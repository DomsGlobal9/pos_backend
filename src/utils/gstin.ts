/**
 * A GSTIN as a cashier types it: what is wrong with it, in one sentence, or null when it is good.
 *
 * Fifteen characters -- state code, PAN, entity number, Z, check character -- and the last one is a
 * checksum over the other fourteen (mod 36), so a single mistyped character is caught here rather
 * than on the customer's GST return a month later.
 */
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function normaliseGstin(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

export function gstinProblem(raw: string): string | null {
  const g = normaliseGstin(raw);
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) {
    return 'A GSTIN is 15 characters, like 27AAPFU0939F1ZV. Check it against their GST certificate.';
  }
  const state = Number(g.slice(0, 2));
  if (state < 1 || state > 38 && state !== 97 && state !== 99) return 'The first two digits of a GSTIN are a state code, and these are not one.';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  if (CHARS[(36 - (sum % 36)) % 36] !== g[14]) {
    return 'That GSTIN has a mistyped character -- its last character does not match. Check it against their GST certificate.';
  }
  return null;
}
