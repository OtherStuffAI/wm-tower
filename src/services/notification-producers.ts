import { getDb } from '../db';
import {
  type Sql, NotificationError, RESERVED_CATEGORIES, CORE_SOURCE, asJson, hashOf, isUuid, plainText,
} from './notification-core';
import { tombstoneItem } from './notification-projector';

export type SourceRow = {
  workspace_id: string; source_app_id: string; kind: string; display_name: string; producer_signer_npub: string; grant_status: string;
  grant_version: number; allowed_recipient_mode: string; allowed_recipient_actor_ids: string[]; allowed_client_apps: string[];
  max_severity: string; rate_per_minute: number;
};

const SEVERITY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2, critical: 3 };
const EVENT_KEY_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
const MAX_BODY_BYTES = 16 * 1024;
const SUBJECT_KINDS = new Set(['app_object', 'workspace']);
const EVENT_FIELDS = new Set([
  'schema', 'version', 'event_key', 'op', 'category', 'severity', 'occurred_at', 'subject', 'recipients', 'audience', 'group_key',
  'target_event_key', 'action', 'expires_at', 'source_app_id', 'presentation', 'title', 'body', 'payload',
]);
const TEXT_FIELDS = ['presentation', 'title', 'body', 'payload'];

export async function resolveProducerGrant(sql: Sql, workspaceId: string, signers: string[]): Promise<SourceRow | null> {
  const [row] = await sql<SourceRow[]>`
    SELECT * FROM flightdeck_pg_notification_sources WHERE workspace_id = ${workspaceId} AND producer_signer_npub = ANY(${signers}::text[]) LIMIT 1`;
  return row ?? null;
}

async function audit(sql: Sql, workspaceId: string, source: string | null, signer: string, action: string, outcome: string, code: string | null, hash: string | null) {
  await sql`INSERT INTO flightdeck_pg_notification_audit (workspace_id, source_app_id, signer_npub, action, outcome, error_code, payload_hash)
    VALUES (${workspaceId}, ${source}, ${signer}, ${action}, ${outcome}, ${code}, ${hash})`;
}

export async function grantSummary(sql: Sql, source: SourceRow) {
  const categories = await sql`
    SELECT category, label, default_severity, default_inbox, default_alert, grouping FROM flightdeck_pg_notification_categories
    WHERE workspace_id = ${source.workspace_id} AND source_app_id = ${source.source_app_id} ORDER BY category`;
  return {
    source_app_id: source.source_app_id, kind: source.kind, display_name: source.display_name, grant_status: source.grant_status,
    grant_version: source.grant_version, allowed_recipient_mode: source.allowed_recipient_mode, allowed_client_apps: source.allowed_client_apps,
    max_severity: source.max_severity, rate_per_minute: source.rate_per_minute, categories,
  };
}

function parseTime(value: unknown, field: string): Date | null {
  if (value == null) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new NotificationError(400, 'validation_error', `${field} must be an ISO timestamp`);
  return date;
}

