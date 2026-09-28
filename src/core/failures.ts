// Structured failure classification.
//
// Every way a mint can fail reduced to one of a fixed set of codes, so that the
// scheduler can decide what to do without parsing prose, and the operator is told
// which of their inputs to look at.
//
// The motivating problem is HTTP 422. OpenSea returns it for "not on the
// allowlist", "per-wallet limit reached", "supply exhausted" and "balance too
// low" alike, and the old code collapsed all four into one retryable error. Three
// of those four are temporary and one is permanent, so the collapse meant a task
// either gave up on a mint it could still win or retried one it had already lost.
//
// Two rules keep this honest:
//
//   A code is a claim, and an unsupported claim is worse than no claim. Where the
//   evidence genuinely does not distinguish two causes, the result is UNKNOWN with
//   `alternatives` listing what it could have been — not a confident guess. A
//   wrong code is acted on; UNKNOWN is investigated.
//
//   Eligibility has one source of truth. `/drops/{slug}/eligibility` answers
//   whether a wallet may mint, and it answers before the stage opens. A 403 on
//   that endpoint means our *credential* was refused, never that the wallet was —
//   so it classifies as an auth problem. Reading a 403 as "not eligible" is how a
//   scope typo becomes a wallet that silently stops trying.

import { id as keccakId } from "ethers";

/**
 * Every terminal reason a mint task can stop.
 *
 * Fixed by specification. Do not add a code without deciding its retryability and
 * its remedy, because the scheduler branches on the former and the operator reads
 * the latter.
 */
export type FailureCode =
  // Credentials
  | "AUTH_EXPIRED"
  | "AUTH_INVALID"
  | "API_KEY_INVALID"
  // Eligibility and schedule
  | "ELIGIBILITY_FALSE"
  | "DROP_NOT_ACTIVE"
  | "STAGE_NOT_ACTIVE"
  | "WALLET_NOT_ELIGIBLE"
  | "MINT_LIMIT_REACHED"
  // Money
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_GAS"
  | "GAS_TOO_HIGH"
  // Execution
  | "SIMULATION_REVERT"
  | "NONCE_CONFLICT"
  | "RPC_TIMEOUT"
  | "RPC_RATE_LIMIT"
  | "BROADCAST_FAILED"
  | "RECEIPT_TIMEOUT"
  | "TX_REVERTED"
  | "SUPPLY_EXHAUSTED"
  | "UNKNOWN";

/** Which system produced the failure. Distinguishes an OpenSea 429 from an RPC one. */
export type FailureSource = "opensea" | "chain" | "local";

export interface FailureMeta {
  /** One line, operator-facing. No credential ever reaches this string. */
  readonly title: string;
  /**
   * Could the identical operation succeed if repeated?
   *
   * Distinct from {@link terminal}: a stage that has not opened is not retryable
   * *now* but is also not terminal, because waiting fixes it. Retryable means
   * "try again immediately"; non-terminal means "this task still has a future".
   */
  readonly retryable: boolean;
  /** True when no amount of waiting or retrying can change the answer. */
  readonly terminal: boolean;
  /** What the operator should change, or "" when there is nothing to change. */
  readonly remedy: string;
}

/**
 * The fixed properties of each code.
 *
 * Exhaustive by construction: `Record<FailureCode, …>` means adding a code to the
 * union without describing it here is a compile error rather than a code that
 * silently reads as retryable.
 */
