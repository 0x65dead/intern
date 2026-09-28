// Wallet arithmetic, key handling, and redaction.
//
// `requiredBalance` and `redactKeys` are both small enough to look obviously
// correct, and both are the kind of thing that is quietly wrong for months. One
// decides whether a mint is attempted at all; the other decides whether a private
// key ends up in a Telegram chat.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  BalanceReport,
  LoadedWallet,
  affordableMaxFeeGwei,
  formatEth,
  gweiToWei,
  loadWallets,
  markPublicHash,
  pairByAddress,
  redactKeys,
  registerSecret,
  requiredBalance,
  resetRedactionRegistry,
  splitByFunding,
  suggestMaxFee,
  weiToGwei,
} from "../src/core/wallets";

// Deterministic throwaway keys. Never funded, never used anywhere.
const KEY_A = "0x0000000000000000000000000000000000000000000000000000000000000001";
const KEY_B = "0x0000000000000000000000000000000000000000000000000000000000000002";

describe("requiredBalance", () => {
  it("reserves the full gas ceiling, not the expected gas cost", () => {
    // This is what the *node* reserves before it will accept the transaction.
    // Budgeting the likely cost instead produces "insufficient funds" at the one
    // moment it cannot be fixed.
    const required = requiredBalance(10n ** 16n, {
      maxFeePerGas: gweiToWei(0.05),
      maxPriorityFeePerGas: gweiToWei(0.001),
      gasLimit: 250_000n,
    });
    assert.equal(required, 10n ** 16n + 250_000n * gweiToWei(0.05));
  });

  it("is the gas reservation alone for a free mint", () => {
    const gas = {
      maxFeePerGas: gweiToWei(1),
      maxPriorityFeePerGas: 0n,
      gasLimit: 100_000n,
    };
    assert.equal(requiredBalance(0n, gas), 100_000n * gweiToWei(1));
  });
});

describe("suggestMaxFee", () => {
  it("leaves room for the base fee to climb", () => {
    // Base fee can rise 12.5% per block. 2× base covers roughly six blocks of
    // sustained increase, which is the span that matters during a mint.
    const base = gweiToWei(10);
    const tip = gweiToWei(1);
    assert.equal(suggestMaxFee(base, tip), base * 2n + tip);
  });
});

describe("affordableMaxFeeGwei", () => {
  it("reports what a balance can actually cover per unit of gas", () => {
    const balance = gweiToWei(1) * 250_000n; // exactly 1 gwei/gas at this limit
    const result = affordableMaxFeeGwei(balance, 0n, 250_000n);
    assert.ok(Math.abs(result - 1) < 1e-9, `expected ~1 gwei, got ${result}`);
  });

  it("returns zero when the mint price alone exhausts the balance", () => {
    assert.equal(affordableMaxFeeGwei(100n, 100n, 250_000n), 0);
    assert.equal(affordableMaxFeeGwei(50n, 100n, 250_000n), 0);
  });
});

describe("gwei conversion", () => {
  it("round-trips", () => {
    assert.equal(gweiToWei(1), 1_000_000_000n);
    assert.equal(weiToGwei(1_000_000_000n), 1);
    assert.equal(gweiToWei(0.001), 1_000_000n);
  });
});

describe("formatEth", () => {
  it("labels the chain's own currency rather than assuming ETH", () => {
    assert.match(formatEth(10n ** 18n, "POL"), /POL/);
    assert.match(formatEth(10n ** 18n, "ETH"), /^1\b/);
  });

  it("does not round a small amount away to zero", () => {
    // "0 ETH" for a nonzero balance reads as "free" and is how people mint
    // believing they have spent nothing.
    const formatted = formatEth(10n ** 12n, "ETH");
    assert.ok(!/^0 /.test(formatted), `small amount rendered as ${formatted}`);
  });
});

