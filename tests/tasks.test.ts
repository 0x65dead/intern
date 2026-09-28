import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskScheduler } from "../src/core/tasks";

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
    assert.equal(scheduler.get(b.id)?.status, "queued");
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
    assert.equal(scheduler.get(b.id)?.status, "cancelled");
    release();
    await a.promise;
  });
});
