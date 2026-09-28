// Wallet-scoped eligibility parsing and the decision it feeds.
//
// The fixture is the shape the live API actually returned for `muse-brokers`:
// three stages, each carrying a `stage_uuid`, `is_eligible`, a `price` as a
// decimal-wei string, a `max_total_mintable_by_wallet` as a decimal string, and a
// null `max_total_mintable_by_wallet_per_token`. Tests written against invented
// shapes prove nothing about a parser whose whole job is reading someone else's
// JSON, so the real one is the baseline and the adversarial cases are mutations
// of it.
//
// Two classes of test carry the weight:
//
//   Joining. The response and the schedule are both arrays and neither endpoint
//   promises a shared order. If they are paired by position, the table shows a
//   price and an allowance next to the wrong stage label, and it looks entirely
//   normal — no error, no warning, just a wrong number that someone acts on.
//
//   Absent versus zero. A free stage and an unpriced stage are different facts.
//   Collapsing them prints "0 ETH" for a stage nobody has priced, which reads as
//   authoritative because every other number on that row is.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { DropStage } from "../src/core/opensea";
import {
  decideFromEligibility,
  eligibilityForStage,
  hintForStage,
  armableStages,
  liveEligibility,
  mintTerms,
  parseEligibilityResponse,
  fetchWalletEligibility,
  tryFetchWalletEligibility,
} from "../src/core/openseaeligibility";
import { OpenSeaAuthManager } from "../src/core/openseaauth";

const NOW = 1_773_576_000_000;
const HOUR = 3_600_000;
const SLUG = "muse-brokers";
const WALLET = "0x1111111111111111111111111111111111111111";

const UUID_GTD = "8f2a1c40-0000-4000-8000-000000000001";
const UUID_FCFS = "8f2a1c40-0000-4000-8000-000000000002";
const UUID_PUBLIC = "8f2a1c40-0000-4000-8000-000000000003";

/** The three scheduled stages, as fetchDropSchedule would return them. */
function schedule(): DropStage[] {
  return [
    {
      type: "presale",
      label: "GTD",
      startMs: NOW + HOUR,
      endMs: NOW + 2 * HOUR,
      isPublic: false,
      uuid: UUID_GTD,
    },
    {
      type: "presale",
      label: "FCFS",
      startMs: NOW + 2 * HOUR,
      endMs: NOW + 3 * HOUR,
      isPublic: false,
      uuid: UUID_FCFS,
    },
    {
      type: "public_sale",
      label: "Public",
      startMs: NOW + 3 * HOUR,
      endMs: NOW + 4 * HOUR,
      isPublic: true,
      uuid: UUID_PUBLIC,
    },
  ];
}

/** The verified live response: eligible for all three, two free, one priced. */
function liveResponse(): object {
  return {
    stages: [
      {
        stage_uuid: UUID_GTD,
        is_eligible: true,
        price: "0",
        max_total_mintable_by_wallet: "1",
        max_total_mintable_by_wallet_per_token: null,
      },
      {
        stage_uuid: UUID_FCFS,
        is_eligible: true,
        price: "0",
        max_total_mintable_by_wallet: "2",
        max_total_mintable_by_wallet_per_token: null,
      },
      {
        stage_uuid: UUID_PUBLIC,
        is_eligible: true,
        price: "1000000000000000",
        max_total_mintable_by_wallet: "5",
        max_total_mintable_by_wallet_per_token: null,
      },
    ],
  };
}

const parse = (raw: unknown, opts: { stages?: DropStage[]; wallet?: string } = {}) =>
  parseEligibilityResponse(raw, {
    dropSlug: SLUG,
    nowMs: NOW,
    stages: opts.stages ?? schedule(),
    ...(opts.wallet !== undefined ? { wallet: opts.wallet } : { wallet: WALLET }),
  });

