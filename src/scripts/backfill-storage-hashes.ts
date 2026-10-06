import { backfillStorageHashes } from '../services/storage';
import { closeDb } from '../db';
const after = process.argv[2];
const limit = Number(process.argv[3] || 20);
const maxBytes = Number(process.argv[4] || 256 * 1024 * 1024);
if ((after && !/^[0-9a-f-]{36}$/.test(after)) || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
  throw new Error('Usage: bun src/scripts/backfill-storage-hashes.ts [after-uuid] [limit 1..100] [byte-budget]');
}
try { console.log(JSON.stringify(await backfillStorageHashes({ after, limit, maxBytes }), null, 2)); }
finally { await closeDb(); }
