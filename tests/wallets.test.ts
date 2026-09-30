// Wallet arithmetic, key handling, and redaction.
//
// `requiredBalance` and `redactKeys` are both small enough to look obviously
// correct, and both are the kind of thing that is quietly wrong for months. One
// decides whether a mint is attempted at all; the other decides whether a private
// key ends up in a Telegram chat.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { parseEther } from "ethers";
import { TelegramClient } from "../src/bot/api";
import {
  BalanceReport,
  LoadedWallet,
  affordableMaxFeeGwei,
  formatEth,
  gweiToWei,
  loadWallets,
  markPublicHash,
  pairByAddress,
  priceCeilingRefusal,
  redactKeys,
  registerSecret,
  requiredBalance,
  resetRedactionRegistry,
  selectWallets,
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

describe("priceCeilingRefusal", () => {
  const eth = (n: string) => parseEther(n);

  it("allows a mint priced exactly at the ceiling", () => {
    // The boundary belongs to the operator. "No more than 0.05" permits 0.05,
    // and a ceiling that refuses the number written on it would be read as a
    // bug and raised until it stopped complaining.
    const refusal = priceCeilingRefusal({
      value: eth("0.05"),
      quantity: 1,
      ceilingPerNftWei: eth("0.05"),
    });
    assert.equal(refusal, null);
  });

  it("refuses a single wei over", () => {
    const refusal = priceCeilingRefusal({
      value: eth("0.05") + 1n,
      quantity: 1,
      ceilingPerNftWei: eth("0.05"),
    });
    assert.ok(refusal, "one wei over the ceiling is over the ceiling");
  });

  it("scales with quantity, because the ceiling is per NFT", () => {
    // The whole reason the setting is per NFT: it keeps its meaning when
    // QUANTITY changes. A total would tighten five-fold behind the operator's
    // back and teach them to raise it until it stopped refusing.
    const ceiling = eth("0.01");
    assert.equal(
      priceCeilingRefusal({ value: eth("0.03"), quantity: 3, ceilingPerNftWei: ceiling }),
      null,
      "three at the ceiling price is three times the ceiling",
    );
    assert.ok(
      priceCeilingRefusal({ value: eth("0.033"), quantity: 3, ceilingPerNftWei: ceiling }),
      "and a tenth more each is refused",
    );
  });

  it("treats a ceiling of zero as free-mints-only, not as unset", () => {
    // The truthiness trap: `!0n` is true, so a ceiling of zero read with a
    // falsy check disappears entirely — and it disappears for the operator who
    // asked for the strictest possible limit.
    assert.equal(
      priceCeilingRefusal({ value: 0n, quantity: 1, ceilingPerNftWei: 0n }),
      null,
      "a free mint is within a ceiling of zero",
    );
    assert.ok(
      priceCeilingRefusal({ value: 1n, quantity: 1, ceilingPerNftWei: 0n }),
      "and one wei is not",
    );
  });

  it("imposes no ceiling when none was configured", () => {
    assert.equal(
      priceCeilingRefusal({ value: eth("1000"), quantity: 1, ceilingPerNftWei: null }),
      null,
    );
  });

  it("states what it would have spent and what the limit was", () => {
    // An operator reading this at 3am needs both numbers to decide whether the
    // ceiling is wrong or the drop is. Neither number alone answers that.
    const refusal = priceCeilingRefusal({
      value: eth("0.6"),
      quantity: 3,
      ceilingPerNftWei: eth("0.05"),
    });
    assert.ok(refusal);
    assert.match(refusal, /0\.6 ETH/, "the total it would have spent");
    assert.match(refusal, /0\.2 ETH × 3/, "broken down per NFT");
    assert.match(refusal, /0\.05 ETH/, "the ceiling that was set");
    assert.match(refusal, /0\.15 ETH/, "and what that ceiling allowed in total");
    assert.match(refusal, /MAX_PRICE_PER_NFT/, "named so it can be changed");
    assert.match(refusal, /Nothing was signed/, "and says what did not happen");
  });

  it("omits the per-NFT figure rather than printing a rounded one", () => {
    // 10 wei over 3 is not a number of wei. Printing a truncated per-NFT price
    // beside the true total would put one false figure in a message whose only
    // job is to say what something costs.
    const refusal = priceCeilingRefusal({ value: 10n, quantity: 3, ceilingPerNftWei: 1n });
    assert.ok(refusal);
    assert.ok(!refusal.includes("×"), "no breakdown when it does not divide exactly");
  });

  it("refuses rather than permits when the quantity is nonsense", () => {
    // Defence in depth: QUANTITY is parsed strictly elsewhere. If that ever
    // fails open, a ceiling that multiplies by zero must not turn into a
    // limitless budget.
    assert.ok(priceCeilingRefusal({ value: 1n, quantity: 0, ceilingPerNftWei: eth("1") }));
    assert.ok(priceCeilingRefusal({ value: 1n, quantity: -5, ceilingPerNftWei: eth("1") }));
  });

  it("uses the chain's own symbol", () => {
    const refusal = priceCeilingRefusal({
      value: eth("2"),
      quantity: 1,
      ceilingPerNftWei: eth("1"),
      symbol: "POL",
    });
    assert.ok(refusal);
    assert.match(refusal, /POL/);
    assert.ok(!refusal.includes("ETH"), "naming the wrong currency misstates the amount");
  });
});

describe("every path that signs is behind the price ceiling", () => {
  // A correct gate that a signing path forgets to call is not a gate. This is
  // the check that survives someone adding a third path in a new file, which is
  // exactly when the omission would be easiest to miss and most expensive.
  // Two levels up, not one: tests run from dist-tests/tests, and the point is to
  // read the TypeScript source rather than the build output beside it.
  const SRC = path.resolve(__dirname, "..", "..", "src");

  const tsFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return tsFiles(full);
      return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
    });

  it("calls priceCeilingRefusal before signTransaction, in every file that signs", () => {
    const signing = tsFiles(SRC)
      .map((file) => ({ file, text: fs.readFileSync(file, "utf8") }))
      .filter(({ text }) => text.includes("signTransaction("));

    assert.ok(signing.length > 0, "the search itself must not silently find nothing");

    for (const { file, text } of signing) {
      const where = path.relative(SRC, file);
      const gate = text.indexOf("priceCeilingRefusal(");
      const sign = text.indexOf("signTransaction(");
      assert.notEqual(gate, -1, `${where} signs without calling the price ceiling`);
      assert.ok(gate < sign, `${where} calls the price ceiling after it has already signed`);
    }
  });
});