describe("loadWallets", () => {
  it("accepts keys with and without the 0x prefix", () => {
    const withPrefix = loadWallets([KEY_A]);
    const without = loadWallets([KEY_A.slice(2)]);
    assert.equal(withPrefix.length, 1);
    assert.equal(withPrefix[0]!.address, without[0]!.address);
  });

  it("numbers wallets in the order given, so W0 means the first key", () => {
    const wallets = loadWallets([KEY_A, KEY_B]);
    assert.equal(wallets[0]!.index, 0);
    assert.equal(wallets[1]!.index, 1);
    assert.notEqual(wallets[0]!.address, wallets[1]!.address);
  });

  it("drops duplicates, which would collide on the same nonce", () => {
    // Two copies of one key are one wallet. Signing twice from the same nonce
    // means one transaction is discarded by the network with no error shown.
    const wallets = loadWallets([KEY_A, KEY_A, KEY_B]);
    assert.equal(wallets.length, 2);
  });

  it("ignores blank entries from a trailing comma or newline", () => {
    assert.equal(loadWallets(["", "  ", KEY_A]).length, 1);
  });

  it("refuses a malformed key without putting it in the message", () => {
    // The error text is shown to the user and may be logged; a key fragment in it
    // defeats the point of hiding the input in the first place.
    const bad = "0xnot-a-key";
    assert.throws(
      () => loadWallets([bad]),
      (err: unknown) => err instanceof Error && !err.message.includes("not-a-key"),
    );
  });
});

describe("redactKeys", () => {
  it("removes a 0x-prefixed private key from text", () => {
    const leaked = `failed to sign with ${KEY_A}`;
    const safe = redactKeys(leaked);
    assert.ok(!safe.includes(KEY_A), `key survived redaction: ${safe}`);
  });

  it("removes a bare 64-hex key with no prefix", () => {
    const safe = redactKeys(`key=${KEY_A.slice(2)}`);
    assert.ok(!safe.includes(KEY_A.slice(2)), `key survived redaction: ${safe}`);
  });

  it("leaves addresses alone", () => {
    // Over-redacting makes error messages useless. An address is 40 hex
    // characters, well short of the 64 a key needs, so shape alone settles it.
    //
    // This test used to be named "leaves addresses and transaction hashes alone"
    // while asserting only the address. A tx hash is 64 hex characters — exactly
    // a key's shape — and was in fact being redacted; see the "transaction
    // hashes" suite below for the coverage the old name claimed.
    const address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    assert.ok(redactKeys(`sent from ${address}`).includes(address));
  });

  it("redacts a bot token", () => {
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
    assert.ok(!redactKeys(`token ${token} rejected`).includes(token));
  });

  it("redacts a bot token inside its own API URL", () => {
    // The form the token actually leaks in. Every Telegram call puts it in the
    // path, so every transport error quotes it — and a `\b` before the digits
    // does not hold after the `t` of `/bot`, so this used to pass through.
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
    const err = `connect ECONNREFUSED https://api.telegram.org/bot${token}/sendMessage`;
    const safe = redactKeys(err);
    assert.ok(!safe.includes(token), `token survived redaction: ${safe}`);
    // The rest of the message has to survive, or the operator cannot tell a DNS
    // failure from a refused connection.
    assert.match(safe, /ECONNREFUSED/);
    assert.match(safe, /sendMessage/);
  });

  it("does not start a token match partway through a longer number", () => {
    // What the `\b` was there for. A block height is not a token.
    assert.equal(redactKeys("block 1234567890 mined"), "block 1234567890 mined");
  });

  it("redacts a key with a stray hex character appended", () => {
    // The pattern matches 64 hex characters *or more*. An anchored exactly-64
    // pattern cannot match inside a longer run, so a key with one extra character
    // on the end used to pass straight through.
    const safe = redactKeys(`k=${KEY_A}f`);
    assert.ok(!safe.includes(KEY_A), `key survived redaction: ${safe}`);
  });

  it("redacts two keys concatenated with no separator", () => {
    const safe = redactKeys(`${KEY_A}${KEY_A.slice(2)}`);
    assert.ok(!safe.includes(KEY_A.slice(2)), `key survived redaction: ${safe}`);
  });
});

