// The allowlist verification boundary.
//
// This is the one place in the project where bytes that came from someone else's
// server are about to be signed by the user's key. Every test here is an attack:
// each one constructs a response that a compromised or hostile API could return,
// and asserts that it is refused.
//
// The happy-path test exists mainly so the failures mean something — a verifier
// that rejects everything would pass all the adversarial cases too.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZeroAddress } from "ethers";
import {
  DropSchedule,
  RawMintTx,
  allowlistInterface,
  fetchDropSchedule,
  isPublicMintCalldata,
  verifyAllowlistTx,
} from "../src/core/opensea";

const SEADROP_V1 = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const COLLECTION = "0x1111111111111111111111111111111111111111";
const MINTER = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x3333333333333333333333333333333333333333";

const NOW = 1_773_576_000_000; // 2026-03-15T12:00:00Z
const START = Math.floor(NOW / 1000) - 60; // opened a minute ago
const END = Math.floor(NOW / 1000) + 3600;
const PRICE = 10_000_000_000_000_000n; // 0.01 ETH

function mintParams(overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const params = {
    mintPrice: PRICE,
    maxTotalMintableByWallet: 5n,
    startTime: BigInt(START),
    endTime: BigInt(END),
    dropStageIndex: 1n,
    maxTokenSupplyForStage: 1000n,
    feeBps: 500n,
    restrictFeeRecipients: true,
    ...overrides,
  };
  return [
    params.mintPrice,
    params.maxTotalMintableByWallet,
    params.startTime,
    params.endTime,
    params.dropStageIndex,
    params.maxTokenSupplyForStage,
    params.feeBps,
    params.restrictFeeRecipients,
  ];
}

/** Build a v1 (singleton) mintSigned response, with fields overridable per test. */
function v1Response(
  opts: {
    nftContract?: string;
    minter?: string;
    quantity?: bigint;
    value?: bigint;
    chain?: string;
    to?: string;
    params?: Partial<Record<string, unknown>>;
  } = {},
): RawMintTx {
  const quantity = opts.quantity ?? 2n;
  const data = allowlistInterface.encodeFunctionData(
    "mintSigned(address,address,address,uint256,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool),uint256,bytes)",
    [
      opts.nftContract ?? COLLECTION,
      FEE_RECIPIENT,
      opts.minter ?? ZeroAddress,
      quantity,
      mintParams(opts.params),
      12345n,
      "0xdeadbeef",
    ],
  );
  return {
    chain: opts.chain ?? "base",
    to: opts.to ?? SEADROP_V1,
    data,
    value: String(opts.value ?? PRICE * quantity),
  };
}

const ctx = {
  expectedChainKey: "base",
  expectedContract: COLLECTION,
  expectedMinter: MINTER,
  expectedQuantity: 2,
  allowTokenTarget: true,
  nowMs: NOW,
};

describe("verifyAllowlistTx — the honest case", () => {
  it("accepts a well-formed v1 mint and reports what it agreed to", () => {
    const verified = verifyAllowlistTx(v1Response(), ctx);
    assert.equal(verified.value, PRICE * 2n);
    assert.equal(verified.mintPrice, PRICE);
    assert.equal(verified.stageIndex, "1");
    assert.ok(verified.method.startsWith("mintSigned"));
    assert.equal(verified.startMs, START * 1000);
  });

  it("accepts the wallet itself as minterIfNotPayer, not only zero", () => {
    const verified = verifyAllowlistTx(v1Response({ minter: MINTER }), ctx);
    assert.equal(verified.value, PRICE * 2n);
  });
});

