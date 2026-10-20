import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import type {
  FlightDeckRecordChange,
  FlightDeckRecordContextPage,
  FlightDeckRecordManifestPage,
  FlightDeckRecordManifestEntry,
  FlightDeckRecordPriorityPage,
  FlightDeckRecordRepairPage,
  FlightDeckLargeRecordManifest,
} from '../types';
import { RECORD_MAX_BYTES, RECORD_MAX_ROWS } from './flightdeck-record-delta';
import { recordFamilies } from './flightdeck-record-families';
import { RecordSyncError } from './flightdeck-record-sync-state';
import { recordVisibility, type RecordEntry } from './flightdeck-record-visibility';
import { issueLargeRecordManifest, type LargeRecordState } from './flightdeck-record-large';

type Db = ReturnType<typeof getDb>;
type ViewerInput = { workspaceId: string; actorId: string; appNpub: string };
type PriorityFilters = {
  families: string[];
  scopeId?: string;
  channelId?: string;
  threadId?: string;
  taskId?: string;
  documentId?: string;
};
type AuxiliaryState = {
  head: string;
  epoch: string;
  filters: PriorityFilters;
  position?: string;
  family?: string;
  id?: string;
  largeRecords?: LargeRecordState[];
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const token = uuid;
const version = /^(0|[1-9][0-9]{0,18})$/;
export const RECORD_AUX_CURSOR_LIMIT = 512;
export const prioritySyncDiscovery = {
  priority_feed: true,
  context_closure: true,
  repair_manifest: true,
  selective_repair: true,
  continuation_idle_days: 7,
  max_auxiliary_cursors_per_actor_workspace: RECORD_AUX_CURSOR_LIMIT,
  omission_policy: 'retain_downloaded',
};

function validateLimit(value?: number) {
  const limit = value ?? RECORD_MAX_ROWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > RECORD_MAX_ROWS) throw new RecordSyncError(400, 'invalid_limit');
  return limit;
}

export function normalizePriorityFilters(input: Partial<PriorityFilters>): PriorityFilters {
  const families = [...new Set(input.families ?? [])].sort();
  if (families.some(family => !(family in recordFamilies))) throw new RecordSyncError(400, 'invalid_family');
  for (const value of [input.scopeId, input.channelId, input.threadId, input.taskId, input.documentId]) {
    if (value !== undefined && !uuid.test(value)) throw new RecordSyncError(400, 'invalid_context');
  }
  return { families, ...(input.scopeId ? {scopeId: input.scopeId} : {}), ...(input.channelId ? {channelId: input.channelId} : {}),
    ...(input.threadId ? {threadId: input.threadId} : {}), ...(input.taskId ? {taskId: input.taskId} : {}),
    ...(input.documentId ? {documentId: input.documentId} : {}) };
}

function filtersEqual(left: PriorityFilters, right: PriorityFilters) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function viewerAndClock(input: ViewerInput, sql: Db) {
  const [viewer] = await sql`SELECT a.npub,w.app_npub FROM flightdeck_pg_workspace_memberships m
    JOIN flightdeck_pg_actors a ON a.id=m.actor_id JOIN flightdeck_pg_workspaces w ON w.id=m.workspace_id
    WHERE m.workspace_id=${input.workspaceId} AND m.actor_id=${input.actorId}`;
  if (!viewer) throw new RecordSyncError(403, 'workspace_membership_required');
  if (viewer.app_npub !== input.appNpub) throw new RecordSyncError(403, 'workspace_app_required');
  const [clock] = await sql`SELECT position::text,epoch,access_revision::text FROM flightdeck_pg_record_clock
    WHERE workspace_id=${input.workspaceId} FOR SHARE`;
  if (!clock) throw new RecordSyncError(409, 'reset_required');
  return {viewer:{npub:String(viewer.npub),app_npub:String(viewer.app_npub)}, clock};
}

