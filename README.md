# File Vault — private Telegram file manager

Store, manage and share files securely from a Telegram bot. Runs on **Railway** as a replaceable runtime.

| Layer | Role | Survives a Railway account/project change? |
|---|---|---|
| **Telegram bot** | User interface | n/a |
| **Railway** | Runtime only (long polling + tiny web server) | replaceable |
| **External Redis** | *Permanent metadata*: users, files, links, passwords (hashes), settings, audit log | **Only if it is NOT Railway's Redis plugin** — see section 14 |
| **Private Telegram channel** | *Permanent file storage* | yes (independent of Railway) |

Nothing is ever written to the Railway filesystem or kept in process memory as the source of truth.

## 1. What it does

- **Dashboard** (`/start`): Upload · My Files · Shared Links · Recent · Search · Storage · Settings · Privacy · Help · Developer (admins also get **Admin Panel**).
- **Upload** documents, archives (ZIP/RAR…), PDFs, Office/text files, photos, videos, audio, voice notes, GIFs. New files are **private**; the card shows name, size, date, 🔐 Private and a short `#REF` (never internal IDs). Buttons: Share · Download · Rename · Move · Password · Expiry · Delete.
- **Share links**: each link is a separate record with its own 192-bit random token, optional **expiry** (1h / 1d / 7d / 30d / custom), optional **download limit** (enforced atomically), and can be **revoked**, edited or deleted. Opening `t.me/<bot>?start=f_<token>` delivers the file into the chat. QR code (PNG + SVG) per link.
- **Password protection** per file (set / change / remove). Stored as a salted **scrypt** hash; the password message is deleted from the chat; attempts are rate limited (default 5 per 15 min per user+file).
- **File expiry** (never / 1h / 1d / 7d / 30d / custom, plus per-user defaults in Settings): expired files stop being shared and are marked expired. **Nothing is deleted** — records stay until the owner deletes them, and the storage-channel copy is never touched (`EXPIRED_OWNER_ACCESS=false` locks owners out until they renew).
- **My Files**: categories (All, Photos, Videos, Audio, Documents, PDFs, Archives), folders, pagination (5 per page, indexed queries — never loads everything).
- **Search**: filename word prefixes plus `type:pdf`, `date:2026-10`, `after:` / `before:`, `#ABC123`; admins can add `owner:<id|@name>`.
- **Storage dashboard**, **Recent files**, **Settings/account** (profile keyed by numeric Telegram ID; username is only an alias).
- **Delete** removes the file permanently from the user's side (record, all links, search index, counters). The copy in the storage channel is **never** deleted.
- **Abuse protection**: rate limits everywhere, generic "File unavailable" for every kind of invalid link, 🚨 Report button on delivered files, admin review.
- **Audit log** (upload, download, link create/revoke/edit/delete, password changes, deletes, start, admin actions, denied access) — no passwords, tokens or secrets.
- **Errors** show only `Reference ID #ABC123`; the real error goes to the private server log.
- **Admin Panel** (`/admin`, numeric `ADMIN_IDS` only): Users · Files · Share Links · Storage · Reports · Logs · Settings (maintenance, backup now, rebuild indexes) · Security. Plus `/stats`, `/broadcast`, `/maintenance`, `/delete`, `/user`, `/file`.
- **Backups**: automatic, optionally encrypted, sent to a private Telegram chat; CLI backup/restore/verify tools.


## 1b. Delivery policy: forward lock + auto-delete (public links)

Files delivered through a **public** share link / collection link follow a policy (owners and admins always get normal, permanent copies):

- **Forward lock** (`FORWARD_LOCK_SECONDS`, default 120): the files are sent with `protect_content` (no forward / save). After this time the locked copies are deleted and **forwardable copies are re-sent** from the storage channel (Telegram cannot unlock a message that was already sent).
- **Auto-delete** (`AUTO_DELETE_SECONDS`, default 600): the delivered messages are deleted from the user's chat this long after delivery. The storage-channel copy is never touched.
- `0` disables either one. Change live with `/autodelete 10m` and `/forwardlock 2m` (admins) or **Admin Panel -> Settings**. Env values are only the defaults.
- Jobs are stored in Redis (`dj:*`, transient, not part of backups) and survive restarts. Single instance only (as before).

