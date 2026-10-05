// The mint engine: everything between "we know the target" and "we have receipts".
//
// The ordering here is the whole point of the tool, so it is worth stating
// plainly. Work is either *preparation* (can happen before the stage opens) or
// *dispatch* (must happen at T-0). Anything that can be moved from the second
// category into the first, is.
//
//   Preparation, in parallel where independent:
//     · warm every socket (TLS handshake ≈ 100-300ms, paid once, in advance)
//     · read the drop, fees, nonces, balances
//     · simulate the mint with eth_call so a revert is discovered now, not at T-0
//     · sign every wallet's transaction and serialize the JSON-RPC body
//     · measure the local clock's error against the chain
//
//   Dispatch, at T-0:
//     · write already-built bytes to already-open sockets
//
// That leaves the firing path with no signing, no encoding, no API call and no
// JSON serialization — which is why it is measured in microseconds while the
// preparation phase takes seconds.
//
// The engine emits structured events rather than printing, so the CLI and the
// Telegram bot render the same run without either owning the logic.

import { JsonRpcProvider, Wallet } from "ethers";
import { ChainProfile } from "./chains";
import { FailureCode } from "./failures";
import { CorrectedClock, ClockSync, syncClock, driftGuard } from "./clock";
import {
  BlastOutcome,
  Endpoint,
  PreparedTx,
  blast,
  classifyRejection,
  prepare,
  waitForReceipt,
  wasAccepted,
  warmConnections,
} from "./blast";
import { MintPlan, fetchMintStats, planWarnings } from "./seadrop";
import { labelFor } from "./rpc";
import { DryRunReport, DryRunWallet, SimVerdict } from "./dryrun";
import {
  RunState,
  clearState,
  defaultStatePath,
  newRunId,
  newRunState,
  recordIntent,
  recordOutcome,
  writeState,
} from "./runstate";
import { FirePlan, formatRemaining, planFire, waitUntil } from "./timing";
import {
  BalanceReport,
  GasSettings,
  LoadedWallet,
  checkBalances,
  fetchNonces,
  pairByAddress,
  splitByFunding,
  formatEth,
  priceCeilingRefusal,
  requiredBalance,
} from "./wallets";

export type EngineEvent =
  | { type: "phase"; name: string; detail?: string }
  | { type: "clock"; sync: ClockSync }
  | { type: "balances"; reports: BalanceReport[]; required: bigint; symbol: string }
  | {
      type: "simulation";
      ok: boolean;
      index: number;
      address: string;
      error?: string;
      /**
       * The structured cause, when one was determined.
       *
       * Carried alongside the prose rather than instead of it: the sentence is
       * what an operator reads, the code is what a retry policy and a task state
       * machine can act on without parsing English.
       */
      code?: FailureCode;
    }
  | { type: "signed"; count: number; elapsedMs: number }
  | { type: "countdown"; remainingMs: number; text: string }
  | { type: "fired"; count: number; dispatchMs: number; timingErrorMs: number }
  | { type: "tx"; index: number; address: string; txHash: string }
  | { type: "accepted"; index: number; label: string; elapsedMs: number }
  | { type: "rejected"; index: number; reasons: string[]; hint?: string }
  | {
      type: "receipt";
      index: number;
      txHash: string;
      block: number;
      position: number;
      success: boolean;
      gasUsed: bigint;
      /** Why it reverted, when the node would say. Absent on success. */
      reason?: string;
    }
  // `cancelled` distinguishes "we stopped looking" from "it did not land in
  // time". Both leave the operator with a hash to check, which is why this is one
  // event and not two — but only one of them means the run was still healthy.
  | { type: "receiptTimeout"; index: number; txHash: string; cancelled?: boolean }
  | { type: "warning"; message: string }
  /** A dry run finished. No transaction was broadcast; the report says what would have been. */
  | { type: "dryRun"; report: DryRunReport }
  | { type: "done"; minted: number; failed: number };

