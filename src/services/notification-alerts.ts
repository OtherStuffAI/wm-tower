import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import {
  CORE_SOURCE, categoryDef, isUuid, plainText, type RuleMode, type Sql,
} from './notification-core';
import {
  buildApnsPayload, classifyApnsResult, collapseIdFor, loadApnsConfig, resetApnsJwtCache, sendApns,
  type ApnsConfig, type ApnsSender,
} from './notification-apns';
import { getCounts, loadAccessKeys, sweepRecipient } from './notification-inbox';

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const DEADLINE_MS = 24 * 3600_000;
const BREAKER_MS = 5 * 60_000;
const PARALLEL = 8;

export const alertsEnabled = () => (Bun.env.NOTIF_ALERTS ?? 'on').toLowerCase() !== 'off';

export const alertStatus = {
  running: false, lastTickAt: null as string | null, lastError: null as string | null,
  sent: 0, suppressed: 0, failed: 0, dead: 0, breakerOpenUntil: 0,
};

// ---------------------------------------------------------------------------------------------------------------
// Preferences: per-app alert rule resolution. Most specific (source, category) wins; within a level a rule for the
// installation's own client app beats '*'; `off` wins on a tie. Mirrors flightdeck_pg_notification_item_visible.
// ---------------------------------------------------------------------------------------------------------------
export type AlertRule = { source_app_id: string; category: string; client_app_id: string; mode: RuleMode; preview: string | null };

export function resolveAlertRule(rules: AlertRule[], source: string, category: string, clientApp: string, fallback: 'on' | 'off'): { mode: 'on' | 'off'; preview: string | null } {
  const matching = rules.filter((r) => r.mode !== 'default'
    && (r.source_app_id === source || r.source_app_id === '*') && (r.category === category || r.category === '*') && (r.client_app_id === clientApp || r.client_app_id === '*'));
  if (!matching.length) return { mode: fallback, preview: null };
  const rank = (r: AlertRule) => (r.source_app_id === source ? 0 : 2) + (r.category === category ? 0 : 1);
  matching.sort((a, b) => rank(a) - rank(b) || (a.client_app_id === clientApp ? 0 : 1) - (b.client_app_id === clientApp ? 0 : 1) || (a.mode === 'off' ? 0 : 1) - (b.mode === 'off' ? 0 : 1));
  const top = matching[0]!;
  return { mode: top.mode as 'on' | 'off', preview: top.preview };
}

async function loadAlertRules(sql: Sql, workspaceId: string, actorId: string): Promise<AlertRule[]> {
  return sql<AlertRule[]>`
    SELECT source_app_id, category, client_app_id, mode, preview FROM flightdeck_pg_notification_rules
    WHERE workspace_id = ${workspaceId} AND actor_id = ${actorId} AND channel = 'alert'`;
}

async function categoryDefaultAlert(sql: Sql, workspaceId: string, source: string, category: string): Promise<'on' | 'off'> {
  if (source === CORE_SOURCE) return categoryDef(category)?.default_alert ?? 'off';
  const [row] = await sql<{ default_alert: 'on' | 'off' }[]>`
    SELECT default_alert FROM flightdeck_pg_notification_categories WHERE workspace_id = ${workspaceId} AND source_app_id = ${source} AND category = ${category}`;
  return row?.default_alert ?? 'off';
}

const audienceAllows = (audience: string[], clientApp: string) => audience.includes('*') || audience.includes(clientApp);

type ItemFacts = {
  id: string; workspace_id: string; recipient_actor_id: string; source_app_id: string; category: string; audience_client_apps: string[];
  expires_at: Date | null; read_at: Date | null; dismissed_at: Date | null; archived_at: Date | null; removed_at: Date | null; status: string;
  group_key: string | null; change_seq: string; subject: Record<string, unknown>; presentation: Record<string, unknown>; acl_family: string | null; acl_channel_id: string | null;
};

// ---------------------------------------------------------------------------------------------------------------
// Creation: runs inside the item-write transaction, so an alert exists iff its item committed.
// ---------------------------------------------------------------------------------------------------------------
/**
 * Queues at most one alert per eligible transport. Nothing is queued while the provider is not ready (the inbox still works).
 * `refold` = the item absorbed another event: it re-alerts under a new generation only when the previous alert already left the
 * queue (a still-pending alert is rebuilt from the item at send time, so it needs no sibling).
 */
