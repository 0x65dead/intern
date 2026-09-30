# Architecture

Three things in intern are easy to get wrong in ways that do not announce
themselves: the bot's panel state, how a bare address finds its chain, and how the
CLI and the bot stay in agreement. This document is about those three.

---

## 1. The panel state machine

### One message per chat

A bot that answers each command with a new message buries the thing you are looking
at under the history of how you got there. So each chat owns exactly **one** panel
message. Its id lives on the session:

```ts
interface Session {
  chatId: number;
  panelId: number | null;      // the message every view edits
  view: View;                  // what is currently drawn
  draft: Draft;                // what is being assembled
  controller?: AbortController;
  gate: EditGate;              // paces edits to this panel
  autoTimer?: NodeJS.Timeout;
  stageSignature?: string;     // to notice a stage transition
}
```

Every state change funnels through one method:

```ts
private async paint(session, text, buttons) {
  session.gate.record(this.now());
  if (session.panelId !== null) {
    try { await client.editMessage(chatId, panelId, text, {buttons}); return; }
    catch { session.panelId = null; }   // deleted or too old — fall through
  }
  const sent = await client.sendMessage(chatId, text, {buttons});
  session.panelId = sent.message_id;
}
```

The fallback matters. Users delete messages, and Telegram refuses edits on messages
past a certain age. A bot that then refuses to draw anything looks broken, so a
failed edit silently becomes a new panel and the session adopts it.

### The views

```
                   ┌──────────────────────────────────────┐
                   │                menu                  │◀──── /start
                   └──┬────────┬────────┬────────┬────────┘
          🎯 Mint     │   🔍   │   📊   │  👛/📈 │
                      ▼        ▼        ▼        ▼
                 awaitTarget  check   stages  wallets/status
                      │      (live)   (live)     (live)
                      ▼
                 awaitChain ──── only when detection is ambiguous
                      ▼
                awaitQuantity
                      ▼
                  awaitTime
                      ▼
                   confirm  ◀──── nothing has touched a key yet
                      │
                   ✅ Send
                      ▼
                   running  ──── holds the global run lock
```

`View` is a closed union (`menu`, `awaitTarget`, `awaitChain`, `awaitQuantity`,
`awaitTime`, `confirm`, `running`, `check`, `stages`, `wallets`, `status`), and the
`Draft` accumulates alongside it. A slash command always wins over whatever the
state machine was expecting, so a half-finished setup can never trap a chat —
`/cancel` and `/start` are reachable from every view.

### Callbacks are a closed vocabulary

Callback data is attacker-supplied in the same sense message text is: the client
echoes back whatever it was given, and a modified client can send anything. So
`PANEL_ACTIONS` is a fixed set, and `parseCallback` returns `null` for anything
outside it rather than defaulting:

```ts
export function parseCallback(data: string | undefined): ParsedCallback | null {
  if (!data) return null;
  const sep = data.indexOf(":");
  const rawAction = sep === -1 ? data : data.slice(0, sep);
  if (!isPanelAction(rawAction)) return null;
  return { action: rawAction, value: sep === -1 ? "" : data.slice(sep + 1) };
}
```

`null` produces a visible *"That button is no longer valid — reopen the panel with
/start"*, not a silent no-op. An unrecognised action almost always means a stale
keyboard from a previous deployment, and doing nothing there is indistinguishable
from a bot that has hung.

Values are range-checked at the point of use, never trusted because we authored the
button: `qty:5` is validated with `Number.isInteger(n) && n >= 1 && n <= 1000`.

### Order of operations on a press

**Authorize → acknowledge → act.** The acknowledgement comes before the work
because Telegram spins the client's button for about thirty seconds without one, and
preparing a run takes several seconds — long enough for a user to conclude nothing
happened and press again.

```ts
if (!chat || !this.authorized(query.from.id, chat)) {
  await client.answerCallback(query.id, "Not authorized to use this bot.", true);
  return;
}
const parsed = parseCallback(query.data);
if (!parsed) { /* stale-button alert */ return; }
if (parsed.action !== "refresh") await client.answerCallback(query.id);
await this.dispatchAction(session, parsed.action, parsed.value, query.id);
```