export interface EngineOptions {
  chain: ChainProfile;
  plan: MintPlan;
  wallets: LoadedWallet[];
  /** Read-capable endpoints, fastest first. */
  readUrls: string[];
  /** Broadcast targets — may include send-only sequencers. */
  blastUrls: string[];
  gas: GasSettings;
  /** Corrected-time epoch ms to dispatch. null fires as soon as prepared. */
  fireAtMs: number | null;
  /** Fire this many ms before the stage opens. */
  leadMs?: number;
  /** Skip the eth_call dry run. Faster setup, no revert protection. */
  skipSimulation?: boolean;
  /** Abort before dispatch when any wallet's simulation reverts. */
  requireSimulation?: boolean;
  clockRounds?: number;
  receiptTimeoutMs?: number;
  signal?: AbortSignal;
  /** Do every check and sign every transaction, then stop without broadcasting. */
  dryRun?: boolean;
  /**
   * The most one NFT may cost, in wei. null or absent means no ceiling.
   *
   * See `priceCeilingRefusal`: this is the only bound on what a mint may spend
   * that does not come from the wallet's own balance.
   */
  maxPricePerNftWei?: bigint | null;
  /**
   * Refuse to fire when the clock offset could not be measured to within this.
   *
   * Undefined means no guard, which is the right default for an operator at a
   * terminal who can see the measured offset and decide. A daemon passes a real
   * value, because nobody is there to make that call.
   */
  driftLimitMs?: number;
  /** Crash-safety journal path. null disables the journal entirely. */
  statePath?: string | null;
  runId?: string;
  /** What the operator called this drop, for the journal. */
  target?: string;
}

export interface EngineResult {
  minted: number;
  failed: number;
  timingErrorMs: number;
  dispatchMs: number;
  clock: ClockSync;
  txHashes: string[];
}

interface SignedBundle {
  wallet: LoadedWallet;
  prepared: PreparedTx;
  nonce: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Cancelled before dispatch — nothing was sent.");
}

/**
 * Dry-run the mint with eth_call from each wallet's address.
 *
 * This is the single highest-value check in the tool. A mint that will revert —
 * wrong fee recipient, per-wallet cap exceeded, stage not open, sold out — reverts
 * identically in eth_call, at no cost, before any gas is spent. Skipping it means
 * discovering the problem by paying for a failed transaction.
 *
 * Note the deliberate asymmetry: a *successful* simulation is strong evidence,
 * but a *failed* one before the stage opens is expected (NotActive) and must not
 * be treated as a reason to abort. That is why `requireSimulation` is opt-in and
 * why the stage-open state is checked alongside.
 */
interface SimResult {
  verdict: SimVerdict;
  error?: string;
}

async function simulate(
  provider: JsonRpcProvider,
  plan: MintPlan,
  wallets: LoadedWallet[],
  emit: (event: EngineEvent) => void,
): Promise<{ ok: boolean; failures: number; verdicts: Map<number, SimResult> }> {
  let failures = 0;
  const verdicts = new Map<number, SimResult>();
  await Promise.all(
    wallets.map(async (wallet) => {
      try {
        await provider.call({
          from: wallet.address,
          to: plan.to,
          data: plan.data,
          value: plan.value,
        });
        verdicts.set(wallet.index, { verdict: "passed" });
        emit({ type: "simulation", ok: true, index: wallet.index, address: wallet.address });
      } catch (err: unknown) {
        failures++;
        const raw = err instanceof Error ? err.message : String(err);
        verdicts.set(wallet.index, { verdict: "reverted", error: describeRevert(raw) });
        emit({
          type: "simulation",
          ok: false,
          index: wallet.index,
          address: wallet.address,
          error: describeRevert(raw),
        });
      }
    }),
  );
  return { ok: failures === 0, failures, verdicts };
}

/**
 * Remove wallets that have already exhausted the SeaDrop per-wallet cap.
 *
 * getMintStats() is optional across NFT contracts. A failed read therefore
 * does not make the wallet ineligible; simulation remains the authoritative
 * fallback for contracts that do not expose this interface.
 */