export async function enqueueAlerts(tx: Sql, itemId: string, refold: boolean): Promise<number> {
  if (!alertsEnabled()) return 0;
  const readiness = loadApnsConfig();
  if (!readiness.ready) return 0;
  const config = readiness.config;
  const [item] = await tx<ItemFacts[]>`SELECT * FROM flightdeck_pg_notification_items WHERE id = ${itemId}`;
  if (!item || item.removed_at || item.read_at || item.dismissed_at || item.archived_at || item.status !== 'active') return 0;
  if (item.expires_at && new Date(item.expires_at).getTime() <= Date.now()) return 0;

  const candidates = await tx<{ transport_id: string; client_app_id: string; environment: string; bundle_id: string }[]>`
    SELECT t.id AS transport_id, i.client_app_id, t.environment, t.bundle_id
    FROM flightdeck_pg_notification_transports t
    JOIN flightdeck_pg_notification_installations i ON i.id = t.installation_id
    WHERE t.kind = 'apns' AND t.status = 'active' AND t.lease_expires_at > NOW() AND t.actor_id = ${item.recipient_actor_id}
      AND i.actor_id = ${item.recipient_actor_id} AND i.status = 'active' AND i.permission_state <> 'denied'
      AND ${item.workspace_id}::uuid = ANY(i.enrolled_workspace_ids)`;
  if (!candidates.length) return 0;

  const rules = await loadAlertRules(tx, item.workspace_id, item.recipient_actor_id);
  const fallback = await categoryDefaultAlert(tx, item.workspace_id, item.source_app_id, item.category);
  const deadline = new Date(Math.min(Date.now() + DEADLINE_MS, item.expires_at ? new Date(item.expires_at).getTime() : Infinity));
  let queued = 0;
  for (const c of candidates) {
    if (!config.environments.has(c.environment as 'sandbox' | 'production') || !config.topics.has(c.bundle_id)) continue;
    if (!audienceAllows(item.audience_client_apps, c.client_app_id)) continue;
    if (resolveAlertRule(rules, item.source_app_id, item.category, c.client_app_id, fallback).mode !== 'on') continue;
    const [last] = await tx<{ generation: number; state: string }[]>`
      SELECT generation, state FROM flightdeck_pg_notification_alerts WHERE item_id = ${item.id} AND transport_id = ${c.transport_id} ORDER BY generation DESC LIMIT 1`;
    if (last && (!refold || ['pending', 'leased', 'failed'].includes(last.state))) continue;
    const rows = await tx`
      INSERT INTO flightdeck_pg_notification_alerts (workspace_id, item_id, recipient_actor_id, transport_id, generation, deadline_at)
      VALUES (${item.workspace_id}, ${item.id}, ${item.recipient_actor_id}, ${c.transport_id}, ${(last?.generation ?? 0) + 1}, ${deadline})
      ON CONFLICT (item_id, transport_id, generation) DO NOTHING RETURNING id`;
    queued += rows.length;
  }
  return queued;
}

/** Projection must never fail because of the push queue: errors are contained in a savepoint. */
export async function enqueueAlertsSafe(tx: Sql, itemId: string, refold: boolean) {
  try {
    return await tx.savepoint(async (sp) => enqueueAlerts(sp as unknown as Sql, itemId, refold));
  } catch (error) {
    console.error('[notifications] alert enqueue failed:', (error instanceof Error ? error.message : String(error)).slice(0, 200));
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------------------------
type Claimed = {
  id: string; workspace_id: string; item_id: string; recipient_actor_id: string; transport_id: string; generation: number;
  attempt_count: number; deadline_at: Date;
};

export type AlertBatchStats = { claimed: number; sent: number; suppressed: number; retried: number; dead: number; skipped: number };

export function backoffMs(attempt: number, random = Math.random()) {
  const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!;
  return Math.round(base * (0.8 + random * 0.4));
}

async function claim(sql: Sql, owner: string, limit: number): Promise<Claimed[]> {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    // A crashed worker leaves `leased` rows (and possibly a write-ahead attempt): both are recovered here.
    await tx`
      UPDATE flightdeck_pg_notification_alert_attempts SET outcome = 'interrupted', finished_at = NOW()
      WHERE outcome = 'started' AND alert_id IN (SELECT id FROM flightdeck_pg_notification_alerts WHERE state = 'leased' AND lease_until < NOW())`;
    return tx<Claimed[]>`
      WITH due AS (
        SELECT id FROM flightdeck_pg_notification_alerts
        WHERE (state IN ('pending', 'failed') AND next_attempt_at <= NOW() AND not_before <= NOW()) OR (state = 'leased' AND lease_until < NOW())
        ORDER BY next_attempt_at, created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      UPDATE flightdeck_pg_notification_alerts a SET state = 'leased', lease_owner = ${owner}, lease_until = NOW() + make_interval(secs => ${LEASE_MS / 1000})
      FROM due WHERE a.id = due.id
      RETURNING a.id, a.workspace_id, a.item_id, a.recipient_actor_id, a.transport_id, a.generation, a.attempt_count, a.deadline_at`;
  });
}

