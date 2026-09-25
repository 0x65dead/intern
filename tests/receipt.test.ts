// Receipt acceptance, and the nonce contract between the two mint paths.
//
// "minted" is the strongest word intern prints — the README sells it as distinct
// from "dispatched" and "accepted" precisely because the other two say nothing
// about ownership. `waitForReceipt` races every read endpoint and takes the first
// answer, which is what makes it fast; it therefore has to be sure that answer is
// about the transaction it asked about. A node that is stale behind a reorg, or
// simply wrong, must not be able to decide that word on its own.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { WARM_TIMEOUT_MS, waitForReceipt, warmConnections } from "../src/core/blast";
import { withNonces } from "../src/core/allowlist";
import { JsonRpcProvider } from "ethers";
import { LoadedWallet } from "../src/core/wallets";

const TX = `0x${"11".repeat(32)}`;
const OTHER_TX = `0x${"22".repeat(32)}`;
const URLS = ["https://node.example/rpc"];

/** A receipt as a node returns it: every field hex, status "0x1" or "0x0". */
function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionHash: TX,
    blockNumber: "0x1234",
    transactionIndex: "0x2",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x3b9aca00",
    status: "0x1",
    ...over,
  };
}

/** Swap global fetch for the duration of one call, always restoring it. */
async function withFetch<T>(result: unknown, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ json: async () => ({ result }) }) as unknown as Response) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const FAST = { timeoutMs: 60, pollMs: 10 };

describe("waitForReceipt — identity", () => {
  it("accepts a receipt for the transaction it asked about", async () => {
    const got = await withFetch(receipt(), () => waitForReceipt(TX, URLS, FAST));
    assert.ok(got);
    assert.equal(got.block, 0x1234);
    assert.equal(got.position, 2);
    assert.equal(got.gasUsed, 0x5208n);
    assert.equal(got.success, true);
  });

  it("refuses a receipt belonging to a different transaction", async () => {
    // The defect this file exists for. First reply wins, so a single endpoint
    // handing back someone else's receipt would otherwise print MINTED for a
    // transaction that may have reverted or never landed at all.
    const got = await withFetch(receipt({ transactionHash: OTHER_TX }), () =>
      waitForReceipt(TX, URLS, FAST),
    );
    assert.equal(got, null);
  });

  it("matches hashes case-insensitively", async () => {
    const got = await withFetch(receipt({ transactionHash: TX.toUpperCase().replace("0X", "0x") }), () =>
      waitForReceipt(TX, URLS, FAST),
    );
    assert.ok(got);
  });

  it("still accepts a node that omits transactionHash", async () => {
    // Not every client echoes it. Absence is not evidence of a mismatch, and
    // rejecting these would break receipts against otherwise fine endpoints.
    const { transactionHash: _omitted, ...rest } = receipt();
    const got = await withFetch(rest, () => waitForReceipt(TX, URLS, FAST));
    assert.ok(got);
  });
});

describe("waitForReceipt — malformed replies", () => {
  it("keeps waiting while the transaction is not yet mined", async () => {
    assert.equal(await withFetch(null, () => waitForReceipt(TX, URLS, FAST)), null);
  });

  it("rejects a receipt whose block number is not a number", async () => {
    const got = await withFetch(receipt({ blockNumber: "not-hex" }), () =>
      waitForReceipt(TX, URLS, FAST),
    );
    assert.equal(got, null);
  });

  it("rejects a receipt whose position is not a number", async () => {
    const got = await withFetch(receipt({ transactionIndex: "" }), () =>
      waitForReceipt(TX, URLS, FAST),
    );
    assert.equal(got, null);
  });

  it("reports a failed transaction as failed, not as absent", async () => {
    const got = await withFetch(receipt({ status: "0x0" }), () =>
      waitForReceipt(TX, URLS, FAST),
    );
    assert.ok(got);
    assert.equal(got.success, false);
  });

  it("tolerates a missing effectiveGasPrice", async () => {
    const { effectiveGasPrice: _none, ...rest } = receipt();
    const got = await withFetch(rest, () => waitForReceipt(TX, URLS, FAST));
    assert.ok(got);
    assert.equal(got.effectiveGasPrice, null);
  });

  it("returns null immediately when there is nowhere to read from", async () => {
    assert.equal(await waitForReceipt(TX, [], FAST), null);
  });
});

