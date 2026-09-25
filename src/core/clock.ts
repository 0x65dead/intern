// Clock offset measurement.
//
// The single largest avoidable source of lost mints is a wrong local clock. A
// machine 400ms slow fires 400ms late; a machine 400ms fast fires before the
// stage opens and reverts with NotActive. Neither shows up in any log — the
// transaction simply loses or reverts, and it looks like bad luck.
//
// Two independent references, because they fail differently:
//
//   HTTP `Date` header — one-second granularity, but every RPC provider serves
//   one, so it always exists. Useless alone for sub-second work.
//
//   Chain head timestamp — the block's own `timestamp` field with the observed
//   arrival time of a fresh block. Millisecond-meaningful on fast chains, and it
//   measures the clock the *contract* uses, which is the one that matters.
//
// Both are sampled several times and the minimum-RTT sample wins: network delay
// is strictly additive, so the fastest round trip carries the least error. This
// is the same reason NTP prefers low-delay samples.

export interface ClockSample {
  /** ms to add to Date.now() to get true time. Positive = local clock is slow. */
  offsetMs: number;
  /** Round-trip time of the sample this offset came from. */
  rttMs: number;
  source: string;
}

export interface ClockSync {
  offsetMs: number;
  /** Half the best RTT — the irreducible uncertainty in the offset. */
  uncertaintyMs: number;
  samples: ClockSample[];
  /** True when at least one sample succeeded. Otherwise offsetMs is 0. */
  synced: boolean;
}

const HTTP_DATE_GRANULARITY_MS = 1000;

/**
 * Sample a server's `Date` header. The header is truncated to the second, so the
 * true server time lies somewhere in [date, date+1000). We take the midpoint,
 * which bounds the error at ±500ms — enough to catch a badly wrong clock, not
 * enough to trust for T-0 firing on its own.
 */
async function sampleHttpDate(url: string, timeoutMs: number): Promise<ClockSample | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sentAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      signal: controller.signal,
    });
    const receivedAt = Date.now();
    const header = res.headers.get("date");
    // Drain so the socket returns to the pool rather than being torn down.
    void res.text().catch(() => {});
    if (!header) return null;
    const serverSec = Date.parse(header);
    if (!Number.isFinite(serverSec)) return null;

    const rttMs = receivedAt - sentAt;
    // Server time when it wrote the header, corrected for one-way delay.
    const serverAtResponse = serverSec + HTTP_DATE_GRANULARITY_MS / 2;
    const localAtResponse = sentAt + rttMs / 2;
    return {
      offsetMs: serverAtResponse - localAtResponse,
      rttMs,
      source: `http-date ${hostOf(url)}`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sample the chain head. `timestamp` is the block's consensus time in seconds,
 * so a block observed shortly after production gives a tight bound on how far
 * local time has drifted from the time the contract will compare against.
 *
 * Only meaningful within one block time of production, so this is called
 * repeatedly and the freshest, lowest-RTT observation is what survives.
 */
async function sampleChainHead(
  url: string,
  blockTimeSec: number,
  timeoutMs: number,
): Promise<ClockSample | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sentAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getBlockByNumber",
        params: ["latest", false],
        id: 1,
      }),
      signal: controller.signal,
    });
    const receivedAt = Date.now();
    const json = (await res.json()) as { result?: { timestamp?: string } };
    const raw = json.result?.timestamp;
    if (typeof raw !== "string") return null;
    const blockSec = parseInt(raw, 16);
    if (!Number.isFinite(blockSec)) return null;

    const rttMs = receivedAt - sentAt;
    const localAtResponse = sentAt + rttMs / 2;
    const blockMs = blockSec * 1000;

    // The block was produced somewhere in the last block interval. Its age is
    // unknown within that window, so assume the expected half-interval. This is
    // a bias, not noise: it does not average out, which is why the HTTP samples
    // stay in the mix as an independent check.
    const assumedAgeMs = (blockTimeSec * 1000) / 2;
    const trueTimeAtResponse = blockMs + assumedAgeMs;

    const offsetMs = trueTimeAtResponse - localAtResponse;
    // Reject nonsense: a stale archive node or a chain with irregular blocks.
    if (Math.abs(offsetMs) > 5 * 60 * 1000) return null;

    return { offsetMs, rttMs, source: `chain-head ${hostOf(url)}` };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Measure the local clock's error against the network.
 *
 * `rounds` sequential passes over every endpoint. Sequential rather than
 * all-at-once because concurrent requests inflate each other's RTT, and RTT is
 * the quality signal being sorted on.
 */
