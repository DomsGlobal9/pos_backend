/**
 * WHO is asking, passed explicitly.
 *
 * This small file is the reason the public API will be cheap to add later rather than a rewrite.
 *
 * The expensive version of this product is discovering in month six that every service function
 * reaches for a logged-in human -- a session, a request object, `req.user` -- and that opening any
 * of it to a client's own software means touching all of it. So the rule, from the first commit:
 *
 *     NO SERVICE FUNCTION READS A REQUEST OR A SESSION. Every one takes an Actor as its first
 *     argument, and the route is the only place that knows an HTTP request exists.
 *
 * Then a public endpoint is the same service function with a different Actor in front of it: an API
 * key instead of a cashier. Nothing underneath changes.
 */

export type ActorKind =
  /** A person at the till, signed in through the Gateway or locally. */
  | 'USER'
  /** A client's own software, holding an API key the Gateway issued. */
  | 'API_KEY'
  /** Another ScaleEzy service -- Inventory confirming a hold, Marketing sending a bill. */
  | 'SERVICE'
  /** The till's own background work: the outbox flush, the webhook dispatcher. */
  | 'SYSTEM';

export interface Actor {
  kind: ActorKind;
  /** The tenant. Every query in this service is scoped by it, without exception. */
  clientId: string;
  /** The user id for a USER, the key id for an API_KEY, the service name for a SERVICE. */
  id: string | null;
  /** For the receipt and the audit log. */
  name?: string | null;
  roles: string[];
  permissions: string[];
}

/** Background work acting on one client's behalf. Holds no permissions -- it may only do what the
 * code path it runs in does, and it can never be the actor on a discount or an override. */
export const systemActor = (clientId: string): Actor => ({
  kind: 'SYSTEM',
  clientId,
  id: null,
  name: 'ScaleEzy POS',
  roles: [],
  permissions: []
});

/** Permission keys. Rows in the database, listed here so a typo is a compile error rather than a
 * silently ungated action. */
export const PERMISSIONS = {
  SELL: 'sale:create',
  DISCOUNT_OVER_LIMIT: 'sale:discount_over_limit',
  PRICE_OVERRIDE: 'sale:price_override',
  REFUND: 'return:create',
  REFUND_OUTSIDE_WINDOW: 'return:outside_window',
  CLOSE_DAY: 'day:close',
  SEE_COST: 'report:cost',
  SETTINGS: 'settings:manage',
  INTEGRATIONS: 'integration:manage'
} as const;

/** OWNER holds everything, including permissions added after this deployment shipped. */
const HOLDS_EVERYTHING = ['OWNER', 'PLATFORM_ADMIN'];

export const holdsEverything = (actor: Actor) =>
  actor.roles.some(r => HOLDS_EVERYTHING.includes(r));

export const may = (actor: Actor, permission: string) =>
  holdsEverything(actor) || actor.permissions.includes(permission);
