# intern

A mint sniper for OpenSea SeaDrop, as a CLI and a Telegram bot.

It does one thing carefully: gets a transaction into the first block of a public
drop. Everything that can be computed before the stage opens is computed before
the stage opens, so the instant the mint goes live the only thing left to do is
write bytes to a socket.

```
intern mint https://opensea.io/collection/some-drop
intern bot
```

---

## What it actually does

**Pre-signs everything.** Nonces, gas, calldata and signatures are all resolved
during the wait. At T-0 the process is doing nothing but `write()`. Signing at T-0
costs 1–3ms per wallet, and in a contested mint that is a block.

**Corrects the clock.** Your machine's clock is usually tens to hundreds of
milliseconds off, and it is the clock deciding when to fire. intern measures the
offset against HTTP `Date` headers and against chain-head block timestamps, keeps
the minimum-RTT sample (the same logic NTP uses), and fires on corrected time.
`intern clock` shows you the measurement.

**Waits in three stages.** A coarse `setTimeout` down to two seconds, 50ms hops
re-reading the clock down to 25ms, then a busy spin. A single long `setTimeout`
drifts; a busy spin for ten minutes heats the CPU and drifts too.

**Broadcasts to every endpoint at once.** Fire-and-forget to all of them, body
pre-stringified, transaction hash derived locally so it is known before any reply
arrives. First acceptance wins; the rest are harmless duplicates.

**Uses send-only sequencers.** Base's and Robinhood's sequencer endpoints refuse
reads but are the fastest path to inclusion on their chains. They stay in the
broadcast list and are never read from.

**Ranks endpoints before it needs them.** Each is sampled several times, the median
taken, and the first (TLS-cold) sample dropped. Anything reporting the wrong chain
id is removed entirely — broadcasting a mint to the wrong network is a silent
failure that looks like bad luck.

**Reads the drop from the contract.** SeaDrop v1 (singleton) and v2 (config on the
token) are probed concurrently. A public mint needs no OpenSea API key at all: the
price, the stage window, the per-wallet cap and the fee recipient all come from
contract reads, which also means nobody can hand you different calldata than you
asked for.

---

## Install

```bash
npm install
npm run build
npm link          # optional — puts `intern` on your PATH
```

Node 20 or newer. Two runtime dependencies: `ethers` and `dotenv`. Nothing else,
deliberately — this process holds private keys, and every dependency is a path
into it.

```bash
intern init       # writes a commented .env (mode 0600)
```

---

## Commands

| | |
|---|---|
| `intern` | help |
| `intern mint <target>` | the main event — interactive unless everything is given |
| `intern dryrun <target>` | prepare, check and **sign** everything, then stop without broadcasting. Spends nothing. Exits 1 if a live run would have refused, so `intern dryrun … && intern mint …` is safe to write |
| `intern check <target>` | read the drop and print every number. Signs nothing |
| `intern watch <target>` | wait for a public stage to appear, then report. Signs nothing |
| `intern allowlist <target>` | allowlist/FCFS mint via OpenSea's signature endpoint |
| `intern rpc` | rank your endpoints by measured latency |
| `intern clock` | measure your clock against the network |
| `intern init` | write a `.env` template |
| `intern bot` | run the Telegram bot |

A target is an OpenSea link, a collection slug, or a contract address. Links carry
their chain, so `intern mint https://opensea.io/assets/base/0x…/1` needs no
`--chain`.

### Options

```
-c, --chain <key>         ethereum base robinhood ink arbitrum optimism polygon zora
-q, --quantity <n>        per wallet (default 1)
    --rpc <url|key>       private endpoint, or an Alchemy key. Repeatable
    --max-fee <gwei>      fee ceiling. A maximum, not a payment
    --priority-fee <gwei> tip
    --gas-limit <n>       default 250000
    --at <time>           HH:MM, ISO, unix, or +90s
    --now                 fire immediately
    --lead-ms <n>         fire this many ms early (default 0)
    --watch               wait for the stage to be configured, then mint it
    --dry-run             sign everything, broadcast nothing. Same as `intern dryrun`
    --skip-simulation     no preflight simulation. Faster setup, no revert protection
    --require-simulation  abort if any wallet's dry run reverts
-y, --yes                 non-interactive
    --json                machine-readable output (rpc, clock, check)
```

