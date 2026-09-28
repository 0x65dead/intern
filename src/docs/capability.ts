// CAPABILITY.md, generated from the matrix the scheduler actually selects from.
//
// This file exists because a hand-written capability document drifts, and a drifted
// capability document is worse than none: it is a claim about code, made in prose,
// that nothing checks. Everything below is rendered from `CAPABILITIES` in
// src/core/capabilities.ts and `SPEED_STATEMENT` in src/core/race.ts, so a row that
// changes in the code changes here, and `npm test` fails when the committed file
// and the generator disagree.
//
// What is hand-written is the part that is not a property of a mechanism: the
// non-custodial boundary, the operational limits found by running the thing, and
// the commands. Those are prose because they are prose, but they live next to the
// generated table so the whole document is one artefact.

import {
  CAPABILITIES,
  Capability,
  MechanismCapability,
  capabilityFor,
} from "../core/capabilities";
import { PRE_ARM_LEAD_MS, SPEED_STATEMENT } from "../core/race";
import { renderRunbook } from "./runbook";

/** A cell for the summary table. Terse; the detail is in the per-mechanism section. */
function mark(cap: Capability): string {
  if (cap.level === "yes") return "yes";
  return cap.level === "warn" ? "partial" : "no";
}

function reasonOf(cap: Capability): string | null {
  if (cap.level === "yes") return cap.note ?? null;
  return cap.reason;
}

const AXES: { key: keyof MechanismCapability; label: string; question: string }[] = [
  { key: "detectWindow", label: "Detect window", question: "Can the stage's window be known before it opens?" },
  { key: "precheckEligibility", label: "Precheck eligibility", question: "Can this wallet's eligibility be known before the stage opens?" },
  { key: "preSign", label: "Pre-sign", question: "Can the calldata be signed before the stage opens?" },
  { key: "fireUnattended", label: "Fire unattended", question: "Can intern fire at it with nobody watching?" },
];

function axis(row: MechanismCapability, key: keyof MechanismCapability): Capability {
  return row[key] as Capability;
}

function summaryTable(): string {
  const head = `| Mechanism | Method | ${AXES.map((a) => a.label).join(" | ")} | Speed |`;
  const rule = `| --- | --- | ${AXES.map(() => "---").join(" | ")} | --- |`;
  const rows = CAPABILITIES.map((row) => {
    const cells = AXES.map((a) => mark(axis(row, a.key)));
    return `| ${row.title} | \`${row.method ?? "—"}\` | ${cells.join(" | ")} | ${row.fireSpeed.class} |`;
  });
  return [head, rule, ...rows].join("\n");
}