describe("parseEligibilityResponse — the verified shape", () => {
  it("reads all three stages with their terms", () => {
    const snapshot = parse(liveResponse());
    assert.equal(snapshot.stages.length, 3);
    assert.equal(snapshot.dropSlug, SLUG);
    assert.equal(snapshot.wallet, WALLET);
    assert.equal(snapshot.checkedAt, NOW);
    assert.deepEqual(snapshot.unmatchedUuids, []);
    assert.deepEqual(snapshot.unansweredStages, []);
    assert.equal(snapshot.walletMismatch, undefined);

    assert.deepEqual(
      snapshot.stages.map((s) => [s.stageLabel, s.isEligible, s.price, s.maxMintable]),
      [
        ["GTD", true, 0n, 1],
        ["FCFS", true, 0n, 2],
        ["Public", true, 1_000_000_000_000_000n, 5],
      ],
    );
  });

  it("maps stage types through the existing taxonomy", () => {
    const snapshot = parse(liveResponse());
    assert.deepEqual(
      snapshot.stages.map((s) => s.stageType),
      ["gtd", "fcfs", "public"],
    );
  });

  it("carries a null per-token limit through as null", () => {
    for (const stage of parse(liveResponse()).stages) {
      assert.equal(stage.maxMintablePerToken, null);
    }
  });

  it("takes each stage's window from the schedule", () => {
    const stage = parse(liveResponse()).stages[0]!;
    assert.equal(stage.startsAt, NOW + HOUR);
    assert.equal(stage.endsAt, NOW + 2 * HOUR);
    assert.equal(stage.source, "opensea-eligibility");
    assert.equal(stage.unmapped, false);
  });
});

describe("parseEligibilityResponse — joining", () => {
  it("joins by uuid even when the response order is reversed", () => {
    const reversed = { stages: [...(liveResponse() as { stages: object[] }).stages].reverse() };
    const snapshot = parse(reversed);

    // Position-based pairing would put the public stage's price and allowance on
    // the GTD row, with nothing to indicate anything went wrong.
    const gtd = snapshot.stages.find((s) => s.stageUuid === UUID_GTD)!;
    assert.equal(gtd.stageLabel, "GTD");
    assert.equal(gtd.price, 0n);
    assert.equal(gtd.maxMintable, 1);

    const pub = snapshot.stages.find((s) => s.stageUuid === UUID_PUBLIC)!;
    assert.equal(pub.stageLabel, "Public");
    assert.equal(pub.price, 1_000_000_000_000_000n);
    assert.equal(pub.maxMintable, 5);
  });

  it("flags a stage the schedule does not contain instead of guessing its label", () => {
    const snapshot = parse({
      stages: [{ stage_uuid: "unknown-uuid", is_eligible: true, price: "5" }],
    });
    assert.deepEqual(snapshot.unmatchedUuids, ["unknown-uuid"]);
    const stage = snapshot.stages[0]!;
    assert.equal(stage.unmapped, true);
    assert.equal(stage.stageType, "unknown");
    assert.equal(stage.stageLabel, "unknown-uuid");
    // The terms still came from OpenSea and are still trustworthy.
    assert.equal(stage.price, 5n);
  });

  it("reports scheduled stages the response said nothing about", () => {
    const snapshot = parse({
      stages: [{ stage_uuid: UUID_GTD, is_eligible: true, price: "0" }],
    });
    assert.deepEqual(snapshot.unansweredStages, ["FCFS", "Public"]);
  });

  it("counts a stage with no uuid as unanswerable rather than matching it by order", () => {
    const stages = schedule();
    delete stages[0]!.uuid;
    const snapshot = parse(liveResponse(), { stages });
    assert.ok(snapshot.unansweredStages.includes("GTD"));
  });

  it("drops a response row that carries no uuid at all", () => {
    const snapshot = parse({
      stages: [
        { is_eligible: true, price: "0" },
        { stage_uuid: UUID_GTD, is_eligible: true, price: "0" },
      ],
    });
    // An unidentifiable row cannot be told apart from any other, and guessing is
    // the single failure mode this module exists to prevent.
    assert.equal(snapshot.stages.length, 1);
    assert.equal(snapshot.stages[0]!.stageUuid, UUID_GTD);
  });

  it("classifies an unmapped stage from the response's own type when it gives one", () => {
    const snapshot = parse({
      stages: [{ stage_uuid: "x", is_eligible: true, label: "GTD Mint", stage_type: "presale" }],
    });
    assert.equal(snapshot.stages[0]!.stageType, "gtd");
    assert.equal(snapshot.stages[0]!.stageLabel, "GTD Mint");
  });
});

