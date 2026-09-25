// Crash safety: knowing what was already sent.
//
// An unattended daemon that restarts mid-mint has one question to answer, and
// getting it wrong is expensive in both directions. Re-firing a wallet that
// already broadcast risks a second transaction at the same nonce — which, if it
// differs by a single byte from the first, is a replacement bid the operator
// never asked for. Refusing to re-fire a wallet that never broadcast loses the
// mint for no reason.
//
// The answer is to record intent *before* the broadcast, not after. Then the
// three states after a crash are distinguishable:
//
//   no record       → nothing was sent. Safe to fire.
//   hash, no result → we were mid-broadcast. The transaction may or may not be
//                     on the network; check it, do not rebuild it.
//   hash + result   → done. Nothing further to do.
//
// The middle case is the one that only exists because the write comes first. If
// the record were written after a successful broadcast, a crash in between would
// be indistinguishable from "never sent" — and the daemon would build a fresh
// transaction at a nonce that already had one in flight.
//
// Nothing in this file may contain key material. It is written to disk, it is
// read back by a process the operator did not start by hand, and it is the kind
// of file that ends up in a support paste. A test asserts the serialised form
// against a run carrying a real key.

import fs from "fs";
import os from "os";
import path from "path";

import { markPublicHash } from "./wallets";

export const STATE_VERSION = 1;

export interface WalletRecord {
  index: number;
  address: string;
  nonce: number;
  /**
   * The locally-derived hash, written *before* the broadcast leaves.
   *
   * It is derivable from the signed transaction without a round trip, which is
   * what makes recording-before-sending affordable on the hot path.
   */
  txHash?: string;
  outcome?: "accepted" | "rejected";
  error?: string;
}

export interface RunState {
  version: number;
  runId: string;
  /** Collection slug or address — for the operator, not used in any decision. */
  target: string;
  chainId: number;
  startedAtMs: number;
  status: "arming" | "firing" | "done" | "aborted";
  dryRun: boolean;
  wallets: WalletRecord[];
}

export function newRunState(opts: {
  runId: string;
  target: string;
  chainId: number;
  startedAtMs: number;
  dryRun?: boolean;
  wallets: { index: number; address: string; nonce: number }[];
}): RunState {
  return {
    version: STATE_VERSION,
    runId: opts.runId,
    target: opts.target,
    chainId: opts.chainId,
    startedAtMs: opts.startedAtMs,
    status: "arming",
    dryRun: opts.dryRun ?? false,
    wallets: opts.wallets.map((w) => ({
      index: w.index,
      address: w.address,
      nonce: w.nonce,
    })),
  };
}

export type ResumeAction =
  | { kind: "skip"; reason: string }
  | { kind: "verify"; txHash: string; reason: string }
  | { kind: "fire"; reason: string };

/**
 * What to do about one wallet after a restart.
 *
 * `verify` never rebuilds. Rebroadcasting the *identical* signed transaction is
 * harmless — same hash, same nonce, and every node dedupes it — but building a
 * new one is not, because a different signature at the same nonce competes with
 * the first. Since a restarted process no longer holds the original signed bytes,
 * the only safe move is to look the hash up rather than to sign again.
 */
export function resumeAction(record: WalletRecord): ResumeAction {
  if (record.outcome === "accepted") {
    return {
      kind: "skip",
      reason: `Wallet ${record.index} already broadcast ${record.txHash ?? "a transaction"}.`,
    };
  }
  if (record.outcome === "rejected") {
    return {
      kind: "skip",
      reason:
        `Wallet ${record.index}'s transaction was rejected before the crash ` +
        `(${record.error ?? "no reason recorded"}). Not retried automatically — ` +
        `a rejection that repeats costs gas each time.`,
    };
  }
  if (record.txHash) {
    return {
      kind: "verify",
      txHash: record.txHash,
      reason:
        `Wallet ${record.index} was mid-broadcast at ${record.txHash}. Checking the ` +
        `chain rather than signing again: a second signature at nonce ${record.nonce} ` +
        `would compete with the first.`,
    };
  }
  return { kind: "fire", reason: `Wallet ${record.index} had not broadcast. Safe to fire.` };
}

export interface RecoveryReport {
  /** Whether the operator has to do anything. False means "safe to discard". */
  needsAttention: boolean;
  /** Transaction hashes whose fate is unknown and must be looked up. */
  verify: string[];
  /** Operator-facing lines. Plain text — the caller escapes for its medium. */
  lines: string[];
}

