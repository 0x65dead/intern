// The interactive wizard.
//
// Split into two phases on purpose. The first collects what is needed to *read*
// the drop; the second asks about gas and timing only after the drop's real price,
// per-wallet cap and opening time have been printed. Asking for a fee ceiling
// before showing what the mint costs invites a number picked from nothing.
//
// Every prompt has a default that is safe to accept, so a contested mint can be
// driven by pressing enter — and every default comes from either .env or the chain,
// never from a guess.

import { ChainProfile, CHAINS, resolveChain } from "../core/chains";
import { LoadedWallet, formatEth, loadWallets, walletsFromEnv, weiToGwei } from "../core/wallets";
import { PreparedRun, DEFAULT_GAS_LIMIT } from "../core/prepare";
import { Defaults } from "../util/env";
import { maskRpc } from "../core/rpc";
import { formatLocal, formatRemaining, parseTimeInput } from "../core/timing";
import { shortAddress } from "../core/target";
import { c, field, heading, info, ok, warn } from "../util/render";
import { askChoice, askHidden, askNumber, askText, askYesNo } from "../util/prompt";

import { writeOut } from "../util/out";
export interface TargetConfig {
  wallets: LoadedWallet[];
  chainKey: string;
  target: string;
  quantity: number;
  manualRpcs: string[];
}

export type Timing = "stage" | "now" | { atMs: number };

export interface ExecutionConfig {
  maxFeeGwei: number | null;
  priorityGwei: number | null;
  gasLimit: bigint;
  timing: Timing;
  leadMs: number;
}

/**
 * Load wallets, preferring .env and falling back to pasted keys.
 *
 * Pasting is offered as the *safer* option and labelled as such, because it is:
 * the key exists in process memory only, and never touches the disk. The .env
 * route is convenient and is what most people will use, so the trade-off is stated
 * once, plainly, rather than buried in a README.
 */
async function collectWallets(): Promise<LoadedWallet[]> {
  const fromEnv = walletsFromEnv();
  if (fromEnv.length > 0) {
    writeOut(
      ok(`${fromEnv.length} wallet(s) loaded from .env: ${fromEnv.map((w) => shortAddress(w.address)).join(", ")}\n`),
    );
    if (await askYesNo("Use these wallets?", true)) return fromEnv;
  }

  writeOut(heading("Wallets") + "\n");
  writeOut(
    info("Paste one private key per line. Input is not echoed. Blank line when done.\n"),
  );
  writeOut(info("Keys entered here stay in memory and are never written to disk.\n"));

  const keys: string[] = [];
  for (;;) {
    const raw = await askHidden(c.gray(`  › key ${keys.length + 1} (blank to finish): `));
    if (raw.trim() === "") break;
    try {
      // Load incrementally so a bad key is reported at the line it was typed on,
      // rather than after the whole set has been entered.
      const wallet = loadWallets([raw])[0]!;
      keys.push(raw);
      writeOut(ok(`W${keys.length - 1}  ${wallet.address}\n`));
    } catch (err: unknown) {
      writeOut(
        `  ${c.red("✗")} ${err instanceof Error ? err.message : "Invalid key."}\n`,
      );
    }
  }

  const wallets = loadWallets(keys);
  if (wallets.length === 0) throw new Error("No wallets entered — nothing to mint with.");
  if (wallets.length < keys.length) {
    writeOut(
      warn(`${keys.length - wallets.length} duplicate key(s) ignored — they share a nonce space.\n`),
    );
  }
  return wallets;
}

async function collectChain(fallback: string): Promise<string> {
  const known = resolveChain(fallback);
  const defaultIndex = Math.max(
    0,
    CHAINS.findIndex((chain) => chain.key === (known?.key ?? "base")),
  );
  const chain = await askChoice(
    "Chain",
    CHAINS.map((entry) => ({
      label: entry.name,
      value: entry.key,
      hint: `id ${entry.chainId} · ~${entry.blockTimeSec}s blocks`,
    })),
    defaultIndex,
  );
  return chain;
}

export async function collectTargetConfig(
  defaults: Defaults,
  preset: Partial<TargetConfig> & { target?: string } = {},
): Promise<TargetConfig> {
  const wallets = preset.wallets ?? (await collectWallets());
  const chainKey = preset.chainKey ?? (await collectChain(defaults.chain));

  let target = preset.target ?? "";
  while (!target.trim()) {
    writeOut(heading("Target") + "\n");
    writeOut(info("An OpenSea link, a collection slug, or a contract address.\n"));
    target = await askText("target");
  }

  const quantity =
    preset.quantity ??
    (await askNumber("quantity per wallet", defaults.quantity, {
      min: 1,
      max: 1000,
      integer: true,
    }));

  // RPC choice is the single biggest speed factor, so it is asked about even
  // though a default exists — a public endpoint during a contested mint is the
  // difference between arriving in block N and block N+2.
  const manualRpcs = preset.manualRpcs ?? (await collectRpcs(chainKey));

  return { wallets, chainKey, target: target.trim(), quantity, manualRpcs };
}

async function collectRpcs(chainKey: string): Promise<string[]> {
  const configured = process.env[`RPC_URL_${chainKey.toUpperCase()}`] ?? process.env.RPC_URL;
  if (configured) {
    writeOut(ok(`private RPC from .env: ${maskRpc(configured.split(",")[0]!)}\n`));
    return [];
  }

  writeOut(heading("RPC") + "\n");
  writeOut(
    warn("No private RPC configured. Public endpoints are shared and rate-limited.\n"),
  );
  const entry = await askText("RPC URL or Alchemy key (enter to use public endpoints)");
  return entry.trim() ? [entry.trim()] : [];
}

