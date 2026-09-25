// Wallet loading and gas budgeting.
//
// Two rules shape this file:
//
//   Never echo key material. ethers embeds the offending value in some of its
//   own error messages, so every construction failure is caught and replaced with
//   a positional message. A leaked key in a log or a screenshot is unrecoverable.
//
//   Balance checks must model what the *node* requires, not what the mint costs.
//   A node reserves value + gasLimit × maxFeePerGas up front and rejects the
//   transaction outright if the balance falls short — regardless of the far
//   smaller amount actually spent once the block lands. Checking against expected
//   cost passes locally and then fails at broadcast.

import { JsonRpcProvider, LangEn, Wallet, formatEther } from "ethers";

export interface LoadedWallet {
  index: number;
  address: string;
  key: string;
}

/**
 * The BIP-39 English wordlist, taken from ethers rather than restated.
 *
 * Restating 2048 words would be a second copy to drift; asking ethers means the
 * set redaction recognises is the same set the wallet loader would accept.
 */
const BIP39_WORDS: ReadonlySet<string> = (() => {
  const list = LangEn.wordlist();
  const words = new Set<string>();
  for (let i = 0; i < 2048; i++) words.add(list.getWord(i));
  return words;
})();

/**
 * The shortest BIP-39 phrase. Twelve consecutive dictionary hits is the signal.
 *
 * Chosen rather than a word-count check because a phrase that fails its checksum
 * still spends: `Mnemonic.isValidMnemonic` would pass a mistyped seed straight
 * through to the chat. Twelve in a row, separated only by blanks, does not occur
 * in this codebase's own prose — the function words that carry English sentences
 * (`the`, `of`, `to`, `and`, `is`) are absent from the wordlist, so any real
 * sentence breaks the run within a word or two. There is a test for exactly that.
 */
const MNEMONIC_MIN_WORDS = 12;

/**
 * Replace runs of twelve or more consecutive BIP-39 words.
 *
 * Punctuation ends a run deliberately: a seed phrase is words and blanks, and
 * allowing commas would let ordinary prose accumulate a false positive.
 */
function redactMnemonics(text: string): string {
  const runs: { start: number; end: number; words: number }[] = [];
  let current: { start: number; end: number; words: number } | null = null;
  let previousEnd = -1;

  const pattern = /[A-Za-z]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const word = match[0];
    const start = match.index;
    const end = start + word.length;
    // Only blanks may join two words of a phrase.
    const joined = current !== null && /^[ \t]+$/.test(text.slice(previousEnd, start));

    if (BIP39_WORDS.has(word.toLowerCase())) {
      if (current !== null && joined) {
        current.end = end;
        current.words += 1;
      } else {
        if (current !== null) runs.push(current);
        current = { start, end, words: 1 };
      }
    } else {
      if (current !== null) runs.push(current);
      current = null;
    }
    previousEnd = end;
  }
  if (current !== null) runs.push(current);

  // Right to left, so an earlier replacement cannot shift a later offset.
  let out = text;
  for (const run of runs.filter((r) => r.words >= MNEMONIC_MIN_WORDS).reverse()) {
    out = `${out.slice(0, run.start)}⟨redacted-mnemonic⟩${out.slice(run.end)}`;
  }
  return out;
}

/**
 * Values this process knows to be secret, normalized to bare lowercase hex.
 *
 * Shape alone cannot tell a private key from a transaction hash — both are 32
 * bytes of hex — so the redactor cannot decide by looking. This set is the half
 * of the answer it can be certain about: a key it loaded itself.
 */
const secrets = new Set<string>();

/**
 * Hashes this process computed itself, and may therefore show.
 *
 * Bounded, because a long-lived bot broadcasts indefinitely and an unbounded
 * exemption list is a slow leak.
 */
const publicHashes = new Set<string>();
const MAX_PUBLIC_HASHES = 4096;

/** Strip an optional `0x` and case, so the two spellings of a value collide. */
function normalizeHex(value: string): string {
  const trimmed = value.trim();
  const body = /^0[xX]/.test(trimmed) ? trimmed.slice(2) : trimmed;
  return body.toLowerCase();
}

/**
 * Record a value as secret, so it is redacted by identity and not merely by shape.
 *
 * Shape is the fallback, not the guarantee. This is the guarantee: a registered
 * secret is hidden no matter what else claims it is safe to print — which is what
 * stops a poisoned resume journal from laundering a key through
 * {@link markPublicHash}.
 */
export function registerSecret(value: string): void {
  const normal = normalizeHex(value);
  if (normal !== "") secrets.add(normal);
}

