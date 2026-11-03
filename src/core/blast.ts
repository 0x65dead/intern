// Broadcast a pre-signed transaction to every endpoint at once.
//
// The design constraint: at T-0 there must be no computation left. Everything
// that can be hoisted out of the firing path is hoisted — the JSON body is built
// and stringified in advance, the transaction hash is derived locally rather than
// read from a response, and sockets are already open.
//
// What remains at fire time is `fetch()` per endpoint, dispatched without
// awaiting. Dispatch is measured separately from acceptance because they answer
// different questions: dispatch latency is what we control, acceptance is what
// the network decided.

import { keccak256, Transaction, Wallet } from "ethers";

import { markPublicHash, type LoadedWallet } from "./wallets";

export interface Endpoint {
  url: string;
  label: string;
}

export interface BlastOutcome {
  label: string;
  url: string;
  /** Hash the endpoint acknowledged, or null when it rejected or failed. */
  txHash: string | null;
  error: string | null;
  /** True when the endpoint already had this transaction — still a success. */
  alreadyKnown: boolean;
  /** Wall time from dispatch to this endpoint's reply. */
  elapsedMs: number;
}

export interface PreparedTx {
  /** Locally derived hash — no round trip needed to know it. */
  txHash: string;
  /** Fully serialized JSON-RPC body, stringified once. */
  body: string;
  raw: string;
}

/**
 * Hoist every byte of preparation out of the firing path. Call after signing and
 * well before T-0.
 */
export function prepare(rawTx: string): PreparedTx {
  // Derived from a transaction this process signed, so it is ours and public.
  // Saying so here is what keeps it out of the key redactor, which cannot tell a
  // hash from a key by shape and hides both otherwise.
  const txHash = markPublicHash(keccak256(rawTx));
  return {
    txHash,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: [rawTx],
      id: 1,
    }),
    raw: rawTx,
  };
}

/** "already known" and friends mean the network has it — a win, not an error. */
export function isAlreadyKnown(message: string): boolean {
  return /already known|already exists|alreadyknown|duplicate transaction|known transaction/i.test(
    message,
  );
}

/**
 * A rejection that will never succeed no matter how many endpoints are tried, so
 * the caller can report a cause instead of a wall of identical errors.
 */
export function classifyRejection(message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes("less than block base fee") || m.includes("max fee per gas less than"))
    return "maxFeePerGas is below the chain's base fee — raise the fee ceiling.";
  if (m.includes("nonce too low")) return "Nonce already used — a transaction from this wallet already landed.";
  if (m.includes("insufficient funds"))
    return "Wallet cannot cover value + gasLimit × maxFeePerGas.";
  if (m.includes("intrinsic gas too low")) return "gasLimit is below the transaction's intrinsic cost.";
  if (m.includes("replacement transaction underpriced"))
    return "A pending transaction with this nonce exists at a higher fee.";
  if (m.includes("exceeds block gas limit")) return "gasLimit exceeds the chain's block gas limit.";
  return null;
}

export interface BlastHandle {
  txHash: string;
  /** Milliseconds spent dispatching — the only part on the critical path. */
  dispatchMs: number;
  /** Resolves once every endpoint has replied or failed. */
  outcomes: Promise<BlastOutcome[]>;
}

/**
 * Fire at every endpoint simultaneously and return immediately.
 *
 * Requests are initiated but not awaited: the returned promise collects replies
 * in the background so the caller can dispatch the next wallet without waiting
 * for the first one's network round trip. With N wallets this is the difference
 * between N sequential round trips and one.
 */
