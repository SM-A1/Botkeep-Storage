import { InlineKeyboard } from 'grammy';
import { logger } from '../logger.js';
import { audit } from '../services/audit.js';
import {
  deleteCollection, getCShare, getCollection, getCollectionStats, linkState, listAllCollections, loadCollectionFiles, setLinkStatus,
} from '../services/collections.js';
import { deleteFile, getFileByRef } from '../services/files.js';
import { getProfile } from '../services/users.js';
import { CATEGORY_LABELS } from '../utils/category.js';
import { escapeHtml, formatBytes, formatSize, truncate } from '../utils/format.js';
import { collectionLink } from '../utils/links.js';
import { describeExpiry, formatDay, formatDayTime } from '../utils/time.js';
import { isRef } from '../utils/ids.js';
import { editOrReply } from './common.js';
import { STATE_TEXT, mixLine } from './collections.js';
import { guard, who } from './admin.js';

const ID = '([A-Za-z0-9_-]{32})';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function listScreen(page) {
  const [list, stats] = await Promise.all([listAllCollections(page, 5), getCollectionStats()]);
  const lines = ['🗂 <b>Collections</b>', `${plural(stats.collections, 'collection')} · ${plural(stats.files, 'file')} · ${formatBytes(stats.bytes)}`, ''];
  const kb = new InlineKeyboard();
  if (list.items.length === 0) lines.push('No collections yet.');
  const offset = (list.page - 1) * 5;
  list.items.forEach((it, i) => {
    const c = it.collection;
    lines.push(`<b>${offset + i + 1}.</b> 🗂 ${escapeHtml(truncate(c.title, 34))} · #${c.ref}\n      👤 <code>${c.ownerId}</code> · ${plural(c.fileCount, 'file')} · ${formatSize(c.totalSize)}\n      ${STATE_TEXT[it.state]} · ${formatDay(c.createdAt)}`);
    kb.text(String(offset + i + 1), `adm:cd:${c.id}`);
  });
  if (list.items.length) kb.row();
  kb.text('⬅️', list.page > 1 ? `adm:colls:${list.page - 1}` : 'noop').text(`${list.page}/${list.totalPages}`, 'noop').text('➡️', list.page < list.totalPages ? `adm:colls:${list.page + 1}` : 'noop').row()
    .text('⬅️ Admin', 'adm:home').text('🏠 Menu', 'menu:home');
  lines.push('', '<i>Tap a number to inspect a collection.</i>');
  return { text: lines.join('\n'), reply_markup: kb };
}

async function detailScreen(collection, title = '🗂 <b>Collection</b>') {
  const [share, files, owner] = await Promise.all([getCShare(collection.shareToken), loadCollectionFiles(collection), getProfile(collection.ownerId)]);
  const state = linkState(share);
  const lines = [
    title, '', `<b>${escapeHtml(truncate(collection.title, 60))}</b>`,
    `🆔 #${collection.ref} · <code>${collection.id.slice(0, 8)}…</code>`,
    `👤 ${owner ? who(owner) : `<code>${collection.ownerId}</code>`}`,
    `📁 ${plural(files.length, 'file')} · 💾 ${formatBytes(files.reduce((s, f) => s + f.size, 0))}`,
  ];
  const mix = mixLine(files);
  if (mix) lines.push(mix);
  lines.push(
    `📅 Created: ${formatDayTime(collection.createdAt)}`,
    `🕘 Last activity: ${formatDayTime(Math.max(collection.updatedAt, share?.lastAccessAt ?? 0))}`,
    `🔗 Share: ${STATE_TEXT[state]}${share?.status === 'disabled' && share.disabledBy === 'admin' ? ' (by admin)' : ''}`,
    `⏳ Expires: ${describeExpiry(share?.expiresAt ?? 0)}`, `📥 Downloads: ${share?.downloads ?? 0}`,
  );
  const kb = new InlineKeyboard();
  if (state === 'active') kb.add({ text: '📋 Copy link', copy_text: { text: collectionLink(collection.shareToken) } }).url('🔗 Open', collectionLink(collection.shareToken)).row();
  kb.text('📂 Files', `adm:cf:${collection.id}:1`).text(share?.status === 'disabled' ? '✅ Enable link' : '🚫 Disable link', `adm:ct:${collection.id}`).row()
    .text('🗑 Delete collection', `adm:cx:${collection.id}`).row()
    .text('⬅️ Collections', 'adm:colls:1').text('🛡 Admin', 'adm:home');
  return { text: lines.join('\n'), reply_markup: kb };
}

