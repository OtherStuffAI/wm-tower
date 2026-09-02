import { createHash, randomUUID } from 'crypto';
import { getDb } from '../db';

/**
 * Flight Deck PG service boundary.
 *
 * Responsibility inventory:
 * - Capability and access-level helpers for the Flight Deck PG API.
 * - Transport serializers for workspaces, scopes, channels, grants, groups,
 *   tasks, comments, docs, files, audio notes, reactions, daily notes, personal
 *   WApps, invocations, edit leases, response activity, and outbox events.
 * - Workspace request context, membership, groups, scopes, channels, grants,
 *   chat threads/messages, docs, files, audio notes, reactions, response
 *   activity, tasks, task comments, assignments, daily notes, personal WApps,
 *   invocations, visible events, edit leases, and outbox writes.
 *
 * Extracted ownership notes:
 * - Authorization and actor/workspace resolution belong in
 *   flightdeck-pg-authorization.ts.
 * - Route validation, HTTP status mapping, and request/response orchestration
 *   belong in routes/flightdeck-pg.ts.
 * - Schema shape belongs in types.ts and schema/ migrations.
 * - Future task/doc/chat/file-specific service work should be extracted into
 *   focused modules instead of expanding this file further.
 */
import type {
  FlightDeckPgActorKind,
  FlightDeckPgChannelKind,
  FlightDeckPgGroupKind,
  FlightDeckPgPermission,
  FlightDeckPgPrincipalType,
  FlightDeckPgOutboxEvent,
  FlightDeckPgScopeKind,
  FlightDeckPgMessage,
  FlightDeckPgDoc,
  FlightDeckPgDocRecoveryReason,
  FlightDeckPgDocRecoveryVersion,
  FlightDeckPgFile,
  FlightDeckPgFileVersion,
  FlightDeckPgFileFolder,
  FlightDeckPgAudioNote,
  FlightDeckPgDailyNote,
  FlightDeckPgDailyNoteStatus,
  FlightDeckPgInvocation,
  FlightDeckPgInvocationRecipient,
  FlightDeckPgInvocationStatus,
  FlightDeckPgInvocationTarget,
  FlightDeckPgInvocationTargetType,
  FlightDeckPgPersonalWapp,
  FlightDeckPgPersonalWappStatus,
  FlightDeckPgDocComment,
  FlightDeckPgReaction,
  FlightDeckPgReactionEmoji,
  FlightDeckPgReactionTargetType,
  FlightDeckPgResourceViewState,
  FlightDeckPgResourceViewStateType,
  FlightDeckPgResponseActivity,
  FlightDeckPgResponseActivitySeverity,
  FlightDeckPgResponseActivityStatus,
  FlightDeckPgResponseActivityTargetType,
  FlightDeckPgAgentActivity,
  FlightDeckPgAgentActivityCommentary,
  FlightDeckPgAgentActivityState,
  FlightDeckPgTask,
  FlightDeckPgTaskAssignment,
  FlightDeckPgTaskComment,
  FlightDeckPgTaskPriority,
  FlightDeckPgTaskState,
  FlightDeckPgThread,
  FlightDeckPgTypedApproval,
  FlightDeckPgApprovalAction,
  FlightDeckPgApprovalStatus,
  FlightDeckPgApprovalTargetType,
  FlightDeckPgWorkroom,
  FlightDeckPgWorkroomAccessStatus,
  FlightDeckPgWorkroomAppTargets,
  FlightDeckPgWorkroomApprovalPolicy,
  FlightDeckPgWorkroomArchivePolicy,
  FlightDeckPgWorkroomBranchConfig,
  FlightDeckPgWorkroomEvent,
  FlightDeckPgWorkroomEventType,
  FlightDeckPgWorkroomEventVisibility,
  FlightDeckPgWorkroomLink,
  FlightDeckPgWorkroomLinkType,
  FlightDeckPgWorkroomParticipant,
  FlightDeckPgWorkroomParticipantKind,
  FlightDeckPgWorkroomParticipantRole,
  FlightDeckPgWorkroomParticipantStatus,
  FlightDeckPgWorkroomRepoConfig,
  FlightDeckPgWorkroomStatus,
  FlightDeckPgWorkspaceRole,
  V4StorageObject,
} from '../types';
import { flightDeckPgPermissions } from '../types';
import { mentionsFromMetadata, normalizeFlightDeckPgChannelMetadata } from './flightdeck-pg-agent-direct';
import { effectiveFlightDeckPgThreadTitle } from './flightdeck-pg-thread-titles';
import {
  authorizeFlightDeckPgOperation,
  getEffectiveFlightDeckPgGroupIds,
  getFlightDeckPgWorkspaceMembership,
  resolveFlightDeckPgActorByNpub,
  resolveFlightDeckPgWorkspace,
  resolveOrCreateFlightDeckPgActor,
  type FlightDeckPgActor,
  type FlightDeckPgWorkspace,
} from './flightdeck-pg-authorization';

type DbClient = ReturnType<typeof getDb>;
type DbJsonValue = Parameters<DbClient['json']>[0];

export type FlightDeckPgValidationField = {
  path: string;
  code: string;
  message: string;
};

export type FlightDeckPgPersonalAgentSettings = {
  workspace_id: string;
  actor_id: string;
  autopilot_agents: Array<{ agent_npub: string; url: string }>;
  row_version: number;
  created_at: Date;
  updated_at: Date;
};

export type FlightDeckPgSearchMode = 'subtree' | 'outside_subtree' | 'workspace';

export type FlightDeckPgSearchResult = {
  id: string;
  record_type: 'document' | 'task' | 'task_comment' | 'message' | 'doc_comment' | 'file' | 'approval';
  title: string;
  snippet: string;
  scope_id: string | null;
  scope_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  updated_at: Date;
  navigation_target: Record<string, unknown>;
  relevance: number;
};

export type FlightDeckPgPersonalWappSignerProfile = {
  enabled: boolean;
  allowed_origins: string[];
  allowed_nip98_target_origins: string[];
  allowed_event_kinds: number[];
  capabilities: string[];
  trust_version: number;
};

export type FlightDeckPgPersonalWappOriginPolicy = {
  trusted: boolean;
  reason: 'trusted' | 'not_registered' | 'ambiguous_origin';
  origin: string;
  personal_wapp: ReturnType<typeof serializeFlightDeckPgPersonalWapp> | null;
  signer_profile: FlightDeckPgPersonalWappSignerProfile | null;
};

