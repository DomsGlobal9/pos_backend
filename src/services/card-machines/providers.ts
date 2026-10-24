/**
 * CARD MACHINE PROVIDERS (24 Oct). One shape for every machine the till can send an amount to:
 * start, ask, cancel. Each provider's own words are read HERE and nowhere else, so the rest of the till
 * only ever sees WAITING / APPROVED / DECLINED / CANCELLED / UNKNOWN.
 *
 * Built from each provider's public integration documents. Confirm on the provider's test system
 * (Pine Labs UAT, Razorpay POS demo) before a shop takes real money on it -- see docs: card-machines.md.
 *
 * THE RULE THAT MATTERS: only a clear "approved for exactly this amount" is money in. Anything the till
 * cannot read is UNKNOWN, never DECLINED: a cashier told "declined" asks the customer to pay again, and
 * a customer charged twice is the worst thing a till can do (POS-PAY-010).
 *
 * The hosts are fixed here, never taken from the owner or a request: the server only ever talks to the
 * provider it names (the 13 Oct audit rule for anything the server calls out to).
 */

export type CardResult =
  | { state: 'WAITING'; detail?: string }
  | { state: 'APPROVED'; amountPaise: number; last4: string | null; approvalCode: string | null; rrn: string | null }
  | { state: 'DECLINED' | 'CANCELLED'; detail: string }
  | { state: 'UNKNOWN'; detail: string };

export type Started = { ok: true; providerRef: string } | { ok: false; detail: string };

export interface CardProvider {
  /** What the owner types in, and which of it is safe to show as the machine's label. */
  fields: { key: string; label: string; secret: boolean }[];
  start(cfg: Record<string, string>, testMode: boolean, req: { amountPaise: number; billRef: string }): Promise<Started>;
  status(cfg: Record<string, string>, testMode: boolean, providerRef: string, amountPaise: number): Promise<CardResult>;
  cancel(cfg: Record<string, string>, testMode: boolean, providerRef: string, amountPaise: number): Promise<CardResult>;
}

/** The one way out to a provider. Swapped by the test scripts for a stand-in; never by a request. */
export type Transport = (url: string, body: unknown, timeoutMs: number) => Promise<{ status: number; body: any } | null>;

const httpTransport: Transport = async (url, body, timeoutMs) => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* a page, not an answer */ }
    return { status: res.status, body: parsed };
  } catch {
    return null;
  }
};

let transport: Transport = httpTransport;
export function useTransport(t: Transport | null) { transport = t ?? httpTransport; }

const SLOW = 'The card machine service could not be reached just now.';
const last4Of = (v: unknown) => { const m = /(\d{4})\s*$/.exec(String(v ?? '')); return m ? m[1] : null; };
const clean = (v: unknown, n = 20) => { const t = String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); return t ? t.slice(0, n) : null; };

/*
 * PINE LABS CLOUD (Plutus Smart): the bill is uploaded, the terminal picks it up, the till asks for
 * its status. Amounts in paise. ResponseCode 0 is success; anything else is read by its message.
 */
const PLUTUS = (test: boolean) =>
  `${test ? 'https://www.plutuscloudserviceuat.in:8201' : 'https://www.plutuscloudservice.in:8201'}/API/CloudBasedIntegration/V1`;

function pineIds(cfg: Record<string, string>) {
  return { MerchantID: Number(cfg.merchantId) || cfg.merchantId, SecurityToken: cfg.securityToken, StoreId: cfg.storeId, ClientId: cfg.clientId };
}

/** Pine Labs' answer, in the till's words. Pending and cancelled are read from the message. */
export function readPine(body: any, amountPaise: number): CardResult {
  if (!body || typeof body !== 'object') return { state: 'UNKNOWN', detail: SLOW };
  const code = Number(body.ResponseCode);
  const msg = String(body.ResponseMessage ?? '').toUpperCase();
  if (code === 0 && /APPROVED|SUCCESS/.test(msg || 'APPROVED')) {
    const tags: Record<string, string> = {};
    for (const t of Array.isArray(body.TransactionData) ? body.TransactionData : []) {
      if (t && typeof t.Tag === 'string') tags[t.Tag.toLowerCase()] = String(t.Value ?? '');
    }
    // A sale without its data cannot be checked: wait for the next answer rather than guess.
    if (!Object.keys(tags).length) return { state: 'WAITING' };
    const paid = Number(tags['amountinpaisa'] ?? tags['finalamount'] ?? NaN);
    return {
      state: 'APPROVED',
      amountPaise: Number.isFinite(paid) ? paid : amountPaise,
      last4: last4Of(tags['card number']),
      approvalCode: clean(tags['approvalcode'], 12),
      rrn: clean(tags['rrn'], 20)
    };
  }
  if (/UPLOADED|PENDING|IN PROGRESS|NOT YET|PROCESSING/.test(msg) || code === 1001) return { state: 'WAITING', detail: 'Waiting for the card on the machine…' };
  if (/CANCEL|VOID|EXPIRED|REVERSED/.test(msg) || code === 1008) return { state: 'CANCELLED', detail: `The machine says: ${body.ResponseMessage}` };
  if (/DECLIN|FAIL|NOT APPROVED|REJECT|INSUFFICIENT|INCORRECT PIN|WRONG PIN/.test(msg)) return { state: 'DECLINED', detail: `The machine says: ${body.ResponseMessage}` };
  return { state: 'UNKNOWN', detail: body.ResponseMessage ? `Pine Labs says: ${body.ResponseMessage}` : SLOW };
}

