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
import { redactKeys } from "./wallets";

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
    /**
     * What OpenSea itself said, when the error body carried a message.
     *
     * This used to be discarded, and discarding it cost real time. A 403 on the
     * token exchange was reported as a bare "Forbidden (HTTP 403)", so the layer
     * above attributed it to the scoped token and told the operator to check its
     * scope. OpenSea's actual words were "Token exchange is not available" — a
     * statement about the endpoint, not the credential, and the difference is
     * between a two-minute fix and regenerating a token that was never wrong.
     *
     * Redacted on the way in: an error body can quote back what was sent.
     */
    public readonly detail: string | null = null,
  ) {
    super(detail === null ? message : `${message} ${detail}`);
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
  // Deliberately does not name a credential. Wallet-scoped calls send two, and
  // this layer does not know which endpoint it served — naming the API key here
  // is what sent operators to rotate a key when the JWT had merely expired.
  // classifyOpenSeaFailure knows the endpoint and names the right one.
  401: "OpenSea rejected the request's credentials",
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

/**
 * Options for one OpenSea API call.
 *
 * `bearer` carries the short-lived wallet JWT for the endpoints that are scoped to
 * a wallet rather than to an application — eligibility is the one that matters.
 * Those endpoints want *both* credentials: `x-api-key` identifies the application
 * and the bearer identifies the wallet, and sending only one earns a 401 that says
 * nothing about which was missing.
 */
export interface RequestOptions {
  apiKey?: string;
  bearer?: string;
  body?: object;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Overrides the method, which otherwise follows the presence of a body.
   *
   * The implicit rule is right for every call here, so this exists for the case
   * where it would stop being right: a POST with no body, or a GET that needs
   * one. Being able to say so explicitly is cheaper than discovering that the
   * inference picked GET for a mutation.
   */
  method?: "GET" | "POST";
}

/**
 * One HTTP path for every OpenSea call this bot makes.
 *
 * Deliberately the only one. A second fetch wrapper for the auth endpoints would
 * be a second place to get the redirect policy, the timeout and the Retry-After
 * parsing right, and the cost of getting them wrong is either a leaked credential
 * or a rate-limit spiral during the one minute of the day that matters.
 *
 * `signal` composes with the timeout rather than replacing it: a caller's
 * cancellation and the request's own deadline are different concerns, and a task
 * that is cancelled mid-poll must abort immediately without waiting out a 20s
 * timeout it no longer cares about.
 */
export async function openSeaRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  if (opts.body) headers["content-type"] = "application/json";

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal,
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
      await errorDetail(res),
    );
  }
  return (await res.json()) as T;
}

/** Long enough for any real API message, short enough that an HTML page cannot flood a log. */
const DETAIL_LIMIT = 300;

/**
 * OpenSea's own description of an error, across the envelopes it uses.
 *
 * Best-effort by construction: a body that cannot be read or does not carry a
 * message yields null, because a failure to explain a failure must not replace
 * it. Bounded because an error body is occasionally an HTML page, and a wall of
 * markup in a log is worse than the canned reason it displaced.
 */
async function errorDetail(res: Response): Promise<string | null> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  if (text.trim() === "") return null;

  let message: string | null = null;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const err = body["error"];
    const errors = body["errors"];
    for (const candidate of [
      typeof err === "object" && err !== null ? (err as Record<string, unknown>)["message"] : err,
      Array.isArray(errors) ? errors[0] : undefined,
      body["message"],
      body["detail"],
    ]) {
      if (typeof candidate === "string" && candidate.trim() !== "") {
        message = candidate.trim();
        break;
      }
    }
  } catch {
    // Not JSON. The raw text is still better than nothing, once trimmed.
    message = text.replace(/\s+/g, " ").trim();
  }
  if (message === null) return null;
  // Redact first, truncate second, and never the other way round. An error body
  // can echo the request that caused it, and that request carries a token; both
  // mechanisms that would catch it match a whole value — `redactLiterals` tests
  // `includes(secret)`, and the JWT pattern needs all three segments. Slicing
  // first turns a credential that straddles the cut into a prefix that matches
  // neither, so the truncation itself is what defeats the redaction and the
  // leading characters of a live token reach the log.
  const safe = redactKeys(message);
  return safe.length <= DETAIL_LIMIT ? safe : `${safe.slice(0, DETAIL_LIMIT)}…`;
}