async function filterMintCapWallets(
  provider: JsonRpcProvider,
  plan: MintPlan,
  wallets: LoadedWallet[],
  emit: (event: EngineEvent) => void,
): Promise<LoadedWallet[]> {
  const cap = plan.drop.maxTotalMintableByWallet;
  if (cap <= 0) return wallets;

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const stats = await fetchMintStats(provider, plan.nftContract, wallet.address);
        const totalAfterMint = stats.minterNumMinted + BigInt(plan.quantity);

        if (totalAfterMint > BigInt(cap)) {
          emit({
            type: "warning",
            message: `W${wallet.index} ${wallet.address} skipped — wallet has already minted ${stats.minterNumMinted}; requested ${plan.quantity} would exceed the per-wallet cap of ${cap}.`,
          });
          return null;
        }

        return wallet;
      } catch {
        // Not every NFT contract exposes getMintStats(). Keep the wallet and
        // let eth_call simulation remain the fallback safety check.
        return wallet;
      }
    }),
  );

  return results.filter((wallet): wallet is LoadedWallet => wallet !== null);
}

/** Turn an ethers/RPC revert blob into something a human can act on. */
export function describeRevert(raw: string): string {
  const text = String(raw ?? "").trim();

  // Ethers/RPC providers often wrap custom-error data inside the message.
  // Keep the original text available, but extract useful standard reasons first.
  const standard = [
    // The optional opening quote matters: ethers reports `reason="Stage not
    // active"`, and a class excluding `"` cannot begin on one. Without it the
    // single most common shape fell straight through to "no reason given".
    /execution reverted:?\s*"?([^"\n]{3,200})/i,
    /reverted:?\s*"?([^"\n]{3,200})/i,
    /reason[:=]\s*"?([^"\n]{3,200})/i,
  ];

  for (const pattern of standard) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      return `Reverted: ${match[1].trim()}`;
    }
  }

  // Decode common Solidity Error(string) revert payload:
  // 0x08c379a0 + ABI encoded string.
  const hex = /0x08c379a0[0-9a-fA-F]+/.exec(text)?.[0];
  if (hex) {
    try {
      const data = hex.slice(10);
      if (data.length >= 128) {
        const offset = Number.parseInt(data.slice(0, 64), 16);
        const lengthPos = offset * 2;
        const length = Number.parseInt(data.slice(lengthPos, lengthPos + 64), 16);
        const reasonHex = data.slice(lengthPos + 64, lengthPos + 64 + length * 2);
        const reason = Buffer.from(reasonHex, "hex").toString("utf8").replace(/\0+$/g, "").trim();
        if (reason) return `Reverted: ${reason}`;
      }
    } catch {
      // Fall through to the generic message below.
    }
  }

  // Decode Solidity Panic(uint256):
  // 0x4e487b71 + uint256 panic code.
  const panic = /0x4e487b71([0-9a-fA-F]{64})/.exec(text);
  if (panic) {
    const code = Number.parseInt(panic[1] ?? "", 16);
    const reasons: Record<number, string> = {
      0x01: "assertion failed",
      0x11: "arithmetic overflow/underflow",
      0x12: "division or modulo by zero",
      0x21: "invalid enum conversion",
      0x22: "incorrectly encoded storage byte array",
      0x31: "pop on empty array",
      0x32: "array index out of bounds",
      0x41: "memory allocation overflow",
      0x51: "call to uninitialized function",
    };
    return `Reverted: Solidity panic 0x${code.toString(16)}${reasons[code] ? ` — ${reasons[code]}` : ""}`;
  }

    // Decode SeaDrop: MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed)
    const capError = /0xedc01273([0-9a-fA-F]{64})([0-9a-fA-F]{64})/i.exec(text);
    if (capError) {
      const total = BigInt(`0x${capError[1] ?? "0"}`);
      const allowed = BigInt(`0x${capError[2] ?? "0"}`);
      return `Reverted: wallet mint cap exceeded — total would be ${total}, allowed ${allowed}`;
    }

  // Other custom errors do not carry a human-readable string unless we know their
  // ABI. Only a plausible revert payload may be reported as one: ABI-encoded revert
  // data is a 4-byte selector followed by whole 32-byte words, so its hex body is
  // 8 + 64n characters long. An address (40) and a transaction hash (64) both fail
  // that test, which is exactly the point — error messages are full of both, and
  // reporting the contract address as "custom error (0x1234abcd…)" is a fabricated
  // diagnosis of a revert that may have had a real reason elsewhere.
  for (const match of text.matchAll(/0x([0-9a-fA-F]+)/g)) {
    const body = match[1] ?? "";
    if (body.length >= 8 && (body.length - 8) % 64 === 0) {
      return `Reverted: custom error (0x${body.slice(0, 8)}…)`;
    }
  }

  return "Reverted (no reason given).";
}

