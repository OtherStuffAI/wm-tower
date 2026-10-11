import { getDb } from '../db';
import type { FlightDeckRecordAccessPartition, FlightDeckRecordAccessChange } from '../types';
import type { RecordSyncState } from './flightdeck-record-sync-state';
type Db = ReturnType<typeof getDb>;
export const RECORD_ACCESS_PAGE_LIMIT = 50;
export function accessPartition(key: string): FlightDeckRecordAccessPartition {
  const [resource_type, resource_id, selector] = key.split(':');
  const [family, resource_kind] = selector!.split('/');
  return { family: family!, resource_type: resource_type as FlightDeckRecordAccessPartition['resource_type'],
    resource_id: resource_id!, ...(resource_kind ? { resource_kind } : {}) };
}
export async function recordAccess(workspaceId: string, actorId: string, sql: Db): Promise<string[]> {
  const [row] = await sql`SELECT flightdeck_pg_record_access(${workspaceId}::uuid,${actorId}::uuid) AS access`;
  return row!.access;
}
/** Only gains queue historic partitions. Revocation cancels remaining catchup. */
export async function observeRecordAccess(state: RecordSyncState, revision: string, workspaceId: string, actorId: string, sql: Db) {
  const next: RecordSyncState = structuredClone(state);
  if (!next.access || next.accessRevision !== revision) {
    const access = await recordAccess(workspaceId, actorId, sql);
    const old = new Set(next.access ?? access), current = new Set(access);
    const gains = access.filter(key => !old.has(key));
    const losses = [...old].filter(key => !current.has(key));
    const cutoff = state.mode === 'snapshot' ? state.boundary : state.after;
    next.catchups = (next.catchups ?? []).filter(item => current.has(item.key));
    // Empty resource birth has no historic catchup. Resolve only gains with
    // canonical rows at/before the independent ordinary-cursor cutoff.
    const history = gains.length ? await sql`SELECT key FROM unnest(${gains}::text[]) key
      WHERE EXISTS(SELECT 1 FROM flightdeck_pg_record_current c WHERE c.workspace_id=${workspaceId}
        AND c.family=split_part(split_part(key,':',3),'/',1) AND c.position<=${cutoff}::bigint
        AND (split_part(key,':',1)='workspace'
          OR (split_part(key,':',1)='channel' AND COALESCE(c.context->>'channel_id',CASE WHEN c.family='channel' THEN c.id END)=split_part(key,':',2))
          OR (split_part(key,':',1)='scope' AND COALESCE(c.context->>'scope_id',CASE WHEN c.family='scope' THEN c.id END)=split_part(key,':',2)))
        AND (split_part(split_part(key,':',3),'/',2)='' OR c.context->>'resource_type'=split_part(split_part(key,':',3),'/',2)))` : [];
    next.catchups.push(...history.map(({key}) => ({ key, cutoff, id: '' })));
    // Undelivered notifications describe current authority, not obsolete gains.
    next.accessChanges = (next.accessChanges ?? []).map(change => ({ ...change,
      status: current.has(change.key) ? 'granted' as const : 'lost' as const }));
    const changes = new Map((next.accessChanges ?? []).map(change => [change.key, change]));
    for (const key of gains) changes.set(key, {key,status:'granted'});
    for (const key of losses) changes.set(key, {key,status:'lost'});
    next.accessChanges = [...changes.values()];
    next.access = access; next.accessRevision = revision;
  }
  return next;
}
export function drainAccessChanges(state: RecordSyncState, limit: number): FlightDeckRecordAccessChange[] {
  return (state.accessChanges?.splice(0, Math.min(limit, RECORD_ACCESS_PAGE_LIMIT)) ?? [])
    .map(({key,status}) => ({...accessPartition(key),status}));
}
