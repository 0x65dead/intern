import { strict as assert } from "node:assert";
import { keccak256, Transaction, Wallet } from "ethers";
import { test } from "node:test";

import { prepare, waitForReceiptWithRbf } from "../src/core/blast";
import type { LoadedWallet } from "../src/core/wallets";

const TEST_PRIVATE_KEY = `0x${"11".repeat(32)}`;
const TEST_RECIPIENT = "0x0000000000000000000000000000000000000001";
const ORIGINAL_MAX_FEE = 100_000_000_000n;
const ORIGINAL_PRIORITY_FEE = 2_000_000_000n;

async function monitorWithCeiling(ceiling: bigint): Promise<{
  result: Awaited<ReturnType<typeof waitForReceiptWithRbf>>;
  replacementFees: Array<{ maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null }>;
  broadcastCount: number;
  beforeReplacementCount: number;
}> {
  const signer = new Wallet(TEST_PRIVATE_KEY);
  const loadedWallet: LoadedWallet = {
    index: 0,
    address: signer.address,
    key: TEST_PRIVATE_KEY,
  };
  const raw = await signer.signTransaction({
    type: 2,
    chainId: 1n,
    nonce: 7,
    to: TEST_RECIPIENT,
    value: 0n,
    gasLimit: 21_000n,
    maxFeePerGas: ORIGINAL_MAX_FEE,
    maxPriorityFeePerGas: ORIGINAL_PRIORITY_FEE,
  });
  const initial = prepare(raw);
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const replacementFees: Array<{ maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null }> = [];
  let broadcastCount = 0;
  let beforeReplacementCount = 0;
  const clockValues = ceiling >= 112_500_000_000n
    ? [0, 0, 0, 45_001, 45_001, 60_000]
    : [0, 0, 0, 45_001, 60_000];
  let clockIndex = 0;

  try {
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        method?: string;
        params?: unknown[];
      };
      let result: unknown = null;

      if (request.method === "eth_getTransactionByHash") {
        result = {
          hash: String(request.params?.[0] ?? ""),
          from: signer.address,
          nonce: "0x7",
          blockNumber: null,
        };
      } else if (request.method === "eth_sendRawTransaction") {
        const replacementRaw = request.params?.[0];
        assert.equal(typeof replacementRaw, "string");
        const replacementTx = Transaction.from(replacementRaw as string);
        replacementFees.push({
          maxFeePerGas: replacementTx.maxFeePerGas,
          maxPriorityFeePerGas: replacementTx.maxPriorityFeePerGas,
        });
        broadcastCount += 1;
        result = keccak256(replacementRaw as string);
      }

      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    Date.now = () => originalNow() + (clockValues[clockIndex++] ?? 60_000);

    const result = await waitForReceiptWithRbf(
      initial,
      loadedWallet,
      ["https://rpc.test/read"],
      [{ url: "https://rpc.test/send", label: "test" }],
      {
        timeoutMs: 60_000,
        pollMs: 200,
        stuckAfterMs: 45_000,
        maxFeePerGasWei: ceiling,
        maxAttempts: 1,
        onBeforeReplacement: async () => { beforeReplacementCount += 1; },
      },
    );

    return { result, replacementFees, broadcastCount, beforeReplacementCount };
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
}

test("bounded RBF increases both EIP-1559 fees by exactly 12.5%", async () => {
  const outcome = await monitorWithCeiling(120_000_000_000n);

  assert.equal(outcome.result.replacementCount, 1);
  assert.equal(outcome.result.ceilingReached, false);
  assert.equal(outcome.broadcastCount, 1);
  assert.equal(outcome.beforeReplacementCount, 1);
  assert.deepEqual(outcome.replacementFees, [{
    maxFeePerGas: 112_500_000_000n,
    maxPriorityFeePerGas: 2_250_000_000n,
  }]);
});

test("bounded RBF refuses to broadcast when the 12.5% bump exceeds the gas ceiling", async () => {
  const outcome = await monitorWithCeiling(110_000_000_000n);

  assert.equal(outcome.result.replacementCount, 0);
  assert.equal(outcome.result.ceilingReached, true);
  assert.match(outcome.result.reason ?? "", /gas ceiling reached/i);
  assert.equal(outcome.broadcastCount, 0);
  assert.equal(outcome.beforeReplacementCount, 0);
});