async function loadState(kind: 'priority'|'manifest', input: ViewerInput & {cursor?: string; filters: PriorityFilters}, clock: any, sql: Db): Promise<AuxiliaryState> {
  if (!input.cursor) return {head:clock.position,epoch:clock.epoch,filters:input.filters};
  if (!token.test(input.cursor)) throw new RecordSyncError(400, 'invalid_cursor');
  const [saved] = await sql`SELECT state FROM flightdeck_pg_record_aux_cursors WHERE token=${input.cursor}
    AND workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND app_npub=${input.appNpub} AND kind=${kind}
    AND last_used_at>statement_timestamp()-interval '7 days'`;
  const state = saved?.state as AuxiliaryState | undefined;
  if (!state || state.epoch !== clock.epoch || !filtersEqual(state.filters,input.filters)) throw new RecordSyncError(409, 'auxiliary_cursor_invalid');
  await sql`UPDATE flightdeck_pg_record_aux_cursors SET last_used_at=clock_timestamp() WHERE token=${input.cursor}`;
  return state;
}

async function saveState(kind: 'priority'|'manifest', input: ViewerInput, state: AuxiliaryState, sql: Db) {
  const next = randomUUID();
  await sql`INSERT INTO flightdeck_pg_record_aux_cursors(token,workspace_id,actor_id,app_npub,kind,state)
    VALUES(${next},${input.workspaceId},${input.actorId},${input.appNpub},${kind},${sql.json(state)})`;
  await sql`DELETE FROM flightdeck_pg_record_aux_cursors WHERE token IN (
    SELECT token FROM flightdeck_pg_record_aux_cursors WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId}
    ORDER BY created_at DESC,token OFFSET ${RECORD_AUX_CURSOR_LIMIT})`;
  await sql`DELETE FROM flightdeck_pg_record_aux_cursors WHERE token IN (
    SELECT token FROM flightdeck_pg_record_aux_cursors WHERE last_used_at<=statement_timestamp()-interval '7 days'
    ORDER BY last_used_at,token LIMIT 64)`;
  return next;
}

function matchesFilters(entry:RecordEntry,filters:PriorityFilters){const context=entry.row;
  return (!filters.families.length||filters.families.includes(entry.family))
    &&(!filters.scopeId||(entry.family==='scope'?entry.id:context.scope_id)===filters.scopeId)
    &&(!filters.channelId||(entry.family==='channel'?entry.id:context.channel_id)===filters.channelId)
    &&(!filters.threadId||(entry.family==='thread'?entry.id:context.thread_id)===filters.threadId)
    &&(!filters.taskId||(entry.family==='task'?entry.id:context.task_id)===filters.taskId)
    &&(!filters.documentId||(entry.family==='doc'?entry.id:context.doc_id)===filters.documentId);
}

function filterSql(sql: Db, filters: PriorityFilters) {
  return sql`(cardinality(${filters.families}::text[]) = 0 OR family = ANY(${filters.families}::text[]))
    AND (${filters.scopeId ?? null}::text IS NULL OR COALESCE(CASE WHEN family='scope' THEN id END,context->>'scope_id') = ${filters.scopeId ?? null}::text)
    AND (${filters.channelId ?? null}::text IS NULL OR COALESCE(CASE WHEN family='channel' THEN id END,context->>'channel_id') = ${filters.channelId ?? null}::text)
    AND (${filters.threadId ?? null}::text IS NULL OR COALESCE(CASE WHEN family='thread' THEN id END,context->>'thread_id') = ${filters.threadId ?? null}::text)
    AND (${filters.taskId ?? null}::text IS NULL OR COALESCE(CASE WHEN family='task' THEN id END,context->>'task_id') = ${filters.taskId ?? null}::text)
    AND (${filters.documentId ?? null}::text IS NULL OR COALESCE(CASE WHEN family='doc' THEN id END,context->>'doc_id') = ${filters.documentId ?? null}::text)`;
}

function changeFrom(entry: RecordEntry, workspaceId: string, row: Record<string, unknown>|null): FlightDeckRecordChange {
  return {family:entry.family,id:entry.id,operation:entry.operation,version:entry.position,workspace_id:workspaceId,
    scope_id:entry.family==='scope'?entry.id:entry.row.scope_id ?? null,
    channel_id:entry.family==='channel'?entry.id:entry.row.channel_id ?? null,row};
}

