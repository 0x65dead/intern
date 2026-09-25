// Eligibility: the difference between "no" and "don't know".
//
// The single most damaging bug this module could have is a green tick on a wallet
// that is not on the list — an operator who sees one stops looking for a spot.
// The second most damaging is a red cross on a wallet that is fine, which makes
// them give up on a mint they would have won. So the probe classifier is pinned
// status by status, and the rule that OpenSea's ambiguous codes produce `unknown`
// rather than a verdict is asserted directly rather than left to inspection.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AbiCoder, JsonRpcProvider } from "ethers";
import {
  WalletEligibility,
  checkMerkleEligibility,
  classifyProbe,
  eligibilityIcon,
  eligibilityLabel,
  summariseEligibility,
} from "../src/core/eligibility";
import { AllowListEntry, MintParams, buildTree, leafFor } from "../src/core/merkle";
import { eligibilitySummary } from "../src/core/prepare";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";

const PARAMS: MintParams = {
  mintPrice: 10_000_000_000_000_000n,
  maxTotalMintableByWallet: 3n,
  startTime: 1_773_576_000n,
  endTime: 1_773_579_600n,
  dropStageIndex: 1n,
  maxTokenSupplyForStage: 5_000n,
  feeBps: 500n,
  restrictFeeRecipients: true,
};

const LIST: AllowListEntry[] = [
  { minter: A, params: PARAMS },
  { minter: B, params: PARAMS },
];
const ROOT = buildTree(LIST.map(leafFor)).root;

/**
 * A provider that answers exactly one read: the allow-list root.
 *
 * `fetchAllowListRoot` swallows its errors by design, so a fake that silently
 * failed would make these tests pass for the wrong reason. The eligible-path
 * assertions below are what rule that out — they are only reachable if the fake
 * really did return this root.
 */
function providerReturning(root: string): JsonRpcProvider {
  const encoded = AbiCoder.defaultAbiCoder().encode(["bytes32"], [root]);
  return { call: async () => encoded } as unknown as JsonRpcProvider;
}

const ZERO_ROOT = `0x${"00".repeat(32)}`;

describe("classifyProbe", () => {
  it("treats a signature as eligibility, and says it is momentary", () => {
    const { state, detail } = classifyProbe(200);
    assert.equal(state, "eligible");
    // The tick must not read as a standing entitlement — the signature is bound
    // to one quantity and salt and expires.
    assert.match(detail, /right now/i);
  });

  it("treats 403 as the one true negative", () => {
    const { state, detail } = classifyProbe(403);
    assert.equal(state, "ineligible");
    assert.match(detail, /not eligible/i);
  });

  it("refuses to call 422 ineligible", () => {
    // 422 covers four causes, three of which are temporary. Reading it as "not on
    // the list" tells an operator to stop trying when supply was simply exhausted
    // for that instant.
    const { state, detail } = classifyProbe(422);
    assert.equal(state, "unknown");
    assert.match(detail, /would be a guess/i);
  });

  it("does not blame the wallet for our own bad key", () => {
    const { state, detail } = classifyProbe(401);
    assert.equal(state, "unknown");
    assert.match(detail, /says nothing about the wallet/i);
  });

  it("reports the pre-open 409 as unknown, not as a refusal", () => {
    const { state, detail } = classifyProbe(409);
    assert.equal(state, "unknown");
    assert.match(detail, /before a stage opens/i);
  });

  it("returns no information for a rate limit", () => {
    assert.equal(classifyProbe(429).state, "unknown");
  });

  it("falls back to unknown for a status it has never seen", () => {
    const { state, detail } = classifyProbe(503);
    assert.equal(state, "unknown");
    assert.match(detail, /503/);
  });

  it("marks exactly one status as ineligible across the whole 2xx-5xx range", () => {
    // The guard against a future edit quietly widening the negative. Only a 403
    // means "this wallet cannot mint"; everything else is eligible or unknown.
    const negatives: number[] = [];
    for (let status = 200; status <= 599; status += 1) {
      if (classifyProbe(status).state === "ineligible") negatives.push(status);
    }
    assert.deepEqual(negatives, [403]);
  });

  it("marks nothing outside 2xx as eligible", () => {
    for (let status = 300; status <= 599; status += 1) {
      assert.notEqual(classifyProbe(status).state, "eligible", `status ${status}`);
    }
  });
});

