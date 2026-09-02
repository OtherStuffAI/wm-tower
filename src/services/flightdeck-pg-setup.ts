import { createHash } from 'crypto';
import { nip19 } from 'nostr-tools';
import { config } from '../config';
import { getDb } from '../db';
import type {
  FlightDeckPgGrantResourceType,
  FlightDeckPgGroupKind,
  FlightDeckPgPermission,
  FlightDeckPgWorkspaceRole,
} from '../types';
import {
  resolveOrCreateFlightDeckPgActor,
  type FlightDeckPgActor,
  type FlightDeckPgWorkspace,
} from './flightdeck-pg-authorization';
import {
  buildFlightDeckPgWorkspaceLinks,
  flightDeckPgAccessLevelForPermissions,
  flightDeckPgContributePermissions,
  flightDeckPgManagePermissions,
  flightDeckPgViewPermissions,
  flightDeckPgWorkspaceCapabilities,
  serializeFlightDeckPgWorkspaceDescriptor,
  type FlightDeckPgChannelRow,
  type FlightDeckPgScopeRow,
} from './flightdeck-pg-api';

type DbClient = ReturnType<typeof getDb>;

const appNamespaceCapabilities = [
  'pg_scopes',
  'pg_channels',
  'pg_channel_grants',
  'pg_tasks',
  'pg_chat',
  'pg_files',
  'pg_audio_notes',
  'pg_reactions',
  'pg_daily_notes',
  'realtime_events',
];

export const defaultFlightDeckPgGroupNames = ['Admins', 'Agents', 'People', 'Workspace'] as const;
export type DefaultFlightDeckPgGroupName = typeof defaultFlightDeckPgGroupNames[number];
type DefaultGroupName = DefaultFlightDeckPgGroupName;

export const flightDeckPgAccessLevels = ['view', 'contribute', 'manage', 'custom'] as const;
export type FlightDeckPgAccessLevel = typeof flightDeckPgAccessLevels[number];

export const flightDeckPgAccessLevelPermissions: Record<FlightDeckPgAccessLevel, FlightDeckPgPermission[]> = {
  view: [...flightDeckPgViewPermissions],
  contribute: [...flightDeckPgContributePermissions],
  manage: [...flightDeckPgManagePermissions],
  custom: [],
};

export function expandFlightDeckPgAccessLevel(accessLevel: FlightDeckPgAccessLevel): FlightDeckPgPermission[] {
  return [...flightDeckPgAccessLevelPermissions[accessLevel]];
}

export function inferFlightDeckPgAccessLevel(permissions: readonly FlightDeckPgPermission[]): FlightDeckPgAccessLevel {
  return flightDeckPgAccessLevelForPermissions(permissions);
}

const groupWorkspacePermissions: Record<DefaultGroupName, FlightDeckPgPermission[]> = {
  Admins: ['workspace.read', 'workspace.manage', 'workspace.invite', 'event_subscription.manage', 'scope.create'],
  Agents: ['workspace.read'],
  People: ['workspace.read'],
  Workspace: ['workspace.read'],
};

const groupScopePermissions: Record<DefaultGroupName, FlightDeckPgPermission[]> = {
  Admins: ['channel.create'],
  Agents: [],
  People: [],
  Workspace: [],
};

const groupChannelAccessLevels: Record<DefaultGroupName, FlightDeckPgAccessLevel> = {
  Admins: 'manage',
  Agents: 'contribute',
  People: 'contribute',
  Workspace: 'view',
};

export type FlightDeckPgSetupInput = {
  towerServiceNpub?: string;
  workspaceServiceNpub?: string;
  workspaceOwnerNpub?: string;
  appNpub?: string;
  creatorNpub: string;
  creatorDisplayName?: string | null;
  workspaceName?: string;
  workspaceDescription?: string | null;
  smokeScopeName?: string | null;
  smokeChannelName?: string | null;
  channelNames?: string[];
  secondActorNpub?: string | null;
  secondActorDisplayName?: string | null;
  secondActorKind?: 'human' | 'agent' | 'app' | 'service';
  secondActorRole?: FlightDeckPgWorkspaceRole;
  secondActorGroupName?: DefaultGroupName;
  towerBaseUrl?: string;
};

