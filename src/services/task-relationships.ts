import { createHash } from 'node:crypto';
import { getDb } from '../db';
type DbClient = ReturnType<typeof getDb>;
import { authorizeFlightDeckPgOperation } from './flightdeck-pg-authorization';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function taskRequestIdentity(workspace: string, actor: string, request: string) {
  const hash = createHash('sha256').update(JSON.stringify(['task.create', workspace, actor, request])).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export function taskRequestHash(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export const hasTaskRelationships = (metadata: Record<string, unknown> | undefined) => !!metadata && ['parent_task_id', 'predecessor_task_ids'].some(key => Object.prototype.hasOwnProperty.call(metadata,key));

/** Call under the workspace task advisory lock, in the mutation transaction. */
export async function validateTaskRelationships(sql: DbClient, input: { workspaceId: string; taskId: string; actorNpub: string; appNpub: string; metadata: Record<string, unknown> }) {
  const {workspaceId, taskId, metadata} = input;
  const parent = metadata.parent_task_id;
  const predecessors = metadata.predecessor_task_ids ?? [];
  const invalid = (message: string) => [{path:'metadata',code:'invalid_relationship',message}];
  if (parent !== undefined && parent !== null && parent !== '' && !uuid(parent)) return invalid('parent_task_id must be a UUID or null');
  if (!Array.isArray(predecessors) || predecessors.some(p => !uuid(p))) return invalid('predecessor_task_ids must be an array of UUIDs');
  if (new Set(predecessors.map(p => p.toLowerCase())).size !== predecessors.length) return invalid('Duplicate predecessor');
  const references = [...new Set([...(parent ? [parent as string] : []), ...predecessors].map(x => x.toLowerCase()))];
  if (references.includes(taskId.toLowerCase())) return invalid('A task cannot link to itself');
  for (const target of references) {
    const [row] = await sql<{channel_id:string}[]>`SELECT channel_id FROM flightdeck_pg_tasks WHERE workspace_id=${workspaceId} AND id=${target} AND deleted_at IS NULL`;
    if (!row) return invalid('Related task unavailable');
    const decision = await authorizeFlightDeckPgOperation({actorNpub:input.actorNpub,appNpub:input.appNpub,workspaceId,permission:'task.read',resource:{type:'channel',channelId:row.channel_id}},sql);
    if (!decision.allowed) return invalid('Related task unavailable');
  }
  if (parent) {
    const rows = await sql<{id:string}[]>`WITH RECURSIVE ancestors(id) AS (
      SELECT ${String(parent).toLowerCase()}::text UNION
      SELECT lower(t.metadata->>'parent_task_id') FROM flightdeck_pg_tasks t JOIN ancestors a ON t.id::text=a.id
      WHERE t.workspace_id=${workspaceId} AND t.deleted_at IS NULL AND t.metadata->>'parent_task_id' IS NOT NULL
    ) SELECT id FROM ancestors WHERE id=${taskId.toLowerCase()} LIMIT 1`;
    if (rows.length) return invalid('Parent cycle');
  }
  if (predecessors.length) {
    const rows = await sql<{id:string}[]>`WITH RECURSIVE ancestors(id) AS (
      SELECT jsonb_array_elements_text(${sql.json(predecessors)}::jsonb) UNION
      SELECT lower(p.id) FROM flightdeck_pg_tasks t JOIN ancestors a ON t.id::text=a.id
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.metadata->'predecessor_task_ids')='array' THEN t.metadata->'predecessor_task_ids' ELSE '[]'::jsonb END) p(id)
      WHERE t.workspace_id=${workspaceId} AND t.deleted_at IS NULL
    ) SELECT id FROM ancestors WHERE id=${taskId.toLowerCase()} LIMIT 1`;
    if (rows.length) return invalid('Dependency cycle');
  }
  return [];
}
