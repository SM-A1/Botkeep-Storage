import { InlineKeyboard } from 'grammy';
import { config, isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { audit, recentAudit, securityToday } from '../services/audit.js';
import { AUTO_DELETE_PRESETS, FORWARD_LOCK_PRESETS, formatSecs, getPolicy, nextPreset, setPolicy } from '../services/autodelete.js';
import { sendBackupToTelegram, lastBackupInfo } from '../services/backup.js';
import { getFileByRef } from '../services/files.js';
import { limiters } from '../services/rateLimit.js';
import { redisHealth } from '../services/redis.js';
import { closeReport, getReport, listOpenReports, REPORT_ID_RE } from '../services/reports.js';
import { databaseInfo, rebuildIndexes, railwayHostWarning, redisPersistenceInfo } from '../services/schema.js';
import { countShares, revokeAllForFile } from '../services/shares.js';
import { isMaintenance, setMaintenance, totalDownloads } from '../services/state.js';
import { getGlobalStats, getUserStats } from '../services/stats.js';
import { checkStorageChannel } from '../services/telegram.js';
import { getProfile, recentUsers, resolveUserId, userCounts } from '../services/users.js';
import { CATEGORIES, CATEGORY_LABELS } from '../utils/category.js';
import { escapeHtml, formatBytes, formatDuration } from '../utils/format.js';
import { formatDay, formatDayTime } from '../utils/time.js';
import { isRef } from '../utils/ids.js';
import { editOrReply } from './common.js';
import { rateLimitText, htmlOpts } from './views.js';
import { registerAdminCollections } from './adminCollections.js';
import { registerForceSubscribeAdmin } from './forceSubscribe.js';
import { getCollection, getCollectionStats, setLinkStatus } from '../services/collections.js';

const homeKeyboard = () =>
  new InlineKeyboard()
    .text('👥 Users', 'adm:users').text('📁 Files', 'adm:files').row()
    .text('🗂 Collections', 'adm:colls:1').text('🔗 Share Links', 'adm:links').row()
    .text('📊 Storage', 'adm:storage').text('📢 Force Subscribe', 'adm:fs').row()
    .text('🚨 Reports', 'adm:reports:1').text('📋 Logs', 'adm:logs').row()
    .text('⚙️ Settings', 'adm:settings').text('🛡 Security', 'adm:security').row()
    .text('🏠 Menu', 'menu:home');
const backAdmin = () => new InlineKeyboard().text('⬅️ Admin', 'adm:home').text('🏠 Menu', 'menu:home');
const homeText = () => '🛡 <b>Admin Panel</b>\n\nChoose a section.';

export const who = (p) => `${escapeHtml(p.name || 'User')}${p.username ? ` @${escapeHtml(p.username)}` : ''} · <code>${p.id}</code>`;
const val = (r, fallback = 'n/a') => (r.status === 'fulfilled' ? r.value : fallback);

async function usersScreen() {
  const [c, recent] = await Promise.all([userCounts(), recentUsers(8)]);
  const lines = ['👥 <b>Users</b>', '', `Total: <b>${c.total}</b>`, `Active 24h: ${c.day} · 7d: ${c.week} · 30d: ${c.month}`, '', '<b>Newest</b>'];
  if (recent.length === 0) lines.push('—');
  for (const u of recent) lines.push(`${who(u)}\n   📁 ${u.fileCount} · 📦 ${formatBytes(u.storageUsed)} · ${formatDay(u.createdAt)}`);
  lines.push('', '<i>Look up: /user &lt;id or @username&gt;</i>');
  return { text: lines.join('\n'), reply_markup: backAdmin() };
}

async function filesScreen() {
  const g = await getGlobalStats();
  const rows = CATEGORIES.filter((c) => g.byCat[c].count > 0).map((c) => `${CATEGORY_LABELS[c].icon} ${CATEGORY_LABELS[c].label}: ${g.byCat[c].count} (${formatBytes(g.byCat[c].bytes)})`);
  return {
    text: ['📁 <b>Files</b>', '', `Total: <b>${g.files}</b> · ${formatBytes(g.bytes)}`, '', ...rows, '', '<i>Look up: /file #ABC123 · Delete: /delete &lt;id&gt;</i>'].join('\n'),
    reply_markup: backAdmin(),
  };
}

async function linksScreen() {
  const [links, downloads, cs] = await Promise.all([countShares(), totalDownloads(), getCollectionStats()]);
  return { text: ['🔗 <b>Share Links</b>', '', `File links: <b>${links}</b>`, `Collection links: <b>${cs.collections}</b> (manage in 🗂 Collections)`, `Total downloads: <b>${downloads}</b>`, '', '<i>Links are managed by their owners; reports let you revoke abusive ones.</i>'].join('\n'), reply_markup: backAdmin() };
}

async function storageScreen() {
  const [g, health, storage, db, persistence, cs] = await Promise.allSettled([getGlobalStats(), redisHealth(), checkStorageChannel(), databaseInfo(), redisPersistenceInfo(), getCollectionStats()]);
  const coll = val(cs, { collections: 0, files: 0, bytes: 0 });
  const stats = val(g, { files: 0, bytes: 0 });
  const st = val(storage, { ok: false });
  const redisOk = val(health, { ok: false });
  const d = val(db, { schema: 0, dbId: '' });
  const pers = val(persistence, { known: false });
  const railway = railwayHostWarning();
  const lines = [
    '📊 <b>Storage</b>', '',
    `Files: <b>${stats.files}</b> · ${formatBytes(stats.bytes)}`,
    `🗂 Collections: <b>${coll.collections}</b> · ${coll.files} files · ${formatBytes(coll.bytes)}`,
    `💾 Storage channel: ${st.ok ? (st.canPost ? '✅ ready' : '⚠️ cannot post') : '❌ unavailable'}${st.isPublic ? ' ⚠️ PUBLIC' : ''}`,
    `🗄 Database: ${redisOk.ok ? `✅ ${redisOk.latencyMs} ms` : '❌ unavailable'} · schema v${d.schema}`,
    `🆔 DB fingerprint: <code>${escapeHtml(d.dbId)}</code>`,
    `💽 Persistence: ${pers.known ? (pers.aof || pers.rdb ? '✅ enabled' : '❌ none') : 'managed / unknown'}`,
    railway ? '⚠️ Redis is Railway-hosted — data is tied to the Railway project.' : '✅ Redis is not a Railway host',
  ];
  return { text: lines.join('\n'), reply_markup: backAdmin() };
}

async function logsScreen() {
  const events = await recentAudit(15);
  const lines = ['📋 <b>Recent activity</b>', ''];
  if (events.length === 0) lines.push('No events yet.');
  for (const e of events) {
    lines.push(`<code>${formatDayTime(e.time).slice(12, 17)}</code> ${escapeHtml(e.type)} · <code>${e.actorId || '—'}</code>${e.fileRef ? ` · #${e.fileRef}` : ''}${e.detail ? ` · ${escapeHtml(e.detail.slice(0, 40))}` : ''}`);
  }
  return { text: lines.join('\n'), reply_markup: backAdmin() };
}

async function securityScreen() {
  const [today, events] = await Promise.all([securityToday(), recentAudit(8, { types: ['password_failed', 'password_lockout', 'link_denied', 'admin_denied', 'report'] })]);
  const n = (k) => Number(today[k]) || 0;
  const lines = [
    '🛡 <b>Security (today, UTC)</b>', '',
    `❌ Invalid/denied links: ${n('link_denied')}`,
    `🔑 Wrong passwords: ${n('password_failed')} · lockouts: ${n('password_lockout')}`,
    `⏳ Rate-limited: ${n('rate_limited')}`,
    `🚨 Reports: ${n('reports')}`,
    `🚫 Admin attempts denied: ${n('admin_denied')}`,
    '', '<b>Latest security events</b>',
  ];
  if (events.length === 0) lines.push('None');
  for (const e of events) lines.push(`<code>${formatDayTime(e.time).slice(12, 17)}</code> ${escapeHtml(e.type)} · <code>${e.actorId || '—'}</code>`);
  return { text: lines.join('\n'), reply_markup: backAdmin() };
}

async function settingsScreen() {
  const [maint, last, policy] = await Promise.all([isMaintenance(), lastBackupInfo(), getPolicy()]);
  const kb = new InlineKeyboard()
    .text(maint ? '🟢 Turn maintenance OFF' : '🛠 Turn maintenance ON', maint ? 'adm:maint:off' : 'adm:maint:on').row()
    .text(`🗑 Auto-delete: ${formatSecs(policy.autoDelete)}`, 'adm:dl:ad').text(`🔒 Forward lock: ${formatSecs(policy.forwardLock)}`, 'adm:dl:fl').row()
    .text('💾 Backup now', 'adm:backup').text('🔄 Rebuild indexes', 'adm:reindex').row()
    .text('⬅️ Admin', 'adm:home').text('🏠 Menu', 'menu:home');
  const text = [
    '⚙️ <b>Admin Settings</b>', '',
    `🛠 Maintenance: <b>${maint ? 'ON' : 'off'}</b>`,
    `🗑 Auto-delete delivered files: <b>${formatSecs(policy.autoDelete)}</b>`,
    `🔒 Forward lock before forwarding is allowed: <b>${formatSecs(policy.forwardLock)}</b>`,
    `💾 Last backup: ${last ? `${formatDayTime(last.at)} (${formatBytes(last.bytes)})` : 'none yet'}`,
    `⏱ Auto backup: ${config.backup.intervalHours > 0 ? `every ${config.backup.intervalHours}h` : 'disabled'} · ${config.backup.encryptionKey ? '🔒 encrypted' : '⚠️ not encrypted'}`,
    `⌛ Expired files: owner access ${config.expiredOwnerAccess ? 'kept' : 'locked'} · nothing is deleted`,
    `📦 Max file size: ${config.maxFileSizeBytes > 0 ? `${config.maxFileSizeMb} MB` : 'unlimited'}`,
    `⏱ Uptime: ${formatDuration(process.uptime())}`,
  ].join('\n');
  return { text, reply_markup: kb };
}

async function reportsScreen(page) {
  const list = await listOpenReports(page, 5);
  const kb = new InlineKeyboard();
  const lines = ['🚨 <b>Reports</b>', `${list.total} open`, ''];
  if (list.items.length === 0) lines.push('No open reports.');
  list.items.forEach((r, i) => {
    lines.push(`<b>${i + 1}.</b> ${r.collId ? '🗂' : ''}#${r.fileRef || r.shareRef || '—'} · owner <code>${r.ownerId}</code> · reporter <code>${r.reporterId}</code> · ${formatDay(r.createdAt)}`);
    kb.text(`🚫 Revoke ${i + 1}`, `adm:rv:${r.id}`).text(`✅ Dismiss ${i + 1}`, `adm:dm:${r.id}`).row();
  });
  if (list.totalPages > 1) kb.text('⬅️', list.page > 1 ? `adm:reports:${list.page - 1}` : 'noop').text(`${list.page}/${list.totalPages}`, 'noop').text('➡️', list.page < list.totalPages ? `adm:reports:${list.page + 1}` : 'noop').row();
  kb.text('⬅️ Admin', 'adm:home').text('🏠 Menu', 'menu:home');
  lines.push('', '<i>Revoke = disable every link of the file / the collection link (nothing is deleted).</i>');
  return { text: lines.join('\n'), reply_markup: kb };
}

const SCREENS = { users: usersScreen, files: filesScreen, links: linksScreen, storage: storageScreen, logs: logsScreen, security: securityScreen, settings: settingsScreen };

export async function guard(ctx, kind) {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) {
    logger.warn('unauthorized admin access attempt', { userId, kind });
    await audit('admin_denied', { actorId: userId, detail: kind });
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Not available.', show_alert: true }).catch(() => {});
    else await ctx.reply('🤔 <b>Unknown command</b>\n\nUse /help to see what I can do.', htmlOpts());
    return false;
  }
  const rl = await limiters.admin(userId);
  if (!rl.allowed) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: `⏳ ${rl.retryAfter}s`, show_alert: false }).catch(() => {});
    else await ctx.reply(rateLimitText(rl.retryAfter), htmlOpts());
    return false;
  }
  return true;
}