Refresh answers its own callback, because it is the one action that may need to
report a debounce instead of a result.

### Authorization, identically on both paths

```ts
private authorized(userId: number | undefined, chat: {id: number; type: string}): boolean {
  if (userId === undefined) return false;
  if (!this.opts.allowedIds.includes(userId)) return false;
  if (chat.type !== "private" && !this.opts.allowedIds.includes(chat.id)) return false;
  return true;
}
```

The same function runs on `message.from.id` and on `callback_query.from.id`. This is
the single easiest thing to get wrong in a bot like this: checking messages and
forgetting that a callback query carries its own `from`. A panel sitting in a group
is visible to every member, so "who pressed the button" is exactly as open a
question as "who typed the command" — and a panel left open in a group would
otherwise be a mint button for the whole room. `tests/botauth.test.ts` drives both
paths through the real `handleUpdate` to hold that in place.

Note the asymmetry in the response: an unsolicited **message** is ignored in silence
(replying confirms the token is live and worth probing), while an unauthorized
**press** is refused out loud (the presser can already see the panel, so there is
nothing to conceal, and silence reads as a broken button).

### Two locks, deliberately different

```ts
private readonly scheduler = new TaskScheduler(() => this.clock.now());
```

One mint run at a time **per wallet**, across every chat. This was a single
`running: number | null` chat id, which serialized every run against every other
whatever wallets they used. That is the safe answer, but it is the safe answer
arrived at by not asking the question: the collision belongs to a wallet — two runs
signing with one key produce two transactions at one nonce and the network keeps
exactly one — and two runs on disjoint keys cannot collide at all. A flag next to
the wallet locks was also a second answer to "may this run start", and two answers
drift.

So `launch()` asks `scheduler.walletHolders()` which of its wallets are committed,
refuses if any are, and otherwise submits the run as a task that holds those
wallets until it settles. Contention refuses rather than queues, deliberately: a
mint that waits for an unrelated run is usually a mint whose stage has closed, and
firing it late and unattended at a price nobody re-confirmed is worse than not
firing it. The refusal names the wallets.

The bot has no per-run wallet selection yet, so every run asks for every loaded key
and the observable behaviour is still one run at a time — which is why the change
was safe to make before the selection exists. `--wallets` on the CLI is the narrower
set today.

Read-only panels — `check`, `stages`, `wallets`, `status` — never take it. They
read; they cannot spend. Holding the run lock to display a countdown would mean one
person watching a drop blocks everyone else from minting, which is backwards.

### Live panels and edit pacing

Telegram allows roughly one edit per second per chat. A 🔄 Refresh button and a 20s
auto loop can exceed that trivially — two taps in a second, or a tap landing on the
same tick as the timer. `EditGate` decides this in one place:

```ts
allows(source: "manual" | "auto", nowMs: number): boolean {
  const gap = source === "manual" ? this.debounceMs : this.minGapMs;   // 3000 / 1000
  return nowMs - this.lastEditMs >= gap;
}
```

Two limits protecting two different things. The **3s manual debounce** protects the
user from their own repeat taps: a refresh re-reads stages, supply, gas and
balances, and doing that five times because someone tapped five times burns RPC
quota to return identical numbers. The **1s hard gap** protects the connection from
a 429 and applies to every edit regardless of origin.

`record()` is called only when an edit actually goes out, so a refused refresh does
not push the next allowed one further away — otherwise repeat tapping would starve
the panel indefinitely. Time is passed in rather than read internally, which is why
`tests/panel.test.ts` can pin all of this down without sleeping.

Auto-refresh stops on three conditions: the user toggles it, a mint starts, or a
stage transitions. The last one is detected by comparing a signature across renders:

```ts
export function stageSignature(run: Pick<PreparedRun, "stages">): string {
  return run.stages.rows.map((r) => `${r.kind}:${r.label}:${r.status}`).join("|");
}
```

When that string changes, something crossed a boundary — a stage opened or closed —
and the panel stops auto-refreshing rather than quietly continuing to tick past the
moment the user was waiting for.

### Time