function relationshipIds(context: Record<string, any>) {
  const result: Record<string,string> = {};
  for (const key of ['scope_id','channel_id','thread_id','task_id','doc_id','resource_type','resource_id']) {
    if (typeof context[key] === 'string') result[key] = context[key];
  }
  return result;
}

export async function readPriorityRecords(input: ViewerInput & {cursor?: string; limit?: number; filters: PriorityFilters; largeRecords?:string}, db: Db=getDb()): Promise<FlightDeckRecordPriorityPage> {
  if(input.largeRecords!==undefined&&input.largeRecords!=='chunked_v1')throw new RecordSyncError(400,'unsupported_extension');
  const limit=validateLimit(input.limit);
  return db.begin('isolation level repeatable read',async transaction=>{
    const sql=transaction as unknown as Db; const {viewer,clock}=await viewerAndClock(input,sql);
    const state=await loadState('priority',input,clock,sql);state.largeRecords=[];
    // The first page needs no synthetic text sentinel, keeping ordering
    // independent of database collation. Continuations use the exact last key.
    const candidates=state.position
      ? await sql<RecordEntry[]>`SELECT family,id,operation,position::text,bytes,context AS row
          FROM flightdeck_pg_record_heads WHERE workspace_id=${input.workspaceId} AND position<=${state.head}::bigint
          AND (position,family,id)<(${state.position}::bigint,${state.family!},${state.id!})
          AND ${filterSql(sql,state.filters)}
          ORDER BY flightdeck_pg_record_heads.position DESC,family DESC,id DESC LIMIT ${RECORD_MAX_ROWS+1}`
      : await sql<RecordEntry[]>`SELECT family,id,operation,position::text,bytes,context AS row
          FROM flightdeck_pg_record_heads WHERE workspace_id=${input.workspaceId} AND position<=${state.head}::bigint
          AND ${filterSql(sql,state.filters)}
          ORDER BY flightdeck_pg_record_heads.position DESC,family DESC,id DESC LIMIT ${RECORD_MAX_ROWS+1}`;
    const visible=recordVisibility(input.workspaceId,input.actorId,viewer,sql); const changes:FlightDeckRecordChange[]=[];const manifests:FlightDeckLargeRecordManifest[]=[];
    let scanned=0; let last:RecordEntry|undefined;
    for(const entry of candidates.slice(0,RECORD_MAX_ROWS)) {
      if(matchesFilters(entry,state.filters)&&await visible(entry)) {
        let row:null|Record<string,unknown>=null;
        if(entry.operation==='upsert') {
          const [payload]=await sql`SELECT row FROM flightdeck_pg_record_current WHERE workspace_id=${input.workspaceId}
            AND family=${entry.family} AND id=${entry.id} AND position=${entry.position}::bigint`;
          if(!payload) { scanned++; last=entry; continue; }
          row=payload.row;
        }
        const change=changeFrom(entry,input.workspaceId,row);
        if(Buffer.byteLength(JSON.stringify({...change,changes:[...changes,change]}))>RECORD_MAX_BYTES-8192) {
          if(!changes.length&&input.largeRecords==='chunked_v1'){
            const manifest=await issueLargeRecordManifest({workspaceId:input.workspaceId,entry,change:{...change,row:null},source:'current'},sql);
            state.largeRecords=[manifest];manifests.push(manifest.public);scanned++;last=entry;break;
          }
          if(!changes.length) throw new RecordSyncError(413,'record_too_large');
          break;
        }
        changes.push(change);
      }
      scanned++; last=entry;
      if(changes.length+manifests.length>=limit)break;
    }
    const hasMore=candidates.length>scanned;
    const nextState={...state,...(last?{position:last.position,family:last.family,id:last.id}:{})};
    const nextCursor=await saveState('priority',input,nextState,sql);
    const response:FlightDeckRecordPriorityPage={protocol_version:1,captured_head:state.head,changes,...(input.largeRecords==='chunked_v1'?{large_records:manifests}:{}),next_cursor:nextCursor,has_more:hasMore,
      progress:{scanned_rows:scanned,returned_rows:changes.length,response_bytes:0},bounds:{max_rows:RECORD_MAX_ROWS,max_bytes:RECORD_MAX_BYTES},
      coverage:'partial',retention_policy:'retain_downloaded'};
    response.progress.response_bytes=Buffer.byteLength(JSON.stringify(response));if(response.progress.response_bytes>RECORD_MAX_BYTES)throw new RecordSyncError(413,'record_too_large');
    return response;
  }) as unknown as FlightDeckRecordPriorityPage;
}

