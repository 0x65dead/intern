// The race: everything that can be done before T-0, done before T-0.
//
// ── The honest speed claim ──────────────────────────────────────────────────
//
// A gated mint is slower than a public mint. That is structural, not a bug, and
// no engineering in this file removes it.
//
// A public SeaDrop mint is built entirely from on-chain reads, so the whole
// transaction — calldata, value, nonce, fees, signature — exists before the stage
// opens. At T-0 the only remaining operation is a network write:
//
//     [ before T-0: read, build, sign ]  →  T-0  →  broadcast
//
// An OpenSea-signed mint cannot be assembled in advance, because the server
// signature is bound to one minter, one quantity and one salt, and OpenSea does
// not issue it before the stage opens. So one HTTP round trip lands *inside* the
// race and cannot be moved out of it:
//
//     [ before T-0: nonce, fees, TLS ]  →  T-0  →  request → verify → sign → broadcast
//
// That round trip costs whatever OpenSea's API costs — typically 80-400ms, and
// more under the load a contested drop generates. It is paid by every bot on that
// drop, including OpenSea's own front end, so it is not a disadvantage against
// the field. It simply means a gated mint is not a public mint and must not be
// described as one.
//
// What the pre-arm makes zero is everything *else*. At T-0 the nonce is known, the
// fees are decided, and the TLS sessions to both OpenSea and the RPC endpoints are
// already open, so the only awaits remaining are the signature request, the local
// sign, and the broadcast.
//
// The balance check is not among them, and earlier versions of this comment and of
// SPEED_STATEMENT claimed it was. It cannot be: the amount a wallet needs is the
// stage price plus the gas ceiling, and the price arrives with the signature. So
// the check happens after the signature and inside the race, by construction. (The
// eligibility endpoint does report a stage price, so a pre-open check against that
// is possible in principle — but it is not implemented, and until it is, nothing
// here should say it is.)
//
// A Merkle allow-list is the exception and is worth choosing when it is offered:
// the proof is computed locally, so that path pre-signs exactly like a public
// mint and is as fast as one.
//
// ── What this file no longer contains ───────────────────────────────────────
//
// It once held a second, parallel mint pipeline — preArm, pollForSignature,
// fireSigned and describeArm — which nothing in src/ ever called. The live path
// is core/allowlist.ts, reached from cli/index.ts. Keeping a fully-tested unused
// duplicate of a mint path is not free, for three reasons:
//
//   pollForSignature *was* the probe-and-infer architecture: it asked the mint
//   endpoint for a signature and read the refusal as a verdict on the wallet, so
//   a 403 became "not eligible". A 403 is a statement about the caller's API key.
//   Eligibility has exactly one source of truth — the eligibility endpoint — and
//   a retry loop is not it. A tested function with a dependency-injection seam is
//   not dormant; it is ready, and what it was ready to do was reintroduce that.
//
//   preArm duplicated work allowlist.ts already does, and did it correctly, which
//   is worse than doing it wrong: two implementations that agree today diverge
//   silently later, and only one of them is the one that runs.
//
//   describeArm's own documentation claimed its output reached the crash-recovery
//   file. It did not — core/runstate.ts writes that, and tests/unattended.test.ts
//   is what proves no key material reaches it.
//
// What survives here is scheduling policy and notification deferral: how long to
// wait after a given answer, and how to avoid spending the race on a status
// message. The pre-arm itself now lives where it can actually run — preArmAllowlist
// in core/allowlist.ts, invoked from the lead window in core/watcher.ts.

import { EngineEvent } from "./engine";
import {
  EligibilityHint,
  Failure,
  OpenSeaEndpoint,
  classifyOpenSeaFailure,
} from "./failures";

/**
 * The speed statement, in one place, so the docs and the code cannot drift.
 * CAPABILITY.md and the README both render this verbatim.
 */
export const SPEED_STATEMENT =
  "A gated mint (allowlist / GTD / FCFS backed by an OpenSea signature) is slower " +
  "than a public mint and always will be. The signature is bound to one minter, " +
  "one quantity and one salt, and OpenSea does not issue it before the stage " +
  "opens — so one HTTP round trip is inside the race and cannot be moved out of " +
  "it. intern removes what it can: the nonce, the fees and the TLS handshakes are " +
  "completed before T-0, leaving request → verify → sign → broadcast. The balance " +
  "check stays inside the race, because the amount a wallet needs depends on the " +
  "price the signature carries. A Merkle allow-list is the exception: its proof is computed " +
  "locally, so that path pre-signs exactly like a public mint and is as fast as one.";

/** How long before the stage opens the pre-arm work must be finished. */
export const PRE_ARM_LEAD_MS = 60_000;

// ── Notification deferral ───────────────────────────────────────────────────

/**
 * Holds events back while the hot path runs.
 *
 * Telegram's API is a network call with a tail measured in seconds. Making one
 * between the signature arriving and the transaction going out would spend the
 * race on a status message. So the window from "start polling" to "broadcast
 * returned" emits nothing; everything queues and flushes immediately after.
 *
 * Fire first, notify after. That ordering is the point of this class, and it is
 * enforced here rather than left as a rule people remember.
 */