describe("parseEligibilityResponse — absent is not zero", () => {
  it("keeps a stated price of zero as free, not unknown", () => {
    const snapshot = parse({ stages: [{ stage_uuid: UUID_GTD, is_eligible: true, price: "0" }] });
    assert.equal(snapshot.stages[0]!.price, 0n);
  });

  it("reports an absent price as unknown, not free", () => {
    for (const price of [undefined, null, "", "abc", "-5", "1.5", {}]) {
      const snapshot = parse({
        stages: [{ stage_uuid: UUID_GTD, is_eligible: true, price }],
      });
      assert.equal(
        snapshot.stages[0]!.price,
        null,
        `price ${JSON.stringify(price)} must be unknown, never 0`,
      );
    }
  });

  it("keeps a stated allowance of zero distinct from no stated allowance", () => {
    const zero = parse({
      stages: [{ stage_uuid: UUID_GTD, is_eligible: true, max_total_mintable_by_wallet: "0" }],
    });
    assert.equal(zero.stages[0]!.maxMintable, 0);

    const absent = parse({ stages: [{ stage_uuid: UUID_GTD, is_eligible: true }] });
    assert.equal(absent.stages[0]!.maxMintable, null);
  });

  it("accepts a large price without losing precision", () => {
    const snapshot = parse({
      stages: [{ stage_uuid: UUID_GTD, is_eligible: true, price: "123456789012345678901" }],
    });
    assert.equal(snapshot.stages[0]!.price, 123456789012345678901n);
  });
});

describe("parseEligibilityResponse — untrusted input", () => {
  it("treats anything other than an explicit true as not eligible", () => {
    for (const value of [false, undefined, null, "true", 1, {}]) {
      const snapshot = parse({
        stages: [{ stage_uuid: UUID_GTD, is_eligible: value }],
      });
      assert.equal(
        snapshot.stages[0]!.isEligible,
        false,
        `is_eligible ${JSON.stringify(value)} must not arm a wallet`,
      );
    }
  });

  it("accepts the camelCase spellings as well", () => {
    const snapshot = parse({
      stages: [
        {
          stageUuid: UUID_GTD,
          isEligible: true,
          price: "7",
          maxTotalMintableByWallet: "3",
          maxTotalMintableByWalletPerToken: "1",
        },
      ],
    });
    const stage = snapshot.stages[0]!;
    assert.equal(stage.stageUuid, UUID_GTD);
    assert.equal(stage.isEligible, true);
    assert.equal(stage.maxMintable, 3);
    assert.equal(stage.maxMintablePerToken, 1);
  });

  it("reads the stage array from any envelope the endpoint might use", () => {
    const rows = [{ stage_uuid: UUID_GTD, is_eligible: true, price: "0" }];
    for (const raw of [rows, { stages: rows }, { eligibility: rows }, { data: rows }]) {
      assert.equal(parse(raw).stages.length, 1, JSON.stringify(raw).slice(0, 40));
    }
  });

  it("returns an empty snapshot rather than throwing on nonsense", () => {
    for (const raw of [null, undefined, 42, "text", {}, { stages: "not-an-array" }]) {
      const snapshot = parse(raw);
      assert.deepEqual(snapshot.stages, []);
    }
  });

  it("flags a response that answers for a different wallet", () => {
    const other = "0x2222222222222222222222222222222222222222";
    const snapshot = parse({ minter: other, stages: [] });
    assert.equal(snapshot.walletMismatch, other);
  });

  it("does not call a checksum difference a mismatch", () => {
    const snapshot = parse({ minter: WALLET.toUpperCase().replace("0X", "0x"), stages: [] });
    assert.equal(snapshot.walletMismatch, undefined);
  });

  it("does not flag a mismatch when neither side names a wallet", () => {
    assert.equal(parse({ stages: [] }, { wallet: "" }).walletMismatch, undefined);
    assert.equal(parse({ stages: [] }).walletMismatch, undefined);
  });
});