An unknown flag is an error, not a shrug. `--quantiy 5` quietly minting one token
is exactly the failure that costs a mint.

### Scripted

```bash
intern mint tadaaaaaa --chain base --quantity 3 \
  --rpc https://base-mainnet.g.alchemy.com/v2/KEY \
  --max-fee 0.08 --yes
```

---

## The Telegram bot

```bash
intern bot
```

Needs `TELEGRAM_BOT_TOKEN` from [@BotFather](https://t.me/botfather) and
`TELEGRAM_ALLOWED_IDS`, a comma-separated list of numeric Telegram user ids
([@userinfobot](https://t.me/userinfobot) tells you yours).

**It will not start without an id allowlist.** A bot token is a bearer credential:
anyone who has it can message the bot. Without an allowlist, this process signs
transactions for whoever finds the token — and tokens leak, through screenshots,
shell history and committed `.env` files. Ids, not usernames, because a username
can be changed by whoever holds it.

In a group, both the sender and the group must be listed. Otherwise adding the bot
to a chat would extend spending authority to everyone in it. The same check runs on
every button press, not just on typed commands — a panel left open in a group is
visible to everyone in it, so "who tapped Send" is exactly as open a question as
"who typed /mint".

### The panel

`/start` opens **one** panel message, and that chat keeps it for the rest of the
session. Every action edits that message in place rather than sending a new one, so
the thing you are looking at never gets buried under the history of how you got
there.

```
┌─────────────────────────────────┐
│  intern                         │
│  chain: ethereum   wallets: 3   │
├─────────────────────────────────┤
│  🎯 Mint        🔍 Check        │
│  👀 Watch       📊 Stages       │
│  👛 Wallets     📈 Status       │
│  ❌ Cancel                      │
└─────────────────────────────────┘
```

Every tap is acknowledged the instant it arrives — Telegram spins the button for
about thirty seconds otherwise, and preparing a run takes long enough for that to
look like a bot that has died. A button from an older deployment is rejected with a
visible message rather than silently doing nothing.

**Nothing signs before ✅ Send.** 🎯 Mint walks target → chain → quantity → a
pre-flight panel showing the contract, the chain, the per-wallet and total cost, the
stage being fired at and the wallets involved. Only ✅ Send reaches a key. ❌ Cancel
works from any panel, and aborts a run in flight.

### Live panels

📊 Stages, 🔍 Check and 📈 Status carry `[🔄 Refresh] [⏱ Auto: off]`.

Refresh re-reads everything — stages, supply, gas, balances — and edits the panel in
place, footing it with `updated HH:MM:SS (chain head time)`. Repeat taps inside 3s
are answered with a toast instead of a re-read; no two edits ever land inside one
second, which is Telegram's per-chat limit. ⏱ Auto re-reads every 20s until you
toggle it off, a stage transitions, or a mint starts.

Read-only panels do **not** hold the run lock. You can watch a drop's countdown in
one chat while a mint is prepared in another.

| | |
|---|---|
| `/mint <target>` | prepare a mint, confirm before anything is sent |
| `/check <target>` | read the drop, print the numbers, send nothing |
| `/stages <target>` | every stage, with prices, windows and countdowns |
| `/watch <target>` | wait for a public stage to open |
| `/wallets` | the wallets it signs with |
| `/status` | what this chat is doing |
| `/cancel` | abandon setup, abort a run, or stop a live panel |

The slash commands are a power-user path over the same session and the same state
machine as the buttons — not a second implementation.

**Never send a private key to the bot, and it will never ask.** It signs with the
wallets in its own `.env`, on the machine it runs on. A key pasted into a chat has
already been through Telegram's servers and is stored on every device signed into
that account; deleting the message does not undo either. Use the CLI to enter keys.

Locking is per wallet rather than per bot. A run is refused when it wants a wallet
another run is already signing with, because that is the actual collision: two
transactions at one wallet's nonce, of which the network keeps exactly one. The
refusal names the wallets, so you can see which one is in the way. The bot has no
per-run wallet selection yet, so every run asks for every loaded key and this still
comes to one run at a time — `--wallets 0,2` on the CLI is where a narrower set
exists today.

### Running it as a daemon

The bot is meant to stay up. It holds the long-poll connection open, runs panel
refresh timers, and waits out countdowns that can be hours long — started from an
SSH session it dies with that session, usually right before the drop it was left
running for.

`deploy/intern-bot.service` is a systemd unit for this:

```bash
npm run build
sudo cp deploy/intern-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now intern-bot

systemctl status intern-bot
journalctl -u intern-bot -f
```

Edit `User=`, `WorkingDirectory=` and `EnvironmentFile=` if intern does not live in
`/root/intern/intern`. The unit restarts on any exit and does not give up after the
default five attempts — an RPC provider having a bad ten minutes should not take the
bot down for the night. Genuinely fatal conditions (a bad token, a second instance
polling the same one) exit non-zero and restart-loop visibly in the journal instead
of failing silently.

`EnvironmentFile` is how the keys get in: systemd reads `.env` directly, so
`PRIVATE_KEYS` never passes through a command line where `/proc/<pid>/cmdline` would
expose it to every user on the box. The unit also runs with `ProtectSystem=strict`,
`PrivateTmp`, and no access to other users' home directories.

Startup prints what it loaded and then says so plainly:

```
intern bot online as @your_bot
  wallets: 3 — 0x1234…5678, 0x90ab…cdef, 0xfeed…beef
  allowed: 2 id(s)
  chain:   ethereum
  clock:   +38ms correction

bot is running — leave this process alive (systemd recommended).
See deploy/intern-bot.service. Ctrl+C to stop.
```

---

## Configuration

`intern init` writes a commented `.env`. The essentials:

```ini
CHAIN=base
QUANTITY=1
GAS_LIMIT=250000
LEAD_MS=0

# The single biggest speed factor in a contested mint.
RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# Plaintext on disk. See below.
PRIVATE_KEYS=0xkey1,0xkey2

# Slug lookups and allowlist stages only. Public mints need no key.
OPENSEA_API_KEY=

TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_IDS=123456789
```

Flags beat `.env`. A fee ceiling you set explicitly is honoured exactly, even when
it is below the current base fee — you get a warning, not a silent correction.
Believing you are capped somewhere you are not is worse than a transaction that
doesn't get included.

---

## About your keys

`PRIVATE_KEYS` in `.env` is plaintext on disk. That is a real exposure and it is
worse than the alternative. It is supported because the alternative — retyping keys
before every mint — pushes people toward worse habits, but it is worth naming
rather than burying.

The safer path is the wizard: `intern mint` with no `PRIVATE_KEYS` set prompts for
keys without echoing them, and they stay in process memory, never touching disk.

Either way:

- Use a fresh wallet holding only what the mint costs. Not your main wallet.
- Never a seed phrase. intern accepts 32-byte hex keys only.
- `.env` is written mode 0600. Add it to `.gitignore` before committing anything.
- Key material is stripped from every error message, log line and chat message
  (`redactKeys`), including messages from underlying libraries.

Duplicate keys are dropped: two copies of one key share a nonce, so one of the two
transactions would be discarded by the network with nothing to show for it.

---

## Allowlist and FCFS mints

```bash
intern allowlist <target>   # needs OPENSEA_API_KEY
```

<!-- BEGIN GENERATED: speed-statement -->
> **The speed claim, stated once.** A gated mint (allowlist / GTD / FCFS backed by an OpenSea signature) is slower than a public mint and always will be. The signature is bound to one minter, one quantity and one salt, and OpenSea does not issue it before the stage opens — so one HTTP round trip is inside the race and cannot be moved out of it. intern removes what it can: the nonce, the fees and the TLS handshakes are completed before T-0, leaving request → verify → sign → broadcast. The balance check stays inside the race, because the amount a wallet needs depends on the price the signature carries. A Merkle allow-list is the exception: its proof is computed locally, so that path pre-signs exactly like a public mint and is as fast as one.
>
> This paragraph is generated from `SPEED_STATEMENT` in `src/core/race.ts` and is
> rendered identically in [CAPABILITY.md](CAPABILITY.md). Run `npm run docs` after
> changing it.
<!-- END GENERATED: speed-statement -->

This path is structurally slower than a public mint, and no engineering removes
that. `mintSigned()` requires a signature from OpenSea's server, bound to one
minter, one quantity and one salt, and OpenSea will not issue it before the stage
opens:

```
public:     sign in advance → stage opens → broadcast
allowlist:  stage opens → request signature → verify → sign → broadcast
```

The API round trip is inside the race. Everything that can be moved out of it —
socket warm-up, nonces, fees, balance checks — is.

The other difference is trust. A public mint's calldata is built locally from
contract reads and cannot be tampered with. Here the bytes come from an HTTP
response and are what your key will sign, so every response is decoded and checked
against independently known values before signing: the chain, the target contract,
the collection, the recipient, the quantity, and `value == mintPrice × quantity`.
Anything that does not decode as a known SeaDrop mint is refused outright. An
opaque blob cannot be checked at all, so it is never signed.

---

## Reading the output

Three words that are not synonyms:

- **dispatched** — bytes written to the socket. Says nothing about acceptance.
- **accepted** — an endpoint acknowledged the transaction. It is in a mempool.
- **minted** — a receipt came back with status 1. You own the NFT.

Tools that report "success" at the first of these are reporting that they called
`send`. intern reports all three separately, plus the measured timing error against
the target instant, so a slow mint can be diagnosed instead of guessed at.

---

## Chains

ethereum · base · robinhood · ink · arbitrum · optimism · polygon · zora

Base and Robinhood include their send-only sequencer endpoints in the broadcast
list. Adding a chain is a single entry in `src/core/chains.ts`.

### Auto-detection

An OpenSea link carries its chain and a slug can be looked up. A bare `0x` address
carries nothing — so intern probes `eth_getCode` on every configured chain at once
and uses the one holding the contract. No `--chain` needed:

```bash
intern check 0x1234…                 # probes 8 chains, picks the one with code
```

Three outcomes, and the difference matters:

- **One chain has code** → it wins, silently.
- **Several have code** → you are **asked**. A CREATE2-deployed collection has the
  same address on every chain it was deployed to. The CLI prompts; the bot shows a
  chain picker. Guessing here mints on the wrong network with nothing to show for
  it, so intern never guesses.
- **None have code** → the error lists which chains were probed and which never
  answered, because that is what separates a mistyped address from a collection on
  a chain intern does not support yet.

`--chain <name>` skips detection entirely. Results are cached per address: a
contract's code cannot leave a chain, so a panel refreshing every 20s does not
re-probe eight chains on every tick.

---

## Stage intelligence

`intern check`, `intern stages` and the 📊 Stages panel all print the same table:

```
stage              price      window                       cap  status                       mints left   source
Public             0.01 ETH   Mar 15 12:00 → Mar 15 18:00  3    🟢 live now · ends in 04:12:33  3800 / 5000  on-chain
Allowlist · GTD    —          Mar 15 10:00 → Mar 15 12:00  —    🔴 ended                        —            OpenSea API
FCFS               —          Mar 15 11:00 → Mar 15 12:00  —    🔴 ended                        —            OpenSea API

Time until end:   04:12:33
Mint left: [3800 / 5000]
```

**Every row is labelled with where it came from, and this is not cosmetic.** The
public stage is a contract read — price, window and per-wallet cap come from the
SeaDrop drop struct and cannot be changed under you. Allowlist, FCFS, GTD and team
stages live in OpenSea's drop configuration; on-chain there is only `mintSigned()`,
whose parameters arrive inside a server-signed payload at mint time. Before such a
stage opens there is no on-chain record of its price at all — which is why those
rows show `—` rather than a number. `0 ETH` would be a claim that the mint is free.

Where the two disagree about the public stage — a creator who edited the schedule on
OpenSea without reconfiguring the contract — the on-chain row wins, because that is
the one the contract will enforce.

Without `OPENSEA_API_KEY` the non-public stages cannot be read. They are not
silently omitted; the table says so explicitly:

```
⚠ Allowlist, FCFS, GTD and team stages are not shown: they live in OpenSea's
  drop configuration, not on-chain. Set OPENSEA_API_KEY to read them.
```

Silently showing only the public stage is how someone concludes a drop has no
allowlist and misses the only stage they were eligible for. A key that returns
nothing ("OpenSea lists no additional stages") and a key whose request failed are
also reported as the different things they are.

Status is 🔴 ended / 🟢 live / ⏳ upcoming, with a countdown that says what it is
counting to. All of it reads the clock-corrected time, never the machine's.

---

## Development

```bash
npm run build     # tsc → dist/
npm test          # node:test over the pure logic
npm run dev       # run the CLI from source
```

TypeScript strict, plus `noUncheckedIndexedAccess` and `noUnusedLocals`.

```
src/core/     chains clock seadrop rpc blast timing wallets engine
              opensea target watcher prepare allowlist
              detect stages stagetable
src/cli/      args report wizard index
src/bot/      api format panel refresh session index
src/util/     env render prompt
deploy/       intern-bot.service
```

The engine emits events; the CLI and the bot are two renderers over the same
stream, so they cannot drift apart in what they report. `src/core/prepare.ts` is
the shared setup path for the same reason.

Parity is structural rather than a convention to remember. `src/core/stagetable.ts`
decides which columns exist and what each cell says, and both renderers build from
it — the CLI pads the cells into a box, the bot escapes them into labelled lines
for a phone screen. Neither decides what a column *means*, so `intern check` and
📊 Stages cannot end up disagreeing about a drop. Chain detection sits in
`src/core/detect.ts` and returns a three-way result; the ambiguous case is raised as
`AmbiguousChainError` and each renderer answers it in its own idiom (a numbered
prompt in the CLI, an inline picker in the bot) without the core knowing which one
is attached.

`src/bot/panel.ts` is pure: a view is `(state → text + keyboard)` with no I/O, so the
auto-refresh loop can re-render on a timer with no risk of it also re-fetching or
re-firing something. `src/bot/session.ts` owns the state machine and is the only
place that talks to Telegram.

[`docs/architecture.md`](docs/architecture.md) covers the panel state machine, chain
auto-detection and shared-core parity in detail.

---

## What this cannot do

- **Beat a bot co-located with the sequencer.** Physics. If you are 80ms from the
  sequencer and someone else is 2ms away, they win the tie. intern removes every
  avoidable millisecond on your side of that gap; it cannot move you.
- **Mint a sold-out drop, or one you are not allowlisted for.** It will tell you
  which, from the revert reason, rather than reporting a generic failure.
- **Guarantee inclusion.** A fee ceiling below what the block clears means your
  transaction waits. intern warns when the ceiling looks low against the live base
  fee; it does not raise it behind your back.

---

MIT.
