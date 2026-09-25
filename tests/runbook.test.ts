import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KNOWN_COMMANDS } from "../src/cli/args";
import { RUNBOOK_EXEMPT, renderRunbook } from "../src/docs/runbook";
import { renderCapabilityDoc } from "../src/docs/capability";

const runbook = renderRunbook();

describe("the runbook", () => {
  it("documents every command the CLI answers to", () => {
    // The point of the test: a verb can be added to KNOWN_COMMANDS and shipped
    // without anyone remembering the docs. This turns that into a test failure.
    const missing = [...KNOWN_COMMANDS].filter(
      (cmd) => !RUNBOOK_EXEMPT.has(cmd) && !runbook.includes(`intern ${cmd}`) && !runbook.includes(`index.js ${cmd}`),
    );
    assert.deepEqual(missing, [], `runbook never mentions: ${missing.join(", ")}`);
  });

  it("exempts nothing that does not exist", () => {
    // An exemption for a deleted command would silently start excusing a real gap
    // if that name were ever reused.
    for (const cmd of RUNBOOK_EXEMPT) {
      assert.ok(KNOWN_COMMANDS.has(cmd), `${cmd} is exempted but is not a command`);
    }
  });

  it("walks deploy, dry run and go live in that order", () => {
    const deploy = runbook.indexOf("### 1. Deploy");
    const rehearse = runbook.indexOf("### 4. Rehearse");
    const live = runbook.indexOf("### 5. Go live");
    assert.ok(deploy >= 0 && rehearse >= 0 && live >= 0, "a stage heading is missing");
    // Rehearsing after going live is not a runbook, it is a post-mortem.
    assert.ok(deploy < rehearse, "deploy must come before the rehearsal");
    assert.ok(rehearse < live, "the rehearsal must come before going live");
  });

  it("states that the dry run spends nothing", () => {
    assert.match(runbook, /Spends nothing|spends nothing/);
  });

  it("states the exit code that makes chaining safe", () => {
    // Without this an operator writes `dryrun; mint` with a semicolon and the
    // mint fires regardless of what the rehearsal found.
    assert.match(runbook, /exits? `?1`?/i);
    assert.match(runbook, /dryrun .*&&.*mint/s);
  });

  it("does not let a pre-open revert read as an eligibility verdict", () => {
    // The caveat that costs the most when it is missing: every wallet reverts
    // with NotActive before a stage opens, eligible or not.
    assert.match(runbook, /NotActive/);
    // Whitespace-tolerant: the prose is hard-wrapped, and a line break falling
    // inside the phrase is not a missing caveat.
    const flat = runbook.replace(/\s+/g, " ");
    assert.match(flat, /not on the list.*not open yet/);
  });

  it("says gated stages are off by default and how to turn them on", () => {
    assert.match(runbook, /ALLOWLIST_MINTING=1/);
    assert.match(runbook, /off by default/i);
  });

  it("promises a report on restart, never a re-fire at the same nonce", () => {
    assert.match(runbook, /reports; it does not resume/);
    assert.match(runbook, /same nonce/);
  });

  it("tells the operator to lock down the file holding the keys", () => {
    assert.match(runbook, /chmod 600 \.env/);
  });

  it("ships no key-shaped string", () => {
    // Same rule as every other generated artefact: a 64-hex run in a document
    // that gets pasted into issues is a leak regardless of where it came from.
    assert.doesNotMatch(runbook, /0x[0-9a-fA-F]{64}/);
    assert.doesNotMatch(runbook, /\b[0-9a-fA-F]{64}\b/);
  });

  it("is deterministic", () => {
    assert.equal(renderRunbook(), runbook);
  });

  it("is carried into CAPABILITY.md verbatim", () => {
    // The generated document is the artefact the operator reads; a runbook that
    // renders correctly but is never included has no effect.
    assert.ok(renderCapabilityDoc().includes(runbook));
  });

  it("comes after the reader has been told what will not fire", () => {
    const doc = renderCapabilityDoc();
    assert.ok(doc.indexOf("## What will not fire") < doc.indexOf("## The runbook"));
  });
});
