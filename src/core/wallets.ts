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

/**
 * Registered secrets in their verbatim form, for the ones no shape can catch.
 *
 * The hex set above works because a private key has a shape a regex can find.
 * The OpenSea credentials do not: an API key, a scoped PAT and a wallet JWT are
 * opaque strings whose character class overlaps ordinary prose and ordinary
 * URLs. Nothing about `read:eligibility` or a base64url run distinguishes a
 * credential from a slug, so shape-matching them would either miss the secret or
 * redact half the log.
 *
 * Identity is the only reliable answer for those, so the verbatim string is kept
 * and struck by exact substring match. That covers the case that actually
 * happens — a credential this process loaded appearing in an error, a header
 * dump or a Telegram message — while {@link JWT_PATTERN} and friends below cover
 * a token we never held, such as one quoted back at us in an API error body.
 */
const literalSecrets = new Set<string>();

/**
 * Below this length a "secret" is too short to strike safely.
 *
 * A registered value is replaced wherever it appears, so registering a short
 * string would censor unrelated text: a 4-character token would blank every
 * incidental occurrence of those 4 characters in every log line. Every real
 * credential here clears this comfortably — an OpenSea API key is 32 characters,
 * a scoped PAT is far longer, a private key is 64 hex — so the floor costs
 * nothing and stops a misconfigured one-character value from redacting the whole
 * output.
 */
const MIN_LITERAL_SECRET_LENGTH = 12;

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
 *
 * Both forms are recorded. The hex set catches a private key however it is spelled
 * (`0x`-prefixed or bare, upper or lower case), because normalising collapses
 * those spellings onto one another. The literal set catches everything that is not
 * hex — the OpenSea API key, the scoped PAT, a wallet JWT — where there is no
 * canonical form to normalise to and case is significant.
 */
export function registerSecret(value: string): void {
  const normal = normalizeHex(value);
  if (normal !== "") secrets.add(normal);

  // Kept verbatim as well: a JWT is base64url, a PAT is opaque, and lowercasing
  // either of them would produce a string that never appears in the output we are
  // trying to censor.
  //
  // Key-shaped hex is the deliberate exception. A 64-hex run is already covered by
  // the shape patterns below, and covered better than an exact-match pass could
  // manage: they collapse both spellings onto one another, they still fire when a
  // stray character is appended to the run, and they label what they strike
  // `⟨redacted-key⟩`. That label is diagnostic — an operator reading a log can see
  // *which kind* of credential escaped into it, which is the difference between
  // rotating one key and rotating everything. Sending a private key down the
  // literal path instead would still redact it, but anonymously, losing that
  // signal for no gain. Shorter hex stays in the literal set: an API key that
  // happens to be all hex is below the 64 characters the shape patterns look for,
  // so identity is the only thing that would catch it.
  const trimmed = value.trim();
  if (trimmed.length < MIN_LITERAL_SECRET_LENGTH) return;
  if (/^[a-f0-9]{64,}$/.test(normal)) return;
  literalSecrets.add(trimmed);
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
  literalSecrets.clear();
}

/** Hide a key-shaped run unless this process vouched for it as a tx hash. */
function hideUnlessPublic(match: string): string {
  const prefixed = /^0[xX]/.test(match);
  const normal = normalizeHex(match);
  if (!secrets.has(normal) && publicHashes.has(normal)) return match;
  return prefixed ? "0x⟨redacted-key⟩" : "⟨redacted-key⟩";
}

/**
 * A wallet JWT, by shape.
 *
 * Every JWT this bot handles is a JOSE compact serialisation, and the header is
 * almost always `{"alg":…` — which base64url-encodes to a literal `eyJ` prefix.
 * Anchoring on that rather than on "three dot-separated base64url runs" is what
 * keeps the pattern from eating ordinary dotted identifiers such as a filename or
 * a package name.
 *
 * This is the backstop for a token we never registered: one quoted back inside an
 * OpenSea error body, or read from an environment we did not load. A token the
 * auth manager fetched is already covered by identity.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

/**
 * An API-key or authorization header, in the HTTP spelling or a JSON/object dump.
 *
 * `x-api-key: abc`, `"x-api-key":"abc"` and `X-API-KEY=abc` all reach a log along
 * some path — a fetch error that quotes its own init object, a config dump in a
 * debug line — and the key is the whole value, so the whole value goes.
 *
 * The value run deliberately extends to the end of the line, stopping only at a
 * quote or a structural delimiter. A tighter class that stopped at the first space
 * would match only the word `Bearer` in `Authorization: Bearer <token>` and leave
 * the token itself sitting in the log — the precise failure this pattern exists to
 * prevent. Over-redacting the tail of a header line costs nothing; under-redacting
 * it costs the credential.
 */
