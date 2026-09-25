// Rendering a run into Telegram messages.
//
// The constraint that shapes this file is Telegram's rate limit: roughly one
// message edit per second per chat, and a hard 4096-character cap. A mint emits
// events far faster than that — the countdown alone hops every 50ms near T-0 — so
// events are folded into a single message that updates, rather than a stream of
// messages that scroll.
//
// Two rules keep that from losing information:
//
//   No event is ever dropped. The message is cumulative — every append stays in
//   it — and `settle` guarantees the final state lands before the run is reported
//   as finished. So "not flushed" means "shown a moment later", never "lost".
//
//   Only events that happen once per run are flushed immediately: T-0 dispatch,
//   and that is all. Per-wallet events are not. The earlier version flushed every
//   receipt, which on a sixty-wallet run is sixty forced edits inside a few
//   seconds against a limit of roughly one per second — a rate limit earned at
//   the exact moment the operator is reading the outcome, and nothing gained,
//   because the line was already in the message either way.
//
//   The 50ms fine-timer and busy-spin phases are never sent at all. They exist to
//   hit T-0 precisely; forwarding them would spend the rate limit during the exact
//   second the socket writes need to happen.

import { ChainProfile, explorerTx } from "../core/chains";
import { EngineEvent } from "../core/engine";
import { dryRunLines, dryRunVerdict } from "../core/dryrun";
import { formatEth, weiToGwei } from "../core/wallets";
import { formatLocal, formatRemaining } from "../core/timing";
import { TelegramClient, TelegramError, bold, code, esc, isMessageGone, link } from "./api";
import {
  WriteGate,
  nextWriteDelay,
  newWriteGate,
  noteRateLimit,
  planFinalWrite,
} from "./refresh";



export function formatGas(
  maxFeeWei: bigint,
  priorityWei: bigint,
  gasLimit: bigint,
  baseFeeWei: bigint | null,
  symbol: string,
): string {
  const lines = [bold("Gas")];
  if (baseFeeWei !== null) lines.push(`base fee now: ${weiToGwei(baseFeeWei).toFixed(4)} gwei`);
  lines.push(`ceiling: ${weiToGwei(maxFeeWei).toFixed(4)} gwei ${esc("(a maximum, not a payment)")}`);
  lines.push(`tip: ${weiToGwei(priorityWei).toFixed(4)} gwei`);
  lines.push(`gas limit: ${gasLimit}`);
  lines.push(`worst case: ${esc(formatEth(gasLimit * maxFeeWei, symbol))} per wallet`);
  return lines.join("\n");
}

/**
 * A Telegram message that updates in place, rate-limit aware.
 *
 * Appends are buffered and written at most every `intervalMs`; `flush` forces a
 * write for events that must not wait. When the buffer outgrows Telegram's message
 * cap the oldest lines are dropped and a marker is left, so the tail — which is
 * where the outcome is — always survives.
 *
 * "Rate-limit aware" now means both halves of it. The interval keeps us under the
 * limit; the `WriteGate` obeys Telegram when we go over anyway. It used to mean
 * only the first, and the error handler below discarded the 429 that carried the
 * retry_after — so exceeding the limit produced a 1.2s retry loop against a
 * limiter that lengthens its answer each time.
 *
 * Time is injected, not read. Same reason as `refresh.ts`: a gate that reads the
 * clock itself can only be tested by sleeping.
 */
export class LiveMessage {
  private lines: string[] = [];
  private messageId: number | null = null;
  private gate: WriteGate = newWriteGate();
  private pending: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dropped = 0;
  /** Replaced on every update rather than appended — for countdowns. */
  private tail: string | null = null;
  /** The last write's failure, or null if it landed. Read only by `settle`. */
  private lastError: unknown = null;

  constructor(
    private readonly client: TelegramClient,
    private readonly chatId: number,
    private readonly header: string,
    private readonly now: () => number,
    private readonly intervalMs = 1_200,
  ) {}

  append(line: string): void {
    this.lines.push(line);
    // Keep the message under Telegram's cap by dropping the oldest body lines.
    while (this.lines.join("\n").length > 3_600 && this.lines.length > 1) {
      this.lines.shift();
      this.dropped++;
    }
    this.schedule();
  }

  setTail(line: string | null): void {
    this.tail = line;
    this.schedule();
  }

  private render(): string {
    const parts = [this.header];
    if (this.dropped > 0) parts.push(esc(`… ${this.dropped} earlier line(s) omitted`));
    parts.push(...this.lines);
    if (this.tail) parts.push(this.tail);
    return parts.join("\n");
  }

