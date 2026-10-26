import { getDb } from '../db';
import {
  type Sql, type RuleRow, type RuleMode, asJson, CORE_CATEGORIES, CORE_SOURCE, CORE_SOURCE_LABEL, INBOX_COUNT_CAP, NotificationError, hashOf, isUuid,
  lockRecipient, signCursor, verifyCursor, categoryDef,
} from './notification-core';
import { tombstoneItem } from './notification-projector';
import { updateFlightDeckPgNotificationPreferences, type FlightDeckPgNotificationPreferenceRow } from './flightdeck-pg-notifications';

export type Recipient = { workspaceId: string; actorId: string };
type ItemRow = Record<string, any>;

export const ITEM_VIEWS = ['inbox', 'unread', 'archived', 'dismissed', 'all'] as const;
type View = typeof ITEM_VIEWS[number];

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value == null ? null : new Date(value as string).toISOString());

// ---------------------------------------------------------------------------------------------------------------
// ACL: the central record-access oracle. Cursors are never authorization proofs; every read re-checks.
// ---------------------------------------------------------------------------------------------------------------
export async function loadAccessKeys(sql: Sql, r: Recipient): Promise<string[]> {
  const [row] = await sql<{ keys: string[] }[]>`
    SELECT ARRAY(SELECT jsonb_array_elements_text(flightdeck_pg_record_access(${r.workspaceId}::uuid, ${r.actorId}::uuid))) AS keys`;
  return row?.keys ?? [];
}

/**
 * Client-app view filter (presentation only, never access authority). One SQL predicate is shared by list, counts,
 * changes and bulk so they cannot disagree. No client_app_id => no app filtering.
 */
const appVisibleSql = (sql: Sql, clientAppId: string | undefined) => clientAppId
  ? sql`flightdeck_pg_notification_item_visible(i.workspace_id, i.recipient_actor_id, i.source_app_id, i.category, i.audience_client_apps, ${clientAppId})`
  : sql`TRUE`;

const visibleSql = (sql: Sql, keys: string[]) => sql`
  (i.removed_at IS NULL AND (i.acl_family IS NULL OR ('channel:' || i.acl_channel_id::text || ':' || i.acl_family) = ANY(${keys}::text[])))`;

/**
 * Tombstones this recipient's items that lost access, whose subject was deleted, whose source was revoked or that expired.
 * Runs before every read so invalidation is immediate and changes the sequence (cursor/recovery context) even when
 * the background sweep has not run.
 */
