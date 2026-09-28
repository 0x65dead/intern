// Failure classification.
//
// The tests that matter most here are the ones asserting what a status does NOT
// mean. Two confusions are expensive enough to be worth pinning permanently:
//
//   A 403 on the eligibility endpoint is not "this wallet is ineligible". It is
//   "our token lacks a scope". Reading it as ineligibility turns a one-line
//   configuration fix into a wallet that silently never tries to mint, and the
//   bot would report it as working correctly.
//
//   A 401 does not always accuse the same credential. From the exchange it is a
//   verdict on the durable scoped token; from a wallet-scoped endpoint it is
//   almost always a JWT that aged out, which fixes itself. Naming the wrong one
//   sends the operator to rotate a credential that was never the problem.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FAILURE_META,
  FailureCode,
  OpenSeaEndpoint,
  classifyChainFailure,
  classifyOpenSeaFailure,
  classifyRevert,
  isRefreshable,
  localFailure,
  shouldKeepWaiting,
} from "../src/core/failures";

const err = (status: number, retryAfterMs: number | null = null) => ({
  status,
  message: `HTTP ${status}`,
  retryAfterMs,
});

/** ABI-encoded revert data: a 4-byte selector followed by whole 32-byte words. */
const revertData = (selector: string, words = 1): string =>
  `${selector}${"0".repeat(64 * words)}`;

describe("FAILURE_META", () => {
  it("describes every code in the union", () => {
    // Record<FailureCode, …> makes this a compile-time guarantee; the runtime
    // assertion catches a placeholder entry added to silence the compiler.
    for (const [code, meta] of Object.entries(FAILURE_META)) {
      assert.ok(meta.title.length > 0, `${code} has no title`);
      assert.equal(typeof meta.retryable, "boolean");
      assert.equal(typeof meta.terminal, "boolean");
    }
  });

  it("ships the codes the specification fixes", () => {
    const required: FailureCode[] = [
      "AUTH_EXPIRED",
      "AUTH_INVALID",
      "API_KEY_INVALID",
      "ELIGIBILITY_FALSE",
      "DROP_NOT_ACTIVE",
      "STAGE_NOT_ACTIVE",
      "WALLET_NOT_ELIGIBLE",
      "MINT_LIMIT_REACHED",
      "INSUFFICIENT_BALANCE",
      "INSUFFICIENT_GAS",
      "SIMULATION_REVERT",
      "GAS_TOO_HIGH",
      "NONCE_CONFLICT",
      "RPC_TIMEOUT",
      "RPC_RATE_LIMIT",
      "BROADCAST_FAILED",
      "RECEIPT_TIMEOUT",
      "TX_REVERTED",
      "SUPPLY_EXHAUSTED",
      "UNKNOWN",
    ];
    for (const code of required) assert.ok(FAILURE_META[code], `${code} is missing`);
  });

  it("never marks a code both terminal and retryable", () => {
    for (const [code, meta] of Object.entries(FAILURE_META)) {
      assert.ok(!(meta.terminal && meta.retryable), `${code} cannot be both`);
    }
  });
});

describe("classifyOpenSeaFailure — credentials", () => {
  it("blames the scoped token for a refused exchange", () => {
    for (const status of [400, 401, 403]) {
      const failure = classifyOpenSeaFailure(err(status), { endpoint: "exchange" });
      assert.equal(failure.code, "AUTH_INVALID", `HTTP ${status} on the exchange`);
      assert.equal(failure.terminal, true);
      assert.match(failure.message, /OPENSEA_SCOPED_TOKEN/);
    }
  });

  it("treats a 401 on eligibility as an expired token, so a refresh is attempted", () => {
    const failure = classifyOpenSeaFailure(err(401), { endpoint: "eligibility" });
    assert.equal(failure.code, "AUTH_EXPIRED");
    assert.equal(failure.retryable, true);
    assert.equal(failure.terminal, false);
    assert.ok(isRefreshable(failure));
  });

  it("blames the API key for a 401 on an application-scoped endpoint", () => {
    for (const endpoint of ["drop", "collection", "mint"] as OpenSeaEndpoint[]) {
      const failure = classifyOpenSeaFailure(err(401), { endpoint });
      assert.equal(failure.code, "API_KEY_INVALID", endpoint);
      assert.match(failure.message, /OPENSEA_API_KEY/);
    }
  });

  it("reads a 403 as a missing scope, never as wallet ineligibility", () => {
    const failure = classifyOpenSeaFailure(err(403), { endpoint: "eligibility" });
    // The whole point: a scope problem must not masquerade as a verdict on the
    // wallet, or a typo becomes a wallet that never mints and never complains.
    assert.equal(failure.code, "AUTH_INVALID");
    assert.notEqual(failure.code, "ELIGIBILITY_FALSE");
    assert.notEqual(failure.code, "WALLET_NOT_ELIGIBLE");
    assert.match(failure.message, /scope/);
  });

  it("does not escalate a 401 to a permanent failure on the first sight", () => {
    assert.equal(classifyOpenSeaFailure(err(401), { endpoint: "eligibility" }).terminal, false);
  });
});

