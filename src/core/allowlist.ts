// Allowlist / FCFS minting.
//
// This path is structurally slower than a public mint and it is worth being clear
// about why, because no amount of engineering removes it: `mintSigned()` requires
// a signature that OpenSea's server produces, bound to one minter, one quantity
// and one salt. OpenSea will not issue it before the stage opens. So the sequence
// is necessarily:
//
//     stage opens → request signature → verify → sign → broadcast
//
// where a public mint is:
//
//     sign in advance → stage opens → broadcast
//
// The API round trip therefore lands *inside* the race. What can be lifted out of
// it is the socket warm-up, the nonce fetch and the clock offset, and preArmAllowlist
// does exactly that, running them during the watcher's lead window before the stage
// opens rather than after. What cannot be lifted out is the signature and the
// balance check that depends on the price the signature carries — that check is
// only possible once OpenSea has answered, so it stays inside the race by
// construction, and no wording here should suggest otherwise.
//
// The other difference is trust. A public mint's calldata is built locally from
// contract reads, so it cannot be tampered with. Here the bytes come from an HTTP
// response, and they are what the user's key will sign. Every response is decoded
// and checked against independently known values before it is signed; see
// verifyAllowlistTx. A response that does not parse as a known mint is refused.

import { JsonRpcProvider, Wallet } from "ethers";
import { ChainProfile } from "./chains";
import { EngineEvent, EngineResult } from "./engine";
import { ClockSync, syncClock } from "./clock";
import {
  Endpoint,
  blast,
  classifyRejection,
  prepare,
  waitForReceipt,
  warmConnections,
  wasAccepted,
} from "./blast";
import { labelFor } from "./rpc";
import {
  GasSettings,
  LoadedWallet,
  checkBalances,
  fetchNonces,
  formatEth,
  priceCeilingRefusal,
  requiredBalance,
} from "./wallets";
import { OpenSeaError, VerifiedMintTx, requestMintTx, verifyAllowlistTx } from "./opensea";
import { EligibilityHint, FailureCode, localFailure } from "./failures";
import { planNextPoll } from "./race";

export interface AllowlistOptions {
  chain: ChainProfile;
  slug: string;
  contract: string;
  apiKey: string;
  quantity: number;
  wallets: LoadedWallet[];
  readUrls: string[];
  blastUrls: string[];
  gas: GasSettings;
  /**
   * The most one NFT may cost, in wei. null or absent means no ceiling.
   *
   * The one bound on this path's price that the operator set. Everything else
   * about the value is checked against the response the value came in.
   */
  maxPricePerNftWei?: bigint | null;
  /** Keep retrying the transient rejections for this long before giving up. */
  retryWindowMs?: number;
  /** Base poll interval. Backoff and jitter are applied on top of it. */
  retryIntervalMs?: number;
  /**
   * What the eligibility endpoint said about each wallet, when it was asked.
   *
   * Present only to disambiguate a 422, which on its own covers four different
   * causes. With a real eligibility answer beside it the same status resolves to
   * exactly one — and that is the whole reason for fetching eligibility early
   * rather than inferring it from a refusal.
   *
   * Keyed by lowercased address, and deliberately not a single hint shared across
   * the run: eligibility is per wallet, and two wallets on the same drop routinely
   * differ. One shared hint would let a 422 for wallet B be explained by wallet
   * A's allowance — a wrong code, stated confidently, which is the failure this
   * whole classification layer exists to avoid. A wallet with no entry gets null
   * and the 422 stays ambiguous, which is the honest answer.
   */
  eligibility?: ReadonlyMap<string, EligibilityHint> | null;
  /**
   * Work already completed during the pre-open lead window.
   *
   * When present, the socket warm-up and clock sync are not repeated — they were
   * done before the stage opened, which is the entire point of having a lead.
   * When absent (the stage was already open on arrival, so there was no lead to
   * use) the same work happens here instead, and the race pays for it.
   */
  prearmed?: PreArmed | null;
  receiptTimeoutMs?: number;
  signal?: AbortSignal;
}

interface BuiltTx {
  wallet: NoncedWallet;
  verified: VerifiedMintTx;
  raw: string;
}

/** LoadedWallet plus the nonce fetched during preparation. */
export type NoncedWallet = LoadedWallet & { nonce: number };

