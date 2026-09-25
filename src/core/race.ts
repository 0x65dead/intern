// The race: everything that can be done before T-0, done before T-0.
//
// ── The honest speed claim ──────────────────────────────────────────────────
//
// A gated mint is slower than a public mint. That is structural, not a bug, and
// no engineering in this file removes it.
//
// A public SeaDrop mint is built entirely from on-chain reads, so the whole
// transaction — calldata, value, nonce, fees, signature — exists before the stage
// opens. At T-0 the only remaining operation is a network write:
//
//     [ before T-0: read, build, sign ]  →  T-0  →  broadcast
//
// An OpenSea-signed mint cannot be assembled in advance, because the server
// signature is bound to one minter, one quantity and one salt, and OpenSea does
// not issue it before the stage opens. So one HTTP round trip lands *inside* the
// race and cannot be moved out of it:
//
//     [ before T-0: nonce, fees, TLS ]  →  T-0  →  request → verify → sign → broadcast
//
// That round trip costs whatever OpenSea's API costs — typically 80-400ms, and
// more under the load a contested drop generates. It is paid by every bot on that
// drop, including OpenSea's own front end, so it is not a disadvantage against
// the field. It simply means a gated mint is not a public mint and must not be
// described as one.
//
// What this file does is make everything *else* zero. At T-0 the nonce is known,
// the fees are decided, the balance is checked, the TLS sessions to both OpenSea
// and the RPC endpoints are already open, and the only awaits remaining are the
// signature request, the local sign, and the broadcast.
//
// A Merkle allow-list is the exception and is worth choosing when it is offered:
// the proof is computed locally, so that path pre-signs exactly like a public
// mint and is as fast as one.

import { JsonRpcProvider, Wallet } from "ethers";
import { ChainProfile } from "./chains";
import { CorrectedClock } from "./clock";
import { BlastOutcome, Endpoint, blast, prepare, warmConnections, wasAccepted } from "./blast";
import { EngineEvent } from "./engine";
import { GasSettings, LoadedWallet, fetchNonces } from "./wallets";
import { OpenSeaError, RawMintTx, VerifyContext, requestMintTx, verifyAllowlistTx } from "./opensea";

/**
 * The speed statement, in one place, so the docs and the code cannot drift.
 * CAPABILITY.md and the README both render this verbatim.
 */
export const SPEED_STATEMENT =
  "A gated mint (allowlist / GTD / FCFS backed by an OpenSea signature) is slower " +
  "than a public mint and always will be. The signature is bound to one minter, " +
  "one quantity and one salt, and OpenSea does not issue it before the stage " +
  "opens — so one HTTP round trip is inside the race and cannot be moved out of " +
  "it. intern removes everything else: nonce, fees, balance check and TLS " +
  "handshakes are all completed before T-0, leaving request → verify → sign → " +
  "broadcast. A Merkle allow-list is the exception: its proof is computed " +
  "locally, so that path pre-signs exactly like a public mint and is as fast as one.";

/** How long before the stage opens the pre-arm work must be finished. */
export const PRE_ARM_LEAD_MS = 60_000;

// ── Notification deferral ───────────────────────────────────────────────────

/**
 * Holds events back while the hot path runs.
 *
 * Telegram's API is a network call with a tail measured in seconds. Making one
 * between the signature arriving and the transaction going out would spend the
 * race on a status message. So the window from "start polling" to "broadcast
 * returned" emits nothing; everything queues and flushes immediately after.
 *
 * Fire first, notify after. That ordering is the point of this class, and it is
 * enforced here rather than left as a rule people remember.
 */
export class DeferredEmitter {
  private buffered: EngineEvent[] = [];
  private hot = false;

  constructor(private readonly sink: (event: EngineEvent) => void) {}

  enterHotPath(): void {
    this.hot = true;
  }

  exitHotPath(): void {
    this.hot = false;
    this.flush();
  }