describe("selectWallets", () => {
  // The spec an operator types is the last place their intent is stated before
  // keys start signing. Every case below is one where a lenient reading would
  // produce a run that looks successful and used the wrong wallets.

  const set = (count: number): LoadedWallet[] =>
    Array.from({ length: count }, (_, i) => ({
      index: i,
      address: `0x${String(i).repeat(40)}`,
      key: `0x${"0".repeat(63)}${i + 1}`,
    }));

  const picked = (wallets: LoadedWallet[]): number[] => wallets.map((w) => w.index);

  it("selects every wallet when no spec is given", () => {
    // The default has to be the behaviour that existed before selection did,
    // or adding this feature silently changes what an unchanged command does.
    for (const spec of [undefined, null, "", "   "]) {
      assert.deepEqual(picked(selectWallets(set(3), spec)), [0, 1, 2], String(spec));
    }
  });

  it("selects every wallet for 'all', in any case", () => {
    for (const spec of ["all", "ALL", " All "]) {
      assert.deepEqual(picked(selectWallets(set(3), spec)), [0, 1, 2], spec);
    }
  });

  it("counts from zero, because that is what the panel prints", () => {
    // loadWallets numbers from zero and every display says W0. A one-based spec
    // would read naturally and pick the wrong key every time, so this is pinned
    // rather than left to the reader of the parser.
    assert.deepEqual(picked(selectWallets(set(3), "0")), [0]);
    assert.deepEqual(picked(selectWallets(set(3), "2")), [2]);
  });

  it("takes a list and a range, together and apart", () => {
    assert.deepEqual(picked(selectWallets(set(5), "0,2")), [0, 2]);
    assert.deepEqual(picked(selectWallets(set(5), "1-3")), [1, 2, 3]);
    assert.deepEqual(picked(selectWallets(set(5), "0,2-4")), [0, 2, 3, 4]);
    assert.deepEqual(picked(selectWallets(set(5), " 0 , 2 - 3 ")), [0, 2, 3]);
  });

  it("returns loaded order however the spec was written, and collapses repeats", () => {
    // Order would otherwise be a silent second meaning of the spec, and nonce
    // allocation is by index. `2,0` and `0,2` must be the same run.
    assert.deepEqual(picked(selectWallets(set(3), "2,0")), [0, 2]);
    assert.deepEqual(picked(selectWallets(set(3), "1,1,1")), [1]);
    assert.deepEqual(picked(selectWallets(set(4), "1-3,2")), [1, 2, 3]);
  });

  it("returns the wallets themselves, not just their indexes", () => {
    const wallets = set(3);
    const chosen = selectWallets(wallets, "1");
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0]!.address, wallets[1]!.address);
    assert.equal(chosen[0]!.key, wallets[1]!.key);
  });

  it("refuses an index that is not loaded rather than skipping it", () => {
    // The failure this prevents: an operator names five wallets, one index is a
    // typo, four sign, and the run reports success. Nothing in that output says
    // the fifth never took part.
    assert.throws(
      () => selectWallets(set(3), "0,5"),
      (err: unknown) => err instanceof Error && /W5/.test(err.message),
    );
  });

  it("says which wallets are loaded when it refuses one that is not", () => {
    assert.throws(
      () => selectWallets(set(3), "7"),
      (err: unknown) => err instanceof Error && /W0, W1, W2/.test(err.message),
    );
    assert.throws(
      () => selectWallets([], "0"),
      (err: unknown) => err instanceof Error && /No wallets are loaded at all/.test(err.message),
    );
  });

  it("refuses a backwards range rather than quietly reversing it", () => {
    assert.throws(
      () => selectWallets(set(5), "3-1"),
      (err: unknown) => err instanceof Error && /backwards/.test(err.message),
    );
  });

  it("refuses anything it cannot read as an index", () => {
    // 0x2 and 1e1 are both numbers to JavaScript and neither means what it looks
    // like — the same reasoning already applied to QUANTITY and MAX_PRICE_PER_NFT.
    for (const spec of ["0x2", "1e1", "abc", "-1", "1.0", "0,", ",0", "0,,1", "1--2", "0 1"]) {
      assert.throws(() => selectWallets(set(5), spec), (err: unknown) => err instanceof Error, spec);
    }
  });

  it("never returns an empty selection", () => {
    // A run with no wallets signs nothing, broadcasts nothing, and reports
    // success. There is no spec that may produce it.
    for (const spec of ["0", "all", "0-2", "1,2"]) {
      assert.ok(selectWallets(set(3), spec).length > 0, spec);
    }
  });

  it("does not let the caller mutate the loaded set through the result", () => {
    // Both select-everything paths, not one. They are separate returns, and a
    // test that exercises only "all" leaves the blank-spec path — the one every
    // caller that passes nothing takes — free to hand back the live array.
    for (const spec of [undefined, "all"] as const) {
      const wallets = set(3);
      selectWallets(wallets, spec).length = 0;
      assert.equal(wallets.length, 3, `${String(spec)} must copy, not alias`);
    }
  });
});

