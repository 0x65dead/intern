// The race: scheduling, deferral, and the promise not to overstate speed.
//
// Three things are pinned here, and each corresponds to a way this file could
// lose a mint or leak a key.
//
//   Scheduling — a 409 is the *expected* answer for the whole pre-open window.
//   Backing off on it, the way you would on a 429, means arriving at the open
//   already asleep. That distinction is asserted directly, because it looks like
//   a harmless uniformity when read casually.
//
//   Deferral — a Telegram call between the signature arriving and the broadcast
//   spends the race on a status message. DeferredEmitter enforces fire-then-notify
//   rather than leaving it as a rule to remember.
//
//   Attribution — a retry scheduler must not invent verdicts. planNextPoll decides
//   only how long to wait; what a status *means* comes from classifyOpenSeaFailure,
//   and the tests below pin the boundary, because the previous version crossed it
//   and read a 403 as "this wallet is not on the allowlist".
//
// The describeArm and pollForSignature suites are gone with the functions they
// covered; core/race.ts records why. The no-key-material assertion those tests
// carried was never about the live crash-recovery file, which is written by
// core/runstate.ts and asserted on in tests/unattended.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeferredEmitter,
  MIN_POLL_MS,
  SPEED_STATEMENT,
  backoffDelayMs,
  planNextPoll,
  withJitter,
} from "../src/core/race";
import { EngineEvent } from "../src/core/engine";

// A deterministic rand at the midpoint, so jitter contributes exactly zero and
// the scheduling assertions are about backoff rather than about luck.
const MID = () => 0.5;

describe("backoffDelayMs", () => {
  it("doubles per attempt from the base interval", () => {
    assert.equal(backoffDelayMs(1, 250), 250);
    assert.equal(backoffDelayMs(2, 250), 500);
    assert.equal(backoffDelayMs(3, 250), 1000);
    assert.equal(backoffDelayMs(4, 250), 2000);
  });

  it("caps rather than growing without bound", () => {
    assert.equal(backoffDelayMs(50, 250), 8000);
    assert.equal(backoffDelayMs(1000, 250), 8000);
  });

  it("never returns less than the base interval", () => {
    assert.equal(backoffDelayMs(0, 250), 250);
    assert.equal(backoffDelayMs(-5, 250), 250);
  });

  it("respects a caller-supplied cap", () => {
    assert.equal(backoffDelayMs(10, 250, 1000), 1000);
  });
});

describe("withJitter", () => {
  it("returns the delay unchanged at the midpoint", () => {
    assert.equal(withJitter(1000, MID), 1000);
  });

  it("stays within ±25% across the whole random range", () => {
    for (const r of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
      const jittered = withJitter(1000, () => r);
      assert.ok(jittered >= 750, `r=${r} gave ${jittered}`);
      assert.ok(jittered <= 1250, `r=${r} gave ${jittered}`);
    }
  });

  it("never returns a negative delay", () => {
    assert.ok(withJitter(0, () => 0) >= 0);
  });
});

