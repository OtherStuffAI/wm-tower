import { ensureServiceIdentity } from './service-identity';

const identity = await ensureServiceIdentity();

const [{ createApp }, { config }, { getDb }, { ensureRuntimeSchema }] = await Promise.all([
  import('./server'),
  import('./config'),
  import('./db'),
  import('./schema/ensure-runtime-schema'),
]);

const app = createApp();

// Verify DB connection on startup
try {
  const sql = getDb();
  await sql`SELECT 1`;
  await ensureRuntimeSchema();
  console.log(`[coworker-be] DB connected: ${config.db.host}:${config.db.port}/${config.db.database}`);
} catch (err) {
  console.error('[coworker-be] DB connection failed:', err);
  process.exit(1);
}

console.log(`[coworker-be] listening on :${config.port}`);
console.log(`[coworker-be] service npub: ${identity.npub}`);

export default {
  port: config.port,
  fetch: app.fetch,
};
