// Merkle allowlists: the one gated path intern can prove by itself.
//
// Two things are pinned here and they guard different failures.
//
// The golden hashes below are literals, computed once and written down. They make
// the *encoding* a fixed fact: if the leaf layout, the field order, or the tuple
// type ever drifts, these fail loudly instead of producing proofs that look fine
// and revert on-chain after the mint is gone.
//
// The fail-closed tests guard the case where the encoding is wrong anyway —
// because a given allowlist generator used a construction we did not guess.
// `checkEligibility` must refuse rather than submit. A missed mint is recoverable;
// a confidently-wrong proof burns gas and the slot.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concat, keccak256 } from "ethers";
import {
  AllowListEntry,
  MintParams,
  buildTree,
  checkEligibility,
  hashPair,
  leafFor,
  proofFor,
  verifyProof,
} from "../src/core/merkle";
import { decodeMintAllowList, encodeMintAllowList } from "../src/core/seadrop";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";

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

// Golden values — computed once against ethers' ABI coder and written down.
const LEAF_A = "0xa8a14b92f807d771db7ca5d4b81503f6754084a7cd467f47bc99346569956097";
const LEAF_B = "0xf46f46abd3a00bbebc819da7058eda751303486cd46e8d919259f0b406ce4cf1";
const LEAF_C = "0x164b4567a9a55adf9e498dfd0e40f7387ed3dabaf96674b48a9b10c0940e50cb";
const ROOT_AB = "0x3452e1668528a55c83c55046eb2bc0ae53678f34fcfe5ae81b2b6fe3e85af4a5";
const ROOT_ABC = "0x1b26b2db35a3606a8154a8344757249dc12ecee1da982185a86388691e2c6e47";

const entry = (minter: string, over: Partial<MintParams> = {}): AllowListEntry => ({
  minter,
  params: { ...PARAMS, ...over },
});

describe("leafFor", () => {
  it("matches the recorded encoding for known inputs", () => {
    assert.equal(leafFor(entry(A)), LEAF_A);
    assert.equal(leafFor(entry(B)), LEAF_B);
    assert.equal(leafFor(entry(C)), LEAF_C);
  });

  it("is case-insensitive in the address", () => {
    // The same wallet written lowercase in a JSON file and checksummed in .env is
    // one member of the list, not two. Producing two leaves here would silently
    // put the operator's own wallet outside the tree they just built.
    assert.equal(leafFor(entry(A.toUpperCase().replace("0X", "0x"))), LEAF_A);
  });

  it("changes when any mint parameter changes", () => {
    // The stage window lives inside the leaf. A wallet allowlisted for stage 1 has
    // no proof for stage 2 even at the same address, and conflating them produces
    // a proof that fails verification against a root that is otherwise correct.
    assert.notEqual(leafFor(entry(A, { dropStageIndex: 2n })), LEAF_A);
    assert.notEqual(leafFor(entry(A, { startTime: PARAMS.startTime + 1n })), LEAF_A);
    assert.notEqual(leafFor(entry(A, { mintPrice: 0n })), LEAF_A);
    assert.notEqual(leafFor(entry(A, { restrictFeeRecipients: false })), LEAF_A);
  });
});

describe("hashPair", () => {
  it("sorts before hashing, so order carries no information", () => {
    assert.equal(hashPair(LEAF_A, LEAF_B), hashPair(LEAF_B, LEAF_A));
  });

  it("hashes the concatenation of the ordered pair", () => {
    const [lo, hi] = [LEAF_A, LEAF_B].sort();
    assert.equal(hashPair(LEAF_A, LEAF_B), keccak256(concat([lo!, hi!])));
  });
});