export async function readRepairManifest(input: ViewerInput & {cursor?:string;limit?:number;filters:PriorityFilters},db:Db=getDb()):Promise<FlightDeckRecordManifestPage>{
  const limit=validateLimit(input.limit);
  return db.begin('isolation level repeatable read',async transaction=>{
    const sql=transaction as unknown as Db;const {viewer,clock}=await viewerAndClock(input,sql);const state=await loadState('manifest',input,clock,sql);
    const afterFamily=state.family??'';const afterId=state.id??'';
    const candidates=await sql<RecordEntry[]>`WITH identities AS (
      SELECT DISTINCT family,id FROM flightdeck_pg_record_journal WHERE workspace_id=${input.workspaceId}
      AND position<=${state.head}::bigint AND (family,id)>(${afterFamily},${afterId})
      AND ${filterSql(sql,state.filters)}
      ORDER BY family,id LIMIT ${RECORD_MAX_ROWS+1}
    ) SELECT j.family,j.id,j.operation,j.position::text,j.bytes,j.context AS row FROM identities i
      CROSS JOIN LATERAL (SELECT family,id,operation,position,bytes,context FROM flightdeck_pg_record_journal
        WHERE workspace_id=${input.workspaceId} AND family=i.family AND id=i.id AND position<=${state.head}::bigint
        ORDER BY position DESC LIMIT 1) j ORDER BY j.family,j.id`;
    const visible=recordVisibility(input.workspaceId,input.actorId,viewer,sql);const entries:FlightDeckRecordManifestEntry[]=[];let scanned=0;let last:RecordEntry|undefined;
    for(const entry of candidates.slice(0,RECORD_MAX_ROWS)){if(matchesFilters(entry,state.filters)&&await visible(entry))entries.push({family:entry.family,id:entry.id,version:entry.position,
      state:entry.operation==='delete'?'deleted':'active',relationships:relationshipIds(entry.row)});scanned++;last=entry;if(entries.length>=limit)break;}
    const nextCursor=await saveState('manifest',input,{...state,...(last?{family:last.family,id:last.id}:{})},sql);
    const response:FlightDeckRecordManifestPage={protocol_version:1,captured_head:state.head,entries,next_cursor:nextCursor,has_more:candidates.length>scanned,
      progress:{scanned_rows:scanned,returned_rows:entries.length,response_bytes:0},bounds:{max_rows:RECORD_MAX_ROWS,max_bytes:RECORD_MAX_BYTES},
      coverage:'authorized_manifest',retention_policy:'retain_downloaded',recovery:{reason_code:'manifest_requested',strategy:'compare_then_repair',full_snapshot_required:false}};
    response.progress.response_bytes=Buffer.byteLength(JSON.stringify(response));return response;
  }) as unknown as FlightDeckRecordManifestPage;
}