type Settle = { state: 'pending' | 'failed' | 'sent' | 'suppressed' | 'dead'; reason?: string | null; nextInMs?: number; providerStatus?: number | null; errorClass?: string | null; consumeAttempt?: boolean };

async function settle(sql: Sql, alert: Claimed, owner: string, outcome: Settle): Promise<boolean> {
  const next = new Date(Date.now() + (outcome.nextInMs ?? 0));
  const rows = await sql`
    UPDATE flightdeck_pg_notification_alerts SET
      state = ${outcome.state}, reason = ${outcome.reason ?? null}, lease_owner = NULL, lease_until = NULL, next_attempt_at = ${next},
      provider_status = ${outcome.providerStatus ?? null}, error_class = ${outcome.errorClass ?? null},
      sent_at = ${outcome.state === 'sent' ? new Date() : null}
    WHERE id = ${alert.id} AND lease_owner = ${owner} AND state = 'leased' RETURNING id`;
  return rows.length > 0;
}

type Gate = { ok: true; item: ItemFacts; transport: any; installation: any; config: ApnsConfig; preview: string | null } | { ok: false; reason: string };

/**
 * Late checks, after claim and before the provider call. Everything that could have changed since creation is read fresh:
 * transport lease/status/owner, enrollment, membership, item state, record access, source grant, audience and alert rules.
 */