export const FAILURE_META: Record<FailureCode, FailureMeta> = {
  AUTH_EXPIRED: {
    title: "The wallet token expired",
    // Retryable because the recovery is automatic: a refresh produces a new JWT
    // and the same call then succeeds. This is the one auth code that is not a
    // configuration problem, so it deliberately carries no remedy.
    retryable: true,
    terminal: false,
    remedy: "",
  },
  AUTH_INVALID: {
    title: "OpenSea rejected the scoped token",
    retryable: false,
    terminal: true,
    remedy: "Check OPENSEA_SCOPED_TOKEN is current and carries the read:eligibility scope.",
  },
  API_KEY_INVALID: {
    title: "OpenSea rejected the API key",
    retryable: false,
    terminal: true,
    remedy: "Check OPENSEA_API_KEY.",
  },
  ELIGIBILITY_FALSE: {
    // The authoritative answer: the eligibility endpoint said is_eligible=false.
    // Terminal for this wallet and stage — the allowlist is not going to change
    // while the stage runs.
    title: "OpenSea says this wallet is not eligible for this stage",
    retryable: false,
    terminal: true,
    remedy: "Use a wallet on the list, or wait for a stage this wallet is eligible for.",
  },
  DROP_NOT_ACTIVE: {
    title: "The drop is not currently mintable",
    retryable: false,
    terminal: false,
    remedy: "",
  },
  STAGE_NOT_ACTIVE: {
    title: "This stage is not open yet",
    retryable: false,
    terminal: false,
    remedy: "",
  },
  WALLET_NOT_ELIGIBLE: {
    // The *inferred* sibling of ELIGIBILITY_FALSE: the mint endpoint or an
    // on-chain revert implied non-eligibility. Kept separate because the
    // provenance differs, and provenance is what an operator needs in order to
    // decide whether to trust it.
    title: "This wallet was refused at mint time",
    retryable: false,
    terminal: true,
    remedy: "Confirm the wallet is on the allowlist for the stage being minted.",
  },
  MINT_LIMIT_REACHED: {
    title: "This wallet has already minted its allowance",
    retryable: false,
    terminal: true,
    remedy: "",
  },
  INSUFFICIENT_BALANCE: {
    title: "The wallet cannot cover the mint price plus gas",
    retryable: false,
    terminal: false,
    remedy: "Fund the wallet, or lower QUANTITY.",
  },
  INSUFFICIENT_GAS: {
    title: "The gas limit is too low to execute the mint",
    retryable: false,
    terminal: false,
    remedy: "Raise GAS_LIMIT.",
  },
  GAS_TOO_HIGH: {
    title: "The network's gas price exceeds the configured ceiling",
    // Retryable because base fee falls as often as it rises; the next block may
    // come in under the ceiling without anyone changing anything.
    retryable: true,
    terminal: false,
    remedy: "Raise MAX_FEE_PER_GAS, or leave it unset to track the live base fee.",
  },
  SIMULATION_REVERT: {
    title: "The mint reverted when simulated",
    retryable: false,
    terminal: false,
    remedy: "",
  },
  NONCE_CONFLICT: {
    // Retryable after re-reading the nonce. Reaching this at all points at two
    // things using one wallet concurrently, which the wallet lock exists to stop.
    title: "The wallet's nonce was already used",
    retryable: true,
    terminal: false,
    remedy: "",
  },
  RPC_TIMEOUT: {
    title: "The upstream did not respond in time",
    retryable: true,
    terminal: false,
    remedy: "",
  },
  RPC_RATE_LIMIT: {
    title: "Rate limited by the upstream",
    retryable: true,
    terminal: false,
    remedy: "A dedicated RPC endpoint avoids this during a contested mint.",
  },
  BROADCAST_FAILED: {
    title: "The signed transaction was not accepted by any endpoint",
    retryable: true,
    terminal: false,
    remedy: "",
  },
  RECEIPT_TIMEOUT: {
    // Emphatically not terminal, and the one code where "failed" is a lie: the
    // transaction is broadcast and may still confirm. Re-signing here is how a
    // wallet mints twice and pays twice.
    title: "No receipt within the timeout — the transaction may still confirm",
    retryable: false,
    terminal: false,
    remedy: "Check the transaction hash on a block explorer before retrying.",
  },
  TX_REVERTED: {
    title: "The transaction was mined but reverted",
    retryable: false,
    terminal: false,
    remedy: "",
  },
  SUPPLY_EXHAUSTED: {
    title: "The collection or stage is sold out",
    retryable: false,
    terminal: true,
    remedy: "",
  },
  UNKNOWN: {
    title: "The cause could not be determined",
    retryable: false,
    terminal: false,
    remedy: "",
  },
};

export interface Failure {
  readonly code: FailureCode;
  readonly source: FailureSource;
  /** Operator-facing, already redaction-safe: built from status and code, never from a credential. */
  readonly message: string;
  readonly retryable: boolean;
  readonly terminal: boolean;
  /** HTTP status, or null for a chain/local failure. */
  readonly status: number | null;
  /** What Retry-After asked for, when the upstream said. */
  readonly retryAfterMs: number | null;
  /**
   * Other codes the same evidence would support.
   *
   * Non-empty only alongside UNKNOWN, and the whole point of it: HTTP 422 has
   * four possible causes and naming all four is strictly more useful than
   * picking one at random.
   */
  readonly alternatives: readonly FailureCode[];
}

