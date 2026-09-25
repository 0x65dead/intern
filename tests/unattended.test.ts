// Running with nobody watching.
//
// Three guards, each covering a failure that only shows up when there is no
// operator at the terminal to notice it:
//
//   driftGuard   — a machine whose clock cannot be measured will fire at the
//                  wrong instant and report success. Refusing is the only honest
//                  option once nobody is watching.
//   runstate     — a daemon that restarts mid-broadcast must not sign a second
//                  transaction at the same nonce.
//   heartbeat    — "still alive" must not become a notification every N minutes
//                  forever, or it stops being read.
//   pollBackoff  — a retry_after obeyed literally can park the bot offline for
//                  longer than the mint it was left running for.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClockSync, driftGuard } from "../src/core/clock";
import { pollBackoff, recoveryTargets } from "../src/bot/index";
import {
  RunState,
  clearState,
  isUntouched,
  newRunId,
  newRunState,
  readState,
  recordIntent,
  recordOutcome,
  recoveryReport,
  resumeAction,
  writeState,
} from "../src/core/runstate";
import {
  applyBeat,
  beatFailure,
  heartbeatText,
  newHeartbeat,
  planBeat,
} from "../src/bot/heartbeat";

const NOW = 1773576000000;

const sync = (over: Partial<ClockSync> = {}): ClockSync => ({
  offsetMs: 12,
  uncertaintyMs: 40,
  samples: [],
  synced: true,
  ...over,
});

describe("driftGuard", () => {
  it("passes a well-measured clock", () => {
    const verdict = driftGuard(sync(), 2_000);
    assert.equal(verdict.ok, true);
    assert.match(verdict.detail, /uncertainty ±40ms/);
  });

  it("refuses when the offset could not be measured at all", () => {
    // A person at a terminal can accept firing against an unvalidated clock and
    // watch what happens. A daemon cannot, because nobody will notice.
    const verdict = driftGuard(sync({ synced: false, offsetMs: 0 }), 2_000);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /unvalidated clock/i);
  });

  it("refuses when uncertainty exceeds the limit", () => {
    const verdict = driftGuard(sync({ uncertaintyMs: 3_000 }), 2_000);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /±3000ms/);
    assert.match(verdict.detail, /CLOCK_DRIFT_LIMIT_MS/);
  });

  it("passes a large but well-measured offset, and says why", () => {
    // The distinction that matters. A clock four seconds slow is corrected for
    // exactly; refusing on offset would ground a machine that can hit T-0 to the
    // millisecond, while letting through one whose uncertainty is genuinely bad.
    const verdict = driftGuard(sync({ offsetMs: -4_000, uncertaintyMs: 30 }), 2_000);
    assert.equal(verdict.ok, true);
    assert.match(verdict.detail, /offset -4000ms/);
    assert.match(verdict.detail, /not itself a problem/i);
  });

  it("always states what it measured, in both directions", () => {
    for (const s of [sync(), sync({ synced: false }), sync({ uncertaintyMs: 9_999 })]) {
      assert.ok(driftGuard(s, 2_000).detail.length > 40);
    }
  });
});