async function filesScreen(collection, page) {
  const all = await loadCollectionFiles(collection);
  const size = 5;
  const totalPages = Math.max(1, Math.ceil(all.length / size));
  const current = Math.min(Math.max(1, page), totalPages);
  const items = all.slice((current - 1) * size, current * size);
  const offset = (current - 1) * size;
  const lines = [`📂 <b>${escapeHtml(truncate(collection.title, 40))}</b>`, `${plural(all.length, 'file')} · Page ${current}/${totalPages}`, ''];
  const kb = new InlineKeyboard();
  items.forEach((f, i) => {
    lines.push(`<b>${offset + i + 1}.</b> ${CATEGORY_LABELS[f.cat]?.icon ?? '📎'} ${escapeHtml(truncate(f.name, 40))}\n      ${formatSize(f.size)} · #${f.ref} · 📥 ${f.downloads}`);
    kb.text(`🗑 ${offset + i + 1}`, `adm:cfd:${collection.id}:${f.ref}`);
  });
  if (items.length) kb.row();
  kb.text('⬅️', current > 1 ? `adm:cf:${collection.id}:${current - 1}` : 'noop').text(`${current}/${totalPages}`, 'noop').text('➡️', current < totalPages ? `adm:cf:${collection.id}:${current + 1}` : 'noop').row()
    .text('⬅️ Back', `adm:cd:${collection.id}`);
  lines.push('', '<i>🗑 deletes that single file (the storage-channel copy is kept).</i>');
  return { text: lines.join('\n'), reply_markup: kb };
}

