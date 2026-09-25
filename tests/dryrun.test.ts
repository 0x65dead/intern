// What a dry run is allowed to claim.
//
// The danger with a feature like this is not that it breaks — it is that it
// reassures. A dry run that silently skipped a check, or that reported "would
// fire" when a live run would have refused, is worse than no dry run at all,
// because the operator would have looked harder without it.
//
// So these tests are mostly about the negative space: what the report must
// refuse to say.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DRY_RUN_CAVEAT,
  DryRunReport,
  dryRunLines,
  dryRunTotals,
  dryRunVerdict,
} from "../src/core/dryrun";

const NOW = 1773576000000;
const HOUR = 3_600_000;

const GWEI = 1_000_000_000n;
const KEY = `0x${"ab".repeat(32)}`;

const report = (over: Partial<DryRunReport> = {}): DryRunReport => ({
  target: "cool-drop",
  chainName: "Base",
  chainId: 8453,
  nativeSymbol: "ETH",
  to: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
  calldataBytes: 164,
  valuePerWallet: 10_000_000_000_000_000n, // 0.01
  gas: { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI / 10n, gasLimit: 250_000n },
  fireAtMs: NOW + HOUR,
  nowMs: NOW,
  drift: { ok: true, detail: "clock synced, uncertainty ±40ms" },
  wallets: [
    {
      index: 0,
      address: "0x1111111111111111111111111111111111111111",
      nonce: 7,
      txHash: `0x${"11".repeat(32)}`,
      rawBytes: 220,
      simulation: "passed",
    },
    {
      index: 1,
      address: "0x2222222222222222222222222222222222222222",
      nonce: 0,
      txHash: `0x${"22".repeat(32)}`,
      rawBytes: 220,
      simulation: "passed",
    },
  ],
  endpoints: ["alchemy", "public"],
  skipped: [],
  refusals: [],
  ...over,
});

const lines = (over: Partial<DryRunReport> = {}): string =>
  dryRunLines(report(over), () => "2026-03-15 13:00").join("\n");

describe("dryRunTotals", () => {
  it("multiplies the per-wallet cost by the wallets that would actually send", () => {
    const totals = dryRunTotals(report());
    assert.equal(totals.walletCount, 2);
    assert.equal(totals.totalValue, 20_000_000_000_000_000n);
  });

  it("prices the worst case at the full fee ceiling, not at the expected fee", () => {
    // The ceiling is a maximum, not a payment — but it is the maximum a wallet
    // must be able to cover, so it is the number worth showing before funding.
    const totals = dryRunTotals(report());
    assert.equal(totals.worstCaseGasPerWallet, 250_000n * 2n * GWEI);
    assert.equal(totals.worstCaseTotal, (10_000_000_000_000_000n + 250_000n * 2n * GWEI) * 2n);
  });

  it("totals nothing when nothing would be sent", () => {
    const totals = dryRunTotals(report({ wallets: [] }));
    assert.equal(totals.totalValue, 0n);
    assert.equal(totals.worstCaseTotal, 0n);
  });
});

describe("dryRunVerdict", () => {
  it("says a live run would fire when nothing objected", () => {
    const verdict = dryRunVerdict(report());
    assert.equal(verdict.wouldFire, true);
    assert.match(verdict.detail, /broadcast 2 transaction/);
  });

  it("never says 'would fire' when anything refused", () => {
    // The single most important assertion in this file.
    const verdict = dryRunVerdict(report({ refusals: ["clock uncertainty ±9000ms"] }));
    assert.equal(verdict.wouldFire, false);
    assert.match(verdict.detail, /would refuse/);
    assert.match(verdict.detail, /±9000ms/);
  });

  it("counts the other refusals rather than hiding them behind the first", () => {
    const verdict = dryRunVerdict(report({ refusals: ["a", "b", "c"] }));
    assert.equal(verdict.wouldFire, false);
    assert.match(verdict.detail, /2 other reasons/);
  });

  it("gets the plural right for a single extra refusal", () => {
    assert.match(dryRunVerdict(report({ refusals: ["a", "b"] })).detail, /1 other reason\b/);
  });

  it("does not claim a fire with no wallets left", () => {
    const verdict = dryRunVerdict(report({ wallets: [] }));
    assert.equal(verdict.wouldFire, false);
    assert.match(verdict.detail, /No wallet survived preflight/);
  });

  it("flags reverting simulations without turning them into a refusal", () => {
    // Before a stage opens every simulation reverts with NotActive, eligible or
    // not. Treating that as a refusal would make the dry run useless for the
    // thing people use it for: checking a mint the day before.
    const verdict = dryRunVerdict(
      report({
        wallets: [
          {
            index: 0,
            address: "0x1111111111111111111111111111111111111111",
            nonce: 7,
            txHash: `0x${"11".repeat(32)}`,
            rawBytes: 220,
            simulation: "reverted",
            simulationError: "NotActive",
          },
        ],
      }),
    );
    assert.equal(verdict.wouldFire, true);
    assert.match(verdict.detail, /1 of them currently simulate as reverting/);
    assert.match(verdict.detail, /expected before the stage opens/);
  });
});