describe("reading a snapshot", () => {
  const ended: DropStage = {
    type: "presale",
    label: "Early",
    startMs: NOW - 2 * HOUR,
    endMs: NOW - HOUR,
    isPublic: false,
    uuid: "ended-uuid",
  };

  it("finds a stage's eligibility by uuid", () => {
    const snapshot = parse(liveResponse());
    assert.equal(eligibilityForStage(snapshot, schedule()[1]!)!.stageLabel, "FCFS");
  });

  it("returns null for a stage with no uuid to join on", () => {
    const snapshot = parse(liveResponse());
    const stage = { ...schedule()[0]! };
    delete stage.uuid;
    assert.equal(eligibilityForStage(snapshot, stage), null);
  });

  it("picks the live stage by its window, not by its position", () => {
    // The first entry has ended. Taking `stages[0]` would report a finished
    // stage as the active one for every drop whose earliest stage is over.
    const stages = [ended, { ...schedule()[0]!, startMs: NOW - 60_000, endMs: NOW + HOUR }];
    const snapshot = parse(
      {
        stages: [
          { stage_uuid: "ended-uuid", is_eligible: true, price: "0" },
          { stage_uuid: UUID_GTD, is_eligible: true, price: "0" },
        ],
      },
      { stages },
    );
    assert.equal(liveEligibility(snapshot, NOW)!.stageUuid, UUID_GTD);
  });

  it("prefers a stage the wallet can use when two overlap", () => {
    const stages: DropStage[] = [
      { ...schedule()[0]!, startMs: NOW - HOUR, endMs: NOW + HOUR },
      { ...schedule()[2]!, startMs: NOW - 2 * HOUR, endMs: NOW + HOUR },
    ];
    const snapshot = parse(
      {
        stages: [
          { stage_uuid: UUID_GTD, is_eligible: true, price: "0" },
          { stage_uuid: UUID_PUBLIC, is_eligible: false, price: "1" },
        ],
      },
      { stages },
    );
    assert.equal(liveEligibility(snapshot, NOW)!.stageUuid, UUID_GTD);
  });

  it("returns null when nothing is open", () => {
    assert.equal(liveEligibility(parse(liveResponse()), NOW), null);
  });

  it("lists eligible future stages soonest first", () => {
    const armable = armableStages(parse(liveResponse()), NOW);
    assert.deepEqual(armable.map((s) => s.stageLabel), ["GTD", "FCFS", "Public"]);
  });

  it("excludes stages the wallet is not eligible for", () => {
    const snapshot = parse({
      stages: [
        { stage_uuid: UUID_GTD, is_eligible: false },
        { stage_uuid: UUID_FCFS, is_eligible: true },
      ],
    });
    assert.deepEqual(armableStages(snapshot, NOW).map((s) => s.stageLabel), ["FCFS"]);
  });

  it("excludes stages that have already opened", () => {
    assert.deepEqual(armableStages(parse(liveResponse()), NOW + 3.5 * HOUR), []);
  });
});

