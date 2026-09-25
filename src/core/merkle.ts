// Merkle allowlists: proof computation, offline and verifiable.
//
// This is the one gated mint path that asks nobody for permission. SeaDrop keeps
// a Merkle root on-chain; a wallet is eligible exactly when it can produce a
// proof that folds to that root. Both halves are computable here, so eligibility
// is known before the stage opens, the calldata is complete, and the transaction
// can be signed during the wait like a public mint.
//
// ── The safety property ────────────────────────────────────────────────────
//
// Leaf encoding varies between SeaDrop deployments and allowlist generators, and
// a wrong guess produces proofs that revert on-chain — after the mint is lost.
// So nothing here is trusted on its own: `verifyAgainstChain` recomputes the root
// from the allowlist data and compares it to the root the contract actually
// holds. A mismatch means our encoding does not match theirs, and intern reports
// that it cannot prove eligibility instead of firing a transaction it expects to
// fail. Being wrong here is loud and cheap rather than silent and expensive.

import { AbiCoder, concat, getAddress, keccak256 } from "ethers";

/** SeaDrop's per-stage parameters. These are hashed into the leaf, not stored. */
export interface MintParams {
  mintPrice: bigint;
  maxTotalMintableByWallet: bigint;
  startTime: bigint;
  endTime: bigint;
  dropStageIndex: bigint;
  maxTokenSupplyForStage: bigint;
  feeBps: bigint;
  restrictFeeRecipients: boolean;
}

export const MINT_PARAMS_TUPLE =
  "tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime," +
  " uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage," +
  " uint256 feeBps, bool restrictFeeRecipients)";

export interface AllowListEntry {
  minter: string;
  params: MintParams;
}

const coder = AbiCoder.defaultAbiCoder();

/**
 * leaf = keccak256(abi.encode(minter, mintParams)), which is what SeaDrop hashes
 * before verifying a proof. The address is checksummed first so the same wallet
 * written in any case produces one leaf rather than several.
 */
export function leafFor(entry: AllowListEntry): string {
  const p = entry.params;
  return keccak256(
    coder.encode(
      ["address", MINT_PARAMS_TUPLE],
      [
        getAddress(entry.minter),
        [
          p.mintPrice,
          p.maxTotalMintableByWallet,
          p.startTime,
          p.endTime,
          p.dropStageIndex,
          p.maxTokenSupplyForStage,
          p.feeBps,
          p.restrictFeeRecipients,
        ],
      ],
    ),
  );
}

/**
 * Sorted-pair hashing: the two children are ordered by value before being
 * concatenated, so a proof carries no left/right information and the verifier
 * needs no position bits. This is what OpenZeppelin's MerkleProof and solady's
 * MerkleProofLib both do, and SeaDrop uses the latter.
 */
export function hashPair(a: string, b: string): string {
  return a.toLowerCase() <= b.toLowerCase()
    ? keccak256(concat([a, b]))
    : keccak256(concat([b, a]));
}

export interface MerkleTree {
  /** Level 0 is the leaves; the last level is a single root. */
  levels: string[][];
  root: string;
}

/**
 * Build the tree.
 *
 * An odd node at any level is promoted unchanged to the next — it is not paired
 * with itself. Duplicating it instead is a real and different construction, and
 * mixing the two is the usual cause of a root that does not match. Which one a
 * given allowlist used is not something intern can know, which is exactly why
 * `verifyAgainstChain` exists.
 */
export function buildTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    throw new Error("Cannot build a Merkle tree from an empty allow-list.");
  }

  // Sorted and deduplicated so the tree is a function of the set, not of the
  // order the file happened to list it in.
  const level0 = [...new Set(leaves.map((l) => l.toLowerCase()))].sort();
  const levels: string[][] = [level0];

  while (true) {
    const current = levels[levels.length - 1];
    if (!current || current.length <= 1) break;
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = current[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    levels.push(next);
  }

  const top = levels[levels.length - 1];
  const root = top?.[0];
  if (!root) throw new Error("Merkle tree has no root — this should be unreachable.");
  return { levels, root };
}

/**
 * The sibling hashes needed to fold `leaf` up to the root, or null when the leaf
 * is not in the tree. Null is a definitive "not eligible", not a missing input.
 */
export function proofFor(tree: MerkleTree, leaf: string): string[] | null {
  const target = leaf.toLowerCase();
  let index = tree.levels[0]?.indexOf(target) ?? -1;
  if (index === -1) return null;

  const proof: string[] = [];
  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    const nodes = tree.levels[level]!;
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    const sibling = nodes[siblingIndex];
    // No sibling means this node was promoted — nothing to add at this level.
    if (sibling !== undefined) proof.push(sibling);
    index = Math.floor(index / 2);
  }
  return proof;
}

/**
 * Fold a proof and compare to the root. This mirrors the contract exactly, so it
 * also validates a proof obtained from somewhere else — an allowlist generator,
 * an API — without needing the full member list.
 */
export function verifyProof(proof: string[], root: string, leaf: string): boolean {
  let computed = leaf.toLowerCase();
  for (const sibling of proof) computed = hashPair(computed, sibling).toLowerCase();
  return computed === root.toLowerCase();
}

export type EligibilityVerdict =
  | { eligible: true; proof: string[]; root: string }
  | { eligible: false; reason: string };

const ZERO_ROOT = `0x${"00".repeat(32)}`;

/**
 * The whole Merkle path in one call: build from the published allowlist, check
 * our root against the chain's, then produce this wallet's proof.
 *
 * Order matters. The root comparison comes first because it validates the
 * *encoding*; only once it passes does a missing proof mean "this wallet is not
 * on the list" rather than "we hashed it differently than they did".
 */
export function checkEligibility(
  minter: string,
  entries: AllowListEntry[],
  onChainRoot: string,
): EligibilityVerdict {
  if (onChainRoot.toLowerCase() === ZERO_ROOT) {
    return {
      eligible: false,
      reason: "No allow-list Merkle root is configured on this collection.",
    };
  }
  if (entries.length === 0) {
    return { eligible: false, reason: "The allow-list is empty — nothing to prove against." };
  }

  const tree = buildTree(entries.map(leafFor));
  if (tree.root.toLowerCase() !== onChainRoot.toLowerCase()) {
    return {
      eligible: false,
      reason:
        `The allow-list does not hash to the root this contract holds ` +
        `(computed ${tree.root}, on-chain ${onChainRoot}). Either the list is not the one ` +
        `this drop was configured with, or it was generated with a different leaf encoding. ` +
        `intern will not submit a proof it cannot verify.`,
    };
  }

  const wanted = getAddress(minter);
  const entry = entries.find((e) => getAddress(e.minter) === wanted);
  if (!entry) {
    return { eligible: false, reason: `${wanted} is not on this allow-list.` };
  }

  const proof = proofFor(tree, leafFor(entry));
  if (!proof) {
    return { eligible: false, reason: `${wanted} is on the list but has no path to the root.` };
  }
  return { eligible: true, proof, root: tree.root };
}
