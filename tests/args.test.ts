// CLI argument parsing.
//
// The theme of these tests is that silence is the failure mode to avoid. A flag
// that is misspelled, given twice, or given without a value must produce an error —
// a parser that shrugs and uses the default turns `--quantiy 5` into a one-token
// mint, discovered after the drop sold out.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArgError, HELP, parseArgs } from "../src/cli/args";

describe("parseArgs — commands", () => {
  it("leaves the command null when given nothing, which prints help", () => {
    assert.equal(parseArgs([]).command, null);
  });

  it("reads a known command", () => {
    assert.equal(parseArgs(["check"]).command, "check");
    assert.equal(parseArgs(["rpc"]).command, "rpc");
    assert.equal(parseArgs(["bot"]).command, "bot");
  });

  it("treats a bare target as a mint of that target", () => {
    const args = parseArgs(["cool-cats"]);
    assert.equal(args.command, "mint");
    assert.equal(args.target, "cool-cats");
  });

  it("treats a bare address as a mint target rather than a bad command", () => {
    const address = "0x1111111111111111111111111111111111111111";
    const args = parseArgs([address]);
    assert.equal(args.command, "mint");
    assert.equal(args.target, address);
  });
});

describe("parseArgs — values", () => {
  it("reads --flag value and --flag=value identically", () => {
    assert.equal(parseArgs(["mint", "x", "--quantity", "3"]).quantity, 3);
    assert.equal(parseArgs(["mint", "x", "--quantity=3"]).quantity, 3);
  });

  it("reads the chain, fees and gas limit", () => {
    const args = parseArgs([
      "mint",
      "x",
      "--chain",
      "base",
      "--max-fee",
      "0.05",
      "--priority-fee",
      "0.001",
      "--gas-limit",
      "300000",
    ]);
    assert.equal(args.chain, "base");
    assert.equal(args.maxFeeGwei, 0.05);
    assert.equal(args.priorityGwei, 0.001);
    assert.equal(args.gasLimit, 300_000n);
  });

  it("reads boolean flags", () => {
    const args = parseArgs(["mint", "x", "--yes", "--watch", "--json"]);
    assert.equal(args.yes, true);
    assert.equal(args.watch, true);
    assert.equal(args.json, true);
  });

  it("supports -h and -v shorthands", () => {
    assert.equal(parseArgs(["-h"]).help, true);
    assert.equal(parseArgs(["-v"]).version, true);
  });
});

describe("parseArgs — --wallets", () => {
  // Kept as text, not resolved here: turning "0,2" into wallets needs the loaded
  // keyring, and this parser deliberately never sees a key.

  it("is absent unless given, which means every loaded wallet", () => {
    assert.equal(parseArgs(["mint", "x"]).wallets, undefined);
  });

  it("reads the spec verbatim, long and short, spaced and inline", () => {
    assert.equal(parseArgs(["mint", "x", "--wallets", "0,2"]).wallets, "0,2");
    assert.equal(parseArgs(["mint", "x", "--wallets=1-3"]).wallets, "1-3");
    assert.equal(parseArgs(["mint", "x", "-w", "all"]).wallets, "all");
  });

  it("takes its value rather than reading it as the target", () => {
    // The reason --wallets is in VALUE_FLAGS: without that, `--wallets 0,2`
    // leaves "0,2" to be collected as a positional and minted as a slug.
    const args = parseArgs(["mint", "tadaaaaaa", "--wallets", "0,2"]);
    assert.equal(args.target, "tadaaaaaa");
    assert.equal(args.wallets, "0,2");
  });

  it("refuses the flag without a value rather than selecting everything", () => {
    assert.throws(() => parseArgs(["mint", "x", "--wallets"]), ArgError);
  });

  it("is documented in the help text, with the counting convention stated", () => {
    // An operator who never learns the flag exists fires every wallet at every
    // drop. One who assumes it counts from one fires the wrong key, so the help
    // has to say which it is.
    assert.match(HELP, /--wallets/);
    assert.match(HELP, /zero/i);
  });
});

describe("parseArgs — refusals", () => {
  it("rejects an unknown flag instead of ignoring it", () => {
    // The whole point. `--quantiy 5` silently minting 1 is exactly the failure
    // that costs a mint.
    assert.throws(() => parseArgs(["mint", "x", "--quantiy", "5"]), ArgError);
  });

  it("rejects a value flag with no value", () => {
    assert.throws(() => parseArgs(["mint", "x", "--quantity"]), ArgError);
  });

  it("rejects a non-numeric quantity", () => {
    assert.throws(() => parseArgs(["mint", "x", "--quantity", "lots"]), ArgError);
  });

  it("rejects a fractional or zero quantity", () => {
    assert.throws(() => parseArgs(["mint", "x", "--quantity", "1.5"]), ArgError);
    assert.throws(() => parseArgs(["mint", "x", "--quantity", "0"]), ArgError);
  });

  it("rejects a negative fee", () => {
    // Written with `=` so the value actually reaches the numeric check: a bare
    // `--max-fee -1` is refused earlier, as a flag missing its value.
    assert.throws(() => parseArgs(["mint", "x", "--max-fee=-1"]), ArgError);
    assert.throws(() => parseArgs(["mint", "x", "--max-fee=0"]), ArgError);
  });

  it("rejects a gas limit below the cost of an empty transaction", () => {
    assert.throws(() => parseArgs(["mint", "x", "--gas-limit", "1000"]), ArgError);
  });

  it("rejects a value attached to a boolean flag", () => {
    assert.throws(() => parseArgs(["mint", "x", "--json=true"]), ArgError);
  });

  it("rejects --now together with --at", () => {
    // These specify different instants. Picking one silently means firing at a
    // time the user did not ask for.
    assert.throws(() => parseArgs(["mint", "x", "--now", "--at", "12:00"]), ArgError);
  });

  it("rejects --skip-simulation together with --require-simulation", () => {
    assert.throws(
      () => parseArgs(["mint", "x", "--skip-simulation", "--require-simulation"]),
      ArgError,
    );
  });
});