export function registerAdmin(bot) {
  registerAdminCollections(bot);
  registerForceSubscribeAdmin(bot);
  bot.command('admin', async (ctx) => {
    if (!(await guard(ctx, '/admin'))) return;
    await ctx.reply(homeText(), htmlOpts({ reply_markup: homeKeyboard() }));
  });

  bot.callbackQuery('adm:home', async (ctx) => {
    if (!(await guard(ctx, 'home'))) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, homeText(), homeKeyboard());
  });

  for (const [name, render] of Object.entries(SCREENS)) {
    bot.callbackQuery(`adm:${name}`, async (ctx) => {
      if (!(await guard(ctx, name))) return;
      await ctx.answerCallbackQuery();
      const view = await render();
      await editOrReply(ctx, view.text, view.reply_markup);
    });
  }

  bot.callbackQuery(/^adm:reports:(\d{1,3})$/, async (ctx) => {
    if (!(await guard(ctx, 'reports'))) return;
    await ctx.answerCallbackQuery();
    const view = await reportsScreen(Number(ctx.match[1]));
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery(/^adm:(rv|dm):([A-Za-z0-9_-]{12})$/, async (ctx) => {
    if (!(await guard(ctx, 'report-action'))) return;
    const [, action, id] = ctx.match;
    if (!REPORT_ID_RE.test(id)) return;
    const report = await getReport(id);
    if (!report) { await ctx.answerCallbackQuery({ text: 'Report not found.', show_alert: true }); return; }
    if (action === 'rv' && report.collId) {
      // Collection report: disable its public link (data stays; the admin can re-enable it from Collections).
      const collection = await getCollection(report.collId);
      if (collection) await setLinkStatus(collection, 'disabled', 'admin');
      await closeReport(id, 'actioned', ctx.from.id);
      await audit('admin_action', { actorId: ctx.from.id, detail: `report collection #${report.shareRef}: link disabled` });
      await ctx.answerCallbackQuery({ text: '🚫 Collection link disabled' });
    } else if (action === 'rv') {
      const changed = await revokeAllForFile(report.fileId);
      await closeReport(id, 'actioned', ctx.from.id);
      await audit('admin_action', { actorId: ctx.from.id, detail: `report ${report.fileRef}: ${changed} link(s) revoked` });
      await ctx.answerCallbackQuery({ text: `🚫 ${changed} link(s) revoked` });
    } else {
      await closeReport(id, 'dismissed', ctx.from.id);
      await audit('admin_action', { actorId: ctx.from.id, detail: `report ${report.fileRef} dismissed` });
      await ctx.answerCallbackQuery({ text: '✅ Dismissed' });
    }
    const view = await reportsScreen(1);
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery(/^adm:maint:(on|off)$/, async (ctx) => {
    if (!(await guard(ctx, 'maintenance'))) return;
    const on = ctx.match[1] === 'on';
    await setMaintenance(on);
    await audit('admin_action', { actorId: ctx.from.id, detail: `maintenance ${on ? 'on' : 'off'}` });
    await ctx.answerCallbackQuery({ text: on ? '🛠 Maintenance ON' : '🟢 Maintenance OFF' });
    const view = await settingsScreen();
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery(/^adm:dl:(ad|fl)$/, async (ctx) => {
    if (!(await guard(ctx, 'delivery policy'))) return;
    const policy = await getPolicy();
    const isAuto = ctx.match[1] === 'ad';
    const value = isAuto ? nextPreset(AUTO_DELETE_PRESETS, policy.autoDelete) : nextPreset(FORWARD_LOCK_PRESETS, policy.forwardLock);
    await setPolicy(isAuto ? { autoDelete: value } : { forwardLock: value });
    await audit('admin_action', { actorId: ctx.from.id, detail: `${isAuto ? 'auto-delete' : 'forward lock'} ${formatSecs(value)}` });
    await ctx.answerCallbackQuery({ text: `${isAuto ? '🗑 Auto-delete' : '🔒 Forward lock'}: ${formatSecs(value)}` });
    const view = await settingsScreen();
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery('adm:backup', async (ctx) => {
    if (!(await guard(ctx, 'backup'))) return;
    await ctx.answerCallbackQuery({ text: '💾 Creating backup…' });
    try {
      const ok = await sendBackupToTelegram({ reason: `manual (admin ${ctx.from.id})` });
      await audit('admin_action', { actorId: ctx.from.id, detail: `backup ${ok ? 'sent' : 'failed'}` });
      await ctx.reply(ok ? '💾 Backup sent to the backup chat.' : '⚠️ Backup is too large for Telegram. Use <code>npm run backup</code>.', htmlOpts());
    } catch (err) {
      logger.error('manual backup failed', { err });
      await ctx.reply('⚠️ Backup failed. Check the server log.');
    }
  });

  bot.callbackQuery('adm:reindex', async (ctx) => {
    if (!(await guard(ctx, 'reindex'))) return;
    await ctx.answerCallbackQuery({ text: '🔄 Rebuilding indexes…' });
    const r = await rebuildIndexes({ clean: false });
    await audit('admin_action', { actorId: ctx.from.id, detail: `reindex files ${r.files}` });
    await ctx.reply(`🔄 Indexes rebuilt: ${r.files} files, ${r.shares} links, ${r.users} users.`);
  });

  bot.command('user', async (ctx) => {
    if (!(await guard(ctx, '/user'))) return;
    const id = await resolveUserId((ctx.match ?? '').trim());
    const profile = id ? await getProfile(id) : null;
    if (!profile) { await ctx.reply('Usage: <code>/user &lt;id or @username&gt;</code> — user not found.', htmlOpts()); return; }
    const s = await getUserStats(id);
    await ctx.reply(['👤 <b>User</b>', '', who(profile), `Joined: ${formatDay(profile.createdAt)} · last active ${formatDay(profile.lastActive)}`, `📁 ${s.files} files · 📦 ${formatBytes(s.bytes)}`].join('\n'), htmlOpts());
  });

  bot.command('file', async (ctx) => {
    if (!(await guard(ctx, '/file'))) return;
    const ref = (ctx.match ?? '').trim().replace(/^#/, '').toUpperCase();
    const meta = isRef(ref) ? await getFileByRef(ref) : null;
    if (!meta) { await ctx.reply('Usage: <code>/file #ABC123</code> — file not found.', htmlOpts()); return; }
    await ctx.reply(['📄 <b>File</b>', '', escapeHtml(meta.name), `${CATEGORY_LABELS[meta.cat].icon} ${CATEGORY_LABELS[meta.cat].label} · ${formatBytes(meta.size)} · ${formatDay(meta.uploadedAt)}`, `Owner: <code>${meta.uploaderId}</code>`, `Downloads: ${meta.downloads}${meta.hasPassword ? ' · 🔐' : ''}`].join('\n'), htmlOpts({ reply_markup: new InlineKeyboard().text('📂 Open', `open:${meta.id}`) }));
  });
}