## 1c. Botkeep (Main.py)

`Main.py` is a tiny launcher: it runs `npm ci` once and starts `node src/index.js`. It needs Node.js 20+ on the host. A Redis (`REDIS_URL`) and an https `BASE_URL` are still required; see `RAILWAY-VARIABLES.env` for the variable list (the file name is historical, the variables are the same on any host).

## 2. Architecture

```
src/
  index.js            startup (database safety gate), polling loop, graceful shutdown
  config.js           env validation
  bot/                commands, handlers, middleware, files (manager), shares, delivery (public access),
                      text (prompt replies), upload, admin, keyboards, views
  services/           redis, telegram, files, shares, users, search, stats, audit, password, reports,
                      schema (guard + migrations + index rebuild), backup, keys, indexing, rateLimit
  web/server.js       /, /health, /health/ready, /file/:token (redirects to the bot)
  utils/              format, time, category, ids, links, errors
scripts/              backup.js, restore.js, verify.js
tests/                integration tests (real Redis, faked Telegram)
```

Redis keys are documented in `src/services/keys.js`: **authoritative** (backed up: `file:*`, `share:*`, `u:*`, `folders:*`, `hist:*`, `report:*`, `audit`, `users`, `meta:*`, counters) vs **derived** indexes (rebuilt automatically: category/folder timelines, search index, per-user stats, ...).

## 3. Create the Telegram bot

