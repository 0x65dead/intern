// A transaction hash must survive redaction, and a private key must not — even
// though the two are indistinguishable by shape.
//
// This file covers the wiring rather than the rule. `tests/wallets.test.ts`
// proves `markPublicHash` behaves; these tests prove the production code
// actually calls it. A correct redactor nobody tells about a hash is exactly as
// broken as no redactor at all, and the bug this guards against — every hash the
// bot reported coming out as `0x⟨redacted-key⟩`, and every explorer link turning
// into a URL Telegram 400s on — shipped with a green suite.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Wallet } from "ethers";

import { prepare } from "../src/core/blast";
import { newRunState, readState, recordIntent, writeState } from "../src/core/runstate";
import { redactKeys, resetRedactionRegistry } from "../src/core/wallets";

const KEY = `0x${"11".repeat(32)}`;

async function signedTx(): Promise<string> {
  const wallet = new Wallet(KEY);
  return wallet.signTransaction({
    to: wallet.address,
    value: 0n,
    chainId: 1,
    nonce: 0,
    gasLimit: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    type: 2,
  });
}

describe("transaction hashes survive redaction", () => {
  beforeEach(() => {
    resetRedactionRegistry();
  });

  it("prepare() vouches for the hash it derives", async () => {
    const { txHash } = prepare(await signedTx());
    assert.match(txHash, /^0x[a-f0-9]{64}$/);
    assert.equal(redactKeys(`broadcast ${txHash}`), `broadcast ${txHash}`);
  });

  it("the explorer link the bot sends stays a valid URL", async () => {
    const { txHash } = prepare(await signedTx());
    const href = `https://etherscan.io/tx/${txHash}`;
    // Not just "unchanged": assert no replacement character reached the href,
    // because that is the byte Telegram rejects.
    assert.equal(redactKeys(href), href);
    assert.doesNotMatch(redactKeys(href), /⟨/);
  });

  it("the signing key is still redacted on the same path", async () => {
    prepare(await signedTx());
    assert.equal(redactKeys(`key ${KEY}`), "key 0x⟨redacted-key⟩");
  });

  it("a hash recovered from the resume journal is shown, not hidden", async () => {
    // The crash-recovery report is the only record that a broadcast happened,
    // and the journal is deleted once it is delivered. A redacted hash there is
    // unrecoverable.
    const { txHash } = prepare(await signedTx());
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "intern-journal-")),
      "state.json",
    );
    const state = recordIntent(
      newRunState({
        runId: "r1",
        target: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        chainId: 1,
        startedAtMs: 0,
        wallets: [{ index: 0, address: new Wallet(KEY).address, nonce: 0 }],
      }),
      0,
      txHash,
    );
    writeState(state, file);

    // Simulate the restart: this process learned the hash from `prepare`, the
    // next one learns it only from the file.
    resetRedactionRegistry();
    const restored = readState(file);

    assert.ok(restored !== null);
    assert.equal(restored.wallets[0]?.txHash, txHash);
    assert.equal(redactKeys(`was mid-broadcast at ${txHash}`), `was mid-broadcast at ${txHash}`);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
