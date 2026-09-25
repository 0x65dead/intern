// The panel: one living message per chat, and the keyboards that drive it.
//
// A trading bot that answers every command with a new message buries the thing you
// are looking at under the history of how you got there. So each chat owns exactly
// one panel message, and every state change is an `editMessageText` on it. The
// message id is the session's; the panel is what the user is looking at.
//
// Two consequences shape this file:
//
//   Rendering is pure. A view is (state → text + keyboard), with no I/O, so the
//   auto-refresh loop can re-render from fresh data on a timer without any risk of
//   it also re-fetching, re-arming, or double-firing something.
//
//   Callback data is a closed vocabulary. Every button carries an action from
//   `PanelAction`, and anything not in that set is rejected out loud rather than
//   ignored — an unrecognised callback means a stale keyboard from a previous
//   version of the bot, and silently doing nothing there looks like a hung bot.
//
// Callback payloads are attacker-supplied in the same sense as message text: the
// client echoes back whatever it was given, and a modified client can send
// anything. Values are parsed and range-checked here, never trusted because we
// authored the button.

import { ChainProfile, CHAINS } from "../core/chains";
import { StageTable, actionableStage, formatClock, formatCoarse } from "../core/stages";
import { StageContext, allStageCells, stageSummaryLines } from "../core/stagetable";
import { MintPlan } from "../core/seadrop";
import { LoadedWallet, formatEth, weiToGwei } from "../core/wallets";
import { shortAddress } from "../core/target";
import { InlineButton, bold, code, esc } from "./api";

/** Everything a button can ask for. Anything else is rejected. */
export const PANEL_ACTIONS = [
  "menu",
  "mint",
  "check",
  "watch",
  "stages",
  "wallets",
  "status",
  "cancel",
  "chain",
  "qty",
  "send",
  "dryrun",
  "fire",
  "refresh",
  "auto",
  "noop",
] as const;

export type PanelAction = (typeof PANEL_ACTIONS)[number];

export function isPanelAction(value: string): value is PanelAction {
  return (PANEL_ACTIONS as readonly string[]).includes(value);
}

/** `action:value` — the only callback_data format this bot emits. */
export function encodeCallback(action: PanelAction, value = ""): string {
  return value ? `${action}:${value}` : action;
}

export interface ParsedCallback {
  action: PanelAction;
  value: string;
}

/**
 * Parse callback data, rejecting anything unrecognised.
 *
 * Returns null rather than a default action: a stale button from an older
 * deployment must produce a visible "that button is out of date", not a silent
 * no-op and not an accidental navigation somewhere else.
 */
export function parseCallback(data: string | undefined): ParsedCallback | null {
  if (!data) return null;
  const separator = data.indexOf(":");
  const rawAction = separator === -1 ? data : data.slice(0, separator);
  const value = separator === -1 ? "" : data.slice(separator + 1);
  if (!isPanelAction(rawAction)) return null;
  return { action: rawAction, value };
}

// ── keyboards ────────────────────────────────────────────────────────────────

export const MAIN_MENU: InlineButton[][] = [
  [
    { text: "🎯 Mint", callback_data: encodeCallback("mint") },
    { text: "🔍 Check", callback_data: encodeCallback("check") },
  ],
  [
    { text: "👀 Watch", callback_data: encodeCallback("watch") },
    { text: "📊 Stages", callback_data: encodeCallback("stages") },
  ],
  [
    { text: "👛 Wallets", callback_data: encodeCallback("wallets") },
    { text: "📈 Status", callback_data: encodeCallback("status") },
  ],
  [{ text: "❌ Cancel", callback_data: encodeCallback("cancel") }],
];

export const BACK_ONLY: InlineButton[][] = [
  [{ text: "← Menu", callback_data: encodeCallback("menu") }],
];

/** Two per row: eight chains in four rows reads better than one long column. */
export function chainKeyboard(chains: ChainProfile[] = CHAINS): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < chains.length; i += 2) {
    rows.push(
      chains.slice(i, i + 2).map((chain) => ({
        text: chain.name,
        callback_data: encodeCallback("chain", chain.key),
      })),
    );
  }
  rows.push([{ text: "❌ Cancel", callback_data: encodeCallback("cancel") }]);
  return rows;
}

