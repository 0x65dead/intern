// CAPABILITY.md must match the code it claims to describe.
//
// The document's whole value is that it is not prose somebody wrote once. It is
// rendered from the same matrix the scheduler selects from, and this file is the
// mechanism that keeps the committed copy honest: edit a capability and forget to
// regenerate, and the suite fails with the exact instruction to run.
//
// The content assertions below are the ones the project's own rules require: the
// speed statement rendered verbatim rather than paraphrased, every non-fireable
// mechanism present with its reason, and the non-custodial boundary documented as
// architecture rather than as a promise.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CAPABILITIES } from "../src/core/capabilities";
import { SPEED_STATEMENT } from "../src/core/race";
import { renderCapabilityDoc } from "../src/docs/capability";
import { SPEED_BLOCK, renderReadme, renderSpeedBlock, replaceBlock } from "../src/docs/readme";

// dist-tests/tests/ → repo root.
const ROOT = path.resolve(__dirname, "..", "..");
const DOC = path.join(ROOT, "CAPABILITY.md");

describe("CAPABILITY.md is in sync with the code", () => {
  it("matches the generator byte for byte", () => {
    assert.ok(fs.existsSync(DOC), "CAPABILITY.md is missing — run `npm run docs`");
    assert.equal(
      fs.readFileSync(DOC, "utf8"),
      renderCapabilityDoc(),
      "CAPABILITY.md is out of date — run `npm run docs`",
    );
  });

  it("is deterministic", () => {
    // A generator that varies between runs makes the check above a flake, and a
    // flaky honesty check gets disabled.
    assert.equal(renderCapabilityDoc(), renderCapabilityDoc());
  });
});

describe("the generated document keeps its promises", () => {
  const doc = renderCapabilityDoc();

  it("renders the speed statement verbatim", () => {
    // Verbatim, not paraphrased. A paraphrase is where an overstatement enters.
    assert.ok(doc.includes(SPEED_STATEMENT));
  });

  it("says in writing that a gated mint is slower than a public one", () => {
    assert.match(doc, /slower than a public mint/);
  });

  it("states the OpenSea pre-signing impossibility", () => {
    assert.match(doc, /cannot be pre-signed/i);
    assert.match(doc, /does not issue it before the stage opens/);
  });

  it("names every mechanism", () => {
    for (const row of CAPABILITIES) {
      assert.ok(doc.includes(row.title), `missing mechanism: ${row.title}`);
    }
  });

  it("lists every non-fireable mechanism with its reason", () => {
    // The rule this document exists to enforce: silent omission of a stage that
    // cannot be fired is a bug, so each one appears with the exact cause.
    const blocked = CAPABILITIES.filter((r) => r.fireUnattended.level !== "yes");
    assert.ok(blocked.length > 0, "fixture check: some mechanism should be unfireable");
    for (const row of blocked) {
      assert.ok(doc.includes(row.title), `missing blocked row: ${row.mechanism}`);
      const reason = row.fireUnattended.level === "yes" ? "" : row.fireUnattended.reason;
      assert.ok(doc.includes(reason), `missing reason for ${row.mechanism}`);
    }
  });

  it("carries every stated limitation's reason, on every axis", () => {
    for (const row of CAPABILITIES) {
      for (const cap of [row.detectWindow, row.precheckEligibility, row.preSign, row.fireUnattended]) {
        if (cap.level === "yes") continue;
        assert.ok(doc.includes(cap.reason), `${row.mechanism}: reason not rendered`);
      }
      assert.ok(doc.includes(row.fireSpeed.detail), `${row.mechanism}: speed detail not rendered`);
    }
  });

  it("documents the non-custodial boundary as architecture", () => {
    assert.match(doc, /Non-custodial, forever/);
    assert.match(doc, /architectural boundary/i);
    assert.match(doc, /never accept|no code path that accepts/i);
    assert.match(doc, /mint for me/i);
  });

  it("names where the non-custodial boundary is enforced", () => {
    // A boundary with no named enforcement point is a promise. These are the
    // files a reviewer checks.
    assert.match(doc, /walletsFromEnv/);
    assert.match(doc, /redactKeys/);
  });

  it("admits that whoever controls the machine controls the keys", () => {
    // The uncomfortable half. A non-custodial claim that omits this is misleading.
    assert.match(doc, /controls the keys/i);
    assert.match(doc, /plaintext on disk/i);
  });

  it("records the core-dump key exposure and its fix", () => {
    assert.match(doc, /SIGABRT/);
    assert.match(doc, /WatchdogSignal=SIGKILL/);
    assert.match(doc, /`LimitCORE=0` does \*\*not\*\*/);
    assert.match(doc, /core_pattern/);
  });

  it("records that the watchdog is gated on progress, not a timer", () => {
    assert.match(doc, /isMakingProgress/);
    assert.match(doc, /only that the event loop turns/);
  });

  it("says crash recovery reports rather than resumes", () => {
    assert.match(doc, /report, not a resume/i);
    assert.match(doc, /cleared only \*after\*/);
  });

  it("contains no key-shaped string", () => {
    // The document is generated from source comments and could in principle carry
    // an example key. It must not.
    assert.doesNotMatch(doc, /0x[0-9a-fA-F]{64}/);
  });

  it("tells the reader how to regenerate it", () => {
    assert.match(doc, /npm run docs/);
  });
});

