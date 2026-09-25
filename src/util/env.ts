// Configuration, and the rules about where secrets may live.
//
// Two kinds of value get read here and they are treated differently:
//
//   Operational settings (chain, gas, RPC URLs, lead time) are read from .env and
//   from flags, with flags winning. They are printed freely.
//
//   Secrets (private keys, API keys, bot tokens) are read but never echoed, never
//   written back to disk, and never included in an error message. `redactKeys`
//   guards the paths where a value could reach a log or a Telegram chat.
//
// A note on .env for private keys: it is plaintext on disk, which is a real
// exposure and is worse than pasting into a prompt that keeps the key in memory
// only. It is supported because the alternative — retyping keys before every mint
// — pushes people toward worse habits, but the CLI says so out loud rather than
// pretending the trade-off is not there.

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

export function loadEnv(cwd: string = process.cwd()): void {
  const envPath = path.resolve(cwd, ".env");
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
}

export interface Defaults {
  chain: string;
  quantity: number;
  gasLimit: bigint;
  maxFeeGwei: number | null;
  priorityGwei: number | null;
  leadMs: number;
  openseaApiKey: string | null;
  telegramToken: string | null;
  telegramAllowedIds: number[];
  receiptTimeoutMs: number;
  /** Let intern fire at allowlist / GTD / FCFS stages. Off means public-only. */
  allowlistMinting: boolean;
  /**
   * A local allow-list to prove wallets against: a path, https:// or ipfs://.
   *
   * null means the eligibility question goes unanswered, which is the honest
   * state — SeaDrop stores only the root, so with no list there is genuinely no
   * way to know whether a wallet is on it.
   */
  allowlistSource: string | null;
  /** Do everything except broadcast. */
  dryRun: boolean;
  /** Minutes between unattended heartbeat edits. 0 disables the heartbeat. */
  heartbeatMinutes: number;
  /**
   * Where the heartbeat lives. null means "the first allowed id".
   *
   * Defaulting to the operator who configured the bot rather than to nobody: an
   * unattended daemon that never says it is alive is one the operator has no way
   * to check without SSH, which defeats the point of running it for a mint they
   * are asleep for. It is one message, edited in place, and HEARTBEAT_MINUTES=0
   * turns it off.
   */
  heartbeatChatId: number | null;
  /** How often to ask OpenSea for a signature once a gated stage is open. */
  signaturePollMs: number;
  /**
   * Refuse to fire when the clock offset cannot be measured to within this.
   *
   * null means unconfigured, which is not the same as "no limit". An unattended
   * run substitutes its own default and enforces it, because nobody is there to
   * judge a bad clock. An interactive run leaves it advisory: the operator is
   * looking at the measured offset and can decide for themselves.
   */
  clockDriftLimitMs: number | null;
}