describe("runstate", () => {
  const state = (): RunState =>
    newRunState({
      runId: "r1",
      target: "cool-drop",
      chainId: 8453,
      startedAtMs: NOW,
      wallets: [
        { index: 0, address: "0x1111111111111111111111111111111111111111", nonce: 7 },
        { index: 1, address: "0x2222222222222222222222222222222222222222", nonce: 2 },
      ],
    });

  it("starts with nothing sent", () => {
    assert.equal(isUntouched(state()), true);
  });

  it("fires a wallet with no record", () => {
    const action = resumeAction(state().wallets[0]!);
    assert.equal(action.kind, "fire");
  });

  it("verifies rather than re-signs a wallet caught mid-broadcast", () => {
    // The whole reason intent is recorded before the broadcast. A restarted
    // process no longer holds the signed bytes, so signing again produces a
    // *different* transaction at the same nonce — a replacement nobody asked for.
    const after = recordIntent(state(), 0, "0xabc");
    const action = resumeAction(after.wallets[0]!);
    assert.equal(action.kind, "verify");
    if (action.kind !== "verify") return;
    assert.equal(action.txHash, "0xabc");
    assert.match(action.reason, /would compete with the first/i);
  });

  it("marks the run as firing the moment intent is recorded", () => {
    assert.equal(recordIntent(state(), 0, "0xabc").status, "firing");
  });

  it("skips a wallet that already broadcast successfully", () => {
    const after = recordOutcome(recordIntent(state(), 0, "0xabc"), 0, "accepted");
    assert.equal(resumeAction(after.wallets[0]!).kind, "skip");
  });

  it("does not silently retry a rejection", () => {
    // A rejection that repeats costs gas each time. Retrying it unattended turns
    // one failed mint into a slow drain.
    const after = recordOutcome(recordIntent(state(), 0, "0xabc"), 0, "rejected", "nonce too low");
    const action = resumeAction(after.wallets[0]!);
    assert.equal(action.kind, "skip");
    if (action.kind !== "skip") return;
    assert.match(action.reason, /nonce too low/);
  });

  it("touches only the wallet it was told to", () => {
    const after = recordIntent(state(), 0, "0xabc");
    assert.equal(after.wallets[1]!.txHash, undefined);
    assert.equal(resumeAction(after.wallets[1]!).kind, "fire");
  });

  it("round-trips through the filesystem", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intern-state-"));
    const file = path.join(dir, "run.json");
    try {
      const original = recordIntent(state(), 1, "0xdef");
      writeState(original, file);
      const back = readState(file);
      assert.ok(back);
      assert.equal(back.runId, "r1");
      assert.equal(back.wallets[1]!.txHash, "0xdef");
      assert.equal(resumeAction(back.wallets[1]!).kind, "verify");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes with owner-only permissions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intern-state-"));
    const file = path.join(dir, "run.json");
    try {
      writeState(state(), file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a missing, corrupt, or foreign-version file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intern-state-"));
    try {
      assert.equal(readState(path.join(dir, "absent.json")), null);

      const corrupt = path.join(dir, "corrupt.json");
      fs.writeFileSync(corrupt, "{not json");
      assert.equal(readState(corrupt), null);

      const future = path.join(dir, "future.json");
      fs.writeFileSync(future, JSON.stringify({ version: 99, runId: "x", wallets: [] }));
      assert.equal(readState(future), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears without complaining about a file that is not there", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intern-state-"));
    try {
      assert.doesNotThrow(() => clearState(path.join(dir, "absent.json")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries no key material into the file", () => {
    // This file is written by a daemon, read by a restart, and is exactly the
    // kind of thing that ends up in a support paste.
    const json = JSON.stringify(recordIntent(state(), 0, "0xabc"));
    assert.doesNotMatch(json, /0x[0-9a-fA-F]{64}/);
    assert.doesNotMatch(json, /"key"/);
    assert.doesNotMatch(json, /private/i);
  });

  it("gives each run a distinct id", () => {
    assert.notEqual(newRunId(NOW), newRunId(NOW + 1));
  });
});

describe("heartbeat", () => {
  const INTERVAL = 30 * 60_000;

  it("sends the first beat, because there is nothing to edit yet", () => {
    const action = planBeat(newHeartbeat(), "alive", NOW, INTERVAL);
    assert.equal(action.kind, "send");
  });

  it("edits that same message forever after", () => {
    // One message, not one per beat. This is the difference between a status line
    // an operator keeps glancing at and 48 notifications a day they mute.
    let state = applyBeat(newHeartbeat(), { kind: "send", text: "a" }, NOW, 4242);
    const action = planBeat(state, "b", NOW + INTERVAL, INTERVAL);
    assert.equal(action.kind, "edit");
    if (action.kind !== "edit") return;
    assert.equal(action.messageId, 4242);

    state = applyBeat(state, action, NOW + INTERVAL);
    const next = planBeat(state, "c", NOW + 2 * INTERVAL, INTERVAL);
    assert.equal(next.kind, "edit");
    if (next.kind !== "edit") return;
    assert.equal(next.messageId, 4242, "the heartbeat must not migrate to a new message");
  });

  it("does nothing when the text has not changed", () => {
    // Telegram rejects an unchanged edit with a 400 regardless, so this saves an
    // error as well as the traffic.
    const state = applyBeat(newHeartbeat(), { kind: "send", text: "same" }, NOW, 1);
    const action = planBeat(state, "same", NOW + 10 * INTERVAL, INTERVAL);
    assert.equal(action.kind, "none");
    if (action.kind !== "none") return;
    assert.match(action.reason, /Nothing changed/i);
  });

  it("holds back a beat that is early", () => {
    const state = applyBeat(newHeartbeat(), { kind: "send", text: "a" }, NOW, 1);
    const action = planBeat(state, "b", NOW + 60_000, INTERVAL);
    assert.equal(action.kind, "none");
    if (action.kind !== "none") return;
    assert.match(action.reason, /Next beat in \d+s/);
  });

  it("lets urgent news through the interval", () => {
    const state = applyBeat(newHeartbeat(), { kind: "send", text: "a" }, NOW, 1);
    const action = planBeat(state, "MINTED", NOW + 1_000, INTERVAL, true);
    assert.equal(action.kind, "edit");
  });

  it("still refuses a duplicate even when forced", () => {
    const state = applyBeat(newHeartbeat(), { kind: "send", text: "a" }, NOW, 1);
    assert.equal(planBeat(state, "a", NOW + 1_000, INTERVAL, true).kind, "none");
  });

  it("cannot be turned into a firehose by a tight caller loop", () => {
    // The interval is enforced here, not at the call site, so a caller polling
    // every second produces exactly one beat per interval.
    let state = applyBeat(newHeartbeat(), { kind: "send", text: "t0" }, NOW, 1);
    let sent = 0;
    for (let t = 1_000; t <= INTERVAL * 2; t += 1_000) {
      const action = planBeat(state, `t${t}`, NOW + t, INTERVAL);
      if (action.kind !== "none") {
        sent += 1;
        state = applyBeat(state, action, NOW + t);
      }
    }
    assert.equal(sent, 2, `expected 2 beats across two intervals, got ${sent}`);
  });
});

describe("heartbeatText", () => {
  const base = {
    phase: "watching",
    target: "cool-drop",
    chain: "base",
    walletCount: 3,
    untilOpenMs: 5_400_000,
    nowMs: NOW,
  };

  it("says what it is, what it is pointed at, and when it matters", () => {
    const text = heartbeatText(base);
    assert.match(text, /intern · watching/);
    assert.match(text, /target: cool-drop/);
    assert.match(text, /base · 3 wallets/);
    assert.match(text, /opens:  in 1h 30m/);
  });

  it("says 'none set' rather than leaving the target blank", () => {
    assert.match(heartbeatText({ ...base, target: null }), /none set/);
  });

  it("omits the countdown when there is no next stage", () => {
    assert.doesNotMatch(heartbeatText({ ...base, untilOpenMs: null }), /opens:/);
  });

  it("surfaces a clock problem in the heartbeat itself", () => {
    // The one place an unattended operator will actually see it.
    const text = heartbeatText({ ...base, clockNote: "uncertainty ±3000ms — will not fire" });
    assert.match(text, /clock:.*will not fire/);
  });

  it("carries a timestamp, so a stalled heartbeat is visible as one", () => {
    // Without this, a frozen process and a quiet one look identical.
    assert.match(heartbeatText(base), /as of 2026-03-15 12:00:00 UTC/);
  });

  it("singularises one wallet", () => {
    assert.match(heartbeatText({ ...base, walletCount: 1 }), /1 wallet\b/);
  });

  it("changes when anything changes, so the edit is never a no-op by accident", () => {
    assert.notEqual(heartbeatText(base), heartbeatText({ ...base, phase: "armed" }));
    assert.notEqual(heartbeatText(base), heartbeatText({ ...base, nowMs: NOW + 60_000 }));
  });
});

describe("recoveryReport", () => {
  const state = (): RunState =>
    newRunState({
      runId: "r7",
      target: "cool-drop",
      chainId: 8453,
      startedAtMs: NOW,
      wallets: [
        { index: 0, address: "0x1111111111111111111111111111111111111111", nonce: 7 },
        { index: 1, address: "0x2222222222222222222222222222222222222222", nonce: 2 },
      ],
    });

  it("needs no attention when the process died before broadcasting", () => {
    // The common case by a wide margin: killed while arming, hours before T-0.
    // Waking the operator for this would train them to ignore the message.
    const report = recoveryReport(state());
    assert.equal(report.needsAttention, false);
    assert.deepEqual(report.verify, []);
  });

  it("says plainly that an untouched journal is safe to discard", () => {
    const text = recoveryReport(state()).lines.join("\n");
    assert.match(text, /without broadcasting anything/i);
    assert.match(text, /Nothing to reconcile/i);
  });

  it("raises a wallet that was mid-broadcast", () => {
    const report = recoveryReport(recordIntent(state(), 0, "0xdead"));
    assert.equal(report.needsAttention, true);
    assert.deepEqual(report.verify, ["0xdead"]);
  });

  it("refuses to re-sign, and says why", () => {
    // The dangerous move is signing again: a different signature at the same
    // nonce competes with a transaction that may already be confirmed.
    const text = recoveryReport(recordIntent(state(), 0, "0xdead")).lines.join("\n");
    assert.match(text, /will not resign/i);
    assert.match(text, /same nonce/i);
  });

  it("names every hash that has to be looked up", () => {
    const mid = recordIntent(recordIntent(state(), 0, "0xaaa"), 1, "0xbbb");
    const report = recoveryReport(mid);
    assert.deepEqual(report.verify, ["0xaaa", "0xbbb"]);
    const text = report.lines.join("\n");
    assert.ok(text.includes("0xaaa"));
    assert.ok(text.includes("0xbbb"));
  });

  it("pluralises the instruction to match the number of hashes", () => {
    const one = recoveryReport(recordIntent(state(), 0, "0xaaa")).lines.join("\n");
    assert.match(one, /Check that hash/);
    const two = recoveryReport(
      recordIntent(recordIntent(state(), 0, "0xaaa"), 1, "0xbbb"),
    ).lines.join("\n");
    assert.match(two, /Check those 2 hashes/);
  });

  it("does not ask for a lookup when every outcome is already known", () => {
    // Both wallets resolved before the crash. Still worth reporting — the
    // operator must not re-mint — but there is nothing to go and check.
    const done = recordOutcome(
      recordOutcome(recordIntent(recordIntent(state(), 0, "0xaaa"), 1, "0xbbb"), 0, "accepted"),
      1,
      "rejected",
      "nonce too low",
    );
    const report = recoveryReport(done);
    assert.equal(report.needsAttention, true);
    assert.deepEqual(report.verify, []);
    assert.match(report.lines.join("\n"), /No transaction is unaccounted for/);
  });

  it("does not retry a rejection on its own", () => {
    const rejected = recordOutcome(recordIntent(state(), 0, "0xaaa"), 0, "rejected", "underpriced");
    const text = recoveryReport(rejected).lines.join("\n");
    assert.match(text, /Not retried automatically/i);
    assert.match(text, /costs gas each time/i);
  });

  it("mentions a wallet that already succeeded, so it is not minted twice", () => {
    const accepted = recordOutcome(recordIntent(state(), 0, "0xaaa"), 0, "accepted");
    assert.match(recoveryReport(accepted).lines.join("\n"), /already broadcast 0xaaa/);
  });

  it("stays silent about wallets that never fired", () => {
    // Wallet 1 has no record. Listing it as "safe to fire" in a recovery report
    // reads like an instruction to fire it, which is not what this is for.
    const text = recoveryReport(recordIntent(state(), 0, "0xaaa")).lines.join("\n");
    assert.doesNotMatch(text, /Safe to fire/);
  });

  it("carries the run identity so the operator knows which drop this was", () => {
    const text = recoveryReport(recordIntent(state(), 0, "0xaaa")).lines.join("\n");
    assert.ok(text.includes("r7"));
    assert.ok(text.includes("cool-drop"));
    assert.ok(text.includes("8453"));
  });

  it("leaks no key material", () => {
    const text = recoveryReport(
      recordOutcome(recordIntent(state(), 0, "0xaaa"), 0, "rejected", "bad"),
    ).lines.join("\n");
    assert.doesNotMatch(text, /private/i);
    assert.doesNotMatch(text, /0x[0-9a-fA-F]{64}/);
  });
});

/**
 * A heartbeat that cannot recover is worse than no heartbeat: a frozen signal
 * reads exactly like a dead bot, which is the distinction it exists to make.
 *
 * `planBeat` only posts a fresh message while `messageId` is null, so the failure
 * path has to be able to put it back there.
 */
describe("beatFailure", () => {
  const INTERVAL = 60_000;

  /** A state mid-life: one beat sent, message id held. */
  const live = () => applyBeat(newHeartbeat(), { kind: "send", text: "alive" }, NOW, 42);

  it("clears the message id when the message is gone", () => {
    const after = beatFailure(live(), "Bad Request: message to edit not found", NOW + 1);
    assert.equal(after.messageId, null);
  });

  it("recovers by sending a new message, not editing a deleted one", () => {
    // The whole point: the next plan must be a send, not another doomed edit.
    const after = beatFailure(live(), "Bad Request: message to edit not found", NOW + 1);
    const action = planBeat(after, "alive", NOW + 1 + INTERVAL, INTERVAL);
    assert.equal(action.kind, "send");
  });

  it("forgets lastText, so an unchanged message is still resent", () => {
    // Otherwise planBeat's "nothing changed" branch would suppress the recovery
    // for as long as the status text stayed the same — which, for an idle bot,
    // is forever.
    const after = beatFailure(live(), "message can't be edited", NOW + 1);
    assert.equal(after.lastText, null);
  });

  it("recognises MESSAGE_ID_INVALID", () => {
    const after = beatFailure(live(), "Bad Request: MESSAGE_ID_INVALID", NOW + 1);
    assert.equal(after.messageId, null);
  });

  it("keeps the message id for a transient failure", () => {
    // A network blip is not a reason to abandon the message and post a duplicate.
    const after = beatFailure(live(), "socket hang up", NOW + 1);
    assert.equal(after.messageId, 42);
  });

  it("advances the clock so a failing beat backs off", () => {
    // Without this the interval check cannot throttle, and one broken message is
    // retried on every poll tick — a 429 against the token the whole bot shares.
    const after = beatFailure(live(), "socket hang up", NOW + 5_000);
    assert.equal(after.lastBeatMs, NOW + 5_000);
    const action = planBeat(after, "changed", NOW + 6_000, INTERVAL);
    assert.equal(action.kind, "none", "should be throttled, not retried immediately");
  });

  it("makes the operator wait one interval for the replacement", () => {
    // A deliberate trade-off, and the reason `planBeat`'s send branch is throttled
    // at all: an unreachable heartbeat chat would otherwise be retried on every
    // poll round trip forever, spending the whole bot's rate limit on a message
    // nobody receives. The cost is that a deleted heartbeat comes back one
    // interval later rather than immediately.
    const after = beatFailure(live(), "message to edit not found", NOW + 5_000);
    assert.equal(planBeat(after, "alive", NOW + 5_001, INTERVAL).kind, "none");
    assert.equal(planBeat(after, "alive", NOW + 5_000 + INTERVAL, INTERVAL).kind, "send");
  });

  it("still lets a forced beat through immediately", () => {
    // `force` is how a caller says "the operator asked for this now".
    const after = beatFailure(live(), "message to edit not found", NOW + 5_000);
    assert.equal(planBeat(after, "alive", NOW + 5_001, INTERVAL, true).kind, "send");
  });

  it("does not throttle the very first beat of the process", () => {
    // lastBeatMs is 0 on a fresh state, and a new bot must announce itself at
    // once rather than after its first full interval of silence.
    assert.equal(planBeat(newHeartbeat(), "alive", NOW, INTERVAL).kind, "send");
  });
});

/**
 * Backing off from a failed poll.
 *
 * The loop's own escalating backoff handles an outage. A retry_after is Telegram
 * telling us we were impolite, and it is obeyed — up to the point where obeying it
 * means being deliberately absent for longer than a drop lasts, with nothing said
 * to the operator.
 */
describe("pollBackoff", () => {
  it("uses our own backoff when Telegram asks for nothing", () => {
    assert.deepEqual(pollBackoff(undefined, 4_000), {
      waitMs: 4_000,
      capped: false,
      askedSec: 0,
    });
  });

  it("obeys a retry_after longer than our backoff", () => {
    const plan = pollBackoff(30, 1_000);
    assert.equal(plan.waitMs, 30_000);
    assert.equal(plan.capped, false);
  });

  it("never waits less than our own backoff", () => {
    // Answering a 429 in under a second is how a one-second limit escalates.
    assert.equal(pollBackoff(1, 8_000).waitMs, 8_000);
  });

  it("caps a retry_after that would take the bot offline", () => {
    const plan = pollBackoff(3_600, 1_000, 120_000);
    assert.equal(plan.waitMs, 120_000);
    assert.equal(plan.capped, true);
    assert.equal(plan.askedSec, 3_600, "the operator is told what was asked for");
  });

  it("does not flag a cap that was not applied", () => {
    assert.equal(pollBackoff(10, 1_000, 120_000).capped, false);
  });

  it("ignores a nonsensical retry_after", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      assert.deepEqual(pollBackoff(bad, 2_000), { waitMs: 2_000, capped: false, askedSec: 0 });
    }
  });

  it("rounds a fractional retry_after up", () => {
    assert.equal(pollBackoff(2.1, 1_000).askedSec, 3);
  });
});

/**
 * Shutdown has to interrupt the long poll, not wait it out.
 *
 * Asserted against the source because the alternative is a test that starts a real
 * bot and waits fifty seconds to watch it not stop.
 */
describe("shutdown reaches a parked long poll", () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "bot", "index.ts"), "utf8");

  it("passes an abort signal into getUpdates", () => {
    assert.match(SRC, /getUpdates\(POLL_TIMEOUT_SEC, shutdown\.signal\)/);
  });

  it("aborts that signal from the signal handler", () => {
    assert.match(SRC, /shutdown\.abort\(\)/);
  });

  it("passes it into the backoff sleep too", () => {
    // Otherwise Ctrl+C during a 60s backoff waits out the backoff.
    assert.match(SRC, /await sleep\(plan\.waitMs, shutdown\.signal\)/);
  });

  it("does not report its own cancellation as an outage", () => {
    assert.match(SRC, /err instanceof AbortedError \|\| stopping\) break;/);
  });
});

