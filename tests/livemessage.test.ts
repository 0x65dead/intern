// The run panel under a rate limit.
//
// A mint emits far more than Telegram will accept, so the panel is one message
// edited in place. Every edit used to be fire-and-forget with a bare `catch {}`,
// on the reasoning that the next edit repeats the whole message so nothing is
// lost. That reasoning holds for every write but the last one, and the last one
// is the one carrying the per-wallet results and their tx hashes.
//
// These tests use real timers deliberately. The sleeps they exercise are the
// fix — a fake timer would prove the branch was taken, not that the bot waits.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { LiveMessage, createTelegramReporter } from "../src/bot/format";
import { EngineEvent } from "../src/core/engine";
import { resolveChain } from "../src/core/chains";
import { TelegramClient, TelegramError, TgMessage } from "../src/bot/api";

interface Attempt {
  method: "sendMessage" | "editMessage";
  text: string;
  atMs: number;
}

/**
 * A client whose failures are scripted per attempt.
 *
 * `fail` returns the error for attempt N, or null to let it through. Cast through
 * `unknown` for the same reason as elsewhere: LiveMessage touches two methods, and
 * a complete fake of the transport would be testing the fake.
 */
function scripted(fail: (attempt: number) => Error | null): {
  client: TelegramClient;
  attempts: Attempt[];
} {
  const attempts: Attempt[] = [];
  const started = Date.now();
  let n = 0;

  const record = (method: Attempt["method"], text: string): Error | null => {
    n += 1;
    attempts.push({ method, text, atMs: Date.now() - started });
    return fail(n);
  };

  const client = {
    async sendMessage(chatId: number, text: string): Promise<TgMessage> {
      const err = record("sendMessage", text);
      if (err) throw err;
      return { message_id: 7, chat: { id: chatId, type: "private" }, date: 0, text };
    },
    async editMessage(_chatId: number, _messageId: number, text: string): Promise<void> {
      const err = record("editMessage", text);
      if (err) throw err;
    },
  } as unknown as TelegramClient;

  return { client, attempts };
}

const never = (): null => null;
/** Frozen clock: the gate's arithmetic is unit-tested; here only real waits matter. */
const frozen = (): number => 1_700_000_000_000;

describe("LiveMessage — the panel survives a rate limit", () => {
  it("sends once and edits after that", async () => {
    const { client, attempts } = scripted(never);
    const live = new LiveMessage(client, 1, "Minting", frozen, 0);
    live.append("one");
    assert.equal(await live.settle(), true);
    live.append("two");
    assert.equal(await live.settle(), true);
    assert.deepEqual(
      attempts.map((a) => a.method),
      ["sendMessage", "editMessage"],
    );
  });

  it("reports the final write landing", async () => {
    const { client } = scripted(never);
    const live = new LiveMessage(client, 1, "Minting", frozen, 0);
    live.append("✓ minted");
    assert.equal(await live.settle(), true);
  });

  it("retries a failed final write instead of losing it", async () => {
    // The bug: one 429 on the last edit and the operator's last word on the mint
    // was whatever countdown happened to be on screen.
    const { client, attempts } = scripted((n) => (n === 1 ? new TelegramError(429, "Too Many Requests") : null));
    const live = new LiveMessage(client, 1, "Minting", frozen, 0);
    live.append("▲ DISPATCHED 60 transaction(s)");
    assert.equal(await live.settle(), true);
    assert.equal(attempts.length, 2);
    assert.match(attempts[1]?.text ?? "", /DISPATCHED/);
  });

  it("waits out the retry_after rather than hammering", async () => {
    const { client, attempts } = scripted((n) =>
      n === 1 ? new TelegramError(429, "Too Many Requests: retry after 1", 1) : null,
    );
    const live = new LiveMessage(client, 1, "Minting", frozen, 0);
    live.append("✓ receipt");
    assert.equal(await live.settle(), true);
    assert.equal(attempts.length, 2);
    // Telegram said one second. Retrying sooner earns a longer ban, not an edit.
    assert.ok((attempts[1]?.atMs ?? 0) >= 950, `retried after ${attempts[1]?.atMs}ms`);
  });

  it("gives up rather than hold the mint lock for minutes", async () => {
    // Telegram sometimes answers with a retry_after longer than the run. The
    // caller is told, and says so, instead of a stale panel reading as the result.
    const { client, attempts } = scripted(() => new TelegramError(429, "Too Many Requests", 600));
    const live = new LiveMessage(client, 1, "Minting", frozen, 0);
    live.append("✓ receipt");
    const startedMs = Date.now();
    assert.equal(await live.settle(), false);
    assert.equal(attempts.length, 1);
    assert.ok(Date.now() - startedMs < 1_000, "settle blocked on a 600s retry_after");
  });

  it("re-sends a panel the operator deleted", async () => {
    // Every later edit of a deleted message fails for a reason a fresh send fixes.
    // Before this the run went dark for the rest of the mint.
    const { client, attempts } = scripted((n) =>
      n === 2 ? new TelegramError(400, "Bad Request: message to edit not found") : null,
    );
    const live = new LiveMessage(client, 1, "Minting", frozen, 0);
    live.append("first");
    await live.settle();
    live.append("second");
    assert.equal(await live.settle(), true);
    assert.deepEqual(
      attempts.map((a) => a.method),
      ["sendMessage", "editMessage", "sendMessage"],
    );
  });

  it("keeps the tail when the body outgrows the cap", async () => {
    const { client, attempts } = scripted(never);
    const live = new LiveMessage(client, 1, "Minting", frozen, 0);
    for (let i = 0; i < 400; i += 1) live.append(`wallet ${i} — 0x${"a".repeat(40)} fired`);
    live.append("✓ minted 60 / failed 0");
    assert.equal(await live.settle(), true);
    const last = attempts[attempts.length - 1]?.text ?? "";
    assert.match(last, /minted 60/);
    assert.match(last, /earlier line\(s\) omitted/);
    assert.ok(last.length <= 4_096, `${last.length} chars`);
  });

  it("does not abort a mint because a progress write failed", async () => {
    // Only the final write is worth retrying; the rest must stay free to fail.
    const { client } = scripted((n) => (n <= 2 ? new Error("Telegram unreachable") : null));
    const live = new LiveMessage(client, 1, "Minting", frozen, 0);
    live.append("preparing");
    await assert.doesNotReject(() => live.flush());
    live.append("signing");
    await assert.doesNotReject(() => live.flush());
    live.append("✓ minted");
    assert.equal(await live.settle(), true);
  });
});

