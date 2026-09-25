// The panel's closed vocabulary, and the edit pacing behind live refreshes.
//
// Two things are pinned here. Callback data is attacker-supplied — a modified
// client echoes back whatever it likes — so `parseCallback` must reject anything
// outside the action set rather than defaulting to something. And the edit gate
// is what keeps a 20s auto-refresh and an impatient finger from earning a 429 on
// the chat the user is watching.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAIN_MENU,
  PANEL_ACTIONS,
  dryRunButton,
  chainKeyboard,
  confirmKeyboard,
  encodeCallback,
  isPanelAction,
  parseCallback,
  quantityKeyboard,
  refreshKeyboard,
} from "../src/bot/panel";
import {
  AUTO_REFRESH_MS,
  EditGate,
  FINAL_WRITE_ATTEMPTS,
  FINAL_WRITE_BUDGET_MS,
  MANUAL_DEBOUNCE_MS,
  MIN_EDIT_GAP_MS,
  MIN_FINAL_RETRY_MS,
  debouncedToast,
  newWriteGate,
  nextWriteDelay,
  noteRateLimit,
  planFinalWrite,
} from "../src/bot/refresh";
import { CHAINS } from "../src/core/chains";

const NOW = 1773576000000;

describe("parseCallback", () => {
  it("parses a bare action", () => {
    assert.deepEqual(parseCallback("menu"), { action: "menu", value: "" });
  });

  it("parses an action with a value", () => {
    assert.deepEqual(parseCallback("chain:base"), { action: "chain", value: "base" });
    assert.deepEqual(parseCallback("qty:5"), { action: "qty", value: "5" });
  });

  it("rejects an unknown action instead of defaulting to one", () => {
    // A stale keyboard from an older deployment must produce a visible "that
    // button is out of date", never a silent no-op and never a wrong navigation.
    assert.equal(parseCallback("selfdestruct"), null);
    assert.equal(parseCallback("mint_now"), null);
    assert.equal(parseCallback("MINT"), null);
  });

  it("rejects empty and missing data", () => {
    assert.equal(parseCallback(undefined), null);
    assert.equal(parseCallback(""), null);
  });

  it("rejects a value whose action is not in the set", () => {
    assert.equal(parseCallback("drain:everything"), null);
  });

  it("keeps colons inside the value", () => {
    // Only the first colon separates; the rest belong to the payload.
    assert.deepEqual(parseCallback("chain:a:b"), { action: "chain", value: "a:b" });
  });

  it("round-trips everything encodeCallback emits", () => {
    for (const action of PANEL_ACTIONS) {
      assert.deepEqual(parseCallback(encodeCallback(action)), { action, value: "" });
      assert.deepEqual(parseCallback(encodeCallback(action, "v")), { action, value: "v" });
    }
  });
});

describe("isPanelAction", () => {
  it("accepts exactly the documented actions", () => {
    for (const action of PANEL_ACTIONS) assert.ok(isPanelAction(action));
  });

  it("rejects anything else", () => {
    assert.ok(!isPanelAction("fire_all"));
    assert.ok(!isPanelAction(""));
    assert.ok(!isPanelAction("__proto__"));
  });
});

