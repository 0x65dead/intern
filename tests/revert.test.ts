// Revert diagnosis.
//
// `describeRevert` is the difference between "REVERTED" and "REVERTED: stage not
// active" — the only question the operator has at that moment. It shipped with
// three patterns written as `/execution reverted:?\\s*([^"\\n]{3,200})/i`, where
// the doubled backslash is a *literal* backslash followed by `s`, so none of them
// could match a real revert string. Every realistic message fell through to
// "Reverted (no reason given)."
//
// These samples are the shapes ethers and raw JSON-RPC actually produce. They are
// here so the escaping cannot silently regress: a broken pattern does not throw,
// it just quietly stops diagnosing anything.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRevert } from "../src/core/engine";

const NO_REASON = "Reverted (no reason given).";

/** Build a real ABI-encoded Error(string) payload, the way a node returns one. */
function errorString(reason: string, declaredLength?: number): string {
  const body = Buffer.from(reason, "utf8").toString("hex");
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64 || 64, "0");
  const offset = (32).toString(16).padStart(64, "0");
  const length = (declaredLength ?? Buffer.byteLength(reason, "utf8"))
    .toString(16)
    .padStart(64, "0");
  return `0x08c379a0${offset}${length}${padded}`;
}

describe("describeRevert — standard reason strings", () => {
  it("reads the reason out of an ethers CALL_EXCEPTION message", () => {
    assert.equal(
      describeRevert(
        'execution reverted: MintQuantityExceedsMaxSupply (action="estimateGas", data=null)',
      ),
      "Reverted: MintQuantityExceedsMaxSupply (action=",
    );
  });

  it("reads a bare JSON-RPC execution reverted message", () => {
    assert.equal(describeRevert("execution reverted: NotActive"), "Reverted: NotActive");
  });

  it("reads a reason= form", () => {
    assert.equal(
      describeRevert('Error: cannot estimate gas; reason="Stage not active"'),
      "Reverted: Stage not active",
    );
  });

  it("reads a reverted-without-execution form", () => {
    assert.equal(
      describeRevert("Transaction reverted: TokenGatedNotTokenOwner"),
      "Reverted: TokenGatedNotTokenOwner",
    );
  });

  it("stops at a newline rather than swallowing a stack trace", () => {
    const text = "execution reverted: NotActive\n    at makeError (ethers/lib/utils.js:1)";
    assert.equal(describeRevert(text), "Reverted: NotActive");
  });

  it("does not match when there is no reason at all", () => {
    assert.equal(describeRevert("execution reverted"), NO_REASON);
    assert.equal(describeRevert(""), NO_REASON);
  });
});

describe("describeRevert — ABI-encoded Error(string)", () => {
  it("decodes a payload with no surrounding prose", () => {
    assert.equal(describeRevert(errorString("NotActive")), "Reverted: NotActive");
  });

  it("decodes a payload embedded in an error blob", () => {
    const text = `could not coalesce error (data="${errorString("MintNotOpen")}")`;
    assert.equal(describeRevert(text), "Reverted: MintNotOpen");
  });

  it("strips NUL padding from the decoded string", () => {
    // The strip was written /\\0+$/g — a literal backslash and a zero, which
    // matches nothing. A reason whose declared length covers its padding came
    // back with the NULs still attached and compared unequal to everything.
    const payload = errorString("NotActive\u0000\u0000\u0000", 12);
    assert.equal(describeRevert(payload), "Reverted: NotActive");
  });

  it("reports no reason for a truncated payload rather than inventing one", () => {
    // 12 hex characters is not a selector plus whole words, so it is not a
    // diagnosable payload. Saying nothing is correct; guessing is not.
    assert.equal(describeRevert("0x08c379a0dead"), NO_REASON);
  });
});

describe("describeRevert — panics and known custom errors", () => {
  it("names a Solidity panic", () => {
    const text = `0x4e487b71${(0x11).toString(16).padStart(64, "0")}`;
    assert.match(describeRevert(text), /panic 0x11 — arithmetic overflow\/underflow/);
  });

  it("decodes the SeaDrop per-wallet cap error with both numbers", () => {
    const total = (5).toString(16).padStart(64, "0");
    const allowed = (3).toString(16).padStart(64, "0");
    assert.equal(
      describeRevert(`0xedc01273${total}${allowed}`),
      "Reverted: wallet mint cap exceeded — total would be 5, allowed 3",
    );
  });
});

describe("describeRevert — the custom-error catch-all", () => {
  // The catch-all used to be /0x[0-9a-fA-F]{8,}/, which matches an address and a
  // transaction hash. Error messages are full of both, so an unrelated failure
  // got diagnosed as "custom error (0x1234abcd…)" — a fabricated answer to the
  // one question that matters, and one that reads as authoritative.

  it("reports a selector-shaped payload", () => {
    assert.equal(describeRevert("0xd05cb609"), "Reverted: custom error (0xd05cb609…)");
  });

  it("reports a selector plus whole ABI words", () => {
    const withArg = `0xd05cb609${"0".repeat(64)}`;
    assert.equal(describeRevert(withArg), "Reverted: custom error (0xd05cb609…)");
  });

  it("does not mistake a contract address for a custom error", () => {
    const address = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
    assert.equal(describeRevert(`no code at ${address}`), NO_REASON);
  });

  it("does not mistake a transaction hash for a custom error", () => {
    const txHash = `0x${"ab".repeat(32)}`;
    assert.equal(describeRevert(`transaction ${txHash} failed`), NO_REASON);
  });

  it("skips an address and still finds the real payload after it", () => {
    const address = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
    assert.equal(
      describeRevert(`call to ${address} failed: 0xd05cb609`),
      "Reverted: custom error (0xd05cb609…)",
    );
  });

  it("is not confused by a bare 0x", () => {
    assert.equal(describeRevert("returned 0x"), NO_REASON);
  });
});

describe("describeRevert — input hygiene", () => {
  it("survives non-string input without throwing", () => {
    assert.equal(describeRevert(undefined as unknown as string), NO_REASON);
    assert.equal(describeRevert(null as unknown as string), NO_REASON);
  });
});
