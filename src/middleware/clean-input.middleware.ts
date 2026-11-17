import { Request, Response, NextFunction } from 'express';

/**
 * A NUL BYTE IS NEVER TEXT (17 Nov, API sweep).
 *
 * Postgres cannot store the character 0x00 in a text column and says so with an error, which
 * reached the cashier as "Something went wrong at our end" -- a 500 anyone could cause on any route
 * by putting %00 in an address or a NUL in a name. Seventy-seven of them in one sweep.
 *
 * In an ADDRESS (an id, a code, a search) it is never honest: refused with a plain 400.
 * In a BODY it is cleaned out, not refused. A note pasted from somewhere odd, or a scanner that
 * sends a stray byte, must not lose a sale -- least of all one saved offline, which would be refused
 * again on every retry. The cleaning happens before any validation, so what is checked is what is
 * stored. A NUL in a field's NAME, or a body nested deeper than any screen sends, is refused.
 *
 * AND A BODY CAN ONLY HOLD SO MANY THINGS (17 Nov, npm advisory GHSA-mrhx-c7xc-m3w5 on zod, measured
 * here). The 1 MB limit counts bytes, but 1 MB can be 470,000 two-byte elements, and the validator
 * builds an error for every one: ten such requests took this server from 108 MB to 800 MB and froze
 * it for six seconds -- enough to put a small instance, and every shop on it, off the air, by anyone
 * signed in. The largest honest body (a long bill, a page of Inventory's pushes, a batch of items)
 * is a few thousand values; past 50,000 it is refused here, before any validation runs.
 */
const MAX_DEPTH = 32;
const MAX_VALUES = 50_000;
const NUL = String.fromCharCode(0);

function clean(value: unknown, depth: number, seen: { n: number }): unknown {
  if (typeof value === 'string') return value.includes(NUL) ? value.split(NUL).join('') : value;
  if (!value || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) throw new Error('deep');
  if (Array.isArray(value)) {
    if ((seen.n += value.length) > MAX_VALUES) throw new Error('many');
    for (let i = 0; i < value.length; i++) value[i] = clean(value[i], depth + 1, seen);
    return value;
  }
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if ((seen.n += keys.length) > MAX_VALUES) throw new Error('many');
  for (const k of keys) {
    if (k.includes(NUL)) throw new Error('key');
    o[k] = clean(o[k], depth + 1, seen);
  }
  return value;
}

const refuse = (res: Response) => res.status(400).json({
  success: false,
  message: 'That has a character the till cannot store. Type it again and try once more.',
  details: { code: 'BAD_TEXT' }
});

export function cleanInput(req: Request, res: Response, next: NextFunction) {
  if (/%00/i.test(req.originalUrl) || req.originalUrl.includes(NUL)) return refuse(res);
  // Buffers (the WhatsApp door's raw body) are left exactly as sent: their signature is over the bytes.
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    try { clean(req.body, 0, { n: 0 }); }
    catch (e) {
      if ((e as Error).message !== 'many') return refuse(res);
      return res.status(413).json({
        success: false,
        message: 'That is too much to send in one go. Send it in smaller parts.',
        details: { code: 'TOO_MANY' }
      });
    }
  }
  next();
}