export async function sweepRecipient(sql: Sql, r: Recipient, keys?: string[]): Promise<number> {
  const accessKeys = keys ?? await loadAccessKeys(sql, r);
  const stale = await sql<{ id: string; reason: string }[]>`
    SELECT i.id,
      CASE
        WHEN i.expires_at IS NOT NULL AND i.expires_at < NOW() THEN 'expired'
        WHEN i.source_app_id <> ${CORE_SOURCE} AND NOT EXISTS (
          SELECT 1 FROM flightdeck_pg_notification_sources s WHERE s.workspace_id = i.workspace_id AND s.source_app_id = i.source_app_id AND s.grant_status <> 'revoked'
        ) THEN 'source_revoked'
        WHEN i.acl_family IS NOT NULL AND ('channel:' || i.acl_channel_id::text || ':' || i.acl_family) <> ALL(${accessKeys}::text[]) THEN 'access_lost'
        WHEN i.source_app_id = ${CORE_SOURCE} AND (
          EXISTS (SELECT 1 FROM flightdeck_pg_messages m WHERE m.workspace_id = i.workspace_id AND m.id::text = i.subject->>'message_id' AND m.deleted_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM flightdeck_pg_task_comments c WHERE c.workspace_id = i.workspace_id AND i.subject->>'kind' = 'task' AND c.id::text = i.subject->>'comment_id' AND c.deleted_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM flightdeck_pg_doc_comments c WHERE c.workspace_id = i.workspace_id AND i.subject->>'kind' = 'doc' AND c.id::text = i.subject->>'comment_id' AND c.deleted_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM flightdeck_pg_threads t WHERE t.workspace_id = i.workspace_id AND i.resource_type = 'thread' AND t.id = i.resource_id AND t.deleted_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM flightdeck_pg_tasks t WHERE t.workspace_id = i.workspace_id AND i.resource_type = 'task' AND t.id = i.resource_id AND t.deleted_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM flightdeck_pg_docs d WHERE d.workspace_id = i.workspace_id AND i.resource_type = 'document' AND d.id = i.resource_id AND d.deleted_at IS NOT NULL)
        ) THEN 'subject_deleted'
      END AS reason
    FROM flightdeck_pg_notification_items i
    WHERE i.workspace_id = ${r.workspaceId} AND i.recipient_actor_id = ${r.actorId} AND i.removed_at IS NULL`;
  const doomed = stale.filter((row) => row.reason);
  if (!doomed.length) return 0;
  await sql.begin(async (tx) => {
    for (const row of doomed) await tombstoneItem(tx as unknown as Sql, r.workspaceId, r.actorId, row.id, row.reason);
  });
  return doomed.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------------------------
async function sourceLabels(sql: Sql, workspaceId: string, rows: ItemRow[]) {
  const ids = [...new Set(rows.map((r) => r.source_app_id).filter((s) => s !== CORE_SOURCE))];
  const labels = new Map<string, { label: string; kind: string }>([[CORE_SOURCE, { label: CORE_SOURCE_LABEL, kind: 'tower_rule' }]]);
  if (ids.length) {
    for (const s of await sql<{ source_app_id: string; display_name: string; kind: string }[]>`
      SELECT source_app_id, display_name, kind FROM flightdeck_pg_notification_sources WHERE workspace_id = ${workspaceId} AND source_app_id = ANY(${ids}::text[])`) {
      labels.set(s.source_app_id, { label: s.display_name, kind: s.kind });
    }
  }
  return labels;
}

async function actorSummaries(sql: Sql, rows: ItemRow[]) {
  const ids = [...new Set(rows.map((r) => r.trigger_actor_id).filter(Boolean))];
  const map = new Map<string, { display_name: string | null; kind: string }>();
  if (ids.length) for (const a of await sql<{ id: string; display_name: string | null; kind: string }[]>`SELECT id, display_name, kind FROM flightdeck_pg_actors WHERE id = ANY(${ids}::uuid[])`) map.set(a.id, a);
  return map;
}

export function serializeTombstone(row: ItemRow) {
  return {
    schema: 'org.wingman.notification.tombstone', version: 1, id: row.id, workspace_id: row.workspace_id, change_seq: Number(row.change_seq),
    change_type: 'remove', removal_reason: row.removal_reason ?? 'access_lost',
  };
}

export function serializeItem(row: ItemRow, labels: Map<string, { label: string; kind: string }>, actors: Map<string, { display_name: string | null; kind: string }>, access: 'ok' | 'unavailable' = 'ok') {
  const label = labels.get(row.source_app_id) ?? { label: row.source_app_id, kind: 'app' };
  const trigger = row.trigger_actor_id ? actors.get(row.trigger_actor_id) : null;
  const subject = { kind: null, scope_id: null, channel_id: null, thread_id: null, task_id: null, doc_id: null, message_id: null, comment_id: null, activity_version: null, ...(row.subject ?? {}) };
  const unavailable = access === 'unavailable';
  return {
    schema: 'org.wingman.notification.item', version: 1,
    id: row.id, workspace_id: row.workspace_id, recipient_actor_id: row.recipient_actor_id,
    change_seq: Number(row.change_seq), row_version: row.row_version,
    source: { app_id: row.source_app_id, label: label.label, kind: label.kind },
    category: row.category, reasons: row.reasons, severity: row.severity, status: row.status, origin: row.origin,
    group: { key: row.group_key, event_count: row.event_count },
    actor: { actor_id: row.trigger_actor_id ?? null, display_name: trigger?.display_name ?? null, kind: trigger?.kind ?? null },
    subject,
    presentation: unavailable ? { title: 'Item no longer available', body: '' } : row.presentation,
    action: unavailable ? null : row.action ?? null,
    audience: { client_apps: row.audience_client_apps },
    occurred_at: iso(row.occurred_at), updated_at: iso(row.updated_at), expires_at: iso(row.expires_at),
    state: {
      read: row.read_at != null, read_at: iso(row.read_at), read_reason: row.read_reason ?? null,
      dismissed: row.dismissed_at != null, archived: row.archived_at != null,
    },
    access,
  };
}

async function serializeRows(sql: Sql, workspaceId: string, rows: ItemRow[]) {
  const live = rows.filter((r) => !r.removed_at);
  const [labels, actors] = await Promise.all([sourceLabels(sql, workspaceId, live), actorSummaries(sql, live)]);
  return rows.map((r) => (r.removed_at ? serializeTombstone(r) : serializeItem(r, labels, actors)));
}

// ---------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------
const viewPredicate = (sql: Sql, view: View) =>
  view === 'unread' ? sql`i.dismissed_at IS NULL AND i.archived_at IS NULL AND i.read_at IS NULL AND i.status = 'active'`
  : view === 'inbox' ? sql`i.dismissed_at IS NULL AND i.archived_at IS NULL`
  : view === 'archived' ? sql`i.archived_at IS NOT NULL AND i.dismissed_at IS NULL`
  : view === 'dismissed' ? sql`i.dismissed_at IS NOT NULL`
  : sql`TRUE`;

export async function listItems(
  sql: Sql, r: Recipient,
  q: { view: View; category?: string; sourceAppId?: string; clientAppId?: string; limit: number; cursor?: string },
) {
  const filter = hashOf({ view: q.view, category: q.category ?? null, source: q.sourceAppId ?? null, client: q.clientAppId ?? null });
  const binding = { w: r.workspaceId, a: r.actorId, r: 'items', f: filter };
  const position = q.cursor ? await verifyCursor<{ o: string; id: string }>(q.cursor, binding, sql) : null;
  if (position && (!position.o || !isUuid(position.id))) throw new NotificationError(400, 'invalid_cursor', 'Cursor is invalid for this request');
  const keys = await loadAccessKeys(sql, r);
  await sweepRecipient(sql, r, keys);
  const [system] = await sql<{ activated_at: Date }[]>`SELECT activated_at FROM flightdeck_pg_notification_system WHERE singleton`;
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const t = tx as unknown as Sql;
    const [cursorRow] = await t<{ last_seq: string; rules_revision: string }[]>`SELECT last_seq, rules_revision FROM flightdeck_pg_notification_cursors WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
    const rows = await t<ItemRow[]>`
      SELECT i.* FROM flightdeck_pg_notification_items i
      WHERE i.workspace_id = ${r.workspaceId} AND i.recipient_actor_id = ${r.actorId} AND ${visibleSql(t, keys)} AND ${viewPredicate(t, q.view)}
        AND ${appVisibleSql(t, q.clientAppId)}
        ${q.category ? t`AND i.category = ${q.category}` : t``}
        ${q.sourceAppId ? t`AND i.source_app_id = ${q.sourceAppId}` : t``}
        ${position ? t`AND (i.occurred_at, i.id) < (${position.o}::timestamptz, ${position.id}::uuid)` : t``}
      ORDER BY i.occurred_at DESC, i.id DESC LIMIT ${q.limit + 1}`;
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    // Microsecond-exact keyset position: read it from the database, not through a JS Date.
    const lastKey = last ? (await t<{ o: string }[]>`SELECT to_char(${last.occurred_at}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS o`)[0]!.o : null;
    const unread = await countUnread(t, r, keys, q.clientAppId);
    return {
      items: await serializeRows(t, r.workspaceId, page),
      next_cursor: more && last ? await signCursor(binding, { o: lastKey, id: last.id }, sql) : null,
      head_seq: Number(cursorRow?.last_seq ?? 0),
      rules_revision: Number(cursorRow?.rules_revision ?? 0),
      counts: { unread_total: unread.total, capped_at: INBOX_COUNT_CAP },
      inbox_started_at: iso(system?.activated_at),
    };
  });
}

export async function getItem(sql: Sql, r: Recipient, id: string) {
  if (!isUuid(id)) throw new NotificationError(404, 'notification_not_found', 'Notification not found');
  const keys = await loadAccessKeys(sql, r);
  await sweepRecipient(sql, r, keys);
  const [row] = await sql<ItemRow[]>`SELECT i.* FROM flightdeck_pg_notification_items i WHERE i.id = ${id} AND i.workspace_id = ${r.workspaceId} AND i.recipient_actor_id = ${r.actorId}`;
  if (!row) throw new NotificationError(404, 'notification_not_found', 'Notification not found');
  if (row.removed_at) return serializeTombstone(row);
  const [labels, actors] = await Promise.all([sourceLabels(sql, r.workspaceId, [row]), actorSummaries(sql, [row])]);
  const accessible = !row.acl_family || keys.includes(`channel:${row.acl_channel_id}:${row.acl_family}`);
  return serializeItem(row, labels, actors, accessible ? 'ok' : 'unavailable');
}

export async function listChanges(sql: Sql, r: Recipient, afterSeq: number, limit: number, opts: { clientAppId?: string; rulesRevision?: number } = {}) {
  const keys = await loadAccessKeys(sql, r);
  await sweepRecipient(sql, r, keys);
  // Head, floor, rules revision and rows come from ONE snapshot, so through_seq can never skip a row nor disagree with head.
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const t = tx as unknown as Sql;
    const [cursor] = await t<{ last_seq: string; tombstone_floor_seq: string; rules_revision: string }[]>`
      SELECT last_seq, tombstone_floor_seq, rules_revision FROM flightdeck_pg_notification_cursors WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
    const head = Number(cursor?.last_seq ?? 0);
    const revision = Number(cursor?.rules_revision ?? 0);
    if (opts.rulesRevision !== undefined && opts.rulesRevision !== revision) {
      throw new NotificationError(410, 'reset_required', 'Notification rules changed; re-list the inbox and re-fetch rules', { reason: 'rules_changed', head_seq: head, rules_revision: revision });
    }
    if (afterSeq < Number(cursor?.tombstone_floor_seq ?? 0)) {
      throw new NotificationError(410, 'reset_required', 'Cursor predates retained history; re-list the inbox', { reason: 'tombstone_floor', head_seq: head, rules_revision: revision });
    }
    if (afterSeq > head) {
      throw new NotificationError(410, 'reset_required', 'Cursor is ahead of the server; re-list the inbox', { reason: 'ahead', head_seq: head, rules_revision: revision });
    }
    // Tombstones are content-free and always included; live items must be visible to the requesting client app.
    const rows = await t<ItemRow[]>`
      SELECT i.* FROM flightdeck_pg_notification_items i
      WHERE i.workspace_id = ${r.workspaceId} AND i.recipient_actor_id = ${r.actorId} AND i.change_seq > ${afterSeq}
        AND (i.removed_at IS NOT NULL OR ${appVisibleSql(t, opts.clientAppId)})
      ORDER BY i.change_seq ASC LIMIT ${limit + 1}`;
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    // Safety net for a race with revocation between sweep and read: never leak content, emit a stub removal instead.
    const safe = page.map((row) => {
      const allowed = row.removed_at || !row.acl_family || keys.includes(`channel:${row.acl_channel_id}:${row.acl_family}`);
      return allowed ? row : { ...row, removed_at: new Date(), removal_reason: 'access_lost' };
    });
    return {
      changes: await serializeRows(t, r.workspaceId, safe),
      // A page that filtered everything still advances to head; a full page advances to its last row.
      through_seq: more ? Number(page[page.length - 1]!.change_seq) : head,
      head_seq: head,
      rules_revision: revision,
      has_more: more,
    };
  });
}

