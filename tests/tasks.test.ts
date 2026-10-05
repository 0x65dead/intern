import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskPhase, TaskScheduler, isTerminal, phaseForEvent } from "../src/core/tasks";

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

describe("TaskScheduler — asking which wallets are committed", () => {
  // The query a caller needs when queueing is the wrong answer. The bot refuses a
  // contended mint rather than running it later, so it has to be able to ask
  // before submitting — and the asking must not itself take a lock.

  it("reports nothing when every wallet asked about is free", () => {
    const s = new TaskScheduler(() => 1_700_000_000_000);
    assert.deepEqual(s.walletHolders([0, 1, 2]), []);
  });

  it("names the wallet and the task holding it", async () => {
    const s = new TaskScheduler(() => 1_700_000_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = s.submit({ target: "0x1", chain: "base", walletIndexes: [1], run: async () => { await gate; } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(s.walletHolders([1]), [{ walletIndex: 1, taskId: t.id }]);
    release();
    await t.promise;
  });

  it("reports only the wallets that are held, not the ones that are free", async () => {
    // The whole point: a run on W0 and W2 must be told about W2 alone, so it can
    // say which wallet is the obstacle rather than refusing in the abstract.
    const s = new TaskScheduler(() => 1_700_000_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = s.submit({ target: "0x1", chain: "base", walletIndexes: [2], run: async () => { await gate; } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(s.walletHolders([0, 1, 2, 3]), [{ walletIndex: 2, taskId: t.id }]);
    release();
    await t.promise;
  });

  it("frees the wallets again when the task ends", async () => {
    const s = new TaskScheduler(() => 1_700_000_000_000);
    const t = s.submit({ target: "0x1", chain: "base", walletIndexes: [0, 1], run: async () => {} });
    await t.promise;
    assert.deepEqual(s.walletHolders([0, 1]), [], "a finished task holds nothing");
  });

  it("holds nothing for a task still queued behind another", async () => {
    // A queued task has taken no lock yet, so it must not be reported as a holder
    // — a caller told W1 is held by a task that is itself waiting would refuse
    // forever.
    const s = new TaskScheduler(() => 1_700_000_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const a = s.submit({ target: "0x1", chain: "base", walletIndexes: [1], run: async () => { await gate; } });
    const b = s.submit({ target: "0x2", chain: "base", walletIndexes: [1], run: async () => {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(s.walletHolders([1]), [{ walletIndex: 1, taskId: a.id }], "the runner, not the waiter");
    release();
    await Promise.all([a.promise, b.promise]);
  });

  it("takes no lock by being asked", async () => {
    const s = new TaskScheduler(() => 1_700_000_000_000);
    s.walletHolders([0, 1, 2]);
    let ran = false;
    const t = s.submit({ target: "0x1", chain: "base", walletIndexes: [0, 1, 2], run: async () => { ran = true; } });
    await t.promise;
    assert.equal(ran, true, "asking must not block a later submit");
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
      run: async ({ id }) => {
        seen = s.get(id)?.status;
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
      run: async ({ id, phase }) => {
        for (const next of walk) {
          assert.equal(phase(next), true, `${next} is a legitimate report`);
          seen.push(s.get(id)?.status);
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
      run: async ({ phase }) => {
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
      run: async ({ phase }) => {
        phase("BROADCASTING");
        phase("CONFIRMING");
      },
    });
    await t.promise;
    assert.equal(s.get(t.id)?.broadcastAtMs, 1_700_000_000_000);
  });

  it("refuses a phase reported by a reporter that outlived its task", async () => {
    // The reporter is a closure the body holds. A body that leaks it — to a
    // timer, a pending fetch, a retry that unwound late — can call it after the
    // record has already been resolved. Honouring that would move a finished
    // task back to ARMED, and an operator reading the panel would be told a
    // mint is in progress that nothing is running.
    const s = scheduler();
    let report!: (next: TaskPhase) => boolean;

    const cancelled = s.submit({
      target: "0x1",
      chain: "base",
      walletIndexes: [1],
      run: async ({ id, signal, phase }) => {
        report = phase;
        s.cancel(id);
        assert.equal(signal.aborted, true, "cancel reaches a running task at once");
        throw new Error("aborted");
      },
    });
    await cancelled.promise;
    assert.equal(s.get(cancelled.id)?.status, "CANCELLED");
    assert.equal(report("SIGNING"), false, "a resolved task takes no further reports");
    assert.equal(s.get(cancelled.id)?.status, "CANCELLED", "and its status is unchanged");

    // Same rule on the happy path: SUCCESS is just as terminal as CANCELLED.
    const done = s.submit({
      target: "0x2",
      chain: "base",
      walletIndexes: [2],
      run: async ({ phase }) => {
        report = phase;
      },
    });
    await done.promise;
    assert.equal(report("BUILDING_TX"), false);
    assert.equal(s.get(done.id)?.status, "SUCCESS");
  });
});

describe("phaseForEvent", () => {
  // The mapping and the ordering rule have to agree. Report BROADCASTING late and
  // the guard against re-signing never arms; report it early and a legitimate step
  // before the broadcast is refused as a regression.

  it("maps the engine's own phase names to task phases", () => {
    assert.equal(phaseForEvent({ type: "phase", name: "prepare" }), "BUILDING_TX");
    assert.equal(phaseForEvent({ type: "phase", name: "simulate" }), "SIMULATING");
    assert.equal(phaseForEvent({ type: "phase", name: "sign" }), "SIGNING");
    assert.equal(phaseForEvent({ type: "phase", name: "wait" }), "WAITING_FOR_STAGE");
    assert.equal(phaseForEvent({ type: "phase", name: "receipts" }), "CONFIRMING");
  });

  it("treats `fired` as the broadcast, because that is when bytes have gone out", () => {
    assert.equal(phaseForEvent({ type: "fired" }), "BROADCASTING");
  });

  it("does not treat a signature as a broadcast", () => {
    // A signed transaction that was never dispatched can be rebuilt safely. Calling
    // it BROADCASTING would set broadcastAtMs and refuse a retry that is legitimate.
    assert.equal(phaseForEvent({ type: "signed" }), null);
  });

  it("reports nothing for an engine phase it has not been taught", () => {
    // Inventing a phase for an unknown name could move the record back past a
    // broadcast, after which the scheduler refuses the next real report too.
    assert.equal(phaseForEvent({ type: "phase", name: "something-new" }), null);
    assert.equal(phaseForEvent({ type: "phase" }), null);
  });

  it("reports nothing for outcomes, which are the scheduler's to decide", () => {
    for (const type of ["done", "warning", "rejected", "accepted", "tx", "simulation", "dryRun"]) {
      assert.equal(phaseForEvent({ type }), null, type);
    }
  });

  it("never maps anything to a terminal status", () => {
    // TaskPhase excludes them at the type level; this pins it at runtime too, since
    // a terminal status reported by a body would make the scheduler drop later
    // reports from a task that was still running.
    const events = [
      { type: "phase", name: "prepare" }, { type: "phase", name: "simulate" },
      { type: "phase", name: "sign" }, { type: "phase", name: "wait" },
      { type: "phase", name: "receipts" }, { type: "balances" }, { type: "countdown" },
      { type: "fired" }, { type: "receipt" }, { type: "receiptTimeout" },
    ];
    for (const event of events) {
      const phase = phaseForEvent(event);
      assert.ok(phase === null || !isTerminal(phase), `${event.type}/${event.name ?? ""}`);
    }
  });

  it("arms the no-re-sign guard when replayed through a real task", async () => {
    // The end-to-end point of the mapping: a run that dispatches and is then asked
    // to rebuild must be refused, and that refusal depends entirely on `fired`
    // having been mapped to BROADCASTING.
    const s = new TaskScheduler(() => 1_700_000_000_000);
    let rebuild: boolean | undefined;
    const t = s.submit({
      target: "0x1", chain: "base", walletIndexes: [0],
      run: async ({ phase }) => {
        for (const event of [
          { type: "phase", name: "sign" },
          { type: "fired" },
          { type: "receipt" },
        ]) {
          const next = phaseForEvent(event);
          if (next !== null) phase(next);
        }
        rebuild = phaseForEvent({ type: "phase", name: "prepare" }) !== null
          ? phase("BUILDING_TX")
          : undefined;
      },
    });
    await t.promise;
    assert.equal(rebuild, false, "rebuilding after a dispatch is refused");
    assert.equal(s.get(t.id)?.broadcastAtMs, 1_700_000_000_000);
    assert.deepEqual(s.get(t.id)?.refusedPhases, ["BUILDING_TX"]);
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

describe("TaskScheduler — when the body begins", () => {
  it("does not begin until submit has returned", async () => {
    // The body used to run inside `submit`, which made it impossible to write
    // against the handle `submit` hands back: `t.id` was still uninitialised.
    // That also broke the caller's side of the same seam — a panel that maps
    // id → message id could not have registered the mapping yet when the first
    // phase arrived. Both are the same ordering bug, so both are pinned here.
    const s = new TaskScheduler(() => 1_700_000_000_000);
    let ownId: string | undefined;
    let registeredAtStart: string | undefined;
    const registry = new Map<string, string>();

    const t = s.submit({
      target: "0x1",
      chain: "base",
      walletIndexes: [1],
      run: async ({ id }) => {
        ownId = id;
        registeredAtStart = registry.get(id);
      },
    });
    registry.set(t.id, "message-7");

    await t.promise;
    assert.equal(ownId, t.id, "the body knows which task it is");
    assert.equal(registeredAtStart, "message-7", "and the caller's bookkeeping was in place");
  });

  it("never enters the body of a task cancelled before it began", async () => {
    // The wallet lock is taken synchronously, so there is a window between
    // "submitted" and "running" in which cancel can land. Running anyway would
    // mint something the operator had already called off.
    const s = new TaskScheduler(() => 1_700_000_000_000);
    let ran = false;
    const t = s.submit({
      target: "0x1",
      chain: "base",
      walletIndexes: [1],
      run: async () => {
        ran = true;
      },
    });

    assert.equal(s.cancel(t.id), true);
    await t.promise;
    assert.equal(ran, false, "the body was never entered");
    assert.equal(s.get(t.id)?.status, "CANCELLED");
    assert.deepEqual(s.listActive(), [], "and the wallet lock was released");
  });
});
