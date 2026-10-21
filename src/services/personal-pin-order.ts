import { createHash } from 'node:crypto';
import { getDb } from '../db';
import type { FlightDeckPgPersonalPin } from '../types';
import { ThreadPinError } from './thread-pins';

type Db = ReturnType<typeof getDb>;
type PinReference = { resource_type: string; resource_id: string; expected_row_version: number };
export type PersonalPinMove = PinReference & { before: PinReference | null; mutation_id: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const types = ['thread', 'task', 'document', 'channel'];
const key = (r: { resource_type: string; resource_id: string }) => `${r.resource_type}:${r.resource_id}`;
function reference(value: unknown): value is PinReference {
 const r = value as PinReference;
 return !!r && typeof r === 'object' && !Array.isArray(r) && types.includes(r.resource_type)
  && typeof r.resource_id === 'string' && uuid.test(r.resource_id)
  && Number.isSafeInteger(r.expected_row_version) && r.expected_row_version > 0 && r.expected_row_version < 2147483647;
}

/** A move changes ordering only, never selection, target metadata or read state. */
export async function movePersonalPin(workspaceId: string, actorId: string, value: unknown, db: Db = getDb()): Promise<FlightDeckPgPersonalPin[]> {
 const b = value as PersonalPinMove;
 if (!reference(b) || Object.keys(b).some(k => !['resource_type','resource_id','expected_row_version','before','mutation_id'].includes(k))
  || typeof b.mutation_id !== 'string' || !uuid.test(b.mutation_id)
  || (b.before !== null && (!reference(b.before) || Object.keys(b.before).some(k => !['resource_type','resource_id','expected_row_version'].includes(k)) || key(b.before) === key(b)))) {
  throw new ThreadPinError(400, 'invalid_pin_order');
 }
 // Prefix separates this operation from immutable pin/unpin receipts, sharing the
 // same actor/workspace mutation-ID namespace. Normalize property order only.
 const hash = createHash('sha256').update(JSON.stringify(['pin_move_v1', b.resource_type, b.resource_id, b.expected_row_version,
  b.before ? [b.before.resource_type, b.before.resource_id, b.before.expected_row_version] : null])).digest('hex');
 return db.begin(async tx => {
  const sql = tx as unknown as Db;
  // Same first lock as pin/unpin and lifecycle writers: commit-ordered journal,
  // selection and receipt are atomic, and additions cannot be lost to a move.
  await sql`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId} FOR UPDATE`;
  const [member] = await sql`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${actorId} FOR SHARE`;
  if (!member) throw new ThreadPinError(403, 'workspace_membership_required');
  const [prior] = await sql`SELECT request_hash,acknowledgement FROM flightdeck_pg_thread_pin_mutations WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND mutation_id=${b.mutation_id}`;
  if (prior) {
   if (prior.request_hash !== hash) throw new ThreadPinError(409, 'mutation_id_reused');
   return prior.acknowledgement.pins as FlightDeckPgPersonalPin[];
  }
  const rows = await sql<FlightDeckPgPersonalPin[]>`SELECT * FROM flightdeck_pg_thread_pins WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND pinned
   ORDER BY order_position ASC NULLS FIRST, CASE WHEN order_position IS NULL THEN pinned_at END DESC NULLS LAST, resource_type COLLATE "C", resource_id FOR UPDATE`;
  const matches = (r: PinReference) => rows.find(p => key(p) === key(r) && p.row_version === r.expected_row_version);
  const moving = matches(b), anchor = b.before ? matches(b.before) : null;
  if (!moving || (b.before && !anchor)) throw new ThreadPinError(409, 'pin_order_conflict');
  const ordered = rows.filter(p => p.id !== moving.id);
  ordered.splice(anchor ? ordered.findIndex(p => p.id === anchor.id) : ordered.length, 0, moving);
  for (let position = 0; position < ordered.length; position++) {
   const row = ordered[position]!;
   if (row.order_position === position) continue;
   if (row.row_version >= 2147483647) throw new ThreadPinError(409, 'pin_order_conflict');
   const [updated] = await sql<FlightDeckPgPersonalPin[]>`UPDATE flightdeck_pg_thread_pins SET order_position=${position},row_version=row_version+1,updated_at=now() WHERE id=${row.id} RETURNING *`;
   ordered[position] = updated!;
  }
  await sql`INSERT INTO flightdeck_pg_thread_pin_mutations VALUES(${workspaceId},${actorId},${b.mutation_id},${hash},${sql.json({pins: ordered} as any)})`;
  // Actor-only hint: existing sync delivers canonical rows, including all changed
  // positions, through the existing personal_pin family and row-version rules.
  await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,entity_id,operation,payload)
   VALUES(${workspaceId},${actorId},'personal_pin.updated','personal_pin',${moving.id},'updated',${sql.json({actor_id:actorId})})`;
  return ordered;
 });
}
