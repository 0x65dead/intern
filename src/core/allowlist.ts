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
// The API round trip therefore lands *inside* the race, and the only things that
// can be moved out of it are the socket warm-up, the balance check, the nonce
// fetch and the fee decision — all of which are.
//
// The other difference is trust. A public mint's calldata is built locally from
// contract reads, so it cannot be tampered with. Here the bytes come from an HTTP
// response, and they are what the user's key will sign. Every response is decoded
// and checked against independently known values before it is signed; see
// verifyAllowlistTx. A response that does not parse as a known mint is refused.

import { JsonRpcProvider, Wallet } from "ethers";
import { ChainProfile } from "./chains";
import { EngineEvent, EngineResult } from "./engine";
import { syncClock } from "./clock";
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
  requiredBalance,
} from "./wallets";
import { OpenSeaError, VerifiedMintTx, requestMintTx, verifyAllowlistTx } from "./opensea";

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
  /** Retry a 409/422 for this long before giving up. */
  retryWindowMs?: number;
  retryIntervalMs?: number;
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
 * slightly later one. 401/403/404 are not retried — they will not fix themselves.
 */
async function buildForWallet(
  opts: AllowlistOptions,
  wallet: NoncedWallet,
  emit: (event: EngineEvent) => void,
): Promise<BuiltTx | null> {
  const deadline = Date.now() + (opts.retryWindowMs ?? 20_000);
  const interval = opts.retryIntervalMs ?? 1_500;

  for (;;) {
    if (opts.signal?.aborted) return null;
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
      const retryable = err instanceof OpenSeaError && err.retryable;
      const message = err instanceof Error ? err.message : String(err);

      if (!retryable || Date.now() >= deadline) {
        emit({
          type: "simulation",
          ok: false,
          index: wallet.index,
          address: wallet.address,
          error: message,
        });
        return null;
      }
      emit({ type: "warning", message: `[W${wallet.index}] ${message} Retrying.` });
      await new Promise((resolve) => setTimeout(resolve, interval));
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

    // Everything that can be done before the signature request is done now, so
    // the API round trip is the only thing left inside the race.
    const [, clockSync] = await Promise.all([
      warmConnections(blastUrls, opts.signal ? { signal: opts.signal } : {}),
      syncClock(readUrls, chain.blockTimeSec, { rounds: 2 }),
    ]);
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
