# CAPABILITY.md

**This file is generated.** Run `npm run docs` to regenerate it; `npm test` fails
if it is out of date. It is generated from `CAPABILITIES` in
`src/core/capabilities.ts` — the same table the scheduler selects from — so it
cannot claim a capability the code does not have.

It exists to be the place where intern says what it cannot do.

## The speed claim

A gated mint (allowlist / GTD / FCFS backed by an OpenSea signature) is slower than a public mint and always will be. The signature is bound to one minter, one quantity and one salt, and OpenSea does not issue it before the stage opens — so one HTTP round trip is inside the race and cannot be moved out of it. intern removes what it can: the nonce, the fees and the TLS handshakes are completed before T-0, leaving request → verify → sign → broadcast. The balance check stays inside the race, because the amount a wallet needs depends on the price the signature carries. A Merkle allow-list is the exception: its proof is computed locally, so that path pre-signs exactly like a public mint and is as fast as one.

Pre-arm work — nonces, warm sockets, a measured clock offset — completes
60 seconds before the stage opens, so the race pays for
none of it. That lead exists only when intern is waiting for a scheduled stage.
Start it against a stage that is already open and there is no lead to use: the
same preparation then happens inside the race, and the run says so rather than
quietly being slower.

## The matrix

The axis is the **mechanism**, not the stage's name. "Allowlist", "GTD" and "FCFS"
are labels a creator chooses; what decides whether intern can fire is which
contract function the stage resolves to and where its authorisation comes from.
The same "Allowlist" label is an offline Merkle proof on one collection and an
OpenSea-held signature on the next, and those two have opposite capabilities.

| Mechanism | Method | Detect window | Precheck eligibility | Pre-sign | Fire unattended | Speed |
| --- | --- | --- | --- | --- | --- | --- |
| Public | `mintPublic()` | yes | yes | yes | yes | pre-signed |
| Allowlist — on-chain Merkle root | `mintAllowList()` | partial | yes | yes | yes | pre-signed |
| Allowlist — signer held locally | `mintSigned()` | partial | yes | yes | yes | pre-signed |
| Allowlist / GTD / FCFS — OpenSea-held signature | `mintSigned()` | partial | partial | no | yes | api-bound |
| Team / reserve | `—` | partial | no | no | no | none |
| Unclassified | `—` | partial | no | no | no | none |

Where a cell says `partial` or `no`, the reason is stated in the section below.
The type system enforces that: a limitation without a cause cannot be written.

## What will not fire

These will not fire, under any configuration:

- **Team / reserve** — Team and reserve stages are minted by the collection's own wallet through OpenSea's interface. If you hold that wallet and the stage is a standard signed stage, it is classified as an OpenSea-signed stage instead and is fireable on that row. intern does not attempt this row.
- **Unclassified** — A stage intern cannot name is a stage it cannot reason about. It is shown in the table so it is never silently dropped, and it is never fired at.

These fire, but only once something is configured:

- **Allowlist / GTD / FCFS — OpenSea-held signature** — Requires OPENSEA_API_KEY and ALLOWLIST_MINTING=1. intern polls for the signature from T-60s and broadcasts the instant one is issued.

## Per mechanism

### Public

**Mechanism:** `public`  
**Contract call:** `mintPublic()`

- **Detect window: yes** — Start, end, price and per-wallet cap are read from the SeaDrop drop struct. No API key, and nobody can hand you different numbers than the contract will enforce.
- **Precheck eligibility: yes** — getMintStats(minter) returns what this wallet has already minted; the cap is on-chain next to it.
- **Pre-sign: yes**
- **Fire unattended: yes**

**Speed (pre-signed):** Signed bytes are on the socket at T-0. Nothing remains between the clock firing and the transaction reaching a mempool except network latency.

### Allowlist — on-chain Merkle root

**Mechanism:** `merkle-allowlist`  
**Contract call:** `mintAllowList()`

- **Detect window: partial** — The window lives inside the signed leaf (MintParams.startTime/endTime), not in a contract getter. It is known exactly once the allowlist data is in hand, and the on-chain root proves that data was not altered.
- **Precheck eligibility: yes** — Provable offline. The leaf is keccak256(abi.encode(minter, mintParams)) and the proof is verified against getAllowListMerkleRoot() on-chain. No third party is asked and the answer cannot change under you.
- **Pre-sign: yes** — Proof and MintParams are fully determined before the stage opens, so the calldata is built and signed during the wait.
- **Fire unattended: yes**

**Speed (pre-signed):** Identical to a public mint. The Merkle proof is part of the calldata and is computed during the wait, not in the race.

### Allowlist — signer held locally