function recordFromDb(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export interface FlightDeckPgDriveTreeItemRow {
  type: 'folder' | 'file';
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  parent_folder_id: string | null;
  name: string | null;
  storage_object_id: string | null;
  current_version_id: string | null;
  row_version: number;
  updated_at: Date;
  sort_key: string;
}

export type FlightDeckPgWorkroomParticipantInput = {
  actorNpub: string;
  kind: FlightDeckPgWorkroomParticipantKind;
  role: FlightDeckPgWorkroomParticipantRole;
  label?: string | null;
  status?: FlightDeckPgWorkroomParticipantStatus;
  accessStatus?: FlightDeckPgWorkroomAccessStatus;
  accessIssue?: string | null;
  metadata?: Record<string, unknown>;
};

export type FlightDeckPgWorkroomLinkInput = {
  linkType: FlightDeckPgWorkroomLinkType;
  targetType: string;
  targetId?: string | null;
  externalUrl?: string | null;
  label?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown>;
};

export type FlightDeckPgWorkroomEventInput = {
  eventType: FlightDeckPgWorkroomEventType;
  actorNpub?: string | null;
  actorId?: string | null;
  targetType?: string | null;
  targetRef?: string | null;
  title?: string | null;
  body?: string | null;
  payload?: Record<string, unknown>;
  visibility?: FlightDeckPgWorkroomEventVisibility;
};

function asDbJson(value: unknown): DbJsonValue {
  return value as DbJsonValue;
}

export const flightDeckPgCapabilities = [
  'pg_workspaces',
  'pg_scopes',
  'pg_channels',
  'pg_channel_grants',
  'pg_tasks',
  'pg_chat',
  'pg_files',
  'pg_audio_notes',
  'pg_reactions',
  'pg_resource_view_states',
  'pg_daily_notes',
  'pg_personal_wapps',
  'pg_wapp_activity',
  'pg_invocations',
  'pg_workrooms',
  'pg_workspace_sync',
  'realtime_events',
] as const;

export const flightDeckPgWorkspaceCapabilities = [
  'pg_scopes',
  'pg_channels',
  'pg_channel_grants',
  'pg_tasks',
  'pg_chat',
  'pg_files',
  'pg_audio_notes',
  'pg_reactions',
  'pg_resource_view_states',
  'pg_daily_notes',
  'pg_personal_wapps',
  'pg_wapp_activity',
  'pg_invocations',
  'pg_workrooms',
  'pg_workspace_sync',
  'realtime_events',
] as const;

const channelPermissionSet = new Set<FlightDeckPgPermission>([
  'channel.read',
  'channel.write',
  'channel.manage',
  'channel.grant',
  'channel.grants.read',
  'channel.grants.manage',
  'task.read',
  'task.create',
  'task.update',
  'task.comment',
  'comment.create',
  'doc.read',
  'doc.write',
  'file.read',
  'file.write',
  'audio_note.read',
  'audio_note.write',
]);

const channelAnchoredPermissions = new Set<FlightDeckPgPermission>(
  flightDeckPgPermissions.filter((permission) => channelPermissionSet.has(permission)),
);

export const flightDeckPgViewPermissions: readonly FlightDeckPgPermission[] = [
  'channel.read',
  'task.read',
  'doc.read',
  'file.read',
  'audio_note.read',
] as const;

export const flightDeckPgContributePermissions: readonly FlightDeckPgPermission[] = [
  ...flightDeckPgViewPermissions,
  'channel.write',
  'task.create',
  'task.update',
  'task.comment',
  'comment.create',
  'doc.write',
  'file.write',
  'audio_note.write',
] as const;

export const flightDeckPgManagePermissions: readonly FlightDeckPgPermission[] = [
  ...flightDeckPgContributePermissions,
  'channel.manage',
  'channel.grants.read',
  'channel.grants.manage',
] as const;

export type FlightDeckPgAccessLevel = 'view' | 'contribute' | 'manage' | 'custom';
export type FlightDeckPgStandardAccessLevel = Exclude<FlightDeckPgAccessLevel, 'custom'>;

export function flightDeckPgPermissionsForAccessLevel(accessLevel: FlightDeckPgStandardAccessLevel): FlightDeckPgPermission[] {
  if (accessLevel === 'view') return [...flightDeckPgViewPermissions];
  if (accessLevel === 'contribute') return [...flightDeckPgContributePermissions];
  return [...flightDeckPgManagePermissions];
}

export function isFlightDeckPgStandardAccessLevel(value: string): value is FlightDeckPgStandardAccessLevel {
  return value === 'view' || value === 'contribute' || value === 'manage';
}

export function flightDeckPgAccessLevelForPermissions(permissions: readonly FlightDeckPgPermission[]): FlightDeckPgAccessLevel {
  const sorted = [...new Set(permissions)].sort();
  const matches = (bundle: readonly FlightDeckPgPermission[]) => {
    const bundleSorted = [...bundle].sort();
    return sorted.length === bundleSorted.length && sorted.every((permission, index) => permission === bundleSorted[index]);
  };
  if (matches(flightDeckPgViewPermissions)) return 'view';
  if (matches(flightDeckPgContributePermissions)) return 'contribute';
  if (matches(flightDeckPgManagePermissions)) return 'manage';
  return 'custom';
}

export type FlightDeckPgIdentity = {
  tower_service_npub: string | null;
  workspace_service_npub: string | null;
  workspace_owner_npub: string | null;
  workspace_id: string | null;
  app_npub: string;
};

export type FlightDeckPgWorkspaceMembershipView = {
  workspace_id: string;
  actor_id: string;
  role: FlightDeckPgWorkspaceRole;
  created_at: Date;
};

export type FlightDeckPgWorkspaceSummary = {
  workspace: FlightDeckPgWorkspace;
  membership: FlightDeckPgWorkspaceMembershipView;
};

export type FlightDeckPgScopeRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  kind: FlightDeckPgScopeKind;
  created_by_actor_id: string | null;
  owner_actor_id: string | null;
  owner_group_id: string | null;
  default_channel_id: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

export type FlightDeckPgChannelRow = {
  id: string;
  workspace_id: string;
  scope_id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  kind: FlightDeckPgChannelKind;
  position: number | null;
  participant_npubs: string[] | null;
  created_by_actor_id: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

export type FlightDeckPgPermissionGrantRow = {
  id: string;
  workspace_id: string;
  principal_type: FlightDeckPgPrincipalType;
  principal_actor_id: string | null;
  principal_group_id: string | null;
  resource_type: 'workspace' | 'scope' | 'channel';
  resource_scope_id: string | null;
  resource_channel_id: string | null;
  permission: FlightDeckPgPermission;
  created_by_actor_id: string | null;
  created_at: Date;
  revoked_at: Date | null;
  channel_scope_id: string | null;
  principal_actor_npub: string | null;
  principal_actor_display_name: string | null;
  principal_actor_kind: string | null;
  principal_group_name: string | null;
  principal_group_kind: string | null;
};

export type FlightDeckPgGroupRow = {
  id: string;
  workspace_id: string;
  name: string;
  kind: FlightDeckPgGroupKind;
  created_by_actor_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type FlightDeckPgGroupMemberRow = {
  workspace_id: string;
  group_id: string;
  actor_id: string;
  created_by_actor_id: string | null;
  created_at: Date;
};

export type FlightDeckPgGroupEdgeRow = {
  workspace_id: string;
  parent_group_id: string;
  child_group_id: string;
  created_by_actor_id: string | null;
  created_at: Date;
};

export type FlightDeckPgTaskRow = FlightDeckPgTask;
export type FlightDeckPgTaskCommentRow = FlightDeckPgTaskComment;
export type FlightDeckPgDocCommentRow = FlightDeckPgDocComment;
export type FlightDeckPgTaskAssignmentRow = FlightDeckPgTaskAssignment;
type FlightDeckPgTaskAssignmentWithActorNpub = FlightDeckPgTaskAssignmentRow & {
  actor_npub?: string | null;
};
type FlightDeckPgTaskWithAssignments = FlightDeckPgTaskRow & {
  assignments?: FlightDeckPgTaskAssignmentWithActorNpub[];
};
export type FlightDeckPgThreadRow = FlightDeckPgThread;
export type FlightDeckPgMessageRow = FlightDeckPgMessage;
export type FlightDeckPgDocRow = FlightDeckPgDoc;
export type FlightDeckPgDocRecoveryVersionRow = FlightDeckPgDocRecoveryVersion;
export type FlightDeckPgFileRow = FlightDeckPgFile;
export type FlightDeckPgFileVersionRow = FlightDeckPgFileVersion;
export type FlightDeckPgFileVersionListRow = FlightDeckPgFileVersionRow & {
  created_by_actor_npub: string | null;
  size_bytes: number | string;
  content_type: string;
  sha256_hex: string | null;
};
export type FlightDeckPgFileFolderRow = FlightDeckPgFileFolder;
export type FlightDeckPgAudioNoteRow = FlightDeckPgAudioNote;
export type FlightDeckPgDailyNoteRow = FlightDeckPgDailyNote;
export type FlightDeckPgPersonalWappRow = FlightDeckPgPersonalWapp;
export type FlightDeckPgReactionRow = FlightDeckPgReaction;
export type FlightDeckPgResponseActivityRow = FlightDeckPgResponseActivity;
export type FlightDeckPgAgentActivityRow = FlightDeckPgAgentActivity;
export type FlightDeckPgInvocationRow = FlightDeckPgInvocation;
export type FlightDeckPgTypedApprovalRow = FlightDeckPgTypedApproval;
export type FlightDeckPgWorkroomRow = FlightDeckPgWorkroom;
export type FlightDeckPgWorkroomParticipantRow = FlightDeckPgWorkroomParticipant;
export type FlightDeckPgWorkroomEventRow = FlightDeckPgWorkroomEvent;
export type FlightDeckPgWorkroomLinkRow = FlightDeckPgWorkroomLink;

export type FlightDeckPgOutboxEventRow = FlightDeckPgOutboxEvent;

export type FlightDeckPgDocVersionRow = {
  workspace_id: string;
  doc_id: string;
  row_version: number;
  scope_id: string;
  channel_id: string;
  storage_object_id: string;
  title: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  operation: 'created' | 'updated' | 'deleted';
  actor_id: string;
  created_at: Date;
  updated_at: Date;
  actor_npub?: string | null;
};

export type FlightDeckPgDocVersionIdentityRow = {
  version_id: string;
  row_version: number;
  storage_object_id: string;
  body_sha256_hex: string | null;
  size_bytes: number | null;
};

type FlightDeckPgDocHeadRow = FlightDeckPgDocRow & {
  body_sha256_hex: string | null;
  body_size_bytes: number | string | null;
};

export type FlightDeckPgDailyNoteVersionRow = {
  workspace_id: string;
  daily_note_id: string;
  row_version: number;
  owner_actor_id: string;
  scope_id: string | null;
  channel_id: string | null;
  note_date: Date | string;
  title: string;
  body: string | null;
  focus: string | null;
  items: unknown[];
  status: FlightDeckPgDailyNoteStatus;
  metadata: Record<string, unknown>;
  content_fingerprint: string;
  operation: 'created' | 'updated' | 'restored';
  actor_id: string;
  created_at: Date;
  updated_at: Date;
  actor_npub?: string | null;
};

export type FlightDeckPgEditLeaseEntityType = 'task' | 'document';

export type FlightDeckPgEditLeaseRow = {
  id: string;
  workspace_id: string;
  entity_type: FlightDeckPgEditLeaseEntityType;
  entity_id: string;
  field_path: string | null;
  lease_token_hash: string;
  holder_actor_id: string;
  holder_actor_npub: string;
  expires_at: Date;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type FlightDeckPgSerializedEditLease = {
  id: string;
  entity_type: FlightDeckPgEditLeaseEntityType;
  entity_id: string;
  field_path: string | null;
  lease_token?: string;
  holder_actor_npub: string;
  expires_at: Date;
};

export type FlightDeckPgEditLeaseConflict = {
  ok: false;
  reason: 'lease_conflict';
  lease: FlightDeckPgSerializedEditLease;
};

export type FlightDeckPgEditLeaseInvalid = {
  ok: false;
  reason: 'lease_missing' | 'lease_invalid' | 'lease_expired';
};

export type FlightDeckPgEventCursor = {
  version: 1;
  rowVersion: number;
};

export type FlightDeckPgSerializedEvent = {
  id: string;
  event_id: string;
  cursor: string;
  workspace_id: string;
  scope_id: string | null;
  channel_id: string | null;
  actor_id: string | null;
  actor_npub: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  operation: string;
  entity_row_version: number | null;
  row_version: number;
  timestamp: Date;
  created_at: Date;
  payload: Record<string, unknown>;
  visible_to_agent_npubs?: string[];
  refetch: {
    entity_type: string;
    entity_id: string | null;
    route: string | null;
  };
};

export function buildFlightDeckPgIdentity(workspace: FlightDeckPgWorkspace | null, appNpub: string): FlightDeckPgIdentity {
  return {
    tower_service_npub: workspace?.tower_service_npub ?? null,
    workspace_service_npub: workspace?.workspace_service_npub ?? null,
    workspace_owner_npub: workspace?.workspace_owner_npub ?? null,
    workspace_id: workspace?.id ?? null,
    app_npub: workspace?.app_npub ?? appNpub,
  };
}

export function serializeFlightDeckPgScope(scope: FlightDeckPgScopeRow) {
  return {
    id: scope.id,
    workspace_id: scope.workspace_id,
    name: scope.name,
    description: scope.description,
    kind: scope.kind,
    owner_actor_id: scope.owner_actor_id,
    owner_group_id: scope.owner_group_id,
    default_channel_id: scope.default_channel_id,
    row_version: 1,
    created_at: scope.created_at,
    updated_at: scope.updated_at,
  };
}

export function serializeFlightDeckPgChannel(channel: FlightDeckPgChannelRow) {
  return {
    id: channel.id,
    workspace_id: channel.workspace_id,
    scope_id: channel.scope_id,
    name: channel.name,
    description: channel.description,
    metadata: normalizeFlightDeckPgChannelMetadata(channel.metadata),
    kind: channel.kind,
    position: channel.position === null ? null : Number(channel.position),
    participant_npubs: channel.participant_npubs ?? null,
    row_version: 1,
    created_at: channel.created_at,
    updated_at: channel.updated_at,
  };
}

export function serializeFlightDeckPgGrant(grant: FlightDeckPgPermissionGrantRow, permissions?: FlightDeckPgPermission[]) {
  const grantPermissions = permissions ?? [grant.permission];
  const principalType = grant.principal_type === 'actor' ? 'person' : grant.principal_type;
  return {
    id: grant.id,
    workspace_id: grant.workspace_id,
    scope_id: grant.channel_scope_id ?? grant.resource_scope_id,
    channel_id: grant.resource_channel_id,
    principal_type: principalType,
    stored_principal_type: grant.principal_type,
    principal_id: grant.principal_actor_id ?? grant.principal_group_id,
    principal: grant.principal_type === 'group'
      ? {
          type: 'group',
          id: grant.principal_group_id,
          name: grant.principal_group_name,
          kind: grant.principal_group_kind,
        }
      : {
          type: 'person',
          id: grant.principal_actor_id,
          actor_id: grant.principal_actor_id,
          npub: grant.principal_actor_npub,
          display_name: grant.principal_actor_display_name,
          kind: grant.principal_actor_kind,
        },
    permissions: grantPermissions,
    access_level: flightDeckPgAccessLevelForPermissions(grantPermissions),
    row_version: 1,
    created_at: grant.created_at,
    updated_at: grant.created_at,
  };
}

export function serializeFlightDeckPgGrantBundles(grants: FlightDeckPgPermissionGrantRow[]) {
  const bundles = new Map<string, { grant: FlightDeckPgPermissionGrantRow; permissions: FlightDeckPgPermission[] }>();
  for (const grant of grants) {
    const key = `${grant.principal_type}:${grant.principal_actor_id ?? grant.principal_group_id}`;
    const existing = bundles.get(key);
    if (existing) {
      existing.permissions.push(grant.permission);
      if (grant.created_at < existing.grant.created_at) existing.grant = grant;
    } else {
      bundles.set(key, { grant, permissions: [grant.permission] });
    }
  }
  return [...bundles.values()].map((bundle) => serializeFlightDeckPgGrant(bundle.grant, [...new Set(bundle.permissions)]));
}

export function serializeFlightDeckPgActor(actor: FlightDeckPgActor) {
  return {
    actor_id: actor.id,
    id: actor.id,
    npub: actor.npub,
    kind: actor.kind,
    display_name: actor.display_name,
  };
}

export function serializeFlightDeckPgWorkspaceMembership(membership: FlightDeckPgWorkspaceMembershipView) {
  return {
    workspace_id: membership.workspace_id,
    actor_id: membership.actor_id,
    role: membership.role,
    joined_at: membership.created_at,
    created_at: membership.created_at,
  };
}

export function serializeFlightDeckPgGroup(group: FlightDeckPgGroupRow & {
  members?: FlightDeckPgActor[];
  child_group_ids?: string[];
  parent_group_ids?: string[];
  effective_members?: FlightDeckPgActor[];
}) {
  const members = group.members ?? [];
  const effectiveMembers = group.effective_members ?? members;
  return {
    id: group.id,
    group_id: group.id,
    workspace_id: group.workspace_id,
    name: group.name,
    kind: group.kind,
    group_kind: group.kind,
    member_npubs: members.map((member) => member.npub),
    members: members.map(serializeFlightDeckPgActor),
    child_group_ids: group.child_group_ids ?? [],
    parent_group_ids: group.parent_group_ids ?? [],
    effective_member_npubs: effectiveMembers.map((member) => member.npub),
    effective_members: effectiveMembers.map(serializeFlightDeckPgActor),
    row_version: 1,
    created_by_actor_id: group.created_by_actor_id,
    created_at: group.created_at,
    updated_at: group.updated_at,
  };
}

export function serializeFlightDeckPgWorkroom(workroom: FlightDeckPgWorkroomRow) {
  return {
    ...workroom,
    repo: recordFromDb(workroom.repo),
    branches: recordFromDb(workroom.branches),
    app_targets: recordFromDb(workroom.app_targets),
    approval_policy: recordFromDb(workroom.approval_policy),
    archive_policy: recordFromDb(workroom.archive_policy),
    metadata: recordFromDb(workroom.metadata),
    created_at: workroom.created_at,
    updated_at: workroom.updated_at,
    completed_at: workroom.completed_at,
    archived_at: workroom.archived_at,
    deleted_at: workroom.deleted_at,
  };
}

export function serializeFlightDeckPgWorkroomParticipant(participant: FlightDeckPgWorkroomParticipantRow) {
  return {
    ...participant,
    metadata: recordFromDb(participant.metadata),
    created_at: participant.created_at,
    updated_at: participant.updated_at,
  };
}

export function serializeFlightDeckPgWorkroomEvent(event: FlightDeckPgWorkroomEventRow) {
  return {
    ...event,
    payload: recordFromDb(event.payload),
    created_at: event.created_at,
  };
}

export function serializeFlightDeckPgWorkroomLink(link: FlightDeckPgWorkroomLinkRow) {
  return {
    ...link,
    metadata: recordFromDb(link.metadata),
    created_at: link.created_at,
    updated_at: link.updated_at,
  };
}

export function serializeFlightDeckPgTypedApproval(approval: FlightDeckPgTypedApprovalRow) {
  return {
    ...approval,
    metadata: recordFromDb(approval.metadata),
    requested_at: approval.requested_at,
    reviewed_at: approval.reviewed_at,
    approved_at: approval.approved_at,
    rejected_at: approval.rejected_at,
    superseded_at: approval.superseded_at,
    cancelled_at: approval.cancelled_at,
    created_at: approval.created_at,
    updated_at: approval.updated_at,
  };
}

export function serializeFlightDeckPgTask(task: FlightDeckPgTaskWithAssignments) {
  const metadata = task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
    ? task.metadata as Record<string, unknown>
    : {};
  const assignedToNpub = typeof metadata.assigned_to_npub === 'string' && metadata.assigned_to_npub.trim()
    ? metadata.assigned_to_npub.trim()
    : null;
  return {
    id: task.id,
    workspace_id: task.workspace_id,
    scope_id: task.scope_id,
    channel_id: task.channel_id,
    thread_id: task.thread_id,
    title: task.title,
    description: task.description,
    state: task.state,
    priority: task.priority,
    metadata: task.metadata,
    assigned_to_npub: assignedToNpub,
    row_version: task.row_version,
    activity_version: Number(task.activity_version),
    created_by_actor_id: task.created_by_actor_id,
    updated_by_actor_id: task.updated_by_actor_id,
    assignments: (task.assignments ?? []).map(serializeFlightDeckPgTaskAssignment),
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

export function serializeFlightDeckPgDailyNote(note: FlightDeckPgDailyNoteRow) {
  const extended = note as FlightDeckPgDailyNoteRow & {
    owner_actor_npub?: string | null;
    updated_by_actor_npub?: string | null;
  };
  return {
    id: note.id,
    workspace_id: note.workspace_id,
    owner_actor_id: note.owner_actor_id,
    owner_actor_npub: extended.owner_actor_npub ?? null,
    owner_npub: extended.owner_actor_npub ?? null,
    sender_npub: extended.owner_actor_npub ?? null,
    scope_id: note.scope_id,
    channel_id: note.channel_id,
    note_date: note.note_date instanceof Date ? note.note_date.toISOString().slice(0, 10) : String(note.note_date),
    title: note.title,
    body: note.body,
    focus: note.focus,
    items: note.items,
    status: note.status,
    metadata: note.metadata,
    row_version: note.row_version,
    created_by_actor_id: note.created_by_actor_id,
    updated_by_actor_id: note.updated_by_actor_id,
    updated_by_actor_npub: extended.updated_by_actor_npub ?? null,
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
}

export function serializeFlightDeckPgDailyNoteVersion(version: FlightDeckPgDailyNoteVersionRow) {
  return {
    workspace_id: version.workspace_id,
    daily_note_id: version.daily_note_id,
    version: version.row_version,
    row_version: version.row_version,
    owner_actor_id: version.owner_actor_id,
    scope_id: version.scope_id,
    channel_id: version.channel_id,
    note_date: version.note_date,
    title: version.title,
    body: version.body,
    focus: version.focus,
    items: version.items,
    status: version.status,
    metadata: version.metadata,
    operation: version.operation,
    actor_id: version.actor_id,
    actor_npub: version.actor_npub ?? null,
    created_at: version.created_at,
    updated_at: version.updated_at,
  };
}

export function serializeFlightDeckPgPersonalWapp(wapp: FlightDeckPgPersonalWappRow) {
  const extended = wapp as FlightDeckPgPersonalWappRow & {
    owner_actor_npub?: string | null;
    updated_by_actor_npub?: string | null;
  };
  const signerValidation = normalizeFlightDeckPgPersonalWappSignerMetadata({
    metadata: wapp.metadata,
    launchUrl: wapp.launch_url,
  });
  return {
    id: wapp.id,
    record_id: wapp.id,
    workspace_id: wapp.workspace_id,
    owner_actor_id: wapp.owner_actor_id,
    owner_actor_npub: extended.owner_actor_npub ?? null,
    owner_npub: extended.owner_actor_npub ?? null,
    scope_id: wapp.scope_id,
    channel_id: wapp.channel_id,
    title: wapp.title,
    description: wapp.description,
    launch_url: wapp.launch_url,
    icon_url: wapp.icon_url,
    app_id: wapp.app_id,
    wapp_id: wapp.wapp_id,
    source_wingman_url: wapp.source_wingman_url,
    sort_order: wapp.sort_order,
    status: wapp.status,
    record_state: wapp.status,
    metadata: wapp.metadata,
    signer_profile: signerValidation.profile,
    row_version: wapp.row_version,
    created_by_actor_id: wapp.created_by_actor_id,
    updated_by_actor_id: wapp.updated_by_actor_id,
    updated_by_actor_npub: extended.updated_by_actor_npub ?? null,
    created_at: wapp.created_at,
    updated_at: wapp.updated_at,
  };
}

export function resolveFlightDeckPgPersonalWappOriginPolicy(
  origin: string,
  wapps: FlightDeckPgPersonalWappRow[],
): FlightDeckPgPersonalWappOriginPolicy {
  const normalizedOrigin = normalizeHttpOrigin(origin);
  if (!normalizedOrigin) {
    throw new Error('origin must be an http(s) origin');
  }

  const matches = wapps.flatMap((wapp) => {
    if (wapp.status !== 'active') return [];
    const serialized = serializeFlightDeckPgPersonalWapp(wapp);
    const profile = serialized.signer_profile;
    if (!profile?.enabled || !profile.allowed_origins.includes(normalizedOrigin)) return [];
    return [{ personalWapp: serialized, profile }];
  });

  if (matches.length !== 1) {
    return {
      trusted: false,
      reason: matches.length > 1 ? 'ambiguous_origin' : 'not_registered',
      origin: normalizedOrigin,
      personal_wapp: null,
      signer_profile: null,
    };
  }

  return {
    trusted: true,
    reason: 'trusted',
    origin: normalizedOrigin,
    personal_wapp: matches[0]!.personalWapp,
    signer_profile: matches[0]!.profile,
  };
}

export function normalizeFlightDeckPgPersonalWappSignerMetadata(input: {
  metadata: Record<string, unknown>;
  launchUrl: string;
}): {
  metadata: Record<string, unknown>;
  profile: FlightDeckPgPersonalWappSignerProfile | null;
  errors: FlightDeckPgValidationField[];
} {
  const signer = input.metadata.signer;
  if (signer === undefined || signer === null) {
    return { metadata: input.metadata, profile: null, errors: [] };
  }
  if (!isPlainObject(signer)) {
    return {
      metadata: input.metadata,
      profile: null,
      errors: [{
        path: 'metadata.signer',
        code: 'invalid',
        message: 'metadata.signer must be an object when provided',
      }],
    };
  }

  const errors: FlightDeckPgValidationField[] = [];
  const enabled = signer.enabled !== false;
  const launchOrigin = normalizeHttpOrigin(input.launchUrl);
  const allowedOrigins = signer.allowed_origins === undefined
    ? []
    : normalizeOriginList(
      signer.allowed_origins,
      'metadata.signer.allowed_origins',
      errors,
    );
  const targetOrigins = signer.allowed_nip98_target_origins === undefined
    ? allowedOrigins
    : normalizeOriginList(
      signer.allowed_nip98_target_origins,
      'metadata.signer.allowed_nip98_target_origins',
      errors,
    );
  const eventKinds = normalizePositiveIntegerList(
    signer.allowed_event_kinds,
    'metadata.signer.allowed_event_kinds',
    errors,
    [27235],
  );
  const capabilities = normalizeStringList(
    signer.capabilities,
    'metadata.signer.capabilities',
    errors,
    ['nip98'],
  );
  const trustVersion = signer.trust_version === undefined
    ? 1
    : Number(signer.trust_version);

  if (!Number.isInteger(trustVersion) || trustVersion < 1) {
    errors.push({
      path: 'metadata.signer.trust_version',
      code: 'invalid',
      message: 'metadata.signer.trust_version must be a positive integer',
    });
  }

  if (enabled) {
    if (allowedOrigins.length === 0) {
      errors.push({
        path: 'metadata.signer.allowed_origins',
        code: 'required',
        message: 'metadata.signer.allowed_origins must include at least one origin when signer is enabled',
      });
    }
    if (launchOrigin && !allowedOrigins.includes(launchOrigin)) {
      errors.push({
        path: 'metadata.signer.allowed_origins',
        code: 'launch_origin_required',
        message: 'metadata.signer.allowed_origins must include the launch_url origin',
      });
    }
    if (!eventKinds.includes(27235)) {
      errors.push({
        path: 'metadata.signer.allowed_event_kinds',
        code: 'nip98_required',
        message: 'metadata.signer.allowed_event_kinds must include 27235 for NIP-98',
      });
    }
    if (!capabilities.includes('nip98')) {
      errors.push({
        path: 'metadata.signer.capabilities',
        code: 'nip98_required',
        message: 'metadata.signer.capabilities must include nip98',
      });
    }
  }

  const profile: FlightDeckPgPersonalWappSignerProfile = {
    enabled,
    allowed_origins: allowedOrigins,
    allowed_nip98_target_origins: targetOrigins,
    allowed_event_kinds: eventKinds,
    capabilities,
    trust_version: Number.isInteger(trustVersion) && trustVersion > 0
      ? trustVersion
      : 1,
  };

  return {
    metadata: {
      ...input.metadata,
      signer: profile,
    },
    profile: errors.length === 0 ? profile : null,
    errors,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeHttpOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.port
      ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}`
      : `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return null;
  }
}

function normalizeOriginList(
  value: unknown,
  path: string,
  errors: FlightDeckPgValidationField[],
): string[] {
  if (!Array.isArray(value)) {
    errors.push({
      path,
      code: 'invalid',
      message: `${path} must be an array of http(s) origins`,
    });
    return [];
  }
  const origins: string[] = [];
  value.forEach((item, index) => {
    const origin = normalizeHttpOrigin(item);
    if (!origin) {
      errors.push({
        path: `${path}.${index}`,
        code: 'invalid',
        message: `${path}.${index} must be an http(s) origin`,
      });
      return;
    }
    if (!origins.includes(origin)) origins.push(origin);
  });
  return origins;
}

function normalizePositiveIntegerList(
  value: unknown,
  path: string,
  errors: FlightDeckPgValidationField[],
  defaultValue: number[],
): number[] {
  if (value === undefined) return defaultValue;
  if (!Array.isArray(value)) {
    errors.push({
      path,
      code: 'invalid',
      message: `${path} must be an array of positive integers`,
    });
    return [];
  }
  const result: number[] = [];
  value.forEach((item, index) => {
    const numberValue = Number(item);
    if (!Number.isInteger(numberValue) || numberValue < 1) {
      errors.push({
        path: `${path}.${index}`,
        code: 'invalid',
        message: `${path}.${index} must be a positive integer`,
      });
      return;
    }
    if (!result.includes(numberValue)) result.push(numberValue);
  });
  return result;
}

function normalizeStringList(
  value: unknown,
  path: string,
  errors: FlightDeckPgValidationField[],
  defaultValue: string[],
): string[] {
  if (value === undefined) return defaultValue;
  if (!Array.isArray(value)) {
    errors.push({
      path,
      code: 'invalid',
      message: `${path} must be an array of strings`,
    });
    return [];
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push({
        path: `${path}.${index}`,
        code: 'invalid',
        message: `${path}.${index} must be a non-empty string`,
      });
      return;
    }
    const normalized = item.trim();
    if (!result.includes(normalized)) result.push(normalized);
  });
  return result;
}

export function serializeFlightDeckPgTaskComment(comment: FlightDeckPgTaskCommentRow) {
  const extended = comment as FlightDeckPgTaskCommentRow & {
    created_by_actor_npub?: string | null;
  };
  return {
    id: comment.id,
    workspace_id: comment.workspace_id,
    scope_id: comment.scope_id,
    channel_id: comment.channel_id,
    task_id: comment.task_id,
    thread_id: comment.thread_id,
    body: comment.body,
    metadata: comment.metadata,
    row_version: comment.row_version,
    created_by_actor_id: comment.created_by_actor_id,
    created_by_actor_npub: extended.created_by_actor_npub ?? null,
    sender_npub: extended.created_by_actor_npub ?? null,
    updated_by_actor_id: comment.updated_by_actor_id,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

export function serializeFlightDeckPgDocComment(comment: FlightDeckPgDocCommentRow) {
  const extended = comment as FlightDeckPgDocCommentRow & {
    created_by_actor_npub?: string | null;
  };
  return {
    id: comment.id,
    workspace_id: comment.workspace_id,
    scope_id: comment.scope_id,
    channel_id: comment.channel_id,
    doc_id: comment.doc_id,
    parent_comment_id: comment.parent_comment_id,
    body: comment.body,
    metadata: comment.metadata,
    record_state: comment.deleted_at ? 'deleted' : 'active',
    deleted_at: comment.deleted_at,
    row_version: comment.row_version,
    created_by_actor_id: comment.created_by_actor_id,
    created_by_actor_npub: extended.created_by_actor_npub ?? null,
    sender_npub: extended.created_by_actor_npub ?? null,
    updated_by_actor_id: comment.updated_by_actor_id,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

export function serializeFlightDeckPgTaskAssignment(assignment: FlightDeckPgTaskAssignmentWithActorNpub) {
  return {
    workspace_id: assignment.workspace_id,
    scope_id: assignment.scope_id,
    channel_id: assignment.channel_id,
    task_id: assignment.task_id,
    actor_id: assignment.actor_id,
    actor_npub: assignment.actor_npub ?? null,
    row_version: assignment.row_version,
    created_by_actor_id: assignment.created_by_actor_id,
    updated_by_actor_id: assignment.updated_by_actor_id,
    created_at: assignment.created_at,
    updated_at: assignment.updated_at,
  };
}

export function serializeFlightDeckPgThread(thread: FlightDeckPgThreadRow) {
  const extended = thread as FlightDeckPgThreadRow & {
    created_by_actor_npub?: string | null;
    source_message_body?: string | null;
  };
  return {
    id: thread.id,
    workspace_id: thread.workspace_id,
    scope_id: thread.scope_id,
    channel_id: thread.channel_id,
    source_message_id: thread.source_message_id,
    title: effectiveFlightDeckPgThreadTitle(thread.title, extended.source_message_body ?? thread.latest),
    latest: thread.latest,
    metadata: thread.metadata,
    record_state: thread.deleted_at ? 'deleted' : thread.archived_at ? 'archived' : 'active',
    archived_at: thread.archived_at,
    deleted_at: thread.deleted_at,
    row_version: thread.row_version,
    activity_version: Number(thread.activity_version),
    created_by_actor_id: thread.created_by_actor_id,
    created_by_actor_npub: extended.created_by_actor_npub ?? null,
    sender_npub: extended.created_by_actor_npub ?? null,
    updated_by_actor_id: thread.updated_by_actor_id,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
  };
}

export function serializeFlightDeckPgResourceViewState(state: FlightDeckPgResourceViewState & { activity_version?: number }) {
  const activityVersion = Number(state.activity_version ?? state.viewed_activity_version);
  return {
    workspace_id: state.workspace_id,
    viewer_actor_id: state.viewer_actor_id,
    resource_type: state.resource_type,
    resource_id: state.resource_id,
    scope_id: state.scope_id,
    channel_id: state.channel_id,
    activity_version: activityVersion,
    viewed_activity_version: Number(state.viewed_activity_version),
    unread: activityVersion > Number(state.viewed_activity_version),
    row_version: state.row_version,
    created_at: state.created_at,
    updated_at: state.updated_at,
  };
}

export function serializeFlightDeckPgMessage(message: FlightDeckPgMessageRow) {
  const extended = message as FlightDeckPgMessageRow & {
    thread_source_message_id?: string | null;
    created_by_actor_npub?: string | null;
  };
  return {
    id: message.id,
    workspace_id: message.workspace_id,
    scope_id: message.scope_id,
    channel_id: message.channel_id,
    thread_id: message.thread_id,
    thread_source_message_id: extended.thread_source_message_id ?? null,
    body: message.body,
    client_request_id: message.client_request_id ?? null,
    mentions: mentionsFromMetadata(message.metadata),
    attachments: Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [],
    metadata: message.metadata,
    record_state: message.deleted_at ? 'deleted' : 'active',
    deleted_at: message.deleted_at,
    row_version: message.row_version,
    created_by_actor_id: message.created_by_actor_id,
    created_by_actor_npub: extended.created_by_actor_npub ?? null,
    created_by_actor_label: (extended as typeof extended & { created_by_actor_label?: string | null }).created_by_actor_label ?? null,
    sender_npub: extended.created_by_actor_npub ?? null,
    updated_by_actor_id: message.updated_by_actor_id,
    created_at: message.created_at,
    updated_at: message.updated_at,
  };
}

export function serializeFlightDeckPgStorageObjectMetadata(storageObject: {
  id: string;
  owner_npub: string;
  owner_group_id: string | null;
  created_by_npub: string;
  access_group_ids: string[];
  is_public: boolean;
  file_name: string | null;
  content_type: string;
  size_bytes: number;
  sha256_hex: string | null;
  created_at: Date;
  completed_at: Date | null;
}) {
  return {
    object_id: storageObject.id,
    owner_npub: storageObject.owner_npub,
    owner_group_id: storageObject.owner_group_id,
    created_by_npub: storageObject.created_by_npub,
    access_group_ids: storageObject.access_group_ids,
    is_public: storageObject.is_public,
    file_name: storageObject.file_name,
    content_type: storageObject.content_type,
    size_bytes: Number(storageObject.size_bytes),
    sha256_hex: storageObject.sha256_hex,
    created_at: storageObject.created_at,
    completed_at: storageObject.completed_at,
  };
}

export function serializeFlightDeckPgDoc(doc: FlightDeckPgDocRow, options: { storageObject?: Record<string, unknown> | null } = {}) {
  return {
    id: doc.id,
    workspace_id: doc.workspace_id,
    scope_id: doc.scope_id,
    channel_id: doc.channel_id,
    storage_object_id: doc.storage_object_id,
    title: doc.title,
    summary: doc.summary,
    metadata: doc.metadata,
    row_version: doc.row_version,
    activity_version: Number(doc.activity_version),
    created_by_actor_id: doc.created_by_actor_id,
    updated_by_actor_id: doc.updated_by_actor_id,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    archived_at: doc.archived_at,
    record_state: doc.archived_at ? 'archived' : 'active',
    body: {
      object_id: doc.storage_object_id,
      route: `/api/v4/flightdeck-pg/workspaces/${doc.workspace_id}/docs/${doc.id}/body`,
      ...(options.storageObject ? { storage_object: options.storageObject } : {}),
    },
  };
}

export function serializeFlightDeckPgDocVersion(version: FlightDeckPgDocVersionRow, options: { content?: Record<string, unknown> | null } = {}) {
  return {
    version_id: flightDeckPgCanonicalDocVersionId(version.doc_id, version.row_version),
    workspace_id: version.workspace_id,
    doc_id: version.doc_id,
    version: version.row_version,
    row_version: version.row_version,
    scope_id: version.scope_id,
    channel_id: version.channel_id,
    storage_object_id: version.storage_object_id,
    title: version.title,
    summary: version.summary,
    metadata: version.metadata,
    operation: version.operation,
    actor_id: version.actor_id,
    actor_npub: version.actor_npub ?? null,
    created_at: version.created_at,
    updated_at: version.updated_at,
    ...(options.content ? { content: options.content } : {}),
  };
}

export function flightDeckPgCanonicalDocVersionId(docId: string, rowVersion: number) {
  return `${docId}:${rowVersion}`;
}

export function serializeFlightDeckPgDocVersionIdentity(identity: FlightDeckPgDocVersionIdentityRow) {
  return {
    version_id: identity.version_id,
    row_version: identity.row_version,
    storage_object_id: identity.storage_object_id,
    body_sha256_hex: identity.body_sha256_hex,
    size_bytes: identity.size_bytes,
  };
}

export function serializeFlightDeckPgDocRecoveryVersion(recovery: FlightDeckPgDocRecoveryVersionRow) {
  const base = recovery.base_row_version === null
    ? null
    : {
        row_version: recovery.base_row_version,
        version_id: recovery.base_version_id,
        body_sha256_hex: recovery.base_body_sha256_hex,
      };
  const root = `/api/v4/flightdeck-pg/workspaces/${recovery.workspace_id}/docs/${recovery.doc_id}/recoveries/${recovery.id}`;
  return {
    id: recovery.id,
    workspace_id: recovery.workspace_id,
    doc_id: recovery.doc_id,
    scope_id: recovery.scope_id,
    channel_id: recovery.channel_id,
    reason_code: recovery.reason_code,
    resolution_state: recovery.resolution_state,
    base,
    head_at_creation: {
      row_version: recovery.head_row_version,
      version_id: recovery.head_version_id,
      storage_object_id: recovery.head_storage_object_id,
      body_sha256_hex: recovery.head_body_sha256_hex,
    },
    submitted_body: {
      version_id: recovery.id,
      storage_object_id: recovery.storage_object_id,
      body_sha256_hex: recovery.submitted_body_sha256_hex,
      route: `${root}/body`,
    },
    submitted_patch: recovery.submitted_patch,
    provenance: {
      created_by_actor_id: recovery.created_by_actor_id,
      created_by_signer_npub: recovery.created_by_signer_npub,
      resolved_by_actor_id: recovery.resolved_by_actor_id,
      resolved_by_signer_npub: recovery.resolved_by_signer_npub,
    },
    resolution: {
      state: recovery.resolution_state,
      resolved_at: recovery.resolved_at,
      head_row_version: recovery.resolution_head_row_version,
      metadata: recovery.resolution_metadata,
    },
    created_at: recovery.created_at,
    updated_at: recovery.updated_at,
    actions: {
      read: root,
      body: `${root}/body`,
      promote: `${root}/promote`,
      discard: `${root}/discard`,
    },
  };
}

export function serializeFlightDeckPgFileVersion(
  version: FlightDeckPgFileVersionRow | FlightDeckPgFileVersionListRow,
  options: { storageObject?: V4StorageObject | Record<string, unknown> | null } = {},
) {
  const storageObject = options.storageObject as Partial<V4StorageObject> | null | undefined;
  const listedVersion = version as Partial<FlightDeckPgFileVersionListRow>;
  const sha256Hex = typeof storageObject?.sha256_hex === 'string'
    ? storageObject.sha256_hex
    : (typeof listedVersion.sha256_hex === 'string' ? listedVersion.sha256_hex : null);
  return {
    id: version.id,
    workspace_id: version.workspace_id,
    file_id: version.file_id,
    version_number: version.version_number,
    storage_object_id: version.storage_object_id,
    size_bytes: storageObject?.size_bytes !== undefined
      ? Number(storageObject.size_bytes)
      : (listedVersion.size_bytes !== undefined ? Number(listedVersion.size_bytes) : null),
    content_type: storageObject?.content_type ?? listedVersion.content_type ?? null,
    sha256_hex: sha256Hex,
    etag: sha256Hex ? `"${sha256Hex}"` : null,
    base_version_id: version.base_version_id,
    operation: version.operation,
    created_by_actor_id: version.created_by_actor_id,
    created_by_actor_npub: listedVersion.created_by_actor_npub ?? null,
    created_at: version.created_at,
  };
}

export function serializeFlightDeckPgFile(
  file: FlightDeckPgFileRow,
  options: {
    storageObject?: Record<string, unknown> | null;
    currentVersion?: FlightDeckPgFileVersionRow | null;
    currentVersionStorageObject?: V4StorageObject | Record<string, unknown> | null;
  } = {},
) {
  return {
    id: file.id,
    workspace_id: file.workspace_id,
    scope_id: file.scope_id,
    channel_id: file.channel_id,
    folder_id: file.folder_id,
    storage_object_id: file.storage_object_id,
    current_version_id: file.current_version_id,
    display_name: file.display_name,
    description: file.description,
    metadata: file.metadata,
    row_version: file.row_version,
    created_by_actor_id: file.created_by_actor_id,
    updated_by_actor_id: file.updated_by_actor_id,
    created_at: file.created_at,
    updated_at: file.updated_at,
    archived_at: file.archived_at,
    record_state: file.archived_at ? 'archived' : 'active',
    deleted_at: file.deleted_at,
    deleted_by_actor_id: file.deleted_by_actor_id,
    object: {
      object_id: file.storage_object_id,
      route: `/api/v4/flightdeck-pg/workspaces/${file.workspace_id}/files/${file.id}/object`,
      ...(options.storageObject ? { storage_object: options.storageObject } : {}),
    },
    current_version: options.currentVersion
      ? serializeFlightDeckPgFileVersion(options.currentVersion, { storageObject: options.currentVersionStorageObject })
      : null,
  };
}

export function serializeFlightDeckPgFileFolder(folder: FlightDeckPgFileFolderRow) {
  return {
    id: folder.id,
    workspace_id: folder.workspace_id,
    scope_id: folder.scope_id,
    channel_id: folder.channel_id,
    parent_folder_id: folder.parent_folder_id,
    title: folder.title,
    metadata: folder.metadata,
    row_version: folder.row_version,
    created_by_actor_id: folder.created_by_actor_id,
    updated_by_actor_id: folder.updated_by_actor_id,
    created_at: folder.created_at,
    updated_at: folder.updated_at,
    deleted_at: folder.deleted_at,
    deleted_by_actor_id: folder.deleted_by_actor_id,
  };
}

export function serializeFlightDeckPgAudioNote(audioNote: FlightDeckPgAudioNoteRow, options: { storageObject?: Record<string, unknown> | null } = {}) {
  const extended = audioNote as FlightDeckPgAudioNoteRow & {
    created_by_actor_npub?: string | null;
  };
  return {
    id: audioNote.id,
    workspace_id: audioNote.workspace_id,
    scope_id: audioNote.scope_id,
    channel_id: audioNote.channel_id,
    thread_id: audioNote.thread_id,
    target_type: audioNote.target_type,
    target_id: audioNote.target_id,
    storage_object_id: audioNote.storage_object_id,
    title: audioNote.title,
    mime_type: audioNote.mime_type,
    duration_seconds: audioNote.duration_seconds === null ? null : Number(audioNote.duration_seconds),
    size_bytes: Number(audioNote.size_bytes),
    media_encryption: audioNote.media_encryption,
    waveform_preview: audioNote.waveform_preview,
    transcript_status: audioNote.transcript_status,
    transcript_preview: audioNote.transcript_preview,
    transcript: audioNote.transcript,
    summary: audioNote.summary,
    metadata: audioNote.metadata,
    record_state: audioNote.record_state,
    row_version: audioNote.row_version,
    created_by_actor_id: audioNote.created_by_actor_id,
    created_by_actor_npub: extended.created_by_actor_npub ?? null,
    sender_npub: extended.created_by_actor_npub ?? null,
    updated_by_actor_id: audioNote.updated_by_actor_id,
    created_at: audioNote.created_at,
    updated_at: audioNote.updated_at,
    media: {
      object_id: audioNote.storage_object_id,
      route: `/api/v4/flightdeck-pg/workspaces/${audioNote.workspace_id}/audio-notes/${audioNote.id}/media`,
      ...(options.storageObject ? { storage_object: options.storageObject } : {}),
    },
  };
}

export function serializeFlightDeckPgReaction(reaction: FlightDeckPgReactionRow) {
  const extended = reaction as FlightDeckPgReactionRow & { reactor_npub?: string | null };
  return {
    id: reaction.id,
    workspace_id: reaction.workspace_id,
    scope_id: reaction.scope_id,
    channel_id: reaction.channel_id,
    thread_id: reaction.thread_id,
    target_type: reaction.target_type,
    target_id: reaction.target_id,
    emoji: reaction.emoji,
    emoji_shortcode: reaction.emoji_shortcode,
    reactor_actor_id: reaction.reactor_actor_id,
    reactor_npub: extended.reactor_npub ?? null,
    record_state: reaction.deleted_at ? 'deleted' : 'active',
    row_version: reaction.row_version,
    created_by_actor_id: reaction.created_by_actor_id,
    updated_by_actor_id: reaction.updated_by_actor_id,
    created_at: reaction.created_at,
    updated_at: reaction.updated_at,
  };
}

export function serializeFlightDeckPgResponseActivity(activity: FlightDeckPgResponseActivityRow) {
  return {
    id: activity.id,
    workspace_id: activity.workspace_id,
    scope_id: activity.scope_id,
    channel_id: activity.channel_id,
    target_type: activity.target_type,
    target_id: activity.target_id,
    thread_id: activity.thread_id,
    task_id: activity.task_id,
    doc_id: activity.doc_id,
    parent_comment_id: activity.parent_comment_id,
    actor_id: activity.actor_id,
    actor_npub: activity.actor_npub,
    activity_type: activity.activity_type,
    status: activity.status,
    severity: activity.severity,
    label: activity.label,
    message: activity.message,
    pipeline_run_id: activity.pipeline_run_id,
    source_message_id: activity.source_message_id,
    metadata: activity.metadata,
    record_state: activity.cleared_at || activity.status === 'cleared' ? 'cleared' : 'active',
    row_version: activity.row_version,
    expires_at: activity.expires_at,
    created_at: activity.created_at,
    updated_at: activity.updated_at,
    cleared_at: activity.cleared_at,
  };
}

export function serializeFlightDeckPgAgentActivity(activity: FlightDeckPgAgentActivityRow) {
  return {
    ...activity,
    sequence: Number(activity.sequence),
    ...(activity.commentary_history
      ? {
          commentary_history: activity.commentary_history.map((entry) => ({
            ...entry,
            sequence: Number(entry.sequence),
          })),
        }
      : {}),
  };
}

function normalizeInvocationRecipients(value: unknown): FlightDeckPgInvocationRecipient[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const type = row.type === 'agent' ? 'agent' : 'person';
    const npub = typeof row.npub === 'string' ? row.npub.trim() : '';
    if (!npub) return [];
    const actorId = typeof row.actor_id === 'string' && row.actor_id.trim() ? row.actor_id.trim() : null;
    const status = row.status === 'done' ? 'done' : 'pending';
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {};
    return [{ type, npub, actor_id: actorId, status, metadata }];
  });
}

function normalizeInvocationTargets(value: unknown): FlightDeckPgInvocationTarget[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const rawType = typeof row.type === 'string' ? row.type.trim() : '';
    const type = rawType === 'task' || rawType === 'file' ? rawType : rawType === 'document' || rawType === 'doc' ? 'document' : null;
    const id = typeof row.id === 'string' ? row.id.trim() : typeof row.target_id === 'string' ? row.target_id.trim() : '';
    if (!type || !id) return [];
    const title = typeof row.title === 'string' ? row.title : null;
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {};
    return [{ type, id, title, metadata }];
  });
}

async function hydrateInvocationTargets(
  workspaceId: string,
  targets: FlightDeckPgInvocationTarget[],
  sql: DbClient = getDb(),
): Promise<FlightDeckPgInvocationTarget[]> {
  if (targets.length === 0) return targets;
  const hydrated = await Promise.all(targets.map(async (target) => {
    try {
      if (target.type === 'document') {
        const doc = await resolveFlightDeckPgDoc(workspaceId, target.id, sql);
        return { ...target, title: doc?.title ?? target.title ?? null };
      }
      if (target.type === 'task') {
        const task = await resolveFlightDeckPgTask(workspaceId, target.id, sql);
        return { ...target, title: task?.title ?? target.title ?? null };
      }
      if (target.type === 'file') {
        const file = await resolveFlightDeckPgFile(workspaceId, target.id, sql);
        return { ...target, title: file?.display_name ?? target.title ?? null };
      }
    } catch {
      return target;
    }
    return target;
  }));
  return hydrated;
}

export async function serializeFlightDeckPgInvocation(
  invocation: FlightDeckPgInvocationRow,
  options: { hydrateTargets?: boolean } = {},
) {
  const recipients = normalizeInvocationRecipients(invocation.recipients);
  const normalizedTargets = normalizeInvocationTargets(invocation.targets);
  const targets = options.hydrateTargets === false
    ? normalizedTargets
    : await hydrateInvocationTargets(invocation.workspace_id, normalizedTargets);
  const extended = invocation as FlightDeckPgInvocationRow & {
    created_by_actor_npub?: string | null;
  };
  return {
    id: invocation.id,
    workspace_id: invocation.workspace_id,
    scope_id: invocation.scope_id,
    channel_id: invocation.channel_id,
    prompt: invocation.prompt,
    recipients,
    targets,
    created_by_actor_id: invocation.created_by_actor_id,
    created_by_npub: extended.created_by_actor_npub ?? null,
    status: invocation.status,
    metadata: invocation.metadata,
    row_version: invocation.row_version,
    created_at: invocation.created_at,
    updated_at: invocation.updated_at,
    closed_at: invocation.closed_at,
  };
}

export function encodeFlightDeckPgEventCursor(rowVersion: number): string {
  const payload: FlightDeckPgEventCursor = { version: 1, rowVersion };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeFlightDeckPgEventCursor(raw: string | null | undefined): FlightDeckPgEventCursor | null {
  const value = raw?.trim();
  if (!value) return { version: 1, rowVersion: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<FlightDeckPgEventCursor>;
    if (parsed.version !== 1) return null;
    const rowVersion = parsed.rowVersion;
    if (!Number.isInteger(rowVersion) || rowVersion === undefined || rowVersion < 0) return null;
    return { version: 1, rowVersion };
  } catch {
    return null;
  }
}

function buildFlightDeckPgEventRefetchRoute(event: FlightDeckPgOutboxEventRow) {
  const workspaceId = encodeURIComponent(event.workspace_id);
  const entityId = event.entity_id ? encodeURIComponent(event.entity_id) : null;
  if (event.entity_type === 'channel' && event.scope_id) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${encodeURIComponent(event.scope_id)}/channels`;
  }
  if (event.entity_type === 'message' && event.channel_id) {
    const params = new URLSearchParams();
    if (event.payload?.thread_id) params.set('thread_id', String(event.payload.thread_id));
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${encodeURIComponent(event.channel_id)}/messages${params.toString() ? `?${params.toString()}` : ''}`;
  }
  if (event.entity_type === 'task' && entityId) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${entityId}`;
  }
  if (event.entity_type === 'actor') {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`;
  }
  if ((event.entity_type === 'task_comment' || event.entity_type === 'task_assignment') && event.payload?.task_id) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${encodeURIComponent(String(event.payload.task_id))}`;
  }
  if (event.entity_type === 'message' && event.channel_id) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${encodeURIComponent(event.channel_id)}/messages`;
  }
  if (event.entity_type === 'thread' && event.channel_id) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${encodeURIComponent(event.channel_id)}/threads`;
  }
  if (event.entity_type === 'resource_view_state') {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/resource-view-states`;
  }
  if (event.entity_type === 'doc' && entityId) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${entityId}`;
  }
  if (event.entity_type === 'doc_comment' && event.payload?.doc_id) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${encodeURIComponent(String(event.payload.doc_id))}/comments`;
  }
  if (event.entity_type === 'file' && entityId) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${entityId}`;
  }
  if (event.entity_type === 'file_folder' && entityId) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/file-folders/${entityId}`;
  }
  if (event.entity_type === 'audio_note' && entityId) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/audio-notes/${entityId}`;
  }
  if (event.entity_type === 'daily_note' && entityId) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/daily-notes/${entityId}`;
  }
  if (event.entity_type === 'personal_wapp') {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/personal-wapps`;
  }
  if (event.entity_type === 'reaction' && event.payload?.target_type && event.payload?.target_id) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/reactions?target_type=${encodeURIComponent(String(event.payload.target_type))}&target_id=${encodeURIComponent(String(event.payload.target_id))}`;
  }
  if (event.entity_type === 'response_activity') {
    const params = new URLSearchParams();
    if (event.payload?.target_type) params.set('target_type', String(event.payload.target_type));
    if (event.payload?.target_id) params.set('target_id', String(event.payload.target_id));
    if (event.channel_id) params.set('channel_id', event.channel_id);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/response-activities${suffix}`;
  }
  if (event.entity_type === 'agent_activity') {
    const params = new URLSearchParams();
    if (event.channel_id) params.set('channel_id', event.channel_id);
    if (event.payload?.thread_id) params.set('thread_id', String(event.payload.thread_id));
    if (event.payload?.activity_id) params.set('activity_id', String(event.payload.activity_id));
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/agent-activities?${params.toString()}`;
  }
  if (event.entity_type === 'invocation' && entityId) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/invocations?invocation_id=${entityId}`;
  }
  if (event.entity_type === 'workroom' && entityId) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${entityId}`;
  }
  if (event.entity_type === 'workroom_event' && event.payload?.workroom_id) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${encodeURIComponent(String(event.payload.workroom_id))}/events`;
  }
  if (event.entity_type === 'workroom_link' && event.payload?.workroom_id) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${encodeURIComponent(String(event.payload.workroom_id))}/links`;
  }
  if (event.channel_id) {
    return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${encodeURIComponent(event.channel_id)}/tasks`;
  }
  return null;
}

export function serializeFlightDeckPgEvent(event: FlightDeckPgOutboxEventRow): FlightDeckPgSerializedEvent {
  const extended = event as FlightDeckPgOutboxEventRow & { actor_npub?: string | null };
  return {
    id: event.id,
    event_id: event.id,
    cursor: encodeFlightDeckPgEventCursor(event.row_version),
    workspace_id: event.workspace_id,
    scope_id: event.scope_id,
    channel_id: event.channel_id,
    actor_id: event.actor_id,
    actor_npub: extended.actor_npub ?? (typeof event.payload?.actor_npub === 'string' ? event.payload.actor_npub : null),
    event_type: event.event_type,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    operation: event.operation,
    entity_row_version: event.entity_row_version === null ? null : Number(event.entity_row_version),
    row_version: event.row_version,
    timestamp: event.created_at,
    created_at: event.created_at,
    payload: event.payload ?? {},
    refetch: {
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      route: buildFlightDeckPgEventRefetchRoute(event),
    },
  };
}

export function buildFlightDeckPgWorkspaceLinks(workspaceId: string) {
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  return {
    descriptor: `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/descriptor`,
    me: `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/me`,
    invites: `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/invites`,
    scopes: `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/scopes`,
    personal_wapps: `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/personal-wapps`,
    events: `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/events`,
  };
}

export function serializeFlightDeckPgWorkspaceSummary(
  summary: FlightDeckPgWorkspaceSummary,
  options: { towerBaseUrl?: string } = {},
) {
  return {
    identity: buildFlightDeckPgIdentity(summary.workspace, summary.workspace.app_npub),
    label: summary.workspace.name,
    slug: summary.workspace.slug,
    description: summary.workspace.description,
    avatar_url: summary.workspace.avatar_url,
    metadata: summary.workspace.metadata ?? {},
    tower_base_url: options.towerBaseUrl,
    v4_workspace_id: summary.workspace.v4_workspace_id,
    capabilities: flightDeckPgWorkspaceCapabilities,
    links: buildFlightDeckPgWorkspaceLinks(summary.workspace.id),
    membership: {
      role: summary.membership.role,
      joined_at: summary.membership.created_at,
    },
    created_at: summary.workspace.created_at,
  };
}

export function serializeFlightDeckPgWorkspaceDescriptor(
  workspace: FlightDeckPgWorkspace,
  input: { towerBaseUrl: string },
) {
  return {
    type: 'wingman_workspace_locator',
    version: 1,
    identity: buildFlightDeckPgIdentity(workspace, workspace.app_npub),
    tower_base_url: input.towerBaseUrl,
    label: workspace.name,
    slug: workspace.slug,
    description: workspace.description ?? `${workspace.name} Flight Deck workspace`,
    avatar_url: workspace.avatar_url,
    metadata: workspace.metadata ?? {},
    capabilities: flightDeckPgWorkspaceCapabilities,
    links: buildFlightDeckPgWorkspaceLinks(workspace.id),
    created_at: workspace.created_at,
  };
}

export async function updateFlightDeckPgWorkspaceProfile(
  input: {
    workspaceId: string;
    name: string;
    slug?: string | null;
    description?: string | null;
    avatarUrl?: string | null;
    metadata?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkspace> {
  const [workspace] = await sql<FlightDeckPgWorkspace[]>`
    UPDATE flightdeck_pg_workspaces
    SET
      name = ${input.name},
      slug = ${input.slug ?? ''},
      description = ${input.description ?? null},
      avatar_url = ${input.avatarUrl ?? null},
      metadata = metadata || ${sql.json(asDbJson(input.metadata ?? {}))}::jsonb,
      updated_at = NOW()
    WHERE id = ${input.workspaceId}
    RETURNING
      id,
      tower_service_npub,
      workspace_service_npub,
      workspace_owner_npub,
      app_npub,
      name,
      slug,
      description,
      avatar_url,
      metadata,
      v4_workspace_id,
      created_by_actor_id,
      created_at,
      updated_at
  `;
  if (!workspace) throw new Error('Flight Deck PG workspace not found');
  return workspace;
}

function hashFlightDeckPgEditLeaseToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function serializeFlightDeckPgEditLease(
  lease: FlightDeckPgEditLeaseRow,
  options: { leaseToken?: string | null } = {},
): FlightDeckPgSerializedEditLease {
  return {
    id: lease.id,
    entity_type: lease.entity_type,
    entity_id: lease.entity_id,
    field_path: lease.field_path,
    ...(options.leaseToken ? { lease_token: options.leaseToken } : {}),
    holder_actor_npub: lease.holder_actor_npub,
    expires_at: lease.expires_at,
  };
}

export async function acquireFlightDeckPgEditLease(
  input: {
    workspaceId: string;
    entityType: FlightDeckPgEditLeaseEntityType;
    entityId: string;
    fieldPath?: string | null;
    actorId: string;
    actorNpub: string;
    leaseSeconds?: number | null;
  },
  sql: DbClient = getDb(),
): Promise<{ ok: true; lease: FlightDeckPgSerializedEditLease } | FlightDeckPgEditLeaseConflict> {
  const fieldPath = input.fieldPath?.trim() || null;
  const leaseSeconds = Math.max(30, Math.min(3600, Math.floor(input.leaseSeconds || 900)));
  const [active] = await sql<FlightDeckPgEditLeaseRow[]>`
    SELECT *
    FROM flightdeck_pg_edit_leases
    WHERE workspace_id = ${input.workspaceId}
      AND entity_type = ${input.entityType}
      AND entity_id = ${input.entityId}
      AND (${fieldPath}::text IS NULL OR field_path IS NOT DISTINCT FROM ${fieldPath})
      AND released_at IS NULL
    ORDER BY expires_at DESC, updated_at DESC
    LIMIT 1
  `;

  if (active && active.expires_at > new Date() && active.holder_actor_id !== input.actorId) {
    return { ok: false, reason: 'lease_conflict', lease: serializeFlightDeckPgEditLease(active) };
  }
  if (active && active.expires_at <= new Date()) {
    await sql`
      UPDATE flightdeck_pg_edit_leases
      SET released_at = NOW(), updated_at = NOW()
      WHERE id = ${active.id}
        AND released_at IS NULL
    `;
  }

  const leaseToken = randomUUID();
  const [lease] = await sql<FlightDeckPgEditLeaseRow[]>`
    INSERT INTO flightdeck_pg_edit_leases (
      workspace_id,
      entity_type,
      entity_id,
      field_path,
      lease_token_hash,
      holder_actor_id,
      holder_actor_npub,
      expires_at
    )
    VALUES (
      ${input.workspaceId},
      ${input.entityType},
      ${input.entityId},
      ${fieldPath},
      ${hashFlightDeckPgEditLeaseToken(leaseToken)},
      ${input.actorId},
      ${input.actorNpub},
      NOW() + (${leaseSeconds}::integer * INTERVAL '1 second')
    )
    RETURNING *
  `;
  return { ok: true, lease: serializeFlightDeckPgEditLease(lease, { leaseToken }) };
}

export async function getActiveFlightDeckPgEditLease(
  input: {
    workspaceId: string;
    entityType: FlightDeckPgEditLeaseEntityType;
    entityId: string;
    fieldPath?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgEditLeaseRow | null> {
  const fieldPath = input.fieldPath?.trim() || null;
  const [lease] = await sql<FlightDeckPgEditLeaseRow[]>`
    SELECT *
    FROM flightdeck_pg_edit_leases
    WHERE workspace_id = ${input.workspaceId}
      AND entity_type = ${input.entityType}
      AND entity_id = ${input.entityId}
      AND (${fieldPath}::text IS NULL OR field_path IS NOT DISTINCT FROM ${fieldPath})
      AND released_at IS NULL
      AND expires_at > NOW()
    ORDER BY expires_at DESC, updated_at DESC
    LIMIT 1
  `;
  return lease ?? null;
}

export async function renewFlightDeckPgEditLease(
  input: {
    workspaceId: string;
    leaseId: string;
    leaseToken: string;
    actorId: string;
    leaseSeconds?: number | null;
  },
  sql: DbClient = getDb(),
): Promise<{ ok: true; lease: FlightDeckPgSerializedEditLease } | FlightDeckPgEditLeaseInvalid> {
  const tokenHash = hashFlightDeckPgEditLeaseToken(input.leaseToken);
  const leaseSeconds = Math.max(30, Math.min(3600, Math.floor(input.leaseSeconds || 900)));
  const [lease] = await sql<FlightDeckPgEditLeaseRow[]>`
    UPDATE flightdeck_pg_edit_leases
    SET expires_at = NOW() + (${leaseSeconds}::integer * INTERVAL '1 second'),
        updated_at = NOW()
    WHERE id = ${input.leaseId}
      AND workspace_id = ${input.workspaceId}
      AND holder_actor_id = ${input.actorId}
      AND lease_token_hash = ${tokenHash}
      AND released_at IS NULL
      AND expires_at > NOW()
    RETURNING *
  `;
  if (!lease) return { ok: false, reason: 'lease_invalid' };
  return { ok: true, lease: serializeFlightDeckPgEditLease(lease, { leaseToken: input.leaseToken }) };
}

export async function releaseFlightDeckPgEditLease(
  input: { workspaceId: string; leaseId: string; leaseToken: string; actorId: string },
  sql: DbClient = getDb(),
): Promise<boolean> {
  const tokenHash = hashFlightDeckPgEditLeaseToken(input.leaseToken);
  const [lease] = await sql<{ id: string }[]>`
    UPDATE flightdeck_pg_edit_leases
    SET released_at = NOW(), updated_at = NOW()
    WHERE id = ${input.leaseId}
      AND workspace_id = ${input.workspaceId}
      AND holder_actor_id = ${input.actorId}
      AND lease_token_hash = ${tokenHash}
      AND released_at IS NULL
    RETURNING id
  `;
  return Boolean(lease);
}

export async function validateFlightDeckPgEditLease(
  input: {
    workspaceId: string;
    entityType: FlightDeckPgEditLeaseEntityType;
    entityId: string;
    actorId: string;
    leaseToken?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<{ ok: true; lease: FlightDeckPgEditLeaseRow } | FlightDeckPgEditLeaseInvalid> {
  const leaseToken = input.leaseToken?.trim() || '';
  if (!leaseToken) return { ok: false, reason: 'lease_missing' };
  const [lease] = await sql<FlightDeckPgEditLeaseRow[]>`
    SELECT *
    FROM flightdeck_pg_edit_leases
    WHERE workspace_id = ${input.workspaceId}
      AND entity_type = ${input.entityType}
      AND entity_id = ${input.entityId}
      AND holder_actor_id = ${input.actorId}
      AND lease_token_hash = ${hashFlightDeckPgEditLeaseToken(leaseToken)}
      AND released_at IS NULL
    ORDER BY expires_at DESC, updated_at DESC
    LIMIT 1
  `;
  if (!lease) return { ok: false, reason: 'lease_invalid' };
  if (lease.expires_at <= new Date()) return { ok: false, reason: 'lease_expired' };
  return { ok: true, lease };
}

export async function listFlightDeckPgWorkspacesForActor(
  input: { actorNpub: string; appNpub?: string | null; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkspaceSummary[]> {
  const actor = await resolveFlightDeckPgActorByNpub(input.actorNpub, sql);
  if (!actor) return [];

  const appFilter = input.appNpub?.trim() || null;
  const rows = await sql<FlightDeckPgWorkspaceSummary[]>`
    SELECT
      w.id,
      w.tower_service_npub,
      w.workspace_service_npub,
      w.workspace_owner_npub,
      w.app_npub,
      w.name,
      w.slug,
      w.description,
      w.avatar_url,
      w.metadata,
      w.v4_workspace_id,
      w.created_by_actor_id,
      w.created_at,
      w.updated_at,
      m.workspace_id AS membership_workspace_id,
      m.actor_id AS membership_actor_id,
      m.role AS membership_role,
      m.created_at AS membership_created_at
    FROM flightdeck_pg_workspace_memberships m
    JOIN flightdeck_pg_workspaces w ON w.id = m.workspace_id
    WHERE m.actor_id = ${actor.id}
      AND (${appFilter}::text IS NULL OR w.app_npub = ${appFilter})
    ORDER BY w.name ASC, w.id ASC
    LIMIT ${input.limit}
  `;

  const summaries: FlightDeckPgWorkspaceSummary[] = rows.map((row: any) => ({
    workspace: {
      id: row.id,
      tower_service_npub: row.tower_service_npub,
      workspace_service_npub: row.workspace_service_npub,
      workspace_owner_npub: row.workspace_owner_npub,
      app_npub: row.app_npub,
      name: row.name,
      slug: row.slug,
      description: row.description,
      avatar_url: row.avatar_url,
      metadata: row.metadata ?? {},
      v4_workspace_id: row.v4_workspace_id,
      created_by_actor_id: row.created_by_actor_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    membership: {
      workspace_id: row.membership_workspace_id,
      actor_id: row.membership_actor_id,
      role: row.membership_role,
      created_at: row.membership_created_at,
    },
  }));

  const visible: FlightDeckPgWorkspaceSummary[] = [];
  for (const summary of summaries) {
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: input.actorNpub,
      appNpub: summary.workspace.app_npub,
      workspaceId: summary.workspace.id,
      permission: 'workspace.read',
      resource: { type: 'workspace' },
    });
    if (decision.allowed) visible.push(summary);
  }
  return visible;
}

export async function resolveFlightDeckPgRequestContext(
  input: { workspaceId: string; actorNpub: string },
  sql: DbClient = getDb(),
): Promise<{
  workspace: FlightDeckPgWorkspace | null;
  actor: FlightDeckPgActor | null;
  membership: FlightDeckPgWorkspaceMembershipView | null;
  groupIds: string[];
}> {
  const workspace = await resolveFlightDeckPgWorkspace(input.workspaceId, sql);
  const actor = await resolveFlightDeckPgActorByNpub(input.actorNpub, sql);
  if (!workspace || !actor) {
    return { workspace, actor, membership: null, groupIds: [] };
  }

  const baseMembership = await getFlightDeckPgWorkspaceMembership(workspace.id, actor.id, sql);
  const [membership] = baseMembership
    ? await sql<FlightDeckPgWorkspaceMembershipView[]>`
      SELECT workspace_id, actor_id, role, created_at
      FROM flightdeck_pg_workspace_memberships
      WHERE workspace_id = ${workspace.id}
        AND actor_id = ${actor.id}
      LIMIT 1
    `
    : [];
  const groupIds = membership ? await getEffectiveFlightDeckPgGroupIds(workspace.id, actor.id, sql) : [];
  return { workspace, actor, membership, groupIds };
}

export async function createFlightDeckPgWorkspaceMember(
  input: {
    workspaceId: string;
    actorNpub: string;
    kind?: FlightDeckPgActorKind;
    displayName?: string | null;
    role?: FlightDeckPgWorkspaceRole;
    createdByActorId: string | null;
  },
  sql: DbClient = getDb(),
) {
  const actor = await resolveOrCreateFlightDeckPgActor(input.actorNpub, input.kind ?? 'human', {
    displayName: input.displayName ?? null,
    sql,
  });
  const role = input.role ?? 'member';
  const [membership] = await sql<FlightDeckPgWorkspaceMembershipView[]>`
    INSERT INTO flightdeck_pg_workspace_memberships (
      workspace_id,
      actor_id,
      role,
      created_by_actor_id
    )
    VALUES (${input.workspaceId}, ${actor.id}, ${role}, ${input.createdByActorId})
    ON CONFLICT (workspace_id, actor_id)
    DO UPDATE SET role = EXCLUDED.role
    RETURNING workspace_id, actor_id, role, created_at
  `;
  await sql`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    SELECT ${input.workspaceId}, g.id, ${actor.id}, ${input.createdByActorId}
    FROM flightdeck_pg_groups g
    WHERE g.workspace_id = ${input.workspaceId}
      AND g.name = 'Workspace'
    ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING
  `;
  if (role === 'owner' || role === 'admin') {
    await sql`
      INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
      SELECT ${input.workspaceId}, g.id, ${actor.id}, ${input.createdByActorId}
      FROM flightdeck_pg_groups g
      WHERE g.workspace_id = ${input.workspaceId}
        AND g.name = 'Admins'
      ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING
    `;
  }
  return { actor, membership };
}

export async function createFlightDeckPgActorProfileOutboxEvent(
  input: {
    workspaceId: string;
    changedActorId: string;
    actorId: string | null;
    displayName: string;
    actorNpub: string;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id, actor_id, event_type, entity_type, entity_id,
      operation, payload
    ) VALUES (
      ${input.workspaceId}, ${input.actorId}, 'actor.profile.updated', 'actor', ${input.changedActorId},
      'updated', ${sql.json(asDbJson({ actor_id: input.changedActorId, actor_npub: input.actorNpub, display_name: input.displayName }))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function getFlightDeckPgPersonalAgentSettings(
  workspaceId: string,
  actorId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPersonalAgentSettings | null> {
  const [settings] = await sql<FlightDeckPgPersonalAgentSettings[]>`
    SELECT workspace_id, actor_id, autopilot_agents, row_version, created_at, updated_at
    FROM flightdeck_pg_personal_agent_settings
    WHERE workspace_id = ${workspaceId}
      AND actor_id = ${actorId}
    LIMIT 1
  `;
  return settings ?? null;
}

export async function updateFlightDeckPgPersonalAgentSettings(
  input: {
    workspaceId: string;
    actorId: string;
    autopilotAgents: Array<{ agent_npub: string; url: string }>;
    expectedRowVersion: number;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPersonalAgentSettings | null> {
  const existing = await getFlightDeckPgPersonalAgentSettings(input.workspaceId, input.actorId, sql);
  if (Number(existing?.row_version || 0) !== input.expectedRowVersion) return null;
  if (existing) {
    const [updated] = await sql<FlightDeckPgPersonalAgentSettings[]>`
      UPDATE flightdeck_pg_personal_agent_settings
      SET autopilot_agents = ${sql.json(asDbJson(input.autopilotAgents))},
          row_version = row_version + 1,
          updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId}
        AND actor_id = ${input.actorId}
        AND row_version = ${input.expectedRowVersion}
      RETURNING workspace_id, actor_id, autopilot_agents, row_version, created_at, updated_at
    `;
    return updated ?? null;
  }
  const [created] = await sql<FlightDeckPgPersonalAgentSettings[]>`
    INSERT INTO flightdeck_pg_personal_agent_settings (
      workspace_id, actor_id, autopilot_agents, row_version
    ) VALUES (
      ${input.workspaceId}, ${input.actorId}, ${sql.json(asDbJson(input.autopilotAgents))}, 1
    )
    ON CONFLICT (workspace_id, actor_id) DO NOTHING
    RETURNING workspace_id, actor_id, autopilot_agents, row_version, created_at, updated_at
  `;
  return created ?? null;
}

export async function createFlightDeckPgPersonalAgentSettingsOutboxEvent(
  input: {
    workspaceId: string;
    actorId: string;
    rowVersion: number;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id, actor_id, event_type, entity_type, entity_id,
      operation, entity_row_version, payload
    ) VALUES (
      ${input.workspaceId}, ${input.actorId}, 'personal_agent_settings.updated',
      'personal_agent_settings', ${input.actorId}, 'updated', ${input.rowVersion},
      ${sql.json(asDbJson({ actor_id: input.actorId, row_version: input.rowVersion }))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function listFlightDeckPgWorkspaceMembers(
  workspaceId: string,
  sql: DbClient = getDb(),
): Promise<Array<{ actor: FlightDeckPgActor; membership: FlightDeckPgWorkspaceMembershipView }>> {
  const rows = await sql<Array<FlightDeckPgActor & {
    membership_workspace_id: string;
    membership_actor_id: string;
    membership_role: FlightDeckPgWorkspaceRole;
    membership_created_at: Date;
  }>>`
    SELECT
      a.id,
      a.npub,
      a.kind,
      a.display_name,
      m.workspace_id AS membership_workspace_id,
      m.actor_id AS membership_actor_id,
      m.role AS membership_role,
      m.created_at AS membership_created_at
    FROM flightdeck_pg_workspace_memberships m
    JOIN flightdeck_pg_actors a ON a.id = m.actor_id
    WHERE m.workspace_id = ${workspaceId}
    ORDER BY a.display_name ASC NULLS LAST, a.npub ASC
  `;
  return rows.map((row) => ({
    actor: {
      id: row.id,
      npub: row.npub,
      kind: row.kind,
      display_name: row.display_name,
    },
    membership: {
      workspace_id: row.membership_workspace_id,
      actor_id: row.membership_actor_id,
      role: row.membership_role,
      created_at: row.membership_created_at,
    },
  }));
}

export async function createFlightDeckPgGroup(
  input: {
    workspaceId: string;
    name: string;
    kind?: FlightDeckPgGroupKind;
    createdByActorId: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgGroupRow> {
  const [group] = await sql<FlightDeckPgGroupRow[]>`
    INSERT INTO flightdeck_pg_groups (
      workspace_id,
      name,
      kind,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.name},
      ${input.kind ?? 'custom'},
      ${input.createdByActorId}
    )
    RETURNING *
  `;
  return group;
}

export async function listFlightDeckPgGroups(
  workspaceId: string,
  sql: DbClient = getDb(),
): Promise<Array<FlightDeckPgGroupRow & {
  members: FlightDeckPgActor[];
  child_group_ids: string[];
  parent_group_ids: string[];
  effective_members: FlightDeckPgActor[];
}>> {
  const groups = await sql<FlightDeckPgGroupRow[]>`
    SELECT *
    FROM flightdeck_pg_groups
    WHERE workspace_id = ${workspaceId}
    ORDER BY name ASC, id ASC
  `;
  const result = [];
  for (const group of groups) {
    const [members, childEdges, parentEdges, effectiveMembers] = await Promise.all([
      listFlightDeckPgGroupMembers(workspaceId, group.id, sql),
      sql<{ child_group_id: string }[]>`
        SELECT child_group_id
        FROM flightdeck_pg_group_edges
        WHERE workspace_id = ${workspaceId}
          AND parent_group_id = ${group.id}
        ORDER BY child_group_id ASC
      `,
      sql<{ parent_group_id: string }[]>`
        SELECT parent_group_id
        FROM flightdeck_pg_group_edges
        WHERE workspace_id = ${workspaceId}
          AND child_group_id = ${group.id}
        ORDER BY parent_group_id ASC
      `,
      listEffectiveFlightDeckPgGroupMembers(workspaceId, group.id, sql),
    ]);
    result.push({
      ...group,
      members,
      child_group_ids: childEdges.map((edge) => edge.child_group_id),
      parent_group_ids: parentEdges.map((edge) => edge.parent_group_id),
      effective_members: effectiveMembers,
    });
  }
  return result;
}

export async function listFlightDeckPgGroupMembers(
  workspaceId: string,
  groupId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgActor[]> {
  return sql<FlightDeckPgActor[]>`
    SELECT a.id, a.npub, a.kind, a.display_name
    FROM flightdeck_pg_group_memberships gm
    JOIN flightdeck_pg_actors a ON a.id = gm.actor_id
    WHERE gm.workspace_id = ${workspaceId}
      AND gm.group_id = ${groupId}
    ORDER BY a.display_name ASC NULLS LAST, a.npub ASC
  `;
}

export async function listEffectiveFlightDeckPgGroupMembers(
  workspaceId: string,
  groupId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgActor[]> {
  return sql<FlightDeckPgActor[]>`
    WITH RECURSIVE descendant_groups(group_id) AS (
      SELECT ${groupId}::uuid
      UNION
      SELECT ge.child_group_id
      FROM flightdeck_pg_group_edges ge
      JOIN descendant_groups dg
        ON dg.group_id = ge.parent_group_id
      WHERE ge.workspace_id = ${workspaceId}
    )
    SELECT DISTINCT a.id, a.npub, a.kind, a.display_name
    FROM descendant_groups dg
    JOIN flightdeck_pg_group_memberships gm
      ON gm.workspace_id = ${workspaceId}
      AND gm.group_id = dg.group_id
    JOIN flightdeck_pg_actors a ON a.id = gm.actor_id
    ORDER BY a.display_name ASC NULLS LAST, a.npub ASC
  `;
}

export async function addFlightDeckPgGroupMember(
  input: {
    workspaceId: string;
    groupId: string;
    actorId: string;
    createdByActorId: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgGroupMemberRow> {
  const [membership] = await sql<FlightDeckPgGroupMemberRow[]>`
    INSERT INTO flightdeck_pg_group_memberships (
      workspace_id,
      group_id,
      actor_id,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.groupId},
      ${input.actorId},
      ${input.createdByActorId}
    )
    ON CONFLICT (workspace_id, group_id, actor_id)
    DO UPDATE SET created_by_actor_id = COALESCE(EXCLUDED.created_by_actor_id, flightdeck_pg_group_memberships.created_by_actor_id)
    RETURNING *
  `;
  return membership;
}

export async function removeFlightDeckPgGroupMember(
  workspaceId: string,
  groupId: string,
  actorId: string,
  sql: DbClient = getDb(),
): Promise<boolean> {
  const rows = await sql<{ actor_id: string }[]>`
    DELETE FROM flightdeck_pg_group_memberships
    WHERE workspace_id = ${workspaceId}
      AND group_id = ${groupId}
      AND actor_id = ${actorId}
    RETURNING actor_id
  `;
  return rows.length > 0;
}

export async function removeFlightDeckPgNestedGroupEdge(
  workspaceId: string,
  parentGroupId: string,
  childGroupId: string,
  sql: DbClient = getDb(),
): Promise<boolean> {
  const rows = await sql<{ child_group_id: string }[]>`
    DELETE FROM flightdeck_pg_group_edges
    WHERE workspace_id = ${workspaceId}
      AND parent_group_id = ${parentGroupId}
      AND child_group_id = ${childGroupId}
    RETURNING child_group_id
  `;
  return rows.length > 0;
}

export async function listVisibleFlightDeckPgScopes(
  input: { workspaceId: string; actorId: string; groupIds: string[]; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgScopeRow[]> {
  const groupIds = input.groupIds.length > 0 ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  return sql<FlightDeckPgScopeRow[]>`
    SELECT DISTINCT s.*
    FROM flightdeck_pg_scopes s
    LEFT JOIN flightdeck_pg_channels c
      ON c.workspace_id = s.workspace_id
      AND c.scope_id = s.id
      AND c.archived_at IS NULL
    LEFT JOIN flightdeck_pg_permission_grants pg
      ON pg.workspace_id = s.workspace_id
      AND pg.revoked_at IS NULL
      AND (
        (
          pg.resource_type = 'scope'
          AND pg.resource_scope_id = s.id
          AND pg.permission = 'scope.read'
        )
        OR (
          pg.resource_type = 'channel'
          AND pg.resource_channel_id = c.id
          AND pg.permission = 'channel.read'
        )
      )
      AND (
        (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
        OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
      )
    WHERE s.workspace_id = ${input.workspaceId}
      AND s.archived_at IS NULL
      AND pg.id IS NOT NULL
    ORDER BY s.name ASC, s.id ASC
    LIMIT ${input.limit}
  `;
}

export async function listVisibleFlightDeckPgChannels(
  input: { workspaceId: string; scopeId: string; actorId: string; groupIds: string[]; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgChannelRow[]> {
  const groupIds = input.groupIds.length > 0 ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  return sql<FlightDeckPgChannelRow[]>`
    SELECT DISTINCT c.*
    FROM flightdeck_pg_channels c
    JOIN flightdeck_pg_permission_grants pg
      ON pg.workspace_id = c.workspace_id
      AND pg.resource_type = 'channel'
      AND pg.resource_channel_id = c.id
      AND pg.permission = 'channel.read'
      AND pg.revoked_at IS NULL
      AND (
        (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
        OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
      )
    WHERE c.workspace_id = ${input.workspaceId}
      AND c.scope_id = ${input.scopeId}
      AND c.archived_at IS NULL
    ORDER BY c.position ASC NULLS LAST, c.created_at ASC, c.id ASC
    LIMIT ${input.limit}
  `;
}

export async function searchVisibleFlightDeckPgRecords(
  input: {
    workspaceId: string;
    actorId: string;
    groupIds: string[];
    query: string;
    scopeId?: string | null;
    mode: FlightDeckPgSearchMode;
    limit: number;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgSearchResult[]> {
  const groupIds = input.groupIds.length > 0 ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  const query = input.query.trim();
  const pattern = `%${query}%`;
  const prefix = `${query}%`;
  const scopeId = input.scopeId || null;
  const mode = input.mode;
  return sql<FlightDeckPgSearchResult[]>`
    WITH RECURSIVE subtree_groups(group_id) AS (
      SELECT owner_group_id
      FROM flightdeck_pg_scopes
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${scopeId}
        AND archived_at IS NULL
        AND owner_group_id IS NOT NULL
      UNION
      SELECT ge.child_group_id
      FROM flightdeck_pg_group_edges ge
      JOIN subtree_groups sg ON sg.group_id = ge.parent_group_id
      WHERE ge.workspace_id = ${input.workspaceId}
    ), subtree_scopes(scope_id) AS (
      SELECT s.id
      FROM flightdeck_pg_scopes s
      WHERE s.workspace_id = ${input.workspaceId}
        AND s.archived_at IS NULL
        AND (
          s.id = ${scopeId}
          OR (s.owner_group_id IS NOT NULL AND s.owner_group_id IN (SELECT group_id FROM subtree_groups))
        )
    ), readable_channels AS (
      SELECT c.id, c.scope_id, c.name,
        bool_or(pg.permission = 'channel.read') AS can_read_channel,
        bool_or(pg.permission = 'task.read') AS can_read_task,
        bool_or(pg.permission = 'doc.read') AS can_read_doc,
        bool_or(pg.permission = 'file.read') AS can_read_file
      FROM flightdeck_pg_channels c
      JOIN flightdeck_pg_scopes s ON s.workspace_id = c.workspace_id AND s.id = c.scope_id AND s.archived_at IS NULL
      JOIN flightdeck_pg_permission_grants pg
        ON pg.workspace_id = c.workspace_id
        AND pg.resource_type = 'channel'
        AND pg.resource_channel_id = c.id
        AND pg.permission IN ('channel.read', 'task.read', 'doc.read', 'file.read')
        AND pg.revoked_at IS NULL
        AND (
          (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
          OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
        )
      WHERE c.workspace_id = ${input.workspaceId}
        AND c.archived_at IS NULL
        AND (
          ${mode} = 'workspace'
          OR (${mode} = 'subtree' AND c.scope_id IN (SELECT scope_id FROM subtree_scopes))
          OR (${mode} = 'outside_subtree' AND c.scope_id NOT IN (SELECT scope_id FROM subtree_scopes))
        )
      GROUP BY c.id, c.scope_id, c.name
    ), candidates AS (
      SELECT d.id, 'document'::text AS record_type, d.title, COALESCE(d.summary, d.title) AS snippet,
        d.scope_id, rc.name AS channel_name, d.channel_id, d.updated_at,
        jsonb_build_object('action', 'open-doc', 'record_id', d.id, 'doc_type', 'document') AS navigation_target
      FROM flightdeck_pg_docs d JOIN readable_channels rc ON rc.id = d.channel_id AND rc.can_read_doc
      WHERE d.deleted_at IS NULL AND d.archived_at IS NULL AND (d.title ILIKE ${pattern} OR COALESCE(d.summary, '') ILIKE ${pattern})
      UNION ALL
      SELECT t.id, 'task', t.title, COALESCE(t.description, t.title), t.scope_id, rc.name, t.channel_id, t.updated_at,
        jsonb_build_object('action', 'open-task', 'record_id', t.id)
      FROM flightdeck_pg_tasks t JOIN readable_channels rc ON rc.id = t.channel_id AND rc.can_read_task
      WHERE t.deleted_at IS NULL AND t.state NOT IN ('archive', 'archived') AND (t.title ILIKE ${pattern} OR COALESCE(t.description, '') ILIKE ${pattern})
      UNION ALL
      SELECT tc.id, 'task_comment', COALESCE(NULLIF(t.title, ''), 'Task comment'), tc.body, tc.scope_id, rc.name, tc.channel_id, tc.updated_at,
        jsonb_build_object('action', 'open-task', 'record_id', tc.task_id, 'comment_id', tc.id)
      FROM flightdeck_pg_task_comments tc JOIN readable_channels rc ON rc.id = tc.channel_id AND rc.can_read_task
      JOIN flightdeck_pg_tasks t ON t.workspace_id = tc.workspace_id AND t.id = tc.task_id AND t.deleted_at IS NULL AND t.state NOT IN ('archive', 'archived')
      WHERE tc.deleted_at IS NULL AND tc.body ILIKE ${pattern}
      UNION ALL
      SELECT m.id, 'message', COALESCE(NULLIF(th.title, ''), NULLIF(left(m.body, 100), ''), 'Chat message'), m.body,
        m.scope_id, rc.name, m.channel_id, m.updated_at,
        jsonb_build_object('action', CASE WHEN m.thread_id IS NULL THEN 'open-channel' ELSE 'open-thread' END, 'record_id', m.id, 'channel_id', m.channel_id, 'thread_id', m.thread_id)
      FROM flightdeck_pg_messages m JOIN readable_channels rc ON rc.id = m.channel_id AND rc.can_read_channel
      LEFT JOIN flightdeck_pg_threads th ON th.workspace_id = m.workspace_id AND th.id = m.thread_id AND th.deleted_at IS NULL AND th.archived_at IS NULL
      WHERE m.deleted_at IS NULL AND (m.body ILIKE ${pattern} OR COALESCE(th.title, '') ILIKE ${pattern}) AND (m.thread_id IS NULL OR th.id IS NOT NULL)
      UNION ALL
      SELECT dc.id, 'doc_comment', COALESCE(NULLIF(d.title, ''), 'Document comment'), dc.body, dc.scope_id, rc.name, dc.channel_id, dc.updated_at,
        jsonb_build_object('action', 'open-doc', 'record_id', dc.doc_id, 'doc_type', 'document', 'comment_id', dc.id)
      FROM flightdeck_pg_doc_comments dc JOIN readable_channels rc ON rc.id = dc.channel_id AND rc.can_read_doc
      JOIN flightdeck_pg_docs d ON d.workspace_id = dc.workspace_id AND d.id = dc.doc_id AND d.deleted_at IS NULL AND d.archived_at IS NULL
      WHERE dc.deleted_at IS NULL AND dc.body ILIKE ${pattern}
      UNION ALL
      SELECT f.id, 'file', COALESCE(NULLIF(f.display_name, ''), 'Untitled file'), COALESCE(f.description, f.display_name, ''), f.scope_id, rc.name, f.channel_id, f.updated_at,
        jsonb_build_object('action', 'open-file', 'record_id', f.id)
      FROM flightdeck_pg_files f JOIN readable_channels rc ON rc.id = f.channel_id AND rc.can_read_file
      WHERE f.deleted_at IS NULL AND f.archived_at IS NULL AND (COALESCE(f.display_name, '') ILIKE ${pattern} OR COALESCE(f.description, '') ILIKE ${pattern} OR f.metadata::text ILIKE ${pattern})
      UNION ALL
      SELECT a.id, 'approval', COALESCE(NULLIF(a.title, ''), 'Approval'), COALESCE(a.summary, a.decision_note, a.title, ''), a.scope_id, rc.name, a.channel_id, a.updated_at,
        jsonb_build_object('action', CASE WHEN a.target_type = 'workroom' THEN 'open-workroom' ELSE 'open-approval' END, 'record_id', CASE WHEN a.target_type = 'workroom' THEN a.target_id ELSE a.id END, 'approval_id', a.id)
      FROM flightdeck_pg_approvals a JOIN readable_channels rc ON rc.id = a.channel_id AND rc.can_read_channel
      WHERE a.status NOT IN ('superseded', 'cancelled') AND (COALESCE(a.title, '') ILIKE ${pattern} OR COALESCE(a.summary, '') ILIKE ${pattern} OR COALESCE(a.decision_note, '') ILIKE ${pattern})
    )
    SELECT c.*, s.name AS scope_name,
      CASE
        WHEN lower(c.title) = lower(${query}) THEN 500
        WHEN c.title ILIKE ${prefix} THEN 400
        WHEN c.title ~* ('(^|[^[:alnum:]_])' || regexp_replace(${query}, '([\\.\\+\\*\\?\\[\\^\\]\\$\\(\\)\\{\\}=!<>|:\\-])', '\\\\1', 'g') || '([^[:alnum:]_]|$)') THEN 300
        WHEN c.title ILIKE ${pattern} THEN 200
        ELSE 100
      END AS relevance
    FROM candidates c
    LEFT JOIN flightdeck_pg_scopes s ON s.workspace_id = ${input.workspaceId} AND s.id = c.scope_id
    ORDER BY relevance DESC, c.updated_at DESC, c.id ASC
    LIMIT ${input.limit}
  `;
}

export async function createFlightDeckPgScope(
  input: {
    workspaceId: string;
    name: string;
    description?: string | null;
    kind: FlightDeckPgScopeKind;
    ownerActorId?: string | null;
    ownerGroupId?: string | null;
    createdByActorId: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgScopeRow> {
  const [scope] = await sql<FlightDeckPgScopeRow[]>`
    INSERT INTO flightdeck_pg_scopes (
      workspace_id,
      name,
      description,
      kind,
      owner_actor_id,
      owner_group_id,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.name},
      ${input.description ?? null},
      ${input.kind},
      ${input.ownerActorId ?? null},
      ${input.ownerGroupId ?? null},
      ${input.createdByActorId}
    )
    RETURNING *
  `;
  return scope;
}

export async function archiveFlightDeckPgScope(
  input: { workspaceId: string; scopeId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgScopeRow | null> {
  const [scope] = await sql<FlightDeckPgScopeRow[]>`
    UPDATE flightdeck_pg_scopes
    SET archived_at = NOW(),
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.scopeId}
      AND archived_at IS NULL
    RETURNING *
  `;
  if (!scope) return null;
  await sql`
    UPDATE flightdeck_pg_channels
    SET archived_at = COALESCE(archived_at, NOW()),
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND scope_id = ${input.scopeId}
      AND archived_at IS NULL
  `;
  return scope;
}

export async function updateFlightDeckPgScope(
  input: {
    workspaceId: string;
    scopeId: string;
    patch: {
      name?: string;
      description?: string | null;
    };
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgScopeRow | null> {
  const [scope] = await sql<FlightDeckPgScopeRow[]>`
    UPDATE flightdeck_pg_scopes
    SET name = CASE
          WHEN ${input.patch.name !== undefined} THEN ${input.patch.name ?? ''}
          ELSE name
        END,
        description = CASE
          WHEN ${input.patch.description !== undefined} THEN ${input.patch.description ?? null}
          ELSE description
        END,
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.scopeId}
      AND archived_at IS NULL
    RETURNING *
  `;
  return scope ?? null;
}

export async function createFlightDeckPgChannel(
  input: {
    workspaceId: string;
    scopeId: string;
    name: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
    kind: FlightDeckPgChannelKind;
    participantNpubs?: string[] | null;
    createdByActorId: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgChannelRow> {
  await sql`
    SELECT id
    FROM flightdeck_pg_scopes
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.scopeId}
      AND archived_at IS NULL
    FOR UPDATE
  `;
  const existing = await sql<FlightDeckPgChannelRow[]>`
    SELECT *
    FROM flightdeck_pg_channels
    WHERE workspace_id = ${input.workspaceId}
      AND scope_id = ${input.scopeId}
      AND archived_at IS NULL
    ORDER BY position ASC NULLS LAST, created_at ASC, id ASC
  `;
  for (const [index, channel] of existing.entries()) {
    const position = index + 1;
    if (Number(channel.position) === position) continue;
    await sql`
      UPDATE flightdeck_pg_channels
      SET position = ${position}
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${channel.id}
    `;
  }
  const [channel] = await sql<FlightDeckPgChannelRow[]>`
    INSERT INTO flightdeck_pg_channels (
      workspace_id,
      scope_id,
      name,
      description,
      metadata,
      kind,
      position,
      participant_npubs,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.name},
      ${input.description ?? null},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.kind},
      ${existing.length + 1},
      ${input.participantNpubs?.length ? input.participantNpubs : null},
      ${input.createdByActorId}
    )
    RETURNING *
  `;
  return channel;
}

export async function reorderFlightDeckPgChannel(
  input: { workspaceId: string; channelId: string; position: number },
  sql: DbClient = getDb(),
): Promise<{
  channel: FlightDeckPgChannelRow;
  channels: FlightDeckPgChannelRow[];
  previousPosition: number;
  position: number;
  changed: boolean;
} | null> {
  const [target] = await sql<FlightDeckPgChannelRow[]>`
    SELECT *
    FROM flightdeck_pg_channels
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.channelId}
      AND archived_at IS NULL
    LIMIT 1
  `;
  if (!target) return null;

  await sql`
    SELECT id
    FROM flightdeck_pg_scopes
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${target.scope_id}
      AND archived_at IS NULL
    FOR UPDATE
  `;
  const siblings = await sql<FlightDeckPgChannelRow[]>`
    SELECT *
    FROM flightdeck_pg_channels
    WHERE workspace_id = ${input.workspaceId}
      AND scope_id = ${target.scope_id}
      AND archived_at IS NULL
    ORDER BY position ASC NULLS LAST, created_at ASC, id ASC
  `;
  const previousIndex = siblings.findIndex((channel) => channel.id === input.channelId);
  if (previousIndex < 0) return null;
  const nextPosition = Math.min(Math.max(1, Math.trunc(input.position)), siblings.length);
  const ordered = [...siblings];
  const [moved] = ordered.splice(previousIndex, 1);
  ordered.splice(nextPosition - 1, 0, moved);
  const neededNormalization = ordered.some((channel, index) => Number(channel.position) !== index + 1);
  const changed = previousIndex !== nextPosition - 1 || neededNormalization;

  if (changed) {
    for (const [index, channel] of ordered.entries()) {
      const position = index + 1;
      if (Number(channel.position) === position) continue;
      await sql`
        UPDATE flightdeck_pg_channels
        SET position = ${position},
            updated_at = NOW()
        WHERE workspace_id = ${input.workspaceId}
          AND id = ${channel.id}
      `;
    }
  }

  const channels = await sql<FlightDeckPgChannelRow[]>`
    SELECT *
    FROM flightdeck_pg_channels
    WHERE workspace_id = ${input.workspaceId}
      AND scope_id = ${target.scope_id}
      AND archived_at IS NULL
    ORDER BY position ASC, created_at ASC, id ASC
  `;
  const channel = channels.find((candidate) => candidate.id === input.channelId);
  if (!channel) return null;
  return {
    channel,
    channels,
    previousPosition: previousIndex + 1,
    position: nextPosition,
    changed,
  };
}

export async function updateFlightDeckPgChannel(
  input: {
    workspaceId: string;
    channelId: string;
    patch: {
      name?: string;
      description?: string | null;
      metadata?: Record<string, unknown>;
    };
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgChannelRow | null> {
  const [channel] = await sql<FlightDeckPgChannelRow[]>`
    UPDATE flightdeck_pg_channels
    SET name = CASE
          WHEN ${input.patch.name !== undefined} THEN ${input.patch.name ?? ''}
          ELSE name
        END,
        description = CASE
          WHEN ${input.patch.description !== undefined} THEN ${input.patch.description ?? null}
          ELSE description
        END,
        metadata = COALESCE(${input.patch.metadata === undefined ? null : sql.json(asDbJson(input.patch.metadata))}, metadata),
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.channelId}
      AND archived_at IS NULL
    RETURNING *
  `;
  return channel ?? null;
}

export async function archiveFlightDeckPgChannel(
  input: { workspaceId: string; channelId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgChannelRow | null> {
  const [channel] = await sql<FlightDeckPgChannelRow[]>`
    UPDATE flightdeck_pg_channels
    SET archived_at = NOW(),
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.channelId}
      AND archived_at IS NULL
    RETURNING *
  `;
  return channel ?? null;
}

export async function resolveFlightDeckPgChannel(
  workspaceId: string,
  channelId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgChannelRow | null> {
  const [channel] = await sql<FlightDeckPgChannelRow[]>`
    SELECT *
    FROM flightdeck_pg_channels
    WHERE workspace_id = ${workspaceId}
      AND id = ${channelId}
      AND archived_at IS NULL
    LIMIT 1
  `;
  return channel ?? null;
}

export function isFlightDeckPgChannelPermission(permission: string): permission is FlightDeckPgPermission {
  return channelAnchoredPermissions.has(permission as FlightDeckPgPermission);
}

export async function listFlightDeckPgChannelGrants(
  workspaceId: string,
  channelId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPermissionGrantRow[]> {
  return sql<FlightDeckPgPermissionGrantRow[]>`
    SELECT
      pg.*,
      c.scope_id AS channel_scope_id,
      actor.npub AS principal_actor_npub,
      actor.display_name AS principal_actor_display_name,
      actor.kind AS principal_actor_kind,
      grp.name AS principal_group_name,
      grp.kind AS principal_group_kind
    FROM flightdeck_pg_permission_grants pg
    JOIN flightdeck_pg_channels c
      ON c.workspace_id = pg.workspace_id
      AND c.id = pg.resource_channel_id
    LEFT JOIN flightdeck_pg_actors actor
      ON actor.id = pg.principal_actor_id
    LEFT JOIN flightdeck_pg_groups grp
      ON grp.workspace_id = pg.workspace_id
      AND grp.id = pg.principal_group_id
    WHERE pg.workspace_id = ${workspaceId}
      AND pg.resource_type = 'channel'
      AND pg.resource_channel_id = ${channelId}
      AND pg.revoked_at IS NULL
    ORDER BY pg.created_at ASC, pg.id ASC
  `;
}

export async function resolveFlightDeckPgChannelGrant(
  workspaceId: string,
  channelId: string,
  grantId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPermissionGrantRow | null> {
  const [grant] = await sql<FlightDeckPgPermissionGrantRow[]>`
    SELECT
      pg.*,
      c.scope_id AS channel_scope_id,
      actor.npub AS principal_actor_npub,
      actor.display_name AS principal_actor_display_name,
      actor.kind AS principal_actor_kind,
      grp.name AS principal_group_name,
      grp.kind AS principal_group_kind
    FROM flightdeck_pg_permission_grants pg
    JOIN flightdeck_pg_channels c
      ON c.workspace_id = pg.workspace_id
      AND c.id = pg.resource_channel_id
    LEFT JOIN flightdeck_pg_actors actor
      ON actor.id = pg.principal_actor_id
    LEFT JOIN flightdeck_pg_groups grp
      ON grp.workspace_id = pg.workspace_id
      AND grp.id = pg.principal_group_id
    WHERE pg.workspace_id = ${workspaceId}
      AND pg.resource_type = 'channel'
      AND pg.resource_channel_id = ${channelId}
      AND pg.id = ${grantId}
      AND pg.revoked_at IS NULL
    LIMIT 1
  `;
  return grant ?? null;
}

export async function createFlightDeckPgChannelGrants(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    principalType: FlightDeckPgPrincipalType;
    principalId: string;
    permissions: FlightDeckPgPermission[];
    createdByActorId: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPermissionGrantRow[]> {
  const rows: FlightDeckPgPermissionGrantRow[] = [];
  for (const permission of input.permissions) {
    const [grant] = await sql<FlightDeckPgPermissionGrantRow[]>`
      INSERT INTO flightdeck_pg_permission_grants (
        workspace_id,
        principal_type,
        principal_actor_id,
        principal_group_id,
        resource_type,
        resource_channel_id,
        permission,
        created_by_actor_id
      )
      VALUES (
        ${input.workspaceId},
        ${input.principalType},
        ${input.principalType === 'actor' ? input.principalId : null},
        ${input.principalType === 'group' ? input.principalId : null},
        'channel',
        ${input.channel.id},
        ${permission},
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
      RETURNING
        *,
        ${input.channel.scope_id}::uuid AS channel_scope_id,
        (
          SELECT a.npub
          FROM flightdeck_pg_actors a
          WHERE a.id = flightdeck_pg_permission_grants.principal_actor_id
        ) AS principal_actor_npub,
        (
          SELECT a.display_name
          FROM flightdeck_pg_actors a
          WHERE a.id = flightdeck_pg_permission_grants.principal_actor_id
        ) AS principal_actor_display_name,
        (
          SELECT a.kind
          FROM flightdeck_pg_actors a
          WHERE a.id = flightdeck_pg_permission_grants.principal_actor_id
        ) AS principal_actor_kind,
        (
          SELECT g.name
          FROM flightdeck_pg_groups g
          WHERE g.workspace_id = flightdeck_pg_permission_grants.workspace_id
            AND g.id = flightdeck_pg_permission_grants.principal_group_id
        ) AS principal_group_name,
        (
          SELECT g.kind
          FROM flightdeck_pg_groups g
          WHERE g.workspace_id = flightdeck_pg_permission_grants.workspace_id
            AND g.id = flightdeck_pg_permission_grants.principal_group_id
        ) AS principal_group_kind
    `;
    rows.push(grant);
  }
  return rows;
}

export async function replaceFlightDeckPgChannelGrantBundle(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    principalType: FlightDeckPgPrincipalType;
    principalId: string;
    permissions: FlightDeckPgPermission[];
    createdByActorId: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPermissionGrantRow[]> {
  await sql`
    UPDATE flightdeck_pg_permission_grants
    SET revoked_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND resource_type = 'channel'
      AND resource_channel_id = ${input.channel.id}
      AND revoked_at IS NULL
      AND (
        (${input.principalType} = 'actor' AND principal_type = 'actor' AND principal_actor_id = ${input.principalId})
        OR (${input.principalType} = 'group' AND principal_type = 'group' AND principal_group_id = ${input.principalId})
      )
  `;
  return createFlightDeckPgChannelGrants(input, sql);
}

export async function revokeFlightDeckPgChannelGrantBundle(
  input: {
    workspaceId: string;
    channelId: string;
    principalType: FlightDeckPgPrincipalType;
    principalId: string;
  },
  sql: DbClient = getDb(),
): Promise<number> {
  const revoked = await sql<{ id: string }[]>`
    UPDATE flightdeck_pg_permission_grants
    SET revoked_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND resource_type = 'channel'
      AND resource_channel_id = ${input.channelId}
      AND revoked_at IS NULL
      AND (
        (${input.principalType} = 'actor' AND principal_type = 'actor' AND principal_actor_id = ${input.principalId})
        OR (${input.principalType} = 'group' AND principal_type = 'group' AND principal_group_id = ${input.principalId})
      )
    RETURNING id
  `;
  return revoked.length;
}

export async function listFlightDeckPgChannelThreads(
  input: { workspaceId: string; channelId: string; limit: number; includeArchived?: boolean },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgThreadRow[]> {
  return sql<FlightDeckPgThreadRow[]>`
    SELECT
      t.*,
      source.body AS source_message_body,
      creator.npub AS created_by_actor_npub
    FROM flightdeck_pg_threads t
    LEFT JOIN flightdeck_pg_messages source ON source.workspace_id = t.workspace_id AND source.id = t.source_message_id AND source.deleted_at IS NULL
    LEFT JOIN flightdeck_pg_actors creator ON creator.id = t.created_by_actor_id
    WHERE t.workspace_id = ${input.workspaceId}
      AND t.channel_id = ${input.channelId}
      AND t.deleted_at IS NULL
      AND (${input.includeArchived === true} OR t.archived_at IS NULL)
    ORDER BY t.updated_at DESC, t.id ASC
    LIMIT ${input.limit}
  `;
}

export async function listFlightDeckPgChannelMessages(
  input: { workspaceId: string; channelId: string; threadId?: string | null; limit: number; afterCreatedAt?: string | Date | null; afterId?: string | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgMessageRow[]> {
  return sql<FlightDeckPgMessageRow[]>`
    SELECT
      m.*,
      m.created_at::text AS cursor_created_at,
      t.source_message_id AS thread_source_message_id,
      creator.npub AS created_by_actor_npub,
      creator.display_name AS created_by_actor_label
    FROM flightdeck_pg_messages m
    LEFT JOIN flightdeck_pg_threads t ON t.id = m.thread_id
    LEFT JOIN flightdeck_pg_actors creator ON creator.id = m.created_by_actor_id
    WHERE m.workspace_id = ${input.workspaceId}
      AND m.channel_id = ${input.channelId}
      AND (${input.threadId ?? null}::uuid IS NULL OR m.thread_id = ${input.threadId ?? null})
      AND (
        ${input.afterCreatedAt ?? null}::timestamptz IS NULL
        OR (date_trunc('milliseconds', m.created_at), m.id) > (date_trunc('milliseconds', ${input.afterCreatedAt ?? null}::timestamptz), ${input.afterId ?? null}::uuid)
      )
      AND m.deleted_at IS NULL
    ORDER BY date_trunc('milliseconds', m.created_at) ASC, m.id ASC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgThread(
  workspaceId: string,
  threadId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgThreadRow | null> {
  const [thread] = await sql<FlightDeckPgThreadRow[]>`
    SELECT t.*, source.body AS source_message_body
    FROM flightdeck_pg_threads t
    LEFT JOIN flightdeck_pg_messages source ON source.workspace_id = t.workspace_id AND source.id = t.source_message_id AND source.deleted_at IS NULL
    WHERE t.workspace_id = ${workspaceId}
      AND t.id = ${threadId}
      AND t.deleted_at IS NULL
    LIMIT 1
  `;
  return thread ?? null;
}

export async function resolveFlightDeckPgMessage(
  workspaceId: string,
  messageId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgMessageRow | null> {
  const [message] = await sql<FlightDeckPgMessageRow[]>`
    SELECT *
    FROM flightdeck_pg_messages
    WHERE workspace_id = ${workspaceId}
      AND id = ${messageId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return message ?? null;
}

export async function resolveFlightDeckPgMessageByClientRequestId(
  input: { workspaceId: string; actorId: string; clientRequestId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgMessageRow | null> {
  const [message] = await sql<FlightDeckPgMessageRow[]>`
    SELECT m.*, creator.npub AS created_by_actor_npub, creator.display_name AS created_by_actor_label
    FROM flightdeck_pg_messages m
    LEFT JOIN flightdeck_pg_actors creator ON creator.id = m.created_by_actor_id
    WHERE m.workspace_id = ${input.workspaceId}
      AND m.created_by_actor_id = ${input.actorId}
      AND m.client_request_id = ${input.clientRequestId}
    LIMIT 1
  `;
  return message ?? null;
}

export async function lockFlightDeckPgMessageIdempotencyKey(
  input: { workspaceId: string; actorId: string; clientRequestId: string },
  sql: DbClient = getDb(),
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.actorId}:${input.clientRequestId}`}, 0))`;
}

export async function createFlightDeckPgThread(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    title: string;
    sourceMessageId?: string | null;
    latest?: string | null;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgThreadRow> {
  const [thread] = await sql<FlightDeckPgThreadRow[]>`
    INSERT INTO flightdeck_pg_threads (
      workspace_id,
      scope_id,
      channel_id,
      source_message_id,
      title,
      latest,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.channel.scope_id},
      ${input.channel.id},
      ${input.sourceMessageId ?? null},
      ${input.title},
      ${input.latest ?? null},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  return thread;
}