export function blast(prepared: PreparedTx, endpoints: Endpoint[]): BlastHandle {
  const startedAt = performance.now();
  const { body, txHash } = prepared;

  const inFlight = endpoints.map((endpoint) => {
    const sentAt = performance.now();
    return fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    })
      .then(async (res): Promise<BlastOutcome> => {
        const elapsedMs = performance.now() - sentAt;
        const text = await res.text();
        let json: { result?: string; error?: { message?: string; code?: number } };
        try {
          json = JSON.parse(text) as typeof json;
        } catch {
          return {
            label: endpoint.label,
            url: endpoint.url,
            txHash: null,
            error: `HTTP ${res.status}: ${text.slice(0, 120)}`,
            alreadyKnown: false,
            elapsedMs,
          };
        }
        if (typeof json.result === "string") {
          return {
            label: endpoint.label,
            url: endpoint.url,
            txHash: json.result,
            error: null,
            alreadyKnown: false,
            elapsedMs,
          };
        }
        const message = json.error?.message ?? `HTTP ${res.status}`;
        return {
          label: endpoint.label,
          url: endpoint.url,
          txHash: null,
          error: message,
          alreadyKnown: isAlreadyKnown(message),
          elapsedMs,
        };
      })
      .catch(
        (err: unknown): BlastOutcome => ({
          label: endpoint.label,
          url: endpoint.url,
          txHash: null,
          error: err instanceof Error ? err.message : String(err),
          alreadyKnown: false,
          elapsedMs: performance.now() - sentAt,
        }),
      );
  });

  return {
    txHash,
    dispatchMs: performance.now() - startedAt,
    outcomes: Promise.all(inFlight),
  };
}

/** Did any endpoint take it? "already known" counts — the bytes are on the network. */
export function wasAccepted(outcomes: BlastOutcome[]): boolean {
  return outcomes.some((o) => o.txHash !== null || o.alreadyKnown);
}

export interface Receipt {
  block: number;
  position: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint | null;
  success: boolean;
}

/**
 * Poll for a receipt across every readable endpoint at once.
 *
 * Polling one endpoint means waiting for that node to sync the block. Racing all
 * of them returns as soon as *any* node has it, which on a fresh block is often
 * hundreds of milliseconds earlier — and it survives a single node stalling.
 */
export async function waitForReceipt(
  txHash: string,
  readUrls: string[],
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<Receipt | null> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 400;
  const signal = opts.signal;
  const deadline = Date.now() + timeoutMs;
  const urls = readUrls.length > 0 ? readUrls : [];
  if (urls.length === 0) return null;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "eth_getTransactionReceipt",
    params: [txHash],
    id: 1,
  });

  // Cancelling stops the watching, not the transaction: these hashes are already
  // in the mempool and are already journalled. Without this the operator's
  // /cancel is acknowledged and then ignored for up to ninety seconds, which
  // reads as a dead bot at the worst possible moment.
  while (Date.now() < deadline && signal?.aborted !== true) {
    const replies = await Promise.allSettled(
      urls.map(async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal:
              signal === undefined
                ? controller.signal
                : AbortSignal.any([controller.signal, signal]),
          });
          const json = (await res.json()) as {
            result?: {
              transactionHash?: string;
              blockNumber: string;
              transactionIndex: string;
              gasUsed: string;
              effectiveGasPrice?: string;
              status: string;
            } | null;
          };
          return json.result ?? null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    for (const reply of replies) {
      if (reply.status !== "fulfilled" || !reply.value) continue;
      const r = reply.value;

      // First reply wins, so that reply must be about the transaction we asked
      // about. Without this check a single endpoint — buggy, stale behind a
      // reorg, or hostile — can hand back someone else's receipt and decide the
      // strongest word this tool prints. "minted" means status 1 on *this* hash.
      if (typeof r.transactionHash === "string" && r.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
        continue;
      }

      const block = parseInt(r.blockNumber, 16);
      const position = parseInt(r.transactionIndex, 16);
      if (!Number.isFinite(block) || !Number.isFinite(position)) continue;

      return {
        block,
        position,
        gasUsed: BigInt(r.gasUsed),
        effectiveGasPrice: r.effectiveGasPrice ? BigInt(r.effectiveGasPrice) : null,
        success: r.status === "0x1",
      };
    }
    await sleepUnlessAborted(pollMs, signal);
  }
  return null;
}

export interface RbfReplacement {
  walletIndex: number;
  txHash: string;
  replacedTxHash: string;
}

export interface RbfMonitorResult {
  receipt: Receipt | null;
  /** Latest accepted transaction hash, or the original hash if no replacement landed. */
  txHash: string;
  replacementCount: number;
  ceilingReached: boolean;
  reason?: string;
}

export interface RbfMonitorOptions {
  timeoutMs?: number;
  pollMs?: number;
  stuckAfterMs?: number;
  maxFeePerGasWei?: bigint | null;
  maxAttempts?: number;
  signal?: AbortSignal;
  /** Must durably record the new hash before it is broadcast. */
  onBeforeReplacement?: (replacement: RbfReplacement) => Promise<void>;
}

