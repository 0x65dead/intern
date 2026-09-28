# VPS patch / deployment guide

The archive is designed to be copied to your existing `intern` checkout. Because this is a public self-hosted repository, keep your existing `.env` and do not overwrite it with the example file.

## 1. Backup the current bot

```bash
cd ~/intern/intern
cp -a . ../intern-backup-$(date +%Y%m%d-%H%M%S)
```

If your checkout is elsewhere, replace the path.

## 2. Copy the patched files

Upload/extract the patched repository over the checkout, **preserving `.env`**.

Example if the archive is `/root/intern-1.1.0-patched.zip`:

```bash
cd ~/intern
mv intern intern-old-$(date +%Y%m%d-%H%M%S)
unzip -q intern-1.1.0-patched.zip
mv intern-main intern
cp intern-old-*/.env intern/.env
cd intern
chmod 600 .env
```

If you have local changes you need to preserve, do not use the move/replace method; use the unified patch instead.

## 3. Preferred: apply the unified patch

From the existing repository root:

```bash
cd ~/intern/intern
cp -a . ../intern-backup-before-1.1.0
patch -p1 < /root/intern-1.1.0.patch
```

If `patch` reports a conflict, stop there and inspect it rather than forcing it.

## 4. Install dependencies

Use the lockfile:

```bash
npm ci
```

The patched project requires Node 20+.

Check:

```bash
node -v
npm -v
```

## 5. Configure OpenSea wallet eligibility

Keep your existing:

```env
OPENSEA_API_KEY=...
```

For each wallet for which you want **pre-open GTD/FCFS/allowlist eligibility**, add its current OpenSea wallet JWT:

```env
OPENSEA_WALLET_JWTS=0xWallet1:JWT1,0xWallet2:JWT2
```

Do not put private keys, seed phrases, PATs, cookies, or Authorization headers in this variable.

The current OpenSea API requires the API key plus a wallet JWT for wallet-scoped eligibility. The JWT needs `read:eligibility`.

JWTs are short-lived. Refresh/replace them according to your OpenSea authentication flow rather than assuming a JWT is permanent.

## 6. Build and test — mandatory gate

Run exactly:

```bash
npm run build && npm test
```

Then:

```bash
npm run typecheck
```

If anything fails, **do not start the live bot yet**. Save the complete output.

## 7. Run a dry test first

Use your existing dry-run mechanism/configuration before spending funds.

For Telegram, start the bot and test:

```text
/start
```

Then verify:

```text
⚡ Tasks
```

and:

```text
🎯 Mint
 → target
 → quantity
 → wallet selection
 → preparation
```

For a drop with wallet JWTs, confirm the stage panel shows per-stage eligibility rather than `unknown (OpenSea-gated)`.

## 8. Test concurrency safely

Use two different wallets.

Create Task A using W1 and Task B using W2.

Open:

```text
⚡ Tasks
```

Both should become `running` rather than one waiting for a global bot lock.

Then create two tasks both using W1. The second should show `queued` until the first releases W1.

This is intentional: it prevents nonce collisions.

## 9. Restart/systemd

After the build/test gate passes:

```bash
sudo cp deploy/intern-bot.service /etc/systemd/system/intern-bot.service
sudo systemctl daemon-reload
sudo systemctl restart intern-bot
sudo systemctl status intern-bot --no-pager
```

Watch logs:

```bash
journalctl -u intern-bot -f
```

Never put a private key in `ExecStart=`, command arguments, or shell history.

## 10. Final checks

```bash
systemctl is-active intern-bot
journalctl -u intern-bot -n 100 --no-pager
```

Then Telegram:

```text
/start
/status
/tasks
/wallets
```

## Rollback

If the new build fails:

```bash
sudo systemctl stop intern-bot
cd ~/intern
rm -rf intern
mv intern-old-YYYYMMDD-HHMMSS intern
cd intern
npm ci
npm run build
sudo systemctl start intern-bot
```

Use the actual backup directory name shown by `ls ~/intern`.