**Mechanism:** `local-signed`  
**Contract call:** `mintSigned()`

- **Detect window: partial** — A signed stage's window is not exposed by any contract getter. It comes from whatever configuration the operator signs against.
- **Precheck eligibility: yes** — The signer key is held locally, so the signature can be produced at will and eligibility is whatever the operator's own list says.
- **Pre-sign: yes** — The signature is produced locally during the wait, so the calldata exists before T-0.
- **Fire unattended: yes**

**Speed (pre-signed):** Pre-signed. No third party is in the firing path.

### Allowlist / GTD / FCFS — OpenSea-held signature

**Mechanism:** `opensea-signed`  
**Contract call:** `mintSigned()`

- **Detect window: partial** — Read from OpenSea's drop configuration, which requires OPENSEA_API_KEY. There is no on-chain record of this stage before it opens, so the window, the stated price and the stated per-wallet cap all come from OpenSea rather than from the contract. Those are the stage's published terms; this wallet's own terms can differ and need the eligibility endpoint.
- **Precheck eligibility: partial** — OpenSea answers this before the stage opens, at /api/v2/drops/{slug}/eligibility, and intern asks during the pre-open lead rather than inferring a verdict from a refusal at T-0. It needs OPENSEA_SCOPED_TOKEN as well as the API key; without one, eligibility stays unknown and the run says so. The token authorises a single wallet, so in a multi-wallet run only that wallet gets an answer — the rest are reported unknown rather than assumed to match.
- **Pre-sign: no** — mintSigned() carries a server signature bound to this minter, this quantity and one salt, and OpenSea does not issue it before the stage opens. The calldata therefore does not exist in advance. This is a property of OpenSea's design and no amount of engineering on this side removes it.
- **Fire unattended: yes** — Requires OPENSEA_API_KEY and ALLOWLIST_MINTING=1. intern polls for the signature from T-60s and broadcasts the instant one is issued.

**Speed (api-bound):** Slower than a public mint, and no engineering changes that. One HTTPS round trip to OpenSea sits inside the race — request, signature, sign, broadcast — where a public mint has already written its bytes. Everything that can be hoisted out of that window is: nonce, fees, balance checks, gas, warm TLS to both OpenSea's origin and the RPC endpoints.

### Team / reserve

**Mechanism:** `team-reserved`  
**Contract call:** none — there is no minter-callable path

- **Detect window: partial** — Visible in OpenSea's drop configuration with an API key; no contract getter exposes it.
- **Precheck eligibility: no** — Eligibility is 'do you hold the team wallet', which cannot be determined from outside the collection.
- **Pre-sign: no** — No calldata path — see fireUnattended.
- **Fire unattended: no** — Team and reserve stages are minted by the collection's own wallet through OpenSea's interface. If you hold that wallet and the stage is a standard signed stage, it is classified as an OpenSea-signed stage instead and is fireable on that row. intern does not attempt this row.

**Speed (none):** Not fireable — see above.

### Unclassified

**Mechanism:** `unknown`  
**Contract call:** none — there is no minter-callable path

- **Detect window: partial** — Whatever OpenSea reported is shown, but intern could not tell what kind of stage it is from its type and label.
- **Precheck eligibility: no** — Unknown mechanism — there is nothing to check against.
- **Pre-sign: no** — Unknown mechanism — no calldata can be built.
- **Fire unattended: no** — A stage intern cannot name is a stage it cannot reason about. It is shown in the table so it is never silently dropped, and it is never fired at.

**Speed (none):** Not fireable — unclassified.


## Non-custodial, forever

This is an architectural boundary, not a policy that could be relaxed later.

intern signs with keys it reads from `.env` on the machine it runs on, and with
nothing else. It has no code path that accepts, stores, proxies or forwards
another party's key material, and there is no "mint for me" mode. A Telegram
message cannot carry a key into this process: the bot's command surface takes a
contract, a quantity and a chain, and the wallet set is fixed at startup by
`walletsFromEnv()`.

Where this is enforced:

- `src/core/wallets.ts` — `walletsFromEnv()` is the only constructor of a
  signing wallet, and it reads `PRIVATE_KEYS` from the process environment.
- `src/bot/session.ts` — the session holds the wallet set it was given at
  construction. No command mutates it.
- `redactKeys()` — every log line and every Telegram message routes through it.
  A private key or mnemonic reaching output is treated as a P0 bug, and the
  redaction is unit-tested against hex keys, bot tokens and BIP-39 seed phrases
  rather than trusted.

The corollary, stated plainly: **whoever controls the machine controls the keys.**
`.env` is plaintext on disk. That is a real exposure, and it is worse than
holding keys in memory only. It is supported because the alternative — retyping
keys before every mint — pushes operators toward worse habits, but it is not
pretended away.