// A mnemonic spends exactly as well as a private key, and none of the hex
// patterns above sees one. CAPABILITY.md states that a mnemonic reaching output
// is a P0 bug; these are the tests that claim is standing on.
//
// The phrase used is Hardhat's published test mnemonic — famously public, funded
// nowhere, and safe to commit.
describe("redactKeys — seed phrases", () => {
  const TWELVE = "test test test test test test test test test test test junk";

  it("removes a twelve-word seed phrase", () => {
    const safe = redactKeys(`recovered with ${TWELVE}`);
    assert.ok(!safe.includes("junk"), `mnemonic survived redaction: ${safe}`);
    assert.match(safe, /redacted-mnemonic/);
  });

  it("removes a twenty-four-word seed phrase as one run", () => {
    const safe = redactKeys(`${TWELVE} ${TWELVE}`);
    assert.equal(safe.trim(), "\u27E8redacted-mnemonic\u27E9");
  });

  it("leaves eleven consecutive wordlist hits alone", () => {
    // The threshold is the shortest phrase BIP-39 defines. Below it, a run is
    // prose that happens to use short words — `only`, `test` and `junk` are all
    // in the wordlist, so a lower threshold would start eating error messages.
    const eleven = "test test test test test test test test test test junk";
    assert.ok(redactKeys(`keys: ${eleven} here`).includes(eleven));
  });

  it("does not join a run across punctuation", () => {
    // A seed phrase is words and blanks. Allowing commas would let ordinary
    // prose — and comma-separated lists especially — accumulate a false positive.
    const commas = TWELVE.split(" ").join(", ");
    assert.ok(redactKeys(commas).includes(commas));
  });

  it("leaves this codebase's own prose untouched", () => {
    // Over-redaction is its own failure: an error message with a hole in it is
    // one the operator cannot act on. These are real lines from src/core.
    for (const line of [
      "Never echo key material. ethers embeds the offending value in some of its own error messages.",
      "A node reserves value + gasLimit x maxFeePerGas up front and rejects the transaction outright.",
      "Balance checks must model what the node requires, not what the mint costs.",
    ]) {
      assert.equal(redactKeys(line), line);
    }
  });
});

/**
 * A transaction hash and a private key are both 32 bytes of hex, so the redactor
 * cannot tell them apart by looking. It used to hide both, which cost the
 * operator the one string they need to check a mint on an explorer — and, because
 * `explorerTx` embeds the hash in an `<a href>`, produced a URL containing `⟨⟩`
 * that Telegram rejects with a 400, taking the entire result panel down with it.
 *
 * The rule now is knowledge, not shape: a hash this process derived from a
 * transaction it signed is publishable, anything else key-shaped is not.
 */
