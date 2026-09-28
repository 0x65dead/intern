// Per-chat panel state, and the authorization boundary.
//
// The shape of this file is one idea: a chat has exactly one panel message, and
// every interaction edits it. `/start` sends it; every button and every command
// after that is an `editMessageText` on the same message id. Nothing stacks, so
// the chat does not fill with the history of how the current screen was reached.
//
// Four decisions here are security decisions rather than UX ones.
//
//   Private keys are never accepted over Telegram. Not as a message, not deleted
//   afterwards, not "just this once". A Telegram message has already been through
//   Telegram's servers by the time the bot sees it, it sits in the chat's history
//   on every device signed into that account, and message deletion is a courtesy
//   rather than a guarantee. The bot signs with the wallets in .env on the machine
//   it runs on, and if there are none it refuses to arm. The CLI is where keys get
//   entered.
//
//   Authorization is a numeric-id allowlist, checked on every update — and an
//   inline button is an update. A callback_query is a bearer entry point exactly
//   like a command: the panel is visible to everyone in a group, so anyone in that
//   group can press its buttons, and `callback_query.from.id` is checked against
//   the same allowlist as `message.from.id`. In a group both the presser and the
//   group must be listed. Skipping this check on callbacks would mean the ✅ Send
//   button spends the owner's wallets for whoever can see it.
//
//   One run at a time across all chats. The wallet set comes from a single .env, so
//   two concurrent runs would sign different transactions with the same nonces and
//   one of them would be silently discarded by the network. Read-only panels
//   (check, stages, status) do *not* take this lock — watching a drop must never be
//   the reason a mint cannot start.
//
//   Nothing signs before ✅ Send. Preparation is idempotent and read-only; the
//   confirm panel states chain, contract, wallet count and worst-case total spend,
//   and the only path to a transaction is that one button.

import { explorerAddress } from "../core/chains";
import { CorrectedClock } from "../core/clock";
import { orderCandidates } from "../core/detect";
import { resolveFireTime, runMint } from "../core/engine";
import { BalanceReport, LoadedWallet, checkBalances, formatEth, redactKeys, requiredBalance } from "../core/wallets";
import {
  AmbiguousChainError,
  PreparedRun,
  closeRun,
  noDropMessage,
  prepareRun,
  refreshRun,
  stageContext,
} from "../core/prepare";
import { OpenSeaAuthManager, authManagerFrom } from "../core/openseaauth";
import { StageContext } from "../core/stagetable";
import { Defaults } from "../util/env";
import { WatchUpdate, waitForPublicStage } from "../core/watcher";
import { formatLocal, parseTimeInput } from "../core/timing";
import { parseTarget, shortAddress } from "../core/target";
import {
  InlineButton,
  TelegramClient,
  TelegramError,
  TgCallbackQuery,
  TgChat,
  TgMessage,
  TgUpdate,
  bold,
  code,
  esc,
  isMessageGone,
  link,
} from "./api";
import { createTelegramReporter, formatGas } from "./format";
import {
  BACK_ONLY,
  MAIN_MENU,
  PanelAction,
  chainKeyboard,
  confirmKeyboard,
  dryRunButton,
  encodeCallback,
  parseCallback,
  quantityKeyboard,
  refreshKeyboard,
  renderAskTarget,
  renderChainPicker,
  renderConfirm,
  renderMenu,
  renderStages,
  updatedFooter,
} from "./panel";
import {
  AUTO_REFRESH_MS,
  EditGate,
  MIN_EDIT_GAP_MS,
  RefreshSource,
  WriteGate,
  debouncedToast,
  newWriteGate,
  nextWriteDelay,
  noteRateLimit,
} from "./refresh";

/** A prepared run left unconfirmed this long is dropped and its provider closed. */
const DRAFT_TTL_MS = 15 * 60_000;

/**
 * The drift limit an unattended run uses when none was configured.
 *
 * Two seconds of uncertainty is already far more than a mint can absorb — a
 * stage opens in a single block — so this is a backstop against a badly broken
 * clock, not a precision target. The CLI leaves the guard advisory by default
 * because an operator is there to read the measured offset; nobody is here.
 */
const DEFAULT_BOT_DRIFT_LIMIT_MS = 2_000;

/**
 * Said when the live run panel could not be brought up to date.
 *
 * It is worth a sentence rather than a silent stale message. The panel is the
 * only place the per-wallet lines and tx hashes appear, and an operator who
 * cannot see that it failed to update will read a half-finished countdown as the
 * state of a mint that has already resolved.
 */
const PANEL_STALE =
  "⚠ The panel above is out of date — Telegram refused the final edit. What follows is the real outcome; check the explorer for per-wallet results.";

/** The dry-run equivalent, where the panel was the entire report. */
const DRY_PANEL_LOST =
  "Telegram refused the edit that carried the dry-run report, so it is gone rather than stale. Nothing was broadcast. Run the check again.";

/** What the panel is currently showing. */
type View =
  | "menu"
  | "awaitTarget"
  | "awaitChain"
  | "awaitQuantity"
  | "awaitTime"
  | "confirm"
  | "running"
  /**
   * 👀 Watch. Distinct from "running" because a watch holds no lock, sends
   * nothing, and must not be repainted over by a finishing run's teardown — all
   * three of which used to be decided by this one shared value.
   */
  | "watching"
  | "check"
  | "stages"
  | "wallets"
  | "status";

/** Which flow the target being collected belongs to. */
type Intent = "mint" | "check" | "watch" | "stages";

interface Draft {
  intent: Intent;
  target?: string;
  chainKey?: string;
  quantity?: number;
  run?: PreparedRun;
  balances?: BalanceReport[];
  /** Candidate chains from an ambiguous detection, awaiting a pick. */
  candidates?: string[];
}

interface Session {
  chatId: number;
  /** The one panel message this chat owns. */
  panelId: number | null;
  view: View;
  draft: Draft;
  controller?: AbortController;
  expiry?: NodeJS.Timeout;
  /** Set while ⏱ Auto is on. */
  autoTimer?: NodeJS.Timeout;
  /** Paces edits to this chat's panel. */
  gate: EditGate;
  /**
   * Telegram's pacing for this chat's panel, as opposed to ours.
   *
   * `gate` decides whether a *refresh* is worth doing. This decides when the edit
   * it produces may actually go out, and it applies to every paint — menu
   * navigation included, which is where a burst of taps used to earn a 429 that
   * `paintNow` swallowed, leaving the panel frozen on the frame before.
   */
  write: WriteGate;
  /**
   * Serializes edits to this chat's panel, so two paints cannot interleave.
   *
   * `prepare` reports progress through an unawaited `void this.paint(...)`, which
   * meant several edits to the same message were in flight at once. Two things
   * went wrong. Out-of-order completion could leave the panel showing an earlier
   * step than the one it had already drawn — including leaving "Working…" on
   * screen permanently over a finished result. And because a failed edit clears
   * `panelId` and posts a replacement, two concurrent failures each posted one,
   * so the chat filled with duplicate panels.
   */
  paintQueue: PaintQueue<{ text: string; buttons: InlineButton[][] }>;
  /** Row statuses at the last render, to notice a stage transition. */
  stageSignature?: string;
  /** Consecutive auto-refresh failures, reset by the first success. */
  refreshFailures?: number;
  /**
   * 👀 Watch's abort handle, kept apart from `controller`.
   *
   * Watch used to assign `session.controller`, overwriting a live mint's handle,
   * so the mint became unabortable — `shutdown` and `cancel` would abort the watch
   * and leave the run signing.
   */
  watchController?: AbortController;
}

export interface SessionManagerOptions {
  client: TelegramClient;
  defaults: Defaults;
  wallets: LoadedWallet[];
  allowedIds: number[];
  /** Corrected clock. All countdowns and footers read from this, never Date.now(). */
  clock?: CorrectedClock;
}

export const BOT_COMMANDS = [
  { command: "start", description: "Open the control panel" },
  { command: "mint", description: "Mint a drop — link, slug, or contract address" },
  { command: "check", description: "Inspect a drop without sending anything" },
  { command: "stages", description: "Every stage of a drop, with countdowns" },
  { command: "watch", description: "Wait for a public stage to open, then report" },
  { command: "wallets", description: "Show the loaded wallets and balances" },
  { command: "status", description: "What this chat is currently doing" },
  { command: "cancel", description: "Abandon the current setup or abort a run" },
  { command: "help", description: "How to use intern" },
];

