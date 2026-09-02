import type { Context } from 'hono';
import { requireNip98AuthResolved, type ResolvedAuth } from '../auth';
import { config } from '../config';
import { getDb } from '../db';
import { withGraphIdentity, type GraphIdentityContext } from './session';
import { getWorkspaceApp } from '../services/workspace-apps';
import { listWorkspacesForMember } from '../services/workspaces';
import type {
  CreateGraphMemoryInput,
  GraphBulkEdgesInput,
  GraphBulkImportInput,
  GraphBulkNodesInput,
  GraphRepositoryDeltaInput,
  GraphEdgeInput,
  GraphMemory,
  GraphMemoryAclInput,
  GraphMemoryEntityInput,
  GraphMemoryVisibility,
  GraphNodeInput,
  GraphSearchResult,
  GraphSchemaSnapshotInput,
  ListGraphMemoriesFilters,
  ListNativeGraphRepositoryCheckpointsFilters,
  ListNativeGraphFilters,
  NativeGraphEdge,
  NativeGraphImportRun,
  NativeGraphNode,
  NativeGraphRepositoryCheckpoint,
  NativeGraphVisibility,
  NativeGraphScopeInput,
  SearchNativeGraphInput,
} from '../types';

type Sql = any;

export type GraphRouteFailure = {
  status: 400 | 403 | 404 | 501;
  body: { error: string; code?: string };
};