/**
 * Declare a transaction hash publishable, and return it unchanged for inline use.
 *
 * A tx hash is `0x` plus 64 hex characters. So is a private key. The redactor
 * used to resolve that ambiguity by hiding both, which meant every hash the bot
 * reported came out as `0x⟨redacted-key⟩` — including the ones inside explorer
 * links, where the replacement's `⟨⟩` produced a URL Telegram rejects, taking the
 * whole result panel down with it. An operator who cannot read a hash cannot
 * check on-chain whether their own mint landed.
 *
 * So the ambiguity is resolved with knowledge instead: hashes are derived here,
 * by {@link blast.prepare}, from a transaction this process signed. A value that
 * came from there is ours and public by construction. Anything else key-shaped
 * stays hidden, because the failure modes are not symmetric — a redacted hash is
 * an inconvenience, a printed key is a stolen wallet.
 *
 * Registered secrets are never marked, whatever the caller claims.
 */
export function markPublicHash(hash: string): string {
  const normal = normalizeHex(hash);
  if (!/^[a-f0-9]{64}$/.test(normal)) return hash; // not hash-shaped; nothing to exempt
  if (secrets.has(normal)) return hash; // a secret stays secret, however it arrived
  if (publicHashes.size >= MAX_PUBLIC_HASHES) {
    const oldest = publicHashes.values().next();
    if (!oldest.done) publicHashes.delete(oldest.value);
  }
  publicHashes.add(normal);
  return hash;
}

/** Test seam: forget every registration. Not used by the running bot. */
export function resetRedactionRegistry(): void {
  secrets.clear();
  publicHashes.clear();
}

/** Hide a key-shaped run unless this process vouched for it as a tx hash. */
function hideUnlessPublic(match: string): string {
  const prefixed = /^0[xX]/.test(match);
  const normal = normalizeHex(match);
  if (!secrets.has(normal) && publicHashes.has(normal)) return match;
  return prefixed ? "0x⟨redacted-key⟩" : "⟨redacted-key⟩";
}

/**
 * Redact anything key-shaped from a string before it reaches a log or a chat.
 *
 * The hex patterns accept `0X` as well as `0x`, and match 64 hex characters *or
 * more*: an anchored exactly-64 pattern cannot match inside a longer run, so two
 * concatenated keys — or a key with a stray hex character appended — used to pass
 * through a function whose whole purpose is that they do not. A run longer than 64
 * is never exempt, since an exemption is recorded at exactly 64.
 *
 * The bot-token pattern opens with a negative lookbehind rather than `\b`, because
 * the one place a bot token actually appears is inside its own API URL —
 * `https://api.telegram.org/bot123456789:AAA…/sendMessage` — and there `t` and `1`
 * are both word characters, so `\b` does not hold and the token used to survive
 * every transport error verbatim. The lookbehind still refuses to start partway
 * through a longer digit run, which is what the `\b` was there for.
 */
export function redactKeys(text: string): string {
  return redactMnemonics(text)
    .replace(/0[xX][a-fA-F0-9]{64,}/g, hideUnlessPublic)
    .replace(/\b[a-fA-F0-9]{64,}\b/g, hideUnlessPublic)
    .replace(/(?<!\d)\d{6,10}:[A-Za-z0-9_-]{30,}/g, "⟨redacted-bot-token⟩");
}

function toWallet(raw: string, position: number): Wallet {
  const normalized = raw.trim().startsWith("0x") ? raw.trim() : `0x${raw.trim()}`;
  try {
    return new Wallet(normalized);
  } catch {
    // Never forward the underlying error: it may quote the key.
    throw new Error(
      `Private key #${position} is not a valid 32-byte hex key. (Seed phrases are not accepted.)`,
    );
  }
}

/**
 * Load keys from PRIVATE_KEY and PRIVATE_KEYS, deduplicated by address.
 *
 * Both variables are read and merged rather than one taking precedence, because
 * the common setup is a main key in one and extras in the other, and silently
 * ignoring half of them loses mints without any visible error.
 */
export function walletsFromEnv(env: NodeJS.ProcessEnv = process.env): LoadedWallet[] {
  const raw = [env.PRIVATE_KEY ?? "", env.PRIVATE_KEYS ?? ""]
    .join("\n")
    .split(/[\s,;]+/)
    .filter(Boolean);
  return loadWallets(raw);
}

