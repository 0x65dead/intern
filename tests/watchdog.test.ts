// The watchdog's job is to fail.
//
// Every test here is really one test asked three ways: does this code stop
// vouching for a bot that has stopped working? A watchdog that always says yes is
// indistinguishable from no watchdog, except that it also produces a log line
// claiming protection the operator does not have. So the assertions below care
// much more about the refusals — not armed, wrong pid, stalled — than about the
// happy path.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  isMakingProgress,
  readWatchdogConfig,
  stallLimitMs,
} from "../src/bot/watchdog";

const PID = 4242;

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });

describe("readWatchdogConfig", () => {
  it("returns null when systemd did not arm a watchdog", () => {
    // The ordinary case: run from a shell. Not a problem — but the bot must not
    // print a line claiming it is supervised.
    assert.equal(readWatchdogConfig(env(), PID), null);
  });

  it("reads the deadline from WATCHDOG_USEC in microseconds", () => {
    const config = readWatchdogConfig(env({ WATCHDOG_USEC: "30000000" }), PID);
    assert.ok(config);
    assert.equal(config.deadlineMs, 30_000);
  });

  it("pings at half the deadline, so one lost ping is survivable", () => {
    const config = readWatchdogConfig(env({ WATCHDOG_USEC: "30000000" }), PID);
    assert.ok(config);
    assert.equal(config.intervalMs, 15_000);
  });

  it("floors the interval at one second so WatchdogSec=1 cannot become a spin", () => {
    const config = readWatchdogConfig(env({ WATCHDOG_USEC: "1000000" }), PID);
    assert.ok(config);
    assert.equal(config.intervalMs, 1_000);
    assert.equal(config.deadlineMs, 1_000);
  });

  it("arms for the process systemd named", () => {
    const config = readWatchdogConfig(
      env({ WATCHDOG_USEC: "20000000", WATCHDOG_PID: String(PID) }),
      PID,
    );
    assert.ok(config);
    assert.equal(config.deadlineMs, 20_000);
  });

  it("refuses to answer on another process's behalf", () => {
    // A child that inherited the variables would keep systemd satisfied while the
    // parent — the process that actually matters — is hung. That is the exact
    // failure a watchdog exists to catch, so inheriting it is worse than nothing.
    assert.equal(
      readWatchdogConfig(env({ WATCHDOG_USEC: "20000000", WATCHDOG_PID: "1" }), PID),
      null,
    );
  });

  it("ignores a non-numeric WATCHDOG_USEC rather than guessing a deadline", () => {
    assert.equal(readWatchdogConfig(env({ WATCHDOG_USEC: "soon" }), PID), null);
    assert.equal(readWatchdogConfig(env({ WATCHDOG_USEC: "30s" }), PID), null);
    assert.equal(readWatchdogConfig(env({ WATCHDOG_USEC: "-1" }), PID), null);
    assert.equal(readWatchdogConfig(env({ WATCHDOG_USEC: "1e7" }), PID), null);
  });

  it("treats an empty or whitespace WATCHDOG_USEC as unset", () => {
    assert.equal(readWatchdogConfig(env({ WATCHDOG_USEC: "" }), PID), null);
    assert.equal(readWatchdogConfig(env({ WATCHDOG_USEC: "   " }), PID), null);
  });

  it("returns null for a deadline that rounds to zero milliseconds", () => {
    // WatchdogSec set in the hundreds of microseconds. Nothing sane to ping at.
    assert.equal(readWatchdogConfig(env({ WATCHDOG_USEC: "500" }), PID), null);
  });
});

describe("isMakingProgress", () => {
  const NOW = 1773576000000;
  const LIMIT = 150_000;

  it("vouches for a loop that just completed a round trip", () => {
    assert.equal(isMakingProgress(NOW - 1_000, NOW, LIMIT), true);
  });

  it("vouches for a loop sitting in a normal long poll", () => {
    // 50 seconds of silence is what a healthy, quiet chat looks like.
    assert.equal(isMakingProgress(NOW - 50_000, NOW, LIMIT), true);
  });

  it("stops vouching once silence exceeds the limit", () => {
    // This is the whole feature: the ping is withheld, the deadline expires, and
    // systemd restarts a process whose event loop was turning perfectly well.
    assert.equal(isMakingProgress(NOW - 150_001, NOW, LIMIT), false);
  });

  it("is exclusive at the boundary", () => {
    assert.equal(isMakingProgress(NOW - LIMIT, NOW, LIMIT), false);
    assert.equal(isMakingProgress(NOW - LIMIT + 1, NOW, LIMIT), true);
  });

  it("does not read a backwards clock jump as a stall", () => {
    // An NTP step backwards puts the stamp in the future. That is a clock
    // problem; killing a working bot over it would be a self-inflicted outage.
    assert.equal(isMakingProgress(NOW + 60_000, NOW, LIMIT), true);
  });
});

describe("stallLimitMs", () => {
  it("leaves room for the poll to time out and retry", () => {
    // Three times the poll timeout: one timeout, one retry, and its backoff.
    assert.equal(stallLimitMs(50), 150_000);
  });

  it("never drops below a minute, however short the poll", () => {
    // A tight poll timeout must not turn a brief network blip into a restart.
    assert.equal(stallLimitMs(1), 60_000);
    assert.equal(stallLimitMs(0), 60_000);
  });

  it("always exceeds the poll timeout it was derived from", () => {
    // The invariant that keeps a healthy long-poll from being read as a stall.
    for (const seconds of [1, 5, 20, 50, 120, 300]) {
      assert.ok(
        stallLimitMs(seconds) > seconds * 1000,
        `stall limit for a ${seconds}s poll must exceed the poll itself`,
      );
    }
  });
});

describe("a live mint is proof of life", () => {
  const STALL = 65_000;

  it("keeps pinging while minting, even with no Telegram round trip for minutes", () => {
    // A Telegram outage stalls lastProgressMs. Answering that with SIGKILL kills a
    // run that is spending real money, to fix an outage a restart cannot fix.
    assert.equal(isMakingProgress(0, 10 * 60_000, STALL, true), true);
  });

  it("still withholds the ping when idle and stalled", () => {
    // The gate has to keep working, or the watchdog proves only that timers fire.
    assert.equal(isMakingProgress(0, 10 * 60_000, STALL, false), false);
  });

  it("defaults to the old behaviour when the flag is not passed", () => {
    assert.equal(isMakingProgress(0, 10 * 60_000, STALL), false);
    assert.equal(isMakingProgress(0, 1_000, STALL), true);
  });

  it("does not depend on the stamp at all while minting", () => {
    // Including a stamp from the future, which a backwards clock jump produces.
    assert.equal(isMakingProgress(Number.MAX_SAFE_INTEGER, 0, STALL, true), true);
    assert.equal(isMakingProgress(0, 0, 0, true), true);
  });

  it("is wired to the manager's own running flag, not a local guess", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "bot", "index.ts"),
      "utf8",
    );
    assert.match(src, /isMakingProgress\(lastProgressMs, Date\.now\(\), stallMs, manager\.isRunning\(\)\)/);
  });
});