describe("dryRunLines", () => {
  it("leads with the fact that nothing will be sent", () => {
    assert.match(dryRunLines(report(), () => "t")[0] ?? "", /^DRY RUN — nothing will be broadcast\.$/);
  });

  it("always ends with the caveat, verbatim", () => {
    const out = dryRunLines(report(), () => "t");
    assert.equal(out[out.length - 1], DRY_RUN_CAVEAT);
  });

  it("says in the caveat that a pre-open revert proves nothing about eligibility", () => {
    // The claim people over-read from a clean dry run.
    assert.match(DRY_RUN_CAVEAT, /NotActive whether or not the wallet is eligible/);
    assert.match(DRY_RUN_CAVEAT, /Nothing was broadcast and no gas was spent\./);
  });

  it("names every wallet that would send, with its nonce and resulting hash", () => {
    const out = lines();
    assert.match(out, /\[W0\] 0x1111111111111111111111111111111111111111/);
    assert.match(out, /nonce 7 · 220 bytes signed · simulation passed/);
    assert.match(out, new RegExp(`would be 0x${"11".repeat(32)}`));
    assert.match(out, /\[W1\]/);
  });

  it("names every wallet that was skipped, and why", () => {
    // Constraint: a row we cannot fire is never silently dropped.
    const out = lines({
      skipped: [{ address: "0x3333333333333333333333333333333333333333", reason: "underfunded — needs 0.02 ETH" }],
    });
    assert.match(out, /skipped 1 wallet/);
    assert.match(out, /0x3333333333333333333333333333333333333333 — underfunded/);
  });

  it("lists refusals individually, not just as a count", () => {
    const out = lines({ refusals: ["clock uncertainty ±9000ms", "2 simulations reverted"] });
    assert.match(out, /a live run would refuse to broadcast:/);
    assert.match(out, /· clock uncertainty ±9000ms/);
    assert.match(out, /· 2 simulations reverted/);
  });

  it("shows the countdown to T-0 rather than only the timestamp", () => {
    assert.match(lines(), /fires: +2026-03-15 13:00 \(in 1h 0m\)/);
  });

  it("says when T-0 has already passed instead of printing a negative", () => {
    assert.match(lines({ fireAtMs: NOW - HOUR }), /\(1h 0m ago\)/);
  });

  it("says 'immediately' when there is no stage start to wait for", () => {
    assert.match(lines({ fireAtMs: null }), /fires: +immediately/);
  });

  it("carries the clock verdict through, good or bad", () => {
    assert.match(lines(), /clock: +clock synced, uncertainty ±40ms/);
    assert.match(
      lines({ drift: { ok: false, detail: "uncertainty ±9000ms exceeds the limit" } }),
      /clock: +uncertainty ±9000ms exceeds the limit/,
    );
  });

  it("prints a sub-microether price as a bound, never as zero", () => {
    // "0 ETH" reads as free, and a free mint is a thing people act on.
    assert.match(lines({ valuePerWallet: 1n }), /<0\.000001 ETH/);
    assert.match(lines({ valuePerWallet: 1n }), /max cost: +0\.001 ETH/);
  });

  it("carries no key material", () => {
    // DryRunWallet has no key field by construction; this pins it against a
    // future edit that adds one for convenience.
    const out = JSON.stringify(report(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + lines();
    assert.doesNotMatch(out, /ab{2,}/i, "a private key reached the dry-run report");
    assert.doesNotMatch(out, /"key"/);
    assert.doesNotMatch(out, /private/i);
    assert.ok(!out.includes(KEY));
  });

  it("renders without ANSI or HTML, so both renderers can style it themselves", () => {
    const out = lines();
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(out, /\u001b\[/);
    assert.doesNotMatch(out, /<[a-z/]/i);
  });
});
