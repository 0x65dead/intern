// What intern can actually do, per mint mechanism, stated once.
//
// The rest of the codebase asks this module two questions: "may I fire at this
// stage unattended?" and "what do I tell the operator about why not?". Both
// answers live here so they cannot drift apart, and so CAPABILITY.md can be
// generated from the same table the scheduler selects from. A row that claims
// more than the code delivers is the failure mode this file exists to prevent.
//
// The axis is the **mechanism**, not the stage kind. "Allowlist", "GTD" and
// "FCFS" are names a creator gives a stage; what decides whether intern can fire
// at it is which contract function it resolves to and where the authorisation
// comes from. The same "Allowlist" label is a fully offline Merkle proof on one
// collection and an OpenSea-held signature on the next, and those two have
// opposite capabilities. `mechanismFor` maps kinds onto mechanisms.

// Type-only: capabilities.ts must not import a *value* from stages.ts, which
// imports values from here. A type import is erased, so there is no runtime cycle.
import type { StageKind } from "./stages";

/**
 * `yes` may carry a note; `warn` and `no` must carry a reason. That asymmetry is
 * enforced by the type: a limitation without a stated cause cannot be written.
 */
export type Capability =
  | { level: "yes"; note?: string }
  | { level: "warn"; reason: string }
  | { level: "no"; reason: string };

export type CapabilityLevel = Capability["level"];

/** The honest answer to "how fast", which is not a yes/no question. */
export type FireSpeedClass = "pre-signed" | "api-bound" | "none";

export interface FireSpeed {
  class: FireSpeedClass;
  /** Printed verbatim in CAPABILITY.md and the README. Must not overstate. */
  detail: string;
}

export type MintMechanism =
  | "public"
  | "merkle-allowlist"
  | "opensea-signed"
  | "local-signed"
  | "team-reserved"
  | "unknown";

export interface MechanismCapability {
  mechanism: MintMechanism;
  title: string;
  /** The contract function this resolves to, or null when there is no path. */
  method: string | null;
  /** Can the stage's window be known before it opens? */
  detectWindow: Capability;
  /** Can this wallet's eligibility be known before the stage opens? */
  precheckEligibility: Capability;
  /** Can the calldata be signed before the stage opens? */
  preSign: Capability;
  /** Can intern fire at it with nobody watching? */
  fireUnattended: Capability;
  fireSpeed: FireSpeed;
}

const YES: Capability = { level: "yes" };

/**
 * The matrix. Every claim here is a claim about code that exists.
 *
 * Ordered most-capable first, which is also the order CAPABILITY.md prints.
 */
