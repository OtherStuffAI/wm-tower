import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { RecordSyncError, type RecordSyncState } from './flightdeck-record-sync-state';
import { recordVisibility, type RecordEntry } from './flightdeck-record-visibility';
import { requireRecordClient, requireRecordMembership, validateRecordClientId, type RecordClientInput } from './flightdeck-record-checkpoints';
import type { FlightDeckRecordChange, FlightDeckLargeRecordManifest } from '../types';
type Db = ReturnType<typeof getDb>;
export const RECORD_CHUNK_BYTES = 262_144;
export type LargeRecordState = {
  public: FlightDeckLargeRecordManifest;
  source: 'current' | 'journal'; sourcePosition: string;
  change: Omit<FlightDeckRecordChange, 'row'> & {row:null}; context: Record<string, any>;
};
/** Build the pinned canonical envelope entirely in Postgres. Never decode the whole payload. */
function envelope(spec: LargeRecordState, workspaceId: string, sql: Db) {
  const source = spec.source === 'current'
    ? sql`SELECT row FROM flightdeck_pg_record_current WHERE workspace_id=${workspaceId} AND family=${spec.change.family} AND id=${spec.change.id} AND position=${spec.sourcePosition}::bigint`
    : sql`SELECT row FROM flightdeck_pg_record_journal WHERE workspace_id=${workspaceId} AND position=${spec.sourcePosition}::bigint AND family=${spec.change.family} AND id=${spec.change.id}`;
  return sql`WITH payload AS (${source}), actors AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('actor_id',a.id,'npub',a.npub,'display_name',a.display_name,'kind',a.kind) ORDER BY a.id),'[]'::jsonb) AS rows
    FROM flightdeck_pg_actors a WHERE a.id IN (
      SELECT reference::uuid FROM payload p, LATERAL unnest(ARRAY[
        p.row->>'created_by_actor_id',p.row->>'updated_by_actor_id',p.row->>'deleted_by_actor_id',p.row->>'archived_by_actor_id',
        p.row->>'owner_actor_id',p.row->>'actor_id',p.row->>'viewer_actor_id',p.row->>'reader_actor_id']) reference
      WHERE reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) SELECT convert_to(jsonb_build_object('change',${sql.json(spec.change)}::jsonb || jsonb_build_object('row',p.row),'actors',a.rows)::text,'UTF8') AS data FROM payload p CROSS JOIN actors a`;
}
export async function issueLargeRecordManifest(input: {workspaceId:string; entry:RecordEntry; change:FlightDeckRecordChange; source:'current'|'journal'}, sql: Db): Promise<LargeRecordState> {
  // Current snapshot wire versions intentionally use the snapshot boundary. Source
  // pinning instead uses the actual canonical position; the two are independent.
  const [current] = input.source === 'current' ? await sql`SELECT position::text FROM flightdeck_pg_record_current WHERE workspace_id=${input.workspaceId} AND family=${input.entry.family} AND id=${input.entry.id}` : [];
  const spec: LargeRecordState = {public: {} as FlightDeckLargeRecordManifest, source:input.source,
    sourcePosition: current?.position ?? input.entry.position, change:{...input.change,row:null}, context:input.entry.row};
  let bytes;
  try {
    [bytes] = await sql`SELECT octet_length(data) AS total_bytes,encode(sha256(data),'hex') AS sha256 FROM (${envelope(spec,input.workspaceId,sql)}) e`;
  } catch (error) {
    // Existing PostgreSQL datum/envelope limits may be reached by a combination
    // of individually legal rows and profiles. Never mint an unusable cursor.
    if ((error as {code?:string}).code === '54000') throw new RecordSyncError(413,'record_too_large');
    throw error;
  }
  if (!bytes) throw new RecordSyncError(409,'large_record_changed');
  spec.public = {manifest_id:randomUUID(),family:input.change.family,id:input.change.id,version:input.change.version,
    sha256:bytes.sha256,total_bytes:bytes.total_bytes,chunk_bytes:RECORD_CHUNK_BYTES,chunk_count:Math.ceil(bytes.total_bytes/RECORD_CHUNK_BYTES)};
  return spec;
}
export async function validateLargeRecord(spec: LargeRecordState, input: Pick<RecordClientInput,'workspaceId'|'actorId'>, sql: Db) {
  await requireRecordMembership(input,sql);
  const [viewer] = await sql`SELECT a.npub,w.app_npub FROM flightdeck_pg_actors a CROSS JOIN flightdeck_pg_workspaces w WHERE a.id=${input.actorId} AND w.id=${input.workspaceId}`;
  const visible = recordVisibility(input.workspaceId,input.actorId,{npub:viewer!.npub,app_npub:viewer!.app_npub},sql);
  if (!await visible({family:spec.change.family,id:spec.change.id,operation:spec.change.operation,position:spec.change.version,row:spec.context,bytes:0})) throw new RecordSyncError(403,'record_access_required');
  const [valid] = await sql`SELECT octet_length(data) AS bytes,encode(sha256(data),'hex') AS digest FROM (${envelope(spec,input.workspaceId,sql)}) e`;
  if (!valid || valid.bytes !== spec.public.total_bytes || valid.digest !== spec.public.sha256) throw new RecordSyncError(409,'large_record_changed');
}
export function requireLargeRecordReceipts(state: RecordSyncState, receipts: unknown) {
  const specs=state.largeRecords ?? [];
  if (!specs.length) {
    if (receipts !== undefined && (!Array.isArray(receipts) || receipts.length)) throw new RecordSyncError(400,'invalid_large_record_receipts');
    return;
  }
  if (!Array.isArray(receipts) || receipts.length !== specs.length || specs.some(spec=>receipts.filter(r=>r && r.manifest_id===spec.public.manifest_id && r.sha256===spec.public.sha256 && Object.keys(r).length===2).length!==1)) throw new RecordSyncError(409,'large_record_receipt_required');
}
export async function validateLargeRecordReceipts(state:RecordSyncState,input:RecordClientInput,receipts:unknown,sql:Db) {
  requireLargeRecordReceipts(state,receipts);
  for (const spec of state.largeRecords ?? []) await validateLargeRecord(spec,input,sql);
}
export async function readLargeRecordChunk(input:RecordClientInput & {cursor:string;manifestId:string;index:number},db:Db=getDb()):Promise<Uint8Array> {
  validateRecordClientId(input.clientId);
  const token=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!token.test(input.cursor) || !token.test(input.manifestId) || !Number.isSafeInteger(input.index) || input.index<0) throw new RecordSyncError(400,'invalid_chunk');
  for (let attempt=0;;attempt++) {
    try { return await db.begin('isolation level read committed',async transaction=>{
      const sql=transaction as unknown as Db;
      const [clock]=await sql`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${input.workspaceId} FOR SHARE`;
      await requireRecordMembership(input,sql);
      if (!clock) throw new RecordSyncError(409,'reset_required');
      await requireRecordClient(input,clock.epoch,sql);
      const [page]=await sql`SELECT state FROM flightdeck_pg_record_page_tokens WHERE token=${input.cursor} AND workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId} AND epoch=${clock.epoch} AND last_used_at>statement_timestamp()-interval '7 days'`;
      if (!page) throw new RecordSyncError(409,'page_token_invalid');
      const spec=(page.state as RecordSyncState).largeRecords?.find(s=>s.public.manifest_id===input.manifestId);
      if (!spec || input.index>=spec.public.chunk_count) throw new RecordSyncError(400,'invalid_chunk');
      await validateLargeRecord(spec,input,sql);
      const [chunk]=await sql`SELECT substring(data FROM ${input.index*RECORD_CHUNK_BYTES+1} FOR ${RECORD_CHUNK_BYTES}) AS data FROM (${envelope(spec,input.workspaceId,sql)}) e
        WHERE octet_length(data)=${spec.public.total_bytes} AND encode(sha256(data),'hex')=${spec.public.sha256}`;
      // Profile updates are deliberately independent of the workspace clock.
      // Validate the exact bytes and digest in the same statement as the slice.
      if (!chunk) throw new RecordSyncError(409,'large_record_changed');
      await sql`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${input.workspaceId} FOR SHARE`;
      await requireRecordClient(input,clock.epoch,sql,true);
      const renewed=await sql`UPDATE flightdeck_pg_record_page_tokens SET last_used_at=clock_timestamp() WHERE token=${input.cursor} AND last_used_at>clock_timestamp()-interval '7 days' RETURNING token`;
      if (!renewed.length) throw new RecordSyncError(409,'page_token_invalid');
      return chunk!.data;
    }) as unknown as Uint8Array; }
    catch(error) { if(attempt>=2 || !['40001','40P01'].includes(String((error as {code?:string}).code))) throw error; }
  }
}