const pineLabs: CardProvider = {
  fields: [
    { key: 'merchantId', label: 'Merchant ID', secret: false },
    { key: 'securityToken', label: 'Security token', secret: true },
    { key: 'storeId', label: 'Store ID', secret: false },
    { key: 'clientId', label: 'Client ID (the terminal)', secret: false }
  ],
  async start(cfg, testMode, req) {
    const reply = await transport(`${PLUTUS(testMode)}/UploadBilledTransaction`, {
      TransactionNumber: req.billRef, SequenceNumber: 1, AllowedPaymentMode: '1',
      Amount: String(req.amountPaise), ...pineIds(cfg), AutoCancelDurationInMinutes: 3
    }, 10_000);
    if (!reply) return { ok: false, detail: SLOW };
    const b = reply.body ?? {};
    if (Number(b.ResponseCode) === 0 && b.PlutusTransactionReferenceID != null) return { ok: true, providerRef: String(b.PlutusTransactionReferenceID) };
    return { ok: false, detail: b.ResponseMessage ? `Pine Labs says: ${b.ResponseMessage}` : SLOW };
  },
  async status(cfg, testMode, ref, amountPaise) {
    const reply = await transport(`${PLUTUS(testMode)}/GetCloudBasedTxnStatus`, { ...pineIds(cfg), PlutusTransactionReferenceID: Number(ref) }, 8_000);
    return reply ? readPine(reply.body, amountPaise) : { state: 'UNKNOWN', detail: SLOW };
  },
  async cancel(cfg, testMode, ref, amountPaise) {
    const reply = await transport(`${PLUTUS(testMode)}/CancelTransaction`, { ...pineIds(cfg), PlutusTransactionReferenceID: Number(ref), Amount: amountPaise }, 8_000);
    if (!reply) return { state: 'UNKNOWN', detail: SLOW };
    // Cancelled -- unless the card was already taken, which only the status can say.
    if (Number(reply.body?.ResponseCode) === 0) return { state: 'CANCELLED', detail: 'Cancelled on the machine.' };
    return this.status(cfg, testMode, ref, amountPaise);
  }
};

/*
 * RAZORPAY POS (Ezetap) push-to-device: the amount is pushed to the terminal, the till asks for its
 * status. Amounts in rupees. AUTHORIZED is the only "paid".
 */
const EZETAP = (test: boolean) => `${test ? 'https://demo.ezetap.com' : 'https://www.ezetap.com'}/api/3.0/p2padapter`;

export function readRazorpayPos(body: any, amountPaise: number): CardResult {
  if (!body || typeof body !== 'object') return { state: 'UNKNOWN', detail: SLOW };
  const status = String(body.status ?? '').toUpperCase();
  const code = String(body.messageCode ?? '').toUpperCase();
  if (status === 'AUTHORIZED') {
    const paid = Math.round(Number(body.amount) * 100);
    return {
      state: 'APPROVED',
      amountPaise: Number.isFinite(paid) ? paid : amountPaise,
      last4: last4Of(body.cardLastFourDigit),
      approvalCode: clean(body.authCode, 12),
      rrn: clean(body.rrNumber ?? body.txnId, 20)
    };
  }
  if (/QUEUED|RECEIVED|IN_PROGRESS|PENDING/.test(code) || status === 'PENDING') return { state: 'WAITING', detail: 'Waiting for the card on the machine…' };
  if (/CANCEL|EXPIRED/.test(code)) return { state: 'CANCELLED', detail: body.message ? `The machine says: ${body.message}` : 'Cancelled on the machine.' };
  if (status === 'FAILED' || /DECLIN|FAILED/.test(code)) return { state: 'DECLINED', detail: body.message ? `The machine says: ${body.message}` : 'The card was declined.' };
  return { state: 'UNKNOWN', detail: body.message ? `Razorpay POS says: ${body.message}` : SLOW };
}

const razorpayPos: CardProvider = {
  fields: [
    { key: 'username', label: 'Username', secret: false },
    { key: 'appKey', label: 'App key', secret: true },
    { key: 'deviceId', label: 'Device ID (serial|ezetap_android)', secret: false }
  ],
  async start(cfg, testMode, req) {
    const reply = await transport(`${EZETAP(testMode)}/pay`, {
      appKey: cfg.appKey, username: cfg.username, amount: (req.amountPaise / 100).toFixed(2),
      externalRefNumber: req.billRef, pushTo: { deviceId: cfg.deviceId }, mode: 'CARD'
    }, 10_000);
    if (!reply) return { ok: false, detail: SLOW };
    const b = reply.body ?? {};
    if (b.success === true && b.p2pRequestId) return { ok: true, providerRef: String(b.p2pRequestId) };
    return { ok: false, detail: b.message ? `Razorpay POS says: ${b.message}` : SLOW };
  },
  async status(cfg, testMode, ref, amountPaise) {
    const reply = await transport(`${EZETAP(testMode)}/status`, { appKey: cfg.appKey, username: cfg.username, origP2pRequestId: ref }, 8_000);
    return reply ? readRazorpayPos(reply.body, amountPaise) : { state: 'UNKNOWN', detail: SLOW };
  },
  async cancel(cfg, testMode, ref, amountPaise) {
    const reply = await transport(`${EZETAP(testMode)}/cancel`, { appKey: cfg.appKey, username: cfg.username, origP2pRequestId: ref, pushTo: { deviceId: cfg.deviceId } }, 8_000);
    if (!reply) return { state: 'UNKNOWN', detail: SLOW };
    if (reply.body?.success === true) return { state: 'CANCELLED', detail: 'Cancelled on the machine.' };
    return this.status(cfg, testMode, ref, amountPaise);
  }
};

export const PROVIDERS: Record<string, CardProvider> = { PINELABS_CLOUD: pineLabs, RAZORPAY_POS: razorpayPos };
export const PROVIDER_NAMES: Record<string, string> = { PINELABS_CLOUD: 'Pine Labs (Cloud)', RAZORPAY_POS: 'Razorpay POS' };
