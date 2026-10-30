# Telegram File Upload & Share Bot

Upload any Telegram file to the bot and get a unique, unguessable share link. Built for **Railway**.

| Layer | Role |
|---|---|
| **Private Telegram channel** | The only place file contents are stored |
| **Redis** | Metadata + state (tokens, per-user index, counters, rate limits, maintenance flag) |
| **Railway** | Application runtime (bot via long polling + web server in one process) |

Nothing is ever written to the Railway filesystem.

## 1. What it does

- `/start` menu with **Upload File / My Files / Help / Privacy** buttons.
- Accepts documents, ZIP/RAR and other archives, PDFs, images, videos, audio, voice notes, video notes and GIFs.
- Copies the file into the private storage channel, stores metadata in Redis, returns `https://YOUR_DOMAIN/file/<token>`.
- Share page shows name, size, type, upload date and a download button. Opening the link inside Telegram (`t.me/<bot>?start=f_<token>`) makes the bot send the file into the chat.
- `/files`: paginated list (5 per page) with Open / Share / Delete.
- Delete removes the metadata, invalidates the token and (optionally) deletes the channel message.
- Optional expiry, Redis-backed rate limiting, admin tools (`/stats`, `/broadcast`, `/maintenance`, `/delete`).

> **Download size note.** Browser downloads stream through the Telegram Bot API, which only serves files up to **20 MB**. Larger files still upload fine (the bot *copies* them, no download needed) and are delivered through the Telegram deep link, which has no such limit. The share page automatically offers only the Telegram option for files over 20 MB.

## 2. Architecture

```
src/
  index.js            startup, polling loop, graceful shutdown
  config.js           env validation (exits with a clear message on bad config)
  logger.js           structured JSON logs with secret redaction
  lifecycle.js        shutdown flag + sleep helper
  bot/                commands.js, handlers.js, keyboards.js, views.js, index.js
  services/           redis.js, telegram.js, files.js, tokens.js, rateLimit.js, state.js
  web/server.js       Express: /, /health, /health/ready, /file/:token, /file/:token/download
  utils/              format.js, links.js
```

Redis keys: `file:<token>` (hash), `user:<id>:files` (sorted set, newest first), `users` (set), `rl:<scope>:<id>` (rate-limit counters), `state:maintenance`, `stats:downloads`, `lock:sweeper`.

## 3. Create the Telegram bot

1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **token** (`BOT_TOKEN`).
2. Note the username (without `@`) → `BOT_USERNAME` (e.g. `Storage_Drop_Bot`).
3. Get your numeric user ID from [@userinfobot](https://t.me/userinfobot) → `ADMIN_IDS`.

## 4. Private storage channel

1. Create a new **Channel** in Telegram and keep it **Private** (no public username).
2. Add your bot as an **Administrator** with **Post messages** and **Delete messages** permissions.
3. Get the channel ID (looks like `-1001234567890`): forward any channel post to [@userinfobot](https://t.me/userinfobot) / [@RawDataBot](https://t.me/RawDataBot), or open the channel in Telegram Web and take the number from the URL, prefixed with `-100`.
4. Never share an invite link to this channel.

On startup the bot checks the channel and logs an error/warning if it is not an admin, cannot post, cannot delete, or is public.

## 5. Redis

- **Railway:** add the Redis service (Step 4 below). Enable a volume/persistence so metadata survives restarts. If Redis loses data, existing links stop working even though the files are still in the channel.
- **Local:** `docker run -d --name redis -p 6379:6379 redis:7` → `REDIS_URL=redis://localhost:6379`.

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
| `FILE_TTL_SECONDS` | no | `0` (default) = never expire; otherwise lifetime in seconds. |
| `DELETE_FROM_CHANNEL` | no | `true` (default): also delete the channel message on delete/expiry. |
| `MAX_FILE_SIZE_MB` | no | Reject uploads above this size (default 2000, `0` = no limit). |
| `MAX_UPLOADS_PER_MINUTE` | no | Per user (default 10). |
| `MAX_DOWNLOADS_PER_MINUTE` | no | Per user (bot) and per IP (web) (default 30). |
| `MAX_STARTS_PER_MINUTE` | no | `/start` abuse protection (default 10). |
| `MAX_ADMIN_COMMANDS_PER_MINUTE` | no | Per admin (default 20). |
| `MAX_CALLBACKS_PER_MINUTE` | no | Button presses per user (default 60). |
| `TRUST_PROXY_HOPS` | no | Reverse proxies to trust for client IPs (default 1, correct for Railway). |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn`, `error`. |
| `APP_NAME` | no | Display name in messages and web pages (default `Storage Drop`). |

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
2. **Add Redis:** in the project, *New* → *Database* → *Add Redis*.
3. **Set variables** on the bot service (*Variables* tab): `BOT_TOKEN`, `STORAGE_CHANNEL_ID`, `ADMIN_IDS`, `BOT_USERNAME`, and `REDIS_URL` as a reference to the Redis service: `${{Redis.REDIS_URL}}`. Optional ones from the table above as needed.
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

`/stats` (files, users, downloads, Redis status, storage-channel status, uptime) · `/broadcast <text>` · `/maintenance on|off|status` · `/delete <token or link>`. Regular users get "Unknown command". Maintenance mode blocks the bot for non-admins; existing web links keep working.

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| Startup exits with "invalid configuration" | The log lists which variables are wrong (never their values). |
| `storage channel is not usable` | Bot must be an **admin** of the channel with *Post messages*. Check `STORAGE_CHANNEL_ID` has the `-100` prefix. |
| Deleted files stay in channel | Give the bot *Delete messages* permission. |
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
