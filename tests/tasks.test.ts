import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskPhase, TaskScheduler, isTerminal } from "../src/core/tasks";

const flush = async () => new Promise<void>((resolve) => setImmediate(resolve));

describe("TaskScheduler", () => {
  it("runs tasks on different wallets concurrently", async () => {
    const scheduler = new TaskScheduler(() => Date.now());
    let firstStarted = false;
    let secondStarted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const a = scheduler.submit({
      target: "0x1111111111111111111111111111111111111111",
      chain: "base",
      walletIndexes: [1],
      run: async () => { firstStarted = true; await gate; },
    });
    const b = scheduler.submit({
      target: "0x2222222222222222222222222222222222222222",
      chain: "base",
      walletIndexes: [2],
      run: async () => { secondStarted = true; },
    });

    await flush();
    assert.equal(firstStarted, true);
    assert.equal(secondStarted, true);
    release();
    await Promise.all([a.promise, b.promise]);
  });

  it("queues a task sharing a wallet until the first task releases it", async () => {
    const scheduler = new TaskScheduler(() => Date.now());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let secondStarted = false;

    const a = scheduler.submit({
      target: "0x1111111111111111111111111111111111111111",
      chain: "base",
      walletIndexes: [1],
      run: async () => { await gate; },
    });
    const b = scheduler.submit({
      target: "0x2222222222222222222222222222222222222222",
      chain: "base",
      walletIndexes: [1],
      run: async () => { secondStarted = true; },
    });

    await flush();
    assert.equal(secondStarted, false);
    assert.equal(scheduler.get(b.id)?.status, "CREATED");
    release();
    await Promise.all([a.promise, b.promise]);
    assert.equal(secondStarted, true);
  });

  it("cancels queued work without touching a running task", async () => {
    const scheduler = new TaskScheduler(() => Date.now());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const a = scheduler.submit({ target: "0x1", chain: "base", walletIndexes: [1], run: async () => { await gate; } });
    const b = scheduler.submit({ target: "0x2", chain: "base", walletIndexes: [1], run: async () => { throw new Error("must not run"); } });
    assert.equal(scheduler.cancel(b.id), true);
    assert.equal(scheduler.get(b.id)?.status, "CANCELLED");
    release();
    await a.promise;
  });
});

