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

import { keccak256 } from "ethers";

import { markPublicHash } from "./wallets";

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