describe("keyboards", () => {
  it("emits only parseable callback data", () => {
    // If a keyboard could emit data its own parser rejects, the button would be
    // dead on arrival — and only in production, where the panel is built for real.
    const keyboards = [
      MAIN_MENU,
      chainKeyboard(),
      quantityKeyboard(),
      confirmKeyboard(),
      refreshKeyboard(true),
      refreshKeyboard(false),
    ];
    for (const keyboard of keyboards) {
      for (const row of keyboard) {
        for (const button of row) {
          assert.ok(
            parseCallback(button.callback_data),
            `unparseable callback: ${button.callback_data}`,
          );
        }
      }
    }
  });

  it("keeps every callback payload inside Telegram's 64-byte limit", () => {
    for (const row of chainKeyboard()) {
      for (const button of row) {
        assert.ok(Buffer.byteLength(button.callback_data) <= 64);
      }
    }
  });

  it("offers the seven main-menu actions the spec fixes", () => {
    const labels = MAIN_MENU.flat().map((b) => b.text);
    assert.deepEqual(labels, [
      "🎯 Mint",
      "🔍 Check",
      "👀 Watch",
      "📊 Stages",
      "👛 Wallets",
      "📈 Status",
      "❌ Cancel",
    ]);
  });

  it("pairs chains two to a row and ends with cancel", () => {
    const keyboard = chainKeyboard(CHAINS.slice(0, 4));
    assert.equal(keyboard.length, 3); // two rows of two, plus cancel
    assert.equal(keyboard[0]!.length, 2);
    assert.equal(keyboard.at(-1)!.length, 1);
    assert.match(keyboard.at(-1)![0]!.text, /Cancel/);
  });

  it("handles an odd number of chains without an empty row", () => {
    const keyboard = chainKeyboard(CHAINS.slice(0, 3));
    for (const row of keyboard) assert.ok(row.length > 0);
  });

  it("puts Send and Cancel on the confirm step and nothing else", () => {
    // Nothing signs until ✅ Send, so this keyboard must not grow a shortcut.
    const buttons = confirmKeyboard().flat();
    assert.equal(buttons.length, 2);
    assert.deepEqual(buttons.map((b) => b.text), ["✅ Send", "❌ Cancel"]);
    assert.equal(buttons[0]!.callback_data, "send");
  });

  it("makes the auto toggle request the opposite of its current state", () => {
    // The label shows what auto *is*; the payload asks for what it should become.
    const on = refreshKeyboard(true).flat().find((b) => b.text.startsWith("⏱"))!;
    assert.equal(on.text, "⏱ Auto: on");
    assert.equal(on.callback_data, "auto:off");

    const off = refreshKeyboard(false).flat().find((b) => b.text.startsWith("⏱"))!;
    assert.equal(off.text, "⏱ Auto: off");
    assert.equal(off.callback_data, "auto:on");
  });

  it("offers quantities that all parse as positive integers", () => {
    const quantities = quantityKeyboard()
      .flat()
      .map((b) => parseCallback(b.callback_data)!)
      .filter((p) => p.action === "qty")
      .map((p) => Number(p.value));
    assert.ok(quantities.length > 0);
    for (const q of quantities) assert.ok(Number.isInteger(q) && q > 0);
  });
});

describe("EditGate", () => {
  it("allows the first edit of a fresh panel", () => {
    const gate = new EditGate();
    assert.ok(gate.allows("manual", NOW));
    assert.ok(gate.allows("auto", NOW));
  });

  it("debounces repeat taps for three seconds", () => {
    const gate = new EditGate();
    gate.record(NOW);
    assert.ok(!gate.allows("manual", NOW + 500));
    assert.ok(!gate.allows("manual", NOW + MANUAL_DEBOUNCE_MS - 1));
    assert.ok(gate.allows("manual", NOW + MANUAL_DEBOUNCE_MS));
  });

  it("holds auto ticks only to the one-second connection floor", () => {
    // The 20s timer paces itself; applying the 3s debounce to it would add a
    // branch that can only ever go wrong.
    const gate = new EditGate();
    gate.record(NOW);
    assert.ok(!gate.allows("auto", NOW + MIN_EDIT_GAP_MS - 1));
    assert.ok(gate.allows("auto", NOW + MIN_EDIT_GAP_MS));
  });

  it("never allows two edits inside a second, from any source", () => {
    const gate = new EditGate();
    gate.record(NOW);
    assert.ok(!gate.allows("manual", NOW + 999));
    assert.ok(!gate.allows("auto", NOW + 999));
  });

  it("does not push the next allowed edit back when one is refused", () => {
    // record() is called only when an edit actually goes out. If a refusal moved
    // the clock, repeat tapping would starve the panel indefinitely.
    const gate = new EditGate();
    gate.record(NOW);
    assert.ok(!gate.allows("manual", NOW + 1_000));
    assert.ok(!gate.allows("manual", NOW + 2_000));
    assert.ok(gate.allows("manual", NOW + MANUAL_DEBOUNCE_MS));
  });

  it("reports the remaining wait for the toast", () => {
    const gate = new EditGate();
    gate.record(NOW);
    assert.equal(gate.waitMs("manual", NOW + 1_000), MANUAL_DEBOUNCE_MS - 1_000);
    assert.equal(gate.waitMs("auto", NOW + 1_000), 0);
  });

  it("never reports a negative wait", () => {
    const gate = new EditGate();
    gate.record(NOW);
    assert.equal(gate.waitMs("manual", NOW + 10_000), 0);
  });

  it("re-arms on reset", () => {
    const gate = new EditGate();
    gate.record(NOW);
    gate.reset();
    assert.ok(gate.allows("manual", NOW));
  });

  it("honours custom windows", () => {
    const gate = new EditGate(10_000, 5_000);
    gate.record(NOW);
    assert.ok(!gate.allows("manual", NOW + 9_999));
    assert.ok(gate.allows("manual", NOW + 10_000));
    assert.ok(gate.allows("auto", NOW + 5_000));
  });
});

