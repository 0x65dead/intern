// Flag parsing.
//
// Hand-rolled rather than a dependency: the surface is small, and the parsing
// rules here are strict in a way most arg libraries are not. An unknown flag is an
// error rather than a silent no-op, because `--quantiy 5` quietly minting 1 token
// is exactly the failure that costs a mint.

export interface CliArgs {
  command: string | null;
  chain?: string;
  target?: string;
  quantity?: number;
  rpc?: string[];
  maxFeeGwei?: number;
  priorityGwei?: number;
  gasLimit?: bigint;
  at?: string;
  leadMs?: number;
  yes: boolean;
  now: boolean;
  watch: boolean;
  skipSimulation: boolean;
  requireSimulation: boolean;
  /** Do every check and sign every transaction, then stop without broadcasting. */
  dryRun: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

/**
 * Every verb the CLI answers to.
 *
 * Exported so the docs can be checked against it: a command that exists but is
 * documented nowhere is the same silent omission as a stage that cannot fire and
 * is left out of the table. `dryrun` is the one that matters most — it is the
 * only way to rehearse a mint without spending, and an operator who never learns
 * it exists rehearses by minting.
 */
export const KNOWN_COMMANDS = new Set([
  "mint",
  "dryrun",
  "allowlist",
  "check",
  "watch",
  "rpc",
  "clock",
  "init",
  "bot",
  "help",
]);

/** Flags taking a value, so `--chain base` is not mistaken for a bare flag. */
const VALUE_FLAGS = new Set([
  "chain",
  "target",
  "collection",
  "quantity",
  "rpc",
  "max-fee",
  "priority-fee",
  "gas-limit",
  "at",
  "lead-ms",
]);

export class ArgError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: null,
    yes: false,
    now: false,
    watch: false,
    skipSimulation: false,
    requireSimulation: false,
    dryRun: false,
    json: false,
    help: false,
    version: false,
  };

  const positional: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const token = argv[i]!;

    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith("-")) {
      positional.push(token);
      i++;
      continue;
    }

    // --name=value and -n=value
    const eq = token.indexOf("=");
    const rawName = eq >= 0 ? token.slice(0, eq) : token;
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : null;
    const name = rawName.replace(/^--?/, "");

    const takeValue = (): string => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next.length > 1)) {
        throw new ArgError(`${rawName} needs a value.`);
      }
      i++;
      return next;
    };

    switch (name) {
      case "h":
      case "help":
        args.help = true;
        break;
      case "v":
      case "version":
        args.version = true;
        break;
      case "c":
      case "chain":
        args.chain = takeValue().trim().toLowerCase();
        break;
      case "t":
      case "target":
      case "collection":
        args.target = takeValue().trim();
        break;
      case "q":
      case "quantity": {
        const value = Number(takeValue());
        if (!Number.isInteger(value) || value < 1 || value > 1000) {
          throw new ArgError("--quantity must be a whole number from 1 to 1000.");
        }
        args.quantity = value;
        break;
      }
      case "rpc": {
        const urls = takeValue()
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean);
        if (urls.length === 0) throw new ArgError("--rpc needs at least one URL or provider key.");
        args.rpc = [...(args.rpc ?? []), ...urls];
        break;
      }
      case "max-fee": {
        const value = Number(takeValue());
        if (!Number.isFinite(value) || value <= 0) {
          throw new ArgError("--max-fee must be a positive number of gwei.");
        }
        args.maxFeeGwei = value;
        break;
      }
      case "priority-fee": {
        const value = Number(takeValue());
        if (!Number.isFinite(value) || value < 0) {
          throw new ArgError("--priority-fee must be a non-negative number of gwei.");
        }
        args.priorityGwei = value;
        break;
      }
      case "gas-limit": {
        const raw = takeValue();
        if (!/^\d+$/.test(raw)) throw new ArgError("--gas-limit must be a whole number.");
        const value = BigInt(raw);
        if (value < 21_000n) throw new ArgError("--gas-limit below 21000 cannot pay for any transaction.");
        args.gasLimit = value;
        break;
      }
      case "at":
        args.at = takeValue().trim();
        break;
      case "lead-ms": {
        const value = Number(takeValue());
        if (!Number.isInteger(value) || value < 0 || value > 60_000) {
          throw new ArgError("--lead-ms must be a whole number of milliseconds from 0 to 60000.");
        }
        args.leadMs = value;
        break;
      }
      case "y":
      case "yes":
      case "assume-yes":
        args.yes = true;
        break;
      case "now":
        args.now = true;
        break;
      case "watch":
        args.watch = true;
        break;
      case "skip-simulation":
        args.skipSimulation = true;
        break;
      case "require-simulation":
        args.requireSimulation = true;
        break;
      case "dry-run":
      case "dryrun":
        args.dryRun = true;
        break;
      case "json":
        args.json = true;
        break;
      default:
        throw new ArgError(`Unknown option "${rawName}". Run \`intern help\` for the full list.`);
    }

    if (inlineValue !== null && !VALUE_FLAGS.has(name) && !["y", "yes"].includes(name)) {
      throw new ArgError(`${rawName} does not take a value.`);
    }
    i++;
  }

  const [first, ...rest] = positional;
  if (first !== undefined) {
    if (KNOWN_COMMANDS.has(first)) {
      args.command = first;
      // A bare second positional is the target: `intern mint tadaaaaaa`.
      if (rest[0] !== undefined && args.target === undefined) args.target = rest[0];
    } else {
      // `intern tadaaaaaa` with no verb means mint that target.
      args.command = "mint";
      if (args.target === undefined) args.target = first;
    }
  }

  if (args.command === "dryrun") {
    // The verb and the flag are the same request, and collapsing them here means
    // the mint path has exactly one notion of "do not broadcast".
    args.command = "mint";
    args.dryRun = true;
  }

  if (args.now && args.at !== undefined) {
    throw new ArgError("--now and --at are mutually exclusive.");
  }
  if (args.skipSimulation && args.requireSimulation) {
    throw new ArgError("--skip-simulation and --require-simulation contradict each other.");
  }

  return args;
}