describe("withNonces", () => {
  function provider(counts: number[]): JsonRpcProvider {
    let call = 0;
    return {
      async getTransactionCount(): Promise<number> {
        const n = counts[call];
        call += 1;
        if (n === undefined) throw new Error("unexpected extra nonce request");
        return n;
      },
    } as unknown as JsonRpcProvider;
  }

  function wallet(index: number, address: string): LoadedWallet {
    return { index, address } as LoadedWallet;
  }

  it("assigns nonces by position, not by wallet index", async () => {
    // The two mint paths index different arrays and both are right. The engine
    // reads nonces[wallet.index] because it fetches for the full wallet list, so
    // position equals index there. `withNonces` fetches for the array it was
    // handed, so it must use that array's position — a caller passing a filtered
    // subset would otherwise read someone else's nonce.
    const wallets = [wallet(5, "0xaaa"), wallet(2, "0xbbb")];
    const nonced = await withNonces(provider([10, 20]), wallets);
    assert.equal(nonced[0]!.nonce, 10);
    assert.equal(nonced[1]!.nonce, 20);
    assert.equal(nonced[0]!.index, 5);
  });

  it("preserves the rest of the wallet", async () => {
    const nonced = await withNonces(provider([7]), [wallet(0, "0xaaa")]);
    assert.equal(nonced[0]!.address, "0xaaa");
  });

  it("returns one entry per wallet", async () => {
    const wallets = [wallet(0, "0xa"), wallet(1, "0xb"), wallet(2, "0xc")];
    assert.equal((await withNonces(provider([1, 2, 3]), wallets)).length, 3);
  });

  it("handles an empty wallet list", async () => {
    assert.deepEqual(await withNonces(provider([]), []), []);
  });
});

describe("waitForReceipt — cancelling stops the watching", () => {
  /** A fetch that never resolves a receipt, so only the signal can end the wait. */
  async function withPendingFetch<T>(fn: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ json: async () => ({ result: null }) }) as unknown as Response) as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  }

  it("returns long before the deadline when the run is cancelled", async () => {
    // The operator's /cancel used to be acknowledged and then ignored for up to
    // ninety seconds, which reads as a dead bot at the worst possible moment.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const startedMs = Date.now();
    const got = await withPendingFetch(() =>
      waitForReceipt(TX, URLS, { timeoutMs: 10_000, pollMs: 400, signal: controller.signal }),
    );
    const elapsed = Date.now() - startedMs;
    assert.equal(got, null);
    assert.ok(elapsed < 2_000, `returned after ${elapsed}ms, expected well under the 10s deadline`);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const got = await withPendingFetch(() =>
      waitForReceipt(TX, URLS, { timeoutMs: 10_000, pollMs: 400, signal: AbortSignal.abort() }),
    );
    assert.equal(got, null);
  });

  it("still honours the deadline when no signal is given", async () => {
    const got = await withPendingFetch(() => waitForReceipt(TX, URLS, FAST));
    assert.equal(got, null);
  });

  it("does not abandon a receipt that arrives before the cancel", async () => {
    // Cancelling must not throw away an answer already in hand: that hash minted.
    const controller = new AbortController();
    const got = await withFetch(receipt(), () =>
      waitForReceipt(TX, URLS, { ...FAST, signal: controller.signal }),
    );
    assert.ok(got);
    assert.equal(got.success, true);
  });
});