## Operational limits found by running it

These are not deductions from documentation. Each was measured on the box.

**A watchdog kill used to write private keys to disk.** systemd's default
`WatchdogSignal` is `SIGABRT`, which dumps core. On a stock Ubuntu host that dump
goes to apport, which writes the process's raw memory to `/var/crash/` — and this
process holds `PRIVATE_KEYS` in that memory. Verified directly: a sentinel string
held in a variable was recovered from the resulting file. `LimitCORE=0` does **not**
prevent it, because the kernel ignores `RLIMIT_CORE` when `core_pattern` is a pipe,
which it is whenever apport or systemd-coredump is installed. The unit file
therefore sets `WatchdogSignal=SIGKILL`, re-verified as `code=killed, status=9/KILL`
with `/var/crash/` left empty.

**The watchdog is gated on evidence of progress, not on a timer.** A timer-driven
ping proves only that the event loop turns, which is exactly the state a hung
long-poll leaves it in. `isMakingProgress()` requires a completed `getUpdates`
within three poll timeouts before a ping is sent, so a stalled bot is killed and
restarted rather than reported healthy.

**`StartLimitIntervalSec` belongs in `[Unit]`, not `[Service]`.** systemd moved it
in v229 and silently ignores it in the wrong section. It was in the wrong section
here, which meant the default limit of five starts in ten seconds applied: with
`RestartSec=2`, a crash-looping bot would have stopped permanently — the precise
outcome the comment claimed to prevent. Verified after the fix: 11 restarts in 14s.

**Crash recovery is a report, not a resume.** A restarted process no longer holds
the signed bytes, so re-sending is impossible, and re-signing at the same nonce
would compete with a transaction that may already be confirmed. `recoveryReport()`
therefore puts unresolved hashes in front of a human and refuses to act on them.
The run journal is cleared only *after* the report is delivered, so a Telegram
outage cannot be the reason an operator re-mints a wallet that already succeeded.

## The runbook

Five steps. The first four spend nothing, and each one fails on the cheap day
instead of the expensive one. Run them in this order.

### 1. Deploy

```bash
git clone <your-fork> /root/intern/intern   # or unpack it there
cd /root/intern/intern
npm ci
npm run build
npm test                                    # must be green before you trust it
```

Then the configuration. `intern init` writes a `.env` template with every
setting documented and every secret commented out, so copying it changes nothing
until you choose to edit it:

```bash
node dist/cli/index.js init
$EDITOR .env          # PRIVATE_KEYS, RPC_URLS, and nothing else yet
chmod 600 .env        # it is plaintext on disk. See "Non-custodial, forever"
```

For unattended operation, install the unit. `EnvironmentFile` is how the keys
get in — systemd reads `.env` directly, so `PRIVATE_KEYS` never passes through
a command line where `/proc/<pid>/cmdline` would expose it to every user on the
box:

```bash
sudo cp deploy/intern-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now intern-bot
journalctl -u intern-bot -f
```

### 2. Prove the machine before the drop

```bash
node dist/cli/index.js rpc      # ranks your endpoints by measured latency
node dist/cli/index.js clock    # measures your clock against the network
```

Both sign nothing. `rpc` is the single biggest speed factor in a contested
mint and the one most often left on a public endpoint; `clock` matters because
every countdown is corrected against measured offset, and an uncorrected host
clock is how a mint fires late. A drift the CLI reports as a warning, the bot
refuses outright at `CLOCK_DRIFT_LIMIT_MS` — nobody is watching it.

### 3. Read the drop

```bash
node dist/cli/index.js check <target> --chain base
```

Signs nothing. Prints every number intern read and the stage table, including the
eligibility column. Read that column before anything else: it is where a stage
says it cannot be fired and why. A row reading `not fireable:` will not fire, and
no flag in step 5 changes that — see the matrix above for which are conditional
and which are structural.

For a gated stage, set the allow-list first so the column can answer at all. With
no list configured, eligibility is genuinely unknowable — SeaDrop stores only the
root — and the table says so rather than guessing:

```bash
echo 'ALLOWLIST_SOURCE=./allowlist.json' >> .env
node dist/cli/index.js check <target> --chain base
```

intern computes the Merkle root from your list and compares it to the root on the
contract **before** using any proof. A mismatch is reported, never submitted.

If the drop is not configured yet — common, since creators often set the stage
hours before it opens — `intern watch <target>` waits for it to appear and then
reports. It signs nothing, so it is safe to leave running:

```bash
node dist/cli/index.js watch <target> --chain base
```