/**
 * A receipt with status 0 says the transaction failed and nothing about why — the
 * reason is not in the receipt at all. Replaying the same call against the block
 * it failed in makes the node produce the revert data, which `describeRevert` can
 * then name. This is the difference between "REVERTED" and "REVERTED: stage not
 * active", and it is the whole question the operator has at that moment.
 *
 * Off the hot path by construction: it runs after the mint is decided. It never
 * throws — a diagnosis that cannot be obtained is reported as its absence, never
 * as a failure of the run.
 */
async function revertReasonFor(
  provider: JsonRpcProvider,
  plan: MintPlan,
  wallet: LoadedWallet,
  block: number,
): Promise<string | undefined> {
  try {
    await provider.call({
      from: wallet.address,
      to: plan.to,
      data: plan.data,
      value: plan.value,
      blockTag: block,
    });
    // Replayed cleanly: the failure depended on state this block no longer has —
    // someone else took the last token in the same block, typically. Claiming a
    // reason here would be inventing one.
    return undefined;
  } catch (err: unknown) {
    const described = describeRevert(err instanceof Error ? err.message : String(err));
    return described === "Reverted (no reason given)." ? undefined : described;
  }
}

export async function runMint(
  opts: EngineOptions,
  emit: (event: EngineEvent) => void,
): Promise<EngineResult> {
  const {
    chain,
    plan,
    wallets,
    readUrls,
    blastUrls,
    gas,
    fireAtMs,
    signal,
    skipSimulation = false,
    requireSimulation = false,
    dryRun = false,
  } = opts;

  // Collected rather than thrown on, so one dry run surfaces every problem.
  // A live run still aborts at the first: see the module header in dryrun.ts.
  const refusals: string[] = [];
  const skippedWallets: { address: string; reason: string }[] = [];
  const refuse = (detail: string): void => {
    if (!dryRun) throw new Error(`Refusing to broadcast: ${detail}`);
    refusals.push(detail);
  };

  if (wallets.length === 0) throw new Error("No wallets loaded — nothing to mint with.");
  if (blastUrls.length === 0) throw new Error("No RPC endpoints available to broadcast to.");
  if (readUrls.length === 0) {
    throw new Error("No read-capable RPC endpoint — cannot fetch nonces or verify the chain.");
  }

  const provider = new JsonRpcProvider(readUrls[0], chain.chainId, {
    staticNetwork: true, // skip the chainId round trip on every call
  });
  const endpoints: Endpoint[] = blastUrls.map((url) => ({ url, label: labelFor(url) }));
  const clock = new CorrectedClock(0);

  try {
    // ── Preparation, concurrent where the work is independent ──────────────
    emit({ type: "phase", name: "prepare", detail: `${wallets.length} wallet(s), ${endpoints.length} endpoint(s)` });

    for (const warning of planWarnings(plan, Date.now())) {
      emit({ type: "warning", message: warning });
    }

    // The price ceiling, before any network work and long before anything is
    // signed. On a live run `refuse` throws here, so nothing below this line
    // happens at all; a dry run records it and carries on so that one rehearsal
    // surfaces every refusal rather than only the first.
    const overCeiling = priceCeilingRefusal({
      value: plan.value,
      quantity: plan.quantity,
      ceilingPerNftWei: opts.maxPricePerNftWei ?? null,
      symbol: chain.nativeSymbol,
    });
    if (overCeiling) refuse(overCeiling);

    const required = requiredBalance(plan.value, gas);
    const [, clockSync, nonces, balances] = await Promise.all([
      warmConnections(blastUrls, signal ? { signal } : {}),
      syncClock(readUrls, chain.blockTimeSec, { rounds: opts.clockRounds ?? 3 }),
      fetchNonces(provider, wallets),
      checkBalances(provider, wallets, required),
    ]);
    throwIfAborted(signal);

    clock.applySync(clockSync);
    emit({ type: "clock", sync: clockSync });

    // ── Clock drift guard ──────────────────────────────────────────────────
    //
    // Evaluated always, enforced only when a limit was given. An operator at a
    // terminal can read the measured offset and decide for themselves; an
    // unattended daemon passes a limit because nobody is there to make that call.
    //
    // The guard keys on uncertainty rather than offset: a measured offset is
    // corrected for, and measuring it is the entire reason syncClock exists.
    const drift = driftGuard(clockSync, opts.driftLimitMs ?? Number.POSITIVE_INFINITY);
    if (!drift.ok) {
      // Warned about either way. The difference an unattended run makes is that
      // it also stops; the operator at a terminal is told and left to judge.
      emit({ type: "warning", message: drift.detail });
      if (opts.driftLimitMs !== undefined) refuse(drift.detail);
    }
    emit({ type: "balances", reports: balances, required, symbol: chain.nativeSymbol });

    // Paired by address, not by subscript: both arrays are positional, and
    // `wallets` is a subset whenever a task selects wallets rather than using
    // every loaded key. See splitByFunding for why the naive subscript fails
    // open rather than closed.
    const funding = splitByFunding(wallets, balances);
    const nonceByAddress = pairByAddress(wallets, nonces);

    const fundedWallets = funding.funded;
    for (const { wallet, verified } of funding.blocked) {
      skippedWallets.push({
        address: wallet.address,
        reason: verified
          ? `underfunded — needs ${formatEth(required, chain.nativeSymbol)}`
          : "funding unverified — no balance report for this wallet",
      });
    }
    if (fundedWallets.length === 0) {
      throw new Error(
        `Every wallet is short of ${formatEth(required, chain.nativeSymbol)} (value + gasLimit × maxFeePerGas) — nothing can be broadcast.`,
      );
    }
    if (fundedWallets.length < wallets.length) {
      emit({
        type: "warning",
        message: `${wallets.length - fundedWallets.length} wallet(s) underfunded and skipped; continuing with ${fundedWallets.length}.`,
      });
    }

      // ── Per-wallet mint-cap preflight ──────────────────────────────────────
      const eligibleWallets = await filterMintCapWallets(
        provider,
        plan,
        fundedWallets,
        emit,
      );
      throwIfAborted(signal);

      for (const w of fundedWallets) {
        if (!eligibleWallets.includes(w)) {
          skippedWallets.push({ address: w.address, reason: "per-wallet mint cap already reached" });
        }
      }

      if (eligibleWallets.length === 0) {
        throw new Error("No funded wallet remains eligible for the requested mint — nothing can be broadcast.");
      }

    // ── Simulation ─────────────────────────────────────────────────────────
    const simVerdicts = new Map<number, SimResult>();
    if (!skipSimulation) {
      emit({ type: "phase", name: "simulate" });
      const result = await simulate(provider, plan, eligibleWallets, emit);
      throwIfAborted(signal);
      for (const [index, verdict] of result.verdicts) simVerdicts.set(index, verdict);
      if (!result.ok && requireSimulation) {
        refuse(
          `${result.failures} wallet simulation(s) reverted and --require-simulation is set.`,
        );
      }
    }

    // ── Sign and serialize everything, before the stage opens ─────────────
    emit({ type: "phase", name: "sign" });
    const signStart = performance.now();
    const bundles: SignedBundle[] = [];
    for (const wallet of eligibleWallets) {
      const nonce = nonceByAddress.get(wallet.address.toLowerCase());
      if (nonce === undefined) throw new Error(`Missing nonce for wallet ${wallet.index}.`);
      const raw = await new Wallet(wallet.key).signTransaction({
        to: plan.to,
        data: plan.data,
        value: plan.value,
        nonce,
        maxFeePerGas: gas.maxFeePerGas,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
        gasLimit: gas.gasLimit,
        type: 2,
        chainId: chain.chainId,
      });
      bundles.push({ wallet, prepared: prepare(raw), nonce });
    }
    emit({ type: "signed", count: bundles.length, elapsedMs: performance.now() - signStart });
    throwIfAborted(signal);

    // ── A dry run stops here ───────────────────────────────────────────────
    //
    // Everything above has run: balances, per-wallet cap, simulation, the drift
    // guard, nonces, signing. The next section is the one that spends money, and
    // skipping it is the only thing that makes this a dry run. That ordering is
    // what makes a green dry run mean something.
    if (dryRun) {
      const report: DryRunReport = {
        target: opts.target ?? plan.nftContract,
        chainName: chain.name,
        chainId: chain.chainId,
        nativeSymbol: chain.nativeSymbol,
        to: plan.to,
        calldataBytes: (plan.data.length - 2) / 2,
        valuePerWallet: plan.value,
        gas,
        fireAtMs,
        nowMs: clock.now(),
        drift,
        wallets: bundles.map(
          ({ wallet, prepared, nonce }): DryRunWallet => {
            const sim = simVerdicts.get(wallet.index);
            return {
              index: wallet.index,
              address: wallet.address,
              nonce,
              txHash: prepared.txHash,
              rawBytes: (prepared.raw.length - 2) / 2,
              simulation: sim?.verdict ?? "skipped",
              ...(sim?.error ? { simulationError: sim.error } : {}),
            };
          },
        ),
        endpoints: endpoints.map((e) => e.label),
        skipped: skippedWallets,
        refusals,
      };
      emit({ type: "dryRun", report });
      emit({ type: "done", minted: 0, failed: 0 });
      return {
        minted: 0,
        failed: 0,
        timingErrorMs: 0,
        dispatchMs: 0,
        clock: clockSync,
        txHashes: [],
      };
    }

    // ── Crash safety: intent is recorded before anything is broadcast ──────
    //
    // Written here rather than at dispatch. The hashes are already known — they
    // are derived from the signed bytes — so the journal is on disk long before
    // T-0 and costs nothing in the hot path.
    //
    // A restart that finds a hash with no outcome knows to look that transaction
    // up rather than sign a competing one at the same nonce. Without this, "never
    // sent" and "sent, then we died" are indistinguishable after a crash.
    const statePath = opts.statePath === undefined ? defaultStatePath() : opts.statePath;
    let state: RunState | null = null;
    if (statePath !== null) {
      state = newRunState({
        runId: opts.runId ?? newRunId(Date.now()),
        target: opts.target ?? plan.nftContract,
        chainId: chain.chainId,
        startedAtMs: Date.now(),
        wallets: bundles.map(({ wallet, nonce }) => ({
          index: wallet.index,
          address: wallet.address,
          nonce,
        })),
      });
      for (const bundle of bundles) {
        state = recordIntent(state, bundle.wallet.index, bundle.prepared.txHash);
      }
      journal(state, statePath, emit);
    }

    // ── Wait for T-0 ───────────────────────────────────────────────────────
    let timingErrorMs = 0;
    if (fireAtMs !== null) {
      emit({ type: "phase", name: "wait", detail: formatRemaining(fireAtMs - clock.now()) });
      timingErrorMs = await waitUntil(
        fireAtMs,
        clock,
        (progress) => {
          emit({
            type: "countdown",
            remainingMs: progress.remainingMs,
            text: `${formatRemaining(progress.remainingMs)} (${progress.phase})`,
          });
        },
        // Handed in, not merely checked afterwards: a countdown can be hours
        // long, and a cancel noticed only at T-0 is not a cancel.
        signal,
      );
      throwIfAborted(signal);
    }

    // ── Dispatch. Nothing below this line computes anything. ───────────────
    const dispatchStart = performance.now();
    const fired = bundles.map(({ wallet, prepared }) => ({
      wallet,
      handle: blast(prepared, endpoints),
    }));
    const dispatchMs = performance.now() - dispatchStart;

    emit({ type: "fired", count: fired.length, dispatchMs, timingErrorMs });
    for (const { wallet, handle } of fired) {
      emit({ type: "tx", index: wallet.index, address: wallet.address, txHash: handle.txHash });
    }

    // ── Acceptance. "Dispatched" only means bytes were written. ────────────
    const settled = await Promise.all(
      fired.map(async ({ wallet, handle }) => ({
        wallet,
        txHash: handle.txHash,
        outcomes: await handle.outcomes,
      })),
    );

    if (state !== null && statePath !== null) {
      let updated = state;
      for (const { wallet, outcomes } of settled) {
        const ok = wasAccepted(outcomes);
        const firstError = outcomes.map((o) => o.error).find((e): e is string => !!e);
        updated = recordOutcome(
          updated,
          wallet.index,
          ok ? "accepted" : "rejected",
          ok ? undefined : firstError,
        );
      }
      state = updated;
      journal(state, statePath, emit);
    }

    const accepted: { wallet: LoadedWallet; txHash: string }[] = [];
    for (const { wallet, txHash, outcomes } of settled) {
      if (wasAccepted(outcomes)) {
        const first = firstAcceptance(outcomes);
        emit({
          type: "accepted",
          index: wallet.index,
          label: first?.label ?? "unknown",
          elapsedMs: first?.elapsedMs ?? 0,
        });
        accepted.push({ wallet, txHash });
        continue;
      }
      const reasons = [...new Set(outcomes.map((o) => o.error).filter((e): e is string => !!e))];
      const hint = reasons.map(classifyRejection).find((h): h is string => h !== null);
      emit({ type: "rejected", index: wallet.index, reasons, ...(hint ? { hint } : {}) });
    }

    if (accepted.length === 0) {
      closeJournal(statePath);
      emit({ type: "done", minted: 0, failed: settled.length });
      return {
        minted: 0,
        failed: settled.length,
        timingErrorMs,
        dispatchMs,
        clock: clockSync,
        txHashes: [],
      };
    }

    // ── Receipts ───────────────────────────────────────────────────────────
    emit({ type: "phase", name: "receipts", detail: `${accepted.length} in flight` });
    let minted = 0;
    let failed = settled.length - accepted.length;

    await Promise.all(
      accepted.map(async ({ wallet, txHash }) => {
        const receipt = await waitForReceipt(txHash, readUrls, {
          timeoutMs: opts.receiptTimeoutMs ?? 90_000,
          pollMs: Math.max(200, (chain.blockTimeSec * 1000) / 4),
          ...(signal ? { signal } : {}),
        });
        if (!receipt) {
          emit({
            type: "receiptTimeout",
            index: wallet.index,
            txHash,
            ...(signal?.aborted === true ? { cancelled: true } : {}),
          });
          return;
        }
        if (receipt.success) minted++;
        else failed++;
        const reason = receipt.success
          ? undefined
          : await revertReasonFor(provider, plan, wallet, receipt.block);
        emit({
          type: "receipt",
          index: wallet.index,
          txHash,
          block: receipt.block,
          position: receipt.position,
          success: receipt.success,
          gasUsed: receipt.gasUsed,
          reason,
        });
      }),
    );

    closeJournal(statePath);
    emit({ type: "done", minted, failed });
    return {
      minted,
      failed,
      timingErrorMs,
      dispatchMs,
      clock: clockSync,
      txHashes: accepted.map((a) => a.txHash),
    };
  } finally {
    provider.destroy();
  }
}

