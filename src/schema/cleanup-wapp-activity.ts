import { closeDb } from '../db';
import { cleanupWappActivity } from '../services/wapp-activity';

async function run() {
  const result = await cleanupWappActivity();
  console.log(JSON.stringify({ ok: true, cleanup: 'wapp_activity_publishing_v1', deleted: result }, null, 2));
  await closeDb();
}

run().catch(async (error) => {
  console.error('WApp activity cleanup failed', error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
