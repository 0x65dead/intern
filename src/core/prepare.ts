// Everything between "the user named a target" and "the engine can run".
//
// This exists so the CLI and the Telegram bot cannot disagree. Target resolution,
// chain selection, endpoint ranking, drop lookup and gas budgeting are decided
// once, here; the two front ends only differ in how they ask for input and how
// they render events. A bug fixed in one is fixed in both.
//
// Ordering is chosen for a specific reason: the chain is settled *before* the
// collection is looked up, because a slug resolves to a different contract
// address on every chain it is listed on. Resolving the collection first and the
// chain second is how a tool ends up minting the Ethereum deployment of a
// collection while the user is watching the Base one.

import { JsonRpcProvider } from "ethers";
import { ChainProfile, resolveChain } from "./chains";
import { MintPlan, buildMintPlan, fetchAllowListRoot, fetchSigners } from "./seadrop";
import { MechanismEvidence, NO_EVIDENCE } from "./capabilities";
import { RpcPlan, planRpcs, resolveRpcsForChain, toRpcUrl } from "./rpc";
import { Detection, detectChain, noCodeMessage } from "./detect";
import { normalizeAddress, parseTarget } from "./target";
import {
  CollectionInfo,
  DropSchedule,
  OpenSeaError,
  fetchDropSchedule,
  resolveCollection,
} from "./opensea";
import { StageTable, buildStageTable } from "./stages";
import { StageContext, firstSentence } from "./stagetable";
import { WalletEligibility, checkMerkleEligibility, summariseEligibility } from "./eligibility";
import { loadAllowList } from "./allowlistsource";
import {
  FeeSnapshot,
  GasSettings,
  gweiToWei,
  readFees,
  redactKeys,
  suggestMaxFee,
  weiToGwei,
} from "./wallets";

export const DEFAULT_CHAIN = "base";
export const DEFAULT_GAS_LIMIT = 250_000n;

export interface TargetResolution {
  chain: ChainProfile;
  contract: string;
  /** Present when the target was a slug and OpenSea answered. */
  collection?: CollectionInfo;
  slug?: string;
  warnings: string[];
  /** Set when the chain was probed rather than given. */
  detection?: Detection;
}

/**
 * Raised when a bare address has code on several chains.
 *
 * A thrown error rather than a silent pick, because the two renderers resolve it
 * differently — the bot shows an inline keyboard, the CLI wizard prompts — and
 * neither can be driven from in here. The candidates travel with the error so the
 * caller can build the picker without re-probing.
 */
export class AmbiguousChainError extends Error {
  constructor(
    public readonly address: string,
    public readonly candidates: string[],
  ) {
    super(
      `${address} has contract code on ${candidates.length} chains (${candidates.join(", ")}). Pick one with --chain.`,
    );
    this.name = "AmbiguousChainError";
  }
}

/**
 * Turn user input into a chain and a contract address.
 *
 * A chain named explicitly always wins over one parsed out of a URL — the flag is
 * a deliberate act and the URL is a paste — but a disagreement between the two is
 * surfaced rather than silently resolved, because it usually means the wrong link
 * was copied.
 *
 * A bare address with neither an explicit chain nor a URL hint is *probed* rather
 * than assumed. Falling back to the default chain there is how a mint silently
 * targets the wrong network: the address has no code, the drop reads as
 * unconfigured, and nothing in the output points at the chain as the cause.
 */
