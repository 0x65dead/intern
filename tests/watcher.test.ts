// Poll pacing while waiting for a stage.
//
// The interval is the whole design of the watcher: too eager and OpenSea rate-limits
// the bot out of the mint it is waiting for; too lazy and a creator's last-minute
// reschedule goes unnoticed until the drop is gone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pollInterval, waitForScheduledStage } from "../src/core/watcher";

describe("pollInterval", () => {
  it("tightens as the stage approaches", () => {
    const hour = pollInterval(3_600_000);
    const minute = pollInterval(60_000);
    const seconds = pollInterval(20_000);
    assert.ok(hour > minute, `${hour} should exceed ${minute}`);
    assert.ok(minute > seconds, `${minute} should exceed ${seconds}`);
  });

  it("never polls faster than the floor", () => {
    // Below this, the bot is rate-limited out of the mint it is waiting for.
    assert.ok(pollInterval(1_000) >= 2_000);
    assert.ok(pollInterval(0) >= 2_000);
    assert.ok(pollInterval(-50_000) >= 2_000);
  });

  it("never sleeps past the ceiling, however far out the stage is", () => {
    // A stage six hours away can still be rescheduled to five minutes from now.
    assert.ok(pollInterval(6 * 3_600_000) <= 60_000);
    assert.ok(pollInterval(Number.MAX_SAFE_INTEGER) <= 60_000);
  });

  it("honours explicit bounds", () => {
    assert.equal(pollInterval(3_600_000, { maxPollMs: 5_000 }), 5_000);
    assert.equal(pollInterval(100, { minPollMs: 500 }), 500);
  });

  it("falls back to the floor for a non-finite input", () => {
    // NaN reaches here when a start time is missing; sleeping NaN ms is an
    // immediate busy loop.
    assert.equal(pollInterval(Number.NaN), 2_000);
    assert.equal(pollInterval(Number.POSITIVE_INFINITY), 2_000);
  });

  it("returns a whole number of milliseconds", () => {
    // setTimeout truncates a fraction, which would slowly desynchronise a long wait.
    assert.ok(Number.isInteger(pollInterval(123_457)));
  });
});

// The pre-open lead.
//
// This is the part of the watcher that was documented before it existed. CAPABILITY.md
// stated "pre-arm work completes 60 seconds before the stage opens" and the allowlist
// module header claimed the nonce fetch and socket warm-up had been moved out of the
// race, while the live path fetched nonces *after* waitForScheduledStage returned —
// which is to say after the stage was already open, which is the one moment that work
// is expensive. The claim is now true, and these tests are what keeps it true, because
// the failure is invisible: the mint still works, it is just slower than advertised,
// and nothing in the output would say so.
//
// The assertions are therefore about *when* preparation happens relative to the open,
// not about whether it happens at all.

const OPEN_STAGE = "0x1111111111111111111111111111111111111111";

/** A raw OpenSea drop payload with stages at the given absolute times. */
function dropBody(stages: { startMs: number; endMs: number; label?: string }[]): unknown {
  return {
    chain: "base",
    contract_address: OPEN_STAGE,
    stages: stages.map((s) => ({
      start_time: new Date(s.startMs).toISOString(),
      end_time: new Date(s.endMs).toISOString(),
      stage_type: "presale",
      label: s.label ?? "Allowlist",
    })),
  };
}

