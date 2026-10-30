import { config } from '../config.js';
import { listFiles, listFolders, getFolderName } from '../services/files.js';
import { shareSummaries, fetchShareSets, listFileShares, listUserShares } from '../services/shares.js';
import { getProfile } from '../services/users.js';
import { getUserStats } from '../services/stats.js';
import { countUserCollections } from '../services/collections.js';
import { shareLink } from '../utils/links.js';
import { describeFileType, escapeHtml, formatBytes, formatSize, truncate } from '../utils/format.js';
import { formatDay, formatDayTime, describeExpiry, formatSeconds } from '../utils/time.js';
import { CATEGORIES, CATEGORY_LABELS } from '../utils/category.js';
import { isExpired } from '../services/files.js';
import { shareState } from '../services/shares.js';
import {
  backMenu, developerKeyboard, filesKeyboard, foldersKeyboard, linksKeyboard, mainMenu, recentKeyboard, settingsKeyboard,
} from './keyboards.js';

const APP = escapeHtml(config.appName);

/** Standard options for every HTML-formatted message. */
export const htmlOpts = (extra = {}) => ({
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
  ...extra,
});

// ---------------------------------------------------------------- static screens

export const welcomeText = () =>
  [
    `🔐 <b>${escapeHtml(config.dashboardTitle)}</b>`,
    '<i>Private • Secure • Fast</i>',
    '',
    'Store, manage and share your files securely.',
    '',
    '📤 Send me any file to get started.',
  ].join('\n');

