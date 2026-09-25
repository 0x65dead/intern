// Render engine events to the terminal.
//
// The engine emits events and knows nothing about output; this file is the only
// place that decides how a run looks. The Telegram bot has its own renderer over
// the same event stream, which is why neither needs to reimplement the mint.
//
// One rule shapes the wording throughout: never report an outcome that has not
// been observed. "Dispatched" means bytes were written to a socket. "Accepted"
// means an endpoint acknowledged the transaction. "Minted" means a receipt with
// status 1 exists. Collapsing those three into "success" is how a tool ends up
// claiming a mint that reverted.

import { ChainProfile, explorerTx } from "../core/chains";
import { EngineEvent } from "../core/engine";
import { MintPlan } from "../core/seadrop";
import { DRY_RUN_CAVEAT, dryRunLines, dryRunVerdict } from "../core/dryrun";
import { EndpointHealth, RpcPlan, isBenignProbeError, maskRpc } from "../core/rpc";
import { formatEth, weiToGwei } from "../core/wallets";
import { formatLocal, formatRemaining, formatUtc } from "../core/timing";
import { ClockSync } from "../core/clock";
import { StageTable, actionableStage, formatClock } from "../core/stages";
import { STAGE_COLUMNS, StageContext, allStageCells, stageSummaryLines } from "../core/stagetable";
import {
  c,
  clearTransient,
  fail,
  field,
  heading,
  info,
  ok,
  padLeft,
  table,
  transient,
  warn,
} from "../util/render";

import { writeOut } from "../util/out";
export function printRpcPlan(plan: RpcPlan, chain: ChainProfile): void {
  for (const bad of plan.dropped) {
    writeOut(
      fail(
        `${bad.label} reports chain ${bad.chainId}, not ${chain.chainId} — excluded from broadcasting.\n`,
      ),
    );
  }

  const rows: string[][] = [];
  for (const h of plan.health) {
    if (plan.dropped.includes(h)) continue;
    rows.push(endpointRow(h));
  }
  if (rows.length > 0) writeOut(`${table(rows)}\n`);

  if (plan.read.length === 0) {
    writeOut(warn("No endpoint answered reads — nonces and balances cannot be read.\n"));
  } else {
    writeOut(
      ok(
        `chain ${chain.chainId} (${chain.name}) confirmed · reading from ${maskRpc(plan.read[0]!)}\n`,
      ),
    );
  }
  writeOut(
    info(`broadcasting to ${plan.blast.length} endpoint(s) simultaneously\n`),
  );
}

function endpointRow(h: EndpointHealth): string[] {
  const latency = h.latencyMs === null ? c.gray("—") : `${padLeft(String(h.latencyMs), 4)}ms`;
  if (h.readable) return [`  ${c.green("✓")}`, h.label, latency, ""];
  if (h.error && isBenignProbeError(h.error)) {
    return [`  ${c.gray("·")}`, c.gray(h.label), c.gray("send-only"), c.gray("(reads refused)")];
  }
  return [
    `  ${c.yellow("⚠")}`,
    c.yellow(h.label),
    latency,
    c.gray((h.error ?? "no response").slice(0, 70)),
  ];
}

export function printPlan(plan: MintPlan, chain: ChainProfile, quantity: number): void {
  const { drop } = plan;
  const startMs = drop.startTime * 1000;
  const endMs = drop.endTime * 1000;
  const now = Date.now();
  const live = now >= startMs && now < endMs;

  writeOut(heading("Drop") + "\n");
  writeOut(
    ok(`calldata built from on-chain state — no OpenSea account or token needed\n`),
  );
  writeOut(field("variant", plan.variant === "v1-singleton" ? "SeaDrop v1 singleton" : "SeaDrop v2 (token contract)") + "\n");
  writeOut(field("target", plan.to) + "\n");
  writeOut(field("collection", plan.nftContract) + "\n");
  writeOut(field("fee recipient", `${plan.feeRecipient} ${c.gray(`(${plan.feeRecipientSource})`)}`) + "\n");
  writeOut(
    field(
      "price",
      `${formatEth(drop.mintPrice, chain.nativeSymbol)} × ${quantity} = ${c.bold(formatEth(plan.value, chain.nativeSymbol))} per wallet`,
    ) + "\n",
  );
  writeOut(
    field(
      "per-wallet cap",
      drop.maxTotalMintableByWallet > 0 ? String(drop.maxTotalMintableByWallet) : "unlimited",
    ) + "\n",
  );
  if (plan.supply.maxSupply !== null && plan.supply.totalSupply !== null) {
    writeOut(
      field("supply", `${plan.supply.totalSupply} / ${plan.supply.maxSupply} minted`) + "\n",
    );
  }
  writeOut(field("calldata", `${(plan.data.length - 2) / 2} bytes (identical for every wallet)`) + "\n");
  writeOut(
    field(
      "window",
      `${formatLocal(startMs)} ${c.gray("→")} ${formatLocal(endMs)}  ${
        live ? c.green("(open now)") : c.yellow(`(opens in ${formatRemaining(startMs - now)})`)
      }`,
    ) + "\n",
  );
  writeOut(field("", c.gray(`${formatUtc(startMs)} UTC`)) + "\n");
}

