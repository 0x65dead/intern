#!/usr/bin/env node
// CLI entry point.
//
// Every command that can spend money follows the same shape: resolve → report →
// confirm → fire. The reporting step is not decoration; it is where a wrong chain,
// a wrong contract, an unaffordable ceiling or a sold-out drop becomes visible
// while it is still free to fix.
//
// `check`, `watch`, `rpc` and `clock` never sign anything, so they are safe to run
// against a live drop while deciding.

import { ArgError, CliArgs, HELP, parseArgs } from "./args";
import { CHAINS, explorerAddress, resolveChain } from "../core/chains";
import { syncClock } from "../core/clock";
import { planRpcs, resolveRpcsForChain, maskRpc, toRpcUrl } from "../core/rpc";
import { planWarnings } from "../core/seadrop";
import { EngineEvent, runMint, resolveFireTime } from "../core/engine";
import { DryRunReport, dryRunVerdict } from "../core/dryrun";
import { PreArmed, preArmAllowlist, runAllowlistMint } from "../core/allowlist";
import {
  AmbiguousChainError,
  PrepareOptions,
  PreparedRun,
  closeRun,
  noDropMessage,
  prepareRun,
  stageContext,
} from "../core/prepare";
import { StageContext } from "../core/stagetable";
import { orderCandidates } from "../core/detect";
import { shortAddress } from "../core/target";
import { PRE_ARM_LEAD_MS } from "../core/race";
import { waitForPublicStage, waitForScheduledStage } from "../core/watcher";
import { DropStage, fetchDropSchedule, liveStage, nextStage } from "../core/opensea";
import { OpenSeaAuthManager, authManagerFrom } from "../core/openseaauth";
import { EligibilityHint } from "../core/failures";
import {
  hintForStage,
  mintTerms,
  tryFetchWalletEligibility,
} from "../core/openseaeligibility";
import {
  checkBalances,
  formatEth,
  gweiToWei,
  redactKeys,
  requiredBalance,
  walletsFromEnv,
} from "../core/wallets";
import { formatRemaining, formatUtc, parseTimeInput } from "../core/timing";
import { loadEnv, readDefaults, writeEnvTemplate } from "../util/env";
import { c, banner, field, heading, info, ok, warn, table } from "../util/render";
import { askChoice, closePrompts } from "../util/prompt";
import { createReporter, printGasSummary, printPlan, printRpcPlan, printStages } from "./report";
import {
  ExecutionConfig,
  collectExecutionConfig,
  collectTargetConfig,
  confirmFire,
} from "./wizard";

import { writeOut, writeErr } from "../util/out";
const VERSION = "1.0.0";