function mechanismSection(row: MechanismCapability): string {
  const lines: string[] = [`### ${row.title}`, ""];
  lines.push(`**Mechanism:** \`${row.mechanism}\`  `);
  lines.push(`**Contract call:** ${row.method === null ? "none — there is no minter-callable path" : `\`${row.method}\``}`);
  lines.push("");

  for (const a of AXES) {
    const cap = axis(row, a.key);
    const reason = reasonOf(cap);
    lines.push(`- **${a.label}: ${mark(cap)}**${reason === null ? "" : ` — ${reason}`}`);
  }
  lines.push("");
  lines.push(`**Speed (${row.fireSpeed.class}):** ${row.fireSpeed.detail}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Every row that cannot be fired, with the reason, in one list.
 *
 * Required by the project's own rule that a stage intern cannot fire must appear
 * with its exact cause. Pulling them together means an operator does not have to
 * read six sections to find the three that will not fire.
 */
function notFireableSection(): string {
  const blocked = CAPABILITIES.filter((r) => r.fireUnattended.level !== "yes");
  const conditional = CAPABILITIES.filter(
    (r) => r.fireUnattended.level === "yes" && r.fireUnattended.note !== undefined,
  );

  const lines: string[] = [];
  if (blocked.length === 0) {
    lines.push("Every mechanism in the matrix can be fired unattended.");
  } else {
    lines.push("These will not fire, under any configuration:");
    lines.push("");
    for (const row of blocked) {
      const reason = reasonOf(row.fireUnattended) ?? "no reason recorded — this is a bug";
      lines.push(`- **${row.title}** — ${reason}`);
    }
  }

  if (conditional.length > 0) {
    lines.push("");
    lines.push("These fire, but only once something is configured:");
    lines.push("");
    for (const row of conditional) {
      const note = row.fireUnattended.level === "yes" ? (row.fireUnattended.note ?? "") : "";
      lines.push(`- **${row.title}** — ${note}`);
    }
  }
  return lines.join("\n");
}

const NON_CUSTODIAL = `## Non-custodial, forever

This is an architectural boundary, not a policy that could be relaxed later.

intern signs with keys it reads from \`.env\` on the machine it runs on, and with
nothing else. It has no code path that accepts, stores, proxies or forwards
another party's key material, and there is no "mint for me" mode. A Telegram
message cannot carry a key into this process: the bot's command surface takes a
contract, a quantity and a chain, and the wallet set is fixed at startup by
\`walletsFromEnv()\`.

Where this is enforced:

- \`src/core/wallets.ts\` — \`walletsFromEnv()\` is the only constructor of a
  signing wallet, and it reads \`PRIVATE_KEYS\` from the process environment.
- \`src/bot/session.ts\` — the session holds the wallet set it was given at
  construction. No command mutates it.
- \`redactKeys()\` — every log line and every Telegram message routes through it.
  A private key or mnemonic reaching output is treated as a P0 bug, and the
  redaction is unit-tested against hex keys, bot tokens and BIP-39 seed phrases
  rather than trusted.

The corollary, stated plainly: **whoever controls the machine controls the keys.**
\`.env\` is plaintext on disk. That is a real exposure, and it is worse than
holding keys in memory only. It is supported because the alternative — retyping
keys before every mint — pushes operators toward worse habits, but it is not
pretended away.`;

const OPERATIONAL = `## Operational limits found by running it

These are not deductions from documentation. Each was measured on the box.

**A watchdog kill used to write private keys to disk.** systemd's default
\`WatchdogSignal\` is \`SIGABRT\`, which dumps core. On a stock Ubuntu host that dump
goes to apport, which writes the process's raw memory to \`/var/crash/\` — and this
process holds \`PRIVATE_KEYS\` in that memory. Verified directly: a sentinel string
held in a variable was recovered from the resulting file. \`LimitCORE=0\` does **not**
prevent it, because the kernel ignores \`RLIMIT_CORE\` when \`core_pattern\` is a pipe,
which it is whenever apport or systemd-coredump is installed. The unit file
therefore sets \`WatchdogSignal=SIGKILL\`, re-verified as \`code=killed, status=9/KILL\`
with \`/var/crash/\` left empty.

**The watchdog is gated on evidence of progress, not on a timer.** A timer-driven
ping proves only that the event loop turns, which is exactly the state a hung
long-poll leaves it in. \`isMakingProgress()\` requires a completed \`getUpdates\`
within three poll timeouts before a ping is sent, so a stalled bot is killed and
restarted rather than reported healthy.

**\`StartLimitIntervalSec\` belongs in \`[Unit]\`, not \`[Service]\`.** systemd moved it
in v229 and silently ignores it in the wrong section. It was in the wrong section
here, which meant the default limit of five starts in ten seconds applied: with
\`RestartSec=2\`, a crash-looping bot would have stopped permanently — the precise
outcome the comment claimed to prevent. Verified after the fix: 11 restarts in 14s.

**Crash recovery is a report, not a resume.** A restarted process no longer holds
the signed bytes, so re-sending is impossible, and re-signing at the same nonce
would compete with a transaction that may already be confirmed. \`recoveryReport()\`
therefore puts unresolved hashes in front of a human and refuses to act on them.
The run journal is cleared only *after* the report is delivered, so a Telegram
outage cannot be the reason an operator re-mints a wallet that already succeeded.`;

/** Render the whole document. Pure — same input, same bytes, every time. */
export function renderCapabilityDoc(): string {
  const sections: string[] = [];

  sections.push(`# CAPABILITY.md

**This file is generated.** Run \`npm run docs\` to regenerate it; \`npm test\` fails
if it is out of date. It is generated from \`CAPABILITIES\` in
\`src/core/capabilities.ts\` — the same table the scheduler selects from — so it
cannot claim a capability the code does not have.

It exists to be the place where intern says what it cannot do.`);

  sections.push(`## The speed claim

${SPEED_STATEMENT}

Pre-arm work — nonces, warm sockets, a measured clock offset — completes
${PRE_ARM_LEAD_MS / 1000} seconds before the stage opens, so the race pays for
none of it. That lead exists only when intern is waiting for a scheduled stage.
Start it against a stage that is already open and there is no lead to use: the
same preparation then happens inside the race, and the run says so rather than
quietly being slower.`);

  sections.push(`## The matrix

The axis is the **mechanism**, not the stage's name. "Allowlist", "GTD" and "FCFS"
are labels a creator chooses; what decides whether intern can fire is which
contract function the stage resolves to and where its authorisation comes from.
The same "Allowlist" label is an offline Merkle proof on one collection and an
OpenSea-held signature on the next, and those two have opposite capabilities.

${summaryTable()}

Where a cell says \`partial\` or \`no\`, the reason is stated in the section below.
The type system enforces that: a limitation without a cause cannot be written.`);

  sections.push(`## What will not fire

${notFireableSection()}`);

  sections.push(`## Per mechanism

${CAPABILITIES.map(mechanismSection).join("\n")}`);

  sections.push(NON_CUSTODIAL);
  sections.push(OPERATIONAL);
  // Last of the prose sections: the reader has now been told what will not
  // fire and why, which is the context that makes the commands safe to run.
  sections.push(renderRunbook());

  sections.push(`## The thing that is structurally impossible

An OpenSea-signed stage cannot be pre-signed. ${
    (() => {
      const cap = capabilityFor("opensea-signed").preSign;
      return cap.level === "yes" ? "" : cap.reason;
    })()
  }

No amount of engineering on this side removes it. intern's response is to move
every other cost out of the race — nonce, fees, balance, TLS handshake, and the
provider selection are all settled before T-0 — and then to say, in writing, that
the remaining round trip is inside the race and cannot be removed.`);

  return `${sections.join("\n\n")}\n`;
}