/** Chunk read for priority pages. The auxiliary token is still viewer/app/epoch bound,
 * but it deliberately has no device checkpoint or acknowledgement semantics. */
export async function readPriorityLargeRecordChunk(input:{workspaceId:string;actorId:string;appNpub:string;cursor:string;manifestId:string;index:number},db:Db=getDb()):Promise<Uint8Array>{
  const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if(!id.test(input.cursor)||!id.test(input.manifestId)||!Number.isSafeInteger(input.index)||input.index<0)throw new RecordSyncError(400,'invalid_chunk');
  return db.begin('isolation level read committed',async transaction=>{const sql=transaction as unknown as Db;
    const [clock]=await sql`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${input.workspaceId} FOR SHARE`;
    const [viewer]=await sql`SELECT a.npub,w.app_npub FROM flightdeck_pg_workspace_memberships m JOIN flightdeck_pg_actors a ON a.id=m.actor_id
      JOIN flightdeck_pg_workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=${input.workspaceId} AND m.actor_id=${input.actorId}`;
    if(!viewer)throw new RecordSyncError(403,'workspace_membership_required');
    if(viewer.app_npub!==input.appNpub)throw new RecordSyncError(403,'workspace_app_required');
    const [page]=await sql`SELECT state FROM flightdeck_pg_record_aux_cursors WHERE token=${input.cursor} AND workspace_id=${input.workspaceId}
      AND actor_id=${input.actorId} AND app_npub=${input.appNpub} AND kind='priority' AND last_used_at>statement_timestamp()-interval '7 days'`;
    const state=page?.state as {epoch?:string;largeRecords?:LargeRecordState[]}|undefined;
    if(!clock||!state||state.epoch!==clock.epoch)throw new RecordSyncError(409,'auxiliary_cursor_invalid');
    const spec=state.largeRecords?.find(item=>item.public.manifest_id===input.manifestId);
    if(!spec||input.index>=spec.public.chunk_count)throw new RecordSyncError(400,'invalid_chunk');
    await validateLargeRecord(spec,input,sql);
    const [chunk]=await sql`SELECT substring(data FROM ${input.index*RECORD_CHUNK_BYTES+1} FOR ${RECORD_CHUNK_BYTES}) AS data FROM (${envelope(spec,input.workspaceId,sql)}) e
      WHERE octet_length(data)=${spec.public.total_bytes} AND encode(sha256(data),'hex')=${spec.public.sha256}`;
    if(!chunk)throw new RecordSyncError(409,'large_record_changed');
    await sql`UPDATE flightdeck_pg_record_aux_cursors SET last_used_at=clock_timestamp() WHERE token=${input.cursor}`;
    return chunk.data as Uint8Array;
  }) as unknown as Uint8Array;
}
