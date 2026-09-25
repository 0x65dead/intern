// The redaction choke point, tested at the wire.
//
// HARD CONSTRAINT 4 says every Telegram message routes through redactKeys(). That
// was previously kept by caller discipline, and an audit found the place the
// discipline had lapsed — one catch block that formatted an error straight into a
// message. So redaction moved into `call()`, the one transport every method shares.
//
// These tests assert the constraint where it actually matters: on the bytes handed
// to fetch. A test that only checked `sendMessage` would pass again the moment
// someone adds a sixth method.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { TelegramClient, isMessageGone, truncate } from "../src/bot/api";

// Shaped like a real bot token so the constructor's validation passes. Not one.
const TOKEN = `123456789:${"A".repeat(35)}`;
const KEY = `0x${"a".repeat(64)}`;
const MNEMONIC = "test test test test test test test test test test test junk";

const realFetch = globalThis.fetch;

/** Capture every request body, and answer as Telegram would. */
function captureFetch(): string[] {
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }): Promise<Response> => {
    bodies.push(init?.body ?? "");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return bodies;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("TelegramClient — outbound redaction", () => {
  it("never puts a private key on the wire", async () => {
    const bodies = captureFetch();
    const client = new TelegramClient(TOKEN);
    await client.sendMessage(42, `failed to sign with ${KEY}`);
    assert.equal(bodies.length, 1);
    assert.ok(!bodies[0]!.includes(KEY), `key reached the wire: ${bodies[0]}`);
    assert.match(bodies[0]!, /redacted-key/);
  });

  it("never puts a seed phrase on the wire", async () => {
    const bodies = captureFetch();
    const client = new TelegramClient(TOKEN);
    await client.sendMessage(42, `recovered with ${MNEMONIC}`);
    assert.ok(!bodies[0]!.includes("junk"), `mnemonic reached the wire: ${bodies[0]}`);
  });

  it("redacts an edited message too — the countdown edits fifty times", async () => {
    const bodies = captureFetch();
    const client = new TelegramClient(TOKEN);
    await client.editMessage(42, 7, `still holding ${KEY}`);
    assert.ok(!bodies[0]!.includes(KEY), `key reached the wire: ${bodies[0]}`);
  });

  it("redacts before truncating, so a long message cannot leak a key fragment", async () => {
    // Truncating first would cut the key at the 4096-character boundary, leaving a
    // partial key visible *and* too short for the pattern to match.
    const bodies = captureFetch();
    const client = new TelegramClient(TOKEN);
    await client.sendMessage(42, `${"x".repeat(4080)}${KEY}`);
    assert.ok(!bodies[0]!.includes(KEY.slice(2, 40)), `key fragment reached the wire`);
  });

  it("redacts a method the class does not special-case", async () => {
    // The point of moving redaction into `call()`: a future method that carries
    // text is covered without anyone remembering to cover it. `answerCallback`
    // passes its text through without touching redactKeys itself.
    const bodies = captureFetch();
    const client = new TelegramClient(TOKEN);
    await client.answerCallback("abc", `rejected: ${KEY}`);
    assert.equal(bodies.length, 1);
    assert.ok(!bodies[0]!.includes(KEY), `key reached the wire: ${bodies[0]}`);
  });

  it("leaves an ordinary message untouched", async () => {
    // Over-redaction would make run reports unreadable.
    const bodies = captureFetch();
    const client = new TelegramClient(TOKEN);
    const text = "minted: 3 · failed: 0 — 0x1234567890abcdef1234567890abcdef12345678";
    await client.sendMessage(42, text);
    assert.ok(bodies[0]!.includes("minted: 3"));
    // An address is 40 hex characters and must survive: it is what the operator
    // pastes into an explorer.
    assert.ok(bodies[0]!.includes("0x1234567890abcdef1234567890abcdef12345678"));
  });

  it("keeps the bot token out of an unreachable-Telegram error", async () => {
    // The token is in the URL, so a transport error can quote it.
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }) as typeof globalThis.fetch;
    const client = new TelegramClient(TOKEN);
    await assert.rejects(
      () => client.sendMessage(42, "hello"),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.ok(!message.includes(TOKEN), `token survived: ${message}`);
        assert.match(message, /redacted-bot-token/);
        return true;
      },
    );
  });
});

describe("TelegramClient — token validation", () => {
  it("refuses something that is not a bot token", () => {
    assert.throws(() => new TelegramClient("not-a-token"), /does not look like a bot token/);
  });

  it("accepts a well-formed token", () => {
    assert.doesNotThrow(() => new TelegramClient(TOKEN));
  });
});

