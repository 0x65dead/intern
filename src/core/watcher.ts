// Waiting for a stage that isn't open yet.
//
// Two sources disagree about when a mint opens, and both matter:
//
//   On-chain `startTime` is what the contract enforces. It is authoritative for
//   whether a transaction reverts, and it is the only thing worth firing against.
//
//   The OpenSea schedule is what the creator published. It can list stages the
//   contract has not been configured for yet, and it changes when the creator
//   edits the drop.
//
// So the on-chain value decides the fire time, and the schedule is re-read while
// waiting — a creator moving the mint an hour later must not leave us firing into
// a stage that no longer exists. Neither source is polled tightly: a stage hours
// away needs one check a minute, and a stage seconds away is already handled by
// the timing module.

import { JsonRpcProvider } from "ethers";
import {
  DropSchedule,
  DropStage,
  OpenSeaError,
  fetchDropSchedule,
  liveStage,
  nextStage,
} from "./opensea";
import { MintPlan, buildMintPlan } from "./seadrop";

export interface WatchOptions {
  /** Longest gap between polls. Shorter as the stage approaches. */
  maxPollMs?: number;
  minPollMs?: number;
  /** Give up after this long. Infinity waits indefinitely. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (update: WatchUpdate) => void;
  /**
   * How long before a stage opens to run {@link onPreArm}.
   *
   * The watcher is the only thing here that knows the countdown, so it is the
   * only place that can honour a lead. Zero — the default — keeps the plain
   * behaviour of doing nothing but watch.
   */
  preArmLeadMs?: number;
  /**
   * Preparation that has to be finished before the stage opens.
   *
   * Called at most once per scheduled start, and re-run if the creator moves the
   * stage: nonces fetched against the old time are still valid, but the operator
   * should see the preparation happen against the time that will actually be
   * used. It is awaited, so the watch does not resume polling until preparation
   * finishes, and a throw ends the watch — failing to prepare is not something
   * to find out about at T-0, when there is nothing left to do about it.
   */
  onPreArm?: (stage: DropStage) => Promise<void> | void;
  /**
   * How to wait. Injected only by tests, which cannot spend a real minute proving
   * that the lead lands a minute early.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface WatchUpdate {
  kind: "waiting" | "rescheduled" | "opened" | "error";
  message: string;
  /** Stage start in epoch ms, when known. */
  startsAtMs?: number;
}

/**
 * Poll interval that tightens as the target approaches.
 *
 * Far out, frequent polling only burns rate limit — a stage six hours away will
 * not open in the next ten seconds. Close in, a creator's last-minute edit is
 * exactly the thing that costs a mint, so the interval shrinks to catch it. The
 * cap keeps us inside OpenSea's limits either way.
 */
export function pollInterval(
  msUntilStart: number,
  opts: { minPollMs?: number; maxPollMs?: number } = {},
): number {
  const min = opts.minPollMs ?? 2_000;
  const max = opts.maxPollMs ?? 60_000;
  if (!Number.isFinite(msUntilStart) || msUntilStart <= 0) return min;
  // Roughly a tenth of the remaining time: ~6min polls at an hour out, ~2s at 20s.
  const scaled = msUntilStart / 10;
  return Math.max(min, Math.min(max, Math.round(scaled)));
}

/**
 * Wait until an on-chain public stage exists and is open (or is about to open).
 *
 * Returns as soon as the contract reports a stage whose start is in the past, or
 * whose start is within `readyWithinMs` — the caller then does the precise T-0
 * wait itself with a corrected clock, which this loop is too coarse for.
 */