/**
 * The stage table — the same columns `intern check` and the 📊 Stages panel both
 * show, because both build their cells from `allStageCells`.
 *
 * The bot renders these cells as labelled lines (a phone cannot hold eight aligned
 * columns); the terminal has the width for a real table, so it gets one. What the
 * columns *mean* is decided in stagetable.ts, so the two cannot disagree about a
 * drop even though they look different.
 */
export function printStages(
  stages: StageTable,
  chain: ChainProfile,
  nowMs: number,
  ctx: StageContext = {},
): void {
  writeOut(heading("Stages") + "\n");

  if (stages.rows.length === 0) {
    writeOut(info("No stages are configured for this drop yet.\n"));
  } else {
    const header = STAGE_COLUMNS.map((h) => c.gray(h));
    const rows: string[][] = [header];
    for (const cell of allStageCells(stages, chain, formatLocal, ctx)) {
      rows.push([
        cell.stage,
        cell.price,
        cell.window,
        cell.cap,
        cell.status,
        cell.mintsLeft,
        // A "not fireable" cell is the one thing in this table an operator must
        // not skim past, so it is coloured as the warning it is.
        cell.eligibility.startsWith("not fireable")
          ? c.yellow(cell.eligibility)
          : cell.eligibility,
        // The source is what tells "on-chain, untamperable" apart from "OpenSea's
        // copy of the config", so it is never dropped to save a column.
        cell.source === "on-chain" ? c.green(cell.source) : c.gray(cell.source),
      ]);
    }
    writeOut(`${table(rows)}\n`);
  }

  // The two verbatim summary lines, for whichever stage the user can act on next.
  const summary = stageSummaryLines(
    actionableStage(stages, nowMs, ctx.fire, ctx.evidence),
    formatClock,
  );
  for (const line of summary) writeOut(field("", line) + "\n");

  if (stages.apiNotice) writeOut(warn(`${stages.apiNotice}\n`));
}

export function printClock(sync: ClockSync): void {
  if (!sync.synced) {
    writeOut(
      warn("Could not measure clock offset — firing against the local clock as-is.\n"),
    );
    return;
  }
  const sign = sync.offsetMs >= 0 ? "+" : "";
  const magnitude = Math.abs(sync.offsetMs);
  const text = `local clock is ${magnitude}ms ${sync.offsetMs >= 0 ? "slow" : "fast"} (offset ${sign}${sync.offsetMs}ms, ±${sync.uncertaintyMs}ms)`;
  // Under ~50ms is normal drift and needs no attention. Beyond ~500ms the machine
  // has a real clock problem, and correcting for it is the difference between
  // firing at T-0 and firing late.
  if (magnitude < 50) writeOut(ok(`${text} — negligible\n`));
  else if (magnitude < 500) writeOut(ok(`${text} — corrected\n`));
  else
    writeOut(
      warn(`${text} — corrected, but consider enabling NTP on this machine\n`),
    );
}

export interface ReporterOptions {
  chain: ChainProfile;
  addresses: string[];
}

/**
 * Build an event handler that renders a run.
 *
 * Stateful only in that it tracks the countdown line so it can be overwritten in
 * place rather than scrolling hundreds of lines.
 */
