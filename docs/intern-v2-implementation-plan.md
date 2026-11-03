# Intern V2 — repository-aware implementation plan

**Branch:** `intern-v2`  
**Baseline:** `main` at `2d7fd1bacf97bbe7832999847413a1e0b2ffd325`  
**Status:** Architecture audit and implementation plan. This commit does not change the live minting path.

## Executive decision

Intern already contains most of the behaviour in the proposed V2 prompt, implemented in a deliberately small dependency footprint. The repository is not a blank Telegraf/viem/Prisma bot: it is a TypeScript CLI and Telegram controller over a shared SeaDrop engine. Replacing that engine with a second implementation would create two sources of truth for eligibility, gas, nonce allocation, stage selection, cancellation, and transaction recovery.

V2 should extend the existing core rather than transplant a generic stack. Keep the current engine, Telegram API client, eligibility model, and pre-broadcast journal. Add durable task/watch definitions and carefully bounded operational features around them.

## What already exists on `main`

| Proposed requirement | Existing implementation | Assessment |
|---|---|---|
| Strict TypeScript / Node 20+ | `tsconfig.json` enables strict mode, `noUncheckedIndexedAccess`, and `noUnusedLocals`; `package.json` requires Node >=20 | Implemented |
| Multi-wallet mint engine | `src/core/engine.ts`, `src/core/allowlist.ts`, `src/core/wallets.ts` | Implemented |
| Separate stage, eligibility, and readiness checks | `src/core/stages.ts`, `src/core/eligibility.ts`, `src/core/prepare.ts`, wallet funding and simulation paths | Implemented across shared core |
| Wallet-specific FCFS/GTD eligibility | `src/core/openseaeligibility.ts`, `src/core/openseaauth.ts`, `src/core/eligibility.ts` | Implemented; scoped credentials and UUID-based stage attribution |
| On-chain Merkle eligibility | `src/core/merkle.ts`, `src/core/seadrop.ts`, `src/core/eligibility.ts` | Implemented |
| Nonce / wallet concurrency safety | `src/core/tasks.ts` and per-wallet locks; nonce reads and prepared transactions in the engine | Implemented in-process |
| Clock correction | `src/core/clock.ts` samples HTTP Date and chain-head time; `src/core/timing.ts` handles T-0 waits | Implemented |
| Gas ceiling and balance preflight | `src/core/wallets.ts`, engine and allowlist preflight | Implemented |
| Simulation before spending | Public and gated mint preparation paths simulate before signing/broadcast | Implemented |
| Transaction crash journal | `src/core/runstate.ts` writes atomically with mode 0600; the locally-derived hash is recorded before broadcast | Implemented |
| Restart handling | `src/bot/index.ts` reports unfinished broadcasts and preserves hashes for manual reconciliation | Implemented conservatively; it intentionally does not blindly re-sign |
| Telegram control panel | `src/bot/api.ts`, `src/bot/panel.ts`, `src/bot/session.ts` | Implemented with inline keyboards, panel edits, pagination patterns, and command flows |
| Telegram access control | Numeric user-id allowlist checked on messages and callback presses | Implemented |
| Polling resilience | Long-poll retry/backoff, rate-limit handling, conflict/invalid-token fatal paths | Implemented |
| Graceful stop | SIGINT/SIGTERM handlers abort polls and active work, then drain | Implemented |
| systemd daemon | `deploy/intern-bot.service` includes restart policy, watchdog, and process hardening | Implemented |
| Structured operational failures | `src/core/failures.ts` classifies retryability and remedies | Implemented |
| Persistent task/watch registry | Task scheduler and chat sessions are in memory; only the in-flight transaction journal is durable | **Gap** |
| Automatic safe task resume | No persisted task descriptor/reconstruction factory exists; restart recovery reports and reconciles transactions instead of recreating jobs | **Gap** |
| Bounded replacement-transaction policy | No explicit user-configurable replacement/bump policy is exposed as part of the documented mint flow | **Gap / future work** |
| Persistent wallet vault | Wallets are loaded locally from the CLI environment; the Telegram bot never accepts keys | Intentionally not implemented |

## Corrections to the generic prompt

1. **Do not use `getMintStats` to decide FCFS eligibility.** It reports mint statistics/supply. It does not prove that a particular wallet is entitled to a particular OpenSea stage. Eligibility must remain wallet-scoped and stage-scoped.
2. **Do not reduce eligibility to a boolean.** The code's `eligible | ineligible | unknown` model matters. Missing credentials, failed requests, ambiguous wallet attribution, and unanswered stage UUIDs are not proof of ineligibility or eligibility.
3. **Do not treat every non-public stage as a normal public SeaDrop drop.** Public stage parameters are read on-chain. OpenSea-signed GTD/FCFS mints require a server response at mint time, and the returned calldata is decoded and validated before a wallet signs it.
4. **Do not move private keys into a database just to satisfy a schema.** Intern currently keeps key material local to the host and refuses keys over Telegram. Adding a database vault introduces another credential, backup, migration, and access-control boundary. A future vault must be an explicit opt-in design with a threat model and audited key lifecycle; it must not be a side effect of V2.
5. **Do not swap ethers for viem or the custom Telegram client for Telegraf as a mechanical refactor.** The current implementation intentionally keeps runtime dependencies to `ethers` and `dotenv`. Any dependency change should be justified by a concrete capability and measured against the current tests and performance.
6. **Do not blindly retry every HTTP operation.** GET/read operations can use bounded retry and backoff. Signature requests and transaction broadcasts need idempotency-aware handling; retrying them indiscriminately can create duplicate or conflicting actions.
7. **Do not auto-bump gas without a hard policy.** Any replacement transaction must use the same sender and nonce, be based on a known pending transaction, check receipt state first, obey the operator's maximum fee ceiling, and have a finite attempt/total-fee budget.

