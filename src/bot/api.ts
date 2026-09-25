// Telegram Bot API client: long polling, no dependencies.
//
// Written directly against the HTTP API rather than a framework, for the same
// reason there is no colour library: this process holds private keys, and every
// dependency is a supply-chain path into it. The surface actually needed is five
// methods.
//
// Two decisions here are safety-critical rather than stylistic:
//
//   The update offset is committed *before* an update is handled, not after. That
//   makes delivery at-most-once. The usual default — acknowledge after successful
//   processing — would redeliver an update if the bot crashed mid-handling, and for
//   a bot that sends transactions, redelivering "fire" means minting twice with the
//   same intent. A dropped command is recoverable by retyping it; a duplicated
//   mint is not.
//
//   HTTP 409 means another process is polling the same token. That is treated as
//   fatal rather than retried, because two live instances would both act on every
//   command — the same double-mint, arrived at a different way.

import { redactKeys } from "../core/wallets";

const API_ROOT = "https://api.telegram.org";

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/**
 * Telegram's ways of saying the message you are editing no longer exists.
 *
 * The distinction matters because the recovery is opposite. A message that is
 * genuinely gone must be replaced. A message that could not be edited *this time*
 * — a 429, a timeout, a 5xx — must not be, or one rate-limited edit becomes a
 * second panel, and the next paint rate-limits again, and the chat fills with
 * panels while the original is orphaned.
 */
const MESSAGE_GONE =
  /message to edit not found|message to be edited not found|message can't be edited|MESSAGE_ID_INVALID|message to delete not found/i;

export function isMessageGone(err: unknown): boolean {
  return MESSAGE_GONE.test(err instanceof Error ? err.message : String(err));
}

export class TelegramError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

/** Another process is polling this token — both would act on every command. */
export class ConflictError extends TelegramError {
  constructor() {
    super(
      409,
      "Another instance is already polling this bot token. Two instances would both act on every command, so this one is stopping.",
    );
    this.name = "ConflictError";
  }
}

/**
 * The caller's own signal cancelled the request.
 *
 * Not a Telegram fault, and the distinction matters: the long poll is held open
 * for fifty seconds, so shutdown has to cancel it rather than wait it out, and the
 * resulting fetch rejection must not be mistaken for an outage and retried.
 */
export class AbortedError extends TelegramError {
  constructor() {
    super(0, "The request was cancelled locally.");
    this.name = "AbortedError";
  }
}

export class TelegramClient {
  private readonly base: string;
  private offset = 0;

