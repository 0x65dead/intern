// Wallet-scoped eligibility: can THIS wallet mint THIS stage, and on what terms.
//
// This replaces an architecture that worked by probing. The old code asked the
// mint endpoint to build a transaction and read the refusal as a verdict: 409 or
// 422 meant "probably not eligible", anything else meant "probably fine". That
// approach has three defects and all of them matter at T-0.
//
//   It cannot answer before the stage opens. A closed stage returns 409 for
//   everyone, eligible or not, so the one question worth answering in advance —
//   is this wallet on the list? — had no answer until it was too late to act on.
//
//   Its verdicts are guesses. HTTP 422 covers four different causes (see
//   failures.ts), so "not eligible" was being reported for wallets whose real
//   problem was a per-wallet cap or an empty balance.
//
//   It costs a mint request per probe, against the endpoint that rate-limits
//   hardest, at the moment that rate limit is least affordable.
//
// `/drops/{slug}/eligibility` answers the question directly, and answers it early.
// The response is per stage and carries the terms — price, per-wallet allowance —
// which the drop schedule endpoint does not return at all.
//
// Two invariants are worth stating because breaking either is silent:
//
//   Stages join by `stage_uuid`, never by position. The eligibility response and
//   the drop schedule both return arrays, in orders neither endpoint promises to
//   keep aligned. Pairing by index produces a table where a price and an
//   allowance belong to a different stage than the label next to them — and it
//   looks completely normal.
//
//   Absent is not zero. A stage whose price is unknown is null and renders as
//   "—"; a stage whose price is genuinely zero is 0n and renders as free. The
//   renderers already depend on this distinction, and collapsing the two would
//   print "0 ETH" next to a stage nobody has priced.

import { DropStage } from "./opensea";
import { OpenSeaAuthError, OpenSeaAuthManager } from "./openseaauth";
import { OpenSeaError, openSeaRequest } from "./opensea";
import { StageKind, stageKindOf } from "./stages";
import { EligibilityHint, Failure, classifyOpenSeaFailure } from "./failures";

/** One stage's terms for one wallet, normalised. */
export interface WalletStageEligibility {
  /** Checksummed where the source gave an address; "" when the JWT implied it. */
  readonly wallet: string;
  readonly dropSlug: string;
  /** OpenSea's stage identifier. The join key. Never empty. */
  readonly stageUuid: string;
  /** Mapped through the existing taxonomy, or "unknown" when unmappable. */
  readonly stageType: StageKind;
  readonly stageLabel: string;
  readonly isEligible: boolean;
  /** Wei. null means OpenSea stated no price; 0n means the mint is free. */
  readonly price: bigint | null;
  /** null means no limit was stated. 0 means a stated limit of zero. */
  readonly maxMintable: number | null;
  readonly maxMintablePerToken: number | null;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly checkedAt: number;
  readonly source: "opensea-eligibility";
  /**
   * True when no scheduled stage carried this uuid.
   *
   * The terms are still trustworthy — they came from OpenSea — but the label and
   * the type could not be confirmed against the schedule, so both are reported
   * as unknown rather than inferred from position.
   */
  readonly unmapped: boolean;
}

export interface EligibilitySnapshot {
  readonly dropSlug: string;
  readonly wallet: string;
  readonly checkedAt: number;
  readonly stages: readonly WalletStageEligibility[];
  /** Stage uuids OpenSea answered for that the schedule does not contain. */
  readonly unmatchedUuids: readonly string[];
  /** Scheduled stages OpenSea returned no answer for, by label. */
  readonly unansweredStages: readonly string[];
  /**
   * Set when the response named a wallet other than the one asked about.
   *
   * Never ignored and never silently accepted. The eligibility answer is the
   * thing that decides whether a wallet tries to mint, so attributing one
   * wallet's "yes" to another is the single most expensive mistake this module
   * could make.
   */
  readonly walletMismatch?: string;
}