describe("verifyAllowlistTx — refusals", () => {
  it("refuses calldata that is not a SeaDrop mint at all", () => {
    // The single most important case: an opaque blob, or an ERC-20 approval
    // dressed up as a mint. Anything that does not decode is refused outright.
    const transfer: RawMintTx = {
      chain: "base",
      to: SEADROP_V1,
      data: "0xa9059cbb0000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000ffffffffffffffff",
      value: "0",
    };
    assert.throws(() => verifyAllowlistTx(transfer, ctx), /not a recognised SeaDrop mint/);
  });

  it("refuses empty calldata", () => {
    assert.throws(
      () => verifyAllowlistTx({ chain: "base", to: SEADROP_V1, data: "0x", value: "0" }, ctx),
      /not a recognised SeaDrop mint/,
    );
  });

  it("refuses a transaction aimed at an unrelated contract", () => {
    assert.throws(
      () => verifyAllowlistTx(v1Response({ to: ATTACKER }), ctx),
      /neither SeaDrop nor the collection/,
    );
  });

  it("refuses calldata that mints a different collection", () => {
    assert.throws(
      () => verifyAllowlistTx(v1Response({ nftContract: ATTACKER }), ctx),
      /different collection/,
    );
  });

  it("refuses calldata that credits the NFT to someone else", () => {
    // The subtle one: a valid mint, correct price, correct collection — but the
    // token lands in the attacker's wallet and the user pays for it.
    assert.throws(
      () => verifyAllowlistTx(v1Response({ minter: ATTACKER }), ctx),
      /credits the NFT to/,
    );
  });

  it("refuses a quantity that does not match what was asked for", () => {
    assert.throws(
      () => verifyAllowlistTx(v1Response({ quantity: 50n, value: PRICE * 50n }), ctx),
      /mints 50 tokens, not the requested 2/,
    );
  });

  it("refuses a value that exceeds price × quantity", () => {
    assert.throws(
      () => verifyAllowlistTx(v1Response({ value: PRICE * 200n }), ctx),
      /does not equal mintPrice/,
    );
  });

  it("refuses a transaction built for a different chain", () => {
    assert.throws(
      () => verifyAllowlistTx(v1Response({ chain: "ethereum" }), ctx),
      /chain "ethereum" but "base" was selected/,
    );
  });

  it("refuses a stage that has not opened", () => {
    assert.throws(
      () =>
        verifyAllowlistTx(
          v1Response({ params: { startTime: BigInt(Math.floor(NOW / 1000) + 600) } }),
          ctx,
        ),
      /has not opened yet/,
    );
  });

  it("refuses a stage that has already closed", () => {
    assert.throws(
      () =>
        verifyAllowlistTx(
          v1Response({ params: { endTime: BigInt(Math.floor(NOW / 1000) - 1) } }),
          ctx,
        ),
      /already ended/,
    );
  });

  it("refuses a fee over 100%", () => {
    assert.throws(
      () => verifyAllowlistTx(v1Response({ params: { feeBps: 10_001n } }), ctx),
      /feeBps exceeds 100%/,
    );
  });

  it("refuses a malformed value string rather than coercing it", () => {
    const raw = v1Response();
    assert.throws(
      () => verifyAllowlistTx({ ...raw, value: "1e18" }, ctx),
      /Invalid transaction value/,
    );
  });

  it("refuses an out-of-range requested quantity before doing anything else", () => {
    assert.throws(
      () => verifyAllowlistTx(v1Response(), { ...ctx, expectedQuantity: 0 }),
      /must be an integer in 1\.\.1000/,
    );
  });
});

describe("isPublicMintCalldata", () => {
  it("does not mistake a signed mint for a public one", () => {
    assert.equal(isPublicMintCalldata(v1Response().data), false);
  });
});