export type GraphRequestContext = GraphIdentityContext & {
  auth: ResolvedAuth;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VISIBILITIES = new Set<GraphMemoryVisibility>(['personal', 'agent', 'group', 'workspace']);
const NATIVE_VISIBILITIES = new Set<NativeGraphVisibility>(['personal', 'agent', 'group']);
const ACL_ACCESS = new Set(['read', 'write', 'owner']);

function clean(value: unknown): string {
  return String(value || '').trim();
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function graphDisabled(): GraphRouteFailure {
  return { status: 501, body: { error: 'graph feature disabled', code: 'graph_disabled' } };
}

export function isGraphEnabled(): boolean {
  return Boolean(config.graph?.enabled);
}

export function isGraphUsable(): boolean {
  if (!isGraphEnabled()) return false;
  return (config.graph.allowedNpubs?.length || 0) > 0 || process.env.NODE_ENV === 'test';
}

function isAllowlisted(ctx: Pick<GraphIdentityContext, 'signerNpub' | 'userNpub' | 'actorNpub'>): boolean {
  if (process.env.NODE_ENV === 'test' && (config.graph.allowedNpubs?.length || 0) === 0) return true;
  const allowed = new Set(config.graph.allowedNpubs || []);
  return allowed.has(ctx.signerNpub) || allowed.has(ctx.userNpub) || allowed.has(ctx.actorNpub);
}

function normalizeLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

function normalizeOffset(value: unknown): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizeSearchLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 100);
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function serializeGraphMemory(memory: GraphMemory) {
  return {
    ...memory,
    workspace_owner_npub: memory.workspace_owner_npub ?? null,
    owner_npub: memory.owner_npub ?? null,
    actor_npub: memory.actor_npub ?? null,
    source_app_npub: memory.source_app_npub ?? null,
    group_id: memory.group_id ?? null,
    title: memory.title ?? null,
    summary: memory.summary ?? null,
    metadata: memory.metadata || {},
    updated_by_npub: memory.updated_by_npub ?? null,
    created_at: toIso(memory.created_at),
    updated_at: toIso(memory.updated_at),
  };
}

export function serializeNativeGraphNode(node: NativeGraphNode) {
  return {
    ...node,
    run_id: node.run_id ?? null,
    node_type: node.node_type ?? null,
    labels: node.labels || [],
    properties: node.properties || {},
    workspace_owner_npub: node.workspace_owner_npub ?? null,
    owner_npub: node.owner_npub ?? null,
    actor_npub: node.actor_npub ?? null,
    source_app_npub: node.source_app_npub ?? null,
    group_id: node.group_id ?? null,
    updated_by_npub: node.updated_by_npub ?? null,
    created_at: toIso(node.created_at),
    updated_at: toIso(node.updated_at),
  };
}

export function serializeNativeGraphEdge(edge: NativeGraphEdge) {
  return {
    ...edge,
    run_id: edge.run_id ?? null,
    properties: edge.properties || {},
    workspace_owner_npub: edge.workspace_owner_npub ?? null,
    owner_npub: edge.owner_npub ?? null,
    actor_npub: edge.actor_npub ?? null,
    source_app_npub: edge.source_app_npub ?? null,
    group_id: edge.group_id ?? null,
    updated_by_npub: edge.updated_by_npub ?? null,
    created_at: toIso(edge.created_at),
    updated_at: toIso(edge.updated_at),
  };
}

export function serializeNativeGraphImportRun(run: NativeGraphImportRun) {
  return {
    ...run,
    workspace_owner_npub: run.workspace_owner_npub ?? null,
    owner_npub: run.owner_npub ?? null,
    actor_npub: run.actor_npub ?? null,
    source_app_npub: run.source_app_npub ?? null,
    group_id: run.group_id ?? null,
    metadata: run.metadata || {},
    updated_by_npub: run.updated_by_npub ?? null,
    created_at: toIso(run.created_at),
    updated_at: toIso(run.updated_at),
  };
}

export function serializeNativeGraphRepositoryCheckpoint(checkpoint: NativeGraphRepositoryCheckpoint) {
  return {
    source: checkpoint.source,
    corpus_id: checkpoint.corpus_id,
    repository_id: checkpoint.repository_id,
    head_sha: checkpoint.head_sha,
    schema_version: checkpoint.schema_version,
    parser_metadata: checkpoint.parser_metadata || {},
    index_metadata: checkpoint.index_metadata || {},
    updated_at: toIso(checkpoint.updated_at),
  };
}

async function listWorkspaceGroupIdsForPrincipals(
  workspaceOwnerNpub: string,
  principals: string[],
): Promise<string[]> {
  const uniquePrincipals = [...new Set(principals.filter(Boolean))];
  if (!workspaceOwnerNpub || uniquePrincipals.length === 0) return [];
  const rows = await getDb()< { group_id: string }[] >`
    SELECT DISTINCT group_id FROM (
      SELECT gm.group_id
      FROM v4_group_members gm
      JOIN v4_groups g ON g.id = gm.group_id
      WHERE g.owner_npub = ${workspaceOwnerNpub}
        AND gm.member_npub = ANY(${uniquePrincipals})
      UNION
      SELECT gm.group_id
      FROM flightdeck_pg_group_memberships gm
      JOIN flightdeck_pg_groups g ON g.id = gm.group_id AND g.workspace_id = gm.workspace_id
      JOIN flightdeck_pg_workspaces w ON w.id = gm.workspace_id
      JOIN flightdeck_pg_actors a ON a.id = gm.actor_id
      WHERE w.workspace_owner_npub = ${workspaceOwnerNpub}
        AND a.npub = ANY(${uniquePrincipals})
    ) visible_groups
  `;
  return rows.map((row) => row.group_id);
}

async function listAllGroupIdsForPrincipals(principals: string[]): Promise<string[]> {
  const uniquePrincipals = [...new Set(principals.filter(Boolean))];
  if (uniquePrincipals.length === 0) return [];
  const rows = await getDb()< { group_id: string }[] >`
    SELECT DISTINCT group_id
    FROM v4_group_members
    WHERE member_npub = ANY(${uniquePrincipals})
  `;
  return rows.map((row) => row.group_id);
}

async function workspaceIsVisible(workspaceOwnerNpub: string, principals: string[]): Promise<boolean> {
  if (!workspaceOwnerNpub) return false;
  if (principals.includes(workspaceOwnerNpub)) return true;

  for (const principal of [...new Set(principals.filter(Boolean))]) {
    const visible = await listWorkspacesForMember(principal);
    if (visible.some((workspace) => workspace.workspace_owner_npub === workspaceOwnerNpub)) return true;
  }
  const [pgWorkspace] = await getDb()< { visible: boolean }[] >`
    SELECT TRUE AS visible
    FROM flightdeck_pg_workspaces w
    JOIN flightdeck_pg_workspace_memberships m ON m.workspace_id = w.id
    JOIN flightdeck_pg_actors a ON a.id = m.actor_id
    WHERE w.workspace_owner_npub = ${workspaceOwnerNpub}
      AND a.npub = ANY(${[...new Set(principals.filter(Boolean))]})
    LIMIT 1
  `;
  if (pgWorkspace?.visible) return true;
  return false;
}

async function resolveWorkspaceFromGroup(groupId: string): Promise<string | null> {
  if (!UUID_RE.test(groupId)) return null;
  const [group] = await getDb()< { owner_npub: string }[] >`
    SELECT owner_npub
    FROM v4_groups
    WHERE id = ${groupId}
    LIMIT 1
  `;
  if (group?.owner_npub) return group.owner_npub;
  const [pgGroup] = await getDb()< { owner_npub: string }[] >`
    SELECT w.workspace_owner_npub AS owner_npub
    FROM flightdeck_pg_groups g
    JOIN flightdeck_pg_workspaces w ON w.id = g.workspace_id
    WHERE g.id = ${groupId}
    LIMIT 1
  `;
  return pgGroup?.owner_npub || null;
}

export async function resolveGraphRequestContext(
  c: Context,
  input: { workspace_owner_npub?: string; actor_npub?: string; source_app_npub?: string; group_id?: string } = {},
): Promise<GraphRequestContext | Response | GraphRouteFailure> {
  if (!isGraphUsable()) return graphDisabled();

  const auth = await requireNip98AuthResolved(c);
  if (isResponse(auth)) return auth;

  const requestedActorNpub = clean(input.actor_npub);
  if (requestedActorNpub && requestedActorNpub !== auth.signerNpub && requestedActorNpub !== auth.userNpub) {
    return {
      status: 403,
      body: { error: 'actor_npub delegation is not supported yet', code: 'graph_actor_delegation_required' },
    };
  }

  const actorNpub = requestedActorNpub || auth.signerNpub;
  const workspaceOwnerNpub = clean(input.workspace_owner_npub) || null;
  const sourceAppNpub = clean(input.source_app_npub) || null;
  const principals = [auth.signerNpub, auth.userNpub, actorNpub];

  const baseCtx = {
    signerNpub: auth.signerNpub,
    userNpub: auth.userNpub,
    actorNpub,
  };
  if (!isAllowlisted(baseCtx)) {
    return { status: 403, body: { error: 'npub is not allowed to use graph memory', code: 'graph_not_allowed' } };
  }

  if (workspaceOwnerNpub && !(await workspaceIsVisible(workspaceOwnerNpub, principals))) {
    return { status: 403, body: { error: 'workspace is not visible to this npub', code: 'graph_workspace_forbidden' } };
  }

  if (sourceAppNpub) {
    if (!workspaceOwnerNpub) {
      return { status: 400, body: { error: 'workspace_owner_npub required with source_app_npub' } };
    }
    const app = await getWorkspaceApp(workspaceOwnerNpub, sourceAppNpub);
    if (!app) {
      return { status: 403, body: { error: 'source_app_npub is not registered for this workspace', code: 'graph_source_app_forbidden' } };
    }
  }

  const groupIds = workspaceOwnerNpub
    ? await listWorkspaceGroupIdsForPrincipals(workspaceOwnerNpub, principals)
    : await listAllGroupIdsForPrincipals(principals);

  return {
    auth,
    signerNpub: auth.signerNpub,
    userNpub: auth.userNpub,
    actorNpub,
    sourceAppNpub,
    workspaceOwnerNpub,
    groupIds,
  };
}

function validateVisibility(value: unknown): GraphMemoryVisibility | null {
  const visibility = clean(value) as GraphMemoryVisibility;
  return VISIBILITIES.has(visibility) ? visibility : null;
}

function validateNativeVisibility(value: unknown): NativeGraphVisibility | null {
  const visibility = clean(value) as NativeGraphVisibility;
  return NATIVE_VISIBILITIES.has(visibility) ? visibility : null;
}

type ResolvedNativeGraphScope = {
  visibility: NativeGraphVisibility;
  workspaceOwnerNpub: string | null;
  ownerNpub: string | null;
  actorNpub: string | null;
  sourceAppNpub: string | null;
  groupId: string | null;
  writeNpub: string;
};

async function resolveNativeGraphScope(
  input: NativeGraphScopeInput,
  ctx: GraphRequestContext,
): Promise<{ scope?: ResolvedNativeGraphScope; failure?: GraphRouteFailure }> {
  const visibility = validateNativeVisibility(input.visibility);
  if (!visibility) return { failure: { status: 400, body: { error: 'valid visibility required' } } };

  let workspaceOwnerNpub = clean(input.workspace_owner_npub) || null;
  const groupId = clean(input.group_id) || null;
  const sourceAppNpub = clean(input.source_app_npub) || null;
  const ownerNpub = visibility === 'personal' ? ctx.userNpub : null;
  const actorNpub = visibility === 'agent' ? ctx.actorNpub : null;
  const writeNpub = visibility === 'agent' ? ctx.actorNpub : ctx.userNpub;

  if (visibility === 'agent' && (ctx.actorNpub !== ctx.signerNpub || ctx.signerNpub !== ctx.userNpub)) {
    return {
      failure: {
        status: 403,
        body: { error: 'agent graph writes must be signed directly by the agent npub', code: 'graph_agent_direct_signer_required' },
      },
    };
  }

  if (visibility === 'group') {
    if (!workspaceOwnerNpub) return { failure: { status: 400, body: { error: 'workspace_owner_npub required for group graph rows' } } };
    if (!groupId || !UUID_RE.test(groupId)) return { failure: { status: 400, body: { error: 'valid group_id required for group graph rows' } } };
    const groupWorkspace = await resolveWorkspaceFromGroup(groupId);
    if (!groupWorkspace || groupWorkspace !== workspaceOwnerNpub) {
      return { failure: { status: 403, body: { error: 'group_id does not belong to workspace', code: 'graph_group_workspace_mismatch' } } };
    }
    if (!(ctx.groupIds || []).includes(groupId)) {
      return { failure: { status: 403, body: { error: 'not a current member of graph group', code: 'graph_group_forbidden' } } };
    }
  }

  if ((visibility === 'personal' || visibility === 'agent') && !workspaceOwnerNpub) {
    workspaceOwnerNpub = null;
  }

  if (sourceAppNpub && !workspaceOwnerNpub) {
    return { failure: { status: 400, body: { error: 'workspace_owner_npub required with source_app_npub' } } };
  }

  return {
    scope: {
      visibility,
      workspaceOwnerNpub,
      ownerNpub,
      actorNpub,
      sourceAppNpub,
      groupId,
      writeNpub,
    },
  };
}

function validateMemoryInput(input: CreateGraphMemoryInput): GraphRouteFailure | null {
  const visibility = validateVisibility(input.visibility);
  if (!visibility) return { status: 400, body: { error: 'valid visibility required' } };
  if (!clean(input.memory_type)) return { status: 400, body: { error: 'memory_type required' } };
  if (!clean(input.body_ciphertext)) return { status: 400, body: { error: 'body_ciphertext required' } };
  if ((input.entities || []).some((entity) => !clean(entity.entity_type) || !clean(entity.entity_key))) {
    return { status: 400, body: { error: 'each entity requires entity_type and entity_key' } };
  }
  if ((input.acl || []).some((acl) => !ACL_ACCESS.has(acl.access))) {
    return { status: 400, body: { error: 'each acl entry requires access read, write, or owner' } };
  }
  return null;
}

function validateAclEntry(acl: GraphMemoryAclInput, ctx: GraphIdentityContext): GraphRouteFailure | null {
  const principalNpub = clean(acl.principal_npub);
  const actorNpub = clean(acl.actor_npub);
  const groupId = clean(acl.group_id);
  if (!principalNpub && !actorNpub && !groupId) {
    return { status: 400, body: { error: 'acl entry requires principal_npub, actor_npub, or group_id' } };
  }
  if (groupId && (!UUID_RE.test(groupId) || !(ctx.groupIds || []).includes(groupId))) {
    return { status: 403, body: { error: 'acl group_id is not writable by this npub', code: 'graph_acl_group_forbidden' } };
  }
  if (actorNpub && actorNpub !== ctx.actorNpub) {
    return { status: 403, body: { error: 'acl actor_npub must match resolved actor_npub', code: 'graph_acl_actor_forbidden' } };
  }
  if (principalNpub && principalNpub !== ctx.userNpub) {
    return { status: 403, body: { error: 'acl principal_npub must match resolved user_npub', code: 'graph_acl_principal_forbidden' } };
  }
  return null;
}

async function upsertEntities(
  tx: Sql,
  memoryId: string,
  workspaceOwnerNpub: string | null,
  entities: GraphMemoryEntityInput[],
) {
  for (const entity of entities) {
    const entityType = clean(entity.entity_type);
    const entityKey = clean(entity.entity_key);
    const displayName = clean(entity.display_name) || entityKey;
    const relation = clean(entity.relation) || 'mentions';
    const weight = Number.isFinite(Number(entity.weight)) ? Number(entity.weight) : 1;
    const metadata = entity.metadata || {};

    const [row] = await tx<{ id: string }[]>`
      INSERT INTO graph_entities (workspace_owner_npub, entity_type, entity_key, display_name, metadata)
      VALUES (${workspaceOwnerNpub}, ${entityType}, ${entityKey}, ${displayName}, ${tx.json(metadata)})
      ON CONFLICT (COALESCE(workspace_owner_npub, ''), entity_type, entity_key)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        metadata = graph_entities.metadata || EXCLUDED.metadata
      RETURNING id
    `;

    await tx`
      INSERT INTO graph_memory_entities (memory_id, entity_id, relation, weight)
      VALUES (${memoryId}, ${row.id}, ${relation}, ${weight})
      ON CONFLICT (memory_id, entity_id, relation)
      DO UPDATE SET weight = EXCLUDED.weight
    `;
  }
}

export async function createGraphMemory(
  input: CreateGraphMemoryInput,
  ctx: GraphRequestContext,
): Promise<{ memory?: GraphMemory; failure?: GraphRouteFailure }> {
  const invalid = validateMemoryInput(input);
  if (invalid) return { failure: invalid };

  const visibility = input.visibility;
  let workspaceOwnerNpub = clean(input.workspace_owner_npub) || null;
  const groupId = clean(input.group_id) || null;
  const sourceAppNpub = clean(input.source_app_npub) || null;
  const ownerNpub = visibility === 'personal' ? ctx.userNpub : null;
  const actorNpub = visibility === 'agent' ? ctx.actorNpub : null;

  if (visibility === 'group' || visibility === 'workspace') {
    if (!workspaceOwnerNpub) return { failure: { status: 400, body: { error: 'workspace_owner_npub required for group/workspace memory' } } };
  }

  if (visibility === 'agent' && (ctx.actorNpub !== ctx.signerNpub || ctx.signerNpub !== ctx.userNpub)) {
    return {
      failure: {
        status: 403,
        body: { error: 'agent graph memory must be signed directly by the agent npub', code: 'graph_agent_direct_signer_required' },
      },
    };
  }

  if (visibility === 'group') {
    if (!groupId || !UUID_RE.test(groupId)) return { failure: { status: 400, body: { error: 'valid group_id required for group memory' } } };
    const groupWorkspace = await resolveWorkspaceFromGroup(groupId);
    if (!groupWorkspace || groupWorkspace !== workspaceOwnerNpub) {
      return { failure: { status: 403, body: { error: 'group_id does not belong to workspace', code: 'graph_group_workspace_mismatch' } } };
    }
    if (!(ctx.groupIds || []).includes(groupId)) {
      return { failure: { status: 403, body: { error: 'not a current member of graph memory group', code: 'graph_group_forbidden' } } };
    }
  }

  if (visibility === 'workspace') {
    return { failure: { status: 403, body: { error: 'workspace graph memory is not enabled yet', code: 'graph_workspace_visibility_disabled' } } };
  }

  if ((visibility === 'personal' || visibility === 'agent') && !workspaceOwnerNpub) {
    workspaceOwnerNpub = null;
  }

  for (const acl of input.acl || []) {
    const failure = validateAclEntry(acl, ctx);
    if (failure) return { failure };
  }

  const memory = await withGraphIdentity(ctx, async (tx) => {
    const [row] = await tx<GraphMemory[]>`
      INSERT INTO graph_memories (
        workspace_owner_npub,
        owner_npub,
        actor_npub,
        source_app_npub,
        group_id,
        visibility,
        memory_type,
        title,
        summary,
        body_ciphertext,
        metadata,
        created_by_npub,
        updated_by_npub
      ) VALUES (
        ${workspaceOwnerNpub},
        ${ownerNpub},
        ${actorNpub},
        ${sourceAppNpub || null},
        ${groupId},
        ${visibility},
        ${clean(input.memory_type)},
        ${input.title === undefined ? null : clean(input.title)},
        ${input.summary === undefined ? null : clean(input.summary)},
        ${clean(input.body_ciphertext)},
        ${tx.json((input.metadata || {}) as any)},
        ${visibility === 'agent' ? ctx.actorNpub : ctx.userNpub},
        ${visibility === 'agent' ? ctx.actorNpub : ctx.userNpub}
      )
      RETURNING *
    `;

    await upsertEntities(tx, row.id, workspaceOwnerNpub, input.entities || []);

    for (const acl of input.acl || []) {
      await tx`
        INSERT INTO graph_memory_acl (memory_id, principal_npub, actor_npub, group_id, access)
        VALUES (
          ${row.id},
          ${clean(acl.principal_npub) || null},
          ${clean(acl.actor_npub) || null},
          ${clean(acl.group_id) || null},
          ${acl.access}
        )
      `;
    }

    return row;
  });

  return { memory };
}

export async function listGraphMemories(
  filters: ListGraphMemoriesFilters,
  ctx: GraphRequestContext,
): Promise<{ memories: GraphMemory[]; total: number; limit: number; offset: number; has_more: boolean }> {
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  const visibility = validateVisibility(filters.visibility) ? filters.visibility : undefined;
  const groupId = clean(filters.group_id);
  const groupFilter = groupId && UUID_RE.test(groupId) ? groupId : null;
  const rows = await withGraphIdentity(ctx, (tx) => tx<(GraphMemory & { total_count: string })[]>`
    SELECT *, COUNT(*) OVER() AS total_count
    FROM graph_memories
    WHERE (${clean(filters.workspace_owner_npub) || null}::text IS NULL OR workspace_owner_npub = ${clean(filters.workspace_owner_npub) || null})
      AND (${visibility || null}::text IS NULL OR visibility = ${visibility || null})
      AND (${clean(filters.memory_type) || null}::text IS NULL OR memory_type = ${clean(filters.memory_type) || null})
      AND (${clean(filters.owner_npub) || null}::text IS NULL OR owner_npub = ${clean(filters.owner_npub) || null})
      AND (${clean(filters.actor_npub) || null}::text IS NULL OR actor_npub = ${clean(filters.actor_npub) || null})
      AND (${clean(filters.source_app_npub) || null}::text IS NULL OR source_app_npub = ${clean(filters.source_app_npub) || null})
      AND (${groupFilter}::uuid IS NULL OR group_id = ${groupFilter}::uuid)
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  const total = Number(rows[0]?.total_count || 0);
  return {
    memories: rows.map(({ total_count: _total, ...row }) => row),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  };
}

export async function getGraphMemoryById(
  memoryId: string,
  ctx: GraphRequestContext,
): Promise<GraphMemory | null> {
  if (!UUID_RE.test(memoryId)) return null;
  const [memory] = await withGraphIdentity(ctx, (tx) => tx<GraphMemory[]>`
    SELECT *
    FROM graph_memories
    WHERE id = ${memoryId}
    LIMIT 1
  `);
  return memory || null;
}

function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.map((label) => clean(label)).filter(Boolean))].sort();
}

function normalizeProperties(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function compactProperties(value: unknown): Record<string, unknown> {
  const properties = normalizeProperties(value);
  const allowed = ['name', 'title', 'summary', 'description', 'status'];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const field = properties[key];
    if (typeof field === 'string') {
      result[key] = field.length > 500 ? `${field.slice(0, 500)}...` : field;
    } else if (typeof field === 'number' || typeof field === 'boolean') {
      result[key] = field;
    }
  }
  return result;
}

function validateSource(value: unknown): string | GraphRouteFailure {
  const source = clean(value);
  if (!source) return { status: 400, body: { error: 'source required' } };
  return source;
}

function validateNodeInput(node: GraphNodeInput): GraphRouteFailure | null {
  if (!clean(node.external_id)) return { status: 400, body: { error: 'each node requires external_id' } };
  return null;
}

function normalizeEdgeExternalId(edge: GraphEdgeInput): string {
  return clean(edge.external_id) || `${clean(edge.from_external_id)}|${clean(edge.relationship_type)}|${clean(edge.to_external_id)}`;
}

function validateEdgeInput(edge: GraphEdgeInput): GraphRouteFailure | null {
  if (!clean(edge.from_external_id)) return { status: 400, body: { error: 'each edge requires from_external_id' } };
  if (!clean(edge.to_external_id)) return { status: 400, body: { error: 'each edge requires to_external_id' } };
  if (!clean(edge.relationship_type)) return { status: 400, body: { error: 'each edge requires relationship_type' } };
  return null;
}

async function upsertGraphNode(
  tx: Sql,
  input: GraphNodeInput,
  source: string,
  runId: string | null,
  scope: ResolvedNativeGraphScope,
): Promise<NativeGraphNode> {
  const labels = normalizeLabels(input.labels);
  const nodeType = clean(input.node_type) || labels[0] || null;
  const properties = normalizeProperties(input.properties);
  const [node] = await tx<NativeGraphNode[]>`
    INSERT INTO graph_nodes (
      external_id,
      source,
      run_id,
      node_type,
      labels,
      properties,
      workspace_owner_npub,
      owner_npub,
      actor_npub,
      source_app_npub,
      group_id,
      visibility,
      created_by_npub,
      updated_by_npub
    ) VALUES (
      ${clean(input.external_id)},
      ${source},
      ${runId},
      ${nodeType},
      ${labels},
      ${tx.json(properties as any)},
      ${scope.workspaceOwnerNpub},
      ${scope.ownerNpub},
      ${scope.actorNpub},
      ${scope.sourceAppNpub},
      ${scope.groupId},
      ${scope.visibility},
      ${scope.writeNpub},
      ${scope.writeNpub}
    )
    ON CONFLICT (
      visibility,
      COALESCE(workspace_owner_npub, ''),
      COALESCE(owner_npub, ''),
      COALESCE(actor_npub, ''),
      COALESCE(group_id::text, ''),
      source,
      external_id
    )
    DO UPDATE SET
      run_id = COALESCE(EXCLUDED.run_id, graph_nodes.run_id),
      node_type = EXCLUDED.node_type,
      labels = EXCLUDED.labels,
      properties = CASE WHEN ${input.property_mode === 'replace'} THEN EXCLUDED.properties ELSE graph_nodes.properties || EXCLUDED.properties END,
      source_app_npub = COALESCE(EXCLUDED.source_app_npub, graph_nodes.source_app_npub),
      updated_by_npub = EXCLUDED.updated_by_npub,
      updated_at = now()
    RETURNING *
  `;

  await tx`DELETE FROM graph_node_labels WHERE node_id = ${node.id}`;
  for (const label of labels) {
    await tx`
      INSERT INTO graph_node_labels (node_id, label)
      VALUES (${node.id}, ${label})
      ON CONFLICT DO NOTHING
    `;
  }
  return node;
}

async function findGraphNodeByExternalId(
  tx: Sql,
  externalId: string,
  source: string,
  scope: ResolvedNativeGraphScope,
): Promise<NativeGraphNode | null> {
  const [node] = await tx<NativeGraphNode[]>`
    SELECT *
    FROM graph_nodes
    WHERE visibility = ${scope.visibility}
      AND COALESCE(workspace_owner_npub, '') = ${scope.workspaceOwnerNpub || ''}
      AND COALESCE(owner_npub, '') = ${scope.ownerNpub || ''}
      AND COALESCE(actor_npub, '') = ${scope.actorNpub || ''}
      AND COALESCE(group_id::text, '') = ${scope.groupId || ''}
      AND source = ${source}
      AND external_id = ${externalId}
    LIMIT 1
  `;
  return node || null;
}

async function upsertGraphEdge(
  tx: Sql,
  input: GraphEdgeInput,
  source: string,
  runId: string | null,
  scope: ResolvedNativeGraphScope,
): Promise<NativeGraphEdge> {
  const fromExternalId = clean(input.from_external_id);
  const toExternalId = clean(input.to_external_id);
  const sourceNode = await findGraphNodeByExternalId(tx, fromExternalId, source, scope);
  const targetNode = await findGraphNodeByExternalId(tx, toExternalId, source, scope);
  if (!sourceNode || !targetNode) {
    throw Object.assign(new Error(`edge references missing node: ${fromExternalId} -> ${toExternalId}`), {
      code: 'GRAPH_EDGE_NODE_MISSING',
      status: 400,
    });
  }

  const properties = normalizeProperties(input.properties);
  const [edge] = await tx<NativeGraphEdge[]>`
    INSERT INTO graph_edges (
      external_id,
      source,
      run_id,
      source_node_id,
      target_node_id,
      relationship_type,
      properties,
      workspace_owner_npub,
      owner_npub,
      actor_npub,
      source_app_npub,
      group_id,
      visibility,
      created_by_npub,
      updated_by_npub
    ) VALUES (
      ${normalizeEdgeExternalId(input)},
      ${source},
      ${runId},
      ${sourceNode.id},
      ${targetNode.id},
      ${clean(input.relationship_type)},
      ${tx.json(properties as any)},
      ${scope.workspaceOwnerNpub},
      ${scope.ownerNpub},
      ${scope.actorNpub},
      ${scope.sourceAppNpub},
      ${scope.groupId},
      ${scope.visibility},
      ${scope.writeNpub},
      ${scope.writeNpub}
    )
    ON CONFLICT (
      visibility,
      COALESCE(workspace_owner_npub, ''),
      COALESCE(owner_npub, ''),
      COALESCE(actor_npub, ''),
      COALESCE(group_id::text, ''),
      source,
      external_id
    )
    DO UPDATE SET
      run_id = COALESCE(EXCLUDED.run_id, graph_edges.run_id),
      source_node_id = EXCLUDED.source_node_id,
      target_node_id = EXCLUDED.target_node_id,
      relationship_type = EXCLUDED.relationship_type,
      properties = CASE WHEN ${input.property_mode === 'replace'} THEN EXCLUDED.properties ELSE graph_edges.properties || EXCLUDED.properties END,
      source_app_npub = COALESCE(EXCLUDED.source_app_npub, graph_edges.source_app_npub),
      updated_by_npub = EXCLUDED.updated_by_npub,
      updated_at = now()
    RETURNING *
  `;
  return edge;
}

async function upsertSchemaSnapshot(
  tx: Sql,
  input: GraphSchemaSnapshotInput | Record<string, unknown> | undefined,
  source: string,
  runId: string | null,
  scope: ResolvedNativeGraphScope,
): Promise<number> {
  if (!input || typeof input !== 'object') return 0;
  const maybeSnapshot = input as GraphSchemaSnapshotInput;
  const schemaKind = clean(maybeSnapshot.schema_kind) || 'property_graph';
  const schema = normalizeProperties(maybeSnapshot.schema || input);
  await tx`
    INSERT INTO graph_schema_snapshots (
      run_id,
      source,
      schema_kind,
      schema,
      workspace_owner_npub,
      owner_npub,
      actor_npub,
      source_app_npub,
      group_id,
      visibility,
      created_by_npub,
      updated_by_npub
    ) VALUES (
      ${runId},
      ${source},
      ${schemaKind},
      ${tx.json(schema as any)},
      ${scope.workspaceOwnerNpub},
      ${scope.ownerNpub},
      ${scope.actorNpub},
      ${scope.sourceAppNpub},
      ${scope.groupId},
      ${scope.visibility},
      ${scope.writeNpub},
      ${scope.writeNpub}
    )
    ON CONFLICT (
      visibility,
      COALESCE(workspace_owner_npub, ''),
      COALESCE(owner_npub, ''),
      COALESCE(actor_npub, ''),
      COALESCE(group_id::text, ''),
      source,
      COALESCE(run_id, ''),
      schema_kind
    )
    DO UPDATE SET
      schema = EXCLUDED.schema,
      source_app_npub = COALESCE(EXCLUDED.source_app_npub, graph_schema_snapshots.source_app_npub),
      updated_by_npub = EXCLUDED.updated_by_npub,
      updated_at = now()
  `;
  return 1;
}

export async function bulkUpsertGraphNodes(
  input: GraphBulkNodesInput,
  ctx: GraphRequestContext,
): Promise<{ nodes?: NativeGraphNode[]; failure?: GraphRouteFailure }> {
  const source = validateSource(input.source);
  if (typeof source !== 'string') return { failure: source };
  if (!Array.isArray(input.nodes)) return { failure: { status: 400, body: { error: 'nodes array required' } } };
  for (const node of input.nodes) {
    const failure = validateNodeInput(node);
    if (failure) return { failure };
  }
  const resolved = await resolveNativeGraphScope(input, ctx);
  if (resolved.failure) return { failure: resolved.failure };
  const scope = resolved.scope!;
  const runId = clean(input.run_id) || null;
  const nodes = await withGraphIdentity(ctx, async (tx) => {
    const result: NativeGraphNode[] = [];
    for (const node of input.nodes) {
      result.push(await upsertGraphNode(tx, node, source, runId, scope));
    }
    return result;
  });
  return { nodes };
}

export async function bulkUpsertGraphEdges(
  input: GraphBulkEdgesInput,
  ctx: GraphRequestContext,
): Promise<{ edges?: NativeGraphEdge[]; failure?: GraphRouteFailure }> {
  const source = validateSource(input.source);
  if (typeof source !== 'string') return { failure: source };
  if (!Array.isArray(input.edges)) return { failure: { status: 400, body: { error: 'edges array required' } } };
  for (const edge of input.edges) {
    const failure = validateEdgeInput(edge);
    if (failure) return { failure };
  }
  const resolved = await resolveNativeGraphScope(input, ctx);
  if (resolved.failure) return { failure: resolved.failure };
  const scope = resolved.scope!;
  const runId = clean(input.run_id) || null;
  try {
    const edges = await withGraphIdentity(ctx, async (tx) => {
      const result: NativeGraphEdge[] = [];
      for (const edge of input.edges) {
        result.push(await upsertGraphEdge(tx, edge, source, runId, scope));
      }
      return result;
    });
    return { edges };
  } catch (error) {
    if ((error as any)?.code === 'GRAPH_EDGE_NODE_MISSING') {
      return { failure: { status: 400, body: { error: (error as Error).message, code: 'graph_edge_node_missing' } } };
    }
    throw error;
  }
}

export async function importNativeGraph(
  input: GraphBulkImportInput,
  ctx: GraphRequestContext,
): Promise<{ run?: NativeGraphImportRun; nodes: NativeGraphNode[]; edges: NativeGraphEdge[]; failure?: GraphRouteFailure }> {
  const source = validateSource(input.source);
  if (typeof source !== 'string') return { nodes: [], edges: [], failure: source };
  const runId = clean(input.run_id);
  if (!runId) return { nodes: [], edges: [], failure: { status: 400, body: { error: 'run_id required' } } };
  if (!Array.isArray(input.nodes)) input.nodes = [];
  if (!Array.isArray(input.edges)) input.edges = [];
  for (const node of input.nodes) {
    const failure = validateNodeInput(node);
    if (failure) return { nodes: [], edges: [], failure };
  }
  for (const edge of input.edges) {
    const failure = validateEdgeInput(edge);
    if (failure) return { nodes: [], edges: [], failure };
  }
  const resolved = await resolveNativeGraphScope(input, ctx);
  if (resolved.failure) return { nodes: [], edges: [], failure: resolved.failure };
  const scope = resolved.scope!;

  try {
    return await withGraphIdentity(ctx, async (tx) => {
      const nodes: NativeGraphNode[] = [];
      for (const node of input.nodes || []) {
        nodes.push(await upsertGraphNode(tx, node, source, runId, scope));
      }

      const edges: NativeGraphEdge[] = [];
      for (const edge of input.edges || []) {
        edges.push(await upsertGraphEdge(tx, edge, source, runId, scope));
      }

      const schemaUpserted = await upsertSchemaSnapshot(tx, input.schema, source, runId, scope);
      const [run] = await tx<NativeGraphImportRun[]>`
        INSERT INTO graph_import_runs (
          run_id,
          source,
          workspace_owner_npub,
          owner_npub,
          actor_npub,
          source_app_npub,
          group_id,
          visibility,
          status,
          nodes_upserted,
          edges_upserted,
          schema_upserted,
          metadata,
          created_by_npub,
          updated_by_npub
        ) VALUES (
          ${runId},
          ${source},
          ${scope.workspaceOwnerNpub},
          ${scope.ownerNpub},
          ${scope.actorNpub},
          ${scope.sourceAppNpub},
          ${scope.groupId},
          ${scope.visibility},
          'completed',
          ${nodes.length},
          ${edges.length},
          ${schemaUpserted},
          ${tx.json(normalizeProperties(input.metadata) as any)},
          ${scope.writeNpub},
          ${scope.writeNpub}
        )
        ON CONFLICT (
          visibility,
          COALESCE(workspace_owner_npub, ''),
          COALESCE(owner_npub, ''),
          COALESCE(actor_npub, ''),
          COALESCE(group_id::text, ''),
          source,
          run_id
        )
        DO UPDATE SET
          status = EXCLUDED.status,
          nodes_upserted = EXCLUDED.nodes_upserted,
          edges_upserted = EXCLUDED.edges_upserted,
          schema_upserted = EXCLUDED.schema_upserted,
          metadata = graph_import_runs.metadata || EXCLUDED.metadata,
          source_app_npub = COALESCE(EXCLUDED.source_app_npub, graph_import_runs.source_app_npub),
          updated_by_npub = EXCLUDED.updated_by_npub,
          updated_at = now()
        RETURNING *
      `;

      return { run, nodes, edges };
    });
  } catch (error) {
    if ((error as any)?.code === 'GRAPH_EDGE_NODE_MISSING') {
      return { nodes: [], edges: [], failure: { status: 400, body: { error: (error as Error).message, code: 'graph_edge_node_missing' } } };
    }
    throw error;
  }
}

const REPOSITORY_ID_RE = /^[A-Za-z0-9._/-]+$/;

function validateRepositoryDelta(input: GraphRepositoryDeltaInput): GraphRouteFailure | null {
  if (!REPOSITORY_ID_RE.test(clean(input.corpus_id))) {
    return { status: 400, body: { error: 'corpus_id must contain only letters, numbers, dot, underscore, slash, or hyphen', code: 'graph_delta_invalid_corpus' } };
  }
  if (!REPOSITORY_ID_RE.test(clean(input.repository_id))) {
    return { status: 400, body: { error: 'repository_id must contain only letters, numbers, dot, underscore, slash, or hyphen', code: 'graph_delta_invalid_repository' } };
  }
  if (!clean(input.head_sha)) return { status: 400, body: { error: 'head_sha required', code: 'graph_delta_head_required' } };
  if (!clean(input.schema_version)) return { status: 400, body: { error: 'schema_version required', code: 'graph_delta_schema_required' } };
  if (input.mode !== 'incremental' && input.mode !== 'full_rebuild') {
    return { status: 400, body: { error: 'mode must be incremental or full_rebuild', code: 'graph_delta_invalid_mode' } };
  }
  if (input.mode === 'incremental' && !clean(input.base_sha)) {
    return { status: 400, body: { error: 'base_sha required for incremental delta', code: 'graph_delta_base_required' } };
  }
  for (const field of ['nodes', 'edges', 'delete_node_external_ids', 'delete_edge_external_ids'] as const) {
    if (input[field] !== undefined && !Array.isArray(input[field])) {
      return { status: 400, body: { error: `${field} must be an array`, code: 'graph_delta_invalid_mutations' } };
    }
  }
  const prefix = `${clean(input.corpus_id)}:${clean(input.repository_id)}:`;
  const corpusPrefix = `${clean(input.corpus_id)}:`;
  const ownedIds = [
    ...(input.nodes || []).map((item) => item.external_id),
    ...(input.edges || []).map(normalizeEdgeExternalId),
    ...(input.delete_node_external_ids || []),
    ...(input.delete_edge_external_ids || []),
  ];
  if (ownedIds.some((id) => !clean(id).startsWith(prefix))) {
    return { status: 400, body: { error: `node, edge, and deletion external IDs must start with ${prefix}`, code: 'graph_delta_scope_escape' } };
  }
  const endpointIds = (input.edges || []).flatMap((item) => [item.from_external_id, item.to_external_id]);
  if (endpointIds.some((id) => !clean(id).startsWith(corpusPrefix))) {
    return { status: 400, body: { error: `edge endpoint external IDs must start with ${corpusPrefix}`, code: 'graph_delta_scope_escape' } };
  }
  for (const node of input.nodes || []) {
    const failure = validateNodeInput(node);
    if (failure) return failure;
    if (node.property_mode && node.property_mode !== 'merge' && node.property_mode !== 'replace') {
      return { status: 400, body: { error: 'node property_mode must be merge or replace', code: 'graph_delta_invalid_property_mode' } };
    }
  }
  for (const edge of input.edges || []) {
    const failure = validateEdgeInput(edge);
    if (failure) return failure;
    if (edge.property_mode && edge.property_mode !== 'merge' && edge.property_mode !== 'replace') {
      return { status: 400, body: { error: 'edge property_mode must be merge or replace', code: 'graph_delta_invalid_property_mode' } };
    }
  }
  return null;
}

export async function applyGraphRepositoryDelta(
  input: GraphRepositoryDeltaInput,
  ctx: GraphRequestContext,
): Promise<{
  checkpoint?: NativeGraphRepositoryCheckpoint;
  replayed?: boolean;
  counts?: { nodes_upserted: number; edges_upserted: number; nodes_deleted: number; edges_deleted: number; schema_upserted: number };
  failure?: GraphRouteFailure;
}> {
  const source = validateSource(input.source);
  if (typeof source !== 'string') return { failure: source };
  const validationFailure = validateRepositoryDelta(input);
  if (validationFailure) return { failure: validationFailure };
  const resolved = await resolveNativeGraphScope(input, ctx);
  if (resolved.failure) return { failure: resolved.failure };
  const scope = resolved.scope!;
  const corpusId = clean(input.corpus_id);
  const repositoryId = clean(input.repository_id);
  const baseSha = clean(input.base_sha) || null;
  const headSha = clean(input.head_sha);
  const schemaVersion = clean(input.schema_version);
  const prefix = `${corpusId}:${repositoryId}:`;
  const runId = `repository-delta:${corpusId}:${repositoryId}:${headSha}`;

  try {
    return await withGraphIdentity(ctx, async (tx) => {
      const lockKey = [scope.visibility, scope.workspaceOwnerNpub || '', scope.ownerNpub || '', scope.actorNpub || '', scope.groupId || '', source, corpusId, repositoryId].join('|');
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const [current] = await tx<NativeGraphRepositoryCheckpoint[]>`
        SELECT source, corpus_id, repository_id, head_sha, schema_version, parser_metadata, index_metadata, updated_at
        FROM graph_repository_checkpoints
        WHERE visibility = ${scope.visibility}
          AND COALESCE(workspace_owner_npub, '') = ${scope.workspaceOwnerNpub || ''}
          AND COALESCE(owner_npub, '') = ${scope.ownerNpub || ''}
          AND COALESCE(actor_npub, '') = ${scope.actorNpub || ''}
          AND COALESCE(group_id::text, '') = ${scope.groupId || ''}
          AND source = ${source}
          AND corpus_id = ${corpusId}
          AND repository_id = ${repositoryId}
        FOR UPDATE
      `;

      if (current?.head_sha === headSha) {
        return {
          checkpoint: current,
          replayed: true,
          counts: { nodes_upserted: 0, edges_upserted: 0, nodes_deleted: 0, edges_deleted: 0, schema_upserted: 0 },
        };
      }
      if (input.mode === 'incremental' && current?.head_sha !== baseSha) {
        throw Object.assign(new Error('base_sha does not match the current repository checkpoint'), {
          code: 'GRAPH_DELTA_STALE_BASE', status: 409, currentHeadSha: current?.head_sha || null,
        });
      }

      const desiredNodeIds = [...new Set((input.nodes || []).map((node) => clean(node.external_id)))];
      const desiredEdgeIds = [...new Set((input.edges || []).map(normalizeEdgeExternalId))];
      const requestedNodeDeletes = [...new Set((input.delete_node_external_ids || []).map(clean))];
      const requestedEdgeDeletes = [...new Set((input.delete_edge_external_ids || []).map(clean))];

      let edgesDeleted = 0;
      if (input.mode === 'full_rebuild') {
        const deleted = await tx`
          DELETE FROM graph_edges
          WHERE source = ${source} AND left(external_id, ${prefix.length}) = ${prefix}
            AND NOT (external_id = ANY(${desiredEdgeIds}))
          RETURNING id
        `;
        edgesDeleted += deleted.length;
      }
      if (requestedEdgeDeletes.length) {
        const deleted = await tx`
          DELETE FROM graph_edges
          WHERE source = ${source} AND external_id = ANY(${requestedEdgeDeletes})
          RETURNING id
        `;
        edgesDeleted += deleted.length;
      }

      const nodeIdsToDelete = input.mode === 'full_rebuild'
        ? (await tx<{ external_id: string }[]>`
            SELECT external_id FROM graph_nodes
            WHERE source = ${source} AND left(external_id, ${prefix.length}) = ${prefix}
              AND NOT (external_id = ANY(${desiredNodeIds}))
          `).map((row) => row.external_id)
        : requestedNodeDeletes;

      if (nodeIdsToDelete.length) {
        const [crossRepositoryEdge] = await tx<{ external_id: string }[]>`
          SELECT e.external_id
          FROM graph_edges e
          JOIN graph_nodes s ON s.id = e.source_node_id
          JOIN graph_nodes t ON t.id = e.target_node_id
          WHERE e.source = ${source}
            AND (s.external_id = ANY(${nodeIdsToDelete}) OR t.external_id = ANY(${nodeIdsToDelete}))
            AND left(e.external_id, ${prefix.length}) <> ${prefix}
          LIMIT 1
        `;
        if (crossRepositoryEdge) {
          throw Object.assign(new Error(`repository node deletion is blocked by cross-repository edge ${crossRepositoryEdge.external_id}`), {
            code: 'GRAPH_DELTA_CROSS_REPOSITORY_EDGE', status: 409,
          });
        }
        const incident = await tx`
          DELETE FROM graph_edges e
          USING graph_nodes s, graph_nodes t
          WHERE e.source_node_id = s.id AND e.target_node_id = t.id
            AND e.source = ${source}
            AND (s.external_id = ANY(${nodeIdsToDelete}) OR t.external_id = ANY(${nodeIdsToDelete}))
          RETURNING e.id
        `;
        edgesDeleted += incident.length;
      }

      const deletedNodes = nodeIdsToDelete.length ? await tx`
        DELETE FROM graph_nodes
        WHERE source = ${source} AND external_id = ANY(${nodeIdsToDelete})
        RETURNING id
      ` : [];

      const nodes: NativeGraphNode[] = [];
      for (const node of input.nodes || []) nodes.push(await upsertGraphNode(tx, node, source, runId, scope));
      const edges: NativeGraphEdge[] = [];
      for (const edge of input.edges || []) edges.push(await upsertGraphEdge(tx, edge, source, runId, scope));
      const schemaUpserted = await upsertSchemaSnapshot(tx, input.schema, source, runId, scope);
      const counts = {
        nodes_upserted: nodes.length,
        edges_upserted: edges.length,
        nodes_deleted: deletedNodes.length,
        edges_deleted: edgesDeleted,
        schema_upserted: schemaUpserted,
      };
      const importMetadata = {
        ...normalizeProperties(input.metadata), corpus_id: corpusId, repository_id: repositoryId,
        base_sha: baseSha, head_sha: headSha, schema_version: schemaVersion, mode: input.mode,
        parser: normalizeProperties(input.parser_metadata), index: normalizeProperties(input.index_metadata),
        nodes_deleted: counts.nodes_deleted, edges_deleted: counts.edges_deleted,
      };
      await tx`
        INSERT INTO graph_import_runs (
          run_id, source, workspace_owner_npub, owner_npub, actor_npub, source_app_npub, group_id,
          visibility, status, nodes_upserted, edges_upserted, schema_upserted, metadata, created_by_npub, updated_by_npub
        ) VALUES (
          ${runId}, ${source}, ${scope.workspaceOwnerNpub}, ${scope.ownerNpub}, ${scope.actorNpub}, ${scope.sourceAppNpub}, ${scope.groupId},
          ${scope.visibility}, 'completed', ${counts.nodes_upserted}, ${counts.edges_upserted}, ${schemaUpserted},
          ${tx.json(importMetadata as any)}, ${scope.writeNpub}, ${scope.writeNpub}
        )
      `;
      const [checkpoint] = await tx<NativeGraphRepositoryCheckpoint[]>`
        INSERT INTO graph_repository_checkpoints (
          source, corpus_id, repository_id, head_sha, schema_version, parser_metadata, index_metadata,
          workspace_owner_npub, owner_npub, actor_npub, source_app_npub, group_id, visibility, created_by_npub, updated_by_npub
        ) VALUES (
          ${source}, ${corpusId}, ${repositoryId}, ${headSha}, ${schemaVersion},
          ${tx.json(normalizeProperties(input.parser_metadata) as any)}, ${tx.json(normalizeProperties(input.index_metadata) as any)},
          ${scope.workspaceOwnerNpub}, ${scope.ownerNpub}, ${scope.actorNpub}, ${scope.sourceAppNpub}, ${scope.groupId},
          ${scope.visibility}, ${scope.writeNpub}, ${scope.writeNpub}
        )
        ON CONFLICT (
          visibility, COALESCE(workspace_owner_npub, ''), COALESCE(owner_npub, ''), COALESCE(actor_npub, ''),
          COALESCE(group_id::text, ''), source, corpus_id, repository_id
        ) DO UPDATE SET
          head_sha = EXCLUDED.head_sha, schema_version = EXCLUDED.schema_version,
          parser_metadata = EXCLUDED.parser_metadata, index_metadata = EXCLUDED.index_metadata,
          source_app_npub = EXCLUDED.source_app_npub, updated_by_npub = EXCLUDED.updated_by_npub, updated_at = now()
        RETURNING source, corpus_id, repository_id, head_sha, schema_version, parser_metadata, index_metadata, updated_at
      `;
      return { checkpoint, replayed: false, counts };
    });
  } catch (error) {
    const code = (error as any)?.code;
    if (code === 'GRAPH_DELTA_STALE_BASE') {
      return { failure: { status: 409, body: { error: (error as Error).message, code: 'graph_delta_stale_base', current_head_sha: (error as any).currentHeadSha } } };
    }
    if (code === 'GRAPH_DELTA_CROSS_REPOSITORY_EDGE') {
      return { failure: { status: 409, body: { error: (error as Error).message, code: 'graph_delta_cross_repository_edge' } } };
    }
    if (code === 'GRAPH_EDGE_NODE_MISSING') {
      return { failure: { status: 400, body: { error: (error as Error).message, code: 'graph_edge_node_missing' } } };
    }
    throw error;
  }
}

export async function listNativeGraphRepositoryCheckpoints(
  filters: ListNativeGraphRepositoryCheckpointsFilters,
  ctx: GraphRequestContext,
): Promise<{ checkpoints: NativeGraphRepositoryCheckpoint[]; limit: number; failure?: GraphRouteFailure }> {
  const source = validateSource(filters.source);
  const limit = normalizeLimit(filters.limit);
  if (typeof source !== 'string') return { checkpoints: [], limit, failure: source };

  const visibilityValue = clean(filters.visibility);
  if (visibilityValue && !validateNativeVisibility(visibilityValue)) {
    return { checkpoints: [], limit, failure: { status: 400, body: { error: 'valid visibility required' } } };
  }
  const groupId = clean(filters.group_id);
  if (groupId && !UUID_RE.test(groupId)) {
    return { checkpoints: [], limit, failure: { status: 400, body: { error: 'valid group_id required' } } };
  }
  const corpusId = clean(filters.corpus_id);
  const repositoryId = clean(filters.repository_id);
  if (corpusId && !REPOSITORY_ID_RE.test(corpusId)) {
    return { checkpoints: [], limit, failure: { status: 400, body: { error: 'corpus_id contains unsupported characters' } } };
  }
  if (repositoryId && !REPOSITORY_ID_RE.test(repositoryId)) {
    return { checkpoints: [], limit, failure: { status: 400, body: { error: 'repository_id contains unsupported characters' } } };
  }

  const visibility = validateNativeVisibility(visibilityValue) || null;
  const checkpoints = await withGraphIdentity(ctx, (tx) => tx<NativeGraphRepositoryCheckpoint[]>`
    SELECT source, corpus_id, repository_id, head_sha, schema_version, parser_metadata, index_metadata, updated_at
    FROM graph_repository_checkpoints
    WHERE source = ${source}
      AND (${visibility}::text IS NULL OR visibility = ${visibility})
      AND (${clean(filters.workspace_owner_npub) || null}::text IS NULL OR workspace_owner_npub = ${clean(filters.workspace_owner_npub) || null})
      AND (${clean(filters.owner_npub) || null}::text IS NULL OR owner_npub = ${clean(filters.owner_npub) || null})
      AND (${clean(filters.actor_npub) || null}::text IS NULL OR actor_npub = ${clean(filters.actor_npub) || null})
      AND (${clean(filters.source_app_npub) || null}::text IS NULL OR source_app_npub = ${clean(filters.source_app_npub) || null})
      AND (${groupId || null}::uuid IS NULL OR group_id = ${groupId || null}::uuid)
      AND (${corpusId || null}::text IS NULL OR corpus_id = ${corpusId || null})
      AND (${repositoryId || null}::text IS NULL OR repository_id = ${repositoryId || null})
    ORDER BY updated_at DESC, corpus_id ASC, repository_id ASC
    LIMIT ${limit}
  `);
  return { checkpoints, limit };
}

export async function listNativeGraphNodes(
  filters: ListNativeGraphFilters,
  ctx: GraphRequestContext,
): Promise<{ nodes: NativeGraphNode[]; total: number; limit: number; offset: number; has_more: boolean }> {
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  const visibility = validateNativeVisibility(filters.visibility) ? filters.visibility : undefined;
  const groupId = clean(filters.group_id);
  const groupFilter = groupId && UUID_RE.test(groupId) ? groupId : null;
  const rows = await withGraphIdentity(ctx, (tx) => tx<(NativeGraphNode & { total_count: string })[]>`
    SELECT *, COUNT(*) OVER() AS total_count
    FROM graph_nodes
    WHERE (${clean(filters.workspace_owner_npub) || null}::text IS NULL OR workspace_owner_npub = ${clean(filters.workspace_owner_npub) || null})
      AND (${visibility || null}::text IS NULL OR visibility = ${visibility || null})
      AND (${clean(filters.owner_npub) || null}::text IS NULL OR owner_npub = ${clean(filters.owner_npub) || null})
      AND (${clean(filters.actor_npub) || null}::text IS NULL OR actor_npub = ${clean(filters.actor_npub) || null})
      AND (${clean(filters.source_app_npub) || null}::text IS NULL OR source_app_npub = ${clean(filters.source_app_npub) || null})
      AND (${groupFilter}::uuid IS NULL OR group_id = ${groupFilter}::uuid)
      AND (${clean(filters.source) || null}::text IS NULL OR source = ${clean(filters.source) || null})
      AND (${clean(filters.run_id) || null}::text IS NULL OR run_id = ${clean(filters.run_id) || null})
      AND (${clean(filters.label) || null}::text IS NULL OR ${clean(filters.label) || null} = ANY(labels))
    ORDER BY updated_at DESC, external_id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `);
  const total = Number(rows[0]?.total_count || 0);
  return {
    nodes: rows.map(({ total_count: _total, ...row }) => row),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  };
}

export async function listNativeGraphEdges(
  filters: ListNativeGraphFilters,
  ctx: GraphRequestContext,
): Promise<{ edges: NativeGraphEdge[]; total: number; limit: number; offset: number; has_more: boolean }> {
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  const visibility = validateNativeVisibility(filters.visibility) ? filters.visibility : undefined;
  const groupId = clean(filters.group_id);
  const groupFilter = groupId && UUID_RE.test(groupId) ? groupId : null;
  const rows = await withGraphIdentity(ctx, (tx) => tx<(NativeGraphEdge & { total_count: string })[]>`
    SELECT
      e.*,
      s.external_id AS from_external_id,
      t.external_id AS to_external_id,
      COUNT(*) OVER() AS total_count
    FROM graph_edges e
    JOIN graph_nodes s ON s.id = e.source_node_id
    JOIN graph_nodes t ON t.id = e.target_node_id
    WHERE (${clean(filters.workspace_owner_npub) || null}::text IS NULL OR e.workspace_owner_npub = ${clean(filters.workspace_owner_npub) || null})
      AND (${visibility || null}::text IS NULL OR e.visibility = ${visibility || null})
      AND (${clean(filters.owner_npub) || null}::text IS NULL OR e.owner_npub = ${clean(filters.owner_npub) || null})
      AND (${clean(filters.actor_npub) || null}::text IS NULL OR e.actor_npub = ${clean(filters.actor_npub) || null})
      AND (${clean(filters.source_app_npub) || null}::text IS NULL OR e.source_app_npub = ${clean(filters.source_app_npub) || null})
      AND (${groupFilter}::uuid IS NULL OR e.group_id = ${groupFilter}::uuid)
      AND (${clean(filters.source) || null}::text IS NULL OR e.source = ${clean(filters.source) || null})
      AND (${clean(filters.run_id) || null}::text IS NULL OR e.run_id = ${clean(filters.run_id) || null})
      AND (${clean(filters.relationship_type) || null}::text IS NULL OR e.relationship_type = ${clean(filters.relationship_type) || null})
    ORDER BY e.updated_at DESC, e.external_id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `);
  const total = Number(rows[0]?.total_count || 0);
  return {
    edges: rows.map(({ total_count: _total, ...row }) => row),
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  };
}

type GraphSearchRow = {
  kind: 'node' | 'edge' | 'memory';
  score: number;
  id: string;
  external_id: string | null;
  source: string | null;
  labels: string[] | null;
  memory_type: string | null;
  relationship_type: string | null;
  from_external_id: string | null;
  to_external_id: string | null;
  title: string | null;
  summary: string | null;
  properties: Record<string, unknown>;
  total_count: string;
};

export async function searchNativeGraph(
  input: SearchNativeGraphInput,
  ctx: GraphRequestContext,
): Promise<{ query: string; results: GraphSearchResult[]; total: number; limit: number; failure?: GraphRouteFailure }> {
  const query = clean(input.q);
  if (!query) return { query, results: [], total: 0, limit: normalizeSearchLimit(input.limit), failure: { status: 400, body: { error: 'q required' } } };

  const visibility = clean(input.visibility);
  if (visibility && !NATIVE_VISIBILITIES.has(visibility as NativeGraphVisibility)) {
    return { query, results: [], total: 0, limit: normalizeSearchLimit(input.limit), failure: { status: 400, body: { error: 'valid visibility required' } } };
  }

  const limit = normalizeSearchLimit(input.limit);
  const groupId = clean(input.group_id);
  if (groupId && !UUID_RE.test(groupId)) {
    return { query, results: [], total: 0, limit, failure: { status: 400, body: { error: 'valid group_id required' } } };
  }
  const groupFilter = groupId || null;
  const q = query.toLowerCase();
  const pattern = `%${q}%`;
  const prefix = `${q}%`;
  const source = clean(input.source) || null;
  const label = clean(input.label) || null;
  const relationshipType = clean(input.relationship_type) || null;

  const rows = await withGraphIdentity(ctx, (tx) => tx<GraphSearchRow[]>`
    WITH matches AS (
      SELECT
        'node'::text AS kind,
        (
          CASE
            WHEN lower(n.external_id) = ${q} THEN 1.0
            WHEN lower(n.external_id) LIKE ${prefix} THEN 0.95
            WHEN lower(COALESCE(n.properties->>'title', n.properties->>'name', '')) = ${q} THEN 0.92
            WHEN lower(n.external_id) LIKE ${pattern} THEN 0.90
            WHEN EXISTS (SELECT 1 FROM unnest(n.labels) label_value WHERE lower(label_value) = ${q}) THEN 0.86
            WHEN EXISTS (SELECT 1 FROM unnest(n.labels) label_value WHERE lower(label_value) LIKE ${pattern}) THEN 0.82
            WHEN lower(COALESCE(n.properties->>'title', n.properties->>'name', n.properties->>'summary', n.properties->>'description', n.properties->>'status', '')) LIKE ${pattern} THEN 0.75
            WHEN lower(n.properties::text) LIKE ${pattern} THEN 0.35
            ELSE 0.20
          END
        )::double precision AS score,
        n.id,
        n.external_id,
        n.source,
        n.labels,
        NULL::text AS memory_type,
        NULL::text AS relationship_type,
        NULL::text AS from_external_id,
        NULL::text AS to_external_id,
        COALESCE(n.properties->>'title', n.properties->>'name', n.external_id) AS title,
        COALESCE(n.properties->>'summary', n.properties->>'description', n.node_type, n.external_id) AS summary,
        n.properties,
        n.updated_at
      FROM graph_nodes n
      WHERE (${clean(input.workspace_owner_npub) || null}::text IS NULL OR n.workspace_owner_npub = ${clean(input.workspace_owner_npub) || null})
        AND (${visibility || null}::text IS NULL OR n.visibility = ${visibility || null})
        AND (${clean(input.owner_npub) || null}::text IS NULL OR n.owner_npub = ${clean(input.owner_npub) || null})
        AND (${clean(input.actor_npub) || null}::text IS NULL OR n.actor_npub = ${clean(input.actor_npub) || null})
        AND (${clean(input.source_app_npub) || null}::text IS NULL OR n.source_app_npub = ${clean(input.source_app_npub) || null})
        AND (${groupFilter}::uuid IS NULL OR n.group_id = ${groupFilter}::uuid)
        AND (${source}::text IS NULL OR n.source = ${source})
        AND (${label}::text IS NULL OR ${label} = ANY(n.labels))
        AND (${relationshipType}::text IS NULL)
        AND (
          lower(n.external_id) LIKE ${pattern}
          OR lower(COALESCE(n.node_type, '')) LIKE ${pattern}
          OR EXISTS (SELECT 1 FROM unnest(n.labels) label_value WHERE lower(label_value) LIKE ${pattern})
          OR lower(COALESCE(n.properties->>'name', n.properties->>'title', n.properties->>'summary', n.properties->>'description', n.properties->>'status', '')) LIKE ${pattern}
          OR lower(n.properties::text) LIKE ${pattern}
        )

      UNION ALL

      SELECT
        'edge'::text AS kind,
        (
          CASE
            WHEN lower(e.external_id) = ${q} THEN 1.0
            WHEN lower(e.external_id) LIKE ${prefix} THEN 0.94
            WHEN lower(e.relationship_type) = ${q} THEN 0.90
            WHEN lower(s.external_id) = ${q} OR lower(t.external_id) = ${q} THEN 0.86
            WHEN lower(e.relationship_type) LIKE ${prefix} THEN 0.82
            WHEN lower(e.external_id) LIKE ${pattern} OR lower(s.external_id) LIKE ${pattern} OR lower(t.external_id) LIKE ${pattern} THEN 0.76
            WHEN lower(COALESCE(e.properties->>'title', e.properties->>'name', e.properties->>'summary', e.properties->>'description', e.properties->>'status', '')) LIKE ${pattern} THEN 0.65
            WHEN lower(e.properties::text) LIKE ${pattern} THEN 0.30
            ELSE 0.20
          END
        )::double precision AS score,
        e.id,
        e.external_id,
        e.source,
        ARRAY[]::text[] AS labels,
        NULL::text AS memory_type,
        e.relationship_type,
        s.external_id AS from_external_id,
        t.external_id AS to_external_id,
        NULL::text AS title,
        COALESCE(e.properties->>'summary', s.external_id || ' ' || e.relationship_type || ' ' || t.external_id) AS summary,
        e.properties,
        e.updated_at
      FROM graph_edges e
      JOIN graph_nodes s ON s.id = e.source_node_id
      JOIN graph_nodes t ON t.id = e.target_node_id
      WHERE (${clean(input.workspace_owner_npub) || null}::text IS NULL OR e.workspace_owner_npub = ${clean(input.workspace_owner_npub) || null})
        AND (${visibility || null}::text IS NULL OR e.visibility = ${visibility || null})
        AND (${clean(input.owner_npub) || null}::text IS NULL OR e.owner_npub = ${clean(input.owner_npub) || null})
        AND (${clean(input.actor_npub) || null}::text IS NULL OR e.actor_npub = ${clean(input.actor_npub) || null})
        AND (${clean(input.source_app_npub) || null}::text IS NULL OR e.source_app_npub = ${clean(input.source_app_npub) || null})
        AND (${groupFilter}::uuid IS NULL OR e.group_id = ${groupFilter}::uuid)
        AND (${source}::text IS NULL OR e.source = ${source})
        AND (${relationshipType}::text IS NULL OR e.relationship_type = ${relationshipType})
        AND (${label}::text IS NULL OR ${label} = ANY(s.labels) OR ${label} = ANY(t.labels))
        AND (
          lower(e.external_id) LIKE ${pattern}
          OR lower(e.relationship_type) LIKE ${pattern}
          OR lower(s.external_id) LIKE ${pattern}
          OR lower(t.external_id) LIKE ${pattern}
          OR lower(COALESCE(e.properties->>'name', e.properties->>'title', e.properties->>'summary', e.properties->>'description', e.properties->>'status', '')) LIKE ${pattern}
          OR lower(e.properties::text) LIKE ${pattern}
        )

      UNION ALL

      SELECT
        'memory'::text AS kind,
        (
          CASE
            WHEN lower(COALESCE(m.title, '')) = ${q} THEN 0.88
            WHEN lower(COALESCE(m.title, '')) LIKE ${prefix} THEN 0.82
            WHEN lower(m.memory_type) = ${q} THEN 0.78
            WHEN lower(COALESCE(m.title, m.summary, '')) LIKE ${pattern} THEN 0.72
            WHEN lower(m.metadata::text) LIKE ${pattern} THEN 0.25
            ELSE 0.15
          END
        )::double precision AS score,
        m.id,
        NULL::text AS external_id,
        NULL::text AS source,
        ARRAY[]::text[] AS labels,
        m.memory_type,
        NULL::text AS relationship_type,
        NULL::text AS from_external_id,
        NULL::text AS to_external_id,
        m.title,
        m.summary,
        m.metadata AS properties,
        m.updated_at
      FROM graph_memories m
      WHERE (${clean(input.workspace_owner_npub) || null}::text IS NULL OR m.workspace_owner_npub = ${clean(input.workspace_owner_npub) || null})
        AND (${visibility || null}::text IS NULL OR m.visibility = ${visibility || null})
        AND (${clean(input.owner_npub) || null}::text IS NULL OR m.owner_npub = ${clean(input.owner_npub) || null})
        AND (${clean(input.actor_npub) || null}::text IS NULL OR m.actor_npub = ${clean(input.actor_npub) || null})
        AND (${clean(input.source_app_npub) || null}::text IS NULL OR m.source_app_npub = ${clean(input.source_app_npub) || null})
        AND (${groupFilter}::uuid IS NULL OR m.group_id = ${groupFilter}::uuid)
        AND (${source}::text IS NULL)
        AND (${label}::text IS NULL)
        AND (${relationshipType}::text IS NULL)
        AND (
          lower(m.memory_type) LIKE ${pattern}
          OR lower(COALESCE(m.title, '')) LIKE ${pattern}
          OR lower(COALESCE(m.summary, '')) LIKE ${pattern}
          OR lower(m.metadata::text) LIKE ${pattern}
        )
    )
    SELECT *, COUNT(*) OVER() AS total_count
    FROM matches
    ORDER BY score DESC, updated_at DESC, kind ASC, COALESCE(external_id, title, id::text) ASC
    LIMIT ${limit}
  `);

  const results = rows.map((row): GraphSearchResult => {
    if (row.kind === 'node') {
      return {
        kind: 'node',
        score: row.score,
        id: row.id,
        external_id: row.external_id || '',
        source: row.source || '',
        labels: row.labels || [],
        title: row.title,
        summary: row.summary,
        properties: compactProperties(row.properties),
      };
    }
    if (row.kind === 'edge') {
      return {
        kind: 'edge',
        score: row.score,
        id: row.id,
        external_id: row.external_id || '',
        source: row.source || '',
        relationship_type: row.relationship_type || '',
        from_external_id: row.from_external_id || '',
        to_external_id: row.to_external_id || '',
        summary: row.summary || `${row.from_external_id || ''} ${row.relationship_type || ''} ${row.to_external_id || ''}`.trim(),
        properties: compactProperties(row.properties),
      };
    }
    return {
      kind: 'memory',
      score: row.score,
      id: row.id,
      memory_type: row.memory_type || '',
      title: row.title,
      summary: row.summary,
      properties: compactProperties(row.properties),
    };
  });

  return {
    query,
    results,
    total: Number(rows[0]?.total_count || 0),
    limit,
  };
}

export async function getNativeGraphNeighborhood(
  input: ListNativeGraphFilters & { node_id?: string; external_id?: string; direction?: string },
  ctx: GraphRequestContext,
): Promise<{ center: NativeGraphNode | null; nodes: NativeGraphNode[]; edges: NativeGraphEdge[] }> {
  const nodeId = clean(input.node_id);
  const externalId = clean(input.external_id);
  const source = clean(input.source);
  if (!nodeId && (!externalId || !source)) {
    throw Object.assign(new Error('node_id or source + external_id required'), { status: 400 });
  }
  if (nodeId && !UUID_RE.test(nodeId)) {
    throw Object.assign(new Error('valid node_id required'), { status: 400 });
  }
  const direction = clean(input.direction) || 'both';
  if (!['in', 'out', 'both'].includes(direction)) {
    throw Object.assign(new Error('direction must be in, out, or both'), { status: 400 });
  }
  const limit = normalizeLimit(input.limit);
  const [center] = await withGraphIdentity(ctx, (tx) => tx<NativeGraphNode[]>`
    SELECT *
    FROM graph_nodes
    WHERE (${nodeId || null}::uuid IS NOT NULL AND id = ${nodeId || null}::uuid)
       OR (${nodeId || null}::uuid IS NULL AND source = ${source} AND external_id = ${externalId})
    LIMIT 1
  `);
  if (!center) return { center: null, nodes: [], edges: [] };

  const edges = await withGraphIdentity(ctx, (tx) => tx<NativeGraphEdge[]>`
    SELECT
      e.*,
      s.external_id AS from_external_id,
      t.external_id AS to_external_id
    FROM graph_edges e
    JOIN graph_nodes s ON s.id = e.source_node_id
    JOIN graph_nodes t ON t.id = e.target_node_id
    WHERE (
      (${direction} IN ('out', 'both') AND e.source_node_id = ${center.id})
      OR (${direction} IN ('in', 'both') AND e.target_node_id = ${center.id})
    )
    ORDER BY e.updated_at DESC, e.external_id ASC
    LIMIT ${limit}
  `);
  const nodeIds = [...new Set(edges.flatMap((edge) => [edge.source_node_id, edge.target_node_id]))];
  if (!nodeIds.includes(center.id)) nodeIds.push(center.id);
  const nodes = nodeIds.length
    ? await withGraphIdentity(ctx, (tx) => tx<NativeGraphNode[]>`
        SELECT *
        FROM graph_nodes
        WHERE id = ANY(${nodeIds})
        ORDER BY external_id ASC
      `)
    : [center];
  return { center, nodes, edges };
}

export async function getNativeGraphBridgeNeighborhood(
  input: ListNativeGraphFilters & { node_id?: string; external_id?: string; relationship_types?: string[]; bridge_labels?: string[] },
  ctx: GraphRequestContext,
): Promise<{ center: NativeGraphNode | null; bridges: NativeGraphNode[]; stories: NativeGraphNode[]; edges: NativeGraphEdge[] }> {
  const nodeId = clean(input.node_id);
  const externalId = clean(input.external_id);
  const source = clean(input.source);
  if (!nodeId && !externalId) {
    throw Object.assign(new Error('node_id or external_id required'), { status: 400 });
  }
  if (nodeId && !UUID_RE.test(nodeId)) {
    throw Object.assign(new Error('valid node_id required'), { status: 400 });
  }
  const limit = Math.min(normalizeLimit(input.limit), 50);
  const relationshipTypes = (input.relationship_types || []).map(clean).filter(Boolean).slice(0, 12);
  const bridgeLabels = (input.bridge_labels || []).map(clean).filter(Boolean).slice(0, 12);
  const [center] = await withGraphIdentity(ctx, (tx) => tx<NativeGraphNode[]>`
    SELECT * FROM graph_nodes
    WHERE (${nodeId || null}::uuid IS NOT NULL AND id = ${nodeId || null}::uuid)
       OR (${nodeId || null}::uuid IS NULL AND external_id = ${externalId} AND (${source || null}::text IS NULL OR source = ${source || null}))
    LIMIT 1
  `);
  if (!center) return { center: null, bridges: [], stories: [], edges: [] };

  const firstEdges = await withGraphIdentity(ctx, (tx) => tx<NativeGraphEdge[]>`
    SELECT e.*, s.external_id AS from_external_id, t.external_id AS to_external_id
    FROM graph_edges e
    JOIN graph_nodes s ON s.id = e.source_node_id
    JOIN graph_nodes t ON t.id = e.target_node_id
    WHERE (e.source_node_id = ${center.id} OR e.target_node_id = ${center.id})
      AND COALESCE((e.properties->>'retracted')::boolean, false) = false
      AND (${relationshipTypes.length === 0} OR e.relationship_type = ANY(${relationshipTypes}))
    ORDER BY e.updated_at DESC, e.external_id ASC
    LIMIT ${limit * 4}
  `);
  const bridgeIds = [...new Set(firstEdges.flatMap((edge) => [edge.source_node_id, edge.target_node_id]).filter((id) => id !== center.id))];
  const bridges = bridgeIds.length ? await withGraphIdentity(ctx, (tx) => tx<NativeGraphNode[]>`
    SELECT * FROM graph_nodes
    WHERE id = ANY(${bridgeIds})
      AND (${bridgeLabels.length === 0} OR labels && ${bridgeLabels})
    ORDER BY external_id ASC
    LIMIT ${limit}
  `) : [];
  const allowedBridgeIds = bridges.map((node) => node.id);
  const secondEdges = allowedBridgeIds.length ? await withGraphIdentity(ctx, (tx) => tx<NativeGraphEdge[]>`
    SELECT e.*, s.external_id AS from_external_id, t.external_id AS to_external_id
    FROM graph_edges e
    JOIN graph_nodes s ON s.id = e.source_node_id
    JOIN graph_nodes t ON t.id = e.target_node_id
    WHERE (e.source_node_id = ANY(${allowedBridgeIds}) OR e.target_node_id = ANY(${allowedBridgeIds}))
      AND COALESCE((e.properties->>'retracted')::boolean, false) = false
      AND (${relationshipTypes.length === 0} OR e.relationship_type = ANY(${relationshipTypes}))
    ORDER BY e.updated_at DESC, e.external_id ASC
    LIMIT ${limit * 12}
  `) : [];
  const storyIds = [...new Set(secondEdges.flatMap((edge) => [edge.source_node_id, edge.target_node_id])
    .filter((id) => id !== center.id && !allowedBridgeIds.includes(id)))];
  const stories = storyIds.length ? await withGraphIdentity(ctx, (tx) => tx<NativeGraphNode[]>`
    SELECT * FROM graph_nodes
    WHERE id = ANY(${storyIds}) AND labels && ${['Story']}
    ORDER BY updated_at DESC, external_id ASC
    LIMIT ${limit}
  `) : [];
  const allowedIds = new Set([center.id, ...allowedBridgeIds, ...stories.map((node) => node.id)]);
  const edges = [...new Map([...firstEdges, ...secondEdges]
    .filter((edge) => allowedIds.has(edge.source_node_id) && allowedIds.has(edge.target_node_id))
    .map((edge) => [edge.id, edge])).values()];
  return { center, bridges, stories, edges };
}
