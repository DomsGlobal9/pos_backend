import { prisma } from '../../lib/prisma';
import { Actor } from '../../types/actor';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { record } from '../audit';
import { pdfFor, money } from '../receipts';

/**
 * Sending a customer their bill. POS-RCPT-006 (WhatsApp). Email and SMS wait on a provider.
 *
 * Through ScaleEzy's WhatsApp service, as its module guide says (inventory/backend/whatsapp-service
 * /docs/USING-FROM-A-MODULE.md), and keeping its rules:
 *
 *   - FROM THE SHOP'S OWN NUMBER, to the shop's own customer: `from: { clientId }`, kind C2
 *   - A PERSON PRESSES SEND. One message per press, never automatic -- a linked number that sends
 *     on its own is how a shop's WhatsApp gets banned
 *   - THE SERVER DECIDES WHO: the bill's own customer. The browser sends a bill and nothing else
 *
 * THE PHASE 10 GATE: a receipt that fails can never damage the sale. This runs in its own request,
 * long after the bill committed; it writes only to `receipt_sends`; and every failure comes back as
 * one sentence while the bill stays exactly as it was.
 */

export function whatsappConfig() {
  const url = (process.env.WHATSAPP_SERVICE_URL ?? '').trim().replace(/\/+$/, '');
  /*
   * Either name. create-module prints `WHATSAPP_SERVICE_KEY=...` and every other module on the
   * service uses that, so somebody pasting the script's own output into Render would otherwise get
   * a till that says "not set up" and no reason why. WHATSAPP_MODULE_KEY is what this service was
   * written with and still works, so nothing deployed has to change.
   */
  const key = (process.env.WHATSAPP_SERVICE_KEY ?? process.env.WHATSAPP_MODULE_KEY ?? '').trim();
  return url && key ? { url, key } : null;
}

const DOCS = 'the bill';

export interface WhatsAppAccount { status: string; phone: string | null; linkedAt: string | null; lastSeenAt: string | null }

/*
 * THE SHOP'S LINKED NUMBER, as the WhatsApp service knows it (12 Oct: Settings showed nothing, and the
 * WhatsApp button appeared for a shop with no number linked). One link per shop, made in Inventory's
 * Settings -> WhatsApp and shared by every module; the till only reads it. Asked at most once a minute
 * per shop, so the screens that need it cost nothing. Null: the service is not set up, or did not answer.
 */
const accounts = new Map<string, { at: number; value: WhatsAppAccount | null }>();
/** The service said a number connected or dropped: ask again next time. */
export const forgetAccounts = () => accounts.clear();
export async function whatsappAccount(ownClientId: string): Promise<WhatsAppAccount | null> {
  const config = whatsappConfig();
  if (!config) return null;
  const clientId = await platformClientId(ownClientId);
  const cached = accounts.get(clientId);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value: WhatsAppAccount | null = null;
  try {
    const res = await fetch(`${config.url}/v1/accounts/client/${encodeURIComponent(clientId)}`, {
      headers: { 'x-module-key': config.key }, signal: AbortSignal.timeout(3_000)
    });
    if (res.ok) {
      const body: any = await res.json();
      value = { status: String(body?.status ?? 'NOT_LINKED'), phone: body?.phone ?? null, linkedAt: body?.linkedAt ?? null, lastSeenAt: body?.lastSeenAt ?? null };
    }
  } catch { /* unknown: left null, and not cached, so the next screen asks again */ }
  if (value) accounts.set(clientId, { at: Date.now(), value });
  return value;
}

/*
 * WHO THE SHOP IS to the WhatsApp service: Inventory's platform id ("sphl"), which the till's own id
 * may not be (pos-uitest is "pos-e2e-..." there). From the catalogue; the till's own id until it says.
 * A different id is "a second shop with no link" (the service's rule 6).
 */
export async function platformClientId(clientId: string) {
  const link = await prisma.inventoryLink.findUnique({ where: { clientId }, select: { platformClientId: true } });
  return link?.platformClientId ?? clientId;
}