/** The raw per-stage shape, all fields untrusted. */
interface RawStage {
  stage_uuid?: unknown;
  stageUuid?: unknown;
  is_eligible?: unknown;
  isEligible?: unknown;
  price?: unknown;
  max_total_mintable_by_wallet?: unknown;
  maxTotalMintableByWallet?: unknown;
  max_total_mintable_by_wallet_per_token?: unknown;
  maxTotalMintableByWalletPerToken?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  stage_type?: unknown;
  label?: unknown;
}

interface RawEligibility {
  stages?: unknown;
  eligibility?: unknown;
  data?: unknown;
  minter?: unknown;
  wallet?: unknown;
  address?: unknown;
}

/** Wei from a decimal string. Distinguishes "0" (free) from absent (unknown). */
function weiOrNull(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    // A price in wei does not survive a float. Only an exact small integer —
    // which in practice means 0 — is safe to accept from a JSON number.
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) return null;
    return BigInt(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

/** A count from a string or number. Distinguishes a stated 0 from absent. */
function countOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function msOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The array of stages, across the envelope shapes the endpoint may use. */
function stageArray(raw: RawEligibility | unknown[]): RawStage[] {
  if (Array.isArray(raw)) return raw as RawStage[];
  if (raw === null || typeof raw !== "object") return [];
  for (const candidate of [raw.stages, raw.eligibility, raw.data]) {
    if (Array.isArray(candidate)) return candidate as RawStage[];
  }
  return [];
}

/**
 * Normalise an eligibility response against the known schedule.
 *
 * Pure, and separate from the HTTP call on purpose: this is where every decision
 * that could silently mis-attribute a stage's terms lives, so it needs to be
 * testable against adversarial payloads without a network in the way.
 */
export function parseEligibilityResponse(
  raw: unknown,
  ctx: {
    dropSlug: string;
    /** The wallet the caller believes it asked about. "" when the JWT implied it. */
    wallet?: string;
    stages?: readonly DropStage[];
    nowMs: number;
  },
): EligibilitySnapshot {
  const envelope = (raw ?? {}) as RawEligibility;
  const rows = stageArray(raw as RawEligibility);
  const expected = (ctx.wallet ?? "").trim();

  const stated = Array.isArray(raw)
    ? ""
    : stringOrEmpty(envelope.minter) ||
      stringOrEmpty(envelope.wallet) ||
      stringOrEmpty(envelope.address);

  // Compared case-insensitively: an address is the same address whatever its
  // checksum capitalisation, and reporting a mismatch over that would train the
  // operator to ignore the warning that matters.
  const mismatch =
    expected !== "" && stated !== "" && stated.toLowerCase() !== expected.toLowerCase()
      ? stated
      : null;

  const byUuid = new Map<string, DropStage>();
  for (const stage of ctx.stages ?? []) {
    if (stage.uuid !== undefined && stage.uuid !== "") byUuid.set(stage.uuid, stage);
  }

  const stages: WalletStageEligibility[] = [];
  const unmatchedUuids: string[] = [];
  const answered = new Set<string>();

  for (const row of rows) {
    const uuid = stringOrEmpty(row.stage_uuid) || stringOrEmpty(row.stageUuid);
    // A row with no uuid cannot be joined to anything and cannot be told apart
    // from another such row. Positional guessing is the one thing this module
    // exists to avoid, so it is dropped rather than approximated.
    if (uuid === "") continue;

    const scheduled = byUuid.get(uuid);
    if (scheduled) answered.add(uuid);
    else unmatchedUuids.push(uuid);

    const eligibleRaw = row.is_eligible ?? row.isEligible;
    // Only an explicit `true` is eligibility. A missing or non-boolean field is
    // not a yes: defaulting to true here would arm a wallet on a malformed or
    // truncated response.
    const isEligible = eligibleRaw === true;

    const rowLabel = stringOrEmpty(row.label);
    const rowType = stringOrEmpty(row.stage_type);
    const label = scheduled?.label ?? (rowLabel !== "" ? rowLabel : rowType);
    const stageType: StageKind = scheduled
      ? stageKindOf(scheduled.type, scheduled.label)
      : rowType !== "" || rowLabel !== ""
        ? stageKindOf(rowType, rowLabel)
        : "unknown";

    stages.push({
      wallet: expected,
      dropSlug: ctx.dropSlug,
      stageUuid: uuid,
      stageType,
      stageLabel: label !== "" ? label : uuid,
      isEligible,
      price: weiOrNull(row.price),
      maxMintable: countOrNull(row.max_total_mintable_by_wallet ?? row.maxTotalMintableByWallet),
      maxMintablePerToken: countOrNull(
        row.max_total_mintable_by_wallet_per_token ?? row.maxTotalMintableByWalletPerToken,
      ),
      startsAt: scheduled?.startMs ?? msOrNull(row.start_time),
      endsAt: scheduled?.endMs ?? msOrNull(row.end_time),
      checkedAt: ctx.nowMs,
      source: "opensea-eligibility",
      unmapped: scheduled === undefined,
    });
  }

  const unansweredStages = (ctx.stages ?? [])
    .filter((s) => s.uuid === undefined || s.uuid === "" || !answered.has(s.uuid))
    .map((s) => s.label || s.type);

  return {
    dropSlug: ctx.dropSlug,
    wallet: expected,
    checkedAt: ctx.nowMs,
    stages,
    unmatchedUuids,
    unansweredStages,
    ...(mismatch !== null ? { walletMismatch: mismatch } : {}),
  };
}

export interface EligibilityRequest {
  slug: string;
  auth: OpenSeaAuthManager;
  /** Optional: the response is scoped by the JWT, so this is a cross-check. */
  wallet?: string;
  stages?: readonly DropStage[];
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Ask OpenSea what a wallet may mint.
 *
 * Both credentials go out together: `x-api-key` identifies the integration and
 * the bearer identifies the wallet. `withAuth` supplies them and handles a 401 by
 * refreshing once, which is the case that actually happens — a JWT can expire
 * between the freshness check and the request landing, and near T-0 that window
 * is hit often enough to matter.
 *
 * The wallet is determined by the token, not by this call. `wallet` is therefore
 * a cross-check rather than a selector: if OpenSea names a different address, the
 * snapshot says so instead of quietly attributing the answer to the wallet we
 * asked about.
 */
export async function fetchWalletEligibility(req: EligibilityRequest): Promise<EligibilitySnapshot> {
  const now = req.now ?? Date.now;
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(req.slug)) {
    throw new Error(`Invalid collection slug: "${req.slug}"`);
  }
  const path = `/drops/${encodeURIComponent(req.slug)}/eligibility`;

  const raw = await req.auth.withAuth(
    (headers) =>
      openSeaRequest<unknown>(path, {
        apiKey: headers.apiKey,
        bearer: headers.bearer,
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      }),
    req.signal ? { signal: req.signal } : {},
  );

  return parseEligibilityResponse(raw, {
    dropSlug: req.slug,
    ...(req.wallet !== undefined ? { wallet: req.wallet } : {}),
    ...(req.stages !== undefined ? { stages: req.stages } : {}),
    nowMs: now(),
  });
}

/**
 * Eligibility with the failure already classified.
 *
 * Returns rather than throws, because "we could not determine eligibility" is a
 * normal state for this bot and not an error: without the scoped token it is the
 * permanent state, and the operator is still entitled to a stage table.
 */
export async function tryFetchWalletEligibility(
  req: EligibilityRequest,
): Promise<{ snapshot: EligibilitySnapshot | null; failure: Failure | null }> {
  try {
    return { snapshot: await fetchWalletEligibility(req), failure: null };
  } catch (err: unknown) {
    if (err instanceof OpenSeaError) {
      return {
        snapshot: null,
        failure: classifyOpenSeaFailure(err, { endpoint: "eligibility" }),
      };
    }
    if (err instanceof OpenSeaAuthError) {
      return {
        snapshot: null,
        failure: classifyOpenSeaFailure(
          { status: err.status ?? 0, message: err.message },
          { endpoint: "exchange" },
        ),
      };
    }
    throw err;
  }
}

// ── Reading a snapshot ───────────────────────────────────────────────────────

export function eligibilityForStage(
  snapshot: EligibilitySnapshot,
  stage: DropStage,
): WalletStageEligibility | null {
  if (stage.uuid === undefined || stage.uuid === "") return null;
  return snapshot.stages.find((s) => s.stageUuid === stage.uuid) ?? null;
}

/**
 * The stage that is open right now, by its own window.
 *
 * Computed from the windows rather than taken from the array, because nothing
 * about the response order says which stage is active. Assuming the first entry
 * is the live one is wrong for every drop whose earliest stage has ended.
 */
export function liveEligibility(
  snapshot: EligibilitySnapshot,
  nowMs: number,
): WalletStageEligibility | null {
  const open = snapshot.stages.filter(
    (s) => s.startsAt !== null && s.startsAt <= nowMs && (s.endsAt === null || nowMs < s.endsAt),
  );
  if (open.length === 0) return null;
  // Overlapping stages are legal. Prefer one this wallet can actually use, then
  // the one that opened most recently — the specific stage rather than a broad
  // public window that happens to run alongside it.
  const eligible = open.filter((s) => s.isEligible);
  const pool = eligible.length > 0 ? eligible : open;
  return pool.reduce((best, s) => ((s.startsAt ?? 0) > (best.startsAt ?? 0) ? s : best));
}

/**
 * Stages this wallet is eligible for that have not opened yet, soonest first.
 *
 * This is the pre-open capability the probe architecture could not provide: an
 * eligible wallet and a future stage is an answer, and it is available now rather
 * than at T-0.
 */
export function armableStages(
  snapshot: EligibilitySnapshot,
  nowMs: number,
): readonly WalletStageEligibility[] {
  return snapshot.stages
    .filter((s) => s.isEligible && s.startsAt !== null && s.startsAt > nowMs)
    .slice()
    .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));
}

