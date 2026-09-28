# intern 1.1.0 — sniper/task/eligibility patch

This patch intentionally keeps intern **single-user/self-hosted**. There is no multi-tenant or shared-user database system.

## What changed

### 1. OpenSea pre-T0 wallet eligibility
- Added current OpenSea wallet-scoped eligibility support.
- `GET /api/v2/drops/{slug}/eligibility` is used with `X-API-KEY` plus a wallet JWT carrying `read:eligibility`.
- Each configured wallet can be checked against each non-public stage during preparation.
- GTD / FCFS / allowlist results are surfaced per stage instead of being inferred from a mint probe.
- The old mint-endpoint probe remains as a legacy/final-execution fallback and is now concurrency-limited.

### 2. Concurrent mint tasks
- Added `src/core/tasks.ts`.
- Different wallet sets can execute concurrently.
- Tasks sharing a wallet are queued behind that wallet's lock to protect nonce safety.
- Added task IDs and task status tracking.
- Added Telegram **⚡ Tasks** control panel.
- Added `/tasks`.
- Added wallet selection during mint setup.

### 3. Telegram UI
- Main panel now has Mint, Check, Watch, Stages, Wallets, Status and Tasks.
- Mint flow is now:
  `target → quantity → wallet selection → prepare → confirm → task queue`.
- Task center shows running/queued/completed work and reasons for failures.
- A task completion no longer blindly tears down a newer task in the same chat.

### 4. Security
- No Telegram private-key input was added.
- OpenSea wallet JWTs are configuration secrets, not wallet keys, and are kept in process memory.
- Existing transaction verification remains in place before signing.
- Callback authorization remains enforced.
- Same-wallet concurrent execution is prevented.

### 5. Documentation/tests
- Updated `.env.example` and generated environment template.
- Updated capability documentation for current OpenSea eligibility.
- Added task scheduler tests.
- Updated Telegram panel tests.
- Package version bumped to 1.1.0.

## Required configuration for pre-open GTD/FCFS eligibility

```env
OPENSEA_API_KEY=...
OPENSEA_WALLET_JWTS=0xWallet1:JWT_FOR_WALLET_1,0xWallet2:JWT_FOR_WALLET_2
```

The JWT must be for the matching wallet and include `read:eligibility`.

If JWTs are not configured, the bot deliberately reports eligibility as unknown/unavailable. It does not guess.

## Verification status

TypeScript syntax validation: **PASS**.

Full `npm run build && npm test`: **NOT VERIFIED in this packaging environment** because the dependency installation could not complete; the environment could not reach the npm registry and therefore did not have `ethers` / `@types/node` installed. Do not treat this patch as production-green until the VPS completes the build/test gate.
