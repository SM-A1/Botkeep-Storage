#!/usr/bin/env node
// Post-deployment checklist. Run it against the NEW Railway project BEFORE switching traffic.
//   node scripts/verify.js [--deep=5] [--skip-telegram]
// Read-only for your data. --deep=N copies N random stored files from the storage channel into the first
// admin's private chat and removes only THAT copy again (the channel is never modified).
process.env.VAULT_SCRIPT = process.argv.includes('--skip-telegram') ? 'redis' : 'full';
process.env.LOG_LEVEL ||= 'error';
const deepArg = process.argv.find((a) => a.startsWith('--deep='));
const deep = deepArg ? Number(deepArg.split('=')[1]) || 0 : 0;
const skipTelegram = process.argv.includes('--skip-telegram');

const { config } = await import('../src/config.js');
const { connectRedis, closeRedis, redis } = await import('../src/services/redis.js');
const { CURRENT_SCHEMA, databaseInfo, railwayHostWarning, redisPersistenceInfo } = await import('../src/services/schema.js');
const { parseMeta } = await import('../src/services/files.js');

let failures = 0;
let warnings = 0;
const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => { warnings += 1; console.log(`⚠️  ${m}`); };
const fail = (m) => { failures += 1; console.log(`❌ ${m}`); };

try {
  await connectRedis();
  ok('Database connection works');
  const info = await databaseInfo();
  if (info.schema === CURRENT_SCHEMA) ok(`Schema is v${info.schema}`);
  else if (info.schema === 0) fail('Database has no schema marker: it is empty or not a Vault database. DO NOT switch traffic.');
  else fail(`Schema v${info.schema} does not match code v${CURRENT_SCHEMA}`);
  if (info.dbId) ok(`Database fingerprint: ${info.dbId}  (put it in DB_FINGERPRINT to lock this deployment to this database)`);
  if (config.dbFingerprint && info.dbId !== config.dbFingerprint) fail('DB_FINGERPRINT does not match this database');

  const host = railwayHostWarning();
  if (host) warn(`REDIS_URL is hosted on Railway (${host}): data is NOT independent of the Railway project/account.`);
  else ok('Redis is not hosted on Railway');
  const persistence = await redisPersistenceInfo();
  if (!persistence.known) warn('Redis persistence could not be read (managed provider?). Confirm in your provider that persistence/backups are on.');
  else if (persistence.aof || persistence.rdb) ok('Redis persistence is enabled');
  else fail('Redis reports no persistence: a restart would lose data');

  // Counts + storage reference validation over every file record (cursor-based, read-only).
  let files = 0; let badRefs = 0; const sample = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'file:*', 'COUNT', 500);
    cursor = next;
    const pipe = redis.pipeline();
    keys.forEach((k) => pipe.hgetall(k));
    const rows = keys.length ? await pipe.exec() : [];
    rows.forEach(([, h], i) => {
      files += 1;
      const meta = parseMeta(keys[i].slice(5), h);
      if (!meta || !Number.isSafeInteger(meta.messageId) || meta.messageId <= 0 || !meta.fileId) badRefs += 1;
      else if (sample.length < 500) sample.push(meta);
    });
  } while (cursor !== '0');
  const [users, shares, audit] = [await redis.scard('users'), (await redis.keys('share:*')).length, await redis.xlen('audit')];
  ok(`Data present: ${files} files, ${shares} share links, ${users} users, ${audit} audit events`);
  if (files === 0) warn('No files found. Expected if this is a brand-new installation; otherwise STOP — wrong database?');
  if (badRefs === 0) ok('All storage references are well-formed'); else fail(`${badRefs} file record(s) have broken storage references`);

  if (!skipTelegram) {
    const { bot, checkStorageChannel } = await import('../src/services/telegram.js');
    const me = await bot.api.getMe();
    ok(`Telegram bot token works (@${me.username})`);
    if (me.username.toLowerCase() !== config.botUsername.toLowerCase()) warn('BOT_USERNAME does not match this bot: links would be wrong');
    const hook = await bot.api.getWebhookInfo();
    if (hook.url) warn(`A webhook is set (${new URL(hook.url).host}). This bot uses long polling; starting it removes the webhook.`);
    else ok('No webhook configured (long polling)');
    const st = await checkStorageChannel();
    if (st.ok && st.canPost) ok('Storage channel reachable and writable'); else fail('Storage channel is not reachable / bot lacks "Post messages"');
    if (st.ok && st.isPublic) warn('Storage channel has a public username: make it private');

    if (deep > 0 && sample.length) {
      const admin = [...config.adminIds][0];
      let good = 0;
      for (const meta of sample.sort(() => Math.random() - 0.5).slice(0, deep)) {
        try {
          const copy = await bot.api.copyMessage(admin, config.storageChannelId, meta.messageId);
          await bot.api.deleteMessage(admin, copy.message_id).catch(() => {});
          good += 1;
        } catch (err) {
          fail(`Stored file #${meta.ref || '?'} is NOT retrievable from the storage channel (${err.description ?? err.message})`);
        }
      }
      if (good) ok(`${good}/${Math.min(deep, sample.length)} sampled stored files are retrievable`);
    }
  }
} catch (err) {
  fail(`Verification crashed: ${err.message}`);
}

console.log(`\n${failures ? '❌ NOT READY' : '✅ READY'} — ${failures} failure(s), ${warnings} warning(s)`);
await closeRedis().catch(() => {});
process.exit(failures ? 1 : 0);
