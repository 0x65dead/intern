// Edit pacing for live panels.
//
// Telegram allows roughly one message edit per second per chat and answers the
// rest with 429 plus a retry_after. A panel with a 🔄 Refresh button and a 20s
// auto-refresh loop can exceed that trivially — two taps in a second, or a tap
// that lands on the same tick as the timer — so the pacing is decided here rather
// than scattered across handlers.
//
// Two different limits, because they protect against two different things:
//
//   The manual debounce (3s) protects the *user* from their own repeat taps. A
//   refresh re-reads stages, supply, gas and balances; firing that five times
//   because someone tapped five times wastes RPC quota and returns the same
//   numbers. The tap is still acknowledged — answerCallbackQuery always runs, or
//   the client spins for thirty seconds — it just does not trigger a re-read.
//
//   The hard gap (1s) protects the *connection* from a 429. It applies to every
//   edit regardless of origin, including the auto loop and a stage transition
//   arriving at an awkward moment.
//
// Time is passed in rather than read. Same reason as everywhere else in this
// codebase: a gate that calls Date.now() internally can only be tested by
// sleeping, and a test that sleeps is a test nobody runs.

/** The default debounce for a manual 🔄 Refresh tap. */
export const MANUAL_DEBOUNCE_MS = 3_000;

/** The floor between any two edits of the same message. */
export const MIN_EDIT_GAP_MS = 1_000;

/** How often an auto-refreshing panel re-reads. */
export const AUTO_REFRESH_MS = 20_000;

export type RefreshSource = "manual" | "auto";

/**
 * Decides whether an edit may happen now, and records the ones that do.
 *
 * One instance per live panel. `record` is called only when an edit actually
 * goes out, so a refused refresh does not push the next allowed one further away.
 */
export class EditGate {
  private lastEditMs = 0;

  constructor(
    private readonly debounceMs = MANUAL_DEBOUNCE_MS,
    private readonly minGapMs = MIN_EDIT_GAP_MS,
  ) {}

  /**
   * May a refresh from `source` proceed at `nowMs`?
   *
   * A manual tap is held to the debounce, an auto tick only to the hard gap: the
   * timer already paces itself at 20s, so applying the 3s debounce to it would
   * never fire and would only add a branch that can go wrong.
   */
  allows(source: RefreshSource, nowMs: number): boolean {
    const gap = source === "manual" ? this.debounceMs : this.minGapMs;
    return nowMs - this.lastEditMs >= gap;
  }

  /** Record that an edit went out. */
  record(nowMs: number): void {
    this.lastEditMs = nowMs;
  }

  /** ms until a manual refresh would be allowed again — for the toast text. */
  waitMs(source: RefreshSource, nowMs: number): number {
    const gap = source === "manual" ? this.debounceMs : this.minGapMs;
    return Math.max(0, gap - (nowMs - this.lastEditMs));
  }

  /** Only for tests and for re-arming a panel that was rebuilt from scratch. */
  reset(): void {
    this.lastEditMs = 0;
  }
}

/**
 * The toast shown when a refresh is debounced.
 *
 * Says why nothing happened. A silent refusal is indistinguishable from a bot
 * that has stopped responding, which is the thing people tap repeatedly about.
 */
export function debouncedToast(waitMs: number): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  return `Just refreshed — try again in ${seconds}s`;
}

// ── Honouring Telegram's own backoff ────────────────────────────────────────
//
// Every gap above is ours, chosen to stay under the limit. `retry_after` is
// Telegram's, sent when we failed to stay under it. Ignoring it is worse than
// ignoring our own pacing, because the limiter escalates: retry straight after a
// 429 and the next retry_after comes back longer. A painter that edits every
// 1.2s and swallows every error — which is what the run reporter did — turns one
// 429 into a chat it cannot write to for minutes, during the exact minutes a
// mint is resolving.

/** What the last write attempt learned about when the next one may go out. */
export interface WriteGate {
  /** When the last write actually went out. 0 before the first one. */
  lastWriteMs: number;
  /** Earliest next write, from Telegram's retry_after. 0 when not limited. */
  blockedUntilMs: number;
}

export function newWriteGate(): WriteGate {
  return { lastWriteMs: 0, blockedUntilMs: 0 };
}

/**
 * How long to wait before writing again.
 *
 * `force` drops our own interval — a terminal event must not queue behind a
 * countdown's politeness gap — but it never drops `blockedUntilMs`. Overriding
 * Telegram's retry_after does not deliver the message sooner; it delivers a
 * second 429 and a longer wait than the one being skipped.
 */
export function nextWriteDelay(
  gate: WriteGate,
  nowMs: number,
  intervalMs: number,
  force = false,
): number {
  const ours = force ? 0 : gate.lastWriteMs + intervalMs - nowMs;
  return Math.max(0, ours, gate.blockedUntilMs - nowMs);
}

/**
 * Record a rate limit. Never shortens a block already in force.
 *
 * A missing or nonsensical retry_after leaves the gate alone rather than
 * inventing a delay: 429 without one still gets our own interval, which is the
 * pre-existing behaviour and is better than a guess.
 */
export function noteRateLimit(
  gate: WriteGate,
  nowMs: number,
  retryAfterSec: number | undefined,
): WriteGate {
  if (retryAfterSec === undefined || !Number.isFinite(retryAfterSec) || retryAfterSec <= 0) {
    return gate;
  }
  const until = nowMs + Math.ceil(retryAfterSec) * 1_000;
  return { ...gate, blockedUntilMs: Math.max(gate.blockedUntilMs, until) };
}

/** Total time the last write of a run may spend trying to land. */
export const FINAL_WRITE_BUDGET_MS = 20_000;

/** Attempts allowed on that last write, including the first. */
export const FINAL_WRITE_ATTEMPTS = 4;

/** Floor between those attempts, so a permanent error is not retried in a spin. */
export const MIN_FINAL_RETRY_MS = 500;

/**
 * Whether the last write of a run is worth another attempt.
 *
 * Progress writes are free to fail: the next one repeats the whole message, so
 * nothing is lost. The final write is not, and that asymmetry is the bug this
 * exists for — the per-wallet fired/receipt lines and their tx hashes live only
 * in that message, and a single 429 on it used to lose them for good while the
 * operator stared at a stale countdown.
 *
 * Bounded on three axes, because an unbounded retry here would hold up the run
 * teardown and the lock with it: attempts, total elapsed, and a refusal to wait
 * longer than the budget has left. Giving up returns a reason so the caller can
 * tell the operator the panel is stale instead of letting it read as the outcome.
 */
export function planFinalWrite(
  attempt: number,
  waitMs: number,
  spentMs: number,
  budgetMs = FINAL_WRITE_BUDGET_MS,
): { kind: "retry"; waitMs: number } | { kind: "giveup"; reason: string } {
  if (attempt >= FINAL_WRITE_ATTEMPTS) {
    return { kind: "giveup", reason: `${FINAL_WRITE_ATTEMPTS} attempts failed` };
  }
  const remaining = budgetMs - spentMs;
  if (remaining <= 0) {
    return { kind: "giveup", reason: `the ${Math.round(budgetMs / 1_000)}s retry budget is spent` };
  }
  const wait = Math.max(waitMs, MIN_FINAL_RETRY_MS);
  if (wait > remaining) {
    return {
      kind: "giveup",
      reason: `Telegram asked for ${Math.ceil(wait / 1_000)}s, longer than the ${Math.round(remaining / 1_000)}s left`,
    };
  }
  return { kind: "retry", waitMs: wait };
}
