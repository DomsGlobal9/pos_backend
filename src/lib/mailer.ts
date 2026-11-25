import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';

/**
 * POS'S ONE PLACE THAT SENDS EMAIL (25 Nov). The same SMTP account and the same three rules as Inventory's
 * mailer (inventory/backend/src/lib/mailer.ts):
 *
 *   SENDING NEVER FAILS THE WORK THAT CAUSED IT. A shop switched on is switched on even when the mail server is
 *     down; the caller hears that the message did not go, and the link is still answered to the super admin.
 *   NOTHING SECRET IS LOGGED. These messages carry sign-in links: the log says what kind went to whom, never the
 *     body or the link.
 *   NO "SEND ANYTHING TO ANYONE". Three named messages with fixed shapes. An endpoint taking a recipient and a body
 *     would be an open relay sending as ScaleEzy.
 */

export type SendResult = { sent: boolean; reason?: string };
type Mail = { to: string; subject: string; text: string; html: string; kind: string };

let transporter: Transporter | null = null;
let capture: ((m: Mail) => void) | null = null;
/** For the tests: messages are handed here instead of to SMTP. */
export const useMailCapture = (fn: ((m: Mail) => void) | null) => { capture = fn; };

export const mailConfigured = () => !!capture || Boolean(env.EMAIL_HOST && env.EMAIL_HOST_USER && env.EMAIL_HOST_PASSWORD);

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  if (!env.EMAIL_HOST || !env.EMAIL_HOST_USER || !env.EMAIL_HOST_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    host: env.EMAIL_HOST,
    port: env.EMAIL_PORT,
    // Implicit TLS is port 465 only; on 587 the connection is upgraded by STARTTLS (secure on 587 hangs).
    secure: env.EMAIL_USE_TLS && env.EMAIL_PORT === 465,
    requireTLS: env.EMAIL_USE_TLS && env.EMAIL_PORT !== 465,
    auth: { user: env.EMAIL_HOST_USER, pass: env.EMAIL_HOST_PASSWORD },
    pool: true, maxConnections: 3,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000
  });
  return transporter;
}

