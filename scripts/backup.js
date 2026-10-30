#!/usr/bin/env node
// Writes a backup of all authoritative data (files, links, profiles, folders, audit, ...) to a local file.
//   REDIS_URL=redis://... node scripts/backup.js [output-file]
// Set BACKUP_ENCRYPTION_KEY to encrypt it. Store the result OUTSIDE Railway (your computer, cloud drive, ...).
import { writeFileSync } from 'node:fs';

process.env.VAULT_SCRIPT = 'redis';
process.env.LOG_LEVEL ||= 'warn';
const { connectRedis, closeRedis } = await import('../src/services/redis.js');
const { createBackup } = await import('../src/services/backup.js');

try {
  await connectRedis();
  const { buffer, counts, filename, encrypted } = await createBackup({ reason: 'cli' });
  const out = process.argv[2] || filename;
  writeFileSync(out, buffer, { mode: 0o600 });
  console.log(`Backup written: ${out} (${buffer.length} bytes, ${encrypted ? 'encrypted' : 'NOT encrypted'})`);
  console.log('Keys by family:', counts);
  if (!encrypted) console.log('Tip: set BACKUP_ENCRYPTION_KEY — the file contains password hashes and storage references.');
  await closeRedis();
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
}