async function countUnread(sql: Sql, r: Recipient, keys: string[], clientAppId?: string) {
  // `badge` = visible to the badge client ('*' when none was given, i.e. shared-audience items), unread and severity >= normal.
  const badgeClient = clientAppId ?? '*';
  const rows = await sql<{ category: string; source_app_id: string; badge: boolean }[]>`
    SELECT i.category, i.source_app_id,
      (i.severity <> 'low' AND flightdeck_pg_notification_item_visible(i.workspace_id, i.recipient_actor_id, i.source_app_id, i.category, i.audience_client_apps, ${badgeClient})) AS badge
    FROM flightdeck_pg_notification_items i
    WHERE i.workspace_id = ${r.workspaceId} AND i.recipient_actor_id = ${r.actorId} AND ${visibleSql(sql, keys)} AND ${appVisibleSql(sql, clientAppId)}
      AND i.read_at IS NULL AND i.dismissed_at IS NULL AND i.archived_at IS NULL AND i.status = 'active'
    LIMIT ${INBOX_COUNT_CAP}`;
  return { total: rows.length, rows };
}

export async function getCounts(sql: Sql, r: Recipient, opts: { clientAppId?: string } = {}) {
  const keys = await loadAccessKeys(sql, r);
  await sweepRecipient(sql, r, keys);
  const [system] = await sql<{ activated_at: Date }[]>`SELECT activated_at FROM flightdeck_pg_notification_system WHERE singleton`;
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const t = tx as unknown as Sql;
    const [cursor] = await t<{ last_seq: string; rules_revision: string }[]>`SELECT last_seq, rules_revision FROM flightdeck_pg_notification_cursors WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
    const unread = await countUnread(t, r, keys, opts.clientAppId);
    const byCategory: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let badge = 0;
    for (const row of unread.rows) {
      byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
      bySource[row.source_app_id] = (bySource[row.source_app_id] ?? 0) + 1;
      if (row.badge) badge += 1;
    }
    return {
      unread_total: unread.total, by_category: byCategory, by_source_app: bySource, badge, capped_at: INBOX_COUNT_CAP,
      head_seq: Number(cursor?.last_seq ?? 0), rules_revision: Number(cursor?.rules_revision ?? 0), inbox_started_at: iso(system?.activated_at),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Mutations: CAS on row_version + durable receipts keyed by mutation_id.
// ---------------------------------------------------------------------------------------------------------------
type Patch = { read?: boolean; dismissed?: boolean; archived?: boolean };

async function receiptFor(tx: Sql, r: Recipient, mutationId: string, requestHash: string) {
  const [receipt] = await tx<{ request_hash: string; response: any }[]>`
    SELECT request_hash, response FROM flightdeck_pg_notification_mutations
    WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId} AND mutation_id = ${mutationId}`;
  if (!receipt) return null;
  if (receipt.request_hash !== requestHash) throw new NotificationError(409, 'mutation_id_reused', 'mutation_id was already used for a different request');
  return receipt.response;
}
async function storeReceipt(tx: Sql, r: Recipient, mutationId: string, requestHash: string, response: unknown) {
  await tx`INSERT INTO flightdeck_pg_notification_mutations (workspace_id, actor_id, mutation_id, request_hash, response)
    VALUES (${r.workspaceId}, ${r.actorId}, ${mutationId}, ${requestHash}, ${tx.json(asJson(response))}) ON CONFLICT DO NOTHING`;
}

export async function patchItem(
  sql: Sql, r: Recipient,
  input: { id: string; mutationId: string; expectedRowVersion: number; observedChangeSeq?: number; patch: Patch },
) {
  const keys = await loadAccessKeys(sql, r);
  await sweepRecipient(sql, r, keys);
  const requestHash = hashOf({ op: 'patch', id: input.id, expected: input.expectedRowVersion, observed: input.observedChangeSeq ?? null, patch: input.patch });
  return sql.begin(async (txn) => {
    const tx = txn as unknown as Sql;
    // Serialise receipts for one (actor, mutation) so concurrent retries converge on one acknowledgement.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${r.workspaceId}:${r.actorId}:${input.mutationId}`}))`;
    const replay = await receiptFor(tx, r, input.mutationId, requestHash);
    if (replay) {
      // The receipt embeds item content: never replay it once access was revoked/removed (sweep above sets removed_at).
      const [live] = await tx<{ id: string }[]>`
        SELECT id FROM flightdeck_pg_notification_items
        WHERE id = ${input.id} AND workspace_id = ${r.workspaceId} AND recipient_actor_id = ${r.actorId} AND removed_at IS NULL`;
      if (!live) throw new NotificationError(404, 'notification_not_found', 'Notification not found');
      return replay as { item: unknown };
    }
    await lockRecipient(tx, r.workspaceId, r.actorId);
    const [row] = await tx<ItemRow[]>`
      SELECT i.* FROM flightdeck_pg_notification_items i
      WHERE i.id = ${input.id} AND i.workspace_id = ${r.workspaceId} AND i.recipient_actor_id = ${r.actorId} FOR UPDATE`;
    if (!row || row.removed_at) throw new NotificationError(404, 'notification_not_found', 'Notification not found');
    const current = async () => (await serializeRows(tx, r.workspaceId, [row]))[0];
    if (row.row_version !== input.expectedRowVersion || (input.observedChangeSeq != null && input.observedChangeSeq < Number(row.change_seq))) {
      throw new NotificationError(409, 'state_conflict', 'Item changed since it was read', { item: await current() });
    }
    const p = input.patch;
    const next = {
      read_at: row.read_at as Date | null, read_reason: row.read_reason as string | null,
      dismissed_at: row.dismissed_at as Date | null, archived_at: row.archived_at as Date | null,
    };
    const now = new Date();
    if (p.read === true && !next.read_at) { next.read_at = now; next.read_reason = 'user'; }
    if (p.read === false) { next.read_at = null; next.read_reason = null; }
    if (p.dismissed === true && !next.dismissed_at) { next.dismissed_at = now; if (!next.read_at) { next.read_at = now; next.read_reason = 'user'; } }
    if (p.dismissed === false) next.dismissed_at = null;
    if (p.archived === true && !next.archived_at) { next.archived_at = now; if (!next.read_at) { next.read_at = now; next.read_reason = 'user'; } }
    if (p.archived === false) next.archived_at = null;
    const changed = (next.read_at == null) !== (row.read_at == null) || (next.dismissed_at == null) !== (row.dismissed_at == null) || (next.archived_at == null) !== (row.archived_at == null);
    let finalRow = row;
    if (changed) {
      const [s] = await tx<{ s: string }[]>`SELECT flightdeck_pg_notification_next_seq(${r.workspaceId}::uuid, ${r.actorId}::uuid) AS s`;
      [finalRow] = await tx<ItemRow[]>`
        UPDATE flightdeck_pg_notification_items SET read_at = ${next.read_at}, read_reason = ${next.read_reason}, dismissed_at = ${next.dismissed_at},
          archived_at = ${next.archived_at}, row_version = row_version + 1, change_seq = ${Number(s!.s)}, updated_at = NOW()
        WHERE id = ${row.id} RETURNING *`;
      await tx`SELECT flightdeck_pg_notification_emit_hint(${r.workspaceId}::uuid, ${r.actorId}::uuid, ${row.id}::uuid, ${Number(s!.s)}::bigint, 'state')`;
    }
    const [labels, actors] = await Promise.all([sourceLabels(tx, r.workspaceId, [finalRow]), actorSummaries(tx, [finalRow])]);
    const response = { item: serializeItem(finalRow, labels, actors) };
    await storeReceipt(tx, r, input.mutationId, requestHash, response);
    return response;
  });
}

export type BulkOp = 'mark_read' | 'mark_unread' | 'dismiss' | 'archive' | 'unarchive';
export async function bulkMutate(
  sql: Sql, r: Recipient,
  input: { mutationId: string; op: BulkOp; ids?: string[]; upToSeq?: number; view?: View; category?: string; sourceAppId?: string; clientAppId?: string },
) {
  const keys = await loadAccessKeys(sql, r);
  await sweepRecipient(sql, r, keys);
  const requestHash = hashOf({ op: 'bulk', ...input });
  return sql.begin(async (txn) => {
    const tx = txn as unknown as Sql;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${r.workspaceId}:${r.actorId}:${input.mutationId}`}))`;
    const replay = await receiptFor(tx, r, input.mutationId, requestHash);
    if (replay) return replay as { affected: number; through_seq: number; mutation_id: string };
    await lockRecipient(tx, r.workspaceId, r.actorId);
    const eligible = {
      mark_read: tx`i.read_at IS NULL`, mark_unread: tx`i.read_at IS NOT NULL AND i.status = 'active'`,
      dismiss: tx`i.dismissed_at IS NULL`, archive: tx`i.archived_at IS NULL`, unarchive: tx`i.archived_at IS NOT NULL`,
    }[input.op];
    const selected = await tx<{ id: string }[]>`
      SELECT i.id FROM flightdeck_pg_notification_items i
      WHERE i.workspace_id = ${r.workspaceId} AND i.recipient_actor_id = ${r.actorId} AND ${visibleSql(tx, keys)} AND ${appVisibleSql(tx, input.clientAppId)} AND ${eligible}
        ${input.ids ? tx`AND i.id = ANY(${input.ids}::uuid[])` : tx`AND i.change_seq <= ${input.upToSeq!} AND ${viewPredicate(tx, input.view ?? 'inbox')}`}
        ${input.category ? tx`AND i.category = ${input.category}` : tx``}
        ${input.sourceAppId ? tx`AND i.source_app_id = ${input.sourceAppId}` : tx``}
      ORDER BY i.change_seq ASC LIMIT 5000 FOR UPDATE OF i`;
    let lastSeq = 0;
    let firstId: string | null = null;
    for (const { id } of selected) {
      const [s] = await tx<{ s: string }[]>`SELECT flightdeck_pg_notification_next_seq(${r.workspaceId}::uuid, ${r.actorId}::uuid) AS s`;
      lastSeq = Number(s!.s);
      firstId ??= id;
      if (input.op === 'mark_read') await tx`UPDATE flightdeck_pg_notification_items SET read_at = NOW(), read_reason = 'bulk', row_version = row_version + 1, change_seq = ${lastSeq}, updated_at = NOW() WHERE id = ${id}`;
      else if (input.op === 'mark_unread') await tx`UPDATE flightdeck_pg_notification_items SET read_at = NULL, read_reason = NULL, row_version = row_version + 1, change_seq = ${lastSeq}, updated_at = NOW() WHERE id = ${id}`;
      else if (input.op === 'dismiss') await tx`UPDATE flightdeck_pg_notification_items SET dismissed_at = NOW(), read_at = COALESCE(read_at, NOW()), read_reason = COALESCE(read_reason, 'bulk'), row_version = row_version + 1, change_seq = ${lastSeq}, updated_at = NOW() WHERE id = ${id}`;
      else if (input.op === 'archive') await tx`UPDATE flightdeck_pg_notification_items SET archived_at = NOW(), read_at = COALESCE(read_at, NOW()), read_reason = COALESCE(read_reason, 'bulk'), row_version = row_version + 1, change_seq = ${lastSeq}, updated_at = NOW() WHERE id = ${id}`;
      else await tx`UPDATE flightdeck_pg_notification_items SET archived_at = NULL, row_version = row_version + 1, change_seq = ${lastSeq}, updated_at = NOW() WHERE id = ${id}`;
    }
    // One content-free hint covers the whole batch ("pull changes now").
    if (firstId) await tx`SELECT flightdeck_pg_notification_emit_hint(${r.workspaceId}::uuid, ${r.actorId}::uuid, ${firstId}::uuid, ${lastSeq}::bigint, 'state')`;
    const [cursor] = await tx<{ last_seq: string }[]>`SELECT last_seq FROM flightdeck_pg_notification_cursors WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
    const response = { affected: selected.length, through_seq: Number(cursor?.last_seq ?? 0), mutation_id: input.mutationId };
    await storeReceipt(tx, r, input.mutationId, requestHash, response);
    return response;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Registry + rules
