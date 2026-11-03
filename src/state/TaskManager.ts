import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type TaskKind = "WATCH" | "SNIPE";
export type TaskStatus = "PENDING" | "ARMED" | "EXECUTING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type WalletExecutionStatus = "PENDING" | "COMPLETED" | "FAILED";

export type TaskConfigValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[];

export type TaskConfig = Record<string, TaskConfigValue>;

export interface TaskState {
  id: string;
  type: TaskKind;
  status: TaskStatus;
  targetTime: number | null;
  collection: string;
  stage: string | null;
  wallets: number[];
  config: TaskConfig;
  /** Every known transaction hash per wallet, oldest to newest. */
  txHashes: Record<string, string[]>;
  /** Per-wallet terminal result, filled only after a receipt is known. */
  walletOutcomes: Record<string, WalletExecutionStatus>;
  createdAt: number;
  updatedAt: number;
}

export interface TaskHistoryEntry {
  id: string;
  taskId: string;
  at: number;
  action: string;
  status: TaskStatus;
  walletIndex?: number;
  txHash?: string;
  replacedTxHash?: string;
  reason?: string;
}

export interface WatchlistEntry {
  id: string;
  collection: string;
  chain: string;
  stage: string | null;
  createdAt: number;
  enabled: boolean;
  config: TaskConfig;
}

export interface CreateTaskInput {
  type: TaskKind;
  status?: TaskStatus;
  targetTime?: number | null;
  collection: string;
  stage?: string | null;
  wallets?: number[];
  config?: TaskConfig;
}

interface TaskStore {
  version: 1;
  tasks: Record<string, TaskState>;
  watchlist: WatchlistEntry[];
  executionHistory: TaskHistoryEntry[];
}

export interface TaskManagerOptions {
  filePath?: string;
  now?: () => number;
  onError?: (message: string, error: unknown) => void;
}

const MAX_HISTORY = 5_000;
const SECRET_CONFIG_KEY = /(private.?key|seed|mnemonic|token|secret|password|api.?key|rpc.?url|credential)/i;

