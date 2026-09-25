// Stage intelligence: one table describing every stage of a drop.
//
// A SeaDrop drop has up to five kinds of stage and they do not live in the same
// place, which is the entire difficulty here:
//
//   PUBLIC        lives on-chain, in the SeaDrop public drop struct (v1 singleton
//                 or v2 config-on-token). Price, window, per-wallet cap and fee
//                 recipient are all contract reads. Authoritative and untamperable.
//
//   GTD / TEAM /  live in OpenSea's drop configuration. On-chain there is only
//   ALLOWLIST /   `mintSigned()`, whose parameters arrive inside a server-signed
//   FCFS          payload at mint time — so before the stage opens there is no
//                 on-chain record of its price or window at all.
//
// That asymmetry is not a detail to paper over. An on-chain price cannot be
// changed under you; an API price is whatever the server said this second. So
// every row carries its `source`, and the renderers print it. A table that mixed
// the two silently would be a table that invites trusting the wrong half.
//
// When there is no API key, the non-public stages are not omitted — their absence
// is stated. Silently showing only the public stage is how someone concludes a
// drop has no allowlist and misses the only stage they were eligible for.
//
// All time arithmetic takes `nowMs` as an argument. Callers pass corrected time
// from src/core/clock; nothing here reads Date.now(), because the countdown in a
// panel and the instant the engine fires at must come from the same clock.

import { DropSchedule, DropStage } from "./opensea";
import { MintPlan, PublicDrop, SupplyInfo } from "./seadrop";

/**
 * Stage kinds, in the order they run in a drop.
 *
 * GTD ("guaranteed") and FCFS ("first come first served") are the two halves of a
 * typical allowlist: guaranteed holders have a reserved token, FCFS holders race
 * for the remainder. They differ in price and window often enough to be worth
 * separate rows.
 */
import {
  FireContext,
  MechanismEvidence,
  NO_EVIDENCE,
  PUBLIC_ONLY,
  isFireable,
  mechanismFor,
} from "./capabilities";

export type StageKind = "gtd" | "team" | "allowlist" | "fcfs" | "public" | "unknown";

export const STAGE_ORDER: StageKind[] = ["team", "gtd", "allowlist", "fcfs", "public", "unknown"];

export type StageStatus = "ended" | "live" | "upcoming";

/** Where a row's numbers came from. Printed in every renderer. */
export type StageSource = "on-chain" | "OpenSea API";

export interface StageRow {
  kind: StageKind;
  /** Display name — the creator's label when there is one. */
  label: string;
  source: StageSource;
  /** null when the stage's price is not knowable before it opens. */
  priceWei: bigint | null;
  startMs: number;
  /** 0 means "no end configured". */
  endMs: number;
  /** 0 means unlimited / not stated. */
  perWalletCap: number;
  status: StageStatus;
  /** ms until start (upcoming), until end (live), or 0 (ended). */
  countdownMs: number;
  /** Tokens still mintable, when knowable. */
  mintsLeft: bigint | null;
  /** Total mintable across the drop, when knowable. */
  mintsTotal: bigint | null;
  /** Set when a row is a placeholder for information that needs a key. */
  note?: string;
}

export interface StageTable {
  rows: StageRow[];
  /** True when OpenSea data was fetched and merged. */
  hasApiData: boolean;
  /** Set when the non-public stages could not be read. */
  apiNotice?: string;
  supply: SupplyInfo;
}

/**
 * Classify a stage against the clock.
 *
 * `endMs === 0` is SeaDrop's "no end" and must not be read as "ended in 1970" —
 * that would mark an open-ended live stage as finished and hide it from the table.
 */
export function classifyStatus(startMs: number, endMs: number, nowMs: number): StageStatus {
  if (endMs > 0 && nowMs >= endMs) return "ended";
  if (nowMs >= startMs) return "live";
  return "upcoming";
}

/** ms that the status column's countdown refers to. */
export function countdownFor(
  status: StageStatus,
  startMs: number,
  endMs: number,
  nowMs: number,
): number {
  if (status === "upcoming") return Math.max(0, startMs - nowMs);
  if (status === "live" && endMs > 0) return Math.max(0, endMs - nowMs);
  return 0;
}

/**
 * Map an OpenSea stage type to a kind.
 *
 * OpenSea's `stage_type` is not a closed enum across drops — it has carried
 * "public_sale", "presale", "allowlist" and creator-defined values. The label is
 * checked too, because the distinction between GTD and FCFS usually lives there
 * rather than in the type field.
 */