export async function resolveTarget(opts: {
  target: string;
  chainKey?: string | undefined;
  apiKey?: string | null;
  defaultChain?: string;
  /** Set false to skip probing and use the default chain, as before. */
  autoDetect?: boolean;
}): Promise<TargetResolution> {
  const warnings: string[] = [];
  const parsed = parseTarget(opts.target);

  const explicit = opts.chainKey?.trim().toLowerCase();

  // Bare address, no chain anywhere: ask the chains themselves.
  let detected: Detection | undefined;
  if (
    parsed.kind === "address" &&
    !explicit &&
    !parsed.chainHint &&
    opts.autoDetect !== false
  ) {
    const normalizedForProbe = normalizeAddress(parsed.value);
    if (!normalizedForProbe) throw new Error(`"${parsed.value}" is not a valid contract address.`);

    detected = await detectChain(normalizedForProbe.address);
    if (detected.kind === "none") {
      throw new Error(noCodeMessage(normalizedForProbe.address, detected.probes));
    }
    if (detected.kind === "ambiguous") {
      throw new AmbiguousChainError(normalizedForProbe.address, detected.candidates);
    }
  }

  const chainKey =
    explicit ??
    (detected?.kind === "single" ? detected.chainKey : undefined) ??
    parsed.chainHint ??
    opts.defaultChain ??
    DEFAULT_CHAIN;
  const chain = resolveChain(chainKey);
  if (!chain) {
    throw new Error(
      `Unknown chain "${chainKey}". Supported: ethereum, base, robinhood, ink, arbitrum, optimism, polygon, zora.`,
    );
  }
  if (explicit && parsed.chainHint && parsed.chainHint !== explicit) {
    warnings.push(
      `The link names chain "${parsed.chainHint}" but "${explicit}" was selected — minting on ${chain.name}.`,
    );
  }

  if (parsed.kind === "address") {
    const normalized = normalizeAddress(parsed.value);
    if (!normalized) throw new Error(`"${parsed.value}" is not a valid contract address.`);
    if (normalized.checksumWarning) {
      warnings.push(
        "Address failed its EIP-55 checksum — it is mixed-case but the capitalisation does not match. Verify you copied it correctly.",
      );
    }
    return {
      chain,
      contract: normalized.address,
      warnings,
      ...(detected ? { detection: detected } : {}),
    };
  }

  // A slug needs OpenSea to become an address. The lookup often works without a
  // key; when it does not, saying so beats a bare 401.
  let collection: CollectionInfo;
  try {
    collection = await resolveCollection(parsed.value, opts.apiKey ?? undefined, chain.key);
  } catch (err: unknown) {
    if (err instanceof OpenSeaError && (err.status === 401 || err.status === 403)) {
      throw new Error(
        `OpenSea would not resolve the slug "${parsed.value}" without a valid API key. Paste the contract address instead, or set OPENSEA_API_KEY.`,
      );
    }
    throw err;
  }

  if (collection.chain.toLowerCase() !== chain.key) {
    warnings.push(
      `OpenSea lists this collection's contract on "${collection.chain}", not "${chain.key}". Check --chain before firing.`,
    );
  }

  return {
    chain,
    contract: collection.contractAddress,
    collection,
    slug: collection.slug,
    warnings,
  };
}

export interface RpcSetup {
  plan: RpcPlan;
  source: string;
  /** A provider on the fastest read endpoint. The caller must destroy it. */
  provider: JsonRpcProvider;
}

/**
 * Rank endpoints and open a provider on the fastest read-capable one.
 *
 * `staticNetwork` matters more than it looks: without it ethers re-verifies the
 * chain id before every single call, doubling the round trips on the setup path.
 * We have already verified the chain id in `planRpcs`, against every endpoint.
 */
