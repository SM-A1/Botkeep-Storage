# Runbook: moving the bot to a new Railway account/project

**Principle:** Railway = runtime. The database (Redis) and the files (private Telegram channel) must not live inside the old Railway project.
**Never** let the new deployment start against an empty database — the bot refuses to (exit code 2) unless `ALLOW_EMPTY_DB_INIT=true`; do not set it.

## 0. Check where your data lives today

Look at `REDIS_URL` of the old project.

- Host ends with `.railway.internal`, `.rlwy.net` or `.railway.app` → **your database is inside Railway** (the bot also warns about this at startup and in Admin → Storage). Do step 1 before anything else, **while the old project still exists**.
- Host is Upstash / Redis Cloud / your own server → skip to step 3; that database is already independent.

## 1. Take a backup (old project still running)

```bash
# from your computer, with the old project's PUBLIC Redis URL (Railway Redis → Connect → public URL)
export BACKUP_ENCRYPTION_KEY='a long secret passphrase'     # keep it outside Railway
REDIS_URL='redis://default:…@….proxy.rlwy.net:PORT' npm run backup -- vault-backup.ndjson.gz.enc
```

Keep that file somewhere safe. (Automatic backups also arrive in your Telegram backup chat if `BACKUP_INTERVAL_HOURS` is not 0.)

## 2. Create the external Redis and restore into it

1. Create a persistent Redis at an independent provider (persistence/backups ON).
2. Restore into it — the tool refuses a non-empty database:

```bash
REDIS_URL='rediss://default:…@your-external-redis:6379' BACKUP_ENCRYPTION_KEY='…' \
  npm run restore -- vault-backup.ndjson.gz.enc
```

3. The output shows the **database fingerprint**; keep it.

## 3. Prepare the new Railway project (do NOT switch traffic yet)

1. Deploy the same repository (Dockerfile).
2. Set the **same** variables: `BOT_TOKEN`, `STORAGE_CHANNEL_ID`, `ADMIN_IDS`, `BOT_USERNAME`, `BASE_URL`, any limits, and `REDIS_URL` = the **external** Redis. Also set `DB_FINGERPRINT` (from step 2) and `BACKUP_ENCRYPTION_KEY`. Do **not** set `ALLOW_EMPTY_DB_INIT`.
3. The Telegram storage channel stays the same: the bot must still be an admin there (same bot token, or add the new bot as admin if you changed the token — note that file links use `BOT_USERNAME`).

## 4. Verify (new project, traffic still on the old one)

```bash
# run in the new service's shell (or locally with the same variables)
npm run verify -- --deep=5
```

Proceed only on **✅ READY**: database reachable, schema v2, fingerprint matches, persistence on, not Railway-hosted, storage references valid, 5 sampled stored files retrievable. Also open the bot in a private chat and check: an existing user sees old files in **My Files**, an old share link still delivers.

## 5. Switch

1. **Stop the old service** (two instances polling the same bot token fight each other with 409 errors).
2. Start/redeploy the new service; watch for `database ready`, `telegram polling started`.
3. Test: `/start`, upload, share link, password, revoke, search.
4. Keep the old Railway project (and the backup file) for a few days, then delete it.

## Rollback

Nothing in the old database is modified by the move. To roll back: stop the new service, start the old one with its original `REDIS_URL`.

## What can still go wrong (honest limits)

- If the external Redis loses its persistence, all metadata is lost; the files remain in the Telegram channel but can no longer be matched to users/links. Keep backups (automatic + CLI) and use a provider with persistence.
- Backups are only as safe as where you store them and the encryption key you keep.
- The storage channel is on Telegram: if it is deleted or the bot is removed from it, files are gone regardless of Railway.