describe("decideFromEligibility", () => {
  it("arms for an eligible stage that has not opened yet", () => {
    // The capability the probe architecture could not provide: an answer before
    // the stage opens, which is the only time it is still actionable.
    const decision = decideFromEligibility(parse(liveResponse()), NOW);
    assert.equal(decision.action, "arm");
    assert.ok(decision.action === "arm");
    assert.equal(decision.stage.stageLabel, "GTD");
    assert.equal(decision.opensAtMs, NOW + HOUR);
    assert.equal(decision.opensInMs, HOUR);
  });

  it("fires when an eligible stage is open now", () => {
    const stages = [{ ...schedule()[0]!, startMs: NOW - 60_000, endMs: NOW + HOUR }];
    const decision = decideFromEligibility(
      parse({ stages: [{ stage_uuid: UUID_GTD, is_eligible: true, price: "0" }] }, { stages }),
      NOW,
    );
    assert.equal(decision.action, "fire");
  });

  it("waits rather than stopping when the open stage is one it cannot use", () => {
    const stages = [{ ...schedule()[0]!, startMs: NOW - 60_000, endMs: NOW + HOUR }];
    const decision = decideFromEligibility(
      parse({ stages: [{ stage_uuid: UUID_GTD, is_eligible: false }] }, { stages }),
      NOW,
    );
    assert.equal(decision.action, "wait");
    assert.ok(decision.action === "wait");
    assert.match(decision.reason, /not eligible for the open stage "GTD"/);
  });

  it("waits when a stage is unanswered, because silence is not a refusal", () => {
    const decision = decideFromEligibility(
      parse({ stages: [{ stage_uuid: UUID_GTD, is_eligible: false }] }, {}),
      NOW,
    );
    assert.equal(decision.action, "wait");
    assert.ok(decision.action === "wait");
    assert.match(decision.reason, /no eligibility answer for FCFS, Public/);
  });

  it("waits when eligible for a stage with no published start time", () => {
    const decision = decideFromEligibility(
      parse({ stages: [{ stage_uuid: "undated", is_eligible: true }] }, { stages: [] }),
      NOW,
    );
    assert.equal(decision.action, "wait");
    assert.ok(decision.action === "wait");
    assert.match(decision.reason, /no published start time/);
  });

  it("waits when OpenSea returned no stages at all", () => {
    const decision = decideFromEligibility(parse({ stages: [] }, { stages: [] }), NOW);
    assert.equal(decision.action, "wait");
  });

  it("stops only when every stage is answered and none is usable", () => {
    const snapshot = parse({
      stages: [
        { stage_uuid: UUID_GTD, is_eligible: false },
        { stage_uuid: UUID_FCFS, is_eligible: false },
        { stage_uuid: UUID_PUBLIC, is_eligible: false },
      ],
    });
    const decision = decideFromEligibility(snapshot, NOW);
    assert.equal(decision.action, "stop");
  });

  it("refuses to act on another wallet's eligibility", () => {
    const other = "0x2222222222222222222222222222222222222222";
    const decision = decideFromEligibility(
      parse({ minter: other, ...liveResponse() }),
      NOW,
    );
    assert.equal(decision.action, "stop");
    assert.ok(decision.action === "stop");
    assert.match(decision.reason, /Refusing to act on another wallet/);
  });
});

describe("mintTerms", () => {
  it("multiplies the price by the quantity", () => {
    const stage = parse(liveResponse()).stages[2]!;
    const terms = mintTerms(stage, 3)!;
    assert.equal(terms.pricePerToken, 1_000_000_000_000_000n);
    assert.equal(terms.totalValue, 3_000_000_000_000_000n);
    assert.equal(terms.allowance, 5);
    assert.equal(terms.withinAllowance, true);
  });

  it("reports a quantity above the stated allowance", () => {
    const stage = parse(liveResponse()).stages[0]!;
    assert.equal(mintTerms(stage, 2)!.withinAllowance, false);
  });

  it("treats no stated allowance as no limit", () => {
    const snapshot = parse({ stages: [{ stage_uuid: UUID_GTD, is_eligible: true, price: "0" }] });
    assert.equal(mintTerms(snapshot.stages[0]!, 99)!.withinAllowance, true);
  });

  it("refuses to state terms for a stage with no known price", () => {
    // A price we do not know is a value we cannot check the calldata against,
    // and that check is what stands between an API response and a signature.
    const snapshot = parse({ stages: [{ stage_uuid: UUID_GTD, is_eligible: true }] });
    assert.equal(mintTerms(snapshot.stages[0]!, 1), null);
  });

  it("refuses a nonsensical quantity", () => {
    const stage = parse(liveResponse()).stages[0]!;
    for (const quantity of [0, -1, 1.5]) assert.equal(mintTerms(stage, quantity), null);
  });
});

// ── The HTTP call ────────────────────────────────────────────────────────────

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const JWT = `${b64({ alg: "none" })}.${b64({ exp: NOW / 1000 + 600 })}.${"s".repeat(20)}`;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function authStub(): OpenSeaAuthManager {
  return new OpenSeaAuthManager({
    apiKey: "api-key-value-0123456789",
    scopedToken: "scoped-token-value-0123456789",
    now: () => NOW,
  });
}

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Answer the exchange, then answer the eligibility call with `body`. */
function stubChain(body: unknown, status = 200): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    seen.push({
      url: href,
      method: String(init?.method ?? "GET"),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    });
    if (href.includes("/auth/tokens/exchange")) {
      return new Response(JSON.stringify({ access_token: JWT }), { status: 200 });
    }
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return seen;
}