describe("warmConnections — an optimisation that cannot block the mint", () => {
  /** Records the signal each warm request was given, and never answers. */
  function captureSignals(): { signals: AbortSignal[]; restore: () => void } {
    const real = globalThis.fetch;
    const signals: AbortSignal[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        // AbortSignal.timeout()'s timer is unref'd, and this fake holds no socket,
        // so without a ref'd timer the test's event loop drains while the request
        // is still pending and node:test reports it as cancelled.
        const keepalive = setInterval(() => {}, 1_000);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearInterval(keepalive);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }) as typeof fetch;
    return { signals, restore: () => { globalThis.fetch = real; } };
  }

  it("gives every warm request a deadline", async () => {
    // Unbounded, this inherits undici's ~300s header timeout: one endpoint that
    // accepts the connection and then says nothing held up the whole prepare
    // phase, and the mint did not fire at all — to save a 200ms handshake.
    const cap = captureSignals();
    try {
      await warmConnections(["https://a.example", "https://b.example"], { timeoutMs: 40 });
      assert.equal(cap.signals.length, 2);
      for (const signal of cap.signals) assert.equal(signal.aborted, true);
    } finally {
      cap.restore();
    }
  });

  it("resolves rather than rejecting when every endpoint hangs", async () => {
    // Warming is best-effort by contract; its failures are already swallowed.
    const cap = captureSignals();
    try {
      await warmConnections(["https://a.example"], { timeoutMs: 20 });
    } finally {
      cap.restore();
    }
  });

  it("returns early when the run is cancelled mid-warm", async () => {
    const cap = captureSignals();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);
    const startedMs = Date.now();
    try {
      await warmConnections(["https://a.example"], {
        timeoutMs: 10_000,
        signal: controller.signal,
      });
    } finally {
      cap.restore();
    }
    const elapsed = Date.now() - startedMs;
    assert.ok(elapsed < 1_000, `warm took ${elapsed}ms after a cancel`);
  });

  it("keeps the default short enough that a warm is still worth having", () => {
    // Past a few seconds the handshake it saves is noise against the wait itself.
    assert.ok(WARM_TIMEOUT_MS > 0 && WARM_TIMEOUT_MS <= 5_000);
  });

  it("does nothing at all when given no endpoints", async () => {
    await warmConnections([]);
  });
});

describe("a cancelled wait is reported as what it is, in both renderers", () => {
  const BOT_SRC = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "bot", "format.ts"),
    "utf8",
  );
  const CLI_SRC = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "cli", "report.ts"),
    "utf8",
  );
  const ENGINE_SRC = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "core", "engine.ts"),
    "utf8",
  );

  it("carries the distinction on the event, so the two renderers cannot drift", () => {
    assert.match(ENGINE_SRC, /type: "receiptTimeout"; index: number; txHash: string; cancelled\?: boolean/);
  });

  it("tells the operator in both surfaces that the transaction is still live", () => {
    // The dangerous misreading is "cancelled, so nothing was spent". The hash was
    // already broadcast; an operator who re-mints on that belief pays twice.
    for (const [name, src] of [["bot", BOT_SRC], ["cli", CLI_SRC]] as const) {
      assert.match(src, /event\.cancelled === true/, `${name} branches on cancelled`);
      assert.match(src, /stopped watching \(cancelled\)/, `${name} names the cause`);
      assert.match(src, /may still mint/, `${name} says the transaction is still live`);
    }
  });

  it("still links the explorer on the cancelled branch, where it matters most", () => {
    assert.match(BOT_SRC, /stopped watching \(cancelled\)[\s\S]{0,200}explorerTx/);
    assert.match(CLI_SRC, /stopped watching \(cancelled\)[\s\S]{0,200}explorerTx/);
  });

  it("only claims cancellation when the signal actually aborted", () => {
    // A genuine 90s timeout on a healthy run must keep reading as a timeout.
    assert.match(ENGINE_SRC, /signal\?\.aborted === true \? \{ cancelled: true \} : \{\}/);
  });
});
