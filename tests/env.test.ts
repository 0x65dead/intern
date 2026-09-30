// Configuration parsing, for the settings that decide whether money moves.
//
// `ALLOWLIST_MINTING` and `DRY_RUN` are the two flags where a parsing mistake is
// expensive in opposite directions: one wrongly on fires at stages the operator
// never chose, the other wrongly on silently skips the broadcast at a mint they
// were counting on. So both are parsed strictly and both default to the safe
// answer — gated minting off, dry run off.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "ethers";
import { ConfigError, ENV_TEMPLATE, readDefaults } from "../src/util/env";

const BASE: NodeJS.ProcessEnv = {};

describe("ALLOWLIST_MINTING", () => {
  it("is off when unset — public-only is the default posture", () => {
    assert.equal(readDefaults(BASE).allowlistMinting, false);
  });

  it("accepts the unambiguous yeses", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", " On "]) {
      assert.equal(readDefaults({ ALLOWLIST_MINTING: value }).allowlistMinting, true, value);
    }
  });

  it("reads the explicit noes as off", () => {
    for (const value of ["0", "false", "no", "off", "FALSE", " Off "]) {
      assert.equal(readDefaults({ ALLOWLIST_MINTING: value }).allowlistMinting, false, value);
    }
  });

  it("treats saying nothing as off — public-only needs no opt-out", () => {
    for (const value of ["", "  "]) {
      assert.equal(readDefaults({ ALLOWLIST_MINTING: value }).allowlistMinting, false, value);
    }
  });

  it("refuses a value it cannot read rather than guessing at off", () => {
    // This used to answer "off", on the reasoning that a flag the operator
    // believed was on but silently was not costs a missed mint and no money.
    // True for this flag — and the same helper reads DRY_RUN, where guessing
    // "off" spends money. There is no direction that is safe for both, so the
    // parser stops choosing one.
    for (const value of ["maybe", "ture", "y", "n", "2"]) {
      assert.throws(
        () => readDefaults({ ALLOWLIST_MINTING: value }),
        (err: unknown) => err instanceof ConfigError && /ALLOWLIST_MINTING/.test(err.message),
        value,
      );
    }
  });
});

describe("DRY_RUN", () => {
  it("is off unless asked for", () => {
    assert.equal(readDefaults(BASE).dryRun, false);
    assert.equal(readDefaults({ DRY_RUN: "0" }).dryRun, false);
  });

  it("turns on for an unambiguous yes", () => {
    assert.equal(readDefaults({ DRY_RUN: "1" }).dryRun, true);
    for (const value of ["true", "yes", "on", "TRUE", " On "]) {
      assert.equal(readDefaults({ DRY_RUN: value }).dryRun, true, value);
    }
  });

  it("stays off for an explicit no", () => {
    for (const value of ["0", "false", "no", "off"]) {
      assert.equal(readDefaults({ DRY_RUN: value }).dryRun, false, value);
    }
  });

  it("refuses a typo instead of quietly minting for real", () => {
    // The flag exists to stop money moving. Read as "off", a misspelling hands
    // an operator who believed they were rehearsing a live mint — which is the
    // one transition that must never happen by accident.
    for (const value of ["ture", "flase", "yess", "enabled", "dry"]) {
      assert.throws(
        () => readDefaults({ DRY_RUN: value }),
        (err: unknown) => err instanceof ConfigError && /DRY_RUN/.test(err.message),
        value,
      );
    }
  });
});