/** Ctrl+C must never leave a run half-fired without saying so. */
function installSignalHandlers(controller: AbortController): void {
  let interrupted = false;
  const onSignal = (): void => {
    if (interrupted) process.exit(130); // second Ctrl+C: leave immediately
    interrupted = true;
    controller.abort();
    writeOut(
      c.yellow("\n  Interrupted. Nothing further will be sent; in-flight transactions continue.\n"),
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    if (err instanceof ArgError) {
      writeErr(`${c.red("✗")} ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  if (args.version) {
    writeOut(`intern ${VERSION}\n`);
    return;
  }
  if (args.help || args.command === "help" || args.command === null) {
    if (!args.json) writeOut(`${banner()}\n`);
    writeOut(HELP);
    return;
  }

  loadEnv();
  const defaults = readDefaults();
  const controller = new AbortController();
  installSignalHandlers(controller);

  switch (args.command) {
    case "init":
      return cmdInit();
    case "rpc":
      return cmdRpc(args, defaults.chain);
    case "clock":
      return cmdClock(args, defaults.chain);
    case "check":
      return cmdCheck(args, defaults);
    case "watch":
      return cmdWatch(args, defaults, controller.signal);
    case "allowlist":
      return cmdAllowlist(args, defaults, controller.signal);
    case "mint":
      return cmdMint(args, defaults, controller.signal);
    case "bot":
      return cmdBot();
    default:
      writeErr(`${c.red("✗")} Unknown command "${args.command}".\n`);
      process.exit(2);
  }
}

// ── shared preparation ───────────────────────────────────────────────────────

/**
 * `prepareRun`, but resolving an ambiguous bare address by asking.
 *
 * A bare address with no `--chain` is probed on every chain (Task 2). One hit
 * settles it silently; several hits are genuinely undecidable — the same address
 * is a different deployment on each — so the core throws rather than guess. Here is
 * where the CLI answers that: a numbered picker at a TTY, the same one the wizard
 * uses; a clear error naming the candidates and `--chain` when input is scripted,
 * because a pipe cannot choose and picking for it could mint on the wrong network.
 */
/**
 * The stage table's context, built the same way for every command.
 *
 * One function so `intern check` and `intern mint` cannot disagree about whether
 * a stage is fireable — a check that says "yes" followed by a mint that refuses
 * is the worst of both.
 */
function stageCtx(
  run: PreparedRun,
  defaults: ReturnType<typeof readDefaults>,
): StageContext {
  return stageContext(run, {
    allowlistMinting: defaults.allowlistMinting,
    openseaApiKey: defaults.openseaApiKey !== null,
  });
}

/**
 * The eligibility credential, built once per process.
 *
 * Built once and shared rather than per call, because the manager's value is the
 * JWT it holds: a second manager means a second token exchange for the same
 * answer. Returns null when neither credential is configured, which is a
 * supported state — the stage table then reports eligibility as unknown, with
 * the reason, rather than claiming a verdict it has no way to obtain.
 */
function eligibilityAuth(
  defaults: ReturnType<typeof readDefaults>,
): OpenSeaAuthManager | null {
  const { manager } = authManagerFrom({
    apiKey: defaults.openseaApiKey,
    scopedToken: defaults.openseaScopedToken,
    walletToken: defaults.openseaWalletToken,
  });
  return manager;
}

async function prepareResolvingChain(opts: PrepareOptions): Promise<PreparedRun> {
  try {
    return await prepareRun(opts);
  } catch (err: unknown) {
    if (!(err instanceof AmbiguousChainError)) throw err;

    const candidates = orderCandidates(err.candidates);
    if (!process.stdin.isTTY) {
      throw new Error(
        `${shortAddress(err.address)} has contract code on ${candidates.length} chains ` +
          `(${candidates.map((chain) => chain.key).join(", ")}). ` +
          `Re-run with --chain to say which one you mean.`,
      );
    }

    writeOut(
      warn(`${err.address} has contract code on ${candidates.length} chains — same address, different deployments.\n`),
    );
    const chainKey = await askChoice(
      "Which chain did you mean?",
      candidates.map((chain) => ({
        label: chain.name,
        value: chain.key,
        hint: `id ${chain.chainId}`,
      })),
      0,
    );
    // Chain now fixed, so this pass cannot come back ambiguous.
    return prepareRun({ ...opts, chainKey });
  }
}

// ── init ─────────────────────────────────────────────────────────────────────

function cmdInit(): void {
  const result = writeEnvTemplate();
  if (!result.created) {
    writeOut(warn(`${result.path} already exists — left untouched.\n`));
    return;
  }
  writeOut(ok(`Wrote ${result.path} (mode 0600).\n`));
  writeOut(
    info("Fill in a private RPC first — it is the single biggest speed factor.\n"),
  );
  writeOut(info("Add .env to .gitignore before committing anything.\n"));
}

// ── rpc ──────────────────────────────────────────────────────────────────────

async function cmdRpc(args: CliArgs, defaultChain: string): Promise<void> {
  const chain = requireChain(args.chain ?? defaultChain);
  const manual = (args.rpc ?? [])
    .map((entry) => toRpcUrl(entry, chain.key))
    .filter((url): url is string => url !== null);
  const resolved = resolveRpcsForChain(chain.key, manual);

  writeOut(heading(`Endpoints for ${chain.name}`) + "\n");
  writeOut(info(`${resolved.source}\n`));
  writeOut(info(`sampling each endpoint 5× and taking the median…\n`));

  const plan = await planRpcs(resolved.urls, chain.chainId, { samples: 5 });

  if (args.json) {
    writeOut(
      `${JSON.stringify(
        {
          chain: chain.key,
          chainId: chain.chainId,
          read: plan.read.map(maskRpc),
          blast: plan.blast.map(maskRpc),
          health: plan.health.map((h) => ({
            endpoint: maskRpc(h.url),
            label: h.label,
            chainId: h.chainId,
            latencyMs: h.latencyMs,
            readable: h.readable,
            ...(h.error ? { error: h.error } : {}),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  printRpcPlan(plan, chain);
  if (plan.read.length > 0) {
    writeOut(
      info(`fastest read endpoint: ${maskRpc(plan.read[0]!)} — reads will go here\n`),
    );
  }
}

// ── clock ────────────────────────────────────────────────────────────────────

async function cmdClock(args: CliArgs, defaultChain: string): Promise<void> {
  const chain = requireChain(args.chain ?? defaultChain);
  const resolved = resolveRpcsForChain(chain.key);

  writeOut(heading(`Clock check against ${chain.name}`) + "\n");
  writeOut(info("sampling HTTP Date headers and the chain head…\n"));

  const sync = await syncClock(resolved.urls, chain.blockTimeSec, { rounds: 4 });
  if (!sync.synced) {
    writeOut(warn("No endpoint answered — cannot measure the clock.\n"));
    process.exitCode = 1;
    return;
  }

  const rows = sync.samples
    .slice()
    .sort((a, b) => a.rttMs - b.rttMs)
    .slice(0, 10)
    .map((s) => [
      `  ${s.source}`,
      `${s.offsetMs >= 0 ? "+" : ""}${Math.round(s.offsetMs)}ms`,
      c.gray(`rtt ${s.rttMs}ms`),
    ]);
  writeOut(`${table(rows)}\n\n`);

  const sign = sync.offsetMs >= 0 ? "+" : "";
  writeOut(
    field("offset", `${sign}${sync.offsetMs}ms ${c.gray(`(±${sync.uncertaintyMs}ms)`)}`) + "\n",
  );
  writeOut(
    field(
      "meaning",
      Math.abs(sync.offsetMs) < 50
        ? "clock is accurate — no correction needed"
        : sync.offsetMs > 0
          ? `local clock is ${sync.offsetMs}ms SLOW — uncorrected, mints would fire ${sync.offsetMs}ms late`
          : `local clock is ${-sync.offsetMs}ms FAST — uncorrected, mints would fire early and revert`,
    ) + "\n",
  );
  writeOut(ok("intern corrects for this automatically on every run.\n"));
  if (Math.abs(sync.offsetMs) > 500) {
    writeOut(warn("Over 500ms out. Enable NTP: `timedatectl set-ntp true`.\n"));
  }
}

// ── check ────────────────────────────────────────────────────────────────────

async function cmdCheck(args: CliArgs, defaults: ReturnType<typeof readDefaults>): Promise<void> {
  const target = requireTarget(args);
  const quantity = args.quantity ?? defaults.quantity;

  // Loaded before the prepare rather than at the balance check below, because the
  // stage table needs to know whether a configured SeaDrop signer is one of ours
  // — that is the difference between "must ask OpenSea" and "can sign it here".
  const wallets = walletsFromEnv();

  const run = await prepareResolvingChain({
    target,
    chainKey: args.chain,
    quantity,
    walletAddresses: wallets.map((w) => w.address),
    allowlistSource: defaults.allowlistSource,
    openseaAuth: eligibilityAuth(defaults),
    manualRpcs: args.rpc ?? [],
    apiKey: defaults.openseaApiKey,
    maxFeeGwei: args.maxFeeGwei ?? defaults.maxFeeGwei,
    priorityGwei: args.priorityGwei ?? defaults.priorityGwei,
    gasLimit: args.gasLimit ?? defaults.gasLimit,
    defaultChain: defaults.chain,
    onProgress: (message) => writeOut(info(`${message}\n`)),
  });

  try {
    for (const message of run.warnings) writeOut(warn(`${message}\n`));
    printRpcPlan(run.rpc.plan, run.chain);

    writeOut(heading("Collection") + "\n");
    if (run.collection) writeOut(field("name", run.collection.name) + "\n");
    writeOut(field("contract", run.contract) + "\n");
    writeOut(field("explorer", explorerAddress(run.chain.chainId, run.contract)) + "\n");
    if (run.detection) {
      writeOut(info(`chain determined by probing for contract code\n`));
    }

    // Every stage — on-chain public plus whatever OpenSea lists — in the same
    // seven columns the bot's 📊 Stages panel shows. Printed whether or not a
    // public drop exists, because "the public stage is not configured but an
    // allowlist opens in 2h" is exactly what the user needs to see.
    printStages(run.stages, run.chain, Date.now(), stageCtx(run, defaults));

    if (!run.plan) {
      writeOut(`\n${warn(noDropMessage(run.contract, run.chain.name, defaults.openseaApiKey !== null))}\n`);
      process.exitCode = 1;
      return;
    }

    printPlan(run.plan, run.chain, quantity);
    for (const message of planWarnings(run.plan, Date.now())) {
      writeOut(warn(`${message}\n`));
    }
    printGasSummary(
      run.gas.maxFeePerGas,
      run.gas.maxPriorityFeePerGas,
      run.gas.gasLimit,
      run.fees.baseFeeWei,
    );

    // Wallet eligibility, when there are wallets to check. `check` never signs, so
    // this is purely a read of what would happen.
    if (wallets.length === 0) {
      writeOut(info("\nNo wallets in .env — skipping the balance check.\n"));
    } else {
      const required = requiredBalance(run.plan.value, run.gas);
      const reports = await checkBalances(run.rpc.provider, wallets, required);
      writeOut(heading("Wallets") + "\n");
      for (const report of reports) {
        const balance =
          report.balance === null ? c.gray("unreadable") : formatEth(report.balance, run.chain.nativeSymbol);
        const line = `[W${report.index}] ${report.address}  ${balance}`;
        if (report.balance !== null && report.balance < required) {
          writeOut(
            `  ${c.red("✗")} ${line}  ${c.red(`short ${formatEth(report.shortfall, run.chain.nativeSymbol)}`)}\n`,
          );
        } else {
          writeOut(ok(`${line}\n`));
        }
      }
      writeOut(
        info(`each wallet needs ${formatEth(required, run.chain.nativeSymbol)} (value + gasLimit × maxFeePerGas)\n`),
      );
    }

    writeOut(
      `\n${ok(`Nothing was sent. To mint: ${c.bold(`intern mint ${target}${args.chain ? ` --chain ${args.chain}` : ""}`)}\n`)}`,
    );
  } finally {
    closeRun(run);
  }
}

// ── watch ────────────────────────────────────────────────────────────────────

async function cmdWatch(
  args: CliArgs,
  defaults: ReturnType<typeof readDefaults>,
  signal: AbortSignal,
): Promise<void> {
  const target = requireTarget(args);
  const quantity = args.quantity ?? defaults.quantity;

  const run = await prepareResolvingChain({
    target,
    chainKey: args.chain,
    quantity,
    manualRpcs: args.rpc ?? [],
    apiKey: defaults.openseaApiKey,
    gasLimit: args.gasLimit ?? defaults.gasLimit,
    defaultChain: defaults.chain,
    onProgress: (message) => writeOut(info(`${message}\n`)),
  });

  try {
    writeOut(heading(`Watching ${run.contract} on ${run.chain.name}`) + "\n");
    writeOut(info("Reads only — nothing will be sent. Ctrl+C to stop.\n"));
    // No wallets were loaded for a watch, so nothing can claim a local signer.
    // The table says "no" for every gated row, which is the truth here.
    printStages(run.stages, run.chain, Date.now(), stageCtx(run, defaults));

    const plan = await waitForPublicStage(run.rpc.provider, run.contract, quantity, {
      signal,
      onUpdate: (update) => {
        const stamp = c.gray(new Date().toLocaleTimeString());
        const mark = update.kind === "opened" ? c.green("✓") : update.kind === "rescheduled" ? c.yellow("⚠") : c.gray("·");
        writeOut(`  ${mark} ${stamp} ${update.message}\n`);
      },
    });

    printPlan(plan, run.chain, quantity);
    writeOut(
      `\n${ok(`Stage is configured. To mint it: ${c.bold(`intern mint ${target} --chain ${run.chain.key}`)}\n`)}`,
    );
  } finally {
    closeRun(run);
  }
}

// ── mint ─────────────────────────────────────────────────────────────────────

async function cmdMint(
  args: CliArgs,
  defaults: ReturnType<typeof readDefaults>,
  signal: AbortSignal,
): Promise<void> {
  writeOut(`${banner()}\n`);

  // A dry run is a dry run whether it came from the verb, the flag, or .env.
  const dryRun = args.dryRun || defaults.dryRun;
  if (dryRun) {
    writeOut(
      info("DRY RUN — every check and every signature will run; nothing will be broadcast.\n"),
    );
  }

  // Interactive when anything essential is missing; scripted when it is all given.
  const envWallets = walletsFromEnv();
  const interactive = !args.yes || envWallets.length === 0 || args.target === undefined;

  const config = interactive
    ? await collectTargetConfig(defaults, {
        ...(args.target ? { target: args.target } : {}),
        ...(args.chain ? { chainKey: args.chain } : {}),
        ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
        ...(args.rpc ? { manualRpcs: args.rpc } : {}),
        ...(envWallets.length > 0 && args.yes ? { wallets: envWallets } : {}),
      })
    : {
        wallets: envWallets,
        chainKey: args.chain ?? defaults.chain,
        target: requireTarget(args),
        quantity: args.quantity ?? defaults.quantity,
        manualRpcs: args.rpc ?? [],
      };

  const run = await prepareResolvingChain({
    target: config.target,
    chainKey: config.chainKey,
    quantity: config.quantity,
    walletAddresses: envWallets.map((w) => w.address),
    allowlistSource: defaults.allowlistSource,
    openseaAuth: eligibilityAuth(defaults),
    manualRpcs: config.manualRpcs,
    apiKey: defaults.openseaApiKey,
    maxFeeGwei: args.maxFeeGwei ?? defaults.maxFeeGwei,
    priorityGwei: args.priorityGwei ?? defaults.priorityGwei,
    gasLimit: args.gasLimit ?? defaults.gasLimit,
    defaultChain: defaults.chain,
    onProgress: (message) => writeOut(info(`${message}\n`)),
  });

  try {
    for (const message of run.warnings) writeOut(warn(`${message}\n`));
    printRpcPlan(run.rpc.plan, run.chain);
    printStages(run.stages, run.chain, Date.now(), stageCtx(run, defaults));

    // No drop configured. --watch waits for one; otherwise this is a dead end and
    // saying so precisely beats "not a SeaDrop collection".
    let plan = run.plan;
    if (!plan) {
      if (!args.watch) {
        writeOut(`\n${warn(noDropMessage(run.contract, run.chain.name, defaults.openseaApiKey !== null))}\n`);
        writeOut(info("Add --watch to wait for the stage to be configured.\n"));
        process.exitCode = 1;
        return;
      }
      writeOut(heading("Waiting for the stage to be configured") + "\n");
      plan = await waitForPublicStage(run.rpc.provider, run.contract, config.quantity, {
        signal,
        onUpdate: (update) => writeOut(info(`${update.message}\n`)),
      });
      run.plan = plan;
    }

    printPlan(plan, run.chain, config.quantity);

    // Gas and timing: from flags when given, interactively otherwise.
    const execution: ExecutionConfig = interactive
      ? await collectExecutionConfig(run, defaults)
      : {
          maxFeeGwei: args.maxFeeGwei ?? defaults.maxFeeGwei,
          priorityGwei: args.priorityGwei ?? defaults.priorityGwei,
          gasLimit: args.gasLimit ?? defaults.gasLimit,
          timing: args.now ? "now" : args.at ? { atMs: parseTimeInput(args.at) } : "stage",
          leadMs: args.leadMs ?? defaults.leadMs,
        };

    const gas = {
      maxFeePerGas:
        execution.maxFeeGwei != null ? gweiToWei(execution.maxFeeGwei) : run.gas.maxFeePerGas,
      maxPriorityFeePerGas:
        execution.priorityGwei != null
          ? gweiToWei(execution.priorityGwei)
          : run.gas.maxPriorityFeePerGas,
      gasLimit: execution.gasLimit,
    };
    printGasSummary(gas.maxFeePerGas, gas.maxPriorityFeePerGas, gas.gasLimit, run.fees.baseFeeWei);

    if (!args.yes && !dryRun) {
      const confirmed = await confirmFire(run, execution, config.wallets, run.chain);
      if (!confirmed) {
        writeOut(ok("Cancelled. Nothing was sent.\n"));
        return;
      }
    }
    // Release stdin before firing: readline competing with the countdown line
    // corrupts both, and no further input is needed.
    closePrompts();

    const { fireAtMs } = resolveFireTime(
      plan,
      execution.timing === "now"
        ? "now"
        : execution.timing === "stage"
          ? "stage"
          : { atMs: execution.timing.atMs },
      execution.leadMs,
    );

    const render = createReporter({
      chain: run.chain,
      addresses: config.wallets.map((w) => w.address),
    });
    const captured: { report: DryRunReport | null } = { report: null };
    const report = (event: EngineEvent): void => {
      if (event.type === "dryRun") captured.report = event.report;
      render(event);
    };

    const result = await runMint(
      {
        chain: run.chain,
        plan,
        wallets: config.wallets,
        readUrls: run.rpc.plan.read,
        blastUrls: run.rpc.plan.blast,
        gas,
        fireAtMs,
        leadMs: execution.leadMs,
        skipSimulation: args.skipSimulation,
        requireSimulation: args.requireSimulation,
        receiptTimeoutMs: defaults.receiptTimeoutMs,
        dryRun,
        // Advisory unless the operator configured a limit: they can read the
        // measured offset and decide. The bot, with nobody watching, enforces one.
        ...(defaults.clockDriftLimitMs !== null
          ? { driftLimitMs: defaults.clockDriftLimitMs }
          : {}),
        target: config.target,
        signal,
      },
      report,
    );

    if (dryRun) {
      // Exit 1 when a live run would have refused, so `intern dryrun … && intern
      // mint …` is a safe thing to write in a shell.
      const verdict = captured.report ? dryRunVerdict(captured.report) : null;
      if (!verdict?.wouldFire) process.exitCode = 1;
      return;
    }

    printRunSummary(result);
    if (result.minted === 0) process.exitCode = 1;
  } finally {
    closeRun(run);
  }
}

// ── allowlist ────────────────────────────────────────────────────────────────

async function cmdAllowlist(
  args: CliArgs,
  defaults: ReturnType<typeof readDefaults>,
  signal: AbortSignal,
): Promise<void> {
  writeOut(`${banner()}\n`);

  if (!defaults.openseaApiKey) {
    writeErr(
      `${c.red("✗")} An allowlist mint needs OPENSEA_API_KEY: the signature is issued by OpenSea and cannot be produced locally.\n`,
    );
    writeErr(`  ${c.gray("Public stages need no key — use `intern mint`.")}\n`);
    process.exit(2);
  }
  const apiKey = defaults.openseaApiKey;

  const wallets = walletsFromEnv();
  if (wallets.length === 0) {
    writeErr(`${c.red("✗")} No wallets in .env. Set PRIVATE_KEY or PRIVATE_KEYS.\n`);
    process.exit(2);
  }

  const target = requireTarget(args);
  const quantity = args.quantity ?? defaults.quantity;

  // Built here, before the prepare, so the whole command shares one manager and
  // therefore one token exchange. The prepare uses it for the stage table and
  // `learnEligibility` reuses it at T-60s off the cached JWT.
  const { manager: auth, reason: noAuth } = authManagerFrom({
    apiKey,
    scopedToken: defaults.openseaScopedToken,
    walletToken: defaults.openseaWalletToken,
  });

  const run = await prepareResolvingChain({
    target,
    chainKey: args.chain,
    quantity,
    walletAddresses: wallets.map((w) => w.address),
    allowlistSource: defaults.allowlistSource,
    openseaAuth: auth,
    manualRpcs: args.rpc ?? [],
    apiKey,
    maxFeeGwei: args.maxFeeGwei ?? defaults.maxFeeGwei,
    priorityGwei: args.priorityGwei ?? defaults.priorityGwei,
    gasLimit: args.gasLimit ?? defaults.gasLimit,
    defaultChain: defaults.chain,
    onProgress: (message) => writeOut(info(`${message}\n`)),
  });

  try {
    const slug = run.slug;
    if (!slug) {
      throw new Error(
        "An allowlist mint needs the collection slug, which only OpenSea can map. Pass the OpenSea link or slug rather than a contract address.",
      );
    }

    for (const message of run.warnings) writeOut(warn(`${message}\n`));
    printRpcPlan(run.rpc.plan, run.chain);
    printGasSummary(
      run.gas.maxFeePerGas,
      run.gas.maxPriorityFeePerGas,
      run.gas.gasLimit,
      run.fees.baseFeeWei,
    );

    // Wait for a stage OpenSea will actually sign for.
    const schedule = await fetchDropSchedule(slug, apiKey);
    const now = Date.now();
    const open = liveStage(schedule, now);

    // Preparation that does not need OpenSea's signature: nonces, warm sockets, a
    // measured clock offset, and — the reason for doing any of it early — the
    // wallet's eligibility, which OpenSea answers before the stage opens. Held in
    // a box rather than a bare `let` because it is assigned from the watcher's
    // callback, and a closure assignment is not something the compiler's flow
    // analysis can follow to the read below.
    const arm: { value: PreArmed | null } = { value: null };

    // Per wallet, never shared. Two wallets on the same drop routinely differ, and
    // one wallet's allowance must never be used to explain another's refusal.
    const eligibility = new Map<string, EligibilityHint>();
    const loaded = new Set(wallets.map((w) => w.address.toLowerCase()));

    /**
     * Ask OpenSea what the wallet may mint, before the stage opens.
     *
     * This replaces inferring eligibility from a refusal, which meant a wallet
     * that was never on the list found out by being told no at T-0 — the one
     * moment nothing can be done about it. Asking a minute early also collapses
     * the mint endpoint's 422 from four possible causes to one.
     *
     * Advisory by design. A failure here degrades the 422 back to ambiguous and is
     * reported, but never stops the mint: eligibility is information, nonces are
     * machinery. The scoped token is bound to a single wallet, so in a multi-wallet
     * run only that wallet gets an answer and the rest stay honestly unknown.
     */
    const learnEligibility = async (stage: DropStage | null): Promise<void> => {
      if (!auth) {
        writeOut(info(`Eligibility not checked — ${noAuth}. A refusal at T-0 will not say why.\n`));
        return;
      }
      try {
        const { snapshot, failure } = await tryFetchWalletEligibility({
          slug,
          auth,
          stages: schedule.stages,
          ...(signal ? { signal } : {}),
        });
        if (!snapshot) {
          writeOut(warn(`Eligibility unknown — ${failure?.message ?? "the check did not complete"}.\n`));
          return;
        }
        // Who the answer is about is decided in core, where it is tested.
        const verdict = hintForStage(snapshot, stage, loaded);
        if (verdict.kind === "foreign") {
          writeOut(
            warn(
              `OPENSEA_SCOPED_TOKEN answers for ${shortAddress(verdict.wallet)}, which is not a wallet loaded from .env. Eligibility left unknown.\n`,
            ),
          );
          return;
        }
        if (verdict.kind === "ambiguous") {
          writeOut(
            warn(
              `OpenSea did not name the wallet and ${verdict.candidates} are loaded, so the answer cannot be attributed to one. Eligibility left unknown.\n`,
            ),
          );
          return;
        }
        if (verdict.kind === "no-row") {
          writeOut(
            info(
              stage?.uuid
                ? `Eligibility has no row for "${stage.label}" (${verdict.answered} stage(s) answered).\n`
                : "This stage carries no OpenSea stage id, so eligibility cannot be joined to it.\n",
            ),
          );
          return;
        }

        eligibility.set(verdict.wallet, verdict.hint);
        const row = verdict.row;
        const price =
          row.price === null ? "price unknown" : `${formatEth(row.price, run.chain.nativeSymbol)} each`;
        const cap = row.maxMintable === null ? "no stated limit" : `up to ${row.maxMintable}`;
        writeOut(
          (row.isEligible ? ok : warn)(
            `${shortAddress(verdict.wallet)} ${row.isEligible ? "is eligible" : "is NOT eligible"} for "${row.stageLabel}" (${row.stageType}) — ${price}, ${cap}.\n`,
          ),
        );
        const terms = mintTerms(row, quantity);
        if (terms && !terms.withinAllowance) {
          writeOut(warn(`Requested ${quantity}, allowance is ${terms.allowance}. OpenSea will refuse.\n`));
        }
      } catch (err: unknown) {
        // Advisory work must not take the mint down with it.
        if (signal?.aborted) return;
        writeOut(
          warn(
            `Eligibility check failed: ${redactKeys(err instanceof Error ? err.message : String(err))}\n`,
          ),
        );
      }
    };

    /**
     * @param inRace  true when there was no pre-open lead and this is happening
     *                with the stage already open.
     */
    const runPreArm = async (stage: DropStage | null, inRace: boolean): Promise<void> => {
      writeOut(info(`Pre-arming ${wallets.length} wallet(s): nonces, sockets, clock, eligibility.\n`));
      // Started first so it overlaps the nonce fetch, but only waited for when there
      // is time to spare. Eligibility is advisory: it sharpens a refusal into a
      // reason, and a reason is not worth a round trip of delay on the signature
      // request. It is still worth starting inside the race, because planNextPoll
      // re-reads this map on every poll — an answer that lands two seconds late
      // still explains the retries that follow it.
      const learning = learnEligibility(stage);
      const armed = await preArmAllowlist({
        provider: run.rpc.provider,
        wallets,
        readUrls: run.rpc.plan.read,
        blastUrls: run.rpc.plan.blast,
        blockTimeSec: run.chain.blockTimeSec,
        ...(signal ? { signal } : {}),
      });
      if (!inRace) await learning;
      arm.value = armed;
      const spare = stage === null ? null : stage.startMs - armed.completedAtMs;
      writeOut(
        ok(
          spare === null
            ? "Pre-armed. Only the signature round trip is left.\n"
            : `Pre-armed with ${formatRemaining(spare)} to spare. Only the signature round trip is left.\n`,
        ),
      );
    };

    if (!open) {
      const upcoming = nextStage(schedule, now);
      if (!upcoming) throw new Error("No stage is open and none is scheduled. Nothing was sent.");
      writeOut(
        heading(`Waiting for "${upcoming.label}" — opens in ${formatRemaining(upcoming.startMs - now)}`) + "\n",
      );
      writeOut(info(`${formatUtc(upcoming.startMs)} UTC\n`));
      await waitForScheduledStage(slug, apiKey, {
        signal,
        preArmLeadMs: PRE_ARM_LEAD_MS,
        onPreArm: (stage) => runPreArm(stage, false),
        onUpdate: (update) => writeOut(info(`${update.message}\n`)),
      });
    } else {
      writeOut(ok(`"${open.label}" is open now.\n`));
    }

    writeOut(
      info("Requesting signatures. OpenSea will not issue one before the stage opens, so this round trip is inside the race.\n"),
    );

    // Already open on arrival, or the stage was rescheduled forward past the
    // lead: there was no lead window to use, so the preparation happens here and
    // the race pays for it. Stating it plainly beats silently being slower.
    if (!arm.value) {
      writeOut(warn("No pre-open lead was available — preparing inside the race.\n"));
      await runPreArm(open ?? null, true);
    }
    const prearmed = arm.value!;
    const nonced = prearmed.wallets;
    closePrompts();

    const report = createReporter({ chain: run.chain, addresses: wallets.map((w) => w.address) });
    const result = await runAllowlistMint(
      {
        chain: run.chain,
        slug,
        contract: run.contract,
        apiKey,
        quantity,
        wallets: nonced,
        readUrls: run.rpc.plan.read,
        blastUrls: run.rpc.plan.blast,
        gas: run.gas,
        prearmed,
        eligibility,
        receiptTimeoutMs: defaults.receiptTimeoutMs,
        signal,
      },
      report,
    );

    printRunSummary(result);
    if (result.minted === 0) process.exitCode = 1;
  } finally {
    closeRun(run);
  }
}

// ── bot ──────────────────────────────────────────────────────────────────────

async function cmdBot(): Promise<void> {
  // Imported lazily so the CLI does not pay for the bot's module graph on every
  // invocation, and so a missing bot token fails at `intern bot` rather than at
  // `intern --help`.
  const { runBot } = await import("../bot/index");
  await runBot();
}

// ── shared ───────────────────────────────────────────────────────────────────

function printRunSummary(result: {
  minted: number;
  failed: number;
  dispatchMs: number;
  timingErrorMs: number;
  clock: { offsetMs: number; synced: boolean };
}): void {
  writeOut(heading("Summary") + "\n");
  writeOut(field("dispatch", `${result.dispatchMs.toFixed(2)}ms to write every transaction`) + "\n");
  if (result.timingErrorMs !== 0) {
    writeOut(
      field("timing", `${result.timingErrorMs > 0 ? "+" : ""}${result.timingErrorMs.toFixed(0)}ms from the target instant`) + "\n",
    );
  }
  if (result.clock.synced && Math.abs(result.clock.offsetMs) >= 50) {
    writeOut(
      field("clock", `corrected for a ${result.clock.offsetMs}ms local error`) + "\n",
    );
  }
  writeOut(field("minted", String(result.minted)) + "\n");
  if (result.failed > 0) writeOut(field("failed", String(result.failed)) + "\n");
}

function requireChain(key: string) {
  const chain = resolveChain(key);
  if (!chain) {
    writeErr(
      `${c.red("✗")} Unknown chain "${key}". Supported: ${CHAINS.map((entry) => entry.key).join(", ")}.\n`,
    );
    process.exit(2);
  }
  return chain;
}

function requireTarget(args: CliArgs): string {
  if (args.target && args.target.trim()) return args.target.trim();
  writeErr(
    `${c.red("✗")} No target given. Pass an OpenSea link, a collection slug, or a contract address.\n`,
  );
  process.exit(2);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // redactKeys guards the one path where a key could reach a terminal: ethers
  // embeds the offending value in some of its own error messages.
  writeErr(`\n${c.red("✗")} ${redactKeys(message)}\n`);
  if (process.env.INTERN_DEBUG && err instanceof Error && err.stack) {
    writeErr(c.gray(`${redactKeys(err.stack)}\n`));
  }
  process.exit(1);
});
