// The dry run: everything except the broadcast.
//
// The point of this path is that it is not a separate path. A dry run reaches
// this report only by passing through the same preflight a live run does —
// balances, per-wallet cap, simulation, clock drift, nonce, signing. It stops at
// the one line that spends money. If it stopped earlier, or took a shortcut past
// a check, a green dry run would mean nothing, which is the only way a feature
// like this can actually hurt someone.
//
// Two deliberate differences from a live run, both of which make the dry run more
// useful rather than less strict:
//
//   1. Non-fatal refusals are collected, not thrown on. A live run aborts at the
//      first problem; you dry-run precisely to find all of them in one pass.
//   2. It does not wait for T-0. It reports when T-0 is and returns, because
//      sleeping for six hours to then not send anything helps nobody.
//
// Both are stated in the output. Everything here is pure: no provider, no socket,
// no clock read. The engine gathers the facts, this decides what they mean.

import { DriftVerdict } from "./clock";
import { GasSettings, formatEth, weiToGwei } from "./wallets";
import { formatRemaining } from "./timing";

export type SimVerdict = "passed" | "reverted" | "skipped";

export interface DryRunWallet {
  index: number;
  address: string;
  nonce: number;
  /**
   * The hash this transaction would have had.
   *
   * Derived locally from the signed bytes, so it is exact — not a guess. It is
   * also what the crash-safety record would have been keyed on, which makes a dry
   * run a way to see that record's contents before trusting it.
   */
  txHash: string;
  rawBytes: number;
  simulation: SimVerdict;
  simulationError?: string;
}

export interface DryRunReport {
  target: string;
  chainName: string;
  chainId: number;
  nativeSymbol: string;
  /** SeaDrop singleton or the token contract, depending on variant. */
  to: string;
  calldataBytes: number;
  valuePerWallet: bigint;
  gas: GasSettings;
  /** Corrected-time epoch ms the live run would fire at, or null for "immediately". */
  fireAtMs: number | null;
  nowMs: number;
  drift: DriftVerdict;
  wallets: DryRunWallet[];
  endpoints: string[];
  /** Wallets dropped during preflight, and the reason each was dropped. */
  skipped: { address: string; reason: string }[];
  /** Conditions under which a live run would have refused to broadcast. */
  refusals: string[];
}

/**
 * What a dry run does and does not establish.
 *
 * Printed verbatim by both renderers. The second sentence is the one that
 * matters: before a stage opens, every wallet's simulation reverts with
 * NotActive whether or not that wallet is eligible, so a pre-open dry run cannot
 * distinguish "not on the list" from "not open yet".
 */
export const DRY_RUN_CAVEAT =
  "A dry run proves the transaction can be built, funded, and signed, and that " +
  "preflight found no reason to refuse. It does not prove the mint will succeed: " +
  "simulation is an eth_call against the chain as it is right now, and a stage " +
  "that has not opened yet reverts with NotActive whether or not the wallet is " +
  "eligible. Nothing was broadcast and no gas was spent.";

export interface DryRunTotals {
  walletCount: number;
  totalValue: bigint;
  worstCaseGasPerWallet: bigint;
  /** Value plus the full fee ceiling for every wallet — the most this run could cost. */
  worstCaseTotal: bigint;
}

export function dryRunTotals(report: DryRunReport): DryRunTotals {
  const walletCount = report.wallets.length;
  const count = BigInt(walletCount);
  const worstCaseGasPerWallet = report.gas.gasLimit * report.gas.maxFeePerGas;
  return {
    walletCount,
    totalValue: report.valuePerWallet * count,
    worstCaseGasPerWallet,
    worstCaseTotal: (report.valuePerWallet + worstCaseGasPerWallet) * count,
  };
}

export interface DryRunOutcome {
  wouldFire: boolean;
  detail: string;
}

/**
 * Whether a live run, started now with this configuration, would broadcast.
 *
 * Deliberately conservative: any collected refusal makes this false, and so does
 * having nothing to send. "Would fire" is a claim about spending real money, so
 * it is only made when nothing at all objected.
 */
