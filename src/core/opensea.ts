// OpenSea API: drop schedules and allowlist mint construction.
//
// Only one thing genuinely requires OpenSea, and it is worth being precise about
// what: an allowlist or FCFS stage mints through `mintSigned()`, whose signature
// is produced by OpenSea's server and bound to one minter, one quantity and one
// salt. There is no local equivalent — not because the calldata is secret, but
// because the signature cannot be forged.
//
// Everything else here is *scheduling* information: which stages exist, when they
// open, which type they are. That is useful but not authoritative, so it is only
// ever used to decide what to wait for. The transaction that gets signed is always
// verified against on-chain state first (see verifyAllowlistTx).
//
// The threat model for this file is that the API response is attacker-controlled.
// A compromised or spoofed response must not be able to make us sign a transfer,
// an approval, or a mint to someone else's address — hence every field is checked
// against independently known values rather than trusted.

import { Interface, ZeroAddress, getAddress } from "ethers";
import { resolveChain } from "./chains";
import { SEADROP_V1 } from "./seadrop";

const API_BASE = "https://api.opensea.io/api/v2";
const REQUEST_TIMEOUT_MS = 20_000;

const MINT_PARAMS =
  "tuple(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)";

export const allowlistInterface = new Interface([
  `function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,${MINT_PARAMS} mintParams,uint256 salt,bytes signature) payable`,
  `function mintAllowList(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,${MINT_PARAMS} mintParams,bytes32[] proof) payable`,
  // v2 token-contract equivalents: no nftContract argument, the token is the target.
  `function mintSigned(address feeRecipient,address minterIfNotPayer,uint256 quantity,${MINT_PARAMS} mintParams,uint256 salt,bytes signature) payable`,
  `function mintAllowList(address feeRecipient,address minterIfNotPayer,uint256 quantity,${MINT_PARAMS} mintParams,bytes32[] proof) payable`,
]);

export class OpenSeaError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * What Retry-After asked for, in ms, when the response carried one.
     *
     * Honouring it matters more than it looks: during a contested stage the
     * signature endpoint rate-limits hard, and a client that ignores the header
     * and keeps hammering stays limited for longer than one that waits. The
     * polite path is the fast path here.
     */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "OpenSeaError";
  }

  /**
   * Does this status mean "try again at the next stage" rather than "give up"?
   *
   * 409 is unambiguous: the drop is not currently mintable. 422 is the awkward
   * one — it covers not-on-the-allowlist, per-wallet limit reached, supply
   * exhausted and insufficient balance, with no way to distinguish them. It is
   * therefore treated as retryable but never reported as "not eligible", because
   * three of those four causes are temporary and one is not.
   */
  get retryable(): boolean {
    return this.status === 409 || this.status === 422 || this.status === 429;
  }
}

const STATUS_REASONS: Record<number, string> = {
  400: "OpenSea rejected the request as malformed",
  401: "OPENSEA_API_KEY is missing or invalid",
  403: "OpenSea denied access — the key may lack drop permissions",
  404: "No drop found for this collection",
  409: "Drop is not open: not started, ended, or paused",
  422: "OpenSea could not build a mint (wallet not allowlisted, limit reached, supply exhausted, or balance too low)",
  429: "Rate limited by OpenSea — retry shortly",
  500: "OpenSea server error",
  502: "OpenSea gateway error",
  503: "OpenSea temporarily unavailable",
};

/**
 * Parse a Retry-After header into a delay in ms.
 *
 * Two formats are legal and both appear in the wild: a count of seconds, and an
 * HTTP date. A date in the past yields 0, not a negative — the request is due
 * now, and a negative would read as "no header" to a caller checking for null.
 *
 * `nowMs` is passed in rather than read so the date branch is testable without
 * waiting for wall-clock time to move.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

async function request<T>(
  path: string,
  opts: { apiKey?: string; body?: object; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  if (opts.body) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.body ? "POST" : "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      // A redirect off api.opensea.io would send the API key to another host.
      redirect: "error",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OpenSeaError(0, `Could not reach OpenSea: ${message}`);
  }

  if (!res.ok) {
    const reason = STATUS_REASONS[res.status] ?? "OpenSea API error";
    throw new OpenSeaError(
      res.status,
      `${reason} (HTTP ${res.status}).`,
      parseRetryAfter(res.headers.get("retry-after"), Date.now()),
    );
  }
  return (await res.json()) as T;
}

// ── Collections ──────────────────────────────────────────────────────────────

export interface CollectionInfo {
  name: string;
  slug: string;
  contractAddress: string;
  chain: string;
}

/**
 * Resolve a collection slug to a contract address.
 *
 * The key is optional here: OpenSea's collections endpoint often answers
 * unauthenticated. It is always attempted, because the alternative — refusing to
 * look up a slug without a key — pushes users toward pasting an address they
 * found somewhere less trustworthy.
 */
