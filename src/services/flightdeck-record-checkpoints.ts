import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { RecordSyncError, type RecordSyncState } from './flightdeck-record-sync-state';
import type { FlightDeckRecordCheckpoint } from '../types';

type Db = ReturnType<typeof getDb>;
export const RECORD_CLIENT_LIMIT = 32;
export const RECORD_CLIENT_IDLE_DAYS = 90;
export const RECORD_PAGE_TOKEN_LIMIT = 512;
export const recordSyncDiscovery = {
  protocol_versions: [1, 2], device_checkpoints: true,
  client_id_format: 'uuid', max_clients_per_actor_workspace: RECORD_CLIENT_LIMIT,
  max_page_tokens_per_client: RECORD_PAGE_TOKEN_LIMIT, page_token_idle_days: 7,
  client_idle_days: RECORD_CLIENT_IDLE_DAYS,
};
export type RecordClientInput = { workspaceId: string; actorId: string; clientId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validateRecordClientId(value: unknown): asserts value is string {
  // Canonical spelling avoids multiple cache names for the same PostgreSQL UUID.
  if (typeof value !== 'string' || !uuid.test(value) || value === '00000000-0000-0000-0000-000000000000') {
    throw new RecordSyncError(400, 'invalid_client_id');
  }
}
export function serializeRecordCheckpoint(client: any): FlightDeckRecordCheckpoint {
  return { protocol_version: 2, client_id: client.client_id, authority_epoch: client.epoch,
    initial_cursor: client.initial_cursor, checkpoint_cursor: client.checkpoint_cursor,
    checkpoint_revision: String(client.revision), last_active_at: client.last_active_at.toISOString() };
}
export async function requireRecordClient(input: RecordClientInput, epoch: string, sql: Db, lock = false) {
  const rows = lock
    ? await sql`SELECT *,revision::text, last_active_at>clock_timestamp()-interval '90 days' AS active
        FROM flightdeck_pg_record_clients WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId} FOR UPDATE`
    : await sql`SELECT *,revision::text, last_active_at>statement_timestamp()-interval '90 days' AS active
        FROM flightdeck_pg_record_clients WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId}`;
  const client = rows[0];
  if (!client) throw new RecordSyncError(409, 'client_not_registered');
  if (!client.active) throw new RecordSyncError(409, 'client_expired');
  if (client.epoch !== epoch) throw new RecordSyncError(409, 'reset_required');
  return client;
}
export async function requireRecordMembership(input: RecordClientInput, sql: Db) {
  const [member] = await sql`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId}`;
  if (!member) throw new RecordSyncError(403, 'workspace_membership_required');
}
/** Clock -> optional registration lock -> client lock; authority checks follow clock. */
async function checkpointTransaction<T>(input: RecordClientInput, operation: (sql: Db, clock: any) => Promise<T>, db: Db): Promise<T> {
  validateRecordClientId(input.clientId);
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.begin(async transaction => {
        const sql = transaction as unknown as Db;
        await sql`INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(${input.workspaceId}) ON CONFLICT DO NOTHING`;
        const [clock] = await sql`SELECT epoch,position::text,journal_floor::text FROM flightdeck_pg_record_clock WHERE workspace_id=${input.workspaceId} FOR SHARE`;
        await requireRecordMembership(input, sql);
        return operation(sql, clock);
      }) as T;
    } catch (error) {
      if (attempt >= 2 || !['40001', '40P01'].includes(String((error as { code?: string }).code))) throw error;
    }
  }
}
export async function registerRecordClient(input: RecordClientInput, db: Db = getDb()): Promise<FlightDeckRecordCheckpoint> {
  return checkpointTransaction(input, async (sql, clock) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${input.workspaceId}),hashtext(${input.actorId}))`;
    const [existing] = await sql`SELECT 1 FROM flightdeck_pg_record_clients WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId}`;
    if (existing) {
      const client = await requireRecordClient(input, clock.epoch, sql, true);
      await requireRecordHistory(input.workspaceId, (client.checkpoint_state ?? client.initial_state) as RecordSyncState, clock, sql);
      const [renewed] = await sql`UPDATE flightdeck_pg_record_clients SET last_active_at=clock_timestamp()
        WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId} RETURNING *,revision::text`;
      return serializeRecordCheckpoint(renewed!);
    }
    // Only abandoned clients are reclaimable, never evict another active cache.
    await sql`DELETE FROM flightdeck_pg_record_clients WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId}
      AND last_active_at<=clock_timestamp()-interval '90 days'`;
    const [count] = await sql`SELECT count(*)::int AS n FROM flightdeck_pg_record_clients WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId}`;
    if (count!.n >= RECORD_CLIENT_LIMIT) throw new RecordSyncError(409, 'client_capacity');
    const state: RecordSyncState = { mode: 'snapshot', boundary: clock.position, after: clock.position,
      family: '', id: '', snapshotId: randomUUID() };
    const [client] = await sql`INSERT INTO flightdeck_pg_record_clients(workspace_id,actor_id,client_id,epoch,initial_state)
      VALUES(${input.workspaceId},${input.actorId},${input.clientId},${clock.epoch},${sql.json(state)}) RETURNING *,revision::text`;
    return serializeRecordCheckpoint(client!);
  }, db);
}
export async function readRecordCheckpoint(input: RecordClientInput, db: Db = getDb()): Promise<FlightDeckRecordCheckpoint> {
  return checkpointTransaction(input, async (sql, clock) => {
    const current = await requireRecordClient(input, clock.epoch, sql, true);
    await requireRecordHistory(input.workspaceId, (current.checkpoint_state ?? current.initial_state) as RecordSyncState, clock, sql);
    const [client] = await sql`UPDATE flightdeck_pg_record_clients SET last_active_at=clock_timestamp()
      WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId} RETURNING *,revision::text`;
    return serializeRecordCheckpoint(client!);
  }, db);
}
/** Explicitly retire only this authenticated actor's cache; frees a capacity slot. */
export async function retireRecordClient(input: RecordClientInput, db: Db = getDb()) {
  return checkpointTransaction(input, async (sql) => {
    await sql`DELETE FROM flightdeck_pg_record_clients WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId}`;
    return { protocol_version: 2 as const, client_id: input.clientId, retired: true };
  }, db);
}
/** Full snapshot keyset ordering followed by delta handover; never compare just after. */
async function stateDoesNotRegress(next: RecordSyncState, committed: RecordSyncState, sql: Db): Promise<boolean> {
  if (next.boundary !== committed.boundary) return false;
  if (committed.mode === 'delta') return next.mode === 'delta' && BigInt(next.after) >= BigInt(committed.after);
  if (next.mode === 'delta') return BigInt(next.after) >= BigInt(committed.boundary);
  if (next.snapshotId !== committed.snapshotId) return false;
  const [order] = await sql`SELECT (${next.family}::text,${next.id}::text)>=(${committed.family}::text,${committed.id}::text) AS valid`;
  return order!.valid;
}
export async function acknowledgeRecordCheckpoint(input: RecordClientInput & { cursor: string; expectedRevision: string }, db: Db = getDb()): Promise<FlightDeckRecordCheckpoint> {
  if (typeof input.cursor !== 'string' || !uuid.test(input.cursor)) throw new RecordSyncError(400, 'invalid_cursor');
  if (typeof input.expectedRevision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedRevision)) throw new RecordSyncError(400, 'invalid_checkpoint_revision');
  return checkpointTransaction(input, async (sql, clock) => {
    const client = await requireRecordClient(input, clock.epoch, sql, true);
    // Lost-response retries remain idempotent after the disposable token is gone.
    if (client.checkpoint_cursor === input.cursor) {
      await requireRecordHistory(input.workspaceId, client.checkpoint_state as RecordSyncState, clock, sql);
      const [renewed] = await sql`UPDATE flightdeck_pg_record_clients SET last_active_at=clock_timestamp()
        WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId} RETURNING *,revision::text`;
      return serializeRecordCheckpoint(renewed!);
    }
    const [token] = await sql`SELECT state,base_revision::text FROM flightdeck_pg_record_page_tokens
      WHERE token=${input.cursor} AND workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId}
      AND epoch=${clock.epoch} AND last_used_at>clock_timestamp()-interval '7 days'`;
    if (!token) throw new RecordSyncError(409, 'page_token_invalid');
    if (input.expectedRevision !== client.revision || token.base_revision !== client.revision) throw new RecordSyncError(409, 'checkpoint_conflict');
    if (client.checkpoint_state && !await stateDoesNotRegress(token.state as RecordSyncState, client.checkpoint_state as RecordSyncState, sql)) {
      throw new RecordSyncError(409, 'checkpoint_regression');
    }
    await requireRecordHistory(input.workspaceId, token.state as RecordSyncState, clock, sql);
    const [saved] = await sql`UPDATE flightdeck_pg_record_clients SET checkpoint_cursor=${input.cursor},checkpoint_state=${sql.json(token.state)},
      revision=revision+1,last_active_at=clock_timestamp() WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId}
      RETURNING *,revision::text`;
    return serializeRecordCheckpoint(saved!);
  }, db);
}

/** Prefix retention loss requires an explicit reset, including during snapshot handover. */
export async function requireRecordHistory(workspaceId: string, state: RecordSyncState, clock: any, sql: Db) {
  const after = state.mode === 'snapshot' ? state.boundary : state.after;
  const [oldest] = await sql`SELECT position::text FROM flightdeck_pg_record_journal WHERE workspace_id=${workspaceId} ORDER BY position LIMIT 1`;
  const floor = oldest ? BigInt(oldest.position) - 1n : BigInt(clock.position);
  if (BigInt(after) < BigInt(clock.journal_floor ?? 0) || BigInt(after) < floor) throw new RecordSyncError(409, 'history_pruned');
}