export type FlightDeckPgSetupResult = {
  workspace_id: string;
  tower_service_npub: string;
  workspace_service_npub: string;
  workspace_owner_npub: string;
  app_npub: string;
  v4_workspace_id: string | null;
  app_namespace: {
    installed: boolean;
    status: 'installed_or_enabled' | 'typed_only_no_v4_workspace';
  };
  groups: Record<DefaultGroupName, string>;
  smoke: {
    scope_id: string | null;
    channel_id: string | null;
  };
  channels: Record<string, string>;
  actors: {
    creator: {
      actor_id: string;
      npub: string;
      membership_role: FlightDeckPgWorkspaceRole;
    };
    second_actor?: {
      actor_id: string;
      npub: string;
      membership_role: FlightDeckPgWorkspaceRole;
      group_name: DefaultGroupName;
      smoke_channel_id: string | null;
    };
  };
  descriptor_route: string;
  descriptor: ReturnType<typeof serializeFlightDeckPgWorkspaceDescriptor>;
  smoke_paths: string[];
};

type GroupRow = {
  id: string;
  workspace_id: string;
  name: DefaultGroupName;
  kind: FlightDeckPgGroupKind;
};

function required(value: string | null | undefined, label: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function optional(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

export function generatedFlightDeckPgWorkspaceServiceNpub(seed: string): string {
  return nip19.npubEncode(createHash('sha256').update(seed).digest('hex'));
}

function normalizeChannelNames(input: FlightDeckPgSetupInput): string[] {
  const names = Array.isArray(input.channelNames) && input.channelNames.length > 0
    ? input.channelNames
    : optional(input.smokeChannelName)
      ? [input.smokeChannelName]
      : [];
  const seen = new Set<string>();
  return names
    .map((name) => required(name, 'channel name'))
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function ensureWorkspaceAppNamespace(
  sql: DbClient,
  workspace: FlightDeckPgWorkspace,
  creator: FlightDeckPgActor,
): Promise<FlightDeckPgSetupResult['app_namespace']> {
  if (!workspace.v4_workspace_id) {
    return { installed: false, status: 'typed_only_no_v4_workspace' };
  }

  await sql`
    INSERT INTO workspace_apps (
      workspace_owner_npub,
      app_npub,
      app_name,
      enabled,
      capabilities,
      created_by_npub
    )
    VALUES (
      ${workspace.workspace_owner_npub},
      ${workspace.app_npub},
      'Flight Deck PG',
      true,
      ${sql.json(appNamespaceCapabilities)},
      ${creator.npub}
    )
    ON CONFLICT (workspace_owner_npub, app_npub)
    DO UPDATE SET
      app_name = EXCLUDED.app_name,
      enabled = true,
      capabilities = EXCLUDED.capabilities,
      updated_at = NOW()
  `;

  return { installed: true, status: 'installed_or_enabled' };
}

async function ensureWorkspace(
  input: Required<Pick<FlightDeckPgSetupInput, 'workspaceServiceNpub' | 'creatorNpub'>> &
    Omit<FlightDeckPgSetupInput, 'workspaceServiceNpub' | 'creatorNpub'>,
  creator: FlightDeckPgActor,
  sql: DbClient,
): Promise<FlightDeckPgWorkspace> {
  const towerServiceNpub = required(input.towerServiceNpub || config.service.npub, 'tower service npub');
  const appNpub = required(input.appNpub || config.flightDeck.appNpub, 'app npub');
  const workspaceOwnerNpub = required(input.workspaceOwnerNpub || input.creatorNpub, 'workspace owner npub');
  const name = required(input.workspaceName || 'Flight Deck PG Dev Workspace', 'workspace name');
  const description = optional(input.workspaceDescription) || 'Tower-local Flight Deck PG smoke workspace';

  const [workspace] = await sql<FlightDeckPgWorkspace[]>`
    INSERT INTO flightdeck_pg_workspaces (
      tower_service_npub,
      workspace_service_npub,
      workspace_owner_npub,
      app_npub,
      name,
      description,
      created_by_actor_id
    )
    VALUES (
      ${towerServiceNpub},
      ${input.workspaceServiceNpub},
      ${workspaceOwnerNpub},
      ${appNpub},
      ${name},
      ${description},
      ${creator.id}
    )
    ON CONFLICT (tower_service_npub, workspace_service_npub, app_npub)
    DO UPDATE SET
      workspace_owner_npub = EXCLUDED.workspace_owner_npub,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      updated_at = NOW()
    RETURNING id, tower_service_npub, workspace_service_npub, workspace_owner_npub, app_npub, name, slug, description, avatar_url, v4_workspace_id, created_by_actor_id, created_at, updated_at
  `;
  return workspace;
}

async function ensureWorkspaceMember(
  sql: DbClient,
  input: {
    workspaceId: string;
    actor: FlightDeckPgActor;
    role: FlightDeckPgWorkspaceRole;
    createdByActorId: string | null;
  },
): Promise<{ workspace_id: string; actor_id: string; role: FlightDeckPgWorkspaceRole }> {
  const [membership] = await sql<{ workspace_id: string; actor_id: string; role: FlightDeckPgWorkspaceRole }[]>`
    INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
    VALUES (${input.workspaceId}, ${input.actor.id}, ${input.role}, ${input.createdByActorId})
    ON CONFLICT (workspace_id, actor_id)
    DO UPDATE SET role = EXCLUDED.role
    RETURNING workspace_id, actor_id, role
  `;
  return membership;
}

async function ensureGroup(
  sql: DbClient,
  input: { workspaceId: string; name: DefaultGroupName; createdByActorId: string },
): Promise<GroupRow> {
  const [group] = await sql<GroupRow[]>`
    INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
    VALUES (${input.workspaceId}, ${input.name}, 'system', ${input.createdByActorId})
    ON CONFLICT (workspace_id, name)
    DO UPDATE SET kind = EXCLUDED.kind
    RETURNING id, workspace_id, name, kind
  `;
  return group;
}

async function ensureGroupMembership(
  sql: DbClient,
  input: { workspaceId: string; groupId: string; actorId: string; createdByActorId: string },
): Promise<void> {
  await sql`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    VALUES (${input.workspaceId}, ${input.groupId}, ${input.actorId}, ${input.createdByActorId})
    ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING
  `;
}

async function ensureWorkspaceGroupBackfill(
  sql: DbClient,
  input: { workspaceId: string; workspaceGroupId: string; createdByActorId: string },
): Promise<void> {
  await sql`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    SELECT m.workspace_id, ${input.workspaceGroupId}, m.actor_id, ${input.createdByActorId}
    FROM flightdeck_pg_workspace_memberships m
    WHERE m.workspace_id = ${input.workspaceId}
    ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING
  `;
}

async function ensureScope(
  sql: DbClient,
  input: { workspaceId: string; name: string; createdByActorId: string; ownerGroupId: string },
): Promise<FlightDeckPgScopeRow> {
  const [scope] = await sql<FlightDeckPgScopeRow[]>`
    INSERT INTO flightdeck_pg_scopes (
      workspace_id,
      name,
      description,
      kind,
      owner_group_id,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.name},
      'Smoke-test scope for Flight Deck PG PH1 setup',
      'project',
      ${input.ownerGroupId},
      ${input.createdByActorId}
    )
    ON CONFLICT (workspace_id, name)
    DO UPDATE SET
      owner_group_id = EXCLUDED.owner_group_id,
      updated_at = NOW()
    RETURNING *
  `;
  return scope;
}

async function ensureDmScope(
  sql: DbClient,
  input: { workspaceId: string; workspaceGroupId: string; createdByActorId: string },
): Promise<FlightDeckPgScopeRow> {
  const [scope] = await sql<FlightDeckPgScopeRow[]>`
    INSERT INTO flightdeck_pg_scopes (
      workspace_id,
      name,
      description,
      kind,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      'DMs',
      'Direct message conversations',
      'dm',
      ${input.createdByActorId}
    )
    ON CONFLICT (workspace_id, name)
    DO UPDATE SET updated_at = NOW()
    RETURNING *
  `;
  await ensureGrant(sql, {
    workspaceId: input.workspaceId,
    principalType: 'group',
    principalId: input.workspaceGroupId,
    resourceType: 'scope',
    scopeId: scope.id,
    permission: 'scope.read',
    createdByActorId: input.createdByActorId,
  });
  return scope;
}

async function ensureChannel(
  sql: DbClient,
  input: { workspaceId: string; scopeId: string; name: string; createdByActorId: string },
): Promise<FlightDeckPgChannelRow> {
  const [channel] = await sql<FlightDeckPgChannelRow[]>`
    INSERT INTO flightdeck_pg_channels (
      workspace_id,
      scope_id,
      name,
      description,
      kind,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.name},
      'Smoke-test channel for Flight Deck PG PH1 setup',
      'channel',
      ${input.createdByActorId}
    )
    ON CONFLICT (scope_id, name)
    DO UPDATE SET updated_at = NOW()
    RETURNING *
  `;

  await sql`
    UPDATE flightdeck_pg_scopes
    SET default_channel_id = ${channel.id}, updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.scopeId}
      AND (default_channel_id IS NULL OR default_channel_id = ${channel.id})
  `;

  return channel;
}

async function ensureGrant(
  sql: DbClient,
  input: {
    workspaceId: string;
    principalType: 'actor' | 'group';
    principalId: string;
    resourceType: FlightDeckPgGrantResourceType;
    permission: FlightDeckPgPermission;
    createdByActorId: string;
    scopeId?: string | null;
    channelId?: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_actor_id,
      principal_group_id,
      resource_type,
      resource_scope_id,
      resource_channel_id,
      permission,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.principalType},
      ${input.principalType === 'actor' ? input.principalId : null},
      ${input.principalType === 'group' ? input.principalId : null},
      ${input.resourceType},
      ${input.scopeId ?? null},
      ${input.channelId ?? null},
      ${input.permission},
      ${input.createdByActorId}
    )
    ON CONFLICT (
      workspace_id,
      principal_type,
      COALESCE(principal_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
      resource_type,
      COALESCE(resource_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(resource_channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
      permission
    )
    WHERE revoked_at IS NULL
    DO UPDATE SET created_by_actor_id = COALESCE(EXCLUDED.created_by_actor_id, flightdeck_pg_permission_grants.created_by_actor_id)
  `;
}

async function ensureGroupGrants(
  sql: DbClient,
  input: {
    workspaceId: string;
    groups: Record<DefaultGroupName, GroupRow>;
    scopeId?: string | null;
    channelId?: string | null;
    createdByActorId: string;
  },
): Promise<void> {
  for (const groupName of defaultFlightDeckPgGroupNames) {
    const group = input.groups[groupName];
    for (const permission of groupWorkspacePermissions[groupName]) {
      await ensureGrant(sql, {
        workspaceId: input.workspaceId,
        principalType: 'group',
        principalId: group.id,
        resourceType: 'workspace',
        permission,
        createdByActorId: input.createdByActorId,
      });
    }
    if (input.scopeId) {
      for (const permission of groupScopePermissions[groupName]) {
        await ensureGrant(sql, {
          workspaceId: input.workspaceId,
          principalType: 'group',
          principalId: group.id,
          resourceType: 'scope',
          scopeId: input.scopeId,
          permission,
          createdByActorId: input.createdByActorId,
        });
      }
    }
    if (input.channelId) {
      for (const permission of expandFlightDeckPgAccessLevel(groupChannelAccessLevels[groupName])) {
        await ensureGrant(sql, {
          workspaceId: input.workspaceId,
          principalType: 'group',
          principalId: group.id,
          resourceType: 'channel',
          channelId: input.channelId,
          permission,
          createdByActorId: input.createdByActorId,
        });
      }
    }
  }
}

export async function setupFlightDeckPgDevWorkspace(
  rawInput: FlightDeckPgSetupInput,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgSetupResult> {
  const appNpub = rawInput.appNpub || config.flightDeck.appNpub;
  const workspaceOwnerNpub = rawInput.workspaceOwnerNpub || rawInput.creatorNpub;
  const workspaceName = rawInput.workspaceName || 'Flight Deck PG Dev Workspace';
  const input = {
    ...rawInput,
    creatorNpub: required(rawInput.creatorNpub, 'creator npub'),
    workspaceServiceNpub: rawInput.workspaceServiceNpub || generatedFlightDeckPgWorkspaceServiceNpub(`${workspaceOwnerNpub}:${appNpub}:${workspaceName}`),
  };
  const creator = await resolveOrCreateFlightDeckPgActor(input.creatorNpub, 'human', {
    displayName: input.creatorDisplayName ?? 'Flight Deck PG Creator',
    sql,
  });
  const workspace = await ensureWorkspace(input, creator, sql);
  const creatorMembership = await ensureWorkspaceMember(sql, {
    workspaceId: workspace.id,
    actor: creator,
    role: 'owner',
    createdByActorId: creator.id,
  });
  const appNamespace = await ensureWorkspaceAppNamespace(sql, workspace, creator);

  const groups = {} as Record<DefaultGroupName, GroupRow>;
  for (const groupName of defaultFlightDeckPgGroupNames) {
    groups[groupName] = await ensureGroup(sql, {
      workspaceId: workspace.id,
      name: groupName,
      createdByActorId: creator.id,
    });
  }

  await ensureGroupMembership(sql, {
    workspaceId: workspace.id,
    groupId: groups.Workspace.id,
    actorId: creator.id,
    createdByActorId: creator.id,
  });
  await ensureGroupMembership(sql, {
    workspaceId: workspace.id,
    groupId: groups.Admins.id,
    actorId: creator.id,
    createdByActorId: creator.id,
  });

  if (workspace.workspace_owner_npub !== creator.npub) {
    const owner = await resolveOrCreateFlightDeckPgActor(workspace.workspace_owner_npub, 'human', {
      displayName: 'Flight Deck PG Workspace Owner',
      sql,
    });
    await ensureWorkspaceMember(sql, {
      workspaceId: workspace.id,
      actor: owner,
      role: 'owner',
      createdByActorId: creator.id,
    });
    await ensureGroupMembership(sql, {
      workspaceId: workspace.id,
      groupId: groups.Workspace.id,
      actorId: owner.id,
      createdByActorId: creator.id,
    });
    await ensureGroupMembership(sql, {
      workspaceId: workspace.id,
      groupId: groups.Admins.id,
      actorId: owner.id,
      createdByActorId: creator.id,
    });
  }

  await ensureWorkspaceGroupBackfill(sql, {
    workspaceId: workspace.id,
    workspaceGroupId: groups.Workspace.id,
    createdByActorId: creator.id,
  });
  await ensureGroupGrants(sql, {
    workspaceId: workspace.id,
    groups,
    createdByActorId: creator.id,
  });

  await ensureDmScope(sql, {
    workspaceId: workspace.id,
    workspaceGroupId: groups.Workspace.id,
    createdByActorId: creator.id,
  });
  const channelNames = normalizeChannelNames(input);
  const smokeScopeName = optional(input.smokeScopeName) || (channelNames.length > 0 ? 'Flight Deck PG Smoke' : null);
  const scope = smokeScopeName
    ? await ensureScope(sql, {
      workspaceId: workspace.id,
      name: smokeScopeName,
      ownerGroupId: groups.Admins.id,
      createdByActorId: creator.id,
    })
    : null;
  const channelRows: FlightDeckPgChannelRow[] = [];
  for (const channelName of scope ? channelNames : []) {
    const channel = await ensureChannel(sql, {
      workspaceId: workspace.id,
      scopeId: scope.id,
      name: channelName,
      createdByActorId: creator.id,
    });
    channelRows.push(channel);
    await ensureGroupGrants(sql, {
      workspaceId: workspace.id,
      groups,
      scopeId: scope.id,
      channelId: channel.id,
      createdByActorId: creator.id,
    });
  }
  const channel = channelRows[0];

  let secondActorResult: FlightDeckPgSetupResult['actors']['second_actor'];
  const secondActorNpub = optional(input.secondActorNpub);
  if (secondActorNpub) {
    const secondActorDisplayName = required(input.secondActorDisplayName, 'second actor display name');
    const secondActorGroupName = input.secondActorGroupName || 'Workspace';
    const secondActor = await resolveOrCreateFlightDeckPgActor(secondActorNpub, input.secondActorKind || 'human', {
      displayName: secondActorDisplayName,
      sql,
    });
    const secondMembership = await ensureWorkspaceMember(sql, {
      workspaceId: workspace.id,
      actor: secondActor,
      role: input.secondActorRole || 'member',
      createdByActorId: creator.id,
    });
    await ensureGroupMembership(sql, {
      workspaceId: workspace.id,
      groupId: groups.Workspace.id,
      actorId: secondActor.id,
      createdByActorId: creator.id,
    });
    await ensureGroupMembership(sql, {
      workspaceId: workspace.id,
      groupId: groups[secondActorGroupName].id,
      actorId: secondActor.id,
      createdByActorId: creator.id,
    });
    secondActorResult = {
      actor_id: secondActor.id,
      npub: secondActor.npub,
      membership_role: secondMembership.role,
      group_name: secondActorGroupName,
      smoke_channel_id: channel?.id ?? null,
    };
  }

  const towerBaseUrl = optional(input.towerBaseUrl) || `http://127.0.0.1:${config.port}`;
  const descriptor = serializeFlightDeckPgWorkspaceDescriptor(workspace, { towerBaseUrl });
  const links = buildFlightDeckPgWorkspaceLinks(workspace.id);
  const smokePaths = [
    '/api/v4/flightdeck-pg/workspaces',
    links.descriptor,
    links.me,
    links.scopes,
    ...(scope
      ? [`/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspace.id)}/scopes/${encodeURIComponent(scope.id)}/channels`]
      : []),
  ];

  return {
    workspace_id: workspace.id,
    tower_service_npub: workspace.tower_service_npub,
    workspace_service_npub: workspace.workspace_service_npub,
    workspace_owner_npub: workspace.workspace_owner_npub,
    app_npub: workspace.app_npub,
    v4_workspace_id: workspace.v4_workspace_id,
    app_namespace: appNamespace,
    groups: {
      Admins: groups.Admins.id,
      Agents: groups.Agents.id,
      People: groups.People.id,
      Workspace: groups.Workspace.id,
    },
    smoke: {
      scope_id: scope?.id ?? null,
      channel_id: channel?.id ?? null,
    },
    channels: Object.fromEntries(channelRows.map((row) => [row.name, row.id])),
    actors: {
      creator: {
        actor_id: creator.id,
        npub: creator.npub,
        membership_role: creatorMembership.role,
      },
      ...(secondActorResult ? { second_actor: secondActorResult } : {}),
    },
    descriptor_route: links.descriptor,
    descriptor: {
      ...descriptor,
      capabilities: flightDeckPgWorkspaceCapabilities,
    },
    smoke_paths: smokePaths,
  };
}