describe("debouncedToast", () => {
  it("says how long to wait, rounded up", () => {
    // A silent refusal is indistinguishable from a hung bot — which is the thing
    // people tap repeatedly about.
    assert.equal(debouncedToast(2_400), "Just refreshed — try again in 3s");
    assert.equal(debouncedToast(1_000), "Just refreshed — try again in 1s");
  });

  it("never says zero seconds", () => {
    assert.equal(debouncedToast(0), "Just refreshed — try again in 1s");
    assert.equal(debouncedToast(-100), "Just refreshed — try again in 1s");
  });
});

describe("refresh constants", () => {
  it("keeps auto-refresh well clear of the per-chat edit limit", () => {
    assert.ok(AUTO_REFRESH_MS >= MIN_EDIT_GAP_MS * 2);
    assert.ok(MANUAL_DEBOUNCE_MS >= MIN_EDIT_GAP_MS);
  });
});

describe("the dry-run button", () => {
  it("asks for a dry run and nothing else", () => {
    assert.deepEqual(parseCallback(dryRunButton().callback_data), {
      action: "dryrun",
      value: "",
    });
  });

  it("cannot be confused with Send by its callback data", () => {
    // The two buttons sit on the same panel and do opposite things. A shared
    // prefix would make a truncated or mangled callback resolve to the wrong one.
    assert.notEqual(dryRunButton().callback_data, encodeCallback("send"));
    assert.ok(!dryRunButton().callback_data.startsWith("send"));
  });

  it("says what it does in the label", () => {
    assert.match(dryRunButton().text, /dry run/i);
  });
});

/**
 * The gates above stop us earning a 429. This one governs what happens once we
 * have earned one anyway — which the run painter previously handled by discarding
 * the error, retry_after and all, and trying again 1.2 seconds later.
 */