function build(
  code: FailureCode,
  source: FailureSource,
  opts: {
    detail?: string;
    status?: number | null;
    retryAfterMs?: number | null;
    alternatives?: readonly FailureCode[];
  } = {},
): Failure {
  const meta = FAILURE_META[code];
  const parts = [meta.title];
  if (opts.detail !== undefined && opts.detail.trim() !== "") parts.push(opts.detail.trim());
  if (meta.remedy !== "") parts.push(meta.remedy);
  return {
    code,
    source,
    message: parts.join(" — "),
    retryable: meta.retryable,
    terminal: meta.terminal,
    status: opts.status ?? null,
    retryAfterMs: opts.retryAfterMs ?? null,
    alternatives: opts.alternatives ?? [],
  };
}

/** Which OpenSea endpoint a failure came from. Decides which credential a 401 accuses. */
export type OpenSeaEndpoint = "exchange" | "eligibility" | "mint" | "drop" | "collection";

/**
 * What is already known about the wallet, used to resolve an ambiguous 422.
 *
 * Supplying this is what upgrades a 422 from UNKNOWN to a definite code, and it
 * is the concrete payoff of having a real eligibility endpoint: the mint
 * endpoint's refusal stops being a mystery once we independently know whether the
 * wallet was on the list and how much of its allowance it had left.
 */
export interface EligibilityHint {
  readonly isEligible: boolean;
  /** null when OpenSea stated no limit. */
  readonly maxMintable: number | null;
  readonly mintedSoFar?: number | null;
}

/** The four things OpenSea's 422 can mean, in the order an operator should check them. */
const AMBIGUOUS_422: readonly FailureCode[] = [
  "WALLET_NOT_ELIGIBLE",
  "MINT_LIMIT_REACHED",
  "SUPPLY_EXHAUSTED",
  "INSUFFICIENT_BALANCE",
];

/**
 * Classify an OpenSea HTTP failure.
 *
 * The endpoint matters as much as the status. A 401 from the exchange is a verdict
 * on the durable scoped token and is fatal; the identical status from the
 * eligibility endpoint is almost always just an aged-out JWT, which the auth
 * manager fixes by refreshing. Naming the wrong credential sends the operator to
 * rotate a token that was never the problem — which is precisely the failure this
 * whole auth chain was rebuilt to escape.
 */
