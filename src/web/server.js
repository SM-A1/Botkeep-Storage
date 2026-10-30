import express from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { redisHealth } from '../services/redis.js';
import { isValidToken } from '../services/tokens.js';
import { lifecycle } from '../lifecycle.js';
import { escapeHtml } from '../utils/format.js';
import { deepLink } from '../utils/links.js';
import { registerShareRoutes } from './share.js';

const APP = escapeHtml(config.appName);

const CSS = `:root{color-scheme:light dark;--bg:#f4f6fb;--card:#fff;--text:#14171f;--muted:#667085;--accent:#2a7fff;--border:#e4e7ee}
@media(prefers-color-scheme:dark){:root{--bg:#0e1118;--card:#171b25;--text:#eef1f7;--muted:#9aa3b5;--accent:#4b94ff;--border:#262c3a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
.icon{font-size:2.2rem}h1{font-size:1.25rem;margin:.2rem 0 1rem;word-break:break-word}dl{margin:0 0 1.4rem}
.row{display:flex;justify-content:space-between;gap:12px;padding:.5rem 0;border-bottom:1px solid var(--border)}
dt{color:var(--muted)}dd{margin:0;text-align:right;word-break:break-word}
.btn{display:block;text-align:center;text-decoration:none;font-weight:600;padding:.85rem 1rem;border-radius:10px;background:var(--accent);color:#fff}
.btn.alt{background:transparent;color:var(--accent);border:1px solid var(--border);margin-top:.6rem}
p{color:var(--muted);margin:.4rem 0 1rem}small{display:block;margin-top:1.2rem;text-align:center;color:var(--muted)}`;

const layout = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} · ${APP}</title><style>${CSS}</style></head>
<body><main class="card">${body}<small>${APP}</small></main></body></html>`;

function sendPage(res, status, title, body) {
  res.status(status).type('html').send(layout(title, body));
}

function sendError(res, status, icon, title, message, extraHeaders = {}) {
  res.set(extraHeaders);
  sendPage(res, status, title, `<div class="icon">${icon}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

function sendStatusError(res, status) {
  if (status === 'expired') return sendError(res, 410, '⌛', 'Link expired', 'This file is no longer available.');
  if (status === 'invalid') return sendError(res, 404, '❌', 'Invalid link', 'This link is not valid. Please check it and try again.');
  return sendError(res, 404, '🔍', 'File not found', 'This file does not exist or has been deleted.');
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    next();
  });

  app.get('/', (req, res) => {
    sendPage(res, 200, 'Status', `<div class="icon">📦</div><h1>${APP} is running</h1><p>Send files to our Telegram bot and share them with a private link.</p><a class="btn" href="https://t.me/${escapeHtml(config.botUsername)}">Open the bot</a>`);
  });

  // Liveness: cheap, never depends on Redis (so a Redis blip does not trigger restarts).
  app.get('/health', (req, res) => {
    if (lifecycle.shuttingDown) return res.status(503).json({ status: 'shutting_down', service: 'telegram-file-share-bot' });
    return res.json({ status: 'ok', service: 'telegram-file-share-bot' });
  });

  // Readiness: also checks Redis.
  app.get('/health/ready', wrap(async (req, res) => {
    const redis = await redisHealth();
    const ok = redis.ok && !lifecycle.shuttingDown;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      service: 'telegram-file-share-bot',
      redis: redis.ok ? 'up' : 'down',
    });
  }));

  // Old web links simply open the bot; all file handling happens inside Telegram.
  app.get('/file/:token', (req, res) => {
    if (!isValidToken(req.params.token)) return sendStatusError(res, 'invalid');
    return res.redirect(302, deepLink(req.params.token));
  });

  registerShareRoutes(app); // /share/:token — public file collection pages

  app.use((req, res) => sendError(res, 404, '🔍', 'Page not found', 'The page you are looking for does not exist.'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('unhandled http error', { path: req.path, err });
    if (res.headersSent) return res.destroy();
    return sendError(res, 500, '⚠️', 'Something went wrong', 'Please try again later.');
  });

  return app;
}

export function startServer() {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      logger.info('http server listening', { port: config.port });
      resolve(server);
    });
    server.keepAliveTimeout = 65_000; // above Railway's proxy idle timeout
    server.headersTimeout = 66_000;
    server.once('error', reject);
  });
}

export function closeServer(server, forceAfterMs = 8_000) {
  return new Promise((resolve) => {
    const force = setTimeout(() => server.closeAllConnections?.(), forceAfterMs);
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}