export const CAPABILITIES: readonly MechanismCapability[] = [
  {
    mechanism: "public",
    title: "Public",
    method: "mintPublic()",
    detectWindow: {
      level: "yes",
      note: "Start, end, price and per-wallet cap are read from the SeaDrop drop struct. No API key, and nobody can hand you different numbers than the contract will enforce.",
    },
    precheckEligibility: {
      level: "yes",
      note: "getMintStats(minter) returns what this wallet has already minted; the cap is on-chain next to it.",
    },
    preSign: YES,
    fireUnattended: YES,
    fireSpeed: {
      class: "pre-signed",
      detail:
        "Signed bytes are on the socket at T-0. Nothing remains between the clock firing and the transaction reaching a mempool except network latency.",
    },
  },
  {
    mechanism: "merkle-allowlist",
    title: "Allowlist — on-chain Merkle root",
    method: "mintAllowList()",
    detectWindow: {
      level: "warn",
      reason:
        "The window lives inside the signed leaf (MintParams.startTime/endTime), not in a contract getter. It is known exactly once the allowlist data is in hand, and the on-chain root proves that data was not altered.",
    },
    precheckEligibility: {
      level: "yes",
      note:
        "Provable offline. The leaf is keccak256(abi.encode(minter, mintParams)) and the proof is verified against getAllowListMerkleRoot() on-chain. No third party is asked and the answer cannot change under you.",
    },
    preSign: {
      level: "yes",
      note: "Proof and MintParams are fully determined before the stage opens, so the calldata is built and signed during the wait.",
    },
    fireUnattended: YES,
    fireSpeed: {
      class: "pre-signed",
      detail:
        "Identical to a public mint. The Merkle proof is part of the calldata and is computed during the wait, not in the race.",
    },
  },
  {
    mechanism: "local-signed",
    title: "Allowlist — signer held locally",
    method: "mintSigned()",
    detectWindow: {
      level: "warn",
      reason:
        "A signed stage's window is not exposed by any contract getter. It comes from whatever configuration the operator signs against.",
    },
    precheckEligibility: {
      level: "yes",
      note: "The signer key is held locally, so the signature can be produced at will and eligibility is whatever the operator's own list says.",
    },
    preSign: {
      level: "yes",
      note: "The signature is produced locally during the wait, so the calldata exists before T-0.",
    },
    fireUnattended: YES,
    fireSpeed: {
      class: "pre-signed",
      detail: "Pre-signed. No third party is in the firing path.",
    },
  },
  {
    mechanism: "opensea-signed",
    title: "Allowlist / GTD / FCFS — OpenSea-held signature",
    method: "mintSigned()",
    detectWindow: {
      level: "warn",
      reason:
        "Read from OpenSea's drop configuration, which requires OPENSEA_API_KEY. There is no on-chain record of this stage's window or price before it opens, which is why its price column shows an em dash rather than a number.",
    },
    precheckEligibility: {
      level: "no",
      reason:
        "OpenSea publishes no eligibility endpoint. The only probe is the mint request itself, made as the wallet, and it answers only once the stage is open — 403 means not eligible. Before open, eligibility is genuinely unknown, and intern reports it as unknown rather than showing a tick it cannot justify.",
    },
    preSign: {
      level: "no",
      reason:
        "mintSigned() carries a server signature bound to this minter, this quantity and one salt, and OpenSea does not issue it before the stage opens. The calldata therefore does not exist in advance. This is a property of OpenSea's design and no amount of engineering on this side removes it.",
    },
    fireUnattended: {
      level: "yes",
      note: "Requires OPENSEA_API_KEY and ALLOWLIST_MINTING=1. intern polls for the signature from T-60s and broadcasts the instant one is issued.",
    },
    fireSpeed: {
      class: "api-bound",
      detail:
        "Slower than a public mint, and no engineering changes that. One HTTPS round trip to OpenSea sits inside the race — request, signature, sign, broadcast — where a public mint has already written its bytes. Everything that can be hoisted out of that window is: nonce, fees, balance checks, gas, warm TLS to both OpenSea's origin and the RPC endpoints.",
    },
  },
  {
    mechanism: "team-reserved",
    title: "Team / reserve",
    method: null,
    detectWindow: {
      level: "warn",
      reason: "Visible in OpenSea's drop configuration with an API key; no contract getter exposes it.",
    },
    precheckEligibility: {
      level: "no",
      reason: "Eligibility is 'do you hold the team wallet', which cannot be determined from outside the collection.",
    },
    preSign: { level: "no", reason: "No calldata path — see fireUnattended." },
    fireUnattended: {
      level: "no",
      reason:
        "Team and reserve stages are minted by the collection's own wallet through OpenSea's interface. If you hold that wallet and the stage is a standard signed stage, it is classified as an OpenSea-signed stage instead and is fireable on that row. intern does not attempt this row.",
    },
    fireSpeed: { class: "none", detail: "Not fireable — see above." },
  },
  {
    mechanism: "unknown",
    title: "Unclassified",
    method: null,
    detectWindow: {
      level: "warn",
      reason: "Whatever OpenSea reported is shown, but intern could not tell what kind of stage it is from its type and label.",
    },
    precheckEligibility: {
      level: "no",
      reason: "Unknown mechanism — there is nothing to check against.",
    },
    preSign: { level: "no", reason: "Unknown mechanism — no calldata can be built." },
    fireUnattended: {
      level: "no",
      reason:
        "A stage intern cannot name is a stage it cannot reason about. It is shown in the table so it is never silently dropped, and it is never fired at.",
    },
    fireSpeed: { class: "none", detail: "Not fireable — unclassified." },
  },
] as const;

const BY_MECHANISM = new Map<MintMechanism, MechanismCapability>(
  CAPABILITIES.map((c) => [c.mechanism, c]),
);

export function capabilityFor(mechanism: MintMechanism): MechanismCapability {
  const found = BY_MECHANISM.get(mechanism);
  // Every mechanism in the union has a row; the union and the table are edited
  // together. Throwing beats returning a permissive default if that ever slips.
  if (!found) throw new Error(`No capability row for mechanism "${mechanism}".`);
  return found;
}