// ---------------------------------------------------------------------------------------------------------------
export async function listCategories(sql: Sql, workspaceId: string) {
  const sources = [{ app_id: CORE_SOURCE, label: CORE_SOURCE_LABEL, kind: 'tower_rule', categories: CORE_CATEGORIES }];
  const rows = await sql<{ source_app_id: string; display_name: string; kind: string; grant_status: string }[]>`
    SELECT source_app_id, display_name, kind, grant_status FROM flightdeck_pg_notification_sources WHERE workspace_id = ${workspaceId} AND grant_status = 'active' ORDER BY source_app_id`;
  for (const s of rows) {
    const cats = await sql`
      SELECT category, label, default_severity, default_inbox, default_alert, FALSE AS mandatory, grouping
      FROM flightdeck_pg_notification_categories WHERE workspace_id = ${workspaceId} AND source_app_id = ${s.source_app_id} ORDER BY category`;
    sources.push({ app_id: s.source_app_id, label: s.display_name, kind: s.kind, categories: cats as unknown as typeof CORE_CATEGORIES });
  }
  return sources;
}

export async function listRules(sql: Sql, r: Recipient): Promise<RuleRow[]> {
  return sql<RuleRow[]>`
    SELECT source_app_id, category, client_app_id, channel, mode, preview, row_version FROM flightdeck_pg_notification_rules
    WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId} ORDER BY source_app_id, category, client_app_id, channel`;
}