export function classifyOpenSeaFailure(
  err: { status: number; message?: string; retryAfterMs?: number | null },
  ctx: { endpoint: OpenSeaEndpoint; eligibility?: EligibilityHint | null },
): Failure {
  const status = err.status;
  const retryAfterMs = err.retryAfterMs ?? null;
  const at = { status, retryAfterMs };
  const walletScoped = ctx.endpoint === "exchange" || ctx.endpoint === "eligibility";

  // Status 0 is this codebase's "never reached the server".
  if (status === 0) {
    return build("RPC_TIMEOUT", "opensea", { ...at, detail: "OpenSea was unreachable" });
  }

  if (status === 400) {
    return ctx.endpoint === "exchange"
      ? build("AUTH_INVALID", "opensea", {
          ...at,
          detail: "the token exchange rejected the request as malformed",
        })
      : build("UNKNOWN", "opensea", { ...at, detail: "OpenSea rejected the request as malformed" });
  }

  if (status === 401) {
    if (ctx.endpoint === "exchange") {
      return build("AUTH_INVALID", "opensea", { ...at, detail: "the scoped token was refused" });
    }
    if (ctx.endpoint === "eligibility") {
      // Ambiguous between an expired JWT and a bad API key, and resolved by
      // escalation rather than by guessing: treat it as expiry, refresh once, and
      // if the exchange itself then 401s that call reports AUTH_INVALID with
      // certainty. Guessing API_KEY_INVALID here would skip the refresh that
      // fixes the common case.
      return build("AUTH_EXPIRED", "opensea", { ...at, detail: "refreshing and retrying once" });
    }
    return build("API_KEY_INVALID", "opensea", at);
  }

  if (status === 403) {
    // Never ELIGIBILITY_FALSE. A 403 is a statement about the caller's
    // permissions, not about the wallet's place on a list.
    return walletScoped
      ? build("AUTH_INVALID", "opensea", {
          ...at,
          detail: "the token lacks the scope this endpoint needs",
        })
      : build("API_KEY_INVALID", "opensea", {
          ...at,
          detail: "the key lacks drop permissions",
        });
  }

  if (status === 404) {
    return build("DROP_NOT_ACTIVE", "opensea", {
      ...at,
      detail: "OpenSea has no drop for this collection",
    });
  }

  if (status === 409) {
    // Unambiguous: the drop exists and is closed. Whether that is "not started",
    // "ended" or "paused" is not stated, so the code stays at the drop level and
    // the schedule — which we hold independently — says which.
    return build("DROP_NOT_ACTIVE", "opensea", {
      ...at,
      detail: "not started, ended, or paused",
    });
  }

  if (status === 422) {
    const hint = ctx.eligibility;
    if (hint) {
      if (!hint.isEligible) {
        return build("WALLET_NOT_ELIGIBLE", "opensea", {
          ...at,
          detail: "OpenSea's eligibility check agrees",
        });
      }
      const minted = hint.mintedSoFar ?? null;
      if (hint.maxMintable !== null && minted !== null && minted >= hint.maxMintable) {
        return build("MINT_LIMIT_REACHED", "opensea", {
          ...at,
          detail: `${minted} of ${hint.maxMintable} already minted`,
        });
      }
      // Eligible with allowance left, yet refused: the remaining causes are
      // supply and balance, and narrowing to two beats naming four.
      return build("UNKNOWN", "opensea", {
        ...at,
        detail: "the wallet is eligible with allowance left, so the refusal is supply or balance",
        alternatives: ["SUPPLY_EXHAUSTED", "INSUFFICIENT_BALANCE"],
      });
    }
    return build("UNKNOWN", "opensea", {
      ...at,
      detail: "OpenSea could not build a mint and does not say why",
      alternatives: AMBIGUOUS_422,
    });
  }

  if (status === 429) {
    // The code name says RPC because the taxonomy is fixed; `source` is what
    // distinguishes an OpenSea limit from a node's.
    return build("RPC_RATE_LIMIT", "opensea", { ...at, detail: "OpenSea rate limit" });
  }

  if (status >= 500) {
    return build("RPC_TIMEOUT", "opensea", { ...at, detail: `OpenSea server error (${status})` });
  }

  return build("UNKNOWN", "opensea", { ...at, detail: `HTTP ${status}` });
}

// ── On-chain failures ────────────────────────────────────────────────────────

/**
 * SeaDrop's custom errors, by selector.
 *
 * Selectors are derived from the signatures at load rather than pasted as hex, so
 * the source states which error each one is and the derivation is checkable. The
 * approach is verified against the one selector this codebase already knew
 * independently: `MintQuantityExceedsMaxMintedPerWallet` is 0xedc01273, and this
 * table reproduces it.
 *
 * A signature that is subtly wrong produces a selector that never matches, which
 * degrades to UNKNOWN — so an error in this table costs a diagnosis, never a
 * wrong one.
 */