## V2 implementation scope

### V2.1 — Durable task and watch registry

Add a persistent, versioned registry for **non-secret task metadata**. It should record:

- task id and task kind (`MINT` or `WATCH`);
- target, chain identity, selected stage UUID, quantity, and wallet indexes;
- creation/update timestamps and the last known task phase;
- cancellation/pause state and a bounded history of state transitions;
- transaction hashes and broadcast timestamps by wallet, referencing the transaction journal rather than duplicating key material.

Use atomic writes and restrictive filesystem permissions for a local-first implementation. If SQLite is later selected, keep the same repository interface and migrations. No private keys, seed phrases, scoped tokens, or API credentials belong in task records.

### V2.2 — Recovery protocol

Recovery must be explicit and idempotent:

- A watch can be reconstructed and resumed after revalidating its target, stage schedule, chain, and cancellation state.
- A mint task that has not broadcast may be reconstructed only after fresh stage, eligibility, funding, gas, nonce, and simulation checks. It must not inherit stale prepared calldata or stale signatures.
- A wallet with a recorded transaction hash must first look up that exact hash and receipt. It must never construct a second transaction merely because the old process exited.
- A task that crossed the broadcast boundary must remain in reconciliation until each wallet's transaction outcome is known.
- A recovered mint must not bypass the same explicit confirmation and spending limits as a newly prepared mint unless the operator has separately enabled a clearly named unattended policy.

### V2.3 — Multi-wallet control panel

Extend the existing panel rather than create a second bot:

- wallet selection with clear selected/available counts;
- per-wallet stage eligibility and UNKNOWN reasons;
- per-wallet required balance, gas ceiling, and total worst-case spend;
- task/watch pagination and explicit pause/cancel confirmation;
- persistent read-only watchlist with no auto-mint side effect;
- notification routing through the existing allowlist.

Every callback remains subject to the same numeric-user authorization check as a typed command.

### V2.4 — Bounded transaction replacement

Only add replacement handling after tests establish the existing receipt and broadcast semantics. Required policy inputs:

- maximum fee per gas and maximum priority fee;
- maximum bump percentage and maximum number of replacements;
- maximum total fee exposure per wallet;
- confirmation threshold and replacement timeout;
- receipt lookup before every replacement;
- same chain, sender, nonce, destination, calldata, and value unless an explicit operator action changes the intent.

No default policy may silently raise the user's configured fee ceiling.

### V2.5 — Verification and operations

Before release:

- unit tests for registry versioning, atomic persistence, corrupt-file recovery, and concurrent writes;
- restart tests at each boundary: before signing, after signing but before dispatch, after local hash persistence, during multi-endpoint broadcast, and while awaiting receipts;
- eligibility tests for wallet mismatch, missing wallet-scoped token, duplicate stage labels, missing UUIDs, FCFS/GTD overlap, and partial API failures;
- funding tests for stage-specific price, quantity limits, gas ceiling, and per-wallet insufficient balance;
- polling/shutdown tests for timeout, 429, 409 conflict, SIGINT, SIGTERM, and active mint drain;
- production build and test suite on the feature branch, followed by a systemd staging test before deployment.

## Acceptance criteria

V2 is ready only when all of the following hold:

- No second transaction is built for a wallet whose previous broadcast outcome is unknown.
- No wallet is marked eligible based on another wallet's scoped token or another stage's response.
- Unknown eligibility stays unknown and cannot satisfy an arming precondition.
- Gas and mint value are checked per wallet against the full node-required balance.
- Task/watch state survives restart without persisting secret material.
- Recovered work is revalidated against current chain and API state.
- Polling, watcher timers, refresh timers, and task controllers are all stopped or drained on shutdown.
- The existing CLI and Telegram controller continue to use one shared mint engine.

## Repository entry points

- Mint/public execution: `src/core/engine.ts`
- OpenSea-signed mint: `src/core/allowlist.ts`
- Eligibility: `src/core/eligibility.ts`, `src/core/openseaeligibility.ts`, `src/core/openseaauth.ts`
- SeaDrop contract reads: `src/core/seadrop.ts`
- Clock and timing: `src/core/clock.ts`, `src/core/timing.ts`, `src/core/watcher.ts`
- Task scheduling and wallet locks: `src/core/tasks.ts`
- Transaction journal and restart report: `src/core/runstate.ts`
- Telegram API, panel, and session state: `src/bot/api.ts`, `src/bot/panel.ts`, `src/bot/session.ts`, `src/bot/index.ts`
- systemd unit: `deploy/intern-bot.service`