export function createReporter(opts: ReporterOptions): (event: EngineEvent) => void {
  const { chain } = opts;
  let counting = false;
  // A dry run ends with minted: 0, which is not a failure and must not be
  // printed as "nothing minted" in red. The report above it already said what
  // happened.
  let wasDryRun = false;

  const endCountdown = (): void => {
    if (counting) {
      clearTransient();
      counting = false;
    }
  };

  return (event: EngineEvent): void => {
    switch (event.type) {
      case "phase": {
        endCountdown();
        const names: Record<string, string> = {
          prepare: "Preparing",
          simulate: "Simulating",
          sign: "Signing",
          wait: "Waiting for T-0",
          receipts: "Waiting for receipts",
        };
        const label = names[event.name] ?? event.name;
        writeOut(
          heading(label) + (event.detail ? ` ${c.gray(`— ${event.detail}`)}` : "") + "\n",
        );
        break;
      }

      case "clock":
        printClock(event.sync);
        break;

      case "balances": {
        for (const report of event.reports) {
          const balance =
            report.balance === null
              ? c.gray("balance unreadable")
              : formatEth(report.balance, event.symbol);
          const line = `[W${report.index}] ${report.address}  ${balance}`;
          if (report.sufficient) writeOut(info(`${line}\n`));
          else
            writeOut(
              fail(
                `${line}  needs ${formatEth(event.required, event.symbol)} (short ${formatEth(report.shortfall, event.symbol)})\n`,
              ),
            );
        }
        writeOut(
          info(
            `each wallet must hold value + gasLimit × maxFeePerGas = ${formatEth(event.required, event.symbol)}\n`,
          ),
        );
        break;
      }

      case "simulation":
        if (event.ok) writeOut(ok(`[W${event.index}] simulation passed\n`));
        else writeOut(warn(`[W${event.index}] ${event.error ?? "simulation failed"}\n`));
        break;

      case "signed":
        writeOut(
          ok(
            `${event.count} transaction(s) signed and serialized in ${event.elapsedMs.toFixed(1)}ms — nothing left to compute at T-0\n`,
          ),
        );
        break;

      case "countdown":
        counting = true;
        transient(`  ${c.cyan("◷")} ${event.text} until dispatch`);
        break;

      case "fired": {
        endCountdown();
        const drift =
          event.timingErrorMs === 0
            ? ""
            : ` ${c.gray(`· fired ${event.timingErrorMs > 0 ? "+" : ""}${event.timingErrorMs.toFixed(0)}ms from target`)}`;
        writeOut(
          `\n  ${c.bold(c.green(`▲ DISPATCHED ${event.count} transaction(s)`))} ${c.gray(`in ${event.dispatchMs.toFixed(2)}ms`)}${drift}\n`,
        );
        break;
      }

      case "tx":
        writeOut(info(`[W${event.index}] ${event.txHash}\n`));
        break;

      case "accepted":
        writeOut(
          ok(`[W${event.index}] accepted by ${event.label} in ${event.elapsedMs.toFixed(0)}ms\n`),
        );
        break;

      case "rejected":
        writeOut(
          fail(`[W${event.index}] rejected by every endpoint — not broadcast.\n`),
        );
        for (const reason of event.reasons) writeOut(`      ${c.red(reason)}\n`);
        if (event.hint) writeOut(`      ${c.yellow(`→ ${event.hint}`)}\n`);
        break;

      case "receipt": {
        const status = event.success ? c.bold(c.green("MINTED")) : c.bold(c.red("REVERTED"));
        writeOut(
          `  ${status} ${c.gray(`[W${event.index}]`)} block ${event.block} · position ${event.position} · gas ${event.gasUsed}\n`,
        );
        if (event.reason) writeOut(warn(`         ${event.reason}\n`));
        writeOut(info(`${explorerTx(chain.chainId, event.txHash)}\n`));
        break;
      }

      case "receiptTimeout":
        writeOut(
          warn(
            event.cancelled === true
              ? // Cancelling stopped the watching. It did not stop the transaction,
                // and saying "cancelled" without that would invite a second mint.
                `[W${event.index}] stopped watching (cancelled) — the transaction was already broadcast and may still mint: ${explorerTx(chain.chainId, event.txHash)}\n`
              : `[W${event.index}] no receipt yet — still pending or dropped: ${explorerTx(chain.chainId, event.txHash)}\n`,
          ),
        );
        break;

      case "warning":
        writeOut(warn(`${event.message}\n`));
        break;

      case "dryRun": {
        endCountdown();
        wasDryRun = true;
        const verdict = dryRunVerdict(event.report);
        writeOut("\n");
        for (const line of dryRunLines(event.report, formatLocal)) {
          // The caveat and the verdict are the two lines an operator must not
          // skim past, so they are the two that are not grey.
          if (line === DRY_RUN_CAVEAT) writeOut(`${c.gray(line)}\n`);
          else if (line === verdict.detail) {
            writeOut(
              `  ${verdict.wouldFire ? c.bold(c.green(line)) : c.bold(c.yellow(line))}\n`,
            );
          } else if (line.startsWith("DRY RUN")) writeOut(`  ${c.bold(c.cyan(line))}\n`);
          else writeOut(`  ${line}\n`);
        }
        writeOut("\n");
        break;
      }

      case "done": {
        endCountdown();
        if (wasDryRun) break;
        const summary =
          event.minted > 0
            ? c.bold(c.green(`${event.minted} wallet(s) minted`))
            : c.bold(c.red("nothing minted"));
        const failedPart = event.failed > 0 ? c.gray(` · ${event.failed} failed`) : "";
        writeOut(`\n  ${summary}${failedPart}\n`);
        break;
      }
    }
  };
}

export function printGasSummary(
  maxFeeWei: bigint,
  priorityWei: bigint,
  gasLimit: bigint,
  baseFeeWei: bigint | null,
): void {
  writeOut(heading("Gas") + "\n");
  if (baseFeeWei !== null) {
    writeOut(field("base fee now", `${weiToGwei(baseFeeWei).toFixed(4)} gwei`) + "\n");
  }
  writeOut(
    field("fee ceiling", `${weiToGwei(maxFeeWei).toFixed(4)} gwei ${c.gray("(a maximum, not a payment)")}`) + "\n",
  );
  writeOut(field("priority tip", `${weiToGwei(priorityWei).toFixed(4)} gwei`) + "\n");
  writeOut(field("gas limit", String(gasLimit)) + "\n");
  writeOut(
    field(
      "worst case",
      `${formatEth(gasLimit * maxFeeWei, "ETH")} per wallet if the ceiling is fully used`,
    ) + "\n",
  );
}
