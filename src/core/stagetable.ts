// The stage table's shape, decided once for both renderers.
//
// The CLI prints plain text and the bot prints Telegram HTML, so they cannot share
// a finished string. What they can share — and what actually drifts when they
// don't — is the decision of which columns exist, what each cell says, and in what
// order the rows come out.
//
// So this module produces cells as plain strings and nothing else. The CLI pads
// them into a box; the bot escapes them into HTML. Neither one decides what a
// column means, which is why `intern check` and the 📊 Stages panel cannot end up
// disagreeing about a drop.

import { ChainProfile } from "./chains";
import {
  FireContext,
  MechanismEvidence,
  MintMechanism,
  NO_EVIDENCE,
  PUBLIC_ONLY,
  isFireable,
  mechanismFor,
  notFireableReason,
} from "./capabilities";
import {
  StageRow,
  StageTable,
  formatMintsLeft,
  formatWindow,
  kindLabel,
  statusText,
} from "./stages";
import { formatEth } from "./wallets";

export const STAGE_COLUMNS = [
  "stage",
  "price",
  "window",
  "cap",
  "status",
  "mints left",
  "eligibility",
  "source",
] as const;

export interface StageCells {
  stage: string;
  price: string;
  window: string;
  cap: string;
  status: string;
  mintsLeft: string;
  /**
   * Either what we know about this wallet set's standing, or — when the stage
   * cannot be fired at all — the reason, prefixed "not fireable:".
   *
   * Those two share a column on purpose. Eligibility is moot on a row intern
   * cannot act on, and an empty cell there reads as "checking" rather than as
   * "never". A row that silently showed neither would be the bug the capability
   * matrix exists to prevent.
   */
  eligibility: string;
  source: string;
}

/**
 * What the renderers know beyond the row itself.
 *
 * Optional throughout, and the defaults are the conservative ones: no allowlist
 * minting, no evidence of a Merkle root or a local signer. A caller that has not
 * been updated to pass context therefore sees the same table it saw before this
 * column existed, rather than an optimistic one.
 */
export interface StageContext {
  fire?: FireContext;
  evidence?: MechanismEvidence;
  /** Per-mechanism eligibility summary, already computed — see summariseEligibility. */
  eligibility?: Partial<Record<MintMechanism, string>>;
  /**
   * Mechanisms whose eligibility check could not run at all.
   *
   * Their `eligibility` line states the cause, and it outranks the generic
   * not-fireable reason. Without this the two cases collapse: a drop with no
   * allow-list configured and a drop whose allow-list failed to load both render
   * as "no loaded wallet has a proof", which is true of both and actionable for
   * neither — it sends the operator to look at their wallets when the real fault
   * is a mistyped path.
   */
  eligibilityUnavailable?: MintMechanism[];
}

/**
 * The first sentence of a reason, for a cell that has one line to work with.
 *
 * Truncating mid-sentence would produce exactly the half-explanation this project
 * is trying not to print, so the cut is at a sentence boundary and the full text
 * stays available in CAPABILITY.md.
 */
export function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(\s|$)/s.exec(text.trim());
  return (match?.[1] ?? text.trim()).replace(/\s+/g, " ");
}

function eligibilityCell(row: StageRow, ctx: StageContext): string {
  const evidence = ctx.evidence ?? NO_EVIDENCE;
  const fire = ctx.fire ?? PUBLIC_ONLY;
  const mechanism = mechanismFor(row.kind, evidence);
  const known = ctx.eligibility?.[mechanism];

  if (!isFireable(mechanism, fire)) {
    // A stated cause beats a derived one. Both are true; only one tells the
    // operator what to change.
    if (known !== undefined && (ctx.eligibilityUnavailable ?? []).includes(mechanism)) {
      return `not fireable: ${known}`;
    }
    return `not fireable: ${firstSentence(notFireableReason(mechanism, fire))}`;
  }
  if (known) return known;
  // A public stage has no eligibility question — saying so beats an em dash that
  // could equally mean "not checked yet".
  return mechanism === "public" ? "open to all" : "—";
}

/**
 * One row's cells.
 *
 * A null price prints "—" rather than "0 ETH". They are not the same claim: one
 * says the number is not knowable yet, the other says the mint is free, and a free
 * mint is a thing people act on.
 */
export function stageCells(
  row: StageRow,
  chain: ChainProfile,
  fmtTime: (ms: number) => string,
  ctx: StageContext = {},
): StageCells {
  return {
    stage: kindLabel(row.kind) === row.label ? kindLabel(row.kind) : `${kindLabel(row.kind)} · ${row.label}`,
    price: row.priceWei === null ? "—" : formatEth(row.priceWei, chain.nativeSymbol),
    window: formatWindow(row, fmtTime),
    cap: row.perWalletCap > 0 ? String(row.perWalletCap) : "—",
    status: statusText(row),
    mintsLeft:
      row.mintsLeft === null || row.mintsTotal === null
        ? "—"
        : `${row.mintsLeft} / ${row.mintsTotal}`,
    eligibility: eligibilityCell(row, ctx),
    source: row.source,
  };
}

export function allStageCells(
  table: StageTable,
  chain: ChainProfile,
  fmtTime: (ms: number) => string,
  ctx: StageContext = {},
): StageCells[] {
  return table.rows.map((row) => stageCells(row, chain, fmtTime, ctx));
}

/**
 * The two summary lines the spec fixes verbatim, for the drop's actionable stage.
 *
 * Both renderers print these under the table, in this wording: "Time until start:
 * HH:MM:SS" and "Mint left: [X / Total]".
 */
export function stageSummaryLines(row: StageRow | undefined, clockFmt: (ms: number) => string): string[] {
  if (!row) return [];
  const lines: string[] = [];

  if (row.status === "upcoming") {
    lines.push(`Time until start: ${clockFmt(row.countdownMs)}`);
  } else if (row.status === "live" && row.endMs > 0) {
    lines.push(`Time until end:   ${clockFmt(row.countdownMs)}`);
  }
  lines.push(formatMintsLeft(row.mintsLeft, row.mintsTotal));
  return lines;
}