describe("classifyOpenSeaFailure — schedule", () => {
  it("treats a closed drop as non-terminal, because waiting fixes it", () => {
    const failure = classifyOpenSeaFailure(err(409), { endpoint: "mint" });
    assert.equal(failure.code, "DROP_NOT_ACTIVE");
    assert.equal(failure.terminal, false);
    assert.equal(failure.retryable, false, "retrying immediately cannot open a closed stage");
    assert.ok(shouldKeepWaiting(failure));
  });

  it("reports a missing drop rather than inventing an eligibility verdict", () => {
    assert.equal(
      classifyOpenSeaFailure(err(404), { endpoint: "drop" }).code,
      "DROP_NOT_ACTIVE",
    );
  });
});

describe("classifyOpenSeaFailure — the ambiguous 422", () => {
  it("names all four possible causes rather than picking one", () => {
    const failure = classifyOpenSeaFailure(err(422), { endpoint: "mint" });
    assert.equal(failure.code, "UNKNOWN");
    assert.deepEqual(
      [...failure.alternatives].sort(),
      [
        "INSUFFICIENT_BALANCE",
        "MINT_LIMIT_REACHED",
        "SUPPLY_EXHAUSTED",
        "WALLET_NOT_ELIGIBLE",
      ].sort(),
    );
  });

  it("resolves to ineligibility when eligibility independently agrees", () => {
    const failure = classifyOpenSeaFailure(err(422), {
      endpoint: "mint",
      eligibility: { isEligible: false, maxMintable: 1 },
    });
    assert.equal(failure.code, "WALLET_NOT_ELIGIBLE");
    assert.equal(failure.terminal, true);
    assert.deepEqual(failure.alternatives, []);
  });

  it("resolves to a spent allowance when the counts say so", () => {
    const failure = classifyOpenSeaFailure(err(422), {
      endpoint: "mint",
      eligibility: { isEligible: true, maxMintable: 2, mintedSoFar: 2 },
    });
    assert.equal(failure.code, "MINT_LIMIT_REACHED");
    assert.match(failure.message, /2 of 2/);
  });

  it("narrows to two causes when the wallet is eligible with allowance left", () => {
    const failure = classifyOpenSeaFailure(err(422), {
      endpoint: "mint",
      eligibility: { isEligible: true, maxMintable: 5, mintedSoFar: 1 },
    });
    assert.equal(failure.code, "UNKNOWN");
    assert.deepEqual([...failure.alternatives].sort(), [
      "INSUFFICIENT_BALANCE",
      "SUPPLY_EXHAUSTED",
    ]);
  });

  it("does not claim a limit was reached when the count is unknown", () => {
    const failure = classifyOpenSeaFailure(err(422), {
      endpoint: "mint",
      eligibility: { isEligible: true, maxMintable: 5 },
    });
    assert.notEqual(failure.code, "MINT_LIMIT_REACHED");
  });
});

describe("classifyOpenSeaFailure — transport", () => {
  it("distinguishes an OpenSea rate limit from a node's by source", () => {
    const failure = classifyOpenSeaFailure(err(429, 2_000), { endpoint: "mint" });
    assert.equal(failure.code, "RPC_RATE_LIMIT");
    assert.equal(failure.source, "opensea");
    assert.equal(failure.retryAfterMs, 2_000);
    assert.equal(failure.retryable, true);
  });

  it("treats an unreachable API as a timeout, not a credential problem", () => {
    const failure = classifyOpenSeaFailure(err(0), { endpoint: "eligibility" });
    assert.equal(failure.code, "RPC_TIMEOUT");
    assert.equal(failure.retryable, true);
  });

  it("marks a server error retryable", () => {
    for (const status of [500, 502, 503]) {
      assert.equal(classifyOpenSeaFailure(err(status), { endpoint: "drop" }).retryable, true);
    }
  });

  it("falls back to UNKNOWN for a status it has no opinion about", () => {
    assert.equal(classifyOpenSeaFailure(err(418), { endpoint: "drop" }).code, "UNKNOWN");
  });
});