export function stageKindOf(type: string, label = ""): StageKind {
  const haystack = `${type} ${label}`.toLowerCase();

  if (/\bteam\b|founder|artist|reserve/.test(haystack)) return "team";
  if (/\bgtd\b|guarantee/.test(haystack)) return "gtd";
  if (/fcfs|first[- ]come|waitlist|raffle/.test(haystack)) return "fcfs";
  if (/public/.test(haystack)) return "public";
  if (/allow[- ]?list|presale|whitelist|\bwl\b/.test(haystack)) return "allowlist";
  return "unknown";
}

/**
 * The on-chain public stage as a row.
 *
 * `mintsLeft` comes from maxSupply − totalSupply rather than from the stage: the
 * per-stage `maxTokenSupplyForStage` is only present in the signed-mint params,
 * not in the public drop struct, so the collection-wide figure is the honest one
 * to show for a public stage.
 */
export function publicStageRow(
  drop: PublicDrop,
  supply: SupplyInfo,
  nowMs: number,
  label = "Public",
): StageRow {
  const startMs = drop.startTime * 1000;
  const endMs = drop.endTime * 1000;
  const status = classifyStatus(startMs, endMs, nowMs);

  const total = supply.maxSupply;
  const left =
    supply.maxSupply !== null && supply.totalSupply !== null
      ? supply.maxSupply - supply.totalSupply
      : null;

  return {
    kind: "public",
    label,
    source: "on-chain",
    priceWei: drop.mintPrice,
    startMs,
    endMs,
    perWalletCap: drop.maxTotalMintableByWallet,
    status,
    countdownMs: countdownFor(status, startMs, endMs, nowMs),
    mintsLeft: left !== null && left > 0n ? left : left === null ? null : 0n,
    mintsTotal: total,
  };
}

/**
 * An OpenSea-scheduled stage as a row.
 *
 * Price and cap are null/0: the drop schedule endpoint returns a stage's type and
 * window but not its price, and the price only becomes knowable inside the signed
 * mint payload once the stage is open. Printing a guess here would be worse than
 * printing "—", because the number would look like it came from somewhere.
 */
export function apiStageRow(stage: DropStage, nowMs: number): StageRow {
  const status = classifyStatus(stage.startMs, stage.endMs, nowMs);
  const kind = stageKindOf(stage.type, stage.label);

  return {
    kind,
    label: stage.label || stage.type,
    source: "OpenSea API",
    priceWei: null,
    startMs: stage.startMs,
    endMs: stage.endMs,
    perWalletCap: 0,
    status,
    countdownMs: countdownFor(status, stage.startMs, stage.endMs, nowMs),
    mintsLeft: null,
    mintsTotal: null,
    note: kind === "public" ? undefined : "price known at mint time",
  };
}

/**
 * Merge on-chain and API views into one table.
 *
 * The on-chain public row wins over an API public row wherever both exist. Both
 * describe the same stage, but only one of them is the thing the contract will
 * enforce — and a creator who edits the schedule on OpenSea without reconfiguring
 * the contract produces exactly that disagreement.
 */
export function buildStageTable(opts: {
  plan: MintPlan | null;
  supply: SupplyInfo;
  schedule?: DropSchedule | null;
  nowMs: number;
  hasApiKey: boolean;
  apiError?: string | undefined;
}): StageTable {
  const rows: StageRow[] = [];

  if (opts.plan) {
    rows.push(publicStageRow(opts.plan.drop, opts.supply, opts.nowMs));
  }

  const apiStages = opts.schedule?.stages ?? [];
  for (const stage of apiStages) {
    const row = apiStageRow(stage, opts.nowMs);
    // Don't duplicate the public stage we already read from the contract.
    if (row.kind === "public" && opts.plan) continue;
    rows.push(row);
  }

  rows.sort(byStageOrder);

  const table: StageTable = {
    rows,
    hasApiData: apiStages.length > 0,
    supply: opts.supply,
  };

  const notice = apiNotice(opts.hasApiKey, apiStages.length, opts.apiError);
  if (notice) table.apiNotice = notice;
  return table;
}

/**
 * Sort by stage order, then by start time.
 *
 * Kind before time because a table read top-to-bottom should follow the drop's
 * shape (team → guaranteed → allowlist → FCFS → public), which is also the order
 * they open in. Ties fall back to the clock.
 */
export function byStageOrder(a: StageRow, b: StageRow): number {
  const ka = STAGE_ORDER.indexOf(a.kind);
  const kb = STAGE_ORDER.indexOf(b.kind);
  if (ka !== kb) return ka - kb;
  return a.startMs - b.startMs;
}