export async function resolveCollection(
  slug: string,
  apiKey?: string,
  preferredChain?: string,
): Promise<CollectionInfo> {
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(slug)) throw new Error(`Invalid collection slug: "${slug}"`);

  const json = await request<{
    name?: string;
    collection?: string;
    contracts?: { address: string; chain: string }[];
  }>(`/collections/${encodeURIComponent(slug)}`, apiKey ? { apiKey } : {});

  const contracts = json.contracts ?? [];
  if (contracts.length === 0) throw new Error(`No contract listed for collection "${slug}".`);

  // Prefer the contract on the chain we intend to mint on. A collection listed on
  // several chains has a different address on each, and picking the first would
  // silently target the wrong network.
  const wanted = preferredChain?.trim().toLowerCase();
  const picked = wanted
    ? contracts.find((c) => c.chain?.toLowerCase() === wanted) ?? contracts[0]
    : contracts[0];

  if (!picked) {
    throw new Error(`cannot resolve target to a contract address: ${slug}`);
  }

  return {
    name: json.name ?? slug,
    slug: json.collection ?? slug,
    contractAddress: getAddress(picked.address),
    chain: picked.chain,
  };
}

// ── Drop schedules ───────────────────────────────────────────────────────────

export type StageType = "public_sale" | "presale" | "allowlist" | string;

export interface DropStage {
  type: StageType;
  label: string;
  startMs: number;
  endMs: number;
  isPublic: boolean;
}

export interface DropSchedule {
  slug: string;
  chain: string;
  contractAddress: string;
  stages: DropStage[];
}

interface RawDrop {
  chain?: string;
  contract_address?: string;
  stages?: { stage_type?: string; label?: string; start_time?: string; end_time?: string }[];
}

export async function fetchDropSchedule(slug: string, apiKey: string): Promise<DropSchedule> {
  const raw = await request<RawDrop>(`/drops/${encodeURIComponent(slug)}`, { apiKey });
  if (typeof raw.chain !== "string" || typeof raw.contract_address !== "string") {
    throw new Error("OpenSea drop response is missing chain or contract address.");
  }
  if (!Array.isArray(raw.stages)) {
    throw new Error("OpenSea returned no mint schedule for this drop.");
  }

  const stages: DropStage[] = raw.stages.map((stage, i) => {
    const startMs = Date.parse(stage.start_time ?? "");
    const endMs = Date.parse(stage.end_time ?? "");
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error(`Stage ${i + 1} has an invalid time range.`);
    }
    const type = stage.stage_type ?? "unknown";
    return {
      type,
      label: stage.label || type,
      startMs,
      endMs,
      isPublic: type === "public_sale",
    };
  });

  return {
    slug,
    chain: raw.chain,
    contractAddress: getAddress(raw.contract_address),
    stages: stages.sort((a, b) => a.startMs - b.startMs),
  };
}

export function liveStage(schedule: DropSchedule, nowMs: number): DropStage | undefined {
  return schedule.stages.find((s) => s.startMs <= nowMs && nowMs < s.endMs);
}

export function nextStage(schedule: DropSchedule, afterMs: number): DropStage | undefined {
  return schedule.stages.find((s) => s.startMs > afterMs);
}

/** Is there a non-public stage open now, or scheduled to open later? */
export function hasPresale(schedule: DropSchedule, nowMs: number): boolean {
  return schedule.stages.some((s) => !s.isPublic && s.endMs > nowMs);
}

// ── Allowlist mint construction ──────────────────────────────────────────────

export interface RawMintTx {
  chain: string;
  to: string;
  data: string;
  value: string;
}

/**
 * Ask OpenSea to build a mint transaction for one wallet.
 *
 * The response is untrusted input. It is never signed as returned — see
 * verifyAllowlistTx, which is the actual security boundary.
 */
export async function requestMintTx(
  slug: string,
  apiKey: string,
  minter: string,
  quantity: number,
): Promise<RawMintTx> {
  const json = await request<Partial<RawMintTx>>(`/drops/${encodeURIComponent(slug)}/mint`, {
    apiKey,
    body: { minter: getAddress(minter), quantity },
  });
  if (
    typeof json.chain !== "string" ||
    typeof json.to !== "string" ||
    typeof json.data !== "string" ||
    typeof json.value !== "string"
  ) {
    throw new Error("OpenSea mint response is missing required fields.");
  }
  return { chain: json.chain, to: json.to, data: json.data, value: json.value };
}

export interface VerifiedMintTx {
  to: string;
  data: string;
  value: bigint;
  method: string;
  stageIndex: string;
  mintPrice: bigint;
  startMs: number;
  endMs: number;
}

export interface VerifyContext {
  expectedChainKey: string;
  expectedContract: string;
  expectedMinter: string;
  expectedQuantity: number;
  /** For a v2 collection the transaction targets the token, not the singleton. */
  allowTokenTarget?: boolean;
  nowMs?: number;
}

/**
 * The decoded shape of a SeaDrop mint call.
 *
 * Declared rather than inferred because ethers returns a positional `Result` whose
 * named members are not visible to the type system. `nftContract` is optional: the
 * v1 form carries it, the v2 token-contract form does not.
 */