describe("buildTree", () => {
  it("produces the recorded root for a two-member list", () => {
    assert.equal(buildTree([LEAF_A, LEAF_B]).root, ROOT_AB);
  });

  it("promotes an odd node rather than pairing it with itself", () => {
    // Three members: two pair, one rides up untouched. Duplicating it instead is a
    // real and different construction that yields a different root — which is why
    // the on-chain comparison is not optional.
    assert.equal(buildTree([LEAF_A, LEAF_B, LEAF_C]).root, ROOT_ABC);
  });

  it("is a function of the set, not of the input order", () => {
    const one = buildTree([LEAF_C, LEAF_A, LEAF_B]).root;
    const two = buildTree([LEAF_B, LEAF_C, LEAF_A]).root;
    assert.equal(one, two);
    assert.equal(one, ROOT_ABC);
  });

  it("ignores duplicate entries", () => {
    assert.equal(buildTree([LEAF_A, LEAF_B, LEAF_A]).root, ROOT_AB);
  });

  it("gives a single-member list the leaf as its root", () => {
    assert.equal(buildTree([LEAF_A]).root, LEAF_A.toLowerCase());
  });

  it("refuses an empty list instead of inventing a root", () => {
    assert.throws(() => buildTree([]), /empty allow-list/i);
  });
});

describe("proofFor / verifyProof", () => {
  it("produces a proof that folds to the root for every member", () => {
    const leaves = [LEAF_A, LEAF_B, LEAF_C];
    const tree = buildTree(leaves);
    for (const leaf of leaves) {
      const proof = proofFor(tree, leaf);
      assert.ok(proof, `expected a proof for ${leaf}`);
      assert.equal(verifyProof(proof, tree.root, leaf), true);
    }
  });

  it("scales past the hand-checkable cases", () => {
    // Eight members exercises three levels; seven exercises promotion at two of
    // them. Both must verify for every single member, not just the first.
    for (const size of [7, 8, 33]) {
      const leaves = Array.from({ length: size }, (_, i) =>
        leafFor(entry(`0x${String(i + 1).padStart(40, "0")}`)),
      );
      const tree = buildTree(leaves);
      for (const leaf of leaves) {
        const proof = proofFor(tree, leaf);
        assert.ok(proof, `size ${size}: no proof for ${leaf}`);
        assert.equal(verifyProof(proof, tree.root, leaf), true, `size ${size}: ${leaf}`);
      }
    }
  });

  it("returns null for a non-member rather than an unusable proof", () => {
    const tree = buildTree([LEAF_A, LEAF_B]);
    assert.equal(proofFor(tree, leafFor(entry(D))), null);
  });

  it("rejects a proof belonging to a different leaf", () => {
    const tree = buildTree([LEAF_A, LEAF_B, LEAF_C]);
    const proof = proofFor(tree, LEAF_A)!;
    assert.equal(verifyProof(proof, tree.root, LEAF_C), false);
  });

  it("rejects a proof against the wrong root", () => {
    const tree = buildTree([LEAF_A, LEAF_B, LEAF_C]);
    assert.equal(verifyProof(proofFor(tree, LEAF_A)!, ROOT_AB, LEAF_A), false);
  });

  it("verifies a proof supplied from outside, with no member list", () => {
    // The generator, or an API, may hand over a proof directly. Verification needs
    // only the proof, the leaf and the root — so an externally-sourced proof can
    // still be checked before a transaction is built on it.
    const sibling = LEAF_B;
    const root = hashPair(LEAF_A, sibling);
    assert.equal(verifyProof([sibling], root, LEAF_A), true);
  });
});

