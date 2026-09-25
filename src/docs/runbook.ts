// The operator runbook: deploy, rehearse, go live.
//
// Hand-written prose, not a rendered table — the commands are a sequence a person
// performs, and a sequence has an order and a reason for that order, neither of
// which is a property of any single mechanism. What keeps it honest instead is
// tests/runbook.test.ts, which asserts every verb in `KNOWN_COMMANDS` is either
// documented here or explicitly listed as out of scope, so a command cannot be
// added to the CLI and quietly go unmentioned.
//
// The ordering is the point. Every step before "go live" is free: `check`, `rpc`
// and `clock` spend nothing, and `dryrun` signs without broadcasting. An operator
// who runs them in order finds a bad RPC, a skewed clock, an unfunded wallet and
// an allow-list typo on a day that costs nothing, instead of at T-0 on a day that
// costs the mint.

import { PRE_ARM_LEAD_MS } from "../core/race";

/**
 * Verbs the runbook deliberately does not walk through.
 *
 * `help` prints usage and needs no rehearsal, which is the whole of the list.
 * Every other verb is walked through below. Kept as a set rather than dropped so
 * the coverage test can tell "considered and excluded" apart from "forgotten" —
 * the distinction it exists to enforce.
 */
export const RUNBOOK_EXEMPT = new Set(["help"]);

export function renderRunbook(): string {
  const lead = PRE_ARM_LEAD_MS / 1000;

  return `## The runbook

Five steps. The first four spend nothing, and each one fails on the cheap day
instead of the expensive one. Run them in this order.

### 1. Deploy

\`\`\`bash
git clone <your-fork> /root/intern/intern   # or unpack it there
cd /root/intern/intern
npm ci
npm run build
npm test                                    # must be green before you trust it
\`\`\`

Then the configuration. \`intern init\` writes a \`.env\` template with every
setting documented and every secret commented out, so copying it changes nothing
until you choose to edit it:

\`\`\`bash
node dist/cli/index.js init
$EDITOR .env          # PRIVATE_KEYS, RPC_URLS, and nothing else yet
chmod 600 .env        # it is plaintext on disk. See "Non-custodial, forever"
\`\`\`

For unattended operation, install the unit. \`EnvironmentFile\` is how the keys
get in — systemd reads \`.env\` directly, so \`PRIVATE_KEYS\` never passes through
a command line where \`/proc/<pid>/cmdline\` would expose it to every user on the
box:

\`\`\`bash
sudo cp deploy/intern-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now intern-bot
journalctl -u intern-bot -f
\`\`\`

### 2. Prove the machine before the drop

\`\`\`bash
node dist/cli/index.js rpc      # ranks your endpoints by measured latency
node dist/cli/index.js clock    # measures your clock against the network
\`\`\`

Both sign nothing. \`rpc\` is the single biggest speed factor in a contested
mint and the one most often left on a public endpoint; \`clock\` matters because
every countdown is corrected against measured offset, and an uncorrected host
clock is how a mint fires late. A drift the CLI reports as a warning, the bot
refuses outright at \`CLOCK_DRIFT_LIMIT_MS\` — nobody is watching it.

### 3. Read the drop

\`\`\`bash
node dist/cli/index.js check <target> --chain base
\`\`\`

Signs nothing. Prints every number intern read and the stage table, including the
eligibility column. Read that column before anything else: it is where a stage
says it cannot be fired and why. A row reading \`not fireable:\` will not fire, and
no flag in step 5 changes that — see the matrix above for which are conditional
and which are structural.

For a gated stage, set the allow-list first so the column can answer at all. With
no list configured, eligibility is genuinely unknowable — SeaDrop stores only the
root — and the table says so rather than guessing:

\`\`\`bash
echo 'ALLOWLIST_SOURCE=./allowlist.json' >> .env
node dist/cli/index.js check <target> --chain base
\`\`\`

intern computes the Merkle root from your list and compares it to the root on the
contract **before** using any proof. A mismatch is reported, never submitted.

If the drop is not configured yet — common, since creators often set the stage
hours before it opens — \`intern watch <target>\` waits for it to appear and then
reports. It signs nothing, so it is safe to leave running:

\`\`\`bash
node dist/cli/index.js watch <target> --chain base
\`\`\`

### 4. Rehearse

\`\`\`bash
node dist/cli/index.js dryrun <target> --chain base --quantity 1
\`\`\`

This is the step that is worth the most and is skipped the most often. It
prepares, funds-checks, simulates and **signs** every wallet's transaction, then
stops without broadcasting. It spends nothing.

It exits \`1\` when a live run would have refused, which is what makes this safe
to write:

\`\`\`bash
node dist/cli/index.js dryrun <target> -c base -y && \\
node dist/cli/index.js mint   <target> -c base -y
\`\`\`

\`DRY_RUN=1\` in \`.env\` does the same thing to every path including the bot, which
is the safer way to rehearse an unattended run: the bot behaves exactly as it will
on the night, and broadcasts nothing.

What a dry run does **not** prove: simulation is an \`eth_call\` against the chain
as it is right now, and a stage that has not opened yet reverts with \`NotActive\`
whether or not the wallet is eligible. A pre-open dry run cannot tell "not on the
list" from "not open yet". Do not read a pre-open revert as a verdict on your
eligibility.

### 5. Go live

Public stage, fire at the posted time:

\`\`\`bash
node dist/cli/index.js mint <target> --chain base --quantity 3 \\
  --rpc https://base-mainnet.g.alchemy.com/v2/KEY \\
  --max-fee 0.08 --at 2026-10-01T15:00:00Z --yes
\`\`\`

Gated stage — allowlist, GTD or FCFS. These are **off by default**, so that a
misread drop cannot spend funds at a stage you did not choose to enter. Turning
them on is a deliberate act:

\`\`\`bash
echo 'ALLOWLIST_MINTING=1' >> .env
node dist/cli/index.js allowlist <target> --chain base --yes
\`\`\`

Unattended, run the bot — \`intern bot\` in the foreground to watch it start,
or the systemd unit from step 1 for anything you actually intend to leave alone:

\`\`\`bash
node dist/cli/index.js bot          # foreground; dies with the SSH session
sudo systemctl start intern-bot     # survives it
\`\`\`

It does the same work from Telegram: \`/check\` and \`/stages\` read, \`/mint\`
fires, \`/status\` reports, \`/wallets\` lists the loaded addresses, and
\`/cancel\` kills any live mint and any live panel loop. One mint runs at a
time, globally — a second \`/mint\` is refused while the first holds the lock,
from any chat.

What \`/cancel\` cannot do is unsend. It stops everything intern controls —
preparation, the wait for the stage to open, the broadcast if it has not left,
and the watching of receipts if it has. It has no effect on a transaction already
in the mempool: that one lands or does not, on its own. Cancel after dispatch and
each affected wallet is reported as \`stopped watching (cancelled) — already
broadcast, may still mint\`, with an explorer link, precisely so the result is
not mistaken for "nothing was spent". Re-firing those wallets on that assumption
is the one way to pay twice.

Pre-arm work — nonce, fees, balance check, TLS handshakes — completes ${lead}
seconds before the stage opens, so what remains at T-0 is the broadcast and
nothing else. That is the whole of the speed claim, and the section above states
plainly where it does not apply.

### If it dies mid-run

It reports; it does not resume. On restart the run journal is read and you are
told what was in flight, because a transaction that may already be confirmed must
never be re-fired at the same nonce by a process that cannot see the mempool it
left. Deciding what to do with a half-finished run is the operator's call, and
intern does not make it for you.`;
}