describe("QUANTITY", () => {
  it("is one when unset or blank", () => {
    assert.equal(readDefaults(BASE).quantity, 1);
    assert.equal(readDefaults({ QUANTITY: "" }).quantity, 1);
    assert.equal(readDefaults({ QUANTITY: "  " }).quantity, 1);
  });

  it("takes a whole number", () => {
    assert.equal(readDefaults({ QUANTITY: "3" }).quantity, 3);
    assert.equal(readDefaults({ QUANTITY: " 12 " }).quantity, 12);
  });

  it("refuses zero rather than buying one", () => {
    // `Math.max(1, ...)` used to turn an operator who asked for nothing into an
    // operator who bought one. There is no safe guess at how much to spend.
    assert.throws(
      () => readDefaults({ QUANTITY: "0" }),
      (err: unknown) => err instanceof ConfigError && /QUANTITY/.test(err.message),
    );
  });

  it("refuses anything else it cannot spend against", () => {
    // Including the forms `Number()` would happily read as something far larger
    // than they look: 0x2 is 2, and 1e3 is a thousand mints.
    for (const value of ["-1", "abc", "1.5", "2.0", "1e400", "1e3", "NaN", "0x2", "+1", "1 000"]) {
      assert.throws(
        () => readDefaults({ QUANTITY: value }),
        (err: unknown) => err instanceof ConfigError,
        value,
      );
    }
  });
});

describe("MAX_PRICE_PER_NFT", () => {
  it("is null when unset or blank, meaning no ceiling", () => {
    assert.equal(readDefaults(BASE).maxPricePerNftWei, null);
    assert.equal(readDefaults({ MAX_PRICE_PER_NFT: "" }).maxPricePerNftWei, null);
    assert.equal(readDefaults({ MAX_PRICE_PER_NFT: "   " }).maxPricePerNftWei, null);
  });

  it("reads whole native currency and converts to wei", () => {
    // The unit is the one the drop is advertised in. Asking for wei would invite
    // an eighteen-digit typo in the setting whose whole job is catching a price
    // that is wrong by orders of magnitude.
    assert.equal(readDefaults({ MAX_PRICE_PER_NFT: "0.05" }).maxPricePerNftWei, parseEther("0.05"));
    assert.equal(readDefaults({ MAX_PRICE_PER_NFT: " 1 " }).maxPricePerNftWei, parseEther("1"));
    assert.equal(readDefaults({ MAX_PRICE_PER_NFT: "0.000000000000000001" }).maxPricePerNftWei, 1n);
  });

  it("keeps a ceiling of zero as zero, not as unset", () => {
    // An operator who writes 0 is asking for free mints only. Collapsing that to
    // null would silently lift the strictest ceiling on offer.
    assert.equal(readDefaults({ MAX_PRICE_PER_NFT: "0" }).maxPricePerNftWei, 0n);
    assert.equal(readDefaults({ MAX_PRICE_PER_NFT: "0.0" }).maxPricePerNftWei, 0n);
  });

  it("refuses a value it cannot read as a price", () => {
    // Same reasoning as QUANTITY, with more at stake: 1e3 and 0x2 are both
    // numbers to JavaScript and neither means what it looks like. A ceiling
    // silently a thousand times too high is not a ceiling.
    for (const value of ["1e3", "0x2", "abc", "-1", "0.05 ETH", "1,5", ".5", "1.", "+1", "1e-3"]) {
      assert.throws(
        () => readDefaults({ MAX_PRICE_PER_NFT: value }),
        (err: unknown) =>
          err instanceof ConfigError && /MAX_PRICE_PER_NFT/.test(err.message),
        value,
      );
    }
  });

  it("refuses an amount finer than wei rather than rounding it", () => {
    assert.throws(
      () => readDefaults({ MAX_PRICE_PER_NFT: "0.0000000000000000001" }),
      (err: unknown) => err instanceof ConfigError && /MAX_PRICE_PER_NFT/.test(err.message),
    );
  });

  it("is documented in the template it is read from", () => {
    assert.match(ENV_TEMPLATE, /MAX_PRICE_PER_NFT/);
  });
});