describe("redactKeys — transaction hashes", () => {
  const HASH = `0x${"b6".repeat(32)}`;

  beforeEach(() => {
    resetRedactionRegistry();
  });

  it("shows a hash this process derived", () => {
    markPublicHash(HASH);
    assert.equal(redactKeys(`mined ${HASH}`), `mined ${HASH}`);
  });

  it("keeps an explorer link usable", () => {
    // The failure this guards is not a cosmetic one: Telegram 400s on a URL
    // containing the replacement's angle brackets, so the whole message is lost.
    markPublicHash(HASH);
    const link = `https://etherscan.io/tx/${HASH}`;
    assert.equal(redactKeys(link), link);
  });

  it("recognises a marked hash whatever its case", () => {
    markPublicHash(HASH);
    const shouted = HASH.toUpperCase();
    assert.ok(redactKeys(`tx ${shouted}`).includes(shouted));
  });

  it("marks a hash given without the 0x prefix", () => {
    markPublicHash(HASH.slice(2));
    assert.ok(redactKeys(`tx ${HASH}`).includes(HASH));
  });

  it("returns the hash unchanged so it can be marked inline", () => {
    assert.equal(markPublicHash(HASH), HASH);
  });

  it("still redacts a 64-hex value nothing vouched for", () => {
    // The fail-safe direction. A hash nobody claimed may be a key, and the two
    // mistakes are not equally bad: a hidden hash is an inconvenience, a printed
    // key is a stolen wallet.
    const unknown = `0x${"ab".repeat(32)}`;
    assert.equal(redactKeys(`stray ${unknown}`), "stray 0x⟨redacted-key⟩");
  });

  it("does not extend an exemption to a longer hex run", () => {
    // 65 hex characters is not the hash that was marked, and may be a key with a
    // stray character appended. Exemptions are recorded at exactly 64.
    markPublicHash(HASH);
    assert.equal(redactKeys(`${HASH}f`), "0x⟨redacted-key⟩");
  });

  it("refuses to exempt a value registered as a secret", () => {
    // The laundering path: a resume journal is read off disk, and its hashes are
    // marked on the way in. A tampered journal must not be able to name a key
    // there and have it printed.
    const key = `0x${"11".repeat(32)}`;
    registerSecret(key);
    markPublicHash(key);
    assert.equal(redactKeys(`key is ${key}`), "key is 0x⟨redacted-key⟩");
  });

  it("ignores values that are not hash-shaped", () => {
    assert.equal(markPublicHash("not a hash"), "not a hash");
    assert.equal(redactKeys("not a hash"), "not a hash");
  });

  it("bounds the exemption list, evicting oldest first", () => {
    // A long-lived bot broadcasts indefinitely. An unbounded exemption list is a
    // slow leak, so the cap is real — and this proves the eviction happens
    // rather than the cap being decoration.
    const nth = (i: number) => `0x${i.toString(16).padStart(64, "0")}`;
    markPublicHash(HASH);
    for (let i = 1; i <= 4096; i += 1) markPublicHash(nth(i));
    assert.equal(redactKeys(HASH), "0x⟨redacted-key⟩", "oldest should be evicted");
    assert.ok(redactKeys(nth(4096)).includes(nth(4096).slice(2)), "newest should remain");
  });

  it("registers a loaded private key as a secret", () => {
    const key = `0x${"22".repeat(32)}`;
    loadWallets([key]);
    markPublicHash(key); // even an explicit claim does not help
    assert.equal(redactKeys(`key ${key}`), "key 0x⟨redacted-key⟩");
  });
});

// ── Pairing per-wallet results with the wallets they describe ────────────────
//
// These read as plumbing tests, and the reason they are worth writing is that
// the bug they pin was live and silent. checkBalances and fetchNonces both
// answer positionally; the engine indexed them by the wallet's *global* index.
// Those agree only for the full wallet set starting at zero, and disagree for
// every subset — which is precisely what per-task wallet selection produces.
//
// The insufficient-balance gate then failed OPEN: `balances[5]` was undefined,
// `undefined?.sufficient !== false` is true, and a wallet nobody had checked
// was signed for and broadcast. So the cases below are mostly about subsets and
// about what happens when a report is missing entirely.

const wallet = (index: number, byte: string): LoadedWallet => ({
  index,
  address: `0x${byte.repeat(20)}`,
  key: `0x${byte.repeat(32)}`,
});

const report = (address: string, sufficient: boolean): BalanceReport => ({
  index: 0,
  address,
  balance: sufficient ? 10n ** 18n : 1n,
  sufficient,
  shortfall: sufficient ? 0n : 10n ** 18n - 1n,
});

