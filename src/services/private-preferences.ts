import { createHash } from 'node:crypto';
import { getDb } from '../db';
import type { FlightDeckPgPrivatePreference } from '../types';
export class PrivatePreferenceError extends Error {
 constructor(public status: 400 | 403 | 409, public code: string) { super(code); }
}
type Db = ReturnType<typeof getDb>;
export function validatePreferenceKey(key: string) {
 if (!/^[a-z][a-z0-9_.-]{0,95}$/.test(key)) throw new PrivatePreferenceError(400,'invalid_preference');
}
export async function readPrivatePreference(workspaceId: string, actorId: string, key: string, db: Db = getDb()) {
 validatePreferenceKey(key);
 const [row] = await db<FlightDeckPgPrivatePreference[]>`SELECT * FROM flightdeck_pg_private_preferences WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND preference_key=${key}`;
 return row ?? null;
}
export async function writePrivatePreference(workspaceId: string, actorId: string, key: string, input: unknown, db: Db = getDb()) {
 validatePreferenceKey(key);
 const b = input as {value: string; expected_row_version: number; mutation_id: string; import_only?: boolean};
 if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k=>!['value','expected_row_version','mutation_id','import_only'].includes(k))
 || typeof b.value !== 'string' || Buffer.byteLength(b.value)>2048 || /[\u0000-\u001f\u007f]/.test(b.value)
 || !Number.isSafeInteger(b.expected_row_version) || b.expected_row_version<0 || b.expected_row_version>=2147483647
 || typeof b.mutation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.mutation_id)
 || (b.import_only !== undefined && typeof b.import_only !== 'boolean') || (b.import_only && b.expected_row_version!==0)) throw new PrivatePreferenceError(400,'invalid_preference');
 const hash=createHash('sha256').update(JSON.stringify([key,b.value,b.expected_row_version,b.import_only===true])).digest('hex');
 return db.begin(async tx=>{
  const sql=tx as unknown as Db;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${actorId}:preferences`},0))`;
  const [member]=await sql`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${actorId} FOR SHARE`;
  if(!member) throw new PrivatePreferenceError(403,'workspace_membership_required');
  const [receipt]=await sql`SELECT * FROM flightdeck_pg_private_preference_mutations WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND mutation_id=${b.mutation_id}`;
  if(receipt){if(receipt.request_hash!==hash)throw new PrivatePreferenceError(409,'mutation_id_reused');return receipt.acknowledgement as FlightDeckPgPrivatePreference;}
  const current=await readPrivatePreference(workspaceId,actorId,key,sql);
  let row=current;
  if(!(b.import_only && current)) {
   if((current?.row_version??0)!==b.expected_row_version)throw new PrivatePreferenceError(409,'preference_conflict');
   [row]=await sql<FlightDeckPgPrivatePreference[]>`INSERT INTO flightdeck_pg_private_preferences(workspace_id,actor_id,preference_key,value) VALUES(${workspaceId},${actorId},${key},${b.value})
    ON CONFLICT(workspace_id,actor_id,preference_key) DO UPDATE SET value=EXCLUDED.value,row_version=flightdeck_pg_private_preferences.row_version+1,updated_at=now() RETURNING *`;
   await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,entity_id,operation,payload) VALUES(${workspaceId},${actorId},'private_preference.updated','private_preference',${row!.id},'updated',${sql.json({actor_id:actorId})})`;
  }
  await sql`INSERT INTO flightdeck_pg_private_preference_mutations VALUES(${workspaceId},${actorId},${b.mutation_id},${hash},${sql.json(row as any)})`;
  return row!;
 });
}