/** Rules and their revision from one snapshot (GET rules, PUT response, conflict body). */
export async function getRulesState(sql: Sql, r: Recipient): Promise<{ rules: RuleRow[]; rules_revision: number }> {
  const run = async (t: Sql) => {
    const [cursor] = await t<{ rules_revision: string }[]>`SELECT rules_revision FROM flightdeck_pg_notification_cursors WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
    return { rules: await listRules(t, r), rules_revision: Number(cursor?.rules_revision ?? 0) };
  };
  return sql.begin('isolation level repeatable read read only', async (tx) => run(tx as unknown as Sql));
}

async function rulesStateIn(tx: Sql, r: Recipient) {
  const [cursor] = await tx<{ rules_revision: string }[]>`SELECT rules_revision FROM flightdeck_pg_notification_cursors WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
  return { rules: await listRules(tx, r), rules_revision: Number(cursor?.rules_revision ?? 0) };
}

/** Caller must hold the recipient lock. */
async function bumpRulesRevision(tx: Sql, r: Recipient) {
  await tx`UPDATE flightdeck_pg_notification_cursors SET rules_revision = rules_revision + 1 WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
}

export type RuleInput = {
  source_app_id: string; category: string; client_app_id: string; channel: 'inbox' | 'alert'; mode: RuleMode; preview: string | null;
  expected_row_version: number;
};
const ruleKey = (rule: { source_app_id: string; category: string; client_app_id: string; channel: string }) =>
  `${rule.source_app_id}\u0000${rule.category}\u0000${rule.client_app_id}\u0000${rule.channel}`;

/**
 * Per-key compare-and-swap, all or nothing. expected_row_version is the row_version of the same key at the client's last
 * GET (0 when absent). mode 'default' keeps a versioned "inherit" row (never deleted) so a stale expected 0 cannot resurrect
 * an override. Lock order: mutation lock -> recipient cursor lock -> rule rows.
 */
export async function putRules(sql: Sql, r: Recipient, mutationId: string, rules: RuleInput[]) {
  const requestHash = hashOf({ op: 'rules', rules });
  return sql.begin(async (txn) => {
    const tx = txn as unknown as Sql;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${r.workspaceId}:${r.actorId}:${mutationId}`}))`;
    const replay = await receiptFor(tx, r, mutationId, requestHash);
    if (replay) return replay as { rules: RuleRow[]; rules_revision: number };
    // Mandatory categories cannot be turned off: reject rather than silently ignore.
    for (const rule of rules) {
      if (rule.mode === 'off' && rule.source_app_id === CORE_SOURCE && categoryDef(rule.category)?.mandatory) {
        throw new NotificationError(400, 'category_mandatory', `${rule.category} is always on`);
      }
    }
    const known = new Set((await tx<{ source_app_id: string; category: string }[]>`
      SELECT source_app_id, category FROM flightdeck_pg_notification_categories WHERE workspace_id = ${r.workspaceId}`).map((c) => `${c.source_app_id}/${c.category}`));
    for (const rule of rules) {
      const ok = (rule.source_app_id === '*' && rule.category === '*')
        || (rule.source_app_id === CORE_SOURCE && (rule.category === '*' || !!categoryDef(rule.category)))
        || (rule.source_app_id === '*' && !!categoryDef(rule.category))
        || (rule.source_app_id !== '*' && rule.source_app_id !== CORE_SOURCE && (rule.category === '*' || known.has(`${rule.source_app_id}/${rule.category}`)));
      if (!ok) throw new NotificationError(400, 'unknown_category', `Unknown source/category ${rule.source_app_id}/${rule.category}`);
    }
    await lockRecipient(tx, r.workspaceId, r.actorId);
    const current = new Map((await listRules(tx, r)).map((row) => [ruleKey(row), row]));
    const conflicts = rules.filter((rule) => (current.get(ruleKey(rule))?.row_version ?? 0) !== rule.expected_row_version);
    if (conflicts.length) {
      const state = await rulesStateIn(tx, r);
      throw new NotificationError(409, 'rules_conflict', 'Rules changed since they were read; rebase on the returned rules', {
        conflicts: conflicts.map((rule) => ({
          source_app_id: rule.source_app_id, category: rule.category, client_app_id: rule.client_app_id, channel: rule.channel,
          expected_row_version: rule.expected_row_version, current: current.get(ruleKey(rule)) ?? null,
        })),
        rules: state.rules, rules_revision: state.rules_revision,
      });
    }
    for (const rule of rules) {
      await tx`
        INSERT INTO flightdeck_pg_notification_rules (workspace_id, actor_id, source_app_id, category, client_app_id, channel, mode, preview)
        VALUES (${r.workspaceId}, ${r.actorId}, ${rule.source_app_id}, ${rule.category}, ${rule.client_app_id}, ${rule.channel}, ${rule.mode}, ${rule.channel === 'alert' ? rule.preview : null})
        ON CONFLICT (workspace_id, actor_id, source_app_id, category, client_app_id, channel)
        DO UPDATE SET mode = EXCLUDED.mode, preview = EXCLUDED.preview, row_version = flightdeck_pg_notification_rules.row_version + 1, updated_at = NOW()`;
      await mirrorLegacyPreference(tx, r, rule);
    }
    await bumpRulesRevision(tx, r);
    const response = await rulesStateIn(tx, r);
    await storeReceipt(tx, r, mutationId, requestHash, response);
    return response;
  });
}

const LEGACY_COLUMN: Record<string, string> = {
  chat_thread: 'chat_threads_enabled', mention: 'mentions_enabled', dm: 'dms_enabled', comment_tag: 'comment_tags_enabled', task_assignment: 'task_assignments_enabled',
};

/** Alert rules on flightdeck.core mirror the legacy per-category booleans so the existing Web Push sender honours them. */
async function mirrorLegacyPreference(tx: Sql, r: Recipient, rule: RuleInput) {
  if (rule.channel !== 'alert' || rule.client_app_id !== '*' || rule.source_app_id !== CORE_SOURCE) return;
  const categories = rule.category === '*' ? Object.keys(LEGACY_COLUMN) : LEGACY_COLUMN[rule.category] ? [rule.category] : [];
  for (const category of categories) {
    const column = LEGACY_COLUMN[category]!;
    const value = rule.mode === 'default' ? categoryDef(category)?.default_alert === 'on' : rule.mode === 'on';
    await tx`INSERT INTO flightdeck_pg_notification_preferences (workspace_id, actor_id) VALUES (${r.workspaceId}, ${r.actorId}) ON CONFLICT DO NOTHING`;
    await tx`UPDATE flightdeck_pg_notification_preferences SET ${tx(column)} = ${value}, updated_at = NOW() WHERE workspace_id = ${r.workspaceId} AND actor_id = ${r.actorId}`;
  }
}

/**
 * Legacy PATCH /notifications/preferences: ONE transaction writes the legacy booleans, mirrors them into alert rules
 * (bumping those row_versions) and bumps rules_revision. No catch: a failed mirror fails the whole write.
 * Same lock order as PUT rules (recipient cursor first) so the two cannot deadlock.
 */
export async function applyLegacyPreferencePatch(
  sql: Sql, r: Recipient, patch: Partial<Record<'chat_threads_enabled' | 'mentions_enabled' | 'dms_enabled' | 'comment_tags_enabled' | 'task_assignments_enabled', boolean>>,
): Promise<FlightDeckPgNotificationPreferenceRow> {
  return sql.begin(async (txn) => {
    const tx = txn as unknown as Sql;
    await lockRecipient(tx, r.workspaceId, r.actorId);
    const preferences = await updateFlightDeckPgNotificationPreferences({ workspaceId: r.workspaceId, actorId: r.actorId, patch }, tx as any);
    if (await mirrorLegacyToRules(tx, r, patch as Record<string, boolean>)) await bumpRulesRevision(tx, r);
    return preferences;
  });
}

/** Mirrors legacy booleans into alert rules inside the caller's transaction (recipient lock held). Returns whether any rule was written. */
export async function mirrorLegacyToRules(tx: Sql, r: Recipient, patch: Record<string, boolean>): Promise<boolean> {
  const byColumn = Object.fromEntries(Object.entries(LEGACY_COLUMN).map(([category, column]) => [column, category]));
  let wrote = false;
  for (const [column, value] of Object.entries(patch)) {
    const category = byColumn[column];
    if (!category) continue;
    await tx`
      INSERT INTO flightdeck_pg_notification_rules (workspace_id, actor_id, source_app_id, category, client_app_id, channel, mode)
      VALUES (${r.workspaceId}, ${r.actorId}, ${CORE_SOURCE}, ${category}, '*', 'alert', ${value ? 'on' : 'off'})
      ON CONFLICT (workspace_id, actor_id, source_app_id, category, client_app_id, channel)
      DO UPDATE SET mode = EXCLUDED.mode, row_version = flightdeck_pg_notification_rules.row_version + 1, updated_at = NOW()`;
    wrote = true;
  }
  return wrote;
}