/** The pre-existing internal spelling, kept so this file reads unchanged below. */
const request = openSeaRequest;

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
  /**
   * OpenSea's own identifier for this stage, when the drop response carries one.
   *
   * This is the join key between a stage and a wallet's eligibility for it. The
   * eligibility endpoint answers per `stage_uuid` and in an order of its own, so
   * without the uuid the only way to pair the two is by position — which is wrong
   * the moment OpenSea returns them in a different order, and wrong silently: the
   * operator would see a price and an allowance belonging to a different stage.
   *
   * Optional because it is absent from older drop payloads. A stage with no uuid
   * simply cannot be joined, and is reported as such rather than guessed at.
   */
  uuid?: string;

  /**
   * The stage's price per token in wei, when the drop response states one in the
   * chain's native currency.
   *
   * Absent means one of two different things, and the distinction matters enough
   * that the field is optional rather than zero: OpenSea stated no price, or it
   * stated a price denominated in an ERC-20 (see `priceCurrency`). Zero is a
   * third, separate fact — a free stage — and is carried as 0n.
   */
  priceWei?: bigint;

  /**
   * The ERC-20 the price is denominated in, when it is not the native currency.
   *
   * Set only in that case. Its presence is why `priceWei` is absent: rendering a
   * USDC amount in an ETH column would be a wrong number that looks right.
   */
  priceCurrency?: string;

  /** The stated per-wallet limit. Absent means OpenSea stated none. */
  maxPerWallet?: number;
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
  stages?: {
    stage_type?: string;
    label?: string;
    start_time?: string;
    end_time?: string;
    /**
     * The live API sends `uuid`. `stage_uuid` is accepted alongside it because
     * the eligibility endpoint uses that spelling for the same identifier, and
     * reading only one of the two is how this field came to be silently empty on
     * every real drop: the parser asked for `stage_uuid`, the drop endpoint sent
     * `uuid`, nothing errored, and the join key that the entire eligibility
     * lookup depends on was quietly absent in production while every test that
     * supplied `stage_uuid` passed.
     */
    uuid?: string;
    stage_uuid?: string;
    price?: string | number;
    price_currency_address?: string;
    max_per_wallet?: string | number;
  }[];
}

/** The zero address, which OpenSea uses to mean "the chain's own currency". */
const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000";

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/**
 * A decimal wei string to a bigint, or null.
 *
 * Strict on purpose. Anything that is not plainly a non-negative integer becomes
 * null — "not stated" — rather than a number derived from a shape nobody
 * verified. A wrong price here is spent money.
 */
function parseWeiString(value: string | number | undefined): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;
  const t = value.trim();
  return /^\d+$/.test(t) ? BigInt(t) : null;
}

/** A stated per-wallet limit, or null when none was stated. A stated 0 is kept. */
function parseCount(value: string | number | undefined): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
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
    const uuid = firstNonEmpty(stage.uuid, stage.stage_uuid);
    const currency = typeof stage.price_currency_address === "string"
      ? stage.price_currency_address.trim().toLowerCase()
      : "";
    const native = currency === "" || currency === NATIVE_CURRENCY;
    const priceWei = native ? parseWeiString(stage.price) : null;
    const cap = parseCount(stage.max_per_wallet);
    return {
      type,
      label: stage.label || type,
      startMs,
      endMs,
      isPublic: type === "public_sale",
      ...(uuid !== "" ? { uuid } : {}),
      ...(priceWei !== null ? { priceWei } : {}),
      ...(!native ? { priceCurrency: currency } : {}),
      ...(cap !== null ? { maxPerWallet: cap } : {}),
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