describe("fetchDropSchedule — the fields the live payload actually carries", () => {
  // Every case here is a mutation of the real /api/v2/drops/muse-brokers body,
  // captured 2026-09-28. It matters that the fixture is the real one, because
  // the bug these tests exist for was not a logic error — it was a field name.
  // The parser read `stage_uuid`; the endpoint sends `uuid`. Nothing threw,
  // nothing warned, and the join key that wallet eligibility is matched on was
  // absent from every stage of every real drop, while the unit tests, which
  // supplied `stage_uuid` because the parser did, all passed.
  //
  // The same payload also carries `price` and `max_per_wallet`, which the stage
  // table used to replace with "—" under a comment asserting the endpoint did
  // not return them.

  const liveStageBody = () => ({
    uuid: "5732cec92ba2443988eeaa5ed53e8d6a",
    stage_type: "public_sale",
    label: "Public stage",
    price: "1000000000000000",
    price_currency_address: "0x0000000000000000000000000000000000000000",
    start_time: "2026-09-26T23:23:17Z",
    end_time: "2026-09-26T23:43:17Z",
    max_per_wallet: "3",
    allowlist_wallet_count: null,
  });

  const drop = (...stages: object[]) => ({
    chain: "base",
    contract_address: "0x00000000000000000000000000000000000000aa",
    stages,
  });

  const fetchWith = async (body: object): Promise<DropSchedule> => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as typeof globalThis.fetch;
    try {
      return await fetchDropSchedule("muse-brokers", "k");
    } finally {
      globalThis.fetch = saved;
    }
  };

  it("reads the uuid the live endpoint actually sends", async () => {
    const s = await fetchWith(drop(liveStageBody()));
    assert.equal(s.stages[0]!.uuid, "5732cec92ba2443988eeaa5ed53e8d6a");
  });

  it("still reads the stage_uuid spelling the eligibility endpoint uses", async () => {
    const { uuid: _drop, ...rest } = liveStageBody();
    const s = await fetchWith(drop({ ...rest, stage_uuid: "abc123" }));
    assert.equal(s.stages[0]!.uuid, "abc123");
  });

  it("leaves the uuid absent rather than empty when neither is present", async () => {
    const { uuid: _drop, ...rest } = liveStageBody();
    const s = await fetchWith(drop(rest));
    // Absent, not "". A stage that cannot be joined has to be detectable as such.
    assert.equal(s.stages[0]!.uuid, undefined);
  });

  it("reads the stage price before the stage opens", async () => {
    const s = await fetchWith(drop(liveStageBody()));
    assert.equal(s.stages[0]!.priceWei, 1_000_000_000_000_000n);
  });

  it("keeps a free stage as zero, not as absent", async () => {
    const s = await fetchWith(drop({ ...liveStageBody(), price: "0" }));
    // 0n is "free"; undefined is "not stated". The table renders them differently
    // and a reader acts on the difference.
    assert.equal(s.stages[0]!.priceWei, 0n);
  });

  it("refuses a price denominated in a token", async () => {
    const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const s = await fetchWith(drop({ ...liveStageBody(), price_currency_address: usdc }));
    // Rendering this in the ETH column would print 0.001 ETH for a 0.001 USDC
    // mint — a wrong number wearing the right units.
    assert.equal(s.stages[0]!.priceWei, undefined);
    assert.equal(s.stages[0]!.priceCurrency, usdc.toLowerCase());
  });

  it("reads the per-wallet cap", async () => {
    const s = await fetchWith(drop(liveStageBody()));
    assert.equal(s.stages[0]!.maxPerWallet, 3);
  });

  it("treats a stated cap of zero as stated", async () => {
    const s = await fetchWith(drop({ ...liveStageBody(), max_per_wallet: "0" }));
    assert.equal(s.stages[0]!.maxPerWallet, 0);
  });

  it("drops a price that is not a plain integer rather than coercing it", async () => {
    for (const bad of ["1.5e18", "-1", "abc", "", "0x10", " 12 3"]) {
      const s = await fetchWith(drop({ ...liveStageBody(), price: bad }));
      assert.equal(s.stages[0]!.priceWei, undefined, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it("accepts the numeric spellings too", async () => {
    const s = await fetchWith(drop({ ...liveStageBody(), price: 250, max_per_wallet: 2 }));
    assert.equal(s.stages[0]!.priceWei, 250n);
    assert.equal(s.stages[0]!.maxPerWallet, 2);
  });
});