/**
 * Persist the journal, never at the cost of the mint.
 *
 * A full disk or a read-only filesystem is a reason to lose crash safety. It is
 * not a reason to lose the mint the operator is standing by for, so this warns
 * and continues rather than throwing.
 */
function journal(state: RunState, file: string, emit: (event: EngineEvent) => void): void {
  try {
    writeState(state, file);
  } catch (err: unknown) {
    emit({
      type: "warning",
      message:
        `Could not write the crash-safety journal to ${file}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `The mint continues, but a restart mid-broadcast will not know what was sent.`,
    });
  }
}

/** Drop the journal once every outcome is known and nothing more will be sent. */
function closeJournal(file: string | null): void {
  if (file === null) return;
  try {
    clearState(file);
  } catch {
    // Leaving a stale journal behind is harmless: every wallet in it has an
    // outcome, so a resume would skip all of them.
  }
}

function firstAcceptance(outcomes: BlastOutcome[]): BlastOutcome | undefined {
  return outcomes
    .filter((o) => o.txHash !== null || o.alreadyKnown)
    .sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
}

/** Convenience wrapper so callers don't reimplement the lead-time arithmetic. */
export function resolveFireTime(
  plan: MintPlan,
  mode: "stage" | "now" | { atMs: number },
  leadMs = 0,
): { fireAtMs: number | null; fire: FirePlan | null } {
  if (mode === "now") return { fireAtMs: null, fire: null };
  if (mode === "stage") {
    const fire = planFire(plan.drop.startTime, { leadMs });
    return { fireAtMs: fire.fireAtMs, fire };
  }
  return {
    fireAtMs: mode.atMs - leadMs,
    fire: { fireAtMs: mode.atMs - leadMs, stageOpensAtMs: plan.drop.startTime * 1000, leadMs },
  };
}
