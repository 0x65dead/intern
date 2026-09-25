#!/usr/bin/env node
// The bot process: startup checks, the long-poll loop, shutdown.
//
// Startup refuses to continue on two conditions, both deliberately fatal rather
// than warned:
//
//   No TELEGRAM_ALLOWED_IDS. A bot token is a bearer credential — anyone who has it
//   can message the bot, and a token in a .env file, a screenshot or a shell history
//   has a way of getting out. Without an id allowlist, this process will sign
//   transactions for whoever finds it. Starting "open for now" is how that happens,
//   so it does not start.
//
//   No wallets. A bot that cannot sign is a bot that discovers this at T-0, on the
//   mint the user was waiting for. Better to fail at boot with the reason.
//
// Pending updates are dropped at startup. A "fire" command that was sent while the
// process was down should not execute on restart, minutes late, against a stage
// whose price has moved.

import { AbortedError, ConflictError, TelegramClient, TelegramError, bold, esc } from "./api";
import {
  BeatAction,
  HeartbeatState,
  applyBeat,
  beatFailure,
  heartbeatText,
  newHeartbeat,
  planBeat,
} from "./heartbeat";
import {
  isMakingProgress,
  pingWatchdog,
  probeNotifyBinary,
  readWatchdogConfig,
  stallLimitMs,
} from "./watchdog";
import { BOT_COMMANDS, SessionManager } from "./session";
import { loadEnv, readDefaults } from "../util/env";
import { redactKeys, walletsFromEnv } from "../core/wallets";
import { clearState, defaultStatePath, readState, recoveryReport } from "../core/runstate";
import { shortAddress } from "../core/target";
import { CorrectedClock, syncClock } from "../core/clock";
import { resolveChain } from "../core/chains";
import { resolveRpcsForChain } from "../core/rpc";

import { writeOut, writeErr } from "../util/out";
/** Backoff between reconnects, in ms. Grows on repeated failure, resets on success. */
/**
 * The longest a retry_after is obeyed before the loop polls anyway.
 *
 * Telegram's own number is honoured below this, because ignoring it is what turns
 * a brief limit into a long one. Above it the calculation inverts: a bot that is
 * deliberately offline for the half hour a server asked for is no longer a bot
 * that is up when a stage opens, and nothing tells the operator it is sitting
 * out. Retrying early risks another 429; not retrying guarantees a missed mint.
 */
const MAX_POLL_WAIT_MS = 120_000;

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** Telegram long-poll timeout, in seconds. Shared with the stall limit. */
const POLL_TIMEOUT_SEC = 50;