describe("timing settings", () => {
  it("floors the signature poll interval at 100ms", () => {
    // Below this the loop earns a 429, which costs more time than it saves.
    assert.equal(readDefaults({ SIGNATURE_POLL_MS: "10" }).signaturePollMs, 100);
    assert.equal(readDefaults({ SIGNATURE_POLL_MS: "-5" }).signaturePollMs, 100);
  });

  it("defaults the signature poll interval to 250ms", () => {
    assert.equal(readDefaults(BASE).signaturePollMs, 250);
    assert.equal(readDefaults({ SIGNATURE_POLL_MS: "nonsense" }).signaturePollMs, 250);
  });

  it("honours a wider poll interval", () => {
    assert.equal(readDefaults({ SIGNATURE_POLL_MS: "900" }).signaturePollMs, 900);
  });

  it("defaults the heartbeat to half an hour, and treats 0 as the off switch", () => {
    // 0 is preserved rather than floored to 1: without an off switch an operator
    // who does not want the message has no recourse but to remove their own id
    // from the allowlist, which would also stop them commanding the bot.
    assert.equal(readDefaults(BASE).heartbeatMinutes, 30);
    assert.equal(readDefaults({ HEARTBEAT_MINUTES: "0" }).heartbeatMinutes, 0);
    assert.equal(readDefaults({ HEARTBEAT_MINUTES: "-5" }).heartbeatMinutes, 0);
  });

  it("never lets a non-zero heartbeat become a notification stream", () => {
    assert.equal(readDefaults({ HEARTBEAT_MINUTES: "0.4" }).heartbeatMinutes, 0);
    assert.equal(readDefaults({ HEARTBEAT_MINUTES: "1.6" }).heartbeatMinutes, 1);
  });

  it("sends the heartbeat to the first allowed id unless told otherwise", () => {
    assert.equal(readDefaults(BASE).heartbeatChatId, null);
    assert.equal(readDefaults({ HEARTBEAT_CHAT_ID: "123" }).heartbeatChatId, 123);
    // Telegram group ids are negative, so a sign check would break groups.
    assert.equal(readDefaults({ HEARTBEAT_CHAT_ID: "-1001234567890" }).heartbeatChatId, -1001234567890);
    assert.equal(readDefaults({ HEARTBEAT_CHAT_ID: "nonsense" }).heartbeatChatId, null);
  });

  it("leaves the clock-drift limit unset rather than inventing one", () => {
    // null is not "no limit" — it is "not configured". An unattended run picks
    // its own default and enforces it; an interactive one keeps the guard
    // advisory, because the operator can see the measured offset and decide.
    assert.equal(readDefaults(BASE).clockDriftLimitMs, null);
    assert.equal(readDefaults({ CLOCK_DRIFT_LIMIT_MS: "500" }).clockDriftLimitMs, 500);
  });

  it("never lets the drift limit collapse to zero", () => {
    // A zero limit would refuse every mint: no measurement is exactly 0ms off.
    assert.equal(readDefaults({ CLOCK_DRIFT_LIMIT_MS: "0" }).clockDriftLimitMs, 100);
  });
});

describe("ALLOWLIST_SOURCE", () => {
  // The list is the only way a Merkle stage becomes fireable, so an operator who
  // sets this and gets silence has no way to tell a typo from a drop that simply
  // has no root. Reading it must be unambiguous.
  it("is null when unset", () => {
    assert.equal(readDefaults({}).allowlistSource, null);
  });

  it("is null when blank or whitespace", () => {
    assert.equal(readDefaults({ ALLOWLIST_SOURCE: "" }).allowlistSource, null);
    assert.equal(readDefaults({ ALLOWLIST_SOURCE: "   " }).allowlistSource, null);
  });

  it("keeps a path as given, trimmed", () => {
    assert.equal(readDefaults({ ALLOWLIST_SOURCE: "  ./allowlist.json " }).allowlistSource, "./allowlist.json");
  });

  it("keeps a URL and an ipfs:// spec intact", () => {
    assert.equal(
      readDefaults({ ALLOWLIST_SOURCE: "https://example.com/list.json" }).allowlistSource,
      "https://example.com/list.json",
    );
    assert.equal(readDefaults({ ALLOWLIST_SOURCE: "ipfs://QmAbc" }).allowlistSource, "ipfs://QmAbc");
  });

  it("is independent of ALLOWLIST_MINTING", () => {
    // Loading a list is a read; firing at the stage is a spend. Knowing whether
    // a wallet is eligible must not require arming the thing that spends money.
    const d = readDefaults({ ALLOWLIST_SOURCE: "./l.json" });
    assert.equal(d.allowlistSource, "./l.json");
    assert.equal(d.allowlistMinting, false);
  });
});

