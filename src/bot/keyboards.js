import { InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { shareLink, telegramShareUrl, whatsappShareUrl } from '../utils/links.js';
import { CATEGORY_LABELS } from '../utils/category.js';
import { EXPIRY_PRESETS } from '../utils/time.js';

// Callback data is limited to 64 bytes; every id is 32 chars (file/share) or 8 chars (folder).

export const mainMenu = (isAdmin = false) => {
  const kb = new InlineKeyboard()
    .text('📤 Upload File', 'menu:upload').text('📁 My Files', 'files:1').row()
    .text('🔗 Shared Links', 'links:1').text('🕘 Recent Files', 'menu:recent').row()
    .text('🔍 Search Files', 'menu:search').text('📊 Storage', 'menu:storage').row()
    .text('⚙️ Settings', 'menu:settings').text('🔐 Privacy', 'menu:privacy').row()
    .text('❓ Help', 'menu:help').text('👨‍💻 Developer', 'menu:dev');
  if (isAdmin) kb.row().text('🛡 Admin Panel', 'adm:home');
  return kb;
};

export const backMenu = () => new InlineKeyboard().text('🏠 Menu', 'menu:home');
export const uploadKeyboard = () => new InlineKeyboard().text('📦 Multiple files', 'mb:start').text('🗂 My Collections', 'colls:1').row().text('🏠 Menu', 'menu:home');
export const cancelKeyboard = (fileId) => new InlineKeyboard().text('✖️ Cancel', fileId ? `cancel:${fileId}` : 'cancel');
export const afterDeleteKeyboard = () => new InlineKeyboard().text('📁 My Files', 'files:1').text('🏠 Menu', 'menu:home');

export const developerKeyboard = () =>
  new InlineKeyboard().url('💬 Message', `https://t.me/${config.developer.handle}`).text('🏠 Menu', 'menu:home');

// ---------------------------------------------------------------- file card

export const fileKeyboard = (meta) =>
  new InlineKeyboard()
    .text('🔗 Share', `sh:${meta.id}`).text('📥 Download', `dl:${meta.id}`).row()
    .text('✏️ Rename', `rn:${meta.id}`).text('📂 Move', `mv:${meta.id}`).row()
    .text('🔐 Password', `pw:${meta.id}`).text('⏳ Expiry', `ex:${meta.id}`).row()
    .text('🗑 Delete', `del:${meta.id}`).text('⬅️ Back', 'files:1');

export const deleteConfirmKeyboard = (id) =>
  new InlineKeyboard().text('✅ Yes, delete', `delok:${id}`).text('❌ Cancel', `open:${id}`);

// ---------------------------------------------------------------- file lists

const CHIPS = [
  ['all', '📁 All'], ['photo', '🖼 Photos'], ['video', '🎥 Videos'], ['audio', '🎵 Audio'],
  ['doc', '📄 Docs'], ['pdf', '📕 PDFs'], ['archive', '📦 Archives'],
];

/** ctx: { kind: 'all' | 'cat' | 'folder' | 'search', cat, folder } */
export function filesKeyboard({ items, page, totalPages }, ctx = { kind: 'all' }) {
  const kb = new InlineKeyboard();
  items.forEach((meta, i) => kb.text(String((page - 1) * config.filesPerPage + i + 1), `open:${meta.id}`));
  if (items.length) kb.row();

  const base = ctx.kind === 'search' ? (p) => `srp:${p}`
    : ctx.kind === 'folder' ? (p) => `fo:${ctx.folder}:${p}`
    : ctx.kind === 'cat' ? (p) => `fc:${ctx.cat}:${p}`
    : (p) => `files:${p}`;
  kb.text('⬅️', page > 1 ? base(page - 1) : 'noop').text(`${page}/${totalPages}`, 'noop').text('➡️', page < totalPages ? base(page + 1) : 'noop').row();

  if (ctx.kind === 'search') {
    kb.text('🔍 New search', 'menu:search').text('🏠 Menu', 'menu:home');
    return kb;
  }
  const active = ctx.kind === 'all' ? 'all' : ctx.kind === 'cat' ? ctx.cat : null;
  CHIPS.forEach(([code, label], i) => {
    kb.text(code === active ? `• ${label}` : label, code === 'all' ? 'files:1' : `fc:${code}:1`);
    if (i === 3) kb.row();
  });
  kb.row().text(ctx.kind === 'folder' ? '• 📂 Folders' : '📂 Folders', 'fo:list').text('🗂 Collections', 'colls:1').row().text('🏠 Menu', 'menu:home');
  return kb;
}

export function recentKeyboard(items) {
  const kb = new InlineKeyboard();
  for (const meta of items) {
    const label = meta.name.length > 16 ? `${meta.name.slice(0, 15)}…` : meta.name;
    kb.text(`📂 ${label}`, `open:${meta.id}`).text('📥', `dl:${meta.id}`).text('🔗', `sh:${meta.id}`).row();
  }
  return kb.text('📁 My Files', 'files:1').text('🏠 Menu', 'menu:home');
}

export function foldersKeyboard(folders) {
  const kb = new InlineKeyboard();
  folders.forEach((f, i) => {
    kb.text(`📂 ${f.name.slice(0, 18)} (${f.count})`, `fo:${f.id}:1`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('⬅️ Back', 'files:1').text('🏠 Menu', 'menu:home');
}

export function moveKeyboard(fileId, folders, currentFolder) {
  const kb = new InlineKeyboard();
  folders.forEach((f, i) => {
    kb.text(`${f.id === currentFolder ? '✅ ' : '📂 '}${f.name.slice(0, 18)}`, `mvt:${fileId}:${f.id}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row();
  if (currentFolder) kb.text('📁 No folder', `mvt:${fileId}:0`);
  return kb.text('➕ New folder', `mvn:${fileId}`).row().text('⬅️ Back', `open:${fileId}`);
}

// ---------------------------------------------------------------- password / expiry

export function passwordKeyboard(meta) {
  const kb = new InlineKeyboard();
  if (meta.hasPassword) kb.text('🔑 Change Password', `pws:${meta.id}`).text('🔓 Remove', `pwr:${meta.id}`);
  else kb.text('🔐 Set Password', `pws:${meta.id}`);
  return kb.row().text('⬅️ Back', `open:${meta.id}`);
}

export const passwordRemoveKeyboard = (id) =>
  new InlineKeyboard().text('✅ Remove password', `pwrok:${id}`).text('❌ Cancel', `pw:${id}`);

/** Generic expiry picker: every button is `${prefix}:<code>`; the last row is a Back button. */
export function expiryKeyboard(prefix, backData, { custom = true, defaultLabel = null } = {}) {
  const kb = new InlineKeyboard();
  if (defaultLabel) kb.text(`⭐ Default (${defaultLabel})`, `${prefix}:d`).row();
  const entries = Object.entries(EXPIRY_PRESETS);
  entries.forEach(([code, p], i) => {
    kb.text(`⏳ ${p.label}`, `${prefix}:${code}`);
    if (i % 2 === 1) kb.row();
  });
  if (entries.length % 2 === 1) kb.row();
  if (custom) kb.text('⏳ Custom', `${prefix}:c`);
  return kb.row().text('⬅️ Back', backData);
}

export const LIMIT_PRESETS = { u: { value: 0, label: 'Unlimited' }, 1: { value: 1, label: '1' }, 5: { value: 5, label: '5' }, 10: { value: 10, label: '10' }, 25: { value: 25, label: '25' } };

export function limitKeyboard(prefix, backData) {
  const kb = new InlineKeyboard();
  Object.entries(LIMIT_PRESETS).forEach(([code, p], i) => {
    kb.text(code === 'u' ? '🔢 Unlimited' : `🔢 ${p.label}`, `${prefix}:${code}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('🔢 Custom', `${prefix}:c`).row().text('⬅️ Back', backData);
}

// ---------------------------------------------------------------- sharing

export function shareMenuKeyboard(fileId, entries) {
  const kb = new InlineKeyboard();
  entries.slice(0, 5).forEach((e, i) => kb.text(`${i + 1}`, `sd:${e.share.token}`));
  if (entries.length) kb.row();
  return kb.text('➕ New Link', `shn:${fileId}`).row().text('⬅️ Back', `open:${fileId}`);
}

export function shareDetailKeyboard(share, state) {
  const kb = new InlineKeyboard();
  const link = shareLink(share.token);
  if (state === 'active') {
    kb.url('🔗 Open Link', link).text('🚫 Revoke Link', `srv:${share.token}`).row()
      .add({ text: '📋 Copy', copy_text: { text: link } }).text('🔳 QR', `qr:${share.token}`).row()
      .url('📤 Send', telegramShareUrl(link)).url('💬 WhatsApp', whatsappShareUrl(link)).row();
  }
  if (state !== 'revoked' && state !== 'deleted') kb.text('✏️ Edit', `se:${share.token}`);
  kb.text('🗑 Delete', `sdel:${share.token}`).row().text('⬅️ Back', `sh:${share.fileId}`);
  return kb;
}

export const shareEditKeyboard = (token) =>
  new InlineKeyboard().text('⏳ Expiry', `sex:${token}`).text('🔢 Download limit', `sel:${token}`).row().text('⬅️ Back', `sd:${token}`);

export const revokeConfirmKeyboard = (token) =>
  new InlineKeyboard().text('✅ Yes, revoke', `srvok:${token}`).text('❌ Cancel', `sd:${token}`);

export const shareDeleteConfirmKeyboard = (token) =>
  new InlineKeyboard().text('✅ Yes, delete', `sdelok:${token}`).text('❌ Cancel', `sd:${token}`);

export function linksKeyboard({ items, page, totalPages }) {
  const kb = new InlineKeyboard();
  items.forEach((it, i) => kb.text(String((page - 1) * config.filesPerPage + i + 1), `sd:${it.share.token}`));
  if (items.length) kb.row();
  return kb
    .text('⬅️', page > 1 ? `links:${page - 1}` : 'noop').text(`${page}/${totalPages}`, 'noop').text('➡️', page < totalPages ? `links:${page + 1}` : 'noop')
    .row().text('🗂 Collections', 'colls:1').text('📁 My Files', 'files:1').row().text('🏠 Menu', 'menu:home');
}

export const qrKeyboard = (token) =>
  new InlineKeyboard().text('📐 Download SVG (vector)', `qrsvg:${token}`).row().text('⬅️ Back to link', `sd:${token}`);

export const reportKeyboard = (token) => ({ inline_keyboard: [[{ text: '🚨 Report', callback_data: `rp:${token}` }]] });

// ---------------------------------------------------------------- settings

export const settingsKeyboard = () =>
  new InlineKeyboard().text('⏳ File expiry', 'set:f').text('🔗 Link expiry', 'set:s').row().text('🏠 Menu', 'menu:home');

export const settingsExpiryKeyboard = (prefix) => expiryKeyboard(prefix, 'menu:settings', { custom: false });

export { CATEGORY_LABELS };