export function loadWallets(rawKeys: string[]): LoadedWallet[] {
  const out: LoadedWallet[] = [];
  const seen = new Set<string>();
  // Blanks come from a trailing comma or a stray newline in a pasted list. They
  // are not a malformed key, and reporting them as one sends people looking for a
  // problem with a key that is fine.
  rawKeys
    .filter((raw) => raw.trim() !== "")
    .forEach((raw, i) => {
      const wallet = toWallet(raw, i + 1);
      const lower = wallet.address.toLowerCase();
      if (seen.has(lower)) return; // duplicate key: same nonce space, would collide
      seen.add(lower);
      registerSecret(wallet.privateKey);
      out.push({ index: out.length, address: wallet.address, key: wallet.privateKey });
    });
  return out;
}

export interface GasSettings {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
}

export interface FeeSnapshot {
  baseFeeWei: bigint | null;
  suggestedMaxFeeWei: bigint | null;
  suggestedPriorityWei: bigint | null;
}

export async function readFees(provider: JsonRpcProvider): Promise<FeeSnapshot> {
  try {
    const [feeData, block] = await Promise.all([
      provider.getFeeData(),
      provider.getBlock("latest"),
    ]);
    return {
      baseFeeWei: block?.baseFeePerGas ?? null,
      suggestedMaxFeeWei: feeData.maxFeePerGas ?? feeData.gasPrice ?? null,
      suggestedPriorityWei: feeData.maxPriorityFeePerGas ?? null,
    };
  } catch {
    return { baseFeeWei: null, suggestedMaxFeeWei: null, suggestedPriorityWei: null };
  }
}

/**
 * A fee ceiling that clears the base fee with room for it to rise.
 *
 * Base fee can climb 12.5% per block, and a mint that everyone is watching is
 * exactly when it does. 2× base plus the tip survives several consecutive
 * increases; a ceiling set at current base fails on the very next block. The
 * ceiling is a maximum, not a payment — EIP-1559 refunds the difference, so
 * headroom costs nothing when the network stays calm.
 */
export function suggestMaxFee(baseFeeWei: bigint, priorityWei: bigint): bigint {
  return baseFeeWei * 2n + priorityWei;
}

/** What the node reserves per wallet, and therefore what it checks against. */
export function requiredBalance(mintValue: bigint, gas: GasSettings): bigint {
  return mintValue + gas.gasLimit * gas.maxFeePerGas;
}

export interface BalanceReport {
  index: number;
  address: string;
  balance: bigint | null;
  sufficient: boolean;
  shortfall: bigint;
}

export async function checkBalances(
  provider: JsonRpcProvider,
  wallets: LoadedWallet[],
  required: bigint,
): Promise<BalanceReport[]> {
  const balances = await Promise.all(
    wallets.map((w) => provider.getBalance(w.address).catch(() => null)),
  );
  return wallets.map((w, i) => {
    const balance = balances[i] ?? null;
    // An unreadable balance is unknown, not insufficient: refusing to fire on a
    // flaky RPC read would lose the mint for no reason.
    const sufficient = balance === null || balance >= required;
    return {
      index: w.index,
      address: w.address,
      balance,
      sufficient,
      shortfall: balance !== null && balance < required ? required - balance : 0n,
    };
  });
}

/** Highest fee ceiling this balance can sustain, for a useful error message. */
export function affordableMaxFeeGwei(
  balance: bigint,
  mintValue: bigint,
  gasLimit: bigint,
): number {
  if (balance <= mintValue || gasLimit === 0n) return 0;
  const perGas = (balance - mintValue) / gasLimit;
  return Number(perGas) / 1e9;
}

export function gweiToWei(gwei: number): bigint {
  if (!Number.isFinite(gwei) || gwei < 0) throw new Error(`Invalid gwei value: ${gwei}`);
  // Round through wei rather than float-multiplying: 0.1 gwei is not exact in
  // binary floating point and BigInt() rejects a non-integer.
  return BigInt(Math.round(gwei * 1e9));
}

export function weiToGwei(wei: bigint): number {
  return Number(wei) / 1e9;
}

export function formatEth(wei: bigint, symbol = "ETH", decimals = 6): string {
  const value = Number(formatEther(wei));
  // Very small non-zero amounts must not print as "0.000000" — that reads as free.
  if (value > 0 && value < 10 ** -decimals) return `<0.${"0".repeat(decimals - 1)}1 ${symbol}`;
  return `${value.toFixed(decimals).replace(/\.?0+$/, "")} ${symbol}`;
}

/**
 * Fetch pending nonces for every wallet at once.
 *
 * "pending" rather than "latest" so a transaction already sitting in the mempool
 * is counted — using "latest" would reuse its nonce and produce a replacement
 * that gets rejected as underpriced.
 */
export async function fetchNonces(
  provider: JsonRpcProvider,
  wallets: LoadedWallet[],
): Promise<number[]> {
  return Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending")));
}
