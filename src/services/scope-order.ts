import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { authorizeFlightDeckPgOperation, getEffectiveFlightDeckPgGroupIds } from './flightdeck-pg-authorization';
import { RecordSyncError } from './flightdeck-record-sync-state';
type Db = ReturnType<typeof getDb>;
import type { FlightDeckPgScopeOrder as ScopeOrder } from '../types';
export async function readScopeOrder(workspaceId: string, actorId: string, sql: Db = getDb()): Promise<ScopeOrder> {
 const [row] = await sql<ScopeOrder[]>`SELECT actor_id::text AS id,* FROM flightdeck_pg_scope_orders WHERE workspace_id=${workspaceId} AND actor_id=${actorId}`;
 return row ?? { id: actorId, workspace_id: workspaceId, actor_id: actorId, scope_ids: [], row_version: 0, updated_at: null };
}
export async function writeScopeOrder(workspaceId: string, actorId: string, value: unknown, db: Db = getDb()) {
 const b = value as {scope_ids: string[]; expected_row_version: number; mutation_id: string};
 const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
 if (!b || Object.keys(b).some(k=>!['scope_ids','expected_row_version','mutation_id'].includes(k)) || !Array.isArray(b.scope_ids)
  || b.scope_ids.length>1000 || b.scope_ids.some(id=>typeof id!=='string'||!uuid.test(id)) || new Set(b.scope_ids).size!==b.scope_ids.length
  || !uuid.test(b.mutation_id) || !Number.isSafeInteger(b.expected_row_version) || b.expected_row_version<0 || b.expected_row_version>=2147483647) throw new RecordSyncError(400,'invalid_scope_order');
 const hash=createHash('sha256').update(JSON.stringify([b.scope_ids,b.expected_row_version])).digest('hex');
 return db.begin(async tx=>{
  const sql=tx as unknown as Db;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${actorId}:scope-order`},0))`;
  const [member]=await sql`SELECT a.npub,w.app_npub FROM flightdeck_pg_workspace_memberships m JOIN flightdeck_pg_actors a ON a.id=m.actor_id JOIN flightdeck_pg_workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=${workspaceId} AND m.actor_id=${actorId} FOR SHARE OF m`;
  if(!member) throw new RecordSyncError(403,'workspace_membership_required');
  const [prior]=await sql`SELECT request_hash,acknowledgement FROM flightdeck_pg_scope_order_mutations WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND mutation_id=${b.mutation_id}`;
  if(prior){if(prior.request_hash!==hash)throw new RecordSyncError(409,'mutation_id_reused');return prior.acknowledgement as ScopeOrder;}
  if((await readScopeOrder(workspaceId,actorId,sql)).row_version!==b.expected_row_version)throw new RecordSyncError(409,'scope_order_conflict');
  await sql`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId} FOR UPDATE`;
  // Reordering grants no authority; retain only readable active targets.
  for(const id of b.scope_ids){
   const [scope]=await sql`SELECT kind FROM flightdeck_pg_scopes WHERE workspace_id=${workspaceId} AND id=${id} AND archived_at IS NULL FOR SHARE`;
   if(!scope || ['dm','system'].includes(scope.kind))throw new RecordSyncError(400,'invalid_scope_order_target');
   const decisions=await Promise.all(['scope.read','scope.manage','context.edit'].map(permission=>authorizeFlightDeckPgOperation({actorNpub:member.npub,appNpub:member.app_npub,workspaceId,permission,resource:{type:'scope',scopeId:id}},sql)));
   if(!decisions.some(d=>d.allowed)){
    const groups=await getEffectiveFlightDeckPgGroupIds(workspaceId,actorId,sql);
    const [child]=await sql`SELECT 1 FROM flightdeck_pg_channels c JOIN flightdeck_pg_permission_grants g ON g.workspace_id=c.workspace_id AND g.resource_channel_id=c.id WHERE c.workspace_id=${workspaceId} AND c.scope_id=${id} AND c.archived_at IS NULL AND g.revoked_at IS NULL AND g.permission='channel.read' AND ((g.principal_type='actor' AND g.principal_actor_id=${actorId}) OR (g.principal_type='group' AND g.principal_group_id IN ${sql(groups.length?groups:['00000000-0000-0000-0000-000000000000'])})) LIMIT 1`;
    if(!child)throw new RecordSyncError(403,'scope_order_target_forbidden');
   }
  }
  const [row]=await sql<ScopeOrder[]>`INSERT INTO flightdeck_pg_scope_orders(workspace_id,actor_id,scope_ids) VALUES(${workspaceId},${actorId},${b.scope_ids}::uuid[]) ON CONFLICT(workspace_id,actor_id) DO UPDATE SET scope_ids=EXCLUDED.scope_ids,row_version=flightdeck_pg_scope_orders.row_version+1,updated_at=now() RETURNING actor_id::text AS id,*`;
  await sql`INSERT INTO flightdeck_pg_scope_order_mutations VALUES(${workspaceId},${actorId},${b.mutation_id},${hash},${sql.json(row as any)})`;
  await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,entity_id,operation,payload) VALUES(${workspaceId},${actorId},'scope_order.updated','scope_order',${actorId},'updated',${sql.json({actor_id:actorId})})`;
  return row!;
 });
}
