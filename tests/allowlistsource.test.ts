// Allow-list parsing: liberal in what it accepts, strict about what it invents.
//
// The list arrives from a generator, a gist, an IPFS pin — whatever the creator
// used — so the parser accepts the several shapes those emit. What it must never
// do is fill in a missing field. Price, window and stage index are hashed into
// the leaf, so a defaulted zero produces a tree that does not match the chain,
// and the operator sees "wrong list" when the truth is "we made a number up".

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAllowList, parseMintParams } from "../src/core/allowlistsource";
import { MintParams, buildTree, leafFor } from "../src/core/merkle";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

const RAW = {
  mintPrice: "10000000000000000",
  maxTotalMintableByWallet: 3,
  startTime: 1_773_576_000,
  endTime: 1_773_579_600,
  dropStageIndex: 1,
  maxTokenSupplyForStage: 5000,
  feeBps: 500,
  restrictFeeRecipients: true,
};

const PARAMS: MintParams = {
  mintPrice: 10_000_000_000_000_000n,
  maxTotalMintableByWallet: 3n,
  startTime: 1_773_576_000n,
  endTime: 1_773_579_600n,
  dropStageIndex: 1n,
  maxTokenSupplyForStage: 5_000n,
  feeBps: 500n,
  restrictFeeRecipients: true,
};

describe("parseMintParams", () => {
  it("reads numbers written as strings, numbers, or bigints", () => {
    // JSON has no bigint, so a mint price above 2^53 must arrive as a string.
    // Reading it as a number would round it and change the leaf.
    assert.deepEqual(parseMintParams(RAW), PARAMS);
  });

  it("keeps full precision on a price JSON cannot hold as a number", () => {
    const huge = "123456789012345678901234567890";
    const params = parseMintParams({ ...RAW, mintPrice: huge });
    assert.equal(params.mintPrice, BigInt(huge));
  });

  it("accepts the alternate field names generators use", () => {
    const params = parseMintParams({
      price: "10000000000000000",
      limit: 3,
      start: 1_773_576_000,
      end: 1_773_579_600,
      stageIndex: 1,
      maxSupplyForStage: 5000,
      fee: 500,
      restrict: true,
    });
    assert.deepEqual(params, PARAMS);
  });

  it("throws on a missing field rather than defaulting it to zero", () => {
    const { startTime, ...rest } = RAW;
    void startTime;
    assert.throws(() => parseMintParams(rest), /startTime/);
  });

  it("throws on a fractional value instead of truncating", () => {
    assert.throws(() => parseMintParams({ ...RAW, feeBps: 500.5 }), /whole number/i);
  });

  it("throws on a non-boolean restrict flag", () => {
    assert.throws(
      () => parseMintParams({ ...RAW, restrictFeeRecipients: "yes" }),
      /not a boolean/i,
    );
  });
});

describe("parseAllowList", () => {
  it("reads an array of entries with their own params", () => {
    const entries = parseAllowList([{ minter: A, mintParams: RAW }, { minter: B, mintParams: RAW }]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.minter, A);
    assert.deepEqual(entries[0]!.params, PARAMS);
  });

  it("reads the wrapped form", () => {
    const entries = parseAllowList({ entries: [{ address: A, params: RAW }] });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.minter, A);
  });

  it("reads one stage's params applied to many wallets", () => {
    // The common shape: a stage configured once, a long list of addresses.
    const entries = parseAllowList({ mintParams: RAW, minters: [A, B] });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[1]!.params, PARAMS);
  });

  it("reads params flattened onto the entry", () => {
    const entries = parseAllowList([{ minter: A, ...RAW }]);
    assert.deepEqual(entries[0]!.params, PARAMS);
  });

  it("accepts bare addresses when params are supplied separately", () => {
    const entries = parseAllowList([A, B], PARAMS);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0]!.params, PARAMS);
  });

  it("refuses bare addresses with no params anywhere", () => {
    assert.throws(() => parseAllowList([A, B]), /no mint params/i);
  });

  it("prefers a per-entry override to the shared params", () => {
    const entries = parseAllowList(
      [{ minter: A, mintParams: { ...RAW, dropStageIndex: 7 } }],
      PARAMS,
    );
    assert.equal(entries[0]!.params.dropStageIndex, 7n);
  });

  it("rejects a value that is not an address", () => {
    assert.throws(() => parseAllowList(["not-an-address"], PARAMS), /not an address/i);
  });

  it("rejects an entry with no minter field", () => {
    assert.throws(() => parseAllowList([{ mintParams: RAW }]), /no valid minter/i);
  });

  it("rejects an unrecognised document shape by saying what it expected", () => {
    assert.throws(() => parseAllowList({ nope: 1 }), /recognised shape/i);
    assert.throws(() => parseAllowList(42), /recognised shape/i);
  });

  it("produces entries that hash to a stable root", () => {
    // The end-to-end point of the parser: two documents describing the same set
    // in different shapes must build the same tree, or the root check fails for
    // a reason that has nothing to do with the chain.
    const one = parseAllowList({ mintParams: RAW, minters: [A, B] });
    const two = parseAllowList([{ minter: B, mintParams: RAW }, { minter: A, mintParams: RAW }]);
    assert.equal(buildTree(one.map(leafFor)).root, buildTree(two.map(leafFor)).root);
  });
});
