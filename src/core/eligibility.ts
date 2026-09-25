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
import { OpenSeaError, requestMintTx } from "./opensea";
import { SeaDropVariant, fetchAllowListRoot, fetchSigners } from "./seadrop";

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

// ── Path B: the OpenSea probe ───────────────────────────────────────────────

/**
 * What a probe's HTTP status actually tells us.
 *
 * Pure, and separated from the request for exactly that reason: this is the
 * judgement call in the signed path, and it is the thing most likely to be got
 * wrong in a way that shows a green tick to someone who is not on the list.
 *
 * The rules:
 *   200/201  — a signature was issued. Eligible, *at this instant*.
 *   401      — our API key is bad. Says nothing about the wallet.
 *   403      — refused for this minter. Final, and the one true negative.
 *   404      — no such drop, or no mintable stage. Not a wallet verdict.
 *   409      — the drop is not currently mintable. Expected before the open.
 *   422      — ambiguous by design: not-on-list, cap reached, sold out and
 *              insufficient balance all land here. Never reported as ineligible.
 *   429      — rate limited. No information at all.
 */
export function classifyProbe(status: number): { state: EligibilityState; detail: string } {
  if (status >= 200 && status < 300) {
    return {
      state: "eligible",
      detail:
        "OpenSea issued a signature for this wallet. Note this is a fact about " +
        "right now: the signature is bound to one quantity and salt and is not " +
        "a standing entitlement.",
    };
  }
  switch (status) {
    case 401:
      return {
        state: "unknown",
        detail: "OpenSea rejected the API key (401). This says nothing about the wallet.",
      };
    case 403:
      return {
        state: "ineligible",
        detail: "OpenSea refused to mint for this wallet (403) — it is not eligible for this stage.",
      };
    case 404:
      return {
        state: "unknown",
        detail: "OpenSea has no mintable stage for this drop (404). Not a verdict on the wallet.",
      };
    case 409:
      return {
        state: "unknown",
        detail:
          "The drop is not currently mintable (409). Expected before a stage opens — " +
          "eligibility cannot be established until then.",
      };
    case 422:
      return {
        state: "unknown",
        detail:
          "OpenSea returned 422, which covers not-on-the-allowlist, per-wallet limit " +
          "reached, sold out and insufficient balance with no way to tell them apart. " +
          "Reporting this as 'not eligible' would be a guess.",
      };
    case 429:
      return {
        state: "unknown",
        detail: "Rate limited by OpenSea (429). No eligibility information was returned.",
      };
    default:
      return {
        state: "unknown",
        detail: `OpenSea returned HTTP ${status}. No eligibility information was returned.`,
      };
  }
}

export interface ProbeOptions {
  slug: string;
  apiKey: string;
  addresses: string[];
  quantity: number;
}

/**
 * Best-effort eligibility probe for the OpenSea-signed path.
 *
 * Best-effort is meant literally: before the stage opens this returns `unknown`
 * for every wallet, because that is the true answer. It is run anyway because a
 * 403 is worth knowing hours early — it is the difference between an operator who
 * discovers at T-0 that they were never on the list and one who does not.
 *
 * Probes run sequentially. Firing the whole wallet set at OpenSea at once is the
 * reliable way to earn a 429, which costs the information the probe was for.
 */
export async function probeOpenSeaEligibility(
  opts: ProbeOptions,
): Promise<WalletEligibility[]> {
  const results: WalletEligibility[] = [];
  for (const address of opts.addresses) {
    const addr = getAddress(address);
    try {
      await requestMintTx(opts.slug, opts.apiKey, addr, opts.quantity);
      const { state, detail } = classifyProbe(200);
      results.push({ address: addr, state, detail, mechanism: "opensea-signed" });
    } catch (err: unknown) {
      if (err instanceof OpenSeaError) {
        const { state, detail } = classifyProbe(err.status);
        results.push({ address: addr, state, detail, mechanism: "opensea-signed" });
      } else {
        results.push({
          address: addr,
          state: "unknown",
          mechanism: "opensea-signed",
          detail: `Could not reach OpenSea: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
  return results;
}

/**
 * Summarise a wallet set into one line for the stage table.
 *
 * Deliberately pessimistic about mixed results: "3 of 5 eligible" is the truth,
 * and rounding it to "eligible" because one wallet can mint hides that four
 * cannot.
 */
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