  emit(event: EngineEvent): void {
    if (this.hot) this.buffered.push(event);
    else this.sink(event);
  }

  flush(): void {
    const pending = this.buffered;
    this.buffered = [];
    for (const event of pending) this.sink(event);
  }

  get pendingCount(): number {
    return this.buffered.length;
  }

  get isHot(): boolean {
    return this.hot;
  }
}

// ── Poll scheduling ─────────────────────────────────────────────────────────

/** Floor on the poll interval. Below this, OpenSea rate-limits rather than answers. */
export const MIN_POLL_MS = 100;
const MAX_BACKOFF_MS = 8_000;

export type PollAction =
  | { kind: "fire" }
  | { kind: "retry"; delayMs: number }
  | { kind: "stop"; reason: string };

/**
 * Exponential backoff, capped.
 *
 * Only applied to 429 and to transport failures. A 409 — "not open yet" — is the
 * expected answer for the whole pre-open window and must keep polling at the
 * base interval, because backing off there means arriving late to the open.
 */
export function backoffDelayMs(attempt: number, baseMs: number, capMs = MAX_BACKOFF_MS): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = baseMs * 2 ** Math.min(exponent, 20);
  return Math.min(capMs, Math.max(baseMs, Math.round(raw)));
}

/**
 * Spread the delay by ±25%.
 *
 * Several wallets polling one endpoint on the same interval arrive together and
 * look exactly like the burst a rate limiter is built to stop. Jitter costs a few
 * ms of expected latency and buys a materially lower chance of a 429 during the
 * one window where a 429 is expensive.
 */
export function withJitter(delayMs: number, rand: () => number = Math.random): number {
  const spread = delayMs * 0.25;
  return Math.max(0, Math.round(delayMs - spread + rand() * spread * 2));
}

/**
 * What to do about one poll outcome.
 *
 * `null` status means the payload arrived. The three terminal statuses are the
 * ones that will not fix themselves within a mint window: 401 (our key), 403
 * (this wallet is refused), 404 (no such drop). Everything else retries, because
 * everything else is either expected before the open or transient during it.
 */
export function planNextPoll(
  status: number | null,
  attempt: number,
  opts: { pollMs: number; retryAfterMs?: number | null; rand?: () => number },
): PollAction {
  if (status === null) return { kind: "fire" };

  const base = Math.max(MIN_POLL_MS, opts.pollMs);
  const rand = opts.rand ?? Math.random;

  switch (status) {
    case 401:
      return { kind: "stop", reason: "OpenSea rejected the API key (401). Polling cannot succeed." };
    case 403:
      return {
        kind: "stop",
        reason: "OpenSea refused this wallet (403) — it is not eligible for this stage.",
      };
    case 404:
      return { kind: "stop", reason: "OpenSea has no such drop (404). Polling cannot succeed." };
    case 429: {
      // Retry-After wins over our own backoff whenever it is longer. Racing it
      // just extends the limit.
      const ours = backoffDelayMs(attempt, base);
      const theirs = opts.retryAfterMs ?? 0;
      return { kind: "retry", delayMs: withJitter(Math.max(ours, theirs), rand) };
    }
    case 409:
    case 422:
      // The pre-open answers. Poll at the base rate — this is the window the
      // signature is expected to appear in, and slowing down here loses the race.
      return { kind: "retry", delayMs: withJitter(base, rand) };
    default:
      // 5xx, and status 0 for a transport failure. Back off; the endpoint is
      // unwell and hammering it does not help.
      return { kind: "retry", delayMs: withJitter(backoffDelayMs(attempt, base), rand) };
  }
}

// ── Pre-arm ─────────────────────────────────────────────────────────────────

export interface ArmedWallet {
  wallet: LoadedWallet;
  nonce: number;
}

export interface ArmedRace {
  wallets: ArmedWallet[];
  gas: GasSettings;
  chainId: number;
  armedAtMs: number;
}

