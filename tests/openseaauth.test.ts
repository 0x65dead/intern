// The OpenSea auth chain, asserted at the wire.
//
// The exchange request shape is the reason this file is detailed out of
// proportion to the module's size. The field is `subjectToken`; an earlier
// attempt sent `token`, and OpenSea's response to that is not "unknown field" —
// it is a 401, indistinguishable from a bad credential. So the failure pointed at
// the token and the fix looked like "generate a new one", which never worked
// because the token was never the problem. A test that reads the bytes handed to
// fetch is the only thing that keeps that from recurring.
//
// The other property worth testing this hard is refresh deduplication. It is
// invisible when it breaks: everything still works, there are simply N auth
// requests where there should be one, and the only symptom is a 429 during the
// one minute of the day that a 429 cannot be afforded.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  ASSUMED_LIFETIME_MS,
  DEFAULT_REFRESH_SKEW_MS,
  OpenSeaAuthError,
  OpenSeaAuthManager,
  authManagerFrom,
  readJwtExpiryMs,
} from "../src/core/openseaauth";
import { OpenSeaError } from "../src/core/opensea";
import { redactKeys } from "../src/core/wallets";

const API_KEY = "test-api-key-abcdef0123456789";
const PAT = "os_pat_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
const NOW = 1_773_576_000_000;