/**
 * What intern has learned on-chain about how a gated stage is authorised.
 *
 * Both fields are discovered, never assumed: a collection can be configured for
 * either mechanism, and which one applies is not something a stage's *name*
 * tells you.
 */
export interface MechanismEvidence {
  /** A non-zero allow-list Merkle root is configured on this collection. */
  merkleRoot: boolean;
  /** The configured SeaDrop signer is a wallet intern holds a key for. */
  localSigner: boolean;
}

export const NO_EVIDENCE: MechanismEvidence = { merkleRoot: false, localSigner: false };

/**
 * Map a stage kind onto the mechanism that would fire it.
 *
 * Precedence for gated stages is Merkle → local signer → OpenSea, because that
 * is the order of decreasing certainty: a Merkle proof is verifiable offline
 * against an on-chain root, a local signer is under the operator's control, and
 * an OpenSea signature is a request to a third party that may be refused.
 *
 * A configured Merkle root does not prove *this* wallet is in the tree — only
 * that the mechanism exists. Eligibility resolves that, and a wallet with no
 * proof falls back to the OpenSea path rather than being declared ineligible.
 */
export function mechanismFor(kind: StageKind, evidence: MechanismEvidence): MintMechanism {
  switch (kind) {
    case "public":
      return "public";
    case "team":
      return "team-reserved";
    case "unknown":
      return "unknown";
    case "allowlist":
    case "gtd":
    case "fcfs":
      if (evidence.merkleRoot) return "merkle-allowlist";
      if (evidence.localSigner) return "local-signed";
      return "opensea-signed";
  }
}

/** Runtime conditions that can withhold a capability the mechanism itself has. */
export interface FireContext {
  /** The ALLOWLIST_MINTING flag. Off by default; off means public-only. */
  allowlistMinting: boolean;
  /** OPENSEA_API_KEY is set. */
  openseaApiKey: boolean;
  /** A Merkle proof was found for at least one loaded wallet. */
  merkleProof: boolean;
}

export const PUBLIC_ONLY: FireContext = {
  allowlistMinting: false,
  openseaApiKey: false,
  merkleProof: false,
};

/**
 * The mechanism's intrinsic capability, narrowed by what this deployment has.
 *
 * Never widens: a mechanism that cannot be fired at all stays unfireable no
 * matter what is configured.
 */
export function canFire(mechanism: MintMechanism, ctx: FireContext): Capability {
  const intrinsic = capabilityFor(mechanism).fireUnattended;
  if (intrinsic.level === "no") return intrinsic;

  if (mechanism === "public") return intrinsic;

  if (!ctx.allowlistMinting) {
    return {
      level: "no",
      reason:
        // The first sentence carries the fix, because that is the part a one-line
        // table cell shows. "Gated stages are off by default" is true and useless
        // on its own — it tells an operator nothing they can do about it.
        "Set ALLOWLIST_MINTING=1 to let intern fire at allowlist, GTD and FCFS stages. Gated stages are off by default, so that a misread drop cannot spend funds at a stage the operator did not choose to enter.",
    };
  }

  switch (mechanism) {
    case "merkle-allowlist":
      return ctx.merkleProof
        ? intrinsic
        : {
            level: "no",
            reason:
              "A Merkle root is configured on this collection but no loaded wallet has a proof for it. Being absent from the tree is a definitive answer, not a missing input.",
          };
    case "opensea-signed":
      return ctx.openseaApiKey
        ? intrinsic
        : {
            level: "no",
            reason:
              "This stage's signature comes from OpenSea, which requires OPENSEA_API_KEY. Without it intern cannot request one and will not pretend the stage is reachable.",
          };
    default:
      return intrinsic;
  }
}

/** Convenience for the selector: fireable means exactly level "yes". */
export function isFireable(mechanism: MintMechanism, ctx: FireContext): boolean {
  return canFire(mechanism, ctx).level === "yes";
}

/** The stated cause, for a row that cannot be fired. Empty string when it can. */
export function notFireableReason(mechanism: MintMechanism, ctx: FireContext): string {
  const verdict = canFire(mechanism, ctx);
  return verdict.level === "yes" ? "" : verdict.reason;
}
