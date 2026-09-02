import { getDb } from '../db';
import type {
  FlightDeckPgActorKind,
  FlightDeckPgGrantResourceType,
  FlightDeckPgPermission,
  FlightDeckPgWorkspaceRole,
} from '../types';
import { flightDeckPgPermissions } from '../types';

type DbClient = ReturnType<typeof getDb>;

export type FlightDeckPgAuthorizationErrorCategory =
  | 'auth-error'
  | 'permission-denied'
  | 'validation-error';

export type FlightDeckPgAuthorizationReason =
  | 'allowed'
  | 'missing-actor-npub'
  | 'unknown-permission'
  | 'permission-definition-missing'
  | 'permission-resource-mismatch'
  | 'actor-not-found'
  | 'workspace-not-found'
  | 'workspace-app-mismatch'
  | 'workspace-membership-required'
  | 'resource-not-found'
  | 'permission-grant-required'
  | 'group-edge-self-reference'
  | 'group-edge-missing-group'
  | 'group-edge-cycle';

export type FlightDeckPgAuthorizationDecision =
  | {
      allowed: true;
      reason: 'allowed';
      category: null;
      actorId: string;
      workspaceId: string;
      effectiveGroupIds: string[];
      grantId: string;
    }
  | {
      allowed: false;
      reason: Exclude<FlightDeckPgAuthorizationReason, 'allowed'>;
      category: FlightDeckPgAuthorizationErrorCategory;
      actorId?: string;
      workspaceId?: string;
      effectiveGroupIds?: string[];
    };

export type FlightDeckPgActor = {
  id: string;
  npub: string;
  kind: FlightDeckPgActorKind;
  display_name: string | null;
};

