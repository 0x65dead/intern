// Can this wallet actually mint at this stage?
//
// Three mechanisms answer that question, and they answer it with different
// certainty. Collapsing them into one boolean is the mistake this module exists
// to avoid — a green tick that means "probably" is worse than an honest "unknown",
// because the operator plans around it.
//
//   A. Merkle allow-list   — provable offline. The root is on-chain and the proof
//                            is computed here. The answer is certain, it is known
//                            before the stage opens, and nobody can revoke it.
//
//   B. OpenSea-signed      — knowable only by asking, as the wallet. The signature
//                            does not exist before the stage opens, so a pre-open
//                            probe can prove ineligibility (a 403 is final) but
//                            never eligibility. This reports `unknown`, and says
//                            why, rather than guessing.
//
//   C. Locally-signed      — the drop's configured signer is a key the operator
//                            holds. Same shape as B, but the signature can be
//                            produced here, so it behaves like A.
//
// The asymmetry in B is the important part and it is not a limitation of this
// code: a negative from OpenSea is information, a positive is only information
// about the instant it was given.

import { JsonRpcProvider, getAddress } from "ethers";
import { MintMechanism } from "./capabilities";
import { AllowListEntry, MintParams, checkEligibility } from "./merkle";
import { SeaDropVariant, fetchAllowListRoot, fetchSigners } from "./seadrop";
import { DropStage } from "./opensea";
import { EligibilitySnapshot, hintForStage } from "./openseaeligibility";

export type EligibilityState = "eligible" | "ineligible" | "unknown";

export interface WalletEligibility {
  address: string;
  state: EligibilityState;
  mechanism: MintMechanism;
  /** Always populated. For `unknown` it states what stands in the way. */
  detail: string;
  /** Path A and C only: everything needed to build calldata right now. */
  proof?: string[];
  params?: MintParams;
}

/** Rendered into the stage table. Never a tick for `unknown`. */
export function eligibilityIcon(state: EligibilityState): string {
  if (state === "eligible") return "✅";
  if (state === "ineligible") return "❌";
  return "❔";
}

export function eligibilityLabel(state: EligibilityState, mechanism: MintMechanism): string {
  if (state === "eligible") return "eligible";
  if (state === "ineligible") return "not eligible";
  return mechanism === "opensea-signed" ? "unknown (OpenSea-gated)" : "unknown";
}

// ── Path A / C: provable locally ────────────────────────────────────────────

export interface MerkleCheckOptions {
  provider: JsonRpcProvider;
  nftContract: string;
  variant: SeaDropVariant;
  entries: AllowListEntry[];
  addresses: string[];
  /**
   * The on-chain root, when the caller already read it.
   *
   * Pre-arm runs on a countdown, and prepareRun reads this root anyway to decide
   * the mechanism. Passing it here spends one fewer round trip at exactly the
   * moment round trips are most expensive. Omit it and the root is fetched.
   */
  root?: string | null;
}

/**
 * Prove each wallet against the on-chain root.
 *
 * The root is read once and shared: it is a property of the drop, not of the
 * wallet, and re-reading it per wallet would multiply the RPC round trips during
 * pre-arm for no information.
 */
export async function checkMerkleEligibility(
  opts: MerkleCheckOptions,
): Promise<WalletEligibility[]> {
  const root =
    opts.root !== undefined
      ? opts.root
      : await fetchAllowListRoot(opts.provider, opts.nftContract, opts.variant);
  if (!root) {
    return opts.addresses.map((address) => ({
      address: getAddress(address),
      state: "ineligible" as const,
      mechanism: "merkle-allowlist" as const,
      detail: "This collection has no allow-list Merkle root configured on-chain.",
    }));
  }

  return opts.addresses.map((address) => {
    const verdict = checkEligibility(address, opts.entries, root);
    if (verdict.eligible) {
      const entry = opts.entries.find((e) => getAddress(e.minter) === getAddress(address));
      return {
        address: getAddress(address),
        state: "eligible" as const,
        mechanism: "merkle-allowlist" as const,
        detail: `Proof verified against the on-chain root ${shortRoot(root)}.`,
        proof: verdict.proof,
        ...(entry ? { params: entry.params } : {}),
      };
    }
    // A root mismatch is not the wallet's fault and must not read as one. It says
    // our list is not the drop's list, which is an operator problem to fix, not a
    // verdict about this address.
    const mismatch = verdict.reason.includes("does not hash to the root");
    return {
      address: getAddress(address),
      state: mismatch ? ("unknown" as const) : ("ineligible" as const),
      mechanism: "merkle-allowlist" as const,
      detail: verdict.reason,
    };
  });
}

function shortRoot(root: string): string {
  return `${root.slice(0, 10)}…${root.slice(-6)}`;
}

/**
 * Is the drop's signer a key we hold?
 *
 * Returns the matching address, or null. A match turns an OpenSea-gated stage
 * into a locally-signable one — the single case where a signed stage is as fast
 * as a public mint, because nothing has to be requested at T-0.
 */