interface RpcReceipt {
  transactionHash?: string;
  blockNumber?: string;
  transactionIndex?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  status?: string;
}

interface RpcPendingTransaction {
  hash?: string;
  from?: string;
  nonce?: string;
  blockNumber?: string | null;
}

async function rpcResult<T>(url: string, method: string, params: unknown[]): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { result?: T | null; error?: { message?: string } };
    return body.error ? null : body.result ?? null;
  } catch {
    return null;
  }
}

async function findReceipt(hash: string, urls: readonly string[]): Promise<Receipt | null> {
  const replies = await Promise.all(urls.map((url) => rpcResult<RpcReceipt>(url, "eth_getTransactionReceipt", [hash])));
  for (const receipt of replies) {
    if (!receipt || typeof receipt.status !== "string" || typeof receipt.blockNumber !== "string" ||
        typeof receipt.transactionIndex !== "string" || typeof receipt.gasUsed !== "string") continue;
    if (receipt.transactionHash && receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) continue;
    const block = Number.parseInt(receipt.blockNumber, 16);
    const position = Number.parseInt(receipt.transactionIndex, 16);
    if (!Number.isFinite(block) || !Number.isFinite(position)) continue;
    return {
      block,
      position,
      gasUsed: BigInt(receipt.gasUsed),
      effectiveGasPrice: receipt.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice) : null,
      success: receipt.status.toLowerCase() === "0x1",
    };
  }
  return null;
}

async function isPendingOnNetwork(
  hash: string,
  wallet: LoadedWallet,
  nonce: number,
  urls: readonly string[],
): Promise<boolean> {
  const replies = await Promise.all(urls.map((url) =>
    rpcResult<RpcPendingTransaction>(url, "eth_getTransactionByHash", [hash]),
  ));
  return replies.some((transaction) =>
    transaction !== null &&
    transaction.hash?.toLowerCase() === hash.toLowerCase() &&
    transaction.from?.toLowerCase() === wallet.address.toLowerCase() &&
    transaction.nonce !== undefined &&
    Number.parseInt(transaction.nonce, 16) === nonce &&
    transaction.blockNumber === null,
  );
}

function bumpTwelvePointFivePercent(value: bigint): bigint {
  return (value * 1125n + 999n) / 1000n;
}

async function signReplacement(
  rawTx: string,
  wallet: LoadedWallet,
  ceiling: bigint,
): Promise<{ prepared: PreparedTx; reason?: string }> {
  const original = Transaction.from(rawTx);
  if (
    original.type !== 2 ||
    original.to === null ||
    original.nonce === undefined ||
    original.gasLimit === null ||
    original.chainId === 0n ||
    original.maxFeePerGas === null ||
    original.maxPriorityFeePerGas === null
  ) {
    throw new Error("RBF supports only fully specified EIP-1559 transactions.");
  }

  const signer = new Wallet(wallet.key);
  if (original.from?.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("RBF signer does not match the original transaction sender.");
  }

  const maxFeePerGas = bumpTwelvePointFivePercent(original.maxFeePerGas);
  const maxPriorityFeePerGas = bumpTwelvePointFivePercent(original.maxPriorityFeePerGas);
  if (maxFeePerGas > ceiling || maxPriorityFeePerGas > ceiling) {
    return { prepared: { txHash: "", raw: "", body: "" }, reason: "gas ceiling reached" };
  }

  const raw = await signer.signTransaction({
    type: 2,
    chainId: original.chainId,
    nonce: original.nonce,
    to: original.to,
    data: original.data,
    value: original.value ?? 0n,
    gasLimit: original.gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    accessList: original.accessList ?? [],
  });
  return { prepared: prepare(raw) };
}

/**
 * Watch an accepted EIP-1559 transaction and replace it only after 45 seconds
 * when a read RPC confirms that the exact hash is still pending. Replacements
 * keep the original nonce and call data and increase both EIP-1559 fee fields
 * by 12.5%. An explicit gas ceiling is mandatory; without one, this is a
 * receipt-only monitor.
 */