describe("the README's generated speed block", () => {
  const README = path.join(ROOT, "README.md");

  it("is in sync with the code", () => {
    const current = fs.readFileSync(README, "utf8");
    assert.equal(renderReadme(current), current, "README.md is out of date — run `npm run docs`");
  });

  it("renders the speed statement verbatim", () => {
    // The project's rule: the README renders SPEED_STATEMENT, it does not
    // summarise it. A summary is where "as fast as a public mint" creeps in.
    assert.ok(fs.readFileSync(README, "utf8").includes(SPEED_STATEMENT));
  });

  it("points at the constant so the next editor knows where to look", () => {
    assert.match(renderSpeedBlock(), /SPEED_STATEMENT/);
    assert.match(renderSpeedBlock(), /npm run docs/);
  });

  it("is idempotent", () => {
    const once = renderReadme(fs.readFileSync(README, "utf8"));
    assert.equal(renderReadme(once), once);
  });

  it("replaces the block rather than appending a second copy", () => {
    const stale = `before\n<!-- BEGIN GENERATED: ${SPEED_BLOCK} -->\nOLD TEXT\n<!-- END GENERATED: ${SPEED_BLOCK} -->\nafter`;
    const next = replaceBlock(stale, SPEED_BLOCK, "NEW TEXT");
    assert.doesNotMatch(next, /OLD TEXT/);
    assert.match(next, /NEW TEXT/);
    assert.match(next, /^before\n/);
    assert.match(next, /\nafter$/);
    assert.equal(next.match(/BEGIN GENERATED/g)?.length, 1);
  });

  it("refuses to write when the markers are gone", () => {
    // Appending would leave two speed claims in the file, and the stale one is
    // the one a reader might act on. Stopping is the safe failure.
    assert.throws(() => replaceBlock("no markers here", SPEED_BLOCK, "x"), /missing the .* generated block markers/);
  });

  it("refuses a reversed marker pair", () => {
    const reversed = `<!-- END GENERATED: ${SPEED_BLOCK} -->\n<!-- BEGIN GENERATED: ${SPEED_BLOCK} -->`;
    assert.throws(() => replaceBlock(reversed, SPEED_BLOCK, "x"), /missing the .* generated block markers/);
  });

  it("leaves the hand-written prose around it alone", () => {
    // The generator edits one block. If it ever rewrote the whole README, the
    // operator commands and the security notes would vanish silently.
    const current = fs.readFileSync(README, "utf8");
    assert.match(current, /## Allowlist and FCFS mints/);
    assert.match(current, /redactKeys/);
  });
});