describe("planNextPoll", () => {
  const plan = (status: number | null, attempt = 1, retryAfterMs?: number | null) =>
    planNextPoll(status, attempt, { pollMs: 250, rand: MID, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

  it("fires when the payload arrived", () => {
    assert.deepEqual(plan(null), { kind: "fire" });
  });

  it("keeps polling at the base rate through the pre-open 409", () => {
    // The whole point. A 409 means "not open yet" and is the answer for every
    // poll until T-0. Backing off on it means being asleep when the stage opens.
    for (const attempt of [1, 5, 20, 200]) {
      const action = plan(409, attempt);
      assert.equal(action.kind, "retry");
      if (action.kind !== "retry") return;
      assert.equal(action.delayMs, 250, `attempt ${attempt} drifted off the base rate`);
    }
  });

  it("treats the ambiguous 422 the same way, and does not give up on it", () => {
    // 422 covers sold-out and cap-reached as well as not-on-the-list. Stopping
    // here would abandon a wallet whose only problem was a momentary state.
    const action = plan(422, 9);
    assert.equal(action.kind, "retry");
    if (action.kind !== "retry") return;
    assert.equal(action.delayMs, 250);
  });

  it("backs off on a rate limit", () => {
    const first = plan(429, 1);
    const later = plan(429, 4);
    assert.equal(first.kind, "retry");
    assert.equal(later.kind, "retry");
    if (first.kind !== "retry" || later.kind !== "retry") return;
    assert.ok(later.delayMs > first.delayMs);
  });

  it("obeys Retry-After when it asks for longer than our backoff", () => {
    const action = plan(429, 1, 5_000);
    assert.equal(action.kind, "retry");
    if (action.kind !== "retry") return;
    assert.equal(action.delayMs, 5_000);
  });

  it("ignores a Retry-After shorter than our own backoff", () => {
    // Racing a limiter extends the limit. The longer of the two is the right wait.
    const action = plan(429, 6, 10);
    assert.equal(action.kind, "retry");
    if (action.kind !== "retry") return;
    assert.ok(action.delayMs >= 250);
  });

  it("backs off on a server error and on a transport failure", () => {
    for (const status of [0, 500, 502, 503]) {
      const a = plan(status, 3);
      const b = plan(status, 1);
      assert.equal(a.kind, "retry");
      if (a.kind !== "retry" || b.kind !== "retry") return;
      assert.ok(a.delayMs > b.delayMs, `status ${status} did not back off`);
    }
  });

  it("stops only on the statuses that cannot fix themselves", () => {
    // Widening this set abandons winnable mints; narrowing it spins on a dead key.
    // 404 is deliberately absent. It used to stop the poll, on the reading that a
    // missing drop stays missing — but OpenSea answers 404 for a drop whose stage
    // is not configured yet, which is the ordinary state of the entire pre-open
    // window. Stopping there abandoned the mint before it started.
    const terminal: number[] = [];
    for (let status = 200; status <= 599; status += 1) {
      if (planNextPoll(status, 1, { pollMs: 250, rand: MID }).kind === "stop") {
        terminal.push(status);
      }
    }
    assert.deepEqual(terminal, [401, 403]);
  });

  it("keeps polling through a 404, which is how an unconfigured drop reads", () => {
    const action = plan(404, 3);
    assert.equal(action.kind, "retry");
  });

  it("says why it stopped, in words an operator can act on", () => {
    for (const status of [401, 403]) {
      const action = plan(status);
      assert.equal(action.kind, "stop");
      if (action.kind !== "stop") return;
      assert.match(action.reason, new RegExp(String(status)));
      assert.ok(action.reason.length > 25, `status ${status} reason is too thin`);
    }
  });

  it("enforces the poll floor even when asked for something tighter", () => {
    const action = planNextPoll(409, 1, { pollMs: 5, rand: MID });
    assert.equal(action.kind, "retry");
    if (action.kind !== "retry") return;
    assert.equal(action.delayMs, MIN_POLL_MS);
  });

  it("blames the credential for a 403, never the wallet", () => {
    // The regression this exists to prevent. A 403 says the API key was refused.
    // The previous implementation reported it as "wallet is not eligible", which
    // sent the operator to check an allowlist while the actual fault was a missing
    // scope on their key — and, worse, recorded a verdict on a wallet that only
    // the eligibility endpoint is entitled to give.
    const action = plan(403);
    assert.equal(action.kind, "stop");
    if (action.kind !== "stop") return;
    assert.doesNotMatch(action.reason, /not eligible|ineligible|allowlist/i);
    assert.match(action.reason, /key/i);
    assert.notEqual(action.failure.code, "ELIGIBILITY_FALSE");
    assert.notEqual(action.failure.code, "WALLET_NOT_ELIGIBLE");
    assert.equal(action.failure.code, "API_KEY_INVALID");
  });

  it("carries the structured cause beside the prose", () => {
    // The sentence is for the operator; the code is what a task state machine acts
    // on. Returning only the sentence forces the caller to parse English.
    for (const status of [401, 403]) {
      const action = plan(status);
      assert.equal(action.kind, "stop");
      if (action.kind !== "stop") return;
      assert.ok(action.failure.terminal, `${status} stopped without a terminal cause`);
      assert.ok(action.failure.code.length > 0);
    }
  });

  it("resolves the ambiguous 422 when eligibility has already answered", () => {
    // 422 alone means one of four things and is retried, because three of the four
    // are temporary. With the eligibility answer beside it there is nothing
    // ambiguous left, and continuing to poll would burn the window on a wallet
    // that was never going to mint.
    const refused = planNextPoll(422, 1, {
      pollMs: 250,
      rand: MID,
      endpoint: "mint",
      eligibility: { isEligible: false, maxMintable: null },
    });
    assert.equal(refused.kind, "stop");
    if (refused.kind !== "stop") return;
    assert.equal(refused.failure.code, "WALLET_NOT_ELIGIBLE");

    const capped = planNextPoll(422, 1, {
      pollMs: 250,
      rand: MID,
      endpoint: "mint",
      eligibility: { isEligible: true, maxMintable: 2, mintedSoFar: 2 },
    });
    assert.equal(capped.kind, "stop");
    if (capped.kind !== "stop") return;
    assert.equal(capped.failure.code, "MINT_LIMIT_REACHED");
  });

  it("keeps polling a 422 when eligibility says the wallet should be able to mint", () => {
    // Eligible with allowance left and still refused: the cause is supply or
    // balance, neither of which is settled, so the poll continues.
    const action = planNextPoll(422, 1, {
      pollMs: 250,
      rand: MID,
      endpoint: "mint",
      eligibility: { isEligible: true, maxMintable: 5, mintedSoFar: 1 },
    });
    assert.equal(action.kind, "retry");
  });

  it("does not need an eligibility answer to keep polling a bare 422", () => {
    // No hint supplied is the common case, and must not become a stop by default.
    const action = planNextPoll(422, 1, { pollMs: 250, rand: MID, endpoint: "mint" });
    assert.equal(action.kind, "retry");
  });
});

describe("DeferredEmitter", () => {
  const collect = () => {
    const seen: EngineEvent[] = [];
    return { seen, emitter: new DeferredEmitter((e) => seen.push(e)) };
  };
  const warn = (message: string): EngineEvent => ({ type: "warning", message });

  it("passes events straight through when not in the hot path", () => {
    const { seen, emitter } = collect();
    emitter.emit(warn("a"));
    assert.equal(seen.length, 1);
  });

  it("emits nothing at all while the hot path is open", () => {
    // The assertion that matters: between the signature arriving and the
    // broadcast returning, no network call leaves on our behalf.
    const { seen, emitter } = collect();
    emitter.enterHotPath();
    emitter.emit(warn("a"));
    emitter.emit(warn("b"));
    assert.equal(seen.length, 0);
    assert.equal(emitter.pendingCount, 2);
  });

  it("flushes in order the moment the hot path closes", () => {
    const { seen, emitter } = collect();
    emitter.enterHotPath();
    emitter.emit(warn("a"));
    emitter.emit(warn("b"));
    emitter.exitHotPath();
    assert.deepEqual(seen.map((e) => (e.type === "warning" ? e.message : "")), ["a", "b"]);
    assert.equal(emitter.pendingCount, 0);
  });

  it("resumes passing through after the hot path", () => {
    const { seen, emitter } = collect();
    emitter.enterHotPath();
    emitter.exitHotPath();
    emitter.emit(warn("after"));
    assert.equal(seen.length, 1);
    assert.equal(emitter.isHot, false);
  });

  it("does not replay a flushed event on a second flush", () => {
    const { seen, emitter } = collect();
    emitter.enterHotPath();
    emitter.emit(warn("a"));
    emitter.flush();
    emitter.flush();
    assert.equal(seen.length, 1);
  });
});

describe("SPEED_STATEMENT", () => {
  it("says a gated mint is slower than a public one, in writing", () => {
    // The spec requires this claim to be made rather than implied, and requires
    // no faster claim to be made anywhere. The constant is the single source both
    // CAPABILITY.md and the README render.
    assert.match(SPEED_STATEMENT, /slower than a public mint/i);
  });

  it("names the structural reason, not a vague one", () => {
    assert.match(SPEED_STATEMENT, /signature/i);
    assert.match(SPEED_STATEMENT, /does not issue it before the stage/i);
    assert.match(SPEED_STATEMENT, /round trip/i);
  });

  it("states what was removed instead of only what could not be", () => {
    assert.match(SPEED_STATEMENT, /nonce/i);
    assert.match(SPEED_STATEMENT, /TLS/i);
  });

  it("names the Merkle exception, so the honest case is not undersold", () => {
    assert.match(SPEED_STATEMENT, /Merkle/);
    assert.match(SPEED_STATEMENT, /as fast as one/i);
  });
});