export async function setupRpcs(
  chain: ChainProfile,
  manualRpcs: string[] = [],
  opts: { samples?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RpcSetup> {
  const expanded = manualRpcs
    .map((entry) => toRpcUrl(entry, chain.key))
    .filter((url): url is string => url !== null);

  const resolved = resolveRpcsForChain(chain.key, expanded, opts.env ?? process.env);
  const plan = await planRpcs(resolved.urls, chain.chainId, { samples: opts.samples ?? 3 });

  if (plan.read.length === 0) {
    const detail = plan.dropped.length > 0 ? ` ${plan.dropped.length} endpoint(s) reported a different chain id.` : "";
    throw new Error(
      `No RPC endpoint answered for ${chain.name} (chain ${chain.chainId}).${detail} Set RPC_URL_${chain.key.toUpperCase()} to a working endpoint.`,
    );
  }

  return {
    plan,
    source: resolved.source,
    provider: new JsonRpcProvider(plan.read[0], chain.chainId, { staticNetwork: true }),
  };
}

export interface GasDecision {
  gas: GasSettings;
  fees: FeeSnapshot;
  warnings: string[];
}

/**
 * Decide the fee ceiling.
 *
 * An explicit ceiling is honoured exactly, including one below the current base
 * fee — that transaction cannot be included until the base fee falls, which is a
 * legitimate choice, so it is warned about rather than overridden. Silently
 * raising a number the user typed would be worse: they would believe they were
 * capped somewhere they are not.
 */
export async function decideGas(
  provider: JsonRpcProvider,
  opts: {
    maxFeeGwei?: number | null;
    priorityGwei?: number | null;
    gasLimit?: bigint;
  } = {},
): Promise<GasDecision> {
  const warnings: string[] = [];
  const fees = await readFees(provider);
  const gasLimit = opts.gasLimit ?? DEFAULT_GAS_LIMIT;

  const priority =
    opts.priorityGwei != null
      ? gweiToWei(opts.priorityGwei)
      : (fees.suggestedPriorityWei ?? gweiToWei(0.001));

  let maxFee: bigint;
  if (opts.maxFeeGwei != null) {
    maxFee = gweiToWei(opts.maxFeeGwei);
    if (fees.baseFeeWei !== null && maxFee <= fees.baseFeeWei) {
      warnings.push(
        `Fee ceiling ${weiToGwei(maxFee).toFixed(4)} gwei is at or below the current base fee (${weiToGwei(fees.baseFeeWei).toFixed(4)} gwei) — the transaction cannot be included until the base fee falls.`,
      );
    }
  } else if (fees.baseFeeWei !== null) {
    maxFee = suggestMaxFee(fees.baseFeeWei, priority);
  } else if (fees.suggestedMaxFeeWei !== null) {
    maxFee = fees.suggestedMaxFeeWei;
    warnings.push("Base fee unreadable — using the endpoint's suggested fee.");
  } else {
    maxFee = gweiToWei(1);
    warnings.push("Could not read fees at all — defaulting the ceiling to 1 gwei. Set --max-fee.");
  }

  // A ceiling below the tip is invalid: nodes reject maxFeePerGas < maxPriorityFeePerGas.
  if (maxFee < priority) {
    warnings.push(
      `Fee ceiling was below the priority tip and has been raised to ${weiToGwei(priority).toFixed(4)} gwei, the minimum a node will accept.`,
    );
    maxFee = priority;
  }

  return {
    gas: { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, gasLimit },
    fees,
    warnings,
  };
}

export interface PreparedRun {
  chain: ChainProfile;
  contract: string;
  collection?: CollectionInfo;
  slug?: string;
  rpc: RpcSetup;
  /** null when no public drop is configured on-chain yet. */
  plan: MintPlan | null;
  gas: GasSettings;
  fees: FeeSnapshot;
  warnings: string[];
  /** Every stage of the drop, on-chain and API, in one table. */
  stages: StageTable;
  /**
   * What the contract itself says about how its gated stages are gated.
   *
   * Read here rather than guessed at the renderer, because the difference
   * between "must ask OpenSea" and "can sign it here" is two contract calls and
   * is otherwise unknowable. Both reads fail soft — most drops have neither a
   * root nor a signer, and that is a fact about the drop, not an error.
   */
  evidence: MechanismEvidence;
  /** The SeaDrop signers configured on the collection. Empty is the common case. */
  signers: string[];
  /** Per-wallet allow-list proof results, when ALLOWLIST_SOURCE is configured. */
  eligibility: EligibilityReport;
  /** Set when the chain was probed rather than given. */
  detection?: Detection;
}

/**
 * The result of asking "can these wallets mint this allow-list stage?".
 *
 * Three states, kept apart on purpose — see readEligibility. An empty `results`
 * with a null `error` means the question was never asked.
 */
export interface EligibilityReport {
  /** Where the list came from, for the operator to check it was the right one. */
  origin: string | null;
  results: WalletEligibility[];
  /** Set when a list was configured but could not be used. */
  error: string | null;
}

export interface PrepareOptions {
  target: string;
  chainKey?: string | undefined;
  quantity: number;
  manualRpcs?: string[];
  apiKey?: string | null;
  maxFeeGwei?: number | null;
  priorityGwei?: number | null;
  gasLimit?: bigint;
  defaultChain?: string;
  samples?: number;
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
  /** Corrected-clock reading. Defaults to Date.now() for non-timing callers. */
  nowMs?: number;
  /** Set false to skip chain probing for a bare address. */
  autoDetect?: boolean;
  /**
   * The addresses intern holds keys for, to decide whether a configured SeaDrop
   * signer is one of ours. Only ever compared — never logged, never sent.
   */
  walletAddresses?: string[];
  /**
   * A local allow-list to prove those addresses against: a path, https:// or
   * ipfs://. Unset means the eligibility question is left unanswered rather
   * than answered "no".
   */
  allowlistSource?: string | null;
}

/**
 * Fetch the OpenSea schedule, tolerating every way it can be unavailable.
 *
 * This is deliberately non-fatal. The schedule is supplementary — the mint itself
 * runs on contract reads — so a missing key, a 404 or a rate limit must degrade
 * the table rather than fail the whole preparation. What it must not do is
 * disappear silently, which is why the reason comes back with the result.
 */
async function loadSchedule(
  slug: string | undefined,
  apiKey: string | null,
): Promise<{ schedule: DropSchedule | null; error?: string }> {
  if (!slug || !apiKey) return { schedule: null };
  try {
    return { schedule: await fetchDropSchedule(slug, apiKey) };
  } catch (err: unknown) {
    if (err instanceof OpenSeaError && err.status === 404) {
      return { schedule: null, error: "no drop listed for this collection" };
    }
    return { schedule: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Full setup: target → chain → endpoints → drop → gas.
 *
 * The provider inside the returned `rpc` is left open, because the caller keeps
 * reading through it (watching, simulating, receipts). Callers must destroy it —
 * `closeRun` is provided so that is one call rather than a reach into internals.
 */
export async function prepareRun(opts: PrepareOptions): Promise<PreparedRun> {
  const progress = opts.onProgress ?? (() => {});
  const warnings: string[] = [];
  const nowMs = opts.nowMs ?? Date.now();

  progress("Resolving target…");
  const resolved = await resolveTarget({
    target: opts.target,
    chainKey: opts.chainKey,
    apiKey: opts.apiKey ?? null,
    ...(opts.defaultChain ? { defaultChain: opts.defaultChain } : {}),
    ...(opts.autoDetect !== undefined ? { autoDetect: opts.autoDetect } : {}),
  });
  warnings.push(...resolved.warnings);

  progress(`Probing ${resolved.chain.name} endpoints…`);
  const rpc = await setupRpcs(resolved.chain, opts.manualRpcs ?? [], {
    samples: opts.samples ?? 3,
    ...(opts.env ? { env: opts.env } : {}),
  });

  try {
    progress("Reading the drop from the contract…");
    // The schedule fetch is independent of both contract reads, so it rides along
    // rather than adding a round trip of its own.
    const [plan, gasDecision, scheduleResult] = await Promise.all([
      buildMintPlan(rpc.provider, resolved.contract, opts.quantity),
      decideGas(rpc.provider, {
        maxFeeGwei: opts.maxFeeGwei ?? null,
        priorityGwei: opts.priorityGwei ?? null,
        ...(opts.gasLimit ? { gasLimit: opts.gasLimit } : {}),
      }),
      loadSchedule(resolved.slug, opts.apiKey ?? null),
    ]);
    warnings.push(...gasDecision.warnings);

    const stages = buildStageTable({
      plan,
      supply: plan?.supply ?? { totalSupply: null, maxSupply: null },
      schedule: scheduleResult.schedule,
      nowMs,
      hasApiKey: Boolean(opts.apiKey),
      apiError: scheduleResult.error,
    });

    // A second round trip, but only one, and only after the variant is known —
    // the getter lives at a different address for v1 than for v2. Both calls are
    // independent, so they share the trip.
    const { evidence, signers, root } = await readMechanismEvidence(
      rpc.provider,
      resolved.contract,
      plan,
      opts.walletAddresses ?? [],
    );

    const eligibility = await readEligibility({
      provider: rpc.provider,
      contract: resolved.contract,
      plan,
      root,
      addresses: opts.walletAddresses ?? [],
      source: opts.allowlistSource ?? null,
    });

    return {
      chain: resolved.chain,
      contract: resolved.contract,
      ...(resolved.collection ? { collection: resolved.collection } : {}),
      ...(resolved.slug ? { slug: resolved.slug } : {}),
      rpc,
      plan,
      gas: gasDecision.gas,
      fees: gasDecision.fees,
      warnings,
      stages,
      evidence,
      signers,
      eligibility,
      ...(resolved.detection ? { detection: resolved.detection } : {}),
    };
  } catch (err) {
    rpc.provider.destroy();
    throw err;
  }
}

/**
 * Ask the contract how its gated stages are actually gated.
 *
 * Returns no evidence rather than throwing on any failure. The absence of an
 * allow-list root is indistinguishable, from outside, from a collection that
 * does not implement the getter — and both mean the same thing for the table:
 * there is no Merkle stage to be eligible for. Claiming otherwise from a failed
 * read would be worse than claiming nothing.
 */
async function readMechanismEvidence(
  provider: JsonRpcProvider,
  contract: string,
  plan: MintPlan | null,
  walletAddresses: string[],
): Promise<{ evidence: MechanismEvidence; signers: string[]; root: string | null }> {
  if (plan === null) return { evidence: NO_EVIDENCE, signers: [], root: null };

  const [root, signers] = await Promise.all([
    fetchAllowListRoot(provider, contract, plan.variant),
    fetchSigners(provider, contract, plan.variant),
  ]);

  // Case-insensitive because one side is checksummed by fetchSigners and the
  // other is whatever the operator put in .env.
  const ours = new Set(walletAddresses.map((a) => a.toLowerCase()));
  return {
    evidence: {
      merkleRoot: root !== null,
      localSigner: signers.some((s) => ours.has(s.toLowerCase())),
    },
    signers,
    // Handed back rather than dropped: the eligibility check needs the same
    // value, and re-reading it would be a second round trip for a number we
    // are already holding.
    root,
  };
}

/**
 * Prove the loaded wallets against the drop's allow-list, when one is given.
 *
 * Three outcomes, and they are deliberately distinguishable in the table. No
 * source configured is not a verdict about any wallet — it means the operator
 * never supplied the list, and the honest cell is "unknown", not "ineligible".
 * A source that fails to load is a third thing again: the operator asked for a
 * check that did not happen, and that must be visible rather than degrade into
 * looking like the first case.
 */
async function readEligibility(opts: {
  provider: JsonRpcProvider;
  contract: string;
  plan: MintPlan | null;
  root: string | null;
  addresses: string[];
  source: string | null;
}): Promise<EligibilityReport> {
  const none: EligibilityReport = { origin: null, results: [], error: null };
  if (opts.source === null || opts.source.trim() === "") return none;
  if (opts.plan === null) return none;
  if (opts.addresses.length === 0) {
    return { origin: null, results: [], error: "No wallets are loaded, so there was nothing to check." };
  }

  try {
    const list = await loadAllowList(opts.source);
    const results = await checkMerkleEligibility({
      provider: opts.provider,
      nftContract: opts.contract,
      variant: opts.plan.variant,
      entries: list.entries,
      addresses: opts.addresses,
      root: opts.root,
    });
    return { origin: list.origin, results, error: null };
  } catch (err: unknown) {
    // Never fatal. A bad allow-list must not stop the operator seeing the rest
    // of the drop — but it must not be silent either, so the reason travels to
    // the table instead of into a swallowed catch.
    return { origin: null, results: [], error: redactKeys(err instanceof Error ? err.message : String(err)) };
  }
}

export function closeRun(run: Pick<PreparedRun, "rpc">): void {
  run.rpc.provider.destroy();
}

/**
 * Re-read the live parts of a prepared run, reusing its provider.
 *
 * This is what a refreshing panel calls. It deliberately does *not* redo target
 * resolution, chain detection or endpoint ranking: those cannot change while a
 * panel is open, and re-ranking endpoints every 20 seconds would spend a latency
 * probe against every RPC on a timer, for an answer that was already correct.
 *
 * What it does re-read is everything that moves — the drop config, current supply,
 * the fee market, the OpenSea schedule — and it rebuilds the stage table against
 * the clock reading it was given, so a countdown advances even when nothing
 * on-chain has changed.
 *
 * The returned run shares the caller's provider, so `closeRun` must be called
 * once for the pair, not once for each.
 */
export async function refreshRun(
  run: PreparedRun,
  opts: {
    quantity: number;
    apiKey?: string | null;
    maxFeeGwei?: number | null;
    priorityGwei?: number | null;
    gasLimit?: bigint;
    nowMs: number;
  },
): Promise<PreparedRun> {
  const warnings: string[] = [];

  const [plan, gasDecision, scheduleResult] = await Promise.all([
    buildMintPlan(run.rpc.provider, run.contract, opts.quantity),
    decideGas(run.rpc.provider, {
      maxFeeGwei: opts.maxFeeGwei ?? null,
      priorityGwei: opts.priorityGwei ?? null,
      ...(opts.gasLimit ? { gasLimit: opts.gasLimit } : {}),
    }),
    loadSchedule(run.slug, opts.apiKey ?? null),
  ]);
  warnings.push(...gasDecision.warnings);

  const stages = buildStageTable({
    plan,
    supply: plan?.supply ?? { totalSupply: null, maxSupply: null },
    schedule: scheduleResult.schedule,
    nowMs: opts.nowMs,
    hasApiKey: Boolean(opts.apiKey),
    apiError: scheduleResult.error,
  });

  // evidence and signers ride through on the spread, deliberately. An allow-list
  // root and a signer set are configured once at deploy time and do not move
  // while a panel is open; re-reading them every refresh would spend two RPC
  // calls on a timer for an answer that was already correct.
  return {
    ...run,
    plan,
    gas: gasDecision.gas,
    fees: gasDecision.fees,
    warnings,
    stages,
  };
}

/**
 * Assemble what the stage table needs to say "can we fire this?" honestly.
 *
 * Every caller of printStages/renderStages goes through here, so the CLI and the
 * bot cannot reach different verdicts about the same drop. Called with nothing
 * configured it produces exactly the conservative defaults the table already
 * used — which is the point: the honest answer with no evidence is "no", and
 * this only ever narrows that by presenting evidence.
 */
export function stageContext(
  run: Pick<PreparedRun, "evidence"> & Partial<Pick<PreparedRun, "eligibility">>,
  opts: {
    allowlistMinting: boolean;
    openseaApiKey: boolean;
  },
): StageContext {
  const report = run.eligibility ?? { origin: null, results: [], error: null };
  const summary = eligibilitySummary(report);
  return {
    fire: {
      allowlistMinting: opts.allowlistMinting,
      openseaApiKey: opts.openseaApiKey,
      // Derived, never asserted by the caller. A proof exists when a wallet was
      // actually proven against the on-chain root — the one fact that turns a
      // Merkle stage from unreachable into fireable.
      merkleProof: report.results.some((r) => r.state === "eligible" && r.proof !== undefined),
    },
    evidence: run.evidence,
    ...(summary ? { eligibility: { "merkle-allowlist": summary } } : {}),
    // A configured list that did not load is not the same as no list, and the
    // table must not let the two read alike.
    ...(report.error !== null ? { eligibilityUnavailable: ["merkle-allowlist" as const] } : {}),
  };
}

/**
 * One line for the Merkle row's eligibility cell, or null to leave it alone.
 *
 * A load failure outranks the wallet verdicts: if the list never loaded there
 * are no verdicts, and printing "unknown" would hide that the operator asked a
 * question the run could not answer.
 */
export function eligibilitySummary(report: EligibilityReport): string | null {
  if (report.error !== null) return `allow-list unusable: ${firstSentence(report.error)}`;
  if (report.results.length === 0) return null;
  return summariseEligibility(report.results);
}

/**
 * The message shown when a collection has no public drop on-chain.
 *
 * Worth being specific: there are three distinct causes with different remedies,
 * and "not a SeaDrop collection" (what most tools say) is only one of them.
 */
export function noDropMessage(contract: string, chainName: string, hasApiKey: boolean): string {
  return [
    `No public SeaDrop stage is configured for ${contract} on ${chainName}.`,
    "That means one of three things:",
    "  · the creator has not configured the public stage yet — use --watch to wait for it",
    "  · this stage is allowlist-only" +
      (hasApiKey ? " — use `intern allowlist`" : " — set OPENSEA_API_KEY and use `intern allowlist`"),
    "  · the contract is not a SeaDrop collection, so there is nothing here to mint",
  ].join("\n");
}