Nothing in the panel path calls `Date.now()`. `SessionManager.now()` reads a
`CorrectedClock` measured against the network at startup, and every countdown and
`updated HH:MM:SS` footer goes through it. The offset is the *machine's* clock
error, which is chain-independent, so one startup sync serves every panel; an actual
mint re-syncs inside the engine against the chain it fires on.

---

## 2. Chain auto-detection

### The problem

An OpenSea link carries its chain. A slug can be looked up. A bare `0x` address
carries nothing — and requiring `--chain` for it is a real failure mode, not a minor
inconvenience: the default gets used, the address has no code on that chain, and the
drop reads as "not configured" or the mint reverts. Both look like a problem with
the collection rather than a problem with the flag.

### The probe

`eth_getCode` on every configured chain, concurrently. It is the right question: one
cheap read, no ABI needed, and a non-empty answer proves *something* is deployed
there. It does not prove the thing is a SeaDrop collection — `buildMintPlan` decides
that afterwards, on the chain this picked.

Concurrent across chains because they are independent and the latency is entirely
network-bound; serially this would be eight round trips on the interactive path
while someone waits. Within a chain, endpoints are tried in order and the first
usable answer wins — code presence is not a matter of opinion between endpoints.
Send-only sequencers are skipped: they reject reads, so probing them adds a
guaranteed-failed request per chain and no information.

### The decision, isolated and pure

```ts
export function classifyProbes(probes: ChainProbe[]): Detection {
  const withCode = probes.filter((p) => p.hasCode);
  if (withCode.length === 1) return {kind: "single", chainKey: withCode[0]!.chainKey, probes};
  if (withCode.length > 1)  return {kind: "ambiguous", candidates: withCode.map(p => p.chainKey), probes};
  return {kind: "none", probes};
}
```

This is separated from the I/O above it because it is the part that must not be
wrong, and a bug here is silent. **Collapsing "ambiguous" into "single" does not
throw and does not warn — it mints on an arbitrary chain.** A CREATE2-deployed
collection has the same address on every chain it was deployed to, so the wrong pick
is a real transaction on a real network with nothing to show for it.

The three outcomes stay three outcomes:

- **single** → use it, no question asked.
- **ambiguous** → **ask**. Never resolved by heuristic. Not by code size, not by
  latency, not by "ethereum is probably right" — none of those have anything to do
  with which deployment the user meant.
- **none** → say so, and list which chains were probed and which never answered. A
  failed probe is "unknown", never "no code there"; treating it as a negative is how
  the one chain that did answer wins by default.

### Plugging into both renderers

The core must not know which renderer is attached, so the ambiguous case is raised
rather than resolved. `prepareRun` throws `AmbiguousChainError` carrying the
candidates, and each renderer answers it in its own idiom.

**CLI** — a numbered prompt, or a clear error when there is no TTY to prompt on:

```ts
async function prepareResolvingChain(opts: PrepareOptions): Promise<PreparedRun> {
  try {
    return await prepareRun(opts);
  } catch (err) {
    if (!(err instanceof AmbiguousChainError)) throw err;
    const candidates = orderCandidates(err.candidates);
    if (!process.stdin.isTTY) throw new Error(/* names the chains, suggests --chain */);
    const chainKey = await askChoice("Which chain did you mean?", candidates);
    return prepareRun({ ...opts, chainKey });
  }
}
```

All four CLI commands (`check`, `watch`, `mint`, `allowlist`) route through this one
function, so none of them can acquire a different chain-resolution policy later.

**Bot** — the same information as an inline keyboard. The session moves to
`awaitChain`, `renderChainPicker` restates the address (the panel can arrive a while
after it was typed, and picking a chain for the wrong address is not recoverable
once the mint fires), and `chainKeyboard` emits `chain:<key>` buttons.

Candidate ordering is registry order in both — deliberately not sorted by code size
or latency. Neither has anything to do with the answer, and a list that reorders
itself between renders is a list people misclick.

### Caching

Keyed by lowercased address. A contract's code cannot leave a chain, so the answer
cannot change while the process runs. Without this, a panel auto-refreshing every
20s would re-probe eight chains on every tick.

---

## 3. Shared-core parity

The requirement is that the CLI and the bot never drift and never duplicate logic.
That is enforced structurally, not by convention — conventions are what drift.