const INDEX_SRC = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "src", "bot", "index.ts"),
  "utf8",
);
const API_SRC = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "src", "bot", "api.ts"),
  "utf8",
);

describe("recoveryTargets — the hashes get more than one chance to land", () => {
  it("puts the heartbeat chat first, then every allowed operator", () => {
    assert.deepEqual(recoveryTargets(99, [7, 8]), [99, 7, 8]);
  });

  it("falls back to the allowed operators when no heartbeat chat is set", () => {
    assert.deepEqual(recoveryTargets(null, [7, 8]), [7, 8]);
  });

  it("does not send the same report to the same chat twice", () => {
    // The usual config: heartbeatChatId defaults to telegramAllowedIds[0].
    assert.deepEqual(recoveryTargets(7, [7, 8]), [7, 8]);
    assert.deepEqual(recoveryTargets(8, [7, 8]), [8, 7]);
  });

  it("returns nothing when nothing is configured, so the journal is kept", () => {
    assert.deepEqual(recoveryTargets(null, []), []);
  });

  it("tolerates a negative chat id (Telegram groups use them)", () => {
    assert.deepEqual(recoveryTargets(-100123, [7]), [-100123, 7]);
  });

  it("is tried in order until one accepts, and only then is the journal cleared", () => {
    // Keeping the journal is the whole safety property: it is the only record
    // that a broadcast happened, and losing it invites a double-mint.
    assert.match(INDEX_SRC, /for \(const chatId of chatIds\)/);
    assert.match(INDEX_SRC, /delivered = true;\s*\n\s*break;/);
    const failAt = INDEX_SRC.indexOf("if (!delivered) {");
    const clearAt = INDEX_SRC.indexOf("clearState(file);", failAt);
    assert.ok(failAt > 0 && clearAt > failAt, "the give-up path returns before clearState");
  });
});

