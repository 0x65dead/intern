// The capability matrix, and the selection it drives.
//
// This is the honesty contract in executable form. Two things are pinned: that
// every limitation carries a stated cause, and that `canFire` never widens a
// capability the mechanism does not intrinsically have. A matrix that claims a
// stage is fireable when the code cannot fire it produces a clean-looking table
// and a mint that never happens — the exact failure the project forbids.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPABILITIES,
  FireContext,
  MechanismEvidence,
  MintMechanism,
  NO_EVIDENCE,
  PUBLIC_ONLY,
  canFire,
  capabilityFor,
  isFireable,
  mechanismFor,
  notFireableReason,
} from "../src/core/capabilities";
import { StageKind, StageRow, StageTable, actionableStage } from "../src/core/stages";
import { WalletEligibility } from "../src/core/eligibility";
import { stageContext } from "../src/core/prepare";

const MECHANISMS: MintMechanism[] = [
  "public",
  "merkle-allowlist",
  "local-signed",
  "opensea-signed",
  "team-reserved",
  "unknown",
];

const GATED: StageKind[] = ["allowlist", "gtd", "fcfs"];

function ctx(over: Partial<FireContext> = {}): FireContext {
  return { ...PUBLIC_ONLY, ...over };
}

function evidence(over: Partial<MechanismEvidence> = {}): MechanismEvidence {
  return { ...NO_EVIDENCE, ...over };
}

describe("the matrix is complete", () => {
  it("has exactly one row per mechanism", () => {
    assert.equal(CAPABILITIES.length, MECHANISMS.length);
    for (const mechanism of MECHANISMS) {
      assert.equal(capabilityFor(mechanism).mechanism, mechanism);
    }
  });

  it("states a cause for every limitation", () => {
    // The type already forbids a warn/no without a reason. This catches the
    // other half: a reason that is present but empty, which reads in the
    // generated document as a limitation with no explanation at all.
    for (const row of CAPABILITIES) {
      const fields = [
        row.detectWindow,
        row.precheckEligibility,
        row.preSign,
        row.fireUnattended,
      ];
      for (const field of fields) {
        if (field.level === "yes") continue;
        assert.ok(field.reason.trim().length > 20, `${row.mechanism}: thin reason`);
      }
      assert.ok(row.fireSpeed.detail.trim().length > 20, `${row.mechanism}: thin speed`);
    }
  });

  it("gives every unfireable mechanism a null method", () => {
    for (const row of CAPABILITIES) {
      if (row.fireUnattended.level === "no") assert.equal(row.method, null);
      else assert.ok(row.method);
    }
  });
});

describe("the OpenSea signature constraint is stated, not hidden", () => {
  // The single most important honest claim in the project: an OpenSea-gated
  // stage cannot be pre-signed, and therefore cannot match a public mint's
  // speed. If this ever quietly flips to "yes", the README's promise is a lie.
  const row = capabilityFor("opensea-signed");

  it("refuses to claim pre-signing", () => {
    assert.equal(row.preSign.level, "no");
    assert.match(row.preSign.level === "no" ? row.preSign.reason : "", /does not issue it before/i);
  });

  it("refuses to claim eligibility is knowable in advance", () => {
    assert.equal(row.precheckEligibility.level, "no");
    assert.match(
      row.precheckEligibility.level === "no" ? row.precheckEligibility.reason : "",
      /403|unknown/i,
    );
  });

  it("says in writing that it is slower than a public mint", () => {
    assert.equal(row.fireSpeed.class, "api-bound");
    assert.match(row.fireSpeed.detail, /slower than a public mint/i);
  });

  it("still fires unattended — the limitation is speed, not reach", () => {
    assert.equal(row.fireUnattended.level, "yes");
  });
});

