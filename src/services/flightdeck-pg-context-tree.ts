import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { authorizeFlightDeckPgStorageRead } from './flightdeck-pg-storage-access';
import {
  authorizeFlightDeckPgOperation, canReadFlightDeckPgContextScope,
  getEffectiveFlightDeckPgGroupIds, resolveFlightDeckPgActorByNpub,
} from './flightdeck-pg-authorization';
import type { FlightDeckPgContextTarget, FlightDeckPgContextTargetType, FlightDeckPgContextComponent, FlightDeckPgContextReference, FlightDeckPgContextDeletePreview } from '../types';

type Db = ReturnType<typeof getDb>;
export type ContextTreeActor = { workspaceId: string; scopeId: string; actorNpub: string; appNpub: string };
export type ContextTreeOperation = 'list' | 'create' | 'update' | 'references' | 'attach' | 'unlink' | 'preview' | 'delete';
export class ContextTreeError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message = code) { super(message); }
}
const invalid = (message: string): never => { throw new ContextTreeError(400, 'validation_error', message); };
const missing = (): never => { throw new ContextTreeError(404, 'context_not_found', 'Context unavailable'); };
const conflict = (code: string): never => { throw new ContextTreeError(409, code); };
export const contextUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string { if (typeof value !== 'string' || !contextUuid.test(value)) invalid('Expected UUID'); return (value as string).toLowerCase(); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected JSON object');
  return value as Record<string, any>;
}
function keys(body: Record<string, any>, allowed: string[]) {
  if (Object.keys(body).some(k => !allowed.includes(k))) invalid('Unknown field');
}
function version(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483646) invalid('expected_row_version must be a positive integer');
  return value as number;
}
function order(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2147483646) invalid('sort_order must be a nonnegative integer');
  return value as number;
}
function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256) invalid('title must contain 1–256 characters');
  return (value as string).trim();
}
export function normalizeContextTarget(type: unknown, value: unknown): { type: FlightDeckPgContextTargetType; target: FlightDeckPgContextTarget } {
  const t = object(value);
  if (type === 'doc' || type === 'file' || type === 'task') {
    keys(t, ['record_id']); return { type, target: { record_id: uuid(t.record_id) } };
  }
  if (type !== 'artifact') invalid('target_type must be doc, file, task or artifact');
  keys(t, ['origin', 'project', 'artifact', 'page', 'version_policy']);
  let origin: URL;
  try { origin = new URL(t.origin); } catch { return invalid('Invalid artifact origin'); }
  if (typeof t.origin !== 'string' || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) invalid('Artifact origin must be an HTTP(S) origin without credentials, path, query or fragment');
  const segment = /^[A-Za-z0-9_-]{1,128}$/;
  if (typeof t.project !== 'string' || !segment.test(t.project) || typeof t.artifact !== 'string' || !segment.test(t.artifact)
    || t.page !== 'index.html' || t.version_policy !== 'latest') invalid('Invalid follow-latest artifact target');
  return { type: 'artifact', target: { origin: origin.origin, project: t.project, artifact: t.artifact, page: 'index.html', version_policy: 'latest' } };
}