function emptyStore(): TaskStore {
  return { version: 1, tasks: {}, watchlist: [], executionHistory: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "PENDING" || value === "ARMED" || value === "EXECUTING" ||
    value === "COMPLETED" || value === "FAILED" || value === "CANCELLED";
}

function validateConfig(config: TaskConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_CONFIG_KEY.test(key)) {
      throw new Error(`Task config may not persist secret-bearing field "${key}".`);
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean" &&
      !(Array.isArray(value) && value.every((item) =>
        typeof item === "string" || (typeof item === "number" && Number.isFinite(item)),
      ))
    ) {
      throw new Error(`Task config field "${key}" is not JSON-safe.`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Task config field "${key}" must be finite.`);
    }
  }
}

function validateTask(task: unknown): task is TaskState {
  if (!isObject(task)) return false;
  if (
    typeof task.id !== "string" ||
    (task.type !== "WATCH" && task.type !== "SNIPE") ||
    !isTaskStatus(task.status) ||
    !(task.targetTime === null || (typeof task.targetTime === "number" && Number.isFinite(task.targetTime))) ||
    typeof task.collection !== "string" ||
    !(task.stage === null || typeof task.stage === "string") ||
    !Array.isArray(task.wallets) ||
    !task.wallets.every((wallet) => Number.isInteger(wallet) && wallet >= 0) ||
    !isObject(task.config) ||
    !isObject(task.txHashes) ||
    !isObject(task.walletOutcomes) ||
    typeof task.createdAt !== "number" ||
    typeof task.updatedAt !== "number"
  ) return false;

  for (const hashes of Object.values(task.txHashes)) {
    if (!Array.isArray(hashes) || !hashes.every((hash) => typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash))) {
      return false;
    }
  }
  for (const outcome of Object.values(task.walletOutcomes)) {
    if (outcome !== "PENDING" && outcome !== "COMPLETED" && outcome !== "FAILED") return false;
  }
  try {
    validateConfig(task.config as TaskConfig);
  } catch {
    return false;
  }
  return true;
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(data, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(tempPath, filePath);
    const dirHandle = await fs.open(directory, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class TaskManager {
  private store: TaskStore = emptyStore();
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly onError: (message: string, error: unknown) => void;

  constructor(options: TaskManagerOptions = {}) {
    this.filePath = path.resolve(options.filePath ?? process.env.INTERN_TASKS_FILE ?? ".intern-tasks.json");
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? ((message, error) => {
      process.stderr.write(`[task-manager] ${message}: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.tasks) ||
          !Array.isArray(parsed.watchlist) || !Array.isArray(parsed.executionHistory)) {
        throw new Error("Unsupported or invalid task store format.");
      }
      const tasks: Record<string, TaskState> = {};
      for (const [id, candidate] of Object.entries(parsed.tasks)) {
        if (!validateTask(candidate) || candidate.id !== id) {
          throw new Error(`Task store contains an invalid task record: ${id}.`);
        }
        tasks[id] = candidate;
      }
      this.store = {
        version: 1,
        tasks,
        watchlist: parsed.watchlist as WatchlistEntry[],
        executionHistory: parsed.executionHistory as TaskHistoryEntry[],
      };
    } catch (error) {
      const code = isObject(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT") {
        this.onError("Unable to load persistent tasks; refusing to overwrite the file", error);
        throw error;
      }
      this.store = emptyStore();
      await this.persist();
    }
    this.initialized = true;
  }

  async createTask(input: CreateTaskInput): Promise<TaskState> {
    this.assertReady();
    const config = { ...(input.config ?? {}) };
    validateConfig(config);
    const timestamp = this.now();
    const task: TaskState = {
      id: randomUUID(),
      type: input.type,
      status: input.status ?? "PENDING",
      targetTime: input.targetTime ?? null,
      collection: input.collection,
      stage: input.stage ?? null,
      wallets: [...new Set(input.wallets ?? [])].sort((a, b) => a - b),
      config,
      txHashes: {},
      walletOutcomes: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    for (const index of task.wallets) task.walletOutcomes[String(index)] = "PENDING";
    this.store.tasks[task.id] = task;
    this.addHistory(task, "CREATED", "Task persisted");
    await this.persist();
    return structuredClone(task);
  }

  async transition(
    id: string,
    status: TaskStatus,
    reason: string,
  ): Promise<TaskState> {
    this.assertReady();
    const task = this.requireTask(id);
    if (task.status === "COMPLETED" || task.status === "FAILED" || task.status === "CANCELLED") {
      if (task.status !== status) throw new Error(`Task ${id} is already terminal (${task.status}).`);
      return structuredClone(task);
    }
    task.status = status;
    task.updatedAt = this.now();
    this.addHistory(task, status, reason);
    await this.persist();
    return structuredClone(task);
  }

  async recordTxHashes(
    id: string,
    transactions: readonly { walletIndex: number; txHash: string; replacedTxHash?: string }[],
  ): Promise<TaskState> {
    this.assertReady();
    const task = this.requireTask(id);
    for (const transaction of transactions) {
      if (!task.wallets.includes(transaction.walletIndex)) {
        throw new Error(`Wallet W${transaction.walletIndex} does not belong to task ${id}.`);
      }
      if (!/^0x[0-9a-f]{64}$/i.test(transaction.txHash)) {
        throw new Error(`Invalid transaction hash for wallet W${transaction.walletIndex}.`);
      }
    }

    for (const transaction of transactions) {
      const key = String(transaction.walletIndex);
      const hashes = task.txHashes[key] ?? (task.txHashes[key] = []);
      if (!hashes.includes(transaction.txHash)) hashes.push(transaction.txHash);
      this.addHistory(
        task,
        transaction.replacedTxHash ? "TX_REPLACEMENT_INTENT" : "TX_BROADCAST_INTENT",
        transaction.replacedTxHash
          ? "Replacement hash persisted before broadcast"
          : "Locally-derived transaction hash persisted before broadcast",
        {
          walletIndex: transaction.walletIndex,
          txHash: transaction.txHash,
          ...(transaction.replacedTxHash ? { replacedTxHash: transaction.replacedTxHash } : {}),
        },
      );
    }
    task.updatedAt = this.now();
    await this.persist();
    return structuredClone(task);
  }

  async recordTxHash(
    id: string,
    walletIndex: number,
    txHash: string,
    replacedTxHash?: string,
  ): Promise<TaskState> {
    this.assertReady();
    if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error("Invalid transaction hash.");
    const task = this.requireTask(id);
    const key = String(walletIndex);
    if (!task.wallets.includes(walletIndex)) throw new Error(`Wallet W${walletIndex} does not belong to task ${id}.`);
    const hashes = task.txHashes[key] ?? (task.txHashes[key] = []);
    if (!hashes.includes(txHash)) hashes.push(txHash);
    task.updatedAt = this.now();
    this.addHistory(
      task,
      "TX_BROADCAST",
      replacedTxHash ? "Replacement transaction recorded" : "Transaction hash recorded",
      { walletIndex, txHash, ...(replacedTxHash ? { replacedTxHash } : {}) },
    );
    await this.persist();
    return structuredClone(task);
  }

  async recordWalletOutcome(
    id: string,
    walletIndex: number,
    outcome: Exclude<WalletExecutionStatus, "PENDING">,
    reason: string,
  ): Promise<TaskState> {
    this.assertReady();
    const task = this.requireTask(id);
    if (!task.wallets.includes(walletIndex)) throw new Error(`Wallet W${walletIndex} does not belong to task ${id}.`);
    task.walletOutcomes[String(walletIndex)] = outcome;
    task.updatedAt = this.now();
    this.addHistory(task, outcome, reason, { walletIndex });
    await this.persist();
    return structuredClone(task);
  }

  async addWatchlist(input: Omit<WatchlistEntry, "id" | "createdAt" | "enabled"> & { enabled?: boolean }): Promise<WatchlistEntry> {
    this.assertReady();
    validateConfig(input.config);
    const entry: WatchlistEntry = {
      ...input,
      id: randomUUID(),
      createdAt: this.now(),
      enabled: input.enabled ?? true,
      config: { ...input.config },
    };
    this.store.watchlist.push(entry);
    await this.persist();
    return structuredClone(entry);
  }

  async removeWatchlist(id: string): Promise<boolean> {
    this.assertReady();
    const previousLength = this.store.watchlist.length;
    this.store.watchlist = this.store.watchlist.filter((entry) => entry.id !== id);
    if (this.store.watchlist.length === previousLength) return false;
    await this.persist();
    return true;
  }

  getTask(id: string): TaskState | null {
    this.assertReady();
    const task = this.store.tasks[id];
    return task ? structuredClone(task) : null;
  }

  listTasks(statuses?: readonly TaskStatus[]): TaskState[] {
    this.assertReady();
    const all = Object.values(this.store.tasks);
    return structuredClone(statuses ? all.filter((task) => statuses.includes(task.status)) : all);
  }

  listWatchlist(enabledOnly = false): WatchlistEntry[] {
    this.assertReady();
    const entries = enabledOnly ? this.store.watchlist.filter((entry) => entry.enabled) : this.store.watchlist;
    return structuredClone(entries);
  }

  listExecutionHistory(limit = 100): TaskHistoryEntry[] {
    this.assertReady();
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    return structuredClone(this.store.executionHistory.slice(-safeLimit).reverse());
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error("TaskManager.init() must complete before use.");
  }

  private requireTask(id: string): TaskState {
    const task = this.store.tasks[id];
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  private addHistory(
    task: TaskState,
    action: string,
    reason: string,
    extra: Pick<TaskHistoryEntry, "walletIndex" | "txHash" | "replacedTxHash"> = {},
  ): void {
    this.store.executionHistory.push({
      id: randomUUID(),
      taskId: task.id,
      at: this.now(),
      action,
      status: task.status,
      reason,
      ...extra,
    });
    if (this.store.executionHistory.length > MAX_HISTORY) {
      this.store.executionHistory.splice(0, this.store.executionHistory.length - MAX_HISTORY);
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.store, null, 2) + "\n";
    const write = this.writeQueue.catch(() => undefined).then(async () => {
      try {
        await atomicWrite(this.filePath, snapshot);
      } catch (error) {
        this.onError("Failed to persist task state", error);
        throw error;
      }
    });
    this.writeQueue = write;
    return write;
  }
}