export type StageDecision =
  /** Open now and this wallet may mint. */
  | { action: "fire"; stage: WalletStageEligibility }
  /** Eligible for a stage that has not opened. Hold and wake at `opensAtMs`. */
  | { action: "arm"; stage: WalletStageEligibility; opensAtMs: number; opensInMs: number }
  /** Nothing to do now, but the situation may change. */
  | { action: "wait"; reason: string }
  /** Nothing this wallet can do for this drop. */
  | { action: "stop"; reason: string };

/**
 * What should this wallet do about this drop, right now?
 *
 * The decision an eligibility check exists to produce. `arm` is the case the old
 * architecture could not reach: it requires knowing a wallet is eligible for a
 * stage that has not started, which is exactly what probing a closed mint
 * endpoint cannot tell you.
 *
 * `stop` is reserved for a genuinely closed door — every stage answered, none
 * eligible, none still to come. An unanswered or unmapped stage yields `wait`,
 * because silence is not a refusal.
 */
export function decideFromEligibility(
  snapshot: EligibilitySnapshot,
  nowMs: number,
): StageDecision {
  if (snapshot.walletMismatch !== undefined) {
    return {
      action: "stop",
      reason:
        `OpenSea answered for ${snapshot.walletMismatch}, not the wallet asked about. ` +
        "Refusing to act on another wallet's eligibility.",
    };
  }

  const live = liveEligibility(snapshot, nowMs);
  if (live !== null && live.isEligible) return { action: "fire", stage: live };

  const armable = armableStages(snapshot, nowMs);
  const next = armable[0];
  if (next !== undefined && next.startsAt !== null) {
    return {
      action: "arm",
      stage: next,
      opensAtMs: next.startsAt,
      opensInMs: next.startsAt - nowMs,
    };
  }

  if (live !== null) {
    return {
      action: "wait",
      reason: `not eligible for the open stage "${live.stageLabel}"`,
    };
  }

  // A stage with no window cannot be scheduled against, but it also has not been
  // ruled out — OpenSea simply did not say when it runs.
  const undated = snapshot.stages.filter((s) => s.isEligible && s.startsAt === null);
  if (undated.length > 0) {
    return {
      action: "wait",
      reason: `eligible for ${undated.length} stage(s) with no published start time`,
    };
  }

  if (snapshot.unansweredStages.length > 0) {
    return {
      action: "wait",
      reason: `no eligibility answer for ${snapshot.unansweredStages.join(", ")}`,
    };
  }

  if (snapshot.stages.length === 0) {
    return { action: "wait", reason: "OpenSea returned no stages for this drop" };
  }

  return { action: "stop", reason: "this wallet is not eligible for any remaining stage" };
}