/**
 * Ask OpenSea for a mint, retrying the transient rejections.
 *
 * 409 and 422 both mean "not right now" and both are common in the first seconds
 * of a stage: the drop's state is propagating, and an allowlist check can lag the
 * stage opening by a block or two. Retrying briefly converts a lost mint into a
 * slightly later one.
 *
 * Which answers are worth retrying, and how long to wait, is not decided here —
 * planNextPoll decides it from the classified failure. This loop previously had its
 * own policy and it was wrong in two ways that only show up under load. It waited a
 * flat 1.5s regardless, so several wallets retried in lockstep and looked precisely
 * like the burst a rate limiter exists to stop; and it retried only 409/422/429, so
 * a 503 or a dropped connection — both entirely ordinary in the first seconds of a
 * contested drop — ended the wallet's mint outright instead of being tried again a
 * moment later.
 *
 * What is decided here is that a verification failure is never retried. Everything
 * below verifyAllowlistTx has been checked against values we hold independently; a
 * response that fails those checks is refused, and asking again is not a remedy for
 * calldata that did not say what it should have.
 */
async function buildForWallet(
  opts: AllowlistOptions,
  wallet: NoncedWallet,
  emit: (event: EngineEvent) => void,
): Promise<BuiltTx | null> {
  const deadline = Date.now() + (opts.retryWindowMs ?? 20_000);
  const pollMs = opts.retryIntervalMs ?? 1_500;
  let attempt = 0;

  const giveUp = (message: string, code?: FailureCode): null => {
    emit({
      type: "simulation",
      ok: false,
      index: wallet.index,
      address: wallet.address,
      error: message,
      ...(code !== undefined ? { code } : {}),
    });
    return null;
  };

  for (;;) {
    if (opts.signal?.aborted) return null;
    attempt += 1;
    try {
      const raw = await requestMintTx(opts.slug, opts.apiKey, wallet.address, opts.quantity);

      // The security boundary. Everything below this line has been checked
      // against values we know from our own configuration and the chain.
      const verified = verifyAllowlistTx(raw, {
        expectedChainKey: opts.chain.key,
        expectedContract: opts.contract,
        expectedMinter: wallet.address,
        expectedQuantity: opts.quantity,
        allowTokenTarget: true,
      });

      // The price gate. `verifyAllowlistTx` has proved the response agrees with
      // itself; it cannot prove the price is one the operator meant to pay,
      // because the mintPrice it compared against was decoded from that same
      // response. Not retried — see `giveUp` below, and PRICE_TOO_HIGH's entry
      // in FAILURE_META: asking again returns the same price.
      const overCeiling = priceCeilingRefusal({
        value: verified.value,
        quantity: opts.quantity,
        ceilingPerNftWei: opts.maxPricePerNftWei ?? null,
        symbol: opts.chain.nativeSymbol,
      });
      if (overCeiling) return giveUp(`[W${wallet.index}] ${overCeiling}`, "PRICE_TOO_HIGH");

      const signed = await new Wallet(wallet.key).signTransaction({
        to: verified.to,
        data: verified.data,
        value: verified.value,
        nonce: wallet.nonce,
        maxFeePerGas: opts.gas.maxFeePerGas,
        maxPriorityFeePerGas: opts.gas.maxPriorityFeePerGas,
        gasLimit: opts.gas.gasLimit,
        type: 2,
        chainId: opts.chain.chainId,
      });
      return { wallet, verified, raw: signed };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // Not an HTTP failure: either verifyAllowlistTx refused the response or the
      // local sign failed. Neither is a "try again" — the first is the security
      // boundary doing its job and the second is a configuration fault.
      if (!(err instanceof OpenSeaError)) {
        return giveUp(message, localFailure("SIMULATION_REVERT").code);
      }

      const action = planNextPoll(err.status, attempt, {
        pollMs,
        retryAfterMs: err.retryAfterMs,
        endpoint: "mint",
        eligibility: opts.eligibility?.get(wallet.address.toLowerCase()) ?? null,
      });

      if (action.kind === "stop") return giveUp(action.reason, action.failure.code);
      // `fire` requires a null status, which an OpenSeaError never carries.
      if (action.kind === "fire") return giveUp(message);

      // Waiting past the deadline is the same as giving up, but reporting it as a
      // wait that was never taken is clearer than reporting it as a refusal.
      if (Date.now() + action.delayMs >= deadline) {
        return giveUp(`${message} Retry window exhausted.`);
      }

      emit({
        type: "warning",
        message: `[W${wallet.index}] ${message} Retrying in ${action.delayMs}ms.`,
      });
      await new Promise((resolve) => setTimeout(resolve, action.delayMs));
    }
  }
}