export async function detectLocalSigner(
  provider: JsonRpcProvider,
  nftContract: string,
  variant: SeaDropVariant,
  heldAddresses: string[],
): Promise<string | null> {
  const signers = await fetchSigners(provider, nftContract, variant);
  if (signers.length === 0) return null;
  const held = new Set(heldAddresses.map((a) => getAddress(a)));
  return signers.find((s) => held.has(s)) ?? null;
}

/**
 * Summarise a wallet set into one line for the stage table.
 *
 * Deliberately pessimistic about mixed results: "3 of 5 eligible" is the truth,
 * and rounding it to "eligible" because one wallet can mint hides that four
 * cannot.
 */
// ── Path B: OpenSea answers for the wallet its token was issued to ──────────

/**
 * Turn an eligibility snapshot into table rows, one per loaded wallet.
 *
 * This is the honest replacement for inferring eligibility from a mint refusal.
 * The difference that matters is not the transport but the timing: OpenSea will
 * answer this before the stage opens, whereas a refusal only exists after it has
 * opened and the chance to act on the answer has already gone.
 *
 * The rule that shapes the output: a scoped token is bound to ONE wallet, so a
 * snapshot can only ever speak about one of the addresses loaded here. That
 * wallet gets a verdict; every other wallet gets `unknown` with the reason — not
 * the answered wallet's verdict copied across. Two wallets on the same drop
 * routinely differ, and one wallet's "yes" standing in for another's is the most
 * expensive mistake available in this file.
 *
 * Attribution is delegated to `hintForStage` rather than redone here, because
 * deciding who an answer is about has three distinct failure modes and they are
 * already enumerated and tested there.
 */
export function openSeaEligibilityRows(
  snapshot: EligibilitySnapshot,
  stage: DropStage | null,
  addresses: readonly string[],
): WalletEligibility[] {
  if (addresses.length === 0) return [];
  const loaded = new Set(addresses.map((a) => a.toLowerCase()));
  const hint = hintForStage(snapshot, stage, loaded);

  // Narrowed on the discriminant rather than on a separate flag: the compiler
  // cannot carry a boolean's meaning back onto `hint`, and destructuring a union
  // it has not narrowed is exactly the kind of "it is obviously fine" that this
  // file's strictness exists to catch.
  if (hint.kind !== "recorded") {
    // Why no wallet could be answered for. Stated in the row rather than
    // dropped, because "unknown" without a cause sends the operator to check
    // their wallets when the fault is a token issued to a different one.
    const reason =
      hint.kind === "foreign"
        ? `OpenSea answered for ${hint.wallet}, which is not one of the loaded wallets.`
        : hint.kind === "ambiguous"
          ? `OpenSea did not name a wallet and ${hint.candidates} are loaded, so the answer cannot be attributed to one.`
          : stage === null
            ? "No gated stage was identified to ask about."
            : `OpenSea answered for ${hint.answered} stage(s), none of them this one.`;
    return addresses.map((address) => ({
      address,
      state: "unknown" as const,
      mechanism: "opensea-signed" as const,
      detail: reason,
    }));
  }

  const { wallet: subject, row } = hint;
  return addresses.map((address) => {
    if (address.toLowerCase() !== subject) {
      return {
        address,
        state: "unknown" as const,
        mechanism: "opensea-signed" as const,
        // Not a verdict. A second wallet needs a second token.
        detail:
          "Not covered by this token — an OpenSea eligibility token answers for one wallet only.",
      };
    }
    // `price` and `maxMintable` keep null distinct from zero throughout: an
    // unstated limit is not a limit of zero, and an unstated price is not free.
    const terms = [
      row.price === null ? null : row.price === 0n ? "free" : `${row.price} wei`,
      row.maxMintable === null ? null : `up to ${row.maxMintable}`,
    ].filter((t): t is string => t !== null);
    const detail =
      `OpenSea ${row.isEligible ? "confirms" : "refuses"} "${row.stageLabel}"` +
      (terms.length > 0 ? ` — ${terms.join(", ")}` : "") +
      (row.unmapped ? " (stage type unconfirmed against the schedule)" : "") +
      ".";
    return {
      address,
      state: (row.isEligible ? "eligible" : "ineligible") as EligibilityState,
      mechanism: "opensea-signed" as const,
      detail,
    };
  });
}

export function summariseEligibility(results: WalletEligibility[]): string {
  if (results.length === 0) return "no wallets loaded";
  const eligible = results.filter((r) => r.state === "eligible").length;
  const unknown = results.filter((r) => r.state === "unknown").length;
  const mechanism = results[0]?.mechanism ?? "unknown";

  if (eligible === results.length) return `${eligibilityIcon("eligible")} all ${eligible} eligible`;
  if (unknown === results.length) {
    return `${eligibilityIcon("unknown")} ${eligibilityLabel("unknown", mechanism)}`;
  }
  if (eligible === 0 && unknown === 0) {
    return `${eligibilityIcon("ineligible")} none of ${results.length} eligible`;
  }
  const parts = [`${eligible}/${results.length} eligible`];
  if (unknown > 0) parts.push(`${unknown} unknown`);
  return `${eligibilityIcon("unknown")} ${parts.join(", ")}`;
}
