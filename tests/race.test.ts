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
//   Secrecy — describeArm's output reaches a log line and a crash-recovery file.
//   A private key in either is a P0, so the assertion is against the serialised
//   JSON of a real arm carrying a real key, not against a hand-built shape.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CorrectedClock } from "../src/core/clock";
import { OpenSeaError, RawMintTx } from "../src/core/opensea";
import {
  ArmedRace,
  DeferredEmitter,
  MIN_POLL_MS,
  SPEED_STATEMENT,
  backoffDelayMs,
  describeArm,
  planNextPoll,
  pollForSignature,
  withJitter,
} from "../src/core/race";
import { EngineEvent } from "../src/core/engine";
import { GasSettings } from "../src/core/wallets";

/** A clock whose time only moves when a test moves it. */
class FakeClock extends CorrectedClock {
  private t: number;
  constructor(start: number) {
    super(0);
    this.t = start;
  }
  override now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const PAYLOAD: RawMintTx = {
  chain: "base",
  to: "0x1111111111111111111111111111111111111111",
  data: "0xdeadbeef",
  value: "1000",
};

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

  it("stops only on the three statuses that cannot fix themselves", () => {
    // Widening this set abandons winnable mints; narrowing it spins on a dead key.
    const terminal: number[] = [];
    for (let status = 200; status <= 599; status += 1) {
      if (planNextPoll(status, 1, { pollMs: 250, rand: MID }).kind === "stop") {
        terminal.push(status);
      }
    }
    assert.deepEqual(terminal, [401, 403, 404]);
  });

  it("says why it stopped, in words an operator can act on", () => {
    for (const status of [401, 403, 404]) {
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
});

describe("pollForSignature", () => {
  /** A fake sleep that moves the virtual clock — so the loop costs no real time. */
  const virtual = (clock: FakeClock) => async (ms: number) => {
    clock.advance(ms);
  };

  const run = (
    clock: FakeClock,
    request: (slug: string, apiKey: string, minter: string, quantity: number) => Promise<RawMintTx>,
    deadlineMs: number,
  ) =>
    pollForSignature({
      slug: "x",
      apiKey: "k",
      minter: "0x1111111111111111111111111111111111111111",
      quantity: 1,
      pollMs: 250,
      deadlineMs,
      clock,
      rand: MID,
      sleep: virtual(clock),
      request,
    });

  it("returns the payload on the first success", async () => {
    const clock = new FakeClock(0);
    const result = await run(clock, async () => PAYLOAD, 60_000);
    assert.equal(result.kind, "payload");
    if (result.kind !== "payload") return;
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.raw, PAYLOAD);
  });

  it("polls through the pre-open 409s and fires on the first signature", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const result = await run(
      clock,
      async () => {
        calls += 1;
        if (calls < 8) throw new OpenSeaError(409, "not open");
        return PAYLOAD;
      },
      60_000,
    );
    assert.equal(result.kind, "payload");
    if (result.kind !== "payload") return;
    assert.equal(result.attempts, 8);
    // Eight attempts at the base rate: seven waits of 250ms, no backoff.
    assert.equal(clock.now(), 7 * 250);
  });

  it("stops for a refused wallet instead of burning the window on it", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const result = await run(
      clock,
      async () => {
        calls += 1;
        throw new OpenSeaError(403, "denied");
      },
      60_000,
    );
    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.match(result.reason, /not eligible/i);
    // Recorded once and dropped — not retried for the rest of the window.
    assert.equal(calls, 1);
  });

  it("times out at the deadline rather than polling forever", async () => {
    const clock = new FakeClock(0);
    const result = await run(clock, async () => {
      throw new OpenSeaError(409, "not open");
    }, 2_000);
    assert.equal(result.kind, "timeout");
    if (result.kind !== "timeout") return;
    assert.ok(result.attempts > 1);
    assert.ok(clock.now() >= 2_000);
  });

  it("never sleeps past the deadline", async () => {
    // A 429 with a long Retry-After must not park the loop well beyond the point
    // where the answer stops mattering.
    const clock = new FakeClock(0);
    await run(clock, async () => {
      throw new OpenSeaError(429, "slow down", 60_000);
    }, 1_000);
    assert.ok(clock.now() <= 1_000, `slept to ${clock.now()}`);
  });

  it("gives up immediately when the deadline has already passed", async () => {
    const clock = new FakeClock(5_000);
    let calls = 0;
    const result = await run(clock, async () => {
      calls += 1;
      return PAYLOAD;
    }, 1_000);
    assert.equal(result.kind, "timeout");
    assert.equal(calls, 0);
  });

  it("honours an abort signal", async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    controller.abort();
    const result = await pollForSignature({
      slug: "x",
      apiKey: "k",
      minter: "0x1111111111111111111111111111111111111111",
      quantity: 1,
      pollMs: 250,
      deadlineMs: 60_000,
      clock,
      sleep: virtual(clock),
      signal: controller.signal,
      request: async () => PAYLOAD,
    });
    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.match(result.reason, /cancelled/i);
  });

  it("treats a non-OpenSea throw as a server error and backs off", async () => {
    // A JSON parse failure or a bug must not spin at the floor interval.
    const clock = new FakeClock(0);
    let calls = 0;
    await run(clock, async () => {
      calls += 1;
      throw new TypeError("boom");
    }, 3_000);
    assert.ok(calls >= 2);
    // Backoff, not the base rate: 250 + 500 + 1000 … reaches 3s in far fewer
    // attempts than 3000/250 = 12.
    assert.ok(calls < 12, `spun ${calls} times instead of backing off`);
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

describe("describeArm", () => {
  // A real key, so the assertion is about the code and not about a fixture that
  // happens to contain nothing.
  const KEY = `0x${"ab".repeat(32)}`;

  const armed: ArmedRace = {
    chainId: 8453,
    armedAtMs: 1_773_576_000_000,
    gas: {
      maxFeePerGas: 1_500_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      gasLimit: 250_000n,
    } as GasSettings,
    wallets: [
      {
        wallet: { index: 0, address: "0x1111111111111111111111111111111111111111", key: KEY },
        nonce: 7,
      },
      {
        wallet: { index: 1, address: "0x2222222222222222222222222222222222222222", key: KEY },
        nonce: 3,
      },
    ],
  };

  it("carries no key material into its serialised form", () => {
    const json = JSON.stringify(describeArm(armed));
    assert.doesNotMatch(json, /ab{2,}/i, "key bytes reached the snapshot");
    assert.ok(!json.includes(KEY), "the key itself reached the snapshot");
    assert.doesNotMatch(json, /0x[0-9a-fA-F]{64}/, "something key-shaped reached the snapshot");
    assert.doesNotMatch(json, /"key"/, "a key field reached the snapshot");
  });

  it("keeps what an operator needs to audit the arm", () => {
    const described = describeArm(armed);
    assert.equal(described.chainId, 8453);
    assert.equal(described.wallets.length, 2);
    assert.equal(described.wallets[0]!.nonce, 7);
    assert.equal(described.wallets[1]!.address, "0x2222222222222222222222222222222222222222");
  });

  it("serialises gas as strings, since JSON has no bigint", () => {
    const described = describeArm(armed);
    assert.equal(described.gas.maxFeePerGas, "1500000000");
    assert.equal(described.gas.gasLimit, "250000");
    // And the whole thing must actually survive JSON.stringify — a bigint here
    // throws at exactly the wrong moment, in the crash-recovery write.
    assert.doesNotThrow(() => JSON.stringify(described));
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
