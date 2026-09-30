// The bot's mint lock and its cancel button.
//
// This file exists because three bugs lived here undetected: the global lock
// exempted the chat that held it, ❌ Cancel consulted only the calling chat's own
// handle, and the run was awaited inside the update loop so no cancel tap could
// be delivered while a run was in flight. All three are HARD CONSTRAINT 6 — one
// mint run at a time, /cancel kills any live mint and any live panel loop — and
// all three survived because the fire path had no direct coverage at all.
//
// The two decisions are tested as pure functions. The third is structural: a
// promise that must not be awaited is not observable from the outside, so it is
// asserted against the source itself.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { TaskScheduler } from "../src/core/tasks";
import {
  PaintQueue,
  REFRESH_ALERT_AFTER,
  abortTargets,
  beginRefusal,
  enqueuePaint,
  fireRefusal,
  walletLockRefusal,
  planRefreshReport,
  planTeardown,
  refreshStillApplies,
} from "../src/bot/session";

const ROOT = path.resolve(__dirname, "..", "..");
const SESSION_SRC = fs.readFileSync(path.join(ROOT, "src", "bot", "session.ts"), "utf8");

const OWNER = 111;
const GROUP = -100222;

describe("walletLockRefusal", () => {
  // Ported from the global-lock version of this rule, assertion for assertion: two
  // distinct refusals, both explaining themselves in terms of nonces, only the
  // same-chat one pointing at a Cancel button, and the whole thing pure. What is
  // new is that the unit is a wallet — the old rule refused a second run whatever
  // wallets it used, which was the safe answer arrived at by not asking.
  const mine = (index: number) => ({ walletIndex: index, chatId: OWNER });
  const theirs = (index: number) => ({ walletIndex: index, chatId: GROUP });

  it("lets a run start when none of its wallets are committed", () => {
    assert.equal(walletLockRefusal([], OWNER), null);
  });

  it("refuses a second run from the chat already using the wallet", () => {
    // The regression this rule exists for. `this.running !== chatId` returned null
    // here, and a double-tap of ✅ Send signed two sets of transactions at the same
    // nonces.
    const refusal = walletLockRefusal([mine(0)], OWNER);
    assert.notEqual(refusal, null);
    assert.match(refusal!.title, /already running/i);
  });

  it("refuses a run whose wallet another chat is signing with", () => {
    const refusal = walletLockRefusal([theirs(0)], OWNER);
    assert.notEqual(refusal, null);
    assert.match(refusal!.title, /mid-run/i);
  });

  it("says why, in terms of nonces, whichever chat is refused", () => {
    // The operator has to be able to tell a deliberate refusal from a failure.
    for (const held of [[mine(1)], [theirs(1)]]) {
      const refusal = walletLockRefusal(held, OWNER)!;
      assert.match(refusal.body, /nonce/i);
      assert.match(refusal.body, /discarded/i);
    }
  });

  it("distinguishes the two refusals, so the wording is never misleading", () => {
    const same = walletLockRefusal([mine(0)], OWNER)!;
    const other = walletLockRefusal([theirs(0)], OWNER)!;
    assert.notEqual(same.title, other.title);
    assert.notEqual(same.body, other.body);
    // Only the same-chat case can honestly point at this chat's own Cancel button.
    assert.match(same.body, /cancel/i);
    assert.doesNotMatch(other.body, /cancel/i);
  });

  it("names the wallets that are the obstacle", () => {
    // "The bot is busy" is not actionable; "W0, W2 are mid-run" is. With per-wallet
    // locking the operator's next move depends on which wallets those are.
    const refusal = walletLockRefusal([theirs(2), theirs(0)], OWNER)!;
    assert.match(refusal.body, /W0, W2/, "sorted, and named rather than counted");
  });

  it("does not name a wallet that was free", () => {
    // Asking about four wallets and being refused over one must not read as though
    // all four were committed.
    const refusal = walletLockRefusal([theirs(3)], OWNER)!;
    assert.match(refusal.body, /W3/);
    for (const absent of ["W0", "W1", "W2"]) {
      assert.doesNotMatch(refusal.body, new RegExp(absent), `${absent} was free`);
    }
  });

  it("treats a mixed set as another chat's run", () => {
    // One wallet held elsewhere means pressing this chat's Cancel would not free
    // it, so the message that points at Cancel would be a lie.
    const refusal = walletLockRefusal([mine(0), theirs(1)], OWNER)!;
    assert.match(refusal.title, /mid-run/i);
    assert.doesNotMatch(refusal.body, /cancel/i);
  });

  it("treats an unidentified holder as another chat's run", () => {
    // A task whose chat could not be resolved is the safer of the two readings:
    // claiming it as this chat's would offer a Cancel button that does nothing.
    const refusal = walletLockRefusal([{ walletIndex: 0, chatId: null }], OWNER)!;
    assert.match(refusal.title, /mid-run/i);
  });

  it("is pure — no lock state is mutated by asking", () => {
    assert.deepEqual(walletLockRefusal([theirs(0)], OWNER), walletLockRefusal([theirs(0)], OWNER));
    assert.equal(walletLockRefusal([], OWNER), null);
  });
});