const API_KEY_HEADER_PATTERN =
  /\b(x-api-key|authorization|opensea[_-]?scoped[_-]?token|opensea[_-]?api[_-]?key)(["']?\s*[:=]\s*["']?)([^\r\n"',;}]{4,})/gi;

/**
 * A bearer credential with no header name in front of it.
 *
 * Matched separately because the header pattern above needs a header to anchor on,
 * and a bearer token reaches output without one often enough to matter: inside a
 * quoted curl invocation, or in an SDK error that prints the scheme and the
 * credential but not the field. Anything following `Bearer` on the same line is a
 * credential by definition, whatever it looks like.
 */
const BEARER_PATTERN = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Strike every registered secret by exact match, longest first.
 *
 * Longest first matters when one credential contains another — a bearer header
 * registered whole alongside the token inside it — because replacing the short
 * one first would leave a mangled remainder of the long one that no later pass
 * recognises. Done with split/join rather than a built regex so a credential
 * containing regex metacharacters cannot alter the pattern's meaning.
 */
function redactLiterals(text: string): string {
  if (literalSecrets.size === 0) return text;
  let out = text;
  for (const secret of [...literalSecrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join("⟨redacted-credential⟩");
  }
  return out;
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
 *
 * Registered secrets are struck first, before any shape pattern runs. A
 * credential this process loaded is hidden by identity, which is the only
 * mechanism that works for the OpenSea API key, the scoped PAT and the wallet
 * JWT — none of which have a shape distinguishable from ordinary text.
 */
export function redactKeys(text: string): string {
  return redactMnemonics(redactLiterals(text))
    .replace(JWT_PATTERN, "⟨redacted-jwt⟩")
    .replace(/0[xX][a-fA-F0-9]{64,}/g, hideUnlessPublic)
    .replace(/\b[a-fA-F0-9]{64,}\b/g, hideUnlessPublic)
    .replace(/(?<!\d)\d{6,10}:[A-Za-z0-9_-]{30,}/g, "⟨redacted-bot-token⟩")
    .replace(API_KEY_HEADER_PATTERN, (_m, name: string, sep: string) => `${name}${sep}⟨redacted⟩`)
    .replace(BEARER_PATTERN, (_m, scheme: string) => `${scheme} ⟨redacted⟩`);
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

/**
 * Which wallets a balance report clears to sign, and which it does not.
 *
 * This exists because {@link checkBalances} answers *positionally* — element i
 * describes wallets[i] — and every caller is one careless subscript away from
 * pairing a report with the wrong wallet. That mistake is not symmetric. A
 * missing element reads as `undefined`, `undefined?.sufficient !== false` is
 * true, and the wallet is therefore treated as funded: a gate whose entire job
 * is to stop a doomed broadcast passes everything instead, silently. Pairing on
 * the address removes the subscript, and with it the whole class of bug.
 *
 * A wallet with no report at all is blocked rather than allowed. That is a
 * different judgement from the one inside `checkBalances`, which deliberately
 * treats an *unreadable* balance as sufficient so a flaky RPC read cannot cost
 * the mint. The distinction is what the absence means: a null balance is a
 * network that did not answer, while a missing report is a caller that passed
 * mismatched arrays, and the safe response to "this gate was never evaluated"
 * is not to assume it passed. `verified` says which of the two happened, so the
 * operator sees "underfunded" or "funding unverified" and not one word covering
 * both.
 */
export interface FundingSplit {
  funded: LoadedWallet[];
  blocked: {
    wallet: LoadedWallet;
    /** True when a report actually said insufficient; false when none existed. */
    verified: boolean;
  }[];
}

export function splitByFunding(
  wallets: LoadedWallet[],
  reports: readonly BalanceReport[],
): FundingSplit {
  const byAddress = new Map(reports.map((r) => [r.address.toLowerCase(), r]));
  const split: FundingSplit = { funded: [], blocked: [] };
  for (const wallet of wallets) {
    const report = byAddress.get(wallet.address.toLowerCase());
    if (report === undefined) {
      split.blocked.push({ wallet, verified: false });
    } else if (report.sufficient) {
      split.funded.push(wallet);
    } else {
      split.blocked.push({ wallet, verified: true });
    }
  }
  return split;
}

/**
 * Pair positional per-wallet values with the wallets they were computed for.
 *
 * The companion to {@link splitByFunding}, for {@link fetchNonces} and anything
 * else that answers one value per wallet in order. Keyed by lowercase address
 * because that is the only identifier that survives being handed a subset.
 */
export function pairByAddress<T>(
  wallets: LoadedWallet[],
  values: readonly T[],
): Map<string, T> {
  const out = new Map<string, T>();
  wallets.forEach((wallet, i) => {
    if (i < values.length) out.set(wallet.address.toLowerCase(), values[i] as T);
  });
  return out;
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