describe("mechanismFor", () => {
  it("maps the ungated kinds without consulting evidence", () => {
    assert.equal(mechanismFor("public", evidence({ merkleRoot: true })), "public");
    assert.equal(mechanismFor("team", evidence({ merkleRoot: true })), "team-reserved");
    assert.equal(mechanismFor("unknown", evidence({ localSigner: true })), "unknown");
  });

  it("sends every gated kind to OpenSea when nothing else is configured", () => {
    for (const kind of GATED) {
      assert.equal(mechanismFor(kind, NO_EVIDENCE), "opensea-signed");
    }
  });

  it("prefers an on-chain Merkle root over everything", () => {
    for (const kind of GATED) {
      assert.equal(
        mechanismFor(kind, evidence({ merkleRoot: true, localSigner: true })),
        "merkle-allowlist",
      );
    }
  });

  it("prefers a local signer over asking OpenSea", () => {
    for (const kind of GATED) {
      assert.equal(mechanismFor(kind, evidence({ localSigner: true })), "local-signed");
    }
  });
});

describe("canFire never widens what the mechanism cannot do", () => {
  const permissive = ctx({ allowlistMinting: true, openseaApiKey: true, merkleProof: true });

  it("keeps team and unclassified stages unfireable under any context", () => {
    for (const mechanism of ["team-reserved", "unknown"] as MintMechanism[]) {
      assert.equal(canFire(mechanism, permissive).level, "no");
      assert.equal(canFire(mechanism, PUBLIC_ONLY).level, "no");
    }
  });

  it("always allows a public mint, with nothing configured", () => {
    assert.ok(isFireable("public", PUBLIC_ONLY));
  });
});

describe("the ALLOWLIST_MINTING flag", () => {
  it("withholds every gated mechanism when off", () => {
    for (const mechanism of ["merkle-allowlist", "local-signed", "opensea-signed"] as MintMechanism[]) {
      const verdict = canFire(mechanism, PUBLIC_ONLY);
      assert.equal(verdict.level, "no");
      assert.match(verdict.level === "no" ? verdict.reason : "", /ALLOWLIST_MINTING/);
    }
  });

  it("does not by itself unlock an OpenSea stage without a key", () => {
    const verdict = canFire("opensea-signed", ctx({ allowlistMinting: true }));
    assert.equal(verdict.level, "no");
    assert.match(verdict.level === "no" ? verdict.reason : "", /OPENSEA_API_KEY/);
  });

  it("unlocks an OpenSea stage once the key is present", () => {
    assert.ok(isFireable("opensea-signed", ctx({ allowlistMinting: true, openseaApiKey: true })));
  });

  it("does not unlock a Merkle stage for a wallet with no proof", () => {
    const verdict = canFire("merkle-allowlist", ctx({ allowlistMinting: true }));
    assert.equal(verdict.level, "no");
    assert.match(verdict.level === "no" ? verdict.reason : "", /no loaded wallet has a proof/i);
  });

  it("unlocks a Merkle stage once a proof exists", () => {
    assert.ok(isFireable("merkle-allowlist", ctx({ allowlistMinting: true, merkleProof: true })));
  });

  it("needs no key for a locally held signer", () => {
    assert.ok(isFireable("local-signed", ctx({ allowlistMinting: true })));
  });
});

describe("notFireableReason", () => {
  it("is empty exactly when the mechanism can fire", () => {
    const full = ctx({ allowlistMinting: true, openseaApiKey: true, merkleProof: true });
    for (const mechanism of MECHANISMS) {
      const fireable = isFireable(mechanism, full);
      assert.equal(notFireableReason(mechanism, full) === "", fireable, mechanism);
    }
  });
});

// ── Matrix-driven selection ────────────────────────────────────────────────

const NOW = 1773576000000;
const HOUR = 3_600_000;

function row(over: Partial<StageRow> & { kind: StageKind }): StageRow {
  return {
    label: over.kind,
    source: "OpenSea API",
    priceWei: null,
    startMs: NOW - HOUR,
    endMs: NOW + HOUR,
    perWalletCap: 0,
    status: "live",
    countdownMs: HOUR,
    mintsLeft: null,
    mintsTotal: null,
    ...over,
  };
}

function table(rows: StageRow[]): StageTable {
  return { rows, hasApiData: true, supply: { totalSupply: 0n, maxSupply: 5000n } };
}