1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **token** (`BOT_TOKEN`).
2. Note the username (without `@`) → `BOT_USERNAME` (e.g. `Storage_Drop_Bot`).
3. Get your numeric user ID from [@userinfobot](https://t.me/userinfobot) → `ADMIN_IDS`.

## 4. Private storage channel

1. Create a new **Channel** in Telegram and keep it **Private** (no public username).
2. Add your bot as an **Administrator** with the **Post messages** permission (Delete messages is not needed).
3. Get the channel ID (looks like `-1001234567890`): forward any channel post to [@userinfobot](https://t.me/userinfobot) / [@RawDataBot](https://t.me/RawDataBot), or open the channel in Telegram Web and take the number from the URL, prefixed with `-100`.
4. Never share an invite link to this channel.

On startup the bot checks the channel and logs an error/warning if it is not an admin, cannot post, cannot delete, or is public.

## 5. Redis (the permanent database)

Redis holds every user, file record, link and setting. **Use an external, persistent Redis** (Upstash, Redis Cloud, a VPS, …) so the data does not depend on your Railway account. Railway's own Redis plugin works but its data lives and dies with the Railway project — the bot warns about it at startup (and refuses to start with `REQUIRE_EXTERNAL_DB=true`). Migration steps: section 14.

- **Local:** `docker run -d --name redis -p 6379:6379 redis:7` → `REDIS_URL=redis://localhost:6379`, plus `ALLOW_EMPTY_DB_INIT=true` for the very first start.

## 6. Local development

```bash
npm install
cp .env.example .env      # fill in values; use BASE_URL=http://localhost:3000 locally
npm run dev               # auto-restart on changes (loads .env)
# or
npm run start:local       # loads .env once
npm start                 # production start (reads real environment variables)
```

Requires Node.js 20+. Run **one** instance per bot token (long polling).

## 7. Environment variables

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | yes | Token from BotFather. Secret. |
| `REDIS_URL` | yes | `redis://` or `rediss://` connection string. Secret. |
| `STORAGE_CHANNEL_ID` | yes | Numeric ID of the private storage channel (`-100…`). |
| `ADMIN_IDS` | yes | Comma-separated **numeric** Telegram user IDs allowed to use admin commands. Usernames are never trusted. |
| `BOT_USERNAME` | yes | Bot username without `@`; used for deep links. |
| `BASE_URL` | yes* | Public `https://` URL of the service, no trailing slash. *Falls back to `RAILWAY_PUBLIC_DOMAIN` if unset. |
| `NODE_ENV` | no | `production` (default). Enforces https for `BASE_URL`. |
| `PORT` | no | Injected by Railway. Defaults to 3000 locally. The server binds to `0.0.0.0`. |
| `FILE_TTL_SECONDS` | no | Default lifetime of NEW uploads in seconds (`0` = never). Users can override it in Settings. |
| `MAX_FILE_SIZE_MB` | no | Reject uploads above this size (default 2000, `0` = no limit). |
| `MAX_UPLOADS_PER_MINUTE` | no | Per user (default 10). |
| `MAX_DOWNLOADS_PER_MINUTE` | no | Per user (bot) and per IP (web) (default 30). |
| `MAX_STARTS_PER_MINUTE` | no | `/start` abuse protection (default 10). |
| `MAX_ADMIN_COMMANDS_PER_MINUTE` | no | Per admin (default 20). |
| `MAX_CALLBACKS_PER_MINUTE` | no | Button presses per user (default 60). |
| `MAX_QR_PER_MINUTE` | no | QR code generations per user (default 5). |
| `TRUST_PROXY_HOPS` | no | Reverse proxies to trust for client IPs (default 1, correct for Railway). |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn`, `error`. |
| `APP_NAME` | no | Display name for web pages (default `Storage Drop`). |
| `DASHBOARD_TITLE` | no | Title on the bot dashboard (default `FILE VAULT`). |
| `DEVELOPER_NAME` / `DEVELOPER_HANDLE` | no | Developer card (default `Sahin` / `Sahin_09022`). |
| `EXPIRED_OWNER_ACCESS` | no | `true` (default): owners keep access to expired files; `false`: locked until renewed. Nothing is ever deleted. |
| `MAX_SEARCH_PER_MINUTE` / `MAX_SHARE_CREATES_PER_MINUTE` / `MAX_TEXT_INPUTS_PER_MINUTE` | no | Defaults 15 / 10 / 40 per user. |
| `MAX_REPORTS_PER_HOUR` | no | Abuse reports per user (default 5). |
| `MAX_PASSWORD_ATTEMPTS` / `PASSWORD_ATTEMPT_WINDOW_MINUTES` | no | Password guesses per user+file per window (default 5 / 15). |
| `FORCE_SUB_SEED` | no | One-time import of required channel(s) into the dynamic Force Subscribe list, e.g. `@TheRoyalZone\|The Royal Zone\|📢 Join The Royal Zone\|https://t.me/TheRoyalZone` (entries separated by `;`, only the first field is required). See section 18. |
| `FORCE_SUB_CACHE_SECONDS` | no | How long a *positive* membership result is reused (default 10, `0` = ask Telegram on every protected interaction). |
| `AUDIT_MAX_EVENTS` | no | Audit stream cap (default 200000). |
| `ALLOW_EMPTY_DB_INIT` | first start only | `true` lets a brand-new installation create its database. **Never needed for an existing database**; without it the bot refuses to start on an empty one. |
| `REQUIRE_EXTERNAL_DB` | no | `true`: refuse to start if `REDIS_URL` is a Railway host. |
| `DB_FINGERPRINT` | recommended | Database ID (shown by `/stats` and `npm run verify`). The bot refuses to start against any other database. |
| `BACKUP_INTERVAL_HOURS` | no | Automatic backups to Telegram (default 24, `0` = off). |
| `BACKUP_CHAT_ID` | no | Private chat/channel receiving backups (default: the storage channel; a separate private channel is better). |
| `BACKUP_ENCRYPTION_KEY` | recommended | ≥16 chars; AES-256-GCM encrypts backups (they contain password hashes and storage references). |

Set any rate limit to `0` to disable it. Never commit a real `.env` (it is git-ignored).

## 8. GitHub deployment

1. Create an empty repository on GitHub (private is fine).
2. Push this project:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Tip: run `npm install` once first and commit the generated `package-lock.json` for reproducible builds.

## 9. Railway deployment

1. **Create a project** → *New Project* → *Deploy from GitHub repo* → pick the repository. Railway detects the `Dockerfile` (`railway.json` also sets `/health` as the health check).
2. **Database:** use an **external** Redis (section 5/14) and set `REDIS_URL` to it. (Railway's Redis plugin works, but it is not independent of Railway.)
3. **Set variables** on the bot service (*Variables* tab): `BOT_TOKEN`, `STORAGE_CHANNEL_ID`, `ADMIN_IDS`, `BOT_USERNAME`, and `REDIS_URL` (your external Redis). Optional ones from the table above as needed.
4. **Deploy.** Watch the logs for `redis connected`, `telegram connected`, `storage channel ready`, `telegram polling started`.
5. **Public domain:** service → *Settings* → *Networking* → *Generate Domain* (or add a custom domain and follow Railway's DNS instructions).
6. **Set `BASE_URL=https://your-domain`** (no trailing slash) and redeploy.
7. **Test:** `/start` → upload a file → open the share link → download → delete from `/files` → reopen the link (should say not found).

Use a single replica. Railway restarts and redeploys are handled: SIGTERM stops polling, drains in-flight downloads, then closes Redis. A short 409 conflict during overlapping deploys is retried automatically.

## 10. Health checks

```bash
curl https://your-domain/health        # {"status":"ok","service":"telegram-file-share-bot"}  (liveness)
curl https://your-domain/health/ready  # also checks Redis; 503 if degraded
```

`/health` deliberately ignores Redis so a Redis blip does not cause restart loops. It never exposes configuration.

## 11. Admin commands

`/admin` (panel) · `/stats` (files, users, downloads, DB fingerprint & schema, Redis/storage status, uptime) · `/broadcast <text>` · `/maintenance on|off|status` · `/delete <id or link>` · `/user <id|@name>` · `/file #REF`. Regular users get "Unknown command" and every attempt is audited. Maintenance mode blocks the bot for non-admins.

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| Startup exits with "invalid configuration" | The log lists which variables are wrong (never their values). |
| `storage channel is not usable` | Bot must be an **admin** of the channel with *Post messages*. Check `STORAGE_CHANNEL_ID` has the `-100` prefix. |
| `409 Conflict` in logs | Another instance is polling with the same token (old deploy, local run). Stop it; the bot retries on its own. |
| Share buttons/links broken | `BASE_URL` wrong or still pointing to localhost. |
| "File unavailable" on download | Telegram error or the channel message was removed by hand. Check logs (`download failed`). |
| Web download says file too large | Telegram Bot API limit is 20 MB for browser downloads; use the "Get it in Telegram" button. |
| Redis errors | Check `REDIS_URL`; on Railway use the reference variable. The client uses `family: 0` for the private network. |

## 13. Security recommendations

- Keep the storage channel **private**; never publish its invite link or ID.
- Rotate `BOT_TOKEN` in BotFather (`/revoke`) if it ever leaks; treat `REDIS_URL` as a secret.
- Anyone with a share link can download the file. Tokens are 192-bit random, but use `FILE_TTL_SECONDS` for sensitive use.
- Keep `ADMIN_IDS` minimal and numeric.
- Enable Redis persistence/backups; metadata is the only index of your files.
- Logs are structured JSON, redact tokens and credentials, and show only the first 6 characters of share tokens.

## 14. Data safety, backups & Railway account migration

### What is (and is not) independent of Railway

| Data | Where it lives | Independent of Railway? |
|---|---|---|
| File contents | Private Telegram channel | ✅ yes |
| Users, profiles, file ownership, share links, expiry, password hashes, settings, history, audit | Redis (`REDIS_URL`) | ✅ only with an **external** Redis. ❌ not with Railway's Redis plugin |
| Code / env vars | GitHub / Railway variables | re-create from your repo and notes |

The bot keeps no local state. A restart or redeploy never loses data as long as Redis keeps it (enable persistence/backups at your Redis provider).

### Safeguards built in

- **Never creates an empty database implicitly.** On an empty database the bot refuses to start (exit code 2) unless `ALLOW_EMPTY_DB_INIT=true` is set (first install only). No code path flushes, resets or overwrites production data.
- **`DB_FINGERPRINT`** locks a deployment to one specific database.
- **Versioned migrations** (`meta:schema`) run under a lock. A migration is additive unless marked destructive; destructive ones need a stored backup **and** `CONFIRM_DESTRUCTIVE_MIGRATION=<version>`. A database from a newer version is refused.
- The v1 → v2 upgrade keeps every existing link working (old tokens become share records) and removes any Redis TTL from file metadata.
- **Backups**: automatic to Telegram (`BACKUP_INTERVAL_HOURS`), on demand (Admin → Settings → Backup now), or CLI: `REDIS_URL=… npm run backup`. Restore only into an **empty** database: `REDIS_URL=<new redis> npm run restore -- <file>` (derived indexes are rebuilt).
- `npm run verify` checks DB connectivity/schema/fingerprint, Railway-hosted Redis, persistence, storage-reference validity, Telegram token/webhook/channel, and (`--deep=5`) that sample stored files are retrievable.

### Moving to a different Railway account/project

See **[RUNBOOK-RAILWAY.md](RUNBOOK-RAILWAY.md)** for the exact, ordered procedure.

## 15. Performance

- Updates are processed **concurrently** (`@grammyjs/runner`); only updates of the *same* user are kept in order. One user's large upload never blocks others.
- Button taps are acknowledged immediately in the background, flood-limited in memory, and lists/cards use as few Redis round trips as possible; audit logging, profile refresh and the maintenance check never block a reply.
- **Biggest remaining factor: distance to Redis.** Every Redis call is a network round trip. Put the external Redis in the **same region** as the Railway service (a Redis 150 ms away makes every button 0.5 s slower, whatever the code does).
- **Idle-latency fix (polling):** the Telegram client timeout (120 s) is deliberately *longer* than the 30 s long-poll, and the runner retries with a constant 2 s delay instead of its default uncapped exponential backoff. Before this, each idle poll was aborted client-side at exactly 30 s, the runner backed off 0.1 s → 0.2 s → 0.4 s → … and the bot answered late after any quiet period. Regression tests: `npm run test:polling` (add `SLOW_TESTS=1` for the 30 s cases).
- **Railway settings that must be right** (code cannot fix these): *Settings → Serverless / App Sleeping = OFF*; exactly **one** replica and no second copy running anywhere else with the same `BOT_TOKEN` (a local `npm run dev` causes 409 conflicts); Redis and the Railway service in the **same region**.
- `VAULT_TEST_REDIS_URL=… npm run bench` measures response time with a simulated slow Redis/Telegram (flushes that database).

## 16. Tests

```bash
VAULT_TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test   # FLUSHES that database — use a throw-away one
```

## 17. File collections — many files, ONE link

Send several files at once (select multiple in Telegram, or an album) and the bot answers with **one** message and **one** link instead of one per file. Also available: `/multi` (or **Upload → Multiple files**) to add files at your own pace and tap **Create link**.

- **Grouping:** files arriving within `UPLOAD_BATCH_QUIET_MS` (default 2.5 s) of each other, the same album, or a manual session form one collection. Every file is stored immediately as a normal private file; the collection only groups them. One file alone behaves exactly as before.
- **Share page:** `https://<BASE_URL>/share/<token>` (192-bit random token) shows title, file count, total size, date and every file with **Preview / Play / Open / Download**, plus **Download All** (streamed ZIP), **Copy Link** and **Share**. Only collection title, file names, sizes and the date are public — never owner details, Telegram ids or storage references.
- **Telegram:** `t.me/<bot>?start=c_<token>` delivers all files into the chat (grouped, not one reply per file).
- **My Collections** (`/collections`, also in Files and Storage): rename, enable/disable link, link expiry, copy/share, Download All, delete (collection only, or collection + files).
- **Admin Panel → 🗂 Collections:** list with owner, file count, size, created/last activity, link state; view files; copy / disable / enable link; delete collection or a single file (all with confirmation). A link disabled by an admin cannot be re-enabled by the owner. Abuse reports can target collections.
- **Limits worth knowing:** the web can only stream files up to **20 MB** (Telegram Bot API); larger files show **Open in Telegram** and are not in the ZIP. Password-protected or expired files are not served through a collection link. `COLLECTION_ZIP_MAX_MB` caps the ZIP.
- **Data:** schema v3 adds `coll:*`, `collf:*`, `cshare:*` (authoritative, backed up) and derived `ucoll:*`, `colls:all`, `collref:*`. The migration is additive; no existing key is touched. Old file links keep working.
- **Needs a public domain** for the web page: set `BASE_URL` (or generate a Railway domain).

## 18. Force Subscribe — required channels managed from the Admin Panel

Users must be a member of **every active mandatory channel** before they can use the bot. Channels are stored in Redis (keys `fsub:ch:<id>` + `fsub:ids`, included in backups), so they survive restarts and redeploys, and **nothing is hard-coded**.

**Admin Panel → 📢 Force Subscribe**: ➕ Add New Channel · 📋 Manage Channels (👁 details, ✏️ edit, 🔛 enable/disable, 🗑 delete with confirmation) · ✏️ Edit Channel · 🗑️ Remove Channel · 🔄 Refresh Channel List.

**Adding a channel** is a guided chat: name → `@username` or `-100…` id → join-button text → invite URL (`https://t.me/<name>`, `https://t.me/+<hash>` or `…/joinchat/<hash>`; every other scheme/host is refused) → optional description → preview → *Confirm & Save*. On confirm the bot resolves the chat with Telegram and checks that it can verify members there; if not, nothing is saved and you are told why. Duplicates are detected by the resolved numeric chat id.

**Requirement:** the bot must be an **administrator** of every required channel (Telegram only lets a bot read a channel's member list as an admin). Private channels: add the bot as admin, use the `-100…` id and a `t.me/+…` invite link.

**How verification works** (`getChatMember` on every active channel, in parallel):
- `member`, `administrator`, `creator` → allowed; `restricted` → allowed only if `is_member = true`; `left`, `kicked`, anything else → denied.
- Any API/network/permission error means access is **not** granted; the user sees which channel could not be verified and the admin sees ⚠️ *Needs attention* on that channel.
- It runs in a middleware before every command, button, upload and text answer, so someone who leaves a channel is blocked again on their next interaction. To save API calls a *positive* result is reused for `FORCE_SUB_CACHE_SECONDS` (default 10 s); set it to `0` for strictly every interaction. The *Verify All Memberships* button always asks Telegram fresh.
- Not gated: `/privacy`, and anyone in `ADMIN_IDS` (admins/owner are never blocked).
- A `/start <link>` opened before joining is remembered; after *Verify* the user gets a **▶️ Continue** button.
- Disabling or deleting a channel takes effect immediately. Enabling is refused while the bot cannot verify members there (that would lock everybody out).

**Migration of an existing channel:** set `FORCE_SUB_SEED=@TheRoyalZone|The Royal Zone|📢 Join The Royal Zone|https://t.me/TheRoyalZone` once. On the next start it is imported **once** (active if the bot is already an admin there, otherwise imported *disabled* with a warning so a rollout can never lock users out). Deleting it later in the panel is permanent. You can remove the variable afterwards.

**Limits / not covered:** public web collection pages (`/share/<token>`) are opened in a browser, where no Telegram identity exists, so they cannot be gated by channel membership. Max 20 channels.

Tests: `VAULT_TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm run test:fsub` (throw-away Redis; it is flushed).

