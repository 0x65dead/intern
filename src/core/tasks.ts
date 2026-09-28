/** Concurrent single-process task scheduler.
 *
 * The bot is intentionally single-user/self-hosted. This scheduler exists to
 * allow multiple independent mint jobs at once without allowing two jobs to
 * allocate the same wallet/chain nonce concurrently.
 */
export type TaskStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export interface TaskRecord {
  id: string;
  target: string;
  chain: string;
  walletIndexes: number[];
  status: TaskStatus;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  error?: string;
}

interface QueuedTask {
  record: TaskRecord;
  run: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  resolve: () => void;
}

export class TaskScheduler {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly walletLocks = new Map<string, string>();
  private readonly queue: QueuedTask[] = [];
  private readonly active = new Map<string, QueuedTask>();
  private sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  submit(opts: {
    target: string;
    chain: string;
    walletIndexes: number[];
    run: (signal: AbortSignal) => Promise<void>;
  }): { id: string; promise: Promise<void>; controller: AbortController } {
    const id = `T${++this.sequence}`;
    const controller = new AbortController();
    const record: TaskRecord = {
      id,
      target: opts.target,
      chain: opts.chain,
      walletIndexes: [...new Set(opts.walletIndexes)].sort((a, b) => a - b),
      status: "queued",
      createdAtMs: this.now(),
    };
    this.tasks.set(id, record);

    let resolveDone!: () => void;
    const promise = new Promise<void>((resolve) => (resolveDone = resolve));
    this.queue.push({ record, run: opts.run, controller, resolve: resolveDone });
    this.pump();
    return { id, promise, controller };
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || ["success", "failed", "cancelled"].includes(task.status)) return false;
    const queued = this.queue.find((entry) => entry.record.id === id);
    if (queued && task.status === "queued") {
      queued.controller.abort();
      task.status = "cancelled";
      task.finishedAtMs = this.now();
      this.removeQueued(id);
      queued.resolve();
      return true;
    }
    // A running task is allowed to unwind its engine/reporting path.
    const running = this.active.get(id);
    if (running) {
      running.controller.abort();
      return true;
    }
    return false;
  }

  cancelAll(): number {
    let count = 0;
    for (const task of this.listActive()) if (this.cancel(task.id)) count++;
    return count;
  }

  get(id: string): TaskRecord | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task, walletIndexes: [...task.walletIndexes] } : undefined;
  }

  listActive(): TaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => task.status === "queued" || task.status === "running")
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((task) => ({ ...task, walletIndexes: [...task.walletIndexes] }));
  }

  listAll(): TaskRecord[] {
    return [...this.tasks.values()]
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((task) => ({ ...task, walletIndexes: [...task.walletIndexes] }));
  }

  private removeQueued(id: string): void {
    const index = this.queue.findIndex((entry) => entry.record.id === id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private canStart(record: TaskRecord): boolean {
    // Nonce safety is wallet-scoped. Different wallets can execute simultaneously.
    return record.walletIndexes.every((index) => !this.walletLocks.has(String(index)));
  }

  private lock(record: TaskRecord): void {
    for (const index of record.walletIndexes) this.walletLocks.set(String(index), record.id);
  }

  private unlock(record: TaskRecord): void {
    for (const index of record.walletIndexes) {
      if (this.walletLocks.get(String(index)) === record.id) this.walletLocks.delete(String(index));
    }
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      if (!entry || entry.record.status !== "queued" || !this.canStart(entry.record)) continue;
      this.queue.splice(i, 1);
      i--;
      this.start(entry);
    }
  }

  private start(entry: QueuedTask): void {
    const record = entry.record;
    this.lock(record);
    this.active.set(record.id, entry);
    record.status = "running";
    record.startedAtMs = this.now();
    void entry.run(entry.controller.signal)
      .then(() => {
        if (record.status === "running") record.status = "success";
      })
      .catch((err: unknown) => {
        if (record.status === "running") {
          record.status = entry.controller.signal.aborted ? "cancelled" : "failed";
          record.error = err instanceof Error ? err.message : String(err);
        }
      })
      .finally(() => {
        record.finishedAtMs = this.now();
        this.unlock(record);
        this.active.delete(record.id);
        entry.resolve();
        this.pump();
      });
  }
}
