import { ensureServiceIdentity } from './service-identity';
import { startFipsIngress } from './fips-ingress';

const identity = await ensureServiceIdentity();

const [{ createApp }, { config }, { getDb }, { ensureRuntimeSchema }, { startHostingBillingRunner }, { startNotificationWorker }] = await Promise.all([
  import('./server'),
  import('./config'),
  import('./db'),
  import('./schema/ensure-runtime-schema'),
  import('./services/hosting-billing'),
  import('./services/notification-worker'),
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

startHostingBillingRunner();
// Durable notification projection runs in this process (NOTIF_PROJECTOR=off disables it).
startNotificationWorker();
// Durable push alert delivery (NOTIF_ALERTS=off disables); idle unless APNs is fully configured.
const { startAlertWorker } = await import('./services/notification-alerts');
startAlertWorker();

console.log(`[coworker-be] listening on :${config.port}`);
console.log(`[coworker-be] service npub: ${identity.npub}`);

// Optional dedicated ingress (native mesh or Docker seam); shares app/DB/SSE hub.
startFipsIngress(app.fetch);

export default {
  port: config.port,
  fetch: app.fetch,
};