export interface PreArmOptions {
  provider: JsonRpcProvider;
  chain: ChainProfile;
  wallets: LoadedWallet[];
  gas: GasSettings;
  /** RPC endpoints to open sockets to, plus the OpenSea origin. */
  warmUrls: string[];
  clock: CorrectedClock;
}

const OPENSEA_ORIGIN = "https://api.opensea.io";

/**
 * Do every slow thing now, so T-0 has none of it left.
 *
 * Warming is deliberately included: a cold TLS handshake to OpenSea is two round
 * trips before the request that matters even starts, and the same to each RPC
 * endpoint on the way out. Both are free to pay a minute early and expensive to
 * pay at T-0.
 */
export async function preArm(opts: PreArmOptions): Promise<ArmedRace> {
  const nonces = await fetchNonces(opts.provider, opts.wallets);

  const armed: ArmedWallet[] = opts.wallets.map((wallet, i) => {
    const nonce = nonces[i];
    if (nonce === undefined) {
      throw new Error(`Missing nonce for wallet ${wallet.index} (${wallet.address}).`);
    }
    return { wallet, nonce };
  });

  // Warming is best-effort: a refused pre-connect is not a reason to abort a
  // mint, only a reason to pay the handshake later.
  await warmConnections([...opts.warmUrls, OPENSEA_ORIGIN]).catch(() => undefined);

  return {
    wallets: armed,
    gas: opts.gas,
    chainId: opts.chain.chainId,
    armedAtMs: opts.clock.now(),
  };
}

/**
 * A serialisable snapshot of the armed state.
 *
 * Used by the crash-recovery state file and by any log line describing the arm.
 * It carries no key material and must never carry any — `LoadedWallet.key` is
 * deliberately not reachable from the returned shape, and a test asserts that the
 * JSON of a real arm contains nothing key-shaped.
 */
export function describeArm(armed: ArmedRace): {
  chainId: number;
  armedAtMs: number;
  gas: { maxFeePerGas: string; maxPriorityFeePerGas: string; gasLimit: string };
  wallets: { index: number; address: string; nonce: number }[];
} {
  return {
    chainId: armed.chainId,
    armedAtMs: armed.armedAtMs,
    gas: {
      maxFeePerGas: armed.gas.maxFeePerGas.toString(),
      maxPriorityFeePerGas: armed.gas.maxPriorityFeePerGas.toString(),
      gasLimit: armed.gas.gasLimit.toString(),
    },
    wallets: armed.wallets.map((a) => ({
      index: a.wallet.index,
      address: a.wallet.address,
      nonce: a.nonce,
    })),
  };
}

// ── The poll loop ───────────────────────────────────────────────────────────

export type PollResult =
  | { kind: "payload"; raw: RawMintTx; attempts: number }
  | { kind: "refused"; reason: string; attempts: number }
  | { kind: "timeout"; attempts: number };