const HELP = [
  bold("intern"),
  esc("A minting bot for OpenSea SeaDrop. Same engine as the CLI."),
  "",
  esc("Everything works from the buttons on the panel. The commands are the same"),
  esc("actions for people who would rather type:"),
  "",
  `${code("/mint <link|slug|0x…>")} ${esc("— prepare a mint, then confirm before anything is sent")}`,
  `${code("/check <link|slug|0x…>")} ${esc("— read the drop, print the numbers, send nothing")}`,
  `${code("/stages <link|slug|0x…>")} ${esc("— every stage, with prices, windows and countdowns")}`,
  `${code("/watch <link|slug|0x…>")} ${esc("— wait for the public stage to open")}`,
  `${code("/wallets")} ${esc("— the wallets this bot signs with, and their balances")}`,
  `${code("/cancel")} ${esc("— abandon setup, abort a run, or stop a live panel")}`,
  "",
  esc("A bare 0x address needs no chain: every configured chain is probed and the"),
  esc("one holding the contract wins. If several hold it, you are asked which."),
  "",
  bold("Never send a private key here."),
  esc(
    "This bot signs with the wallets in its .env on the machine it runs on. A key pasted into a chat is already stored on Telegram's servers and on every device signed into your account. Use the CLI to enter keys.",
  ),
].join("\n");

/**
 * Whether a run may start, given who holds the global lock.
 *
 * HARD CONSTRAINT 6 is one mint run at a time, *globally*. The check used to read
 * `this.running !== chatId`, exempting the chat that already held the lock — which
 * was invisible only because the update loop was blocked for the whole run, so a
 * second ✅ Send could not be delivered until the first had finished. With the run
 * detached so ❌ Cancel can land, that exemption becomes a double-tap that signs
 * two sets of transactions at the same nonces, and the network keeps one.
 *
 * Returns the refusal to show, or `null` to proceed. Pure, so the rule is testable
 * without standing up a chat, a wallet set and a chain.
 */
export function lockRefusal(
  holder: number | null,
  chatId: number,
): { title: string; body: string } | null {
  if (holder === null) return null;
  if (holder === chatId) {
    return {
      title: "Already running",
      body: "This chat already has a run in progress. Use ❌ Cancel to stop it; starting a second would reuse the same nonces and one would be silently discarded.",
    };
  }
  return {
    title: "Another chat is mid-run",
    body: "The same wallets are already signing. Two runs would use the same nonces and one would be silently discarded, so this one is not starting.",
  };
}

/**
 * The controllers ❌ Cancel should abort.
 *
 * Two, not one. The mint lock is global, so a run started from a group panel has
 * to be stoppable from the operator's DM — `cancel` used to consult only the
 * calling chat's own handle, which meant the only chat that could stop a run was
 * the one that started it. And HARD CONSTRAINT 6 asks a single button to kill a
 * live mint *and* a live panel loop, which for one chat can be two controllers.
 *
 * Already-aborted handles are dropped so the caller can distinguish "something was
 * stopped" from "there was nothing to stop", and the same handle appearing twice
 * is returned once.
 */
export function abortTargets(
  ...controllers: (AbortController | null | undefined)[]
): AbortController[] {
  const live = new Set<AbortController>();
  for (const controller of controllers) {
    if (controller && !controller.signal.aborted) live.add(controller);
  }
  return [...live];
}

/** What a finished run is still entitled to tear down. */
export interface RunTeardown {
  /** Drop the session's controller reference — only while it is still this run's. */
  clearController: boolean;
  /** The draft is still this run's, so the whole draft goes with it. */
  discardDraft: boolean;
  /** The operator prepared something new; close only what this run itself held. */
  closeOwnRunOnly: boolean;
  /** Repaint the menu — only if the operator has not navigated away. */
  showMenu: boolean;
}

/**
 * Decide what a finished run may tear down.
 *
 * Preparing a mint takes no lock, deliberately: reading a drop must never be
 * blocked by somebody else's run. That was invisible until the run itself was
 * detached so ❌ Cancel could be delivered — and then the combination became
 * reachable. The operator can now prepare a second mint while the first is still
 * in flight, and the first run's teardown runs against a session that has moved on.
 *
 * Every field answers one question: is this still mine? Tearing down state that
 * belongs to the next run is worse than leaking it — a blanket `discardDraft`
 * closes the provider the confirm panel is about to use, and nothing in the
 * resulting failure names the run that closed it.
 */
export function planTeardown(
  state: {
    controller: AbortController | undefined;
    draftRun: object | undefined;
    view: string;
  },
  owned: { controller: AbortController; run: object },
): RunTeardown {
  const draftIsMine = state.draftRun === owned.run;
  return {
    clearController: state.controller === owned.controller,
    discardDraft: draftIsMine,
    closeOwnRunOnly: !draftIsMine,
    showMenu: state.view === "running",
  };
}

/**
 * A serialization slot: one edit in flight, one waiting, the waiting one replaceable.
 */
export interface PaintQueue<T> {
  chain: Promise<void>;
  pending?: T;
}

/**
 * Queue a draw behind whatever is already in flight, latest-wins.
 *
 * Telegram edits the same message, so concurrent edits to it are not merely
 * wasteful — they land in whatever order the network decides, and the panel ends
 * up showing whichever one happened to finish last. The visible symptom is a
 * panel stuck on "Working…" over a result that is actually ready.
 *
 * Only the newest queued value is kept: a burst of progress callbacks is worth one
 * edit, not one edit each, and intermediate steps nobody saw are not worth a round
 * trip against a rate-limited token.
 *
 * The chain is advanced with the *caught* promise, because a chain that rejects
 * would skip every draw queued behind it — turning one failed edit into a panel
 * that never updates again.
 */
export function enqueuePaint<T>(
  queue: PaintQueue<T>,
  value: T,
  draw: (value: T) => Promise<void>,
): Promise<void> {
  queue.pending = value;
  const queued = queue.chain.then(async () => {
    const pending = queue.pending;
    if (pending === undefined) return; // a later call already drew newer content
    delete queue.pending;
    await draw(pending);
  });
  queue.chain = queued.catch(() => {});
  return queued;
}

/**
 * Refuse to start a setup flow while this chat is already busy.
 *
 * The guard used to read `session.view === "running"`, which is a *display* flag,
 * not the lock. Any view change cleared it — `/status` sets the view to "status",
 * and from then on the guard saw an idle chat while a mint was still signing. The
 * real lock is `running`, so that is what this reads.
 *
 * Another chat's run is deliberately not refused here: preparing a target sends
 * nothing, and the global lock is re-checked at fire time, where it belongs.
 */
export function beginRefusal(
  running: number | null,
  chatId: number,
  view: string,
): { title: string; body: string } | null {
  if (running === chatId) {
    return {
      title: "A run is in progress",
      body: "Cancel it before starting another.",
    };
  }
  if (view === "watching") {
    return {
      title: "A watch is running",
      body: "Stop watching before starting something else.",
    };
  }
  return null;
}

/** Consecutive failed auto-refreshes before the chat is told the panel is stale. */
export const REFRESH_ALERT_AFTER = 3;

/**
 * Is the panel a refresh was reading for still the panel on screen?
 *
 * `refreshRun` and `readBalances` take seconds against live RPC. The guard that
 * decided the refresh was worth doing ran before them, and the write-back ran
 * after — so in between the operator could navigate away, press ❌ Cancel, or
 * start a mint, and the refresh would commit anyway: painting a stale Check panel
 * over whatever was now on screen, and replacing `draft.run` with a rebuilt run
 * that the mint about to fire had not been prepared against.
 *
 * Identity, not equality. A rebuilt run is a different object even when every
 * number in it matches, which is exactly the case that must not be committed.
 */
export function refreshStillApplies(
  startedView: string,
  currentView: string,
  startedRun: unknown,
  currentRun: unknown,
): boolean {
  if (currentView !== startedView) return false;
  if (currentRun !== startedRun) return false;
  return currentView === "check" || currentView === "stages";
}