async function send(m: Mail): Promise<SendResult> {
  if (capture) { capture(m); return { sent: true }; }
  const t = getTransporter();
  if (!t) return { sent: false, reason: 'Email is not set up on this POS.' };
  try {
    await t.sendMail({ from: `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_FROM_ADDRESS ?? env.EMAIL_HOST_USER}>`, to: m.to, subject: m.subject, text: m.text, html: m.html });
    console.log(`[mail] ${m.kind} sent to ${m.to.replace(/(^.).*(@.*$)/, '$1***$2')}`);
    return { sent: true };
  } catch (e) {
    console.error(`[mail] ${m.kind} to ${m.to.replace(/(^.).*(@.*$)/, '$1***$2')} not sent: ${(e as Error).message.split('\n')[0]}`);
    return { sent: false, reason: 'The email could not be sent just now.' };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * One layout for every POS email: a table (the only layout every mail app draws the same, Outlook included),
 * at most 520 px and full width on a phone, the shop's name at the top, one green button, the address beneath it
 * wrapped so it never runs off a phone, and a footer saying why the email came. A hidden first line is the
 * preview mail apps show in the list.
 */
function layout(o: { preview: string; heading: string; shop?: string; lines: string[]; button?: { label: string; href: string }; note?: string }) {
  const p = (t: string, extra = '') => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1b1f1d;${extra}">${t}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#eef2ef;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2ef"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #dbe3dd;border-radius:16px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<tr><td style="padding:22px 26px 0">
  <div style="font-size:13px;font-weight:700;letter-spacing:.2px;color:#1f5a3c">ScaleEzy POS${o.shop ? ` &middot; ${esc(o.shop)}` : ''}</div>
  <h1 style="margin:10px 0 16px;font-size:21px;line-height:1.3;color:#14231b">${esc(o.heading)}</h1>
</td></tr>
<tr><td style="padding:0 26px 6px">
  ${o.lines.map(l => p(l)).join('\n  ')}
  ${o.button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px"><tr><td style="border-radius:12px;background:#1f5a3c"><a href="${esc(o.button.href)}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px">${esc(o.button.label)}</a></td></tr></table>
  ${p(`Button not working? Copy this address into your browser:<br><span style="color:#1f5a3c;word-break:break-all;overflow-wrap:anywhere">${esc(o.button.href)}</span>`, 'font-size:12.5px;color:#5c6660')}` : ''}
  ${o.note ? p(o.note, 'font-size:13.5px;color:#5c6660;padding:12px 14px;background:#f4f7f5;border-radius:10px') : ''}
</td></tr>
<tr><td style="padding:14px 26px 22px;border-top:1px solid #e6ece8">
  <p style="margin:0;font-size:12px;line-height:1.5;color:#7a847e">You get this email because of your ScaleEzy POS login. ScaleEzy never asks for your password or PIN by email or phone.</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

/** A new shop's owner: their one-time link to choose a password and PIN. */
export function sendWelcome(to: string, p: { name: string; shop: string; link: string; days: number }) {
  return send({
    kind: 'welcome', to, subject: `${p.shop} is ready on ScaleEzy POS`,
    text: `Hello ${p.name},\n\n${p.shop} is ready on ScaleEzy POS. Open this link to choose your password and PIN (it works once, for ${p.days} days):\n\n${p.link}\n\nYou sign in with this email. ScaleEzy never asks for your password or PIN by email or phone.`,
    html: layout({
      preview: `Choose your password and PIN to open the till at ${p.shop}.`,
      heading: 'Your shop is ready', shop: p.shop,
      lines: [`Hello ${esc(p.name)},`, `<strong>${esc(p.shop)}</strong> is ready on ScaleEzy POS. Choose your password and a 4-number PIN, and the till opens.`],
      button: { label: 'Choose my password', href: p.link },
      note: `The link works once, for ${p.days} days. You sign in with this email.`
    })
  });
}

/** Someone asked to reset this login's password. */
export function sendReset(to: string, p: { name: string; shops: { name: string; link: string }[]; minutes: number }) {
  const one = p.shops.length === 1;
  return send({
    kind: 'reset', to, subject: 'Choose a new ScaleEzy POS password',
    text: `Hello ${p.name},\n\nSomeone asked to reset your ScaleEzy POS password. If it was you, open the link${one ? '' : ' for the shop'} below. It works once, for ${p.minutes} minutes.\n\n${p.shops.map(s => `${s.name}: ${s.link}`).join('\n')}\n\nIf it was not you, ignore this email: your password stays as it is.`,
    html: layout({
      preview: `A link to choose a new password${one ? ` for ${p.shops[0].name}` : ''}. It works for ${p.minutes} minutes.`,
      heading: 'Choose a new password', shop: one ? p.shops[0].name : undefined,
      lines: [`Hello ${esc(p.name)},`, `Someone asked to reset your ScaleEzy POS password. If it was you, choose a new one${one ? ' below' : ' for the shop you need'}. Your PIN, your staff and your bills stay as they are.`,
        ...(one ? [] : p.shops.map(s => `<a href="${esc(s.link)}" style="display:inline-block;padding:11px 16px;border:1px solid #1f5a3c;border-radius:10px;color:#1f5a3c;font-weight:700;text-decoration:none">${esc(s.name)}: choose a new password</a>`))],
      button: one ? { label: 'Choose a new password', href: p.shops[0].link } : undefined,
      note: `The link works once, for ${p.minutes} minutes. If it was not you, ignore this email: your password stays as it is.`
    })
  });
}

/** After a password change by link: so a change nobody asked for does not go unseen. */
export function sendPasswordChanged(to: string, p: { name: string; shop: string }) {
  return send({
    kind: 'password-changed', to, subject: 'Your ScaleEzy POS password was changed',
    text: `Hello ${p.name},\n\nThe password for ${p.shop} on ScaleEzy POS was just changed. If this was you, there is nothing more to do.\n\nIf it was not you, ask ScaleEzy support at once to send you a new link.`,
    html: layout({
      preview: `The password for ${p.shop} was just changed.`,
      heading: 'Your password was changed', shop: p.shop,
      lines: [`Hello ${esc(p.name)},`, `The password for <strong>${esc(p.shop)}</strong> on ScaleEzy POS was just changed. If this was you, there is nothing more to do.`],
      note: '<strong>Not you?</strong> Ask ScaleEzy support at once to send you a new link. Your staff and bills are safe.'
    })
  });
}