export interface PollOptions {
  slug: string;
  apiKey: string;
  minter: string;
  quantity: number;
  pollMs: number;
  /** Corrected-clock instant to give up at. */
  deadlineMs: number;
  clock: CorrectedClock;
  rand?: () => number;
  signal?: AbortSignal;
  /** Injected in tests so the loop runs without real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so the loop runs without network. */
  request?: typeof requestMintTx;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask OpenSea for a signature until it gives one, refuses, or time runs out.
 *
 * Nothing is emitted from in here. The caller owns notification and does it after
 * the transaction is away — see DeferredEmitter.
 */
export async function pollForSignature(opts: PollOptions): Promise<PollResult> {
  const sleep = opts.sleep ?? realSleep;
  const send = opts.request ?? requestMintTx;
  let attempt = 0;

  for (;;) {
    if (opts.signal?.aborted) return { kind: "refused", reason: "Cancelled.", attempts: attempt };
    if (opts.clock.now() >= opts.deadlineMs) return { kind: "timeout", attempts: attempt };

    attempt += 1;
    let status: number | null = null;
    let retryAfterMs: number | null = null;
    let payload: RawMintTx | null = null;

    try {
      payload = await send(opts.slug, opts.apiKey, opts.minter, opts.quantity);
    } catch (err: unknown) {
      if (err instanceof OpenSeaError) {
        status = err.status;
        retryAfterMs = err.retryAfterMs;
      } else {
        // A non-OpenSeaError is a bug or a parse failure, not a transport blip.
        // Treated as a 500 so it backs off rather than spinning.
        status = 500;
      }
    }

    if (payload) return { kind: "payload", raw: payload, attempts: attempt };

    const action = planNextPoll(status, attempt, {
      pollMs: opts.pollMs,
      retryAfterMs,
      ...(opts.rand ? { rand: opts.rand } : {}),
    });
    if (action.kind === "stop") return { kind: "refused", reason: action.reason, attempts: attempt };
    if (action.kind === "fire") {
      // `status === null` with no payload — `requestMintTx` resolved to nothing
      // while promising a transaction. Unreachable while it honours its own
      // return type, and the `!` that used to stand here asserted exactly that:
      // the compiler has narrowed `payload` to `null` on this line, because the
      // truthy case returned three lines up.
      //
      // Reported as a refusal rather than handed back as `raw: null`, which the
      // caller would carry into the fire path and try to broadcast.
      return {
        kind: "refused",
        reason: "OpenSea returned neither a transaction nor an error.",
        attempts: attempt,
      };
    }

    // Never sleep past the deadline — waking up after it wastes the remainder.
    const remaining = opts.deadlineMs - opts.clock.now();
    if (remaining <= 0) return { kind: "timeout", attempts: attempt };
    await sleep(Math.min(action.delayMs, remaining));
  }
}

// ── Fire ────────────────────────────────────────────────────────────────────

export interface FireOptions {
  armed: ArmedWallet;
  /** The raw response from OpenSea. Verified here before it is ever signed. */
  payload: RawMintTx;
  chain: ChainProfile;
  gas: GasSettings;
  verify: VerifyContext;
  endpoints: Endpoint[];
}

export type FireResult =
  | { ok: true; txHash: string; endpoints: string[] }
  | { ok: false; error: string };

/**
 * Verify, sign and broadcast, with no avoidable await in between.
 *
 * The verify step is not optional and is not a formality: these bytes came from
 * an HTTP response and are about to be signed by the operator's key. They are
 * checked against the chain, contract, minter and quantity we already knew before
 * the signature was requested.
 *
 * The broadcast goes to every endpoint at once rather than in order. One slow
 * endpoint must not decide when the transaction reaches the mempool, and the
 * duplicates are rejected harmlessly as already-known.
 */
export async function fireSigned(opts: FireOptions): Promise<FireResult> {
  let raw: string;
  try {
    const verified = verifyAllowlistTx(opts.payload, opts.verify);
    raw = await new Wallet(opts.armed.wallet.key).signTransaction({
      to: verified.to,
      data: verified.data,
      value: verified.value,
      nonce: opts.armed.nonce,
      maxFeePerGas: opts.gas.maxFeePerGas,
      maxPriorityFeePerGas: opts.gas.maxPriorityFeePerGas,
      gasLimit: opts.gas.gasLimit,
      type: 2,
      chainId: opts.chain.chainId,
    });
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const prepared = prepare(raw);
  const handle = blast(prepared, opts.endpoints);
  const outcomes: BlastOutcome[] = await handle.outcomes;

  if (!wasAccepted(outcomes)) {
    const first = outcomes.find((o) => o.error !== null);
    return { ok: false, error: first?.error ?? "No endpoint accepted the transaction." };
  }
  return {
    ok: true,
    txHash: prepared.txHash,
    endpoints: outcomes.filter((o) => o.error === null).map((o) => o.label),
  };
}