/**
 * Terms for the mint, once a stage is chosen.
 *
 * `price` is per token and may legitimately be 0n. null is refused rather than
 * defaulted: a mint whose price we do not know is one whose value we cannot
 * check against the calldata, and that check is the thing standing between an
 * unverified API response and a signature.
 */
export function mintTerms(
  stage: WalletStageEligibility,
  quantity: number,
): { pricePerToken: bigint; totalValue: bigint; withinAllowance: boolean; allowance: number | null } | null {
  if (stage.price === null) return null;
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  return {
    pricePerToken: stage.price,
    totalValue: stage.price * BigInt(quantity),
    withinAllowance: stage.maxMintable === null ? true : quantity <= stage.maxMintable,
    allowance: stage.maxMintable,
  };
}

// ── Attributing an answer to a wallet ────────────────────────────────────────

/**
 * What a snapshot is allowed to say about the wallets this run is minting with.
 *
 * Separate from the CLI that prints it because the decision is the delicate
 * part: an eligibility answer is what makes a refusal explainable, and pinning
 * one wallet's answer to another wallet turns a helpful hint into a confident
 * lie. The rule is stated once, here, and tested.
 */
export type StageHint =
  /** Safe to record against `wallet`. */
  | { kind: "recorded"; wallet: string; hint: EligibilityHint; row: WalletStageEligibility }
  /** The token authorises an address this run is not minting with. */
  | { kind: "foreign"; wallet: string }
  /**
   * OpenSea did not name the wallet and more than one is loaded, so there is no
   * way to tell which of them the answer describes.
   */
  | { kind: "ambiguous"; candidates: number }
  /** OpenSea answered, but not for this stage. */
  | { kind: "no-row"; answered: number };

