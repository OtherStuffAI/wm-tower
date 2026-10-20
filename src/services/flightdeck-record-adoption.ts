import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db';
import type { FlightDeckRecordCheckpoint, FlightDeckRecordManifestEntry } from '../types';
import { recordAccess } from './flightdeck-record-access';
import {
  requireRecordClient,
  requireRecordHistory,
  serializeRecordCheckpoint,
  validateRecordClientId,
} from './flightdeck-record-checkpoints';
import { RECORD_MAX_BYTES, RECORD_MAX_ROWS } from './flightdeck-record-delta';
import { recordFamilies } from './flightdeck-record-families';
import { RecordSyncError, type RecordSyncState } from './flightdeck-record-sync-state';
import { recordVisibility, type RecordEntry } from './flightdeck-record-visibility';

type Db = ReturnType<typeof getDb>;
type AdoptionInput = { workspaceId: string; actorId: string; appNpub: string; clientId: string };
type InventoryEntry = { family: string; id: string; state: 'active'|'deleted'|'missing'; version?: string };
type ReceiptEntry = { family: string; id: string; state: 'active'|'deleted'; version: string };
type AdoptionState = {
  challenge: FlightDeckRecordManifestEntry[];
  afterFamily: string;
  afterId: string;
  hasMore: boolean;
  mismatches?: FlightDeckRecordManifestEntry[];
};
type StartBody = { request_id: string; manifest_cursor: string; expected_checkpoint_revision: string };
type InventoryBody = { cursor: string; inventory: InventoryEntry[] };
type RepairBody = { cursor: string; repaired: ReceiptEntry[] };
export type RecordAdoptionBody = StartBody | InventoryBody | RepairBody;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^(0|[1-9][0-9]{0,18})$/;
export const RECORD_ADOPTION_LIMIT = 32;
export const RECORD_ADOPTION_IDLE_DAYS = 7;

export const recordAdoptionDiscovery = {
  version: 1,
  route: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync/clients/{clientId}/adoption',
  requires_unfiltered_manifest: true,
  max_inventory_rows: RECORD_MAX_ROWS,
  max_request_bytes: RECORD_MAX_BYTES,
  max_response_bytes: RECORD_MAX_BYTES,
  max_sessions_per_actor_workspace: RECORD_ADOPTION_LIMIT,
  continuation_idle_days: RECORD_ADOPTION_IDLE_DAYS,
  checkpoint_mode: 'delta_at_captured_head',
};

function hashBody(body: unknown) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function assertResponseBound(response: unknown) {
  if (Buffer.byteLength(JSON.stringify(response)) > RECORD_MAX_BYTES) throw new RecordSyncError(413, 'adoption_response_too_large');
}

function manifestEntry(entry: RecordEntry): FlightDeckRecordManifestEntry {
  return { family: entry.family, id: entry.id, version: entry.position,
    state: entry.operation === 'delete' ? 'deleted' : 'active', relationships: relationshipIds(entry.row) };
}

function relationshipIds(context: Record<string, any>) {
  const result: Record<string,string> = {};
  for (const key of ['scope_id','channel_id','thread_id','task_id','doc_id','resource_type','resource_id']) {
    if (typeof context[key] === 'string') result[key] = context[key];
  }
  return result;
}

async function authority(input: AdoptionInput, sql: Db) {
  const [viewer] = await sql`SELECT a.npub,w.app_npub FROM flightdeck_pg_workspace_memberships m
    JOIN flightdeck_pg_actors a ON a.id=m.actor_id JOIN flightdeck_pg_workspaces w ON w.id=m.workspace_id
    WHERE m.workspace_id=${input.workspaceId} AND m.actor_id=${input.actorId}`;
  if (!viewer) throw new RecordSyncError(403, 'workspace_membership_required');
  if (viewer.app_npub !== input.appNpub) throw new RecordSyncError(403, 'workspace_app_required');
  const [clock] = await sql`SELECT position::text,epoch,journal_floor::text,access_revision::text
    FROM flightdeck_pg_record_clock WHERE workspace_id=${input.workspaceId} FOR SHARE`;
  if (!clock) throw new RecordSyncError(409, 'reset_required');
  return { viewer: { npub: String(viewer.npub), app_npub: String(viewer.app_npub) }, clock };
}

