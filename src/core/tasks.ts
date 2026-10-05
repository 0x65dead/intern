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

/**
 * The task phase an engine event implies, or null when it implies no change.
 *
 * Lives here, beside `PHASE_ORDER`, because the mapping and the ordering rule have
 * to agree: report BROADCASTING late and the guard against re-signing after a
 * broadcast never arms, report it early and a legitimate pre-broadcast step looks
 * like a regression and is refused.
 *
 * `fired` is the honest broadcast point. The engine emits it immediately after the
 * bytes are handed to the endpoints, so it is the first instant at which a
 * transaction may exist on the network — which is exactly the fact
 * `broadcastAtMs` records. `signed` deliberately does not map to BROADCASTING: a
 * signed transaction that was never dispatched can be rebuilt safely, and treating
 * it as sent would refuse a retry that is legitimate.
 *
 * Events that report an outcome rather than a step — a receipt, a rejection, a
 * warning — return null: the scheduler decides terminal statuses, and a task whose
 * broadcast was rejected everywhere has still broadcast.
 */
export function phaseForEvent(event: { type: string; name?: string }): TaskPhase | null {
  switch (event.type) {
    case "phase":
      switch (event.name) {
        case "prepare":
          return "BUILDING_TX";
        case "simulate":
          return "SIMULATING";
        case "sign":
          return "SIGNING";
        case "wait":
          return "WAITING_FOR_STAGE";
        case "receipts":
          return "CONFIRMING";
        default:
          // An engine phase this mapping has not been taught. Reporting nothing is
          // right: inventing a phase for it could move the record backwards past a
          // broadcast, and the scheduler would then refuse the next real report.
          return null;
      }
    case "balances":
      return "ELIGIBILITY_CHECK";
    case "countdown":
      return "WAITING_FOR_STAGE";
    case "fired":
      return "BROADCASTING";
    case "receipt":
    case "receiptTimeout":
      return "CONFIRMING";
    default:
      return null;
  }
}

const TERMINAL: readonly TaskStatus[] = ["SUCCESS", "FAILED", "CANCELLED"];

/** Has this task stopped for good? Terminal statuses are never left. */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

/** The first phase at which a transaction may exist on the network. */
const BROADCAST_INDEX = PHASE_ORDER.indexOf("BROADCASTING");

/** A phase a running task may report. Terminal states are the scheduler's to set. */
export type TaskPhase = (typeof PHASE_ORDER)[number];

/**
 * What a running task is handed. An object rather than positional arguments so
 * that adding to it later is not a breaking change at every call site.
 */
export interface TaskContext {
  /**
   * The task's own id.
   *
   * Passed in because the body cannot otherwise learn it: the id is minted by
   * `submit`, and `submit` has not returned by the time the body first runs. The
   * id is what every log line, record lookup and panel row is keyed by, so a
   * body without it can report progress but cannot say whose progress it is.
   */
  id: string;
  /** Aborted when the operator cancels. The body is expected to check it. */
  signal: AbortSignal;
  /**
   * Report progress. Returns false when the report was refused as unsafe, which
   * a caller may check but need not: a refused report changes the record, never
   * the mint.
   */
  phase: (next: TaskPhase) => boolean;
}

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
  run: (ctx: TaskContext) => Promise<void>;
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
    /** The work. See `TaskContext` for what it is handed. */
    run: (ctx: TaskContext) => Promise<void>;
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

  /**
   * Which of these wallets are already committed, and to which task.
   *
   * For callers that must refuse rather than wait. `submit` queues a task whose
   * wallets are busy, which is right for a work queue and wrong for a mint: a
   * drop that has to wait for an unrelated run to finish is usually a drop that
   * is over by the time it does, and firing it late and unattended at a price
   * nobody re-confirmed is worse than not firing it. So a caller that cannot
   * sensibly queue asks this first and declines, and the queue stays available
   * for callers that can.
   *
   * Only wallets actually locked are returned, so an empty array means every
   * wallet asked about is free. Read-only: asking takes nothing.
   */
  walletHolders(walletIndexes: readonly number[]): { walletIndex: number; taskId: string }[] {
    const held: { walletIndex: number; taskId: string }[] = [];
    for (const index of walletIndexes) {
      const taskId = this.walletLocks.get(String(index));
      if (taskId !== undefined) held.push({ walletIndex: index, taskId });
    }
    return held;
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

  /**
   * Take the wallet locks and hand the task to its body.
   *
   * The locks, the status and the start timestamp are all taken synchronously,
   * because those are what make "one wallet, one mint at a time" true: a second
   * `submit` for the same wallet must see the lock before it can be told it may
   * start. The *body* is deliberately not synchronous. It is queued on a
   * microtask so that `submit` has returned first, which buys two things the
   * caller cannot arrange for itself:
   *
   *   - the body can be written against the handle `submit` returns, rather
   *     than racing its own initialisation (a body that touched `t.id` while
   *     `const t = scheduler.submit(...)` was still evaluating got a
   *     ReferenceError, which is how this was found);
   *   - anything the caller registers against that handle — the message id a
   *     progress panel edits, say — exists before the first phase is reported,
   *     instead of arriving one tick too late.
   *
   * A microtask costs nothing next to a network round trip, and nothing about
   * the mint is slower for it: the lock, which is the part that must not slip,
   * was already taken above.
   */
  private start(entry: QueuedTask): void {
    const record = entry.record;
    this.lock(record);
    this.active.set(record.id, entry);
    record.status = "DISCOVERING";
    record.startedAtMs = this.now();
    const body = async (): Promise<void> => {
      // Cancelled in the gap between taking the lock and getting the microtask.
      // Starting anyway would mint something the operator has already called
      // off, so the body is never entered at all.
      if (entry.controller.signal.aborted) {
        record.status = "CANCELLED";
        return;
      }
      await entry.run({
        id: record.id,
        signal: entry.controller.signal,
        phase: (next) => this.advance(record, next),
      });
    };
    void Promise.resolve()
      .then(body)
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