describe("fetchWalletEligibility", () => {
  it("GETs the eligibility path with both credentials", async () => {
    const seen = stubChain(liveResponse());
    const snapshot = await fetchWalletEligibility({
      slug: SLUG,
      auth: authStub(),
      wallet: WALLET,
      stages: schedule(),
      now: () => NOW,
    });

    assert.equal(snapshot.stages.length, 3);

    const call = seen.find((s) => s.url.includes("/eligibility"))!;
    assert.equal(call.url, `https://api.opensea.io/api/v2/drops/${SLUG}/eligibility`);
    assert.equal(call.method, "GET");
    // Both: x-api-key identifies the integration, the bearer identifies the
    // wallet. Sending one earns a 401 that says nothing about which was missing.
    assert.equal(call.headers["x-api-key"], "api-key-value-0123456789");
    assert.equal(call.headers["authorization"], `Bearer ${JWT}`);
  });

  it("rejects a slug that is not a slug before making a request", async () => {
    const seen = stubChain(liveResponse());
    await assert.rejects(
      () => fetchWalletEligibility({ slug: "../../admin", auth: authStub() }),
      /Invalid collection slug/,
    );
    assert.equal(seen.length, 0);
  });
});

describe("tryFetchWalletEligibility", () => {
  it("classifies a missing scope as an auth problem, never as ineligibility", async () => {
    stubChain({ error: "forbidden" }, 403);
    const { snapshot, failure } = await tryFetchWalletEligibility({
      slug: SLUG,
      auth: authStub(),
      stages: schedule(),
    });

    assert.equal(snapshot, null);
    assert.ok(failure !== null);
    assert.equal(failure.code, "AUTH_INVALID");
    assert.notEqual(failure.code, "ELIGIBILITY_FALSE");
    assert.match(failure.message, /scope/);
  });

  it("reports a rate limit as retryable rather than failing the task", async () => {
    stubChain({ error: "slow down" }, 429);
    const { failure } = await tryFetchWalletEligibility({ slug: SLUG, auth: authStub() });
    assert.equal(failure!.code, "RPC_RATE_LIMIT");
    assert.equal(failure!.retryable, true);
  });

  it("returns a snapshot and no failure on success", async () => {
    stubChain(liveResponse());
    const { snapshot, failure } = await tryFetchWalletEligibility({
      slug: SLUG,
      auth: authStub(),
      stages: schedule(),
      now: () => NOW,
    });
    assert.equal(failure, null);
    assert.equal(snapshot!.stages.length, 3);
  });
});

