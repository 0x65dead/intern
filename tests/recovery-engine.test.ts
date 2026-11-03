import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RecoveryEngine } from "../src/state/RecoveryEngine";
import { TaskManager } from "../src/state/TaskManager";

const TX_HASH = `0x${"a".repeat(64)}`;

async function createTaskManager(): Promise<{ directory: string; manager: TaskManager }> {
  const directory = await mkdtemp(join(tmpdir(), "intern-v2-tests-"));
  const manager = new TaskManager({ filePath: join(directory, "tasks.json") });
  await manager.init();
  return { directory, manager };
}

test("RecoveryEngine monitors a persisted EXECUTING transaction instead of firing it again", async () => {
  const { directory, manager } = await createTaskManager();
  const originalFetch = globalThis.fetch;
  const rpcMethods: string[] = [];
  let dueCalls = 0;
  let engine: RecoveryEngine | undefined;

  try {
    const task = await manager.createTask({
      type: "SNIPE",
      status: "EXECUTING",
      collection: "recovery-test",
      wallets: [0],
    });
    await manager.recordTxHash(task.id, 0, TX_HASH);

    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method?: string };
      const method = request.method ?? "";
      rpcMethods.push(method);

      const result = method === "eth_getTransactionReceipt"
        ? null
        : { hash: TX_HASH, blockNumber: null };

      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    engine = new RecoveryEngine({
      taskManager: manager,
      resolveRpcUrls: () => ["https://rpc.invalid"],
      onDue: async () => { dueCalls += 1; },
      pollMs: 1_000,
      requestTimeoutMs: 1_000,
    });

    await engine.recover();

    assert.equal(dueCalls, 0, "a transaction with a persisted hash must never be re-fired");
    assert.ok(rpcMethods.includes("eth_getTransactionReceipt"));
    assert.ok(rpcMethods.includes("eth_getTransactionByHash"));
    assert.equal(manager.getTask(task.id)?.status, "EXECUTING");
  } finally {
    if (engine) await engine.stop();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("RecoveryEngine revalidates an EXECUTING task without a hash before re-arming it", async () => {
  const { directory, manager } = await createTaskManager();
  let validationCalls = 0;
  let dueCalls = 0;
  let engine: RecoveryEngine | undefined;

  try {
    const task = await manager.createTask({
      type: "SNIPE",
      status: "EXECUTING",
      collection: "recovery-test",
      wallets: [0],
    });

    engine = new RecoveryEngine({
      taskManager: manager,
      resolveRpcUrls: () => [],
      revalidateUnbroadcast: async (candidate) => {
        assert.equal(candidate.id, task.id);
        validationCalls += 1;
        return true;
      },
      onDue: async () => { dueCalls += 1; },
    });

    await engine.recover();

    assert.equal(validationCalls, 1, "fresh eligibility/funding validation is required");
    assert.equal(manager.getTask(task.id)?.status, "ARMED");
    assert.equal(dueCalls, 0, "recovery must not bypass the normal due-task preparation path");
  } finally {
    if (engine) await engine.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskManager saves and reloads task state without losing transaction history", async () => {
  const { directory, manager } = await createTaskManager();

  try {
    const task = await manager.createTask({
      type: "SNIPE",
      status: "ARMED",
      collection: "persistence-test",
      wallets: [0, 2],
      config: { quantity: 2, chain: "ethereum" },
    });

    await manager.recordTxHash(task.id, 0, TX_HASH);
    await manager.recordWalletOutcome(task.id, 2, "COMPLETED", "Receipt confirmed");
    await manager.flush();

    const reloaded = new TaskManager({ filePath: join(directory, "tasks.json") });
    await reloaded.init();

    assert.deepEqual(reloaded.getTask(task.id), manager.getTask(task.id));
    assert.equal(reloaded.listExecutionHistory().some((entry) => entry.txHash === TX_HASH), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