export async function sendReceipt(actor: Actor, saleId: string, input: { onceKey: string; channel?: string }) {
  /*
   * A PERSON, every time. The service's rule is one message per press and never automatic, because
   * a linked number that sends on its own is how a shop's WhatsApp gets banned -- and that rule was
   * written in the comment above and enforced by nothing. It holds today only because a person is
   * the only actor this service can mint; the moment a client's own software gets an API key
   * (Phase 12, the kind is already declared) it would have been able to send from the shop's number
   * in a loop. One line now, rather than a hole later.
   */
  if (actor.kind !== 'USER') {
    throw forbidden('A receipt is sent by someone at the till, not by other software.', { code: 'NOT_PERMITTED' });
  }
  const channel = input.channel ?? 'WHATSAPP';
  if (channel === 'EMAIL' || channel === 'SMS') {
    throw conflict(`${channel === 'EMAIL' ? 'Email' : 'SMS'} receipts are not set up yet. Send it on WhatsApp, or print it.`, { code: 'NOT_CONFIGURED' });
  }
  if (channel !== 'WHATSAPP') throw badRequest('Choose how to send the receipt.');
  if (!input.onceKey || input.onceKey.length < 8) throw badRequest('This send needs a key.');

  // One press, one message: a second press of the same button returns the first.
  const already = await prisma.receiptSend.findUnique({ where: { onceKey: input.onceKey } });
  if (already) {
    if (already.clientId !== actor.clientId || already.saleId !== saleId) throw conflict('That send key is already in use. Try again.');
    return { replayed: true, send: view(already) };
  }

  const sale = await prisma.sale.findFirst({
    where: { id: saleId, clientId: actor.clientId },
    select: { id: true, invoiceNo: true, totalPaise: true, customer: { select: { phone: true, name: true } } }
  });
  if (!sale) throw notFound('That bill was not found.');
  const phone = sale.customer?.phone;
  if (!phone) {
    throw badRequest('This bill has no customer on it, so there is no number to send it to. Print it, or show them the QR code.', { code: 'NO_CUSTOMER' });
  }

  const config = whatsappConfig();
  if (!config) {
    throw conflict('WhatsApp receipts are not set up for this till yet. Print the bill, or show the QR code.', { code: 'NOT_CONFIGURED' });
  }

  const { pdf, url, sale: full } = await pdfFor(actor, saleId);
  const shopName = full.shop?.shopName ?? 'the shop';
  const text = `Thank you for shopping at ${shopName}. Your bill ${sale.invoiceNo} for ${money(sale.totalPaise)} is attached. You can also open it here: ${url}`;

  const row = await prisma.receiptSend.create({
    data: {
      clientId: actor.clientId, saleId, channel, toLast4: phone.slice(-4), status: 'SENDING',
      byId: actor.kind === 'USER' ? actor.id : null, onceKey: input.onceKey
    }
  });

  let status = 'FAILED';
  let providerId: string | null = null;
  let failReason: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`${config.url}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-module-key': config.key },
      body: JSON.stringify({
        from: { clientId: await platformClientId(actor.clientId) },
        to: phone,
        text,
        document: { fileName: `${sale.invoiceNo.replace(/[^\w-]+/g, '-')}.pdf`, mimeType: 'application/pdf', base64: pdf.toString('base64') },
        kind: 'C2',
        reference: sale.invoiceNo,
        idempotencyKey: `pos-receipt-${input.onceKey}`
      })
    }).finally(() => clearTimeout(timer));
    const body: any = await res.json().catch(() => null);
    if (res.status === 202 || res.status === 200) {
      status = 'QUEUED';
      providerId = body?.id ?? null;
    } else {
      // The service's own sentence is written for people ("This person replied STOP") -- pass it on.
      failReason = body?.error?.message ?? `WhatsApp did not take ${DOCS} (${res.status}).`;
    }
  } catch (error: any) {
    failReason = error?.name === 'AbortError'
      ? 'WhatsApp took too long to answer. The bill is saved — try sending again.'
      : 'WhatsApp could not be reached. The bill is saved — try sending again.';
  }

  const saved = await prisma.receiptSend.update({ where: { id: row.id }, data: { status, providerId, failReason } });
  await record(actor, { action: 'receipt.sent', subject: sale.invoiceNo, detail: { channel, status, toLast4: phone.slice(-4) } });

  if (status === 'FAILED') {
    throw conflict(failReason!, { code: 'SEND_FAILED', send: view(saved) });
  }
  return { replayed: false, send: view(saved) };
}

function view(row: { id: string; channel: string; toLast4: string; status: string; failReason: string | null; createdAt: Date }) {
  return { id: row.id, channel: row.channel, to: `••••${row.toLast4}`, status: row.status, failReason: row.failReason, at: row.createdAt };
}

/**
 * The sends for a bill, newest first -- with their latest status asked of the WhatsApp service for
 * the few still on their way. A status that cannot be fetched is left as it was.
 */
export async function sendsFor(actor: Actor, saleId: string) {
  const rows = await prisma.receiptSend.findMany({ where: { clientId: actor.clientId, saleId }, orderBy: { createdAt: 'desc' }, take: 10 });
  const config = whatsappConfig();
  if (config) {
    for (const r of rows.filter(x => x.providerId && ['QUEUED', 'SENT'].includes(x.status)).slice(0, 3)) {
      try {
        const res = await fetch(`${config.url}/v1/messages/${r.providerId}`, { headers: { 'x-module-key': config.key }, signal: AbortSignal.timeout(3_000) });
        if (!res.ok) continue;
        const body: any = await res.json();
        const next = String(body?.status ?? '').toUpperCase();
        if (['SENT', 'DELIVERED', 'READ', 'FAILED', 'EXPIRED'].includes(next) && next !== r.status) {
          const updated = await prisma.receiptSend.update({
            where: { id: r.id },
            data: { status: next, failReason: body?.failReason ?? r.failReason }
          });
          Object.assign(r, updated);
        }
      } catch { /* the status stays as last known */ }
    }
  }
  return rows.map(view);
}