export function registerAdminCollections(bot) {
  const load = async (ctx, id) => {
    const collection = await getCollection(id);
    if (!collection) {
      await ctx.answerCallbackQuery({ text: 'Collection not found.', show_alert: true }).catch(() => {});
      return null;
    }
    return collection;
  };

  bot.callbackQuery(/^adm:colls:(\d{1,4})$/, async (ctx) => {
    if (!(await guard(ctx, 'collections'))) return;
    await ctx.answerCallbackQuery();
    const view = await listScreen(Number(ctx.match[1]));
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery(new RegExp(`^adm:cd:${ID}$`), async (ctx) => {
    if (!(await guard(ctx, 'collection-view'))) return;
    const collection = await load(ctx, ctx.match[1]);
    if (!collection) return;
    await ctx.answerCallbackQuery();
    const view = await detailScreen(collection);
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  bot.callbackQuery(new RegExp(`^adm:cf:${ID}:(\\d{1,4})$`), async (ctx) => {
    if (!(await guard(ctx, 'collection-files'))) return;
    const collection = await load(ctx, ctx.match[1]);
    if (!collection) return;
    await ctx.answerCallbackQuery();
    const view = await filesScreen(collection, Number(ctx.match[2]));
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  // ---- enable / disable the public link (no data is touched) ----
  bot.callbackQuery(new RegExp(`^adm:ct:${ID}$`), async (ctx) => {
    if (!(await guard(ctx, 'collection-link'))) return;
    const collection = await load(ctx, ctx.match[1]);
    if (!collection) return;
    const share = await getCShare(collection.shareToken);
    const enable = share?.status === 'disabled';
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, enable
      ? `✅ <b>Enable this link?</b>\n\n🗂 ${escapeHtml(collection.title)}\n\nAnyone with the link will be able to open the collection again.`
      : `🚫 <b>Disable this link?</b>\n\n🗂 ${escapeHtml(collection.title)}\n\nThe public page and downloads stop working immediately. The owner cannot re-enable a link disabled by an admin.`,
    new InlineKeyboard().text(enable ? '✅ Yes, enable' : '🚫 Yes, disable', `adm:ctok:${collection.id}:${enable ? 'e' : 'd'}`).text('❌ Cancel', `adm:cd:${collection.id}`));
  });
  bot.callbackQuery(new RegExp(`^adm:ctok:${ID}:(e|d)$`), async (ctx) => {
    if (!(await guard(ctx, 'collection-link-apply'))) return;
    const collection = await load(ctx, ctx.match[1]);
    if (!collection) return;
    const enable = ctx.match[2] === 'e';
    await setLinkStatus(collection, enable ? 'active' : 'disabled', 'admin');
    await audit('admin_action', { actorId: ctx.from.id, detail: `collection #${collection.ref} link ${enable ? 'enabled' : 'disabled'}` });
    await ctx.answerCallbackQuery({ text: enable ? '✅ Link enabled' : '🚫 Link disabled' });
    const view = await detailScreen(collection);
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  // ---- delete the whole collection ----
  bot.callbackQuery(new RegExp(`^adm:cx:${ID}$`), async (ctx) => {
    if (!(await guard(ctx, 'collection-delete'))) return;
    const collection = await load(ctx, ctx.match[1]);
    if (!collection) return;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, [
      '🗑 <b>Delete this collection?</b>', '', `🗂 ${escapeHtml(collection.title)} · ${plural(collection.fileCount, 'file')} · owner <code>${collection.ownerId}</code>`, '',
      '• <b>Collection only</b> — the link dies, the files stay in the owner\'s files',
      '• <b>Collection + files</b> — the files are deleted too (cannot be undone)',
    ].join('\n'), new InlineKeyboard()
      .text('🗑 Collection only', `adm:cxok:${collection.id}:c`).row()
      .text('🗑 Collection + files', `adm:cxok:${collection.id}:f`).row()
      .text('❌ Cancel', `adm:cd:${collection.id}`));
  });
  bot.callbackQuery(new RegExp(`^adm:cxok:${ID}:(c|f)$`), async (ctx) => {
    if (!(await guard(ctx, 'collection-delete-apply'))) return;
    const collection = await load(ctx, ctx.match[1]);
    if (!collection) return;
    const withFiles = ctx.match[2] === 'f';
    const out = await deleteCollection(collection.id, { actorId: ctx.from.id, isAdmin: true, withFiles });
    if (out.result === 'deleted') {
      await audit('admin_action', { actorId: ctx.from.id, detail: `collection #${collection.ref} deleted${withFiles ? ` with ${out.filesDeleted} files` : ''}` });
      logger.info('admin deleted collection', { adminId: ctx.from.id, ownerId: collection.ownerId, withFiles });
    }
    await ctx.answerCallbackQuery({ text: out.result === 'deleted' ? '🗑 Collection deleted' : 'Already deleted' });
    const view = await listScreen(1);
    await editOrReply(ctx, view.text, view.reply_markup);
  });

  // ---- delete one file of a collection ----
  bot.callbackQuery(new RegExp(`^adm:cfd:${ID}:([A-HJKMNP-Z2-9]{6})$`), async (ctx) => {
    if (!(await guard(ctx, 'collection-file-delete'))) return;
    const collection = await load(ctx, ctx.match[1]);
    const file = isRef(ctx.match[2]) ? await getFileByRef(ctx.match[2]) : null;
    if (!collection || !file || file.collectionId !== collection.id) {
      await ctx.answerCallbackQuery({ text: 'File not found in this collection.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, `🗑 <b>Delete this file?</b>\n\n📄 ${escapeHtml(file.name)} · ${formatSize(file.size)}\n🗂 ${escapeHtml(collection.title)}\n\nIt is removed permanently from the owner's files and from the collection. The storage-channel copy is kept.${collection.fileCount <= 1 ? '\n\n⚠️ This is the last file: the collection and its link will be removed too.' : ''}`,
      new InlineKeyboard().text('✅ Yes, delete', `adm:cfdok:${collection.id}:${file.ref}`).text('❌ Cancel', `adm:cf:${collection.id}:1`));
  });
  bot.callbackQuery(new RegExp(`^adm:cfdok:${ID}:([A-HJKMNP-Z2-9]{6})$`), async (ctx) => {
    if (!(await guard(ctx, 'collection-file-delete-apply'))) return;
    const collection = await load(ctx, ctx.match[1]);
    const file = isRef(ctx.match[2]) ? await getFileByRef(ctx.match[2]) : null;
    if (!collection || !file || file.collectionId !== collection.id) {
      await ctx.answerCallbackQuery({ text: 'File not found in this collection.', show_alert: true });
      return;
    }
    const out = await deleteFile(file.id, { id: ctx.from.id, isAdmin: true });
    if (out.result === 'deleted') await audit('file_delete', { actorId: ctx.from.id, file: out.meta, detail: 'by admin (collection)' });
    await ctx.answerCallbackQuery({ text: out.result === 'deleted' ? '🗑 File deleted' : 'Already deleted' });
    const still = await getCollection(collection.id);
    const view = still ? await filesScreen(still, 1) : await listScreen(1);
    await editOrReply(ctx, view.text, view.reply_markup);
  });
}