export class DeferredEmitter {
  private buffered: EngineEvent[] = [];
  private hot = false;

  constructor(private readonly sink: (event: EngineEvent) => void) {}

  enterHotPath(): void {
    this.hot = true;
  }

  exitHotPath(): void {
    this.hot = false;
    this.flush();
  }

  emit(event: EngineEvent): void {
    if (this.hot) this.buffered.push(event);
    else this.sink(event);
  }

  flush(): void {
    const pending = this.buffered;
    this.buffered = [];
    for (const event of pending) this.sink(event);
  }

  get pendingCount(): number {
    return this.buffered.length;
  }

  get isHot(): boolean {
    return this.hot;
  }
}

// ── Poll scheduling ─────────────────────────────────────────────────────────

/** Floor on the poll interval. Below this, OpenSea rate-limits rather than answers. */
export const MIN_POLL_MS = 100;
const MAX_BACKOFF_MS = 8_000;

export type PollAction =
  | { kind: "fire" }
  | { kind: "retry"; delayMs: number }
  | { kind: "stop"; reason: string; failure: Failure };

/**
 * Exponential backoff, capped.
 *
 * Only applied to the answers that mean "the endpoint is unwell or annoyed". A
 * 409 — "not open yet" — is the expected answer for the whole pre-open window and
 * must keep polling at the base interval, because backing off there means
 * arriving late to the open.
 */
export function backoffDelayMs(attempt: number, baseMs: number, capMs = MAX_BACKOFF_MS): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = baseMs * 2 ** Math.min(exponent, 20);
  return Math.min(capMs, Math.max(baseMs, Math.round(raw)));
}

/**
 * Spread the delay by ±25%.
 *
 * Several wallets polling one endpoint on the same interval arrive together and
 * look exactly like the burst a rate limiter is built to stop. Jitter costs a few
 * ms of expected latency and buys a materially lower chance of a 429 during the
 * one window where a 429 is expensive.
 */
export function withJitter(delayMs: number, rand: () => number = Math.random): number {
  const spread = delayMs * 0.25;
  return Math.max(0, Math.round(delayMs - spread + rand() * spread * 2));
}

/**
 * What to do about one poll outcome.
 *
 * `null` status means the payload arrived. Everything else is classified once, by
 * failures.ts, and scheduled from the result — this function deliberately holds no
 * opinion of its own about what a status means.
 *
 * It used to hold one, and it was wrong in a way that mattered: it read a 403 as
 * "OpenSea refused this wallet — it is not eligible for this stage". A 403 is a
 * statement about the caller's permissions, never a verdict on a wallet's place on
 * a list, and printing that sentence sent an operator looking for an allowlist
 * problem when the real fault was a key without drop permissions. Eligibility has
 * exactly one source of truth (the eligibility endpoint), and a retry scheduler is
 * not it.
 *
 * The scheduling rule, in priority order:
 *
 *   terminal          → stop, carrying the code so the caller can act on it
 *   pre-open answer   → retry at the base rate; this is the window the signature
 *                       is expected to appear in, and slowing down here loses it
 *   Retry-After       → obey it, or our own backoff if that is longer
 *   anything else     → back off; the endpoint is unwell or we are unexplained
 */
export function planNextPoll(
  status: number | null,
  attempt: number,
  opts: {
    pollMs: number;
    retryAfterMs?: number | null;
    rand?: () => number;
    /** Which endpoint answered. Only the mint endpoint is polled today. */
    endpoint?: OpenSeaEndpoint;
    /** Resolves an ambiguous 422 when a real eligibility answer is held. */
    eligibility?: EligibilityHint | null;
  },
): PollAction {
  if (status === null) return { kind: "fire" };

  const base = Math.max(MIN_POLL_MS, opts.pollMs);
  const rand = opts.rand ?? Math.random;
  const failure = classifyOpenSeaFailure(
    { status, retryAfterMs: opts.retryAfterMs ?? null },
    {
      endpoint: opts.endpoint ?? "mint",
      ...(opts.eligibility !== undefined ? { eligibility: opts.eligibility } : {}),
    },
  );

  if (failure.terminal) {
    return { kind: "stop", reason: `${failure.message} (HTTP ${status})`, failure };
  }

  // The pre-open answers. A closed drop and the ambiguous 422 are both what a
  // healthy endpoint says before a stage opens, so neither is a reason to slow
  // down — the poll rate here is the difference between arriving at T-0 and
  // arriving after it.
  const preOpen =
    failure.code === "DROP_NOT_ACTIVE" || failure.code === "STAGE_NOT_ACTIVE" || status === 422;
  if (preOpen) return { kind: "retry", delayMs: withJitter(base, rand) };

  // Racing a limiter extends the limit, so the longer of the two waits wins.
  const ours = backoffDelayMs(attempt, base);
  const theirs = failure.retryAfterMs ?? 0;
  return { kind: "retry", delayMs: withJitter(Math.max(ours, theirs), rand) };
}
