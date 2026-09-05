import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { authorizeFlightDeckPgOperation, getEffectiveFlightDeckPgGroupIds } from './flightdeck-pg-authorization';
import { recordFamilies } from './flightdeck-record-families';
import type { FlightDeckRecordChange, FlightDeckRecordPage } from '../types';

type Db = ReturnType<typeof getDb>;
type State = { mode: 'snapshot' | 'delta'; boundary: string; after: string; family: string; id: string; snapshotId: string | null };
type Entry = { family: string; id: string; operation: 'upsert' | 'delete'; position: string; row: Record<string, any>; bytes: number };
export const RECORD_MAX_ROWS = 200;
export const RECORD_MAX_BYTES = 1_048_576;
export class RecordSyncError extends Error {
  constructor(public status: 400 | 403 | 409 | 413, public code: string) { super(code); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Transactions serialize on the clock only when writing, never via allocation-order sequences. */
export async function readFlightDeckRecordPage(input: {
  workspaceId: string; actorId: string; cursor?: string | null; limit?: number;
}, db: Db = getDb()): Promise<FlightDeckRecordPage> {
  if (input.cursor && !uuid.test(input.cursor)) throw new RecordSyncError(400, 'invalid_cursor');
  const limit = input.limit ?? RECORD_MAX_ROWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > RECORD_MAX_ROWS) throw new RecordSyncError(400, 'invalid_limit');
  const run = () => db.begin('isolation level repeatable read', async transaction => {
    const sql = transaction as unknown as Db;
    const [viewer] = await sql`
      SELECT a.npub, w.app_npub FROM flightdeck_pg_workspace_memberships m
      JOIN flightdeck_pg_actors a ON a.id=m.actor_id
      JOIN flightdeck_pg_workspaces w ON w.id=m.workspace_id
      WHERE m.workspace_id=${input.workspaceId} AND m.actor_id=${input.actorId}
    `;
    if (!viewer) throw new RecordSyncError(403, 'workspace_membership_required');
    let [clock] = await sql`SELECT position::text, epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${input.workspaceId}`;
    if (!clock) {
      [clock] = await sql`INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(${input.workspaceId}) RETURNING position::text,epoch`;
    }
    let state: State;
    if (input.cursor) {
      const [saved] = await sql`SELECT epoch,state FROM flightdeck_pg_record_cursors WHERE token=${input.cursor} AND workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND created_at>now()-interval '7 days'`;
      if (!saved || saved.epoch !== clock!.epoch) throw new RecordSyncError(409, 'reset_required');
      state = saved.state as State;
    } else {
      state = { mode: 'snapshot', boundary: clock!.position, after: clock!.position, family: '', id: '', snapshotId: randomUUID() };
    }
    // Fetch at most limit+1 entries BEFORE permission filtering: hidden history cannot turn into an unbounded scan.
    const entries: Entry[] = state.mode === 'snapshot'
      ? await sql<Entry[]>`SELECT family,id,'upsert'::text AS operation,${state.boundary}::text AS position,bytes,context AS row
        FROM flightdeck_pg_record_current
        WHERE workspace_id=${input.workspaceId} AND (family,id)>(${state.family},${state.id})
        ORDER BY family,id LIMIT ${limit + 1}`
      : await sql<Entry[]>`SELECT family,id,operation,position::text,bytes,context AS row
        FROM flightdeck_pg_record_journal
        WHERE workspace_id=${input.workspaceId} AND position>${state.after}::bigint
        ORDER BY position LIMIT ${limit + 1}`;
    const decisions = new Map<string, boolean>();
    let effectiveGroups: string[] | undefined;
    async function grant(permission: string, type: 'channel' | 'scope', id: string): Promise<boolean> {
      if (!id) return false;
      const key = `${permission}:${id}`;
      if (decisions.has(key)) return decisions.get(key)!;
      const decision = await authorizeFlightDeckPgOperation({ actorNpub: viewer!.npub, appNpub: viewer!.app_npub,
        workspaceId: input.workspaceId, permission,
        resource: type === 'channel' ? { type, channelId: id } : { type, scopeId: id } }, sql);
      decisions.set(key, decision.allowed);
      return decision.allowed;
    }
    async function visible(e: Entry): Promise<boolean> {
      const r = e.row;
      if (e.family === 'daily_note' || e.family === 'personal_wapp') return r.owner_actor_id === input.actorId;
      if (e.family === 'scope') {
        const [scope] = await sql`SELECT 1 FROM flightdeck_pg_scopes WHERE workspace_id=${input.workspaceId} AND id=${e.id} AND archived_at IS NULL`;
        if (!scope) return false;
        if (await grant('scope.read', 'scope', e.id)) return true;
        effectiveGroups ??= await getEffectiveFlightDeckPgGroupIds(input.workspaceId, input.actorId, sql);
        const groups = effectiveGroups.length ? effectiveGroups : ['00000000-0000-0000-0000-000000000000'];
        const [childGrant] = await sql`SELECT 1 FROM flightdeck_pg_permission_grants pg
          JOIN flightdeck_pg_channels c ON c.workspace_id=pg.workspace_id AND c.id=pg.resource_channel_id
          WHERE pg.workspace_id=${input.workspaceId} AND c.scope_id=${e.id} AND c.archived_at IS NULL
          AND pg.resource_type='channel' AND pg.permission='channel.read' AND pg.revoked_at IS NULL
          AND ((pg.principal_type='actor' AND pg.principal_actor_id=${input.actorId})
            OR (pg.principal_type='group' AND pg.principal_group_id IN ${sql(groups)})) LIMIT 1`;
        return !!childGrant;
      }
      if (e.family === 'resource_view_state' && r.viewer_actor_id !== input.actorId) return false;
      const parentType = e.family === 'resource_view_state' ? r.resource_type
        : ['task_comment','task_assignment'].includes(e.family) ? 'task' : e.family === 'doc_comment' ? 'document' : e.family === 'message' && r.thread_id ? 'thread' : null;
      const parentId = e.family === 'resource_view_state' ? r.resource_id : parentType === 'task' ? r.task_id : parentType === 'thread' ? r.thread_id : r.doc_id;
      if (parentType) {
        const table = { task: 'flightdeck_pg_tasks', document: 'flightdeck_pg_docs', thread: 'flightdeck_pg_threads' }[parentType as 'task'];
        if (!table || !parentId) return false;
        const key = `parent:${parentType}:${parentId}`;
        if (!decisions.has(key)) {
          const [parent] = await sql`SELECT 1 FROM ${sql(table)} WHERE workspace_id=${input.workspaceId} AND id=${parentId} AND deleted_at IS NULL`;
          decisions.set(key, !!parent);
        }
        if (!decisions.get(key)) return false;
      }
      const channelId = e.family === 'channel' ? e.id : r.channel_id;
      if (!channelId) return false;
      const activeKey = `active:${channelId}`;
      if (!decisions.has(activeKey)) {
        const [active] = await sql`SELECT 1 FROM flightdeck_pg_channels c JOIN flightdeck_pg_scopes s ON s.workspace_id=c.workspace_id AND s.id=c.scope_id WHERE c.workspace_id=${input.workspaceId} AND c.id=${channelId} AND c.archived_at IS NULL AND s.archived_at IS NULL`;
        decisions.set(activeKey, !!active);
      }
      if (!decisions.get(activeKey)) return false;
      const target = e.family === 'resource_view_state' ? (r.resource_type === 'document' ? 'doc' : r.resource_type) : e.family;
      if (target.startsWith('task')) return grant('task.read', 'channel', channelId);
      if (['doc','doc_comment','file','audio_note'].includes(target)) {
        return await grant(`${target === 'doc_comment' ? 'doc' : target}.read`, 'channel', channelId)
          || await grant('channel.read', 'channel', channelId);
      }
      return grant('channel.read', 'channel', channelId);
    }
    const nextToken = randomUUID();
    const response: FlightDeckRecordPage = {
      protocol_version: 1, families: Object.keys(recordFamilies), mode: state.mode, changes: [],
      next_cursor: nextToken, has_more: entries.length > limit, snapshot_id: state.snapshotId,
      snapshot_complete: false, partitions_complete: [], bounds: { max_rows: RECORD_MAX_ROWS, max_bytes: RECORD_MAX_BYTES },
    };
    const next = { ...state };
    let processed = 0;
    for (const entry of entries.slice(0, limit)) {
      if (await visible(entry)) {
        const change: FlightDeckRecordChange = { family: entry.family, id: entry.id, operation: entry.operation,
          version: entry.position, workspace_id: input.workspaceId, scope_id: entry.family === 'scope' ? entry.id : entry.row.scope_id ?? null,
          channel_id: entry.family === 'channel' ? entry.id : entry.row.channel_id ?? null,
          row: null };
        // Decide using stored byte size and authorization metadata BEFORE fetching canonical JSON.
        const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...response, changes: [...response.changes, change], partitions_complete: Object.keys(recordFamilies) }));
        if (entry.operation === 'upsert' && envelopeBytes + entry.bytes > RECORD_MAX_BYTES) {
          if (!response.changes.length) throw new RecordSyncError(413, 'record_too_large');
          response.has_more = true; break;
        }
        if (entry.operation === 'upsert') {
          const [payload] = state.mode === 'snapshot'
            ? await sql`SELECT row FROM flightdeck_pg_record_current WHERE workspace_id=${input.workspaceId} AND family=${entry.family} AND id=${entry.id}`
            : await sql`SELECT row FROM flightdeck_pg_record_journal WHERE workspace_id=${input.workspaceId} AND position=${entry.position}::bigint`;
          change.row = payload!.row;
        }
        const actualBytes = Buffer.byteLength(JSON.stringify({ ...response, changes: [...response.changes, change], partitions_complete: Object.keys(recordFamilies) }));
        if (actualBytes > RECORD_MAX_BYTES) throw new RecordSyncError(413, 'record_too_large');
        response.changes.push(change);
      }
      processed++;
      if (state.mode === 'snapshot') { next.family = entry.family; next.id = entry.id; }
      else next.after = entry.position;
    }
    if (processed === entries.length && state.mode === 'snapshot') {
      response.snapshot_complete = true;
      response.partitions_complete = Object.keys(recordFamilies);
      // Always request the delta handover, including when snapshot scan was empty.
      response.has_more = true;
      next.mode = 'delta'; next.snapshotId = null; next.after = state.boundary;
    }
    if (state.mode === 'delta' && entries.length === 0 && input.cursor) {
      response.next_cursor = input.cursor;
      return response;
    }
    await sql`INSERT INTO flightdeck_pg_record_cursors(token,workspace_id,actor_id,epoch,state)
      VALUES(${nextToken},${input.workspaceId},${input.actorId},${clock!.epoch},${sql.json(next)})`;
    // Bounded retention: at most 512 recent progress cursors per viewer, with a seven-day replay TTL.
    await sql`DELETE FROM flightdeck_pg_record_cursors WHERE token IN (
      SELECT token FROM flightdeck_pg_record_cursors WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId}
      ORDER BY created_at DESC,token OFFSET 512 LIMIT 64
    )`;
    await sql`DELETE FROM flightdeck_pg_record_cursors WHERE token IN (
      SELECT token FROM flightdeck_pg_record_cursors WHERE created_at<now()-interval '7 days' ORDER BY created_at,token LIMIT 64
    )`;
    return response;
  }) as unknown as Promise<FlightDeckRecordPage>;
  for (let attempt=0; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (attempt >= 2 || !['40001','40P01'].includes(String((error as {code?:string}).code))) throw error;
    }
  }
}