### 4. Rehearse

```bash
node dist/cli/index.js dryrun <target> --chain base --quantity 1
```

This is the step that is worth the most and is skipped the most often. It
prepares, funds-checks, simulates and **signs** every wallet's transaction, then
stops without broadcasting. It spends nothing.

It exits `1` when a live run would have refused, which is what makes this safe
to write:

```bash
node dist/cli/index.js dryrun <target> -c base -y && \
node dist/cli/index.js mint   <target> -c base -y
```

`DRY_RUN=1` in `.env` does the same thing to every path including the bot, which
is the safer way to rehearse an unattended run: the bot behaves exactly as it will
on the night, and broadcasts nothing.

Set `MAX_PRICE_PER_NFT` before the rehearsal rather than after it. It is the only
ceiling on what a mint may **spend**: the balance check bounds what the wallet can
reach, which is not a limit but a total; the gas settings bound the fee and not the
purchase; and on a gated stage the price arrives inside the same OpenSea response
intern checks it against, so that check proves the response is self-consistent and
nothing about the price being one you agreed to. The value is per NFT and is
multiplied by quantity, so it keeps its meaning when you change `QUANTITY`. A dry
run reports the refusal beside every other one, which is how you find out the
number is wrong on a night when nothing is at stake.

What a dry run does **not** prove: simulation is an `eth_call` against the chain
as it is right now, and a stage that has not opened yet reverts with `NotActive`
whether or not the wallet is eligible. A pre-open dry run cannot tell "not on the
list" from "not open yet". Do not read a pre-open revert as a verdict on your
eligibility.

### 5. Go live

Public stage, fire at the posted time:

```bash
node dist/cli/index.js mint <target> --chain base --quantity 3 \
  --rpc https://base-mainnet.g.alchemy.com/v2/KEY \
  --max-fee 0.08 --at 2026-10-01T15:00:00Z --yes
```

Every loaded key fires unless you say otherwise. `--wallets 0,2` narrows a run to
the wallets named, counting from zero exactly as `W0`/`W1` do in the output; the
selection is echoed back before anything is prepared. Worth knowing before the
first live run rather than after it, because the default on a keyring of six is
six wallets at the same drop.

Gated stage — allowlist, GTD or FCFS. These are **off by default**, so that a
misread drop cannot spend funds at a stage you did not choose to enter. Turning
them on is a deliberate act:

```bash
echo 'ALLOWLIST_MINTING=1' >> .env
node dist/cli/index.js allowlist <target> --chain base --yes
```

Unattended, run the bot — `intern bot` in the foreground to watch it start,
or the systemd unit from step 1 for anything you actually intend to leave alone:

```bash
node dist/cli/index.js bot          # foreground; dies with the SSH session
sudo systemctl start intern-bot     # survives it
```

It does the same work from Telegram: `/check` and `/stages` read, `/mint`
fires, `/status` reports, `/wallets` lists the loaded addresses, and
`/cancel` kills any live mint and any live panel loop. One mint runs at a
time, globally — a second `/mint` is refused while the first holds the lock,
from any chat.

What `/cancel` cannot do is unsend. It stops everything intern controls —
preparation, the wait for the stage to open, the broadcast if it has not left,
and the watching of receipts if it has. It has no effect on a transaction already
in the mempool: that one lands or does not, on its own. Cancel after dispatch and
each affected wallet is reported as `stopped watching (cancelled) — already
broadcast, may still mint`, with an explorer link, precisely so the result is
not mistaken for "nothing was spent". Re-firing those wallets on that assumption
is the one way to pay twice.

Pre-arm work — nonce, fees, balance check, TLS handshakes — completes 60
seconds before the stage opens, so what remains at T-0 is the broadcast and
nothing else. That is the whole of the speed claim, and the section above states
plainly where it does not apply.

### If it dies mid-run

It reports; it does not resume. On restart the run journal is read and you are
told what was in flight, because a transaction that may already be confirmed must
never be re-fired at the same nonce by a process that cannot see the mempool it
left. Deciding what to do with a half-finished run is the operator's call, and
intern does not make it for you.

## The thing that is structurally impossible

An OpenSea-signed stage cannot be pre-signed. mintSigned() carries a server signature bound to this minter, this quantity and one salt, and OpenSea does not issue it before the stage opens. The calldata therefore does not exist in advance. This is a property of OpenSea's design and no amount of engineering on this side removes it.

No amount of engineering on this side removes it. intern's response is to move
every other cost out of the race — nonce, fees, balance, TLS handshake, and the
provider selection are all settled before T-0 — and then to say, in writing, that
the remaining round trip is inside the race and cannot be removed.