/** Answer each poll from the queue in turn; the last entry repeats forever. */
function stubDrops(bodies: unknown[]): { calls: number } {
  let i = 0;
  const state = { calls: 0 };
  globalThis.fetch = (async (): Promise<Response> => {
    state.calls += 1;
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return state;
}

describe("waitForScheduledStage pre-arm lead", () => {
  const HOUR = 3_600_000;
  const LEAD = 60_000;

  it("prepares before the stage opens, without waiting for it", async () => {
    // The bug this pins: preparation that happens after the open still passes every
    // other test in this repository. The only witness is the clock.
    const start = Date.now() + 30_000;
    const state = stubDrops([
      dropBody([{ startMs: start, endMs: start + HOUR }]),
      dropBody([{ startMs: Date.now() - 1_000, endMs: Date.now() + HOUR }]),
    ]);
    const armedAt: number[] = [];
    const sleeps: number[] = [];

    const result = await waitForScheduledStage("muse-brokers", "k", {
      preArmLeadMs: LEAD,
      onPreArm: () => {
        armedAt.push(Date.now());
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    assert.equal(armedAt.length, 1, "preparation did not run");
    assert.ok(armedAt[0]! < start, "preparation ran after the stage opened");
    assert.equal(sleeps.length, 0, "it waited before preparing instead of preparing first");
    assert.equal(result.stage.label, "Allowlist");
    assert.equal(state.calls, 2);
  });

  it("prepares once, however many polls the wait takes", async () => {
    // Re-fetching nonces every poll would burn rate limit and, worse, leave the
    // signing loop holding whichever snapshot happened to land last.
    const start = Date.now() + 30_000;
    stubDrops([dropBody([{ startMs: start, endMs: start + HOUR }])]);
    const controller = new AbortController();
    let arms = 0;
    const sleeps: number[] = [];

    await assert.rejects(
      waitForScheduledStage("muse-brokers", "k", {
        signal: controller.signal,
        preArmLeadMs: LEAD,
        onPreArm: () => {
          arms += 1;
        },
        sleep: async (ms: number) => {
          sleeps.push(ms);
          if (sleeps.length >= 3) controller.abort();
        },
      }),
      /cancelled/i,
    );
    assert.equal(arms, 1, `prepared ${arms} times across ${sleeps.length} polls`);
  });

  it("never sleeps through the lead boundary", async () => {
    // Without the clamp the poll interval decides when preparation happens, so a
    // 60s lead silently becomes whatever the last sleep left of it. At 65s out the
    // natural interval is 6.5s, which would overshoot the boundary at 5s.
    const start = Date.now() + 65_000;
    stubDrops([dropBody([{ startMs: start, endMs: start + HOUR }])]);
    const controller = new AbortController();
    const sleeps: number[] = [];

    await assert.rejects(
      waitForScheduledStage("muse-brokers", "k", {
        signal: controller.signal,
        preArmLeadMs: LEAD,
        onPreArm: () => undefined,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          controller.abort();
        },
      }),
      /cancelled/i,
    );
    assert.ok(sleeps[0]! <= 5_100, `first sleep of ${sleeps[0]}ms overshoots the boundary`);
  });

  it("prepares again when the creator moves the stage", async () => {
    // Nonces survive a reschedule, but the operator should see the preparation
    // happen against the time that will actually be used.
    const first = Date.now() + 30_000;
    const second = Date.now() + 45_000;
    stubDrops([
      dropBody([{ startMs: first, endMs: first + HOUR }]),
      dropBody([{ startMs: second, endMs: second + HOUR }]),
    ]);
    const controller = new AbortController();
    let arms = 0;

    await assert.rejects(
      waitForScheduledStage("muse-brokers", "k", {
        signal: controller.signal,
        preArmLeadMs: LEAD,
        onPreArm: () => {
          arms += 1;
        },
        sleep: async () => {
          controller.abort();
        },
      }),
      /cancelled/i,
    );
    assert.equal(arms, 2, "a rescheduled stage did not re-arm");
  });

  it("ends the watch when preparation fails", async () => {
    // Discovering at T-0 that the nonce fetch failed leaves nothing to do about it.
    const start = Date.now() + 30_000;
    stubDrops([dropBody([{ startMs: start, endMs: start + HOUR }])]);

    await assert.rejects(
      waitForScheduledStage("muse-brokers", "k", {
        preArmLeadMs: LEAD,
        onPreArm: () => {
          throw new Error("RPC refused the nonce request");
        },
        sleep: async () => undefined,
      }),
      /nonce request/,
    );
  });

  it("does not prepare at all when no lead is configured", async () => {
    // The default is unchanged: a watch is a watch.
    const start = Date.now() + 30_000;
    stubDrops([
      dropBody([{ startMs: start, endMs: start + HOUR }]),
      dropBody([{ startMs: Date.now() - 1_000, endMs: Date.now() + HOUR }]),
    ]);
    let arms = 0;
    const sleeps: number[] = [];

    await waitForScheduledStage("muse-brokers", "k", {
      onPreArm: () => {
        arms += 1;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    assert.equal(arms, 0, "prepared without being given a lead to prepare within");
    assert.equal(sleeps.length, 1);
  });
});
