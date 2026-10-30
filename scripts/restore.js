#!/usr/bin/env node
// Restores a backup into a NEW, EMPTY Redis. It refuses to touch a database that already contains data.
//   REDIS_URL=redis://<new-empty-redis> node scripts/restore.js <backup-file>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: REDIS_URL=<new empty redis> node scripts/restore.js <backup-file>');
  process.exit(1);
}
process.env.VAULT_SCRIPT = 'redis';
process.env.LOG_LEVEL ||= 'warn';
const { connectRedis, closeRedis, redis } = await import('../src/services/redis.js');
const { restoreBackup, parseBackup } = await import('../src/services/backup.js');

try {
  const buffer = readFileSync(file);
  const { header, entries } = parseBackup(buffer); // validates + decrypts before touching Redis
  console.log(`Backup from ${header.createdAt} (schema v${header.schema}, DB ${String(header.dbId).slice(0, 6)}…): ${entries.length} keys`);
  await connectRedis();
  const result = await restoreBackup(buffer);
  console.log('Restored keys by family:', result.restored);
  console.log('Indexes rebuilt:', result.rebuilt);
  console.log(`\nDone. The restored database keeps its fingerprint: ${header.dbId}`);
  console.log('Next: point REDIS_URL of the bot at this database, then run `npm run verify`.');
  await closeRedis();
  void redis;
} catch (err) {
  console.error(`Restore failed: ${err.message}`);
  process.exit(1);
}