describe("a failing heartbeat cannot eat a batch of commands", () => {
  it("wraps the whole beat, not just its network calls", () => {
    // getUpdates commits its offset before returning, so an exception escaping
    // beat() is a permanent loss of the commands already fetched.
    assert.match(INDEX_SRC, /const beat = async \(force = false\): Promise<void> => \{[\s\S]*?try \{\s*\n\s*await beatOnce\(force\);/);
  });

  it("builds the heartbeat text inside the guarded call, not outside it", () => {
    const beatAt = INDEX_SRC.indexOf("const beat = async (force = false)");
    const onceAt = INDEX_SRC.indexOf("const beatOnce = async (force: boolean)");
    const textAt = INDEX_SRC.indexOf("heartbeatText({", onceAt);
    assert.ok(beatAt > 0 && onceAt > beatAt, "beatOnce is declared after beat");
    assert.ok(textAt > onceAt, "the text is built inside beatOnce");
  });

  it("still records the failure so the next beat does not repeat it", () => {
    assert.match(INDEX_SRC, /heartbeat = beatFailure\(heartbeat, message, clock\.now\(\)\);/);
  });
});

describe("the startup line does not invent a backlog size", () => {
  it("reports what offset:-1 actually knows", () => {
    // Telegram returns only the most recent update for offset:-1, so the array
    // length is 1 for a backlog of two hundred as readily as for one.
    assert.match(API_SRC, /hadBacklog: true, throughId: last\.update_id/);
    assert.doesNotMatch(API_SRC, /return stale\.length;/);
  });

  it("no longer prints a count of dropped updates", () => {
    assert.doesNotMatch(INDEX_SRC, /\$\{dropped\} update\(s\)/);
    assert.match(INDEX_SRC, /backlog\.hadBacklog/);
  });
});
