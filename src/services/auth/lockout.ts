/**
 * WRONG-TRY LOCKOUTS THAT HOLD (17 Nov, security audit pos-run-1).
 *
 * The audit found three things wrong with the old flat lockout on sign-in:
 *   1. It never grew. Five tries, five minutes, again and again: about 1,440 guesses a day, every
 *      4-digit PIN in about a week -- the same weakness approvals had already fixed on 13 Oct.
 *   2. It was checked BEFORE the slow comparison and counted AFTER it, so twenty guesses sent at once
 *      all got compared before the first one was counted.
 *   3. (In openTill) its key was the login as typed, so "98765 43210" and "9876543210" -- one phone --
 *      each had their own five tries.
 *
 * So: an attempt is RESERVED the moment it starts (a burst cannot get ahead of the count); each lock
 * is twice as long as the last, up to an hour, until a right answer clears it or the key has been
 * quiet for a day; and callers key it on the canonical identity, not the raw text.
 *
 * In memory and per process, like approvals': a second instance keeps its own count (see the audit
 * report). A restart forgets locks, which is why the escalation matters more than the length.
 */
export interface LockoutOptions {
  /** Wrong tries before a lock. */
  after: number;
  /** The first lock; each later one doubles. */
  baseMs: number;
  /** The longest lock. */
  maxMs: number;
  /** A key untouched this long starts again from the first lock. */
  forgetAfterMs: number;
}

interface Entry { count: number; until: number; lockouts: number; last: number; inFlight: number }

export type Attempt =
  | { locked: true; retryInMs: number }
  | {
      locked: false;
      /** A wrong answer. Returns the lock it caused, if this try was the one that locked the key. */
      fail(): { lockedForMs: number; lockoutNumber: number } | null;
      /** A right answer: the key starts clean. */
      succeed(): void;
      /** Neither (the name was not found, the request failed): just give the reserved try back. */
      release(): void;
    };

export function makeLockout(opts: LockoutOptions) {
  const entries = new Map<string, Entry>();

  function begin(key: string): Attempt {
    const now = Date.now();
    let e = entries.get(key);
    if (e && e.inFlight === 0 && e.until <= now && now - e.last > opts.forgetAfterMs) {
      entries.delete(key);
      e = undefined;
    }
    if (!e) {
      e = { count: 0, until: 0, lockouts: 0, last: now, inFlight: 0 };
      entries.set(key, e);
    }
    if (e.until > now) return { locked: true, retryInMs: e.until - now };
    // Tries already being checked count too: a burst cannot outrun the limit.
    if (e.count + e.inFlight >= opts.after) return { locked: true, retryInMs: 5_000 };

    const entry = e;
    entry.inFlight += 1;
    let done = false;
    const finish = () => { if (done) return false; done = true; entry.inFlight -= 1; return true; };
    return {
      locked: false,
      fail() {
        if (!finish()) return null;
        const at = Date.now();
        entry.count += 1;
        entry.last = at;
        if (entry.count < opts.after) return null;
        const lockedForMs = Math.min(opts.baseMs * 2 ** entry.lockouts, opts.maxMs);
        entry.until = at + lockedForMs;
        entry.lockouts += 1;
        entry.count = 0;
        return { lockedForMs, lockoutNumber: entry.lockouts };
      },
      succeed() {
        if (!finish()) return;
        entries.delete(key);
      },
      release() { finish(); }
    };
  }

  return { begin, reset: () => entries.clear() };
}

/** "Wait 7 minutes" / "Wait 1 minute" for a lock. */
export const waitWords = (ms: number) => {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  return `Wait ${mins} minute${mins === 1 ? '' : 's'} and try again.`;
};