/**
 * Decide where a failed refresh gets reported.
 *
 * A refresh driven by a button press has a `callback_query_id` to answer, and the
 * toast lands on the operator's screen. A refresh driven by the ⏱ Auto timer has
 * none — and the code used to answer `queryId ?? ""` anyway, which Telegram
 * rejects, into a `.catch(() => {})`. So the one failure mode that happens while
 * nobody is pressing anything was reported nowhere at all: the countdown simply
 * stopped advancing, which looks exactly like a countdown that is up to date.
 *
 * A single timer failure is genuinely not worth a message — the next tick usually
 * succeeds, which is why it is swallowed rather than fatal. A streak is, because
 * by then the numbers on screen are stale and the operator is making decisions
 * from them. Announcing on the Nth failure exactly, rather than every failure
 * past N, keeps a long outage to one message.
 */
export function planRefreshReport(
  queryId: string | undefined,
  consecutiveFailures: number,
): { toast: boolean; announce: boolean } {
  const interactive = queryId !== undefined && queryId !== "";
  return {
    toast: interactive,
    announce: !interactive && consecutiveFailures === REFRESH_ALERT_AFTER,
  };
}

export class SessionManager {
  private readonly sessions = new Map<number, Session>();
  /** chatId currently holding the run lock, or null. Mint runs only. */
  private running: number | null = null;

  /**
   * The live run's abort handle, held here rather than only on the session.
   *
   * The lock is global, so cancellation has to be too: a run started from a group
   * panel used to be uncancellable from the operator's DM, because `cancel` only
   * ever looked at the calling chat's own controller.
   */
  private activeController: AbortController | null = null;

  /** The detached run, so shutdown can wait for it instead of cutting it off. */
  private activeRun: Promise<void> | null = null;

  /** The detached watch. Holds no lock, but shutdown still waits for it. */
  private activeWatch: Promise<void> | null = null;
  /** The contract the live run is firing at, for the heartbeat. null when idle. */
  private runningTarget: string | null = null;
  private readonly clock: CorrectedClock;
  /**
   * The eligibility credential, built at most once for the process lifetime.
   *
   * `undefined` means not yet built; `null` means built and unavailable. The
   * distinction matters because the bot is long-lived: rebuilding per prepare
   * would perform a token exchange every time a panel opens, and re-deriving
   * "unavailable" on every one of those would be a request per panel for an
   * answer that cannot change without a restart. The manager holds the JWT and
   * refreshes it on its own schedule, so one instance is the whole point.
   */
  private openseaAuth: OpenSeaAuthManager | null | undefined;

  constructor(private readonly opts: SessionManagerOptions) {
    this.clock = opts.clock ?? new CorrectedClock(0);
  }

  private now(): number {
    return this.clock.now();
  }

  /**
   * The stage table's context, built the same way for every panel.
   *
   * Shares src/core/prepare.ts's builder with the CLI, so 📊 Stages in Telegram
   * and `intern check` in a terminal cannot reach different verdicts about
   * whether a stage is fireable.
   */
  /** Lazily built so a bot with no eligibility credential never tries. */
  private auth(): OpenSeaAuthManager | null {
    if (this.openseaAuth === undefined) {
      this.openseaAuth = authManagerFrom({
        apiKey: this.opts.defaults.openseaApiKey,
        scopedToken: this.opts.defaults.openseaScopedToken,
        walletToken: this.opts.defaults.openseaWalletToken,
      }).manager;
    }
    return this.openseaAuth;
  }

  private stageCtx(run: PreparedRun): StageContext {
    return stageContext(run, {
      allowlistMinting: this.opts.defaults.allowlistMinting,
      openseaApiKey: this.opts.defaults.openseaApiKey !== null,
    });
  }

  /** Whether a mint run currently holds the global lock. For the heartbeat. */
  isRunning(): boolean {
    return this.running !== null;
  }

  /** The contract a live run is firing at, or null when idle. For the heartbeat. */
  currentTarget(): string | null {
    return this.runningTarget;
  }

  // ── authorization ──────────────────────────────────────────────────────────

  /**
   * Both the sender and, for groups, the chat must be listed.
   *
   * Applied identically to messages and to callback queries. A panel sitting in a
   * group is visible to every member, so "who pressed it" is exactly as much of an
   * open question as "who typed it".
   */
  private authorized(userId: number | undefined, chat: { id: number; type: string }): boolean {
    if (userId === undefined) return false;
    if (!this.opts.allowedIds.includes(userId)) return false;
    if (chat.type !== "private" && !this.opts.allowedIds.includes(chat.id)) return false;
    return true;
  }

