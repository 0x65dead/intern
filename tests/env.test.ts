// Configuration parsing, for the settings that decide whether money moves.
//
// `ALLOWLIST_MINTING` and `DRY_RUN` are the two flags where a parsing mistake is
// expensive in opposite directions: one wrongly on fires at stages the operator
// never chose, the other wrongly on silently skips the broadcast at a mint they
// were counting on. So both are parsed strictly and both default to the safe
// answer — gated minting off, dry run off.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENV_TEMPLATE, readDefaults } from "../src/util/env";

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

  it("treats anything else as off, including a typo", () => {
    // The failure mode this guards: a value the operator believed was on,
    // silently enabling nothing, is recoverable. The reverse is not.
    for (const value of ["0", "false", "no", "off", "maybe", "ture", "", "  "]) {
      assert.equal(readDefaults({ ALLOWLIST_MINTING: value }).allowlistMinting, false, value);
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
    for (const secret of ["PRIVATE_KEYS", "OPENSEA_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_IDS"]) {
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