const SEADROP_ERRORS: { signature: string; code: FailureCode; detail: string }[] = [
  {
    signature: "NotActive(uint256,uint256,uint256)",
    code: "STAGE_NOT_ACTIVE",
    detail: "the contract says this stage is not open",
  },
  {
    signature: "MintQuantityExceedsMaxMintedPerWallet(uint256,uint256)",
    code: "MINT_LIMIT_REACHED",
    detail: "the per-wallet cap was reached",
  },
  {
    signature: "MintQuantityExceedsMaxSupply(uint256,uint256)",
    code: "SUPPLY_EXHAUSTED",
    detail: "the collection is sold out",
  },
  {
    signature: "MintQuantityExceedsMaxTokenSupplyForStage(uint256,uint256)",
    code: "SUPPLY_EXHAUSTED",
    detail: "this stage's allocation is exhausted",
  },
  {
    signature: "InvalidProof()",
    code: "WALLET_NOT_ELIGIBLE",
    detail: "the Merkle proof was rejected — this wallet is not in the on-chain allowlist",
  },
  {
    signature: "InvalidSignature(address)",
    code: "WALLET_NOT_ELIGIBLE",
    detail: "the mint signature did not recover to an allowed signer",
  },
  {
    signature: "SignerNotPresent()",
    code: "WALLET_NOT_ELIGIBLE",
    detail: "the contract has no allowed signer for this stage",
  },
  {
    signature: "IncorrectPayment(uint256,uint256)",
    code: "SIMULATION_REVERT",
    detail: "the value sent did not match the stage price",
  },
  {
    signature: "FeeRecipientNotAllowed()",
    code: "SIMULATION_REVERT",
    detail: "the fee recipient is not allowed by the contract",
  },
  {
    signature: "MintQuantityCannotBeZero()",
    code: "SIMULATION_REVERT",
    detail: "quantity was zero",
  },
];

const SELECTOR_CODES = new Map<string, { code: FailureCode; detail: string }>(
  SEADROP_ERRORS.map((e) => [
    keccakId(e.signature).slice(0, 10).toLowerCase(),
    { code: e.code, detail: e.detail },
  ]),
);

/** Textual revert reasons, for nodes that return a string rather than a custom error. */
const REVERT_TEXT: { pattern: RegExp; code: FailureCode }[] = [
  { pattern: /not\s*active|stage.*(not open|closed)|sale.*not.*(started|active)/i, code: "STAGE_NOT_ACTIVE" },
  { pattern: /sold\s*out|exceeds\s*max\s*supply|max\s*supply\s*reached|supply.*exhausted/i, code: "SUPPLY_EXHAUSTED" },
  { pattern: /exceeds.*(per\s*wallet|wallet\s*(cap|limit))|already\s*minted|wallet mint cap/i, code: "MINT_LIMIT_REACHED" },
  { pattern: /invalid\s*(proof|signature)|not\s*(allow\s*listed|whitelisted)|signer\s*not/i, code: "WALLET_NOT_ELIGIBLE" },
  { pattern: /insufficient\s*(funds|balance)/i, code: "INSUFFICIENT_BALANCE" },
  { pattern: /incorrect\s*payment|wrong\s*(price|value)/i, code: "SIMULATION_REVERT" },
];

/**
 * Classify a revert from its raw data or message.
 *
 * `fallback` decides what an unrecognised revert is called, and the caller knows
 * that when this module does not: the same opaque blob is SIMULATION_REVERT from
 * an `eth_call` and TX_REVERTED from a receipt, and the difference is whether
 * money was spent.
 */
export function classifyRevert(
  raw: string,
  fallback: "SIMULATION_REVERT" | "TX_REVERTED" = "SIMULATION_REVERT",
): Failure {
  const text = String(raw ?? "");

  for (const match of text.matchAll(/0x([0-9a-fA-F]{8,})/g)) {
    const body = match[1] ?? "";
    // ABI-encoded revert data is a 4-byte selector plus whole 32-byte words.
    // Requiring that shape keeps an address or a tx hash in the message from
    // being read as a selector.
    if ((body.length - 8) % 64 !== 0) continue;
    const hit = SELECTOR_CODES.get(`0x${body.slice(0, 8).toLowerCase()}`);
    if (hit) return build(hit.code, "chain", { detail: hit.detail });
  }

  for (const { pattern, code } of REVERT_TEXT) {
    if (pattern.test(text)) return build(code, "chain", { detail: "from the revert reason" });
  }

  return build(fallback, "chain", {
    detail: text.trim() === "" ? "no reason given" : "reason not recognised",
  });
}

/** Where in the execution path a chain error happened. Decides several codes. */
export type ChainPhase = "gas" | "balance" | "simulate" | "nonce" | "broadcast" | "receipt";

interface ChainErrorish {
  code?: unknown;
  shortMessage?: unknown;
  message?: unknown;
  info?: unknown;
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err === null || typeof err !== "object") return String(err);
  const e = err as ChainErrorish;
  const parts: string[] = [];
  for (const candidate of [e.shortMessage, e.message]) {
    if (typeof candidate === "string") parts.push(candidate);
  }
  // Providers bury the node's own words in `info`, and that is often the only
  // place the revert reason appears.
  if (e.info !== undefined) {
    try {
      parts.push(JSON.stringify(e.info));
    } catch {
      // Circular or unserialisable — the messages above are enough.
    }
  }
  return parts.join(" ");
}

