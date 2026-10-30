import { config } from '../config.js';
import { logger, shortToken } from '../logger.js';
import { audit } from '../services/audit.js';
import { createFile } from '../services/files.js';
import { limiters } from '../services/rateLimit.js';
import { redis } from '../services/redis.js';
import { copyToStorage, deleteStorageMessage } from '../services/telegram.js';
import {
  addDuplicate, addProblem, addToBatch, claimMessage, claimUnique, getBatch, openBatch, releaseUnique,
} from '../services/uploadBatch.js';
import { errorRef } from '../utils/errors.js';
import { formatSize, sanitizeFilename } from '../utils/format.js';
import { fileKeyboard } from './keyboards.js';
import { htmlOpts, rateLimitText, renderFileCard, unsupportedText } from './views.js';
import { isNotModified } from './common.js';
import {
  finalizeBatch, manualKeyboard, manualText, progressEdit, progressText, scheduleFinalize,
} from './collections.js';

export const MEDIA_FILTERS = [
  'message:document', 'message:photo', 'message:video', 'message:audio',
  'message:voice', 'message:video_note', 'message:animation',
];

const MIME_EXT = {
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/flac': 'flac',
  'audio/wav': 'wav', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/webm': 'webm',
};
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,80}$/i;

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const extFor = (mime, fallback) => MIME_EXT[mime] ?? fallback;

export function extractMedia(msg) {
  if (msg.document) {
    const d = msg.document;
    return { type: 'document', uniqueId: d.file_unique_id, fileId: d.file_id, size: d.file_size ?? 0, name: d.file_name, mime: d.mime_type };
  }
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { type: 'photo', uniqueId: p.file_unique_id, fileId: p.file_id, size: p.file_size ?? 0, name: `photo_${stamp()}.jpg`, mime: 'image/jpeg' };
  }
  if (msg.video) {
    const v = msg.video;
    return { type: 'video', uniqueId: v.file_unique_id, fileId: v.file_id, size: v.file_size ?? 0, name: v.file_name ?? `video_${stamp()}.${extFor(v.mime_type, 'mp4')}`, mime: v.mime_type };
  }
  if (msg.audio) {
    const a = msg.audio;
    const ext = extFor(a.mime_type, 'mp3');
    const titled = a.title ? `${a.performer ? `${a.performer} - ` : ''}${a.title}.${ext}` : undefined;
    return { type: 'audio', uniqueId: a.file_unique_id, fileId: a.file_id, size: a.file_size ?? 0, name: a.file_name ?? titled ?? `audio_${stamp()}.${ext}`, mime: a.mime_type };
  }
  if (msg.voice) {
    const v = msg.voice;
    return { type: 'voice', uniqueId: v.file_unique_id, fileId: v.file_id, size: v.file_size ?? 0, name: `voice_${stamp()}.ogg`, mime: v.mime_type ?? 'audio/ogg' };
  }
  if (msg.video_note) {
    const v = msg.video_note;
    return { type: 'video_note', uniqueId: v.file_unique_id, fileId: v.file_id, size: v.file_size ?? 0, name: `video_note_${stamp()}.mp4`, mime: 'video/mp4' };
  }
  if (msg.animation) {
    const a = msg.animation;
    return { type: 'animation', uniqueId: a.file_unique_id, fileId: a.file_id, size: a.file_size ?? 0, name: a.file_name ?? `animation_${stamp()}.mp4`, mime: a.mime_type };
  }
  return null;
}

async function showUploadResult(ctx, statusMessageId, text, reply_markup) {
  try {
    await ctx.api.editMessageText(ctx.chat.id, statusMessageId, text, htmlOpts({ reply_markup }));
  } catch (err) {
    if (isNotModified(err)) return;
    try {
      await ctx.reply(text, htmlOpts({ reply_markup }));
    } catch (replyErr) {
      logger.error('could not deliver upload result to user', { err: replyErr });
    }
  }
}

/** Quiet window that ends an auto batch. 0 disables time-based grouping (albums and manual sessions still group). */
const windowMs = () => (config.collections.batchQuietMs > 0 ? config.collections.batchQuietMs : 2000);

/**
 * Upload entry point. One file behaves exactly as before (status message, then the file card). Files that arrive
 * together — an album, a multi-select, or a manual "Multiple files" session — are grouped into ONE collection
 * with ONE share link (see bot/collections.js). Nothing is replied per file: one status message is updated.
 */