/**
 * Truncation has to leave the message *sendable*, not merely short.
 *
 * Every one of these inputs used to produce a 400 from Telegram rather than a
 * shortened message, and the panel painter treats a failed edit as nothing to do
 * — so the visible symptom was a live run whose status silently stopped updating.
 * A mint prints one line per wallet, so long messages are the normal case.
 */
describe("truncate keeps HTML sendable", () => {
  const LIMIT = 60;
  const MARKER = "\n… (truncated)";

  it("leaves a message within the limit untouched", () => {
    assert.equal(truncate("<b>fine</b>", LIMIT), "<b>fine</b>");
  });

  it("respects the limit", () => {
    assert.ok(truncate("x".repeat(500), LIMIT).length <= LIMIT);
  });

  it("never cuts inside a tag", () => {
    // The cut lands in the middle of `<a href="…">`. Dropping the whole tag is
    // correct; emitting `<a hre` is a 400.
    const out = truncate(`${"x".repeat(50)}<a href="https://etherscan.io/tx/abc">t</a>`, LIMIT);
    assert.doesNotMatch(out, /<[^>]*$/, "a tag was left unterminated");
    assert.ok(!out.includes("<a hre") || out.includes("</a>"));
  });

  it("closes a tag left open at the cut", () => {
    const out = truncate(`<b>${"y".repeat(80)}</b>`, LIMIT);
    assert.ok(out.startsWith("<b>"));
    assert.ok(out.includes("</b>"), "unbalanced <b> is rejected by Telegram");
    assert.ok(out.length <= LIMIT);
  });

  it("closes nested tags in reverse order", () => {
    const out = truncate(`<b>${"a".repeat(20)}<code>${"b".repeat(40)}</code></b>`, LIMIT);
    assert.ok(out.includes("</code></b>"), `wrong nesting order: ${out}`);
  });

  it("does not split an entity", () => {
    const out = truncate(`${"z".repeat(43)}${"&amp;".repeat(4)}`, LIMIT);
    assert.doesNotMatch(out, /&[a-z]*$/);
    assert.doesNotMatch(out.replace(MARKER, ""), /&(?!amp;)/);
  });

  it("does not split a surrogate pair", () => {
    // A lone surrogate is not valid UTF-8 once JSON-encoded, so the request
    // itself is malformed rather than the markup.
    const text = `${"w".repeat(45)}${"🚀".repeat(10)}`;
    const out = truncate(text, LIMIT);
    assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])/);
    // The naive cut this replaced did produce one, at this exact boundary.
    assert.match(text.slice(0, 46), /[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("truncates a realistic multi-wallet run summary without breaking a link", () => {
    const row = (i: number) =>
      `<b>W${i}</b> <a href="https://etherscan.io/tx/0x${"c".repeat(64)}">tx</a>\n`;
    const out = truncate(Array.from({ length: 60 }, (_, i) => row(i)).join(""));
    assert.ok(out.length <= 4096);
    // Balanced: every opener has a closer.
    const opens = (out.match(/<(?!\/)[a-z]/g) ?? []).length;
    const closes = (out.match(/<\//g) ?? []).length;
    assert.equal(opens, closes, `unbalanced markup:\n${out.slice(-120)}`);
  });
});

/**
 * The difference between "gone" and "failed this time" decides whether a panel is
 * replaced. Getting it wrong in the permissive direction turns one rate-limited
 * edit into a chat full of duplicate panels.
 */
describe("isMessageGone", () => {
  for (const message of [
    "Bad Request: message to edit not found",
    "Bad Request: message to be edited not found",
    "Bad Request: message can't be edited",
    "Bad Request: MESSAGE_ID_INVALID",
  ]) {
    it(`treats "${message}" as gone`, () => {
      assert.equal(isMessageGone(new Error(message)), true);
    });
  }

  for (const message of [
    "Too Many Requests: retry after 12",
    "Telegram unreachable: fetch failed",
    "Bad Request: can't parse entities",
    "Internal Server Error",
    "Forbidden: bot was blocked by the user",
  ]) {
    it(`treats "${message}" as transient, keeping the panel`, () => {
      assert.equal(isMessageGone(new Error(message)), false);
    });
  }

  it("accepts a non-Error without throwing", () => {
    assert.equal(isMessageGone("message to edit not found"), true);
    assert.equal(isMessageGone(undefined), false);
  });
});