export async function ingestProducerEvent(
  sql: Sql,
  input: { workspaceId: string; signers: string[]; rawBytes: number; body: Record<string, any> },
) {
  const signer = input.signers[0] ?? 'unknown';
  const body = input.body;
  const hash = hashOf(body);
  const reject = async (status: ConstructorParameters<typeof NotificationError>[0], code: string, source: string | null = null, message?: string): Promise<never> => {
    await audit(sql, input.workspaceId, source, signer, 'event.ingest', 'rejected', code, hash).catch(() => undefined);
    throw new NotificationError(status, code, message);
  };

  if (input.rawBytes > MAX_BODY_BYTES) return reject(413, 'payload_too_large');
  const source = await resolveProducerGrant(sql, input.workspaceId, input.signers);
  if (!source) return reject(403, 'source_not_registered');
  if (source.grant_status !== 'active') return reject(403, 'source_not_active', source.source_app_id);
  if (body.source_app_id !== undefined && body.source_app_id !== source.source_app_id) {
    return reject(403, body.source_app_id === CORE_SOURCE ? 'reserved_source' : 'source_mismatch', source.source_app_id);
  }
  for (const key of Object.keys(body)) if (!EVENT_FIELDS.has(key)) return reject(400, 'validation_error', source.source_app_id, `unknown field ${key}`);
  if (body.schema !== undefined && body.schema !== 'org.wingman.notification.event') return reject(400, 'validation_error', source.source_app_id, 'unsupported schema');
  if (body.version !== undefined && body.version !== 1) return reject(400, 'validation_error', source.source_app_id, 'unsupported version');
  if (typeof body.event_key !== 'string' || !EVENT_KEY_RE.test(body.event_key)) return reject(400, 'validation_error', source.source_app_id, 'event_key must match [A-Za-z0-9:_.-]{1,128}');
  const op = body.op ?? 'publish';
  if (!['publish', 'resolve', 'withdraw'].includes(op)) return reject(400, 'validation_error', source.source_app_id, 'op must be publish, resolve or withdraw');

  const category = typeof body.category === 'string' ? body.category : '';
  if (op === 'publish' || op === 'resolve') {
    if (RESERVED_CATEGORIES.has(category)) return reject(403, 'reserved_source', source.source_app_id);
    const [cat] = await sql`SELECT 1 FROM flightdeck_pg_notification_categories WHERE workspace_id = ${input.workspaceId} AND source_app_id = ${source.source_app_id} AND category = ${category}`;
    if (!cat) return reject(403, 'category_not_granted', source.source_app_id);
  }
  const severity = body.severity ?? 'normal';
  if (!(severity in SEVERITY_RANK) || SEVERITY_RANK[severity]! > SEVERITY_RANK[source.max_severity]!) return reject(403, 'severity_not_allowed', source.source_app_id);

  const [{ count }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM flightdeck_pg_notification_events
    WHERE workspace_id = ${input.workspaceId} AND source_app_id = ${source.source_app_id} AND created_at > NOW() - INTERVAL '1 minute'` as { count: number }[];
  if (count >= source.rate_per_minute) {
    await audit(sql, input.workspaceId, source.source_app_id, signer, 'event.ingest', 'rejected', 'rate_limited', hash).catch(() => undefined);
    throw new NotificationError(429, 'rate_limited', 'Producer rate limit exceeded', { retry_after: 60 });
  }

  let recipients: Record<string, unknown> = {};
  let subject: Record<string, unknown> = {};
  let actorIds: string[] = [];
  if (op === 'publish') {
    subject = body.subject ?? {};
    if (!subject || typeof subject !== 'object' || !SUBJECT_KINDS.has(String((subject as any).kind))) return reject(400, 'subject_kind_not_allowed', source.source_app_id, 'external producers may publish app_object or workspace subjects');
    if ((subject as any).kind === 'app_object' && (typeof (subject as any).object_id !== 'string' || (subject as any).app_id !== undefined && (subject as any).app_id !== source.source_app_id)) {
      return reject(400, 'validation_error', source.source_app_id, 'subject.app_id must equal the source and object_id is required');
    }
    const rec = body.recipients;
    if (!rec || rec.mode !== 'actors' || !Array.isArray(rec.actor_ids) || rec.actor_ids.length < 1 || rec.actor_ids.length > 500 || !rec.actor_ids.every(isUuid)) {
      return reject(400, 'validation_error', source.source_app_id, 'recipients must be {mode:"actors", actor_ids:[1..500 uuids]}');
    }
    actorIds = [...new Set<string>(rec.actor_ids)];
    if (source.allowed_recipient_mode === 'actor_list' && !actorIds.every((id) => source.allowed_recipient_actor_ids.includes(id))) return reject(403, 'recipient_not_allowed', source.source_app_id);
    if (source.allowed_recipient_mode === 'owner_only') {
      const owners = await sql<{ actor_id: string }[]>`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id = ${input.workspaceId} AND role = 'owner' AND actor_id = ANY(${actorIds}::uuid[])`;
      if (owners.length !== actorIds.length) return reject(403, 'recipient_not_allowed', source.source_app_id);
    }
    recipients = { mode: 'actors', actor_ids: actorIds };
    const clientApps = body.audience?.client_apps;
    if (clientApps !== undefined && (!Array.isArray(clientApps) || !clientApps.every((c: unknown) => typeof c === 'string' && /^[a-z*][a-z0-9_.*-]{0,63}$/.test(c as string)))) {
      return reject(400, 'validation_error', source.source_app_id, 'audience.client_apps must be slugs');
    }
    if (clientApps && !clientApps.includes('*') && !source.allowed_client_apps.includes('*') && !clientApps.every((c: string) => source.allowed_client_apps.includes(c))) {
      return reject(403, 'client_app_not_allowed', source.source_app_id);
    }
    if (body.action?.target?.kind && !['app_object', 'workspace'].includes(body.action.target.kind)) return reject(400, 'validation_error', source.source_app_id, 'action.target.kind not allowed for external producers');
  }
  if ((op === 'resolve') && (typeof body.group_key !== 'string' || !body.group_key)) return reject(400, 'validation_error', source.source_app_id, 'resolve requires group_key');
  if ((op === 'withdraw') && (typeof body.target_event_key !== 'string' || !EVENT_KEY_RE.test(body.target_event_key))) return reject(400, 'validation_error', source.source_app_id, 'withdraw requires target_event_key');
  const groupKey = body.group_key == null ? null : plainText(body.group_key, 128);
  const occurredAt = parseTime(body.occurred_at, 'occurred_at') ?? new Date();
  const expiresAt = parseTime(body.expires_at, 'expires_at');

  const presentationDowngraded = TEXT_FIELDS.some((f) => body[f] !== undefined);
  const canonical = { ...body };
  const payloadHash = hashOf(canonical);

  return sql.begin(async (txn) => {
    const tx = txn as unknown as Sql;
    const [existing] = await tx<{ id: string; payload_hash: string; state: string; event_key: string; recipient_count: number | null }[]>`
      SELECT id, payload_hash, state, event_key, recipient_count FROM flightdeck_pg_notification_events
      WHERE workspace_id = ${input.workspaceId} AND source_app_id = ${source.source_app_id} AND event_key = ${body.event_key}`;
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        await audit(tx, input.workspaceId, source.source_app_id, signer, 'event.ingest', 'rejected', 'event_key_reused', payloadHash);
        throw new NotificationError(409, 'event_key_reused', 'event_key was already used with a different payload');
      }
      return { status: 200 as const, body: { event: { id: existing.id, state: existing.state, event_key: existing.event_key }, replayed: true, presentation_downgraded: presentationDowngraded } };
    }
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO flightdeck_pg_notification_events (
        workspace_id, source_app_id, event_key, op, category, severity, subject, recipients, audience, action, group_key, target_event_key,
        payload_hash, producer_kind, producer_signer_npub, occurred_at, expires_at
      ) VALUES (
        ${input.workspaceId}, ${source.source_app_id}, ${body.event_key}, ${op}, ${category || 'withdraw'}, ${severity}, ${tx.json(asJson(subject))},
        ${tx.json(asJson(recipients))}, ${tx.json(asJson({ client_apps: body.audience?.client_apps ?? ['*'] }))},
        ${body.action ? tx.json(asJson({ type: 'open', target: body.action.target ?? null })) : null}, ${groupKey}, ${body.target_event_key ?? null},
        ${payloadHash}, ${source.kind}, ${signer}, ${occurredAt}, ${expiresAt}
      ) RETURNING id`;
    await tx`INSERT INTO flightdeck_pg_notification_intake (workspace_id, kind, event_id) VALUES (${input.workspaceId}, 'event', ${created!.id})`;
    await audit(tx, input.workspaceId, source.source_app_id, signer, 'event.ingest', 'accepted', null, payloadHash);
    return { status: 201 as const, body: { event: { id: created!.id, state: 'accepted', event_key: body.event_key }, replayed: false, presentation_downgraded: presentationDowngraded } };
  });
}

