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
import { getAddress, parseEther, parseUnits } from "ethers";

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
  /** Absolute EIP-1559 maxFeePerGas ceiling for automatic replacements. null disables RBF. */
  maxGasCeilingWei: bigint | null;
  /** Maximum number of fee replacements per wallet; 0 disables replacements. */
  rbfMaxAttempts: number;
  leadMs: number;
  openseaApiKey: string | null;
  /**
   * The durable credential exchanged for a short-lived wallet JWT.
   *
   * Kept separate from the API key because the two authorise different things
   * and fail independently: the key identifies the integration, this identifies
   * the wallet. null simply means wallet-scoped eligibility is unavailable, so
   * intern reports eligibility as unknown until a stage opens rather than
   * refusing to run.
   */
  openseaScopedToken: string | null;
  /**
   * A short-lived wallet JWT issued by OpenSea, used as a fallback when the
   * PAT exchange flow cannot be used. Unlike a PAT, it is not refreshed
   * automatically and applies to one wallet only.
   */
  openseaWalletToken: string | null;
  /** Personal access tokens indexed by the wallet they authorize. */
  openseaScopedTokens: Record<string, string>;
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
  /**
   * The most one NFT may cost, in wei. null means no ceiling was configured.
   *
   * Stated per NFT rather than per transaction because that is how a drop is
   * advertised and how an operator holds the limit in their head — "it is 0.001,
   * never pay more than 0.002 each" keeps its meaning when QUANTITY changes,
   * where a total would silently become five times too tight and teach the
   * operator to raise it.
   *
   * 0 is a real setting and is not the same as unset: it means free mints only.
   */
  maxPricePerNftWei: bigint | null;
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

/** Parse a JSON object of wallet addresses to their OpenSea personal access tokens. */
function addressTokenMapFrom(name: string, raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(name + " must be a JSON object mapping wallet addresses to tokens.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(name + " must be a JSON object mapping wallet addresses to tokens.");
  }

  const tokens: Record<string, string> = {};
  for (const [address, credential] of Object.entries(parsed)) {
    let normalized: string;
    try {
      normalized = getAddress(address).toLowerCase();
    } catch {
      throw new ConfigError(name + " contains an invalid wallet address.");
    }
    if (typeof credential !== "string" || credential.trim() === "") {
      throw new ConfigError(name + " must map every wallet address to a non-empty token.");
    }
    if (Object.prototype.hasOwnProperty.call(tokens, normalized)) {
      throw new ConfigError(name + " contains duplicate wallet addresses after normalization.");
    }
    tokens[normalized] = credential.trim();
  }
  return tokens;
}

/** A setting whose value the parser will not guess at. Fatal at startup. */
export class ConfigError extends Error {}

const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["0", "false", "no", "off"];

/**
 * A boolean setting, where a value that is neither a yes nor a no is refused.
 *
 * This used to answer "off" to anything it did not recognise, and the reasoning
 * was sound for the flag it was written against: ALLOWLIST_MINTING=ture leaves
 * the bot public-only, which costs a missed mint and no money. But the same
 * helper reads DRY_RUN, where the polarity is reversed — DRY_RUN=ture read as
 * "off" is a live mint by an operator who believed they were rehearsing, and
 * the brief's rule is that a task never accidentally jumps from dry-run to
 * live. A default direction that is safe for one flag is unsafe for the other,
 * so there is no safe direction to pick and the parser stops picking one.
 *
 * Refusing costs nothing either way: both entry points read settings once, at
 * startup, and both already print the message and exit non-zero. The operator
 * learns about the typo immediately instead of inferring it from a wallet
 * balance. Unset and blank still mean the documented default — that is an
 * operator who said nothing, not one who said something unreadable.
 */
function booleanFrom(name: string, raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "") return fallback;
  if (TRUE_WORDS.includes(value)) return true;
  if (FALSE_WORDS.includes(value)) return false;
  throw new ConfigError(
    `${name} is set to something I cannot read as a yes or a no. ` +
      `Use one of ${TRUE_WORDS.join(", ")} — or ${FALSE_WORDS.join(", ")} — or remove the line.`,
  );
}

/**
 * How many to mint. Unset means one; an unreadable value means stop.
 *
 * The old reading was `Math.max(1, Math.floor(...))`, which turned QUANTITY=0
 * into QUANTITY=1: an operator who asked to buy nothing bought one. Every other
 * wrong value did the same, because a non-numeric fell through to the default.
 * There is no safe guess for how much money to spend, so an explicitly bad
 * value is refused rather than rounded into a purchase.
 */
function quantityFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const text = raw.trim();
  // Plain decimal digits only, rather than `Number()`. `Number` also reads hex
  // and scientific notation, so QUANTITY=1e3 is a thousand mints from a line
  // that looks like a typo for 13 — a value meaning something other than it
  // looks is the whole class of mistake this function exists to stop. Nobody
  // writes a mint count in hex.
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    throw new ConfigError(
      "QUANTITY must be a whole number of at least 1, written in plain digits. " +
        "Remove the line to mint one, and use DRY_RUN=1 to rehearse without buying.",
    );
  }
  return Number(text);
}

/**
 * A price ceiling written in whole native currency, converted to wei.
 *
 * Written in ETH rather than wei because that is the unit a drop is advertised
 * in and the unit every price intern prints. Asking for wei would invite an
 * eighteen-digit typo in the one setting whose entire job is to catch a price
 * that is wrong by orders of magnitude — a ceiling a thousand times too high is
 * no ceiling, and it would look almost exactly like the right one.
 *
 * Plain decimal only, for the reason QUANTITY is: `0x…` and `1e…` are both
 * numbers to JavaScript and neither means what it looks like.
 */
function weiFromEther(name: string, raw: string | undefined): bigint | null {
  if (raw === undefined || raw.trim() === "") return null;
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new ConfigError(
      `${name} must be an amount of the chain's native currency written in plain ` +
        `digits, such as 0.05. Remove the line to run with no price ceiling.`,
    );
  }
  try {
    return parseEther(text);
  } catch {
    throw new ConfigError(
      `${name} is finer than wei can represent — eighteen decimal places is the limit.`,
    );
  }
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

function weiFromGwei(name: string, raw: string | undefined): bigint | null {
  if (raw === undefined || raw.trim() === "") return null;
  const text = raw.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(text)) {
    throw new ConfigError(`${name} must be plain gwei with at most 9 decimal places.`);
  }
  try {
    const value = parseUnits(text, 9);
    if (value <= 0n) throw new Error("must be positive");
    return value;
  } catch {
    throw new ConfigError(`${name} must be a positive gwei amount representable in wei.`);
  }
}

function rbfAttemptsFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new ConfigError("RBF_MAX_ATTEMPTS must be an integer from 0 to 3.");
  }
  return value;
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
  const scoped = env.OPENSEA_SCOPED_TOKEN?.trim();
  const walletToken = env.OPENSEA_WALLET_TOKEN?.trim();
  const scopedTokens = addressTokenMapFrom("OPENSEA_SCOPED_TOKENS", env.OPENSEA_SCOPED_TOKENS);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  return {
    chain: (env.CHAIN ?? "base").trim().toLowerCase(),
    quantity: quantityFrom(env.QUANTITY),
    gasLimit: bigintFrom(env.GAS_LIMIT, 250_000n),
    maxFeeGwei: numberFrom(env.MAX_FEE_PER_GAS, null),
    priorityGwei: numberFrom(env.MAX_PRIORITY_FEE, null),
    maxGasCeilingWei: weiFromGwei("MAX_GAS_CEILING_GWEI", env.MAX_GAS_CEILING_GWEI),
    rbfMaxAttempts: rbfAttemptsFrom(env.RBF_MAX_ATTEMPTS),
    leadMs: Math.max(0, Math.floor(numberFrom(env.LEAD_MS, 0) ?? 0)),
    openseaApiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    openseaScopedToken: scoped && scoped.length > 0 ? scoped : null,
    openseaWalletToken: walletToken && walletToken.length > 0 ? walletToken : null,
    openseaScopedTokens: scopedTokens,
    telegramToken: token && token.length > 0 ? token : null,
    telegramAllowedIds: idsFrom(env.TELEGRAM_ALLOWED_IDS),
    receiptTimeoutMs: Math.max(
      5_000,
      Math.floor(numberFrom(env.RECEIPT_TIMEOUT_MS, 90_000) ?? 90_000),
    ),
    allowlistMinting: booleanFrom("ALLOWLIST_MINTING", env.ALLOWLIST_MINTING),
    allowlistSource: stringFrom(env.ALLOWLIST_SOURCE),
    dryRun: booleanFrom("DRY_RUN", env.DRY_RUN),
    maxPricePerNftWei: weiFromEther("MAX_PRICE_PER_NFT", env.MAX_PRICE_PER_NFT),
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
# A whole number in plain digits. A value that cannot be read that way is
# refused at startup rather than rounded into a purchase.
QUANTITY=1
GAS_LIMIT=250000
# Fee ceiling in gwei. Left unset, it is derived from the live base fee, which is
# usually what you want — a ceiling is a maximum, not a payment.
# MAX_FEE_PER_GAS=
# MAX_PRIORITY_FEE=
#
# Automatic replacement transactions (RBF) are disabled unless this separate,
# absolute maxFeePerGas ceiling is explicitly set. After 45s pending, Intern may
# bump both EIP-1559 fee fields by 12.5%, never beyond this ceiling.
# MAX_GAS_CEILING_GWEI=
# RBF_MAX_ATTEMPTS=1

# Fire this many ms before the stage opens. 0 (default) fires at T-0. A non-zero
# value risks reverting with NotActive; only set it if you know the chain's
# inclusion behaviour.
LEAD_MS=0
RECEIPT_TIMEOUT_MS=90000

# ── OpenSea ─────────────────────────────────────────────────────────────────
# The API key identifies the integration. It is what slug lookups, drop schedules
# and the mint builder authenticate with, and it says nothing about which wallet
# is asking. Needed only for slug lookups and allowlist/FCFS stages; public mints
# read everything from the chain and need no key at all.
# OPENSEA_API_KEY=
# The scoped token answers the wallet-scoped question: can THIS wallet mint THIS
# stage, at what price, and up to what limit. Create a personal access token with
# the read:eligibility scope. Create the PAT in OpenSea Settings -> Developer,
# or use the official CLI's wallet login flow with --scopes read:eligibility.
# Store the PAT here; intern exchanges it for a short-
# lived wallet JWT in memory and refreshes it as needed.
#
# For one wallet, use the legacy single-token setting:
# OPENSEA_SCOPED_TOKEN=
#
# For several wallets, provide one PAT per wallet as a JSON object keyed by the
# wallet address. Every token must belong to the corresponding wallet and carry
# read:eligibility. This map takes precedence over the two single-wallet settings.
# OPENSEA_SCOPED_TOKENS={"0x1111111111111111111111111111111111111111":"os_pat_REPLACE_ME","0x2222222222222222222222222222222222222222":"os_pat_REPLACE_ME"}
#
# A wallet JWT already issued by OpenSea may be used for a single wallet instead
# of a PAT. It is short-lived and must be replaced manually after expiry.
# OPENSEA_WALLET_TOKEN=

# ── Gated stages (allowlist / GTD / FCFS / team) ────────────────────────────
# Off by default. Set to 1 to let intern fire at gated stages, so that a misread
# drop cannot spend funds at a stage you did not choose to enter.
# Reads 1/true/yes/on and 0/false/no/off. Anything else stops the start, because
# a typo in a flag that moves money must not be guessed at in either direction.
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
# Reads 1/true/yes/on and 0/false/no/off. A misspelling is refused at startup:
# read as "off" it would be a live mint by someone who believed they were
# rehearsing.
# DRY_RUN=0

# The most one NFT may cost, in whole native currency (0.05 means 0.05 ETH on
# Ethereum or Base). Checked against the transaction value just before signing,
# multiplied by QUANTITY, on both the public and the allowlist path.
#
# Worth setting even though the wallet balance already caps the damage, because
# a balance is not a ceiling — it is everything the key can reach. This is the
# only number in the whole pre-sign sequence that says what you INTENDED to pay:
# gas settings bound the fee, not the purchase, and on the allowlist path the
# price arrives in the same API response that intern checks it against.
#
# Unset means no ceiling. 0 is a real setting and means free mints only.
# MAX_PRICE_PER_NFT=0.05

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

# ── Diagnostics ───────────────────────────────────────────────────────
# Print a stack trace when the CLI fails, instead of just the message. The trace
# is passed through the same redaction as everything else, so keys and tokens do
# not appear in it — but a trace names internal paths, so it is off by default.
# INTERN_DEBUG=1
`;

/** Write a commented .env template. Never overwrites an existing file. */
export function writeEnvTemplate(cwd: string = process.cwd()): { path: string; created: boolean } {
  const envPath = path.resolve(cwd, ".env");
  if (fs.existsSync(envPath)) return { path: envPath, created: false };
  fs.writeFileSync(envPath, ENV_TEMPLATE, { encoding: "utf8", mode: 0o600 });
  return { path: envPath, created: true };
}

export { ENV_TEMPLATE };
