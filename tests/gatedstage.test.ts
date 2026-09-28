// Which stage the eligibility question is actually about.
//
// The rule under test is the brief's, and it is a rule because getting it wrong
// is invisible: an answer about the wrong stage is a well-formed answer with the
// wrong price and the wrong allowance in it. Position in the array means nothing
// here — only the clock decides, and public stages are not asked about at all.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DropSchedule, DropStage } from "../src/core/opensea";
import { gatedStageToAsk } from "../src/core/prepare";

const NOW = 1_773_576_000_000;
const HOUR = 3_600_000;

const stage = (over: Partial<DropStage> & { label: string }): DropStage => ({
  type: "presale",
  startMs: NOW + HOUR,
  endMs: NOW + 2 * HOUR,
  isPublic: false,
  ...over,
});

const schedule = (...stages: DropStage[]): DropSchedule =>
  ({ stages } as DropSchedule);

describe("gatedStageToAsk", () => {
  it("prefers a gated stage that is open right now", () => {
    const open = stage({ label: "FCFS", startMs: NOW - HOUR, endMs: NOW + HOUR });
    const later = stage({ label: "Later", startMs: NOW + 2 * HOUR, endMs: NOW + 3 * HOUR });
    assert.equal(gatedStageToAsk(schedule(open, later), NOW)?.label, "FCFS");
  });

  it("takes the soonest gated stage still ahead when none is open", () => {
    const soon = stage({ label: "GTD", startMs: NOW + HOUR, endMs: NOW + 2 * HOUR });
    const late = stage({ label: "FCFS", startMs: NOW + 5 * HOUR, endMs: NOW + 6 * HOUR });
    assert.equal(gatedStageToAsk(schedule(soon, late), NOW)?.label, "GTD");
  });

  it("ignores a gated stage that has already closed", () => {
    const done = stage({ label: "Over", startMs: NOW - 3 * HOUR, endMs: NOW - 2 * HOUR });
    const next = stage({ label: "Next", startMs: NOW + HOUR, endMs: NOW + 2 * HOUR });
    assert.equal(gatedStageToAsk(schedule(done, next), NOW)?.label, "Next");
    assert.equal(gatedStageToAsk(schedule(done), NOW), null);
  });

  it("never asks about a public stage, open or not", () => {
    // A public stage has no eligibility question — anyone may mint it — so a
    // round trip could only ever come back "yes".
    const pub = stage({ label: "Public", isPublic: true, startMs: NOW - HOUR, endMs: NOW + HOUR });
    assert.equal(gatedStageToAsk(schedule(pub), NOW), null);
    const gated = stage({ label: "GTD", startMs: NOW + HOUR, endMs: NOW + 2 * HOUR });
    assert.equal(gatedStageToAsk(schedule(pub, gated), NOW)?.label, "GTD");
  });

  it("chooses by the clock, not by position", () => {
    // The stage listed first is the one that already closed. A reader that took
    // stages[0] would ask about a window that cannot be minted, and OpenSea
    // would answer for it — with terms that look entirely plausible.
    const first = stage({ label: "Closed", startMs: NOW - 3 * HOUR, endMs: NOW - 2 * HOUR });
    const second = stage({ label: "Open", startMs: NOW - HOUR, endMs: NOW + HOUR });
    assert.equal(gatedStageToAsk(schedule(first, second), NOW)?.label, "Open");
  });

  it("returns null for an empty schedule", () => {
    assert.equal(gatedStageToAsk(schedule(), NOW), null);
  });

  it("treats the instant a stage opens as open", () => {
    const st = stage({ label: "Edge", startMs: NOW, endMs: NOW + HOUR });
    assert.equal(gatedStageToAsk(schedule(st), NOW)?.label, "Edge");
  });

  it("treats the instant a stage ends as closed", () => {
    // Half-open by design, matching liveStage: at exactly endMs the stage is
    // over, and an off-by-one here would fire at a window that just shut.
    const st = stage({ label: "Edge", startMs: NOW - HOUR, endMs: NOW });
    assert.equal(gatedStageToAsk(schedule(st), NOW), null);
  });
});