export type FlightDeckPgWorkspace = {
  id: string;
  tower_service_npub: string;
  workspace_service_npub: string;
  workspace_owner_npub: string;
  app_npub: string;
  name: string;
  slug: string;
  description: string | null;
  avatar_url: string | null;
  metadata: Record<string, unknown>;
  v4_workspace_id: string | null;
  created_by_actor_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type FlightDeckPgAuthorizationResource =
  | { type: 'workspace' }
  | { type: 'scope'; scopeId: string }
  | { type: 'channel'; channelId: string };

export type FlightDeckPgAuthorizationInput = {
  actorNpub: string | null | undefined;
  appNpub: string;
  workspaceId: string;
  permission: FlightDeckPgPermission | string;
  resource: FlightDeckPgAuthorizationResource;
};

export type FlightDeckPgGroupEdgeMutationResult =
  | {
      ok: true;
      edge: {
        workspace_id: string;
        parent_group_id: string;
        child_group_id: string;
        created_by_actor_id: string | null;
      };
    }
  | {
      ok: false;
      decision: FlightDeckPgAuthorizationDecision;
    };

// Maps each permission to the grant anchor checked by authorization.
const permissionResourceTypes: Record<FlightDeckPgPermission, FlightDeckPgGrantResourceType> = {
  'workspace.read': 'workspace',
  'workspace.manage': 'workspace',
  'workspace.invite': 'workspace',
  'event_subscription.manage': 'workspace',
  'scope.read': 'scope',
  'scope.create': 'workspace',
  'scope.manage': 'scope',
  'channel.read': 'channel',
  'channel.create': 'scope',
  'channel.write': 'channel',
  'channel.manage': 'channel',
  'channel.grant': 'channel',
  'channel.grants.read': 'channel',
  'channel.grants.manage': 'channel',
  'task.read': 'channel',
  'task.create': 'channel',
  'task.update': 'channel',
  'task.comment': 'channel',
  'comment.create': 'channel',
  'doc.read': 'channel',
  'doc.write': 'channel',
  'file.read': 'channel',
  'file.write': 'channel',
  'audio_note.read': 'channel',
  'audio_note.write': 'channel',
  'daily_note.read': 'workspace',
  'daily_note.write': 'workspace',
};

const validPermissions = new Set<string>(flightDeckPgPermissions);

function denied(
  reason: Exclude<FlightDeckPgAuthorizationReason, 'allowed'>,
  category: FlightDeckPgAuthorizationErrorCategory,
  context: Partial<Pick<FlightDeckPgAuthorizationDecision, 'actorId' | 'workspaceId' | 'effectiveGroupIds'>> = {},
): FlightDeckPgAuthorizationDecision {
  return {
    allowed: false,
    reason,
    category,
    ...context,
  };
}

function isFlightDeckPgPermission(value: string): value is FlightDeckPgPermission {
  return validPermissions.has(value);
}

function expectedResourceType(permission: FlightDeckPgPermission): FlightDeckPgGrantResourceType {
  return permissionResourceTypes[permission];
}

const fullNpubPattern = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{50,}$/i;
const setupActorDisplayNames = new Set([
  'Workspace Creator',
  'Flight Deck PG Creator',
  'Flight Deck PG Workspace Owner',
  'Flight Deck PG Smoke Viewer',
  'Flight Deck PG Collaborator',
]);

export function isFlightDeckPgSetupActorDisplayName(value: string | null | undefined) {
  return setupActorDisplayNames.has(String(value || '').trim());
}

function assertValidFlightDeckPgActorNpub(actorNpub: string) {
  const normalized = String(actorNpub || '').trim();
  if (!fullNpubPattern.test(normalized)) {
    throw new Error('actor_npub must be a full valid npub');
  }
  return normalized;
}

export async function resolveFlightDeckPgActorByNpub(
  actorNpub: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgActor | null> {
  const normalizedActorNpub = String(actorNpub || '').trim();
  const [actor] = await sql<FlightDeckPgActor[]>`
    SELECT id, npub, kind, display_name
    FROM flightdeck_pg_actors
    WHERE npub = ${normalizedActorNpub}
    LIMIT 1
  `;
  return actor ?? null;
}

export async function resolveOrCreateFlightDeckPgActor(
  actorNpub: string,
  kind: FlightDeckPgActorKind = 'human',
  options: { displayName?: string | null; sql?: DbClient } = {},
): Promise<FlightDeckPgActor> {
  const sql = options.sql ?? getDb();
  const normalizedActorNpub = assertValidFlightDeckPgActorNpub(actorNpub);
  const displayName = typeof options.displayName === 'string' && options.displayName.trim()
    ? options.displayName.trim()
    : null;
  const incomingIsSetupPlaceholder = isFlightDeckPgSetupActorDisplayName(displayName);
  const [actor] = await sql<FlightDeckPgActor[]>`
    INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
    VALUES (${normalizedActorNpub}, ${kind}, ${displayName})
    ON CONFLICT (npub)
    DO UPDATE SET
      kind = CASE
        WHEN ${incomingIsSetupPlaceholder} THEN flightdeck_pg_actors.kind
        ELSE EXCLUDED.kind
      END,
      display_name = CASE
        WHEN EXCLUDED.display_name IS NULL THEN flightdeck_pg_actors.display_name
        WHEN flightdeck_pg_actors.display_name IS NULL THEN EXCLUDED.display_name
        WHEN flightdeck_pg_actors.display_name IN ('Workspace Creator', 'Flight Deck PG Creator', 'Flight Deck PG Workspace Owner', 'Flight Deck PG Smoke Viewer', 'Flight Deck PG Collaborator') THEN EXCLUDED.display_name
        WHEN ${incomingIsSetupPlaceholder} THEN flightdeck_pg_actors.display_name
        ELSE EXCLUDED.display_name
      END,
      updated_at = NOW()
    RETURNING id, npub, kind, display_name
  `;
  if (actor.display_name) {
    await sql`
      UPDATE user_profiles
      SET display_name = ${actor.display_name}
      WHERE user_npub = ${normalizedActorNpub}
    `;
  }
  return actor;
}

/** Canonical actor names live in flightdeck_pg_actors; user_profiles mirrors them when present. */
export async function updateFlightDeckPgActorDisplayName(
  actorId: string,
  displayName: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgActor | null> {
  const normalized = String(displayName || '').trim();
  if (!normalized) throw new Error('display_name must be non-empty');
  const [actor] = await sql<FlightDeckPgActor[]>`
    UPDATE flightdeck_pg_actors
    SET display_name = ${normalized}, updated_at = NOW()
    WHERE id = ${actorId}
    RETURNING id, npub, kind, display_name
  `;
  if (!actor) return null;
  await sql`
    UPDATE user_profiles
    SET display_name = ${normalized}
    WHERE user_npub = ${actor.npub}
  `;
  return actor;
}

export async function resolveFlightDeckPgWorkspace(
  workspaceId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkspace | null> {
  const [workspace] = await sql<FlightDeckPgWorkspace[]>`
    SELECT id, tower_service_npub, workspace_service_npub, workspace_owner_npub, app_npub, name, slug, description, avatar_url, metadata, v4_workspace_id, created_by_actor_id, created_at, updated_at
    FROM flightdeck_pg_workspaces
    WHERE id = ${workspaceId}
    LIMIT 1
  `;
  return workspace ?? null;
}

export async function resolveFlightDeckPgWorkspaceByIdentity(
  identity: { towerServiceNpub: string; workspaceServiceNpub: string; appNpub: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkspace | null> {
  const [workspace] = await sql<FlightDeckPgWorkspace[]>`
    SELECT id, tower_service_npub, workspace_service_npub, workspace_owner_npub, app_npub, name, slug, description, avatar_url, metadata, v4_workspace_id, created_by_actor_id, created_at, updated_at
    FROM flightdeck_pg_workspaces
    WHERE tower_service_npub = ${identity.towerServiceNpub}
      AND workspace_service_npub = ${identity.workspaceServiceNpub}
      AND app_npub = ${identity.appNpub}
    LIMIT 1
  `;
  return workspace ?? null;
}

export async function getFlightDeckPgWorkspaceMembership(
  workspaceId: string,
  actorId: string,
  sql: DbClient = getDb(),
): Promise<{ workspace_id: string; actor_id: string; role: FlightDeckPgWorkspaceRole } | null> {
  const [membership] = await sql<{ workspace_id: string; actor_id: string; role: FlightDeckPgWorkspaceRole }[]>`
    SELECT workspace_id, actor_id, role
    FROM flightdeck_pg_workspace_memberships
    WHERE workspace_id = ${workspaceId}
      AND actor_id = ${actorId}
    LIMIT 1
  `;
  return membership ?? null;
}

export async function getEffectiveFlightDeckPgGroupIds(
  workspaceId: string,
  actorId: string,
  sql: DbClient = getDb(),
): Promise<string[]> {
  const rows = await sql<{ group_id: string }[]>`
    WITH RECURSIVE effective_groups(group_id) AS (
      SELECT group_id
      FROM flightdeck_pg_group_memberships
      WHERE workspace_id = ${workspaceId}
        AND actor_id = ${actorId}
      UNION
      SELECT ge.parent_group_id
      FROM flightdeck_pg_group_edges ge
      JOIN effective_groups eg
        ON eg.group_id = ge.child_group_id
      WHERE ge.workspace_id = ${workspaceId}
    )
    SELECT group_id
    FROM effective_groups
    ORDER BY group_id
  `;
  return rows.map((row) => row.group_id);
}

async function getPermissionDefinition(
  permission: FlightDeckPgPermission,
  sql: DbClient,
): Promise<{ permission: string; resource_type: FlightDeckPgGrantResourceType } | null> {
  const [definition] = await sql<{ permission: string; resource_type: FlightDeckPgGrantResourceType }[]>`
    SELECT permission, resource_type
    FROM flightdeck_pg_permission_definitions
    WHERE permission = ${permission}
    LIMIT 1
  `;
  return definition ?? null;
}

async function resourceExists(
  workspaceId: string,
  resource: FlightDeckPgAuthorizationResource,
  sql: DbClient,
): Promise<boolean> {
  if (resource.type === 'workspace') return true;
  if (resource.type === 'scope') {
    const [scope] = await sql<{ id: string }[]>`
      SELECT id
      FROM flightdeck_pg_scopes
      WHERE workspace_id = ${workspaceId}
        AND id = ${resource.scopeId}
        AND archived_at IS NULL
      LIMIT 1
    `;
    return Boolean(scope);
  }
  const [channel] = await sql<{ id: string }[]>`
    SELECT id
    FROM flightdeck_pg_channels
    WHERE workspace_id = ${workspaceId}
      AND id = ${resource.channelId}
      AND archived_at IS NULL
    LIMIT 1
  `;
  return Boolean(channel);
}

async function findPermissionGrant(
  input: {
    workspaceId: string;
    actorId: string;
    groupIds: string[];
    permission: FlightDeckPgPermission;
    resource: FlightDeckPgAuthorizationResource;
  },
  sql: DbClient,
): Promise<{ id: string } | null> {
  const actorGrant = await findActorPermissionGrant(input, sql);
  if (actorGrant) return actorGrant;
  if (input.groupIds.length === 0) return null;
  return findGroupPermissionGrant(input, sql);
}

async function findActorPermissionGrant(
  input: {
    workspaceId: string;
    actorId: string;
    permission: FlightDeckPgPermission;
    resource: FlightDeckPgAuthorizationResource;
  },
  sql: DbClient,
): Promise<{ id: string } | null> {
  if (input.resource.type === 'workspace') {
    const [grant] = await sql<{ id: string }[]>`
      SELECT id
      FROM flightdeck_pg_permission_grants
      WHERE workspace_id = ${input.workspaceId}
        AND principal_type = 'actor'
        AND principal_actor_id = ${input.actorId}
        AND resource_type = 'workspace'
        AND resource_scope_id IS NULL
        AND resource_channel_id IS NULL
        AND permission = ${input.permission}
        AND revoked_at IS NULL
      LIMIT 1
    `;
    return grant ?? null;
  }

  if (input.resource.type === 'scope') {
    const [grant] = await sql<{ id: string }[]>`
      SELECT id
      FROM flightdeck_pg_permission_grants
      WHERE workspace_id = ${input.workspaceId}
        AND principal_type = 'actor'
        AND principal_actor_id = ${input.actorId}
        AND resource_type = 'scope'
        AND resource_scope_id = ${input.resource.scopeId}
        AND resource_channel_id IS NULL
        AND permission = ${input.permission}
        AND revoked_at IS NULL
      LIMIT 1
    `;
    return grant ?? null;
  }

  const [grant] = await sql<{ id: string }[]>`
    SELECT id
    FROM flightdeck_pg_permission_grants
    WHERE workspace_id = ${input.workspaceId}
      AND principal_type = 'actor'
      AND principal_actor_id = ${input.actorId}
      AND resource_type = 'channel'
      AND resource_channel_id = ${input.resource.channelId}
      AND permission = ${input.permission}
      AND revoked_at IS NULL
    LIMIT 1
  `;
  return grant ?? null;
}

async function findGroupPermissionGrant(
  input: {
    workspaceId: string;
    groupIds: string[];
    permission: FlightDeckPgPermission;
    resource: FlightDeckPgAuthorizationResource;
  },
  sql: DbClient,
): Promise<{ id: string } | null> {
  if (input.resource.type === 'workspace') {
    const [grant] = await sql<{ id: string }[]>`
      SELECT id
      FROM flightdeck_pg_permission_grants
      WHERE workspace_id = ${input.workspaceId}
        AND principal_type = 'group'
        AND principal_group_id IN ${sql(input.groupIds)}
        AND resource_type = 'workspace'
        AND resource_scope_id IS NULL
        AND resource_channel_id IS NULL
        AND permission = ${input.permission}
        AND revoked_at IS NULL
      LIMIT 1
    `;
    return grant ?? null;
  }

  if (input.resource.type === 'scope') {
    const [grant] = await sql<{ id: string }[]>`
      SELECT id
      FROM flightdeck_pg_permission_grants
      WHERE workspace_id = ${input.workspaceId}
        AND principal_type = 'group'
        AND principal_group_id IN ${sql(input.groupIds)}
        AND resource_type = 'scope'
        AND resource_scope_id = ${input.resource.scopeId}
        AND resource_channel_id IS NULL
        AND permission = ${input.permission}
        AND revoked_at IS NULL
      LIMIT 1
    `;
    return grant ?? null;
  }

  const [grant] = await sql<{ id: string }[]>`
    SELECT id
    FROM flightdeck_pg_permission_grants
    WHERE workspace_id = ${input.workspaceId}
      AND principal_type = 'group'
      AND principal_group_id IN ${sql(input.groupIds)}
      AND resource_type = 'channel'
      AND resource_channel_id = ${input.resource.channelId}
      AND permission = ${input.permission}
      AND revoked_at IS NULL
    LIMIT 1
  `;
  return grant ?? null;
}

export async function authorizeFlightDeckPgOperation(
  input: FlightDeckPgAuthorizationInput,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgAuthorizationDecision> {
  const actorNpub = String(input.actorNpub || '').trim();
  if (!actorNpub) return denied('missing-actor-npub', 'auth-error');
  if (!isFlightDeckPgPermission(input.permission)) {
    return denied('unknown-permission', 'validation-error');
  }

  const expectedType = expectedResourceType(input.permission);
  if (input.resource.type !== expectedType) {
    return denied('permission-resource-mismatch', 'validation-error');
  }

  const definition = await getPermissionDefinition(input.permission, sql);
  if (!definition) return denied('permission-definition-missing', 'validation-error');
  if (definition.resource_type !== expectedType) {
    return denied('permission-resource-mismatch', 'validation-error');
  }

  const actor = await resolveFlightDeckPgActorByNpub(actorNpub, sql);
  if (!actor) return denied('actor-not-found', 'permission-denied');

  const workspace = await resolveFlightDeckPgWorkspace(input.workspaceId, sql);
  if (!workspace) return denied('workspace-not-found', 'permission-denied', { actorId: actor.id });
  if (workspace.app_npub !== input.appNpub) {
    return denied('workspace-app-mismatch', 'auth-error', { actorId: actor.id, workspaceId: workspace.id });
  }

  const membership = await getFlightDeckPgWorkspaceMembership(workspace.id, actor.id, sql);
  if (!membership) {
    return denied('workspace-membership-required', 'permission-denied', {
      actorId: actor.id,
      workspaceId: workspace.id,
    });
  }

  const exists = await resourceExists(workspace.id, input.resource, sql);
  if (!exists) {
    return denied('resource-not-found', 'validation-error', {
      actorId: actor.id,
      workspaceId: workspace.id,
    });
  }

  const groupIds = await getEffectiveFlightDeckPgGroupIds(workspace.id, actor.id, sql);
  const grant = await findPermissionGrant(
    {
      workspaceId: workspace.id,
      actorId: actor.id,
      groupIds,
      permission: input.permission,
      resource: input.resource,
    },
    sql,
  );

  if (!grant) {
    return denied('permission-grant-required', 'permission-denied', {
      actorId: actor.id,
      workspaceId: workspace.id,
      effectiveGroupIds: groupIds,
    });
  }

  return {
    allowed: true,
    reason: 'allowed',
    category: null,
    actorId: actor.id,
    workspaceId: workspace.id,
    effectiveGroupIds: groupIds,
    grantId: grant.id,
  };
}

async function groupEdgeWouldCycle(
  workspaceId: string,
  parentGroupId: string,
  childGroupId: string,
  sql: DbClient,
): Promise<boolean> {
  const [cycle] = await sql<{ found: number }[]>`
    WITH RECURSIVE descendants(group_id) AS (
      SELECT child_group_id
      FROM flightdeck_pg_group_edges
      WHERE workspace_id = ${workspaceId}
        AND parent_group_id = ${childGroupId}
      UNION
      SELECT ge.child_group_id
      FROM flightdeck_pg_group_edges ge
      JOIN descendants d
        ON d.group_id = ge.parent_group_id
      WHERE ge.workspace_id = ${workspaceId}
    )
    SELECT 1 AS found
    FROM descendants
    WHERE group_id = ${parentGroupId}
    LIMIT 1
  `;
  return Boolean(cycle);
}

async function groupsExistInWorkspace(
  workspaceId: string,
  groupIds: string[],
  sql: DbClient,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT id
    FROM flightdeck_pg_groups
    WHERE workspace_id = ${workspaceId}
      AND id IN ${sql(groupIds)}
  `;
  return rows.length === groupIds.length;
}

export async function createFlightDeckPgNestedGroupEdge(
  input: {
    workspaceId: string;
    parentGroupId: string;
    childGroupId: string;
    createdByActorId?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgGroupEdgeMutationResult> {
  if (input.parentGroupId === input.childGroupId) {
    return { ok: false, decision: denied('group-edge-self-reference', 'validation-error') };
  }

  const groupsExist = await groupsExistInWorkspace(input.workspaceId, [input.parentGroupId, input.childGroupId], sql);
  if (!groupsExist) {
    return { ok: false, decision: denied('group-edge-missing-group', 'validation-error') };
  }

  const createsCycle = await groupEdgeWouldCycle(input.workspaceId, input.parentGroupId, input.childGroupId, sql);
  if (createsCycle) {
    return { ok: false, decision: denied('group-edge-cycle', 'validation-error') };
  }

  const [edge] = await sql<{
    workspace_id: string;
    parent_group_id: string;
    child_group_id: string;
    created_by_actor_id: string | null;
  }[]>`
    INSERT INTO flightdeck_pg_group_edges (
      workspace_id,
      parent_group_id,
      child_group_id,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.parentGroupId},
      ${input.childGroupId},
      ${input.createdByActorId ?? null}
    )
    ON CONFLICT (workspace_id, parent_group_id, child_group_id)
    DO UPDATE SET created_by_actor_id = COALESCE(EXCLUDED.created_by_actor_id, flightdeck_pg_group_edges.created_by_actor_id)
    RETURNING workspace_id, parent_group_id, child_group_id, created_by_actor_id
  `;

  return { ok: true, edge };
}