describe("checkEligibility", () => {
  const list = [entry(A), entry(B), entry(C)];

  it("proves a member against the matching on-chain root", () => {
    const verdict = checkEligibility(A, list, ROOT_ABC);
    assert.equal(verdict.eligible, true);
    if (!verdict.eligible) return;
    assert.equal(verifyProof(verdict.proof, ROOT_ABC, LEAF_A), true);
  });

  it("reports a non-member as ineligible, by name", () => {
    const verdict = checkEligibility(D, list, ROOT_ABC);
    assert.equal(verdict.eligible, false);
    if (verdict.eligible) return;
    assert.match(verdict.reason, /not on this allow-list/i);
  });

  it("fails closed when our root disagrees with the chain's", () => {
    // This is the whole safety property. A root mismatch means our leaf encoding
    // is not theirs, and any proof we produced would revert. Reporting "not
    // eligible" here costs a mint; submitting anyway costs gas and the mint.
    const verdict = checkEligibility(A, list, ROOT_AB);
    assert.equal(verdict.eligible, false);
    if (verdict.eligible) return;
    assert.match(verdict.reason, /does not hash to the root/i);
    assert.match(verdict.reason, /will not submit a proof it cannot verify/i);
  });

  it("names both roots in the mismatch, so the disagreement is diagnosable", () => {
    const verdict = checkEligibility(A, list, ROOT_AB);
    assert.equal(verdict.eligible, false);
    if (verdict.eligible) return;
    assert.match(verdict.reason, new RegExp(ROOT_ABC, "i"));
    assert.match(verdict.reason, new RegExp(ROOT_AB, "i"));
  });

  it("says no allow-list is configured when the root is zero", () => {
    const verdict = checkEligibility(A, list, `0x${"00".repeat(32)}`);
    assert.equal(verdict.eligible, false);
    if (verdict.eligible) return;
    assert.match(verdict.reason, /No allow-list Merkle root is configured/i);
  });

  it("distinguishes an empty list from a missing root", () => {
    const verdict = checkEligibility(A, [], ROOT_ABC);
    assert.equal(verdict.eligible, false);
    if (verdict.eligible) return;
    assert.match(verdict.reason, /allow-list is empty/i);
  });

  it("matches a member regardless of address case", () => {
    const verdict = checkEligibility(A.toLowerCase(), list, ROOT_ABC);
    assert.equal(verdict.eligible, true);
  });
});

describe("mintAllowList calldata", () => {
  const FEE = "0x0000a26b00c1F0DF003000390027140000fAa719";
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const PROOF = [LEAF_B, LEAF_C];

  it("round-trips through the v1 singleton ABI", () => {
    const data = encodeMintAllowList("v1-singleton", TOKEN, FEE, 2, PARAMS, PROOF);
    const decoded = decodeMintAllowList(data);
    assert.ok(decoded);
    assert.equal(decoded.name, "mintAllowList");
    assert.equal(decoded.args[0], TOKEN);
    assert.equal(decoded.args[3], 2n);
  });

  it("round-trips through the v2 token ABI", () => {
    const data = encodeMintAllowList("v2-token", TOKEN, FEE, 1, PARAMS, PROOF);
    const decoded = decodeMintAllowList(data);
    assert.ok(decoded);
    assert.equal(decoded.name, "mintAllowList");
    // No nftContract argument on v2 — the token is the contract being called.
    assert.equal(decoded.args[0], FEE);
  });

  it("carries the proof through unchanged", () => {
    const data = encodeMintAllowList("v2-token", TOKEN, FEE, 1, PARAMS, PROOF);
    const decoded = decodeMintAllowList(data)!;
    assert.deepEqual([...(decoded.args[4] as readonly string[])], PROOF);
  });

  it("encodes the mint params the leaf was hashed from", () => {
    // If these two ever diverge the proof verifies and the mint still reverts,
    // because the contract re-hashes the params it was handed.
    const data = encodeMintAllowList("v2-token", TOKEN, FEE, 1, PARAMS, PROOF);
    const params = decodeMintAllowList(data)!.args[3] as readonly unknown[];
    assert.equal(params[0], PARAMS.mintPrice);
    assert.equal(params[2], PARAMS.startTime);
    assert.equal(params[4], PARAMS.dropStageIndex);
    assert.equal(params[7], PARAMS.restrictFeeRecipients);
  });

  it("distinguishes itself from public-mint calldata", () => {
    assert.equal(decodeMintAllowList("0xdeadbeef"), null);
  });

  it("differs per wallet, unlike the public path", () => {
    // Public calldata is byte-identical across the wallet set. Allowlist calldata
    // is not, because the proof is the wallet's. Anything that caches one encode
    // and reuses it across wallets is wrong here.
    const one = encodeMintAllowList("v2-token", TOKEN, FEE, 1, PARAMS, [LEAF_B]);
    const two = encodeMintAllowList("v2-token", TOKEN, FEE, 1, PARAMS, [LEAF_C]);
    assert.notEqual(one, two);
  });
});