async function challengeAfter(input: AdoptionInput, viewer: {npub:string;app_npub:string}, head: string,
  afterFamily: string, afterId: string, sql: Db): Promise<AdoptionState> {
  const candidates = await sql<RecordEntry[]>`WITH identities AS (
    SELECT DISTINCT family,id FROM flightdeck_pg_record_journal WHERE workspace_id=${input.workspaceId}
    AND position<=${head}::bigint AND (family,id)>(${afterFamily},${afterId})
    ORDER BY family,id LIMIT ${RECORD_MAX_ROWS + 1}
  ) SELECT j.family,j.id,j.operation,j.position::text,j.bytes,j.context AS row FROM identities i
    CROSS JOIN LATERAL (SELECT family,id,operation,position,bytes,context FROM flightdeck_pg_record_journal
      WHERE workspace_id=${input.workspaceId} AND family=i.family AND id=i.id AND position<=${head}::bigint
      ORDER BY position DESC LIMIT 1) j ORDER BY j.family,j.id`;
  const visible = recordVisibility(input.workspaceId,input.actorId,viewer,sql);
  const challenge: FlightDeckRecordManifestEntry[] = [];
  let scanned = 0;
  let last: RecordEntry|undefined;
  for (const entry of candidates.slice(0,RECORD_MAX_ROWS)) {
    if (await visible(entry)) challenge.push(manifestEntry(entry));
    scanned++;
    last = entry;
  }
  return { challenge, afterFamily:last?.family ?? afterFamily, afterId:last?.id ?? afterId, hasMore:candidates.length>scanned };
}

function common(row: any) {
  return { protocol_version:2 as const, adoption_id:String(row.adoption_id), captured_head:String(row.captured_head),
    authority_epoch:String(row.epoch), access_revision:String(row.access_revision), checkpoint_revision:String(row.base_revision),
    bounds:{max_rows:RECORD_MAX_ROWS,max_bytes:RECORD_MAX_BYTES}, retention_policy:'retain_downloaded' as const };
}

function inventoryResponse(row:any,state:AdoptionState,cursor:string) {
  return {...common(row),status:'inventory_required' as const,cursor,challenge:state.challenge,has_more:state.hasMore};
}

function repairResponse(row:any,state:AdoptionState,cursor:string) {
  return {...common(row),status:'repair_required' as const,cursor,records:state.mismatches,
    repair_route:'/api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync/repair'};
}

function validateStart(body: any): asserts body is StartBody {
  if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).sort().join(',')!=='expected_checkpoint_revision,manifest_cursor,request_id'
    || !uuid.test(body.request_id) || !uuid.test(body.manifest_cursor) || !decimal.test(body.expected_checkpoint_revision)) {
    throw new RecordSyncError(400,'invalid_adoption_request');
  }
}

function validateCursorBody(body:any): asserts body is InventoryBody|RepairBody {
  if (!body || typeof body!=='object' || Array.isArray(body) || !uuid.test(body.cursor)) throw new RecordSyncError(400,'invalid_adoption_request');
  const keys=Object.keys(body).sort().join(',');
  if (keys!=='cursor,inventory' && keys!=='cursor,repaired') throw new RecordSyncError(400,'invalid_adoption_request');
  const rows = 'inventory' in body ? body.inventory : body.repaired;
  if (!Array.isArray(rows) || rows.length>RECORD_MAX_ROWS) throw new RecordSyncError(400,'invalid_adoption_request');
  for (const item of rows) {
    if (!item || typeof item!=='object' || Array.isArray(item) || !(item.family in recordFamilies)
      || typeof item.id!=='string' || !item.id || item.id.length>512) throw new RecordSyncError(400,'invalid_adoption_request');
    if ('inventory' in body) {
      const keys=Object.keys(item).sort().join(',');
      if (!['family,id,state','family,id,state,version'].includes(keys) || !['active','deleted','missing'].includes(item.state)
        || (item.state==='missing' ? item.version!==undefined : !decimal.test(item.version))) {
        throw new RecordSyncError(400,'invalid_adoption_request');
      }
    } else if (Object.keys(item).sort().join(',')!=='family,id,state,version'
      || !['active','deleted'].includes(item.state) || !decimal.test(item.version)) throw new RecordSyncError(400,'invalid_adoption_request');
  }
}

async function commitAdoption(input:AdoptionInput,row:any,sql:Db,clock:any):Promise<any> {
  const [client]=await sql`SELECT *,revision::text FROM flightdeck_pg_record_clients
    WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId} FOR UPDATE`;
  if (!client || client.epoch!==row.epoch || client.revision!==String(row.base_revision)) throw new RecordSyncError(409,'adoption_checkpoint_conflict');
  const state:RecordSyncState={mode:'delta',boundary:String(row.captured_head),after:String(row.captured_head),family:'',id:'',snapshotId:null,
    access:await recordAccess(input.workspaceId,input.actorId,sql),accessRevision:String(row.access_revision),progress:'0'};
  await requireRecordHistory(input.workspaceId,state,clock,sql);
  const adoptedCursor=randomUUID();
  const [saved]=await sql`UPDATE flightdeck_pg_record_clients SET initial_cursor=${adoptedCursor},initial_state=${sql.json(state)},
    checkpoint_cursor=${adoptedCursor},checkpoint_state=${sql.json(state)},revision=revision+1,last_active_at=clock_timestamp()
    WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId} AND revision=${row.base_revision}
    RETURNING *,revision::text`;
  if(!saved)throw new RecordSyncError(409,'adoption_checkpoint_conflict');
  await sql`DELETE FROM flightdeck_pg_record_page_tokens WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId}`;
  const checkpoint:FlightDeckRecordCheckpoint=serializeRecordCheckpoint({...saved,access_revision:clock.access_revision});
  return {...common(row),status:'adopted' as const,checkpoint};
}