/**
 * The sentence explaining what is missing from the table, or null.
 *
 * Three distinct situations, and collapsing them would hide the actionable one:
 * no key at all (fixable by setting one), a key that returned nothing (the drop
 * genuinely has no extra stages), and a key whose request failed (transient).
 */
export function apiNotice(
  hasApiKey: boolean,
  apiStageCount: number,
  apiError?: string,
): string | undefined {
  if (!hasApiKey) {
    return "Allowlist, FCFS, GTD and team stages are not shown: they live in OpenSea's drop configuration, not on-chain. Set OPENSEA_API_KEY to read them.";
  }
  if (apiError) {
    return `OpenSea's schedule could not be read (${apiError}) — only on-chain stages are shown.`;
  }
  if (apiStageCount === 0) {
    return "OpenSea lists no additional stages for this drop.";
  }
  return undefined;
}

// ── formatting shared by both renderers ──────────────────────────────────────

/** "HH:MM:SS", the countdown format used in every panel and in the CLI. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** "Mint left: [123 / 5000]" — the spec's format, verbatim. */
export function formatMintsLeft(left: bigint | null, total: bigint | null): string {
  if (left === null || total === null) return "Mint left: [unknown]";
  return `Mint left: [${left} / ${total}]`;
}

export function statusIcon(status: StageStatus): string {
  if (status === "ended") return "🔴";
  if (status === "live") return "🟢";
  return "⏳";
}

/**
 * The status cell: icon plus what the countdown means.
 *
 * "opens in 2h 14m" and "ends in 00:04:12" are different facts and a bare
 * duration next to a coloured dot does not say which one is on screen.
 */
export function statusText(row: StageRow): string {
  const icon = statusIcon(row.status);
  if (row.status === "ended") return `${icon} ended`;
  if (row.status === "live") {
    return row.endMs > 0
      ? `${icon} live now · ends in ${formatClock(row.countdownMs)}`
      : `${icon} live now`;
  }
  return `${icon} opens in ${formatCoarse(row.countdownMs)}`;
}

/**
 * A duration at human resolution: "2h 14m", "3d 4h", "45s".
 *
 * Two units, never three. The third unit is never what the reader needed, and it
 * pushes the table past the width a phone will render without wrapping.
 */
export function formatCoarse(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

/** The window cell: "start → end", or "start → no end". */
export function formatWindow(
  row: StageRow,
  fmt: (ms: number) => string,
): string {
  if (row.startMs === 0) return "not scheduled";
  const start = fmt(row.startMs);
  return row.endMs > 0 ? `${start} → ${fmt(row.endMs)}` : `${start} → no end`;
}

export function kindLabel(kind: StageKind): string {
  switch (kind) {
    case "gtd":
      return "GTD";
    case "team":
      return "Team";
    case "allowlist":
      return "Allowlist";
    case "fcfs":
      return "FCFS";
    case "public":
      return "Public";
    case "unknown":
      return "Other";
  }
}

/**
 * The stage that should be fired at: the highest-priority stage intern can
 * actually fire, live first, else the soonest one still to come.
 *
 * Selection is driven by the capability matrix rather than by a hardcoded
 * `kind === "public"` test, so a stage is a candidate exactly when the code can
 * fire it unattended. With the default context — ALLOWLIST_MINTING off — the
 * only fireable mechanism is `public`, which reproduces the previous behaviour
 * exactly; that equivalence is pinned by test.
 *
 * Gated stages outrank public when both are open, which is `STAGE_ORDER`'s
 * existing order. An allowlist stage you are eligible for is the one worth
 * taking: it is usually cheaper, usually capped, and the public stage is still
 * there afterwards. Ties break on that same order so the choice is deterministic
 * — an operator who re-runs and gets a different stage has no way to tell a
 * schedule change from a coin flip.
 */
export function actionableStage(
  table: StageTable,
  nowMs: number,
  ctx: FireContext = PUBLIC_ONLY,
  evidence: MechanismEvidence = NO_EVIDENCE,
): StageRow | undefined {
  const fireable = table.rows.filter((row) =>
    isFireable(mechanismFor(row.kind, evidence), ctx),
  );

  const byPriority = (a: StageRow, b: StageRow): number =>
    STAGE_ORDER.indexOf(a.kind) - STAGE_ORDER.indexOf(b.kind);

  const live = fireable.filter((r) => r.status === "live").sort(byPriority);
  if (live[0]) return live[0];

  return fireable
    .filter((r) => r.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs || byPriority(a, b))[0];
}
