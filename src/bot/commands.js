import { isAdmin } from '../config.js';
import { logger, shortToken } from '../logger.js';
import { countFiles, deleteFile } from '../services/files.js';
import { audit } from '../services/audit.js';
import { MAX_AUTO_DELETE, MAX_FORWARD_LOCK, formatSecs, getPolicy, parseSeconds, setPolicy } from '../services/autodelete.js';
import { databaseInfo } from '../services/schema.js';
import { limiters } from '../services/rateLimit.js';
import { redisHealth } from '../services/redis.js';
import { countUsers, iterateUsers, isMaintenance, removeUser, setMaintenance, totalDownloads } from '../services/state.js';
import { bot as botInstance, checkStorageChannel, isBlockedError } from '../services/telegram.js';
import { isValidToken } from '../services/tokens.js';
import { lifecycle, sleep } from '../lifecycle.js';
import { escapeHtml, formatDuration } from '../utils/format.js';
import { mainMenu, uploadKeyboard } from './keyboards.js';
import { deliverShare } from './delivery.js';
import { deliverCollection } from './collections.js';
import { createCollectionReport } from '../services/reports.js';
import { secCount } from '../services/audit.js';
import {
  developerView, helpText, htmlOpts, privacyText, rateLimitText, renderFilesView, renderLinksView, renderRecentView,
  renderSettingsView, renderStorageView, unavailableText, uploadPromptText, welcomeText,
} from './views.js';
import { SEARCH_HELP } from '../services/search.js';
import { searchPromptText } from './views.js';

const BROADCAST_MAX_LENGTH = 3500;
let broadcastRunning = false;

async function startCommand(ctx) {
  const rl = await limiters.starts(ctx.from.id);
  if (!rl.allowed) {
    await ctx.reply(rateLimitText(rl.retryAfter), htmlOpts());
    return;
  }
  const payload = (ctx.match ?? '').trim();
  if (payload) {
    const match = /^f_([A-Za-z0-9_-]{32})$/.exec(payload);
    if (match) return deliverShare(ctx, match[1]);
    // File collections: c_<token> (all files) or c_<token>_<fileRef> (one file); r_<token> reports a collection.
    const coll = /^c_([A-Za-z0-9_-]{32})(?:_([A-HJKMNP-Z2-9]{6}))?$/.exec(payload);
    if (coll) return deliverCollection(ctx, coll[1], coll[2] ?? '');
    const rep = /^r_([A-Za-z0-9_-]{32})$/.exec(payload);
    if (rep) {
      const rl = await limiters.reports(ctx.from.id);
      if (!rl.allowed) { await ctx.reply(rateLimitText(rl.retryAfter), htmlOpts()); return; }
      const res = await createCollectionReport({ reporterId: ctx.from.id, token: rep[1] });
      if (res.result === 'created') {
        await secCount('reports');
        await audit('report', { actorId: ctx.from.id, detail: 'abuse report (collection)' });
      }
      await ctx.reply(res.result === 'not_found' ? unavailableText() : '🚨 <b>Thank you</b>\n\nAn admin will review this collection.', htmlOpts());
      return;
    }
    await ctx.reply('❌ <b>File unavailable</b>\n\nThe link may be expired, revoked, deleted, or invalid.', htmlOpts());
    return;
  }
  await audit('start', { actorId: ctx.from.id });
  await ctx.reply(welcomeText(), htmlOpts({ reply_markup: mainMenu(isAdmin(ctx.from.id)) }));
}

/** Registers an admin-only command: numeric-ID allowlist + rate limit + audit log. */
function adminCommand(bot, name, handler) {
  bot.command(name, async (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) {
      logger.warn('unauthorized admin command attempt', { userId, command: name });
      await ctx.reply('🤔 <b>Unknown command</b>\n\nUse /help to see what I can do.', htmlOpts());
      return;
    }
    const rl = await limiters.admin(userId);
    if (!rl.allowed) {
      await ctx.reply(rateLimitText(rl.retryAfter), htmlOpts());
      return;
    }
    logger.info('admin command', { userId, command: name });
    await handler(ctx);
  });
}