describe("fireRefusal", () => {
  // The join between "which wallets are held" and "what to say about it". Both
  // sides were tested and this was not, so the mapping could have been wrong in
  // either direction with a green suite — which is how a mint gets refused for the
  // wrong reason, or not refused at all.

  const holders = (...pairs: [number, string][]) =>
    pairs.map(([walletIndex, taskId]) => ({ walletIndex, taskId }));

  it("lets a run start when the scheduler holds none of its wallets", () => {
    assert.equal(fireRefusal([], () => undefined, OWNER), null);
  });

  it("carries the wallet indexes through to the message", () => {
    const refusal = fireRefusal(holders([2, "T1"], [0, "T1"]), () => GROUP, OWNER)!;
    assert.match(refusal.body, /W0, W2/);
  });

  it("resolves each holder's chat through the lookup it is given", () => {
    const mine = fireRefusal(holders([0, "T1"]), () => OWNER, OWNER)!;
    const theirs = fireRefusal(holders([0, "T1"]), () => GROUP, OWNER)!;
    assert.match(mine.title, /already running/i);
    assert.match(theirs.title, /mid-run/i);
  });

  it("reads an unknown task as another chat's run, not as this chat's", () => {
    // The mapping that mattered: `undefined` becoming this chat's id would offer a
    // ❌ Cancel button that cannot free the wallet, and would call someone else's
    // live mint a double-tap of your own.
    const refusal = fireRefusal(holders([0, "T-gone"]), () => undefined, OWNER)!;
    assert.match(refusal.title, /mid-run/i);
    assert.doesNotMatch(refusal.body, /cancel/i);
  });

  it("looks up by the task id the holder reported", () => {
    const seen: string[] = [];
    fireRefusal(holders([0, "T7"], [1, "T9"]), (taskId) => { seen.push(taskId); return OWNER; }, OWNER);
    assert.deepEqual(seen, ["T7", "T9"], "not the wallet index, and not a guess");
  });

  it("is pure", () => {
    const held = holders([1, "T1"]);
    assert.deepEqual(fireRefusal(held, () => GROUP, OWNER), fireRefusal(held, () => GROUP, OWNER));
  });
});