  // ── dispatch ───────────────────────────────────────────────────────────────

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.text) return;
    if (!this.authorized(message.from?.id, message.chat)) return;
    await this.handleText(message, message.text.trim());
  }

  private session(chatId: number): Session {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        chatId,
        panelId: null,
        view: "menu",
        draft: { intent: "mint" },
        gate: new EditGate(),
        write: newWriteGate(),
        paintQueue: { chain: Promise.resolve() },
      };
      this.sessions.set(chatId, session);
    }
    return session;
  }

  // ── the panel ──────────────────────────────────────────────────────────────

  /**
   * Draw the panel: edit the existing message, or send the first one.
   *
   * Every state change in the bot ends here. A failed edit falls back to sending a
   * new panel, because the usual cause is that the user deleted the old message
   * and a bot that then refuses to draw anything looks broken.
   */
  /**
   * Queue a panel edit behind any edit already in flight for this chat.
   *
   * Latest-wins: a paint still waiting its turn is replaced rather than stacked,
   * so a burst of progress callbacks costs one edit instead of one per step. The
   * returned promise resolves once the panel shows content at least as new as
   * this call's, which is what every caller actually wants.
   */
  /**
   * The press awaiting an answer, or null once answered.
   *
   * A single field is enough because the poll loop applies updates strictly
   * sequentially — see the note at its `for` loop in index.ts. Two presses are
   * never in flight at once.
   */
  private pendingAck: string | null = null;

  private paint(session: Session, text: string, buttons: InlineButton[][]): Promise<void> {
    return enqueuePaint(session.paintQueue, { text, buttons }, (pending) =>
      this.paintNow(session, pending.text, pending.buttons),
    );
  }

  private async paintNow(
    session: Session,
    text: string,
    buttons: InlineButton[][],
  ): Promise<void> {
    // Paints are serialized and latest-wins, so waiting here does not stack edits:
    // taps that arrive during the wait collapse into the single pending frame that
    // runs next. Five taps in a second cost two edits instead of five and a 429.
    const delay = nextWriteDelay(session.write, this.now(), MIN_EDIT_GAP_MS);
    if (delay > 0) await sleep(delay);
    session.write = { ...session.write, lastWriteMs: this.now() };
    session.gate.record(this.now());

    if (session.panelId !== null) {
      try {
        await this.opts.client.editMessage(session.chatId, session.panelId, text, { buttons });
        return;
      } catch (err: unknown) {
        // The one useful thing a 429 carries. Without it the next paint retries
        // into the same limit and the panel stays a frame behind indefinitely.
        if (err instanceof TelegramError) {
          session.write = noteRateLimit(session.write, this.now(), err.retryAfterSec);
        }
        // Only a message that is genuinely gone justifies posting a replacement.
        // Every failure used to land here, so a single 429 orphaned the panel and
        // posted a second one — and the next paint rate-limited too, and the chat
        // filled with panels while the live one scrolled away. A transient failure
        // keeps the panel and skips this frame; the next paint edits it again.
        if (!isMessageGone(err)) return;
        session.panelId = null;
      }
    }
    try {
      const sent = await this.opts.client.sendMessage(session.chatId, text, { buttons });
      session.panelId = sent.message_id;
    } catch (err: unknown) {
      // A chat that has blocked the bot must not take the process down.
      if (err instanceof TelegramError) {
        session.write = noteRateLimit(session.write, this.now(), err.retryAfterSec);
      }
    }
  }

  /**
   * Answer a button press exactly once, without losing what was said.
   *
   * Telegram accepts one answerCallbackQuery per press and rejects the rest, and
   * the client swallows that rejection. So the pre-emptive empty acknowledgement
   * in `handleCallback` did not merely duplicate work — it spent the press's one
   * answer, and every alert a handler raised afterwards went nowhere. "Invalid
   * quantity.", "Auto-refresh only applies to a Check or Stages panel." and
   * "Refresh failed: …" were all being shown to no one. A button that works and
   * says nothing is what gets reported as a broken bot.
   *
   * The acknowledgement still goes first, because Telegram spins the button for
   * about thirty seconds without it and preparing a run takes several seconds.
   * What changes is the fallback: a handler speaking after the press has been
   * answered gets a chat message rather than silence. Less pretty than a toast,
   * and it actually arrives.
   */
  private async ackCallback(
    session: Session,
    queryId: string,
    text?: string,
    alert = false,
  ): Promise<void> {
    if (queryId !== "" && this.pendingAck === queryId) {
      this.pendingAck = null;
      await this.opts.client.answerCallback(queryId, text, alert);
      return;
    }
    if (text !== undefined && text !== "") await this.say(session.chatId, esc(text));
  }

  /** A one-off message that is not the panel — run reports and run summaries. */
  private async say(chatId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
    try {
      await this.opts.client.sendMessage(chatId, text, buttons ? { buttons } : {});
    } catch {
      // As above.
    }
  }

  private async showMenu(session: Session): Promise<void> {
    this.stopAuto(session);
    session.view = "menu";
    await this.paint(
      session,
      renderMenu(this.opts.defaults.chain, this.opts.wallets.length),
      MAIN_MENU,
    );
  }

  // ── text commands ──────────────────────────────────────────────────────────

  private async handleText(message: TgMessage, text: string): Promise<void> {
    const session = this.session(message.chat.id);

    // A slash command always wins over whatever the state machine was expecting,
    // so a half-finished setup can never trap a chat.
    const command = text.startsWith("/") ? text.slice(1).split(/[\s@]/)[0]?.toLowerCase() : null;
    const rest = text.includes(" ") ? text.slice(text.indexOf(" ") + 1).trim() : "";

    if (command) {
      switch (command) {
        case "start":
          await this.showMenu(session);
          return;
        case "help":
          await this.paint(session, HELP, BACK_ONLY);
          return;
        case "mint":
          await this.begin(session, "mint", rest);
          return;
        case "check":
          await this.begin(session, "check", rest);
          return;
        case "stages":
          await this.begin(session, "stages", rest);
          return;
        case "watch":
          await this.begin(session, "watch", rest);
          return;
        case "wallets":
          await this.showWallets(session);
          return;
        case "status":
          await this.showStatus(session);
          return;
        case "cancel":
        case "abort":
          await this.cancel(session);
          return;
        default:
          await this.paint(
            session,
            `${bold("Unknown command")}\n${esc(`/${command} is not a command. /help lists them.`)}`,
            BACK_ONLY,
          );
          return;
      }
    }

    switch (session.view) {
      case "awaitTarget":
        session.draft.target = text;
        await this.afterTarget(session);
        return;
      case "awaitQuantity": {
        const quantity = Number(text);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
          await this.paint(
            session,
            `${bold("Quantity")}\n${esc("A whole number between 1 and 1000.")}`,
            quantityKeyboard(),
          );
          return;
        }
        session.draft.quantity = quantity;
        await this.prepare(session);
        return;
      }
      case "awaitTime": {
        try {
          const atMs = parseTimeInput(text, this.now());
          this.launch(session, { atMs });
        } catch (err: unknown) {
          await this.paint(
            session,
            `${bold("Could not read that time")}\n${esc(err instanceof Error ? err.message : "Try HH:MM, an ISO timestamp, a unix time, or +90s.")}`,
            confirmKeyboard(),
          );
        }
        return;
      }
      default:
        // A bare address or link with no command is unambiguous enough to act on.
        if (/^(0x[0-9a-fA-F]{40}|https?:\/\/\S+)$/.test(text)) {
          await this.begin(session, "mint", text);
          return;
        }
        await this.paint(
          session,
          `${bold("Not sure what to do with that")}\n${esc("Pick an action, or /help.")}`,
          MAIN_MENU,
        );
    }
  }

  // ── callbacks ──────────────────────────────────────────────────────────────

  /**
   * Route a button press.
   *
   * Order matters: authorize, then acknowledge, then act. The acknowledgement is
   * sent before any of the work because Telegram spins the client's button for
   * about thirty seconds without it, and preparing a run takes several seconds —
   * long enough for a user to conclude nothing happened and press again.
   *
   * That acknowledgement is a press's only one, so it goes through `ackCallback`
   * rather than straight to the client: see the note there for what a second
   * answer used to cost.
   */
  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    const chat: TgChat | undefined = query.message?.chat;

    if (!chat || !this.authorized(query.from.id, chat)) {
      // Rejected out loud: the presser can see the panel, so there is nothing to
      // conceal from them, and a silent refusal reads as a broken bot.
      await this.opts.client.answerCallback(
        query.id,
        "Not authorized to use this bot.",
        true,
      );
      return;
    }

    const parsed = parseCallback(query.data);
    if (!parsed) {
      // An unrecognised action means a stale keyboard from an older deployment.
      // Saying so beats doing nothing, and beats guessing what was meant.
      await this.opts.client.answerCallback(
        query.id,
        "That button is no longer valid — reopen the panel with /start.",
        true,
      );
      return;
    }

    const session = this.session(chat.id);
    // Adopt the message the button lives on, so a panel from a previous process
    // keeps working instead of being orphaned.
    if (session.panelId === null && query.message) session.panelId = query.message.message_id;

    this.pendingAck = query.id;
    // Refresh answers its own press: it is the one action whose outcome is worth a
    // toast, and it finishes inside the spinner's window either way.
    if (parsed.action !== "refresh") await this.ackCallback(session, query.id);

    try {
      await this.dispatchAction(session, parsed.action, parsed.value, query.id);
    } finally {
      // Whatever happened, the spinner stops. An unanswered press spins for about
      // thirty seconds and reads as a hang — and a handler that threw is exactly
      // when the operator most needs the button to stop pretending to work.
      await this.ackCallback(session, query.id);
    }
  }

  private async dispatchAction(
    session: Session,
    action: PanelAction,
    value: string,
    queryId: string,
  ): Promise<void> {
    switch (action) {
      case "menu":
        await this.showMenu(session);
        return;
      case "mint":
        await this.begin(session, "mint", "");
        return;
      case "check":
        await this.begin(session, "check", "");
        return;
      case "stages":
        await this.begin(session, "stages", "");
        return;
      case "watch":
        await this.begin(session, "watch", "");
        return;
      case "wallets":
        await this.showWallets(session);
        return;
      case "status":
        await this.showStatus(session);
        return;
      case "cancel":
        await this.cancel(session);
        return;
      case "chain":
        await this.pickChain(session, value);
        return;
      case "qty": {
        // Callback data is echoed back by the client, so it is validated the same
        // way typed input is rather than trusted because we authored the button.
        const quantity = Number(value);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
          await this.ackCallback(session, queryId, "Invalid quantity.", true);
          return;
        }
        session.draft.quantity = quantity;
        await this.prepare(session);
        return;
      }
      case "send":
        this.launch(session, "stage");
        return;
      case "dryrun":
        this.launch(session, "stage", true);
        return;
      case "fire":
        if (value === "custom") {
          session.view = "awaitTime";
          await this.paint(
            session,
            `${bold("Fire at")}\n${esc("Send a time — HH:MM, an ISO timestamp, a unix time, or +90s.")}`,
            confirmKeyboard(),
          );
          return;
        }
        this.launch(session, value === "now" ? "now" : "stage");
        return;
      case "refresh":
        await this.refreshPanel(session, "manual", queryId);
        return;
      case "auto":
        await this.toggleAuto(session, value === "on", queryId);
        return;
      case "noop":
        return;
    }
  }

  // ── setup flow ─────────────────────────────────────────────────────────────

  private async begin(session: Session, intent: Intent, target: string): Promise<void> {
    const busy = beginRefusal(this.running, session.chatId, session.view);
    if (busy !== null) {
      await this.paint(
        session,
        `${bold(busy.title)}\n${esc(busy.body)}`,
        [[{ text: "❌ Cancel", callback_data: encodeCallback("cancel") }]],
      );
      return;
    }
    this.stopAuto(session);
    this.discardDraft(session);
    session.draft = { intent, ...(target ? { target } : {}) };

    if (!target) {
      session.view = "awaitTarget";
      const titles: Record<Intent, string> = {
        mint: "🎯 Mint",
        check: "🔍 Check",
        watch: "👀 Watch",
        stages: "📊 Stages",
      };
      await this.paint(session, renderAskTarget(titles[intent]), BACK_ONLY);
      return;
    }
    await this.afterTarget(session);
  }

  /**
   * Decide the chain, then move on.
   *
   * A URL carries its chain and a bare address is probed; only a slug, or an
   * address deployed to several chains, needs asking. Guessing here is the failure
   * this whole path exists to prevent: a slug resolves to a different contract on
   * every chain it is listed on, so the wrong guess prepares a mint against the
   * wrong deployment and only reveals it as a revert.
   */
  private async afterTarget(session: Session): Promise<void> {
    const target = session.draft.target ?? "";
    let parsedKind: "address" | "slug" | null = null;
    let hint: string | undefined;
    try {
      const parsed = parseTarget(target);
      parsedKind = parsed.kind;
      hint = parsed.chainHint;
    } catch {
      // Let resolveTarget produce the error message; it has one written for this.
    }

    if (hint) {
      session.draft.chainKey = hint;
      await this.askQuantity(session);
      return;
    }
    // A bare address is probed inside resolveTarget. A slug cannot be.
    if (parsedKind === "address") {
      await this.askQuantity(session);
      return;
    }

    session.view = "awaitChain";
    await this.paint(
      session,
      [
        bold("Chain"),
        "",
        esc(`Which chain is this collection on? Default is ${this.opts.defaults.chain}.`),
      ].join("\n"),
      chainKeyboard(),
    );
  }

  private async pickChain(session: Session, chainKey: string): Promise<void> {
    if (!chainKey) return;
    session.draft.chainKey = chainKey;
    delete session.draft.candidates;
    await this.askQuantity(session);
  }

  private async askQuantity(session: Session): Promise<void> {
    // Only a mint needs a quantity. Reading a drop does not depend on one.
    if (session.draft.intent !== "mint") {
      session.draft.quantity = this.opts.defaults.quantity;
      await this.prepare(session);
      return;
    }
    session.view = "awaitQuantity";
    await this.paint(
      session,
      [bold("Quantity"), "", esc("How many per wallet? Tap one, or send a number.")].join("\n"),
      quantityKeyboard(),
    );
  }

  /** Resolve, probe, read the drop, budget gas — then show every number. */
  private async prepare(session: Session): Promise<void> {
    const draft = session.draft;
    if (!draft.target) {
      session.view = "awaitTarget";
      await this.paint(session, renderAskTarget("Target"), BACK_ONLY);
      return;
    }

    await this.paint(session, `${bold("Working")}\n${esc("Resolving the target…")}`, []);
    const progress = (text: string): void => {
      void this.paint(session, `${bold("Working")}\n${esc(text)}`, []);
    };

    let run: PreparedRun;
    try {
      run = await prepareRun({
        target: draft.target,
        chainKey: draft.chainKey,
        quantity: draft.quantity ?? this.opts.defaults.quantity,
        // Addresses only. The stage table needs to know whether a configured
        // SeaDrop signer is a wallet we hold a key for; the keys stay here.
        walletAddresses: this.opts.wallets.map((w) => w.address),
        allowlistSource: this.opts.defaults.allowlistSource,
        openseaAuth: this.auth(),
        apiKey: this.opts.defaults.openseaApiKey,
        maxFeeGwei: this.opts.defaults.maxFeeGwei,
        priorityGwei: this.opts.defaults.priorityGwei,
        gasLimit: this.opts.defaults.gasLimit,
        defaultChain: this.opts.defaults.chain,
        nowMs: this.now(),
        onProgress: progress,
      });
    } catch (err: unknown) {
      // The one error with a UI rather than a message: the address exists on
      // several chains, and only the user knows which deployment they meant.
      if (err instanceof AmbiguousChainError) {
        session.view = "awaitChain";
        session.draft.candidates = err.candidates;
        const candidates = orderCandidates(err.candidates);
        await this.paint(
          session,
          renderChainPicker(err.address, candidates),
          chainKeyboard(candidates),
        );
        return;
      }
      session.view = "menu";
      await this.paint(
        session,
        `${bold("Could not prepare that")}\n\n${esc(redactKeys(err instanceof Error ? err.message : String(err)))}`,
        MAIN_MENU,
      );
      return;
    }

    draft.run = run;

    if (draft.intent === "watch") {
      this.launchWatch(session);
      return;
    }
    if (draft.intent === "stages") {
      await this.showStages(session);
      return;
    }
    if (draft.intent === "check" || !run.plan) {
      await this.showCheck(session);
      return;
    }
    await this.confirm(session);
  }

  // ── read-only panels ───────────────────────────────────────────────────────

  /**
   * Read wallet balances against what this run would actually need.
   *
   * The figure checked is value + gasLimit × maxFeePerGas, which is what the node
   * reserves and therefore what it rejects against — not the expected cost, which
   * is smaller and would pass here and fail at broadcast.
   */
  private async readBalances(run: PreparedRun): Promise<BalanceReport[]> {
    if (!run.plan) return [];
    const required = requiredBalance(run.plan.value, run.gas);
    try {
      return await checkBalances(run.rpc.provider, this.opts.wallets, required);
    } catch {
      return [];
    }
  }

  private balanceLines(reports: BalanceReport[], symbol: string): string[] {
    if (reports.length === 0) return [];
    const lines = [bold("Wallets")];
    for (const report of reports) {
      const balance = report.balance === null ? "unreadable" : formatEth(report.balance, symbol);
      const mark = report.balance === null ? "·" : report.sufficient ? "✓" : "✗";
      lines.push(esc(`${mark} W${report.index} ${shortAddress(report.address)} — ${balance}`));
      if (!report.sufficient && report.balance !== null) {
        lines.push(esc(`   short ${formatEth(report.shortfall, symbol)}`));
      }
    }
    return lines;
  }

  /** 🔍 Check: the full picture, read-only, refreshable. */
  private async showCheck(session: Session): Promise<void> {
    const run = session.draft.run;
    if (!run) {
      await this.showMenu(session);
      return;
    }
    session.view = "check";
    session.draft.balances = await this.readBalances(run);
    session.stageSignature = stageSignature(run);
    await this.paint(session, this.renderCheck(session, run), refreshKeyboard(this.isAuto(session)));
  }

  private renderCheck(session: Session, run: PreparedRun): string {
    const nowMs = this.now();
    const quantity = session.draft.quantity ?? this.opts.defaults.quantity;
    const blocks: string[] = [];

    if (run.collection) {
      blocks.push(
        `${bold(run.collection.name)}\n${link("contract on the explorer", explorerAddress(run.chain.chainId, run.contract))}`,
      );
    } else {
      blocks.push(`${bold("Drop")}\n${code(run.contract)}`);
    }

    blocks.push(
      [
        esc(`chain: ${run.chain.name} (id ${run.chain.chainId})`),
        esc(`quantity: ${quantity} per wallet`),
        run.plan
          ? esc(
              `variant: ${run.plan.variant === "v1-singleton" ? "SeaDrop v1 singleton" : "SeaDrop v2 (config on token)"}`,
            )
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    blocks.push(renderStages(run.stages, run.chain, formatLocal, nowMs, this.stageCtx(run)));

    if (!run.plan) {
      blocks.push(
        esc(noDropMessage(run.contract, run.chain.name, this.opts.defaults.openseaApiKey !== null)),
      );
    }

    blocks.push(
      formatGas(
        run.gas.maxFeePerGas,
        run.gas.maxPriorityFeePerGas,
        run.gas.gasLimit,
        run.fees.baseFeeWei,
        run.chain.nativeSymbol,
      ),
    );

    const balances = this.balanceLines(session.draft.balances ?? [], run.chain.nativeSymbol);
    if (balances.length > 0) blocks.push(balances.join("\n"));

    for (const warning of run.warnings) blocks.push(esc(`⚠ ${warning}`));
    blocks.push(updatedFooter(nowMs));
    return blocks.join("\n\n");
  }

  /** 📊 Stages: the stage table on its own, refreshable. */
  private async showStages(session: Session): Promise<void> {
    const run = session.draft.run;
    if (!run) {
      session.view = "awaitTarget";
      session.draft.intent = "stages";
      await this.paint(session, renderAskTarget("📊 Stages"), BACK_ONLY);
      return;
    }
    session.view = "stages";
    session.stageSignature = stageSignature(run);
    await this.paint(session, this.renderStagesPanel(run), refreshKeyboard(this.isAuto(session)));
  }

  private renderStagesPanel(run: PreparedRun): string {
    const nowMs = this.now();
    const head = run.collection
      ? bold(run.collection.name)
      : `${bold("Drop")} ${code(shortAddress(run.contract))}`;
    return [
      head,
      esc(`${run.chain.name} · ${shortAddress(run.contract)}`),
      "",
      renderStages(run.stages, run.chain, formatLocal, nowMs, this.stageCtx(run)),
      "",
      updatedFooter(nowMs),
    ].join("\n");
  }

  // ── refresh and auto mode ──────────────────────────────────────────────────

  private isAuto(session: Session): boolean {
    return session.autoTimer !== undefined;
  }

  /**
   * Re-read everything behind a live panel and redraw it in place.
   *
   * Debounced rather than queued: a second tap two seconds after the first would
   * return the same numbers, so it is acknowledged with a toast and dropped. The
   * acknowledgement always happens — that is what stops the client spinning.
   */
  private async refreshPanel(
    session: Session,
    source: RefreshSource,
    queryId?: string,
  ): Promise<void> {
    const nowMs = this.now();

    if (!session.gate.allows(source, nowMs)) {
      if (queryId) {
        await this.ackCallback(session, queryId, debouncedToast(session.gate.waitMs(source, nowMs)));
      }
      return;
    }
    // Deliberately no "Refreshing…" here. It answered the press, which meant the
    // failure toast below was rejected as a duplicate and the operator saw a
    // refresh that reported success and changed nothing. The spinner runs for the
    // second or two the re-read takes, which is what a spinner is for.

    const run = session.draft.run;
    const startedView = session.view;
    if (!run || (startedView !== "check" && startedView !== "stages")) {
      this.stopAuto(session);
      return;
    }

    let fresh: PreparedRun;
    try {
      fresh = await refreshRun(run, {
        quantity: session.draft.quantity ?? this.opts.defaults.quantity,
        // Re-asked each refresh: the gated stage being asked about changes as
        // stages open, so carrying the last answer forward would describe the
        // wrong stage with full confidence.
        openseaAuth: this.auth(),
        walletAddresses: this.opts.wallets.map((w) => w.address),
        apiKey: this.opts.defaults.openseaApiKey,
        maxFeeGwei: this.opts.defaults.maxFeeGwei,
        priorityGwei: this.opts.defaults.priorityGwei,
        gasLimit: this.opts.defaults.gasLimit,
        nowMs: this.now(),
      });
    } catch (err: unknown) {
      // A failed read must not kill the panel: the next tick may well succeed, and
      // tearing down a countdown someone is watching because one RPC call timed
      // out is worse than showing slightly stale numbers.
      const message = redactKeys(err instanceof Error ? err.message : String(err));
      session.refreshFailures = (session.refreshFailures ?? 0) + 1;
      const report = planRefreshReport(queryId, session.refreshFailures);
      if (report.toast) {
        await this.ackCallback(
          session,
          queryId ?? "",
          `Refresh failed: ${message.slice(0, 150)}`,
        ).catch(() => {});
      }
      if (report.announce) {
        await this.say(
          session.chatId,
          `${bold("Panel is stale")}\n${esc(
            `The last ${REFRESH_ALERT_AFTER} refreshes failed, so the numbers above are not current: ${message.slice(0, 200)}`,
          )}`,
        ).catch(() => {});
      }
      return;
    }

    // The reads worked, whatever happens to the result below.
    session.refreshFailures = 0;

    const balances = startedView === "check" ? await this.readBalances(fresh) : undefined;

    // Re-checked after the reads, not only before them. Discarding `fresh` costs
    // nothing: `refreshRun` reuses the same provider, so there is no handle here
    // to close and nothing to leak.
    if (!refreshStillApplies(startedView, session.view, run, session.draft.run)) return;

    // The provider is shared, so the old run must not be closed here.
    session.draft.run = fresh;
    if (balances !== undefined) session.draft.balances = balances;

    // A stage that opens or closes changes what the buttons should mean, so auto
    // mode stops and hands control back rather than continuing to tick.
    const signature = stageSignature(fresh);
    const transitioned = session.stageSignature !== undefined && session.stageSignature !== signature;
    session.stageSignature = signature;
    if (transitioned) this.stopAuto(session);

    const text =
      startedView === "check" ? this.renderCheck(session, fresh) : this.renderStagesPanel(fresh);
    const body = transitioned
      ? `${text}\n\n${bold("A stage just changed — auto-refresh stopped.")}`
      : text;

    await this.paint(session, body, refreshKeyboard(this.isAuto(session)));
  }

  /**
   * Turn ⏱ Auto on or off.
   *
   * The interval re-reads on a timer and stops on any of: a second press, a stage
   * transition, a mint run starting, `/cancel`, or navigation away from the panel.
   * It is unref'd so a live panel never holds the process open by itself.
   */
  private async toggleAuto(session: Session, on: boolean, queryId: string): Promise<void> {
    if (session.view !== "check" && session.view !== "stages") {
      await this.ackCallback(
        session,
        queryId,
        "Auto-refresh only applies to a Check or Stages panel.",
        true,
      );
      return;
    }

    if (!on) {
      this.stopAuto(session);
      const run = session.draft.run;
      if (run) {
        const text =
          session.view === "check" ? this.renderCheck(session, run) : this.renderStagesPanel(run);
        await this.paint(session, text, refreshKeyboard(false));
      }
      return;
    }

    this.stopAuto(session);
    session.autoTimer = setInterval(() => {
      void this.refreshPanel(session, "auto");
    }, AUTO_REFRESH_MS);
    session.autoTimer.unref?.();

    const run = session.draft.run;
    if (run) {
      const text =
        session.view === "check" ? this.renderCheck(session, run) : this.renderStagesPanel(run);
      await this.paint(session, text, refreshKeyboard(true));
    }
  }

  private stopAuto(session: Session): void {
    if (session.autoTimer) {
      clearInterval(session.autoTimer);
      delete session.autoTimer;
    }
  }

  // ── confirm and fire ───────────────────────────────────────────────────────

  /**
   * The last stop before anything irreversible.
   *
   * Every number that costs money if it is wrong, on one screen: chain, contract,
   * variant, price, caps, supply, the stage window, the gas ceiling, the wallets,
   * and the worst-case total. "Are you sure?" without these is a button people
   * press without reading.
   */
  private async confirm(session: Session): Promise<void> {
    const run = session.draft.run;
    if (!run?.plan) {
      await this.showCheck(session);
      return;
    }
    session.view = "confirm";
    this.armExpiry(session);

    const quantity = session.draft.quantity ?? this.opts.defaults.quantity;
    const balances = await this.readBalances(run);
    session.draft.balances = balances;

    const fireMode = this.opts.defaults.leadMs > 0
      ? `at the stage opening, −${this.opts.defaults.leadMs}ms lead`
      : "at the stage opening (T-0)";

    const body = renderConfirm({
      plan: run.plan,
      chain: run.chain,
      collectionName: run.collection?.name,
      quantity,
      wallets: this.opts.wallets,
      maxFeeWei: run.gas.maxFeePerGas,
      gasLimit: run.gas.gasLimit,
      stages: run.stages,
      fireMode,
      nowMs: this.now(),
    });

    const blocks = [body];
    const short = balances.filter((r) => !r.sufficient);
    if (short.length > 0) {
      blocks.push(
        [
          bold("⚠ Underfunded wallets"),
          ...short.map((r) =>
            esc(`W${r.index} ${shortAddress(r.address)} short ${formatEth(r.shortfall, run.chain.nativeSymbol)}`),
          ),
        ].join("\n"),
      );
    }
    for (const warning of run.warnings) blocks.push(esc(`⚠ ${warning}`));

    const startMs = run.plan.drop.startTime * 1000;
    const open = this.now() >= startMs;
    const buttons: InlineButton[][] = [
      [
        { text: open ? "✅ Send now" : "✅ Send", callback_data: encodeCallback("send") },
        { text: "❌ Cancel", callback_data: encodeCallback("cancel") },
      ],
    ];
    buttons.push([dryRunButton()]);
    if (!open) {
      buttons.push([
        { text: "⚡ Fire now anyway", callback_data: encodeCallback("fire", "now") },
        { text: "🕐 At a time…", callback_data: encodeCallback("fire", "custom") },
      ]);
    }

    await this.paint(session, blocks.join("\n\n"), buttons);
  }

  /**
   * Start a run without holding up the update loop.
   *
   * `fire` is deliberately not awaited. A mint can sit in its countdown for hours,
   * and awaiting it here meant `handleUpdate` never returned — so the bot made no
   * further `getUpdates` call for the whole run, and the ❌ Cancel tap the run's own
   * message offers was never delivered. The cancel button was decorative.
   *
   * The promise is kept so shutdown can wait for the run to unwind rather than
   * cutting it off mid-flight.
   */
  private launch(
    session: Session,
    mode: "stage" | "now" | { atMs: number },
    dryRun = false,
  ): void {
    // A refused start resolves almost immediately. Installing it as `activeRun`
    // anyway would replace the live run's promise with one that is already done,
    // so `drain()` would return while the real mint was still signing and
    // shutdown would cut it off mid-broadcast.
    const refused = lockRefusal(this.running, session.chatId) !== null;
    const run = this.fire(session, mode, dryRun)
      .catch(async (err: unknown) => {
        // Nothing awaits this promise, so an escape would be an unhandled
        // rejection — and a bot that dies mid-mint is worse than one that reports
        // a failure. `fire` handles its own run errors; this catches the paint
        // and menu calls around them.
        const message = redactKeys(err instanceof Error ? err.message : String(err));
        await this.say(session.chatId, `${bold("Run stopped")}\n${esc(message)}`).catch(() => {});
      })
      .finally(() => {
        // Only if it is still ours: a later run may already have replaced it.
        if (this.activeRun === run) this.activeRun = null;
      });
    if (!refused) this.activeRun = run;
  }

  /**
   * Start a watch without blocking the update loop.
   *
   * `watch` was still awaited inside `handleUpdate`, which is the same defect
   * detaching `fire` fixed and left on this path: a watch runs until the stage
   * opens, so the bot stopped reading updates for as long as that took. ❌ Cancel
   * could not be delivered, because delivering it required the loop that was
   * waiting on the watch. A watch is read-only and takes no lock.
   */
  private launchWatch(session: Session): void {
    const task = this.watch(session)
      .catch(async (err: unknown) => {
        const message = redactKeys(err instanceof Error ? err.message : String(err));
        await this.say(session.chatId, `${bold("Watch stopped")}\n${esc(message)}`).catch(() => {});
      })
      .finally(() => {
        if (this.activeWatch === task) this.activeWatch = null;
      });
    this.activeWatch = task;
  }

  private async fire(
    session: Session,
    mode: "stage" | "now" | { atMs: number },
    dryRun = false,
  ): Promise<void> {
    const chatId = session.chatId;
    const run = session.draft.run;
    if (!run?.plan) {
      await this.paint(
        session,
        `${bold("Nothing is prepared")}\n${esc("Start with 🎯 Mint.")}`,
        MAIN_MENU,
      );
      return;
    }
    const refusal = lockRefusal(this.running, chatId);
    if (refusal !== null) {
      await this.paint(session, [bold(refusal.title), "", esc(refusal.body)].join("\n"), MAIN_MENU);
      return;
    }

    // A mint takes the panel out of live mode: the numbers are now fixed by the
    // transactions being signed, and a refresh loop editing the same message
    // would fight the run reporter for the rate limit.
    this.stopAuto(session);
    this.running = chatId;
    this.runningTarget = run.contract;
    session.view = "running";
    this.clearExpiry(session);
    const controller = new AbortController();
    session.controller = controller;
    this.activeController = controller;

    const { fireAtMs } = resolveFireTime(run.plan, mode, this.opts.defaults.leadMs);
    // A null fire time means "as soon as everything is signed" — there is no
    // instant to print, and printing the current time would imply a schedule
    // that does not exist.
    const when = fireAtMs === null ? "immediately" : formatLocal(fireAtMs);
    await this.paint(
      session,
      [
        bold(dryRun ? "Dry run" : "Running"),
        "",
        esc(`${run.chain.name} · ${shortAddress(run.contract)}`),
        esc(`${this.opts.wallets.length} wallet(s) · ${when}`),
        "",
        esc(
          dryRun
            ? "Every check and every signature will run. Nothing will be broadcast."
            : "Progress is reported below. Cancel stops anything not yet broadcast.",
        ),
      ].join("\n"),
      [[{ text: "❌ Cancel", callback_data: encodeCallback("cancel") }]],
    );

    const reporter = createTelegramReporter(this.opts.client, chatId, run.chain, () => this.clock.now());

    try {
      const result = await runMint(
        {
          chain: run.chain,
          plan: run.plan,
          wallets: this.opts.wallets,
          readUrls: run.rpc.plan.read,
          blastUrls: run.rpc.plan.blast,
          gas: run.gas,
          fireAtMs,
          leadMs: this.opts.defaults.leadMs,
          receiptTimeoutMs: this.opts.defaults.receiptTimeoutMs,
          dryRun,
          // Enforced here, unlike in the CLI. Nobody is watching a bot run, so
          // there is no one to read a clock warning and decide it is acceptable.
          driftLimitMs: this.opts.defaults.clockDriftLimitMs ?? DEFAULT_BOT_DRIFT_LIMIT_MS,
          target: run.contract,
          signal: controller.signal,
        },
        reporter.handle,
      );
      const landed = await reporter.settle();

      // The dry-run report is the entire output, and the reporter has already
      // sent it. A minted/failed tally underneath would say 0 / 0 and read as a
      // failure.
      if (dryRun) {
        if (!landed) await this.say(chatId, `${bold("Report not delivered")}\n${esc(DRY_PANEL_LOST)}`);
        return;
      }

      const tail = [];
      // Before the outcome, not after: the operator reads the top of a message.
      if (!landed) tail.push(esc(PANEL_STALE), "");
      tail.push(
        bold("Summary"),
        esc(`dispatch: ${result.dispatchMs.toFixed(2)}ms to write every transaction`),
      );
      if (result.timingErrorMs !== 0) {
        tail.push(
          esc(
            `timing: ${result.timingErrorMs > 0 ? "+" : ""}${result.timingErrorMs.toFixed(0)}ms from the target instant`,
          ),
        );
      }
      tail.push(esc(`minted: ${result.minted} · failed: ${result.failed}`));
      await this.say(chatId, tail.join("\n"));
    } catch (err: unknown) {
      const landed = await reporter.settle();
      const message = redactKeys(err instanceof Error ? err.message : String(err));
      const note = landed ? "" : `\n\n${esc(PANEL_STALE)}`;
      await this.say(chatId, `${bold("Run stopped")}\n${esc(message)}${note}`);
    } finally {
      this.running = null;
      this.runningTarget = null;
      this.activeController = null;
      // Only tear down what this run owned. Now that the run is detached, the
      // operator can prepare a *new* mint while this one is still in flight —
      // preparing takes no lock, deliberately. A blanket `discardDraft` would
      // close that new run's provider and drop its plan, leaving a confirm panel
      // whose ✅ Send fires against a dead provider. Nothing about that failure
      // would name the run that caused it.
      const teardown = planTeardown(
        { controller: session.controller, draftRun: session.draft.run, view: session.view },
        { controller, run },
      );
      if (teardown.clearController) delete session.controller;
      if (teardown.discardDraft) this.discardDraft(session);
      if (teardown.closeOwnRunOnly) closeRun(run);
      // Do not repaint over a panel the operator has moved on to. The run's
      // closing summary is a separate message, so it is not lost either way.
      if (teardown.showMenu) await this.showMenu(session);
    }
  }

  // ── watch ──────────────────────────────────────────────────────────────────

  /**
   * Wait for a public stage to open.
   *
   * Read-only, so it does not take the run lock — but it does occupy this chat's
   * panel, because the panel is where its progress is reported.
   */
  private async watch(session: Session): Promise<void> {
    const chatId = session.chatId;
    const run = session.draft.run;
    if (!run) {
      await this.showMenu(session);
      return;
    }

    session.view = "watching";
    const controller = new AbortController();
    // Not `session.controller`: that belongs to a run, and overwriting it left a
    // live mint with no abort handle at all.
    session.watchController = controller;

    await this.paint(
      session,
      [
        bold("👀 Watching"),
        "",
        esc(`${run.chain.name} · ${shortAddress(run.contract)}`),
        "",
        esc("Polling the contract for the public stage. Nothing will be sent."),
      ].join("\n"),
      [[{ text: "❌ Stop watching", callback_data: encodeCallback("cancel") }]],
    );

    try {
      const found = await waitForPublicStage(
        run.rpc.provider,
        run.contract,
        session.draft.quantity ?? this.opts.defaults.quantity,
        {
          signal: controller.signal,
          onUpdate: (update: WatchUpdate) => {
            if (update.kind === "waiting") return; // too chatty for a chat
            void this.say(chatId, esc(update.message));
          },
        },
      );
      await this.say(
        chatId,
        [
          bold("🟢 Stage open"),
          esc(`${run.chain.name} · ${shortAddress(run.contract)}`),
          esc(`price: ${formatEth(found.drop.mintPrice, run.chain.nativeSymbol)}`),
          "",
          esc("Use 🎯 Mint to prepare and confirm against it."),
        ].join("\n"),
      );
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        await this.say(chatId, esc(redactKeys(err instanceof Error ? err.message : String(err))));
      }
    } finally {
      if (session.watchController === controller) delete session.watchController;
      // The watch is detached now, so the operator may have built a new draft
      // while it ran. Only discard the one this watch was actually using.
      if (session.draft.run === run) {
        this.discardDraft(session);
      } else {
        closeRun(run);
      }
      // Do not repaint over a panel the operator has moved on to.
      if (session.view === "watching") await this.showMenu(session);
    }
  }

  // ── odds and ends ──────────────────────────────────────────────────────────

  private async showWallets(session: Session): Promise<void> {
    this.stopAuto(session);
    session.view = "wallets";
    const wallets = this.opts.wallets;

    if (wallets.length === 0) {
      await this.paint(
        session,
        `${bold("No wallets")}\n${esc("Set PRIVATE_KEYS in the bot's .env. Keys are never accepted over Telegram.")}`,
        BACK_ONLY,
      );
      return;
    }

    const lines = [bold(`👛 ${wallets.length} wallet(s)`), ""];
    for (const wallet of wallets) lines.push(`W${wallet.index} ${code(wallet.address)}`);
    lines.push("");
    lines.push(esc("Balances are checked against the real required amount during a mint,"));
    lines.push(esc("per chain — value plus the full gas ceiling, which is what a node reserves."));
    await this.paint(session, lines.join("\n"), BACK_ONLY);
  }

  private async showStatus(session: Session): Promise<void> {
    // Read the view *before* overwriting it. This used to assign "status" first
    // and then look the new value up, so the lookup could only ever land on the
    // "status" row — /status answered "Idle." during a live mint.
    const was = session.view;
    session.view = "status";
    const describe: Record<View, string> = {
      menu: "Idle.",
      awaitTarget: "Waiting for a link, slug, or contract address.",
      awaitChain: "Waiting for a chain.",
      awaitQuantity: "Waiting for a quantity.",
      awaitTime: "Waiting for a time to fire at.",
      confirm: "Prepared and waiting for confirmation. Nothing has been sent.",
      running: "Running. Cancel to abort.",
      watching: "Watching for the public stage. Nothing will be sent.",
      check: "Showing a drop.",
      stages: "Showing a drop's stages.",
      wallets: "Showing wallets.",
      status: "Idle.",
    };

    // The lock is the truth; the view is a display flag any panel can overwrite.
    const state = this.running === session.chatId ? "Running. Cancel to abort." : describe[was];
    const lines = [bold("📈 Status"), "", esc(state)];
    const run = session.draft.run;
    if (run) {
      lines.push(esc(`target: ${shortAddress(run.contract)} on ${run.chain.name}`));
      if (run.detection) lines.push(esc(`chain: detected by probing (${run.detection.kind})`));
    }
    lines.push(
      esc(`clock: ${this.clock.offset >= 0 ? "+" : ""}${this.clock.offset}ms correction applied`),
    );
    lines.push(esc(`wallets: ${this.opts.wallets.length}`));
    if (this.isAuto(session)) lines.push(esc("auto-refresh: on"));
    if (this.running !== null) {
      lines.push(
        esc(this.running === session.chatId ? "This chat holds the run lock." : "Another chat holds the run lock."),
      );
    }
    lines.push("", updatedFooter(this.now()));
    await this.paint(session, lines.join("\n"), BACK_ONLY);
  }

  /**
   * Abort whatever is happening, from any panel.
   *
   * Handles three distinct situations with one button: a run in flight (abort it),
   * a live panel (stop the loop), and a half-finished setup (drop it). An already
   * broadcast transaction cannot be recalled, and the message says so rather than
   * implying the abort undid it.
   */
  private async cancel(session: Session): Promise<void> {
    const wasAuto = this.isAuto(session);
    this.stopAuto(session);

    // Both handles, not just this chat's. The mint lock is global, so a run
    // started from a group panel has to be stoppable from the operator's DM —
    // and HARD CONSTRAINT 6 asks for one button that kills a live mint *and* a
    // live panel loop, which for this chat may be two different controllers.
    // Anything reaching here has already passed the authorization check.
    const live = abortTargets(
      this.activeController,
      session.controller,
      session.watchController,
    );
    if (live.length > 0) {
      for (const controller of live) controller.abort();
      await this.paint(
        session,
        [
          bold("Aborting"),
          "",
          esc(
            "Nothing further will be sent. Anything already broadcast is on-chain and cannot be recalled.",
          ),
        ].join("\n"),
        MAIN_MENU,
      );
      return;
    }

    const had = session.view !== "menu" || session.draft.run !== undefined || wasAuto;
    this.discardDraft(session);
    session.view = "menu";
    await this.paint(
      session,
      [
        renderMenu(this.opts.defaults.chain, this.opts.wallets.length),
        "",
        esc(had ? "Cancelled. Nothing was sent." : "Nothing to cancel."),
      ].join("\n"),
      MAIN_MENU,
    );
  }

  /** Close the prepared run's provider. Sockets left open leak file descriptors. */
  private discardDraft(session: Session): void {
    this.clearExpiry(session);
    this.stopAuto(session);
    if (session.draft.run) closeRun(session.draft.run);
    session.draft = { intent: session.draft.intent };
    delete session.stageSignature;
  }

  private armExpiry(session: Session): void {
    this.clearExpiry(session);
    session.expiry = setTimeout(() => {
      if (session.view !== "confirm") return;
      this.discardDraft(session);
      session.view = "menu";
      void this.paint(
        session,
        [
          bold("That prepared mint went stale"),
          "",
          esc(
            "Prices and the stage may have moved, so it was dropped. Nothing was sent. Start again with 🎯 Mint.",
          ),
        ].join("\n"),
        MAIN_MENU,
      );
    }, DRAFT_TTL_MS);
    session.expiry.unref?.();
  }

  private clearExpiry(session: Session): void {
    if (session.expiry) {
      clearTimeout(session.expiry);
      delete session.expiry;
    }
  }

  /**
   * Wait for a detached run to finish unwinding after `shutdown` aborted it.
   *
   * Raising the abort is not the same as having stopped: the run still has to
   * settle its reporter and send its closing line. Exiting the instant the abort
   * is raised drops that message, and the operator is left with a countdown that
   * simply went quiet.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([this.activeRun, this.activeWatch]);
  }

  /** Abort everything in flight — used on shutdown. */
  shutdown(): void {
    // The lock is global, so the handle is too: a run started from one chat used
    // to survive SIGTERM because shutdown only walked per-session controllers,
    // and `watch` had overwritten the one it looked at.
    this.activeController?.abort();
    for (const session of this.sessions.values()) {
      session.controller?.abort();
      session.watchController?.abort();
      this.clearExpiry(session);
      this.stopAuto(session);
      if (session.draft.run) closeRun(session.draft.run);
    }
  }
}

/**
 * A fingerprint of every stage's status, for noticing a transition.
 *
 * Status rather than countdown: the countdown changes on every tick by design, so
 * comparing it would report a transition every 20 seconds. What matters is a row
 * crossing from upcoming to live, or live to ended.
 */
export function stageSignature(run: Pick<PreparedRun, "stages">): string {
  return run.stages.rows.map((row) => `${row.kind}:${row.label}:${row.status}`).join("|");
}

/** Used only to wait out Telegram's pacing before a panel edit. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