  constructor(token: string) {
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN does not look like a bot token (expected `123456789:ABC…` from @BotFather).",
      );
    }
    this.base = `${API_ROOT}/bot${token}`;
  }

  private async call<T>(
    method: string,
    payload?: object,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<T> {
    // Redacted here, at the one transport every method shares, and not only at the
    // call sites: HARD CONSTRAINT 4 says every Telegram message routes through
    // redactKeys(), and a rule kept by caller discipline is a rule that holds only
    // until the next call site is added. It already failed that way once.
    const safe = redactOutbound(payload);
    let res: Response;
    try {
      res = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(safe ?? {}),
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      // Distinguished from a network fault because the caller acts on it
      // differently: a cancelled poll during shutdown is the expected outcome and
      // must not be retried or reported as Telegram being unreachable.
      if (signal?.aborted === true) throw new AbortedError();
      const message = err instanceof Error ? err.message : String(err);
      // The token is in the URL, so a fetch error can quote it.
      throw new TelegramError(0, `Telegram unreachable: ${redactKeys(message)}`);
    }

    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };

    if (res.status === 409) throw new ConflictError();
    if (res.status === 401) {
      throw new TelegramError(401, "Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.");
    }
    if (!res.ok || json.ok !== true) {
      const retryAfter = json.parameters?.retry_after;
      throw new TelegramError(
        res.status,
        `Telegram ${method} failed: ${json.description ?? `HTTP ${res.status}`}`,
        retryAfter,
      );
    }
    return json.result as T;
  }

  async getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe");
  }

  /**
   * Long-poll for updates.
   *
   * A 50s server-side wait rather than a short poll loop: the connection is held
   * open and Telegram replies the instant something arrives, so a command reaches
   * the bot in one round trip instead of waiting out a polling interval. The client
   * timeout is deliberately longer than the server's so the server closes first.
   */
  async getUpdates(timeoutSec = 50, signal?: AbortSignal): Promise<TgUpdate[]> {
    const updates = await this.call<TgUpdate[]>(
      "getUpdates",
      {
        offset: this.offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query"],
      },
      (timeoutSec + 15) * 1000,
      signal,
    );
    // Commit before the caller handles anything. See the header note.
    for (const update of updates) {
      if (update.update_id >= this.offset) this.offset = update.update_id + 1;
    }
    return updates;
  }

  /**
   * Discard anything queued while the bot was down.
   *
   * `offset: -1` is the cheap, correct way to skip a backlog: Telegram returns
   * only the most recent update, and acknowledging it retires every update before
   * it. The discard is total no matter how deep the queue was.
   *
   * What it cannot do is count. The array is one element long after a weekend
   * offline exactly as it is after a minute, so a caller reporting `length` as a
   * number of dropped updates reports 1 for a backlog of two hundred. This
   * returns what the call actually knows — whether there was a backlog, and the
   * update it was retired through — rather than a number that reads precise and
   * is not.
   */
  async dropPendingUpdates(): Promise<{ hadBacklog: boolean; throughId: number | null }> {
    const stale = await this.call<TgUpdate[]>("getUpdates", { offset: -1, timeout: 0 });
    const last = stale[stale.length - 1];
    if (!last) return { hadBacklog: false, throughId: null };
    this.offset = last.update_id + 1;
    return { hadBacklog: true, throughId: last.update_id };
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts: { buttons?: InlineButton[][]; replyTo?: number; silent?: boolean } = {},
  ): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: truncate(redactKeys(text)),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo } } : {}),
      ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
    });
  }

  /**
   * Edit a message in place.
   *
   * Used for the countdown and the live run status, so a mint produces one message
   * that updates rather than fifty that scroll. "message is not modified" is
   * returned as an error by Telegram and is meaningless here, so it is swallowed.
   */
  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    opts: { buttons?: InlineButton[][] } = {},
  ): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: truncate(redactKeys(text)),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof TelegramError && /not modified/i.test(err.message)) return;
      throw err;
    }
  }

  /**
   * Acknowledge a button press. Without this the client spins for ~30s.
   *
   * `alert` raises a modal instead of a toast, for the cases the user must
   * actually read — a rejected callback, or a button that is no longer valid.
   */
  async answerCallback(id: string, text?: string, alert = false): Promise<void> {
    try {
      await this.call("answerCallbackQuery", {
        callback_query_id: id,
        ...(text ? { text } : {}),
        ...(alert ? { show_alert: true } : {}),
      });
    } catch {
      // A stale callback id is not worth failing a run over.
    }
  }

  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    try {
      await this.call("setMyCommands", { commands });
    } catch {
      // Cosmetic: the menu hint in Telegram's UI. Never fail startup for it.
    }
  }
}

/** Telegram rejects messages over 4096 characters outright. */
/**
 * Every field of an outbound payload that carries free text.
 *
 * Ids are numbers and button labels are our own constants, so these are the only
 * places operator input can reach Telegram.
 */
const TEXT_FIELDS = ["text", "caption"] as const;

/**
 * Redact the text-bearing fields of an outbound payload.
 *
 * Returns `object` rather than a generic so no cast is needed — the only consumer
 * is `JSON.stringify`, which does not care about the static type. Idempotent, so
 * applying it after a call site has already redacted costs nothing: the
 * replacement markers are not themselves key-shaped.
 */