/**
 * Sixty wallets finishing at once.
 *
 * Receipts for a whole batch land within a block or two of each other. Each one
 * used to call `flush`, which exists to bypass the pacing — so a full run
 * produced sixty forced edits inside a few seconds against a limit of about one
 * per second, and Telegram stopped accepting them at exactly the moment the
 * operator was reading the result.
 *
 * Nothing is lost by pacing them: the message is cumulative, and `settle`
 * guarantees the last state lands.
 */
describe("a full batch of receipts does not flood", () => {
  const chain = resolveChain("base");
  assert.ok(chain, "base is a known chain");

  function receipts(count: number): EngineEvent[] {
    const out: EngineEvent[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push({
        type: "receipt",
        index: i,
        txHash: `0x${i.toString(16).padStart(64, "0")}`,
        block: 100 + i,
        position: i,
        success: true,
        gasUsed: 120_000n,
      });
    }
    return out;
  }

  it("costs a handful of edits, not one per wallet", async () => {
    const { client, attempts } = scripted(never);
    const reporter = createTelegramReporter(client, 1, chain, frozen);
    for (const event of receipts(60)) reporter.handle(event);
    assert.equal(await reporter.settle(), true);
    assert.ok(attempts.length <= 3, `${attempts.length} writes for 60 receipts`);
  });

  it("still shows every wallet in the final message", async () => {
    // Pacing must not turn into dropping. The cap trims the oldest lines and says
    // so; sixty receipt lines fit.
    const { client, attempts } = scripted(never);
    const reporter = createTelegramReporter(client, 1, chain, frozen);
    for (const event of receipts(60)) reporter.handle(event);
    reporter.handle({ type: "done", minted: 60, failed: 0 });
    await reporter.settle();
    const last = attempts[attempts.length - 1]?.text ?? "";
    for (const i of [0, 17, 59]) assert.match(last, new RegExp(`W${i} · block ${100 + i}`));
    assert.match(last, /60 wallet\(s\) minted/);
  });

  it("does not flush per-wallet events", () => {
    const SRC = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "bot", "format.ts"),
      "utf8",
    );
    // One flush left in the file: T-0 dispatch, which happens once per run.
    assert.equal(SRC.match(/live\.flush\(\)/g)?.length, 1);
    assert.match(SRC, /case "fired":[\s\S]{0,400}?live\.flush\(\)/);
  });
});