export async function getProducerEvent(sql: Sql, workspaceId: string, signers: string[], eventId: string) {
  const source = await resolveProducerGrant(sql, workspaceId, signers);
  if (!source || !isUuid(eventId)) throw new NotificationError(404, 'event_not_found');
  const [event] = await sql`
    SELECT id, event_key, state, op, category, recipient_count, created_at FROM flightdeck_pg_notification_events
    WHERE id = ${eventId} AND workspace_id = ${workspaceId} AND source_app_id = ${source.source_app_id}`;
  if (!event) throw new NotificationError(404, 'event_not_found');
  return event;
}

// --- Owner/admin lifecycle -------------------------------------------------------------------------------------
export type SourceInput = {
  kind: string; display_name: string; producer_signer_npub: string; allowed_recipient_mode: string; allowed_recipient_actor_ids: string[];
  allowed_client_apps: string[]; max_severity: string; rate_per_minute: number;
  categories: { category: string; label: string; default_severity: string; grouping: string; default_inbox: string; default_alert: string }[];
};

export async function upsertSource(sql: Sql, workspaceId: string, sourceAppId: string, approvedBy: string, input: SourceInput) {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(sourceAppId) || sourceAppId === CORE_SOURCE) throw new NotificationError(400, 'reserved_source', 'source_app_id is invalid or reserved');
  for (const c of input.categories) {
    if (RESERVED_CATEGORIES.has(c.category)) throw new NotificationError(403, 'reserved_source', `${c.category} is reserved`);
  }
  return sql.begin(async (txn) => {
    const tx = txn as unknown as Sql;
    if (input.allowed_recipient_actor_ids.length) {
      const ids = [...new Set(input.allowed_recipient_actor_ids)];
      const members = await tx<{ actor_id: string }[]>`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id = ${workspaceId} AND actor_id = ANY(${ids}::uuid[])`;
      const missing = ids.filter((id) => !members.some((m) => m.actor_id === id));
      if (missing.length) throw new NotificationError(400, 'recipient_not_member', 'allowed_recipient_actor_ids must all be workspace members', { actor_ids: missing });
    }
    const [clash] = await tx`SELECT source_app_id FROM flightdeck_pg_notification_sources WHERE workspace_id = ${workspaceId} AND producer_signer_npub = ${input.producer_signer_npub} AND source_app_id <> ${sourceAppId}`;
    if (clash) throw new NotificationError(409, 'signer_already_bound', 'This signer is already bound to another source');
    const [existing] = await tx<{ producer_signer_npub: string; grant_status: string }[]>`SELECT producer_signer_npub, grant_status FROM flightdeck_pg_notification_sources WHERE workspace_id = ${workspaceId} AND source_app_id = ${sourceAppId} FOR UPDATE`;
    if (existing?.grant_status === 'revoked') throw new NotificationError(409, 'source_revoked', 'A revoked source cannot be re-registered; choose a new source_app_id');
    await tx`
      INSERT INTO flightdeck_pg_notification_sources (
        workspace_id, source_app_id, kind, display_name, producer_signer_npub, allowed_recipient_mode, allowed_recipient_actor_ids,
        allowed_client_apps, max_severity, rate_per_minute, approved_by_actor_id
      ) VALUES (
        ${workspaceId}, ${sourceAppId}, ${input.kind}, ${plainText(input.display_name, 80)}, ${input.producer_signer_npub}, ${input.allowed_recipient_mode},
        ${input.allowed_recipient_actor_ids}::uuid[], ${input.allowed_client_apps}::text[], ${input.max_severity}, ${input.rate_per_minute}, ${approvedBy}
      )
      ON CONFLICT (workspace_id, source_app_id) DO UPDATE SET
        kind = EXCLUDED.kind, display_name = EXCLUDED.display_name, producer_signer_npub = EXCLUDED.producer_signer_npub,
        allowed_recipient_mode = EXCLUDED.allowed_recipient_mode, allowed_recipient_actor_ids = EXCLUDED.allowed_recipient_actor_ids,
        allowed_client_apps = EXCLUDED.allowed_client_apps, max_severity = EXCLUDED.max_severity, rate_per_minute = EXCLUDED.rate_per_minute,
        grant_version = CASE WHEN flightdeck_pg_notification_sources.producer_signer_npub <> EXCLUDED.producer_signer_npub
          THEN flightdeck_pg_notification_sources.grant_version + 1 ELSE flightdeck_pg_notification_sources.grant_version END,
        approved_by_actor_id = EXCLUDED.approved_by_actor_id, updated_at = NOW()`;
    for (const c of input.categories) {
      await tx`
        INSERT INTO flightdeck_pg_notification_categories (workspace_id, source_app_id, category, label, default_severity, default_inbox, default_alert, grouping)
        VALUES (${workspaceId}, ${sourceAppId}, ${c.category}, ${plainText(c.label, 80)}, ${c.default_severity}, ${c.default_inbox}, ${c.default_alert}, ${c.grouping})
        ON CONFLICT (workspace_id, source_app_id, category) DO UPDATE SET label = EXCLUDED.label, default_severity = EXCLUDED.default_severity,
          default_inbox = EXCLUDED.default_inbox, default_alert = EXCLUDED.default_alert, grouping = EXCLUDED.grouping`;
    }
    const [row] = await tx<SourceRow[]>`SELECT * FROM flightdeck_pg_notification_sources WHERE workspace_id = ${workspaceId} AND source_app_id = ${sourceAppId}`;
    return row!;
  });
}

