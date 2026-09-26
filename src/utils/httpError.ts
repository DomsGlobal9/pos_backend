/**
 * Errors a person at the counter will read.
 *
 * The rule across ScaleEzy: no raw errors in the UI. A cashier with a queue in front of them cannot
 * act on "PrismaClientKnownRequestError P2002" -- they need one plain sentence telling them what to
 * do. So every error thrown deliberately carries a message written for them, and anything NOT
 * thrown deliberately is replaced with a safe sentence by the error handler rather than forwarded.
 *
 * `message` is shown. `details` is for the screen's own logic (a code it branches on), never for
 * prose.
 */

export interface HttpError extends Error {
  statusCode: number;
  /** True for errors written for a person. Anything without it is treated as a leak risk. */
  safe: true;
  details?: Record<string, unknown>;
}

const make = (statusCode: number) => (message: string, details?: Record<string, unknown>): HttpError =>
  Object.assign(new Error(message), { statusCode, safe: true as const, details });

/** The request was wrong -- a missing field, an impossible quantity, a reason left blank. */
export const badRequest = make(400);
/** Not signed in, or the token has expired. */
export const unauthorized = make(401);
/** Signed in, but not allowed to do this. A cashier overriding a price, for example. */
export const forbidden = make(403);
/** The bill, item or customer asked for is not there. */
export const notFound = make(404);
/**
 * Someone else got there first, or the world moved under this request: an offer that ran out
 * between being quoted and being charged, a hold that expired, the same sale id with a different
 * basket. Always retryable or re-priceable by the screen.
 */
export const conflict = make(409);
/** Something on our side. The handler replaces the text; this exists so the status is deliberate. */
export const serverError = make(500);

export const isHttpError = (e: unknown): e is HttpError =>
  typeof e === 'object' && e !== null && (e as HttpError).safe === true;
