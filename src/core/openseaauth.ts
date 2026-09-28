// OpenSea wallet authentication: scoped token in, short-lived JWT out.
//
// OpenSea splits its v2 API into two kinds of endpoint, and they authenticate
// differently:
//
//   Application-scoped  — collections, drops, the mint builder. One `x-api-key`
//                         header identifies the integration. Nothing about these
//                         endpoints knows which wallet is asking.
//
//   Wallet-scoped       — `/drops/{slug}/eligibility`. Answers a question *about a
//                         wallet*, so it needs proof that the caller controls that
//                         wallet. That proof is a short-lived JWT, and the JWT is
//                         minted by exchanging a durable scoped token.
//
// The exchange is the part that is easy to get wrong, so it is worth stating the
// shape exactly. It was established against the live API, not from documentation:
//
//   POST /api/v2/auth/tokens/exchange
//   content-type: application/json
//   {"subjectToken": "<scoped token>", "subjectTokenType": "ACCESS_TOKEN"}
//
// The field is `subjectToken`. An earlier attempt used `token`, which the API
// accepts as a well-formed request and then rejects — so the failure looks like a
// bad credential rather than a bad field name, and the obvious next move is to
// regenerate a token that was never the problem. `subjectTokenType` is required
// alongside it.
//
// Note what is *not* sent: no `x-api-key`. The exchange was proven to work without
// one, and this call is the single place where a credential is the request body
// rather than a header, so it sends exactly what is known to work and nothing more.
//
// Three properties this module is responsible for:
//
//   The JWT never reaches disk. It lives in this object's memory and dies with the
//   process, which is the whole reason the durable credential is a separate thing:
//   .env holds the scoped token, and a restart re-exchanges rather than reusing a
//   token whose remaining lifetime nobody tracked.
//
//   Concurrent callers cause one exchange, not N. A scheduler with several armed
//   tasks polls eligibility from several places at once, and a token that has just
//   expired would otherwise produce a refresh per caller — a burst against an auth
//   endpoint, at the moment a rate limit is least affordable.
//
//   Nothing here is logged. Both credentials are registered with the redactor on
//   the way in, so even an error that quotes them is censored downstream.

import { OpenSeaError, openSeaRequest } from "./opensea";
import { registerSecret } from "./wallets";

/**
 * How long before true expiry a token is treated as spent.
 *
 * A token that is valid for another two seconds is not useful: the request it
 * would authorize takes longer than that to reach OpenSea, and a 401 at T-0 costs
 * a refresh round trip at exactly the wrong moment. Thirty seconds is comfortably
 * longer than any single request's latency and far shorter than the token's own
 * lifetime, so it never causes a needless exchange.
 */
export const DEFAULT_REFRESH_SKEW_MS = 30_000;

/**
 * Assumed lifetime when the response says nothing about expiry.
 *
 * Only reached when the JWT carries no `exp` claim *and* no `expires_in` field is
 * returned, which has not been observed but must not be a crash. Deliberately
 * short: a conservative guess costs one extra exchange, while an optimistic one
 * costs a 401 on the hot path.
 */
export const ASSUMED_LIFETIME_MS = 5 * 60_000;

export interface WalletToken {
  /** The bearer credential. Never log this, never persist it. */
  readonly token: string;
  /** Absolute expiry in epoch ms, from the JWT's own `exp` where available. */
  readonly expiresAtMs: number;
  /** True when {@link ASSUMED_LIFETIME_MS} was substituted for a stated expiry. */
  readonly expiryAssumed: boolean;
  readonly obtainedAtMs: number;
}

export interface OpenSeaAuthOptions {
  /** Identifies the integration. Sent as `x-api-key` on wallet-scoped calls. */
  apiKey: string;
  /** The durable credential from OpenSea developer settings. Exchanged, never sent. */
  scopedToken: string;
  /**
   * A wallet access token already issued to this wallet, used as-is.
   *
   * The exchange above is the intended route and stays the default. This exists
   * because OpenSea currently answers that endpoint with
   * `403 {"message": "Token exchange is not available"}` — identically for a
   * valid token, a nonsense token, and no API key at all, which is what rules
   * out the credentials being at fault. Its own 401 guidance on the eligibility
   * endpoint points elsewhere: "Get one by running `opensea login` or through
   * the OAuth 2.1 authorization-code flow with PKCE."
   *
   * So this is a second door to the same room, not a second architecture. The
   * token it takes is the very thing the exchange would have returned, and every
   * caller downstream is unchanged. When exchange comes back, unset this and the
   * primary path resumes with no other edit.
   *
   * Short-lived, so it is read from the environment at start and held in memory
   * like an exchanged one. It is registered as a secret on the same line.
   */
  walletToken?: string | null;
  now?: () => number;
  refreshSkewMs?: number;
}