export async function listSources(sql: Sql, workspaceId: string) {
  const rows = await sql<SourceRow[]>`SELECT * FROM flightdeck_pg_notification_sources WHERE workspace_id = ${workspaceId} ORDER BY source_app_id`;
  return Promise.all(rows.map((row) => grantSummary(sql, row)));
}

export async function setSourceStatus(sql: Sql, workspaceId: string, sourceAppId: string, status: 'disabled' | 'revoked') {
  return sql.begin(async (txn) => {
    const tx = txn as unknown as Sql;
    const [row] = await tx<SourceRow[]>`
      UPDATE flightdeck_pg_notification_sources SET grant_status = ${status}, grant_version = grant_version + 1, updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND source_app_id = ${sourceAppId} AND grant_status <> 'revoked' RETURNING *`;
    if (!row) throw new NotificationError(404, 'source_not_found');
    let tombstoned = 0;
    if (status === 'revoked') {
      // Revocation stops new events immediately and tombstones existing items with content-free removals.
      // Canonical order: recipients ascending (tombstoneItem takes each recipient lock before its item row).
      const items = await tx<{ id: string; recipient_actor_id: string }[]>`
        SELECT id, recipient_actor_id FROM flightdeck_pg_notification_items
        WHERE workspace_id = ${workspaceId} AND source_app_id = ${sourceAppId} AND removed_at IS NULL ORDER BY recipient_actor_id, id`;
      for (const item of items) await tombstoneItem(tx, workspaceId, item.recipient_actor_id, item.id, 'source_revoked');
      await tx`UPDATE flightdeck_pg_notification_intake SET state = 'done', done_at = NOW(), last_error = 'source_revoked'
        WHERE state IN ('pending', 'leased') AND kind = 'event' AND event_id IN (SELECT id FROM flightdeck_pg_notification_events WHERE workspace_id = ${workspaceId} AND source_app_id = ${sourceAppId})`;
      tombstoned = items.length;
    }
    return { source: await grantSummary(tx, row), tombstoned };
  });
}