describe("actionableStage — flag off reproduces the old behaviour", () => {
  it("picks the live public stage and ignores a live allowlist stage", () => {
    const publicRow = row({ kind: "public", source: "on-chain" });
    const allow = row({ kind: "allowlist" });
    assert.equal(actionableStage(table([allow, publicRow]), NOW), publicRow);
  });

  it("returns nothing for an allowlist-only drop", () => {
    assert.equal(actionableStage(table([row({ kind: "gtd" })]), NOW), undefined);
  });

  it("never selects a team stage", () => {
    const full = ctx({ allowlistMinting: true, openseaApiKey: true, merkleProof: true });
    assert.equal(actionableStage(table([row({ kind: "team" })]), NOW, full), undefined);
  });

  it("never selects an unclassified stage", () => {
    const full = ctx({ allowlistMinting: true, openseaApiKey: true, merkleProof: true });
    assert.equal(actionableStage(table([row({ kind: "unknown" })]), NOW, full), undefined);
  });
});

describe("actionableStage — flag on prefers the gated stage", () => {
  const full = ctx({ allowlistMinting: true, openseaApiKey: true });

  it("takes an open allowlist stage over an open public stage", () => {
    // Cheaper, usually capped, and the public stage is still there afterwards.
    const publicRow = row({ kind: "public", source: "on-chain" });
    const allow = row({ kind: "allowlist" });
    assert.equal(actionableStage(table([publicRow, allow]), NOW, full), allow);
  });

  it("ranks GTD above allowlist above FCFS above public", () => {
    const rows = [row({ kind: "public" }), row({ kind: "fcfs" }), row({ kind: "allowlist" }), row({ kind: "gtd" })];
    assert.equal(actionableStage(table(rows), NOW, full)!.kind, "gtd");
  });

  it("does not depend on the order the rows arrive in", () => {
    const a = [row({ kind: "public" }), row({ kind: "gtd" })];
    const b = [row({ kind: "gtd" }), row({ kind: "public" })];
    assert.equal(actionableStage(table(a), NOW, full)!.kind, actionableStage(table(b), NOW, full)!.kind);
  });

  it("falls back to public when the gated stage has ended", () => {
    const publicRow = row({ kind: "public", source: "on-chain" });
    const ended = row({ kind: "gtd", status: "ended", startMs: NOW - 5 * HOUR, endMs: NOW - HOUR });
    assert.equal(actionableStage(table([ended, publicRow]), NOW, full), publicRow);
  });

  it("prefers a live stage to an earlier-starting upcoming one", () => {
    const live = row({ kind: "public", source: "on-chain" });
    const upcoming = row({ kind: "gtd", status: "upcoming", startMs: NOW + HOUR, endMs: NOW + 2 * HOUR });
    assert.equal(actionableStage(table([upcoming, live]), NOW, full), live);
  });

  it("takes the soonest upcoming stage when none is live", () => {
    const soon = row({ kind: "public", status: "upcoming", startMs: NOW + HOUR, endMs: 0 });
    const later = row({ kind: "gtd", status: "upcoming", startMs: NOW + 5 * HOUR, endMs: 0 });
    assert.equal(actionableStage(table([later, soon]), NOW, full), soon);
  });

  it("breaks a same-start tie on stage order, not arrival order", () => {
    const pub = row({ kind: "public", status: "upcoming", startMs: NOW + HOUR, endMs: 0 });
    const gtd = row({ kind: "gtd", status: "upcoming", startMs: NOW + HOUR, endMs: 0 });
    assert.equal(actionableStage(table([pub, gtd]), NOW, full), gtd);
    assert.equal(actionableStage(table([gtd, pub]), NOW, full), gtd);
  });

  it("skips an OpenSea stage when the key is missing and takes public instead", () => {
    const publicRow = row({ kind: "public", source: "on-chain" });
    const allow = row({ kind: "allowlist" });
    const noKey = ctx({ allowlistMinting: true });
    assert.equal(actionableStage(table([allow, publicRow]), NOW, noKey), publicRow);
  });

  it("routes a gated stage to the Merkle path when a root is configured", () => {
    const allow = row({ kind: "allowlist" });
    const merkle = ctx({ allowlistMinting: true, merkleProof: true });
    assert.equal(actionableStage(table([allow]), NOW, merkle, evidence({ merkleRoot: true })), allow);
  });
});