/**
 * What a journal left behind by a previous process means, in words.
 *
 * Deliberately reports rather than acts. A restarted process has none of the
 * original signed bytes and no idea how much time has passed, so it cannot
 * safely resume a broadcast — but it is holding the only record that the
 * broadcast ever happened, and losing that quietly is how an operator ends up
 * re-minting a wallet that already succeeded. So the journal's whole remaining
 * job is to put those hashes in front of a human.
 *
 * `needsAttention` is false only when nothing reached the network, which is the
 * common case: the process died while arming, hours before T-0.
 */
export function recoveryReport(state: RunState): RecoveryReport {
  const verify: string[] = [];
  const detail: string[] = [];

  for (const record of state.wallets) {
    const action = resumeAction(record);
    if (action.kind === "fire") continue;
    if (action.kind === "verify") verify.push(action.txHash);
    detail.push(`  · ${action.reason}`);
  }

  if (detail.length === 0) {
    return {
      needsAttention: false,
      verify: [],
      lines: [
        `A previous run (${state.runId}) on ${state.target} ended without broadcasting anything.`,
        "Nothing to reconcile. The journal has been discarded.",
      ],
    };
  }

  const lines = [
    `A previous run left unfinished business: ${state.runId} on ${state.target} (chain ${state.chainId}).`,
    `It was ${state.status} when the process stopped.`,
    "",
    ...detail,
    "",
  ];

  if (verify.length > 0) {
    lines.push(
      verify.length === 1
        ? "Check that hash on the explorer before minting this collection again."
        : `Check those ${verify.length} hashes on the explorer before minting this collection again.`,
      "intern will not resign them: it no longer holds the original signed bytes, and a",
      "fresh signature at the same nonce would compete with a transaction that may",
      "already be confirmed.",
    );
  } else {
    lines.push("No transaction is unaccounted for — every wallet above has a known outcome.");
  }

  return { needsAttention: true, verify, lines };
}

/** True when nothing in this run has reached the network yet. */
export function isUntouched(state: RunState): boolean {
  return state.wallets.every((w) => !w.txHash && !w.outcome);
}

export function recordIntent(state: RunState, index: number, txHash: string): RunState {
  return {
    ...state,
    status: "firing",
    wallets: state.wallets.map((w) => (w.index === index ? { ...w, txHash } : w)),
  };
}

export function recordOutcome(
  state: RunState,
  index: number,
  outcome: "accepted" | "rejected",
  error?: string,
): RunState {
  return {
    ...state,
    wallets: state.wallets.map((w) =>
      w.index === index ? { ...w, outcome, ...(error ? { error } : {}) } : w,
    ),
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function defaultStatePath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, ".intern-run.json");
}

/**
 * Write atomically: a full file into a sibling temp, then rename over.
 *
 * rename(2) is atomic within a filesystem, so a crash during the write leaves
 * either the old state or the new one, never a half-written JSON document that
 * the next start cannot parse — which would strand exactly the information the
 * file exists to preserve.
 */
export function writeState(state: RunState, file: string = defaultStatePath()): void {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.intern-run.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Read a previous run, or null.
 *
 * Every failure returns null rather than throwing. A corrupt or foreign state
 * file must not stop the daemon from starting — but see `isUntouched`: a null
 * here means "no usable record", which callers treat as "do not assume nothing
 * was sent" only when a file existed and failed to parse.
 */
export function readState(file: string = defaultStatePath()): RunState | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const state = parsed as Partial<RunState>;
    if (state.version !== STATE_VERSION) return null;
    if (!Array.isArray(state.wallets) || typeof state.runId !== "string") return null;
    // A resumed run reports hashes it broadcast before the crash, and those came
    // off disk rather than out of `prepare`, so nothing has vouched for them yet.
    // `markPublicHash` refuses any value registered as a secret, so a tampered
    // journal cannot use this path to unmask a key.
    for (const wallet of state.wallets) {
      if (wallet.txHash) markPublicHash(wallet.txHash);
    }
    return state as RunState;
  } catch {
    return null;
  }
}

export function clearState(file: string = defaultStatePath()): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a state file we cannot delete is not a reason to fail a run */
  }
}

/** A run id that sorts by time and is unique per process. */
export function newRunId(nowMs: number): string {
  return `${nowMs.toString(36)}-${os.hostname().slice(0, 8)}-${process.pid}`;
}
