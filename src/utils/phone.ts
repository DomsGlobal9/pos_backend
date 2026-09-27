/**
 * The phone number, which IS the customer's identity. POS-CUST-002, -003.
 *
 * Everything about this file follows from one fact: the number is the unique key, so two ways of
 * writing the same number must produce the same stored value or a shop ends up with the same
 * person three times — three visit counts, three lifetime spends, and a loyalty balance split
 * across all of them.
 *
 * A cashier types it a different way every time, and all of these are one person:
 *
 *     9876543210            typed quickly
 *     98765 43210           as it appears on a phone screen
 *     +91 98765 43210       copied from a contact
 *     09876543210           as an older person writes it
 *     091-9876543210        from a paper slip
 *
 * So: stored in E.164 (+919876543210), displayed the way a person reads it, and masked on the
 * receipt because that paper goes home with them and is often left on a counter.
 */

/** India, because that is where every shop using this is. A foreign number must carry its own +. */
const DEFAULT_COUNTRY = '91';

/** Indian mobile numbers are ten digits and never start with 0-5. */
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

export interface NormalisedPhone {
  /** E.164, stored. This is the unique key. */
  e164: string;
  /** What a person reads. */
  display: string;
  /** For a receipt that goes home with the customer. */
  masked: string;
}

export class PhoneError extends Error {}

/**
 * A typed number to the one value that gets stored.
 *
 * Throws rather than guessing when it cannot be made sense of: a wrong number saved silently is a
 * customer record nobody can find again, and a loyalty balance attached to a person who does not
 * exist.
 */
export function normalisePhone(raw: string): NormalisedPhone {
  const text = String(raw ?? '').trim();
  if (!text) throw new PhoneError('Enter a phone number.');

  const hasPlus = text.startsWith('+');
  // Everything that is not a digit goes: spaces, dashes, brackets, the dot some people use.
  let digits = text.replace(/\D/g, '');

  if (!digits) throw new PhoneError('That does not look like a phone number.');

  if (hasPlus) {
    // The caller said which country. Trust it, only sanity-check the length -- country codes are
    // one to three digits and E.164 allows fifteen digits in total.
    if (digits.length < 8 || digits.length > 15) {
      throw new PhoneError('That does not look like a phone number.');
    }
    return shape(digits);
  }

  // No +. Strip the trunk prefixes people write before an Indian number.
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith(DEFAULT_COUNTRY)) digits = digits.slice(2);
  if (digits.length === 13 && digits.startsWith('0' + DEFAULT_COUNTRY)) digits = digits.slice(3);

  if (INDIAN_MOBILE.test(digits)) return shape(DEFAULT_COUNTRY + digits);

  if (digits.length === 10) {
    // Ten digits but not a valid Indian mobile: almost always a typo in the first digit, and
    // saving it would create a customer nobody can look up.
    throw new PhoneError('An Indian mobile number starts with 6, 7, 8 or 9.');
  }

  throw new PhoneError('Enter a 10-digit mobile number, or the full number with its country code.');
}

function shape(digits: string): NormalisedPhone {
  const e164 = '+' + digits;
  return { e164, display: displayPhone(e164), masked: maskPhone(e164) };
}

/** +919876543210 -> +91 98765 43210. Indian numbers get the grouping a person expects; anything
 * else is left alone rather than grouped wrongly. */
export function displayPhone(e164: string): string {
  const digits = String(e164 ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith(DEFAULT_COUNTRY)) {
    const local = digits.slice(2);
    return `+${DEFAULT_COUNTRY} ${local.slice(0, 5)} ${local.slice(5)}`;
  }
  return e164 ?? '';
}

/**
 * What a receipt may show.
 *
 * The last four digits are enough for the customer to recognise their own number and not enough
 * for anyone who picks the receipt off the counter to call them.
 */
export function maskPhone(e164: string): string {
  const digits = String(e164 ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return '••••' + digits.slice(-4);
}

/** True when two typed numbers mean the same person. Used to spot a duplicate before writing one. */
export function sameNumber(a: string, b: string): boolean {
  try {
    return normalisePhone(a).e164 === normalisePhone(b).e164;
  } catch {
    return false;
  }
}