export async function readContextClosure(input:ViewerInput&{resourceType:'channel'|'thread'|'task'|'document';resourceId:string},db:Db=getDb()):Promise<FlightDeckRecordContextPage>{
  if(!uuid.test(input.resourceId))throw new RecordSyncError(400,'invalid_context');
  return db.begin('isolation level repeatable read',async transaction=>{
    const sql=transaction as unknown as Db;const {viewer,clock}=await viewerAndClock(input,sql);
    const targetFamily=input.resourceType==='document'?'doc':input.resourceType;
    const [target]=await sql<RecordEntry[]>`SELECT family,id,'upsert'::text AS operation,position::text,bytes,context AS row
      FROM flightdeck_pg_record_current WHERE workspace_id=${input.workspaceId} AND family=${targetFamily} AND id=${input.resourceId}`;
    const visible=recordVisibility(input.workspaceId,input.actorId,viewer,sql);
    if(!target||!await visible(target))return {protocol_version:1,captured_head:clock.position,resource:{type:input.resourceType,id:input.resourceId},changes:[],
      dependencies:[],complete:true,bounds:{max_rows:RECORD_MAX_ROWS,max_bytes:RECORD_MAX_BYTES},retention_policy:'retain_downloaded'};
    const ids=[...(target.row.scope_id?[['scope',target.row.scope_id] as const]:[]),...(target.row.channel_id?[['channel',target.row.channel_id] as const]:[]),[targetFamily,input.resourceId] as const];
    const changes:FlightDeckRecordChange[]=[];const dependencies:{family:string;id:string}[]=[];
    for(const [family,id] of ids){if(changes.some(change=>change.family===family&&change.id===id))continue;const [entry]=await sql<RecordEntry[]>`SELECT family,id,'upsert'::text AS operation,position::text,bytes,context AS row FROM flightdeck_pg_record_current WHERE workspace_id=${input.workspaceId} AND family=${family} AND id=${id}`;
      if(!entry||!await visible(entry))continue;const [payload]=await sql`SELECT row FROM flightdeck_pg_record_current WHERE workspace_id=${input.workspaceId} AND family=${family} AND id=${id}`;
      const change=changeFrom(entry,input.workspaceId,payload!.row);if(Buffer.byteLength(JSON.stringify([...changes,change]))>RECORD_MAX_BYTES)throw new RecordSyncError(413,'record_too_large');changes.push(change);if(family!==targetFamily||id!==input.resourceId)dependencies.push({family,id});}
    return {protocol_version:1,captured_head:clock.position,resource:{type:input.resourceType,id:input.resourceId},changes,dependencies,complete:true,
      bounds:{max_rows:RECORD_MAX_ROWS,max_bytes:RECORD_MAX_BYTES},retention_policy:'retain_downloaded'};
  }) as unknown as FlightDeckRecordContextPage;
}

export async function repairRecords(input:ViewerInput&{records:{family:string;id:string;version?:string}[]},db:Db=getDb()):Promise<FlightDeckRecordRepairPage>{
  if(!Array.isArray(input.records)||input.records.length<1||input.records.length>RECORD_MAX_ROWS)throw new RecordSyncError(400,'invalid_repair_request');
  for(const item of input.records)if(!item||!(item.family in recordFamilies)||typeof item.id!=='string'||!item.id||item.id.length>512||(item.version!==undefined&&!version.test(item.version)))throw new RecordSyncError(400,'invalid_repair_request');
  return db.begin('isolation level repeatable read',async transaction=>{
    const sql=transaction as unknown as Db;const {viewer,clock}=await viewerAndClock(input,sql);const visible=recordVisibility(input.workspaceId,input.actorId,viewer,sql);
    const changes:FlightDeckRecordChange[]=[];const unresolved:{family:string;id:string;reason:'not_available'}[]=[];
    for(const requested of input.records){const [entry]=await sql<RecordEntry[]>`SELECT family,id,operation,position::text,bytes,context AS row FROM flightdeck_pg_record_heads WHERE workspace_id=${input.workspaceId} AND family=${requested.family} AND id=${requested.id}`;
      if(!entry||!await visible(entry)){unresolved.push({family:requested.family,id:requested.id,reason:'not_available'});continue;}let row:null|Record<string,unknown>=null;if(entry.operation==='upsert'){const [payload]=await sql`SELECT row FROM flightdeck_pg_record_current WHERE workspace_id=${input.workspaceId} AND family=${entry.family} AND id=${entry.id} AND position=${entry.position}::bigint`;if(!payload){unresolved.push({family:requested.family,id:requested.id,reason:'not_available'});continue;}row=payload.row;}const change=changeFrom(entry,input.workspaceId,row);
      if(Buffer.byteLength(JSON.stringify({changes:[...changes,change],unresolved}))>RECORD_MAX_BYTES)throw new RecordSyncError(413,'record_too_large');changes.push(change);}
    return {protocol_version:1,captured_head:clock.position,changes,unresolved,bounds:{max_rows:RECORD_MAX_ROWS,max_bytes:RECORD_MAX_BYTES},retention_policy:'retain_downloaded'};
  }) as unknown as FlightDeckRecordRepairPage;
}