describe("TaskScheduler — the phase a task reports", () => {
  const scheduler = () => new TaskScheduler(() => 1_700_000_000_000);

  it("starts a task at DISCOVERING rather than a generic 'running'", async () => {
    const s = scheduler();
    let seen: string | undefined;
    const t = s.submit({
      target: "0x1",
      chain: "base",
      walletIndexes: [1],
      run: async () => {
        seen = s.get(t.id)?.status;
      },
    });
    await t.promise;
    assert.equal(seen, "DISCOVERING", "the first phase is stated, not implied");
    assert.equal(s.get(t.id)?.status, "SUCCESS");
  });

  it("records each reported phase, forwards and backwards, before any broadcast", async () => {
    // A poll loop genuinely oscillates: it arms, the stage slips, it waits again.
    // Refusing a backwards move in general would make the status lie during the
    // one period the operator is watching it most closely.
    const s = scheduler();
    const seen: (string | undefined)[] = [];
    const walk: TaskPhase[] = ["ELIGIBILITY_CHECK", "WAITING_FOR_STAGE", "ARMED", "WAITING_FOR_STAGE"];
    const t = s.submit({
      target: "0x1",
      chain: "base",
      walletIndexes: [1],
      run: async (_signal, phase) => {
        for (const next of walk) {
          assert.equal(phase(next), true, `${next} is a legitimate report`);
          seen.push(s.get(t.id)?.status);
        }
      },
    });
    await t.promise;
    assert.deepEqual(seen, walk);
  });

  it("refuses to go back to signing once a transaction has been broadcast", async () => {
    // The invariant with money attached: a re-signed mint is a second
    // transaction contending for the same nonce, and the operator pays for
    // whichever one lands.
    const s = scheduler();
    let rebuild: boolean | undefined;
    let resign: boolean | undefined;
    const t = s.submit({
      target: "0x1",
      chain: "base",
      walletIndexes: [1],
      run: async (_signal, phase) => {
        phase("SIGNING");
        phase("BROADCASTING");
        phase("CONFIRMING");
        rebuild = phase("BUILDING_TX");
        resign = phase("SIGNING");
      },
    });
    await t.promise;
    assert.equal(rebuild, false, "BUILDING_TX after a broadcast is refused");
    assert.equal(resign, false, "and so is SIGNING");
    const record = s.get(t.id);
    assert.equal(record?.status, "SUCCESS", "the refusals did not fail the task");
    assert.deepEqual(record?.refusedPhases, ["BUILDING_TX", "SIGNING"], "and are on the record");
  });

  it("remembers the broadcast after the status has moved past it", async () => {
    // `status === "BROADCASTING"` is true for an instant. The fact that matters —
    // something may be on the network — has to outlive the phase that set it.
    const s = scheduler();
    const t = s.submit({
      target: "0x1",
      chain: "base",
      walletIndexes: [1],
      run: async (_signal, phase) => {
        phase("BROADCASTING");
        phase("CONFIRMING");
      },
    });
    await t.promise;
    assert.equal(s.get(t.id)?.broadcastAtMs, 1_700_000_000_000);
  });

  it("ignores a phase reported after the task was cancelled", async () => {
    const s = scheduler();
    let late: boolean | undefined;
    const t = s.submit({
      target: "0x1",
      chain: "base",
      walletIndexes: [1],
      run: async (signal, phase) => {
        s.cancel(t.id);
        assert.equal(signal.aborted, true);
        throw new Error("aborted");
      },
    });
    await t.promise;
    assert.equal(s.get(t.id)?.status, "CANCELLED");
    late = undefined;
    assert.equal(late, undefined);
  });
});

describe("TaskScheduler — holding a task", () => {
  it("pauses a task that has not taken a wallet lock, and resumes it", async () => {
    const s = new TaskScheduler(() => 1_700_000_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let secondRan = false;

    const a = s.submit({ target: "0x1", chain: "base", walletIndexes: [1], run: async () => { await gate; } });
    const b = s.submit({ target: "0x2", chain: "base", walletIndexes: [1], run: async () => { secondRan = true; } });

    assert.equal(s.pause(b.id), true);
    assert.equal(s.get(b.id)?.status, "PAUSED");
    release();
    await a.promise;
    assert.equal(secondRan, false, "a held task does not start when the lock frees");

    assert.equal(s.resume(b.id), true);
    await b.promise;
    assert.equal(secondRan, true);
    assert.equal(s.get(b.id)?.status, "SUCCESS");
  });

  it("refuses to pause a task that is already running, rather than lying", async () => {
    const s = new TaskScheduler(() => 1_700_000_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = s.submit({ target: "0x1", chain: "base", walletIndexes: [1], run: async () => { await gate; } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(s.pause(t.id), false, "nothing stops a mint mid-flight");
    assert.notEqual(s.get(t.id)?.status, "PAUSED");
    release();
    await t.promise;
  });

  it("cancels a held task without making the operator resume it first", async () => {
    const s = new TaskScheduler(() => 1_700_000_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const a = s.submit({ target: "0x1", chain: "base", walletIndexes: [1], run: async () => { await gate; } });
    const b = s.submit({
      target: "0x2", chain: "base", walletIndexes: [1],
      run: async () => { throw new Error("must not run"); },
    });

    assert.equal(s.pause(b.id), true);
    assert.equal(s.cancel(b.id), true);
    assert.equal(s.get(b.id)?.status, "CANCELLED");
    assert.ok(isTerminal(s.get(b.id)!.status));
    release();
    await a.promise;
    assert.deepEqual(s.listActive(), [], "and it is gone from the active list");
  });
});