export async function syncClock(
  rpcUrls: string[],
  blockTimeSec: number,
  opts: { rounds?: number; timeoutMs?: number } = {},
): Promise<ClockSync> {
  const rounds = opts.rounds ?? 3;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const probe = rpcUrls.slice(0, 3); // more endpoints adds noise, not accuracy
  const samples: ClockSample[] = [];

  for (let round = 0; round < rounds; round++) {
    for (const url of probe) {
      const [head, http] = await Promise.all([
        sampleChainHead(url, blockTimeSec, timeoutMs),
        sampleHttpDate(url, timeoutMs),
      ]);
      if (head) samples.push(head);
      if (http) samples.push(http);
    }
  }

  if (samples.length === 0) {
    return { offsetMs: 0, uncertaintyMs: Infinity, samples: [], synced: false };
  }

  // Chain-head samples measure the clock the contract uses, so they decide the
  // offset when available. HTTP samples are the fallback and the sanity check.
  const heads = samples.filter((s) => s.source.startsWith("chain-head"));
  const chosen = heads.length > 0 ? heads : samples;
  const best = chosen.reduce((a, b) => (a.rttMs <= b.rttMs ? a : b));

  return {
    offsetMs: Math.round(best.offsetMs),
    uncertaintyMs: Math.round(best.rttMs / 2),
    samples,
    synced: true,
  };
}

/** A clock that reports corrected time. Cheap to call in a tight loop. */
export class CorrectedClock {
  constructor(private offsetMs: number = 0) {}

  now(): number {
    return Date.now() + this.offsetMs;
  }

  get offset(): number {
    return this.offsetMs;
  }

  applySync(sync: ClockSync): void {
    if (sync.synced) this.offsetMs = sync.offsetMs;
  }
}

// ── The unattended drift guard ──────────────────────────────────────────────

export interface DriftVerdict {
  ok: boolean;
  /** Always populated, for both verdicts — the log line says what was measured. */
  detail: string;
}

/**
 * Should an unattended run be allowed to fire?
 *
 * The metric is *uncertainty*, not offset, and the distinction matters enough to
 * be explicit about. A local clock 400ms slow is harmless once measured: the
 * correction is applied and T-0 is hit exactly. Measuring it is the whole reason
 * syncClock exists. What is not harmless is not knowing where T-0 is to within
 * the limit — that is `uncertaintyMs`, half the best round trip, and it is the
 * number that bounds how late or early the transaction can land.
 *
 * So a large corrected offset passes, with the magnitude stated. A large
 * uncertainty fails, and a failed sync fails hardest: with no measurement at all
 * intern is firing against an unvalidated clock, which is a risk a person at a
 * terminal can accept and an unattended daemon cannot.
 */
export function driftGuard(sync: ClockSync, limitMs: number): DriftVerdict {
  if (!sync.synced) {
    return {
      ok: false,
      detail:
        "Clock offset could not be measured — every time source failed. An " +
        "unattended run will not fire against an unvalidated clock; a run you are " +
        "watching still can.",
    };
  }
  if (sync.uncertaintyMs > limitMs) {
    return {
      ok: false,
      detail:
        `Clock uncertainty is ±${sync.uncertaintyMs}ms, beyond the ${limitMs}ms limit. ` +
        `T-0 cannot be placed accurately enough to fire. Raise CLOCK_DRIFT_LIMIT_MS ` +
        `to accept this, or use a closer time source.`,
    };
  }
  const sign = sync.offsetMs >= 0 ? "+" : "";
  return {
    ok: true,
    detail:
      `Clock measured: offset ${sign}${sync.offsetMs}ms, uncertainty ±${sync.uncertaintyMs}ms ` +
      `(limit ${limitMs}ms). The offset is corrected for, so its size is not itself a problem.`,
  };
}