/**
 * Decide which wallet, if any, a snapshot's answer for `stage` belongs to.
 *
 * The scoped token is bound to a single wallet, so at most one wallet in a run
 * can be answered for. Three things can go wrong, and all three end in no hint
 * rather than a guess:
 *
 *   The response names an address that is not one of ours. The token belongs to
 *   a different wallet than the keys in .env, so its answer describes someone
 *   else's allowance.
 *
 *   The response names no address at all — legal, since the JWT already implies
 *   one. With a single wallet loaded there is only one thing it can mean. With
 *   several there is no way to choose, and choosing wrong is the expensive
 *   mistake, so nothing is recorded.
 *
 *   The response has no row carrying this stage's uuid. Nothing here falls back
 *   to position: a price and an allowance lifted off the wrong stage looks
 *   exactly like a right answer.
 *
 * @param loaded  Lowercased addresses of the wallets this run will mint with.
 */
export function hintForStage(
  snapshot: EligibilitySnapshot,
  stage: DropStage | null,
  loaded: ReadonlySet<string>,
): StageHint {
  if (snapshot.walletMismatch !== undefined) {
    return { kind: "foreign", wallet: snapshot.walletMismatch };
  }

  const named = snapshot.wallet.trim().toLowerCase();
  let subject: string;
  if (named !== "") {
    if (!loaded.has(named)) return { kind: "foreign", wallet: snapshot.wallet };
    subject = named;
  } else {
    if (loaded.size !== 1) return { kind: "ambiguous", candidates: loaded.size };
    subject = [...loaded][0]!;
  }

  const row = stage === null ? null : eligibilityForStage(snapshot, stage);
  if (!row) return { kind: "no-row", answered: snapshot.stages.length };

  return {
    kind: "recorded",
    wallet: subject,
    row,
    hint: { isEligible: row.isEligible, maxMintable: row.maxMintable },
  };
}
