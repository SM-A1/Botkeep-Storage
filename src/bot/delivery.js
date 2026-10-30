import { isAdmin } from '../config.js';
import { logger, shortToken } from '../logger.js';
import { audit, secCount } from '../services/audit.js';
import { canOwnerDownload, getPasswordHash, recordDownload } from '../services/files.js';
import { clearAwait, setAwait } from '../services/inputState.js';
import { verifyPassword } from '../services/password.js';
import { limiters } from '../services/rateLimit.js';
import { redis } from '../services/redis.js';
import { consumeShare, refundShare, resolveShare } from '../services/shares.js';
import { getPolicy, trackDelivery } from '../services/autodelete.js';
import { copyFromStorage } from '../services/telegram.js';
import { cancelKeyboard, reportKeyboard } from './keyboards.js';
import { htmlOpts, rateLimitText, unavailableText } from './views.js';

const UNLOCK_SECONDS = 600;
const unlockKey = (viewerId, token) => `unlock:${viewerId}:${token.slice(0, 16)}`;

/** One generic answer for every kind of denial: never reveal which check failed. */
async function deny(ctx, reason, token) {
  await secCount('link_denied');
  await audit('link_denied', { actorId: ctx.from.id, detail: reason });
  logger.info('share access denied', { userId: ctx.from.id, tokenId: shortToken(token), reason });
  await ctx.reply(unavailableText(), htmlOpts());
}

/**
 * Public access path for a share link (t.me deep link or password reply).
 * Verifies: token → link status → link expiry → file exists/expiry → password → download limit (atomic) → delivery.
 */
export async function deliverShare(ctx, token, { passwordChecked = false } = {}) {
  const viewerId = ctx.from.id;
  const rl = await limiters.downloadUser(viewerId);
  if (!rl.allowed) {
    await secCount('rate_limited');
    await ctx.reply(rateLimitText(rl.retryAfter), htmlOpts());
    return;
  }

  const resolved = await resolveShare(token);
  if (!resolved.ok) return deny(ctx, resolved.reason, token);
  const { share, file } = resolved;

  const privileged = file.uploaderId === viewerId || isAdmin(viewerId);
  if (privileged) {
    // Owners/admins use the owner path: no password, no download-limit consumption.
    if (!canOwnerDownload(file)) return deny(ctx, 'file_expired', token);
    await sendFile(ctx, file, share, { privileged: true });
    return;
  }

  if (file.hasPassword && !passwordChecked && !(await redis.get(unlockKey(viewerId, token)))) {
    await setAwait(viewerId, { kind: 'pw', token });
    await ctx.reply('🔐 <b>Password required</b>\n\nThis file is protected. Send the password as a message.', htmlOpts({ reply_markup: cancelKeyboard() }));
    return;
  }

  const claim = await consumeShare(token);
  if (!claim.ok) return deny(ctx, claim.reason, token);
  try {
    await sendFile(ctx, file, share, { privileged: false });
  } catch (err) {
    await refundShare(token).catch(() => {});
    throw err;
  }
}

async function sendFile(ctx, file, share, { privileged }) {
  // Owners/admins always get plain, permanent copies. Everyone else follows the delivery policy.
  const policy = privileged ? { autoDelete: 0, forwardLock: 0 } : await getPolicy();
  const markup = privileged ? null : reportKeyboard(share.token);
  let delivered;
  try {
    delivered = await copyFromStorage(ctx.chat.id, file.messageId, {
      ...(markup ? { reply_markup: markup } : {}),
      ...(policy.forwardLock > 0 ? { protect_content: true } : {}),
    });
  } catch (err) {
    logger.error('download failed', { userId: ctx.from.id, tokenId: shortToken(share.token), err });
    if (!privileged) await refundShare(share.token).catch(() => {});
    await ctx.reply('⚠️ <b>File unavailable</b>\n\nWe could not retrieve this file right now. Please try again later.', htmlOpts());
    return;
  }
  void recordDownload(file.id);
  await audit('download', { actorId: ctx.from.id, file, share, detail: privileged ? 'owner' : 'link' });
  logger.info('download delivered', { userId: ctx.from.id, tokenId: shortToken(share.token), privileged });
  await trackDelivery({ chatId: ctx.chat.id, ids: [delivered.message_id], src: [file.messageId], policy, markup, markupOn: 'file' })
    .catch((err) => logger.error('could not schedule auto-delete', { err }));
}

/** The user replied with a password for a protected link. */
export async function handlePasswordReply(ctx, token, text) {
  const viewerId = ctx.from.id;
  const rl = await limiters.passwordAttempt(viewerId, token);
  if (!rl.allowed) {
    await secCount('password_lockout');
    await audit('password_lockout', { actorId: viewerId });
    await clearAwait(viewerId);
    await ctx.reply(`⏳ <b>Too many attempts</b>\n\nPlease try again in ${Math.ceil(rl.retryAfter / 60)} min.`, htmlOpts());
    return;
  }

  const resolved = await resolveShare(token);
  if (!resolved.ok) { await clearAwait(viewerId); return deny(ctx, resolved.reason, token); }
  const hash = await getPasswordHash(resolved.file.id);
  if (!hash) { // protection was removed meanwhile
    await clearAwait(viewerId);
    return deliverShare(ctx, token, { passwordChecked: true });
  }

  if (!(await verifyPassword(text, hash))) {
    await secCount('password_failed');
    await audit('password_failed', { actorId: viewerId, file: resolved.file, share: resolved.share });
    await ctx.reply('❌ <b>Incorrect password</b>\n\nTry again, or tap Cancel.', htmlOpts({ reply_markup: cancelKeyboard() }));
    return;
  }
  await clearAwait(viewerId);
  await redis.set(unlockKey(viewerId, token), '1', 'EX', UNLOCK_SECONDS);
  await deliverShare(ctx, token, { passwordChecked: true });
}