describe("the wallets asked about are the wallets that sign", () => {
  // `walletAddresses` decides who eligibility, the stage table and the allowlist
  // proof get resolved for. When it drifts from the set that actually signs, the
  // run answers every question about the wrong wallets and still reports success.
  // That is not hypothetical: the mint command resolved eligibility for the .env
  // addresses while a key pasted at the prompt did the signing, and with .env
  // empty it asked about nobody at all.
  //
  // A file-scoped version of this check was tried first and was not worth having.
  // Both "the selection" and "the config's wallets" are legitimately named in the
  // one function — the first builds the second — so merely proving the receiver
  // is *a* signing set somewhere passes for either. The invariant with teeth is
  // narrower: within one flow, the set handed to prepare and the set handed to
  // the run must be the same expression. Matching each run call to the nearest
  // preceding walletAddresses is a heuristic, and the right one here, because
  // preparing always precedes running in each of these flows.

  const SRC = path.resolve(__dirname, "..", "..", "src");

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
    });

  /** The `wallets:` value of the call object starting at `from`, shorthand included. */
  const signingSet = (text: string, from: number): string | null => {
    const window = text.slice(from, from + 3000);
    const named = /\bwallets:\s*([A-Za-z_$][\w.$]*)/.exec(window);
    const shorthand = /^\s*wallets,\s*$/m.exec(window);
    if (named && (!shorthand || named.index <= shorthand.index)) return named[1]!;
    return shorthand ? "wallets" : null;
  };

  it("hands the run the same wallet set it handed the prepare", () => {
    let checked = 0;
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      const where = path.relative(SRC, file);
      for (const call of text.matchAll(/\b(runMint|runAllowlistMint)\(/g)) {
        const before = text.slice(0, call.index);
        const asked = [...before.matchAll(/walletAddresses:\s*([A-Za-z_$][\w.$]*)\.map/g)].pop();
        if (!asked) continue; // a run with no prepare above it has nothing to compare
        // A call handing over a pre-armed set is exempt, and deliberately so. Its
        // wallets are the same selection with nonces attached, so the names
        // legitimately differ — and `assertPreArmCovers` already refuses a
        // pre-arm that does not cover every wallet about to mint, per address
        // rather than per identifier. That is a strictly stronger check than
        // matching a variable name, so requiring the name too would only force
        // the exemption to be written somewhere less obvious.
        if (/\bprearmed[,:]/.test(text.slice(call.index, call.index + 3000))) continue;
        const signs = signingSet(text, call.index);
        assert.notEqual(signs, null, `${where}: ${call[1]!} passes no wallets at all`);
        checked++;
        assert.equal(
          asked[1]!,
          signs,
          `${where}: ${call[1]!} signs with \`${signs}\` but eligibility was resolved for \`${asked[1]!}\``,
        );
      }
    }
    assert.ok(checked > 0, "the search itself must not silently find nothing");
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

  it("redacts every token the client is willing to connect with", () => {
    // The invariant, rather than a sample. The redactor used to stop at a
    // ten-digit id while TelegramClient accepted twelve, so an eleven-digit
    // token was one this process would authenticate with and then print in full
    // in every transport error. Whatever the validator admits, this must hide —
    // and Telegram bot ids are user ids, which only get longer.
    const secret = "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
    let accepted = 0;
    for (let digits = 4; digits <= 16; digits++) {
      const token = `${"1".repeat(digits)}:${secret}`;
      let valid = true;
      try {
        new TelegramClient(token);
      } catch {
        valid = false;
      }
      if (!valid) continue;
      accepted++;
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      assert.ok(
        !redactKeys(`connect ECONNREFUSED ${url}`).includes(secret),
        `a ${digits}-digit bot id is accepted by TelegramClient but survives redaction`,
      );
    }
    assert.ok(accepted >= 5, "the sweep actually exercised some valid tokens");
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