/** The shape the exchange endpoint answers with, across the spellings seen. */
interface ExchangeResponse {
  access_token?: unknown;
  accessToken?: unknown;
  token?: unknown;
  expires_in?: unknown;
  expiresIn?: unknown;
  expires_at?: unknown;
  expiresAt?: unknown;
}

/**
 * Read the `exp` claim out of a JWT without verifying it.
 *
 * Verification would need OpenSea's signing key and would answer a question we are
 * not asking. The claim is used for one purpose — deciding when to refresh — and
 * for that purpose a forged `exp` is harmless: too early wastes an exchange, too
 * late produces a 401 that {@link OpenSeaAuthManager.withAuth} already recovers
 * from. What matters is that a malformed token cannot throw here, because that
 * would turn a soft auth problem into a crashed task.
 */
export function readJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined || payload === "") return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const claims = JSON.parse(json) as { exp?: unknown };
    const exp = claims.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
    // `exp` is seconds since the epoch, per RFC 7519.
    return Math.round(exp * 1000);
  } catch {
    return null;
  }
}

/** Pull the credential out of a response, accepting the spellings seen in the wild. */
function tokenFrom(body: ExchangeResponse): string | null {
  for (const candidate of [body.access_token, body.accessToken, body.token]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

/** An absolute expiry from the response body, when it states one. */
function statedExpiryMs(body: ExchangeResponse, nowMs: number): number | null {
  for (const candidate of [body.expires_in, body.expiresIn]) {
    const seconds = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      return nowMs + Math.round(seconds * 1000);
    }
  }
  for (const candidate of [body.expires_at, body.expiresAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      // Seconds or milliseconds, distinguished by magnitude: anything below the
      // year-2001 boundary in ms must have been seconds.
      return candidate < 1e12 ? Math.round(candidate * 1000) : Math.round(candidate);
    }
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Raised when the scoped token cannot be turned into a wallet JWT.
 *
 * Separate from {@link OpenSeaError} so callers can tell "this credential is
 * wrong" from "this request failed". The distinction drives behaviour: a bad
 * credential must stop a task and tell the operator, whereas a failed request
 * should be retried.
 */
export class OpenSeaAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    /** False for a 401/403 on the exchange itself: retrying cannot help. */
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "OpenSeaAuthError";
  }
}

/**
 * Holds the wallet JWT, refreshes it, and hands out authorized headers.
 *
 * One instance per process. It is constructed from configuration at startup and
 * shared, because the deduplication it provides is only meaningful if every
 * caller goes through the same object.
 */
export class OpenSeaAuthManager {
  private readonly apiKey: string;
  private readonly scopedToken: string;
  private readonly walletToken: string | null;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;

  private cached: WalletToken | null = null;

  /**
   * The exchange currently in flight, shared by every caller that wants a token.
   *
   * This is the whole deduplication mechanism. A second caller arriving mid-flight
   * awaits the same promise instead of starting its own request, so N armed tasks
   * hitting an expired token produce one exchange between them.
   */
  private inFlight: Promise<WalletToken> | null = null;

  /** Exchanges performed, for the diagnostics panel. Never includes a token. */
  private exchanges = 0;
  private lastError: string | null = null;

  constructor(opts: OpenSeaAuthOptions) {
    this.apiKey = opts.apiKey.trim();
    this.scopedToken = opts.scopedToken.trim();
    this.now = opts.now ?? Date.now;
    this.refreshSkewMs = Math.max(0, opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS);

    this.walletToken = opts.walletToken?.trim() ? opts.walletToken.trim() : null;

    if (this.apiKey === "") throw new OpenSeaAuthError("OPENSEA_API_KEY is empty.");
    // One of the two is required, not both: a supplied wallet token makes the
    // exchange — and therefore the scoped token — unnecessary.
    if (this.scopedToken === "" && this.walletToken === null) {
      throw new OpenSeaAuthError(
        "Set OPENSEA_SCOPED_TOKEN or OPENSEA_WALLET_TOKEN; both are empty.",
      );
    }

    // Registered before any request can fail with them in the message. An empty
    // string is never registered: it would match everywhere and redact nothing
    // while making every log line look scrubbed.
    registerSecret(this.apiKey);
    if (this.scopedToken !== "") registerSecret(this.scopedToken);
    if (this.walletToken !== null) registerSecret(this.walletToken);
  }

  /** Is the cached token still usable, allowing for the refresh skew? */
  private fresh(token: WalletToken | null): token is WalletToken {
    if (token === null) return false;
    return this.now() + this.refreshSkewMs < token.expiresAtMs;
  }

  /**
   * A valid wallet JWT, exchanging or refreshing only when one is actually needed.
   *
   * `force` discards the cache first. It exists for the 401 path: OpenSea is
   * entitled to reject a token we believe is valid — a revoked scoped token, a
   * clock disagreement, a server-side invalidation — and in that case the cached
   * copy is known-bad regardless of what its `exp` claims.
   */
  async token(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<WalletToken> {
    if (opts.force === true) this.cached = null;
    const cached = this.cached;
    if (this.fresh(cached)) return cached;

    // Join the in-flight exchange rather than starting a second one.
    const existing = this.inFlight;
    if (existing !== null) return existing;

    const attempt = this.exchange(opts.signal)
      .then((token) => {
        this.cached = token;
        this.lastError = null;
        return token;
      })
      .finally(() => {
        // Cleared before the caller's `.then` runs, so a caller that immediately
        // asks again sees the cache rather than a settled in-flight promise.
        this.inFlight = null;
      });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * Perform the exchange.
   *
   * Every failure is translated into an {@link OpenSeaAuthError} carrying whether
   * a retry could conceivably help, because the caller's correct behaviour differs
   * completely between the two and the HTTP status is the only thing that knows.
   */
  private async exchange(signal?: AbortSignal): Promise<WalletToken> {
    const startedAt = this.now();

    // Already holding what the exchange would have produced. Its expiry is read
    // the same way and it refreshes the same way — which, for a token nobody can
    // re-issue without the operator, means it expires and says so rather than
    // silently going stale.
    if (this.walletToken !== null) {
      const claimed = readJwtExpiryMs(this.walletToken);
      if (claimed !== null && claimed <= startedAt) {
        this.lastError = "the supplied wallet token has expired";
        throw new OpenSeaAuthError(
          "OPENSEA_WALLET_TOKEN has expired. Wallet access tokens are short-lived; " +
            "issue a new one, or unset it to use the scoped-token exchange.",
          null,
          false,
        );
      }
      return {
        token: this.walletToken,
        expiresAtMs: claimed ?? startedAt + ASSUMED_LIFETIME_MS,
        expiryAssumed: claimed === null,
        obtainedAtMs: startedAt,
      };
    }

    let body: ExchangeResponse;
    try {
      body = await openSeaRequest<ExchangeResponse>("/auth/tokens/exchange", {
        body: { subjectToken: this.scopedToken, subjectTokenType: "ACCESS_TOKEN" },
        ...(signal ? { signal } : {}),
      });
      this.exchanges += 1;
    } catch (err: unknown) {
      if (err instanceof OpenSeaError) {
        // 401/403 here is a verdict on the scoped token itself. Retrying burns
        // rate limit to be told the same thing, so the operator is told instead.
        const fatal = err.status === 401 || err.status === 403 || err.status === 400;
        // A 403 saying the exchange is unavailable is not a verdict on the token.
        // Reporting it as one sends the operator off to regenerate a credential
        // that was never the problem — the same wasted afternoon this file's
        // header describes for the `token` / `subjectToken` mix-up, arrived at
        // from the other direction.
        const unavailable = /token exchange is not available/i.test(err.message);
        const detail = unavailable
          ? "OpenSea has disabled the token exchange endpoint (403 \"Token exchange is not " +
            "available\"). This is not a problem with OPENSEA_SCOPED_TOKEN — the endpoint " +
            "answers the same way with no credentials at all. Supply OPENSEA_WALLET_TOKEN " +
            "with a wallet access token carrying the read:eligibility scope instead."
          : fatal
            ? "OpenSea rejected the scoped token. Check OPENSEA_SCOPED_TOKEN is current " +
              "and carries the read:eligibility scope."
            : err.message;
        this.lastError = detail;
        throw new OpenSeaAuthError(
          `Could not exchange the scoped token for a wallet JWT: ${detail}`,
          err.status,
          !fatal,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      throw new OpenSeaAuthError(`Could not exchange the scoped token: ${message}`, null, true);
    }

    const token = tokenFrom(body);
    if (token === null) {
      this.lastError = "exchange response carried no access token";
      throw new OpenSeaAuthError(
        "OpenSea's token exchange returned no access token. The response shape may have " +
          "changed; intern accepts access_token, accessToken and token.",
        null,
        false,
      );
    }
    registerSecret(token);

    // The JWT's own claim wins over the envelope: it is what OpenSea will actually
    // enforce, and the two can disagree when a response is cached or a clock drifts.
    const fromClaim = readJwtExpiryMs(token);
    const fromBody = statedExpiryMs(body, startedAt);
    const expiresAtMs = fromClaim ?? fromBody ?? startedAt + ASSUMED_LIFETIME_MS;

    return {
      token,
      expiresAtMs,
      expiryAssumed: fromClaim === null && fromBody === null,
      obtainedAtMs: startedAt,
    };
  }

  /** Discard the cached token. The next call exchanges again. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Run one wallet-scoped request, refreshing once if the token is rejected.
   *
   * The retry is the reason this is a method rather than a pair of helpers. A JWT
   * can expire between the freshness check and the request reaching OpenSea, and
   * on a poll loop near T-0 that window is hit often enough to matter. Retrying
   * once on 401 turns that into a hiccup; leaving it to the caller turns it into a
   * failed task, and leaving it to an unbounded retry turns a revoked credential
   * into an infinite loop — so it is exactly once.
   */
  async withAuth<T>(
    call: (headers: { apiKey: string; bearer: string }) => Promise<T>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const first = await this.token(opts.signal ? { signal: opts.signal } : {});
    try {
      return await call({ apiKey: this.apiKey, bearer: first.token });
    } catch (err: unknown) {
      if (!(err instanceof OpenSeaError) || err.status !== 401) throw err;
      const refreshed = await this.token({
        force: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      return call({ apiKey: this.apiKey, bearer: refreshed.token });
    }
  }

  /**
   * What the operator is allowed to see about the auth state.
   *
   * Everything here is a fact *about* the credentials and none of it is a
   * credential: no token, no prefix, no length. A "show me the first six
   * characters" affordance is how a credential ends up in a screenshot.
   */
  status(): {
    hasToken: boolean;
    expiresAtMs: number | null;
    expiresInMs: number | null;
    expiryAssumed: boolean;
    exchanges: number;
    lastError: string | null;
  } {
    const cached = this.cached;
    return {
      hasToken: this.fresh(cached),
      expiresAtMs: cached?.expiresAtMs ?? null,
      expiresInMs: cached === null ? null : cached.expiresAtMs - this.now(),
      expiryAssumed: cached?.expiryAssumed ?? false,
      exchanges: this.exchanges,
      lastError: this.lastError,
    };
  }
}

/**
 * Build an auth manager from configuration, or explain what is missing.
 *
 * Returns null rather than throwing when the credentials are absent: wallet-scoped
 * eligibility is an enhancement, and a public mint needs neither credential. The
 * reason comes back with the null so the operator is told why the feature is off
 * instead of finding it silently missing.
 */
export function authManagerFrom(opts: {
  apiKey: string | null;
  scopedToken: string | null;
  /** A wallet access token already issued, used instead of the exchange. */
  walletToken?: string | null;
  now?: () => number;
}): { manager: OpenSeaAuthManager | null; reason: string | null } {
  if (opts.apiKey === null || opts.apiKey.trim() === "") {
    return { manager: null, reason: "OPENSEA_API_KEY is not set" };
  }
  const wallet = opts.walletToken?.trim() ?? "";
  const scoped = opts.scopedToken?.trim() ?? "";
  // Either credential is enough. Naming both in the reason matters because the
  // exchange route is currently refused by OpenSea, and an operator told only to
  // set OPENSEA_SCOPED_TOKEN would set it and still get nothing.
  if (wallet === "" && scoped === "") {
    return {
      manager: null,
      reason: "neither OPENSEA_SCOPED_TOKEN nor OPENSEA_WALLET_TOKEN is set",
    };
  }
  try {
    return {
      manager: new OpenSeaAuthManager({
        apiKey: opts.apiKey,
        scopedToken: scoped,
        ...(wallet !== "" ? { walletToken: wallet } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      }),
      reason: null,
    };
  } catch (err: unknown) {
    return { manager: null, reason: err instanceof Error ? err.message : String(err) };
  }
}