export async function waitForReceiptWithRbf(
  initial: PreparedTx,
  wallet: LoadedWallet,
  readUrls: string[],
  endpoints: Endpoint[],
  opts: RbfMonitorOptions = {},
): Promise<RbfMonitorResult> {
  const timeoutMs = Math.max(1_000, opts.timeoutMs ?? 90_000);
  const pollMs = Math.max(200, opts.pollMs ?? 400);
  const stuckAfterMs = Math.max(45_000, opts.stuckAfterMs ?? 45_000);
  const maxAttempts = Math.max(0, Math.min(3, Math.floor(opts.maxAttempts ?? 0)));
  const ceiling = opts.maxFeePerGasWei ?? null;
  const deadline = Date.now() + timeoutMs;
  const hashes = [initial.txHash];
  let currentHash = initial.txHash;
  let currentRaw = initial.raw;
  let lastBroadcastAt = Date.now();
  let replacementCount = 0;
  let ceilingReached = false;
  let reason: string | undefined;

  while (Date.now() < deadline && opts.signal?.aborted !== true) {
    for (const hash of hashes) {
      const receipt = await findReceipt(hash, readUrls);
      if (receipt) {
        return { receipt, txHash: hash, replacementCount, ceilingReached, ...(reason ? { reason } : {}) };
      }
    }

    const eligibleToReplace =
      ceiling !== null &&
      ceiling > 0n &&
      replacementCount < maxAttempts &&
      !ceilingReached &&
      Date.now() - lastBroadcastAt >= stuckAfterMs;

    if (eligibleToReplace) {
      const parsed = Transaction.from(currentRaw);
      const stillPending = await isPendingOnNetwork(currentHash, wallet, parsed.nonce, readUrls);
      if (stillPending) {
        const signed = await signReplacement(currentRaw, wallet, ceiling);
        if (signed.reason) {
          ceilingReached = true;
          reason = "Tx stuck, but gas ceiling reached. Manual intervention required.";
        } else {
          const replacement: RbfReplacement = {
            walletIndex: wallet.index,
            txHash: signed.prepared.txHash,
            replacedTxHash: currentHash,
          };
          // Persist before sending. A crash after this point must reconcile both hashes.
          await opts.onBeforeReplacement?.(replacement);
          const outcomes = await blast(signed.prepared, endpoints).outcomes;
          const accepted = outcomes.some((outcome) =>
            outcome.txHash !== null || outcome.alreadyKnown,
          );
          if (!accepted) {
            const errors = outcomes.map((outcome) => outcome.error).filter((value): value is string => value !== null);
            reason = errors.some((error) => /replacement transaction underpriced/i.test(error))
              ? "Replacement was rejected as underpriced; no further fee bump was attempted."
              : `Replacement was rejected by all broadcast endpoints: ${errors.slice(0, 2).join("; ")}`;
            return { receipt: null, txHash: currentHash, replacementCount, ceilingReached, reason };
          }

          hashes.push(signed.prepared.txHash);
          currentHash = signed.prepared.txHash;
          currentRaw = signed.prepared.raw;
          replacementCount += 1;
          lastBroadcastAt = Date.now();
        }
      }
    }

    await sleepUnlessAborted(pollMs, opts.signal);
  }

  return {
    receipt: null,
    txHash: currentHash,
    replacementCount,
    ceilingReached,
    ...(reason ? { reason } : {}),
  };
}

/** Waits out the poll gap, but returns at once if the run is cancelled. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Open a TCP/TLS connection to every endpoint so the first real request doesn't
 * pay for a handshake.
 *
 * Warmed with a deliberately invalid eth_sendRawTransaction: some endpoints
 * (sequencers) reject every other method, and the handshake is the point, not the
 * response. Undici keeps the socket pooled afterwards, which is what saves the
 * ~100-300ms TLS round trip at fire time.
 */
export const WARM_TIMEOUT_MS = 3_000;

export async function warmConnections(
  urls: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "eth_sendRawTransaction",
    params: ["0x00"],
    id: 1,
  });
  // Bounded, because this is an optimisation and an optimisation must never be
  // able to block the thing it optimises. An unbounded fetch inherits undici's
  // ~300s header timeout, so a single endpoint that accepts the connection and
  // then says nothing holds up the whole prepare phase — and the mint does not
  // fire at all, to save a 200ms handshake. Past a few seconds the warm has lost
  // its purpose anyway; every failure mode here is already swallowed.
  const timeoutMs = opts.timeoutMs ?? WARM_TIMEOUT_MS;
  await Promise.allSettled(
    urls.map((url) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        signal: opts.signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal])
          : AbortSignal.timeout(timeoutMs),
      })
        .then((res) => res.text())
        .catch(() => undefined),
    ),
  );
}