describe("hintForStage — who the answer is about", () => {
  // The scoped token authorises exactly one wallet, so at most one wallet in a
  // run can ever be answered for. Every other wallet has to stay unknown, and
  // "unknown" has to survive contact with the three ways this gets confusing:
  // an answer for someone else's address, an answer for no stated address, and
  // an answer that covers the drop but not the stage being minted.
  //
  // The cost of getting it wrong is specific. The hint's only consumer is the
  // 422 classifier, which turns an ambiguous refusal into a stated cause. Feed
  // it wallet A's "eligible, limit 1" while wallet B is the one being refused
  // and the run reports MINT_LIMIT_REACHED for a wallet that was never on the
  // list — a wrong answer delivered with the same confidence as a right one.

  const only = (addr: string): ReadonlySet<string> => new Set([addr.toLowerCase()]);
  const OTHER = "0x2222222222222222222222222222222222222222";

  it("records the answer when OpenSea names a wallet the run loaded", () => {
    const snap = parse(liveResponse());
    const hint = hintForStage(snap, schedule()[2]!, only(WALLET));
    assert.equal(hint.kind, "recorded");
    if (hint.kind !== "recorded") return;
    assert.equal(hint.wallet, WALLET.toLowerCase());
    assert.deepEqual(hint.hint, { isEligible: true, maxMintable: 5 });
    assert.equal(hint.row.stageUuid, UUID_PUBLIC);
  });

  it("keys the hint lowercased, whatever case the response used", () => {
    // The map is read with a lowercased address. A checksummed key would be a
    // hint that is stored and never found — no error, just silently no effect.
    const snap = parse(liveResponse(), { wallet: WALLET.toUpperCase() });
    const hint = hintForStage(snap, schedule()[0]!, only(WALLET));
    assert.equal(hint.kind, "recorded");
    if (hint.kind !== "recorded") return;
    assert.equal(hint.wallet, hint.wallet.toLowerCase());
    assert.equal(hint.wallet, WALLET.toLowerCase());
  });

  it("refuses an answer about an address the run is not minting with", () => {
    const snap = parse(liveResponse(), { wallet: OTHER });
    const hint = hintForStage(snap, schedule()[0]!, only(WALLET));
    assert.equal(hint.kind, "foreign");
    if (hint.kind !== "foreign") return;
    assert.equal(hint.wallet.toLowerCase(), OTHER.toLowerCase());
  });

  it("takes the single loaded wallet when OpenSea names none", () => {
    // Legal: the JWT already identifies the wallet, so the body need not repeat
    // it. With one wallet loaded there is only one thing the answer can mean.
    const snap = parse(liveResponse(), { wallet: "" });
    assert.equal(snap.wallet, "");
    const hint = hintForStage(snap, schedule()[1]!, only(WALLET));
    assert.equal(hint.kind, "recorded");
    if (hint.kind !== "recorded") return;
    assert.equal(hint.wallet, WALLET.toLowerCase());
    assert.equal(hint.hint.maxMintable, 2);
  });

  it("attributes nothing when OpenSea names none and several are loaded", () => {
    const snap = parse(liveResponse(), { wallet: "" });
    const loaded = new Set([WALLET.toLowerCase(), OTHER.toLowerCase()]);
    const hint = hintForStage(snap, schedule()[0]!, loaded);
    assert.equal(hint.kind, "ambiguous");
    if (hint.kind !== "ambiguous") return;
    assert.equal(hint.candidates, 2);
  });

  it("attributes nothing when no wallet is loaded at all", () => {
    const snap = parse(liveResponse(), { wallet: "" });
    assert.equal(hintForStage(snap, schedule()[0]!, new Set()).kind, "ambiguous");
  });

  it("refuses when the response contradicts the wallet it was asked about", () => {
    const snap = parse(liveResponse(), { wallet: WALLET });
    const mismatched = { ...snap, walletMismatch: OTHER };
    // Loaded, and named — but the parser already flagged the contradiction, and
    // a flagged answer is not repaired by the address happening to be ours.
    const hint = hintForStage(mismatched, schedule()[0]!, only(WALLET));
    assert.equal(hint.kind, "foreign");
  });

  it("reports no row rather than falling back to another stage", () => {
    const body = { stages: [(liveResponse() as { stages: object[] }).stages[0]] };
    const snap = parse(body);
    // Asked about Public; only GTD was answered. Position would have "worked".
    const hint = hintForStage(snap, schedule()[2]!, only(WALLET));
    assert.equal(hint.kind, "no-row");
    if (hint.kind !== "no-row") return;
    assert.equal(hint.answered, 1);
  });

  it("reports no row for a stage carrying no OpenSea stage id", () => {
    const untagged: DropStage = { ...schedule()[0]!, uuid: undefined };
    assert.equal(hintForStage(parse(liveResponse()), untagged, only(WALLET)).kind, "no-row");
  });

  it("reports no row when there is no stage to ask about", () => {
    assert.equal(hintForStage(parse(liveResponse()), null, only(WALLET)).kind, "no-row");
  });

  it("carries an ineligible verdict through unchanged", () => {
    // The whole point: this is the hint that turns a bare 422 into
    // WALLET_NOT_ELIGIBLE, so a false must arrive as a false.
    const body = liveResponse() as { stages: { is_eligible: boolean }[] };
    body.stages[0]!.is_eligible = false;
    const hint = hintForStage(parse(body), schedule()[0]!, only(WALLET));
    assert.equal(hint.kind, "recorded");
    if (hint.kind !== "recorded") return;
    assert.equal(hint.hint.isEligible, false);
  });

  it("passes an unstated allowance through as null, not zero", () => {
    const body = liveResponse() as { stages: { max_total_mintable_by_wallet: string | null }[] };
    body.stages[0]!.max_total_mintable_by_wallet = null;
    const hint = hintForStage(parse(body), schedule()[0]!, only(WALLET));
    assert.equal(hint.kind, "recorded");
    if (hint.kind !== "recorded") return;
    // null is "no limit stated"; 0 is "a stated limit of zero". The classifier
    // reads them differently, so collapsing them invents a limit.
    assert.equal(hint.hint.maxMintable, null);
  });
});