export async function createFlightDeckPgMessage(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    body: string;
    threadId?: string | null;
    metadata?: Record<string, unknown>;
    actorId: string;
    clientRequestId?: string | null;
    clientRequestHash?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgMessageRow> {
  const [message] = await sql<FlightDeckPgMessageRow[]>`
    INSERT INTO flightdeck_pg_messages (
      workspace_id,
      scope_id,
      channel_id,
      thread_id,
      body,
      client_request_id,
      client_request_hash,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.channel.scope_id},
      ${input.channel.id},
      ${input.threadId ?? null},
      ${input.body},
      ${input.clientRequestId ?? null},
      ${input.clientRequestHash ?? null},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  return message;
}

export async function touchFlightDeckPgThreadAfterMessage(
  input: { workspaceId: string; threadId: string; latest: string; actorId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgThreadRow | null> {
  const [thread] = await sql<FlightDeckPgThreadRow[]>`
    UPDATE flightdeck_pg_threads
    SET
      latest = ${input.latest},
      archived_at = NULL,
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.threadId}
      AND deleted_at IS NULL
    RETURNING *
  `;
  return thread ?? null;
}

export async function deleteFlightDeckPgMessage(
  input: { workspaceId: string; messageId: string; actorId: string; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgMessageRow | null> {
  const [message] = await sql<FlightDeckPgMessageRow[]>`
    UPDATE flightdeck_pg_messages
    SET
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.messageId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return message ?? null;
}