export function quantityKeyboard(): InlineButton[][] {
  return [
    [1, 2, 3, 5, 10].map((n) => ({
      text: String(n),
      callback_data: encodeCallback("qty", String(n)),
    })),
    [{ text: "❌ Cancel", callback_data: encodeCallback("cancel") }],
  ];
}

/** Confirm keyboard. Nothing signs until ✅ Send. */
export function confirmKeyboard(): InlineButton[][] {
  return [
    [
      { text: "✅ Send", callback_data: encodeCallback("send") },
      { text: "❌ Cancel", callback_data: encodeCallback("cancel") },
    ],
  ];
}

/**
 * The dry-run button, offered wherever ✅ Send is.
 *
 * Deliberately on its own row and below Send rather than beside it: the two do
 * very different things and a mis-tap in either direction is expensive — one
 * spends money unexpectedly, the other fails to spend it when the operator meant
 * to mint.
 */
export function dryRunButton(): InlineButton {
  return { text: "🧪 Dry run", callback_data: encodeCallback("dryrun") };
}

/** The read-only panel footer: refresh plus the auto toggle. */
export function refreshKeyboard(autoOn: boolean): InlineButton[][] {
  return [
    [
      { text: "🔄 Refresh", callback_data: encodeCallback("refresh") },
      {
        text: autoOn ? "⏱ Auto: on" : "⏱ Auto: off",
        callback_data: encodeCallback("auto", autoOn ? "off" : "on"),
      },
    ],
    [{ text: "← Menu", callback_data: encodeCallback("menu") }],
  ];
}

// ── views ────────────────────────────────────────────────────────────────────

export function renderMenu(chainName: string, walletCount: number): string {
  return [
    bold("intern"),
    esc("OpenSea SeaDrop mint sniper. Pre-signed, clock-corrected, multi-RPC."),
    "",
    `${esc("chain:")} ${code(chainName)}   ${esc("wallets:")} ${code(String(walletCount))}`,
    "",
    esc("Pick an action. Nothing sends until you confirm."),
  ].join("\n");
}

export function renderAskTarget(what: string): string {
  return [
    bold(what),
    "",
    esc("Send a contract address or an OpenSea link."),
    esc("A bare 0x address is fine — the chain is detected automatically."),
  ].join("\n");
}

/**
 * The chain picker shown when an address has code on several chains.
 *
 * The address is restated because this panel can arrive a while after it was
 * typed, and picking a chain for the wrong address is not recoverable once the
 * mint fires.
 */
export function renderChainPicker(address: string, candidates: ChainProfile[]): string {
  return [
    bold("Which chain?"),
    "",
    `${esc("Contract code exists at")} ${code(shortAddress(address))} ${esc("on all of these:")}`,
    "",
    ...candidates.map((c) => esc(`  · ${c.name} (chain ${c.chainId})`)),
    "",
    esc("Same address, different deployments. Pick the one you mean — a wrong pick"),
    esc("mints on the wrong network."),
  ].join("\n");
}

/**
 * The stage table as Telegram HTML.
 *
 * Labelled lines per stage rather than aligned columns: Telegram renders message
 * text in a proportional font, so padded columns come out ragged, and a
 * seven-column table wraps on a phone regardless of the font. One labelled line
 * per field survives any width, and the column *meanings* still come from
 * stagetable.ts, so this cannot drift from what the CLI prints.
 */
export function renderStages(
  table: StageTable,
  chain: ChainProfile,
  fmtTime: (ms: number) => string,
  nowMs: number,
  ctx: StageContext = {},
): string {
  const lines = [bold("Stages")];

  if (table.rows.length === 0) {
    lines.push("", esc("No stages are configured for this drop yet."));
  }

  const cells = allStageCells(table, chain, fmtTime, ctx);
  for (const cell of cells) {
    lines.push("");
    lines.push(`${bold(cell.stage)}  ${esc(`[${cell.source}]`)}`);
    lines.push(esc(`price:  ${cell.price}`));
    lines.push(esc(`window: ${cell.window}`));
    lines.push(esc(`cap:    ${cell.cap} per wallet`));
    lines.push(esc(`status: ${cell.status}`));
    lines.push(esc(`left:   ${cell.mintsLeft}`));
    lines.push(esc(`can we: ${cell.eligibility}`));
  }

  const summary = stageSummaryLines(
    actionableStage(table, nowMs, ctx.fire, ctx.evidence),
    formatClock,
  );
  if (summary.length > 0) {
    lines.push("");
    for (const line of summary) lines.push(bold(line));
  }

  if (table.apiNotice) {
    lines.push("");
    lines.push(esc(`⚠ ${table.apiNotice}`));
  }
  return lines.join("\n");
}