const b64 = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A structurally real JWT — decodable header and payload, meaningless signature. */
function jwt(claims: Record<string, unknown> = {}): string {
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.${"s".repeat(24)}`;
}

interface Capture {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: string;
}

const realFetch = globalThis.fetch;

/** Answer every exchange with `bodies` in turn, recording each request. */
function stubFetch(
  responses: { status?: number; json?: unknown; delayMs?: number }[],
): Capture[] {
  const calls: Capture[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === "string" ? init.body : "",
      redirect: String(init?.redirect ?? ""),
    });
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (spec?.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
    }
    return new Response(JSON.stringify(spec?.json ?? {}), {
      status: spec?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return calls;
}

function manager(opts: { now?: () => number; refreshSkewMs?: number } = {}): OpenSeaAuthManager {
  return new OpenSeaAuthManager({
    apiKey: API_KEY,
    scopedToken: PAT,
    now: opts.now ?? (() => NOW),
    ...(opts.refreshSkewMs !== undefined ? { refreshSkewMs: opts.refreshSkewMs } : {}),
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("readJwtExpiryMs", () => {
  it("reads the exp claim as seconds and returns milliseconds", () => {
    assert.equal(readJwtExpiryMs(jwt({ exp: 1_773_576_900 })), 1_773_576_900_000);
  });

  it("returns null rather than throwing for anything malformed", () => {
    for (const bad of [
      "",
      "not-a-jwt",
      "only.two",
      "a.b.c.d",
      `${b64({})}.!!!not-base64!!!.sig`,
      jwt({}),
      jwt({ exp: "soon" }),
      jwt({ exp: 0 }),
      jwt({ exp: -5 }),
    ]) {
      assert.equal(readJwtExpiryMs(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("OpenSeaAuthManager — the exchange request", () => {
  it("POSTs the scoped token as subjectToken, the field name that works", async () => {
    const calls = stubFetch([{ json: { access_token: jwt({ exp: NOW / 1000 + 600 }) } }]);
    await manager().token();

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.method, "POST");
    assert.equal(call.url, "https://api.opensea.io/api/v2/auth/tokens/exchange");

    const body = JSON.parse(call.body) as Record<string, unknown>;
    assert.equal(body.subjectToken, PAT);
    // The bug this pins: `token` is accepted as well-formed and then rejected,
    // so the wrong field name is indistinguishable from a bad credential.
    assert.ok(!("token" in body), "must not send the token under the key `token`");
  });

  it("declares subjectTokenType, which the endpoint requires", async () => {
    const calls = stubFetch([{ json: { access_token: jwt({ exp: NOW / 1000 + 600 }) } }]);
    await manager().token();
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    assert.equal(body.subjectTokenType, "ACCESS_TOKEN");
  });

  it("sends no api key on the exchange, which is proven to work without one", async () => {
    const calls = stubFetch([{ json: { access_token: jwt({ exp: NOW / 1000 + 600 }) } }]);
    await manager().token();
    const headers = calls[0]!.headers;
    assert.ok(!("x-api-key" in headers), "the exchange must not carry x-api-key");
    assert.ok(!("authorization" in headers), "the exchange must not carry a bearer");
    assert.equal(headers["content-type"], "application/json");
  });

  it("refuses to follow a redirect, which would forward the token off-host", async () => {
    const calls = stubFetch([{ json: { access_token: jwt({ exp: NOW / 1000 + 600 }) } }]);
    await manager().token();
    assert.equal(calls[0]!.redirect, "error");
  });
});

describe("OpenSeaAuthManager — caching and expiry", () => {
  it("reuses a live token instead of exchanging again", async () => {
    const calls = stubFetch([{ json: { access_token: jwt({ exp: NOW / 1000 + 600 }) } }]);
    const auth = manager();
    const first = await auth.token();
    const second = await auth.token();

    assert.equal(calls.length, 1);
    assert.equal(first.token, second.token);
    assert.equal(auth.status().exchanges, 1);
  });

  it("exchanges again once the token has expired", async () => {
    let clock = NOW;
    const calls = stubFetch([
      { json: { access_token: jwt({ exp: NOW / 1000 + 60, jti: "first" }) } },
      { json: { access_token: jwt({ exp: NOW / 1000 + 6000, jti: "second" }) } },
    ]);
    const auth = manager({ now: () => clock });

    const first = await auth.token();
    clock = NOW + 120_000;
    const second = await auth.token();

    assert.equal(calls.length, 2);
    assert.notEqual(first.token, second.token);
  });

  it("refreshes inside the skew window, before true expiry", async () => {
    let clock = NOW;
    const expSeconds = NOW / 1000 + 600;
    const calls = stubFetch([
      { json: { access_token: jwt({ exp: expSeconds, jti: "a" }) } },
      { json: { access_token: jwt({ exp: expSeconds + 600, jti: "b" }) } },
    ]);
    const auth = manager({ now: () => clock });
    await auth.token();

    // Still valid, but only just — inside the skew, so it counts as spent.
    clock = expSeconds * 1000 - (DEFAULT_REFRESH_SKEW_MS - 1_000);
    await auth.token();
    assert.equal(calls.length, 2, "a token expiring within the skew must be replaced");
  });

  it("keeps a token that expires just beyond the skew", async () => {
    let clock = NOW;
    const expSeconds = NOW / 1000 + 600;
    const calls = stubFetch([{ json: { access_token: jwt({ exp: expSeconds }) } }]);
    const auth = manager({ now: () => clock });
    await auth.token();

    clock = expSeconds * 1000 - (DEFAULT_REFRESH_SKEW_MS + 1_000);
    await auth.token();
    assert.equal(calls.length, 1);
  });

  it("prefers the JWT's own exp over the envelope's expires_in", async () => {
    stubFetch([
      { json: { access_token: jwt({ exp: NOW / 1000 + 600 }), expires_in: 30 } },
    ]);
    const token = await manager().token();
    // The claim is what OpenSea enforces; the envelope can disagree after a cache
    // or a clock skew, and trusting the shorter value would refresh needlessly.
    assert.equal(token.expiresAtMs, NOW + 600_000);
    assert.equal(token.expiryAssumed, false);
  });

  it("falls back to expires_in when the token carries no exp", async () => {
    stubFetch([{ json: { access_token: jwt({ sub: "wallet" }), expires_in: 900 } }]);
    const token = await manager().token();
    assert.equal(token.expiresAtMs, NOW + 900_000);
    assert.equal(token.expiryAssumed, false);
  });

  it("assumes a short lifetime when nothing states one, and says it assumed", async () => {
    stubFetch([{ json: { access_token: "opaque-not-a-jwt" } }]);
    const token = await manager().token();
    assert.equal(token.expiresAtMs, NOW + ASSUMED_LIFETIME_MS);
    assert.equal(token.expiryAssumed, true, "an assumed expiry must be flagged as assumed");
  });

  it("accepts the response spellings the endpoint has used", async () => {
    for (const key of ["access_token", "accessToken", "token"]) {
      const value = jwt({ exp: NOW / 1000 + 600 });
      stubFetch([{ json: { [key]: value } }]);
      const token = await manager().token();
      assert.equal(token.token, value, `expected the ${key} spelling to be read`);
    }
  });

  it("forgets the cached token when invalidated", async () => {
    const calls = stubFetch([
      { json: { access_token: jwt({ exp: NOW / 1000 + 600, jti: "a" }) } },
      { json: { access_token: jwt({ exp: NOW / 1000 + 600, jti: "b" }) } },
    ]);
    const auth = manager();
    await auth.token();
    auth.invalidate();
    await auth.token();
    assert.equal(calls.length, 2);
  });
});

describe("OpenSeaAuthManager — concurrent refresh", () => {
  it("collapses simultaneous callers onto one exchange", async () => {
    const calls = stubFetch([
      { json: { access_token: jwt({ exp: NOW / 1000 + 600 }) }, delayMs: 10 },
    ]);
    const auth = manager();

    const tokens = await Promise.all(Array.from({ length: 8 }, () => auth.token()));

    // The property: eight armed tasks wanting a token produce one auth request.
    assert.equal(calls.length, 1, "concurrent callers must not each start an exchange");
    assert.equal(new Set(tokens.map((t) => t.token)).size, 1);
    assert.equal(auth.status().exchanges, 1);
  });

  it("collapses callers that arrive across microtasks, not just in one tick", async () => {
    const calls = stubFetch([
      { json: { access_token: jwt({ exp: NOW / 1000 + 600 }) }, delayMs: 20 },
    ]);
    const auth = manager();

    const first = auth.token();
    await Promise.resolve();
    await Promise.resolve();
    const second = auth.token();
    await Promise.all([first, second]);

    assert.equal(calls.length, 1);
  });

  it("lets the next caller exchange after an in-flight attempt fails", async () => {
    let attempt = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      attempt += 1;
      if (attempt === 1) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ access_token: jwt({ exp: NOW / 1000 + 600 }) }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    const auth = manager();
    await assert.rejects(() => auth.token(), OpenSeaAuthError);
    // A failed attempt must not leave a poisoned in-flight promise behind.
    const token = await auth.token();
    assert.ok(token.token.length > 0);
    assert.equal(attempt, 2);
  });
});

describe("OpenSeaAuthManager — withAuth and the 401 path", () => {
  it("supplies both credentials to the call", async () => {
    stubFetch([{ json: { access_token: jwt({ exp: NOW / 1000 + 600 }) } }]);
    const auth = manager();
    const seen = await auth.withAuth(async (headers) => headers);
    assert.equal(seen.apiKey, API_KEY);
    assert.ok(seen.bearer.startsWith("eyJ"));
  });

  it("refreshes and retries once when the call is rejected as unauthorised", async () => {
    const calls = stubFetch([
      { json: { access_token: jwt({ exp: NOW / 1000 + 600, jti: "stale" }) } },
      { json: { access_token: jwt({ exp: NOW / 1000 + 600, jti: "fresh" }) } },
    ]);
    const auth = manager();

    const bearers: string[] = [];
    const result = await auth.withAuth(async (headers) => {
      bearers.push(headers.bearer);
      if (bearers.length === 1) throw new OpenSeaError(401, "unauthorised");
      return "ok";
    });

    assert.equal(result, "ok");
    assert.equal(calls.length, 2, "the 401 must trigger exactly one re-exchange");
    assert.notEqual(bearers[0], bearers[1], "the retry must use the refreshed token");
  });

  it("gives up after one retry rather than looping on a revoked credential", async () => {
    stubFetch([{ json: { access_token: jwt({ exp: NOW / 1000 + 600 }) } }]);
    const auth = manager();
    let attempts = 0;

    await assert.rejects(
      () =>
        auth.withAuth(async () => {
          attempts += 1;
          throw new OpenSeaError(401, "unauthorised");
        }),
      OpenSeaError,
    );
    assert.equal(attempts, 2, "one original attempt plus one retry, then stop");
  });

  it("does not retry a status that a new token cannot fix", async () => {
    stubFetch([{ json: { access_token: jwt({ exp: NOW / 1000 + 600 }) } }]);
    const auth = manager();
    let attempts = 0;

    await assert.rejects(
      () =>
        auth.withAuth(async () => {
          attempts += 1;
          throw new OpenSeaError(403, "forbidden");
        }),
      OpenSeaError,
    );
    assert.equal(attempts, 1, "403 is a scope problem — refreshing changes nothing");
  });
});

describe("OpenSeaAuthManager — failure reporting", () => {
  it("names the scoped token, not the API key, when the exchange is refused", async () => {
    for (const status of [400, 401, 403]) {
      stubFetch([{ status, json: { error: "nope" } }]);
      const auth = manager();
      const err = await auth.token().then(
        () => null,
        (e: unknown) => e as OpenSeaAuthError,
      );
      assert.ok(err instanceof OpenSeaAuthError);
      assert.match(err.message, /OPENSEA_SCOPED_TOKEN/);
      assert.match(err.message, /read:eligibility/);
      assert.equal(err.retryable, false, `HTTP ${status} on the exchange is not retryable`);
    }
  });

  it("marks a server-side failure retryable", async () => {
    stubFetch([{ status: 503, json: {} }]);
    const err = await manager()
      .token()
      .then(
        () => null,
        (e: unknown) => e as OpenSeaAuthError,
      );
    assert.ok(err instanceof OpenSeaAuthError);
    assert.equal(err.retryable, true);
  });

  it("explains a response that carries no token", async () => {
    stubFetch([{ json: { something_else: true } }]);
    const err = await manager()
      .token()
      .then(
        () => null,
        (e: unknown) => e as OpenSeaAuthError,
      );
    assert.ok(err instanceof OpenSeaAuthError);
    assert.match(err.message, /no access token/i);
    assert.equal(err.retryable, false);
  });

  it("refuses to construct without credentials", () => {
    assert.throws(
      () => new OpenSeaAuthManager({ apiKey: "  ", scopedToken: PAT }),
      /OPENSEA_API_KEY is empty/,
    );
    assert.throws(
      () => new OpenSeaAuthManager({ apiKey: API_KEY, scopedToken: "" }),
      /OPENSEA_SCOPED_TOKEN or OPENSEA_WALLET_TOKEN/,
    );
  });

  it("constructs on a wallet token alone, with no scoped token to exchange", () => {
    // The scoped token only exists to be exchanged, and OpenSea currently
    // refuses the exchange. Demanding it anyway would gate the feature on a
    // credential that provably cannot be used for anything.
    assert.doesNotThrow(
      () => new OpenSeaAuthManager({ apiKey: API_KEY, scopedToken: "", walletToken: "wt-abc" }),
    );
  });
});

describe("OpenSeaAuthManager — secrecy", () => {
  it("registers both credentials for redaction on construction", () => {
    manager();
    // Registered in the constructor, before any request can fail with them in
    // the message — a token registered only on success is unredacted in exactly
    // the logs that get pasted into a support channel.
    assert.ok(!redactKeys(`key=${API_KEY}`).includes(API_KEY));
    assert.ok(!redactKeys(`pat=${PAT}`).includes(PAT));
  });

  it("registers the wallet JWT the moment it arrives", async () => {
    const token = jwt({ exp: NOW / 1000 + 600, sub: "wallet" });
    stubFetch([{ json: { access_token: token } }]);
    await manager().token();
    assert.ok(!redactKeys(`bearer ${token}`).includes(token));
  });

  it("puts no credential in an error message", async () => {
    stubFetch([{ status: 401, json: { error: "bad token" } }]);
    const err = await manager()
      .token()
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    assert.ok(err !== null);
    assert.ok(!err.message.includes(PAT), "the scoped token must not appear in the message");
    assert.ok(!err.message.includes(API_KEY));
  });

  it("reports status without exposing the token, its prefix or its length", async () => {
    const token = jwt({ exp: NOW / 1000 + 600 });
    stubFetch([{ json: { access_token: token } }]);
    const auth = manager();
    await auth.token();

    const status = auth.status();
    const serialised = JSON.stringify(status);
    assert.ok(!serialised.includes(token));
    assert.ok(!serialised.includes(PAT));
    assert.ok(!serialised.includes(API_KEY));
    // No length either: it narrows the search space and is never worth knowing.
    assert.ok(!serialised.includes(String(token.length)));

    assert.equal(status.hasToken, true);
    assert.equal(status.expiresAtMs, NOW + 600_000);
    assert.equal(status.exchanges, 1);
    assert.equal(status.lastError, null);
  });

  it("reports no usable token before the first exchange", () => {
    const status = manager().status();
    assert.equal(status.hasToken, false);
    assert.equal(status.expiresAtMs, null);
    assert.equal(status.exchanges, 0);
  });
});

describe("authManagerFrom", () => {
  it("explains which credential is missing rather than throwing", () => {
    assert.deepEqual(authManagerFrom({ apiKey: null, scopedToken: PAT }), {
      manager: null,
      reason: "OPENSEA_API_KEY is not set",
    });
    assert.deepEqual(authManagerFrom({ apiKey: API_KEY, scopedToken: null }), {
      manager: null,
      // Both are named. Telling an operator to set OPENSEA_SCOPED_TOKEN and
      // nothing else sends them to the one route OpenSea is currently refusing.
      reason: "neither OPENSEA_SCOPED_TOKEN nor OPENSEA_WALLET_TOKEN is set",
    });
    assert.equal(
      authManagerFrom({ apiKey: API_KEY, scopedToken: null, walletToken: "wt-abc" }).manager !== null,
      true,
    );
    assert.deepEqual(authManagerFrom({ apiKey: "   ", scopedToken: PAT }).manager, null);
  });

  it("builds a manager when both are present", () => {
    const { manager: built, reason } = authManagerFrom({
      apiKey: API_KEY,
      scopedToken: PAT,
      now: () => NOW,
    });
    assert.ok(built instanceof OpenSeaAuthManager);
    assert.equal(reason, null);
  });
});

describe("a wallet token supplied directly", () => {
  // OpenSea answers POST /auth/tokens/exchange with 403 "Token exchange is not
  // available" — verified 2026-09-28 against the live API, and verified to be
  // unrelated to our credentials: the same 403 comes back for a nonsense subject
  // token and for a request carrying no API key at all, while an empty body
  // still gets a 422 naming the missing field, so the route is reachable and
  // simply refusing. OpenSea's own 401 on the eligibility endpoint says to get
  // the token from `opensea login` or an OAuth 2.1 PKCE flow instead.
  //
  // So the manager takes one directly. The contract downstream is unchanged: the
  // same WalletToken, the same expiry handling, the same refusal to log it.

  const WT_EXP = Math.floor((NOW + 10 * 60_000) / 1000);
  const supplied = (exp: number | null): string =>
    exp === null
      ? `${b64({ alg: "none" })}.${b64({ sub: "w" })}.${"s".repeat(16)}`
      : `${b64({ alg: "none" })}.${b64({ exp })}.${"s".repeat(16)}`;

  it("uses it without calling the exchange at all", async () => {
    const seen = stubFetch([]);
    const auth = new OpenSeaAuthManager({
      apiKey: API_KEY,
      scopedToken: "",
      walletToken: supplied(WT_EXP),
      now: () => NOW,
    });
    const token = await auth.token();
    assert.equal(token.token, supplied(WT_EXP));
    assert.equal(seen.length, 0, "no HTTP request should have been made");
    assert.equal(auth.status().exchanges, 0);
  });

  it("reads its expiry from its own claim", async () => {
    const auth = new OpenSeaAuthManager({
      apiKey: API_KEY, scopedToken: "", walletToken: supplied(WT_EXP), now: () => NOW,
    });
    const token = await auth.token();
    assert.equal(token.expiresAtMs, WT_EXP * 1000);
    assert.equal(token.expiryAssumed, false);
  });

  it("assumes a short life when the token states no expiry", async () => {
    const auth = new OpenSeaAuthManager({
      apiKey: API_KEY, scopedToken: "", walletToken: supplied(null), now: () => NOW,
    });
    const token = await auth.token();
    assert.equal(token.expiryAssumed, true);
    assert.equal(token.expiresAtMs, NOW + ASSUMED_LIFETIME_MS);
  });

  it("says the token expired rather than sending it and getting a 401", async () => {
    const seen = stubFetch([]);
    const auth = new OpenSeaAuthManager({
      apiKey: API_KEY,
      scopedToken: "",
      walletToken: supplied(Math.floor((NOW - 60_000) / 1000)),
      now: () => NOW,
    });
    const err = await auth.token().then(() => null, (e: unknown) => e as OpenSeaAuthError);
    assert.ok(err instanceof OpenSeaAuthError);
    assert.match(err.message, /OPENSEA_WALLET_TOKEN has expired/);
    // Not retryable: nothing in this process can mint a new one.
    assert.equal(err.retryable, false);
    assert.equal(seen.length, 0);
  });

  it("prefers it over the exchange when both are configured", async () => {
    const seen = stubFetch([]);
    const auth = new OpenSeaAuthManager({
      apiKey: API_KEY, scopedToken: PAT, walletToken: supplied(WT_EXP), now: () => NOW,
    });
    await auth.token();
    assert.equal(seen.length, 0);
  });

  it("is redacted like any other credential", () => {
    const wt = supplied(WT_EXP);
    new OpenSeaAuthManager({ apiKey: API_KEY, scopedToken: "", walletToken: wt, now: () => NOW });
    assert.doesNotMatch(redactKeys(`bearer ${wt} sent`), new RegExp(wt.slice(0, 24)));
  });

  it("blames the endpoint, not the token, when the exchange is unavailable", async () => {
    stubFetch([{ status: 403, json: { error: { message: "Token exchange is not available" } } }]);
    const auth = manager();
    const err = await auth.token().then(() => null, (e: unknown) => e as OpenSeaAuthError);
    assert.ok(err instanceof OpenSeaAuthError);
    // The old message told the operator to check OPENSEA_SCOPED_TOKEN's scope,
    // which is a wild goose chase: the endpoint refuses with no credentials too.
    assert.match(err.message, /disabled the token exchange/i);
    assert.match(err.message, /OPENSEA_WALLET_TOKEN/);
    assert.doesNotMatch(err.message, /Check OPENSEA_SCOPED_TOKEN is current/);
  });
});