  private schedule(): void {
    if (this.pending) return;
    const wait = nextWriteDelay(this.gate, this.now(), this.intervalMs);
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.write();
    }, wait);
  }

  /**
   * Write now, and wait for it. Used for events that must not be lost.
   *
   * "Now" skips our own interval but still waits out a retry_after. A terminal
   * event that jumps the queue into a 429 is not delivered promptly, it is
   * dropped — and the whole point of flushing it is that it must not be.
   */
  async flush(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    const wait = nextWriteDelay(this.gate, this.now(), this.intervalMs, true);
    if (wait > 0) await sleep(wait);
    await this.write();
  }

  private write(): Promise<void> {
    // Serialize writes: two concurrent edits of the same message race, and the
    // loser's content is silently discarded.
    this.writing = this.writing.then(async () => {
      const startedMs = this.now();
      this.gate = { ...this.gate, lastWriteMs: startedMs };
      const text = this.render();
      try {
        await this.send(text);
        this.lastError = null;
      } catch (err: unknown) {
        this.lastError = err;
        // The one piece of information a 429 carries, previously thrown away.
        if (err instanceof TelegramError) {
          this.gate = noteRateLimit(this.gate, startedMs, err.retryAfterSec);
        }
        // A message the operator deleted can never be edited again, so every
        // remaining write of the run would fail for a reason a fresh send fixes.
        if (isMessageGone(err)) this.messageId = null;
        // A failed progress write must never abort a mint, and costs nothing: the
        // next write carries the whole message again. `settle` handles the final
        // one, which is the only write whose loss the operator pays for.
      }
    });
    return this.writing;
  }

  private async send(text: string): Promise<void> {
    if (this.messageId === null) {
      const sent = await this.client.sendMessage(this.chatId, text);
      this.messageId = sent.message_id;
    } else {
      await this.client.editMessage(this.chatId, this.messageId, text);
    }
  }

  /**
   * Land the final state of the message, retrying inside a budget.
   *
   * Returns whether it landed. The caller needs to know: the per-wallet fired and
   * receipt lines with their tx hashes exist nowhere except this message, and
   * before this the loop above swallowed a 429 on the last write and reported the
   * run as finished — leaving a stale countdown as the operator's final word on a
   * mint that had already spent real money. Silence read as success.
   *
   * Bounded, because this runs while the global mint lock is still held.
   */
  async settle(): Promise<boolean> {
    const startedMs = this.now();
    for (let attempt = 1; ; attempt += 1) {
      await this.flush();
      await this.writing;
      if (this.lastError === null) return true;
      const plan = planFinalWrite(
        attempt,
        nextWriteDelay(this.gate, this.now(), this.intervalMs, true),
        this.now() - startedMs,
      );
      if (plan.kind === "giveup") return false;
      await sleep(plan.waitMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Build an event handler that renders a run into one live message.
 *
 * Returns the handler plus a `settle` that resolves once every buffered write has
 * landed — the caller awaits it before reporting the run as finished, so the last
 * message a user sees is the real outcome and not a stale countdown.
 */
export function createTelegramReporter(
  client: TelegramClient,
  chatId: number,
  chain: ChainProfile,
  now: () => number,
): { handle: (event: EngineEvent) => void; settle: () => Promise<boolean> } {
  const live = new LiveMessage(client, chatId, bold("Minting"), now);
  let lastCountdown = 0;
  let dry = false;

  const handle = (event: EngineEvent): void => {
    switch (event.type) {
      case "phase": {
        const names: Record<string, string> = {
          prepare: "Preparing",
          simulate: "Simulating",
          sign: "Signing",
          wait: "Waiting for T-0",
          receipts: "Waiting for receipts",
        };
        live.append(`\n${bold(names[event.name] ?? event.name)}${event.detail ? esc(` — ${event.detail}`) : ""}`);
        break;
      }

      case "clock": {
        if (!event.sync.synced) {
          live.append(esc("⚠ clock not measured — using the local clock as-is"));
          break;
        }
        const magnitude = Math.abs(event.sync.offsetMs);
        live.append(
          magnitude < 50
            ? esc(`✓ clock accurate (${event.sync.offsetMs >= 0 ? "+" : ""}${event.sync.offsetMs}ms)`)
            : esc(
                `✓ clock is ${magnitude}ms ${event.sync.offsetMs >= 0 ? "slow" : "fast"} — corrected`,
              ),
        );
        break;
      }

      case "balances": {
        for (const report of event.reports) {
          if (report.sufficient) continue;
          live.append(
            esc(`✗ W${report.index} short ${formatEth(report.shortfall, event.symbol)}`),
          );
        }
        live.append(esc(`each wallet needs ${formatEth(event.required, event.symbol)}`));
        break;
      }

      case "simulation":
        live.append(
          event.ok
            ? esc(`✓ W${event.index} simulation passed`)
            : esc(`⚠ W${event.index} ${event.error ?? "simulation failed"}`),
        );
        break;

      case "signed":
        live.append(
          esc(`✓ ${event.count} transaction(s) signed in ${event.elapsedMs.toFixed(1)}ms — nothing left to compute at T-0`),
        );
        break;

      case "countdown": {
        // Only the coarse phase is worth a network round trip, and only every few
        // seconds. The last two seconds are where precision matters most, and
        // spending the rate limit there would be actively harmful.
        if (event.remainingMs < 3_000) break;
        const at = now();
        if (at - lastCountdown < 3_000) break;
        lastCountdown = at;
        live.setTail(esc(`◷ ${formatRemaining(event.remainingMs)} until dispatch`));
        break;
      }

      // The only forced write: once per run, and the instant the operator is
      // waiting for. Everything after it is per-wallet and paced.
      case "fired":
        live.setTail(null);
        live.append(
          `${bold(`▲ DISPATCHED ${event.count} transaction(s)`)}${esc(` in ${event.dispatchMs.toFixed(2)}ms`)}${
            event.timingErrorMs !== 0
              ? esc(` · ${event.timingErrorMs > 0 ? "+" : ""}${event.timingErrorMs.toFixed(0)}ms from target`)
              : ""
          }`,
        );
        void live.flush();
        break;

      case "tx":
        live.append(link(`W${event.index} tx`, explorerTx(chain.chainId, event.txHash)));
        break;

      case "accepted":
        live.append(esc(`✓ W${event.index} accepted by ${event.label} in ${event.elapsedMs.toFixed(0)}ms`));
        break;

      case "rejected":
        // Per-wallet, so deliberately not flushed. See the header: the line is in
        // the message the moment it is appended, and the next scheduled write
        // carries it. Forcing one edit per wallet buys a 429, not promptness.
        live.append(esc(`✗ W${event.index} rejected by every endpoint — not broadcast`));
        for (const reason of event.reasons.slice(0, 3)) live.append(code(reason.slice(0, 200)));
        if (event.hint) live.append(esc(`→ ${event.hint}`));
        break;

      case "receipt":
        // Also per-wallet. Sixty of these land within a block or two of each other.
        live.append(
          `${event.success ? bold("MINTED") : bold("REVERTED")} ${esc(`W${event.index} · block ${event.block} · gas ${event.gasUsed}`)}` +
            (event.reason ? `\n${esc(event.reason)}` : ""),
        );
        break;

      case "receiptTimeout":
        live.append(
          `${esc(
            event.cancelled === true
              ? // Cancelling stopped the watching, not the transaction.
                `⚠ W${event.index} stopped watching (cancelled) — already broadcast, may still mint: `
              : `⚠ W${event.index} no receipt yet — `,
          )}${link("check on the explorer", explorerTx(chain.chainId, event.txHash))}`,
        );
        break;

      case "warning":
        live.append(esc(`⚠ ${event.message}`));
        break;

      case "dryRun": {
        dry = true;
        live.setTail(null);
        const verdict = dryRunVerdict(event.report);
        // Sent as its own block rather than folded into the live message: this
        // is the whole output of the command, and the live message is a
        // scratchpad that keeps being overwritten.
        live.append(
          [
            bold(verdict.wouldFire ? "🧪 Dry run — would fire" : "🧪 Dry run — would NOT fire"),
            "",
            esc(dryRunLines(event.report, formatLocal).join("\n")),
          ].join("\n"),
        );
        break;
      }

      case "done":
        live.setTail(null);
        // A dry run ends with minted: 0, which is not "nothing minted" — it is
        // "nothing was sent, as promised". The report above already said so.
        if (dry) break;
        live.append(
          event.minted > 0
            ? bold(`✓ ${event.minted} wallet(s) minted`)
            : bold("✗ nothing minted"),
        );
        break;
    }
  };

  return { handle, settle: () => live.settle() };
}