describe("checkMerkleEligibility", () => {
  const run = (root: string, addresses: string[], entries = LIST) =>
    checkMerkleEligibility({
      provider: providerReturning(root),
      nftContract: TOKEN,
      variant: "v2-token",
      entries,
      addresses,
    });

  it("proves a member and hands back the proof and params", async () => {
    const [result] = await run(ROOT, [A]);
    assert.ok(result);
    assert.equal(result.state, "eligible");
    assert.equal(result.mechanism, "merkle-allowlist");
    assert.ok(result.proof, "an eligible wallet must carry its proof");
    assert.deepEqual(result.params, PARAMS);
  });

  it("marks a non-member ineligible", async () => {
    const [result] = await run(ROOT, [C]);
    assert.ok(result);
    assert.equal(result.state, "ineligible");
    assert.match(result.detail, /not on this allow-list/i);
  });

  it("reports a root mismatch as unknown, not as the wallet's fault", async () => {
    // Our list is not the drop's list. That is an operator problem — pointing at
    // the wrong file, or a generator that hashed differently. Calling the wallet
    // ineligible would send them chasing the wrong thing entirely.
    const otherRoot = buildTree([leafFor({ minter: C, params: PARAMS })]).root;
    const [result] = await run(otherRoot, [A]);
    assert.ok(result);
    assert.equal(result.state, "unknown");
    assert.match(result.detail, /does not hash to the root/i);
  });

  it("says the collection has no allow-list when the root is zero", async () => {
    const [result] = await run(ZERO_ROOT, [A]);
    assert.ok(result);
    assert.equal(result.state, "ineligible");
    assert.match(result.detail, /no allow-list Merkle root configured/i);
  });

  it("answers for every wallet it was given", async () => {
    const results = await run(ROOT, [A, B, C]);
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((r) => r.state), ["eligible", "eligible", "ineligible"]);
  });

  it("uses a root it was handed instead of reading one", async () => {
    // prepareRun already holds the root. Re-reading it would be a second round
    // trip during pre-arm, which is exactly when a round trip is most expensive.
    // The provider here would answer with a DIFFERENT root, so a passing proof
    // proves the supplied one was the one used.
    const wrongRoot = buildTree([leafFor({ minter: C, params: PARAMS })]).root;
    const [result] = await checkMerkleEligibility({
      provider: providerReturning(wrongRoot),
      nftContract: TOKEN,
      variant: "v2-token",
      entries: LIST,
      addresses: [A],
      root: ROOT,
    });
    assert.ok(result);
    assert.equal(result.state, "eligible");
  });

  it("treats an explicitly null root as 'no allow-list', without reading", async () => {
    // null is an answer, not a missing input: prepareRun read the getter and got
    // nothing back. Falling through to a fetch here would ask the same question
    // twice and could contradict the mechanism the table already chose.
    const [result] = await checkMerkleEligibility({
      provider: providerReturning(ROOT),
      nftContract: TOKEN,
      variant: "v2-token",
      entries: LIST,
      addresses: [A],
      root: null,
    });
    assert.ok(result);
    assert.equal(result.state, "ineligible");
    assert.match(result.detail, /no allow-list Merkle root configured/i);
  });

  it("agrees with the fetching path when handed the same root", async () => {
    // The optimisation must be invisible in the output. Same drop, same wallets,
    // one path reads the root and the other is given it.
    const fetched = await run(ROOT, [A, B, C]);
    const supplied = await checkMerkleEligibility({
      provider: providerReturning(ROOT),
      nftContract: TOKEN,
      variant: "v2-token",
      entries: LIST,
      addresses: [A, B, C],
      root: ROOT,
    });
    assert.deepEqual(
      supplied.map((r) => [r.address, r.state, r.detail]),
      fetched.map((r) => [r.address, r.state, r.detail]),
    );
  });

  it("returns checksummed addresses whatever case it was handed", async () => {
    const [result] = await run(ROOT, [A.toLowerCase()]);
    assert.ok(result);
    assert.equal(result.address, A);
  });
});

describe("eligibility rendering", () => {
  it("never shows a tick for an unknown state", () => {
    assert.notEqual(eligibilityIcon("unknown"), eligibilityIcon("eligible"));
    assert.equal(eligibilityIcon("unknown"), "❔");
  });

  it("names OpenSea as the reason an unknown is unknown", () => {
    assert.equal(eligibilityLabel("unknown", "opensea-signed"), "unknown (OpenSea-gated)");
    assert.equal(eligibilityLabel("unknown", "merkle-allowlist"), "unknown");
  });
});