export async function runBot(): Promise<void> {
  loadEnv();
  const defaults = readDefaults();

  if (!defaults.telegramToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and put the token in .env.",
    );
  }

  if (defaults.telegramAllowedIds.length === 0) {
    throw new Error(
      [
        "TELEGRAM_ALLOWED_IDS is empty, so this bot will not start.",
        "",
        "The bot token is the only thing standing between a stranger and your wallets,",
        "and a token is easy to leak. Set TELEGRAM_ALLOWED_IDS to the numeric Telegram",
        "user ids allowed to command this bot:",
        "",
        "    TELEGRAM_ALLOWED_IDS=123456789,987654321",
        "",
        "Message @userinfobot on Telegram to find your id. Ids, not usernames — a",
        "username can be changed by whoever holds it.",
      ].join("\n"),
    );
  }

  const wallets = walletsFromEnv();
  if (wallets.length === 0) {
    throw new Error(
      "No wallets loaded. Set PRIVATE_KEYS in .env — the bot signs locally and never accepts keys over Telegram.",
    );
  }

  const client = new TelegramClient(defaults.telegramToken);
  const me = await client.getMe();

  // Measure the local clock against the network once at startup, so every panel
  // countdown and "updated at" footer reads corrected time. This is only for
  // display: an actual mint re-syncs inside the engine against the chain it fires
  // on. Best-effort — a bot that cannot reach an RPC at boot must still start,
  // because the wallets and the allowlist are what make it useful, not the clock.
  const clock = new CorrectedClock(0);
  try {
    const chain = resolveChain(defaults.chain);
    if (chain) {
      const resolved = resolveRpcsForChain(chain.key, [], process.env);
      const sync = await syncClock(resolved.urls, chain.blockTimeSec, { rounds: 2 });
      clock.applySync(sync);
    }
  } catch {
    // Fall through with a zero offset — the local clock, used as-is.
  }

  const manager = new SessionManager({
    client,
    defaults,
    wallets,
    allowedIds: defaults.telegramAllowedIds,
    clock,
  });

  // ── Unattended supervision ───────────────────────────────────────────────
  //
  // Two independent things, deliberately not one: the watchdog tells systemd the
  // bot is working (and stops telling it when the poll loop wedges), while the
  // heartbeat tells the operator the same thing in a message they can read from
  // a phone. Either can be absent without affecting the other.
  const watchdog = readWatchdogConfig(process.env, process.pid);
  const canNotify = watchdog === null ? false : await probeNotifyBinary();
  const stallMs = stallLimitMs(POLL_TIMEOUT_SEC);
  let lastProgressMs = Date.now();

  if (watchdog !== null && canNotify) {
    const timer = setInterval(() => {
      // The gate. A ping sent regardless of progress would prove only that the
      // event loop turns, which stays true when the bot has stopped working.
      if (isMakingProgress(lastProgressMs, Date.now(), stallMs, manager.isRunning())) {
        pingWatchdog();
      }
    }, watchdog.intervalMs);
    timer.unref?.();
  }

  const heartbeatChatId =
    defaults.heartbeatChatId ?? defaults.telegramAllowedIds[0] ?? null;
  const heartbeatMs = defaults.heartbeatMinutes * 60_000;
  let heartbeat: HeartbeatState = newHeartbeat();

  // Nothing in here may throw. It is awaited inside the poll loop's try, *after*
  // getUpdates has already committed its offset — so an exception escaping this
  // function is caught as a poll failure, backs the loop off for up to two
  // minutes, and silently discards the batch of commands already fetched. The
  // whole body is inside the try for that reason, not just the network calls:
  // building the text touches the manager, the clock and the wallet list.
  const beat = async (force = false): Promise<void> => {
    if (heartbeatMs === 0 || heartbeatChatId === null) return;
    try {
      await beatOnce(force);
    } catch (err: unknown) {
      const message = redactKeys(err instanceof Error ? err.message : String(err));
      heartbeat = beatFailure(heartbeat, message, clock.now());
      writeErr(`heartbeat failed: ${message}\n`);
    }
  };

  const beatOnce = async (force: boolean): Promise<void> => {
    if (heartbeatChatId === null) return;
    // Escaped and redacted here, before planBeat, so the text compared for
    // "nothing changed" is byte-for-byte the text that was sent. heartbeatText
    // returns plain text by contract and does not know it is going into HTML.
    const text = esc(
      redactKeys(
        heartbeatText({
          phase: manager.isRunning() ? "minting" : "idle",
          target: manager.currentTarget(),
          chain: defaults.chain,
          walletCount: wallets.length,
          untilOpenMs: null,
          ...(Math.abs(clock.offset) >= 1_000
            ? {
                clockNote: `local clock is ${Math.abs(clock.offset)}ms ${clock.offset >= 0 ? "slow" : "fast"} — corrected`,
              }
            : {}),
          nowMs: clock.now(),
        }),
      ),
    );
    // A heartbeat that cannot be delivered is not a reason to stop minting — but
    // it is a reason to update the state, or the next beat repeats it. That
    // bookkeeping now lives in the caller's catch, which covers this and the text
    // above alike.
    const action: BeatAction = planBeat(heartbeat, text, clock.now(), heartbeatMs, force);
    if (action.kind === "send") {
      // Silent: the first beat is the only one that can notify, and waking
      // someone at 3am to say "still idle" is how a heartbeat gets muted.
      const sent = await client.sendMessage(heartbeatChatId, action.text, { silent: true });
      heartbeat = applyBeat(heartbeat, action, clock.now(), sent.message_id);
    } else if (action.kind === "edit") {
      await client.editMessage(heartbeatChatId, action.messageId, action.text);
      heartbeat = applyBeat(heartbeat, action, clock.now());
    }
  };

  const backlog = await client.dropPendingUpdates();
  await client.setCommands(BOT_COMMANDS);

  // ── Crash recovery ───────────────────────────────────────────────────────
  //
  // The write half of this runs in the engine: every wallet's transaction hash
  // is journalled before its broadcast leaves. This is the read half, and it is
  // deliberately a report rather than a resume. A restarted process no longer
  // holds the signed bytes, so it cannot re-send them, and signing fresh ones at
  // the same nonce would compete with transactions that may already be confirmed.
  //
  // What it can do is make sure the hashes reach a human. The journal is only
  // discarded once that has actually happened — a Telegram outage must not be
  // the reason an operator re-mints a wallet that already succeeded.
  await reportRecovery(client, recoveryTargets(heartbeatChatId, defaults.telegramAllowedIds));

  writeOut(
    [
      `intern bot online as @${me.username ?? me.id}`,
      `  wallets: ${wallets.length} — ${wallets.map((w) => shortAddress(w.address)).join(", ")}`,
      `  allowed: ${defaults.telegramAllowedIds.length} id(s)`,
      `  chain:   ${defaults.chain}`,
      `  clock:   ${clock.offset >= 0 ? "+" : ""}${clock.offset}ms correction`,
      watchdogLine(watchdog, canNotify),
      heartbeatMs === 0 || heartbeatChatId === null
        ? "  beat:    off"
        : `  beat:    every ${defaults.heartbeatMinutes}m to chat ${heartbeatChatId}`,
      backlog.hadBacklog
        ? `  dropped: a backlog queued while offline, through update #${backlog.throughId}`
        : "",
      "",
      "bot is running — leave this process alive (systemd recommended).",
      "See deploy/intern-bot.service. Ctrl+C to stop.",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n",
  );

  let stopping = false;
  // Cancels the long poll and any backoff sleep, so the signal is acted on when it
  // arrives rather than whenever the current 50s poll happens to return.
  const shutdown = new AbortController();
  const stop = (): void => {
    if (stopping) {
      process.exit(130);
    }
    stopping = true;
    writeOut("\nStopping — in-flight runs are being aborted.\n");
    // Without this the loop stays parked in getUpdates for up to fifty seconds
    // after Ctrl+C. It reads as a hang, and under systemd's TimeoutStopSec it ends
    // as a SIGKILL — the slowest possible restart for a process whose only job is
    // to be up when a stage opens.
    shutdown.abort();
    manager.shutdown();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let backoff = BACKOFF_MIN_MS;

  while (!stopping) {
    try {
      const updates = await client.getUpdates(POLL_TIMEOUT_SEC, shutdown.signal);
      backoff = BACKOFF_MIN_MS;
      // The only evidence the watchdog accepts: a completed round trip.
      lastProgressMs = Date.now();
      await beat();

      // Sequential, not concurrent. Two commands from the same chat arriving in one
      // batch must be applied in the order they were sent, or "/mint x" followed by
      // a confirmation tap can be processed the wrong way round.
      for (const update of updates) {
        if (stopping) break;
        try {
          await manager.handleUpdate(update);
        } catch (err: unknown) {
          // One bad update must never end the loop: the bot would go silent
          // precisely when someone is relying on it.
          const message = redactKeys(err instanceof Error ? err.message : String(err));
          writeErr(`update ${update.update_id} failed: ${message}\n`);
          const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
          if (chatId !== undefined) {
            await client
              .sendMessage(chatId, `${bold("Something went wrong")}\n${esc(message)}`)
              .catch(() => {});
          }
        }
      }
    } catch (err: unknown) {
      // Our own doing. Nothing to report and nothing to retry.
      if (err instanceof AbortedError || stopping) break;
      if (err instanceof ConflictError) {
        writeErr(`\n${err.message}\n`);
        manager.shutdown();
        await manager.drain();
        process.exitCode = 1;
        return;
      }
      if (err instanceof TelegramError && err.status === 401) {
        writeErr(`\n${err.message}\n`);
        manager.shutdown();
        await manager.drain();
        process.exitCode = 1;
        return;
      }

      // Everything else — a dropped connection, a 502, a rate limit — is transient.
      const plan = pollBackoff(
        err instanceof TelegramError ? err.retryAfterSec : undefined,
        backoff,
      );
      const message = redactKeys(err instanceof Error ? err.message : String(err));
      writeErr(
        `poll failed (${message}) — retrying in ${Math.round(plan.waitMs / 1000)}s${
          plan.capped ? ` (Telegram asked for ${plan.askedSec}s; capped)` : ""
        }\n`,
      );
      await sleep(plan.waitMs, shutdown.signal);
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    }
  }

  manager.shutdown();
  // Aborted, now let it land: the run still has to send its closing line.
  await manager.drain();
}

/**
 * Say what was actually armed, not what was configured.
 *
 * A line claiming watchdog protection that is not there is the kind of thing an
 * operator reads once at deploy time and trusts for months.
 */
function watchdogLine(
  config: { intervalMs: number; deadlineMs: number } | null,
  canNotify: boolean,
): string {
  if (config === null) return "  watchdog: not armed (no WatchdogSec in the unit file)";
  if (!canNotify) {
    return "  watchdog: WatchdogSec is set but systemd-notify is missing — NOT protected";
  }
  return `  watchdog: ping every ${Math.round(config.intervalMs / 1000)}s, systemd kills after ${Math.round(config.deadlineMs / 1000)}s`;
}

/**
 * Surface a journal left behind by a previous process, then discard it.
 *
 * Ordering matters: the journal is cleared only after the operator has been told
 * what was in it. Clearing first would be tidier and would lose the one record
 * that a broadcast ever happened.
 */
export function recoveryTargets(
  heartbeatChatId: number | null,
  allowedIds: readonly number[],
): number[] {
  const out: number[] = [];
  for (const id of [heartbeatChatId, ...allowedIds]) {
    if (id === null || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

async function reportRecovery(
  client: TelegramClient,
  chatIds: readonly number[],
): Promise<void> {
  const file = defaultStatePath();
  const state = readState(file);
  if (state === null) return;

  const report = recoveryReport(state);
  const text = redactKeys(report.lines.join("\n"));

  if (!report.needsAttention) {
    // Nothing reached the network. Noted on stdout for the journal, but not
    // worth a notification — this is what an ordinary restart looks like.
    writeOut(`${text}\n\n`);
    try {
      clearState(file);
    } catch {
      // A journal that cannot be deleted is harmless: it describes a run that
      // never broadcast, and the next run overwrites it.
    }
    return;
  }

  writeOut(`\n⚠ ${text}\n\n`);

  if (chatIds.length === 0) {
    // No chat to tell. The journal stays on disk precisely because the only
    // copy of this information is now the file and the console scrollback.
    writeOut(
      `The journal at ${file} has been kept — no Telegram destination was configured to send it to.\n\n`,
    );
    return;
  }

  // Every configured destination is tried, not just the first. This message
  // carries transaction hashes for wallets that may already have spent money, and
  // the one chat at the head of the list is exactly the one that can have blocked
  // the bot or removed it from a group since the last run. Stop at the first that
  // accepts it; an operator reading it twice is not a problem worth a lost report.
  const failures: string[] = [];
  let delivered = false;
  for (const chatId of chatIds) {
    try {
      await client.sendMessage(chatId, `${bold("Unfinished run recovered")}\n\n${esc(text)}`);
      delivered = true;
      break;
    } catch (err: unknown) {
      failures.push(
        `chat ${chatId}: ${redactKeys(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  if (!delivered) {
    writeOut(
      `Could not deliver the recovery report to any of ${chatIds.length} chat(s) — ${failures.join("; ")}. Keeping ${file} so it is not lost.\n\n`,
    );
    return;
  }

  try {
    clearState(file);
  } catch {
    // Delivered but not deletable. The operator has the information, which is
    // the part that matters; the next run overwrites the file.
  }
}

/**
 * Back off without letting the process exit.
 *
 * This timer is deliberately *not* unref'd. It used to be, and during a backoff
 * there is nothing else pending — `getUpdates` has already failed, so no socket is
 * open — which left the event loop empty. Node then exited with code 0 in the
 * middle of a retry: the bot vanished after one transient Telegram error, with a
 * success status that tells a `Restart=on-failure` unit not to bring it back. The
 * watchdog interval above is unref'd because it must not keep the process alive;
 * this must.
 */
/**
 * How long to wait before polling again.
 *
 * Kept separate from the loop so it can be tested without waiting: the branch that
 * matters is the one nobody would notice in production until the bot had been
 * quietly offline for an hour.
 */
export function pollBackoff(
  retryAfterSec: number | undefined,
  backoffMs: number,
  maxMs = MAX_POLL_WAIT_MS,
): { waitMs: number; capped: boolean; askedSec: number } {
  const asked =
    retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.ceil(retryAfterSec)
      : 0;
  if (asked === 0) return { waitMs: backoffMs, capped: false, askedSec: 0 };
  const wanted = asked * 1_000;
  // Never shorter than our own backoff: a 429 answered by an immediate retry is
  // how a one-second limit becomes a one-minute one.
  const waitMs = Math.max(backoffMs, Math.min(maxMs, wanted));
  return { waitMs, capped: wanted > maxMs, askedSec: asked };
}

/** Resolves early when aborted, so shutdown does not wait out a backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
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

// Runnable directly (`npm run bot`) as well as through `intern bot`.
if (require.main === module) {
  runBot().catch((err: unknown) => {
    const message = redactKeys(err instanceof Error ? err.message : String(err));
    writeErr(`\n${message}\n`);
    process.exit(1);
  });
}