export async function waitForPublicStage(
  provider: JsonRpcProvider,
  nftContract: string,
  quantity: number,
  opts: WatchOptions & { readyWithinMs?: number } = {},
): Promise<MintPlan> {
  const readyWithinMs = opts.readyWithinMs ?? 60_000;
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
  let lastStart: number | null = null;

  for (;;) {
    if (opts.signal?.aborted) throw new Error("Cancelled while waiting for the stage.");
    if (Date.now() > deadline) throw new Error("Timed out waiting for a public stage to open.");

    const plan = await buildMintPlan(provider, nftContract, quantity);
    if (plan) {
      const startMs = plan.drop.startTime * 1000;
      const untilStart = startMs - Date.now();

      if (untilStart <= readyWithinMs) {
        opts.onUpdate?.({
          kind: "opened",
          message:
            untilStart <= 0
              ? "Public stage is open on-chain."
              : `Public stage opens in ${Math.round(untilStart / 1000)}s — handing over to the precise timer.`,
          startsAtMs: startMs,
        });
        return plan;
      }

      if (lastStart !== null && lastStart !== startMs) {
        opts.onUpdate?.({
          kind: "rescheduled",
          message: `Start time moved from ${new Date(lastStart).toISOString()} to ${new Date(startMs).toISOString()}.`,
          startsAtMs: startMs,
        });
      } else {
        opts.onUpdate?.({
          kind: "waiting",
          message: `Public stage opens at ${new Date(startMs).toISOString()}.`,
          startsAtMs: startMs,
        });
      }
      lastStart = startMs;

      const sleep = Math.min(pollInterval(untilStart, opts), untilStart - readyWithinMs);
      await delay(Math.max(1_000, sleep), opts.signal);
      continue;
    }

    // No drop configured yet. This is normal well before a mint: the creator
    // configures SeaDrop shortly before opening. Keep watching.
    opts.onUpdate?.({
      kind: "waiting",
      message: "No public drop configured on-chain yet — still watching.",
    });
    await delay(opts.maxPollMs ?? 30_000, opts.signal);
  }
}

export interface StageWatchResult {
  schedule: DropSchedule;
  stage: DropStage;
}

/**
 * Wait for the next stage in OpenSea's schedule to open.
 *
 * Used by the allowlist path, where there is no on-chain start time to read: the
 * signature only exists once OpenSea will issue one. The schedule is re-fetched
 * on every poll so a moved or deleted stage is noticed rather than waited on
 * forever.
 */
export async function waitForScheduledStage(
  slug: string,
  apiKey: string,
  opts: WatchOptions & { includePublic?: boolean } = {},
): Promise<StageWatchResult> {
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
  const wantPublic = opts.includePublic ?? true;
  const sleep = opts.sleep ?? delay;
  let announced: number | null = null;
  let preArmedFor: number | null = null;

  for (;;) {
    if (opts.signal?.aborted) throw new Error("Cancelled while waiting for the stage.");
    if (Date.now() > deadline) throw new Error("Timed out waiting for a stage to open.");

    let schedule: DropSchedule;
    try {
      schedule = await fetchDropSchedule(slug, apiKey);
    } catch (err: unknown) {
      // A transient API failure must not end the watch — the mint is still coming.
      if (err instanceof OpenSeaError && (err.status === 0 || err.status >= 429)) {
        opts.onUpdate?.({ kind: "error", message: `${err.message} Retrying.` });
        await sleep(15_000, opts.signal);
        continue;
      }
      throw err;
    }

    const now = Date.now();
    const open = liveStage(schedule, now);
    if (open && (wantPublic || !open.isPublic)) {
      opts.onUpdate?.({ kind: "opened", message: `${open.label} is open.`, startsAtMs: open.startMs });
      return { schedule, stage: open };
    }

    const upcoming = nextStage(schedule, now);
    if (!upcoming) {
      throw new Error(
        "No further stages in OpenSea's schedule — nothing left to wait for. Nothing was sent.",
      );
    }
    if (announced !== upcoming.startMs) {
      opts.onUpdate?.({
        kind: announced === null ? "waiting" : "rescheduled",
        message: `Next stage "${upcoming.label}" opens at ${new Date(upcoming.startMs).toISOString()}.`,
        startsAtMs: upcoming.startMs,
      });
      announced = upcoming.startMs;
    }

    const lead = opts.preArmLeadMs ?? 0;
    const arming = opts.onPreArm !== undefined && lead > 0;
    if (arming && preArmedFor !== upcoming.startMs && upcoming.startMs - now <= lead) {
      // Set before the await, not after: a preparation that throws must not be
      // retried on the next poll, because whatever it half-finished is still
      // half-finished and the reason it failed is unlikely to have changed.
      preArmedFor = upcoming.startMs;
      await opts.onPreArm!(upcoming);
      // Re-read the schedule immediately. Preparation takes real time, and a
      // creator editing the drop during it is precisely the case this watch
      // exists to notice.
      continue;
    }

    // Never sleep through the lead boundary. Without this the poll interval
    // decides when preparation happens, so a 60s lead quietly becomes whatever
    // the last sleep happened to leave of it.
    let waitMs = pollInterval(upcoming.startMs - now, opts);
    const untilLead = upcoming.startMs - lead - now;
    if (arming && untilLead > 0 && untilLead < waitMs) waitMs = untilLead;
    await sleep(waitMs, opts.signal);
  }
}

/** Sleep that resolves early on abort rather than leaving a dangling timer. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