export function dryRunVerdict(report: DryRunReport): DryRunOutcome {
  if (report.refusals.length > 0) {
    const [first] = report.refusals;
    const more = report.refusals.length - 1;
    return {
      wouldFire: false,
      detail:
        `A live run would refuse: ${first ?? ""}` +
        (more > 0 ? ` (and ${more} other reason${more === 1 ? "" : "s"})` : ""),
    };
  }
  if (report.wallets.length === 0) {
    return { wouldFire: false, detail: "No wallet survived preflight — nothing would be sent." };
  }
  const reverted = report.wallets.filter((w) => w.simulation === "reverted").length;
  const suffix =
    reverted > 0
      ? ` ${reverted} of them currently simulate as reverting — expected before the stage opens, a real problem after it.`
      : "";
  return {
    wouldFire: true,
    detail: `A live run would broadcast ${report.wallets.length} transaction(s).${suffix}`,
  };
}

function simCell(wallet: DryRunWallet): string {
  if (wallet.simulation === "skipped") return "simulation skipped";
  if (wallet.simulation === "passed") return "simulation passed";
  return `simulation reverted: ${wallet.simulationError ?? "no reason given"}`;
}

/**
 * The report as plain lines, for the CLI to colour and the bot to escape.
 *
 * Contains no key material by construction — DryRunWallet has no key field — and
 * a test pins that, because the whole file is the kind of thing an operator pastes
 * into a chat when asking why a mint did not work.
 */
export function dryRunLines(report: DryRunReport, fmtTime: (ms: number) => string): string[] {
  const totals = dryRunTotals(report);
  const verdict = dryRunVerdict(report);
  const lines: string[] = [];

  lines.push(`DRY RUN — nothing will be broadcast.`);
  lines.push(`target:    ${report.target}`);
  lines.push(`chain:     ${report.chainName} (${report.chainId})`);
  lines.push(`to:        ${report.to}`);
  lines.push(`calldata:  ${report.calldataBytes} bytes`);
  lines.push(
    `price:     ${formatEth(report.valuePerWallet, report.nativeSymbol)} per wallet` +
      ` · ${formatEth(totals.totalValue, report.nativeSymbol)} total`,
  );
  lines.push(
    `gas:       ceiling ${weiToGwei(report.gas.maxFeePerGas).toFixed(4)} gwei` +
      ` · tip ${weiToGwei(report.gas.maxPriorityFeePerGas).toFixed(4)} gwei` +
      ` · limit ${report.gas.gasLimit}`,
  );
  // The number an operator actually needs before funding wallets: the ceiling is a
  // maximum, but it is the maximum they must be able to cover.
  lines.push(
    `max cost:  ${formatEth(totals.worstCaseTotal, report.nativeSymbol)} if every fee ceiling is fully used`,
  );

  if (report.fireAtMs === null) {
    lines.push(`fires:     immediately (no stage start known)`);
  } else {
    const delta = report.fireAtMs - report.nowMs;
    lines.push(
      `fires:     ${fmtTime(report.fireAtMs)}` +
        (delta > 0 ? ` (in ${formatRemaining(delta)})` : ` (${formatRemaining(-delta)} ago)`),
    );
  }
  lines.push(`clock:     ${report.drift.detail}`);
  lines.push(`endpoints: ${report.endpoints.length} broadcast target(s)`);

  lines.push("");
  lines.push(`would send ${report.wallets.length} transaction(s):`);
  for (const wallet of report.wallets) {
    lines.push(`  [W${wallet.index}] ${wallet.address}`);
    lines.push(`         nonce ${wallet.nonce} · ${wallet.rawBytes} bytes signed · ${simCell(wallet)}`);
    lines.push(`         would be ${wallet.txHash}`);
  }

  if (report.skipped.length > 0) {
    lines.push("");
    lines.push(`skipped ${report.skipped.length} wallet(s):`);
    for (const skip of report.skipped) lines.push(`  ${skip.address} — ${skip.reason}`);
  }

  if (report.refusals.length > 0) {
    lines.push("");
    lines.push(`a live run would refuse to broadcast:`);
    for (const refusal of report.refusals) lines.push(`  · ${refusal}`);
  }

  lines.push("");
  lines.push(verdict.detail);
  lines.push(DRY_RUN_CAVEAT);
  return lines;
}