describe("splitByFunding", () => {
  it("clears a funded wallet and blocks an underfunded one", () => {
    const a = wallet(0, "aa");
    const b = wallet(1, "bb");
    const split = splitByFunding([a, b], [report(a.address, true), report(b.address, false)]);
    assert.deepEqual(split.funded, [a]);
    assert.deepEqual(split.blocked, [{ wallet: b, verified: true }]);
  });

  it("pairs by address when the wallets are a subset with non-zero indexes", () => {
    // The regression. These wallets are #2 and #5 of a larger set, so the
    // positional arrays have two elements while the indexes are 2 and 5.
    // Subscripting by index would read past the end of both.
    const third = wallet(2, "33");
    const sixth = wallet(5, "66");
    const split = splitByFunding(
      [third, sixth],
      [report(third.address, true), report(sixth.address, false)],
    );
    assert.deepEqual(split.funded, [third], "the funded subset wallet must still clear");
    assert.deepEqual(
      split.blocked,
      [{ wallet: sixth, verified: true }],
      "the underfunded subset wallet must still be blocked, not silently passed",
    );
  });

  it("is unaffected by the order the reports arrive in", () => {
    const a = wallet(0, "aa");
    const b = wallet(1, "bb");
    const split = splitByFunding([a, b], [report(b.address, false), report(a.address, true)]);
    assert.deepEqual(split.funded, [a]);
    assert.deepEqual(split.blocked, [{ wallet: b, verified: true }]);
  });

  it("blocks a wallet with no report rather than assuming it is funded", () => {
    // Fail closed. A missing report means the gate was never evaluated, and
    // "never evaluated" must not be read as "passed" — that was the original
    // bug's actual mechanism.
    const a = wallet(0, "aa");
    const orphan = wallet(1, "bb");
    const split = splitByFunding([a, orphan], [report(a.address, true)]);
    assert.deepEqual(split.funded, [a]);
    assert.deepEqual(split.blocked, [{ wallet: orphan, verified: false }]);
  });

  it("distinguishes 'underfunded' from 'never checked'", () => {
    // The two deserve different words in the operator's report: one is a wallet
    // to top up, the other is a bug to fix.
    const poor = wallet(0, "aa");
    const orphan = wallet(1, "bb");
    const split = splitByFunding([poor, orphan], [report(poor.address, false)]);
    assert.equal(split.blocked.find((b) => b.wallet === poor)?.verified, true);
    assert.equal(split.blocked.find((b) => b.wallet === orphan)?.verified, false);
  });

  it("matches addresses irrespective of checksum casing", () => {
    // checkBalances echoes the address it was given; a caller may have
    // checksummed one and not the other. A case-sensitive compare here would
    // look exactly like a missing report.
    const a = wallet(0, "aa");
    const shouted = { ...report(a.address.toUpperCase(), true) };
    assert.deepEqual(splitByFunding([a], [shouted]).funded, [a]);
  });

  it("treats an unreadable balance as sufficient, as checkBalances decided", () => {
    // Deliberate, and documented at checkBalances: a flaky RPC read must not
    // cost the mint. splitByFunding must not quietly reverse that call.
    const a = wallet(0, "aa");
    const unknown: BalanceReport = {
      index: 0,
      address: a.address,
      balance: null,
      sufficient: true,
      shortfall: 0n,
    };
    assert.deepEqual(splitByFunding([a], [unknown]).funded, [a]);
  });

  it("returns empty halves for no wallets", () => {
    assert.deepEqual(splitByFunding([], []), { funded: [], blocked: [] });
  });
});

describe("pairByAddress", () => {
  it("pairs each wallet with its own positional value", () => {
    const a = wallet(0, "aa");
    const b = wallet(1, "bb");
    const nonces = pairByAddress([a, b], [7, 12]);
    assert.equal(nonces.get(a.address.toLowerCase()), 7);
    assert.equal(nonces.get(b.address.toLowerCase()), 12);
  });

  it("pairs correctly for a subset whose indexes do not start at zero", () => {
    // fetchNonces returned two values for wallets #4 and #9. Indexing by 4 and 9
    // would miss both; the nonce lookup then threw, which was safe but wrong.
    const fifth = wallet(4, "44");
    const tenth = wallet(9, "99");
    const nonces = pairByAddress([fifth, tenth], [3, 0]);
    assert.equal(nonces.get(fifth.address.toLowerCase()), 3);
    assert.equal(nonces.get(tenth.address.toLowerCase()), 0);
  });

  it("omits a wallet the values ran out for rather than pairing undefined", () => {
    // An omitted entry makes the caller's `=== undefined` check fire. Storing an
    // explicit undefined would too, but it would also make `has()` lie.
    const a = wallet(0, "aa");
    const b = wallet(1, "bb");
    const nonces = pairByAddress([a, b], [7]);
    assert.equal(nonces.has(b.address.toLowerCase()), false);
    assert.equal(nonces.size, 1);
  });

  it("keeps a zero value, which is a legitimate nonce", () => {
    // A fresh wallet has nonce 0. Any truthiness test on the value would drop it
    // and the engine would report a missing nonce for a perfectly good wallet.
    const a = wallet(0, "aa");
    assert.equal(pairByAddress([a], [0]).get(a.address.toLowerCase()), 0);
  });
});