export async function runAllowlistMint(
  opts: AllowlistOptions & { wallets: NoncedWallet[] },
  emit: (event: EngineEvent) => void,
): Promise<EngineResult> {
  const { chain, wallets, readUrls, blastUrls, gas } = opts;
  if (wallets.length === 0) throw new Error("No wallets loaded — nothing to mint with.");
  if (readUrls.length === 0) throw new Error("No read-capable RPC endpoint available.");

  const provider = new JsonRpcProvider(readUrls[0], chain.chainId, { staticNetwork: true });
  const endpoints: Endpoint[] = blastUrls.map((url) => ({ url, label: labelFor(url) }));

  try {
    emit({ type: "phase", name: "prepare", detail: `${wallets.length} wallet(s), allowlist stage` });

    // Everything that does not need the signature is done before the signature
    // request, so the API round trip is the only thing left inside the race.
    // Ideally it was done before the stage even opened — see preArmAllowlist.
    let clockSync: ClockSync;
    if (opts.prearmed) {
      assertPreArmCovers(opts.prearmed, wallets);
      clockSync = opts.prearmed.clock;
    } else {
      const [, measured] = await Promise.all([
        warmConnections(blastUrls, opts.signal ? { signal: opts.signal } : {}),
        syncClock(readUrls, chain.blockTimeSec, { rounds: 2 }),
      ]);
      clockSync = measured;
    }
    emit({ type: "clock", sync: clockSync });

    emit({ type: "phase", name: "sign", detail: "requesting signatures from OpenSea" });
    const started = performance.now();
    const built = (
      await Promise.all(
        wallets.map((wallet: NoncedWallet) => buildForWallet(opts, wallet, emit)),
      )
    ).filter((b): b is BuiltTx => b !== null);

    if (built.length === 0) {
      throw new Error(
        "OpenSea would not build a mint for any wallet. Common causes: not on the allowlist, per-wallet limit reached, supply exhausted, or the stage is closed. Nothing was sent.",
      );
    }
    emit({ type: "signed", count: built.length, elapsedMs: performance.now() - started });

    // The price is only known once OpenSea has answered, so the affordability
    // check happens here rather than during preparation.
    const value = built[0]!.verified.value;
    const required = requiredBalance(value, gas);
    const balances = await checkBalances(
      provider,
      built.map((b) => b.wallet),
      required,
    );
    emit({ type: "balances", reports: balances, required, symbol: chain.nativeSymbol });

    const affordable = built.filter(
      (b) => balances.find((r) => r.index === b.wallet.index)?.sufficient !== false,
    );
    if (affordable.length === 0) {
      throw new Error(
        `Every wallet is short of ${formatEth(required, chain.nativeSymbol)} — nothing was sent.`,
      );
    }

    // Dispatch.
    const dispatchStart = performance.now();
    const fired = affordable.map((b) => ({ wallet: b.wallet, handle: blast(prepare(b.raw), endpoints) }));
    const dispatchMs = performance.now() - dispatchStart;

    emit({ type: "fired", count: fired.length, dispatchMs, timingErrorMs: 0 });
    for (const { wallet, handle } of fired) {
      emit({ type: "tx", index: wallet.index, address: wallet.address, txHash: handle.txHash });
    }

    const settled = await Promise.all(
      fired.map(async ({ wallet, handle }) => ({
        wallet,
        txHash: handle.txHash,
        outcomes: await handle.outcomes,
      })),
    );

    const accepted: { wallet: LoadedWallet; txHash: string }[] = [];
    for (const { wallet, txHash, outcomes } of settled) {
      if (wasAccepted(outcomes)) {
        const best = outcomes
          .filter((o) => o.txHash !== null || o.alreadyKnown)
          .sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
        emit({
          type: "accepted",
          index: wallet.index,
          label: best?.label ?? "unknown",
          elapsedMs: best?.elapsedMs ?? 0,
        });
        accepted.push({ wallet, txHash });
        continue;
      }
      const reasons = [...new Set(outcomes.map((o) => o.error).filter((e): e is string => !!e))];
      const hint = reasons.map(classifyRejection).find((h): h is string => h !== null);
      emit({ type: "rejected", index: wallet.index, reasons, ...(hint ? { hint } : {}) });
    }

    let minted = 0;
    let failed = settled.length - accepted.length;

    if (accepted.length > 0) {
      emit({ type: "phase", name: "receipts", detail: `${accepted.length} in flight` });
      await Promise.all(
        accepted.map(async ({ wallet, txHash }) => {
          const receipt = await waitForReceipt(txHash, readUrls, {
            timeoutMs: opts.receiptTimeoutMs ?? 90_000,
            pollMs: Math.max(200, (chain.blockTimeSec * 1000) / 4),
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
          if (!receipt) {
            emit({
              type: "receiptTimeout",
              index: wallet.index,
              txHash,
              ...(opts.signal?.aborted === true ? { cancelled: true } : {}),
            });
            return;
          }
          if (receipt.success) minted++;
          else failed++;
          emit({
            type: "receipt",
            index: wallet.index,
            txHash,
            block: receipt.block,
            position: receipt.position,
            success: receipt.success,
            gasUsed: receipt.gasUsed,
          });
        }),
      );
    }

    emit({ type: "done", minted, failed });
    return {
      minted,
      failed,
      timingErrorMs: 0,
      dispatchMs,
      clock: clockSync,
      txHashes: accepted.map((a) => a.txHash),
    };
  } finally {
    provider.destroy();
  }
}

/** Attach pending nonces so the signing loop has no round trip left to make. */
export async function withNonces(
  provider: JsonRpcProvider,
  wallets: LoadedWallet[],
): Promise<NoncedWallet[]> {
  const nonces = await fetchNonces(provider, wallets);
  return wallets.map((wallet, i) => {
    // Never default. A missing nonce defaulting to 0 does not fail — it signs a
    // transaction with a nonce the wallet used long ago, which the network
    // discards silently, so the mint is lost and the output says nothing went
    // wrong. The engine throws on this exact condition; both paths must agree.
    const nonce = nonces[i];
    if (nonce === undefined) {
      throw new Error(`Missing nonce for wallet ${wallet.index} (${wallet.address}).`);
    }
    return { ...wallet, nonce };
  });
}

/** Work finished before the stage opens, so the race does not have to pay for it. */
export interface PreArmed {
  /** Wallets with their pending nonce attached, ready to sign. */
  wallets: NoncedWallet[];
  /** The clock offset measured during the lead, to be reused rather than re-measured. */
  clock: ClockSync;
  /** When the preparation finished, so an operator can see the lead actually achieved. */
  completedAtMs: number;
}

/**
 * Do everything the mint needs that does not depend on OpenSea's signature.
 *
 * This exists because the module header above claims the socket warm-up, the
 * nonce fetch and the fee decision are moved out of the race — and until this
 * function was called from the watcher's lead window, that claim was false. The
 * work was happening, but it was happening after the stage had already opened,
 * which is the one moment it is expensive. Three RPC round trips and a TLS
 * handshake cost the same number of milliseconds wherever they run; the only
 * question is whether a contested mint is waiting on them.
 *
 * What cannot be moved is the signature itself, and the balance check that
 * depends on the price it carries. Those stay inside the race by construction.
 *
 * One consequence worth stating: nonces fetched during the lead are a snapshot.
 * If the same wallet sends another transaction between the lead and the mint,
 * the snapshot is stale and the mint will be rejected as a duplicate nonce. For
 * a single operator with a wallet dedicated to the drop that is not a real risk,
 * and it is the same exposure the pre-signing public path already accepts — but
 * it is a reason not to widen the lead much beyond a minute.
 */
export async function preArmAllowlist(opts: {
  provider: JsonRpcProvider;
  wallets: LoadedWallet[];
  readUrls: string[];
  blastUrls: string[];
  blockTimeSec: number;
  signal?: AbortSignal;
}): Promise<PreArmed> {
  const [wallets, , clock] = await Promise.all([
    withNonces(opts.provider, opts.wallets),
    warmConnections(opts.blastUrls, opts.signal ? { signal: opts.signal } : {}),
    syncClock(opts.readUrls, opts.blockTimeSec, { rounds: 2 }),
  ]);
  return { wallets, clock, completedAtMs: Date.now() };
}

/**
 * Refuse a pre-arm that does not cover every wallet about to mint.
 *
 * Passing `prearmed` from one wallet set and `wallets` from another would mint
 * with a nonce belonging to a different account, which the network discards
 * silently — the same failure mode withNonces refuses to default into.
 */
function assertPreArmCovers(prearmed: PreArmed, wallets: NoncedWallet[]): void {
  const armed = new Set(prearmed.wallets.map((w) => w.address.toLowerCase()));
  const missing = wallets.find((w) => !armed.has(w.address.toLowerCase()));
  if (missing) {
    throw new Error(
      `Pre-arm does not cover wallet ${missing.index} (${missing.address}) — no nonce was fetched for it. Nothing was sent.`,
    );
  }
}