/**
 * The pre-flight confirmation.
 *
 * Everything that costs money if it is wrong, restated in one place: which chain,
 * which contract, how much in total, and from which wallets. "Are you sure?"
 * without these numbers is a button people press without reading.
 */
export function renderConfirm(opts: {
  plan: MintPlan;
  chain: ChainProfile;
  collectionName?: string;
  quantity: number;
  wallets: LoadedWallet[];
  maxFeeWei: bigint;
  gasLimit: bigint;
  stages: StageTable;
  fireMode: string;
  nowMs: number;
}): string {
  const { plan, chain, quantity, wallets } = opts;
  const perWallet = plan.value;
  const total = perWallet * BigInt(wallets.length);
  const worstGas = opts.gasLimit * opts.maxFeeWei * BigInt(wallets.length);
  const symbol = chain.nativeSymbol;
  const startMs = plan.drop.startTime * 1000;
  const open = opts.nowMs >= startMs;

  const lines = [
    bold("Confirm mint"),
    "",
    `${esc("collection:")} ${esc(opts.collectionName ?? "unnamed")}`,
    `${esc("chain:")}      ${esc(chain.name)} ${esc(`(id ${chain.chainId})`)}`,
    `${esc("contract:")}   ${code(plan.nftContract)}`,
    `${esc("variant:")}    ${esc(plan.variant === "v1-singleton" ? "SeaDrop v1 singleton" : "SeaDrop v2 (config on token)")}`,
    "",
    `${esc("price:")}      ${esc(formatEth(plan.drop.mintPrice, symbol))} ${esc(`× ${quantity}`)}`,
    `${esc("per wallet:")} ${bold(formatEth(perWallet, symbol))}`,
    `${esc("cap:")}        ${esc(plan.drop.maxTotalMintableByWallet > 0 ? `${plan.drop.maxTotalMintableByWallet} per wallet` : "unlimited")}`,
  ];

  if (plan.supply.maxSupply !== null && plan.supply.totalSupply !== null) {
    lines.push(
      `${esc("supply:")}     ${esc(`${plan.supply.totalSupply} / ${plan.supply.maxSupply} minted`)}`,
    );
  }

  lines.push(
    "",
    `${esc("stage:")}      ${esc(open ? "open now" : `opens in ${formatCoarse(startMs - opts.nowMs)}`)}`,
    `${esc("window:")}     ${esc(`${fmtShort(startMs)} → ${plan.drop.endTime > 0 ? fmtShort(plan.drop.endTime * 1000) : "no end"}`)}`,
    `${esc("fire mode:")}  ${esc(opts.fireMode)}`,
    "",
    `${esc("gas ceiling:")} ${esc(`${weiToGwei(opts.maxFeeWei).toFixed(4)} gwei`)} ${esc("(a maximum, not a payment)")}`,
    `${esc("wallets:")}    ${esc(`${wallets.length} — ${wallets.map((w) => shortAddress(w.address)).join(", ")}`)}`,
    "",
    `${esc("mint cost:")}  ${bold(formatEth(total, symbol))}`,
    `${esc("worst case:")} ${esc(formatEth(total + worstGas, symbol))} ${esc("if every ceiling is fully used")}`,
  );

  const next = actionableStage(opts.stages, opts.nowMs);
  if (next && next.status === "upcoming") {
    lines.push("", bold(`Time until start: ${formatClock(next.countdownMs)}`));
  }

  lines.push("", esc("Nothing has been signed. ✅ Send is the point of no return."));
  return lines.join("\n");
}

function fmtShort(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** The "updated at" footer required on every refreshable panel. */
export function updatedFooter(nowMs: number, chainHead = true): string {
  const stamp = new Date(nowMs).toISOString().slice(11, 19);
  return esc(`updated ${stamp} (${chainHead ? "chain head time" : "local time"})`);
}
