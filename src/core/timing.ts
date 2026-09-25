// Waiting until exactly T-0.
//
// `setTimeout(ms)` guarantees only "not before" — it fires late by whatever the
// event loop and OS scheduler owe, typically 1-15ms and occasionally much worse
// under load. For a mint that decides ordering in the first block, arriving 15ms
// late can be the whole race.
//
// So the wait is staged:
//
//   Coarse — setTimeout down to ~2s out. Cheap; precision is irrelevant here.
//   Fine   — short setTimeout hops down to ~25ms out, re-reading the clock each
//            hop so scheduler drift is corrected rather than accumulated.
//   Spin   — a busy loop for the last few ms. It burns one core for a moment and
//            is the only way to hit a sub-millisecond target from userspace.
//
// Every comparison uses the corrected clock, so a local clock that is 300ms slow
// does not turn into a 300ms late mint.

import { CorrectedClock } from "./clock";

export interface FirePlan {
  /** Corrected-time instant to begin dispatching, in ms since epoch. */
  fireAtMs: number;
  /** Stage opening in corrected time, for reporting. */
  stageOpensAtMs: number;
  /** Negative = firing before the stage opens. */
  leadMs: number;
}

export interface WaitProgress {
  remainingMs: number;
  phase: "coarse" | "fine" | "spin";
}

const SPIN_WINDOW_MS = 25;
const FINE_WINDOW_MS = 2000;
const FINE_HOP_MS = 50;

/**
 * Decide when to dispatch.
 *
 * `leadMs` fires early on purpose. On a chain where transactions queue in a
 * mempool, arriving a little before the stage opens means sitting at the front of
 * the queue when it does — but only if the stage check is against block time, and
 * only if the block containing the transaction lands after the opening. Fire too
 * early and SeaDrop reverts with NotActive.
 *
 * The safe default is 0: dispatch at T-0 and let propagation do the rest. A
 * positive lead is opt-in for operators who know the chain's inclusion behaviour.
 */
export function planFire(
  stageStartSec: number,
  opts: { leadMs?: number } = {},
): FirePlan {
  const stageOpensAtMs = stageStartSec * 1000;
  const leadMs = opts.leadMs ?? 0;
  return { fireAtMs: stageOpensAtMs - leadMs, stageOpensAtMs, leadMs };
}

/**
 * Raised when a countdown is cancelled. Distinct wording from the engine's
 * pre-dispatch check so a journal says which of the two stopped the run.
 */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Cancelled during the countdown — nothing was sent.");
}

/**
 * Sleep, waking early if the run is cancelled.
 *
 * Without the listener a cancellation waits out the current chunk. That is a
 * second at worst here, but the same function is used for the fine hops, and a
 * countdown that ignores the abort it was handed is the bug this replaced.
 */
function nap(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    signal.addEventListener("abort", wake, { once: true });
  });
}

/**
 * Block until the corrected clock reaches `targetMs`.
 *
 * Returns the signed error in milliseconds: negative means the loop exited
 * before the target (it never should), positive means it overshot by that much.
 * Reporting it makes the timing auditable rather than assumed.
 */
export async function waitUntil(
  targetMs: number,
  clock: CorrectedClock,
  onProgress?: (progress: WaitProgress) => void,
  signal?: AbortSignal,
): Promise<number> {
  throwIfCancelled(signal);
  let remaining = targetMs - clock.now();
  if (remaining <= 0) return -remaining;

  // Coarse: sleep in chunks, reporting progress, until inside the fine window.
  while (remaining > FINE_WINDOW_MS) {
    onProgress?.({ remainingMs: remaining, phase: "coarse" });
    // Cap each sleep so a moved stage or a re-sync is noticed within a second.
    const sleep = Math.min(remaining - FINE_WINDOW_MS, 1000);
    await nap(sleep, signal);
    throwIfCancelled(signal);
    remaining = targetMs - clock.now();
  }

  // Fine: short hops, re-reading the clock so drift is corrected each time
  // rather than compounding across a single long sleep.
  while (remaining > SPIN_WINDOW_MS) {
    onProgress?.({ remainingMs: remaining, phase: "fine" });
    const sleep = Math.min(remaining - SPIN_WINDOW_MS, FINE_HOP_MS);
    await nap(sleep, signal);
    throwIfCancelled(signal);
    remaining = targetMs - clock.now();
  }

  // Spin: the last few milliseconds, where setTimeout's granularity is the
  // dominant error term.
  if (remaining > 0) {
    onProgress?.({ remainingMs: remaining, phase: "spin" });
    while (clock.now() < targetMs) {
      /* deliberate busy wait — sub-ms precision is not otherwise reachable */
    }
  }

  return clock.now() - targetMs;
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** ISO-8601 in UTC, seconds precision — unambiguous in logs and across timezones. */
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Local time with the offset shown, for humans reading a terminal. */
export function formatLocal(ms: number): string {
  const date = new Date(ms);
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`;
}

/**
 * Parse a user-supplied time into an epoch ms.
 *
 * Accepted, in order of specificity:
 *   - a unix timestamp in seconds or milliseconds
 *   - a full ISO-8601 string (with or without timezone)
 *   - `HH:MM` or `HH:MM:SS`, meaning the next occurrence in local time
 *   - `+90s`, `+5m`, `+2h`, meaning relative to now
 *
 * `nowMs` is injected so the relative and `HH:MM` forms are testable.
 */
export function parseTimeInput(raw: string, nowMs: number = Date.now()): number {
  const value = raw.trim();
  if (!value) throw new Error("No time given.");

  const relative = /^\+(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
    return nowMs + amount * factor;
  }

  if (/^\d{10}$/.test(value)) return Number(value) * 1000;
  if (/^\d{13}$/.test(value)) return Number(value);

  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (clock) {
    const hh = Number(clock[1]);
    const mm = Number(clock[2]);
    const ss = clock[3] ? Number(clock[3]) : 0;
    if (hh > 23 || mm > 59 || ss > 59) {
      throw new Error(`"${raw}" is not a valid 24-hour time.`);
    }
    const target = new Date(nowMs);
    target.setHours(hh, mm, ss, 0);
    // A time already past today means the next occurrence, tomorrow.
    if (target.getTime() <= nowMs) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;

  throw new Error(
    `Could not read "${raw}" as a time. Use HH:MM, an ISO timestamp, a unix time, or +30s / +5m.`,
  );
}