describe("classifyRevert", () => {
  it("recognises SeaDrop's NotActive as a closed stage", () => {
    const failure = classifyRevert(`reverted ${revertData("0x13da22f2", 3)}`);
    assert.equal(failure.code, "STAGE_NOT_ACTIVE");
    assert.equal(failure.terminal, false);
  });

  it("recognises the per-wallet cap error", () => {
    // 0xedc01273 is MintQuantityExceedsMaxMintedPerWallet — the one selector
    // this codebase already knew independently, so it also checks the
    // signature-derivation approach the rest of the table relies on.
    const failure = classifyRevert(`execution reverted ${revertData("0xedc01273", 2)}`);
    assert.equal(failure.code, "MINT_LIMIT_REACHED");
    assert.equal(failure.terminal, true);
  });

  it("recognises both supply-exhaustion errors", () => {
    for (const selector of ["0xe12d2314", "0xb98dabea"]) {
      assert.equal(classifyRevert(revertData(selector, 2)).code, "SUPPLY_EXHAUSTED");
    }
  });

  it("recognises a rejected proof as ineligibility", () => {
    assert.equal(classifyRevert(revertData("0x09bde339", 0)).code, "WALLET_NOT_ELIGIBLE");
  });

  it("reads a textual reason when the node returns prose", () => {
    assert.equal(classifyRevert("execution reverted: NotActive").code, "STAGE_NOT_ACTIVE");
    assert.equal(classifyRevert("execution reverted: sold out").code, "SUPPLY_EXHAUSTED");
    assert.equal(
      classifyRevert("execution reverted: already minted max per wallet").code,
      "MINT_LIMIT_REACHED",
    );
    assert.equal(
      classifyRevert("execution reverted: invalid proof").code,
      "WALLET_NOT_ELIGIBLE",
    );
  });

  it("does not mistake an address or a tx hash for a selector", () => {
    // Both are hex runs of the wrong length to be ABI-encoded revert data, and
    // error messages are full of them. Reading one as a selector would fabricate
    // a diagnosis for a revert that had a real reason elsewhere.
    const address = `0x${"ab".repeat(20)}`;
    const txHash = `0x${"cd".repeat(32)}`;
    assert.equal(classifyRevert(`call to ${address} failed`).code, "SIMULATION_REVERT");
    assert.equal(classifyRevert(`tx ${txHash} failed`).code, "SIMULATION_REVERT");
  });

  it("uses the caller's fallback, because the phase decides what a revert costs", () => {
    assert.equal(classifyRevert("opaque", "SIMULATION_REVERT").code, "SIMULATION_REVERT");
    // Same blob, from a receipt: money was already spent.
    assert.equal(classifyRevert("opaque", "TX_REVERTED").code, "TX_REVERTED");
  });
});