describe("WriteGate — Telegram's own backoff", () => {
  const NOW = 1_700_000_000_000;

  it("lets the first write go out immediately", () => {
    assert.equal(nextWriteDelay(newWriteGate(), NOW, 1_200), 0);
  });

  it("holds an ordinary write to the interval", () => {
    const gate = { lastWriteMs: NOW, blockedUntilMs: 0 };
    assert.equal(nextWriteDelay(gate, NOW + 200, 1_200), 1_000);
  });

  it("lets a forced write skip our own interval", () => {
    const gate = { lastWriteMs: NOW, blockedUntilMs: 0 };
    assert.equal(nextWriteDelay(gate, NOW + 200, 1_200, true), 0);
  });

  it("does NOT let a forced write skip a retry_after", () => {
    // The whole point. Jumping the queue into a live rate limit does not deliver
    // the message early, it loses it and lengthens the next retry_after.
    const gate = noteRateLimit(newWriteGate(), NOW, 5);
    assert.equal(nextWriteDelay(gate, NOW, 1_200, true), 5_000);
    assert.equal(nextWriteDelay(gate, NOW + 4_000, 1_200, true), 1_000);
    assert.equal(nextWriteDelay(gate, NOW + 5_000, 1_200, true), 0);
  });

  it("takes whichever wait is longer", () => {
    const gate = noteRateLimit({ lastWriteMs: NOW, blockedUntilMs: 0 }, NOW, 1);
    // interval 1200ms vs retry_after 1000ms
    assert.equal(nextWriteDelay(gate, NOW, 1_200), 1_200);
  });

  it("rounds a fractional retry_after up", () => {
    assert.equal(noteRateLimit(newWriteGate(), NOW, 1.2).blockedUntilMs, NOW + 2_000);
  });

  it("never shortens a block already in force", () => {
    const long = noteRateLimit(newWriteGate(), NOW, 30);
    assert.equal(noteRateLimit(long, NOW, 1).blockedUntilMs, long.blockedUntilMs);
  });

  it("ignores a missing or nonsensical retry_after", () => {
    // A 429 without one still gets our own interval, which is what it got before.
    for (const bad of [undefined, 0, -5, NaN, Infinity]) {
      assert.equal(noteRateLimit(newWriteGate(), NOW, bad).blockedUntilMs, 0);
    }
  });

  it("does not mutate the gate it is given", () => {
    const gate = newWriteGate();
    noteRateLimit(gate, NOW, 5);
    assert.equal(gate.blockedUntilMs, 0);
  });
});

/**
 * The final write is the only one whose failure costs the operator something: the
 * per-wallet lines and tx hashes exist nowhere else. It is also the one that runs
 * while the global mint lock is still held, so the retry has to be bounded.
 */
describe("planFinalWrite", () => {
  it("retries a first failure", () => {
    assert.deepEqual(planFinalWrite(1, 0, 0), { kind: "retry", waitMs: MIN_FINAL_RETRY_MS });
  });

  it("waits out a retry_after when there is budget for it", () => {
    assert.deepEqual(planFinalWrite(1, 5_000, 0), { kind: "retry", waitMs: 5_000 });
  });

  it("never retries a permanent error in a spin", () => {
    // waitMs 0 with a parse error would otherwise loop as fast as the event loop
    // allows until the attempt cap, four times in under a millisecond.
    const plan = planFinalWrite(2, 0, 10);
    assert.equal(plan.kind === "retry" && plan.waitMs >= MIN_FINAL_RETRY_MS, true);
  });

  it("gives up after the attempt cap", () => {
    const plan = planFinalWrite(FINAL_WRITE_ATTEMPTS, 0, 0);
    assert.equal(plan.kind, "giveup");
    assert.match(plan.kind === "giveup" ? plan.reason : "", /attempts failed/);
  });

  it("gives up once the budget is spent", () => {
    const plan = planFinalWrite(2, 0, FINAL_WRITE_BUDGET_MS);
    assert.equal(plan.kind, "giveup");
    assert.match(plan.kind === "giveup" ? plan.reason : "", /budget is spent/);
  });

  it("refuses a wait longer than the budget has left", () => {
    // Telegram occasionally answers with minutes. Honouring that here would hold
    // the mint lock for minutes after the mint finished.
    const plan = planFinalWrite(1, 120_000, 0);
    assert.equal(plan.kind, "giveup");
    assert.match(plan.kind === "giveup" ? plan.reason : "", /longer than/);
  });

  it("states the reason it gave up, for the operator", () => {
    // The caller turns this into a message. A silent give-up leaves a stale
    // countdown reading as the outcome of a mint that spent real money.
    const plan = planFinalWrite(FINAL_WRITE_ATTEMPTS, 0, 0);
    assert.ok(plan.kind === "giveup" && plan.reason.length > 0);
  });
});
