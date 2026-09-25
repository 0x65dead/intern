// Telling systemd the bot is still working — and, more importantly, not telling
// it when the bot is not.
//
// A watchdog that pings from its own timer is worse than no watchdog at all. It
// proves the event loop still turns, which is exactly the thing that stays true
// when the bot has silently stopped doing its job: a long-poll that never returns,
// a promise that never settles, a loop stuck behind a socket that was never
// closed. systemd sees healthy pings and leaves the corpse running until the
// operator notices at T-0.
//
// So the ping here is gated on evidence. The poll loop stamps a clock every time
// it completes a round trip to Telegram; the watchdog only pings if that stamp is
// recent. When the loop wedges, the pings stop, systemd kills the process, and the
// restart is the recovery. That is the whole point of arming a watchdog.
//
// Everything that decides *whether* to ping is pure and tested. The one impure
// function shells out to systemd-notify, because Node's dgram cannot open a unix
// datagram socket and the dependency budget is ethers + dotenv.

import { execFile } from "child_process";

export interface WatchdogConfig {
  /** How often to ping, already halved from systemd's deadline. */
  intervalMs: number;
  /** systemd's own deadline, for the log line that says what was armed. */
  deadlineMs: number;
}

/**
 * Read systemd's watchdog settings out of the environment.
 *
 * Returns null whenever the watchdog is not armed for *this* process, which is
 * the common case: run from a shell, run under a different supervisor, or run as
 * a child that merely inherited the variables. A null here is not a problem to
 * report — it means nobody asked for a watchdog — but it does mean the bot must
 * not claim to have one.
 */
export function readWatchdogConfig(env: NodeJS.ProcessEnv, pid: number): WatchdogConfig | null {
  const usec = env.WATCHDOG_USEC?.trim();
  if (!usec || !/^\d+$/.test(usec)) return null;

  // systemd sets WATCHDOG_PID when the watchdog belongs to one specific process.
  // A child that inherited these variables must not answer on its parent's behalf:
  // it would keep the watchdog satisfied while the process that matters is hung.
  const owner = env.WATCHDOG_PID?.trim();
  if (owner && owner !== String(pid)) return null;

  const deadlineMs = Math.floor(Number(usec) / 1000);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return null;

  // Half the deadline is the interval systemd's own documentation recommends: it
  // leaves room for one ping to be lost or late without killing a healthy process.
  // Floored at 1s so a misconfigured WatchdogSec=1 cannot become a spin.
  return { intervalMs: Math.max(1_000, Math.floor(deadlineMs / 2)), deadlineMs };
}

/**
 * Whether the bot has done anything lately that proves it is still working.
 *
 * `lastProgressMs` is stamped by the poll loop on every completed round trip to
 * Telegram. The tolerance has to exceed the long-poll timeout — a loop that is
 * healthily blocked waiting for an update has made no progress for as long as
 * Telegram takes to answer, and killing it for that would be a restart loop.
 */
export function isMakingProgress(
  lastProgressMs: number,
  nowMs: number,
  stallLimitMs: number,
  minting = false,
): boolean {
  // A mint in flight is the strongest proof of life this process can offer, and
  // the worst possible moment to be restarted. The poll loop stamps progress only
  // on a completed Telegram round trip, so a Telegram outage during a mint reads
  // as a stall — and systemd answers a stall with SIGKILL. That kills a run that
  // is spending real money, to fix an outage a restart cannot fix. The hashes are
  // journalled, so it is recoverable; it should still never happen.
  if (minting) return true;
  // A clock that jumped backwards must not read as a stall. The measurement is
  // "how long since progress", and a negative answer means the stamp is in the
  // future, which is a clock problem rather than a hung bot.
  const since = nowMs - lastProgressMs;
  return since < stallLimitMs;
}

/**
 * How long to tolerate silence before withholding pings.
 *
 * Derived from the poll timeout rather than configured: the only silence that is
 * normal is a long-poll waiting for an update, so the limit is that timeout plus
 * room for one retry and its backoff. Anything longer is not a quiet chat.
 */
export function stallLimitMs(pollTimeoutSec: number): number {
  return Math.max(60_000, pollTimeoutSec * 1000 * 3);
}

/**
 * Send one WATCHDOG=1 to systemd. Best-effort by design.
 *
 * Failure here is never propagated: if the notification cannot be delivered, the
 * watchdog deadline will expire and systemd will restart the process, which is
 * the correct outcome and needs no help from an exception. Throwing would instead
 * risk taking down a bot that is otherwise perfectly healthy.
 */
export function pingWatchdog(): void {
  try {
    execFile("systemd-notify", ["WATCHDOG=1"], () => {
      // Swallowed deliberately: see above. A missing systemd-notify binary is a
      // deployment fact, not a runtime error, and is reported once at startup.
    });
  } catch {
    // execFile can throw synchronously if the process table is exhausted.
  }
}

/** Whether `systemd-notify` is actually callable, so startup can say so honestly. */
export function probeNotifyBinary(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile("systemd-notify", ["--version"], (err) => resolve(err === null));
    } catch {
      resolve(false);
    }
  });
}