describe("stageContext", () => {
  // The builder both front ends go through. Its whole job is to make the CLI and
  // the bot incapable of disagreeing about whether a stage can be fired, so the
  // tests care about what it refuses to invent as much as what it passes along.
  const run = (over: Partial<MechanismEvidence> = {}) => ({
    evidence: { ...NO_EVIDENCE, ...over },
  });

  /** A run whose allow-list check actually ran, with the given wallet verdicts. */
  const withReport = (
    results: WalletEligibility[],
    over: Partial<MechanismEvidence> = {},
    error: string | null = null,
  ) => ({ evidence: { ...NO_EVIDENCE, ...over }, eligibility: { origin: "./list.json", results, error } });

  const proven = (address: string): WalletEligibility => ({
    address,
    state: "eligible",
    mechanism: "merkle-allowlist",
    detail: "Proof verified against the on-chain root.",
    proof: ["0xaa", "0xbb"],
  });

  const rejected = (address: string): WalletEligibility => ({
    address,
    state: "ineligible",
    mechanism: "merkle-allowlist",
    detail: "This address is not in the allow-list.",
  });

  it("carries the operator's ALLOWLIST_MINTING decision through unchanged", () => {
    assert.equal(
      stageContext(run(), { allowlistMinting: true, openseaApiKey: false }).fire?.allowlistMinting,
      true,
    );
    assert.equal(
      stageContext(run(), { allowlistMinting: false, openseaApiKey: false }).fire?.allowlistMinting,
      false,
    );
  });

  it("reports the API key as a boolean, never the key", () => {
    const ctx = stageContext(run(), { allowlistMinting: true, openseaApiKey: true });
    assert.equal(ctx.fire?.openseaApiKey, true);
    assert.equal(typeof ctx.fire?.openseaApiKey, "boolean");
  });

  it("assumes no Merkle proof unless one was actually verified", () => {
    // The dangerous default is the other way round: a table claiming a proof
    // exists produces a "fireable" row for a stage that reverts at T-0.
    assert.equal(
      stageContext(run(), { allowlistMinting: true, openseaApiKey: true }).fire?.merkleProof,
      false,
    );
  });

  it("derives the proof flag from a wallet that was actually proven", () => {
    const ctx = stageContext(withReport([proven("0x1111111111111111111111111111111111111111")], { merkleRoot: true }), {
      allowlistMinting: true,
      openseaApiKey: false,
    });
    assert.equal(ctx.fire?.merkleProof, true);
  });

  it("does not count an eligible verdict that carries no proof", () => {
    // The flag means "we hold calldata for this", not "we think they are on the
    // list". An eligible row without a proof cannot be fired from, so claiming
    // otherwise would produce a fireable table row and a revert at T-0.
    const noProof: WalletEligibility = {
      address: "0x1111111111111111111111111111111111111111",
      state: "eligible",
      mechanism: "merkle-allowlist",
      detail: "Listed, but the proof could not be built.",
    };
    const ctx = stageContext(withReport([noProof], { merkleRoot: true }), {
      allowlistMinting: true,
      openseaApiKey: false,
    });
    assert.equal(ctx.fire?.merkleProof, false);
  });

  it("counts one proven wallet among many rejected ones", () => {
    // One eligible wallet is enough to make the stage fireable — the other
    // wallets simply do not fire at it.
    const ctx = stageContext(
      withReport(
        [
          rejected("0x2222222222222222222222222222222222222222"),
          proven("0x1111111111111111111111111111111111111111"),
          rejected("0x3333333333333333333333333333333333333333"),
        ],
        { merkleRoot: true },
      ),
      { allowlistMinting: true, openseaApiKey: false },
    );
    assert.equal(ctx.fire?.merkleProof, true);
  });

  it("passes the contract's own evidence through untouched", () => {
    const ctx = stageContext(run({ merkleRoot: true, localSigner: true }), {
      allowlistMinting: false,
      openseaApiKey: false,
    });
    assert.deepEqual(ctx.evidence, { merkleRoot: true, localSigner: true });
  });

  it("omits the eligibility map rather than inventing an empty one", () => {
    // An empty map and an absent map mean different things to the table: one is
    // "checked, nobody is eligible", the other is "not checked".
    const ctx = stageContext(run(), { allowlistMinting: true, openseaApiKey: true });
    assert.equal(ctx.eligibility, undefined);
    assert.equal("eligibility" in ctx, false);
  });

  it("summarises a computed report onto the Merkle row", () => {
    const ctx = stageContext(
      withReport([
        proven("0x1111111111111111111111111111111111111111"),
        proven("0x2222222222222222222222222222222222222222"),
      ]),
      { allowlistMinting: true, openseaApiKey: true },
    );
    assert.match(ctx.eligibility?.["merkle-allowlist"] ?? "", /all 2 eligible/);
  });

  it("does not round a mixed result up to eligible", () => {
    const ctx = stageContext(
      withReport([
        proven("0x1111111111111111111111111111111111111111"),
        rejected("0x2222222222222222222222222222222222222222"),
        rejected("0x3333333333333333333333333333333333333333"),
      ]),
      { allowlistMinting: true, openseaApiKey: true },
    );
    const cell = ctx.eligibility?.["merkle-allowlist"] ?? "";
    assert.match(cell, /1\/3 eligible/);
    assert.doesNotMatch(cell, /all/);
  });

  it("says the list was unusable rather than falling back to unknown", () => {
    // The operator configured a check that did not happen. Degrading this into
    // the same "—" an unconfigured run shows would hide a fixable mistake.
    const ctx = stageContext(
      { evidence: NO_EVIDENCE, eligibility: { origin: null, results: [], error: "Allow-list file not found: ./nope.json" } },
      { allowlistMinting: true, openseaApiKey: true },
    );
    assert.match(ctx.eligibility?.["merkle-allowlist"] ?? "", /unusable/);
    assert.match(ctx.eligibility?.["merkle-allowlist"] ?? "", /not found/);
  });

  it("grants no proof from a failed load", () => {
    const ctx = stageContext(
      { evidence: { merkleRoot: true, localSigner: false }, eligibility: { origin: null, results: [], error: "HTTP 500" } },
      { allowlistMinting: true, openseaApiKey: true },
    );
    assert.equal(ctx.fire?.merkleProof, false);
  });

  it("produces the conservative defaults when nothing is configured", () => {
    // Called with an empty deployment it must reproduce exactly the defaults the
    // table used before any of this was threaded through — no silent widening.
    const ctx = stageContext(run(), { allowlistMinting: false, openseaApiKey: false });
    assert.deepEqual(ctx.fire, PUBLIC_ONLY);
    assert.deepEqual(ctx.evidence, NO_EVIDENCE);
  });

  it("cannot make an intrinsically unfireable mechanism fireable", () => {
    // The invariant that matters: stageContext produces the FireContext that
    // canFire reads, and no combination of flags it sets can widen a mechanism
    // whose intrinsic fireUnattended is "no". team-reserved is one such: there
    // is no minter-callable path, so an all-permissive context is still "no".
    const ctx = stageContext(
      withReport([proven("0x1111111111111111111111111111111111111111")], {
        merkleRoot: true,
        localSigner: true,
      }),
      { allowlistMinting: true, openseaApiKey: true },
    );
    assert.ok(ctx.fire);
    assert.equal(canFire("team-reserved", ctx.fire).level, "no");
    assert.equal(canFire("unknown", ctx.fire).level, "no");
  });

  it("hands opensea-signed the API-key flag it needs to be fireable", () => {
    // The other half of the same contract: stageContext must not clamp a
    // mechanism that IS fireable. opensea-signed becomes fireable exactly when
    // OPENSEA_API_KEY is present (intern polls for the signature from T-60s);
    // pre-open SIGNING remains impossible, but that is preSign, not fireUnattended.
    const withKey = stageContext(run({ merkleRoot: false, localSigner: false }), {
      allowlistMinting: true,
      openseaApiKey: true,
    });
    assert.ok(withKey.fire);
    assert.equal(canFire("opensea-signed", withKey.fire).level, "yes");

    const withoutKey = stageContext(run({ merkleRoot: false, localSigner: false }), {
      allowlistMinting: true,
      openseaApiKey: false,
    });
    assert.ok(withoutKey.fire);
    assert.equal(canFire("opensea-signed", withoutKey.fire).level, "no");
  });
});
