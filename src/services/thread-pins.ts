import { createHash } from 'node:crypto';
import { getDb } from '../db';
import type { FlightDeckPgThreadPin } from '../types';
import { authorizeFlightDeckPgOperation } from './flightdeck-pg-authorization';
import { isFlightDeckPgThreadParticipant } from './flightdeck-pg-api';
export class ThreadPinError extends Error {
 constructor(public status: 400 | 403 | 404 | 409, public code: string) { super(code); }
}
type Db = ReturnType<typeof getDb>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function mutateThreadPin(workspaceId: string, actorId: string, threadId: string, value: unknown, db: Db = getDb()): Promise<FlightDeckPgThreadPin> {
 const b = value as { pinned: boolean; expected_row_version: number; mutation_id: string; import_only?: boolean; pinned_at?: string };
 if (!uuid.test(threadId) || !b || typeof b !== 'object' || Array.isArray(b)
  || Object.keys(b).some(k=>!['pinned','expected_row_version','mutation_id','import_only','pinned_at'].includes(k))
  || typeof b.pinned !== 'boolean' || typeof b.mutation_id !== 'string' || !uuid.test(b.mutation_id)
  || !Number.isSafeInteger(b.expected_row_version) || b.expected_row_version<0 || b.expected_row_version>=2147483647
  || (b.import_only !== undefined && typeof b.import_only !== 'boolean')
  || (b.import_only && (!b.pinned || b.expected_row_version !== 0))
  || (b.pinned_at !== undefined && (!b.import_only || typeof b.pinned_at !== 'string' || !Number.isFinite(Date.parse(b.pinned_at))))) throw new ThreadPinError(400,'invalid_thread_pin');
 const hash=createHash('sha256').update(JSON.stringify([threadId,b.pinned,b.expected_row_version,b.import_only===true,b.pinned_at??null])).digest('hex');
 return db.begin(async tx=>{
  const sql=tx as unknown as Db;
  // All pin writers acquire the record clock before target/actor locks, matching
  // authority/lifecycle writers and record_emit's commit ordering.
  await sql`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId} FOR UPDATE`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${actorId}:${threadId}:pin`},0))`;
  const [member]=await sql`SELECT a.npub,a.kind,w.app_npub FROM flightdeck_pg_workspace_memberships m JOIN flightdeck_pg_actors a ON a.id=m.actor_id JOIN flightdeck_pg_workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=${workspaceId} AND m.actor_id=${actorId} FOR SHARE OF m`;
  if(!member) throw new ThreadPinError(403,'workspace_membership_required');
  const [prior]=await sql`SELECT request_hash,acknowledgement FROM flightdeck_pg_thread_pin_mutations WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND mutation_id=${b.mutation_id}`;
  if(prior){if(prior.request_hash!==hash)throw new ThreadPinError(409,'mutation_id_reused');return prior.acknowledgement as FlightDeckPgThreadPin;}
  const [current]=await sql<FlightDeckPgThreadPin[]>`SELECT * FROM flightdeck_pg_thread_pins WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND thread_id=${threadId}`;
  // A later device's legacy import cannot replace either a pin or a tombstone.
  if(b.import_only && current) {
   await sql`INSERT INTO flightdeck_pg_thread_pin_mutations VALUES(${workspaceId},${actorId},${b.mutation_id},${hash},${sql.json(current as any)})`;
   return current;
  }
  if((current?.row_version??0)!==b.expected_row_version)throw new ThreadPinError(409,'thread_pin_conflict');
  let channelId=current?.channel_id??null,rootId=current?.root_record_id??null;
  if(b.pinned){
   const [thread]=await sql`SELECT * FROM flightdeck_pg_threads WHERE workspace_id=${workspaceId} AND id=${threadId} AND deleted_at IS NULL FOR SHARE`;
   if(thread){
    const access=await authorizeFlightDeckPgOperation({actorNpub:member.npub,appNpub:member.app_npub,workspaceId,permission:'channel.read',resource:{type:'channel',channelId:thread.channel_id}},sql);
    const participant=member.kind==='human'||await isFlightDeckPgThreadParticipant({workspaceId,threadId,actorId,actorNpub:member.npub},sql);
    if(!access.allowed||!participant){if(!b.import_only)throw new ThreadPinError(403,'thread_pin_target_forbidden');}
    else {channelId=thread.channel_id;rootId=thread.parent_thread_id?thread.id:thread.source_message_id??thread.id;}
   } else if(!b.import_only)throw new ThreadPinError(404,'thread_not_found');
   // Imports preserve unavailable UUID selections only, without metadata or access.
  }
  const [row]=await sql<FlightDeckPgThreadPin[]>`INSERT INTO flightdeck_pg_thread_pins(workspace_id,actor_id,thread_id,channel_id,root_record_id,pinned,pinned_at)
    VALUES(${workspaceId},${actorId},${threadId},${channelId},${rootId},${b.pinned},${b.pinned ? (b.pinned_at ? new Date(b.pinned_at).toISOString() : new Date().toISOString()) : null})
    ON CONFLICT(workspace_id,actor_id,thread_id) DO UPDATE SET pinned=EXCLUDED.pinned,channel_id=EXCLUDED.channel_id,root_record_id=EXCLUDED.root_record_id,
    pinned_at=CASE WHEN EXCLUDED.pinned AND flightdeck_pg_thread_pins.pinned THEN flightdeck_pg_thread_pins.pinned_at ELSE EXCLUDED.pinned_at END,
    row_version=flightdeck_pg_thread_pins.row_version+1,updated_at=now() RETURNING *`;
  await sql`INSERT INTO flightdeck_pg_thread_pin_mutations VALUES(${workspaceId},${actorId},${b.mutation_id},${hash},${sql.json(row as any)})`;
  // No channel/scope event routing: personal pins must never enter shared audiences.
  await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,entity_id,operation,payload) VALUES(${workspaceId},${actorId},'thread_pin.updated','thread_pin',${row!.id},'updated',${sql.json({actor_id:actorId})})`;
  return row!;
 });
}