async function access(input: ContextTreeActor, sql: Db, write: boolean) {
  const actor = await resolveFlightDeckPgActorByNpub(input.actorNpub, sql);
  if (!actor) missing();
  const groupIds = await getEffectiveFlightDeckPgGroupIds(input.workspaceId, actor!.id, sql);
  if (!await canReadFlightDeckPgContextScope({ ...input, actorId: actor!.id, groupIds }, sql)) missing();
  const decision = await authorizeFlightDeckPgOperation({ ...input, permission: 'scope.manage', resource: { type: 'scope', scopeId: input.scopeId } }, sql);
  const editor = await authorizeFlightDeckPgOperation({ ...input, permission: 'context.edit', resource: { type: 'scope', scopeId: input.scopeId } }, sql);
  const edit = decision.allowed || editor.allowed;
  if (write && !edit) throw new ContextTreeError(403, 'permission_denied', 'context.edit or scope.manage required');
  // manage is the backward-compatible context-edit capability, never scope administration.
  return { actorId: actor!.id, capabilities: { read: true, manage: edit, edit, scope_manage: decision.allowed } };
}
async function component(input: ContextTreeActor, id: string, sql: Db) {
  const [row] = await sql`SELECT * FROM flightdeck_pg_context_components
    WHERE workspace_id=${input.workspaceId} AND scope_id=${input.scopeId} AND id=${id} AND deleted_at IS NULL`;
  if (!row) missing(); return row!;
}
async function subtree(input: ContextTreeActor, id: string, sql: Db) {
  return sql`WITH RECURSIVE tree AS (
    SELECT * FROM flightdeck_pg_context_components WHERE workspace_id=${input.workspaceId} AND scope_id=${input.scopeId} AND id=${id} AND deleted_at IS NULL
    UNION
    SELECT c.* FROM flightdeck_pg_context_components c JOIN tree p ON c.parent_id=p.id
      WHERE c.workspace_id=${input.workspaceId} AND c.scope_id=${input.scopeId} AND c.deleted_at IS NULL
  ) SELECT * FROM tree ORDER BY id`;
}
async function preview(input: ContextTreeActor, id: string, sql: Db) {
  await component(input, id, sql);
  const components = await subtree(input, id, sql);
  const references = await sql`SELECT * FROM flightdeck_pg_context_references WHERE workspace_id=${input.workspaceId}
    AND scope_id=${input.scopeId} AND component_id IN ${sql(components.map(r => r.id))} AND deleted_at IS NULL ORDER BY id`;
  // Full canonical persisted rows, not counts. Scope lock prevents changes during comparison/delete.
  const token = createHash('sha256').update(JSON.stringify({ v: 1, workspace: input.workspaceId, scope: input.scopeId, root: id, components, references })).digest('hex');
  return { components, references, value: { component_id: id, component_count: components.length, descendant_count: components.length - 1, reference_count: references.length, confirmation_token: token } };
}
async function appendOrder(input: ContextTreeActor, parentId: string | null, sql: Db) {
  const [r] = await sql`SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM flightdeck_pg_context_components
    WHERE workspace_id=${input.workspaceId} AND scope_id=${input.scopeId} AND parent_id IS NOT DISTINCT FROM ${parentId}::uuid AND deleted_at IS NULL`;
  return order(Number(r!.n));
}
async function targetResolution(input: ContextTreeActor, type: FlightDeckPgContextTargetType, target: FlightDeckPgContextTarget, sql: Db) {
  // Artifact WApp remains its own access authority. Do not fetch the URL or claim it is accessible.
  if (type === 'artifact') return { status: 'external' };
  const table = { doc: 'flightdeck_pg_docs', file: 'flightdeck_pg_files', task: 'flightdeck_pg_tasks' }[type];
  const [row] = await sql`SELECT t.id,t.channel_id,${sql(type === 'file' ? 't.display_name' : 't.title')} AS title
    ${type === 'task' ? sql`` : sql`,t.archived_at`} FROM ${sql(table)} t
    JOIN flightdeck_pg_scopes s ON s.workspace_id=t.workspace_id AND s.id=t.scope_id AND s.archived_at IS NULL
    JOIN flightdeck_pg_channels c ON c.workspace_id=t.workspace_id AND c.id=t.channel_id AND c.archived_at IS NULL
    WHERE t.workspace_id=${input.workspaceId} AND t.id=${(target as { record_id: string }).record_id} AND t.deleted_at IS NULL`;
  if (!row || (type !== 'task' && row.archived_at)) return { status: 'unavailable' };
  const decision = type === 'task'
    ? await authorizeFlightDeckPgOperation({ ...input, permission: 'task.read', resource: { type: 'channel', channelId: row.channel_id } }, sql)
    : await authorizeFlightDeckPgStorageRead({ ...input, entityType: type, channelId: row.channel_id }, sql);
  if (!decision.allowed) return { status: 'unavailable' };
  return { status: 'available', title: row.title, record_id: row.id };
}
async function emit(input: ContextTreeActor, actorId: string, family: 'context_component' | 'context_reference', operation: 'created' | 'updated' | 'deleted', row: Record<string, any>, sql: Db, mutationId: string) {
  const [event] = await sql`INSERT INTO flightdeck_pg_outbox_events
    (workspace_id,scope_id,actor_id,event_type,entity_type,entity_id,operation,entity_row_version,payload)
    VALUES(${input.workspaceId},${input.scopeId},${actorId},${`${family}.${operation}`},${family},${row.id},${operation},${row.row_version},
      ${sql.json({ schema_version: 1, mutation_id: mutationId, scope_id: input.scopeId, component_id: family === 'context_component' ? row.id : row.component_id })}) RETURNING id,row_version`;
  return event!;
}