export async function updateFlightDeckPgMessage(
  input: {
    workspaceId: string;
    messageId: string;
    body: string;
    metadata: Record<string, unknown>;
    actorId: string;
    rowVersion: number;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgMessageRow | null> {
  const [message] = await sql<FlightDeckPgMessageRow[]>`
    UPDATE flightdeck_pg_messages
    SET
      body = ${input.body},
      metadata = ${sql.json(asDbJson(input.metadata))},
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.messageId}
      AND created_by_actor_id = ${input.actorId}
      AND row_version = ${input.rowVersion}
      AND deleted_at IS NULL
    RETURNING *
  `;
  return message ?? null;
}

export async function attachFlightDeckPgThreadSourceMessage(
  input: { workspaceId: string; threadId: string; sourceMessageId: string; latest?: string | null; actorId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgThreadRow | null> {
  const [thread] = await sql<FlightDeckPgThreadRow[]>`
    UPDATE flightdeck_pg_threads
    SET
      source_message_id = ${input.sourceMessageId},
      latest = COALESCE(${input.latest ?? null}, latest),
      archived_at = NULL,
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.threadId}
      AND deleted_at IS NULL
    RETURNING *
  `;
  return thread ?? null;
}

export async function setFlightDeckPgThreadArchived(
  input: { workspaceId: string; threadId: string; archived: boolean; actorId: string; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgThreadRow | null> {
  const [thread] = await sql<FlightDeckPgThreadRow[]>`
    UPDATE flightdeck_pg_threads
    SET
      archived_at = CASE WHEN ${input.archived} THEN COALESCE(archived_at, NOW()) ELSE NULL END,
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.threadId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return thread ?? null;
}

export async function updateFlightDeckPgThreadTitle(
  input: { workspaceId: string; threadId: string; title: string; actorId: string; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgThreadRow | null> {
  const [thread] = await sql<FlightDeckPgThreadRow[]>`
    UPDATE flightdeck_pg_threads
    SET
      title = ${input.title},
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.threadId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return thread ?? null;
}

export async function isFlightDeckPgThreadParticipant(
  input: { workspaceId: string; threadId: string; actorId: string; actorNpub: string },
  sql: DbClient = getDb(),
): Promise<boolean> {
  const [participant] = await sql<{ ok: boolean }[]>`
    SELECT true AS ok
    FROM flightdeck_pg_messages m
    WHERE m.workspace_id = ${input.workspaceId}
      AND m.thread_id = ${input.threadId}
      AND m.deleted_at IS NULL
      AND (
        m.created_by_actor_id = ${input.actorId}
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.metadata->'mentions') = 'array' THEN m.metadata->'mentions' ELSE '[]'::jsonb END) mention
          WHERE mention->>'npub' = ${input.actorNpub}
             OR mention->>'actor_id' = ${input.actorId}
        )
      )
    LIMIT 1
  `;
  return Boolean(participant?.ok);
}

export async function deleteFlightDeckPgThread(
  input: { workspaceId: string; threadId: string; actorId: string; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgThreadRow | null> {
  const [thread] = await sql<FlightDeckPgThreadRow[]>`
    UPDATE flightdeck_pg_threads
    SET
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.threadId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  if (!thread) return null;

  await sql`
    UPDATE flightdeck_pg_messages
    SET
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND thread_id = ${input.threadId}
      AND deleted_at IS NULL
  `;

  return thread;
}

export async function listFlightDeckPgChannelDocs(
  input: { workspaceId: string; channelId: string; limit: number; archived?: boolean },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocRow[]> {
  return sql<FlightDeckPgDocRow[]>`
    SELECT *
    FROM flightdeck_pg_docs
    WHERE workspace_id = ${input.workspaceId}
      AND channel_id = ${input.channelId}
      AND deleted_at IS NULL
      AND (${input.archived === true} = (archived_at IS NOT NULL))
    ORDER BY updated_at DESC, id ASC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgDoc(
  workspaceId: string,
  docId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocRow | null> {
  const [doc] = await sql<FlightDeckPgDocRow[]>`
    SELECT *
    FROM flightdeck_pg_docs
    WHERE workspace_id = ${workspaceId}
      AND id = ${docId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return doc ?? null;
}

export async function resolveFlightDeckPgDocVersionIdentity(
  input: { workspaceId: string; docId: string; lock?: boolean },
  sql: DbClient = getDb(),
): Promise<{ doc: FlightDeckPgDocRow; identity: FlightDeckPgDocVersionIdentityRow } | null> {
  const rows = await sql<FlightDeckPgDocHeadRow[]>`
    SELECT
      d.*,
      body.sha256_hex AS body_sha256_hex,
      body.size_bytes AS body_size_bytes
    FROM flightdeck_pg_docs d
    JOIN v4_storage_objects body ON body.id = d.storage_object_id
    WHERE d.workspace_id = ${input.workspaceId}
      AND d.id = ${input.docId}
      AND d.deleted_at IS NULL
    LIMIT 1
    ${input.lock ? sql`FOR UPDATE OF d` : sql``}
  `;
  const head = rows[0];
  if (!head) return null;
  return {
    doc: head,
    identity: {
      version_id: flightDeckPgCanonicalDocVersionId(head.id, head.row_version),
      row_version: head.row_version,
      storage_object_id: head.storage_object_id,
      body_sha256_hex: head.body_sha256_hex,
      size_bytes: head.body_size_bytes === null ? null : Number(head.body_size_bytes),
    },
  };
}

function flightDeckPgDocRecoveryIdempotencyKey(input: {
  docId: string;
  storageObjectId: string;
  baseAvailable: boolean;
  baseRowVersion: number | null;
  baseVersionId: string | null;
  baseBodySha256Hex: string | null;
  submittedPatch: Record<string, unknown>;
}) {
  return createHash('sha256').update(JSON.stringify({
    contract: 'flightdeck_pg_doc_recovery_v1',
    doc_id: input.docId,
    storage_object_id: input.storageObjectId,
    base_available: input.baseAvailable,
    base_row_version: input.baseRowVersion,
    base_version_id: input.baseVersionId,
    base_body_sha256_hex: input.baseBodySha256Hex,
    submitted_patch: input.submittedPatch,
  })).digest('hex');
}

export type FlightDeckPgDocBodySaveDecision =
  | {
      outcome: 'canonical';
      head: FlightDeckPgDocRow;
      headIdentity: FlightDeckPgDocVersionIdentityRow;
      submittedIdentity: Omit<FlightDeckPgDocVersionIdentityRow, 'version_id' | 'row_version'>;
    }
  | {
      outcome: 'recovery';
      head: FlightDeckPgDocRow;
      headIdentity: FlightDeckPgDocVersionIdentityRow;
      submittedIdentity: Omit<FlightDeckPgDocVersionIdentityRow, 'version_id' | 'row_version'>;
      recovery: FlightDeckPgDocRecoveryVersionRow;
      created: boolean;
    };

export async function decideFlightDeckPgDocBodySave(
  input: {
    workspaceId: string;
    docId: string;
    storageObjectId: string;
    actorId: string;
    signerNpub: string;
    baseAvailable: boolean;
    baseRowVersion: number | null;
    baseVersionId: string | null;
    baseBodySha256Hex: string | null;
    submittedPatch: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocBodySaveDecision | null> {
  const resolved = await resolveFlightDeckPgDocVersionIdentity({ workspaceId: input.workspaceId, docId: input.docId, lock: true }, sql);
  if (!resolved) return null;

  const [submittedObject] = await sql<V4StorageObject[]>`
    SELECT *
    FROM v4_storage_objects
    WHERE id = ${input.storageObjectId}
    LIMIT 1
  `;
  if (!submittedObject) throw new Error('submitted document body storage object was not found');
  if (!submittedObject.completed_at) throw new Error('submitted document body storage object upload is not completed');
  if (!submittedObject.sha256_hex) throw new Error('submitted document body storage object has no sha256 identity');

  const submittedIdentity = {
    storage_object_id: submittedObject.id,
    body_sha256_hex: submittedObject.sha256_hex,
    size_bytes: Number(submittedObject.size_bytes),
  };
  const expectedVersionId = flightDeckPgCanonicalDocVersionId(resolved.doc.id, resolved.doc.row_version);
  let reason: FlightDeckPgDocRecoveryReason | null = null;
  if (!input.baseAvailable) reason = 'base_unavailable';
  else if (input.baseRowVersion !== resolved.doc.row_version) reason = 'stale_base';
  else if (input.baseVersionId && input.baseVersionId !== expectedVersionId) reason = 'base_version_mismatch';
  else if (!resolved.identity.body_sha256_hex) reason = 'head_body_unverifiable';
  else if (input.baseBodySha256Hex !== resolved.identity.body_sha256_hex) reason = 'base_body_mismatch';

  if (!reason) {
    return {
      outcome: 'canonical',
      head: resolved.doc,
      headIdentity: resolved.identity,
      submittedIdentity,
    };
  }

  const idempotencyKey = flightDeckPgDocRecoveryIdempotencyKey({
    docId: input.docId,
    storageObjectId: input.storageObjectId,
    baseAvailable: input.baseAvailable,
    baseRowVersion: input.baseRowVersion,
    baseVersionId: input.baseVersionId,
    baseBodySha256Hex: input.baseBodySha256Hex,
    submittedPatch: input.submittedPatch,
  });
  const [existing] = await sql<FlightDeckPgDocRecoveryVersionRow[]>`
    SELECT *
    FROM flightdeck_pg_doc_recovery_versions
    WHERE workspace_id = ${input.workspaceId}
      AND doc_id = ${input.docId}
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  if (existing) {
    return { outcome: 'recovery', head: resolved.doc, headIdentity: resolved.identity, submittedIdentity, recovery: existing, created: false };
  }

  const [recovery] = await sql<FlightDeckPgDocRecoveryVersionRow[]>`
    INSERT INTO flightdeck_pg_doc_recovery_versions (
      workspace_id,
      doc_id,
      scope_id,
      channel_id,
      storage_object_id,
      reason_code,
      base_row_version,
      base_version_id,
      base_body_sha256_hex,
      head_row_version,
      head_version_id,
      head_storage_object_id,
      head_body_sha256_hex,
      submitted_body_sha256_hex,
      submitted_patch,
      idempotency_key,
      created_by_actor_id,
      created_by_signer_npub
    ) VALUES (
      ${input.workspaceId},
      ${input.docId},
      ${resolved.doc.scope_id},
      ${resolved.doc.channel_id},
      ${input.storageObjectId},
      ${reason},
      ${input.baseAvailable ? input.baseRowVersion : null},
      ${input.baseAvailable ? input.baseVersionId : null},
      ${input.baseAvailable ? input.baseBodySha256Hex : null},
      ${resolved.doc.row_version},
      ${expectedVersionId},
      ${resolved.doc.storage_object_id},
      ${resolved.identity.body_sha256_hex},
      ${submittedObject.sha256_hex},
      ${sql.json(asDbJson(input.submittedPatch))},
      ${idempotencyKey},
      ${input.actorId},
      ${input.signerNpub}
    )
    RETURNING *
  `;
  return { outcome: 'recovery', head: resolved.doc, headIdentity: resolved.identity, submittedIdentity, recovery, created: true };
}

export async function listFlightDeckPgDocRecoveryVersions(
  input: { workspaceId: string; docId: string; limit: number; state?: 'open' | 'promoted' | 'discarded' | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocRecoveryVersionRow[]> {
  return sql<FlightDeckPgDocRecoveryVersionRow[]>`
    SELECT *
    FROM flightdeck_pg_doc_recovery_versions
    WHERE workspace_id = ${input.workspaceId}
      AND doc_id = ${input.docId}
      AND (${input.state ?? null}::text IS NULL OR resolution_state = ${input.state ?? null})
    ORDER BY created_at DESC, id DESC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgDocRecoveryVersion(
  input: { workspaceId: string; docId: string; recoveryId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocRecoveryVersionRow | null> {
  const [recovery] = await sql<FlightDeckPgDocRecoveryVersionRow[]>`
    SELECT *
    FROM flightdeck_pg_doc_recovery_versions
    WHERE workspace_id = ${input.workspaceId}
      AND doc_id = ${input.docId}
      AND id = ${input.recoveryId}
    LIMIT 1
  `;
  return recovery ?? null;
}

export type FlightDeckPgDocRecoveryPromotionResult =
  | { outcome: 'promoted'; doc: FlightDeckPgDocRow; recovery: FlightDeckPgDocRecoveryVersionRow; priorHead: FlightDeckPgDocRow; priorHeadIdentity: FlightDeckPgDocVersionIdentityRow }
  | { outcome: 'head_conflict'; recovery: FlightDeckPgDocRecoveryVersionRow; head: FlightDeckPgDocRow; headIdentity: FlightDeckPgDocVersionIdentityRow }
  | { outcome: 'resolved'; recovery: FlightDeckPgDocRecoveryVersionRow; head: FlightDeckPgDocRow; headIdentity: FlightDeckPgDocVersionIdentityRow };

export async function promoteFlightDeckPgDocRecoveryVersion(
  input: {
    workspaceId: string;
    docId: string;
    recoveryId: string;
    actorId: string;
    signerNpub: string;
    expectedHeadRowVersion: number;
    expectedHeadVersionId?: string | null;
    expectedHeadBodySha256Hex: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocRecoveryPromotionResult | null> {
  const resolved = await resolveFlightDeckPgDocVersionIdentity({ workspaceId: input.workspaceId, docId: input.docId, lock: true }, sql);
  if (!resolved) return null;
  const [recovery] = await sql<FlightDeckPgDocRecoveryVersionRow[]>`
    SELECT *
    FROM flightdeck_pg_doc_recovery_versions
    WHERE workspace_id = ${input.workspaceId}
      AND doc_id = ${input.docId}
      AND id = ${input.recoveryId}
    LIMIT 1
    FOR UPDATE
  `;
  if (!recovery) return null;
  if (recovery.resolution_state !== 'open') {
    return { outcome: 'resolved', recovery, head: resolved.doc, headIdentity: resolved.identity };
  }
  const expectedVersionId = flightDeckPgCanonicalDocVersionId(resolved.doc.id, resolved.doc.row_version);
  if (
    input.expectedHeadRowVersion !== resolved.doc.row_version
    || (input.expectedHeadVersionId && input.expectedHeadVersionId !== expectedVersionId)
    || input.expectedHeadBodySha256Hex !== resolved.identity.body_sha256_hex
  ) {
    return { outcome: 'head_conflict', recovery, head: resolved.doc, headIdentity: resolved.identity };
  }

  const patch = recovery.submitted_patch ?? {};
  const [doc] = await sql<FlightDeckPgDocRow[]>`
    UPDATE flightdeck_pg_docs
    SET
      storage_object_id = ${recovery.storage_object_id},
      title = CASE WHEN ${typeof patch.title === 'string'} THEN ${typeof patch.title === 'string' ? patch.title : ''} ELSE title END,
      summary = CASE WHEN ${Object.prototype.hasOwnProperty.call(patch, 'summary')} THEN ${patch.summary === null ? null : (typeof patch.summary === 'string' ? patch.summary : null)} ELSE summary END,
      metadata = CASE WHEN ${Boolean(patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata))} THEN ${patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata) ? sql.json(asDbJson(patch.metadata as Record<string, unknown>)) : sql.json({})} ELSE metadata END,
      archived_at = CASE WHEN ${typeof patch.archived === 'boolean'} THEN CASE WHEN ${patch.archived === true} THEN COALESCE(archived_at, NOW()) ELSE NULL END ELSE archived_at END,
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.docId}
      AND row_version = ${resolved.doc.row_version}
      AND deleted_at IS NULL
    RETURNING *
  `;
  if (!doc) return { outcome: 'head_conflict', recovery, head: resolved.doc, headIdentity: resolved.identity };
  const [promoted] = await sql<FlightDeckPgDocRecoveryVersionRow[]>`
    UPDATE flightdeck_pg_doc_recovery_versions
    SET
      resolution_state = 'promoted',
      resolved_by_actor_id = ${input.actorId},
      resolved_by_signer_npub = ${input.signerNpub},
      resolved_at = NOW(),
      resolution_head_row_version = ${doc.row_version},
      resolution_metadata = ${sql.json({ promoted_storage_object_id: recovery.storage_object_id })},
      updated_at = NOW()
    WHERE id = ${recovery.id}
      AND resolution_state = 'open'
    RETURNING *
  `;
  return { outcome: 'promoted', doc, recovery: promoted, priorHead: resolved.doc, priorHeadIdentity: resolved.identity };
}

export async function discardFlightDeckPgDocRecoveryVersion(
  input: { workspaceId: string; docId: string; recoveryId: string; actorId: string; signerNpub: string },
  sql: DbClient = getDb(),
): Promise<{ recovery: FlightDeckPgDocRecoveryVersionRow; changed: boolean } | null> {
  const [recovery] = await sql<FlightDeckPgDocRecoveryVersionRow[]>`
    SELECT *
    FROM flightdeck_pg_doc_recovery_versions
    WHERE workspace_id = ${input.workspaceId}
      AND doc_id = ${input.docId}
      AND id = ${input.recoveryId}
    LIMIT 1
    FOR UPDATE
  `;
  if (!recovery) return null;
  if (recovery.resolution_state !== 'open') return { recovery, changed: false };
  const [discarded] = await sql<FlightDeckPgDocRecoveryVersionRow[]>`
    UPDATE flightdeck_pg_doc_recovery_versions
    SET
      resolution_state = 'discarded',
      resolved_by_actor_id = ${input.actorId},
      resolved_by_signer_npub = ${input.signerNpub},
      resolved_at = NOW(),
      resolution_metadata = ${sql.json({ discarded: true })},
      updated_at = NOW()
    WHERE id = ${recovery.id}
      AND resolution_state = 'open'
    RETURNING *
  `;
  return { recovery: discarded, changed: true };
}

export async function createFlightDeckPgDoc(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    storageObjectId: string;
    title: string;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocRow> {
  const [doc] = await sql<FlightDeckPgDocRow[]>`
    INSERT INTO flightdeck_pg_docs (
      workspace_id,
      scope_id,
      channel_id,
      storage_object_id,
      title,
      summary,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.channel.scope_id},
      ${input.channel.id},
      ${input.storageObjectId},
      ${input.title},
      ${input.summary ?? null},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  return doc;
}

export async function snapshotFlightDeckPgDocVersion(
  input: {
    doc: FlightDeckPgDocRow;
    actorId: string;
    operation: 'created' | 'updated' | 'deleted';
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocVersionRow> {
  const [version] = await sql<FlightDeckPgDocVersionRow[]>`
    INSERT INTO flightdeck_pg_doc_versions (
      workspace_id,
      doc_id,
      row_version,
      scope_id,
      channel_id,
      storage_object_id,
      title,
      summary,
      metadata,
      operation,
      actor_id,
      created_at,
      updated_at
    )
    VALUES (
      ${input.doc.workspace_id},
      ${input.doc.id},
      ${input.doc.row_version},
      ${input.doc.scope_id},
      ${input.doc.channel_id},
      ${input.doc.storage_object_id},
      ${input.doc.title},
      ${input.doc.summary},
      ${sql.json(asDbJson(input.doc.metadata ?? {}))},
      ${input.operation},
      ${input.actorId},
      ${input.doc.created_at},
      ${input.doc.updated_at}
    )
    ON CONFLICT (workspace_id, doc_id, row_version) DO NOTHING
    RETURNING *
  `;
  if (version) return version;
  const [existing] = await sql<FlightDeckPgDocVersionRow[]>`
    SELECT *
    FROM flightdeck_pg_doc_versions
    WHERE workspace_id = ${input.doc.workspace_id}
      AND doc_id = ${input.doc.id}
      AND row_version = ${input.doc.row_version}
    LIMIT 1
  `;
  return existing;
}

export async function listFlightDeckPgDocVersions(
  input: { workspaceId: string; docId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocVersionRow[]> {
  const versions = await sql<FlightDeckPgDocVersionRow[]>`
    SELECT
      v.*,
      actor.npub AS actor_npub
    FROM flightdeck_pg_doc_versions v
    LEFT JOIN flightdeck_pg_actors actor ON actor.id = v.actor_id
    WHERE v.workspace_id = ${input.workspaceId}
      AND v.doc_id = ${input.docId}
    ORDER BY v.row_version DESC
    LIMIT ${input.limit}
  `;
  if (versions.length > 0) return versions;

  const doc = await resolveFlightDeckPgDoc(input.workspaceId, input.docId, sql);
  if (!doc) return [];
  return [{
    workspace_id: doc.workspace_id,
    doc_id: doc.id,
    row_version: doc.row_version,
    scope_id: doc.scope_id,
    channel_id: doc.channel_id,
    storage_object_id: doc.storage_object_id,
    title: doc.title,
    summary: doc.summary,
    metadata: doc.metadata,
    operation: doc.deleted_at ? 'deleted' : 'updated',
    actor_id: doc.updated_by_actor_id,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  }];
}

export async function updateFlightDeckPgDoc(
  input: {
    workspaceId: string;
    docId: string;
    actorId: string;
    rowVersion?: number | null;
    patch: {
      title?: string;
      scopeId?: string;
      channelId?: string;
      storageObjectId?: string;
      summary?: string | null;
      metadata?: Record<string, unknown>;
      archived?: boolean;
    };
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocRow | null> {
  const [doc] = await sql<FlightDeckPgDocRow[]>`
    UPDATE flightdeck_pg_docs
    SET
      title = COALESCE(${input.patch.title ?? null}, title),
      scope_id = COALESCE(${input.patch.scopeId ?? null}, scope_id),
      channel_id = COALESCE(${input.patch.channelId ?? null}, channel_id),
      storage_object_id = COALESCE(${input.patch.storageObjectId ?? null}, storage_object_id),
      summary = CASE
        WHEN ${input.patch.summary !== undefined} THEN ${input.patch.summary ?? null}
        ELSE summary
      END,
      metadata = COALESCE(${input.patch.metadata === undefined ? null : sql.json(asDbJson(input.patch.metadata))}, metadata),
      archived_at = CASE WHEN ${input.patch.archived ?? null}::boolean IS NULL THEN archived_at WHEN ${input.patch.archived ?? false} THEN COALESCE(archived_at, NOW()) ELSE NULL END,
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.docId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return doc ?? null;
}

export async function moveFlightDeckPgDoc(
  input: {
    workspaceId: string;
    docId: string;
    destinationChannel: FlightDeckPgChannelRow;
    actorId: string;
    rowVersion?: number | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocRow | null> {
  const [doc] = await sql<FlightDeckPgDocRow[]>`
    WITH moved_doc AS (
      UPDATE flightdeck_pg_docs
      SET
        scope_id = ${input.destinationChannel.scope_id},
        channel_id = ${input.destinationChannel.id},
        updated_by_actor_id = ${input.actorId},
        row_version = row_version + 1,
        updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.docId}
        AND deleted_at IS NULL
        AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
      RETURNING *
    ), moved_comments AS (
      UPDATE flightdeck_pg_doc_comments comments
      SET scope_id = moved_doc.scope_id, channel_id = moved_doc.channel_id
      FROM moved_doc
      WHERE comments.workspace_id = moved_doc.workspace_id AND comments.doc_id = moved_doc.id
      RETURNING comments.id
    ), moved_links AS (
      UPDATE flightdeck_pg_storage_links links
      SET scope_id = moved_doc.scope_id, channel_id = moved_doc.channel_id
      FROM moved_doc
      WHERE links.workspace_id = moved_doc.workspace_id
        AND links.entity_type = 'doc'
        AND links.entity_id = moved_doc.id
        AND links.deleted_at IS NULL
      RETURNING links.id
    ), moved_recoveries AS (
      UPDATE flightdeck_pg_doc_recovery_versions recoveries
      SET scope_id = moved_doc.scope_id, channel_id = moved_doc.channel_id, updated_at = NOW()
      FROM moved_doc
      WHERE recoveries.workspace_id = moved_doc.workspace_id
        AND recoveries.doc_id = moved_doc.id
      RETURNING recoveries.id
    ), moved_reactions AS (
      UPDATE flightdeck_pg_reactions reactions
      SET scope_id = moved_doc.scope_id, channel_id = moved_doc.channel_id
      FROM moved_doc
      WHERE reactions.workspace_id = moved_doc.workspace_id
        AND reactions.deleted_at IS NULL
        AND (
          (reactions.target_type = 'doc' AND reactions.target_id = moved_doc.id)
          OR (reactions.target_type = 'doc_comment' AND reactions.target_id IN (SELECT id FROM moved_comments))
        )
      RETURNING reactions.id
    ), moved_activities AS (
      UPDATE flightdeck_pg_response_activities activities
      SET scope_id = moved_doc.scope_id, channel_id = moved_doc.channel_id
      FROM moved_doc
      WHERE activities.workspace_id = moved_doc.workspace_id AND activities.doc_id = moved_doc.id
      RETURNING activities.id
    ), moved_view_states AS (
      UPDATE flightdeck_pg_resource_view_states states
      SET
        scope_id = moved_doc.scope_id,
        channel_id = moved_doc.channel_id,
        row_version = states.row_version + 1,
        updated_at = NOW()
      FROM moved_doc
      WHERE states.workspace_id = moved_doc.workspace_id
        AND states.resource_type = 'document'
        AND states.resource_id = moved_doc.id
      RETURNING states.resource_id
    )
    SELECT * FROM moved_doc
  `;
  return doc ?? null;
}

export async function deleteFlightDeckPgDoc(
  input: { workspaceId: string; docId: string; actorId: string; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocRow | null> {
  const [doc] = await sql<FlightDeckPgDocRow[]>`
    UPDATE flightdeck_pg_docs
    SET
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.docId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return doc ?? null;
}

export async function listFlightDeckPgChannelFiles(
  input: { workspaceId: string; channelId: string; limit: number; archived?: boolean },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileRow[]> {
  return sql<FlightDeckPgFileRow[]>`
    SELECT *
    FROM flightdeck_pg_files
    WHERE workspace_id = ${input.workspaceId}
      AND channel_id = ${input.channelId}
      AND deleted_at IS NULL
      AND (${input.archived === true} = (archived_at IS NOT NULL))
    ORDER BY updated_at DESC, id ASC
    LIMIT ${input.limit}
  `;
}

export async function listFlightDeckPgChannelFileFolders(
  input: { workspaceId: string; channelId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileFolderRow[]> {
  return sql<FlightDeckPgFileFolderRow[]>`
    SELECT *
    FROM flightdeck_pg_file_folders
    WHERE workspace_id = ${input.workspaceId}
      AND channel_id = ${input.channelId}
      AND deleted_at IS NULL
    ORDER BY parent_folder_id ASC NULLS FIRST, title ASC, updated_at DESC
    LIMIT ${input.limit}
  `;
}

export async function listFlightDeckPgDriveTree(
  input: {
    workspaceId: string;
    actorId: string;
    groupIds: string[];
    scopeId?: string | null;
    channelId?: string | null;
    parentFolderId?: string | null;
    parentFolderIdSpecified?: boolean;
    afterSortKey?: string | null;
    limit: number;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDriveTreeItemRow[]> {
  const groupIds = input.groupIds.length > 0 ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  const parentFolderIdSpecified = input.parentFolderIdSpecified ?? false;
  return sql<FlightDeckPgDriveTreeItemRow[]>`
    WITH drive_items AS (
      SELECT
        'folder'::text AS type,
        f.id::text AS id,
        f.workspace_id::text AS workspace_id,
        f.scope_id::text AS scope_id,
        f.channel_id::text AS channel_id,
        f.parent_folder_id::text AS parent_folder_id,
        f.title AS name,
        NULL::text AS storage_object_id,
        NULL::text AS current_version_id,
        f.row_version,
        f.updated_at,
        'folder:' || f.id::text AS sort_key
      FROM flightdeck_pg_file_folders f
      WHERE f.workspace_id = ${input.workspaceId}
        AND f.deleted_at IS NULL
        AND (${input.scopeId ?? null}::uuid IS NULL OR f.scope_id = ${input.scopeId ?? null})
        AND (${input.channelId ?? null}::uuid IS NULL OR f.channel_id = ${input.channelId ?? null})
        AND (
          ${parentFolderIdSpecified} = false
          OR f.parent_folder_id IS NOT DISTINCT FROM ${input.parentFolderId ?? null}::uuid
        )
        AND EXISTS (
          SELECT 1
          FROM flightdeck_pg_permission_grants pg
          WHERE pg.workspace_id = f.workspace_id
            AND pg.resource_type = 'channel'
            AND pg.resource_channel_id = f.channel_id
            AND pg.permission IN ('file.read', 'channel.read')
            AND pg.revoked_at IS NULL
            AND (
              (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
              OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
            )
        )
      UNION ALL
      SELECT
        'file'::text AS type,
        f.id::text AS id,
        f.workspace_id::text AS workspace_id,
        f.scope_id::text AS scope_id,
        f.channel_id::text AS channel_id,
        f.folder_id::text AS parent_folder_id,
        f.display_name AS name,
        f.storage_object_id::text AS storage_object_id,
        f.current_version_id::text AS current_version_id,
        f.row_version,
        f.updated_at,
        'file:' || f.id::text AS sort_key
      FROM flightdeck_pg_files f
      WHERE f.workspace_id = ${input.workspaceId}
        AND f.deleted_at IS NULL
        AND (${input.scopeId ?? null}::uuid IS NULL OR f.scope_id = ${input.scopeId ?? null})
        AND (${input.channelId ?? null}::uuid IS NULL OR f.channel_id = ${input.channelId ?? null})
        AND (
          ${parentFolderIdSpecified} = false
          OR f.folder_id IS NOT DISTINCT FROM ${input.parentFolderId ?? null}::uuid
        )
        AND EXISTS (
          SELECT 1
          FROM flightdeck_pg_permission_grants pg
          WHERE pg.workspace_id = f.workspace_id
            AND pg.resource_type = 'channel'
            AND pg.resource_channel_id = f.channel_id
            AND pg.permission IN ('file.read', 'channel.read')
            AND pg.revoked_at IS NULL
            AND (
              (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
              OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
            )
        )
    )
    SELECT *
    FROM drive_items
    WHERE (${input.afterSortKey ?? null}::text IS NULL OR sort_key > ${input.afterSortKey ?? null})
    ORDER BY sort_key ASC
    LIMIT ${input.limit}
  `;
}

export async function listVisibleFlightDeckPgDriveEvents(
  input: {
    workspaceId: string;
    actorId: string;
    groupIds: string[];
    afterRowVersion: number;
    limit: number;
    scopeId?: string | null;
    channelId?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgOutboxEventRow[]> {
  const groupIds = input.groupIds.length > 0 ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  return sql<FlightDeckPgOutboxEventRow[]>`
    SELECT e.*, actor.npub AS actor_npub
    FROM flightdeck_pg_outbox_events e
    LEFT JOIN flightdeck_pg_actors actor ON actor.id = e.actor_id
    WHERE e.workspace_id = ${input.workspaceId}
      AND e.row_version > ${input.afterRowVersion}
      AND e.entity_type IN ('file', 'file_folder')
      AND (${input.scopeId ?? null}::uuid IS NULL OR e.scope_id = ${input.scopeId ?? null})
      AND (${input.channelId ?? null}::uuid IS NULL OR e.channel_id = ${input.channelId ?? null})
      AND e.channel_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM flightdeck_pg_permission_grants pg
        WHERE pg.workspace_id = e.workspace_id
          AND pg.resource_type = 'channel'
          AND pg.resource_channel_id = e.channel_id
          AND pg.permission IN ('file.read', 'channel.read')
          AND pg.revoked_at IS NULL
          AND (
            (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
            OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
          )
      )
    ORDER BY e.row_version ASC, e.created_at ASC, e.id ASC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgFileFolder(
  workspaceId: string,
  folderId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileFolderRow | null> {
  const [folder] = await sql<FlightDeckPgFileFolderRow[]>`
    SELECT *
    FROM flightdeck_pg_file_folders
    WHERE workspace_id = ${workspaceId}
      AND id = ${folderId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return folder ?? null;
}

export async function createFlightDeckPgFileFolder(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    title: string;
    parentFolderId?: string | null;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileFolderRow> {
  const [folder] = await sql<FlightDeckPgFileFolderRow[]>`
    INSERT INTO flightdeck_pg_file_folders (
      workspace_id,
      scope_id,
      channel_id,
      parent_folder_id,
      title,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.channel.scope_id},
      ${input.channel.id},
      ${input.parentFolderId ?? null},
      ${input.title},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  return folder;
}

export async function updateFlightDeckPgFileFolder(
  input: {
    workspaceId: string;
    folderId: string;
    actorId: string;
    rowVersion?: number | null;
    patch: {
      title?: string;
      parentFolderId?: string | null;
      metadata?: Record<string, unknown>;
    };
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileFolderRow | null> {
  const [folder] = await sql<FlightDeckPgFileFolderRow[]>`
    UPDATE flightdeck_pg_file_folders
    SET
      title = CASE
        WHEN ${input.patch.title !== undefined} THEN ${input.patch.title ?? ''}
        ELSE title
      END,
      parent_folder_id = CASE
        WHEN ${input.patch.parentFolderId !== undefined} THEN ${input.patch.parentFolderId ?? null}
        ELSE parent_folder_id
      END,
      metadata = COALESCE(${input.patch.metadata === undefined ? null : sql.json(asDbJson(input.patch.metadata))}, metadata),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.folderId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return folder ?? null;
}

export type DeleteFlightDeckPgFileFolderResult =
  | { status: 'not_found' }
  | { status: 'stale'; folder: FlightDeckPgFileFolderRow }
  | { status: 'not_empty'; folder: FlightDeckPgFileFolderRow; activeFileCount: number; activeFolderCount: number }
  | { status: 'deleted'; folder: FlightDeckPgFileFolderRow };

export async function deleteFlightDeckPgFileFolder(
  input: { workspaceId: string; folderId: string; actorId: string; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<DeleteFlightDeckPgFileFolderResult> {
  const [lockedFolder] = await sql<FlightDeckPgFileFolderRow[]>`
    SELECT *
    FROM flightdeck_pg_file_folders
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.folderId}
      AND deleted_at IS NULL
    FOR UPDATE
    LIMIT 1
  `;
  if (!lockedFolder) return { status: 'not_found' };
  if (input.rowVersion && lockedFolder.row_version !== input.rowVersion) return { status: 'stale', folder: lockedFolder };

  const [children] = await sql<{ file_count: string; folder_count: string }[]>`
    SELECT
      (SELECT COUNT(*)::text FROM flightdeck_pg_files f
       WHERE f.workspace_id = ${input.workspaceId}
         AND f.folder_id = ${input.folderId}
         AND f.deleted_at IS NULL) AS file_count,
      (SELECT COUNT(*)::text FROM flightdeck_pg_file_folders ff
       WHERE ff.workspace_id = ${input.workspaceId}
         AND ff.parent_folder_id = ${input.folderId}
         AND ff.deleted_at IS NULL) AS folder_count
  `;
  const activeFileCount = Number(children?.file_count ?? 0);
  const activeFolderCount = Number(children?.folder_count ?? 0);
  if (activeFileCount > 0 || activeFolderCount > 0) {
    return { status: 'not_empty', folder: lockedFolder, activeFileCount, activeFolderCount };
  }

  const [folder] = await sql<FlightDeckPgFileFolderRow[]>`
    UPDATE flightdeck_pg_file_folders
    SET
      deleted_at = NOW(),
      deleted_by_actor_id = ${input.actorId},
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.folderId}
      AND deleted_at IS NULL
    RETURNING *
  `;
  return folder ? { status: 'deleted', folder } : { status: 'not_found' };
}

export async function resolveFlightDeckPgFile(
  workspaceId: string,
  fileId: string,
  sql: DbClient = getDb(),
  options: { includeDeleted?: boolean } = {},
): Promise<FlightDeckPgFileRow | null> {
  const [file] = await sql<FlightDeckPgFileRow[]>`
    SELECT *
    FROM flightdeck_pg_files
    WHERE workspace_id = ${workspaceId}
      AND id = ${fileId}
      AND (${options.includeDeleted === true} OR deleted_at IS NULL)
    LIMIT 1
  `;
  return file ?? null;
}

export async function listFlightDeckPgFileVersions(
  input: { workspaceId: string; fileId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileVersionListRow[]> {
  return sql<FlightDeckPgFileVersionListRow[]>`
    SELECT
      v.*,
      actor.npub AS created_by_actor_npub,
      storage.size_bytes,
      storage.content_type,
      storage.sha256_hex
    FROM flightdeck_pg_file_versions v
    JOIN v4_storage_objects storage
      ON storage.id = v.storage_object_id
    LEFT JOIN flightdeck_pg_actors actor
      ON actor.id = v.created_by_actor_id
    WHERE v.workspace_id = ${input.workspaceId}
      AND v.file_id = ${input.fileId}
    ORDER BY v.version_number DESC, v.id DESC
    LIMIT ${input.limit}
  `;
}

export async function createFlightDeckPgFile(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    storageObjectId: string;
    folderId?: string | null;
    displayName?: string | null;
    description?: string | null;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileRow> {
  const [file] = await sql<FlightDeckPgFileRow[]>`
    INSERT INTO flightdeck_pg_files (
      workspace_id,
      scope_id,
      channel_id,
      folder_id,
      storage_object_id,
      display_name,
      description,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.channel.scope_id},
      ${input.channel.id},
      ${input.folderId ?? null},
      ${input.storageObjectId},
      ${input.displayName ?? null},
      ${input.description ?? null},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  const [version] = await sql<FlightDeckPgFileVersionRow[]>`
    INSERT INTO flightdeck_pg_file_versions (
      workspace_id,
      file_id,
      version_number,
      storage_object_id,
      base_version_id,
      operation,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${file.id},
      1,
      ${input.storageObjectId},
      NULL,
      'created',
      ${input.actorId}
    )
    RETURNING *
  `;
  const [versionedFile] = await sql<FlightDeckPgFileRow[]>`
    UPDATE flightdeck_pg_files
    SET current_version_id = ${version.id}
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${file.id}
    RETURNING *
  `;
  return versionedFile;
}

export async function resolveFlightDeckPgFileVersion(
  input: { workspaceId: string; versionId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileVersionRow | null> {
  const [version] = await sql<FlightDeckPgFileVersionRow[]>`
    SELECT *
    FROM flightdeck_pg_file_versions
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.versionId}
    LIMIT 1
  `;
  return version ?? null;
}

export type ReplaceFlightDeckPgFileContentResult =
  | { status: 'not_found' }
  | { status: 'stale'; file: FlightDeckPgFileRow; currentVersion: FlightDeckPgFileVersionRow | null }
  | { status: 'replaced'; file: FlightDeckPgFileRow; version: FlightDeckPgFileVersionRow };

export async function replaceFlightDeckPgFileContent(
  input: {
    workspaceId: string;
    fileId: string;
    actorId: string;
    baseVersionId: string;
    storageObjectId: string;
  },
  sql: DbClient = getDb(),
): Promise<ReplaceFlightDeckPgFileContentResult> {
  const [lockedFile] = await sql<FlightDeckPgFileRow[]>`
    SELECT *
    FROM flightdeck_pg_files
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.fileId}
      AND deleted_at IS NULL
    FOR UPDATE
    LIMIT 1
  `;
  if (!lockedFile) return { status: 'not_found' };

  if (lockedFile.current_version_id !== input.baseVersionId) {
    const currentVersion = lockedFile.current_version_id
      ? await resolveFlightDeckPgFileVersion({ workspaceId: input.workspaceId, versionId: lockedFile.current_version_id }, sql)
      : null;
    return { status: 'stale', file: lockedFile, currentVersion };
  }

  const [version] = await sql<FlightDeckPgFileVersionRow[]>`
    INSERT INTO flightdeck_pg_file_versions (
      workspace_id,
      file_id,
      version_number,
      storage_object_id,
      base_version_id,
      operation,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.fileId},
      (
        SELECT COALESCE(MAX(version_number), 0) + 1
        FROM flightdeck_pg_file_versions
        WHERE workspace_id = ${input.workspaceId}
          AND file_id = ${input.fileId}
      ),
      ${input.storageObjectId},
      ${input.baseVersionId},
      'replaced',
      ${input.actorId}
    )
    RETURNING *
  `;

  const [file] = await sql<FlightDeckPgFileRow[]>`
    UPDATE flightdeck_pg_files
    SET
      storage_object_id = ${input.storageObjectId},
      current_version_id = ${version.id},
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.fileId}
      AND deleted_at IS NULL
    RETURNING *
  `;

  return { status: 'replaced', file, version };
}

export type DeleteFlightDeckPgFileResult =
  | { status: 'not_found' }
  | { status: 'stale'; file: FlightDeckPgFileRow; currentVersion: FlightDeckPgFileVersionRow | null }
  | { status: 'deleted'; file: FlightDeckPgFileRow; version: FlightDeckPgFileVersionRow };

export async function deleteFlightDeckPgFile(
  input: { workspaceId: string; fileId: string; actorId: string; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<DeleteFlightDeckPgFileResult> {
  const [lockedFile] = await sql<FlightDeckPgFileRow[]>`
    SELECT *
    FROM flightdeck_pg_files
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.fileId}
      AND deleted_at IS NULL
    FOR UPDATE
    LIMIT 1
  `;
  if (!lockedFile) return { status: 'not_found' };
  if (input.rowVersion && lockedFile.row_version !== input.rowVersion) {
    const currentVersion = lockedFile.current_version_id
      ? await resolveFlightDeckPgFileVersion({ workspaceId: input.workspaceId, versionId: lockedFile.current_version_id }, sql)
      : null;
    return { status: 'stale', file: lockedFile, currentVersion };
  }

  const [version] = await sql<FlightDeckPgFileVersionRow[]>`
    INSERT INTO flightdeck_pg_file_versions (
      workspace_id,
      file_id,
      version_number,
      storage_object_id,
      base_version_id,
      operation,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.fileId},
      (
        SELECT COALESCE(MAX(version_number), 0) + 1
        FROM flightdeck_pg_file_versions
        WHERE workspace_id = ${input.workspaceId}
          AND file_id = ${input.fileId}
      ),
      ${lockedFile.storage_object_id},
      ${lockedFile.current_version_id ?? null},
      'deleted',
      ${input.actorId}
    )
    RETURNING *
  `;

  const [file] = await sql<FlightDeckPgFileRow[]>`
    UPDATE flightdeck_pg_files
    SET
      current_version_id = ${version.id},
      deleted_at = NOW(),
      deleted_by_actor_id = ${input.actorId},
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.fileId}
      AND deleted_at IS NULL
    RETURNING *
  `;

  return file ? { status: 'deleted', file, version } : { status: 'not_found' };
}

export async function updateFlightDeckPgFile(
  input: {
    workspaceId: string;
    fileId: string;
    actorId: string;
    rowVersion?: number | null;
    patch: {
      scopeId?: string;
      channelId?: string;
      folderId?: string | null;
      displayName?: string | null;
      description?: string | null;
      metadata?: Record<string, unknown>;
      archived?: boolean;
    };
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgFileRow | null> {
  const [file] = await sql<FlightDeckPgFileRow[]>`
    UPDATE flightdeck_pg_files
    SET
      scope_id = COALESCE(${input.patch.scopeId ?? null}, scope_id),
      channel_id = COALESCE(${input.patch.channelId ?? null}, channel_id),
      folder_id = CASE
        WHEN ${input.patch.folderId !== undefined} THEN ${input.patch.folderId ?? null}
        ELSE folder_id
      END,
      display_name = CASE
        WHEN ${input.patch.displayName !== undefined} THEN ${input.patch.displayName ?? null}
        ELSE display_name
      END,
      description = CASE
        WHEN ${input.patch.description !== undefined} THEN ${input.patch.description ?? null}
        ELSE description
      END,
      metadata = COALESCE(${input.patch.metadata === undefined ? null : sql.json(asDbJson(input.patch.metadata))}, metadata),
      archived_at = CASE WHEN ${input.patch.archived ?? null}::boolean IS NULL THEN archived_at WHEN ${input.patch.archived ?? false} THEN COALESCE(archived_at, NOW()) ELSE NULL END,
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.fileId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return file ?? null;
}

export async function listFlightDeckPgChannelAudioNotes(
  input: { workspaceId: string; channelId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgAudioNoteRow[]> {
  return sql<FlightDeckPgAudioNoteRow[]>`
    SELECT
      n.*,
      creator.npub AS created_by_actor_npub
    FROM flightdeck_pg_audio_notes n
    LEFT JOIN flightdeck_pg_actors creator ON creator.id = n.created_by_actor_id
    WHERE n.workspace_id = ${input.workspaceId}
      AND n.channel_id = ${input.channelId}
      AND n.deleted_at IS NULL
    ORDER BY n.updated_at DESC, n.id ASC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgAudioNote(
  workspaceId: string,
  audioNoteId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgAudioNoteRow | null> {
  const [audioNote] = await sql<FlightDeckPgAudioNoteRow[]>`
    SELECT *
    FROM flightdeck_pg_audio_notes
    WHERE workspace_id = ${workspaceId}
      AND id = ${audioNoteId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return audioNote ?? null;
}

export async function createFlightDeckPgAudioNote(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    storageObjectId: string;
    targetType?: FlightDeckPgReactionTargetType | null;
    targetId?: string | null;
    threadId?: string | null;
    title?: string | null;
    mimeType: string;
    durationSeconds?: number | null;
    sizeBytes?: number | null;
    mediaEncryption?: Record<string, unknown>;
    waveformPreview?: unknown[];
    transcriptText?: string | null;
    transcriptPreview?: string | null;
    transcript?: string | null;
    transcriptStatus?: string | null;
    summary?: string | null;
    recordState?: 'active' | 'archived';
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgAudioNoteRow> {
  const [audioNote] = await sql<FlightDeckPgAudioNoteRow[]>`
    INSERT INTO flightdeck_pg_audio_notes (
      workspace_id,
      scope_id,
      channel_id,
      thread_id,
      storage_object_id,
      target_type,
      target_id,
      title,
      mime_type,
      duration_seconds,
      size_bytes,
      media_encryption,
      waveform_preview,
      transcript_status,
      transcript_preview,
      transcript,
      summary,
      metadata,
      record_state,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.channel.scope_id},
      ${input.channel.id},
      ${input.threadId ?? null},
      ${input.storageObjectId},
      ${input.targetType ?? null},
      ${input.targetId ?? null},
      ${input.title ?? null},
      ${input.mimeType},
      ${input.durationSeconds ?? null},
      ${input.sizeBytes ?? 0},
      ${sql.json(asDbJson(input.mediaEncryption ?? {}))},
      ${sql.json(asDbJson(input.waveformPreview ?? []))},
      ${input.transcriptStatus ?? 'not_requested'},
      ${input.transcriptPreview ?? input.transcriptText ?? null},
      ${input.transcript ?? null},
      ${input.summary ?? null},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.recordState ?? 'active'},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  return audioNote;
}

export type FlightDeckPgReactionTarget = {
  targetType: FlightDeckPgReactionTargetType;
  targetId: string;
  scopeId: string;
  channelId: string;
  threadId: string | null;
};

export async function resolveFlightDeckPgReactionTarget(
  workspaceId: string,
  targetType: FlightDeckPgReactionTargetType,
  targetId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgReactionTarget | null> {
  if (targetType === 'message') {
    const message = await resolveFlightDeckPgMessage(workspaceId, targetId, sql);
    return message ? { targetType, targetId: message.id, scopeId: message.scope_id, channelId: message.channel_id, threadId: message.thread_id } : null;
  }
  if (targetType === 'task_comment') {
    const [comment] = await sql<FlightDeckPgTaskCommentRow[]>`
      SELECT *
      FROM flightdeck_pg_task_comments
      WHERE workspace_id = ${workspaceId}
        AND id = ${targetId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    return comment ? { targetType, targetId: comment.id, scopeId: comment.scope_id, channelId: comment.channel_id, threadId: comment.thread_id } : null;
  }
  if (targetType === 'task') {
    const task = await resolveFlightDeckPgTask(workspaceId, targetId, sql);
    return task ? { targetType, targetId: task.id, scopeId: task.scope_id, channelId: task.channel_id, threadId: task.thread_id } : null;
  }
  if (targetType === 'doc') {
    const doc = await resolveFlightDeckPgDoc(workspaceId, targetId, sql);
    return doc ? { targetType, targetId: doc.id, scopeId: doc.scope_id, channelId: doc.channel_id, threadId: null } : null;
  }
  if (targetType === 'file') {
    const file = await resolveFlightDeckPgFile(workspaceId, targetId, sql);
    return file ? { targetType, targetId: file.id, scopeId: file.scope_id, channelId: file.channel_id, threadId: null } : null;
  }
  if (targetType === 'audio_note') {
    const audioNote = await resolveFlightDeckPgAudioNote(workspaceId, targetId, sql);
    return audioNote ? { targetType, targetId: audioNote.id, scopeId: audioNote.scope_id, channelId: audioNote.channel_id, threadId: audioNote.thread_id } : null;
  }
  return null;
}

export async function listFlightDeckPgReactionsForTarget(
  input: { workspaceId: string; targetType: FlightDeckPgReactionTargetType; targetId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgReactionRow[]> {
  return sql<FlightDeckPgReactionRow[]>`
    SELECT r.*, a.npub AS reactor_npub
    FROM flightdeck_pg_reactions r
    LEFT JOIN flightdeck_pg_actors a ON a.id = r.reactor_actor_id
    WHERE r.workspace_id = ${input.workspaceId}
      AND r.target_type = ${input.targetType}
      AND r.target_id = ${input.targetId}
      AND r.deleted_at IS NULL
    ORDER BY r.created_at ASC, r.id ASC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgReaction(
  workspaceId: string,
  reactionId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgReactionRow | null> {
  const [reaction] = await sql<FlightDeckPgReactionRow[]>`
    SELECT *
    FROM flightdeck_pg_reactions
    WHERE workspace_id = ${workspaceId}
      AND id = ${reactionId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return reaction ?? null;
}

export async function createFlightDeckPgReaction(
  input: {
    workspaceId: string;
    target: FlightDeckPgReactionTarget;
    emoji: FlightDeckPgReactionEmoji;
    emojiShortcode?: string;
    metadata?: Record<string, unknown>;
    actorId?: string;
    reactorActorId?: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgReactionRow> {
  const reactorActorId = input.reactorActorId ?? input.actorId;
  if (!reactorActorId) throw new Error('reaction reactor actor is required');
  const emojiShortcode = input.emojiShortcode ?? ({
    thumbs_up: ':thumbs_up:',
    smile: ':smile:',
    heart: ':heart:',
    eyes: ':eyes:',
    party: ':party:',
    white_check_mark: ':white_check_mark:',
  } satisfies Record<FlightDeckPgReactionEmoji, string>)[input.emoji];
  const [existing] = await sql<FlightDeckPgReactionRow[]>`
    SELECT *
    FROM flightdeck_pg_reactions
    WHERE workspace_id = ${input.workspaceId}
      AND target_type = ${input.target.targetType}
      AND target_id = ${input.target.targetId}
      AND emoji = ${input.emoji}
      AND reactor_actor_id = ${reactorActorId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing) return existing;

  const [reaction] = await sql<FlightDeckPgReactionRow[]>`
    INSERT INTO flightdeck_pg_reactions (
      workspace_id,
      scope_id,
      channel_id,
      thread_id,
      target_type,
      target_id,
      emoji,
      emoji_shortcode,
      reactor_actor_id,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.target.scopeId},
      ${input.target.channelId},
      ${input.target.threadId},
      ${input.target.targetType},
      ${input.target.targetId},
      ${input.emoji},
      ${emojiShortcode},
      ${reactorActorId},
      ${reactorActorId},
      ${reactorActorId}
    )
    RETURNING *
  `;
  return reaction;
}

export async function deleteFlightDeckPgReaction(
  input: { workspaceId: string; reactionId: string; actorId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgReactionRow | null> {
  const [reaction] = await sql<FlightDeckPgReactionRow[]>`
    UPDATE flightdeck_pg_reactions
    SET
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.reactionId}
      AND deleted_at IS NULL
    RETURNING *
  `;
  return reaction ?? null;
}

export type FlightDeckPgResponseActivityTarget = {
  targetType: FlightDeckPgResponseActivityTargetType;
  targetId: string;
  scopeId: string | null;
  channelId: string | null;
  threadId: string | null;
  taskId: string | null;
  docId: string | null;
  parentCommentId: string | null;
};

export async function resolveFlightDeckPgResponseActivityTarget(
  workspaceId: string,
  targetType: FlightDeckPgResponseActivityTargetType,
  targetId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgResponseActivityTarget | null> {
  if (targetType === 'chat_thread') {
    const thread = await resolveFlightDeckPgThread(workspaceId, targetId, sql);
    if (!thread || thread.deleted_at) return null;
    return {
      targetType,
      targetId: thread.id,
      scopeId: thread.scope_id,
      channelId: thread.channel_id,
      threadId: thread.id,
      taskId: null,
      docId: null,
      parentCommentId: null,
    };
  }
  if (targetType === 'task_comment') {
    const [comment] = await sql<FlightDeckPgTaskCommentRow[]>`
      SELECT *
      FROM flightdeck_pg_task_comments
      WHERE workspace_id = ${workspaceId}
        AND id = ${targetId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!comment) return null;
    return {
      targetType,
      targetId: comment.id,
      scopeId: comment.scope_id,
      channelId: comment.channel_id,
      threadId: comment.thread_id,
      taskId: comment.task_id,
      docId: null,
      parentCommentId: comment.id,
    };
  }
  if (targetType === 'doc_comment') {
    const [comment] = await sql<FlightDeckPgDocCommentRow[]>`
      SELECT *
      FROM flightdeck_pg_doc_comments
      WHERE workspace_id = ${workspaceId}
        AND id = ${targetId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!comment) return null;
    return {
      targetType,
      targetId: comment.id,
      scopeId: comment.scope_id,
      channelId: comment.channel_id,
      threadId: null,
      taskId: null,
      docId: comment.doc_id,
      parentCommentId: comment.id,
    };
  }
  return null;
}

export async function listFlightDeckPgResponseActivities(
  input: {
    workspaceId: string;
    targetType?: FlightDeckPgResponseActivityTargetType | null;
    targetId?: string | null;
    channelId?: string | null;
    includeCleared?: boolean;
    limit: number;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgResponseActivityRow[]> {
  const targetType = input.targetType ?? null;
  const targetId = input.targetId ?? null;
  const channelId = input.channelId ?? null;
  const includeCleared = input.includeCleared === true;
  return sql<FlightDeckPgResponseActivityRow[]>`
    SELECT *
    FROM flightdeck_pg_response_activities
    WHERE workspace_id = ${input.workspaceId}
      AND (${targetType}::text IS NULL OR target_type = ${targetType})
      AND (${targetId}::uuid IS NULL OR target_id = ${targetId})
      AND (${channelId}::uuid IS NULL OR channel_id = ${channelId})
      AND (${includeCleared}::boolean OR cleared_at IS NULL)
      AND (${includeCleared}::boolean OR expires_at > NOW())
    ORDER BY updated_at DESC, id DESC
    LIMIT ${input.limit}
  `;
}

export async function upsertFlightDeckPgResponseActivity(
  input: {
    workspaceId: string;
    target: FlightDeckPgResponseActivityTarget;
    actorId: string | null;
    actorNpub: string | null;
    activityType?: string | null;
    status: FlightDeckPgResponseActivityStatus;
    severity?: FlightDeckPgResponseActivitySeverity | null;
    label?: string | null;
    message?: string | null;
    pipelineRunId?: string | null;
    sourceMessageId?: string | null;
    metadata?: Record<string, unknown>;
    expiresAt: Date;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgResponseActivityRow> {
  const activityType = input.activityType?.trim() || 'agent_response';
  const severity = input.severity ?? (input.status === 'failed' ? 'error' : 'info');
  const [activity] = await sql<FlightDeckPgResponseActivityRow[]>`
    INSERT INTO flightdeck_pg_response_activities (
      workspace_id,
      scope_id,
      channel_id,
      target_type,
      target_id,
      thread_id,
      task_id,
      doc_id,
      parent_comment_id,
      actor_id,
      actor_npub,
      activity_type,
      status,
      severity,
      label,
      message,
      pipeline_run_id,
      source_message_id,
      metadata,
      expires_at,
      cleared_at
    )
    VALUES (
      ${input.workspaceId},
      ${input.target.scopeId},
      ${input.target.channelId},
      ${input.target.targetType},
      ${input.target.targetId},
      ${input.target.threadId},
      ${input.target.taskId},
      ${input.target.docId},
      ${input.target.parentCommentId},
      ${input.actorId},
      ${input.actorNpub},
      ${activityType},
      ${input.status},
      ${severity},
      ${input.label ?? null},
      ${input.message ?? null},
      ${input.pipelineRunId ?? null},
      ${input.sourceMessageId ?? null},
      ${sql.json(input.metadata ?? {})},
      ${input.expiresAt},
      ${input.status === 'cleared' ? new Date() : null}
    )
    ON CONFLICT (workspace_id, target_type, target_id, actor_id, activity_type)
      WHERE cleared_at IS NULL
    DO UPDATE SET
      scope_id = EXCLUDED.scope_id,
      channel_id = EXCLUDED.channel_id,
      thread_id = EXCLUDED.thread_id,
      task_id = EXCLUDED.task_id,
      doc_id = EXCLUDED.doc_id,
      parent_comment_id = EXCLUDED.parent_comment_id,
      actor_npub = EXCLUDED.actor_npub,
      status = EXCLUDED.status,
      severity = EXCLUDED.severity,
      label = EXCLUDED.label,
      message = EXCLUDED.message,
      pipeline_run_id = EXCLUDED.pipeline_run_id,
      source_message_id = EXCLUDED.source_message_id,
      metadata = EXCLUDED.metadata,
      expires_at = EXCLUDED.expires_at,
      cleared_at = CASE WHEN EXCLUDED.status = 'cleared' THEN NOW() ELSE NULL END,
      row_version = flightdeck_pg_response_activities.row_version + 1,
      updated_at = NOW()
    RETURNING *
  `;
  return activity;
}

export async function clearFlightDeckPgResponseActivity(
  input: { workspaceId: string; activityId: string; actorId: string | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgResponseActivityRow | null> {
  const [activity] = await sql<FlightDeckPgResponseActivityRow[]>`
    UPDATE flightdeck_pg_response_activities
    SET
      status = 'cleared',
      cleared_at = COALESCE(cleared_at, NOW()),
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.activityId}
      AND cleared_at IS NULL
      AND (${input.actorId}::uuid IS NULL OR actor_id = ${input.actorId})
    RETURNING *
  `;
  return activity ?? null;
}

const terminalAgentActivityStates = new Set<FlightDeckPgAgentActivityState>(['completed', 'failed', 'cancelled']);

export async function listFlightDeckPgAgentActivities(
  input: { workspaceId: string; channelId: string; threadId?: string | null; activityId?: string | null; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgAgentActivityRow[]> {
  const threadId = input.threadId ?? null;
  const activityId = input.activityId ?? null;
  await sql`
    DELETE FROM flightdeck_pg_agent_activities
    WHERE workspace_id = ${input.workspaceId} AND expires_at <= NOW()
  `;
  const activities = await sql<FlightDeckPgAgentActivityRow[]>`
    SELECT *
    FROM flightdeck_pg_agent_activities
    WHERE workspace_id = ${input.workspaceId}
      AND channel_id = ${input.channelId}
      AND (${threadId}::uuid IS NULL OR thread_id = ${threadId})
      AND (${activityId}::text IS NULL OR activity_id = ${activityId})
      AND expires_at > NOW()
    ORDER BY updated_at DESC, id DESC
    LIMIT ${input.limit}
  `;
  if (!activities.length) return activities;
  const activityRowIds = activities.map((activity) => activity.id);
  const commentary = await sql<FlightDeckPgAgentActivityCommentary[]>`
    SELECT *
    FROM flightdeck_pg_agent_activity_commentary
    WHERE workspace_id = ${input.workspaceId}
      AND agent_activity_id IN ${sql(activityRowIds)}
    ORDER BY sequence ASC, id ASC
  `;
  const commentaryByActivityId = new Map<string, FlightDeckPgAgentActivityCommentary[]>();
  for (const entry of commentary) {
    const entries = commentaryByActivityId.get(entry.agent_activity_id) ?? [];
    entries.push(entry);
    commentaryByActivityId.set(entry.agent_activity_id, entries);
  }
  return activities.map((activity) => ({
    ...activity,
    commentary_history: (commentaryByActivityId.get(activity.id) ?? [])
      .filter((entry) => entry.turn_id === activity.turn_id),
  }));
}

export async function upsertFlightDeckPgAgentActivity(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    threadId: string;
    triggerMessageId: string;
    turnId: string;
    sessionId: string;
    activityId: string;
    agentNpub: string;
    publisherActorId: string;
    state: FlightDeckPgAgentActivityState;
    label?: string | null;
    summary?: string | null;
    body?: string | null;
    sequence: number;
    expiresAt: Date;
  },
  sql: DbClient = getDb(),
): Promise<{ activity: FlightDeckPgAgentActivityRow; outcome: 'created' | 'updated' | 'idempotent' | 'stale' | 'terminal' | 'identity_mismatch' }> {
  const terminalAt = terminalAgentActivityStates.has(input.state) ? new Date() : null;
  const rows = await sql<FlightDeckPgAgentActivityRow[]>`
    INSERT INTO flightdeck_pg_agent_activities (
      workspace_id, scope_id, channel_id, thread_id, trigger_message_id,
      turn_id, session_id, activity_id, agent_npub, publisher_actor_id, state,
      label, summary, body, visibility, sequence, expires_at, terminal_at
    ) VALUES (
      ${input.workspaceId}, ${input.scopeId}, ${input.channelId}, ${input.threadId}, ${input.triggerMessageId},
      ${input.turnId}, ${input.sessionId}, ${input.activityId}, ${input.agentNpub}, ${input.publisherActorId}, ${input.state},
      ${input.label ?? null}, ${input.summary ?? null}, ${input.body ?? null}, 'user_visible',
      ${input.sequence}, ${input.expiresAt}, ${terminalAt}
    )
    ON CONFLICT (workspace_id, activity_id) DO UPDATE SET
      state = EXCLUDED.state,
      turn_id = COALESCE(flightdeck_pg_agent_activities.turn_id, EXCLUDED.turn_id),
      label = EXCLUDED.label,
      summary = EXCLUDED.summary,
      body = EXCLUDED.body,
      sequence = EXCLUDED.sequence,
      expires_at = EXCLUDED.expires_at,
      terminal_at = EXCLUDED.terminal_at,
      updated_at = NOW()
    WHERE flightdeck_pg_agent_activities.sequence < EXCLUDED.sequence
      AND flightdeck_pg_agent_activities.terminal_at IS NULL
      AND flightdeck_pg_agent_activities.channel_id = EXCLUDED.channel_id
      AND flightdeck_pg_agent_activities.thread_id = EXCLUDED.thread_id
      AND flightdeck_pg_agent_activities.trigger_message_id = EXCLUDED.trigger_message_id
      AND flightdeck_pg_agent_activities.session_id = EXCLUDED.session_id
      AND flightdeck_pg_agent_activities.agent_npub = EXCLUDED.agent_npub
      AND flightdeck_pg_agent_activities.publisher_actor_id = EXCLUDED.publisher_actor_id
      AND (flightdeck_pg_agent_activities.turn_id IS NULL OR flightdeck_pg_agent_activities.turn_id = EXCLUDED.turn_id)
    RETURNING *, (xmax = 0) AS inserted
  ` as unknown as Array<FlightDeckPgAgentActivityRow & { inserted: boolean }>;
  const changed = rows[0];
  if (changed) {
    const hasCommentary = Boolean(input.summary?.trim() || input.body?.trim());
    if (input.state === 'working' && hasCommentary) {
      await sql`
        INSERT INTO flightdeck_pg_agent_activity_commentary (
          workspace_id, agent_activity_id, turn_id, activity_id, state,
          label, summary, body, visibility, sequence
        ) VALUES (
          ${input.workspaceId}, ${changed.id}, ${input.turnId}, ${input.activityId}, 'working',
          ${input.label ?? null}, ${input.summary ?? null}, ${input.body ?? null}, 'user_visible', ${input.sequence}
        )
        ON CONFLICT (workspace_id, turn_id, sequence) DO NOTHING
      `;
    }
    return { activity: changed, outcome: changed.inserted ? 'created' : 'updated' };
  }

  const [current] = await sql<FlightDeckPgAgentActivityRow[]>`
    SELECT * FROM flightdeck_pg_agent_activities
    WHERE workspace_id = ${input.workspaceId} AND activity_id = ${input.activityId}
    LIMIT 1
  `;
  if (!current) throw new Error('agent activity upsert conflict did not resolve an existing row');
  if (current.turn_id !== null && current.turn_id !== input.turnId) {
    return { activity: current, outcome: 'identity_mismatch' };
  }
  if (Number(current.sequence) === input.sequence && current.state === input.state) {
    return { activity: current, outcome: 'idempotent' };
  }
  return { activity: current, outcome: current.terminal_at ? 'terminal' : 'stale' };
}

export async function listFlightDeckPgChannelTasks(
  input: { workspaceId: string; channelId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskRow[]> {
  return sql<FlightDeckPgTaskRow[]>`
    SELECT *
    FROM flightdeck_pg_tasks
    WHERE workspace_id = ${input.workspaceId}
      AND channel_id = ${input.channelId}
      AND deleted_at IS NULL
    ORDER BY updated_at DESC, id ASC
    LIMIT ${input.limit}
  `;
}

export async function listFlightDeckPgTaskAssignments(
  input: { workspaceId: string; taskId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskAssignmentWithActorNpub[]> {
  return sql<FlightDeckPgTaskAssignmentWithActorNpub[]>`
    SELECT
      a.*,
      actor.npub AS actor_npub
    FROM flightdeck_pg_task_assignments a
    LEFT JOIN flightdeck_pg_actors actor ON actor.id = a.actor_id
    WHERE a.workspace_id = ${input.workspaceId}
      AND a.task_id = ${input.taskId}
      AND a.deleted_at IS NULL
    ORDER BY a.created_at ASC, a.actor_id ASC
  `;
}

export async function withFlightDeckPgTaskAssignments(
  workspaceId: string,
  tasks: FlightDeckPgTaskRow[],
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskWithAssignments[]> {
  const rows: FlightDeckPgTaskWithAssignments[] = [];
  for (const task of tasks) {
    rows.push({
      ...task,
      assignments: await listFlightDeckPgTaskAssignments({ workspaceId, taskId: task.id }, sql),
    });
  }
  return rows;
}

export async function listVisibleFlightDeckPgScopeTasks(
  input: { workspaceId: string; scopeId: string; actorId: string; groupIds: string[]; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskRow[]> {
  const groupIds = input.groupIds.length > 0 ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  return sql<FlightDeckPgTaskRow[]>`
    SELECT DISTINCT t.*
    FROM flightdeck_pg_tasks t
    JOIN flightdeck_pg_permission_grants pg
      ON pg.workspace_id = t.workspace_id
      AND pg.resource_type = 'channel'
      AND pg.resource_channel_id = t.channel_id
      AND pg.permission = 'task.read'
      AND pg.revoked_at IS NULL
      AND (
        (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
        OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
      )
    WHERE t.workspace_id = ${input.workspaceId}
      AND t.scope_id = ${input.scopeId}
      AND t.deleted_at IS NULL
    ORDER BY t.updated_at DESC, t.id ASC
    LIMIT ${input.limit}
  `;
}

export async function listVisibleFlightDeckPgWorkrooms(
  input: {
    workspaceId: string;
    actorId: string;
    groupIds: string[];
    limit: number;
    scopeId?: string | null;
    channelId?: string | null;
    status?: FlightDeckPgWorkroomStatus | null;
    query?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomRow[]> {
  const groupIds = input.groupIds.length > 0 ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  const query = input.query?.trim() ? `%${input.query.trim()}%` : null;
  return sql<FlightDeckPgWorkroomRow[]>`
    SELECT DISTINCT w.*
    FROM flightdeck_pg_workrooms w
    JOIN flightdeck_pg_permission_grants pg
      ON pg.workspace_id = w.workspace_id
      AND pg.resource_type = 'channel'
      AND pg.resource_channel_id = w.channel_id
      AND pg.permission = 'channel.read'
      AND pg.revoked_at IS NULL
      AND (
        (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
        OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
      )
    WHERE w.workspace_id = ${input.workspaceId}
      AND w.deleted_at IS NULL
      AND (${input.scopeId ?? null}::uuid IS NULL OR w.scope_id = ${input.scopeId ?? null})
      AND (${input.channelId ?? null}::uuid IS NULL OR w.channel_id = ${input.channelId ?? null})
      AND (${input.status ?? null}::text IS NULL OR w.status = ${input.status ?? null})
      AND (
        ${query}::text IS NULL
        OR w.title ILIKE ${query}
        OR w.goal ILIKE ${query}
        OR COALESCE(w.integration_autopilot_npub, '') ILIKE ${query}
      )
    ORDER BY w.updated_at DESC, w.id ASC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgWorkroom(
  workspaceId: string,
  workroomId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomRow | null> {
  const [workroom] = await sql<FlightDeckPgWorkroomRow[]>`
    SELECT *
    FROM flightdeck_pg_workrooms
    WHERE workspace_id = ${workspaceId}
      AND id = ${workroomId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return workroom ?? null;
}

export async function resolveFlightDeckPgWorkroomByThread(
  input: { workspaceId: string; channelId: string; threadId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomRow | null> {
  const [workroom] = await sql<FlightDeckPgWorkroomRow[]>`
    SELECT *
    FROM flightdeck_pg_workrooms
    WHERE workspace_id = ${input.workspaceId}
      AND channel_id = ${input.channelId}
      AND deleted_at IS NULL
      AND (
        thread_id = ${input.threadId}
        OR metadata->>'announcement_thread_id' = ${input.threadId}
      )
    ORDER BY (thread_id = ${input.threadId}) DESC, updated_at DESC, id ASC
    LIMIT 1
  `;
  return workroom ?? null;
}

export async function createFlightDeckPgWorkroom(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    title: string;
    goal: string;
    threadId?: string | null;
    integrationAutopilotNpub?: string | null;
    repo?: FlightDeckPgWorkroomRepoConfig;
    branches?: FlightDeckPgWorkroomBranchConfig;
    appTargets?: FlightDeckPgWorkroomAppTargets;
    approvalPolicy?: FlightDeckPgWorkroomApprovalPolicy;
    archivePolicy?: FlightDeckPgWorkroomArchivePolicy;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomRow> {
  const [workroom] = await sql<FlightDeckPgWorkroomRow[]>`
    INSERT INTO flightdeck_pg_workrooms (
      workspace_id, scope_id, channel_id, title, goal, integration_autopilot_npub,
      thread_id,
      repo, branches, app_targets, approval_policy, archive_policy, metadata,
      created_by_actor_id, updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId}, ${input.channel.scope_id}, ${input.channel.id}, ${input.title}, ${input.goal},
      ${input.integrationAutopilotNpub ?? null},
      ${input.threadId ?? null},
      ${sql.json(asDbJson(input.repo ?? {}))},
      ${sql.json(asDbJson(input.branches ?? {}))},
      ${sql.json(asDbJson(input.appTargets ?? {}))},
      ${sql.json(asDbJson(input.approvalPolicy ?? {}))},
      ${sql.json(asDbJson(input.archivePolicy ?? { retention: 'keep' }))},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId}, ${input.actorId}
    )
    RETURNING *
  `;
  return workroom;
}

export async function updateFlightDeckPgWorkroom(
  input: {
    workspaceId: string;
    workroomId: string;
    actorId: string;
    rowVersion?: number | null;
    patch: {
      title?: string;
      goal?: string;
      status?: FlightDeckPgWorkroomStatus;
      threadId?: string | null;
      integrationAutopilotNpub?: string | null;
      repo?: FlightDeckPgWorkroomRepoConfig;
      branches?: FlightDeckPgWorkroomBranchConfig;
      appTargets?: FlightDeckPgWorkroomAppTargets;
      approvalPolicy?: FlightDeckPgWorkroomApprovalPolicy;
      archivePolicy?: FlightDeckPgWorkroomArchivePolicy;
      metadata?: Record<string, unknown>;
    };
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomRow | null> {
  const [workroom] = await sql<FlightDeckPgWorkroomRow[]>`
    UPDATE flightdeck_pg_workrooms
    SET
      title = COALESCE(${input.patch.title ?? null}, title),
      goal = COALESCE(${input.patch.goal ?? null}, goal),
      status = COALESCE(${input.patch.status ?? null}, status),
      thread_id = CASE WHEN ${input.patch.threadId !== undefined} THEN ${input.patch.threadId ?? null} ELSE thread_id END,
      integration_autopilot_npub = CASE WHEN ${input.patch.integrationAutopilotNpub !== undefined} THEN ${input.patch.integrationAutopilotNpub ?? null} ELSE integration_autopilot_npub END,
      repo = COALESCE(${input.patch.repo === undefined ? null : sql.json(asDbJson(input.patch.repo))}, repo),
      branches = COALESCE(${input.patch.branches === undefined ? null : sql.json(asDbJson(input.patch.branches))}, branches),
      app_targets = COALESCE(${input.patch.appTargets === undefined ? null : sql.json(asDbJson(input.patch.appTargets))}, app_targets),
      approval_policy = COALESCE(${input.patch.approvalPolicy === undefined ? null : sql.json(asDbJson(input.patch.approvalPolicy))}, approval_policy),
      archive_policy = COALESCE(${input.patch.archivePolicy === undefined ? null : sql.json(asDbJson(input.patch.archivePolicy))}, archive_policy),
      metadata = COALESCE(${input.patch.metadata === undefined ? null : sql.json(asDbJson(input.patch.metadata))}, metadata),
      completed_at = CASE WHEN ${input.patch.status ?? null} = 'complete' THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.workroomId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return workroom ?? null;
}

export async function archiveFlightDeckPgWorkroom(
  input: { workspaceId: string; workroomId: string; actorId: string; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomRow | null> {
  const [workroom] = await sql<FlightDeckPgWorkroomRow[]>`
    UPDATE flightdeck_pg_workrooms
    SET status = 'archived',
        archived_at = COALESCE(archived_at, NOW()),
        updated_by_actor_id = ${input.actorId},
        row_version = row_version + 1,
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.workroomId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return workroom ?? null;
}

export async function createFlightDeckPgWorkroomParticipant(
  input: { workspaceId: string; workroomId: string; participant: FlightDeckPgWorkroomParticipantInput },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomParticipantRow> {
  const [member] = await sql<{ actor_id: string }[]>`
    SELECT m.actor_id
    FROM flightdeck_pg_workspace_memberships m
    JOIN flightdeck_pg_actors a ON a.id = m.actor_id
    WHERE m.workspace_id = ${input.workspaceId}
      AND a.npub = ${input.participant.actorNpub}
    LIMIT 1
  `;
  const accessStatus = input.participant.accessStatus ?? (member?.actor_id ? 'granted' : 'failed');
  const accessIssue = input.participant.accessIssue ?? (member?.actor_id ? null : 'workspace_membership_missing');
  const [participant] = await sql<FlightDeckPgWorkroomParticipantRow[]>`
    INSERT INTO flightdeck_pg_workroom_participants (
      workspace_id, workroom_id, actor_npub, actor_id, kind, role, label,
      status, access_status, access_issue, metadata
    )
    VALUES (
      ${input.workspaceId}, ${input.workroomId}, ${input.participant.actorNpub}, ${member?.actor_id ?? null},
      ${input.participant.kind}, ${input.participant.role}, ${input.participant.label ?? null},
      ${input.participant.status ?? 'invited'}, ${accessStatus}, ${accessIssue},
      ${sql.json(asDbJson(input.participant.metadata ?? {}))}
    )
    ON CONFLICT (workroom_id, actor_npub) DO UPDATE SET
      actor_id = EXCLUDED.actor_id,
      kind = EXCLUDED.kind,
      role = EXCLUDED.role,
      label = EXCLUDED.label,
      status = EXCLUDED.status,
      access_status = EXCLUDED.access_status,
      access_issue = EXCLUDED.access_issue,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *
  `;
  return participant;
}

export async function listFlightDeckPgWorkroomParticipants(
  input: { workspaceId: string; workroomId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomParticipantRow[]> {
  return sql<FlightDeckPgWorkroomParticipantRow[]>`
    SELECT *
    FROM flightdeck_pg_workroom_participants
    WHERE workspace_id = ${input.workspaceId}
      AND workroom_id = ${input.workroomId}
    ORDER BY created_at ASC, actor_npub ASC
  `;
}

export async function createFlightDeckPgWorkroomEvent(
  input: { workspaceId: string; workroom: FlightDeckPgWorkroomRow; event: FlightDeckPgWorkroomEventInput },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomEventRow> {
  const [event] = await sql<FlightDeckPgWorkroomEventRow[]>`
    INSERT INTO flightdeck_pg_workroom_events (
      workspace_id, workroom_id, scope_id, channel_id, event_type, actor_npub, actor_id,
      target_type, target_ref, title, body, payload, visibility
    )
    VALUES (
      ${input.workspaceId}, ${input.workroom.id}, ${input.workroom.scope_id}, ${input.workroom.channel_id},
      ${input.event.eventType}, ${input.event.actorNpub ?? null}, ${input.event.actorId ?? null},
      ${input.event.targetType ?? null}, ${input.event.targetRef ?? null}, ${input.event.title ?? null},
      ${input.event.body ?? null}, ${sql.json(asDbJson(input.event.payload ?? {}))}, ${input.event.visibility ?? 'room'}
    )
    RETURNING *
  `;
  return event;
}

export async function listFlightDeckPgWorkroomEvents(
  input: { workspaceId: string; workroomId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomEventRow[]> {
  return sql<FlightDeckPgWorkroomEventRow[]>`
    SELECT *
    FROM flightdeck_pg_workroom_events
    WHERE workspace_id = ${input.workspaceId}
      AND workroom_id = ${input.workroomId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${input.limit}
  `;
}

export async function createFlightDeckPgWorkroomLink(
  input: { workspaceId: string; workroom: FlightDeckPgWorkroomRow; link: FlightDeckPgWorkroomLinkInput; actorId: string | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomLinkRow> {
  const [link] = await sql<FlightDeckPgWorkroomLinkRow[]>`
    INSERT INTO flightdeck_pg_workroom_links (
      workspace_id, workroom_id, scope_id, channel_id, link_type, target_type,
      target_id, external_url, label, status, metadata, created_by_actor_id
    )
    VALUES (
      ${input.workspaceId}, ${input.workroom.id}, ${input.workroom.scope_id}, ${input.workroom.channel_id},
      ${input.link.linkType}, ${input.link.targetType}, ${input.link.targetId ?? null}, ${input.link.externalUrl ?? null},
      ${input.link.label ?? null}, ${input.link.status ?? null}, ${sql.json(asDbJson(input.link.metadata ?? {}))}, ${input.actorId}
    )
    RETURNING *
  `;
  return link;
}

export async function listFlightDeckPgWorkroomLinks(
  input: { workspaceId: string; workroomId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgWorkroomLinkRow[]> {
  return sql<FlightDeckPgWorkroomLinkRow[]>`
    SELECT *
    FROM flightdeck_pg_workroom_links
    WHERE workspace_id = ${input.workspaceId}
      AND workroom_id = ${input.workroomId}
    ORDER BY updated_at DESC, id ASC
    LIMIT ${input.limit}
  `;
}

export async function createFlightDeckPgTypedApproval(
  input: {
    workspaceId: string;
    workroom: FlightDeckPgWorkroomRow;
    targetType: FlightDeckPgApprovalTargetType;
    action: FlightDeckPgApprovalAction;
    title?: string | null;
    summary?: string | null;
    requestedByActorId: string;
    requestedByNpub: string;
    reviewerNpub?: string | null;
    metadata?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTypedApprovalRow> {
  const reviewerActorId = input.reviewerNpub
    ? (await sql<{ actor_id: string }[]>`
        SELECT m.actor_id
        FROM flightdeck_pg_workspace_memberships m
        JOIN flightdeck_pg_actors a ON a.id = m.actor_id
        WHERE m.workspace_id = ${input.workspaceId}
          AND a.npub = ${input.reviewerNpub}
        LIMIT 1
      `)[0]?.actor_id ?? null
    : null;
  const [approval] = await sql<FlightDeckPgTypedApprovalRow[]>`
    INSERT INTO flightdeck_pg_approvals (
      workspace_id, scope_id, channel_id, target_type, target_id, action, status,
      title, summary, requested_by_actor_id, requested_by_npub, reviewer_actor_id,
      reviewer_npub, metadata
    )
    VALUES (
      ${input.workspaceId}, ${input.workroom.scope_id}, ${input.workroom.channel_id},
      ${input.targetType}, ${input.workroom.id}, ${input.action}, 'requested',
      ${input.title ?? null}, ${input.summary ?? null}, ${input.requestedByActorId},
      ${input.requestedByNpub}, ${reviewerActorId}, ${input.reviewerNpub ?? null},
      ${sql.json(asDbJson(input.metadata ?? {}))}
    )
    RETURNING *
  `;
  return approval;
}

export async function listFlightDeckPgTypedApprovals(
  input: { workspaceId: string; targetType?: string | null; targetId?: string | null; action?: string | null; status?: string | null; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTypedApprovalRow[]> {
  return sql<FlightDeckPgTypedApprovalRow[]>`
    SELECT *
    FROM flightdeck_pg_approvals
    WHERE workspace_id = ${input.workspaceId}
      AND (${input.targetType ?? null}::text IS NULL OR target_type = ${input.targetType ?? null})
      AND (${input.targetId ?? null}::uuid IS NULL OR target_id = ${input.targetId ?? null})
      AND (${input.action ?? null}::text IS NULL OR action = ${input.action ?? null})
      AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
    ORDER BY updated_at DESC, id ASC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgTypedApproval(
  workspaceId: string,
  approvalId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTypedApprovalRow | null> {
  const [approval] = await sql<FlightDeckPgTypedApprovalRow[]>`
    SELECT *
    FROM flightdeck_pg_approvals
    WHERE workspace_id = ${workspaceId}
      AND id = ${approvalId}
    LIMIT 1
  `;
  return approval ?? null;
}

export async function decideFlightDeckPgTypedApproval(
  input: {
    workspaceId: string;
    approvalId: string;
    actorId: string;
    actorNpub: string;
    status: Extract<FlightDeckPgApprovalStatus, 'approved' | 'rejected' | 'superseded' | 'cancelled'>;
    decisionNote?: string | null;
    rowVersion?: number | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTypedApprovalRow | null> {
  const [approval] = await sql<FlightDeckPgTypedApprovalRow[]>`
    UPDATE flightdeck_pg_approvals
    SET
      status = ${input.status},
      approver_actor_id = CASE WHEN ${input.status} = 'approved' THEN ${input.actorId} ELSE approver_actor_id END,
      approver_npub = CASE WHEN ${input.status} = 'approved' THEN ${input.actorNpub} ELSE approver_npub END,
      reviewer_actor_id = COALESCE(reviewer_actor_id, ${input.actorId}),
      reviewer_npub = COALESCE(reviewer_npub, ${input.actorNpub}),
      decision_note = ${input.decisionNote ?? null},
      reviewed_at = COALESCE(reviewed_at, NOW()),
      approved_at = CASE WHEN ${input.status} = 'approved' THEN NOW() ELSE approved_at END,
      rejected_at = CASE WHEN ${input.status} = 'rejected' THEN NOW() ELSE rejected_at END,
      superseded_at = CASE WHEN ${input.status} = 'superseded' THEN NOW() ELSE superseded_at END,
      cancelled_at = CASE WHEN ${input.status} = 'cancelled' THEN NOW() ELSE cancelled_at END,
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.approvalId}
      AND status IN ('requested', 'in_review')
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return approval ?? null;
}

export async function hasApprovedFlightDeckPgProductionMergeApproval(
  input: { workspaceId: string; workroomId: string; toBranch: string; commit: string; repo?: string | null },
  sql: DbClient = getDb(),
): Promise<boolean> {
  const [approval] = await sql<{ id: string }[]>`
    SELECT id
    FROM flightdeck_pg_approvals
    WHERE workspace_id = ${input.workspaceId}
      AND target_type = 'workroom'
      AND target_id = ${input.workroomId}
      AND action = 'production_merge'
      AND status = 'approved'
      AND metadata->>'to_branch' = ${input.toBranch}
      AND metadata->>'commit' = ${input.commit}
      AND (${input.repo ?? null}::text IS NULL OR metadata->>'repo' = ${input.repo ?? null} OR metadata->'repo'->>'url' = ${input.repo ?? null})
    LIMIT 1
  `;
  return Boolean(approval);
}

export async function listFlightDeckPgDailyNotes(
  input: { workspaceId: string; actorId: string; ownerActorId?: string | null; ownerNpub?: string | null; noteDate?: string | null; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDailyNoteRow[]> {
  return sql<FlightDeckPgDailyNoteRow[]>`
    SELECT
      n.*,
      owner.npub AS owner_actor_npub,
      updater.npub AS updated_by_actor_npub
    FROM flightdeck_pg_daily_notes n
    LEFT JOIN flightdeck_pg_actors owner ON owner.id = n.owner_actor_id
    LEFT JOIN flightdeck_pg_actors updater ON updater.id = n.updated_by_actor_id
    WHERE n.workspace_id = ${input.workspaceId}
      AND n.deleted_at IS NULL
      AND (${input.ownerActorId ?? null}::uuid IS NULL OR n.owner_actor_id = ${input.ownerActorId ?? null})
      AND (${input.ownerNpub ?? null}::text IS NULL OR owner.npub = ${input.ownerNpub ?? null})
      AND (${input.noteDate ?? null}::date IS NULL OR n.note_date = ${input.noteDate ?? null}::date)
      AND (
        n.owner_actor_id = ${input.actorId}
        OR EXISTS (
          SELECT 1
          FROM flightdeck_pg_daily_scope_agent_access access
          WHERE access.workspace_id = n.workspace_id
            AND access.owner_actor_id = n.owner_actor_id
            AND access.agent_actor_id = ${input.actorId}
            AND access.can_read = true
            AND access.revoked_at IS NULL
        )
      )
    ORDER BY n.note_date DESC, n.updated_at DESC, n.id ASC
    LIMIT ${input.limit}
  `;
}

export async function resolveFlightDeckPgDailyNote(
  workspaceId: string,
  noteId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDailyNoteRow | null> {
  const [note] = await sql<FlightDeckPgDailyNoteRow[]>`
    SELECT
      n.*,
      owner.npub AS owner_actor_npub,
      updater.npub AS updated_by_actor_npub
    FROM flightdeck_pg_daily_notes n
    LEFT JOIN flightdeck_pg_actors owner ON owner.id = n.owner_actor_id
    LEFT JOIN flightdeck_pg_actors updater ON updater.id = n.updated_by_actor_id
    WHERE n.workspace_id = ${workspaceId}
      AND n.id = ${noteId}
      AND n.deleted_at IS NULL
    LIMIT 1
  `;
  return note ?? null;
}

export async function resolveFlightDeckPgDailyNoteForOwnerDate(
  input: { workspaceId: string; ownerActorId: string; noteDate: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDailyNoteRow | null> {
  const [note] = await sql<FlightDeckPgDailyNoteRow[]>`
    SELECT
      n.*,
      owner.npub AS owner_actor_npub,
      updater.npub AS updated_by_actor_npub
    FROM flightdeck_pg_daily_notes n
    LEFT JOIN flightdeck_pg_actors owner ON owner.id = n.owner_actor_id
    LEFT JOIN flightdeck_pg_actors updater ON updater.id = n.updated_by_actor_id
    WHERE n.workspace_id = ${input.workspaceId}
      AND n.owner_actor_id = ${input.ownerActorId}
      AND n.note_date = ${input.noteDate}::date
      AND n.deleted_at IS NULL
    LIMIT 1
  `;
  return note ?? null;
}

function canonicalDailyNoteVersionItems(items: unknown): unknown[] {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const row = item as Record<string, unknown>;
    return {
      id: row.id ?? null,
      text: row.text ?? row.label ?? '',
      source: row.source ?? null,
    };
  });
}

export function dailyNoteVersionContentFingerprint(note: {
  title: string;
  body?: string | null;
  focus?: string | null;
  items?: unknown;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  return createHash('sha256').update(JSON.stringify({
    title: note.title || '',
    body: note.body ?? null,
    focus: note.focus ?? null,
    items: canonicalDailyNoteVersionItems(note.items),
    status: note.status || 'active',
    metadata: note.metadata ?? {},
  })).digest('hex');
}

export async function actorCanAccessFlightDeckPgDailyScope(
  input: { workspaceId: string; actorId: string; ownerActorId: string; access: 'read' | 'write' },
  sql: DbClient = getDb(),
): Promise<boolean> {
  if (input.actorId === input.ownerActorId) return true;
  const [row] = await sql<{ allowed: boolean }[]>`
    SELECT true AS allowed
    FROM flightdeck_pg_daily_scope_agent_access access
    WHERE access.workspace_id = ${input.workspaceId}
      AND access.owner_actor_id = ${input.ownerActorId}
      AND access.agent_actor_id = ${input.actorId}
      AND access.can_read = true
      AND (${input.access} = 'read' OR access.can_write = true)
      AND access.revoked_at IS NULL
    LIMIT 1
  `;
  return Boolean(row?.allowed);
}

export async function listFlightDeckPgDailyScopeAgentAccess(
  input: { workspaceId: string; ownerActorId: string },
  sql: DbClient = getDb(),
) {
  return sql`
    SELECT
      access.*,
      agent.npub AS agent_actor_npub,
      agent.kind AS agent_actor_kind,
      agent.display_name AS agent_display_name
    FROM flightdeck_pg_daily_scope_agent_access access
    JOIN flightdeck_pg_actors agent ON agent.id = access.agent_actor_id
    WHERE access.workspace_id = ${input.workspaceId}
      AND access.owner_actor_id = ${input.ownerActorId}
      AND access.revoked_at IS NULL
    ORDER BY agent.display_name NULLS LAST, agent.npub ASC
  `;
}

export async function upsertFlightDeckPgDailyScopeAgentAccess(
  input: { workspaceId: string; ownerActorId: string; agentActorId: string; canRead: boolean; canWrite: boolean; actorId: string },
  sql: DbClient = getDb(),
) {
  const [row] = await sql`
    INSERT INTO flightdeck_pg_daily_scope_agent_access (
      workspace_id,
      owner_actor_id,
      agent_actor_id,
      can_read,
      can_write,
      created_by_actor_id,
      updated_by_actor_id,
      revoked_at
    )
    VALUES (
      ${input.workspaceId},
      ${input.ownerActorId},
      ${input.agentActorId},
      ${input.canRead},
      ${input.canWrite},
      ${input.actorId},
      ${input.actorId},
      NULL
    )
    ON CONFLICT (workspace_id, owner_actor_id, agent_actor_id)
    DO UPDATE SET
      can_read = EXCLUDED.can_read,
      can_write = EXCLUDED.can_write,
      updated_by_actor_id = EXCLUDED.updated_by_actor_id,
      updated_at = NOW(),
      revoked_at = NULL
    RETURNING *
  `;
  return row;
}

export async function revokeFlightDeckPgDailyScopeAgentAccess(
  input: { workspaceId: string; ownerActorId: string; agentActorId: string; actorId: string },
  sql: DbClient = getDb(),
) {
  const [row] = await sql`
    UPDATE flightdeck_pg_daily_scope_agent_access
    SET
      can_read = false,
      can_write = false,
      updated_by_actor_id = ${input.actorId},
      updated_at = NOW(),
      revoked_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND owner_actor_id = ${input.ownerActorId}
      AND agent_actor_id = ${input.agentActorId}
    RETURNING *
  `;
  return row ?? null;
}

export async function upsertFlightDeckPgDailyNote(
  input: {
    workspaceId: string;
    ownerActorId: string;
    scopeId?: string | null;
    channelId?: string | null;
    noteDate: string;
    title: string;
    body?: string | null;
    focus?: string | null;
    items?: unknown[];
    status?: FlightDeckPgDailyNoteStatus;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDailyNoteRow> {
  const [note] = await sql<FlightDeckPgDailyNoteRow[]>`
    INSERT INTO flightdeck_pg_daily_notes (
      workspace_id,
      owner_actor_id,
      scope_id,
      channel_id,
      note_date,
      title,
      body,
      focus,
      items,
      status,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.ownerActorId},
      ${input.scopeId ?? null},
      ${input.channelId ?? null},
      ${input.noteDate}::date,
      ${input.title},
      ${input.body ?? null},
      ${input.focus ?? null},
      ${sql.json(asDbJson(input.items ?? []))},
      ${input.status ?? 'active'},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    ON CONFLICT (
      workspace_id,
      owner_actor_id,
      note_date
    ) WHERE deleted_at IS NULL
    DO UPDATE SET
      title = EXCLUDED.title,
      scope_id = EXCLUDED.scope_id,
      channel_id = EXCLUDED.channel_id,
      body = EXCLUDED.body,
      focus = EXCLUDED.focus,
      items = EXCLUDED.items,
      status = EXCLUDED.status,
      metadata = EXCLUDED.metadata,
      updated_by_actor_id = EXCLUDED.updated_by_actor_id,
      row_version = flightdeck_pg_daily_notes.row_version + 1,
      updated_at = NOW()
    RETURNING *
  `;
  return await resolveFlightDeckPgDailyNote(input.workspaceId, note.id, sql) ?? note;
}

export async function snapshotFlightDeckPgDailyNoteVersion(
  input: {
    note: FlightDeckPgDailyNoteRow;
    actorId: string;
    operation: 'created' | 'updated' | 'restored';
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDailyNoteVersionRow> {
  const [version] = await sql<FlightDeckPgDailyNoteVersionRow[]>`
    INSERT INTO flightdeck_pg_daily_note_versions (
      workspace_id,
      daily_note_id,
      row_version,
      owner_actor_id,
      scope_id,
      channel_id,
      note_date,
      title,
      body,
      focus,
      items,
      status,
      metadata,
      content_fingerprint,
      operation,
      actor_id,
      created_at,
      updated_at
    )
    VALUES (
      ${input.note.workspace_id},
      ${input.note.id},
      ${input.note.row_version},
      ${input.note.owner_actor_id},
      ${input.note.scope_id ?? null},
      ${input.note.channel_id ?? null},
      ${input.note.note_date},
      ${input.note.title},
      ${input.note.body ?? null},
      ${input.note.focus ?? null},
      ${sql.json(asDbJson(input.note.items ?? []))},
      ${input.note.status},
      ${sql.json(asDbJson(input.note.metadata ?? {}))},
      ${dailyNoteVersionContentFingerprint(input.note)},
      ${input.operation},
      ${input.actorId},
      ${input.note.created_at},
      ${input.note.updated_at}
    )
    ON CONFLICT (workspace_id, daily_note_id, row_version) DO UPDATE SET
      owner_actor_id = EXCLUDED.owner_actor_id,
      scope_id = EXCLUDED.scope_id,
      channel_id = EXCLUDED.channel_id,
      note_date = EXCLUDED.note_date,
      title = EXCLUDED.title,
      body = EXCLUDED.body,
      focus = EXCLUDED.focus,
      items = EXCLUDED.items,
      status = EXCLUDED.status,
      metadata = EXCLUDED.metadata,
      content_fingerprint = EXCLUDED.content_fingerprint,
      operation = EXCLUDED.operation,
      actor_id = EXCLUDED.actor_id,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `;
  return version;
}

export async function listFlightDeckPgDailyNoteVersions(
  input: { workspaceId: string; dailyNoteId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDailyNoteVersionRow[]> {
  const versions = await sql<FlightDeckPgDailyNoteVersionRow[]>`
    SELECT
      v.*,
      actor.npub AS actor_npub
    FROM flightdeck_pg_daily_note_versions v
    LEFT JOIN flightdeck_pg_actors actor ON actor.id = v.actor_id
    WHERE v.workspace_id = ${input.workspaceId}
      AND v.daily_note_id = ${input.dailyNoteId}
    ORDER BY v.row_version DESC
    LIMIT ${input.limit}
  `;
  if (versions.length > 0) return versions;

  const note = await resolveFlightDeckPgDailyNote(input.workspaceId, input.dailyNoteId, sql);
  if (!note) return [];
  const extended = note as FlightDeckPgDailyNoteRow & { updated_by_actor_npub?: string | null };
  return [{
    workspace_id: note.workspace_id,
    daily_note_id: note.id,
    row_version: note.row_version,
    owner_actor_id: note.owner_actor_id,
    scope_id: note.scope_id,
    channel_id: note.channel_id,
    note_date: note.note_date,
    title: note.title,
    body: note.body,
    focus: note.focus,
    items: note.items,
    status: note.status,
    metadata: note.metadata,
    content_fingerprint: dailyNoteVersionContentFingerprint(note),
    operation: 'updated',
    actor_id: note.updated_by_actor_id,
    actor_npub: extended.updated_by_actor_npub ?? null,
    created_at: note.created_at,
    updated_at: note.updated_at,
  }];
}

export async function listFlightDeckPgPersonalWapps(
  input: { workspaceId: string; actorId: string; ownerActorId?: string | null; ownerNpub?: string | null; includeArchived?: boolean; limit?: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPersonalWappRow[]> {
  return sql<FlightDeckPgPersonalWappRow[]>`
    SELECT
      w.*,
      owner.npub AS owner_actor_npub,
      updater.npub AS updated_by_actor_npub
    FROM flightdeck_pg_personal_wapps w
    LEFT JOIN flightdeck_pg_actors owner ON owner.id = w.owner_actor_id
    LEFT JOIN flightdeck_pg_actors updater ON updater.id = w.updated_by_actor_id
    WHERE w.workspace_id = ${input.workspaceId}
      AND w.deleted_at IS NULL
      AND (${input.includeArchived ?? false} = true OR w.status = 'active')
      AND (${input.ownerActorId ?? null}::uuid IS NULL OR w.owner_actor_id = ${input.ownerActorId ?? null})
      AND (${input.ownerNpub ?? null}::text IS NULL OR owner.npub = ${input.ownerNpub ?? null})
      AND (
        w.owner_actor_id = ${input.actorId}
        OR EXISTS (
          SELECT 1
          FROM flightdeck_pg_daily_scope_agent_access access
          WHERE access.workspace_id = w.workspace_id
            AND access.owner_actor_id = w.owner_actor_id
            AND access.agent_actor_id = ${input.actorId}
            AND access.can_read = true
            AND access.revoked_at IS NULL
        )
      )
    ORDER BY w.sort_order ASC, w.updated_at DESC, w.id ASC
    LIMIT ${input.limit ?? null}
  `;
}

export async function resolveFlightDeckPgPersonalWapp(
  workspaceId: string,
  wappId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPersonalWappRow | null> {
  const [wapp] = await sql<FlightDeckPgPersonalWappRow[]>`
    SELECT
      w.*,
      owner.npub AS owner_actor_npub,
      updater.npub AS updated_by_actor_npub
    FROM flightdeck_pg_personal_wapps w
    LEFT JOIN flightdeck_pg_actors owner ON owner.id = w.owner_actor_id
    LEFT JOIN flightdeck_pg_actors updater ON updater.id = w.updated_by_actor_id
    WHERE w.workspace_id = ${workspaceId}
      AND w.id = ${wappId}
      AND w.deleted_at IS NULL
    LIMIT 1
  `;
  return wapp ?? null;
}

export async function getNextFlightDeckPgPersonalWappSortOrder(
  input: { workspaceId: string; ownerActorId: string },
  sql: DbClient = getDb(),
): Promise<number> {
  const [row] = await sql<{ next_sort_order: number }[]>`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
    FROM flightdeck_pg_personal_wapps
    WHERE workspace_id = ${input.workspaceId}
      AND owner_actor_id = ${input.ownerActorId}
      AND deleted_at IS NULL
  `;
  return Number(row?.next_sort_order ?? 0);
}

export async function upsertFlightDeckPgPersonalWapp(
  input: {
    workspaceId: string;
    wappId?: string | null;
    ownerActorId: string;
    scopeId?: string | null;
    channelId?: string | null;
    title: string;
    description?: string | null;
    launchUrl: string;
    iconUrl?: string | null;
    appId?: string | null;
    externalWappId?: string | null;
    sourceWingmanUrl?: string | null;
    sortOrder?: number | null;
    status?: FlightDeckPgPersonalWappStatus;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPersonalWappRow> {
  if (input.wappId) {
    const [wapp] = await sql<FlightDeckPgPersonalWappRow[]>`
      UPDATE flightdeck_pg_personal_wapps
      SET
        scope_id = ${input.scopeId ?? null},
        channel_id = ${input.channelId ?? null},
        title = ${input.title},
        description = ${input.description ?? null},
        launch_url = ${input.launchUrl},
        icon_url = ${input.iconUrl ?? null},
        app_id = ${input.appId ?? null},
        wapp_id = ${input.externalWappId ?? null},
        source_wingman_url = ${input.sourceWingmanUrl ?? null},
        sort_order = COALESCE(${input.sortOrder ?? null}, sort_order),
        status = ${input.status ?? 'active'},
        metadata = ${sql.json(asDbJson(input.metadata ?? {}))},
        updated_by_actor_id = ${input.actorId},
        row_version = row_version + 1,
        updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.wappId}
        AND owner_actor_id = ${input.ownerActorId}
        AND deleted_at IS NULL
      RETURNING *
    `;
    if (!wapp) throw new Error('personal WApp not found');
    return await resolveFlightDeckPgPersonalWapp(input.workspaceId, wapp.id, sql) ?? wapp;
  }

  const nextSortOrder = input.sortOrder ?? await getNextFlightDeckPgPersonalWappSortOrder({
    workspaceId: input.workspaceId,
    ownerActorId: input.ownerActorId,
  }, sql);
  const [wapp] = await sql<FlightDeckPgPersonalWappRow[]>`
    INSERT INTO flightdeck_pg_personal_wapps (
      workspace_id,
      owner_actor_id,
      scope_id,
      channel_id,
      title,
      description,
      launch_url,
      icon_url,
      app_id,
      wapp_id,
      source_wingman_url,
      sort_order,
      status,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.ownerActorId},
      ${input.scopeId ?? null},
      ${input.channelId ?? null},
      ${input.title},
      ${input.description ?? null},
      ${input.launchUrl},
      ${input.iconUrl ?? null},
      ${input.appId ?? null},
      ${input.externalWappId ?? null},
      ${input.sourceWingmanUrl ?? null},
      ${nextSortOrder},
      ${input.status ?? 'active'},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  return await resolveFlightDeckPgPersonalWapp(input.workspaceId, wapp.id, sql) ?? wapp;
}

export async function archiveFlightDeckPgPersonalWapp(
  input: { workspaceId: string; ownerActorId: string; wappId: string; actorId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPersonalWappRow | null> {
  const [wapp] = await sql<FlightDeckPgPersonalWappRow[]>`
    UPDATE flightdeck_pg_personal_wapps
    SET
      status = 'archived',
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND owner_actor_id = ${input.ownerActorId}
      AND id = ${input.wappId}
      AND deleted_at IS NULL
    RETURNING *
  `;
  return wapp ?? null;
}

export async function reorderFlightDeckPgPersonalWapps(
  input: { workspaceId: string; ownerActorId: string; orderedIds: string[]; actorId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPersonalWappRow[]> {
  if (input.orderedIds.length === 0) return listFlightDeckPgPersonalWapps({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    ownerActorId: input.ownerActorId,
    includeArchived: false,
    limit: 200,
  }, sql);

  const existing = await sql<{ id: string }[]>`
    SELECT id
    FROM flightdeck_pg_personal_wapps
    WHERE workspace_id = ${input.workspaceId}
      AND owner_actor_id = ${input.ownerActorId}
      AND id IN ${sql(input.orderedIds)}
      AND deleted_at IS NULL
  `;
  const existingIds = new Set(existing.map((row) => row.id));
  if (existingIds.size !== input.orderedIds.length) {
    throw new Error('ordered_ids must all belong to active personal WApps for this owner');
  }

  for (const [index, id] of input.orderedIds.entries()) {
    await sql`
      UPDATE flightdeck_pg_personal_wapps
      SET
        sort_order = ${index},
        updated_by_actor_id = ${input.actorId},
        row_version = row_version + 1,
        updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId}
        AND owner_actor_id = ${input.ownerActorId}
        AND id = ${id}
    `;
  }

  return listFlightDeckPgPersonalWapps({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    ownerActorId: input.ownerActorId,
    includeArchived: false,
    limit: 200,
  }, sql);
}

export async function listVisibleFlightDeckPgEvents(
  input: { workspaceId: string; actorId: string; groupIds: string[]; afterRowVersion: number; throughRowVersion?: number | null; limit: number; includeWorkspaceEvents?: boolean },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgOutboxEventRow[]> {
  const groupIds = input.groupIds.length > 0 ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  const includeWorkspaceEvents = input.includeWorkspaceEvents ?? false;
  return sql<FlightDeckPgOutboxEventRow[]>`
    SELECT e.*, actor.npub AS actor_npub
    FROM flightdeck_pg_outbox_events e
    LEFT JOIN flightdeck_pg_actors actor ON actor.id = e.actor_id
    WHERE e.workspace_id = ${input.workspaceId}
      AND e.row_version > ${input.afterRowVersion}
      AND (${input.throughRowVersion ?? null}::integer IS NULL OR e.row_version <= ${input.throughRowVersion ?? null})
      AND (
        (
          e.entity_type = 'resource_view_state'
          AND e.payload->>'viewer_actor_id' = ${input.actorId}
        )
        OR
        (
          e.channel_id IS NOT NULL
          AND e.entity_type LIKE 'task%'
          AND EXISTS (
            SELECT 1
            FROM flightdeck_pg_permission_grants pg
            WHERE pg.workspace_id = e.workspace_id
              AND pg.resource_type = 'channel'
              AND pg.resource_channel_id = e.channel_id
              AND pg.permission = 'task.read'
              AND pg.revoked_at IS NULL
              AND (
                (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
                OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
              )
          )
        )
        OR (
          e.channel_id IS NOT NULL
          AND e.entity_type IN ('doc', 'file', 'audio_note')
          AND EXISTS (
            SELECT 1
            FROM flightdeck_pg_permission_grants pg
            WHERE pg.workspace_id = e.workspace_id
              AND pg.resource_type = 'channel'
              AND pg.resource_channel_id = e.channel_id
              AND pg.permission IN (
                CASE
                  WHEN e.entity_type = 'file' THEN 'file.read'
                  WHEN e.entity_type = 'audio_note' THEN 'audio_note.read'
                  ELSE 'doc.read'
                END,
                'channel.read'
              )
              AND pg.revoked_at IS NULL
              AND (
                (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
                OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
              )
          )
        )
        OR (
          e.channel_id IS NOT NULL
          AND e.entity_type = 'wapp_activity_item'
          AND EXISTS (
            SELECT 1
            FROM flightdeck_pg_channels channel
            JOIN flightdeck_pg_scopes scope
              ON scope.workspace_id = channel.workspace_id
             AND scope.id = channel.scope_id
            WHERE channel.workspace_id = e.workspace_id
              AND channel.id = e.channel_id
              AND channel.archived_at IS NULL
              AND scope.archived_at IS NULL
          )
          AND EXISTS (
            SELECT 1
            FROM flightdeck_pg_permission_grants pg
            WHERE pg.workspace_id = e.workspace_id
              AND pg.resource_type = 'channel'
              AND pg.resource_channel_id = e.channel_id
              AND pg.permission = 'channel.read'
              AND pg.revoked_at IS NULL
              AND (
                (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
                OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
              )
          )
        )
        OR (
          e.channel_id IS NOT NULL
          AND e.entity_type NOT LIKE 'task%'
          AND e.entity_type NOT IN ('doc', 'file', 'audio_note', 'daily_note', 'resource_view_state', 'wapp_activity_item')
          AND EXISTS (
            SELECT 1
            FROM flightdeck_pg_permission_grants pg
            WHERE pg.workspace_id = e.workspace_id
              AND pg.resource_type = 'channel'
              AND pg.resource_channel_id = e.channel_id
              AND pg.permission = 'channel.read'
              AND pg.revoked_at IS NULL
              AND (
                (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
                OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
              )
          )
        )
        OR (
          e.entity_type = 'daily_note'
          AND EXISTS (
            SELECT 1
            FROM flightdeck_pg_daily_notes n
            WHERE n.workspace_id = e.workspace_id
              AND n.id = e.entity_id
              AND n.deleted_at IS NULL
              AND (
                n.owner_actor_id = ${input.actorId}
                OR EXISTS (
                  SELECT 1
                  FROM flightdeck_pg_daily_scope_agent_access access
                  WHERE access.workspace_id = n.workspace_id
                    AND access.owner_actor_id = n.owner_actor_id
                    AND access.agent_actor_id = ${input.actorId}
                    AND access.can_read = true
                    AND access.revoked_at IS NULL
                )
              )
          )
        )
        OR (
          e.channel_id IS NULL
          AND ${includeWorkspaceEvents}
        )
      )
    ORDER BY e.row_version ASC, e.created_at ASC, e.id ASC
    LIMIT ${input.limit}
  `;
}

export type FlightDeckPgEventSubscriptionAudience = {
  actorId: string;
  npub: string;
  groupIds: string[];
  includeWorkspaceEvents: boolean;
};

export type FlightDeckPgEventSubscriptionRejection = {
  npub: string;
  code: 'inactive_or_unknown_workspace_member';
};

export type FlightDeckPgEventSubscriptionReconciliation = {
  audience: Array<{ actor_id: string; npub: string }>;
  rejectedAudience: FlightDeckPgEventSubscriptionRejection[];
};

export async function listFlightDeckPgEventSubscriptionAgents(
  input: { workspaceId: string; managerActorId: string },
  sql: DbClient = getDb(),
): Promise<Array<{ actor_id: string; npub: string }>> {
  return sql<Array<{ actor_id: string; npub: string }>>`
    SELECT actor.id AS actor_id, actor.npub
    FROM flightdeck_pg_event_subscription_agents authz
    JOIN flightdeck_pg_actors actor ON actor.id = authz.agent_actor_id
    JOIN flightdeck_pg_workspace_memberships membership
      ON membership.workspace_id = authz.workspace_id
     AND membership.actor_id = authz.agent_actor_id
    WHERE authz.workspace_id = ${input.workspaceId}
      AND authz.manager_actor_id = ${input.managerActorId}
    ORDER BY actor.npub ASC
  `;
}

export async function replaceFlightDeckPgEventSubscriptionAgents(
  input: { workspaceId: string; managerActorId: string; authorizedByActorId: string; agentNpubs: string[] },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgEventSubscriptionReconciliation> {
  return sql.begin(async (tx) => {
    const audience = input.agentNpubs.length === 0 ? [] : await tx<Array<{ actor_id: string; npub: string }>>`
      SELECT actor.id AS actor_id, actor.npub
      FROM flightdeck_pg_actors actor
      JOIN flightdeck_pg_workspace_memberships membership
        ON membership.actor_id = actor.id
       AND membership.workspace_id = ${input.workspaceId}
      WHERE actor.npub IN ${tx(input.agentNpubs)}
      ORDER BY actor.npub ASC
    `;
    const acceptedNpubs = new Set(audience.map((member) => member.npub));
    const rejectedAudience: FlightDeckPgEventSubscriptionRejection[] = input.agentNpubs
      .filter((npub) => !acceptedNpubs.has(npub))
      .map((npub) => ({ npub, code: 'inactive_or_unknown_workspace_member' }));
    await tx`
      DELETE FROM flightdeck_pg_event_subscription_agents
      WHERE workspace_id = ${input.workspaceId}
        AND manager_actor_id = ${input.managerActorId}
    `;
    for (const member of audience) {
      await tx`
        INSERT INTO flightdeck_pg_event_subscription_agents (
          workspace_id, manager_actor_id, agent_actor_id, authorized_by_actor_id
        ) VALUES (
          ${input.workspaceId}, ${input.managerActorId}, ${member.actor_id}, ${input.authorizedByActorId}
        )
      `;
    }
    return { audience, rejectedAudience };
  });
}

export async function listVisibleFlightDeckPgEventsForAudience(
  input: { workspaceId: string; audience: FlightDeckPgEventSubscriptionAudience[]; afterRowVersion: number; limit: number },
  sql: DbClient = getDb(),
): Promise<{ events: Array<{ event: FlightDeckPgOutboxEventRow; visibleToAgentNpubs: string[] }>; throughRowVersion: number }> {
  const scanned = await sql<Array<{ row_version: number }>>`
    SELECT row_version
    FROM flightdeck_pg_outbox_events
    WHERE workspace_id = ${input.workspaceId}
      AND row_version > ${input.afterRowVersion}
    ORDER BY row_version ASC, created_at ASC, id ASC
    LIMIT ${input.limit}
  `;
  const throughRowVersion = Number(scanned.at(-1)?.row_version ?? input.afterRowVersion);
  if (scanned.length === 0) return { events: [], throughRowVersion };
  const visibleByEvent = new Map<string, { event: FlightDeckPgOutboxEventRow; npubs: Set<string> }>();
  for (const member of input.audience) {
    const events = await listVisibleFlightDeckPgEvents({
      workspaceId: input.workspaceId,
      actorId: member.actorId,
      groupIds: member.groupIds,
      afterRowVersion: input.afterRowVersion,
      throughRowVersion,
      limit: input.limit,
      includeWorkspaceEvents: member.includeWorkspaceEvents,
    }, sql);
    for (const event of events) {
      const existing = visibleByEvent.get(event.id) ?? { event, npubs: new Set<string>() };
      existing.npubs.add(member.npub);
      visibleByEvent.set(event.id, existing);
    }
  }
  const events = [...visibleByEvent.values()]
    .sort((left, right) => left.event.row_version - right.event.row_version
      || left.event.created_at.getTime() - right.event.created_at.getTime()
      || left.event.id.localeCompare(right.event.id))
    .slice(0, input.limit)
    .map(({ event, npubs }) => ({ event, visibleToAgentNpubs: [...npubs].sort() }));
  return { events, throughRowVersion };
}

export async function createFlightDeckPgInvocation(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string;
    prompt: string;
    recipients: FlightDeckPgInvocationRecipient[];
    targets: FlightDeckPgInvocationTarget[];
    metadata?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgInvocationRow> {
  const [invocation] = await sql<FlightDeckPgInvocationRow[]>`
    INSERT INTO flightdeck_pg_invocations (
      workspace_id,
      scope_id,
      channel_id,
      created_by_actor_id,
      prompt,
      recipients,
      targets,
      metadata
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.prompt},
      ${sql.json(asDbJson(input.recipients))},
      ${sql.json(asDbJson(input.targets))},
      ${sql.json(asDbJson(input.metadata ?? {}))}
    )
    RETURNING *
  `;
  return invocation;
}

export async function resolveFlightDeckPgInvocation(
  workspaceId: string,
  invocationId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgInvocationRow | null> {
  const [invocation] = await sql<FlightDeckPgInvocationRow[]>`
    SELECT i.*, creator.npub AS created_by_actor_npub
    FROM flightdeck_pg_invocations i
    LEFT JOIN flightdeck_pg_actors creator ON creator.id = i.created_by_actor_id
    WHERE i.workspace_id = ${workspaceId}
      AND i.id = ${invocationId}
    LIMIT 1
  `;
  return invocation ?? null;
}

export async function listVisibleFlightDeckPgInvocations(
  input: {
    workspaceId: string;
    actorId: string;
    actorNpub: string;
    groupIds: string[];
    role?: 'recipient' | 'created_by' | 'visible' | 'all_visible';
    status?: FlightDeckPgInvocationStatus | null;
    recipientNpub?: string | null;
    createdByNpub?: string | null;
    targetType?: FlightDeckPgInvocationTargetType | null;
    targetId?: string | null;
    invocationId?: string | null;
    scopeId?: string | null;
    channelId?: string | null;
    updatedSince?: Date | null;
    limit: number;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgInvocationRow[]> {
  const groupIds = input.groupIds.length > 0 ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  const role = input.role ?? 'visible';
  const recipientFilter = input.recipientNpub?.trim() || null;
  const createdByFilter = input.createdByNpub?.trim() || null;
  const targetType = input.targetType ?? null;
  const targetId = input.targetId?.trim() || null;
  return sql<FlightDeckPgInvocationRow[]>`
    SELECT i.*, creator.npub AS created_by_actor_npub
    FROM flightdeck_pg_invocations i
    LEFT JOIN flightdeck_pg_actors creator ON creator.id = i.created_by_actor_id
    WHERE i.workspace_id = ${input.workspaceId}
      AND (${input.status ?? null}::text IS NULL OR i.status = ${input.status ?? null})
      AND (${input.invocationId ?? null}::uuid IS NULL OR i.id = ${input.invocationId ?? null})
      AND (${input.scopeId ?? null}::uuid IS NULL OR i.scope_id = ${input.scopeId ?? null})
      AND (${input.channelId ?? null}::uuid IS NULL OR i.channel_id = ${input.channelId ?? null})
      AND (${input.updatedSince ?? null}::timestamptz IS NULL OR i.updated_at > ${input.updatedSince ?? null})
      AND (${recipientFilter}::text IS NULL OR i.recipients @> ${sql.json(asDbJson([{ npub: recipientFilter }]))}::jsonb)
      AND (${createdByFilter}::text IS NULL OR creator.npub = ${createdByFilter})
      AND (${targetType}::text IS NULL OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(i.targets) AS target
        WHERE target->>'type' = ${targetType}
          AND (${targetId}::text IS NULL OR target->>'id' = ${targetId})
      ))
      AND (
        (${role} = 'created_by' AND i.created_by_actor_id = ${input.actorId})
        OR (${role} = 'recipient' AND i.recipients @> ${sql.json(asDbJson([{ npub: input.actorNpub }]))}::jsonb)
        OR (${role} IN ('visible', 'all_visible') AND EXISTS (
          SELECT 1
          FROM flightdeck_pg_permission_grants pg
          WHERE pg.workspace_id = i.workspace_id
            AND pg.resource_type = 'channel'
            AND pg.resource_channel_id = i.channel_id
            AND pg.permission = 'channel.read'
            AND pg.revoked_at IS NULL
            AND (
              (pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
              OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)})
            )
        ))
      )
    ORDER BY
      CASE WHEN ${input.updatedSince ?? null}::timestamptz IS NULL THEN i.updated_at END DESC,
      CASE WHEN ${input.updatedSince ?? null}::timestamptz IS NOT NULL THEN i.updated_at END ASC,
      i.id ASC
    LIMIT ${input.limit}
  `;
}

export async function createFlightDeckPgInvocationOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    invocation: FlightDeckPgInvocationRow;
    createdByNpub?: string | null;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      'flightdeck_pg.invocation.created',
      'invocation',
      ${input.invocation.id},
      'created',
      ${input.invocation.row_version},
      ${sql.json(asDbJson({
        invocation_id: input.invocation.id,
        prompt: input.invocation.prompt,
        recipients: normalizeInvocationRecipients(input.invocation.recipients),
        targets: normalizeInvocationTargets(input.invocation.targets),
        created_by_actor_id: input.invocation.created_by_actor_id,
        created_by_npub: input.createdByNpub ?? null,
        metadata: input.invocation.metadata ?? {},
      }))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function resolveFlightDeckPgTask(
  workspaceId: string,
  taskId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskRow | null> {
  const [task] = await sql<FlightDeckPgTaskRow[]>`
    SELECT *
    FROM flightdeck_pg_tasks
    WHERE workspace_id = ${workspaceId}
      AND id = ${taskId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return task ?? null;
}

export async function createFlightDeckPgTask(
  input: {
    workspaceId: string;
    channel: FlightDeckPgChannelRow;
    title: string;
    description?: string | null;
    state?: FlightDeckPgTaskState;
    priority?: FlightDeckPgTaskPriority;
    threadId?: string | null;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskRow> {
  const [task] = await sql<FlightDeckPgTaskRow[]>`
    INSERT INTO flightdeck_pg_tasks (
      workspace_id,
      scope_id,
      channel_id,
      thread_id,
      title,
      description,
      state,
      priority,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.channel.scope_id},
      ${input.channel.id},
      ${input.threadId ?? null},
      ${input.title},
      ${input.description ?? null},
      ${input.state ?? 'new'},
      ${input.priority ?? 'sand'},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  return task;
}

export async function updateFlightDeckPgTask(
  input: {
    workspaceId: string;
    taskId: string;
    actorId: string;
    rowVersion?: number | null;
    patch: {
      title?: string;
      description?: string | null;
      priority?: FlightDeckPgTaskPriority;
      metadata?: Record<string, unknown>;
    };
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskRow | null> {
  const [task] = await sql<FlightDeckPgTaskRow[]>`
    UPDATE flightdeck_pg_tasks
    SET
      title = COALESCE(${input.patch.title ?? null}, title),
      description = CASE
        WHEN ${input.patch.description !== undefined} THEN ${input.patch.description ?? null}
        ELSE description
      END,
      priority = COALESCE(${input.patch.priority ?? null}, priority),
      metadata = COALESCE(${input.patch.metadata === undefined ? null : sql.json(asDbJson(input.patch.metadata))}, metadata),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.taskId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return task ?? null;
}

export async function moveFlightDeckPgTask(
  input: {
    workspaceId: string;
    taskId: string;
    destinationChannel: FlightDeckPgChannelRow;
    actorId: string;
    rowVersion?: number | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskRow | null> {
  const [task] = await sql<FlightDeckPgTaskRow[]>`
    WITH moved_task AS (
      UPDATE flightdeck_pg_tasks
      SET
        scope_id = ${input.destinationChannel.scope_id},
        channel_id = ${input.destinationChannel.id},
        updated_by_actor_id = ${input.actorId},
        row_version = row_version + 1,
        updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.taskId}
        AND deleted_at IS NULL
        AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
      RETURNING *
    ), moved_comments AS (
      UPDATE flightdeck_pg_task_comments comments
      SET scope_id = moved_task.scope_id, channel_id = moved_task.channel_id
      FROM moved_task
      WHERE comments.workspace_id = moved_task.workspace_id AND comments.task_id = moved_task.id
      RETURNING comments.id
    ), moved_assignments AS (
      UPDATE flightdeck_pg_task_assignments assignments
      SET scope_id = moved_task.scope_id, channel_id = moved_task.channel_id
      FROM moved_task
      WHERE assignments.workspace_id = moved_task.workspace_id AND assignments.task_id = moved_task.id
      RETURNING assignments.task_id
    ), moved_watchers AS (
      UPDATE flightdeck_pg_task_watchers watchers
      SET scope_id = moved_task.scope_id, channel_id = moved_task.channel_id
      FROM moved_task
      WHERE watchers.workspace_id = moved_task.workspace_id AND watchers.task_id = moved_task.id
      RETURNING watchers.task_id
    ), moved_reactions AS (
      UPDATE flightdeck_pg_reactions reactions
      SET scope_id = moved_task.scope_id, channel_id = moved_task.channel_id
      FROM moved_task
      WHERE reactions.workspace_id = moved_task.workspace_id
        AND reactions.deleted_at IS NULL
        AND (
          (reactions.target_type = 'task' AND reactions.target_id = moved_task.id)
          OR (reactions.target_type = 'task_comment' AND reactions.target_id IN (SELECT id FROM moved_comments))
        )
      RETURNING reactions.id
    ), moved_activities AS (
      UPDATE flightdeck_pg_response_activities activities
      SET scope_id = moved_task.scope_id, channel_id = moved_task.channel_id
      FROM moved_task
      WHERE activities.workspace_id = moved_task.workspace_id AND activities.task_id = moved_task.id
      RETURNING activities.id
    ), moved_view_states AS (
      UPDATE flightdeck_pg_resource_view_states states
      SET
        scope_id = moved_task.scope_id,
        channel_id = moved_task.channel_id,
        row_version = states.row_version + 1,
        updated_at = NOW()
      FROM moved_task
      WHERE states.workspace_id = moved_task.workspace_id
        AND states.resource_type = 'task'
        AND states.resource_id = moved_task.id
      RETURNING states.resource_id
    )
    SELECT * FROM moved_task
  `;
  return task ?? null;
}

export async function updateFlightDeckPgTaskState(
  input: { workspaceId: string; taskId: string; actorId: string; state: FlightDeckPgTaskState; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskRow | null> {
  const [task] = await sql<FlightDeckPgTaskRow[]>`
    UPDATE flightdeck_pg_tasks
    SET
      state = ${input.state},
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.taskId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return task ?? null;
}

export async function deleteFlightDeckPgTask(
  input: { workspaceId: string; taskId: string; actorId: string; rowVersion?: number | null },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskRow | null> {
  const [task] = await sql<FlightDeckPgTaskRow[]>`
    UPDATE flightdeck_pg_tasks
    SET
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.taskId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return task ?? null;
}

export async function createFlightDeckPgTaskComment(
  input: {
    workspaceId: string;
    task: FlightDeckPgTaskRow;
    body: string;
    threadId?: string | null;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskCommentRow> {
  const [comment] = await sql<FlightDeckPgTaskCommentRow[]>`
    INSERT INTO flightdeck_pg_task_comments (
      workspace_id,
      scope_id,
      channel_id,
      task_id,
      thread_id,
      body,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.task.scope_id},
      ${input.task.channel_id},
      ${input.task.id},
      ${input.threadId ?? input.task.thread_id},
      ${input.body},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  return comment;
}

export async function listFlightDeckPgTaskComments(
  input: { workspaceId: string; taskId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskCommentRow[]> {
  return sql<FlightDeckPgTaskCommentRow[]>`
    SELECT
      tc.*,
      creator.npub AS created_by_actor_npub
    FROM flightdeck_pg_task_comments tc
    LEFT JOIN flightdeck_pg_actors creator ON creator.id = tc.created_by_actor_id
    WHERE tc.workspace_id = ${input.workspaceId}
      AND tc.task_id = ${input.taskId}
      AND tc.deleted_at IS NULL
    ORDER BY tc.created_at ASC, tc.id ASC
    LIMIT ${input.limit}
  `;
}

export async function createFlightDeckPgDocComment(
  input: {
    workspaceId: string;
    doc: FlightDeckPgDocRow;
    body: string;
    parentCommentId?: string | null;
    metadata?: Record<string, unknown>;
    actorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocCommentRow> {
  const [comment] = await sql<FlightDeckPgDocCommentRow[]>`
    INSERT INTO flightdeck_pg_doc_comments (
      workspace_id,
      scope_id,
      channel_id,
      doc_id,
      parent_comment_id,
      body,
      metadata,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.doc.scope_id},
      ${input.doc.channel_id},
      ${input.doc.id},
      ${input.parentCommentId ?? null},
      ${input.body},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.actorId},
      ${input.actorId}
    )
    RETURNING *
  `;
  return comment;
}

export async function resolveFlightDeckPgDocComment(
  workspaceId: string,
  docId: string,
  commentId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocCommentRow | null> {
  const [comment] = await sql<FlightDeckPgDocCommentRow[]>`
    SELECT
      dc.*,
      creator.npub AS created_by_actor_npub
    FROM flightdeck_pg_doc_comments dc
    LEFT JOIN flightdeck_pg_actors creator ON creator.id = dc.created_by_actor_id
    WHERE dc.workspace_id = ${workspaceId}
      AND dc.doc_id = ${docId}
      AND dc.id = ${commentId}
      AND dc.deleted_at IS NULL
    LIMIT 1
  `;
  return comment ?? null;
}

export async function updateFlightDeckPgDocComment(
  input: {
    workspaceId: string;
    docId: string;
    commentId: string;
    actorId: string;
    metadata?: Record<string, unknown>;
    rowVersion?: number | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocCommentRow | null> {
  const [comment] = await sql<FlightDeckPgDocCommentRow[]>`
    UPDATE flightdeck_pg_doc_comments
    SET
      metadata = ${sql.json(asDbJson(input.metadata ?? {}))},
      updated_by_actor_id = ${input.actorId},
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND doc_id = ${input.docId}
      AND id = ${input.commentId}
      AND deleted_at IS NULL
      AND (${input.rowVersion ?? null}::bigint IS NULL OR row_version = ${input.rowVersion ?? null})
    RETURNING *
  `;
  return comment ?? null;
}

export async function deleteFlightDeckPgDocComment(
  input: {
    workspaceId: string;
    docId: string;
    commentId: string;
    actorId: string;
    rowVersion?: number | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocCommentRow | null> {
  const [comment] = await sql<FlightDeckPgDocCommentRow[]>`
    SELECT *
    FROM flightdeck_pg_doc_comments
    WHERE workspace_id = ${input.workspaceId}
      AND doc_id = ${input.docId}
      AND id = ${input.commentId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!comment) return null;
  if (input.rowVersion && comment.row_version !== input.rowVersion) return null;

  await sql`
    UPDATE flightdeck_pg_doc_comments
    SET
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND doc_id = ${input.docId}
      AND deleted_at IS NULL
      AND (id = ${input.commentId} OR parent_comment_id = ${input.commentId})
  `;
  const [deleted] = await sql<FlightDeckPgDocCommentRow[]>`
    SELECT *
    FROM flightdeck_pg_doc_comments
    WHERE workspace_id = ${input.workspaceId}
      AND doc_id = ${input.docId}
      AND id = ${input.commentId}
      AND deleted_at IS NOT NULL
    LIMIT 1
  `;
  return deleted ?? null;
}

export async function listFlightDeckPgDocComments(
  input: { workspaceId: string; docId: string; limit: number },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgDocCommentRow[]> {
  return sql<FlightDeckPgDocCommentRow[]>`
    SELECT
      dc.*,
      creator.npub AS created_by_actor_npub
    FROM flightdeck_pg_doc_comments dc
    LEFT JOIN flightdeck_pg_actors creator ON creator.id = dc.created_by_actor_id
    WHERE dc.workspace_id = ${input.workspaceId}
      AND dc.doc_id = ${input.docId}
      AND dc.deleted_at IS NULL
    ORDER BY dc.created_at ASC, dc.id ASC
    LIMIT ${input.limit}
  `;
}

export async function assignFlightDeckPgTask(
  input: { workspaceId: string; task: FlightDeckPgTaskRow; actorId: string; assigneeActorId: string },
  sql: DbClient = getDb(),
): Promise<{ assignment: FlightDeckPgTaskAssignmentWithActorNpub; changed: boolean }> {
  const [existing] = await sql<FlightDeckPgTaskAssignmentRow[]>`
    SELECT *
    FROM flightdeck_pg_task_assignments
    WHERE workspace_id = ${input.workspaceId}
      AND task_id = ${input.task.id}
      AND actor_id = ${input.assigneeActorId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing) {
    const hydratedExisting = (await listFlightDeckPgTaskAssignments({ workspaceId: input.workspaceId, taskId: input.task.id }, sql))
      .find((item) => item.actor_id === input.assigneeActorId);
    if (!hydratedExisting) throw new Error('Task assignment actor identity could not be resolved');
    return { assignment: hydratedExisting, changed: false };
  }

  const [assignment] = await sql<FlightDeckPgTaskAssignmentRow[]>`
    INSERT INTO flightdeck_pg_task_assignments (
      workspace_id,
      scope_id,
      channel_id,
      task_id,
      actor_id,
      created_by_actor_id,
      updated_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${input.task.scope_id},
      ${input.task.channel_id},
      ${input.task.id},
      ${input.assigneeActorId},
      ${input.actorId},
      ${input.actorId}
    )
    ON CONFLICT (task_id, actor_id)
    DO UPDATE SET
      deleted_at = NULL,
      updated_by_actor_id = EXCLUDED.updated_by_actor_id,
      row_version = flightdeck_pg_task_assignments.row_version + 1,
      updated_at = NOW()
    WHERE flightdeck_pg_task_assignments.deleted_at IS NOT NULL
    RETURNING *
  `;
  if (assignment) {
    const created = (await listFlightDeckPgTaskAssignments({ workspaceId: input.workspaceId, taskId: input.task.id }, sql))
      .find((item) => item.actor_id === input.assigneeActorId);
    if (!created) throw new Error('Task assignment actor identity could not be resolved');
    return { assignment: created, changed: true };
  }

  const [active] = await sql<FlightDeckPgTaskAssignmentRow[]>`
    SELECT *
    FROM flightdeck_pg_task_assignments
    WHERE workspace_id = ${input.workspaceId}
      AND task_id = ${input.task.id}
      AND actor_id = ${input.assigneeActorId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (active) {
    const hydratedActive = (await listFlightDeckPgTaskAssignments({ workspaceId: input.workspaceId, taskId: input.task.id }, sql))
      .find((item) => item.actor_id === input.assigneeActorId);
    if (!hydratedActive) throw new Error('Task assignment actor identity could not be resolved');
    return { assignment: hydratedActive, changed: false };
  }
  throw new Error('Task assignment could not be created');
}

export async function unassignFlightDeckPgTask(
  input: { workspaceId: string; task: FlightDeckPgTaskRow; actorId: string; assigneeActorId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgTaskAssignmentWithActorNpub | null> {
  const [assignment] = await sql<FlightDeckPgTaskAssignmentWithActorNpub[]>`
    UPDATE flightdeck_pg_task_assignments
    SET
      deleted_at = NOW(),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND task_id = ${input.task.id}
      AND actor_id = ${input.assigneeActorId}
      AND deleted_at IS NULL
    RETURNING *
  `;
  if (!assignment) return null;
  const [actor] = await sql<{ npub: string | null }[]>`
    SELECT npub
    FROM flightdeck_pg_actors
    WHERE id = ${assignment.actor_id}
    LIMIT 1
  `;
  return {
    ...assignment,
    actor_npub: actor?.npub ?? null,
  };
}

type FlightDeckPgResourceActivityRow = {
  resource_type: FlightDeckPgResourceViewStateType;
  resource_id: string;
  scope_id: string;
  channel_id: string;
  activity_version: number;
};

async function insertVisibleFlightDeckPgResourceViewStateBaseline(
  input: { workspaceId: string; actorId: string; groupIds: string[] },
  sql: DbClient,
): Promise<boolean> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-view-state:${input.workspaceId}:${input.actorId}`}, 0))`;
  const inserted = await sql<{ viewer_actor_id: string }[]>`
    INSERT INTO flightdeck_pg_resource_view_state_rollouts (workspace_id, viewer_actor_id)
    VALUES (${input.workspaceId}, ${input.actorId})
    ON CONFLICT DO NOTHING
    RETURNING viewer_actor_id
  `;
  if (inserted.length === 0) return false;
  const groupIds = input.groupIds.length ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  await sql`
    INSERT INTO flightdeck_pg_resource_view_states (
      workspace_id, viewer_actor_id, resource_type, resource_id, scope_id, channel_id, viewed_activity_version
    )
    SELECT ${input.workspaceId}, ${input.actorId}, visible.resource_type, visible.resource_id,
      visible.scope_id, visible.channel_id, visible.activity_version
    FROM (
      SELECT 'thread'::text AS resource_type, t.id AS resource_id, t.scope_id, t.channel_id, t.activity_version
      FROM flightdeck_pg_threads t
      WHERE t.workspace_id = ${input.workspaceId} AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND EXISTS (
          SELECT 1 FROM flightdeck_pg_permission_grants pg
          WHERE pg.workspace_id = t.workspace_id AND pg.resource_type = 'channel'
            AND pg.resource_channel_id = t.channel_id AND pg.permission = 'channel.read' AND pg.revoked_at IS NULL
            AND ((pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
              OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)}))
        )
      UNION ALL
      SELECT 'task', t.id, t.scope_id, t.channel_id, t.activity_version
      FROM flightdeck_pg_tasks t
      WHERE t.workspace_id = ${input.workspaceId} AND t.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM flightdeck_pg_permission_grants pg
          WHERE pg.workspace_id = t.workspace_id AND pg.resource_type = 'channel'
            AND pg.resource_channel_id = t.channel_id AND pg.permission IN ('task.read', 'channel.read') AND pg.revoked_at IS NULL
            AND ((pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
              OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)}))
        )
      UNION ALL
      SELECT 'document', d.id, d.scope_id, d.channel_id, d.activity_version
      FROM flightdeck_pg_docs d
      WHERE d.workspace_id = ${input.workspaceId} AND d.deleted_at IS NULL AND d.archived_at IS NULL
        AND EXISTS (
          SELECT 1 FROM flightdeck_pg_permission_grants pg
          WHERE pg.workspace_id = d.workspace_id AND pg.resource_type = 'channel'
            AND pg.resource_channel_id = d.channel_id AND pg.permission IN ('doc.read', 'channel.read') AND pg.revoked_at IS NULL
            AND ((pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
              OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groupIds)}))
        )
    ) visible
    ON CONFLICT DO NOTHING
  `;
  return true;
}

export async function listVisibleFlightDeckPgResourceViewStates(
  input: {
    workspaceId: string;
    actorId: string;
    groupIds: string[];
    resourceType?: FlightDeckPgResourceViewStateType | null;
    channelId?: string | null;
    after?: { resourceType: FlightDeckPgResourceViewStateType; resourceId: string } | null;
    limit: number;
  },
  sql: DbClient = getDb(),
): Promise<{ states: Array<FlightDeckPgResourceViewState & { activity_version: number }>; baselineCreated: boolean }> {
  const run = async (client: DbClient) => {
    const baselineCreated = await insertVisibleFlightDeckPgResourceViewStateBaseline(input, client);
    const groupIds = input.groupIds.length ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
    const states = await client<Array<FlightDeckPgResourceViewState & { activity_version: number }>>`
      WITH visible AS (
        SELECT 'thread'::text AS resource_type, t.id AS resource_id, t.scope_id, t.channel_id, t.activity_version, t.created_at, t.updated_at
        FROM flightdeck_pg_threads t
        WHERE t.workspace_id = ${input.workspaceId} AND t.deleted_at IS NULL AND t.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM flightdeck_pg_permission_grants pg WHERE pg.workspace_id=t.workspace_id AND pg.resource_channel_id=t.channel_id AND pg.resource_type='channel' AND pg.permission='channel.read' AND pg.revoked_at IS NULL AND ((pg.principal_type='actor' AND pg.principal_actor_id=${input.actorId}) OR (pg.principal_type='group' AND pg.principal_group_id IN ${client(groupIds)})))
        UNION ALL
        SELECT 'task', t.id, t.scope_id, t.channel_id, t.activity_version, t.created_at, t.updated_at FROM flightdeck_pg_tasks t
        WHERE t.workspace_id=${input.workspaceId} AND t.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM flightdeck_pg_permission_grants pg WHERE pg.workspace_id=t.workspace_id AND pg.resource_channel_id=t.channel_id AND pg.resource_type='channel' AND pg.permission IN ('task.read','channel.read') AND pg.revoked_at IS NULL AND ((pg.principal_type='actor' AND pg.principal_actor_id=${input.actorId}) OR (pg.principal_type='group' AND pg.principal_group_id IN ${client(groupIds)})))
        UNION ALL
        SELECT 'document', d.id, d.scope_id, d.channel_id, d.activity_version, d.created_at, d.updated_at FROM flightdeck_pg_docs d
        WHERE d.workspace_id=${input.workspaceId} AND d.deleted_at IS NULL AND d.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM flightdeck_pg_permission_grants pg WHERE pg.workspace_id=d.workspace_id AND pg.resource_channel_id=d.channel_id AND pg.resource_type='channel' AND pg.permission IN ('doc.read','channel.read') AND pg.revoked_at IS NULL AND ((pg.principal_type='actor' AND pg.principal_actor_id=${input.actorId}) OR (pg.principal_type='group' AND pg.principal_group_id IN ${client(groupIds)})))
      )
      SELECT
        ${input.workspaceId}::uuid AS workspace_id,
        ${input.actorId}::uuid AS viewer_actor_id,
        v.resource_type,
        v.resource_id,
        v.scope_id,
        v.channel_id,
        COALESCE(s.viewed_activity_version, 0) AS viewed_activity_version,
        COALESCE(s.row_version, 0) AS row_version,
        COALESCE(s.created_at, v.created_at) AS created_at,
        COALESCE(s.updated_at, v.updated_at) AS updated_at,
        v.activity_version
      FROM visible v
      LEFT JOIN flightdeck_pg_resource_view_states s
        ON s.workspace_id=${input.workspaceId} AND s.viewer_actor_id=${input.actorId}
        AND s.resource_type=v.resource_type AND s.resource_id=v.resource_id
      WHERE (${input.resourceType ?? null}::text IS NULL OR v.resource_type=${input.resourceType ?? null})
        AND (${input.channelId ?? null}::uuid IS NULL OR v.channel_id=${input.channelId ?? null})
        AND (${input.after?.resourceType ?? null}::text IS NULL OR (v.resource_type, v.resource_id) > (${input.after?.resourceType ?? null}::text, ${input.after?.resourceId ?? null}::uuid))
      ORDER BY v.resource_type ASC, v.resource_id ASC
      LIMIT ${input.limit}
    `;
    return { states, baselineCreated };
  };
  if (sql !== getDb()) return run(sql);
  return getDb().begin(async (tx) => run(tx as unknown as DbClient));
}

export async function resolveFlightDeckPgResourceActivity(
  workspaceId: string,
  resourceType: FlightDeckPgResourceViewStateType,
  resourceId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgResourceActivityRow | null> {
  const rows = resourceType === 'thread'
    ? await sql<FlightDeckPgResourceActivityRow[]>`SELECT 'thread'::text AS resource_type, id AS resource_id, scope_id, channel_id, activity_version FROM flightdeck_pg_threads WHERE workspace_id=${workspaceId} AND id=${resourceId} AND deleted_at IS NULL AND archived_at IS NULL`
    : resourceType === 'task'
      ? await sql<FlightDeckPgResourceActivityRow[]>`SELECT 'task'::text AS resource_type, id AS resource_id, scope_id, channel_id, activity_version FROM flightdeck_pg_tasks WHERE workspace_id=${workspaceId} AND id=${resourceId} AND deleted_at IS NULL`
      : await sql<FlightDeckPgResourceActivityRow[]>`SELECT 'document'::text AS resource_type, id AS resource_id, scope_id, channel_id, activity_version FROM flightdeck_pg_docs WHERE workspace_id=${workspaceId} AND id=${resourceId} AND deleted_at IS NULL AND archived_at IS NULL`;
  return rows[0] ?? null;
}

export async function markFlightDeckPgResourceViewed(
  input: { workspaceId: string; actorId: string; resource: FlightDeckPgResourceActivityRow; viewedActivityVersion: number },
  sql: DbClient = getDb(),
): Promise<{ state: FlightDeckPgResourceViewState; changed: boolean }> {
  const [existing] = await sql<FlightDeckPgResourceViewState[]>`
    SELECT * FROM flightdeck_pg_resource_view_states
    WHERE workspace_id=${input.workspaceId} AND viewer_actor_id=${input.actorId}
      AND resource_type=${input.resource.resource_type} AND resource_id=${input.resource.resource_id}
    FOR UPDATE
  `;
  if (existing && Number(existing.viewed_activity_version) >= input.viewedActivityVersion) {
    return { state: existing, changed: false };
  }
  const [state] = await sql<FlightDeckPgResourceViewState[]>`
    INSERT INTO flightdeck_pg_resource_view_states (
      workspace_id, viewer_actor_id, resource_type, resource_id, scope_id, channel_id, viewed_activity_version
    ) VALUES (
      ${input.workspaceId}, ${input.actorId}, ${input.resource.resource_type}, ${input.resource.resource_id},
      ${input.resource.scope_id}, ${input.resource.channel_id}, ${input.viewedActivityVersion}
    )
    ON CONFLICT (workspace_id, viewer_actor_id, resource_type, resource_id) DO UPDATE SET
      scope_id=EXCLUDED.scope_id,
      channel_id=EXCLUDED.channel_id,
      viewed_activity_version=GREATEST(flightdeck_pg_resource_view_states.viewed_activity_version, EXCLUDED.viewed_activity_version),
      row_version=CASE WHEN EXCLUDED.viewed_activity_version > flightdeck_pg_resource_view_states.viewed_activity_version THEN flightdeck_pg_resource_view_states.row_version + 1 ELSE flightdeck_pg_resource_view_states.row_version END,
      updated_at=CASE WHEN EXCLUDED.viewed_activity_version > flightdeck_pg_resource_view_states.viewed_activity_version THEN NOW() ELSE flightdeck_pg_resource_view_states.updated_at END
    RETURNING *
  `;
  return { state, changed: true };
}

export async function advanceFlightDeckPgResourceActivity(
  input: { workspaceId: string; actorId: string; resourceType: FlightDeckPgResourceViewStateType; resourceId: string },
  sql: DbClient = getDb(),
): Promise<{ resource: FlightDeckPgResourceActivityRow; state: FlightDeckPgResourceViewState }> {
  const rows = input.resourceType === 'thread'
    ? await sql<FlightDeckPgResourceActivityRow[]>`UPDATE flightdeck_pg_threads SET activity_version=activity_version+1 WHERE workspace_id=${input.workspaceId} AND id=${input.resourceId} AND deleted_at IS NULL RETURNING 'thread'::text AS resource_type, id AS resource_id, scope_id, channel_id, activity_version`
    : input.resourceType === 'task'
      ? await sql<FlightDeckPgResourceActivityRow[]>`UPDATE flightdeck_pg_tasks SET activity_version=activity_version+1 WHERE workspace_id=${input.workspaceId} AND id=${input.resourceId} AND deleted_at IS NULL RETURNING 'task'::text AS resource_type, id AS resource_id, scope_id, channel_id, activity_version`
      : await sql<FlightDeckPgResourceActivityRow[]>`UPDATE flightdeck_pg_docs SET activity_version=activity_version+1 WHERE workspace_id=${input.workspaceId} AND id=${input.resourceId} AND deleted_at IS NULL RETURNING 'document'::text AS resource_type, id AS resource_id, scope_id, channel_id, activity_version`;
  const resource = rows[0];
  if (!resource) throw new Error('resource not found while advancing activity');
  const marked = await markFlightDeckPgResourceViewed({ workspaceId: input.workspaceId, actorId: input.actorId, resource, viewedActivityVersion: Number(resource.activity_version) }, sql);
  return { resource, state: marked.state };
}

export async function createFlightDeckPgResourceViewStateOutboxEvent(
  input: { workspaceId: string; actorId: string; state: FlightDeckPgResourceViewState; activityVersion: number },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (workspace_id, scope_id, channel_id, actor_id, event_type, entity_type, entity_id, operation, entity_row_version, payload)
    VALUES (${input.workspaceId}, ${input.state.scope_id}, ${input.state.channel_id}, ${input.actorId},
      'flightdeck_pg.resource_view_state.updated', 'resource_view_state', ${input.state.resource_id}, 'updated', ${input.state.row_version},
      ${sql.json(asDbJson({ viewer_actor_id: input.actorId, resource_type: input.state.resource_type, resource_id: input.state.resource_id, activity_version: input.activityVersion, viewed_activity_version: Number(input.state.viewed_activity_version), row_version: input.state.row_version }))})
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgTaskOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    eventType: string;
    entityType: 'task' | 'task_comment' | 'task_assignment' | 'task_watcher';
    entityId: string | null;
    operation: 'created' | 'updated' | 'deleted' | 'assigned' | 'unassigned' | 'watched' | 'unwatched';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.eventType},
      ${input.entityType},
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgChatOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    eventType: string;
    entityType: 'message' | 'thread';
    entityId: string | null;
    operation: 'created' | 'updated' | 'deleted';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.eventType},
      ${input.entityType},
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgChannelOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    eventType: string;
    entityId: string;
    operation: 'updated';
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id, scope_id, channel_id, actor_id, event_type,
      entity_type, entity_id, operation, entity_row_version, payload
    ) VALUES (
      ${input.workspaceId}, ${input.scopeId}, ${input.channelId}, ${input.actorId}, ${input.eventType},
      'channel', ${input.entityId}, ${input.operation}, NULL, ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgWorkroomOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    eventType: string;
    entityType: 'workroom' | 'workroom_event' | 'workroom_link' | 'workroom_participant';
    entityId: string | null;
    operation: string;
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.eventType},
      ${input.entityType},
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgDocOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    eventType: string;
    entityType?: 'doc' | 'doc_comment';
    entityId: string | null;
    operation: 'created' | 'updated' | 'deleted';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.eventType},
      ${input.entityType ?? 'doc'},
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgFileOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    eventType: string;
    entityId: string | null;
    operation: 'created' | 'updated' | 'deleted';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.eventType},
      'file',
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgFileFolderOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    eventType: string;
    entityId: string | null;
    operation: 'created' | 'updated' | 'deleted';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.eventType},
      'file_folder',
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgAudioNoteOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    eventType: string;
    entityId: string | null;
    operation: 'created' | 'updated' | 'deleted';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.eventType},
      'audio_note',
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgDailyNoteOutboxEvent(
  input: {
    workspaceId: string;
    scopeId?: string | null;
    channelId?: string | null;
    actorId: string | null;
    eventType: string;
    entityId: string | null;
    operation: 'created' | 'updated' | 'deleted';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId ?? null},
      ${input.channelId ?? null},
      ${input.actorId},
      ${input.eventType},
      'daily_note',
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgPersonalWappOutboxEvent(
  input: {
    workspaceId: string;
    scopeId?: string | null;
    channelId?: string | null;
    actorId: string | null;
    eventType: string;
    entityId: string | null;
    operation: 'created' | 'updated' | 'deleted';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId ?? null},
      ${input.channelId ?? null},
      ${input.actorId},
      ${input.eventType},
      'personal_wapp',
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgReactionOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string | null;
    eventType: string;
    entityId: string | null;
    operation: 'created' | 'deleted';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.eventType},
      'reaction',
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgResponseActivityOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string | null;
    channelId: string | null;
    actorId: string | null;
    eventType: string;
    entityId: string | null;
    operation: 'upserted' | 'cleared' | 'expired';
    entityRowVersion: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id,
      scope_id,
      channel_id,
      actor_id,
      event_type,
      entity_type,
      entity_id,
      operation,
      entity_row_version,
      payload
    )
    VALUES (
      ${input.workspaceId},
      ${input.scopeId},
      ${input.channelId},
      ${input.actorId},
      ${input.eventType},
      'response_activity',
      ${input.entityId},
      ${input.operation},
      ${input.entityRowVersion},
      ${sql.json(asDbJson(input.payload ?? {}))}
    )
    RETURNING id, row_version
  `;
  return event;
}

export async function createFlightDeckPgAgentActivityOutboxEvent(
  input: {
    workspaceId: string;
    scopeId: string;
    channelId: string;
    actorId: string;
    entityId: string;
    operation: 'created' | 'updated';
    sequence: number;
    payload: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id, scope_id, channel_id, actor_id, event_type, entity_type,
      entity_id, operation, entity_row_version, payload
    ) VALUES (
      ${input.workspaceId}, ${input.scopeId}, ${input.channelId}, ${input.actorId},
      'flightdeck_pg.agent_activity.snapshot', 'agent_activity', ${input.entityId},
      ${input.operation}, ${input.sequence}, ${sql.json(asDbJson(input.payload))}
    )
    RETURNING id, row_version
  `;
  return event;
}
