import { getDb } from '../db';
import { type Sql, projectorEnabled } from './notification-core';
import { processIntakeBatch, tombstoneItem } from './notification-projector';

export const workerStatus = {
  running: false, startedAt: null as string | null, lastTickAt: null as string | null, lastMaintenanceAt: null as string | null,
  lastError: null as string | null, ticks: 0, projected: 0, failed: 0, dead: 0,
};

const intEnv = (name: string, fallback: number) => {
  const value = Number(Bun.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export async function queueStats(sql: Sql, workspaceId: string) {
  const [row] = await sql<{ depth: number; leased: number; dead: number; oldest_age_s: number | null }[]>`
    SELECT COUNT(*) FILTER (WHERE state IN ('pending','leased'))::int AS depth,
           COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
           COUNT(*) FILTER (WHERE state = 'dead')::int AS dead,
           EXTRACT(EPOCH FROM NOW() - MIN(created_at) FILTER (WHERE state IN ('pending','leased')))::int AS oldest_age_s
    FROM flightdeck_pg_notification_intake WHERE workspace_id = ${workspaceId}`;
  return { ...row!, worker: { ...workerStatus, enabled: projectorEnabled() } };
}

/** Retention and bounded cleanup. Safe to run repeatedly; each run touches at most `batch` rows per rule. */
export async function runMaintenance(sql: Sql = getDb(), batch = 500) {
  const doomed = await sql<{ id: string; workspace_id: string; recipient_actor_id: string }[]>`
    SELECT id, workspace_id, recipient_actor_id FROM flightdeck_pg_notification_items
    WHERE removed_at IS NULL AND (
      (expires_at IS NOT NULL AND expires_at < NOW())
      OR ((read_at IS NOT NULL OR dismissed_at IS NOT NULL OR status = 'resolved') AND archived_at IS NULL AND updated_at < NOW() - INTERVAL '90 days')
      OR (read_at IS NULL AND severity IN ('low','normal') AND created_at < NOW() - INTERVAL '180 days')
      OR (read_at IS NULL AND severity IN ('high','critical') AND created_at < NOW() - INTERVAL '365 days')
      OR (archived_at IS NOT NULL AND archived_at < NOW() - INTERVAL '2 years')
    ) ORDER BY workspace_id, recipient_actor_id, id LIMIT ${batch}`;
  if (doomed.length) {
    await sql.begin(async (tx) => {
      for (const item of doomed) await tombstoneItem(tx as unknown as Sql, item.workspace_id, item.recipient_actor_id, item.id, 'expired');
    });
  }
  // Tombstones are kept 30 days; the floor advances so older cursors get 410 reset_required.
  await sql`
    WITH gone AS (
      DELETE FROM flightdeck_pg_notification_items WHERE id IN (
        SELECT id FROM flightdeck_pg_notification_items WHERE removed_at < NOW() - INTERVAL '30 days' LIMIT ${batch}
      ) RETURNING workspace_id, recipient_actor_id, change_seq
    )
    UPDATE flightdeck_pg_notification_cursors c SET tombstone_floor_seq = GREATEST(c.tombstone_floor_seq, g.m)
    FROM (SELECT workspace_id, recipient_actor_id, MAX(change_seq) AS m FROM gone GROUP BY 1, 2) g
    WHERE c.workspace_id = g.workspace_id AND c.actor_id = g.recipient_actor_id`;
  await sql`DELETE FROM flightdeck_pg_notification_intake WHERE id IN (SELECT id FROM flightdeck_pg_notification_intake WHERE state = 'done' AND done_at < NOW() - INTERVAL '14 days' LIMIT ${batch})`;
  await sql`DELETE FROM flightdeck_pg_notification_events WHERE id IN (SELECT id FROM flightdeck_pg_notification_events WHERE created_at < NOW() - INTERVAL '180 days' LIMIT ${batch})`;
  await sql`DELETE FROM flightdeck_pg_notification_mutations WHERE created_at < NOW() - INTERVAL '30 days'`;
  await sql`DELETE FROM flightdeck_pg_notification_audit WHERE created_at < NOW() - INTERVAL '90 days'`;
  workerStatus.lastMaintenanceAt = new Date().toISOString();
  return { tombstoned: doomed.length };
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
let lastMaintenance = 0;

/** Starts the projection loop inside the server process. Idempotent. Returns a stop function. */
export function startNotificationWorker(sql: Sql = getDb()) {
  if (timer) return stopNotificationWorker;
  if (!projectorEnabled()) {
    console.log('[notifications] projector disabled by NOTIF_PROJECTOR=off');
    return stopNotificationWorker;
  }
  workerStatus.running = true;
  workerStatus.startedAt = new Date().toISOString();
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (let i = 0; i < 10; i += 1) {
        const stats = await processIntakeBatch({ sql, limit: 25 });
        workerStatus.projected += stats.done;
        workerStatus.failed += stats.failed;
        workerStatus.dead += stats.dead;
        if (stats.claimed === 0) break;
      }
      workerStatus.ticks += 1;
      workerStatus.lastTickAt = new Date().toISOString();
      workerStatus.lastError = null;
      if (Date.now() - lastMaintenance > intEnv('NOTIF_MAINTENANCE_MS', 10 * 60_000)) {
        lastMaintenance = Date.now();
        await runMaintenance(sql);
      }
    } catch (error) {
      workerStatus.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      console.error('[notifications] worker tick failed:', workerStatus.lastError);
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, intEnv('NOTIF_POLL_MS', 1000));
  void tick();
  console.log('[notifications] projection worker started');
  return stopNotificationWorker;
}

export function stopNotificationWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  workerStatus.running = false;
}