async function runBroadcast(adminChatId, text) {
  let sent = 0;
  let blocked = 0;
  let failed = 0;
  const seen = new Set();
  const message = `📢 <b>Announcement</b>\n\n${escapeHtml(text)}`;

  for await (const userId of iterateUsers()) {
    if (lifecycle.shuttingDown) break;
    if (seen.has(userId)) continue;
    seen.add(userId);
    try {
      await botInstance.api.sendMessage(userId, message, htmlOpts());
      sent += 1;
    } catch (err) {
      if (isBlockedError(err)) {
        blocked += 1;
        await removeUser(userId).catch(() => {});
      } else {
        failed += 1;
        logger.warn('broadcast delivery failed', { userId, err });
      }
    }
    await sleep(50); // ~20 msgs/s, under Telegram's broadcast limits
  }

  logger.info('broadcast finished', { sent, blocked, failed });
  await botInstance.api
    .sendMessage(adminChatId, `📢 <b>Broadcast finished</b>\n\n✅ Delivered: ${sent}\n🚫 Blocked/removed: ${blocked}\n⚠️ Failed: ${failed}`, htmlOpts())
    .catch(() => {});
}

export function registerCommands(bot) {
  bot.command('start', startCommand);
  bot.command('help', (ctx) => ctx.reply(helpText(), htmlOpts({ reply_markup: mainMenu(isAdmin(ctx.from.id)) })));
  bot.command('privacy', (ctx) => ctx.reply(privacyText(), htmlOpts()));
  bot.command('upload', (ctx) => ctx.reply(uploadPromptText(), htmlOpts({ reply_markup: uploadKeyboard() })));
  const showView = (render) => async (ctx) => {
    const view = await render(ctx);
    await ctx.reply(view.text, htmlOpts({ reply_markup: view.reply_markup }));
  };
  bot.command('files', showView((ctx) => renderFilesView(ctx.from.id, 1)));
  bot.command('links', showView((ctx) => renderLinksView(ctx.from.id, 1)));
  bot.command('recent', showView((ctx) => renderRecentView(ctx.from.id)));
  bot.command('storage', showView((ctx) => renderStorageView(ctx.from.id)));
  bot.command('settings', showView((ctx) => renderSettingsView(ctx.from.id)));
  bot.command('developer', showView(() => developerView()));
  bot.command('search', async (ctx) => {
    const { setAwait } = await import('../services/inputState.js');
    await setAwait(ctx.from.id, { kind: 'search' });
    const { cancelKeyboard } = await import('./keyboards.js');
    await ctx.reply(searchPromptText(SEARCH_HELP), htmlOpts({ reply_markup: cancelKeyboard() }));
  });

  adminCommand(bot, 'stats', async (ctx) => {
    const [files, users, downloads, redisState, maintenance, storage, db] = await Promise.allSettled([
      countFiles(), countUsers(), totalDownloads(), redisHealth(), isMaintenance(), checkStorageChannel(), databaseInfo(),
    ]);
    const val = (r, fallback = 'n/a') => (r.status === 'fulfilled' ? r.value : fallback);
    const redisInfo = val(redisState, { ok: false });
    const storageInfo = val(storage, { ok: false });

    let storageLine = '❌ Unavailable';
    if (storageInfo.ok) {
      storageLine = storageInfo.canPost ? '✅ Ready' : '⚠️ Cannot post';
      if (storageInfo.isPublic) storageLine += ' (⚠️ channel is public!)';
    }

    await ctx.reply(
      [
        '📊 <b>Statistics</b>',
        '',
        `📁 <b>Files:</b> ${val(files)}`,
        `👥 <b>Users:</b> ${val(users)}`,
        `📥 <b>Downloads:</b> ${val(downloads)}`,
        `🗄 <b>Redis:</b> ${redisInfo.ok ? `✅ Connected (${redisInfo.latencyMs} ms)` : '❌ Unavailable'}`,
        `💾 <b>Storage channel:</b> ${storageLine}`,
        `🆔 <b>DB fingerprint:</b> <code>${val(db, { dbId: 'n/a' }).dbId || 'n/a'}</code> (schema v${val(db, { schema: '?' }).schema})`,
        `🛠 <b>Maintenance:</b> ${val(maintenance, false) ? 'On' : 'Off'}`,
        `⏱ <b>Uptime:</b> ${formatDuration(process.uptime())}`,
      ].join('\n'),
      htmlOpts(),
    );
  });

  adminCommand(bot, 'broadcast', async (ctx) => {
    const text = (ctx.match ?? '').trim();
    if (!text) {
      await ctx.reply('Usage: <code>/broadcast your message</code>', htmlOpts());
      return;
    }
    if (text.length > BROADCAST_MAX_LENGTH) {
      await ctx.reply(`Message too long (max ${BROADCAST_MAX_LENGTH} characters).`);
      return;
    }
    if (broadcastRunning) {
      await ctx.reply('⏳ A broadcast is already running. Please wait for it to finish.');
      return;
    }
    broadcastRunning = true;
    const total = await countUsers().catch(() => 0);
    logger.info('broadcast started', { adminId: ctx.from.id, recipients: total });
    await ctx.reply(`📢 Broadcast started for about ${total} user${total === 1 ? '' : 's'}. You will get a report when it finishes.`);
    runBroadcast(ctx.chat.id, text)
      .catch((err) => logger.error('broadcast crashed', { err }))
      .finally(() => { broadcastRunning = false; });
  });

  adminCommand(bot, 'maintenance', async (ctx) => {
    const arg = (ctx.match ?? '').trim().toLowerCase();
    if (arg === 'on' || arg === 'off') {
      await setMaintenance(arg === 'on');
      logger.info('maintenance mode changed', { adminId: ctx.from.id, enabled: arg === 'on' });
      await ctx.reply(arg === 'on' ? '🛠 Maintenance mode is now <b>ON</b>. Regular users are blocked.' : '✅ Maintenance mode is now <b>OFF</b>.', htmlOpts());
    } else if (arg === 'status' || arg === '') {
      await ctx.reply(`🛠 Maintenance mode is <b>${(await isMaintenance()) ? 'ON' : 'OFF'}</b>.\n\nUsage: <code>/maintenance on|off</code>`, htmlOpts());
    } else {
      await ctx.reply('Usage: <code>/maintenance on|off|status</code>', htmlOpts());
    }
  });

  for (const [name, field, max, label] of [['autodelete', 'autoDelete', MAX_AUTO_DELETE, '🗑 Auto-delete'], ['forwardlock', 'forwardLock', MAX_FORWARD_LOCK, '🔒 Forward lock']]) {
    adminCommand(bot, name, async (ctx) => {
      const arg = (ctx.match ?? '').trim();
      if (arg) {
        const seconds = parseSeconds(arg);
        if (seconds === null || seconds > max) {
          await ctx.reply(`Usage: <code>/${name} off|30s|2m|10m|1h</code> (max ${formatSecs(max)})`, htmlOpts());
          return;
        }
        await setPolicy({ [field]: seconds });
        await audit('admin_action', { actorId: ctx.from.id, detail: `${name} ${formatSecs(seconds)}` });
      }
      const policy = await getPolicy();
      await ctx.reply(`${label}: <b>${formatSecs(policy[field])}</b>\n\nUsage: <code>/${name} off|30s|2m|10m|1h</code>`, htmlOpts());
    });
  }

  adminCommand(bot, 'delete', async (ctx) => {
    const token = (ctx.match ?? '').trim().split('/').pop();
    if (!isValidToken(token)) {
      await ctx.reply('Usage: <code>/delete &lt;token or share link&gt;</code>', htmlOpts());
      return;
    }
    const outcome = await deleteFile(token, { id: ctx.from.id, isAdmin: true });
    if (outcome.result === 'deleted') {
      await audit('file_delete', { actorId: ctx.from.id, file: outcome.meta, detail: 'by admin' });
      logger.info('admin deleted file', { adminId: ctx.from.id, tokenId: shortToken(token), ownerId: outcome.meta.uploaderId });
      await ctx.reply(`🗑 Deleted <b>${escapeHtml(outcome.meta.name)}</b> for its owner.\nThe storage-channel copy was kept.`, htmlOpts());
    } else {
      await ctx.reply('🔍 File not found.');
    }
  });
}