export const uploadPromptText = () =>
  [
    '📤 <b>Upload a file</b>',
    '',
    'Send it to this chat — document, photo, video, audio, voice message, PDF, Office file or archive (ZIP/RAR).',
    config.maxFileSizeBytes > 0 ? `Maximum size: ${config.maxFileSizeMb} MB.` : '',
    '',
    '💡 Send images as <i>File</i> to keep their original quality.',
    '',
    '📦 <b>Many files at once?</b> Select several and send them together — you get ONE link for all of them. Tap <b>Multiple files</b> below to add files at your own pace.',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');

export const helpText = () =>
  [
    '❓ <b>Help</b>',
    '',
    '1️⃣ Send any file — it is stored privately',
    '2️⃣ Tap <b>Share</b> to create a link (expiry, download limit, password)',
    '3️⃣ Manage everything from <b>My Files</b> and <b>Shared Links</b>',
    '4️⃣ Send several files together (or /multi) for ONE link — see <b>My Collections</b> (/collections)',
    '',
    '<b>Commands</b>',
    '/start — dashboard · /files — My Files',
    '/search — find files · /links — shared links',
    '/recent — latest uploads · /storage — usage',
    '/settings — account · /privacy — privacy',
    '',
    '<b>Good to know</b>',
    '• Files are private until you create a link',
    '• Anyone with a valid link (and password, if set) can download',
    '• Revoked or expired links stop working immediately',
  ].join('\n');

export const privacyText = () =>
  [
    '🔐 <b>Privacy &amp; Security</b>',
    '',
    '🔐 Files are private by default.',
    '🔗 Files are only reachable through valid, authorized links.',
    '🗑 Revoked or expired links stop working immediately.',
    '🔑 Password-protected files need the correct password (stored only as a salted hash).',
    '🚫 Internal storage information is never exposed.',
    '',
    '<b>What we keep</b>',
    'File name, type, size, upload time, your numeric Telegram ID, your Telegram name/username, link settings and an access log. Never your phone number or the file contents outside Telegram.',
    '',
    '<b>Deleting</b>',
    'Deleting a file removes it permanently from your account and kills all its links. The stored copy stays in the private storage channel and is not deleted.',
    '<b>Expiry</b>',
    'Expired files stop being shared; their records are kept until you delete them.',
  ].join('\n');

export const developerText = () =>
  ['👨‍💻 <b>Developer</b>', '', `Developer: <b>${escapeHtml(config.developer.name)}</b>`, `Telegram: @${escapeHtml(config.developer.handle)}`].join('\n');

export const maintenanceText = () =>
  '🛠 <b>Under maintenance</b>\n\nThe service is temporarily unavailable. Please try again shortly.';

export const rateLimitText = (retryAfter) =>
  `⏳ <b>Too many requests</b>\n\nPlease wait ${retryAfter} second${retryAfter === 1 ? '' : 's'} and try again.`;

export const errorText = (ref) =>
  `⚠️ <b>Something went wrong.</b>\n\nPlease try again in a moment.\n\nReference ID:\n<code>${escapeHtml(ref)}</code>`;

export const unavailableText = () =>
  '❌ <b>File unavailable</b>\n\nThe link may be expired, revoked, deleted, or invalid.';

export const unsupportedText = () =>
  ['🤔 <b>That content type is not supported</b>', '', 'Please send a document, archive, PDF, image, video, audio file or voice message.'].join('\n');

// ---------------------------------------------------------------- file card

export function shareStatusLine(summary) {
  if (!summary || summary.active === 0) return '🔒 Not shared';
  return `🔗 Shared · ${summary.active} active link${summary.active === 1 ? '' : 's'}`;
}

export function fileCardText(meta, { title = '📄 <b>File</b>', summary = null, folderName = null } = {}) {
  const expired = isExpired(meta);
  const lines = [title, '', `📄 <b>${escapeHtml(truncate(meta.name, 80))}</b>`, `📦 Size: ${formatSize(meta.size)} · ${escapeHtml(describeFileType(meta))}`, `📅 Uploaded: ${formatDay(meta.uploadedAt)}`];
  if (meta.expiresAt > 0) lines.push(`⏳ ${expired ? '⌛ Expired' : 'Expires'}: ${describeExpiry(meta.expiresAt).replace(/^Expired /, '')}`);
  lines.push(`🔐 ${meta.hasPassword ? 'Private · password protected' : 'Private'}`);
  if (summary) lines.push(shareStatusLine(summary));
  if (folderName) lines.push(`📂 Folder: ${escapeHtml(folderName)}`);
  lines.push(`📥 Downloads: ${meta.downloads}`, `🆔 #${meta.ref || '------'}`);
  return lines.join('\n');
}

export async function renderFileCard(meta, opts = {}) {
  const [shares, folderName] = await Promise.all([
    listFileShares(meta.id, meta),
    meta.folder ? getFolderName(meta.uploaderId, meta.folder) : null,
  ]);
  const active = shares.filter((s) => s.state === 'active').length;
  return fileCardText(meta, { ...opts, summary: { active, total: shares.length }, folderName });
}

// ---------------------------------------------------------------- lists

function fileLine(m, n, summary) {
  const exp = isExpired(m) ? ' · ⌛ Expired' : m.expiresAt > 0 ? ` · ⏳ ${formatDay(m.expiresAt)}` : '';
  const share = summary?.get(m.id)?.active ? ' · 🔗 Shared' : '';
  const icon = CATEGORY_LABELS[m.cat]?.icon ?? '📄';
  return `<b>${n}.</b> ${icon} ${escapeHtml(truncate(m.name, 44))}\n      ${formatSize(m.size)} · ${formatDay(m.uploadedAt)}${exp}${share}`;
}

/** listFiles() with the share-link lookup overlapped; pass the result to renderListView. */
export const listFilesWithShares = (userId, opts) => listFiles(userId, { ...opts, prefetch: fetchShareSets });

export async function renderListView(list, { title, ctx, emptyText }) {
  if (list.total === 0) return { text: emptyText, reply_markup: ctx.kind === 'search' ? new (await import('grammy')).InlineKeyboard().text('🔍 New search', 'menu:search').text('🏠 Menu', 'menu:home') : backMenu() };
  const summary = await shareSummaries(list.items, list.extra);
  const offset = (list.page - 1) * config.filesPerPage;
  const text = [
    title,
    `${list.total} file${list.total === 1 ? '' : 's'} · Page ${list.page}/${list.totalPages}`,
    '',
    list.items.map((m, i) => fileLine(m, offset + i + 1, summary)).join('\n\n'),
    '',
    '<i>Tap a number to open a file.</i>',
  ].join('\n');
  return { text, reply_markup: filesKeyboard(list, ctx) };
}

/** My Files (all) or one category. Backwards compatible with the v1 signature (userId, page). */
export async function renderFilesView(userId, page = 1, cat = 'all') {
  const list = await listFilesWithShares(userId, { cat, page });
  const label = cat === 'all' ? '📁 <b>My Files</b>' : `${CATEGORY_LABELS[cat].icon} <b>${CATEGORY_LABELS[cat].label}</b>`;
  const view = await renderListView(list, {
    title: label,
    ctx: cat === 'all' ? { kind: 'all' } : { kind: 'cat', cat },
    emptyText: cat === 'all'
      ? '📭 <b>No files yet</b>\n\nSend me any file and it will show up here.'
      : `${CATEGORY_LABELS[cat].icon} <b>${CATEGORY_LABELS[cat].label}</b>\n\nNothing here yet.`,
  });
  if (list.total === 0 && cat !== 'all') {
    const { InlineKeyboard } = await import('grammy');
    view.reply_markup = new InlineKeyboard().text('📁 All files', 'files:1').text('🏠 Menu', 'menu:home');
  }
  return view;
}

export async function renderFoldersView(userId) {
  const folders = await listFolders(userId);
  if (folders.length === 0) {
    const { InlineKeyboard } = await import('grammy');
    return { text: '📂 <b>Folders</b>\n\nNo folders yet. Open a file and tap <b>Move</b> to create one.', reply_markup: new InlineKeyboard().text('⬅️ Back', 'files:1').text('🏠 Menu', 'menu:home') };
  }
  return { text: '📂 <b>Folders</b>\n\nChoose a folder:', reply_markup: foldersKeyboard(folders) };
}

export async function renderFolderView(userId, folderId, page = 1) {
  const name = await getFolderName(userId, folderId);
  if (!name) return renderFoldersView(userId);
  const list = await listFilesWithShares(userId, { folder: folderId, page });
  return renderListView(list, { title: `📂 <b>${escapeHtml(name)}</b>`, ctx: { kind: 'folder', folder: folderId }, emptyText: `📂 <b>${escapeHtml(name)}</b>\n\nThis folder is empty. Open a file and tap <b>Move</b>.` })
    .then(async (v) => {
      if (list.total === 0) { const { InlineKeyboard } = await import('grammy'); v.reply_markup = new InlineKeyboard().text('📂 Folders', 'fo:list').text('🏠 Menu', 'menu:home'); }
      return v;
    });
}

export async function renderRecentView(userId) {
  const list = await listFilesWithShares(userId, { page: 1, pageSize: 5 });
  if (list.total === 0) return { text: '🕘 <b>Recent Files</b>\n\nNo files yet. Send me a file to start.', reply_markup: backMenu() };
  const summary = await shareSummaries(list.items, list.extra);
  const text = ['🕘 <b>Recent Files</b>', '', list.items.map((m, i) => fileLine(m, i + 1, summary)).join('\n\n'), '', '<i>📂 open · 📥 download · 🔗 share</i>'].join('\n');
  return { text, reply_markup: recentKeyboard(list.items) };
}

// ---------------------------------------------------------------- storage / settings

export async function renderStorageView(userId) {
  const [s, collections] = await Promise.all([getUserStats(userId), countUserCollections(userId)]);
  if (s.files === 0) return { text: '📊 <b>Storage Overview</b>\n\nFiles: 0\nUsed: 0 B', reply_markup: backMenu() };
  const rows = CATEGORIES.filter((c) => s.byCat[c].count > 0).map((c) => `${CATEGORY_LABELS[c].icon} ${CATEGORY_LABELS[c].label}: ${formatBytes(s.byCat[c].bytes)} (${s.byCat[c].count})`);
  const lines = ['📊 <b>Storage Overview</b>', '', `Files: <b>${s.files}</b>`, `Used: <b>${formatBytes(s.bytes)}</b>`];
  if (collections > 0) lines.push(`🗂 Collections: <b>${collections}</b>`);
  return { text: [...lines, '', ...rows].join('\n'), reply_markup: backMenu() };
}

export async function renderSettingsView(userId) {
  const p = await getProfile(userId);
  if (!p) return { text: '⚙️ <b>Settings</b>\n\nProfile not found. Send /start first.', reply_markup: backMenu() };
  const text = [
    '⚙️ <b>Settings</b>',
    '',
    `👤 ${escapeHtml(p.name || 'User')}${p.username ? ` · @${escapeHtml(p.username)}` : ''}`,
    `🆔 Telegram ID: <code>${p.id}</code>`,
    `📅 Joined: ${formatDay(p.createdAt)}`,
    `📁 Files: ${p.fileCount} · 📦 Used: ${formatBytes(p.storageUsed)}`,
    '',
    `⏳ Default file expiry: <b>${p.settings.fileExp ? formatSeconds(p.settings.fileExp) : 'Never'}</b>`,
    `🔗 Default link expiry: <b>${p.settings.shareExp ? formatSeconds(p.settings.shareExp) : 'Never'}</b>`,
    '<i>Defaults apply to new uploads and new links.</i>',
  ].join('\n');
  return { text, reply_markup: settingsKeyboard() };
}

export const developerView = () => ({ text: developerText(), reply_markup: developerKeyboard() });

// ---------------------------------------------------------------- shares

export const STATE_LABEL = {
  active: '🟢 Active', revoked: '🚫 Revoked', expired: '⌛ Expired', limit: '🔢 Limit reached', file_expired: '⌛ File expired', deleted: '🗑 File deleted',
};

const downloadsText = (s) => `${s.downloads}${s.limit > 0 ? `/${s.limit}` : ''}`;

export function shareDetailText(share, file, state, { title = '🔗 <b>Share Link</b>' } = {}) {
  const lines = [title, '', `File: ${file ? escapeHtml(truncate(file.name, 60)) : '—'}`];
  lines.push(`Status: ${STATE_LABEL[state]}`);
  lines.push(`Created: ${formatDay(share.createdAt)}`);
  lines.push(`Expires: ${describeExpiry(share.expiresAt)}`);
  lines.push(`Downloads: ${downloadsText(share)}${share.limit > 0 ? '' : ' (no limit)'}`);
  if (file?.hasPassword) lines.push('🔐 Password protected');
  if (state === 'active') lines.push('', shareLink(share.token));
  lines.push('', `<i>Link ID #${share.ref || '------'}</i>`);
  return lines.join('\n');
}

export function shareCreatedText(share, file) {
  const lines = ['🔗 <b>Share Link Created</b>', '', `File: ${escapeHtml(truncate(file.name, 60))}`, `Expires: ${share.expiresAt ? describeExpiry(share.expiresAt) : 'Never'}`, `Downloads: ${share.limit > 0 ? share.limit : 'Unlimited'}`];
  if (file.hasPassword) lines.push('🔐 Password protected');
  lines.push('', shareLink(share.token));
  return lines.join('\n');
}

export async function renderShareMenu(file) {
  const entries = await listFileShares(file.id, file);
  const lines = ['🔗 <b>Share</b>', '', `📄 ${escapeHtml(truncate(file.name, 60))}`, ''];
  if (entries.length === 0) lines.push('No links yet. Create one to share this file.');
  else {
    entries.slice(0, 5).forEach((e, i) => lines.push(`<b>${i + 1}.</b> ${STATE_LABEL[e.state]} · ⏳ ${e.share.expiresAt ? formatDay(e.share.expiresAt) : 'Never'} · 📥 ${downloadsText(e.share)}`));
    if (entries.length > 5) lines.push(`… and ${entries.length - 5} more in Shared Links`);
    lines.push('', '<i>Tap a number to manage a link.</i>');
  }
  return { text: lines.join('\n'), entries };
}

export async function renderLinksView(userId, page = 1) {
  const list = await listUserShares(userId, page);
  if (list.total === 0) return { text: '🔗 <b>Shared Links</b>\n\nYou have no links yet. Open a file and tap <b>Share</b>.', reply_markup: backMenu() };
  const offset = (list.page - 1) * config.filesPerPage;
  const body = list.items.map((it, i) =>
    `<b>${offset + i + 1}.</b> 📄 ${it.file ? escapeHtml(truncate(it.file.name, 40)) : '—'}\n      ${STATE_LABEL[it.state]} · 📅 ${formatDay(it.share.createdAt)} · ⏳ ${it.share.expiresAt ? formatDay(it.share.expiresAt) : 'Never'} · 📥 ${downloadsText(it.share)}`);
  const text = ['🔗 <b>Shared Links</b>', `${list.total} link${list.total === 1 ? '' : 's'} · Page ${list.page}/${list.totalPages}`, '', body.join('\n\n'), '', '<i>Tap a number to open, edit, revoke or delete.</i>'].join('\n');
  return { text, reply_markup: linksKeyboard(list) };
}

export const searchPromptText = (help) => ['🔍 <b>Search Files</b>', '', help].join('\n');

export { mainMenu, shareState, formatDayTime };
