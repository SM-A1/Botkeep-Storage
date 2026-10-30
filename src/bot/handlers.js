import { isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { errorRef } from '../utils/errors.js';
import { mainMenu } from './keyboards.js';
import { registerFileHandlers } from './files.js';
import { registerShareHandlers } from './shares.js';
import { registerCollectionHandlers } from './collections.js';
import { registerAdmin } from './admin.js';
import { handleAwaitedText } from './text.js';
import { MEDIA_FILTERS, handleUpload } from './upload.js';
import { errorText, htmlOpts, unsupportedText } from './views.js';

export { registerMiddleware } from './middleware.js';

export function registerHandlers(bot) {
  registerAdmin(bot);
  registerFileHandlers(bot);
  registerShareHandlers(bot);
  registerCollectionHandlers(bot);

  bot.callbackQuery(/.*/, (ctx) => ctx.answerCallbackQuery()); // stale or unknown buttons

  // ---- Uploads ---------------------------------------------------------------
  bot.on(MEDIA_FILTERS, handleUpload);

  // ---- Text: answers to prompts (rename, password, search, ...) -------------------
  bot.on('message:text', async (ctx, next) => {
    if (ctx.msg.text.startsWith('/')) return next();
    if (await handleAwaitedText(ctx)) return;
    await ctx.reply('📤 Send me a file to store it, or pick an option below.', htmlOpts({ reply_markup: mainMenu(isAdmin(ctx.from.id)) }));
  });

  // ---- Everything else ----------------------------------------------------------
  bot.on('message', async (ctx) => {
    const text = ctx.msg.text;
    if (text?.startsWith('/')) await ctx.reply('🤔 <b>Unknown command</b>\n\nUse /help to see what I can do.', htmlOpts());
    else await ctx.reply(unsupportedText(), htmlOpts());
  });

  // ---- Centralised error handling: never leak internals to users -----------
  bot.catch(async (botError) => {
    const { ctx, error } = botError;
    const ref = errorRef();
    logger.error('unhandled bot error', { refId: ref, updateId: ctx.update.update_id, userId: ctx.from?.id, err: error });
    try {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: `⚠️ Something went wrong. Reference ${ref}`, show_alert: true });
      else if (ctx.chat) await ctx.reply(errorText(ref), htmlOpts());
    } catch {
      // nothing more we can do
    }
  });
}