interface DecodedMintArgs {
  nftContract?: string;
  feeRecipient: string;
  minterIfNotPayer: string;
  quantity: bigint;
  mintParams: {
    mintPrice: bigint;
    maxTotalMintableByWallet: bigint;
    startTime: bigint;
    endTime: bigint;
    dropStageIndex: bigint;
    maxTokenSupplyForStage: bigint;
    feeBps: bigint;
    restrictFeeRecipients: boolean;
  };
}

/**
 * Verify an OpenSea-supplied transaction before it is signed.
 *
 * This is the security boundary of the allowlist path. The API response decides
 * what bytes get signed by the user's key, so every field is checked against a
 * value we know independently:
 *
 *   · the chain must be the one we selected      (else: wrong-network broadcast)
 *   · the target must be SeaDrop or the token    (else: arbitrary contract call)
 *   · the calldata must decode to a known mint   (else: transfer or approval)
 *   · the collection must be the one requested   (else: minting someone else's)
 *   · the recipient must be this wallet or zero  (else: minting to an attacker)
 *   · value must equal mintPrice × quantity      (else: overpayment)
 *   · the stage must be open right now           (else: guaranteed revert)
 *
 * Decoding is what makes this meaningful: an opaque `data` blob cannot be checked
 * at all, so anything that does not parse as a known mint function is refused
 * outright rather than passed through.
 */
export function verifyAllowlistTx(raw: RawMintTx, ctx: VerifyContext): VerifiedMintTx {
  const nowMs = ctx.nowMs ?? Date.now();
  const quantity = ctx.expectedQuantity;

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw new Error(`Quantity must be an integer in 1..1000, got ${quantity}.`);
  }
  if (raw.chain !== ctx.expectedChainKey) {
    throw new Error(
      `OpenSea returned a transaction for chain "${raw.chain}" but "${ctx.expectedChainKey}" was selected.`,
    );
  }
  if (!resolveChain(raw.chain)) throw new Error(`Unsupported chain "${raw.chain}".`);

  const to = getAddress(raw.to);
  const isSeaDrop = to === getAddress(SEADROP_V1);
  const isToken = to === getAddress(ctx.expectedContract);
  if (!isSeaDrop && !(ctx.allowTokenTarget !== false && isToken)) {
    throw new Error(`Transaction targets ${to}, which is neither SeaDrop nor the collection.`);
  }

  if (!/^\d+$/.test(raw.value)) throw new Error(`Invalid transaction value "${raw.value}".`);
  const value = BigInt(raw.value);

  let method: string;
  let args: DecodedMintArgs;
  try {
    const parsed = allowlistInterface.parseTransaction({ data: raw.data });
    if (!parsed) throw new Error("unrecognised");
    method = parsed.name;
    args = parsed.args as unknown as DecodedMintArgs;
  } catch {
    throw new Error(
      "OpenSea returned calldata that is not a recognised SeaDrop mint — refusing to sign it.",
    );
  }

  // The v1 form carries nftContract as the first argument; the v2 form does not.
  if (args.nftContract !== undefined) {
    if (getAddress(args.nftContract) !== getAddress(ctx.expectedContract)) {
      throw new Error("Calldata mints a different collection than the one requested.");
    }
  } else if (!isToken) {
    throw new Error("Token-contract mint calldata must target the collection itself.");
  }

  if (BigInt(args.quantity) !== BigInt(quantity)) {
    throw new Error(`Calldata mints ${args.quantity} tokens, not the requested ${quantity}.`);
  }

  const minterIfNotPayer = getAddress(args.minterIfNotPayer);
  if (
    minterIfNotPayer !== getAddress(ZeroAddress) &&
    minterIfNotPayer !== getAddress(ctx.expectedMinter)
  ) {
    throw new Error(
      `Calldata credits the NFT to ${minterIfNotPayer}, not to the minting wallet.`,
    );
  }

  const params = args.mintParams;
  const mintPrice = BigInt(params.mintPrice);
  if (value !== mintPrice * BigInt(quantity)) {
    throw new Error(
      `Value ${value} does not equal mintPrice ${mintPrice} × quantity ${quantity}.`,
    );
  }
  if (BigInt(params.feeBps) > 10_000n) throw new Error("feeBps exceeds 100%.");

  const startMs = Number(params.startTime) * 1000;
  const endMs = Number(params.endTime) * 1000;
  if (nowMs < startMs) throw new Error("This stage has not opened yet.");
  if (nowMs >= endMs) throw new Error("This stage has already ended.");

  return {
    to,
    data: raw.data,
    value,
    method,
    stageIndex: String(params.dropStageIndex),
    mintPrice,
    startMs,
    endMs,
  };
}

/** Is this calldata a public mint rather than a signed/allowlist one? */
export function isPublicMintCalldata(data: string): boolean {
  const publicSelectors = [
    new Interface(["function mintPublic(address,address,address,uint256) payable"])
      .getFunction("mintPublic")!
      .selector,
    new Interface(["function mintPublic(address,address,uint256,uint256) payable"])
      .getFunction("mintPublic")!
      .selector,
  ];
  return publicSelectors.some((selector) => data.toLowerCase().startsWith(selector.toLowerCase()));
}