describe(".env.example documents what the parser actually reads", () => {
  // The failure this prevents: a setting is added to readDefaults, the template is
  // not updated, and an operator copying .env.example never learns the flag exists.
  // That is how ALLOWLIST_SOURCE and five safety settings went undocumented.
  //
  // The key list is not hand-maintained. readDefaults is called against a Proxy
  // that records every property read, so the test learns the true set from the
  // code and cannot fall behind it.
  function keysReadByParser(): string[] {
    const seen = new Set<string>();
    const spy = new Proxy(
      {},
      {
        get(_t, prop): undefined {
          if (typeof prop === "string") seen.add(prop);
          return undefined;
        },
        has(_t, prop): boolean {
          if (typeof prop === "string") seen.add(prop);
          return false;
        },
      },
    ) as NodeJS.ProcessEnv;
    readDefaults(spy);
    return [...seen].filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
  }

  it("mentions every environment variable readDefaults consults", () => {
    const template = ENV_TEMPLATE;
    const missing = keysReadByParser().filter((key) => !template.includes(key));
    assert.deepEqual(missing, [], `undocumented settings: ${missing.join(", ")}`);
  });

  it("reads a non-trivial number of settings", () => {
    // Guards the guard: if the Proxy ever stopped recording, the test above would
    // pass vacuously with an empty list.
    assert.ok(keysReadByParser().length >= 10);
  });

  it("documents the two flags that decide whether money moves", () => {
    assert.match(ENV_TEMPLATE, /ALLOWLIST_MINTING/);
    assert.match(ENV_TEMPLATE, /DRY_RUN/);
  });

  it("documents the allow-list source", () => {
    assert.match(ENV_TEMPLATE, /ALLOWLIST_SOURCE/);
  });

  /** The settings the template ships uncommented, parsed back into an env. */
  function liveSettings(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const line of ENV_TEMPLATE.split("\n")) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match && match[1] !== undefined) env[match[1]] = match[2] ?? "";
    }
    return env;
  }

  it("ships no secret uncommented", () => {
    // A live secret line is a placeholder an operator might not replace, and a
    // placeholder key that parses is worse than one that fails loudly.
    const live = Object.keys(liveSettings());
    for (const secret of [
      "PRIVATE_KEY",
      "PRIVATE_KEYS",
      "OPENSEA_API_KEY",
      "OPENSEA_SCOPED_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_IDS",
    ]) {
      assert.ok(!live.includes(secret), `${secret} must not ship uncommented`);
    }
  });

  it("ships no money-moving flag uncommented", () => {
    // These two decide whether funds can leave. Both must be a deliberate act by
    // the operator, never something inherited from a copied file.
    const live = Object.keys(liveSettings());
    assert.ok(!live.includes("ALLOWLIST_MINTING"));
    assert.ok(!live.includes("DRY_RUN"));
  });

  it("is a no-op to copy: every live value equals the parser's own default", () => {
    // The strong form of the rule. The template does ship some operational lines
    // live so the file is immediately readable, and that is fine precisely
    // because none of them changes behaviour — copying .env.example and running
    // must produce byte-identical settings to running with no .env at all. A
    // future edit that sets a live value to something other than the default
    // would silently reconfigure every new operator, and fails here.
    assert.deepEqual(readDefaults(liveSettings()), readDefaults({}));
  });

  it("actually ships some live lines, so the check above is not vacuous", () => {
    assert.ok(Object.keys(liveSettings()).length > 0);
  });

  it("contains no key-shaped value", () => {
    assert.doesNotMatch(ENV_TEMPLATE, /0x[0-9a-fA-F]{64}/);
  });
});
