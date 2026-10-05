/**
 * The shop's clock, not the machine's. Imported FIRST by server.ts, before anything reads a date.
 *
 * A till's day is the shop's day: "today's sales", the day close, the financial year a bill is
 * numbered in, the return window, the time printed on a PDF bill. All of that code asks the clock
 * for local hours and dates -- and on the live server the machine's clock is UTC, five and a half
 * hours behind every ScaleEzy shop. Found on the live till, 1 Oct: a bill parked at 3:11 pm was
 * labelled "Parked at 9:41 am", the Home screen said good morning in the afternoon, and "today"
 * would have changed at 5:30 am. Nothing local could show it, because this machine is already on
 * India time.
 *
 * So the process is put on the shop's time zone here, whatever the host is set to. Every shop is in
 * India today; POS_TIMEZONE overrides it for a deployment elsewhere. (A zone per shop is a different
 * feature: it needs every one of those date calls to take the shop's zone, not a process setting.)
 */
// POS_TIMEZONE may live in .env, and env.ts's dotenv.config() runs after this file -- too late.
import 'dotenv/config';

export const SHOP_TIMEZONE = (process.env.POS_TIMEZONE ?? '').trim() || 'Asia/Kolkata';

// Node re-reads TZ when it is assigned: every Date after this line is in the shop's time.
process.env.TZ = SHOP_TIMEZONE;