/** All reads/edits use one scope row lock, including references and preview. Archive
 * updates the same row. READ COMMITTED ensures opposing moves see the preceding commit.
 * No network calls, content copies or record-delta registration here (WP2 owns recovery). */
type Persisted<T> = Omit<T, 'created_at' | 'updated_at' | 'deleted_at'> & { created_at: Date; updated_at: Date; deleted_at: Date | null };
type Resolution = { status: 'unavailable' | 'external' } | { status: 'available'; record_id: string; title: string | null };
type ReferenceRow = Persisted<FlightDeckPgContextReference> & { resolution?: Resolution };
type Capabilities = { capabilities: { read: boolean; manage: boolean; edit: boolean; scope_manage: boolean } };
type Mutation = Capabilities & { audit: { event_id: string; operation: string; actor_npub: string }; outbox: Array<{ id: string; row_version: number }>; mutation_id: string };
export type ContextTreeResults = {
  list: Capabilities & { components: Persisted<FlightDeckPgContextComponent>[]; next_cursor: string | null };
  references: Capabilities & { references: ReferenceRow[]; next_cursor: string | null };
  preview: Capabilities & { preview: FlightDeckPgContextDeletePreview };
  create: Mutation & { component: Persisted<FlightDeckPgContextComponent> };
  update: Mutation & { component: Persisted<FlightDeckPgContextComponent> };
  attach: Mutation & { reference: ReferenceRow };
  unlink: Mutation & { reference: ReferenceRow };
  delete: Mutation & { deleted: { component_id: string; component_count: number; reference_count: number } };
};
type ContextTreeParams = { componentId?: string; referenceId?: string; body?: unknown; limit?: unknown; cursor?: unknown };
export function runContextTree<O extends ContextTreeOperation>(input: ContextTreeActor, operation: O, params?: ContextTreeParams, db?: Db): Promise<ContextTreeResults[O]>;
export async function runContextTree(
  input: ContextTreeActor, operation: ContextTreeOperation,
  params: { componentId?: string; referenceId?: string; body?: unknown; limit?: unknown; cursor?: unknown } = {},
  db: Db = getDb(),
) {
  uuid(input.workspaceId); uuid(input.scopeId);
  const id = ['list', 'create'].includes(operation) && params.componentId === undefined ? undefined : uuid(params.componentId);
  const referenceId = operation !== 'unlink' && params.referenceId === undefined ? undefined : uuid(params.referenceId);
  const write = ['create', 'update', 'attach', 'unlink', 'delete'].includes(operation);
  return db.begin('isolation level read committed', async tx => {
    const sql = tx as unknown as Db;
    const [scope] = await sql`SELECT id FROM flightdeck_pg_scopes WHERE workspace_id=${input.workspaceId} AND id=${input.scopeId} AND archived_at IS NULL FOR UPDATE`;
    if (!scope) missing();
    const { actorId, capabilities } = await access(input, sql, write || operation === 'preview');
    if (id) await component(input, id, sql);
    if (operation === 'list' || operation === 'references') {
      const limit = params.limit === undefined ? 50 : Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('limit must be 1–200');
      const pageKey = `${input.workspaceId}/${input.scopeId}/${operation}/${id ?? ''}`;
      let afterOrder = -1, afterId = '00000000-0000-0000-0000-000000000000';
      if (params.cursor !== undefined) {
        if (typeof params.cursor !== 'string' || params.cursor.length > 2048) invalid('Invalid cursor');
        try {
          const cursor = JSON.parse(Buffer.from(String(params.cursor), 'base64url').toString());
          if (cursor.key !== pageKey) invalid('Cursor belongs to a different route');
          afterOrder = order(cursor.order); afterId = uuid(cursor.id);
        } catch { invalid('Invalid cursor'); }
      }
      const table = operation === 'list' ? 'flightdeck_pg_context_components' : 'flightdeck_pg_context_references';
      const rows = await sql`SELECT * FROM ${sql(table)} WHERE workspace_id=${input.workspaceId} AND scope_id=${input.scopeId}
        AND deleted_at IS NULL ${operation === 'references' ? sql`AND component_id=${id!}` : sql``}
        AND (sort_order,id) > (${afterOrder},${afterId}::uuid) ORDER BY sort_order,id LIMIT ${limit + 1}`;
      const more = rows.length > limit; const items = rows.slice(0, limit); const last = items.at(-1);
      if (operation === 'references') for (const row of items) row.resolution = await targetResolution(input, row.target_type, row.target, sql);
      return { [operation === 'list' ? 'components' : 'references']: items, capabilities,
        next_cursor: more ? Buffer.from(JSON.stringify({ key: pageKey, order: last!.sort_order, id: last!.id })).toString('base64url') : null };
    }
    if (operation === 'preview') return { preview: (await preview(input, id!, sql)).value, capabilities };
    const body = object(params.body);
    const mutationId = crypto.randomUUID(); const events: Record<string, any>[] = [];
    let result: Record<string, any>;
    if (operation === 'create' || operation === 'update') {
      keys(body, operation === 'create' ? ['title', 'parent_id', 'sort_order'] : ['title', 'parent_id', 'sort_order', 'expected_row_version']);
      const current = operation === 'update' ? await component(input, id!, sql) : null;
      if (current && current.row_version !== version(body.expected_row_version)) conflict('row_version_conflict');
      if (current && !['title', 'parent_id', 'sort_order'].some(k => k in body)) invalid('Empty patch');
      const parent = 'parent_id' in body ? (body.parent_id === null ? null : uuid(body.parent_id)) : current?.parent_id ?? null;
      if (parent) {
        await component(input, parent, sql);
        if (current && (await subtree(input, id!, sql)).some(r => r.id === parent)) conflict('circular_parent');
      }
      const newTitle = 'title' in body ? title(body.title) : current ? current.title : title(undefined);
      const sort = 'sort_order' in body ? order(body.sort_order) : (!current || parent !== current.parent_id) ? await appendOrder(input, parent, sql) : current.sort_order;
      const [row] = current
        ? await sql`UPDATE flightdeck_pg_context_components SET title=${newTitle},parent_id=${parent},sort_order=${sort},row_version=row_version+1,updated_at=NOW()
          WHERE workspace_id=${input.workspaceId} AND scope_id=${input.scopeId} AND id=${id!} AND row_version=${current.row_version} AND deleted_at IS NULL RETURNING *`
        : await sql`INSERT INTO flightdeck_pg_context_components(workspace_id,scope_id,title,parent_id,sort_order)
          VALUES(${input.workspaceId},${input.scopeId},${newTitle},${parent},${sort}) RETURNING *`;
      if (!row) conflict('row_version_conflict');
      events.push(await emit(input, actorId, 'context_component', current ? 'updated' : 'created', row!, sql, mutationId));
      result = { component: row };
    } else if (operation === 'attach') {
      keys(body, ['target_type', 'target', 'sort_order']);
      const normalized = normalizeContextTarget(body.target_type, body.target);
      const resolution = await targetResolution(input, normalized.type, normalized.target, sql);
      if (resolution.status === 'unavailable') throw new ContextTreeError(403, 'target_unavailable', 'Target unavailable');
      const [duplicate] = await sql`SELECT id FROM flightdeck_pg_context_references WHERE workspace_id=${input.workspaceId} AND component_id=${id!}
        AND target_type=${normalized.type} AND target=${sql.json(normalized.target)} AND deleted_at IS NULL`;
      if (duplicate) conflict('duplicate_reference');
      const [max] = await sql`SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM flightdeck_pg_context_references WHERE workspace_id=${input.workspaceId} AND component_id=${id!} AND deleted_at IS NULL`;
      const sort = 'sort_order' in body ? order(body.sort_order) : order(Number(max!.n));
      const [row] = await sql`INSERT INTO flightdeck_pg_context_references(workspace_id,scope_id,component_id,target_type,target,sort_order)
        VALUES(${input.workspaceId},${input.scopeId},${id!},${normalized.type},${sql.json(normalized.target)},${sort}) RETURNING *`;
      events.push(await emit(input, actorId, 'context_reference', 'created', row!, sql, mutationId));
      result = { reference: { ...row, resolution } };
    } else if (operation === 'unlink') {
      keys(body, ['expected_row_version']); const expected = version(body.expected_row_version);
      const [existing] = await sql`SELECT * FROM flightdeck_pg_context_references WHERE workspace_id=${input.workspaceId} AND scope_id=${input.scopeId} AND component_id=${id!} AND id=${referenceId!} AND deleted_at IS NULL`;
      if (!existing) missing(); if (existing!.row_version !== expected) conflict('row_version_conflict');
      const [row] = await sql`UPDATE flightdeck_pg_context_references SET deleted_at=NOW(),updated_at=NOW(),row_version=row_version+1
        WHERE id=${referenceId!} AND workspace_id=${input.workspaceId} AND component_id=${id!} AND row_version=${expected} AND deleted_at IS NULL RETURNING *`;
      if (!row) conflict('row_version_conflict');
      events.push(await emit(input, actorId, 'context_reference', 'deleted', row!, sql, mutationId));
      result = { reference: row };
    } else {
      keys(body, ['confirmation_token']);
      if (typeof body.confirmation_token !== 'string' || !/^[a-f0-9]{64}$/.test(body.confirmation_token)) invalid('confirmation_token required');
      const before = await preview(input, id!, sql);
      if (body.confirmation_token !== before.value.confirmation_token) conflict('delete_preview_changed');
      const refs = await sql`UPDATE flightdeck_pg_context_references SET deleted_at=NOW(),updated_at=NOW(),row_version=row_version+1
        WHERE workspace_id=${input.workspaceId} AND scope_id=${input.scopeId} AND component_id IN ${sql(before.components.map(r => r.id))} AND deleted_at IS NULL RETURNING *`;
      const components = await sql`UPDATE flightdeck_pg_context_components SET deleted_at=NOW(),updated_at=NOW(),row_version=row_version+1
        WHERE workspace_id=${input.workspaceId} AND scope_id=${input.scopeId} AND id IN ${sql(before.components.map(r => r.id))} AND deleted_at IS NULL RETURNING *`;
      // One transaction, per-row tombstone hints, shared mutation_id. WP2 must recover/materialize atomically.
      for (const row of refs) events.push(await emit(input, actorId, 'context_reference', 'deleted', row, sql, mutationId));
      for (const row of components) events.push(await emit(input, actorId, 'context_component', 'deleted', row, sql, mutationId));
      result = { deleted: { component_id: id, component_count: components.length, reference_count: refs.length } };
    }
    const action = `context.${operation}`;
    const [audit] = await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,actor_id,action,resource_type,resource_id,metadata)
      VALUES(${input.workspaceId},${actorId},${action},'context_component',${id ?? result.component?.id},${sql.json({ scope_id: input.scopeId, mutation_id: mutationId, event_count: events.length })}) RETURNING id`;
    return { ...result, capabilities, audit: { event_id: audit!.id, operation: action, actor_npub: input.actorNpub }, outbox: events, mutation_id: mutationId };
  });
}