async function gate(sql: Sql, alert: Claimed, config: ApnsConfig): Promise<Gate> {
  const [row] = await sql<any[]>`
    SELECT t.address, t.status AS t_status, t.lease_expires_at, t.actor_id AS t_actor, t.environment, t.bundle_id, t.preview AS t_preview, t.registered_origin,
           i.status AS i_status, i.actor_id AS i_actor, i.permission_state, i.enrolled_workspace_ids, i.client_app_id
    FROM flightdeck_pg_notification_transports t JOIN flightdeck_pg_notification_installations i ON i.id = t.installation_id
    WHERE t.id = ${alert.transport_id}`;
  if (!row) return { ok: false, reason: 'transport_gone' };
  if (row.t_status !== 'active') return { ok: false, reason: 'transport_revoked' };
  if (new Date(row.lease_expires_at).getTime() <= Date.now()) return { ok: false, reason: 'lease_expired' };
  if (row.t_actor !== alert.recipient_actor_id || row.i_actor !== alert.recipient_actor_id) return { ok: false, reason: 'transport_owner_changed' };
  if (row.i_status !== 'active' || !row.enrolled_workspace_ids.includes(alert.workspace_id)) return { ok: false, reason: 'not_enrolled' };
  if (row.permission_state === 'denied') return { ok: false, reason: 'permission_denied' };
  if (!config.environments.has(row.environment)) return { ok: false, reason: 'environment_not_enabled' };
  if (!config.topics.has(row.bundle_id)) return { ok: false, reason: 'bundle_not_allowed' };
  if (new Date(alert.deadline_at).getTime() <= Date.now()) return { ok: false, reason: 'deadline_passed' };

  const [member] = await sql`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id = ${alert.workspace_id} AND actor_id = ${alert.recipient_actor_id}`;
  if (!member) return { ok: false, reason: 'membership_revoked' };

  const r = { workspaceId: alert.workspace_id, actorId: alert.recipient_actor_id };
  const keys = await loadAccessKeys(sql, r);
  await sweepRecipient(sql, r, keys);
  const [item] = await sql<ItemFacts[]>`SELECT * FROM flightdeck_pg_notification_items WHERE id = ${alert.item_id}`;
  if (!item || item.removed_at) return { ok: false, reason: 'item_removed' };
  if (item.read_at || item.dismissed_at || item.archived_at || item.status !== 'active') return { ok: false, reason: 'read_before_send' };
  if (item.expires_at && new Date(item.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'item_expired' };
  if (item.acl_family && !keys.includes(`channel:${item.acl_channel_id}:${item.acl_family}`)) return { ok: false, reason: 'no_access' };
  if (item.source_app_id !== CORE_SOURCE) {
    const [source] = await sql`SELECT 1 FROM flightdeck_pg_notification_sources WHERE workspace_id = ${alert.workspace_id} AND source_app_id = ${item.source_app_id} AND grant_status = 'active'`;
    if (!source) return { ok: false, reason: 'source_revoked' };
  }
  if (!audienceAllows(item.audience_client_apps, row.client_app_id)) return { ok: false, reason: 'audience_mismatch' };
  const rules = await loadAlertRules(sql, alert.workspace_id, alert.recipient_actor_id);
  const fallback = await categoryDefaultAlert(sql, alert.workspace_id, item.source_app_id, item.category);
  const resolved = resolveAlertRule(rules, item.source_app_id, item.category, row.client_app_id, fallback);
  if (resolved.mode !== 'on') return { ok: false, reason: 'alert_rule_off' };
  const preview = row.t_preview === 'full' && resolved.preview === 'full' ? 'full' : null;
  return { ok: true, item, transport: row, installation: row, config, preview };
}

async function buildContent(sql: Sql, alert: Claimed, g: Extract<Gate, { ok: true }>) {
  const { item, transport, installation } = g;
  const origin = g.config.publicOrigin ?? (typeof transport.registered_origin === 'string' && transport.registered_origin.startsWith('https://') ? transport.registered_origin : null);
  if (!origin) return null;
  const core = item.source_app_id === CORE_SOURCE;
  const ids: Record<string, string> = {};
  if (core) {
    for (const key of ['channel_id', 'thread_id', 'task_id', 'doc_id'] as const) {
      const value = (item.subject as Record<string, unknown>)[key];
      if (isUuid(value)) ids[key] = value.toLowerCase();
    }
  }
  let badge: number | null = null;
  if (installation.enrolled_workspace_ids.length === 1) {
    badge = (await getCounts(sql, { workspaceId: alert.workspace_id, actorId: alert.recipient_actor_id }, { clientAppId: installation.client_app_id })).badge;
  }
  const presentation = item.presentation as { title?: string; body?: string };
  const [ws] = await sql<{ tower_service_npub: string | null }[]>`SELECT tower_service_npub FROM flightdeck_pg_workspaces WHERE id = ${alert.workspace_id}`;
  return {
    towerServiceNpub: ws?.tower_service_npub ?? null,
    workspaceId: alert.workspace_id, itemId: item.id, changeSeq: Number(item.change_seq), sourceAppId: item.source_app_id, category: item.category,
    groupKey: item.group_key, coreSource: core, ids, badge, origin,
    preview: g.preview === 'full' ? { title: plainText(presentation.title, 120), body: plainText(presentation.body, 120) } : null,
  };
}

async function dispatchOne(sql: Sql, alert: Claimed, owner: string, config: ApnsConfig, sender: ApnsSender, stats: AlertBatchStats) {
  const g = await gate(sql, alert, config);
  if (!g.ok) {
    if (await settle(sql, alert, owner, { state: 'suppressed', reason: g.reason })) { stats.suppressed += 1; alertStatus.suppressed += 1; }
    return;
  }
  const content = await buildContent(sql, alert, g);
  if (!content) {
    if (await settle(sql, alert, owner, { state: 'dead', reason: 'origin_unavailable' })) { stats.dead += 1; alertStatus.dead += 1; }
    return;
  }

  // Write-ahead intent: the attempt row exists before any network I/O. A crash after this point may re-send (at-least-once).
  const attemptNo = alert.attempt_count + 1;
  const started = Date.now();
  const marked = await sql`
    UPDATE flightdeck_pg_notification_alerts SET attempt_count = ${attemptNo}, collapse_key = ${collapseIdFor(alert.workspace_id, alert.item_id, content.groupKey)}
    WHERE id = ${alert.id} AND lease_owner = ${owner} AND state = 'leased' RETURNING collapse_key`;
  if (!marked.length) { stats.skipped += 1; return; }
  await sql`INSERT INTO flightdeck_pg_notification_alert_attempts (alert_id, attempt_no) VALUES (${alert.id}, ${attemptNo}) ON CONFLICT DO NOTHING`;

  let outcome: ReturnType<typeof classifyApnsResult> = 'transient';
  let providerStatus: number | null = null;
  let errorClass: string | null = null;
  let retryAfterMs: number | null = null;
  try {
    const result = await sender(config, {
      environment: g.transport.environment, deviceToken: g.transport.address, topic: g.transport.bundle_id,
      collapseId: marked[0]!.collapse_key, expiration: Math.floor(new Date(alert.deadline_at).getTime() / 1000), body: JSON.stringify(buildApnsPayload(content)),
    });
    outcome = classifyApnsResult(result);
    providerStatus = result.status;
    errorClass = result.reason ?? (outcome === 'sent' ? null : `http_${result.status}`);
    retryAfterMs = result.retryAfterMs;
  } catch (error) {
    errorClass = /timeout/i.test(error instanceof Error ? error.message : '') ? 'timeout' : 'network_error';
  }
  const latency = Date.now() - started;
  await sql`
    UPDATE flightdeck_pg_notification_alert_attempts SET finished_at = NOW(), outcome = ${outcome}, provider_status = ${providerStatus}, error_class = ${errorClass}, latency_ms = ${latency}
    WHERE alert_id = ${alert.id} AND attempt_no = ${attemptNo}`;

  if (outcome === 'sent') {
    await sql`UPDATE flightdeck_pg_notification_transports SET last_success_at = NOW(), failure_count = 0 WHERE id = ${alert.transport_id}`;
    if (await settle(sql, alert, owner, { state: 'sent', providerStatus })) { stats.sent += 1; alertStatus.sent += 1; }
    return;
  }
  await sql`UPDATE flightdeck_pg_notification_transports SET last_failure_at = NOW(), failure_count = failure_count + 1 WHERE id = ${alert.transport_id}`;
  if (outcome === 'stale_token') {
    await sql`UPDATE flightdeck_pg_notification_transports SET status = 'stale', updated_at = NOW() WHERE id = ${alert.transport_id} AND status = 'active'`;
    await sql`
      UPDATE flightdeck_pg_notification_alerts SET state = 'suppressed', reason = 'transport_gone', lease_owner = NULL, lease_until = NULL
      WHERE transport_id = ${alert.transport_id} AND id <> ${alert.id} AND state IN ('pending', 'failed')`;
    if (await settle(sql, alert, owner, { state: 'dead', reason: 'transport_gone', providerStatus, errorClass })) { stats.dead += 1; alertStatus.dead += 1; }
    return;
  }
  if (outcome === 'credential') {
    // A credential problem is Tower's, not the alert's: open the breaker, keep the attempt budget, retry after it resets.
    alertStatus.breakerOpenUntil = Date.now() + BREAKER_MS;
    resetApnsJwtCache();
    await sql`UPDATE flightdeck_pg_notification_alerts SET attempt_count = attempt_count - 1 WHERE id = ${alert.id}`;
    if (await settle(sql, alert, owner, { state: 'failed', reason: 'provider_credential', nextInMs: BREAKER_MS, providerStatus, errorClass })) { stats.retried += 1; alertStatus.failed += 1; }
    return;
  }
  if (outcome === 'permanent') {
    if (await settle(sql, alert, owner, { state: 'dead', reason: 'provider_rejected', providerStatus, errorClass })) { stats.dead += 1; alertStatus.dead += 1; }
    return;
  }
  // transient
  const delay = retryAfterMs ?? backoffMs(attemptNo);
  const exhausted = attemptNo >= MAX_ATTEMPTS || Date.now() + delay >= new Date(alert.deadline_at).getTime();
  if (exhausted) {
    if (await settle(sql, alert, owner, { state: 'dead', reason: 'retries_exhausted', providerStatus, errorClass })) { stats.dead += 1; alertStatus.dead += 1; }
  } else if (await settle(sql, alert, owner, { state: 'failed', reason: 'transient', nextInMs: delay, providerStatus, errorClass })) {
    stats.retried += 1; alertStatus.failed += 1;
  }
}

/** Claims due alerts and delivers them. Safe to run from several processes: `SKIP LOCKED` leases give each alert one sender. */
export async function processAlertBatch(opts: { sql?: Sql; limit?: number; sender?: ApnsSender; owner?: string } = {}): Promise<AlertBatchStats> {
  const sql = opts.sql ?? getDb();
  const owner = opts.owner ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  const stats: AlertBatchStats = { claimed: 0, sent: 0, suppressed: 0, retried: 0, dead: 0, skipped: 0 };
  const readiness = loadApnsConfig();
  if (!readiness.ready) return stats;
  if (Date.now() < alertStatus.breakerOpenUntil) return stats;
  const alerts = await claim(sql, owner, opts.limit ?? 25);
  stats.claimed = alerts.length;
  const sender = opts.sender ?? sendApns;
  for (let i = 0; i < alerts.length; i += PARALLEL) {
    await Promise.all(alerts.slice(i, i + PARALLEL).map(async (alert) => {
      try {
        await dispatchOne(sql, alert, owner, readiness.config, sender, stats);
      } catch (error) {
        // Unexpected failure: give the alert back with a backoff rather than leaving it leased.
        alertStatus.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        await settle(sql, alert, owner, { state: 'failed', reason: 'worker_error', nextInMs: backoffMs(Math.max(1, alert.attempt_count)) });
        stats.retried += 1;
      }
    }));
  }
  return stats;
}

export async function alertStats(sql: Sql, workspaceId: string) {
  const rows = await sql<{ state: string; n: number }[]>`
    SELECT state, COUNT(*)::int AS n FROM flightdeck_pg_notification_alerts WHERE workspace_id = ${workspaceId} GROUP BY state`;
  const [oldest] = await sql<{ age: number | null }[]>`
    SELECT EXTRACT(EPOCH FROM NOW() - MIN(created_at))::int AS age FROM flightdeck_pg_notification_alerts WHERE workspace_id = ${workspaceId} AND state IN ('pending', 'failed', 'leased')`;
  const readiness = loadApnsConfig();
  return {
    by_state: Object.fromEntries(rows.map((r) => [r.state, r.n])), oldest_pending_age_s: oldest?.age ?? null,
    provider: readiness.ready ? { ready: true } : { ready: false, reason: readiness.reason },
    worker: { ...alertStatus, enabled: alertsEnabled(), breaker_open: Date.now() < alertStatus.breakerOpenUntil },
  };
}

export async function pruneAlerts(sql: Sql, batch = 500) {
  await sql`DELETE FROM flightdeck_pg_notification_alerts WHERE id IN (
    SELECT id FROM flightdeck_pg_notification_alerts WHERE state IN ('sent', 'suppressed', 'dead') AND created_at < NOW() - INTERVAL '14 days' LIMIT ${batch})`;
}

// ---------------------------------------------------------------------------------------------------------------
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startAlertWorker(sql: Sql = getDb()) {
  if (timer) return stopAlertWorker;
  if (!alertsEnabled()) {
    console.log('[notifications] alert worker disabled by NOTIF_ALERTS=off');
    return stopAlertWorker;
  }
  alertStatus.running = true;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (let i = 0; i < 5; i += 1) {
        const stats = await processAlertBatch({ sql });
        if (stats.claimed === 0) break;
      }
      alertStatus.lastTickAt = new Date().toISOString();
      alertStatus.lastError = null;
    } catch (error) {
      alertStatus.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      console.error('[notifications] alert tick failed:', alertStatus.lastError);
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, Number(Bun.env.NOTIF_ALERT_POLL_MS) > 0 ? Number(Bun.env.NOTIF_ALERT_POLL_MS) : 2000);
  void tick();
  console.log('[notifications] alert worker started');
  return stopAlertWorker;
}

export function stopAlertWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  alertStatus.running = false;
}
