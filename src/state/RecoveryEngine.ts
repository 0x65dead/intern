import type { TaskManager, TaskState, WalletExecutionStatus } from "./TaskManager";

interface RpcEnvelope<T> {
  result?: T | null;
  error?: { code?: number; message?: string };
}

interface RpcReceipt {
  transactionHash?: string;
  status?: string;
}

interface RpcTransaction {
  hash?: string;
  blockNumber?: string | null;
}

export type RecoveredTransactionState =
  | { kind: "mined"; success: boolean; hash: string }
  | { kind: "pending"; hash: string }
  | { kind: "unknown"; hash: string };

export interface RecoveryEngineOptions {
  taskManager: TaskManager;
  resolveRpcUrls: (task: TaskState) => string[];
  onAlert?: (task: TaskState, message: string) => Promise<void>;
  /** Must repeat target, stage, eligibility, funding, nonce and simulation checks. */
  revalidateUnbroadcast?: (task: TaskState) => Promise<boolean>;
  /** Called when an armed task reaches its target time. Must re-prepare before execution. */
  onDue?: (task: TaskState) => Promise<void>;
  /** Called for a persisted read-only WATCH task at startup. */
  onWatchResume?: (task: TaskState) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  requestTimeoutMs?: number;
}

export class RecoveryEngine {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly monitors = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: RecoveryEngineOptions) {
    this.now = options.now ?? Date.now;
    this.pollMs = Math.max(1_000, options.pollMs ?? 5_000);
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 5_000);
  }

  async recover(): Promise<void> {
    const tasks = this.options.taskManager.listTasks(["PENDING", "ARMED", "EXECUTING"]);
    for (const task of tasks) {
      try {
        await this.recoverTask(task);
      } catch (error) {
        await this.alert(task, `Recovery check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.monitors.values()) controller.abort();
    this.monitors.clear();
    await this.options.taskManager.flush();
  }

  private async recoverTask(task: TaskState): Promise<void> {
    if (task.type === "WATCH") {
      if (this.options.onWatchResume) {
        await this.options.onWatchResume(task);
      } else {
        await this.alert(task, "Watch persisted. Automatic watcher restoration is not configured; it remains saved and read-only.");
      }
      return;
    }

    const hashes: Array<{ walletIndex: number; hash: string }> = [];
    for (const [wallet, walletHashes] of Object.entries(task.txHashes)) {
      const walletIndex = Number(wallet);
      for (const hash of walletHashes) {
        hashes.push({ walletIndex, hash });
      }
    }

    // A hash is the irreversible boundary, even if the crash happened before
    // the EXECUTING status flush. Never treat a hash-bearing ARMED task as unsent.
    if (task.status === "EXECUTING" || hashes.length > 0) {
      if (task.status !== "EXECUTING") {
        await this.options.taskManager.transition(
          task.id,
          "EXECUTING",
          "Recovered a persisted transaction hash before broadcast-state flush",
        );
      }
      if (hashes.length === 0) {
        const canRearm = this.options.revalidateUnbroadcast
          ? await this.options.revalidateUnbroadcast(task)
          : false;
        if (canRearm) {
          const armed = await this.options.taskManager.transition(task.id, "ARMED", "Recovered pre-broadcast task after fresh validation");
          await this.scheduleOrRun(armed);
        } else {
          await this.options.taskManager.transition(
            task.id,
            "FAILED",
            "Process stopped before a transaction hash was journalled; automatic re-arm requires fresh eligibility, funding and simulation validation.",
          );
          await this.alert(task, "No broadcast hash was found. The task was not re-fired. Re-prepare and confirm it after fresh eligibility and funding checks.");
        }
        return;
      }

      const urls = this.options.resolveRpcUrls(task);
      if (urls.length === 0) {
        await this.alert(task, "Transaction hash is saved, but no read-capable RPC is configured. It will not be re-fired.");
        return;
      }

      const observations = await Promise.all(hashes.map(async ({ walletIndex, hash }) => ({
        walletIndex,
        observation: await this.inspectHash(hash, urls),
      })));
      const grouped = new Map<number, RecoveredTransactionState[]>();
      for (const observation of observations) {
        const group = grouped.get(observation.walletIndex) ?? [];
        group.push(observation.observation);
        grouped.set(observation.walletIndex, group);
      }

      const pending: Array<{ walletIndex: number; hash: string }> = [];
      for (const [walletIndex, walletHashes] of grouped) {
        const mined = walletHashes.find((entry) => entry.kind === "mined");
        if (mined?.kind === "mined") {
          const outcome: WalletExecutionStatus = mined.success ? "COMPLETED" : "FAILED";
          await this.options.taskManager.recordWalletOutcome(
            task.id,
            walletIndex,
            outcome,
            `Recovered receipt for ${mined.hash}: ${mined.success ? "success" : "reverted"}`,
          );
          continue;
        }
        const live = walletHashes.filter((entry) => entry.kind !== "mined");
        for (const entry of live) {
          pending.push({ walletIndex, hash: entry.hash });
        }
      }

      const refreshed = this.options.taskManager.getTask(task.id);
      if (refreshed && Object.values(refreshed.walletOutcomes).every((value) => value === "COMPLETED")) {
        await this.options.taskManager.transition(task.id, "COMPLETED", "All wallet receipts recovered successfully");
        await this.alert(task, "Recovery found successful receipts for every wallet. Task marked COMPLETED.");
        return;
      }
      if (refreshed && Object.values(refreshed.walletOutcomes).every((value) => value !== "PENDING")) {
        await this.options.taskManager.transition(task.id, "FAILED", "One or more wallet receipts recovered as reverted");
        await this.alert(task, "Recovery found a reverted mint receipt. Task marked FAILED; no replacement was sent.");
        return;
      }

      if (pending.length > 0) {
        await this.alert(task, `Found ${pending.length} transaction hash(es) without a terminal receipt. Monitoring the existing hash(es); no new transaction will be broadcast.`);
        this.startMonitor(task.id, pending, urls);
      } else {
        await this.alert(task, "Transaction outcome is not yet conclusive. Existing hashes are retained; no new mint will be sent.");
      }
      return;
    }

    await this.scheduleOrRun(task);
  }

  private async scheduleOrRun(task: TaskState): Promise<void> {
    const targetTime = task.targetTime;
    if (targetTime === null || targetTime <= this.now()) {
      if (this.options.onDue) {
        try {
          await this.options.onDue(task);
        } catch (error) {
          await this.options.taskManager.transition(task.id, "FAILED", "Due-task revalidation or execution failed");
          await this.alert(task, `Due task could not run: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        await this.alert(task, "Task is due and remains ARMED. No automatic execution adapter is configured; it will not send without fresh preparation.");
      }
      return;
    }

    const delay = Math.min(2_147_000_000, Math.max(0, targetTime - this.now()));
    const old = this.timers.get(task.id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      void this.handleDue(task.id).catch(async (error: unknown) => {
        await this.alert(task, `Scheduled recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delay);
    timer.unref?.();
    this.timers.set(task.id, timer);
  }

  private async handleDue(taskId: string): Promise<void> {
    const task = this.options.taskManager.getTask(taskId);
    if (!task || task.status === "CANCELLED" || task.status === "COMPLETED" || task.status === "FAILED") return;
    if (this.options.onDue) {
      await this.options.onDue(task);
      return;
    }
    await this.alert(task, "Scheduled time reached. Task remains ARMED until the live engine revalidates it; no stale calldata or signature is reused.");
  }

  private startMonitor(
    taskId: string,
    hashes: Array<{ walletIndex: number; hash: string }>,
    urls: string[],
  ): void {
    if (this.monitors.has(taskId)) return;
    const controller = new AbortController();
    this.monitors.set(taskId, controller);
    void this.monitorLoop(taskId, hashes, urls, controller.signal)
      .catch(async (error: unknown) => {
        const task = this.options.taskManager.getTask(taskId);
        if (task) await this.alert(task, `Receipt monitor stopped: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => this.monitors.delete(taskId));
  }

  private async monitorLoop(
    taskId: string,
    hashes: Array<{ walletIndex: number; hash: string }>,
    urls: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const pending = new Map(hashes.map((entry) => [entry.hash.toLowerCase(), entry]));
    while (!signal.aborted && pending.size > 0) {
      for (const [key, item] of pending) {
        const state = await this.inspectHash(item.hash, urls);
        if (state.kind !== "mined") continue;
        pending.delete(key);
        await this.options.taskManager.recordWalletOutcome(
          taskId,
          item.walletIndex,
          state.success ? "COMPLETED" : "FAILED",
          `Receipt observed after restart for ${state.hash}: ${state.success ? "success" : "reverted"}`,
        );
      }

      const task = this.options.taskManager.getTask(taskId);
      if (!task) return;
      const outcomes = Object.values(task.walletOutcomes);
      if (outcomes.length > 0 && outcomes.every((status) => status === "COMPLETED")) {
        await this.options.taskManager.transition(taskId, "COMPLETED", "Receipt monitor confirmed every wallet");
        await this.alert(task, "All recovered transactions confirmed successfully. Task marked COMPLETED.");
        return;
      }
      if (outcomes.length > 0 && outcomes.every((status) => status !== "PENDING")) {
        await this.options.taskManager.transition(taskId, "FAILED", "Receipt monitor observed a reverted transaction");
        await this.alert(task, "A recovered transaction reverted. Task marked FAILED.");
        return;
      }
      await this.sleep(this.pollMs, signal);
    }
  }

  private async inspectHash(hash: string, urls: string[]): Promise<RecoveredTransactionState> {
    for (const url of urls) {
      try {
        const receipt = await this.rpc<RpcReceipt>(url, "eth_getTransactionReceipt", [hash]);
        if (receipt && typeof receipt.status === "string") {
          const actualHash = receipt.transactionHash?.toLowerCase();
          if (actualHash && actualHash !== hash.toLowerCase()) continue;
          return { kind: "mined", success: receipt.status.toLowerCase() === "0x1", hash };
        }
      } catch {
        continue;
      }
    }
    for (const url of urls) {
      try {
        const transaction = await this.rpc<RpcTransaction>(url, "eth_getTransactionByHash", [hash]);
        if (transaction && transaction.hash?.toLowerCase() === hash.toLowerCase() && transaction.blockNumber === null) {
          return { kind: "pending", hash };
        }
      } catch {
        continue;
      }
    }
    return { kind: "unknown", hash };
  }

  private async rpc<T>(url: string, method: string, params: unknown[]): Promise<T | null> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const envelope = await response.json() as RpcEnvelope<T>;
    if (envelope.error) throw new Error(envelope.error.message ?? "RPC request failed");
    return envelope.result ?? null;
  }

  private async alert(task: TaskState, message: string): Promise<void> {
    try {
      await this.options.onAlert?.(task, message);
    } catch {
      // Notification failures must not mutate transaction conclusions.
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