/**
 * Classify an RPC or ethers error.
 *
 * ethers' own `code` is checked before the message, because it is a stable enum
 * while the message is whatever the node operator's software chose to say.
 */
export function classifyChainFailure(err: unknown, phase: ChainPhase): Failure {
  const text = messageOf(err);
  const ethersCode =
    err !== null && typeof err === "object" && typeof (err as ChainErrorish).code === "string"
      ? ((err as ChainErrorish).code as string)
      : "";

  const revertFallback = phase === "receipt" ? "TX_REVERTED" : "SIMULATION_REVERT";

  switch (ethersCode) {
    case "INSUFFICIENT_FUNDS":
      return build("INSUFFICIENT_BALANCE", "chain", { detail: "the node rejected the transaction" });
    case "NONCE_EXPIRED":
    case "REPLACEMENT_UNDERPRICED":
      return build("NONCE_CONFLICT", "chain", { detail: "another transaction used this nonce" });
    case "CALL_EXCEPTION":
      return classifyRevert(text, revertFallback);
    case "TIMEOUT":
      return build("RPC_TIMEOUT", "chain", {});
    case "UNPREDICTABLE_GAS_LIMIT":
      // The node refuses to estimate, which it does when the call reverts. Calling
      // it a gas problem would send the operator to raise a limit that is fine.
      return classifyRevert(text, revertFallback);
  }

  if (/nonce too low|nonce has already been used|already known|replacement transaction underpriced/i.test(text)) {
    return build("NONCE_CONFLICT", "chain", { detail: "another transaction used this nonce" });
  }
  if (/insufficient funds|insufficient balance/i.test(text)) {
    return build("INSUFFICIENT_BALANCE", "chain", { detail: "the node rejected the transaction" });
  }
  if (/intrinsic gas too low|gas limit(?: is)? too low|out of gas/i.test(text)) {
    return build("INSUFFICIENT_GAS", "chain", {});
  }
  if (/max fee per gas less than block base fee|fee cap less than block base fee|transaction underpriced/i.test(text)) {
    return build("GAS_TOO_HIGH", "chain", {
      detail: "the base fee moved above the configured ceiling",
    });
  }
  if (/429|too many requests|rate limit|exceeded.*(compute|quota|capacity)/i.test(text)) {
    return build("RPC_RATE_LIMIT", "chain", {});
  }
  if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)) {
    return build("RPC_TIMEOUT", "chain", {});
  }
  if (/revert/i.test(text)) {
    return classifyRevert(text, revertFallback);
  }
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|network error|fetch failed/i.test(text)) {
    // Identical transport failures mean different things by phase: before
    // broadcast nothing was spent, and after it a transaction may be in flight.
    return phase === "broadcast"
      ? build("BROADCAST_FAILED", "chain", { detail: "the endpoint could not be reached" })
      : build("RPC_TIMEOUT", "chain", { detail: "the endpoint could not be reached" });
  }

  if (phase === "broadcast") {
    return build("BROADCAST_FAILED", "chain", { detail: "reason not recognised" });
  }
  return build("UNKNOWN", "chain", { detail: `reason not recognised during ${phase}` });
}

/** A failure that did not come from an upstream — a failed safety gate, say. */
export function localFailure(code: FailureCode, detail?: string): Failure {
  return build(code, "local", detail !== undefined ? { detail } : {});
}

/** `AUTH_EXPIRED` is the one code whose recovery is "refresh the token and repeat". */
export function isRefreshable(failure: Failure): boolean {
  return failure.code === "AUTH_EXPIRED";
}

/**
 * Should the scheduler keep this task alive?
 *
 * Deliberately not `!terminal`: RECEIPT_TIMEOUT is non-terminal but must never be
 * retried automatically, because the transaction it describes may already be
 * confirming and a second one would mint and pay twice.
 */
export function shouldKeepWaiting(failure: Failure): boolean {
  if (failure.terminal) return false;
  return failure.code !== "RECEIPT_TIMEOUT";
}