### The layering

```
              ┌───────────────────────────────────────────┐
              │  core/  engine · prepare · seadrop · rpc   │
              │         detect · stages · stagetable       │
              │         clock · timing · wallets           │
              └───────────────┬───────────────────────────┘
                              │  events + data, no strings
              ┌───────────────┴───────────────┐
              ▼                               ▼
      ┌───────────────┐               ┌───────────────┐
      │  cli/report   │               │  bot/panel    │
      │  padded table │               │  labelled     │
      │  ANSI colour  │               │  Telegram HTML│
      └───────────────┘               └───────────────┘
```

`core/` knows nothing about terminals or Telegram. It emits events and returns data.
Both renderers subscribe to the same `EngineEvent` stream, so a run reports the same
facts in both places by construction: there is one implementation of the mint.

### Where parity actually breaks, and the fix

The engine was never the risk — it is one code path. The risk is **presentation
logic that looks like formatting but is really a decision**: which columns exist,
what a cell says when a value is unknown, what order rows come in. That is exactly
the kind of thing that gets fixed in one renderer and not the other.

So `core/stagetable.ts` owns those decisions and produces plain-string cells:

```ts
export const STAGE_COLUMNS = ["stage","price","window","cap","status","mints left","source"] as const;

export function stageCells(row: StageRow, chain: ChainProfile, fmtTime): StageCells {
  return {
    stage: /* kind, plus the creator's label when it adds something */,
    price: row.priceWei === null ? "—" : formatEth(row.priceWei, chain.nativeSymbol),
    window: formatWindow(row, fmtTime),
    cap: row.perWalletCap > 0 ? String(row.perWalletCap) : "—",
    status: statusText(row),
    mintsLeft: /* "3800 / 5000" or "—" */,
    source: row.source,
  };
}
```

The CLI pads these into a box. The bot escapes them into labelled lines, because
Telegram renders a proportional font and a seven-column table wraps on a phone
regardless. **The two look different and say the same thing** — neither decides what
a column *means*, so `intern check` and 📊 Stages cannot end up disagreeing about a
drop.

The same applies to wording the spec fixes verbatim. `stageSummaryLines` produces
`"Time until start: HH:MM:SS"` and `"Mint left: [X / Total]"` once, for both.

### Source labelling as a correctness property

Every row carries where it came from, and this is not decoration:

- **PUBLIC** is on-chain — price, window and per-wallet cap read from the SeaDrop
  drop struct. Authoritative; it cannot be changed under you.
- **GTD / TEAM / ALLOWLIST / FCFS** live in OpenSea's drop configuration. On-chain
  there is only `mintSigned()`, whose parameters arrive inside a server-signed
  payload at mint time. Before such a stage opens there is no on-chain record of its
  price at all.

A table mixing the two silently invites trusting the wrong half, so `source` is a
column in both renderers and is never dropped to save width. An unknown price prints
`—`, never `0 ETH`: those are different claims, and "free mint" is one people act on.

Where the two disagree about the public stage — a creator who edited the schedule on
OpenSea without reconfiguring the contract — the on-chain row wins, because it is
the one the contract will enforce.

Missing data is stated, not omitted. Without `OPENSEA_API_KEY` the table says which
stages are not shown and why; silently showing only the public stage is how someone
concludes a drop has no allowlist and misses the only stage they were eligible for.
Three distinct situations stay distinct — no key (fixable), a key that returned
nothing (a fact about the drop), a key whose request failed (transient).

### Shared preparation

`core/prepare.ts` is the single setup path: resolve the target, detect the chain,
plan RPCs, build the mint plan, build the stage table. `prepareRun` returns a
`PreparedRun`; `refreshRun` re-reads it for a live panel. Both renderers call the
same two functions, which is why a fix to target resolution or fee-recipient
selection cannot land in one and miss the other.

### What is legitimately not shared

Only the last step: bytes to a terminal versus HTML to Telegram, ANSI colour versus
`<b>` tags, a padded table versus labelled lines, a readline prompt versus an inline
keyboard. Everything upstream of that — what to read, what it means, what to call
it, what order to show it in — has exactly one implementation.