describe("classifyChainFailure", () => {
  it("maps ethers' own codes before looking at prose", () => {
    assert.equal(
      classifyChainFailure({ code: "INSUFFICIENT_FUNDS" }, "broadcast").code,
      "INSUFFICIENT_BALANCE",
    );
    assert.equal(classifyChainFailure({ code: "NONCE_EXPIRED" }, "broadcast").code, "NONCE_CONFLICT");
    assert.equal(
      classifyChainFailure({ code: "REPLACEMENT_UNDERPRICED" }, "broadcast").code,
      "NONCE_CONFLICT",
    );
    assert.equal(classifyChainFailure({ code: "TIMEOUT" }, "simulate").code, "RPC_TIMEOUT");
  });

  it("treats a refused gas estimate as the revert it really is", () => {
    // The node declines to estimate because the call reverts. Calling this a gas
    // problem sends the operator to raise a limit that was never too low.
    const failure = classifyChainFailure(
      { code: "UNPREDICTABLE_GAS_LIMIT", message: "execution reverted: NotActive" },
      "gas",
    );
    assert.equal(failure.code, "STAGE_NOT_ACTIVE");
  });

  it("reads a revert reason out of the provider's nested info", () => {
    const failure = classifyChainFailure(
      { code: "CALL_EXCEPTION", info: { error: { message: "execution reverted: sold out" } } },
      "simulate",
    );
    assert.equal(failure.code, "SUPPLY_EXHAUSTED");
  });

  it("recognises a nonce collision from the node's wording", () => {
    for (const message of ["nonce too low", "already known", "replacement transaction underpriced"]) {
      assert.equal(classifyChainFailure({ message }, "broadcast").code, "NONCE_CONFLICT");
    }
  });

  it("separates a too-low gas limit from a too-high gas price", () => {
    assert.equal(
      classifyChainFailure({ message: "intrinsic gas too low" }, "broadcast").code,
      "INSUFFICIENT_GAS",
    );
    const ceiling = classifyChainFailure(
      { message: "max fee per gas less than block base fee" },
      "broadcast",
    );
    assert.equal(ceiling.code, "GAS_TOO_HIGH");
    assert.equal(ceiling.retryable, true, "the base fee falls as often as it rises");
  });

  it("recognises a rate limit however the provider words it", () => {
    for (const message of ["429 Too Many Requests", "rate limit exceeded", "exceeded compute units"]) {
      assert.equal(classifyChainFailure({ message }, "simulate").code, "RPC_RATE_LIMIT");
    }
  });

  it("calls a transport failure during broadcast a broadcast failure", () => {
    // The same error means different things by phase: before broadcast nothing
    // was spent, after it a transaction may already be in flight.
    assert.equal(
      classifyChainFailure({ message: "fetch failed" }, "broadcast").code,
      "BROADCAST_FAILED",
    );
    assert.equal(classifyChainFailure({ message: "fetch failed" }, "simulate").code, "RPC_TIMEOUT");
  });

  it("does not pretend to know an unrecognised failure", () => {
    const failure = classifyChainFailure({ message: "something odd happened" }, "simulate");
    assert.equal(failure.code, "UNKNOWN");
    assert.match(failure.message, /simulate/);
  });

  it("survives a non-error being thrown at it", () => {
    for (const thrown of [null, undefined, 42, "plain string", { info: { self: null } }]) {
      const failure = classifyChainFailure(thrown, "receipt");
      assert.equal(typeof failure.code, "string");
    }
  });
});

describe("retry policy", () => {
  it("never auto-retries a receipt timeout, whose transaction may still confirm", () => {
    const failure = localFailure("RECEIPT_TIMEOUT");
    assert.equal(failure.terminal, false);
    // Non-terminal but explicitly not resumable: re-signing here is how a wallet
    // mints twice and pays twice.
    assert.equal(shouldKeepWaiting(failure), false);
    assert.match(failure.message, /block explorer/);
  });

  it("stops waiting on a terminal failure", () => {
    for (const code of ["AUTH_INVALID", "ELIGIBILITY_FALSE", "SUPPLY_EXHAUSTED"] as FailureCode[]) {
      assert.equal(shouldKeepWaiting(localFailure(code)), false, code);
    }
  });

  it("keeps waiting when the door is only temporarily shut", () => {
    for (const code of ["STAGE_NOT_ACTIVE", "DROP_NOT_ACTIVE", "RPC_TIMEOUT"] as FailureCode[]) {
      assert.equal(shouldKeepWaiting(localFailure(code)), true, code);
    }
  });

  it("marks only an expired token as refreshable", () => {
    assert.ok(isRefreshable(localFailure("AUTH_EXPIRED")));
    assert.ok(!isRefreshable(localFailure("AUTH_INVALID")));
    assert.ok(!isRefreshable(localFailure("API_KEY_INVALID")));
  });
});

describe("failure messages", () => {
  it("carries the remedy where there is one to offer", () => {
    assert.match(localFailure("INSUFFICIENT_BALANCE").message, /Fund the wallet/);
    assert.match(localFailure("INSUFFICIENT_GAS").message, /GAS_LIMIT/);
    assert.match(localFailure("GAS_TOO_HIGH").message, /MAX_FEE_PER_GAS/);
  });

  it("includes the caller's detail without losing the title", () => {
    const failure = localFailure("SIMULATION_REVERT", "wallet 3");
    assert.match(failure.message, /reverted when simulated/);
    assert.match(failure.message, /wallet 3/);
  });

  it("records the source so an operator knows which system to look at", () => {
    assert.equal(classifyOpenSeaFailure(err(429), { endpoint: "mint" }).source, "opensea");
    assert.equal(classifyChainFailure({ code: "TIMEOUT" }, "simulate").source, "chain");
    assert.equal(localFailure("UNKNOWN").source, "local");
  });
});