/**
 * Ask about gas and timing, with the drop's actual numbers on screen.
 *
 * The fee ceiling default is the chain's own suggestion (2× base + tip). It is
 * offered as a number the user can accept or override, and the wording says
 * explicitly that a ceiling is a maximum rather than a payment — the most common
 * misreading, and the one that makes people set it too low.
 */
export async function collectExecutionConfig(
  run: PreparedRun,
  defaults: Defaults,
): Promise<ExecutionConfig> {
  const suggestedMaxFee = Number(weiToGwei(run.gas.maxFeePerGas).toFixed(4));
  const suggestedPriority = Number(weiToGwei(run.gas.maxPriorityFeePerGas).toFixed(4));

  writeOut(heading("Gas") + "\n");
  if (run.fees.baseFeeWei !== null) {
    writeOut(
      info(`base fee is ${weiToGwei(run.fees.baseFeeWei).toFixed(4)} gwei right now\n`),
    );
  }
  writeOut(
    info("The ceiling is a maximum, not a payment — unused headroom is refunded.\n"),
  );

  const maxFeeGwei = await askNumber("fee ceiling (gwei)", suggestedMaxFee, { min: 0.000001 });
  const priorityGwei = await askNumber("priority tip (gwei)", suggestedPriority, { min: 0 });
  const gasLimit = BigInt(
    await askNumber("gas limit", Number(defaults.gasLimit || DEFAULT_GAS_LIMIT), {
      min: 21_000,
      max: 30_000_000,
      integer: true,
    }),
  );

  const worstCase = gasLimit * BigInt(Math.round(maxFeeGwei * 1e9));
  writeOut(
    info(`worst case gas: ${formatEth(worstCase, run.chain.nativeSymbol)} per wallet\n`),
  );

  const timing = await collectTiming(run);
  const leadMs =
    timing === "now"
      ? 0
      : await askNumber("fire this many ms early (0 = at T-0)", defaults.leadMs, {
          min: 0,
          max: 60_000,
          integer: true,
        });

  return { maxFeeGwei, priorityGwei, gasLimit, timing, leadMs };
}

async function collectTiming(run: PreparedRun): Promise<Timing> {
  const plan = run.plan;
  if (!plan) return "now";

  const startMs = plan.drop.startTime * 1000;
  const untilStart = startMs - Date.now();

  if (untilStart <= 0) {
    writeOut(ok("The stage is already open — firing immediately.\n"));
    return "now";
  }

  const choice = await askChoice<"stage" | "now" | "custom">(
    `Stage opens in ${formatRemaining(untilStart)} (${formatLocal(startMs)}). When should intern fire?`,
    [
      {
        label: "At the stage opening",
        value: "stage",
        hint: "recommended — waits with a clock-corrected timer",
      },
      { label: "Now", value: "now", hint: "will revert with NotActive until the stage opens" },
      { label: "At a time I specify", value: "custom", hint: "HH:MM, ISO, unix, or +5m" },
    ],
    0,
  );

  if (choice === "stage") return "stage";
  if (choice === "now") return "now";

  for (;;) {
    const raw = await askText("fire at");
    try {
      const atMs = parseTimeInput(raw);
      writeOut(ok(`firing at ${formatLocal(atMs)}\n`));
      if (atMs < startMs) {
        writeOut(
          warn("That is before the stage opens — the mint will revert with NotActive.\n"),
        );
        if (!(await askYesNo("Fire anyway?", false))) continue;
      }
      return { atMs };
    } catch (err: unknown) {
      writeOut(`  ${c.red("✗")} ${err instanceof Error ? err.message : "Bad time."}\n`);
    }
  }
}

/**
 * The last stop before anything irreversible happens.
 *
 * Deliberately restates the total spend across all wallets, the chain by name, and
 * the target address. Those are the three things that, if wrong, cost real money —
 * and the point of a final confirmation is to show what would actually happen, not
 * to ask "are you sure".
 */
export async function confirmFire(
  run: PreparedRun,
  config: ExecutionConfig,
  wallets: LoadedWallet[],
  chain: ChainProfile,
): Promise<boolean> {
  const plan = run.plan;
  writeOut(heading("Confirm") + "\n");

  const perWallet = plan?.value ?? 0n;
  const total = perWallet * BigInt(wallets.length);
  const maxFeeGwei = config.maxFeeGwei ?? 0;
  const gasWorstCase = config.gasLimit * BigInt(Math.round(maxFeeGwei * 1e9));
  const totalWorstCase = total + gasWorstCase * BigInt(wallets.length);

  writeOut(field("chain", `${chain.name} ${c.gray(`(id ${chain.chainId})`)}`) + "\n");
  writeOut(field("contract", run.contract) + "\n");
  if (run.collection) writeOut(field("collection", run.collection.name) + "\n");
  writeOut(
    field("wallets", `${wallets.length} — ${wallets.map((w) => shortAddress(w.address)).join(", ")}`) + "\n",
  );
  if (plan) {
    writeOut(
      field("mint cost", `${formatEth(total, chain.nativeSymbol)} total (${formatEth(perWallet, chain.nativeSymbol)} each)`) + "\n",
    );
  }
  writeOut(
    field("max total", `${formatEth(totalWorstCase, chain.nativeSymbol)} ${c.gray("if every ceiling is fully used")}`) + "\n",
  );
  writeOut(
    field(
      "fires",
      config.timing === "now"
        ? "immediately"
        : config.timing === "stage"
          ? `at the stage opening${config.leadMs ? ` minus ${config.leadMs}ms` : ""}`
          : formatLocal(config.timing.atMs),
    ) + "\n",
  );

  return askYesNo(c.bold("Send these transactions?"), false);
}