export const HELP = `intern — NFT mint sniper for OpenSea SeaDrop

USAGE
  intern [command] [target] [options]

COMMANDS
  mint <target>       Snipe a public SeaDrop mint. Default when a target is given.
  dryrun <target>     Every check, every signature, no broadcast. Spends nothing.
  allowlist <target>  Mint an allowlist / WL FCFS stage (needs OPENSEA_API_KEY).
  check <target>      Report drop state and wallet eligibility. Sends nothing.
  watch <target>      Wait for a stage to be configured, then report. Sends nothing.
  rpc                 Probe and rank RPC endpoints for a chain.
  clock               Measure this machine's clock error against the chain.
  init                Write a commented .env template.
  bot                 Run the Telegram bot.
  help                Show this text.

TARGET
  An OpenSea collection URL, an item URL, a bare slug, or a contract address.

OPTIONS
  -c, --chain <key>        ethereum | base | robinhood | ink | arbitrum |
                           optimism | polygon | zora        (default: base)
  -q, --quantity <n>       Tokens per wallet                 (default: 1)
      --rpc <url,...>      RPC URLs or an Alchemy key. Repeatable.
      --max-fee <gwei>     Fee ceiling. Derived from base fee when unset.
      --priority-fee <g>   Priority tip.
      --gas-limit <n>      Gas limit                        (default: 250000)
      --at <time>          Fire at HH:MM, an ISO timestamp, a unix time, or +5m.
      --now                Fire as soon as everything is prepared.
      --lead-ms <n>        Fire n ms before the stage opens  (default: 0)
      --watch              Wait for the drop to be configured, then mint.
      --require-simulation Abort if any wallet's simulation reverts.
      --skip-simulation    Skip the eth_call check. Faster setup, no revert protection.
      --dry-run            Prepare and sign, then stop. Same as the dryrun command.
  -y, --yes                Skip the confirmation prompt.
      --json               Machine-readable output where supported.
  -h, --help               This text.
  -v, --version            Version.

EXAMPLES
  intern init
  intern check https://opensea.io/collection/tadaaaaaa
  intern dryrun tadaaaaaa --chain robinhood --quantity 2
  intern mint tadaaaaaa --chain robinhood --quantity 2
  intern mint 0xabc…def --chain base --at 21:00 --max-fee 0.05 -y
  intern rpc --chain base
  intern bot

NOTES
  Public mints read price, fee recipient and timing from the contract, so they
  need no OpenSea key. Allowlist stages need one: their signature is issued by
  OpenSea and cannot be produced locally.

  Transactions are signed before the stage opens; at T-0 the only work left is
  writing bytes to already-open sockets.

  \`dryrun\` runs the same preflight as \`mint\` — balances, per-wallet cap,
  simulation, clock drift, nonces, signing — and stops at the broadcast. It does
  not wait for T-0; it reports when T-0 is. A clean dry run does not promise the
  mint will succeed: before a stage opens every simulation reverts with NotActive,
  eligible or not.
`;