describe("summariseEligibility", () => {
  const w = (state: WalletEligibility["state"]): WalletEligibility => ({
    address: A,
    state,
    mechanism: "merkle-allowlist",
    detail: "",
  });

  it("says all-eligible only when every wallet is", () => {
    assert.match(summariseEligibility([w("eligible"), w("eligible")]), /all 2 eligible/);
  });

  it("does not round a partial result up to eligible", () => {
    // One wallet with a spot does not mean the set has spots. An operator reading
    // "eligible" here would not notice four wallets sitting idle at T-0.
    const line = summariseEligibility([w("eligible"), w("ineligible"), w("ineligible")]);
    assert.match(line, /1\/3 eligible/);
    assert.doesNotMatch(line, /^✅/);
  });

  it("counts the unknowns separately from the refusals", () => {
    const line = summariseEligibility([w("eligible"), w("unknown"), w("ineligible")]);
    assert.match(line, /1\/3 eligible/);
    assert.match(line, /1 unknown/);
  });

  it("collapses an all-unknown set to the gated wording", () => {
    assert.match(summariseEligibility([w("unknown"), w("unknown")]), /unknown/);
  });

  it("says none rather than 0/3", () => {
    assert.match(summariseEligibility([w("ineligible"), w("ineligible")]), /none of 2/);
  });

  it("handles an empty wallet set without claiming anything", () => {
    assert.equal(summariseEligibility([]), "no wallets loaded");
  });
});

describe("eligibilitySummary", () => {
  // The one line the stage table gets for the Merkle row. Three inputs that must
  // stay distinguishable: never asked, asked and answered, asked and failed.
  // Collapsing the third into the first is the bug this guards.
  const proven = (address: string): WalletEligibility => ({
    address,
    state: "eligible",
    mechanism: "merkle-allowlist",
    detail: "Proof verified.",
    proof: ["0xaa"],
  });

  const out = (address: string): WalletEligibility => ({
    address,
    state: "ineligible",
    mechanism: "merkle-allowlist",
    detail: "Not in the allow-list.",
  });

  const A = "0x1111111111111111111111111111111111111111";
  const B = "0x2222222222222222222222222222222222222222";

  it("returns null when no list was configured", () => {
    // null, not "unknown": the caller omits the cell entirely, so the table shows
    // its own em dash rather than a verdict nobody asked for.
    assert.equal(eligibilitySummary({ origin: null, results: [], error: null }), null);
  });

  it("reports a load failure in the cell", () => {
    const line = eligibilitySummary({
      origin: null,
      results: [],
      error: "Allow-list file not found: ./nope.json",
    });
    assert.ok(line);
    assert.match(line, /unusable/);
    assert.match(line, /not found/);
  });

  it("puts the failure ahead of any verdicts it might also hold", () => {
    // Defensive: if both are somehow set, the failure is the more important fact,
    // because verdicts computed from a list that did not load are meaningless.
    const line = eligibilitySummary({ origin: "./l.json", results: [proven(A)], error: "HTTP 500" });
    assert.ok(line);
    assert.match(line, /unusable/);
    assert.doesNotMatch(line, /eligible/);
  });

  it("summarises real verdicts", () => {
    const line = eligibilitySummary({ origin: "./l.json", results: [proven(A), proven(B)], error: null });
    assert.match(line ?? "", /all 2 eligible/);
  });

  it("does not hide the wallets that cannot mint", () => {
    const line = eligibilitySummary({ origin: "./l.json", results: [proven(A), out(B)], error: null });
    assert.match(line ?? "", /1\/2 eligible/);
  });

  it("cuts a multi-sentence failure to its first sentence", () => {
    // The cell is one line. A truncation mid-sentence is the half-explanation the
    // project forbids, so the cut lands on a boundary.
    const line = eligibilitySummary({
      origin: null,
      results: [],
      error: "Allow-list field \"maxTotal\" is not a number: abc. Check the file.",
    });
    assert.ok(line);
    assert.doesNotMatch(line, /Check the file/);
    assert.match(line, /not a number/);
  });

  it("leaks no key material from an error", () => {
    const line = eligibilitySummary({
      origin: null,
      results: [],
      error: "fetch failed for 0x1111111111111111111111111111111111111111",
    });
    assert.ok(line);
    assert.doesNotMatch(line, /0x[0-9a-f]{64}/i);
  });
});