describe("the lock, composed the way launch composes it", () => {
  // `walletLockRefusal` and `TaskScheduler` are each tested alone. What neither
  // proves is that they fit: the refusal is only as good as the holder list it is
  // handed, and `launch` is the one place those two meet. These drive the same
  // sequence launch does — submit, ask who holds what, decide — so the seam is
  // covered rather than assumed.

  const flush = async () => new Promise<void>((resolve) => setImmediate(resolve));

  /** Exactly launch's step: holders from the scheduler, chat ids from bookkeeping. */
  const refusalFor = (
    scheduler: TaskScheduler,
    indexes: number[],
    owner: (taskId: string) => number | null,
    chatId: number,
  ) =>
    walletLockRefusal(
      scheduler.walletHolders(indexes).map((held) => ({
        walletIndex: held.walletIndex,
        chatId: owner(held.taskId),
      })),
      chatId,
    );

  it("refuses a second run that shares a wallet with a live one", async () => {
    const scheduler = new TaskScheduler(() => 1_700_000_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = scheduler.submit({
      target: "0xaaa", chain: "base", walletIndexes: [0, 1],
      run: async () => { await gate; },
    });
    await flush();

    const refusal = refusalFor(scheduler, [1, 2], () => GROUP, OWNER);
    assert.notEqual(refusal, null, "W1 is shared, so this must not start");
    assert.match(refusal!.body, /W1/);
    assert.doesNotMatch(refusal!.body, /W2/, "W2 was free and must not be blamed");

    release();
    await first.promise;
  });

  it("lets a run on entirely different wallets start alongside", async () => {
    // The property the global flag could not express, and the reason for the
    // change: two drops on disjoint wallets cannot collide on a nonce, so nothing
    // is protected by making them wait for each other.
    const scheduler = new TaskScheduler(() => 1_700_000_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = scheduler.submit({
      target: "0xaaa", chain: "base", walletIndexes: [0, 1],
      run: async () => { await gate; },
    });
    await flush();

    assert.equal(refusalFor(scheduler, [2, 3], () => GROUP, OWNER), null);

    let secondRan = false;
    const second = scheduler.submit({
      target: "0xbbb", chain: "base", walletIndexes: [2, 3],
      run: async () => { secondRan = true; },
    });
    await second.promise;
    assert.equal(secondRan, true, "and it actually runs rather than queueing");

    release();
    await first.promise;
  });

  it("still serializes every run while they all share one keyring", async () => {
    // What the bot does today: every run takes every loaded wallet. So replacing
    // the global flag with per-wallet locks changed no behaviour — a second run is
    // refused exactly as before — and the concurrency above arrives only once a run
    // can hold a narrower set. Pinned so that claim is checked, not just asserted
    // in a comment.
    const scheduler = new TaskScheduler(() => 1_700_000_000_000);
    const everyWallet = [0, 1, 2];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = scheduler.submit({
      target: "0xaaa", chain: "base", walletIndexes: everyWallet,
      run: async () => { await gate; },
    });
    await flush();

    assert.notEqual(refusalFor(scheduler, everyWallet, () => GROUP, OWNER), null);
    release();
    await first.promise;
    assert.equal(refusalFor(scheduler, everyWallet, () => GROUP, OWNER), null, "and frees up after");
  });

  it("calls the same chat's second attempt a double-tap, not a collision", async () => {
    const scheduler = new TaskScheduler(() => 1_700_000_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = scheduler.submit({
      target: "0xaaa", chain: "base", walletIndexes: [0],
      run: async () => { await gate; },
    });
    await flush();

    const refusal = refusalFor(scheduler, [0], () => OWNER, OWNER)!;
    assert.match(refusal.title, /already running/i);
    assert.match(refusal.body, /cancel/i, "this chat's own Cancel is the way out");

    release();
    await first.promise;
  });
});

describe("abortTargets — the watch handle", () => {
  it("aborts a run and a watch together", () => {
    const run = new AbortController();
    const watch = new AbortController();
    assert.equal(abortTargets(null, run, watch).length, 2);
  });

  it("ignores an already-aborted watch", () => {
    const watch = new AbortController();
    watch.abort();
    assert.deepEqual(abortTargets(null, undefined, watch), []);
  });

  it("takes any number of handles", () => {
    assert.deepEqual(abortTargets(null, undefined, undefined, null), []);
  });
});

describe("abortTargets", () => {
  it("returns nothing when there is nothing in flight", () => {
    assert.deepEqual(abortTargets(null, undefined), []);
  });

  it("reaches a run started by another chat", () => {
    // The regression: `cancel` looked at `session.controller` only, so a run
    // started from a group panel could not be stopped from the operator's DM.
    const global = new AbortController();
    assert.deepEqual(abortTargets(global, undefined), [global]);
  });

  it("stops this chat's panel loop as well as the global run", () => {
    const global = new AbortController();
    const own = new AbortController();
    const targets = abortTargets(global, own);
    assert.equal(targets.length, 2);
    assert.ok(targets.includes(global));
    assert.ok(targets.includes(own));
  });

  it("returns one handle once when the run is this chat's own", () => {
    const shared = new AbortController();
    assert.deepEqual(abortTargets(shared, shared), [shared]);
  });

  it("ignores handles already aborted, so a second tap reads as nothing to stop", () => {
    const spent = new AbortController();
    spent.abort();
    assert.deepEqual(abortTargets(spent, undefined), []);
    assert.deepEqual(abortTargets(spent, spent), []);
  });

  it("keeps the live handle when only one of the two is spent", () => {
    const spent = new AbortController();
    spent.abort();
    const live = new AbortController();
    assert.deepEqual(abortTargets(spent, live), [live]);
    assert.deepEqual(abortTargets(live, spent), [live]);
  });

  it("aborting what it returns actually raises the signals", () => {
    const global = new AbortController();
    const own = new AbortController();
    for (const controller of abortTargets(global, own)) controller.abort();
    assert.ok(global.signal.aborted);
    assert.ok(own.signal.aborted);
  });
});

describe("the run is detached from the update loop", () => {
  it("never awaits the run from the update loop", () => {
    // The P0. `await this.fire(...)` meant handleUpdate did not return until the
    // run finished, so the bot issued no further getUpdates call for the whole
    // countdown and the ❌ Cancel button its own message offers was decorative.
    //
    // `fire` is now awaited in exactly one place — inside the scheduler task body,
    // which is itself detached — so "no await anywhere" stopped expressing the
    // property. What matters is that the entry point from the update loop does not
    // wait: `launch` is never awaited, and the one call to `fire` is inside the
    // submit that hands it to the scheduler.
    assert.doesNotMatch(SESSION_SRC, /await\s+this\.launch\(/);

    const calls = [...SESSION_SRC.matchAll(/this\.fire\(/g)];
    assert.equal(calls.length, 1, "fire has one caller, and it is launch's submit");
    const submit = SESSION_SRC.indexOf("this.scheduler.submit({");
    const registered = SESSION_SRC.indexOf("this.taskChat.set(");
    assert.ok(submit !== -1 && registered > submit, "the submit call is where it is expected");
    assert.ok(
      calls[0]!.index! > submit && calls[0]!.index! < registered,
      "the run is started inside the scheduler submit, not on the caller's stack",
    );
  });

  it("starts runs through launch(), which returns void", () => {
    assert.match(SESSION_SRC, /private launch\([\s\S]{0,200}?\): void \{/);
    assert.ok(SESSION_SRC.includes("this.launch(session,"));
  });

  it("keeps the detached promise so shutdown can wait for it", () => {
    // Aborting is not the same as having stopped: the run still has to send its
    // closing line. Without drain() the process exits first and the operator is
    // left with a countdown that simply went quiet.
    assert.match(SESSION_SRC, /async drain\(\): Promise<void>/);
    assert.match(SESSION_SRC, /this\.activeRun = run;/);
  });

  it("catches the detached promise, so a failure cannot take the process down", () => {
    // The task's promise, now that the scheduler owns the run. Nothing awaits it,
    // so an escaping rejection would be unhandled and a bot that dies mid-mint is
    // worse than one that reports a failure.
    assert.match(SESSION_SRC, /task\.promise\s*\n?\s*\.catch\(/);
  });

  it("releases the global handle when the run ends", () => {
    // A stale activeController would make the next /cancel abort an already
    // finished run and report "Aborting" while nothing was running.
    assert.match(SESSION_SRC, /this\.activeController = null;/);
  });

  it("drains every live task, not only the newest", () => {
    // `activeRun` holds one promise. With more than one run possible, waiting on
    // it alone would cut an older mint off mid-closing-line exactly as awaiting
    // nothing used to cut off the only one.
    assert.match(SESSION_SRC, /this\.runningTasks\.set\(/);
    assert.match(SESSION_SRC, /\.\.\.this\.runningTasks\.values\(\)/);
    assert.match(SESSION_SRC, /this\.runningTasks\.delete\(/);
  });

  it("holds no lock of its own beside the scheduler's", () => {
    // The point of the change. A `running` chat id next to the wallet locks is a
    // second answer to "may this run start", and the two would drift.
    assert.doesNotMatch(SESSION_SRC, /private running\b/);
    assert.doesNotMatch(SESSION_SRC, /this\.running\s*=/);
    assert.doesNotMatch(SESSION_SRC, /private runningTarget\b/);
  });

  it("asks the scheduler for real holders, and refuses before it claims the lock", () => {
    // The gap this closes: `launch` is private and needs a prepared plan, a chain
    // and a provider, so no test reaches it — and neutering its refusal check left
    // every test passing. What is checked here is that the call exists, is fed the
    // scheduler's own holder list rather than a constant, and happens before the
    // submit that takes the wallets.
    const at = SESSION_SRC.indexOf("private launch(");
    assert.notEqual(at, -1);
    const body = SESSION_SRC.slice(at, SESSION_SRC.indexOf("\n  /**", at));

    const gate = body.indexOf("fireRefusal(");
    const claim = body.indexOf("this.scheduler.submit({");
    assert.notEqual(gate, -1, "launch must consult the lock");
    assert.notEqual(claim, -1, "launch must submit the run");
    assert.ok(gate < claim, "the lock is consulted before the wallets are claimed");
    assert.match(
      body.slice(gate, claim),
      /this\.scheduler\.walletHolders\(indexes\)/,
      "fed the live holder list for this run's own wallets",
    );
    assert.match(body.slice(gate, claim), /return;/, "and a refusal actually returns");
  });

  it("reports phases to the task record, and does it through the tap", () => {
    // How the statuses came to be dead: the task context was threaded into the run
    // and then never called. `noUnusedParameters` is off, so nothing said so, and
    // every task read DISCOVERING from start to finish while the scheduler's guard
    // against re-signing after a broadcast sat permanently unarmed.
    // The mapped value, under the condition that it is a phase at all. Asserting
    // only that `ctx.phase(` appears somewhere passed while the tap reported a
    // hardcoded phase whenever the mapping returned nothing — the exact inversion
    // of what it should do.
    assert.match(SESSION_SRC, /phaseForEvent\(event\)/, "phases come from the engine's events");
    assert.match(SESSION_SRC, /next !== null/, "a non-phase must report nothing");
    assert.match(SESSION_SRC, /ctx\.phase\(next\)/, "the mapped phase, not a literal");
    // The tap, not the bare handler: passing reporter.handle straight through would
    // paint the panel correctly and report nothing.
    assert.match(SESSION_SRC, /^\s*report,\s*$/m, "runMint is given the tap");
    assert.doesNotMatch(SESSION_SRC, /^\s*reporter\.handle,\s*$/m);
  });

  it("cannot let a phase report break a mint", () => {
    // Reporting is bookkeeping and the mint is not. A throw from the tap would
    // escape into the engine's own emit call, mid-dispatch.
    const at = SESSION_SRC.indexOf("const report = (");
    assert.notEqual(at, -1);
    const body = SESSION_SRC.slice(at, SESSION_SRC.indexOf("\n    };", at));
    assert.match(body, /try \{/, "the phase report is guarded");
    assert.match(body, /catch/);
    // Both indexes checked for presence before they are compared. `indexOf` returns
    // -1 for something absent, and -1 is less than every real index, so the naive
    // ordering assertion passed most convincingly at the moment the call it was
    // meant to locate had been deleted outright.
    const panel = body.indexOf("reporter.handle(event)");
    const guard = body.indexOf("try {");
    assert.notEqual(panel, -1, "the panel must still be told about the event");
    assert.notEqual(guard, -1, "the phase report must still be guarded");
    assert.ok(
      panel < guard,
      "the panel is told first, so a reporting bug cannot cost the operator the panel too",
    );
  });

  it("cancels through the scheduler, so a cancel reaches every run", () => {
    // Scoped to cancel's own body. Asserting the call appears *somewhere* in the
    // file passed while cancel had lost it entirely, because shutdown calls it too
    // — so the test proved only that the method name still existed.
    const body = (name: string): string => {
      const at = SESSION_SRC.indexOf(name);
      assert.notEqual(at, -1, `${name} not found`);
      const next = SESSION_SRC.indexOf("\n  private ", at + name.length);
      return SESSION_SRC.slice(at, next === -1 ? undefined : next);
    };
    assert.match(body("private async cancel(session: Session)"), /this\.scheduler\.cancelAll\(\)/);
    assert.match(body("shutdown(): void {"), /this\.scheduler\.cancelAll\(\)/);
  });
});

describe("planTeardown", () => {
  // Stand-ins for PreparedRun. Only identity matters to the rule.
  const mine = { id: "the run that just finished" };
  const theirs = { id: "a mint prepared while it was running" };

  const owned = (controller: AbortController) => ({ controller, run: mine });

  it("tears down everything when nothing else has happened", () => {
    const c = new AbortController();
    assert.deepEqual(planTeardown({ controller: c, draftRun: mine, view: "running" }, owned(c)), {
      clearController: true,
      discardDraft: true,
      closeOwnRunOnly: false,
      showMenu: true,
    });
  });

  it("leaves a mint prepared during the run completely alone", () => {
    // The regression detaching the run introduced. `discardDraft` would have
    // called closeRun() on `theirs`, so the confirm panel still on screen would
    // fire against a closed provider — and nothing in that failure would name
    // the run that closed it.
    const c = new AbortController();
    const plan = planTeardown({ controller: c, draftRun: theirs, view: "confirm" }, owned(c));
    assert.equal(plan.discardDraft, false);
    assert.equal(plan.closeOwnRunOnly, true);
  });

  it("still closes its own provider when the draft has moved on", () => {
    // The other half: not discarding must not mean leaking. A provider left open
    // is a leaked file descriptor, and a bot that runs for weeks accumulates them.
    const c = new AbortController();
    const plan = planTeardown({ controller: c, draftRun: theirs, view: "confirm" }, owned(c));
    assert.equal(plan.closeOwnRunOnly, true);
  });

  it("never both discards the draft and closes the run separately", () => {
    // Doing both would call closeRun() twice on the same provider.
    const c = new AbortController();
    for (const draftRun of [mine, theirs, undefined]) {
      const plan = planTeardown({ controller: c, draftRun, view: "running" }, owned(c));
      assert.notEqual(plan.discardDraft, plan.closeOwnRunOnly);
    }
  });

  it("closes its own run when the draft was cleared out from under it", () => {
    const c = new AbortController();
    const plan = planTeardown({ controller: c, draftRun: undefined, view: "menu" }, owned(c));
    assert.equal(plan.discardDraft, false);
    assert.equal(plan.closeOwnRunOnly, true);
  });

  it("does not repaint over a panel the operator has navigated to", () => {
    const c = new AbortController();
    for (const view of ["menu", "confirm", "askTarget", "watch"]) {
      assert.equal(planTeardown({ controller: c, draftRun: mine, view }, owned(c)).showMenu, false);
    }
  });

  it("repaints only while the panel is still the run's own", () => {
    const c = new AbortController();
    assert.equal(
      planTeardown({ controller: c, draftRun: mine, view: "running" }, owned(c)).showMenu,
      true,
    );
  });

  it("does not delete a controller belonging to something started later", () => {
    // A watch panel opened during the run installs its own controller. Deleting
    // it here would leave that loop running with nothing able to stop it — and
    // ❌ Cancel would then report "nothing to cancel" while the panel kept editing.
    const ran = new AbortController();
    const watching = new AbortController();
    const plan = planTeardown(
      { controller: watching, draftRun: mine, view: "watch" },
      { controller: ran, run: mine },
    );
    assert.equal(plan.clearController, false);
  });

  it("clears the controller when it is still the run's own", () => {
    const c = new AbortController();
    assert.equal(
      planTeardown({ controller: c, draftRun: mine, view: "running" }, owned(c)).clearController,
      true,
    );
  });

  it("copes with the session having no controller at all", () => {
    const c = new AbortController();
    const plan = planTeardown({ controller: undefined, draftRun: mine, view: "running" }, owned(c));
    assert.equal(plan.clearController, false);
  });
});

/**
 * Panel edits target one Telegram message, so two in flight at once land in
 * whatever order the network picks. The symptom was a panel left on "Working…"
 * over a result that had already been drawn.
 */
describe("enqueuePaint", () => {
  /** Drain the microtask queue, so ordering assertions do not count ticks. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  /**
   * A draw that records the order it was called in and blocks until released.
   *
   * `release` works whether or not the draw has started yet, so a test never
   * deadlocks on having guessed the wrong number of ticks.
   */
  function recorder() {
    const drawn: string[] = [];
    const released = new Set<string>();
    const waiting = new Map<string, () => void>();
    const release = (value: string): void => {
      released.add(value);
      waiting.get(value)?.();
      waiting.delete(value);
    };
    const draw = (value: string): Promise<void> => {
      drawn.push(value);
      if (released.has(value)) return Promise.resolve();
      return new Promise<void>((resolve) => waiting.set(value, resolve));
    };
    return { drawn, draw, release };
  }

  it("draws serially, never concurrently", async () => {
    const r = recorder();
    const queue: PaintQueue<string> = { chain: Promise.resolve() };
    const a = enqueuePaint(queue, "a", r.draw);
    await flush();
    assert.deepEqual(r.drawn, ["a"], "first draw should start");
    const b = enqueuePaint(queue, "b", r.draw);
    await flush();
    assert.deepEqual(r.drawn, ["a"], "second must wait for the first to finish");
    r.release("a");
    await a;
    await flush();
    assert.deepEqual(r.drawn, ["a", "b"]);
    r.release("b");
    await b;
  });

  it("coalesces a burst into one draw of the newest value", async () => {
    // Progress callbacks arrive faster than an edit round trip. Drawing each one
    // spends a rate-limited API call on a step nobody will see.
    const r = recorder();
    const queue: PaintQueue<string> = { chain: Promise.resolve() };
    const first = enqueuePaint(queue, "step1", r.draw);
    await flush();
    enqueuePaint(queue, "step2", r.draw);
    enqueuePaint(queue, "step3", r.draw);
    const last = enqueuePaint(queue, "step4", r.draw);
    r.release("step1");
    r.release("step4");
    await Promise.all([first, last]);
    assert.deepEqual(r.drawn, ["step1", "step4"], "intermediate steps should be dropped");
  });

  it("keeps drawing after a draw rejects", async () => {
    // A chain advanced with the rejecting promise would skip everything queued
    // behind it — one failed edit, and the panel never updates again.
    const drawn: string[] = [];
    const queue: PaintQueue<string> = { chain: Promise.resolve() };
    const draw = async (value: string): Promise<void> => {
      drawn.push(value);
      if (value === "bad") throw new Error("edit failed");
    };
    await enqueuePaint(queue, "bad", draw).catch(() => {});
    await enqueuePaint(queue, "good", draw);
    assert.deepEqual(drawn, ["bad", "good"]);
  });

  it("resolves only once the panel shows content at least as new", async () => {
    const drawn: string[] = [];
    const queue: PaintQueue<string> = { chain: Promise.resolve() };
    const draw = async (value: string): Promise<void> => {
      drawn.push(value);
    };
    await enqueuePaint(queue, "x", draw);
    assert.deepEqual(drawn, ["x"]);
  });

  it("leaves nothing pending once drained", async () => {
    const queue: PaintQueue<string> = { chain: Promise.resolve() };
    await enqueuePaint(queue, "x", async () => {});
    assert.equal(queue.pending, undefined);
  });
});

/**
 * An auto-refresh has no callback_query_id to answer, and the failure branch used
 * to answer `queryId ?? ""` into a swallowed rejection. So the failure that
 * happens while nobody is pressing anything was reported nowhere, and a frozen
 * countdown is indistinguishable from a current one.
 */
describe("planRefreshReport", () => {
  it("toasts a failure the operator caused by pressing a button", () => {
    assert.deepEqual(planRefreshReport("q1", 1), { toast: true, announce: false });
  });

  it("does not announce an interactive failure", () => {
    // The toast already told them, and they are clearly watching.
    assert.equal(planRefreshReport("q1", REFRESH_ALERT_AFTER).announce, false);
  });

  it("stays quiet for a single timer failure", () => {
    // The next tick usually succeeds; a message per blip trains the operator to
    // ignore the channel.
    assert.deepEqual(planRefreshReport(undefined, 1), { toast: false, announce: false });
  });

  it("announces once the streak reaches the threshold", () => {
    assert.equal(planRefreshReport(undefined, REFRESH_ALERT_AFTER).announce, true);
  });

  it("announces exactly once per streak, not on every later failure", () => {
    // A long outage is one message, not one per tick.
    assert.equal(planRefreshReport(undefined, REFRESH_ALERT_AFTER + 1).announce, false);
    assert.equal(planRefreshReport(undefined, REFRESH_ALERT_AFTER + 9).announce, false);
  });

  it("treats an empty query id as non-interactive", () => {
    // This was the actual bug: `queryId ?? ""` is not a usable id, and Telegram
    // rejects it rather than delivering anything.
    assert.deepEqual(planRefreshReport("", REFRESH_ALERT_AFTER), {
      toast: false,
      announce: true,
    });
  });
});

/**
 * The setup guard used to read `session.view === "running"` — a display flag that
 * any panel overwrites. `/status` sets the view to "status", and from then on the
 * guard saw an idle chat while a mint was still signing.
 */
describe("beginRefusal", () => {
  it("refuses while this chat has a run of its own", () => {
    assert.equal(beginRefusal(true, "menu")?.title, "A run is in progress");
  });

  it("still refuses after a view change has hidden the run", () => {
    // The actual bug: /status, 👛 Wallets or any other panel used to unlock this.
    for (const view of ["status", "wallets", "menu", "check", "stages"]) {
      assert.notEqual(beginRefusal(true, view), null, `view "${view}" defeated the guard`);
    }
  });

  it("refuses while this chat is watching", () => {
    assert.equal(beginRefusal(false, "watching")?.title, "A watch is running");
  });

  it("allows setup while only another chat runs", () => {
    // Preparing a target sends nothing, so the caller passes false for a run that
    // is not this chat's. Wallet contention is re-checked at fire time, which is
    // where refusing actually protects the nonces.
    assert.equal(beginRefusal(false, "menu"), null);
  });

  it("allows setup when nothing is running", () => {
    assert.equal(beginRefusal(false, "menu"), null);
  });
});

describe("the watch is detached from the update loop too", () => {
  it("does not await watch inside a handler", () => {
    // `watch` runs until the stage opens. Awaiting it inside handleUpdate stopped
    // the bot reading updates for that whole time, so ❌ Cancel could not be
    // delivered — the same defect detaching `fire` fixed, left on this path.
    assert.doesNotMatch(SESSION_SRC, /await\s+this\.watch\(/);
    assert.match(SESSION_SRC, /this\.launchWatch\(session\)/);
  });

  it("tracks the watch so shutdown can wait for it", () => {
    assert.match(SESSION_SRC, /activeWatch/);
    // The watch is drained alongside the runs. Matched loosely on purpose: drain
    // also waits on every live task, and pinning the exact argument list made this
    // test fail for the change that added them rather than for a lost watch.
    assert.match(SESSION_SRC, /Promise\.allSettled\(\[this\.activeRun, this\.activeWatch/);
  });

  it("gives the watch its own abort handle", () => {
    // Assigning session.controller left a live mint with no handle at all.
    assert.match(SESSION_SRC, /session\.watchController = controller/);
  });

  it("aborts the global controller on shutdown", () => {
    assert.match(SESSION_SRC, /this\.activeController\?\.abort\(\)/);
  });

  it("only replaces a panel Telegram says is gone", () => {
    // Every failure used to clear panelId and post a replacement, so one 429
    // filled the chat with panels.
    assert.match(SESSION_SRC, /if \(!isMessageGone\(err\)\) return;/);
  });
});

describe("refreshStillApplies — the auto-refresh cannot paint over a panel that moved", () => {
  const run = { id: "the run the refresh was started for" };

  it("commits when nothing moved", () => {
    assert.equal(refreshStillApplies("check", "check", run, run), true);
    assert.equal(refreshStillApplies("stages", "stages", run, run), true);
  });

  it("refuses when the operator navigated away mid-read", () => {
    // refreshRun takes seconds of live RPC. Pressing ⬅ Menu during it used to
    // repaint the Check panel over the menu the operator had just opened.
    assert.equal(refreshStillApplies("check", "menu", run, run), false);
    assert.equal(refreshStillApplies("check", "wallets", run, run), false);
  });

  it("refuses when the operator switched between the two refreshable views", () => {
    // Both views auto-refresh, so neither the entry guard nor the exit guard can
    // be a bare "is it check-or-stages" test.
    assert.equal(refreshStillApplies("check", "stages", run, run), false);
    assert.equal(refreshStillApplies("stages", "check", run, run), false);
  });

  it("refuses when the prepared run was replaced under it", () => {
    // ❌ Cancel clears draft.run; a mint replaces it. Either way the rebuilt run
    // must not be written back over whatever is there now.
    assert.equal(refreshStillApplies("check", "check", run, undefined), false);
    assert.equal(refreshStillApplies("check", "check", run, { id: "a different run" }), false);
  });

  it("compares runs by identity, not by value", () => {
    // A rebuilt run holding identical numbers is still the wrong object to commit:
    // it is the exact case where something else already swapped the draft.
    assert.equal(refreshStillApplies("check", "check", { id: "r" }, { id: "r" }), false);
  });

  it("refuses when both moved", () => {
    assert.equal(refreshStillApplies("check", "menu", run, undefined), false);
  });

  it("never commits into a view that does not own a refreshable panel", () => {
    // Belt and braces: even if the view is unchanged, only these two paint here.
    for (const view of ["menu", "wallets", "stages_detail", "confirm", ""]) {
      if (view === "stages") continue;
      assert.equal(
        refreshStillApplies(view, view, run, run),
        false,
        `${view} must not be repainted by the refresh loop`,
      );
    }
  });
});

describe("the recheck runs after the reads, not only before them", () => {
  it("captures the view at entry and uses it for every later decision", () => {
    // session.view is read live everywhere else, so the refresh path has to pin
    // it once — reading it again after the await is the bug, not the fix.
    assert.match(SESSION_SRC, /const startedView = session\.view;/);
    assert.match(SESSION_SRC, /startedView === "check" \? await this\.readBalances\(fresh\)/);
    assert.match(SESSION_SRC, /startedView === "check" \? this\.renderCheck/);
  });

  it("guards the write-back with refreshStillApplies", () => {
    assert.match(
      SESSION_SRC,
      /if \(!refreshStillApplies\(startedView, session\.view, run, session\.draft\.run\)\) return;/,
    );
  });

  it("puts the guard after the balance read, so both awaits are covered", () => {
    const readAt = SESSION_SRC.indexOf("await this.readBalances(fresh)");
    const guardAt = SESSION_SRC.indexOf("if (!refreshStillApplies(");
    const commitAt = SESSION_SRC.indexOf("session.draft.run = fresh;");
    assert.ok(readAt > 0 && guardAt > 0 && commitAt > 0);
    assert.ok(guardAt > readAt, "the guard must run after the balance read");
    assert.ok(commitAt > guardAt, "the commit must run after the guard");
  });

  it("does not close the discarded run", () => {
    // refreshRun reuses run.rpc.provider, so closing `fresh` would destroy the
    // provider the still-live original run is using. Dropping it leaks nothing.
    const after = SESSION_SRC.slice(SESSION_SRC.indexOf("if (!refreshStillApplies("));
    const guardBody = after.slice(0, after.indexOf("session.draft.run = fresh;"));
    assert.doesNotMatch(guardBody, /closeRun/);
  });
});