function redactOutbound(payload: object | undefined): object | undefined {
  if (payload === undefined) return undefined;
  const out: Record<string, unknown> = { ...payload };
  for (const field of TEXT_FIELDS) {
    const value = out[field];
    if (typeof value === "string") out[field] = redactKeys(value);
  }
  return out;
}

const TRUNCATION_MARKER = "\n… (truncated)";

/**
 * Trim a finished HTML message to Telegram's limit without corrupting it.
 *
 * The naive version — `slice(0, limit - 20)` — cuts at a raw character offset,
 * and every one of those offsets can land somewhere that makes the message
 * unsendable rather than merely shorter:
 *
 * - inside a tag, leaving `<a hre`, so Telegram answers 400 "can't parse
 *   entities" and the message is lost entirely rather than truncated;
 * - after an opening tag but before its close, leaving `<b>` unbalanced, same 400;
 * - inside an entity, leaving `&am`;
 * - between the halves of a surrogate pair, leaving a lone surrogate that is not
 *   valid UTF-8 once JSON-encoded.
 *
 * All four fail the same way, and they fail where nobody is watching: the panel
 * painter treats a failed edit as nothing to do, so the symptom is a live run
 * whose status message simply stops updating. Long messages are exactly the ones
 * a real mint produces — one line per wallet — so this is not a rare path.
 *
 * So the cut is made at an atom boundary instead: tags, entities and astral
 * characters are stepped over whole, never entered. Whatever tags are still open
 * at the boundary are closed, in reverse order, before the marker is appended.
 */
export function truncate(text: string, limit = 4096): string {
  if (text.length <= limit) return text;

  // The closers have to fit too, and their length depends on where the cut lands,
  // which depends on the budget. Two passes converge; the loop is belt and braces.
  let reserve = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const budget = Math.max(0, limit - TRUNCATION_MARKER.length - reserve);
    const { cut, open } = planCut(text, budget);
    const closers = [...open].reverse().map((tag) => `</${tag}>`).join("");
    const out = `${text.slice(0, cut)}${closers}${TRUNCATION_MARKER}`;
    if (out.length <= limit) return out;
    reserve = closers.length;
  }
  // Unreachable while the loop above converges. Falling back to a tag-free
  // message is the one truncation that cannot produce a parse error.
  return TRUNCATION_MARKER.trimStart();
}

/**
 * Find the largest cut point at or below `budget` that no atom straddles, and
 * report which tags are open there.
 */
function planCut(text: string, budget: number): { cut: number; open: string[] } {
  const open: string[] = [];
  let cut = 0;
  let cutOpen: string[] = [];
  let i = 0;

  while (i < text.length) {
    let next: number;
    if (text[i] === "<") {
      const close = text.indexOf(">", i);
      if (close === -1) break; // an unterminated tag: there is no safe cut past it
      const tag = /^<(\/?)([a-zA-Z]+)/.exec(text.slice(i, close + 1));
      if (tag) {
        const name = (tag[2] ?? "").toLowerCase();
        if (tag[1] === "/") {
          if (open[open.length - 1] === name) open.pop();
        } else {
          open.push(name);
        }
      }
      next = close + 1;
    } else if (text[i] === "&") {
      const semi = text.indexOf(";", i);
      // `&` also occurs as a literal in text that was never escaped; only treat a
      // plausibly short run as an entity.
      next = semi !== -1 && semi - i <= 10 ? semi + 1 : i + 1;
    } else {
      const code = text.charCodeAt(i);
      next = code >= 0xd800 && code <= 0xdbff ? i + 2 : i + 1;
    }

    if (next > budget) break;
    i = next;
    cut = next;
    cutOpen = [...open];
  }

  return { cut, open: cutOpen };
}

/** Escape for parse_mode HTML. Only these three characters are special. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function code(text: string): string {
  return `<code>${esc(text)}</code>`;
}

export function bold(text: string): string {
  return `<b>${esc(text)}</b>`;
}

export function link(label: string, url: string): string {
  return `<a href="${esc(url)}">${esc(label)}</a>`;
}
