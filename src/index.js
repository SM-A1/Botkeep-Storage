import { run } from '@grammyjs/runner';
import { config } from './config.js';
import { logger } from './logger.js';
import { lifecycle, sleep } from './lifecycle.js';
import { closeRedis, connectRedis } from './services/redis.js';
import { DatabaseGuardError, initDatabase } from './services/schema.js';
import { sendBackupToTelegram, startBackupScheduler } from './services/backup.js';
import { startExpirySweeper } from './services/files.js';
import { startDeliverySweeper } from './services/autodelete.js';
import { bot, checkStorageChannel } from './services/telegram.js';
import { registerBot } from './bot/index.js';
import { seedFromConfig } from './services/forceSubscribe.js';
import { startBatchSweeper } from './bot/collections.js';
import { closeServer, startServer } from './web/server.js';

const PUBLIC_COMMANDS = [
  { command: 'start', description: 'Dashboard' },
  { command: 'files', description: 'My files' },
  { command: 'search', description: 'Search files' },
  { command: 'links', description: 'Shared links' },
  { command: 'collections', description: 'My collections (one link, many files)' },
  { command: 'multi', description: 'Upload many files, get one link' },
  { command: 'recent', description: 'Recent files' },
  { command: 'storage', description: 'Storage usage' },
  { command: 'settings', description: 'Settings' },
  { command: 'help', description: 'How to use the bot' },
  { command: 'privacy', description: 'Privacy information' },
];
const ADMIN_COMMANDS = [
  ...PUBLIC_COMMANDS,
  { command: 'admin', description: 'Admin: panel' },
  { command: 'stats', description: 'Admin: statistics' },
  { command: 'broadcast', description: 'Admin: message all users' },
  { command: 'maintenance', description: 'Admin: maintenance mode' },
  { command: 'delete', description: 'Admin: delete a file by token' },
  { command: 'autodelete', description: 'Admin: auto-delete delivered files' },
  { command: 'forwardlock', description: 'Admin: forward lock time' },
];

async function withRetry(label, fn, attempts = 5) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || lifecycle.shuttingDown) throw err;
      logger.warn(`${label} failed, retrying`, { attempt: i, err });
      await sleep(Math.min(1000 * 2 ** i, 15_000));
    }
  }
}

async function registerTelegramCommands() {
  try {
    await bot.api.setMyCommands(PUBLIC_COMMANDS);
    for (const adminId of config.adminIds) {
      // Fails harmlessly if that admin has not started the bot yet.
      await bot.api
        .setMyCommands(ADMIN_COMMANDS, { scope: { type: 'chat', chat_id: adminId } })
        .catch(() => logger.debug('admin command menu not set (admin has not started the bot yet)'));
    }
  } catch (err) {
    logger.warn('could not register bot commands', { err });
  }
}

let runner = null;

/**
 * Long polling with @grammyjs/runner: updates are processed CONCURRENTLY (one user's slow upload no longer
 * blocks everybody else). Updates of the same user stay in order (see sequentialize in the middleware).
 * Restarts automatically (e.g. a 409 while a previous Railway instance shuts down).
 */
async function runPolling() {
  let attempt = 0;
  while (!lifecycle.shuttingDown) {
    try {
      runner = run(bot, {
        runner: {
          fetch: { allowed_updates: ['message', 'callback_query'] },
          // Constant 2 s retry. The runner default is an UNCAPPED exponential backoff (it doubles on every failed
          // poll), which after a few minutes of trouble leaves the bot deaf for a long time even though Telegram
          // is reachable again. Telegram long polling is cheap, so a short fixed delay is the right choice.
          retryInterval: 2000,
          maxRetryTime: 60 * 60 * 1000,
        },
      });
      logger.info('telegram polling started (concurrent)', { botUsername: bot.botInfo?.username });
      attempt = 0;
      await runner.task();
    } catch (err) {
      if (lifecycle.shuttingDown) break;
      attempt += 1;
      const delayMs = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
      logger.error('telegram polling stopped; restarting', { err, delayMs });
      await sleep(delayMs);
      continue;
    }
    if (!lifecycle.shuttingDown) await sleep(1000);
  }
}

async function main() {
  logger.info('starting', { node: process.version, env: config.env });

  await connectRedis();
  logger.info('redis connected');

  const me = await withRetry('telegram getMe', () => bot.api.getMe());
  logger.info('telegram connected', { botUsername: me.username });
  if (me.username.toLowerCase() !== config.botUsername.toLowerCase()) {
    logger.warn('BOT_USERNAME does not match the bot behind BOT_TOKEN; deep links will be wrong');
  }

  const storage = await checkStorageChannel();
  if (!storage.ok || !storage.canPost) {
    logger.error('storage channel is not usable: add the bot as an admin with "Post messages" permission', { details: storage });
  } else {
    logger.info('storage channel ready');
    if (storage.isPublic) logger.warn('storage channel has a public username; make it private');
  }

  // Data safety gate: never starts on an empty/wrong/newer database; upgrades the schema in place when needed.
  try {
    const db = await initDatabase({ backupFn: async (reason) => (storage.ok && storage.canPost ? sendBackupToTelegram({ reason }) : false) });
    logger.info('database ready', { schema: db.schema, dbId: db.dbId });
  } catch (err) {
    if (err instanceof DatabaseGuardError) {
      logger.error(`DATABASE SAFETY CHECK FAILED — refusing to start. ${err.message}`);
      await closeRedis();
      process.exit(2);
    }
    throw err;
  }

  registerBot(bot);
  // Optional one-time import of FORCE_SUB_SEED (e.g. @TheRoyalZone) into the dynamic channel list. Never blocks startup.
  try {
    const seed = await seedFromConfig();
    if (seed.seeded) logger.info('force subscribe: seed applied', seed);
  } catch (err) {
    logger.warn('force subscribe: seed failed; add the channel from Admin Panel -> Force Subscribe', { err });
  }
  const stopSweeper = startExpirySweeper();
  const stopBatchSweeper = startBatchSweeper();
  const stopDeliverySweeper = startDeliverySweeper();
  const stopBackups = startBackupScheduler();
  const server = await startServer();
  await registerTelegramCommands();

  let shuttingDownStarted = false;
  async function shutdown(reason, exitCode = 0) {
    if (shuttingDownStarted) return;
    shuttingDownStarted = true;
    lifecycle.shuttingDown = true;
    logger.info('shutdown started', { reason });

    const force = setTimeout(() => {
      logger.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 20_000);
    force.unref();

    try {
      stopSweeper();
      stopBatchSweeper();
      stopDeliverySweeper();
      stopBackups();
      if (runner?.isRunning()) await runner.stop().catch(() => {}); // stop receiving updates first
      await closeServer(server); // let in-flight downloads finish
      await closeRedis(); // close Redis last
      logger.info('shutdown complete');
      process.exit(exitCode);
    } catch (err) {
      logger.error('error during shutdown', { err });
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    shutdown('uncaughtException', 1);
  });

  await runPolling();
}

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
});

main().catch((err) => {
  logger.error('fatal startup error', { err });
  process.exit(1);
});
