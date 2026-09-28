/** Concurrent single-process task scheduler.
 *
 * The bot is intentionally single-user/self-hosted. This scheduler exists to
 * allow multiple independent mint jobs at once without allowing two jobs to
 * allocate the same wallet/chain nonce concurrently.
 */
export type TaskStatus =
  // Submitted, holding no wallet lock yet.
  | "CREATED"
  // The working phases, in the order a mint passes through them.
  | "DISCOVERING"
  | "ELIGIBILITY_CHECK"
  | "ELIGIBLE"
  | "WAITING_FOR_STAGE"
  | "ARMED"
  | "BUILDING_TX"
  | "SIMULATING"
  | "SIGNING"
  | "BROADCASTING"
  | "CONFIRMING"
  // Terminal.
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  // Operator-held, and only before a wallet lock is taken. See `pause`.
  | "PAUSED";

/**
 * The working phases in order, which is what makes a *backwards* move detectable.
 *
 * Order matters for exactly one safety property. Once a transaction has been
 * broadcast, the task must never return to a phase that would build or sign
 * another one: a re-signed mint is a second transaction competing with the first
 * for the same nonce, and the operator pays for whichever lands. Reporting
 * progress is otherwise free-form — a poll loop legitimately moves
 * WAITING_FOR_STAGE → ARMED → WAITING_FOR_STAGE — so the rule is not "forward
 * only", it is "nothing before BROADCASTING, once BROADCASTING has happened".
 */
const PHASE_ORDER: readonly TaskStatus[] = [
  "DISCOVERING",
  "ELIGIBILITY_CHECK",
  "ELIGIBLE",
  "WAITING_FOR_STAGE",
  "ARMED",
  "BUILDING_TX",
  "SIMULATING",
  "SIGNING",
  "BROADCASTING",
  "CONFIRMING",
];

const TERMINAL: readonly TaskStatus[] = ["SUCCESS", "FAILED", "CANCELLED"];

/** Has this task stopped for good? Terminal statuses are never left. */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

/** The first phase at which a transaction may exist on the network. */
const BROADCAST_INDEX = PHASE_ORDER.indexOf("BROADCASTING");

/** A phase a running task may report. Terminal states are the scheduler's to set. */
export type TaskPhase = (typeof PHASE_ORDER)[number];

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
  /**
   * Set the first time the task reports BROADCASTING, and never cleared.
   *
   * This is the record that a transaction may exist on the network. It outlives
   * the phase it came from, because by CONFIRMING the status no longer says that
   * signing already happened — and that is the fact a retry must not ignore.
   */
  broadcastAtMs?: number;
  /** Phase reports refused as unsafe, for the diagnostics panel. */
  refusedPhases?: TaskPhase[];
}

interface QueuedTask {
  record: TaskRecord;
  run: (signal: AbortSignal, phase: (next: TaskPhase) => boolean) => Promise<void>;
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
    /**
     * The work. `phase` reports progress and returns false when the report was
     * refused as unsafe, which a caller may check but need not: a refused report
     * changes the record, never the mint.
     */
    run: (signal: AbortSignal, phase: (next: TaskPhase) => boolean) => Promise<void>;
  }): { id: string; promise: Promise<void>; controller: AbortController } {
    const id = `T${++this.sequence}`;
    const controller = new AbortController();
    const record: TaskRecord = {
      id,
      target: opts.target,
      chain: opts.chain,
      walletIndexes: [...new Set(opts.walletIndexes)].sort((a, b) => a - b),
      status: "CREATED",
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
    if (!task || isTerminal(task.status)) return false;
    const queued = this.queue.find((entry) => entry.record.id === id);
    // PAUSED as well as CREATED: a held task is still sitting in the queue, and
    // refusing to cancel it would leave the operator no way to be rid of it
    // short of resuming the thing they paused.
    if (queued && (task.status === "CREATED" || task.status === "PAUSED")) {
      queued.controller.abort();
      task.status = "CANCELLED";
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
    return task ? this.copy(task) : undefined;
  }

  listActive(): TaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => !isTerminal(task.status))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((task) => this.copy(task));
  }

  listAll(): TaskRecord[] {
    return [...this.tasks.values()]
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((task) => this.copy(task));
  }

  /** Callers must not be able to reach in and mutate a record's arrays. */
  private copy(task: TaskRecord): TaskRecord {
    return {
      ...task,
      walletIndexes: [...task.walletIndexes],
      ...(task.refusedPhases ? { refusedPhases: [...task.refusedPhases] } : {}),
    };
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
      if (!entry || entry.record.status !== "CREATED" || !this.canStart(entry.record)) continue;
      this.queue.splice(i, 1);
      i--;
      this.start(entry);
    }
  }

  /**
   * Record a phase a running task reports, unless doing so would be unsafe.
   *
   * The one refusal is a move back before BROADCASTING after a broadcast has
   * happened. It is refused rather than obeyed because every consumer of this
   * record — the retry logic, the operator reading a status, a recovery pass
   * after a restart — would otherwise be told that nothing has been sent yet,
   * and the correct response to "nothing sent yet" is to build and sign, which
   * is precisely the double-spend this guards.
   */
  private advance(record: TaskRecord, next: TaskPhase): boolean {
    if (isTerminal(record.status)) return false;
    if (record.broadcastAtMs !== undefined && PHASE_ORDER.indexOf(next) < BROADCAST_INDEX) {
      (record.refusedPhases ??= []).push(next);
      return false;
    }
    record.status = next;
    if (next === "BROADCASTING" && record.broadcastAtMs === undefined) {
      record.broadcastAtMs = this.now();
    }
    return true;
  }

  /**
   * Hold a task that has not started yet.
   *
   * Only CREATED can be paused, and that is a real limitation stated rather than
   * papered over. A started task holds a wallet lock and may have a transaction
   * in flight; there is no mechanism that stops it mid-mint and nothing would be
   * gained by labelling it "PAUSED" while it carried on broadcasting. Cancel is
   * the operation that stops running work, and it is honest about being one-way.
   */
  pause(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "CREATED") return false;
    task.status = "PAUSED";
    return true;
  }

  /** Return a held task to the queue. It competes for wallet locks as before. */
  resume(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "PAUSED") return false;
    task.status = "CREATED";
    this.pump();
    return true;
  }

  private start(entry: QueuedTask): void {
    const record = entry.record;
    this.lock(record);
    this.active.set(record.id, entry);
    record.status = "DISCOVERING";
    record.startedAtMs = this.now();
    void entry.run(entry.controller.signal, (next) => this.advance(record, next))
      .then(() => {
        if (!isTerminal(record.status)) record.status = "SUCCESS";
      })
      .catch((err: unknown) => {
        if (!isTerminal(record.status)) {
          record.status = entry.controller.signal.aborted ? "CANCELLED" : "FAILED";
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
