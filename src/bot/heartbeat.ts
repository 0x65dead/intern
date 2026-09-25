// The unattended heartbeat.
//
// An operator who leaves intern running for two days needs to know it is still
// alive, and needs that without a notification every thirty minutes for two days.
// Those are not in tension: Telegram lets a message be edited in place, so the
// heartbeat is one message that keeps changing rather than a stream of messages
// that say the same thing.
//
// Three rules make that work, and all three are decided here rather than at the
// call site, so "never spams" is a property of the code and not of the caller's
// discipline:
//
//   One message. The first beat sends; every beat after edits that same id.
//   No no-ops. Identical text is not re-sent — Telegram rejects an unchanged edit
//     with a 400 anyway, and the traffic buys nothing.
//   No early beats. The interval is enforced here, so a caller in a tight loop
//     cannot accidentally turn the heartbeat into a firehose.

// The single import: "is this message gone?" is a fact about the Telegram
// protocol, and a second copy of that regex here would drift from the one the
// panel painter uses.
import { isMessageGone } from "./api";

export interface HeartbeatState {
  /** The message being edited. Null until the first beat has been sent. */
  messageId: number | null;
  lastBeatMs: number;
  lastText: string | null;
}

export function newHeartbeat(): HeartbeatState {
  return { messageId: null, lastBeatMs: 0, lastText: null };
}

export type BeatAction =
  | { kind: "send"; text: string }
  | { kind: "edit"; messageId: number; text: string }
  | { kind: "none"; reason: string };

/**
 * Decide what this tick should do.
 *
 * `force` exists for the beats that are not routine — a mint finishing, a drift
 * guard refusing — where the interval should not hold the news back. It still
 * cannot produce a duplicate: unchanged text is a no-op whether forced or not.
 */
export function planBeat(
  state: HeartbeatState,
  text: string,
  nowMs: number,
  intervalMs: number,
  force = false,
): BeatAction {
  if (state.messageId === null) {
    // The first beat goes out immediately; a *replacement* beat waits for the
    // interval. Without this, a heartbeat chat that can never be reached — or one
    // whose message was deleted — is retried on every poll round trip forever,
    // which spends the whole bot's rate limit on a message nobody receives.
    if (!force && state.lastBeatMs !== 0 && nowMs - state.lastBeatMs < intervalMs) {
      const waitMs = intervalMs - (nowMs - state.lastBeatMs);
      return { kind: "none", reason: `Retrying the beat in ${Math.ceil(waitMs / 1000)}s.` };
    }
    return { kind: "send", text };
  }

  if (text === state.lastText) {
    return { kind: "none", reason: "Nothing changed since the last beat." };
  }
  if (!force && nowMs - state.lastBeatMs < intervalMs) {
    const waitMs = intervalMs - (nowMs - state.lastBeatMs);
    return { kind: "none", reason: `Next beat in ${Math.ceil(waitMs / 1000)}s.` };
  }
  return { kind: "edit", messageId: state.messageId, text };
}

/** Fold a completed action back into the state. A no-op changes nothing. */
/**
 * Fold a failed beat back into the state, so the liveness signal can recover.
 *
 * `planBeat` only sends a fresh message while `messageId` is null, and the failure
 * path used to leave the state entirely untouched. Two things followed, both bad:
 *
 * - If the heartbeat message was deleted, every future edit targeted a message
 *   that no longer existed, so the signal was permanently dead — and a dead
 *   liveness signal is indistinguishable from a dead bot, which is the one thing
 *   it exists to tell apart.
 * - `lastBeatMs` never advanced, so the interval check could not throttle, and a
 *   failing beat was retried on every poll tick. That turns one broken message
 *   into a 429 against the token the whole bot shares.
 *
 * So a gone message clears the id — the next beat posts a new one — and any other
 * failure still advances the clock, to back off to the configured interval.
 */
export function beatFailure(
  state: HeartbeatState,
  message: string,
  nowMs: number,
): HeartbeatState {
  if (isMessageGone(message)) {
    // No message holds `lastText` any more, so it must not suppress the resend.
    return { messageId: null, lastBeatMs: nowMs, lastText: null };
  }
  return { ...state, lastBeatMs: nowMs };
}

export function applyBeat(
  state: HeartbeatState,
  action: BeatAction,
  nowMs: number,
  sentMessageId?: number,
): HeartbeatState {
  if (action.kind === "none") return state;
  if (action.kind === "send") {
    return {
      messageId: sentMessageId ?? state.messageId,
      lastBeatMs: nowMs,
      lastText: action.text,
    };
  }
  return { messageId: action.messageId, lastBeatMs: nowMs, lastText: action.text };
}

export interface HeartbeatStatus {
  /** What intern is doing: "watching", "armed", "firing", "idle". */
  phase: string;
  target: string | null;
  chain: string;
  walletCount: number;
  /** Corrected-clock ms until the next stage opens, or null. */
  untilOpenMs: number | null;
  /** The drift guard's one-line verdict, when it has one to report. */
  clockNote?: string;
  lastEventText?: string;
  nowMs: number;
}

function briefDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The heartbeat's text.
 *
 * Deliberately terse and deliberately complete: an operator glancing at a phone
 * should be able to tell, in one line each, that intern is alive, what it is
 * pointed at, how long until it matters, and whether anything is wrong. A
 * heartbeat that says only "alive" is a heartbeat nobody reads after the first
 * day, and one nobody reads is the same as no heartbeat at all.
 *
 * Returns plain text. The caller escapes it — this module does not know whether
 * it is being rendered into HTML.
 */
export function heartbeatText(status: HeartbeatStatus): string {
  const stamp = new Date(status.nowMs).toISOString().replace("T", " ").slice(0, 19);
  const lines = [
    `intern · ${status.phase}`,
    `target: ${status.target ?? "none set"}`,
    `chain:  ${status.chain} · ${status.walletCount} wallet${status.walletCount === 1 ? "" : "s"}`,
  ];
  if (status.untilOpenMs !== null) {
    lines.push(`opens:  in ${briefDuration(status.untilOpenMs)}`);
  }
  if (status.clockNote) lines.push(`clock:  ${status.clockNote}`);
  if (status.lastEventText) lines.push(`last:   ${status.lastEventText}`);
  lines.push(`as of ${stamp} UTC`);
  return lines.join("\n");
}