function numberFrom(raw: string | undefined, fallback: number | null): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** A trimmed string, or null when unset or blank. */
function stringFrom(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * Deliberately strict: only an unambiguous yes is a yes.
 *
 * These flags unlock spending. `ALLOWLIST_MINTING=maybe` is off, not on, and a
 * typo in a .env file must never be the reason a wallet fires at a stage the
 * operator did not mean to enter.
 */
function booleanFrom(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "") return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Floored at 100ms. A limit tighter than the measurement's own noise refuses
 * every run, including the ones with a perfectly good clock.
 */
/**
 * 0 is the off switch and is preserved exactly; anything else is at least a
 * minute, because a heartbeat faster than that is a notification stream.
 */
function heartbeatMinutesFrom(raw: string | undefined): number {
  const value = Math.floor(numberFrom(raw, 30) ?? 30);
  if (value <= 0) return 0;
  return Math.max(1, value);
}

/** A Telegram chat id, which may legitimately be negative for a group. */
function chatIdFrom(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value !== 0 ? value : null;
}

function driftLimitFrom(raw: string | undefined): number | null {
  const value = numberFrom(raw, null);
  return value === null ? null : Math.max(100, Math.floor(value));
}

function bigintFrom(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const value = BigInt(raw.trim());
    return value > 0n ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Telegram access control: an explicit allowlist of numeric user ids.
 *
 * This is the only thing standing between a bot token and someone else's wallet,
 * so it is deliberately an allowlist rather than a password. A token can leak from
 * a screenshot, a shell history, or a misconfigured backup; an id allowlist means
 * a leaked token alone is not enough to spend funds. The bot refuses to run
 * without one for exactly that reason.
 */
function idsFrom(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function readDefaults(env: NodeJS.ProcessEnv = process.env): Defaults {
  const apiKey = env.OPENSEA_API_KEY?.trim();
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  return {
    chain: (env.CHAIN ?? "base").trim().toLowerCase(),
    quantity: Math.max(1, Math.floor(numberFrom(env.QUANTITY, 1) ?? 1)),
    gasLimit: bigintFrom(env.GAS_LIMIT, 250_000n),
    maxFeeGwei: numberFrom(env.MAX_FEE_PER_GAS, null),
    priorityGwei: numberFrom(env.MAX_PRIORITY_FEE, null),
    leadMs: Math.max(0, Math.floor(numberFrom(env.LEAD_MS, 0) ?? 0)),
    openseaApiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    telegramToken: token && token.length > 0 ? token : null,
    telegramAllowedIds: idsFrom(env.TELEGRAM_ALLOWED_IDS),
    receiptTimeoutMs: Math.max(
      5_000,
      Math.floor(numberFrom(env.RECEIPT_TIMEOUT_MS, 90_000) ?? 90_000),
    ),
    allowlistMinting: booleanFrom(env.ALLOWLIST_MINTING),
    allowlistSource: stringFrom(env.ALLOWLIST_SOURCE),
    dryRun: booleanFrom(env.DRY_RUN),
    heartbeatMinutes: heartbeatMinutesFrom(env.HEARTBEAT_MINUTES),
    heartbeatChatId: chatIdFrom(env.HEARTBEAT_CHAT_ID),
    // Floored at 100ms: OpenSea rate-limits, and a tighter loop earns a 429 that
    // costs far more time than the polling interval saves.
    signaturePollMs: Math.max(100, Math.floor(numberFrom(env.SIGNATURE_POLL_MS, 250) ?? 250)),
    clockDriftLimitMs: driftLimitFrom(env.CLOCK_DRIFT_LIMIT_MS),
  };
}

const ENV_TEMPLATE = `# intern — configuration
#
# Everything here is optional; the CLI prompts for what it needs. Values set here
# become the defaults so a contested mint needs no typing.

# ── Wallets ─────────────────────────────────────────────────────────────────
# PLAINTEXT ON DISK. Prefer pasting keys at the prompt (memory only) and use this
# only on a machine you control. Never a seed phrase. Never commit this file.
# PRIVATE_KEY=
# PRIVATE_KEYS=key1,key2

# ── Network ─────────────────────────────────────────────────────────────────
# ethereum | base | robinhood | ink | arbitrum | optimism | polygon | zora
CHAIN=base

# A private RPC is the single biggest speed factor in a contested mint.
# Per-chain entries win over the generic one; comma-separate for several.
# RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
# RPC_URL_ETHEREUM=
# RPC_URL_ROBINHOOD=
# RPC_URL=
# EXTRA_RPC_URLS=

# ── Mint ────────────────────────────────────────────────────────────────────
QUANTITY=1
GAS_LIMIT=250000
# Fee ceiling in gwei. Left unset, it is derived from the live base fee, which is
# usually what you want — a ceiling is a maximum, not a payment.
# MAX_FEE_PER_GAS=
# MAX_PRIORITY_FEE=

# Fire this many ms before the stage opens. 0 (default) fires at T-0. A non-zero
# value risks reverting with NotActive; only set it if you know the chain's
# inclusion behaviour.
LEAD_MS=0
RECEIPT_TIMEOUT_MS=90000

# ── OpenSea ─────────────────────────────────────────────────────────────────
# Needed only for slug lookups and allowlist/FCFS stages. Public mints read
# everything from the chain and need no key at all.
# OPENSEA_API_KEY=

# ── Gated stages (allowlist / GTD / FCFS / team) ────────────────────────────
# Off by default. Set to 1 to let intern fire at gated stages, so that a misread
# drop cannot spend funds at a stage you did not choose to enter.
# ALLOWLIST_MINTING=0

# A local allow-list for Merkle (mintAllowList) stages: a file path, an https URL
# or ipfs://. intern computes the Merkle root from it and compares that to the
# root on the contract BEFORE using any proof — a mismatch is reported, never
# submitted. Not needed for OpenSea-signed stages, which cannot be proven locally.
# ALLOWLIST_SOURCE=./allowlist.json

# How often to ask OpenSea for a signature once a gated stage is open.
# Floored at 100ms: a tighter loop earns a 429 that costs far more than it saves.
# SIGNATURE_POLL_MS=250

# ── Safety ──────────────────────────────────────────────────────────────────
# Prepare, check, and sign everything, then stop without broadcasting. Identical
# to \`intern dryrun\`. Spends nothing.
# DRY_RUN=0

# Refuse to fire when the clock offset cannot be measured to within this many ms.
# Unset, this is advisory in the CLI (you see the warning and decide) and enforced
# at 2000ms in the bot, where nobody is watching. Floored at 100ms.
# CLOCK_DRIFT_LIMIT_MS=2000

# ── Telegram bot ────────────────────────────────────────────────────────────
# From @BotFather.
# TELEGRAM_BOT_TOKEN=
# REQUIRED for the bot to start: numeric user ids allowed to command it. Get
# yours from @userinfobot. A leaked token is not enough to spend funds unless the
# attacker is also on this list.
# TELEGRAM_ALLOWED_IDS=123456789
# The bot keeps ONE message saying it is alive and edits it in place, so this is a
# refresh rate and not a message rate. 0 turns it off entirely. By default it goes
# to the first id in TELEGRAM_ALLOWED_IDS; set HEARTBEAT_CHAT_ID to send it
# somewhere else, such as a group you share with a second operator.
# HEARTBEAT_MINUTES=30
# HEARTBEAT_CHAT_ID=
`;

/** Write a commented .env template. Never overwrites an existing file. */
export function writeEnvTemplate(cwd: string = process.cwd()): { path: string; created: boolean } {
  const envPath = path.resolve(cwd, ".env");
  if (fs.existsSync(envPath)) return { path: envPath, created: false };
  fs.writeFileSync(envPath, ENV_TEMPLATE, { encoding: "utf8", mode: 0o600 });
  return { path: envPath, created: true };
}

export { ENV_TEMPLATE };