async function begin(input:AdoptionInput,body:StartBody,sql:Db,viewer:any,clock:any) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${input.workspaceId}),hashtext(${input.actorId}))`;
  const [prior]=await sql`SELECT *,captured_head::text,access_revision::text,base_revision::text,
    last_used_at>statement_timestamp()-interval '7 days' AS active FROM flightdeck_pg_record_adoptions
    WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId}
    AND app_npub=${input.appNpub} AND request_id=${body.request_id} FOR UPDATE`;
  if(prior){
    if(!prior.active)throw new RecordSyncError(409,'adoption_expired');
    if(prior.manifest_cursor!==body.manifest_cursor||prior.base_revision!==body.expected_checkpoint_revision)throw new RecordSyncError(409,'adoption_request_conflict');
    if(prior.epoch!==clock.epoch||prior.access_revision!==clock.access_revision)throw new RecordSyncError(409,'adoption_authority_changed');
    const client=await requireRecordClient(input,clock.epoch,sql,true);
    const expectedRevision=prior.phase==='adopted' ? String(BigInt(prior.base_revision)+1n) : String(prior.base_revision);
    if(client.revision!==expectedRevision)throw new RecordSyncError(409,'adoption_checkpoint_conflict');
    await sql`UPDATE flightdeck_pg_record_adoptions SET last_used_at=clock_timestamp() WHERE adoption_id=${prior.adoption_id}`;
    return prior.last_response;
  }
  await sql`DELETE FROM flightdeck_pg_record_adoptions WHERE last_used_at<=clock_timestamp()-interval '7 days'`;
  const client=await requireRecordClient(input,clock.epoch,sql,true);
  if(client.revision!==body.expected_checkpoint_revision)throw new RecordSyncError(409,'adoption_checkpoint_conflict');
  if((client.checkpoint_state as RecordSyncState|null)?.mode==='delta')throw new RecordSyncError(409,'client_already_checkpointed');
  const [manifest]=await sql`SELECT state FROM flightdeck_pg_record_aux_cursors WHERE token=${body.manifest_cursor}
    AND workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND app_npub=${input.appNpub} AND kind='manifest'
    AND last_used_at>statement_timestamp()-interval '7 days' FOR UPDATE`;
  const captured=manifest?.state as any;
  if(!captured||captured.epoch!==clock.epoch||captured.accessRevision!==clock.access_revision
    ||JSON.stringify(captured.filters)!==JSON.stringify({families:[]}))throw new RecordSyncError(409,'adoption_manifest_invalid');
  const [count]=await sql`SELECT count(*)::int AS n FROM flightdeck_pg_record_adoptions WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND committed_at IS NULL`;
  if(count!.n>=RECORD_ADOPTION_LIMIT)throw new RecordSyncError(409,'adoption_capacity');
  const state=await challengeAfter(input,viewer,captured.head,'','',sql);
  const row={adoption_id:randomUUID(),captured_head:captured.head,epoch:clock.epoch,access_revision:clock.access_revision,base_revision:client.revision};
  const cursor=randomUUID();
  const response=inventoryResponse(row,state,cursor);assertResponseBound(response);
  await sql`INSERT INTO flightdeck_pg_record_adoptions(adoption_id,workspace_id,actor_id,client_id,app_npub,request_id,manifest_cursor,
    epoch,access_revision,captured_head,base_revision,cursor,phase,state,last_response)
    VALUES(${row.adoption_id},${input.workspaceId},${input.actorId},${input.clientId},${input.appNpub},${body.request_id},${body.manifest_cursor},
      ${clock.epoch},${clock.access_revision},${captured.head},${client.revision},${cursor},'inventory',${sql.json(state as any)},${sql.json(response as any)})`;
  return response;
}

function exactInventory(challenge:FlightDeckRecordManifestEntry[],inventory:InventoryEntry[]){
  if(inventory.length!==challenge.length)throw new RecordSyncError(409,'adoption_inventory_incomplete');
  const mismatches:FlightDeckRecordManifestEntry[]=[];
  for(let i=0;i<challenge.length;i++){
    const expected=challenge[i]!,actual=inventory[i]!;
    if(actual.family!==expected.family||actual.id!==expected.id)throw new RecordSyncError(409,'adoption_inventory_invalid');
    if(actual.state!==expected.state||actual.version!==expected.version)mismatches.push(expected);
  }
  return mismatches;
}

async function exactRepairs(input:AdoptionInput,viewer:any,mismatches:FlightDeckRecordManifestEntry[],repaired:ReceiptEntry[],sql:Db){
  if(repaired.length!==mismatches.length)throw new RecordSyncError(409,'adoption_repair_incomplete');
  const visible=recordVisibility(input.workspaceId,input.actorId,viewer,sql);
  for(let i=0;i<mismatches.length;i++){
    const expected=mismatches[i]!,actual=repaired[i]!;
    if(actual.family!==expected.family||actual.id!==expected.id)throw new RecordSyncError(409,'adoption_repair_incomplete');
    const [entry]=await sql<RecordEntry[]>`SELECT family,id,operation,position::text,bytes,context AS row FROM flightdeck_pg_record_heads
      WHERE workspace_id=${input.workspaceId} AND family=${expected.family} AND id=${expected.id}`;
    if(!entry||!await visible(entry)||actual.version!==entry.position||actual.state!==(entry.operation==='delete'?'deleted':'active')){
      throw new RecordSyncError(409,'adoption_repair_incomplete');
    }
  }
}

export async function adoptRecordCache(input:AdoptionInput,body:RecordAdoptionBody,db:Db=getDb()):Promise<any>{
  validateRecordClientId(input.clientId);
  if(Buffer.byteLength(JSON.stringify(body))>RECORD_MAX_BYTES)throw new RecordSyncError(413,'adoption_request_too_large');
  const isStart='request_id' in (body as any);
  if(isStart)validateStart(body);else validateCursorBody(body);
  return db.begin(async transaction=>{
    const sql=transaction as unknown as Db;const {viewer,clock}=await authority(input,sql);
    if(isStart)return begin(input,body as StartBody,sql,viewer,clock);
    const requestHash=hashBody(body);
    const [row]=await sql`SELECT *,captured_head::text,access_revision::text,base_revision::text,
      last_used_at>statement_timestamp()-interval '7 days' AS active FROM flightdeck_pg_record_adoptions
      WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId}
      AND app_npub=${input.appNpub} AND (cursor=${(body as any).cursor} OR previous_cursor=${(body as any).cursor}) FOR UPDATE`;
    if(!row)throw new RecordSyncError(409,'adoption_cursor_invalid');
    if(!row.active)throw new RecordSyncError(409,'adoption_expired');
    if(row.previous_cursor===(body as any).cursor){if(row.last_request_hash===requestHash)return row.last_response;throw new RecordSyncError(409,'adoption_cursor_invalid');}
    if(row.epoch!==clock.epoch||row.access_revision!==clock.access_revision)throw new RecordSyncError(409,'adoption_authority_changed');
    const [client]=await sql`SELECT revision::text FROM flightdeck_pg_record_clients WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId}`;
    if(!client||client.revision!==row.base_revision)throw new RecordSyncError(409,'adoption_checkpoint_conflict');
    let state=row.state as AdoptionState;
    if(row.phase==='inventory'){
      if(!('inventory' in body))throw new RecordSyncError(409,'adoption_phase_invalid');
      const mismatches=exactInventory(state.challenge,body.inventory);
      if(mismatches.length)state={...state,mismatches};
    }else if(row.phase==='repair'){
      if(!('repaired' in body))throw new RecordSyncError(409,'adoption_phase_invalid');
      await exactRepairs(input,viewer,state.mismatches??[],body.repaired,sql);
      state={...state,mismatches:undefined};
    }else return row.last_response;
    let response:any;let phase:'inventory'|'repair'|'adopted';let nextCursor=randomUUID();
    if(state.mismatches?.length){phase='repair';response=repairResponse(row,state,nextCursor);}
    else if(state.hasMore){state=await challengeAfter(input,viewer,String(row.captured_head),state.afterFamily,state.afterId,sql);phase='inventory';response=inventoryResponse(row,state,nextCursor);}
    else{phase='adopted';response=await commitAdoption(input,row,sql,clock);nextCursor=row.cursor;}
    assertResponseBound(response);
    await sql`UPDATE flightdeck_pg_record_adoptions SET previous_cursor=cursor,cursor=${nextCursor},phase=${phase},state=${sql.json(state as any)},
      last_request_hash=${requestHash},last_response=${sql.json(response)},last_used_at=clock_timestamp(),committed_at=${phase==='adopted'?sql`clock_timestamp()`:sql`committed_at`}
      WHERE adoption_id=${row.adoption_id}`;
    return response;
  }) as unknown as Promise<any>;
}