export async function handleUpload(ctx) {
  const userId = ctx.from.id;
  if (!(await claimMessage(userId, ctx.msg.message_id))) return; // Telegram re-delivered this update: already handled

  const group = ctx.msg.media_group_id ? String(ctx.msg.media_group_id).slice(0, 40) : '';
  let batch = await getBatch(userId);
  // An open auto batch absorbs this file only while grouping applies (quiet window enabled, or the same album).
  if (batch && batch.mode === 'auto' && !(config.collections.batchQuietMs > 0 || (group && batch.group === group))) {
    await finalizeBatch(userId);
    batch = null;
  }
  const mode = batch?.mode ?? 'auto';
  const opts = { mode, group };

  // Replies to a rejected file: quiet while a batch is open (summarised at the end); one per album otherwise.
  const reject = async (text) => {
    if (batch) {
      await addProblem(userId, 'skipped', '', opts);
      if (mode === 'auto') scheduleFinalize(userId, windowMs());
      return;
    }
    if (group && (await redis.set(`upl:rej:${userId}:${group}`, '1', 'EX', 30, 'NX')) !== 'OK') return;
    await ctx.reply(text, htmlOpts());
  };

  const rl = batch ? await limiters.uploadFiles(userId) : await limiters.uploads(userId);
  if (!rl.allowed) {
    if (batch) await addProblem(userId, 'skipped', '', opts);
    else await ctx.reply(rateLimitText(rl.retryAfter), htmlOpts());
    return;
  }
  const media = extractMedia(ctx.msg);
  if (!media) return reject(unsupportedText());
  if (ctx.msg.has_protected_content) {
    return reject('🚫 <b>This file is protected</b>\n\nIts owner disabled copying and forwarding, so it cannot be stored.');
  }
  // File metadata validation: sane numbers and identifiers before anything is stored.
  const size = Number.isFinite(media.size) && media.size >= 0 ? Math.floor(media.size) : 0;
  if (typeof media.fileId !== 'string' || media.fileId.length < 5 || media.fileId.length > 300) return reject(unsupportedText());
  if (config.maxFileSizeBytes > 0 && size > config.maxFileSizeBytes) {
    return reject(`📦 <b>File too large</b>\n\nThe maximum size is ${config.maxFileSizeMb} MB (this file is ${formatSize(size)}).`);
  }
  // The same Telegram file twice in one batch is ignored (double taps, re-sent albums).
  const uniqueId = typeof media.uniqueId === 'string' ? media.uniqueId.slice(0, 64) : '';
  if (!(await claimUnique(userId, uniqueId))) {
    await addDuplicate(userId, opts);
    if (mode === 'auto') scheduleFinalize(userId, windowMs());
    return;
  }

  let statusId = batch?.status ?? null;
  if (!batch) {
    const status = await ctx.reply('⏳ <b>Processing your file…</b>\nSaving it to secure storage.', htmlOpts());
    statusId = status.message_id;
  }
  let storedMessageId = null;
  let meta;
  try {
    storedMessageId = await copyToStorage(ctx.chat.id, ctx.msg.message_id);
    meta = await createFile({
      fileId: media.fileId,
      messageId: storedMessageId,
      name: sanitizeFilename(media.name, `file_${stamp()}`),
      type: media.type,
      size,
      mime: typeof media.mime === 'string' && MIME_RE.test(media.mime) ? media.mime.toLowerCase() : '',
      uploaderId: userId,
    });
  } catch (err) {
    const ref = errorRef();
    logger.error('upload failed', { userId, type: media.type, refId: ref, err });
    // Only a half-finished upload (copy made, no record) is cleaned up — never a stored user file.
    if (storedMessageId !== null) await deleteStorageMessage(storedMessageId);
    await releaseUnique(userId, uniqueId);
    if (batch) {
      await addProblem(userId, 'failed', ref, opts); // reported once in the batch summary
      if (mode === 'auto') scheduleFinalize(userId, windowMs());
      return;
    }
    await showUploadResult(ctx, statusId, `❌ <b>Upload failed</b>\n\nWe could not store your file. Please try again in a moment.\n\nReference ID: <code>${ref}</code>`);
    return;
  }

  logger.info('upload succeeded', { userId, tokenId: shortToken(meta.id), type: media.type, size });
  await audit('upload', { actorId: userId, file: meta, detail: `${meta.cat} ${size}B` });

  if (!batch) {
    // First file: show its card right away, exactly like a single upload. If more files follow, this same
    // message turns into the progress line and finally the collection summary.
    await openBatch(userId, { mode: 'auto', statusMessageId: statusId, group });
    await addToBatch(userId, meta.id, size, opts);
    await showUploadResult(ctx, statusId, await renderFileCard(meta, { title: '✅ <b>Uploaded</b>' }), fileKeyboard(meta));
    scheduleFinalize(userId, windowMs());
    return;
  }

  const count = await addToBatch(userId, meta.id, size, opts);
  if (mode === 'manual') {
    await progressEdit(userId, statusId, manualText(count, batch.bytes + size), manualKeyboard(count), 1500);
  } else {
    await progressEdit(userId, statusId, progressText(count));
    scheduleFinalize(userId, windowMs());
  }
}
