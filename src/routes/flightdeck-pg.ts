import { Hono } from 'hono';
import type { Context } from 'hono';
import { createHash } from 'crypto';
import { getEffectiveRequestUrl, requireNip98AuthResolved, resolveNip98AuthHeader } from '../auth';
import { getTowerBuildInfo } from '../build-info';
import { config } from '../config';
import { getDb } from '../db';
import { getTowerProfile } from '../services/tower-profile';
import { evaluateWappManagement, WappManagementError } from '../services/wapp-management';
import {
  getStorageDownloadUrl,
  getStorageObject,
  getStorageObjectContent,
  getStorageUploadUrl,
  prepareStorageObjectForAuthorizedOwner,
} from '../services/storage';
import {
  authorizeFlightDeckPgOperation,
  createFlightDeckPgNestedGroupEdge,
  getFlightDeckPgWorkspaceMembership,
  resolveFlightDeckPgActorByNpub,
  updateFlightDeckPgActorDisplayName,
  type FlightDeckPgActor,
  type FlightDeckPgAuthorizationDecision,
} from '../services/flightdeck-pg-authorization';
import {
  authorizeFlightDeckPgStorageAttach,
  authorizeFlightDeckPgStorageRead,
  createFlightDeckPgStorageLink,
  resolveFlightDeckPgStorageLink,
  syncFlightDeckPgMessageAttachmentLinks,
  validateFlightDeckPgMessageAttachmentObjects,
  resolveReadableFlightDeckPgStorageObject,
  tombstoneFlightDeckPgStorageLinksForEntity,
} from '../services/flightdeck-pg-storage-access';
import {
  AGENT_INSTRUCTION_SIGNATURE_METADATA_KEY,
  validateFlightDeckPgMessageInstructionSignature,
} from '../services/flightdeck-pg-message-signatures';
import {
  AgentIdentityRotationError,
  rotateFlightDeckPgAgentIdentity,
  type AgentIdentityRotationProof,
} from '../services/flightdeck-pg-identity-rotation';
import {
  deriveFlightDeckPgThreadTitle,
  validateFlightDeckPgThreadTitle,
} from '../services/flightdeck-pg-thread-titles';
import {
  evaluateFlightDeckPgNotificationOutboxEvent,
  getFlightDeckPgNotificationPreferences,
  getFlightDeckPgVapidPublicKey,
  listFlightDeckPgNotificationDeliveries,
  listFlightDeckPgPushSubscriptionsForActor,
  revokeFlightDeckPgPushSubscription,
  updateFlightDeckPgNotificationPreferences,
  upsertFlightDeckPgPushSubscription,
} from '../services/flightdeck-pg-notifications';
import {
  buildFlightDeckPgIdentity,
  acquireFlightDeckPgEditLease,
  archiveFlightDeckPgChannel,
  archiveFlightDeckPgScope,
  actorCanAccessFlightDeckPgDailyScope,
  advanceFlightDeckPgResourceActivity,
  assignFlightDeckPgTask,
  addFlightDeckPgGroupMember,
  attachFlightDeckPgThreadSourceMessage,
  createFlightDeckPgChannel,
  createFlightDeckPgChannelGrants,
  createFlightDeckPgChannelOutboxEvent,
  createFlightDeckPgChatOutboxEvent,
  createFlightDeckPgDoc,
  createFlightDeckPgDocComment,
  createFlightDeckPgDocOutboxEvent,
  decideFlightDeckPgDocBodySave,
  discardFlightDeckPgDocRecoveryVersion,
  createFlightDeckPgDailyNoteOutboxEvent,
  createFlightDeckPgPersonalWappOutboxEvent,
  createFlightDeckPgFile,
  createFlightDeckPgFileFolder,
  createFlightDeckPgFileFolderOutboxEvent,
  createFlightDeckPgFileOutboxEvent,
  createFlightDeckPgInvocation,
  createFlightDeckPgInvocationOutboxEvent,
  createFlightDeckPgAudioNote,
  createFlightDeckPgAudioNoteOutboxEvent,
  createFlightDeckPgActorProfileOutboxEvent,
  createFlightDeckPgPersonalAgentSettingsOutboxEvent,
  createFlightDeckPgMessage,
  createFlightDeckPgReaction,
  createFlightDeckPgReactionOutboxEvent,
  createFlightDeckPgResponseActivityOutboxEvent,
  createFlightDeckPgResourceViewStateOutboxEvent,
  createFlightDeckPgAgentActivityOutboxEvent,
  createFlightDeckPgGroup,
  createFlightDeckPgScope,
  createFlightDeckPgTask,
  createFlightDeckPgTaskComment,
  createFlightDeckPgTaskOutboxEvent,
  createFlightDeckPgThread,
  createFlightDeckPgTypedApproval,
  createFlightDeckPgWorkroom,
  createFlightDeckPgWorkroomEvent,
  createFlightDeckPgWorkroomLink,
  createFlightDeckPgWorkroomOutboxEvent,
  createFlightDeckPgWorkroomParticipant,
  createFlightDeckPgWorkspaceMember,
  decideFlightDeckPgTypedApproval,
  deleteFlightDeckPgDoc,
  deleteFlightDeckPgDocComment,
  deleteFlightDeckPgFile,
  deleteFlightDeckPgFileFolder,
  deleteFlightDeckPgMessage,
  deleteFlightDeckPgTask,
  deleteFlightDeckPgThread,
  deleteFlightDeckPgReaction,
  decodeFlightDeckPgEventCursor,
  encodeFlightDeckPgEventCursor,
  flightDeckPgCapabilities,
  flightDeckPgCanonicalDocVersionId,
  flightDeckPgManagePermissions,
  flightDeckPgPermissionsForAccessLevel,
  flightDeckPgWorkspaceCapabilities,
  getActiveFlightDeckPgEditLease,
  getFlightDeckPgPersonalAgentSettings,
  listEffectiveFlightDeckPgGroupMembers,
  listFlightDeckPgGroupMembers,
  listFlightDeckPgGroups,
  listFlightDeckPgDailyScopeAgentAccess,
  listFlightDeckPgPersonalWapps,
  listFlightDeckPgWorkspaceMembers,
  normalizeFlightDeckPgPersonalWappSignerMetadata,
  listFlightDeckPgChannelTasks,
  listFlightDeckPgDailyNotes,
  listFlightDeckPgDailyNoteVersions,
  listFlightDeckPgChannelAudioNotes,
  listFlightDeckPgChannelDocs,
  listFlightDeckPgChannelFiles,
  listFlightDeckPgChannelFileFolders,
  listFlightDeckPgFileVersions,
  listFlightDeckPgDriveTree,
  listFlightDeckPgChannelMessages,
  listFlightDeckPgChannelThreads,
  listFlightDeckPgDocVersions,
  listFlightDeckPgDocRecoveryVersions,
  listFlightDeckPgDocComments,
  listVisibleFlightDeckPgInvocations,
  listVisibleFlightDeckPgResourceViewStates,
  listFlightDeckPgReactionsForTarget,
  listFlightDeckPgResponseActivities,
  listFlightDeckPgAgentActivities,
  listVisibleFlightDeckPgEvents,
  listVisibleFlightDeckPgEventsForAudience,
  listFlightDeckPgEventSubscriptionAgents,
  listVisibleFlightDeckPgDriveEvents,
  listFlightDeckPgWorkspacesForActor,
  isFlightDeckPgChannelPermission,
  isFlightDeckPgThreadParticipant,
  isFlightDeckPgStandardAccessLevel,
  listFlightDeckPgChannelGrants,
  listFlightDeckPgTaskComments,
  listFlightDeckPgTypedApprovals,
  listFlightDeckPgWorkroomEvents,
  listFlightDeckPgWorkroomLinks,
  listFlightDeckPgWorkroomParticipants,
  listVisibleFlightDeckPgScopeTasks,
  listVisibleFlightDeckPgWorkrooms,
  listVisibleFlightDeckPgChannels,
  listVisibleFlightDeckPgScopes,
  moveFlightDeckPgDoc,
  promoteFlightDeckPgDocRecoveryVersion,
  moveFlightDeckPgTask,
  searchVisibleFlightDeckPgRecords,
  resolveFlightDeckPgAudioNote,
  resolveFlightDeckPgChannel,
  resolveFlightDeckPgDailyNote,
  resolveFlightDeckPgDailyNoteForOwnerDate,
  resolveFlightDeckPgPersonalWapp,
  resolveFlightDeckPgPersonalWappOriginPolicy,
  resolveFlightDeckPgDoc,
  resolveFlightDeckPgDocRecoveryVersion,
  resolveFlightDeckPgDocVersionIdentity,
  resolveFlightDeckPgDocComment,
  resolveFlightDeckPgFile,
  resolveFlightDeckPgFileFolder,
  replaceFlightDeckPgFileContent,
  resolveFlightDeckPgReaction,
  resolveFlightDeckPgReactionTarget,
  resolveFlightDeckPgResponseActivityTarget,
  resolveFlightDeckPgResourceActivity,
  resolveFlightDeckPgRequestContext,
  replaceFlightDeckPgEventSubscriptionAgents,
  resolveFlightDeckPgMessage,
  resolveFlightDeckPgMessageByClientRequestId,
  resolveFlightDeckPgTask,
  resolveFlightDeckPgThread,
  resolveFlightDeckPgTypedApproval,
  resolveFlightDeckPgWorkroom,
  resolveFlightDeckPgWorkroomByThread,
  releaseFlightDeckPgEditLease,
  reorderFlightDeckPgChannel,
  replaceFlightDeckPgChannelGrantBundle,
  renewFlightDeckPgEditLease,
  removeFlightDeckPgGroupMember,
  removeFlightDeckPgNestedGroupEdge,
  revokeFlightDeckPgDailyScopeAgentAccess,
  revokeFlightDeckPgChannelGrantBundle,
  serializeFlightDeckPgActor,
  serializeFlightDeckPgGroup,
  serializeFlightDeckPgWorkspaceMembership,
  serializeFlightDeckPgWorkspaceDescriptor,
  serializeFlightDeckPgWorkspaceSummary,
  serializeFlightDeckPgAudioNote,
  serializeFlightDeckPgChannel,
  serializeFlightDeckPgDailyNote,
  serializeFlightDeckPgDailyNoteVersion,
  serializeFlightDeckPgPersonalWapp,
  serializeFlightDeckPgDocComment,
  serializeFlightDeckPgDoc,
  serializeFlightDeckPgDocRecoveryVersion,
  serializeFlightDeckPgDocVersion,
  serializeFlightDeckPgDocVersionIdentity,
  serializeFlightDeckPgFile,
  serializeFlightDeckPgFileVersion,
  serializeFlightDeckPgFileFolder,
  serializeFlightDeckPgInvocation,
  serializeFlightDeckPgGrant,
  serializeFlightDeckPgGrantBundles,
  serializeFlightDeckPgMessage,
  serializeFlightDeckPgReaction,
  serializeFlightDeckPgResponseActivity,
  serializeFlightDeckPgResourceViewState,
  serializeFlightDeckPgAgentActivity,
  serializeFlightDeckPgScope,
  serializeFlightDeckPgStorageObjectMetadata,
  serializeFlightDeckPgTask,
  serializeFlightDeckPgTaskAssignment,
  serializeFlightDeckPgTaskComment,
  serializeFlightDeckPgThread,
  serializeFlightDeckPgTypedApproval,
  serializeFlightDeckPgWorkroom,
  serializeFlightDeckPgWorkroomEvent,
  serializeFlightDeckPgWorkroomLink,
  serializeFlightDeckPgWorkroomParticipant,
  setFlightDeckPgThreadArchived,
  touchFlightDeckPgThreadAfterMessage,
  lockFlightDeckPgMessageIdempotencyKey,
  serializeFlightDeckPgEvent,
  serializeFlightDeckPgEditLease,
  dailyNoteVersionContentFingerprint,
  snapshotFlightDeckPgDocVersion,
  snapshotFlightDeckPgDailyNoteVersion,
  unassignFlightDeckPgTask,
  updateFlightDeckPgChannel,
  updateFlightDeckPgScope,
  updateFlightDeckPgWorkspaceProfile,
  updateFlightDeckPgPersonalAgentSettings,
  updateFlightDeckPgDoc,
  updateFlightDeckPgDocComment,
  updateFlightDeckPgFile,
  updateFlightDeckPgFileFolder,
  updateFlightDeckPgTask,
  updateFlightDeckPgMessage,
  updateFlightDeckPgThreadTitle,
  updateFlightDeckPgTaskState,
  updateFlightDeckPgWorkroom,
  markFlightDeckPgResourceViewed,
  hasApprovedFlightDeckPgProductionMergeApproval,
  withFlightDeckPgTaskAssignments,
  archiveFlightDeckPgWorkroom,
  archiveFlightDeckPgPersonalWapp,
  reorderFlightDeckPgPersonalWapps,
  upsertFlightDeckPgDailyScopeAgentAccess,
  upsertFlightDeckPgDailyNote,
  upsertFlightDeckPgPersonalWapp,
  upsertFlightDeckPgResponseActivity,
  upsertFlightDeckPgAgentActivity,
  validateFlightDeckPgEditLease,
  clearFlightDeckPgResponseActivity,
  type FlightDeckPgEditLeaseEntityType,
  type FlightDeckPgIdentity,
  type FlightDeckPgInvocationRow,
} from '../services/flightdeck-pg-api';
import {
  MESSAGE_CLIENT_REQUEST_ID_MAX_LENGTH,
  parseAgentMentionInputs,
  validateFlightDeckPgChannelMetadata,
} from '../services/flightdeck-pg-agent-direct';
import type {
  FlightDeckPgActorKind,
  FlightDeckPgApprovalStatus,
  FlightDeckPgChannelKind,
  FlightDeckPgGroupKind,
  FlightDeckPgInvocationRecipient,
  FlightDeckPgInvocationStatus,
  FlightDeckPgInvocationTarget,
  FlightDeckPgInvocationTargetType,
  FlightDeckPgPermission,
  FlightDeckPgPrincipalType,
  FlightDeckPgReactionEmoji,
  FlightDeckPgReactionTargetType,
  FlightDeckPgResourceViewStateType,
  FlightDeckPgResponseActivitySeverity,
  FlightDeckPgResponseActivityStatus,
  FlightDeckPgResponseActivityTargetType,
  FlightDeckPgAgentActivityState,
  FlightDeckPgScopeKind,
  FlightDeckPgTaskPriority,
  FlightDeckPgTaskState,
  FlightDeckPgWorkroomAccessStatus,
  FlightDeckPgWorkroomEventType,
  FlightDeckPgWorkroomEventVisibility,
  FlightDeckPgWorkroomLinkType,
  FlightDeckPgWorkroomParticipantKind,
  FlightDeckPgWorkroomParticipantRole,
  FlightDeckPgWorkroomParticipantStatus,
  FlightDeckPgWorkroomStatus,
  FlightDeckPgWorkspaceRole,
  PrepareStorageInput,
} from '../types';

export const flightDeckPgRouter = new Hono();

const scopeKinds = new Set<FlightDeckPgScopeKind>([
  'business_unit',
  'department',
  'project',
  'customer',
  'dm',
  'temporary',
  'custom',
]);
const channelKinds = new Set<FlightDeckPgChannelKind>(['channel', 'dm', 'system']);
const channelCreatorPermissions: FlightDeckPgPermission[] = [
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
];
const dmParticipantPermissions: FlightDeckPgPermission[] = [...flightDeckPgManagePermissions];
const groupKinds = new Set<FlightDeckPgGroupKind>(['workspace', 'scope', 'channel', 'dm', 'agent', 'app', 'custom']);
const workspaceRoles = new Set<FlightDeckPgWorkspaceRole>(['owner', 'admin', 'member', 'guest', 'agent', 'app']);
const actorKinds = new Set<FlightDeckPgActorKind>(['human', 'agent', 'app', 'service']);
const principalTypes = new Set(['actor', 'person', 'group']);
const taskStates = new Set<FlightDeckPgTaskState>(['new', 'ready', 'in_progress', 'review', 'done', 'archive', 'backlog', 'blocked', 'archived']);
const taskPriorities = new Set<FlightDeckPgTaskPriority>(['rock', 'pebble', 'sand', 'low', 'normal', 'high', 'urgent']);
const workroomStatuses = new Set<FlightDeckPgWorkroomStatus>(['draft', 'active', 'waiting_review', 'waiting_approval', 'integrating', 'deploying', 'blocked', 'complete', 'archived']);
const workroomParticipantKinds = new Set<FlightDeckPgWorkroomParticipantKind>(['human', 'agent', 'autopilot', 'app', 'service']);
const workroomParticipantRoles = new Set<FlightDeckPgWorkroomParticipantRole>(['integration', 'contributor', 'reviewer', 'human_approver', 'observer']);
const workroomParticipantStatuses = new Set<FlightDeckPgWorkroomParticipantStatus>(['invited', 'active', 'inactive', 'removed']);
const workroomAccessStatuses = new Set<FlightDeckPgWorkroomAccessStatus>(['pending', 'granted', 'failed', 'not_required']);
const workroomEventTypes = new Set<FlightDeckPgWorkroomEventType>(['created', 'started', 'status_changed', 'participant_invited', 'access_grant_failed', 'artifact_added', 'link_added', 'pr_opened', 'pr_ready', 'review_requested', 'review_complete', 'approval_requested', 'approval_decided', 'merge_started', 'merge_complete', 'deploy_started', 'deploy_complete', 'blocker_added', 'blocker_cleared', 'completed', 'archived', 'note']);
const workroomEventVisibilities = new Set<FlightDeckPgWorkroomEventVisibility>(['room', 'workspace', 'private']);
const workroomLinkTypes = new Set<FlightDeckPgWorkroomLinkType>(['pull_request', 'file', 'doc', 'task', 'artifact', 'app_target', 'preview_url', 'production_url', 'approval', 'deployment', 'thread', 'message', 'external_url']);
const typedApprovalStatuses = new Set<FlightDeckPgApprovalStatus>(['requested', 'in_review', 'approved', 'rejected', 'superseded', 'cancelled']);
const typedApprovalDecisionStatuses = new Set<FlightDeckPgApprovalStatus>(['approved', 'rejected', 'superseded', 'cancelled']);
const reactionTargetTypes = new Set<FlightDeckPgReactionTargetType>(['message', 'task_comment', 'task', 'doc', 'file', 'audio_note']);
const reactionTargetTypesMessage = 'target_type must be one of message, task, task_comment, doc, file, or audio_note';
const reactionEmojis = new Set<FlightDeckPgReactionEmoji>(['thumbs_up', 'smile', 'heart', 'eyes', 'party', 'white_check_mark']);
const reactionEmojiShortcodes: Record<FlightDeckPgReactionEmoji, string> = {
  thumbs_up: ':thumbs_up:',
  smile: ':smile:',
  heart: ':heart:',
  eyes: ':eyes:',
  party: ':party:',
  white_check_mark: ':white_check_mark:',
};
const responseActivityTargetTypes = new Set<FlightDeckPgResponseActivityTargetType>(['chat_thread', 'task_comment', 'doc_comment']);
const responseActivityStatuses = new Set<FlightDeckPgResponseActivityStatus>(['queued', 'thinking', 'drafting', 'publishing', 'failed', 'cleared']);
const responseActivitySeverities = new Set<FlightDeckPgResponseActivitySeverity>(['info', 'warning', 'error']);
const agentActivityStates = new Set<FlightDeckPgAgentActivityState>(['accepted', 'working', 'waiting', 'completed', 'failed', 'cancelled']);
const invocationRecipientTypes = new Set(['person', 'agent']);
const invocationTargetTypes = new Set<FlightDeckPgInvocationTargetType>(['document', 'task', 'file']);
const invocationStatuses = new Set<FlightDeckPgInvocationStatus>(['open', 'closed']);

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function typedParticipantMetadata(participant: any) {
  const metadata = objectValue(participant?.metadata);
  const hasMetadata = Object.keys(metadata).length > 0;
  const capabilities = metadata.capabilities;
  const localWorkspace = objectValue(metadata.localWorkspace ?? metadata.local_workspace);
  const constraints = objectValue(metadata.constraints);
  const invalid = (capabilities !== undefined && !Array.isArray(capabilities))
    || (metadata.localWorkspace !== undefined && (typeof metadata.localWorkspace !== 'object' || Array.isArray(metadata.localWorkspace)))
    || (metadata.local_workspace !== undefined && (typeof metadata.local_workspace !== 'object' || Array.isArray(metadata.local_workspace)))
    || (metadata.constraints !== undefined && (typeof metadata.constraints !== 'object' || Array.isArray(metadata.constraints)))
    || (localWorkspace.repoPath !== undefined && typeof localWorkspace.repoPath !== 'string')
    || (localWorkspace.defaultBranch !== undefined && typeof localWorkspace.defaultBranch !== 'string')
    || (localWorkspace.canRunTests !== undefined && typeof localWorkspace.canRunTests !== 'boolean');
  return {
    npub: participant.actor_npub,
    role: participant.role === 'human_approver' ? 'approver' : participant.role,
    metadataStatus: !hasMetadata ? 'missing' : invalid ? 'invalid' : 'valid',
    capabilities: Array.isArray(capabilities) ? capabilities.filter((value) => typeof value === 'string') : [],
    localWorkspace: {
      repoPath: typeof localWorkspace.repoPath === 'string' ? localWorkspace.repoPath : null,
      defaultBranch: typeof localWorkspace.defaultBranch === 'string' ? localWorkspace.defaultBranch : null,
      canRunTests: typeof localWorkspace.canRunTests === 'boolean' ? localWorkspace.canRunTests : false,
    },
    constraints: {
      canMergeIntegration: constraints.canMergeIntegration === true,
      canMergeProduction: constraints.canMergeProduction === true,
      canRestartManagedApps: constraints.canRestartManagedApps === true,
    },
  };
}

function typedAppTargets(value: unknown, branches: Record<string, unknown>) {
  const targets = objectValue(value);
  return Object.entries(targets).flatMap(([kind, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const target = raw as Record<string, unknown>;
    const runbook = objectValue(target.runbook ?? target.run_book);
    return [{
      ...target,
      id: target.id ?? target.app_id ?? `${kind}`,
      kind,
      label: target.label ?? kind,
      url: target.url ?? null,
      autopilotAppId: target.autopilotAppId ?? target.app_id ?? null,
      branch: target.branch ?? branches[kind] ?? null,
      runbook,
    }];
  });
}

function typedWorkroomState(status: string) {
  if (status === 'archived') return 'archived';
  if (status === 'complete') return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'active';
}

function dailyScopePermissionDenied(
  c: Context,
  identity: FlightDeckPgIdentity,
  requiredPermission: 'daily_note.read' | 'daily_note.write',
) {
  return authorizationError(c, {
    allowed: false,
    reason: 'permission-grant-required',
    category: 'permission-denied',
  }, identity, requiredPermission);
}

function normalizeDailyScopeItems(items: unknown): unknown[] {
  if (items === undefined) return [];
  if (!Array.isArray(items)) throw new Error('items must be an array when provided');
  if (items.length > 5) throw new Error('items cannot contain more than five entries');
  return items.map((item, index) => {
    const raw = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : { text: item };
    const text = String(raw.text ?? raw.label ?? '').trim();
    if (!text) throw new Error(`items.${index}.text is required`);
    return {
      id: String(raw.id || `item-${index + 1}`).trim(),
      text,
      completed: Boolean(raw.completed),
      source: typeof raw.source === 'string' ? raw.source : undefined,
      created_at: typeof raw.created_at === 'string' ? raw.created_at : undefined,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
    };
  });
}

async function resolveDailyScopeOwnerActor(context: FlightDeckPgRequiredRequestContext, body: Record<string, unknown>) {
  const ownerActorId = String(body.owner_actor_id || '').trim();
  if (ownerActorId) {
    const membership = await getFlightDeckPgWorkspaceMembership(context.workspace.id, ownerActorId);
    return membership ? ownerActorId : null;
  }
  const ownerNpub = String(body.owner_npub || body.owner_actor_npub || '').trim();
  if (ownerNpub) {
    const actor = await resolveFlightDeckPgActorByNpub(ownerNpub);
    if (!actor) return null;
    const membership = await getFlightDeckPgWorkspaceMembership(context.workspace.id, actor.id);
    return membership ? actor.id : null;
  }
  return context.actor.id;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function resolveLinkedUrl(baseUrl: string, href: string | null): string | null {
  const value = String(href || '').trim();
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseIconSize(value: unknown): number {
  const sizes = String(value || '').match(/\d+/g) || [];
  return sizes.map((entry) => Number(entry)).filter(Number.isFinite).sort((a, b) => b - a)[0] || 0;
}

async function resolveInheritedPersonalWappIcon(launchUrl: string): Promise<string | null> {
  if (!isHttpUrl(launchUrl)) return null;
  try {
    const response = await fetch(launchUrl, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return resolveLinkedUrl(launchUrl, '/favicon.ico');
    const html = await response.text();
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
    const parsedLinks = links.map((tag) => {
      const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase() || '';
      const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1] || '';
      const sizes = tag.match(/\bsizes=["']([^"']+)["']/i)?.[1] || '';
      return { rel, href: resolveLinkedUrl(launchUrl, href), sizes };
    });
    const manifestLink = parsedLinks.find((link) => link.href && link.rel.split(/\s+/).includes('manifest'))?.href || null;
    if (manifestLink) {
      try {
        const manifestResponse = await fetch(manifestLink, { signal: AbortSignal.timeout(4000) });
        if (manifestResponse.ok) {
          const manifest = await manifestResponse.json() as { icons?: unknown[] };
          const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
          const best = icons
            .map((icon) => icon && typeof icon === 'object' ? icon as Record<string, unknown> : null)
            .map((icon) => ({
              src: resolveLinkedUrl(manifestLink, String(icon?.src || '')),
              size: parseIconSize(icon?.sizes),
            }))
            .filter((icon) => icon.src)
            .sort((a, b) => b.size - a.size)[0]?.src || null;
          if (best) return best;
        }
      } catch {
        // Fall through to link icon and favicon fallback.
      }
    }
    const linkedIcon = parsedLinks
      .filter((link) => link.href && /\b(icon|apple-touch-icon)\b/.test(link.rel))
      .sort((a, b) => parseIconSize(b.sizes) - parseIconSize(a.sizes))[0]?.href || null;
    return linkedIcon || resolveLinkedUrl(launchUrl, '/favicon.ico');
  } catch {
    return resolveLinkedUrl(launchUrl, '/favicon.ico');
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function personalWappPermissionDenied(
  c: Context,
  identity: FlightDeckPgIdentity,
  requiredPermission: 'personal_wapp.read' | 'personal_wapp.write',
) {
  return authorizationError(c, {
    allowed: false,
    reason: 'permission-grant-required',
    category: 'permission-denied',
  }, identity, requiredPermission);
}

function parsePersonalWappSortOrder(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) return null;
  return numberValue;
}
type DbClient = ReturnType<typeof getDb>;
type DbJsonValue = Parameters<DbClient['json']>[0];
type FlightDeckPgPrincipalRequestType = FlightDeckPgPrincipalType | 'person';
type ChannelGrantRequest = {
  principalType: FlightDeckPgPrincipalType;
  principalId: string;
  permissions: FlightDeckPgPermission[];
  accessLevel?: 'view' | 'contribute' | 'manage';
};
type FlightDeckPgNullableRequestContext = Awaited<ReturnType<typeof resolveFlightDeckPgRequestContext>>;
type FlightDeckPgRequiredRequestContext = {
  workspace: NonNullable<FlightDeckPgNullableRequestContext['workspace']>;
  actor: NonNullable<FlightDeckPgNullableRequestContext['actor']>;
  membership: NonNullable<FlightDeckPgNullableRequestContext['membership']>;
  groupIds: string[];
};
type FlightDeckPgContextResult =
  | { response: Response }
  | { context: FlightDeckPgRequiredRequestContext; identity: FlightDeckPgIdentity };

function asDbClient(sql: unknown): DbClient {
  return sql as DbClient;
}

function asDbJson(value: Record<string, unknown>): DbJsonValue {
  return value as DbJsonValue;
}

function normalizeGrantPrincipalType(value: string): FlightDeckPgPrincipalType | null {
  const principalType = value.trim() as FlightDeckPgPrincipalRequestType;
  if (principalType === 'person') return 'actor';
  if (principalType === 'actor' || principalType === 'group') return principalType;
  return null;
}

function parseChannelGrantRequest(body: Record<string, unknown>, fields: { path: string; code: string; message: string }[]): ChannelGrantRequest | null {
  const requestedPrincipalType = String(body.principal_type || '').trim();
  const principalType = normalizeGrantPrincipalType(requestedPrincipalType);
  const principalId = String(body.principal_id || '').trim();
  const accessLevel = String(body.access_level || '').trim().toLowerCase();
  const rawPermissions = Array.isArray(body.permissions)
    ? body.permissions.map((permission) => String(permission).trim()).filter(Boolean)
    : [];

  if (!principalType || !principalTypes.has(requestedPrincipalType)) {
    fields.push({ path: 'principal_type', code: 'invalid', message: 'principal_type must be person or group' });
  }
  if (!principalId) fields.push({ path: 'principal_id', code: 'required', message: 'principal_id must be a non-empty UUID string' });
  if (accessLevel && !isFlightDeckPgStandardAccessLevel(accessLevel)) {
    fields.push({ path: 'access_level', code: 'invalid', message: 'access_level must be view, contribute, or manage' });
  }
  if (!accessLevel && rawPermissions.length === 0) {
    fields.push({ path: 'access_level', code: 'required', message: 'access_level is required unless permissions are provided for a custom grant' });
  }
  for (const permission of rawPermissions) {
    if (!isFlightDeckPgChannelPermission(permission)) {
      fields.push({ path: 'permissions', code: 'invalid', message: `${permission} is not a channel-anchored Flight Deck PG permission` });
    }
  }
  if (fields.length || !principalType) return null;
  const permissions = isFlightDeckPgStandardAccessLevel(accessLevel)
    ? flightDeckPgPermissionsForAccessLevel(accessLevel)
    : rawPermissions as FlightDeckPgPermission[];
  return {
    principalType,
    principalId,
    permissions,
    accessLevel: isFlightDeckPgStandardAccessLevel(accessLevel) ? accessLevel : undefined,
  };
}

function parseInitialChannelGrants(body: Record<string, unknown>, fields: { path: string; code: string; message: string }[]): ChannelGrantRequest[] {
  const grants = body.grants ?? body.access_grants ?? body.channel_grants;
  if (grants === undefined) return [];
  if (!Array.isArray(grants)) {
    fields.push({ path: 'grants', code: 'invalid', message: 'grants must be an array when provided' });
    return [];
  }
  return grants.map((grant, index) => {
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
      fields.push({ path: `grants.${index}`, code: 'invalid', message: 'grant must be an object' });
      return null;
    }
    return parseChannelGrantRequest(grant as Record<string, unknown>, fields);
  }).filter((grant): grant is ChannelGrantRequest => Boolean(grant));
}

function parseInvocationRecipients(value: unknown, fields: { path: string; code: string; message: string }[]): Array<{
  type: 'person' | 'agent';
  npub: string;
  actorId: string | null;
  metadata: Record<string, unknown>;
}> {
  if (!Array.isArray(value) || value.length === 0) {
    fields.push({ path: 'recipients', code: 'required', message: 'recipients must be a non-empty array' });
    return [];
  }
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fields.push({ path: `recipients.${index}`, code: 'invalid', message: 'recipient must be an object' });
      return [];
    }
    const row = entry as Record<string, unknown>;
    const type = String(row.type || '').trim();
    const npub = String(row.npub || '').trim();
    const actorId = String(row.actor_id || '').trim() || null;
    const metadata = optionalObject(row.metadata);
    if (!invocationRecipientTypes.has(type)) {
      fields.push({ path: `recipients.${index}.type`, code: 'invalid', message: 'recipient type must be person or agent' });
    }
    if (!npub) fields.push({ path: `recipients.${index}.npub`, code: 'required', message: 'recipient npub is required' });
    if (metadata === null) fields.push({ path: `recipients.${index}.metadata`, code: 'invalid', message: 'recipient metadata must be an object when provided' });
    if (!invocationRecipientTypes.has(type) || !npub || metadata === null) return [];
    return [{ type: type as 'person' | 'agent', npub, actorId, metadata: metadata ?? {} }];
  });
}

function parseInvocationTargets(value: unknown, fields: { path: string; code: string; message: string }[]): FlightDeckPgInvocationTarget[] {
  if (!Array.isArray(value) || value.length === 0) {
    fields.push({ path: 'targets', code: 'required', message: 'targets must be a non-empty array' });
    return [];
  }
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fields.push({ path: `targets.${index}`, code: 'invalid', message: 'target must be an object' });
      return [];
    }
    const row = entry as Record<string, unknown>;
    const rawType = String(row.type || '').trim();
    const type = rawType === 'doc' ? 'document' : rawType;
    const id = String(row.id || row.target_id || '').trim();
    const metadata = optionalObject(row.metadata);
    if (!invocationTargetTypes.has(type as FlightDeckPgInvocationTargetType)) {
      fields.push({ path: `targets.${index}.type`, code: 'invalid', message: 'target type must be document, task, or file' });
    }
    if (!id) fields.push({ path: `targets.${index}.id`, code: 'required', message: 'target id is required' });
    if (metadata === null) fields.push({ path: `targets.${index}.metadata`, code: 'invalid', message: 'target metadata must be an object when provided' });
    if (!invocationTargetTypes.has(type as FlightDeckPgInvocationTargetType) || !id || metadata === null) return [];
    return [{ type: type as FlightDeckPgInvocationTargetType, id, metadata: metadata ?? {} }];
  });
}

function invocationReadPermissionForTarget(targetType: FlightDeckPgInvocationTargetType): FlightDeckPgPermission {
  if (targetType === 'task') return 'task.read';
  if (targetType === 'file') return 'file.read';
  return 'doc.read';
}

async function resolveInvocationTargetContext(
  workspaceId: string,
  target: FlightDeckPgInvocationTarget,
): Promise<{ scopeId: string; channelId: string; title: string | null } | null> {
  if (target.type === 'document') {
    const doc = await resolveFlightDeckPgDoc(workspaceId, target.id);
    return doc ? { scopeId: doc.scope_id, channelId: doc.channel_id, title: doc.title } : null;
  }
  if (target.type === 'task') {
    const task = await resolveFlightDeckPgTask(workspaceId, target.id);
    return task ? { scopeId: task.scope_id, channelId: task.channel_id, title: task.title } : null;
  }
  const file = await resolveFlightDeckPgFile(workspaceId, target.id);
  return file ? { scopeId: file.scope_id, channelId: file.channel_id, title: file.display_name ?? null } : null;
}

function appNpubFromRequest(c: Context, fallback = config.flightDeck.appNpub) {
  return String(c.req.header('x-flightdeck-pg-app-npub') || c.req.query('app_npub') || fallback).trim();
}

type ParsedByteRange =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: 'malformed' | 'unsatisfiable' };

function parseSingleByteRange(rangeHeader: string | undefined, size: number): ParsedByteRange | null {
  const header = String(rangeHeader || '').trim();
  if (!header) return null;
  if (!header.startsWith('bytes=')) return { ok: false, reason: 'malformed' };

  const spec = header.slice('bytes='.length).trim();
  if (!spec || spec.includes(',')) return { ok: false, reason: 'malformed' };

  const match = spec.match(/^(\d*)-(\d*)$/);
  if (!match) return { ok: false, reason: 'malformed' };

  const [, startText, endText] = match;
  if (!startText && !endText) return { ok: false, reason: 'malformed' };
  if (size <= 0) return { ok: false, reason: 'unsatisfiable' };

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { ok: false, reason: 'unsatisfiable' };
    return {
      ok: true,
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return { ok: false, reason: 'malformed' };
  if (start >= size || requestedEnd < start) return { ok: false, reason: 'unsatisfiable' };

  return {
    ok: true,
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

function storageObjectEtag(sha256Hex: string | null | undefined): string | null {
  const hash = String(sha256Hex || '').trim();
  return hash ? `"${hash}"` : null;
}

function optionalAppNpubFromRequest(c: Context) {
  const raw = c.req.header('x-flightdeck-pg-app-npub') || c.req.query('app_npub');
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 416,
  code: string,
  error: string,
  identity: FlightDeckPgIdentity,
  extra: Record<string, unknown> = {},
) {
  return c.json({ error, code, status, identity, ...extra }, status);
}

function validationError(
  c: Context,
  identity: FlightDeckPgIdentity,
  fields: { path: string; code: string; message: string }[],
) {
  return jsonError(c, 400, 'validation_error', 'Request body failed validation', identity, {
    details: { fields },
  });
}

function authorizationError(
  c: Context,
  decision: FlightDeckPgAuthorizationDecision,
  identity: FlightDeckPgIdentity,
  requiredPermission: string,
) {
  if (decision.category === 'auth-error') {
    return jsonError(c, 401, decision.reason, 'Flight Deck PG authentication failed', identity, {
      required_permission: requiredPermission,
    });
  }
  if (decision.category === 'validation-error') {
    return jsonError(c, 400, decision.reason, 'Flight Deck PG authorization request is invalid', identity, {
      required_permission: requiredPermission,
    });
  }
  return jsonError(c, 403, 'permission_denied', 'Actor does not have the required Flight Deck PG permission', identity, {
    reason: decision.reason,
    required_permission: requiredPermission,
  });
}

function storageAuthorizationError(
  c: Context,
  access: Extract<Awaited<ReturnType<typeof authorizeFlightDeckPgStorageRead>>, { allowed: false }>,
  identity: FlightDeckPgIdentity,
  requiredPermission: string,
) {
  return authorizationError(c, access.decision, identity, requiredPermission);
}

async function requireFlightDeckPgContext(
  c: Context,
  actorNpub: string,
): Promise<FlightDeckPgContextResult> {
  const workspaceId = c.req.param('workspaceId') ?? '';
  const context = await resolveFlightDeckPgRequestContext({ workspaceId, actorNpub });
  const identity = buildFlightDeckPgIdentity(context.workspace, context.workspace?.app_npub ?? appNpubFromRequest(c));
  if (!context.workspace) {
    return { response: jsonError(c, 404, 'workspace_not_found', 'Flight Deck PG workspace not found', identity) };
  }
  if (!context.actor || !context.membership) {
    return {
      response: jsonError(c, 403, 'workspace_membership_required', 'Actor is not a member of this Flight Deck PG workspace', identity),
    };
  }
  return {
    context: {
      workspace: context.workspace,
      actor: context.actor,
      membership: context.membership,
      groupIds: context.groupIds,
    },
    identity,
  };
}

function parseLimit(c: Context) {
  const raw = Number(c.req.query('limit') || 50);
  if (!Number.isFinite(raw)) return 50;
  return Math.max(1, Math.min(200, Math.floor(raw)));
}

function encodeFlightDeckPgMessageCursor(message: { created_at: Date; id: string; cursor_created_at?: string }) {
  return Buffer.from(JSON.stringify({ version: 1, created_at: message.cursor_created_at ?? message.created_at.toISOString(), id: message.id }), 'utf8').toString('base64url');
}

function decodeFlightDeckPgMessageCursor(raw: string | null | undefined): { createdAt: string | null; id: string | null } | null {
  if (!raw) return { createdAt: null, id: null };
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    const createdAt = typeof value.created_at === 'string' ? new Date(value.created_at) : null;
    if (value.version !== 1 || !createdAt || Number.isNaN(createdAt.getTime()) || typeof value.id !== 'string' || !isUuid(value.id)) return null;
    return { createdAt: value.created_at as string, id: value.id };
  } catch {
    return null;
  }
}

function parseFlightDeckPgMessageAttachmentStorageObjectIds(
  value: unknown,
  path = 'metadata.attachments',
): { storageObjectIds: string[]; errors: Array<{ path: string; code: string; message: string }> } {
  if (value === undefined) return { storageObjectIds: [], errors: [] };
  if (!Array.isArray(value)) {
    return { storageObjectIds: [], errors: [{ path, code: 'invalid', message: 'attachments must be an array' }] };
  }

  const storageObjectIds: string[] = [];
  const errors: Array<{ path: string; code: string; message: string }> = [];
  for (const [index, attachment] of value.entries()) {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      errors.push({ path: `${path}.${index}`, code: 'invalid', message: 'attachment must be an object' });
      continue;
    }
    const storageObjectId = String((attachment as Record<string, unknown>).storage_object_id || '').trim();
    if (!isUuid(storageObjectId)) {
      errors.push({ path: `${path}.${index}.storage_object_id`, code: 'invalid', message: 'storage_object_id must be a UUID' });
      continue;
    }
    if (storageObjectIds.includes(storageObjectId)) {
      errors.push({ path: `${path}.${index}.storage_object_id`, code: 'duplicate', message: 'storage_object_id must be unique within a message' });
      continue;
    }
    storageObjectIds.push(storageObjectId);
  }
  return { storageObjectIds, errors };
}

const FLIGHT_DECK_PG_EVENT_STREAM_POLL_MS = 1_000;
const FLIGHT_DECK_PG_EVENT_STREAM_HEARTBEAT_MS = 25_000;

function encodeSseFrame(input: { id?: string | number | null; event: string; data: unknown }): Uint8Array {
  const lines = [
    input.id !== undefined && input.id !== null ? `id: ${input.id}` : null,
    `event: ${input.event}`,
    `data: ${JSON.stringify(input.data)}`,
    '',
    '',
  ].filter((line): line is string => line !== null);
  return new TextEncoder().encode(lines.join('\n'));
}

function encodeSseComment(comment: string): Uint8Array {
  return new TextEncoder().encode(`: ${comment}\n\n`);
}

async function readJsonBody(c: Context) {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    return null;
  }
}

function optionalRowVersion(body: Record<string, unknown>) {
  if (body.row_version === undefined || body.row_version === null) return null;
  const rowVersion = Number(body.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion < 1) return NaN;
  return rowVersion;
}

function encodeFlightDeckPgDriveTreeCursor(sortKey: string) {
  return Buffer.from(JSON.stringify({ version: 1, sortKey }), 'utf8').toString('base64url');
}

function decodeFlightDeckPgDriveTreeCursor(raw: string | null | undefined): { sortKey: string } | null {
  if (!raw) return { sortKey: '' };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { version?: unknown; sortKey?: unknown };
    if (parsed.version !== 1 || typeof parsed.sortKey !== 'string') return null;
    return { sortKey: parsed.sortKey };
  } catch {
    return null;
  }
}

function encodeFlightDeckPgResourceViewStateCursor(state: { resource_type: FlightDeckPgResourceViewStateType; resource_id: string }) {
  return Buffer.from(JSON.stringify({ version: 1, resource_type: state.resource_type, resource_id: state.resource_id }), 'utf8').toString('base64url');
}

function decodeFlightDeckPgResourceViewStateCursor(raw: string | null | undefined): { resourceType: FlightDeckPgResourceViewStateType; resourceId: string } | null {
  if (!raw) return { resourceType: 'thread', resourceId: '00000000-0000-0000-0000-000000000000' };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.version !== 1 || !['thread', 'task', 'document'].includes(String(parsed.resource_type)) || typeof parsed.resource_id !== 'string' || !isUuid(parsed.resource_id)) return null;
    return { resourceType: parsed.resource_type as FlightDeckPgResourceViewStateType, resourceId: parsed.resource_id };
  } catch {
    return null;
  }
}

function flightDeckPgDriveRefetchRoute(workspaceId: string, type: 'file' | 'folder', id: string) {
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  const encodedId = encodeURIComponent(id);
  if (type === 'folder') return `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/file-folders/${encodedId}`;
  return `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/files/${encodedId}`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function optionalObject(value: unknown) {
  if (value === undefined) return undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

async function resolveFileFolderPlacement(input: {
  workspaceId: string;
  scopeId: string;
  channelId: string;
  folderId: string | null | undefined;
}) {
  const folderId = typeof input.folderId === 'string' ? input.folderId.trim() : input.folderId;
  if (!folderId) return { folderId: null, folder: null };
  const folder = await resolveFlightDeckPgFileFolder(input.workspaceId, folderId);
  if (!folder || folder.scope_id !== input.scopeId || folder.channel_id !== input.channelId) {
    return { folderId, folder: null, invalid: true };
  }
  return { folderId, folder };
}

function taskMetadataFromBody(body: Record<string, unknown>, baseMetadata: Record<string, unknown> | undefined) {
  const hasAssignedToNpub = Object.prototype.hasOwnProperty.call(body, 'assigned_to_npub');
  const hasAssignedToNpubs = Object.prototype.hasOwnProperty.call(body, 'assigned_to_npubs');
  if (baseMetadata === undefined && !hasAssignedToNpub && !hasAssignedToNpubs) return undefined;
  const metadata = { ...(baseMetadata ?? {}) };
  if (hasAssignedToNpub) {
    const npub = String(body.assigned_to_npub ?? '').trim();
    metadata.assigned_to_npub = npub || null;
  } else if (hasAssignedToNpubs) {
    const raw = Array.isArray(body.assigned_to_npubs) ? body.assigned_to_npubs : [];
    const npub = raw.map((value) => String(value ?? '').trim()).find(Boolean) || '';
    metadata.assigned_to_npub = npub || null;
  }
  return metadata;
}

async function canonicalTaskMentions(input: {
  value: unknown;
  path: string;
  workspaceId: string;
  appNpub: string;
  channelId: string;
}) {
  const parsed = parseAgentMentionInputs(input.value, input.path);
  if (parsed.errors.length) return { mentions: [], errors: parsed.errors };
  const mentions: Array<{ type: 'agent'; actor_id: string; npub: string; label?: string }> = [];
  for (const mention of parsed.mentions) {
    const actor = await resolveFlightDeckPgActorByNpub(mention.npub);
    if (!actor) return { mentions: [], errors: [{ path: input.path, code: 'unknown_actor', message: 'mentioned identity is not a workspace actor' }] };
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: actor.npub,
      appNpub: input.appNpub,
      workspaceId: input.workspaceId,
      permission: 'task.read',
      resource: { type: 'channel', channelId: input.channelId },
    });
    if (!decision.allowed) return { mentions: [], errors: [{ path: input.path, code: 'inaccessible_actor', message: 'mentioned actor cannot read this task' }] };
    mentions.push({ type: 'agent', actor_id: actor.id, npub: actor.npub, ...(mention.label ? { label: mention.label } : actor.display_name ? { label: actor.display_name } : {}) });
  }
  return { mentions, errors: [] };
}

async function canonicalDocMentions(input: {
  value: unknown;
  path: string;
  workspaceId: string;
  appNpub: string;
  channelId: string;
}) {
  const parsed = parseAgentMentionInputs(input.value, input.path);
  if (parsed.errors.length) return { mentions: [], errors: parsed.errors };
  const mentions: Array<{ type: 'agent'; actor_id: string; npub: string; label?: string }> = [];
  for (const mention of parsed.mentions) {
    const actor = await resolveFlightDeckPgActorByNpub(mention.npub);
    if (!actor) return { mentions: [], errors: [{ path: input.path, code: 'unknown_actor', message: 'mentioned identity is not a workspace actor' }] };
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: actor.npub,
      appNpub: input.appNpub,
      workspaceId: input.workspaceId,
      permission: 'doc.read',
      resource: { type: 'channel', channelId: input.channelId },
    });
    if (!decision.allowed) return { mentions: [], errors: [{ path: input.path, code: 'inaccessible_actor', message: 'mentioned actor cannot read this document' }] };
    mentions.push({ type: 'agent', actor_id: actor.id, npub: actor.npub, ...(mention.label ? { label: mention.label } : actor.display_name ? { label: actor.display_name } : {}) });
  }
  return { mentions, errors: [] };
}

function addedAgentMentions(previous: unknown, current: Array<{ actor_id: string }>) {
  const previousActorIds = new Set((Array.isArray(previous) ? previous : []).flatMap((mention) => {
    if (!mention || typeof mention !== 'object' || Array.isArray(mention)) return [];
    const actorId = (mention as Record<string, unknown>).actor_id;
    return typeof actorId === 'string' ? [actorId] : [];
  }));
  return current.filter((mention) => !previousActorIds.has(mention.actor_id));
}

async function documentBodyVersionInfo(storageObjectId: string | null | undefined) {
  if (!storageObjectId) return { storage_object_id: null, sha256_hex: null, size_bytes: null };
  const object = await getStorageObject(storageObjectId);
  return {
    storage_object_id: storageObjectId,
    sha256_hex: object?.sha256_hex ?? null,
    size_bytes: object ? Number(object.size_bytes) : null,
  };
}

function optionalSha256Hex(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : '';
}

async function ensureFlightDeckPgDocStorageLink(input: {
  workspaceId: string;
  channelId: string;
  docId: string;
  storageObjectId: string;
  actorId: string;
  metadata: Record<string, unknown>;
}, sql: DbClient) {
  const existing = await resolveFlightDeckPgStorageLink({ workspaceId: input.workspaceId, storageObjectId: input.storageObjectId }, sql);
  if (existing) {
    if (existing.entity_type !== 'doc' || existing.entity_id !== input.docId) {
      throw new Error('storage object is already attached to another active Flight Deck PG entity');
    }
    return { link: existing, created: false };
  }
  const link = await createFlightDeckPgStorageLink({
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    entityType: 'doc',
    entityId: input.docId,
    storageObjectId: input.storageObjectId,
    metadata: input.metadata,
    createdByActorId: input.actorId,
  }, sql);
  return { link, created: true };
}

function serializeFlightDeckPgNotificationPreferences(preferences: Awaited<ReturnType<typeof getFlightDeckPgNotificationPreferences>>) {
  return {
    workspace_id: preferences.workspace_id,
    actor_id: preferences.actor_id,
    chat_threads_enabled: preferences.chat_threads_enabled,
    mentions_enabled: preferences.mentions_enabled,
    dms_enabled: preferences.dms_enabled,
    comment_tags_enabled: preferences.comment_tags_enabled,
    task_assignments_enabled: preferences.task_assignments_enabled,
    created_at: preferences.created_at,
    updated_at: preferences.updated_at,
  };
}

function serializeFlightDeckPgPushSubscription(subscription: Awaited<ReturnType<typeof listFlightDeckPgPushSubscriptionsForActor>>[number]) {
  return {
    id: subscription.id,
    actor_id: subscription.actor_id,
    endpoint: subscription.endpoint,
    device_label: subscription.device_label,
    platform: subscription.platform,
    user_agent: subscription.user_agent,
    app_version: subscription.app_version,
    last_seen_workspace_id: subscription.last_seen_workspace_id,
    status: subscription.status,
    failure_count: subscription.failure_count,
    last_success_at: subscription.last_success_at,
    last_failure_at: subscription.last_failure_at,
    revoked_at: subscription.revoked_at,
    stale_at: subscription.stale_at,
    created_at: subscription.created_at,
    updated_at: subscription.updated_at,
  };
}

function parseFlightDeckPgStoredDocumentContent(bytes: Uint8Array) {
  const raw = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const model = parsed?.content_model && typeof parsed.content_model === 'object' && !Array.isArray(parsed.content_model)
      ? parsed.content_model as Record<string, unknown>
      : parsed;
    return {
      content: typeof model.content === 'string' ? model.content : raw,
      content_format: typeof model.content_format === 'string' ? model.content_format : null,
      content_blocks: Array.isArray(model.content_blocks) ? model.content_blocks : [],
      raw,
    };
  } catch {
    return {
      content: raw,
      content_format: null,
      content_blocks: [],
      raw,
    };
  }
}

function normalizeEditLeaseEntityType(value: unknown): FlightDeckPgEditLeaseEntityType | null {
  const raw = String(value || '').trim();
  if (raw === 'task') return 'task';
  if (raw === 'document' || raw === 'doc') return 'document';
  return null;
}

function requiredLeaseToken(body: Record<string, unknown>) {
  return String(body.lease_token || '').trim();
}

async function requireValidFlightDeckPgEditLeaseForSave(
  c: Context,
  input: {
    identity: FlightDeckPgIdentity;
    workspaceId: string;
    actorId: string;
    entityType: FlightDeckPgEditLeaseEntityType;
    entityId: string;
    rowVersion: number | null;
    leaseToken: string;
  },
): Promise<Response | null> {
  const fields: { path: string; code: string; message: string }[] = [];
  if (!input.rowVersion) {
    fields.push({ path: 'row_version', code: 'required', message: 'row_version is required for PG edit saves' });
  }
  if (!input.leaseToken) {
    fields.push({ path: 'lease_token', code: 'required', message: 'lease_token is required for PG edit saves' });
  }
  if (fields.length) return validationError(c, input.identity, fields);

  const lease = await validateFlightDeckPgEditLease({
    workspaceId: input.workspaceId,
    entityType: input.entityType,
    entityId: input.entityId,
    actorId: input.actorId,
    leaseToken: input.leaseToken,
  });
  if (lease.ok) return null;

  return jsonError(c, 409, lease.reason, 'A valid PG edit lease is required to update this record', input.identity);
}

function optionalNonNegativeNumber(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return NaN;
  return parsed;
}

async function writeFlightDeckPgAudit(
  input: {
    workspaceId: string;
    actorId: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_audit_events (
      workspace_id,
      actor_id,
      action,
      resource_type,
      resource_id,
      metadata
    )
    VALUES (
      ${input.workspaceId},
      ${input.actorId},
      ${input.action},
      ${input.resourceType},
      ${input.resourceId ?? null},
      ${sql.json(asDbJson(input.metadata ?? {}))}
    )
    RETURNING id
  `;
  return event.id;
}

async function requireFlightDeckPgWorkspaceManage(
  c: Context,
  actorNpub: string,
  context: FlightDeckPgRequiredRequestContext,
  identity: FlightDeckPgIdentity,
) {
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.manage',
    resource: { type: 'workspace' },
  });
  return decision.allowed ? null : authorizationError(c, decision, identity, 'workspace.manage');
}

async function resolveFlightDeckPgWorkspaceActorId(
  workspaceId: string,
  input: { actorId?: unknown; actorNpub?: unknown },
  sql: DbClient = getDb(),
): Promise<string | null> {
  const actorId = String(input.actorId || '').trim();
  if (actorId) {
    const [membership] = await sql<{ actor_id: string }[]>`
      SELECT actor_id
      FROM flightdeck_pg_workspace_memberships
      WHERE workspace_id = ${workspaceId}
        AND actor_id = ${actorId}
      LIMIT 1
    `;
    return membership?.actor_id ?? null;
  }

  const actorNpub = String(input.actorNpub || '').trim();
  if (!actorNpub) return null;
  const [membership] = await sql<{ actor_id: string }[]>`
    SELECT m.actor_id
    FROM flightdeck_pg_workspace_memberships m
    JOIN flightdeck_pg_actors a ON a.id = m.actor_id
    WHERE m.workspace_id = ${workspaceId}
      AND a.npub = ${actorNpub}
    LIMIT 1
  `;
  return membership?.actor_id ?? null;
}

async function flightDeckPgGroupExists(
  workspaceId: string,
  groupId: string,
  sql: DbClient = getDb(),
): Promise<boolean> {
  const [group] = await sql<{ id: string }[]>`
    SELECT id
    FROM flightdeck_pg_groups
    WHERE workspace_id = ${workspaceId}
      AND id = ${groupId}
    LIMIT 1
  `;
  return Boolean(group);
}

flightDeckPgRouter.get('/service', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const towerProfile = await getTowerProfile();
  const appNpub = appNpubFromRequest(c);
  return c.json({
    identity: buildFlightDeckPgIdentity(null, appNpub),
    service: {
      name: towerProfile.tower_name,
      description: towerProfile.tower_description,
      base_url: new URL(c.req.url).origin,
      service_npub: config.service.npub || null,
      version: getTowerBuildInfo().version,
      schema_version: 1,
    },
    capabilities: flightDeckPgCapabilities,
    links: {
      workspace_descriptor_template: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/descriptor',
      me_template: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/me',
      scopes_template: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes',
      events_template: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/events',
      sync_template: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/sync',
      openapi: '/openapi.json',
    },
  });
});

flightDeckPgRouter.get('/workspaces', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const appNpub = optionalAppNpubFromRequest(c);
  const towerBaseUrl = new URL(c.req.url).origin;
  const workspaces = await listFlightDeckPgWorkspacesForActor({
    actorNpub: auth.userNpub,
    appNpub,
    limit: parseLimit(c),
  });

  return c.json({
    identity: buildFlightDeckPgIdentity(null, appNpub ?? appNpubFromRequest(c)),
    workspaces: workspaces.map((workspace) => serializeFlightDeckPgWorkspaceSummary(workspace, { towerBaseUrl })),
    next_cursor: null,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/descriptor', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.read',
    resource: { type: 'workspace' },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'workspace.read');

  return c.json(serializeFlightDeckPgWorkspaceDescriptor(context.workspace, {
    towerBaseUrl: new URL(c.req.url).origin,
  }));
});

flightDeckPgRouter.patch('/workspaces/:workspaceId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
  if (manageError) return manageError;

  const body = await readJsonBody(c) as Record<string, unknown> | null;
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const fields: { path: string; code: string; message: string }[] = [];
  const name = String(body.name || '').trim();
  if (!name) fields.push({ path: 'name', code: 'required', message: 'name must be a non-empty string' });
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
    fields.push({ path: 'description', code: 'invalid', message: 'description must be a string when provided' });
  }
  if (body.slug !== undefined && body.slug !== null && typeof body.slug !== 'string') {
    fields.push({ path: 'slug', code: 'invalid', message: 'slug must be a string when provided' });
  }
  if (body.avatar_url !== undefined && body.avatar_url !== null && typeof body.avatar_url !== 'string') {
    fields.push({ path: 'avatar_url', code: 'invalid', message: 'avatar_url must be a string or null when provided' });
  }
  const metadata = body.metadata !== undefined && body.metadata !== null && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};
  if (body.metadata !== undefined && body.metadata !== null && (typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
    fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  }
  if (fields.length) return validationError(c, identity, fields);

  const description = String(body.description ?? '').trim() || null;
  const slug = String(body.slug || '').trim();
  const avatarUrl = body.avatar_url === null ? null : String(body.avatar_url || '').trim() || null;
  const workspace = await updateFlightDeckPgWorkspaceProfile({
    workspaceId: context.workspace.id,
    name,
    slug,
    description,
    avatarUrl,
    metadata,
  });
  await writeFlightDeckPgAudit({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    action: 'workspace_profile.update',
    resourceType: 'workspace',
    resourceId: context.workspace.id,
    metadata: {
      name,
      slug,
      description,
      avatar_url: avatarUrl,
      metadata,
    },
  });

  return c.json({
    identity: buildFlightDeckPgIdentity(workspace, workspace.app_npub),
    workspace: serializeFlightDeckPgWorkspaceDescriptor(workspace, {
      towerBaseUrl: new URL(c.req.url).origin,
    }),
    name: workspace.name,
    description: workspace.description ?? '',
    slug: workspace.slug,
    avatar_url: workspace.avatar_url,
    metadata: workspace.metadata ?? {},
    updated_at: workspace.updated_at,
  });
});

flightDeckPgRouter.delete('/workspaces/:workspaceId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
  if (manageError) return manageError;

  const body = await readJsonBody(c) as Record<string, unknown> | null;
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const confirmation = String(body.confirmation || '').trim();
  if (confirmation !== context.workspace.id) {
    return validationError(c, identity, [{
      path: 'confirmation',
      code: 'confirmation_mismatch',
      message: 'confirmation must match the workspace id',
    }]);
  }

  const sql = getDb();
  const deletion = await sql.begin(async (tx) => {
    const members = await listFlightDeckPgWorkspaceMembers(context.workspace.id, tx);
    const rows = await tx<{ id: string }[]>`
      DELETE FROM flightdeck_pg_workspaces
      WHERE id = ${context.workspace.id}
      RETURNING id
    `;
    return {
      deleted: rows.length === 1,
      revokedMemberNpubs: members.map((member) => member.actor.npub),
    };
  });
  if (!deletion.deleted) return jsonError(c, 404, 'workspace_not_found', 'Flight Deck PG workspace not found', identity);

  return c.json({
    identity,
    workspace_id: context.workspace.id,
    workspace_name: context.workspace.name,
    deleted: true,
    revoked_member_npubs: deletion.revokedMemberNpubs,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/me', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.read',
    resource: { type: 'workspace' },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'workspace.read');

  const sql = getDb();
  const effectiveGroupIds = context.groupIds.length ? context.groupIds : ['00000000-0000-0000-0000-000000000000'];
  const [scopes, channels, permissionRows] = await Promise.all([
    listVisibleFlightDeckPgScopes({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      groupIds: context.groupIds,
      limit: 200,
    }),
    sql<any[]>`
      SELECT DISTINCT c.*
      FROM flightdeck_pg_channels c
      JOIN flightdeck_pg_permission_grants pg
        ON pg.workspace_id = c.workspace_id
        AND pg.resource_type = 'channel'
        AND pg.resource_channel_id = c.id
        AND pg.permission = 'channel.read'
        AND pg.revoked_at IS NULL
        AND (
          (pg.principal_type = 'actor' AND pg.principal_actor_id = ${context.actor.id})
          OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(effectiveGroupIds)})
        )
      WHERE c.workspace_id = ${context.workspace.id}
        AND c.archived_at IS NULL
      ORDER BY c.name ASC, c.id ASC
      LIMIT 200
    `,
    sql<{ permission: FlightDeckPgPermission }[]>`
      SELECT DISTINCT permission
      FROM flightdeck_pg_permission_grants
      WHERE workspace_id = ${context.workspace.id}
        AND revoked_at IS NULL
        AND (
          (principal_type = 'actor' AND principal_actor_id = ${context.actor.id})
          OR (principal_type = 'group' AND principal_group_id IN ${sql(effectiveGroupIds)})
        )
      ORDER BY permission ASC
    `,
  ]);

  return c.json({
    identity,
    actor: {
      actor_id: context.actor.id,
      npub: context.actor.npub,
      kind: context.actor.kind,
      display_name: context.actor.display_name,
    },
    membership: {
      role: context.membership.role,
      joined_at: context.membership.created_at,
    },
    permissions: permissionRows.map((row) => row.permission),
    visible: {
      scopes: scopes.map(serializeFlightDeckPgScope),
      channels: channels.map(serializeFlightDeckPgChannel),
    },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/me/autopilot-agents', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.read',
    resource: { type: 'workspace' },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'workspace.read');
  const settings = await getFlightDeckPgPersonalAgentSettings(context.workspace.id, context.actor.id);
  return c.json({
    identity,
    settings: settings ? {
      autopilot_agents: settings.autopilot_agents,
      row_version: settings.row_version,
      updated_at: settings.updated_at,
    } : {
      autopilot_agents: [],
      row_version: 0,
      updated_at: null,
    },
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/agents/:actorId/rotate-identity', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const body = await readJsonBody(c) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid_proof', message: 'body must be valid JSON' }, 400);
  if (Object.keys(body).some((key) => !['rotation_id', 'old_npub', 'new_npub', 'proof'].includes(key))) return c.json({ error: 'invalid_proof', message: 'body contains unsupported fields' }, 400);
  const rotationId = String(body.rotation_id || '').trim();
  const oldNpub = String(body.old_npub || '').trim();
  const newNpub = String(body.new_npub || '').trim();
  if (!rotationId || !oldNpub || !newNpub || !body.proof || typeof body.proof !== 'object') {
    return c.json({ error: 'invalid_proof', message: 'rotation_id, old_npub, new_npub, and proof are required' }, 400);
  }
  if (auth.signerNpub !== oldNpub || auth.userNpub !== oldNpub) return c.json({ error: 'stale_identity', message: 'NIP-98 must be signed directly by old_npub' }, 409);
  try {
    const result = await rotateFlightDeckPgAgentIdentity({
      towerOrigin: getEffectiveRequestUrl(c.req.raw).origin,
      workspaceId: c.req.param('workspaceId'),
      actorId: c.req.param('actorId'),
      requesterNpub: auth.signerNpub,
      rotation_id: rotationId,
      old_npub: oldNpub,
      new_npub: newNpub,
      proof: body.proof as AgentIdentityRotationProof,
    });
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof AgentIdentityRotationError) return c.json({ error: error.code, message: error.message }, error.status);
    console.error('Flight Deck PG actor identity rotation failed', { actor_id: c.req.param('actorId'), rotation_id: rotationId, error: error instanceof Error ? error.message : 'unknown error' });
    return c.json({ error: 'unsupported_records', message: 'Atomic identity rotation failed' }, 422);
  }
});

flightDeckPgRouter.put('/workspaces/:workspaceId/me/autopilot-agents', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.read',
    resource: { type: 'workspace' },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'workspace.read');
  const body = await readJsonBody(c) as Record<string, unknown> | null;
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const expectedRowVersion = Number(body.expected_row_version);
  const sourceAgents = body.autopilot_agents;
  const fields: { path: string; code: string; message: string }[] = [];
  if (!Number.isInteger(expectedRowVersion) || expectedRowVersion < 0) {
    fields.push({ path: 'expected_row_version', code: 'invalid', message: 'expected_row_version must be a non-negative integer' });
  }
  if (!Array.isArray(sourceAgents) || sourceAgents.length > 50) {
    fields.push({ path: 'autopilot_agents', code: 'invalid', message: 'autopilot_agents must be an array with at most 50 entries' });
  }
  const autopilotAgents: Array<{ agent_npub: string; url: string }> = [];
  const seen = new Set<string>();
  if (Array.isArray(sourceAgents)) {
    for (const [index, value] of sourceAgents.entries()) {
      const entry = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const agentNpub = String(entry.agent_npub || '').trim();
      const rawUrl = String(entry.url || '').trim();
      let validUrl = false;
      try {
        const parsed = new URL(rawUrl);
        validUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {}
      if (!agentNpub) fields.push({ path: `autopilot_agents.${index}.agent_npub`, code: 'required', message: 'agent_npub is required' });
      if (!validUrl) fields.push({ path: `autopilot_agents.${index}.url`, code: 'invalid', message: 'url must be an http(s) URL' });
      if (agentNpub && seen.has(agentNpub)) fields.push({ path: `autopilot_agents.${index}.agent_npub`, code: 'duplicate', message: 'agent_npub entries must be unique' });
      if (agentNpub) seen.add(agentNpub);
      if (agentNpub && validUrl) autopilotAgents.push({ agent_npub: agentNpub, url: rawUrl });
    }
  }
  if (fields.length) return validationError(c, identity, fields);

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const settings = await updateFlightDeckPgPersonalAgentSettings({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      autopilotAgents,
      expectedRowVersion,
    }, sql);
    if (!settings) return null;
    const outbox = await createFlightDeckPgPersonalAgentSettingsOutboxEvent({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      rowVersion: settings.row_version,
    }, sql);
    return { settings, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Personal agent settings row_version is stale', identity);
  return c.json({
    identity,
    settings: {
      autopilot_agents: payload.settings.autopilot_agents,
      row_version: payload.settings.row_version,
      updated_at: payload.settings.updated_at,
    },
    outbox: payload.outbox,
  });
});

async function updateFlightDeckPgMemberProfile(c: Context, selfService: boolean) {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
  if (!displayName) return validationError(c, identity, [{ path: 'display_name', code: 'required', message: 'display_name must be a non-empty string' }]);
  if (displayName.length > 120) return validationError(c, identity, [{ path: 'display_name', code: 'too_long', message: 'display_name must be at most 120 characters' }]);

  const targetActorId = selfService ? context.actor.id : c.req.param('actorId');
  if (!selfService && targetActorId !== context.actor.id) {
    const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
    if (manageError) return manageError;
  }

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const [target] = await sql<Array<FlightDeckPgActor & { membership_role: FlightDeckPgWorkspaceRole; membership_created_at: Date }>>`
      SELECT a.id, a.npub, a.kind, a.display_name,
             m.role AS membership_role, m.created_at AS membership_created_at
      FROM flightdeck_pg_workspace_memberships m
      JOIN flightdeck_pg_actors a ON a.id = m.actor_id
      WHERE m.workspace_id = ${context.workspace.id}
        AND a.id = ${targetActorId}
      LIMIT 1
    `;
    if (!target) return null;
    const actor = await updateFlightDeckPgActorDisplayName(target.id, displayName, sql);
    if (!actor) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'actor_profile.update',
      resourceType: 'actor',
      resourceId: actor.id,
      metadata: { display_name: displayName, self_service: actor.id === context.actor.id },
    }, sql);
    const outbox = await createFlightDeckPgActorProfileOutboxEvent({
      workspaceId: context.workspace.id,
      changedActorId: actor.id,
      actorId: context.actor.id,
      actorNpub: actor.npub,
      displayName,
    }, sql);
    return { actor, target, auditId, outbox };
  });
  if (!payload) return jsonError(c, 404, 'workspace_member_not_found', 'Workspace member not found', identity);
  return c.json({
    identity,
    actor: serializeFlightDeckPgActor(payload.actor),
    membership: {
      workspace_id: context.workspace.id,
      actor_id: payload.actor.id,
      role: payload.target.membership_role,
      joined_at: payload.target.membership_created_at,
    },
    audit: { event_id: payload.auditId, operation: 'actor_profile.update', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
}

flightDeckPgRouter.patch('/workspaces/:workspaceId/me', async (c) => updateFlightDeckPgMemberProfile(c, true));

flightDeckPgRouter.patch('/workspaces/:workspaceId/members/:actorId/profile', async (c) => updateFlightDeckPgMemberProfile(c, false));

flightDeckPgRouter.post('/workspaces/:workspaceId/storage/prepare', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c) as PrepareStorageInput | null;
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  if (!body?.content_type) return validationError(c, identity, [{ path: 'content_type', code: 'required', message: 'content_type required' }]);
  const metadata = optionalObject(body.metadata);
  if (metadata === null) return validationError(c, identity, [{ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' }]);
  const storagePurpose = String(metadata?.purpose || '').trim();
  const isWorkspaceProfileAvatar = storagePurpose === 'workspace-profile/avatar'
    && String(body.content_type || '').trim().toLowerCase().startsWith('image/');
  if (body.is_public === true && !isWorkspaceProfileAvatar) {
    return validationError(c, identity, [{
      path: 'is_public',
      code: 'invalid',
      message: 'public PG storage prepares are only allowed for workspace profile avatar images',
    }]);
  }

  try {
    const row = await prepareStorageObjectForAuthorizedOwner({
      ...body,
      owner_npub: context.workspace.workspace_owner_npub,
      owner_group_id: null,
      access_group_ids: [],
      is_public: body.is_public === true && isWorkspaceProfileAvatar,
    }, auth.userNpub);
    const origin = new URL(c.req.url).origin;
    const uploadUrl = await getStorageUploadUrl(row.id);
    const downloadUrl = await getStorageDownloadUrl(row.id);
    return c.json({
      identity,
      object_id: row.id,
      owner_npub: row.owner_npub,
      owner_group_id: row.owner_group_id,
      access_group_ids: row.access_group_ids,
      is_public: row.is_public,
      file_name: row.file_name,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      upload_url: uploadUrl || `${origin}/api/v4/storage/${row.id}`,
      complete_url: `${origin}/api/v4/storage/${row.id}/complete`,
      content_url: `${origin}/api/v4/storage/${row.id}/content`,
      download_url: downloadUrl || `${origin}/api/v4/storage/${row.id}/content`,
      completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
    }, 201);
  } catch (error) {
    return jsonError(c, 500, 'storage_prepare_failed', error instanceof Error ? error.message : 'Failed to prepare PG storage object', identity);
  }
});

flightDeckPgRouter.get('/workspaces/:workspaceId/drive/tree', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const scopeId = String(c.req.query('scope_id') || '').trim() || null;
  const channelId = String(c.req.query('channel_id') || '').trim() || null;
  const parentFolderIdSpecified = c.req.query('parent_folder_id') !== undefined;
  const parentFolderId = parentFolderIdSpecified
    ? String(c.req.query('parent_folder_id') || '').trim() || null
    : null;
  const cursorRaw = c.req.query('cursor') || null;
  const cursor = decodeFlightDeckPgDriveTreeCursor(cursorRaw);
  const fields: { path: string; code: string; message: string }[] = [];
  if (scopeId && !isUuid(scopeId)) fields.push({ path: 'scope_id', code: 'invalid', message: 'scope_id must be a UUID when provided' });
  if (channelId && !isUuid(channelId)) fields.push({ path: 'channel_id', code: 'invalid', message: 'channel_id must be a UUID when provided' });
  if (parentFolderId && !isUuid(parentFolderId)) fields.push({ path: 'parent_folder_id', code: 'invalid', message: 'parent_folder_id must be a UUID or empty root marker when provided' });
  if (!cursor) fields.push({ path: 'cursor', code: 'invalid', message: 'cursor must be an opaque Drive tree cursor returned by this endpoint' });
  if (fields.length) return validationError(c, identity, fields);

  if (channelId) {
    const access = await authorizeFlightDeckPgStorageRead({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      entityType: 'file',
      channelId,
    });
    if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.read or channel.read');
  }

  if (parentFolderId) {
    const parentFolder = await resolveFlightDeckPgFileFolder(context.workspace.id, parentFolderId);
    if (!parentFolder) return jsonError(c, 404, 'folder_not_found', 'Drive parent folder not found', identity);
    if ((scopeId && parentFolder.scope_id !== scopeId) || (channelId && parentFolder.channel_id !== channelId)) {
      return jsonError(c, 400, 'folder_scope_mismatch', 'Parent folder must match supplied scope_id and channel_id filters', identity);
    }
    const access = await authorizeFlightDeckPgStorageRead({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      entityType: 'file',
      channelId: parentFolder.channel_id,
    });
    if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.read or channel.read');
  }

  const items = await listFlightDeckPgDriveTree({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    groupIds: context.groupIds,
    scopeId,
    channelId,
    parentFolderId,
    parentFolderIdSpecified,
    afterSortKey: cursor.sortKey || null,
    limit: parseLimit(c),
  });

  return c.json({
    identity,
    items: items.map((item) => ({
      type: item.type,
      id: item.id,
      workspace_id: item.workspace_id,
      scope_id: item.scope_id,
      channel_id: item.channel_id,
      parent_folder_id: item.parent_folder_id,
      name: item.name,
      row_version: item.row_version,
      current_version_id: item.current_version_id,
      storage_object_id: item.storage_object_id,
      updated_at: item.updated_at,
      refetch: flightDeckPgDriveRefetchRoute(context.workspace.id, item.type, item.id),
    })),
    next_cursor: items.length > 0 ? encodeFlightDeckPgDriveTreeCursor(items.at(-1)!.sort_key) : null,
    cursor_semantics: {
      version: 1,
      order: 'Drive active file/folder items by stable type:id sort key',
      since: 'returns visible Drive tree items with sort key greater than the decoded cursor sortKey',
    },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/drive/delta', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const scopeId = String(c.req.query('scope_id') || '').trim() || null;
  const channelId = String(c.req.query('channel_id') || '').trim() || null;
  const cursorRaw = c.req.query('cursor') || c.req.query('since') || null;
  const cursor = decodeFlightDeckPgEventCursor(cursorRaw);
  const fields: { path: string; code: string; message: string }[] = [];
  if (scopeId && !isUuid(scopeId)) fields.push({ path: 'scope_id', code: 'invalid', message: 'scope_id must be a UUID when provided' });
  if (channelId && !isUuid(channelId)) fields.push({ path: 'channel_id', code: 'invalid', message: 'channel_id must be a UUID when provided' });
  if (!cursor) {
    fields.push({
      path: c.req.query('cursor') ? 'cursor' : 'since',
      code: 'invalid',
      message: 'cursor must be an opaque Flight Deck PG event cursor returned by this endpoint',
    });
  }
  if (fields.length) return validationError(c, identity, fields);

  if (channelId) {
    const access = await authorizeFlightDeckPgStorageRead({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      entityType: 'file',
      channelId,
    });
    if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.read or channel.read');
  }

  const events = await listVisibleFlightDeckPgDriveEvents({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    groupIds: context.groupIds,
    afterRowVersion: cursor.rowVersion,
    limit: parseLimit(c),
    scopeId,
    channelId,
  });
  const serializedEvents = events.map(serializeFlightDeckPgEvent);

  return c.json({
    identity,
    changes: serializedEvents.map((event) => {
      const type = event.entity_type === 'file_folder' ? 'folder' : 'file';
      return {
        type,
        id: event.entity_id,
        operation: event.operation,
        row_version: event.entity_row_version,
        event_row_version: event.row_version,
        cursor: event.cursor,
        scope_id: event.scope_id,
        channel_id: event.channel_id,
        timestamp: event.timestamp,
        tombstone: event.operation === 'deleted' ? event.payload?.tombstone ?? null : null,
        refetch: event.refetch.route || (event.entity_id ? flightDeckPgDriveRefetchRoute(context.workspace.id, type, event.entity_id) : null),
      };
    }),
    next_cursor: serializedEvents.at(-1)?.cursor ?? (cursor.rowVersion > 0 ? encodeFlightDeckPgEventCursor(cursor.rowVersion) : null),
    has_more: events.length >= parseLimit(c),
    cursor_semantics: {
      version: 1,
      order: 'flightdeck_pg_outbox_events.row_version ASC, created_at ASC, id ASC',
      since: 'returns visible file and folder events with row_version greater than the decoded cursor rowVersion',
    },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/sync', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const workspaceReadDecision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.read',
    resource: { type: 'workspace' },
  });
  const cursorRaw = c.req.query('cursor') || null;
  type SnapshotCursor = {
    version: 2;
    kind: 'workspace_snapshot';
    throughRowVersion: number;
    channelId: string | null;
    messageCreatedAt: string | null;
    messageId: string | null;
  };
  const decodeSnapshotCursor = (raw: string | null): SnapshotCursor | null => {
    if (!raw) return null;
    try {
      const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<SnapshotCursor>;
      if (value.version !== 2 || value.kind !== 'workspace_snapshot') return null;
      if (!Number.isInteger(value.throughRowVersion) || Number(value.throughRowVersion) < 0) return null;
      if (value.channelId !== null && (typeof value.channelId !== 'string' || !isUuid(value.channelId))) return null;
      if ((value.messageCreatedAt === null) !== (value.messageId === null)) return null;
      if (value.messageId !== null && (typeof value.messageId !== 'string' || !isUuid(value.messageId))) return null;
      if (value.messageCreatedAt !== null && typeof value.messageCreatedAt !== 'string') return null;
      return value as SnapshotCursor;
    } catch {
      return null;
    }
  };
  const encodeSnapshotCursor = (value: SnapshotCursor) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const snapshotCursor = decodeSnapshotCursor(cursorRaw);
  const cursor = snapshotCursor ? null : (cursorRaw ? decodeFlightDeckPgEventCursor(cursorRaw) : { version: 1, rowVersion: 0 });
  if (!snapshotCursor && !cursor) {
    return validationError(c, identity, [{
      path: 'query.cursor',
      code: 'invalid',
      message: 'cursor must be an opaque Flight Deck PG sync cursor returned by this endpoint',
    }]);
  }

  const requestedLimit = Number(c.req.query('limit') || 500);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 2_000)
    : 500;
  const fullSnapshot = !cursorRaw || Boolean(snapshotCursor);
  const sql = getDb();
  const events = fullSnapshot
    ? []
    : await listVisibleFlightDeckPgEvents({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      groupIds: context.groupIds,
      afterRowVersion: cursor!.rowVersion,
      limit,
      includeWorkspaceEvents: workspaceReadDecision.allowed,
    });

  const [highWater] = await sql<{ row_version: number }[]>`
    SELECT COALESCE(MAX(row_version), 0)::integer AS row_version
    FROM flightdeck_pg_outbox_events
    WHERE workspace_id = ${context.workspace.id}
  `;
  const throughRowVersion = fullSnapshot
    ? Number(snapshotCursor?.throughRowVersion ?? highWater?.row_version ?? 0)
    : Number(events.at(-1)?.row_version || cursor!.rowVersion || 0);

  const scopes = await listVisibleFlightDeckPgScopes({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    groupIds: context.groupIds,
    limit: 10_000,
  });
  const channels = (await Promise.all(scopes.map((scope) => listVisibleFlightDeckPgChannels({
    workspaceId: context.workspace.id,
    scopeId: scope.id,
    actorId: context.actor.id,
    groupIds: context.groupIds,
    limit: 10_000,
  })))).flat();
  const visibleChannelIds = new Set(channels.map((channel) => channel.id));
  const orderedVisibleChannelIds = [...visibleChannelIds].sort();
  const snapshotChannelId = fullSnapshot
    ? (snapshotCursor?.channelId ?? orderedVisibleChannelIds[0] ?? null)
    : null;
  if (snapshotChannelId && !visibleChannelIds.has(snapshotChannelId)) {
    return validationError(c, identity, [{
      path: 'query.cursor', code: 'invalid', message: 'snapshot cursor is no longer visible to this actor',
    }]);
  }
  const targetChannelIds = fullSnapshot
    ? (snapshotChannelId ? [snapshotChannelId] : [])
    : [...new Set(events.map((event) => event.channel_id).filter((channelId): channelId is string => Boolean(channelId && visibleChannelIds.has(channelId))))];

  const loadChannelBundle = async (channelId: string) => {
    const includeChannelCollections = !fullSnapshot || !snapshotCursor?.messageId;
    const [threads, messages, baseTasks, activeDocs, archivedDocs, activeFiles, archivedFiles, fileFolders, audioNotes] = await Promise.all([
      includeChannelCollections ? listFlightDeckPgChannelThreads({ workspaceId: context.workspace.id, channelId, limit: 10_000, includeArchived: true }) : Promise.resolve([]),
      listFlightDeckPgChannelMessages({
        workspaceId: context.workspace.id,
        channelId,
        limit: fullSnapshot ? limit + 1 : 10_000,
        afterCreatedAt: fullSnapshot && snapshotCursor?.channelId === channelId ? snapshotCursor.messageCreatedAt : null,
        afterId: fullSnapshot && snapshotCursor?.channelId === channelId ? snapshotCursor.messageId : null,
      }),
      includeChannelCollections ? listFlightDeckPgChannelTasks({ workspaceId: context.workspace.id, channelId, limit: 10_000 }) : Promise.resolve([]),
      includeChannelCollections ? listFlightDeckPgChannelDocs({ workspaceId: context.workspace.id, channelId, limit: 10_000 }) : Promise.resolve([]),
      includeChannelCollections ? listFlightDeckPgChannelDocs({ workspaceId: context.workspace.id, channelId, limit: 10_000, archived: true }) : Promise.resolve([]),
      includeChannelCollections ? listFlightDeckPgChannelFiles({ workspaceId: context.workspace.id, channelId, limit: 10_000 }) : Promise.resolve([]),
      includeChannelCollections ? listFlightDeckPgChannelFiles({ workspaceId: context.workspace.id, channelId, limit: 10_000, archived: true }) : Promise.resolve([]),
      includeChannelCollections ? listFlightDeckPgChannelFileFolders({ workspaceId: context.workspace.id, channelId, limit: 10_000 }) : Promise.resolve([]),
      includeChannelCollections ? listFlightDeckPgChannelAudioNotes({ workspaceId: context.workspace.id, channelId, limit: 10_000 }) : Promise.resolve([]),
    ]);
    const tasks = await withFlightDeckPgTaskAssignments(context.workspace.id, baseTasks);
    const taskComments = [];
    for (const task of tasks) taskComments.push(await listFlightDeckPgTaskComments({ workspaceId: context.workspace.id, taskId: task.id, limit: 10_000 }));
    const docComments = [];
    for (const doc of [...activeDocs, ...archivedDocs]) docComments.push(await listFlightDeckPgDocComments({ workspaceId: context.workspace.id, docId: doc.id, limit: 10_000 }));
    const pageMessages = fullSnapshot ? messages.slice(0, limit) : messages;
    return {
      channel_id: channelId,
      threads: includeChannelCollections ? threads.map(serializeFlightDeckPgThread) : [],
      messages: pageMessages.map(serializeFlightDeckPgMessage),
      tasks: includeChannelCollections ? tasks.map(serializeFlightDeckPgTask) : [],
      task_comments: includeChannelCollections ? taskComments.flat().map(serializeFlightDeckPgTaskComment) : [],
      docs: includeChannelCollections ? [...activeDocs, ...archivedDocs].map((doc) => serializeFlightDeckPgDoc(doc)) : [],
      doc_comments: includeChannelCollections ? docComments.flat().map(serializeFlightDeckPgDocComment) : [],
      files: includeChannelCollections ? [...activeFiles, ...archivedFiles].map((file) => serializeFlightDeckPgFile(file)) : [],
      file_folders: includeChannelCollections ? fileFolders.map(serializeFlightDeckPgFileFolder) : [],
      audio_notes: includeChannelCollections ? audioNotes.map((note) => serializeFlightDeckPgAudioNote(note)) : [],
      _message_has_more: fullSnapshot && messages.length > limit,
    };
  };
  const channelBundles = [];
  for (const channelId of targetChannelIds) channelBundles.push(await loadChannelBundle(channelId));

  const snapshotBundle = channelBundles[0];
  const snapshotMessages = snapshotBundle?.messages || [];
  const snapshotMessageHasMore = snapshotBundle?._message_has_more === true;
  const currentChannelIndex = snapshotChannelId ? orderedVisibleChannelIds.indexOf(snapshotChannelId) : -1;
  const nextSnapshotChannelId = currentChannelIndex >= 0 ? (orderedVisibleChannelIds[currentChannelIndex + 1] ?? null) : null;
  const snapshotHasMore = fullSnapshot && (snapshotMessageHasMore || Boolean(nextSnapshotChannelId));
  const nextSnapshotCursor = snapshotHasMore ? encodeSnapshotCursor({
    version: 2,
    kind: 'workspace_snapshot',
    throughRowVersion,
    channelId: snapshotMessageHasMore ? snapshotChannelId : nextSnapshotChannelId,
    messageCreatedAt: snapshotMessageHasMore ? String(snapshotMessages.at(-1)?.created_at || '') : null,
    messageId: snapshotMessageHasMore ? String(snapshotMessages.at(-1)?.id || '') : null,
  }) : null;
  for (const bundle of channelBundles) delete (bundle as Record<string, unknown>)._message_has_more;

  const changedEntityTypes = new Set(events.map((event) => event.entity_type));
  const refreshDirectory = workspaceReadDecision.allowed && (fullSnapshot || [...changedEntityTypes].some((type) => (
    ['actor', 'workspace_member', 'workspace_member_profile', 'group'].includes(type)
  )));
  const refreshDailyNotes = fullSnapshot || changedEntityTypes.has('daily_note');
  const refreshPersonalWapps = fullSnapshot || changedEntityTypes.has('personal_wapp');
  const manageDecision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.manage',
    resource: { type: 'workspace' },
  });
  const [members, groups, dailyNotes, personalWapps] = await Promise.all([
    refreshDirectory ? listFlightDeckPgWorkspaceMembers(context.workspace.id) : Promise.resolve([]),
    refreshDirectory && manageDecision.allowed ? listFlightDeckPgGroups(context.workspace.id) : Promise.resolve([]),
    refreshDailyNotes
      ? listFlightDeckPgDailyNotes({ workspaceId: context.workspace.id, actorId: context.actor.id, limit: 10_000 })
      : Promise.resolve([]),
    refreshPersonalWapps
      ? listFlightDeckPgPersonalWapps({ workspaceId: context.workspace.id, actorId: context.actor.id, limit: 10_000 })
      : Promise.resolve([]),
  ]);

  return c.json({
    identity,
    mode: fullSnapshot ? 'snapshot' : 'delta',
    from_cursor: cursorRaw,
    through_cursor: encodeFlightDeckPgEventCursor(throughRowVersion),
    next_cursor: nextSnapshotCursor || encodeFlightDeckPgEventCursor(throughRowVersion),
    has_more: fullSnapshot ? snapshotHasMore : events.length >= limit,
    full_snapshot: fullSnapshot,
    snapshot_complete: fullSnapshot ? !snapshotHasMore : undefined,
    changed_event_count: events.length,
    refreshed: {
      directory: refreshDirectory,
      daily_notes: refreshDailyNotes,
      personal_wapps: refreshPersonalWapps,
    },
    scopes: scopes.map(serializeFlightDeckPgScope),
    channels: channels.map(serializeFlightDeckPgChannel),
    channel_bundles: channelBundles,
    members: members.map((member) => ({
      actor: serializeFlightDeckPgActor(member.actor),
      ...(manageDecision.allowed ? { membership: serializeFlightDeckPgWorkspaceMembership(member.membership) } : {}),
    })),
    groups: groups.map(serializeFlightDeckPgGroup),
    daily_notes: dailyNotes.map(serializeFlightDeckPgDailyNote),
    personal_wapps: personalWapps.map(serializeFlightDeckPgPersonalWapp),
    tombstones: events
      .filter((event) => event.operation === 'deleted')
      .map((event) => ({
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        scope_id: event.scope_id,
        channel_id: event.channel_id,
        row_version: event.row_version,
      })),
  });
});

const FLIGHT_DECK_PG_EVENT_AUDIENCE_MAX = 32;

function parseFlightDeckPgEventAudienceNpubs(c: Context): string[] {
  const values = new URL(c.req.url).searchParams.getAll('audience_npub')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].sort();
}

async function resolveFlightDeckPgEventAudience(input: {
  workspaceId: string;
  managerActorId: string;
  requestedNpubs: string[];
}) {
  if (input.requestedNpubs.length === 0) return { audience: [], rejectedNpubs: [] };
  const authorized = await listFlightDeckPgEventSubscriptionAgents({
    workspaceId: input.workspaceId,
    managerActorId: input.managerActorId,
  });
  const authorizedNpubs = new Set(authorized.map((agent) => agent.npub));
  const audience = [];
  const rejectedNpubs: string[] = [];
  for (const npub of input.requestedNpubs) {
    if (!authorizedNpubs.has(npub)) {
      rejectedNpubs.push(npub);
      continue;
    }
    const member = await resolveFlightDeckPgRequestContext({ workspaceId: input.workspaceId, actorNpub: npub });
    if (!member.workspace || !member.actor || !member.membership) {
      rejectedNpubs.push(npub);
      continue;
    }
    const workspaceReadDecision = await authorizeFlightDeckPgOperation({
      actorNpub: npub,
      appNpub: member.workspace.app_npub,
      workspaceId: member.workspace.id,
      permission: 'workspace.read',
      resource: { type: 'workspace' },
    });
    audience.push({
      actorId: member.actor.id,
      npub,
      groupIds: member.groupIds,
      includeWorkspaceEvents: workspaceReadDecision.allowed,
    });
  }
  return { audience, rejectedNpubs };
}

flightDeckPgRouter.get('/workspaces/:workspaceId/event-subscription-agents', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'event_subscription.manage', resource: { type: 'workspace' } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'event_subscription.manage');
  const agents = await listFlightDeckPgEventSubscriptionAgents({ workspaceId: context.workspace.id, managerActorId: context.actor.id });
  const audienceNpubs = agents.map((agent) => agent.npub);
  return c.json({ identity, manager_npub: auth.userNpub, agent_npubs: audienceNpubs, audience_npubs: audienceNpubs, rejected_audience: [] });
});

flightDeckPgRouter.put('/workspaces/:workspaceId/event-subscription-agents', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'event_subscription.manage', resource: { type: 'workspace' } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'event_subscription.manage');
  const body = await readJsonBody(c);
  const rawAudience = body && (Array.isArray(body.audience_npubs) ? body.audience_npubs : body.agent_npubs);
  if (!body || !Array.isArray(rawAudience)) return validationError(c, identity, [{ path: 'agent_npubs', code: 'required', message: 'agent_npubs or audience_npubs must be an array' }]);
  const rawNpubs = rawAudience.map((value: unknown) => String(value || '').trim());
  const agentNpubs = [...new Set(rawNpubs)].sort();
  if (rawNpubs.some((npub: string) => !npub) || agentNpubs.length !== rawNpubs.length || agentNpubs.length > FLIGHT_DECK_PG_EVENT_AUDIENCE_MAX) {
    return validationError(c, identity, [{ path: 'agent_npubs', code: 'invalid', message: `agent_npubs must contain at most ${FLIGHT_DECK_PG_EVENT_AUDIENCE_MAX} distinct non-empty npubs` }]);
  }
  try {
    const reconciliation = await replaceFlightDeckPgEventSubscriptionAgents({ workspaceId: context.workspace.id, managerActorId: context.actor.id, authorizedByActorId: context.actor.id, agentNpubs });
    const audienceNpubs = reconciliation.audience.map((member) => member.npub);
    return c.json({
      identity,
      manager_npub: auth.userNpub,
      agent_npubs: audienceNpubs,
      audience_npubs: audienceNpubs,
      rejected_audience: reconciliation.rejectedAudience,
    });
  } catch (error) {
    return validationError(c, identity, [{ path: 'agent_npubs', code: 'invalid', message: error instanceof Error ? error.message : 'invalid agent_npubs' }]);
  }
});

flightDeckPgRouter.get('/workspaces/:workspaceId/events', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const cursorRaw = c.req.query('cursor') || c.req.query('since') || null;
  const cursor = decodeFlightDeckPgEventCursor(cursorRaw);
  if (!cursor) {
    return validationError(c, identity, [{
      path: c.req.query('cursor') ? 'query.cursor' : 'query.since',
      code: 'invalid',
      message: 'cursor must be an opaque Flight Deck PG event cursor returned by this endpoint',
    }]);
  }

  const workspaceReadDecision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.read',
    resource: { type: 'workspace' },
  });
  const requestedNpubs = parseFlightDeckPgEventAudienceNpubs(c);
  if (requestedNpubs.length > FLIGHT_DECK_PG_EVENT_AUDIENCE_MAX) return validationError(c, identity, [{ path: 'query.audience_npub', code: 'invalid', message: `at most ${FLIGHT_DECK_PG_EVENT_AUDIENCE_MAX} audience npubs may be requested` }]);
  if (requestedNpubs.length > 0) {
    const manageDecision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'event_subscription.manage', resource: { type: 'workspace' } });
    if (!manageDecision.allowed) return authorizationError(c, manageDecision, identity, 'event_subscription.manage');
  }
  const resolvedAudience = requestedNpubs.length > 0
    ? await resolveFlightDeckPgEventAudience({ workspaceId: context.workspace.id, managerActorId: context.actor.id, requestedNpubs })
    : null;
  const limit = parseLimit(c);
  const unionPage = resolvedAudience
    ? await listVisibleFlightDeckPgEventsForAudience({ workspaceId: context.workspace.id, audience: resolvedAudience.audience, afterRowVersion: cursor.rowVersion, limit })
    : null;
  const visibleEvents = unionPage?.events ?? (await listVisibleFlightDeckPgEvents({ workspaceId: context.workspace.id, actorId: context.actor.id, groupIds: context.groupIds, afterRowVersion: cursor.rowVersion, limit, includeWorkspaceEvents: workspaceReadDecision.allowed }))
    .map((event) => ({ event, visibleToAgentNpubs: [] }));
  const serializedEvents = visibleEvents.map(({ event, visibleToAgentNpubs }) => ({
    ...serializeFlightDeckPgEvent(event),
    ...(resolvedAudience ? {
      visible_to_agent_npubs: visibleToAgentNpubs,
      visible_to_audience_npubs: visibleToAgentNpubs,
    } : {}),
  }));

  return c.json({
    identity,
    events: serializedEvents,
    ...(resolvedAudience ? {
      subscription_audience_npubs: resolvedAudience.audience.map((member) => member.npub),
      rejected_audience_npubs: resolvedAudience.rejectedNpubs,
    } : {}),
    next_cursor: unionPage ? encodeFlightDeckPgEventCursor(unionPage.throughRowVersion) : (serializedEvents.at(-1)?.cursor ?? (cursor.rowVersion > 0 ? encodeFlightDeckPgEventCursor(cursor.rowVersion) : null)),
    ...(unionPage ? { through_cursor: encodeFlightDeckPgEventCursor(unionPage.throughRowVersion) } : {}),
    cursor_semantics: {
      version: 1,
      order: 'flightdeck_pg_outbox_events.row_version ASC, created_at ASC, id ASC',
      since: 'returns only visible events with row_version greater than the decoded cursor row_version',
    },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/invocations', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const roleRaw = String(c.req.query('role') || 'visible').trim();
  const role = roleRaw === 'recipient' || roleRaw === 'created_by' || roleRaw === 'all_visible' ? roleRaw : 'visible';
  const statusRaw = String(c.req.query('status') || '').trim();
  const status = statusRaw ? statusRaw as FlightDeckPgInvocationStatus : null;
  const targetTypeRaw = String(c.req.query('target_type') || '').trim();
  const targetType = targetTypeRaw === 'doc' ? 'document' : targetTypeRaw;
  const updatedSinceRaw = String(c.req.query('updated_since') || '').trim();
  const updatedSince = updatedSinceRaw ? new Date(updatedSinceRaw) : null;
  const fields: { path: string; code: string; message: string }[] = [];
  if (statusRaw && !invocationStatuses.has(statusRaw as FlightDeckPgInvocationStatus)) {
    fields.push({ path: 'status', code: 'invalid', message: 'status must be open or closed' });
  }
  if (targetType && !invocationTargetTypes.has(targetType as FlightDeckPgInvocationTargetType)) {
    fields.push({ path: 'target_type', code: 'invalid', message: 'target_type must be document, task, or file' });
  }
  if (updatedSinceRaw && (!updatedSince || Number.isNaN(updatedSince.getTime()))) {
    fields.push({ path: 'updated_since', code: 'invalid', message: 'updated_since must be an ISO timestamp' });
  }
  if (fields.length) return validationError(c, identity, fields);

  const invocations = await listVisibleFlightDeckPgInvocations({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    actorNpub: auth.userNpub,
    groupIds: context.groupIds,
    role,
    status,
    invocationId: String(c.req.query('invocation_id') || '').trim() || null,
    recipientNpub: String(c.req.query('recipient_npub') || '').trim() || null,
    createdByNpub: String(c.req.query('created_by_npub') || '').trim() || null,
    targetType: targetType ? targetType as FlightDeckPgInvocationTargetType : null,
    targetId: String(c.req.query('target_id') || '').trim() || null,
    scopeId: String(c.req.query('scope_id') || '').trim() || null,
    channelId: String(c.req.query('channel_id') || '').trim() || null,
    updatedSince,
    limit: parseLimit(c),
  });

  const serialized = await Promise.all(invocations.map((invocation) => serializeFlightDeckPgInvocation(invocation)));
  return c.json({ identity, invocations: serialized, next_cursor: null });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/invocations', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const scopeId = String(body.scope_id || '').trim();
  const channelId = String(body.channel_id || '').trim();
  const prompt = String(body.prompt || '').trim();
  const metadata = optionalObject(body.metadata);
  const trigger = String(body.trigger || metadata?.trigger || '').trim();
  const clientRequestId = String(body.client_request_id || metadata?.client_request_id || '').trim();
  const fields: { path: string; code: string; message: string }[] = [];
  if (!scopeId) fields.push({ path: 'scope_id', code: 'required', message: 'scope_id is required' });
  if (!channelId) fields.push({ path: 'channel_id', code: 'required', message: 'channel_id is required' });
  if (!prompt) fields.push({ path: 'prompt', code: 'required', message: 'prompt is required' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (trigger && trigger !== 'full_document_review_requested') fields.push({ path: 'trigger', code: 'invalid', message: 'trigger must be full_document_review_requested when provided' });
  if (trigger === 'full_document_review_requested' && !clientRequestId) fields.push({ path: 'client_request_id', code: 'required', message: 'client_request_id is required for deterministic full-document review dispatch' });
  const recipientRequests = parseInvocationRecipients(body.recipients, fields);
  const targets = parseInvocationTargets(body.targets, fields);
  if (fields.length) return validationError(c, identity, fields);

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel || channel.scope_id !== scopeId) {
    return validationError(c, identity, [{ path: 'channel_id', code: 'invalid', message: 'channel_id must belong to scope_id in this workspace' }]);
  }

  const creatorChannelDecision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.read',
    resource: { type: 'channel', channelId },
  });
  if (!creatorChannelDecision.allowed) return authorizationError(c, creatorChannelDecision, identity, 'channel.read');

  const normalizedTargets: FlightDeckPgInvocationTarget[] = [];
  for (const [index, target] of targets.entries()) {
    const targetContext = await resolveInvocationTargetContext(context.workspace.id, target);
    if (!targetContext) {
      return validationError(c, identity, [{ path: `targets.${index}.id`, code: 'not_found', message: 'target was not found in this workspace' }]);
    }
    if (targetContext.scopeId !== scopeId || targetContext.channelId !== channelId) {
      return validationError(c, identity, [{ path: `targets.${index}.id`, code: 'invalid_channel', message: 'target must belong to the invocation scope and channel' }]);
    }
    const permission = invocationReadPermissionForTarget(target.type);
    const creatorTargetDecision = await authorizeFlightDeckPgOperation({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission,
      resource: { type: 'channel', channelId },
    });
    if (!creatorTargetDecision.allowed) return authorizationError(c, creatorTargetDecision, identity, permission);
    normalizedTargets.push({ ...target, title: targetContext.title });
  }

  const recipients: FlightDeckPgInvocationRecipient[] = [];
  for (const [index, recipient] of recipientRequests.entries()) {
    const actor = recipient.actorId
      ? await getFlightDeckPgWorkspaceMembership(context.workspace.id, recipient.actorId).then(async (membership) => {
          if (!membership) return null;
          const resolved = await resolveFlightDeckPgActorByNpub(recipient.npub);
          return resolved?.id === recipient.actorId ? resolved : null;
        })
      : await resolveFlightDeckPgActorByNpub(recipient.npub);
    if (!actor) {
      return validationError(c, identity, [{ path: `recipients.${index}.npub`, code: 'not_found', message: 'recipient is not a workspace actor' }]);
    }
    const membership = await getFlightDeckPgWorkspaceMembership(context.workspace.id, actor.id);
    if (!membership) {
      return validationError(c, identity, [{ path: `recipients.${index}.npub`, code: 'not_member', message: 'recipient is not a member of this workspace' }]);
    }
    const channelDecision = await authorizeFlightDeckPgOperation({
      actorNpub: actor.npub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'channel.read',
      resource: { type: 'channel', channelId },
    });
    if (!channelDecision.allowed) {
      return validationError(c, identity, [{ path: `recipients.${index}.npub`, code: 'permission_denied', message: 'recipient cannot read the invocation channel' }]);
    }
    for (const target of normalizedTargets) {
      const permission = invocationReadPermissionForTarget(target.type);
      const targetDecision = await authorizeFlightDeckPgOperation({
        actorNpub: actor.npub,
        appNpub: context.workspace.app_npub,
        workspaceId: context.workspace.id,
        permission,
        resource: { type: 'channel', channelId },
      });
      if (!targetDecision.allowed) {
        return validationError(c, identity, [{ path: `recipients.${index}.npub`, code: 'permission_denied', message: `recipient cannot read ${target.type} target ${target.id}` }]);
      }
    }
    recipients.push({
      type: recipient.type,
      npub: actor.npub,
      actor_id: actor.id,
      status: 'pending',
      metadata: recipient.metadata,
    });
  }

  if (trigger === 'full_document_review_requested') {
    if (normalizedTargets.length !== 1 || normalizedTargets[0]?.type !== 'document') {
      return validationError(c, identity, [{ path: 'targets', code: 'invalid', message: 'full_document_review_requested requires exactly one document target' }]);
    }
    if (recipients.length !== 1 || recipients[0]?.type !== 'agent') {
      return validationError(c, identity, [{ path: 'recipients', code: 'invalid', message: 'full_document_review_requested requires exactly one agent recipient' }]);
    }
  }

  const requestHash = createHash('sha256').update(JSON.stringify({ scope_id: scopeId, channel_id: channelId, prompt, recipients, targets: normalizedTargets, trigger })).digest('hex');
  if (clientRequestId) {
    const [existingInvocation] = await getDb()<FlightDeckPgInvocationRow[]>`
      SELECT i.*, creator.npub AS created_by_actor_npub
      FROM flightdeck_pg_invocations i
      LEFT JOIN flightdeck_pg_actors creator ON creator.id = i.created_by_actor_id
      WHERE i.workspace_id = ${context.workspace.id}
        AND i.metadata->>'client_request_id' = ${clientRequestId}
      LIMIT 1
    `;
    if (existingInvocation) {
      if (existingInvocation.metadata?.request_hash !== requestHash) {
        return jsonError(c, 409, 'client_request_conflict', 'client_request_id was already used with a different invocation request', identity);
      }
      return c.json({ identity, invocation: await serializeFlightDeckPgInvocation(existingInvocation), replayed: true }, 200);
    }
  }

  const canonicalInvocationMetadata = { ...(metadata ?? {}), ...(trigger ? { trigger } : {}), ...(clientRequestId ? { client_request_id: clientRequestId, request_hash: requestHash } : {}), author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } };
  const invocation = await createFlightDeckPgInvocation({
    workspaceId: context.workspace.id,
    scopeId,
    channelId,
    actorId: context.actor.id,
    prompt,
    recipients,
    targets: normalizedTargets,
    metadata: canonicalInvocationMetadata,
  });
  const outbox = await createFlightDeckPgInvocationOutboxEvent({
    workspaceId: context.workspace.id,
    scopeId,
    channelId,
    actorId: context.actor.id,
    invocation,
    createdByNpub: auth.userNpub,
  });

  let triggerOutbox = null;
  if (trigger === 'full_document_review_requested') {
    const document = await resolveFlightDeckPgDoc(context.workspace.id, normalizedTargets[0]!.id);
    const bodyVersion = await documentBodyVersionInfo(document?.storage_object_id);
    triggerOutbox = await createFlightDeckPgDocOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId,
      channelId,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.full_document_review_requested',
      entityType: 'doc',
      entityId: document!.id,
      operation: 'updated',
      entityRowVersion: document!.row_version,
      payload: { trigger, invocation_id: invocation.id, client_request_id: clientRequestId, document_id: document!.id, doc_id: document!.id, workspace_id: context.workspace.id, scope_id: scopeId, channel_id: channelId, document_row_version: document!.row_version, body_version: bodyVersion, current_body_hash: bodyVersion.sha256_hex, agent: recipients[0], prompt, author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
    });
  }

  return c.json({ identity, invocation: await serializeFlightDeckPgInvocation(invocation), outbox, trigger_outbox: triggerOutbox, replayed: false }, 201);
});

async function readFlightDeckPgNotificationConfig(c: Context) {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { identity } = result;
  return c.json({
    identity,
    vapid_public_key: getFlightDeckPgVapidPublicKey(),
    subscription_scope: 'browser_install',
    preferences_scope: 'workspace_actor',
    categories: ['chat_thread', 'mention', 'dm', 'comment_tag', 'task_assignment'],
  });
}

flightDeckPgRouter.get('/workspaces/:workspaceId/notifications/config', readFlightDeckPgNotificationConfig);
flightDeckPgRouter.get('/workspaces/:workspaceId/notifications/settings', readFlightDeckPgNotificationConfig);

flightDeckPgRouter.get('/workspaces/:workspaceId/notifications/preferences', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const preferences = await getFlightDeckPgNotificationPreferences(context.workspace.id, context.actor.id);
  return c.json({ identity, preferences: serializeFlightDeckPgNotificationPreferences(preferences) });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/notifications/preferences', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const allowed = ['chat_threads_enabled', 'mentions_enabled', 'dms_enabled', 'comment_tags_enabled', 'task_assignments_enabled'] as const;
  const patch: Partial<Record<typeof allowed[number], boolean>> = {};
  const fields: { path: string; code: string; message: string }[] = [];
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') {
      fields.push({ path: key, code: 'invalid', message: `${key} must be a boolean` });
    } else {
      patch[key] = body[key];
    }
  }
  if (fields.length) return validationError(c, identity, fields);
  const preferences = await updateFlightDeckPgNotificationPreferences({ workspaceId: context.workspace.id, actorId: context.actor.id, patch });
  return c.json({ identity, preferences: serializeFlightDeckPgNotificationPreferences(preferences) });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/notifications/subscriptions', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const subscriptions = await listFlightDeckPgPushSubscriptionsForActor(context.actor.id);
  return c.json({ identity, subscriptions: subscriptions.map(serializeFlightDeckPgPushSubscription) });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/notifications/subscriptions', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const keys = body.keys && typeof body.keys === 'object' && !Array.isArray(body.keys) ? body.keys as Record<string, unknown> : {};
  const endpoint = String(body.endpoint || '').trim();
  const p256dh = String(body.p256dh || keys.p256dh || '').trim();
  const authKey = String(body.auth || keys.auth || '').trim();
  const fields: { path: string; code: string; message: string }[] = [];
  if (!endpoint || !/^https:\/\//i.test(endpoint)) fields.push({ path: 'endpoint', code: 'invalid', message: 'endpoint must be an HTTPS Web Push endpoint' });
  if (!p256dh) fields.push({ path: 'keys.p256dh', code: 'required', message: 'p256dh key is required' });
  if (!authKey) fields.push({ path: 'keys.auth', code: 'required', message: 'auth key is required' });
  if (fields.length) return validationError(c, identity, fields);
  const subscription = await upsertFlightDeckPgPushSubscription({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    endpoint,
    p256dh,
    auth: authKey,
    deviceLabel: typeof body.device_label === 'string' ? body.device_label : null,
    platform: typeof body.platform === 'string' ? body.platform : null,
    userAgent: c.req.header('user-agent') || null,
    appVersion: typeof body.app_version === 'string' ? body.app_version : null,
  });
  const preferences = await getFlightDeckPgNotificationPreferences(context.workspace.id, context.actor.id);
  const subscriptions = await listFlightDeckPgPushSubscriptionsForActor(context.actor.id);
  return c.json({
    identity,
    subscription: serializeFlightDeckPgPushSubscription(subscription),
    preferences: serializeFlightDeckPgNotificationPreferences(preferences),
    subscriptions: subscriptions.map(serializeFlightDeckPgPushSubscription),
  }, 201);
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/notifications/subscriptions/:subscriptionId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const subscription = await revokeFlightDeckPgPushSubscription({ actorId: context.actor.id, subscriptionId: c.req.param('subscriptionId') });
  if (!subscription) return jsonError(c, 404, 'subscription_not_found', 'Push subscription not found for this actor', identity);
  return c.json({ identity, subscription: serializeFlightDeckPgPushSubscription(subscription) });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/notifications/deliveries', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const deliveries = await listFlightDeckPgNotificationDeliveries({ workspaceId: context.workspace.id, actorId: context.actor.id, limit: parseLimit(c) });
  return c.json({ identity, deliveries, next_cursor: null });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/notifications/evaluate', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.read',
    resource: { type: 'workspace' },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'workspace.read');
  const body = await readJsonBody(c);
  const outboxEventId = body ? String(body.outbox_event_id || '').trim() : '';
  if (!outboxEventId) return validationError(c, identity, [{ path: 'outbox_event_id', code: 'required', message: 'outbox_event_id is required' }]);
  const evaluation = await evaluateFlightDeckPgNotificationOutboxEvent(outboxEventId);
  return c.json({ identity, evaluation });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/events/stream', async (c) => {
  const queryTokens = new URL(c.req.raw.url).searchParams.getAll('token');
  const queryToken = queryTokens[0];
  const auth = queryTokens.length > 0
    ? queryTokens.length === 1 && queryToken
      ? await resolveNip98AuthHeader(`Nostr ${queryToken}`, c.req.raw, {
          excludedQueryParams: ['token'],
        })
      : null
    : await requireNip98AuthResolved(c);
  if (!auth) return c.json({ error: 'nip98 auth required' }, 401);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const cursorRaw = c.req.query('cursor') || c.req.query('since') || null;
  const cursor = decodeFlightDeckPgEventCursor(cursorRaw);
  if (!cursor) {
    return validationError(c, identity, [{
      path: c.req.query('cursor') ? 'query.cursor' : 'query.since',
      code: 'invalid',
      message: 'cursor must be an opaque Flight Deck PG event cursor returned by this endpoint',
    }]);
  }

  const workspaceReadDecision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.read',
    resource: { type: 'workspace' },
  });
  const requestedNpubs = parseFlightDeckPgEventAudienceNpubs(c);
  if (requestedNpubs.length > FLIGHT_DECK_PG_EVENT_AUDIENCE_MAX) return validationError(c, identity, [{ path: 'query.audience_npub', code: 'invalid', message: `at most ${FLIGHT_DECK_PG_EVENT_AUDIENCE_MAX} audience npubs may be requested` }]);
  if (requestedNpubs.length > 0) {
    const manageDecision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'event_subscription.manage', resource: { type: 'workspace' } });
    if (!manageDecision.allowed) return authorizationError(c, manageDecision, identity, 'event_subscription.manage');
  }
  const initialAudience = requestedNpubs.length > 0
    ? await resolveFlightDeckPgEventAudience({ workspaceId: context.workspace.id, managerActorId: context.actor.id, requestedNpubs })
    : null;
  const limit = parseLimit(c);
  const streamSignal = c.req.raw.signal;

  let afterRowVersion = cursor.rowVersion;
  let closed = false;
  let inFlight = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let activeAudienceNpubs = initialAudience?.audience.map((member) => member.npub) ?? [];
  let rejectedAudienceNpubs = initialAudience?.rejectedNpubs ?? [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      };
      streamSignal.addEventListener('abort', close, { once: true });

      const poll = async () => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          if (initialAudience) {
            const manageDecision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'event_subscription.manage', resource: { type: 'workspace' } });
            if (!manageDecision.allowed) {
              controller.enqueue(encodeSseFrame({ event: 'flightdeck_pg.error', data: { error: 'event_subscription_manager_revoked' } }));
              close();
              controller.close();
              return;
            }
          }
          const currentAudience = initialAudience
            ? await resolveFlightDeckPgEventAudience({ workspaceId: context.workspace.id, managerActorId: context.actor.id, requestedNpubs })
            : null;
          const nextActiveAudienceNpubs = currentAudience?.audience.map((member) => member.npub) ?? [];
          const nextRejectedAudienceNpubs = currentAudience?.rejectedNpubs ?? [];
          if (initialAudience
            && (nextActiveAudienceNpubs.join('\n') !== activeAudienceNpubs.join('\n')
              || nextRejectedAudienceNpubs.join('\n') !== rejectedAudienceNpubs.join('\n'))) {
            activeAudienceNpubs = nextActiveAudienceNpubs;
            rejectedAudienceNpubs = nextRejectedAudienceNpubs;
            controller.enqueue(encodeSseFrame({
              event: 'flightdeck_pg.audience_changed',
              data: {
                subscription_audience_npubs: activeAudienceNpubs,
                rejected_audience_npubs: rejectedAudienceNpubs,
              },
            }));
          }
          const unionPage = currentAudience
            ? await listVisibleFlightDeckPgEventsForAudience({ workspaceId: context.workspace.id, audience: currentAudience.audience, afterRowVersion, limit })
            : null;
          const events = unionPage
            ? unionPage.events
            : (await listVisibleFlightDeckPgEvents({ workspaceId: context.workspace.id, actorId: context.actor.id, groupIds: context.groupIds, afterRowVersion, limit, includeWorkspaceEvents: workspaceReadDecision.allowed }))
              .map((event) => ({ event, visibleToAgentNpubs: [] }));
          for (const { event: row, visibleToAgentNpubs } of events) {
            if (closed) return;
            const event = {
              ...serializeFlightDeckPgEvent(row),
              ...(initialAudience ? {
                visible_to_agent_npubs: visibleToAgentNpubs,
                visible_to_audience_npubs: visibleToAgentNpubs,
              } : {}),
            };
            afterRowVersion = Math.max(afterRowVersion, row.row_version);
            controller.enqueue(encodeSseFrame({
              id: row.row_version,
              event: 'flightdeck_pg.event',
              data: event,
            }));
          }
          if (unionPage) afterRowVersion = Math.max(afterRowVersion, unionPage.throughRowVersion);
        } catch (error) {
          if (!closed) {
            controller.enqueue(encodeSseFrame({
              event: 'flightdeck_pg.error',
              data: {
                error: error instanceof Error ? error.message : 'Failed to read Flight Deck PG events',
              },
            }));
          }
        } finally {
          inFlight = false;
        }
      };

      controller.enqueue(encodeSseFrame({
        event: 'connected',
        data: {
          cursor: encodeFlightDeckPgEventCursor(afterRowVersion),
          poll_ms: FLIGHT_DECK_PG_EVENT_STREAM_POLL_MS,
          ...(initialAudience ? {
            subscription_audience_npubs: activeAudienceNpubs,
            rejected_audience_npubs: rejectedAudienceNpubs,
          } : {}),
        },
      }));
      void poll();
      pollTimer = setInterval(() => { void poll(); }, FLIGHT_DECK_PG_EVENT_STREAM_POLL_MS);
      heartbeatTimer = setInterval(() => {
        if (!closed) {
          controller.enqueue(encodeSseComment('heartbeat'));
        }
      }, FLIGHT_DECK_PG_EVENT_STREAM_HEARTBEAT_MS);
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/members', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const memberNpub = String(body.npub || body.actor_npub || body.member_npub || '').trim();
  const role = String(body.role || 'member').trim() as FlightDeckPgWorkspaceRole;
  const kind = String(body.kind || 'human').trim() as FlightDeckPgActorKind;
  const fields: { path: string; code: string; message: string }[] = [];
  if (!memberNpub) fields.push({ path: 'member_npub', code: 'required', message: 'member_npub must be a non-empty string' });
  if (!workspaceRoles.has(role)) fields.push({ path: 'role', code: 'invalid', message: 'role is not a valid workspace role' });
  if (!actorKinds.has(kind)) fields.push({ path: 'kind', code: 'invalid', message: 'kind is not a valid actor kind' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.invite',
    resource: { type: 'workspace' },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'workspace.invite');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const member = await createFlightDeckPgWorkspaceMember({
      workspaceId: context.workspace.id,
      actorNpub: memberNpub,
      kind,
      displayName: typeof body.display_name === 'string' ? body.display_name : null,
      role,
      createdByActorId: context.actor.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'workspace_member.create',
      resourceType: 'actor',
      resourceId: member.actor.id,
      metadata: { role },
    }, sql);
    return { ...member, auditId };
  });

  return c.json({
    identity,
    actor: {
      actor_id: payload.actor.id,
      npub: payload.actor.npub,
      kind: payload.actor.kind,
      display_name: payload.actor.display_name,
    },
    membership: {
      workspace_id: payload.membership.workspace_id,
      actor_id: payload.membership.actor_id,
      role: payload.membership.role,
      joined_at: payload.membership.created_at,
    },
    audit: {
      event_id: payload.auditId,
      operation: 'workspace_member.create',
      actor_npub: auth.userNpub,
    },
  }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/members', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  // Every workspace member may read the slim directory (actor identity only);
  // membership management fields stay behind workspace.manage.
  const readDecision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.read',
    resource: { type: 'workspace' },
  });
  if (!readDecision.allowed) return authorizationError(c, readDecision, identity, 'workspace.read');

  const manageDecision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.manage',
    resource: { type: 'workspace' },
  });

  const members = await listFlightDeckPgWorkspaceMembers(context.workspace.id);
  return c.json({
    identity,
    members: members.map((member) => ({
      actor: serializeFlightDeckPgActor(member.actor),
      ...(manageDecision.allowed
        ? { membership: serializeFlightDeckPgWorkspaceMembership(member.membership) }
        : {}),
    })),
    next_cursor: null,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/groups', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
  if (manageError) return manageError;

  const groups = await listFlightDeckPgGroups(context.workspace.id);
  return c.json({
    identity,
    groups: groups.map(serializeFlightDeckPgGroup),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/groups', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const name = String(body.name || '').trim();
  const kind = String(body.kind || 'custom').trim() as FlightDeckPgGroupKind;
  const fields: { path: string; code: string; message: string }[] = [];
  if (!name) fields.push({ path: 'name', code: 'required', message: 'name must be a non-empty string' });
  if (!groupKinds.has(kind)) fields.push({ path: 'kind', code: 'invalid', message: 'kind is not a valid editable group kind' });
  if (fields.length) return validationError(c, identity, fields);

  const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
  if (manageError) return manageError;

  let payload;
  try {
    payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const group = await createFlightDeckPgGroup({
        workspaceId: context.workspace.id,
        name,
        kind,
        createdByActorId: context.actor.id,
      }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'workspace_group.create',
        resourceType: 'group',
        resourceId: group.id,
        metadata: { name, kind },
      }, sql);
      return { group, auditId };
    });
  } catch (error) {
    if (error instanceof Error && /duplicate key value/i.test(error.message)) {
      return jsonError(c, 409, 'duplicate_group', 'Group name already exists in this workspace', identity);
    }
    return jsonError(c, 400, 'validation_error', error instanceof Error ? error.message : 'Group could not be created', identity);
  }

  const groups = await listFlightDeckPgGroups(context.workspace.id);
  const group = groups.find((item) => item.id === payload.group.id) ?? payload.group;
  return c.json({
    identity,
    group: serializeFlightDeckPgGroup(group),
    audit: {
      event_id: payload.auditId,
      operation: 'workspace_group.create',
      actor_npub: auth.userNpub,
    },
  }, 201);
});

flightDeckPgRouter.post('/workspaces/:workspaceId/groups/:groupId/members', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const groupId = String(c.req.param('groupId') || '').trim();
  const actorNpub = String(body.npub || body.actor_npub || body.member_npub || '').trim();
  const actorId = String(body.actor_id || '').trim();
  const fields: { path: string; code: string; message: string }[] = [];
  if (!groupId) fields.push({ path: 'group_id', code: 'required', message: 'group_id is required' });
  if (!actorId && !actorNpub) fields.push({ path: 'actor_id', code: 'required', message: 'actor_id or member_npub is required' });
  if (fields.length) return validationError(c, identity, fields);

  const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
  if (manageError) return manageError;

  const sql = getDb();
  if (!(await flightDeckPgGroupExists(context.workspace.id, groupId, sql))) {
    return jsonError(c, 404, 'group_not_found', 'Flight Deck PG group not found', identity);
  }
  const resolvedActorId = await resolveFlightDeckPgWorkspaceActorId(context.workspace.id, { actorId, actorNpub }, sql);
  if (!resolvedActorId) {
    return jsonError(c, 404, 'workspace_member_not_found', 'Actor is not a member of this Flight Deck PG workspace', identity);
  }

  const payload = await getDb().begin(async (tx) => {
    const txSql = asDbClient(tx);
    const membership = await addFlightDeckPgGroupMember({
      workspaceId: context.workspace.id,
      groupId,
      actorId: resolvedActorId,
      createdByActorId: context.actor.id,
    }, txSql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'workspace_group_member.add',
      resourceType: 'group',
      resourceId: groupId,
      metadata: { actor_id: resolvedActorId },
    }, txSql);
    return { membership, auditId };
  });

  const members = await listFlightDeckPgGroupMembers(context.workspace.id, groupId);
  const effectiveMembers = await listEffectiveFlightDeckPgGroupMembers(context.workspace.id, groupId);
  return c.json({
    identity,
    membership: payload.membership,
    members: members.map(serializeFlightDeckPgActor),
    effective_members: effectiveMembers.map(serializeFlightDeckPgActor),
    audit: {
      event_id: payload.auditId,
      operation: 'workspace_group_member.add',
      actor_npub: auth.userNpub,
    },
  }, 201);
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/groups/:groupId/members/:actorId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
  if (manageError) return manageError;

  const groupId = String(c.req.param('groupId') || '').trim();
  const actorId = String(c.req.param('actorId') || '').trim();
  const removed = await removeFlightDeckPgGroupMember(context.workspace.id, groupId, actorId);
  if (!removed) return jsonError(c, 404, 'group_member_not_found', 'Flight Deck PG group member not found', identity);
  const auditId = await writeFlightDeckPgAudit({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    action: 'workspace_group_member.remove',
    resourceType: 'group',
    resourceId: groupId,
    metadata: { actor_id: actorId },
  });
  return c.json({
    identity,
    removed: true,
    audit: {
      event_id: auditId,
      operation: 'workspace_group_member.remove',
      actor_npub: auth.userNpub,
    },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/groups/:groupId/effective-members', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
  if (manageError) return manageError;

  const groupId = String(c.req.param('groupId') || '').trim();
  if (!(await flightDeckPgGroupExists(context.workspace.id, groupId))) {
    return jsonError(c, 404, 'group_not_found', 'Flight Deck PG group not found', identity);
  }
  const members = await listEffectiveFlightDeckPgGroupMembers(context.workspace.id, groupId);
  return c.json({
    identity,
    group_id: groupId,
    effective_members: members.map(serializeFlightDeckPgActor),
    effective_member_npubs: members.map((member) => member.npub),
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/groups/:groupId/child-groups', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const parentGroupId = String(c.req.param('groupId') || '').trim();
  const childGroupId = String(body.child_group_id || body.group_id || '').trim();
  const fields: { path: string; code: string; message: string }[] = [];
  if (!parentGroupId) fields.push({ path: 'group_id', code: 'required', message: 'group_id is required' });
  if (!childGroupId) fields.push({ path: 'child_group_id', code: 'required', message: 'child_group_id must be a non-empty string' });
  if (fields.length) return validationError(c, identity, fields);

  const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
  if (manageError) return manageError;

  const edgeResult = await createFlightDeckPgNestedGroupEdge({
    workspaceId: context.workspace.id,
    parentGroupId,
    childGroupId,
    createdByActorId: context.actor.id,
  });
  if (!edgeResult.ok) return authorizationError(c, edgeResult.decision, identity, 'workspace.manage');
  const auditId = await writeFlightDeckPgAudit({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    action: 'workspace_group_edge.add',
    resourceType: 'group',
    resourceId: parentGroupId,
    metadata: { child_group_id: childGroupId },
  });
  return c.json({
    identity,
    edge: edgeResult.edge,
    audit: {
      event_id: auditId,
      operation: 'workspace_group_edge.add',
      actor_npub: auth.userNpub,
    },
  }, 201);
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/groups/:groupId/child-groups/:childGroupId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const manageError = await requireFlightDeckPgWorkspaceManage(c, auth.userNpub, context, identity);
  if (manageError) return manageError;

  const parentGroupId = String(c.req.param('groupId') || '').trim();
  const childGroupId = String(c.req.param('childGroupId') || '').trim();
  const removed = await removeFlightDeckPgNestedGroupEdge(context.workspace.id, parentGroupId, childGroupId);
  if (!removed) return jsonError(c, 404, 'group_edge_not_found', 'Flight Deck PG group edge not found', identity);
  const auditId = await writeFlightDeckPgAudit({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    action: 'workspace_group_edge.remove',
    resourceType: 'group',
    resourceId: parentGroupId,
    metadata: { child_group_id: childGroupId },
  });
  return c.json({
    identity,
    removed: true,
    audit: {
      event_id: auditId,
      operation: 'workspace_group_edge.remove',
      actor_npub: auth.userNpub,
    },
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/invites', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const memberNpub = String(body.npub || body.actor_npub || body.member_npub || body.invitee_npub || '').trim();
  const role = String(body.role || 'member').trim() as FlightDeckPgWorkspaceRole;
  const kind = String(body.kind || 'human').trim() as FlightDeckPgActorKind;
  const fields: { path: string; code: string; message: string }[] = [];
  if (!memberNpub) fields.push({ path: 'invitee_npub', code: 'required', message: 'invitee_npub must be a non-empty string' });
  if (!workspaceRoles.has(role)) fields.push({ path: 'role', code: 'invalid', message: 'role is not a valid workspace role' });
  if (!actorKinds.has(kind)) fields.push({ path: 'kind', code: 'invalid', message: 'kind is not a valid actor kind' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'workspace.invite',
    resource: { type: 'workspace' },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'workspace.invite');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const member = await createFlightDeckPgWorkspaceMember({
      workspaceId: context.workspace.id,
      actorNpub: memberNpub,
      kind,
      displayName: typeof body.display_name === 'string' ? body.display_name : null,
      role,
      createdByActorId: context.actor.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'workspace_invite.create',
      resourceType: 'actor',
      resourceId: member.actor.id,
      metadata: {
        role,
        invitee_npub: memberNpub,
        status: 'membership_recorded',
      },
    }, sql);
    return { ...member, auditId };
  });

  return c.json({
    identity,
    invite: {
      workspace_id: payload.membership.workspace_id,
      actor_id: payload.membership.actor_id,
      npub: payload.actor.npub,
      role: payload.membership.role,
      status: 'membership_recorded',
      created_at: payload.membership.created_at,
    },
    actor: {
      actor_id: payload.actor.id,
      npub: payload.actor.npub,
      kind: payload.actor.kind,
      display_name: payload.actor.display_name,
    },
    membership: {
      workspace_id: payload.membership.workspace_id,
      actor_id: payload.membership.actor_id,
      role: payload.membership.role,
      joined_at: payload.membership.created_at,
    },
    audit: {
      event_id: payload.auditId,
      operation: 'workspace_invite.create',
      actor_npub: auth.userNpub,
    },
  }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/scopes', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const scopes = await listVisibleFlightDeckPgScopes({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    groupIds: context.groupIds,
    limit: parseLimit(c),
  });
  const scopeManageDecisions = await Promise.all(scopes.map((scope) => authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'scope.manage',
    resource: { type: 'scope', scopeId: scope.id },
  })));
  return c.json({
    identity,
    scopes: scopes.map((scope, index) => ({
      ...serializeFlightDeckPgScope(scope),
      can_manage: scopeManageDecisions[index]?.allowed === true,
    })),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/scopes', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const name = String(body.name || '').trim();
  const kind = String(body.kind || '').trim() as FlightDeckPgScopeKind;
  const fields: { path: string; code: string; message: string }[] = [];
  if (!name) fields.push({ path: 'name', code: 'required', message: 'name must be a non-empty string' });
  if (!scopeKinds.has(kind)) fields.push({ path: 'kind', code: 'invalid', message: 'kind is not a valid scope kind' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'scope.create',
    resource: { type: 'workspace' },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'scope.create');

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const scope = await createFlightDeckPgScope({
        workspaceId: context.workspace.id,
        name,
        description: typeof body.description === 'string' ? body.description : null,
        kind,
        ownerGroupId: typeof body.owner_group_id === 'string' ? body.owner_group_id : null,
        createdByActorId: context.actor.id,
      }, sql);
      await sql`
        INSERT INTO flightdeck_pg_permission_grants (
          workspace_id,
          principal_type,
          principal_actor_id,
          resource_type,
          resource_scope_id,
          permission,
          created_by_actor_id
        )
        VALUES
          (${context.workspace.id}, 'actor', ${context.actor.id}, 'scope', ${scope.id}, 'scope.read', ${context.actor.id}),
          (${context.workspace.id}, 'actor', ${context.actor.id}, 'scope', ${scope.id}, 'scope.manage', ${context.actor.id}),
          (${context.workspace.id}, 'actor', ${context.actor.id}, 'scope', ${scope.id}, 'channel.create', ${context.actor.id})
      `;
      await sql`
        INSERT INTO flightdeck_pg_permission_grants (
          workspace_id,
          principal_type,
          principal_group_id,
          resource_type,
          resource_scope_id,
          permission,
          created_by_actor_id
        )
        SELECT ${context.workspace.id}, 'group', g.id, 'scope', ${scope.id}, 'channel.create', ${context.actor.id}
        FROM flightdeck_pg_groups g
        WHERE g.workspace_id = ${context.workspace.id}
          AND g.name = 'Admins'
      `;
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'scope.create',
        resourceType: 'scope',
        resourceId: scope.id,
      }, sql);
      return { scope, auditId };
    });

    return c.json({
      identity,
      scope: serializeFlightDeckPgScope(payload.scope),
      audit: {
        event_id: payload.auditId,
        operation: 'scope.create',
        actor_npub: auth.userNpub,
      },
    }, 201);
  } catch (error) {
    if (error instanceof Error && /duplicate key value/i.test(error.message)) {
      return jsonError(c, 409, 'duplicate_scope', 'Scope name already exists in this workspace', identity);
    }
    return jsonError(c, 400, 'validation_error', error instanceof Error ? error.message : 'Scope could not be created', identity);
  }
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/scopes/:scopeId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const scopeId = c.req.param('scopeId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const fields: { path: string; code: string; message: string }[] = [];
  const patch: { name?: string; description?: string | null } = {};
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = String(body.name || '').trim();
    if (!name) fields.push({ path: 'name', code: 'required', message: 'name must be a non-empty string' });
    patch.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    patch.description = typeof body.description === 'string' ? body.description : null;
  }
  if (Object.keys(patch).length === 0) fields.push({ path: 'body', code: 'required', message: 'name or description is required' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'scope.manage',
    resource: { type: 'scope', scopeId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'scope.manage');

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const scope = await updateFlightDeckPgScope({ workspaceId: context.workspace.id, scopeId, patch }, sql);
      if (!scope) return null;
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'scope.update',
        resourceType: 'scope',
        resourceId: scope.id,
        metadata: { fields: Object.keys(patch) },
      }, sql);
      return { scope, auditId };
    });
    if (!payload) return jsonError(c, 404, 'scope_not_found', 'Flight Deck PG scope not found', identity);
    return c.json({
      identity,
      scope: serializeFlightDeckPgScope(payload.scope),
      audit: { event_id: payload.auditId, operation: 'scope.update', actor_npub: auth.userNpub },
    });
  } catch (error) {
    if (error instanceof Error && /duplicate key value/i.test(error.message)) {
      return jsonError(c, 409, 'duplicate_scope', 'Scope name already exists in this workspace', identity);
    }
    return jsonError(c, 400, 'validation_error', error instanceof Error ? error.message : 'Scope could not be updated', identity);
  }
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/scopes/:scopeId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const scopeId = c.req.param('scopeId');

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'scope.manage',
    resource: { type: 'scope', scopeId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'scope.manage');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const scope = await archiveFlightDeckPgScope({
      workspaceId: context.workspace.id,
      scopeId,
    }, sql);
    if (!scope) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'scope.delete',
      resourceType: 'scope',
      resourceId: scope.id,
    }, sql);
    return { scope, auditId };
  });

  if (!payload) return jsonError(c, 404, 'scope_not_found', 'Flight Deck PG scope not found', identity);
  return c.json({
    identity,
    scope: serializeFlightDeckPgScope(payload.scope),
    audit: { event_id: payload.auditId, operation: 'scope.delete', actor_npub: auth.userNpub },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/scopes/:scopeId/channels', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const channels = await listVisibleFlightDeckPgChannels({
    workspaceId: context.workspace.id,
    scopeId: c.req.param('scopeId'),
    actorId: context.actor.id,
    groupIds: context.groupIds,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    scope_id: c.req.param('scopeId'),
    channels: channels.map(serializeFlightDeckPgChannel),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/scopes/:scopeId/channels', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const scopeId = c.req.param('scopeId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const name = String(body.name || '').trim();
  const kind = String(body.kind || 'channel').trim() as FlightDeckPgChannelKind;
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};
  const rawParticipantNpubs = Array.isArray(body.participant_npubs)
    ? body.participant_npubs
    : [body.participant_npub];
  const participantNpubs = [...new Set(rawParticipantNpubs.map((value: unknown) => String(value || '').trim()).filter(Boolean))];
  const fields: { path: string; code: string; message: string }[] = [];
  if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
    fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  }
  if (!name) fields.push({ path: 'name', code: 'required', message: 'name must be a non-empty string' });
  if (!channelKinds.has(kind)) fields.push({ path: 'kind', code: 'invalid', message: 'kind is not a valid channel kind' });
  if (kind !== 'dm' && participantNpubs.length > 0) fields.push({ path: 'participant_npubs', code: 'invalid', message: 'participant_npubs is only supported for DM channels' });
  if (kind === 'dm' && !participantNpubs.includes(auth.userNpub)) participantNpubs.unshift(auth.userNpub);
  if (kind === 'dm' && participantNpubs.length !== 2) {
    fields.push({ path: 'participant_npubs', code: 'invalid', message: 'DM channels require exactly two distinct participants' });
  }
  const normalizedChannelMetadata = validateFlightDeckPgChannelMetadata(metadata);
  fields.push(...normalizedChannelMetadata.errors);
  const initialGrants = parseInitialChannelGrants(body, fields);
  if (fields.length) return validationError(c, identity, fields);

  // DMs are member-to-member: any workspace member may open a DM with another
  // existing member. Named channels keep the scope-anchored channel.create rule.
  const dmParticipantActors: FlightDeckPgActor[] = [];
  if (kind === 'dm') {
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'workspace.read',
      resource: { type: 'workspace' },
    });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'workspace.read');
    for (const participantNpub of participantNpubs.filter((npub) => npub !== auth.userNpub)) {
      const participantActor = await resolveFlightDeckPgActorByNpub(participantNpub);
      const participantMembership = participantActor
        ? await getFlightDeckPgWorkspaceMembership(context.workspace.id, participantActor.id)
        : null;
      if (!participantActor || !participantMembership) {
        return jsonError(c, 403, 'dm_participant_not_member', 'DM participants must already be members of this workspace', identity);
      }
      dmParticipantActors.push(participantActor);
    }
  } else {
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'channel.create',
      resource: { type: 'scope', scopeId },
    });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.create');
  }

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const channel = await createFlightDeckPgChannel({
        workspaceId: context.workspace.id,
        scopeId,
        name,
        description: typeof body.description === 'string' ? body.description : null,
        metadata: normalizedChannelMetadata.metadata,
        kind,
        participantNpubs: kind === 'dm' ? participantNpubs : null,
        createdByActorId: context.actor.id,
      }, sql);
      await createFlightDeckPgChannelGrants({
        workspaceId: context.workspace.id,
        channel,
        principalType: 'actor',
        principalId: context.actor.id,
        permissions: kind === 'dm' ? dmParticipantPermissions : channelCreatorPermissions,
        createdByActorId: context.actor.id,
      }, sql);
      for (const grant of initialGrants) {
        await replaceFlightDeckPgChannelGrantBundle({
          workspaceId: context.workspace.id,
          channel,
          principalType: grant.principalType,
          principalId: grant.principalId,
          permissions: grant.permissions,
          createdByActorId: context.actor.id,
        }, sql);
      }
      for (const participantActor of dmParticipantActors) {
        await createFlightDeckPgChannelGrants({
          workspaceId: context.workspace.id,
          channel,
          principalType: 'actor',
          principalId: participantActor.id,
          permissions: dmParticipantPermissions,
          createdByActorId: context.actor.id,
        }, sql);
      }
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'channel.create',
        resourceType: 'channel',
        resourceId: channel.id,
        metadata: kind === 'dm' || initialGrants.length > 0
          ? { participant_npubs: participantNpubs, initial_grants: initialGrants.length }
          : undefined,
      }, sql);
      return { channel, auditId };
    });

    return c.json({
      identity,
      channel: serializeFlightDeckPgChannel(payload.channel),
      audit: {
        event_id: payload.auditId,
        operation: 'channel.create',
        actor_npub: auth.userNpub,
      },
    }, 201);
  } catch (error) {
    if (error instanceof Error && /duplicate key value/i.test(error.message)) {
      return jsonError(c, 409, 'duplicate_channel', 'Channel name already exists in this scope', identity);
    }
    return jsonError(c, 400, 'validation_error', error instanceof Error ? error.message : 'Channel could not be created', identity);
  }
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.read',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');

  return c.json({
    identity,
    channel: serializeFlightDeckPgChannel(channel),
  });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/channels/:channelId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const fields: { path: string; code: string; message: string }[] = [];
  const patch: { name?: string; description?: string | null; metadata?: Record<string, unknown> } = {};
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = String(body.name || '').trim();
    if (!name) fields.push({ path: 'name', code: 'required', message: 'name must be a non-empty string' });
    patch.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    patch.description = typeof body.description === 'string' ? body.description : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'metadata')) {
    if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object' });
    } else {
      patch.metadata = body.metadata as Record<string, unknown>;
    }
  }
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.manage',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.manage');

  const existingChannel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!existingChannel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);
  if (patch.metadata) {
    const mergedMetadata = { ...existingChannel.metadata, ...patch.metadata };
    if (!Object.prototype.hasOwnProperty.call(patch.metadata, 'agent_chat')
      && (Object.prototype.hasOwnProperty.call(patch.metadata, 'basePrompt') || Object.prototype.hasOwnProperty.call(patch.metadata, 'contextPrompt'))) {
      delete mergedMetadata.agent_chat;
    }
    const normalized = validateFlightDeckPgChannelMetadata(mergedMetadata, 'metadata', true);
    if (normalized.errors.length) return validationError(c, identity, normalized.errors);
    patch.metadata = normalized.metadata;
  }

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const channel = await updateFlightDeckPgChannel({
        workspaceId: context.workspace.id,
        channelId,
        patch,
      }, sql);
      if (!channel) return null;
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'channel.update',
        resourceType: 'channel',
        resourceId: channel.id,
        metadata: { fields: Object.keys(patch) },
      }, sql);
      return { channel, auditId };
    });
    if (!payload) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);
    return c.json({
      identity,
      channel: serializeFlightDeckPgChannel(payload.channel),
      audit: {
        event_id: payload.auditId,
        operation: 'channel.update',
        actor_npub: auth.userNpub,
      },
    });
  } catch (error) {
    if (error instanceof Error && /duplicate key value/i.test(error.message)) {
      return jsonError(c, 409, 'duplicate_channel', 'Channel name already exists in this scope', identity);
    }
    return jsonError(c, 400, 'validation_error', error instanceof Error ? error.message : 'Channel could not be updated', identity);
  }
});

flightDeckPgRouter.post('/workspaces/:workspaceId/channels/:channelId/reorder', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const requestedPosition = Number(body.position);
  if (!Number.isInteger(requestedPosition) || requestedPosition < 1) {
    return validationError(c, identity, [{ path: 'position', code: 'invalid', message: 'position must be a positive 1-based integer' }]);
  }

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.manage',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.manage');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const reordered = await reorderFlightDeckPgChannel({
      workspaceId: context.workspace.id,
      channelId,
      position: requestedPosition,
    }, sql);
    if (!reordered) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'channel.reorder',
      resourceType: 'channel',
      resourceId: reordered.channel.id,
      metadata: {
        previous_position: reordered.previousPosition,
        position: reordered.position,
        requested_position: requestedPosition,
        changed: reordered.changed,
      },
    }, sql);
    const outbox = [];
    if (reordered.changed) {
      for (const channel of reordered.channels) {
        outbox.push(await createFlightDeckPgChannelOutboxEvent({
          workspaceId: context.workspace.id,
          scopeId: channel.scope_id,
          channelId: channel.id,
          actorId: context.actor.id,
          eventType: 'flightdeck_pg.channel.reordered',
          entityId: channel.id,
          operation: 'updated',
          payload: {
            channel_id: channel.id,
            scope_id: channel.scope_id,
            position: channel.position,
            moved_channel_id: reordered.channel.id,
          },
        }, sql));
      }
    }
    return { ...reordered, auditId, outbox };
  });

  if (!payload) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);
  return c.json({
    identity,
    channel: serializeFlightDeckPgChannel(payload.channel),
    previous_position: payload.previousPosition,
    position: payload.position,
    requested_position: requestedPosition,
    channel_count: payload.channels.length,
    changed: payload.changed,
    audit: { event_id: payload.auditId, operation: 'channel.reorder', actor_npub: auth.userNpub },
    outbox: payload.outbox.map((event) => ({ id: event.id, row_version: event.row_version })),
  });
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/channels/:channelId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.manage',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.manage');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const channel = await archiveFlightDeckPgChannel({
      workspaceId: context.workspace.id,
      channelId,
    }, sql);
    if (!channel) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'channel.delete',
      resourceType: 'channel',
      resourceId: channel.id,
    }, sql);
    return { channel, auditId };
  });

  if (!payload) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);
  return c.json({
    identity,
    channel: serializeFlightDeckPgChannel(payload.channel),
    audit: { event_id: payload.auditId, operation: 'channel.delete', actor_npub: auth.userNpub },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId/grants', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.grants.read',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.grants.read');

  const grants = await listFlightDeckPgChannelGrants(context.workspace.id, channelId);
  return c.json({
    identity,
    channel_id: channelId,
    grants: serializeFlightDeckPgGrantBundles(grants),
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/channels/:channelId/grants', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const fields: { path: string; code: string; message: string }[] = [];
  const grantRequest = parseChannelGrantRequest(body, fields);
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.grants.manage',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.grants.manage');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const grants = grantRequest!.accessLevel
        ? await replaceFlightDeckPgChannelGrantBundle({
            workspaceId: context.workspace.id,
            channel,
            principalType: grantRequest!.principalType,
            principalId: grantRequest!.principalId,
            permissions: grantRequest!.permissions,
            createdByActorId: context.actor.id,
          }, sql)
        : await createFlightDeckPgChannelGrants({
            workspaceId: context.workspace.id,
            channel,
            principalType: grantRequest!.principalType,
            principalId: grantRequest!.principalId,
            permissions: grantRequest!.permissions,
            createdByActorId: context.actor.id,
          }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'channel_grant.create',
        resourceType: 'channel',
        resourceId: channel.id,
        metadata: {
          principal_type: grantRequest!.principalType,
          principal_id: grantRequest!.principalId,
          access_level: grantRequest!.accessLevel ?? 'custom',
          permissions: grantRequest!.permissions,
        },
      }, sql);
      return { grants, auditId };
    });

    return c.json({
      identity,
      grant: serializeFlightDeckPgGrant(payload.grants[0], grantRequest!.permissions),
      grants: serializeFlightDeckPgGrantBundles(payload.grants),
      audit: {
        event_id: payload.auditId,
        operation: 'channel_grant.create',
        actor_npub: auth.userNpub,
      },
    }, 201);
  } catch (error) {
    return jsonError(c, 400, 'validation_error', error instanceof Error ? error.message : 'Channel grants could not be created', identity);
  }
});

flightDeckPgRouter.put('/workspaces/:workspaceId/channels/:channelId/grants/:principalType/:principalId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');
  const requestedPrincipalType = String(c.req.param('principalType') || '').trim();
  const principalType = normalizeGrantPrincipalType(requestedPrincipalType);
  const principalId = String(c.req.param('principalId') || '').trim();

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const requestedAccessLevel = String(body.access_level || '').trim().toLowerCase();
  const permissions = isFlightDeckPgStandardAccessLevel(requestedAccessLevel)
    ? flightDeckPgPermissionsForAccessLevel(requestedAccessLevel)
    : (Array.isArray(body.permissions) ? body.permissions.map((permission) => String(permission).trim()) : []);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!principalType || !principalTypes.has(requestedPrincipalType)) fields.push({ path: 'principal_type', code: 'invalid', message: 'principal_type must be person or group' });
  if (!principalId) fields.push({ path: 'principal_id', code: 'required', message: 'principal_id must be a non-empty UUID string' });
  if (permissions.length === 0) fields.push({ path: 'permissions', code: 'required', message: 'permissions or access_level must describe View, Contribute, or Manage' });
  for (const permission of permissions) {
    if (!isFlightDeckPgChannelPermission(permission)) {
      fields.push({ path: 'permissions', code: 'invalid', message: `${permission} is not a channel-anchored Flight Deck PG permission` });
    }
  }
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.grants.manage',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.grants.manage');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const grants = await replaceFlightDeckPgChannelGrantBundle({
        workspaceId: context.workspace.id,
        channel,
        principalType: principalType!,
        principalId,
        permissions: permissions as FlightDeckPgPermission[],
        createdByActorId: context.actor.id,
      }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'channel_grant.update',
        resourceType: 'channel',
        resourceId: channel.id,
        metadata: { principal_type: principalType, principal_id: principalId, access_level: requestedAccessLevel || 'custom', permissions },
      }, sql);
      return { grants, auditId };
    });

    return c.json({
      identity,
      grant: serializeFlightDeckPgGrant(payload.grants[0], permissions as FlightDeckPgPermission[]),
      grants: serializeFlightDeckPgGrantBundles(payload.grants),
      audit: { event_id: payload.auditId, operation: 'channel_grant.update', actor_npub: auth.userNpub },
    });
  } catch (error) {
    return jsonError(c, 400, 'validation_error', error instanceof Error ? error.message : 'Channel grants could not be updated', identity);
  }
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/channels/:channelId/grants/:principalType/:principalId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');
  const requestedPrincipalType = String(c.req.param('principalType') || '').trim();
  const principalType = normalizeGrantPrincipalType(requestedPrincipalType);
  const principalId = String(c.req.param('principalId') || '').trim();

  const fields: { path: string; code: string; message: string }[] = [];
  if (!principalType || !principalTypes.has(requestedPrincipalType)) fields.push({ path: 'principal_type', code: 'invalid', message: 'principal_type must be person or group' });
  if (!principalId) fields.push({ path: 'principal_id', code: 'required', message: 'principal_id must be a non-empty UUID string' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.grants.manage',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.grants.manage');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const revoked = await revokeFlightDeckPgChannelGrantBundle({
      workspaceId: context.workspace.id,
      channelId,
      principalType: principalType!,
      principalId,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'channel_grant.delete',
      resourceType: 'channel',
      resourceId: channel.id,
      metadata: { principal_type: principalType, principal_id: principalId, revoked },
    }, sql);
    return { revoked, auditId };
  });

  return c.json({
    identity,
    revoked: payload.revoked,
    audit: { event_id: payload.auditId, operation: 'channel_grant.delete', actor_npub: auth.userNpub },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId/threads', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.read',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');

  const threads = await listFlightDeckPgChannelThreads({
    workspaceId: context.workspace.id,
    channelId,
    limit: parseLimit(c),
    includeArchived: c.req.query('include_archived') === 'true',
  });
  return c.json({
    identity,
    channel_id: channelId,
    threads: threads.map(serializeFlightDeckPgThread),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/channels/:channelId/threads', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const titleValidation = validateFlightDeckPgThreadTitle(body.title);
  const title = titleValidation.title;
  const sourceMessageId = typeof body.source_message_id === 'string' && body.source_message_id.trim()
    ? body.source_message_id.trim()
    : null;
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (titleValidation.error) fields.push({ path: 'title', code: title ? 'too_long' : 'required', message: titleValidation.error });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);

  const sourceMessage = sourceMessageId ? await resolveFlightDeckPgMessage(context.workspace.id, sourceMessageId) : null;
  if (sourceMessageId && (!sourceMessage || sourceMessage.channel_id !== channel.id)) {
    return jsonError(c, 404, 'source_message_not_found', 'Flight Deck PG source message not found in this channel', identity);
  }

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const thread = await createFlightDeckPgThread({
      workspaceId: context.workspace.id,
      channel,
      title,
      sourceMessageId,
      latest: typeof body.latest === 'string' ? body.latest : sourceMessage?.body ?? null,
      metadata: metadata ?? undefined,
      actorId: context.actor.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'thread.create',
      resourceType: 'thread',
      resourceId: thread.id,
      metadata: { channel_id: channel.id, scope_id: channel.scope_id, source_message_id: sourceMessageId },
    }, sql);
    const outbox = await createFlightDeckPgChatOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: thread.scope_id,
      channelId: thread.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.thread.created',
      entityType: 'thread',
      entityId: thread.id,
      operation: 'created',
      entityRowVersion: thread.row_version,
      payload: { thread_id: thread.id, source_message_id: sourceMessageId },
    }, sql);
    return { thread, auditId, outbox };
  });

  return c.json({
    identity,
    thread: serializeFlightDeckPgThread(payload.thread),
    audit: { event_id: payload.auditId, operation: 'thread.create', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/threads/:threadId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const thread = await resolveFlightDeckPgThread(context.workspace.id, c.req.param('threadId'));
  if (!thread) return jsonError(c, 404, 'thread_not_found', 'Flight Deck PG thread not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.read',
    resource: { type: 'channel', channelId: thread.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  if (context.actor.kind !== 'human' && !(await isFlightDeckPgThreadParticipant({
    workspaceId: context.workspace.id,
    threadId: thread.id,
    actorId: context.actor.id,
    actorNpub: auth.userNpub,
  }))) {
    return jsonError(c, 403, 'thread_participation_required', 'Bot must participate in the thread to read its title', identity);
  }
  return c.json({ identity, thread: serializeFlightDeckPgThread(thread) });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/threads/:threadId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const titleValidation = validateFlightDeckPgThreadTitle(body.title);
  const rowVersion = optionalRowVersion({ row_version: body.row_version });
  const fields: { path: string; code: string; message: string }[] = [];
  if (titleValidation.error) fields.push({ path: 'title', code: titleValidation.title ? 'too_long' : 'required', message: titleValidation.error });
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (fields.length) return validationError(c, identity, fields);

  const existing = await resolveFlightDeckPgThread(context.workspace.id, c.req.param('threadId'));
  if (!existing) return jsonError(c, 404, 'thread_not_found', 'Flight Deck PG thread not found', identity);
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId: existing.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');
  if (context.actor.kind !== 'human' && !(await isFlightDeckPgThreadParticipant({
    workspaceId: context.workspace.id,
    threadId: existing.id,
    actorId: context.actor.id,
    actorNpub: auth.userNpub,
  }))) {
    return jsonError(c, 403, 'thread_participation_required', 'Bot must participate in the thread to update its title', identity);
  }

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const thread = await updateFlightDeckPgThreadTitle({
      workspaceId: context.workspace.id,
      threadId: existing.id,
      title: titleValidation.title,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (!thread) return null;
    const auditId = await writeFlightDeckPgAudit({ workspaceId: context.workspace.id, actorId: context.actor.id, action: 'thread.rename', resourceType: 'thread', resourceId: thread.id, metadata: { channel_id: thread.channel_id, scope_id: thread.scope_id } }, sql);
    const outbox = await createFlightDeckPgChatOutboxEvent({ workspaceId: context.workspace.id, scopeId: thread.scope_id, channelId: thread.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.thread.updated', entityType: 'thread', entityId: thread.id, operation: 'renamed', entityRowVersion: thread.row_version, payload: { thread_id: thread.id, title: thread.title } }, sql);
    return { thread, auditId, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Thread row_version is stale', identity);
  return c.json({ identity, thread: serializeFlightDeckPgThread(payload.thread), audit: { event_id: payload.auditId, operation: 'thread.rename', actor_npub: auth.userNpub }, outbox: payload.outbox });
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/threads/:threadId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const threadId = c.req.param('threadId');
  const rowVersion = optionalRowVersion({ row_version: c.req.query('row_version') });
  if (Number.isNaN(rowVersion)) return validationError(c, identity, [{ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' }]);

  const thread = await resolveFlightDeckPgThread(context.workspace.id, threadId);
  if (!thread) return jsonError(c, 404, 'thread_not_found', 'Flight Deck PG thread not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId: thread.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const deleted = await deleteFlightDeckPgThread({
      workspaceId: context.workspace.id,
      threadId,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (!deleted) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'thread.delete',
      resourceType: 'thread',
      resourceId: deleted.id,
      metadata: { channel_id: deleted.channel_id, scope_id: deleted.scope_id, row_version: deleted.row_version },
    }, sql);
    const outbox = await createFlightDeckPgChatOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: deleted.scope_id,
      channelId: deleted.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.thread.deleted',
      entityType: 'thread',
      entityId: deleted.id,
      operation: 'deleted',
      entityRowVersion: deleted.row_version,
      payload: { thread_id: deleted.id },
    }, sql);
    return { thread: deleted, auditId, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Thread row_version is stale', identity);

  return c.json({
    identity,
    thread: serializeFlightDeckPgThread(payload.thread),
    audit: { event_id: payload.auditId, operation: 'thread.delete', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/threads/:threadId/archive', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const threadId = c.req.param('threadId');
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const archived = body.archived === true;
  if (body.archived !== true && body.archived !== false) {
    return validationError(c, identity, [{ path: 'archived', code: 'invalid', message: 'archived must be true or false' }]);
  }
  const rowVersion = optionalRowVersion({ row_version: body.row_version });
  if (Number.isNaN(rowVersion)) return validationError(c, identity, [{ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' }]);

  const thread = await resolveFlightDeckPgThread(context.workspace.id, threadId);
  if (!thread) return jsonError(c, 404, 'thread_not_found', 'Flight Deck PG thread not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId: thread.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const updated = await setFlightDeckPgThreadArchived({
      workspaceId: context.workspace.id,
      threadId,
      archived,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (!updated) return null;
    const operation = archived ? 'thread.archive' : 'thread.unarchive';
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: operation,
      resourceType: 'thread',
      resourceId: updated.id,
      metadata: { channel_id: updated.channel_id, scope_id: updated.scope_id, row_version: updated.row_version },
    }, sql);
    const outbox = await createFlightDeckPgChatOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: updated.scope_id,
      channelId: updated.channel_id,
      actorId: context.actor.id,
      eventType: archived ? 'flightdeck_pg.thread.archived' : 'flightdeck_pg.thread.unarchived',
      entityType: 'thread',
      entityId: updated.id,
      operation: archived ? 'archived' : 'unarchived',
      entityRowVersion: updated.row_version,
      payload: { thread_id: updated.id, archived },
    }, sql);
    return { thread: updated, auditId, outbox, operation };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Thread row_version is stale', identity);

  return c.json({
    identity,
    thread: serializeFlightDeckPgThread(payload.thread),
    audit: { event_id: payload.auditId, operation: payload.operation, actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId/messages', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');
  const threadId = c.req.query('thread_id') || null;
  const cursor = decodeFlightDeckPgMessageCursor(c.req.query('cursor'));
  if (!cursor) return validationError(c, identity, [{ path: 'query.cursor', code: 'invalid', message: 'cursor must be an opaque message cursor returned by this endpoint' }]);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.read',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');

  if (threadId) {
    const thread = await resolveFlightDeckPgThread(context.workspace.id, threadId);
    if (!thread || thread.channel_id !== channelId) {
      return jsonError(c, 404, 'thread_not_found', 'Flight Deck PG thread not found in this channel', identity);
    }
  }

  const limit = parseLimit(c);
  const rows = await listFlightDeckPgChannelMessages({
    workspaceId: context.workspace.id,
    channelId,
    threadId,
    limit: limit + 1,
    afterCreatedAt: cursor.createdAt,
    afterId: cursor.id,
  });
  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;
  return c.json({
    identity,
    channel_id: channelId,
    thread_id: threadId,
    messages: messages.map(serializeFlightDeckPgMessage),
    next_cursor: hasMore && messages.length ? encodeFlightDeckPgMessageCursor(messages[messages.length - 1]!) : null,
    cursor_semantics: { version: 1, order: 'created_at ASC, id ASC' },
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/channels/:channelId/messages', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const messageBody = String(body.body || '').trim();
  const requestedThreadId = typeof body.thread_id === 'string' && body.thread_id.trim() ? body.thread_id.trim() : null;
  const createThread = body.create_thread === true;
  const metadata = optionalObject(body.metadata);
  const clientRequestId = typeof body.client_request_id === 'string' ? body.client_request_id.trim() : null;
  const explicitThreadTitleValidation = body.thread_title !== undefined || body.title !== undefined
    ? validateFlightDeckPgThreadTitle(body.thread_title ?? body.title)
    : null;
  const fields: { path: string; code: string; message: string }[] = [];
  const parsedAttachments = parseFlightDeckPgMessageAttachmentStorageObjectIds(metadata?.attachments);
  fields.push(...parsedAttachments.errors);
  const hasAttachments = parsedAttachments.storageObjectIds.length > 0;
  if (!messageBody && !hasAttachments) fields.push({ path: 'body', code: 'required', message: 'body must be non-empty unless metadata.attachments contains at least one attachment' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (body.client_request_id !== undefined && !clientRequestId) fields.push({ path: 'client_request_id', code: 'invalid', message: 'client_request_id must be a non-empty string when provided' });
  if (clientRequestId && clientRequestId.length > MESSAGE_CLIENT_REQUEST_ID_MAX_LENGTH) fields.push({ path: 'client_request_id', code: 'too_long', message: `client_request_id must be at most ${MESSAGE_CLIENT_REQUEST_ID_MAX_LENGTH} characters` });
  if (createThread && requestedThreadId) {
    fields.push({ path: 'thread_id', code: 'conflict', message: 'thread_id cannot be combined with create_thread' });
  }
  if (createThread && explicitThreadTitleValidation?.error) {
    fields.push({ path: 'thread_title', code: explicitThreadTitleValidation.title ? 'too_long' : 'required', message: explicitThreadTitleValidation.error });
  }
  const mentionSource = body.mentions !== undefined ? body.mentions : metadata?.mentions;
  const parsedMentions = parseAgentMentionInputs(mentionSource, body.mentions !== undefined ? 'mentions' : 'metadata.mentions');
  fields.push(...parsedMentions.errors);
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);

  const attachmentValidation = await validateFlightDeckPgMessageAttachmentObjects({
    actorNpub: auth.userNpub,
    workspaceId: context.workspace.id,
    storageObjectIds: parsedAttachments.storageObjectIds,
  });
  if (!attachmentValidation.ok) {
    return validationError(c, identity, [{
      path: 'metadata.attachments',
      code: attachmentValidation.reason === 'workspace-mismatch' ? 'workspace_mismatch' : 'not_attachable',
      message: `storage object ${attachmentValidation.storageObjectId} is not attachable in this workspace`,
    }]);
  }

  if (requestedThreadId) {
    const thread = await resolveFlightDeckPgThread(context.workspace.id, requestedThreadId);
    if (!thread || thread.channel_id !== channel.id) {
      return jsonError(c, 404, 'thread_not_found', 'Flight Deck PG thread not found in this channel', identity);
    }
  }

  const canonicalMentions: Array<{ type: 'agent'; actor_id: string; npub: string; label?: string }> = [];
  for (const mention of parsedMentions.mentions) {
    const actor = await resolveFlightDeckPgActorByNpub(mention.npub);
    if (!actor) return validationError(c, identity, [{ path: 'metadata.mentions', code: 'unknown_actor', message: 'mentioned identity is not a workspace actor' }]);
    const mentionDecision = await authorizeFlightDeckPgOperation({
      actorNpub: actor.npub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'channel.read',
      resource: { type: 'channel', channelId },
    });
    if (!mentionDecision.allowed) return validationError(c, identity, [{ path: 'metadata.mentions', code: 'inaccessible_actor', message: 'mentioned actor is not permitted in this channel' }]);
    canonicalMentions.push({ type: 'agent' as const, actor_id: actor.id, npub: actor.npub, ...(mention.label ? { label: mention.label } : actor.display_name ? { label: actor.display_name } : {}) });
  }

  const signatureValidation = validateFlightDeckPgMessageInstructionSignature({
    value: body.message_signature,
    body: messageBody,
    actorNpub: auth.userNpub,
    workspaceId: context.workspace.id,
    channelId,
    threadId: requestedThreadId,
  });
  if (signatureValidation.errors.length || !signatureValidation.signature) {
    return validationError(c, identity, signatureValidation.errors);
  }
  const messageMetadata = {
    ...(metadata ?? {}),
    ...(mentionSource !== undefined ? { mentions: canonicalMentions } : {}),
    [AGENT_INSTRUCTION_SIGNATURE_METADATA_KEY]: signatureValidation.signature,
  };

  const clientRequestHash = clientRequestId
    ? createHash('sha256').update(JSON.stringify({
      channel_id: channel.id,
      thread_id: requestedThreadId,
      create_thread: createThread,
      body: messageBody,
      attachment_storage_object_ids: parsedAttachments.storageObjectIds,
    })).digest('hex')
    : null;

  let payload;
  try {
    payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
    if (clientRequestId) {
      await lockFlightDeckPgMessageIdempotencyKey({ workspaceId: context.workspace.id, actorId: context.actor.id, clientRequestId }, sql);
      const existing = await resolveFlightDeckPgMessageByClientRequestId({ workspaceId: context.workspace.id, actorId: context.actor.id, clientRequestId }, sql);
      if (existing) {
        if (existing.client_request_hash !== clientRequestHash) return { conflict: true as const };
        const thread = existing.thread_id ? await resolveFlightDeckPgThread(context.workspace.id, existing.thread_id, sql) : null;
        return { replayed: true as const, message: existing, thread };
      }
    }
    const explicitThreadTitle = body.thread_title ?? body.title;
    const threadTitle = explicitThreadTitle === undefined
      ? deriveFlightDeckPgThreadTitle(messageBody)
      : explicitThreadTitleValidation!.title;
    const createdThread = createThread
      ? await createFlightDeckPgThread({
        workspaceId: context.workspace.id,
        channel,
        title: threadTitle,
        latest: messageBody,
        metadata: {},
        actorId: context.actor.id,
      }, sql)
      : null;
    const message = await createFlightDeckPgMessage({
      workspaceId: context.workspace.id,
      channel,
      body: messageBody,
      threadId: createdThread?.id ?? requestedThreadId,
      metadata: messageMetadata,
      actorId: context.actor.id,
      clientRequestId,
      clientRequestHash,
    }, sql);
    const attachmentLinks = await syncFlightDeckPgMessageAttachmentLinks({
      workspaceId: context.workspace.id,
      channelId: channel.id,
      messageId: message.id,
      storageObjectIds: parsedAttachments.storageObjectIds,
      createdByActorId: context.actor.id,
    }, sql);
    Object.assign(message, {
      created_by_actor_npub: auth.userNpub,
      created_by_actor_label: context.actor.display_name,
    });
    const thread = createdThread
      ? await attachFlightDeckPgThreadSourceMessage({
        workspaceId: context.workspace.id,
        threadId: createdThread.id,
        sourceMessageId: message.id,
        latest: message.body,
        actorId: context.actor.id,
      }, sql)
      : requestedThreadId
        ? await touchFlightDeckPgThreadAfterMessage({
          workspaceId: context.workspace.id,
          threadId: requestedThreadId,
          latest: message.body,
          actorId: context.actor.id,
        }, sql)
      : null;
    const activity = thread
      ? await advanceFlightDeckPgResourceActivity({ workspaceId: context.workspace.id, actorId: context.actor.id, resourceType: 'thread', resourceId: thread.id }, sql)
      : null;
    if (activity && thread) thread.activity_version = activity.resource.activity_version;
    const viewStateOutbox = activity
      ? await createFlightDeckPgResourceViewStateOutboxEvent({ workspaceId: context.workspace.id, actorId: context.actor.id, state: activity.state, activityVersion: Number(activity.resource.activity_version) }, sql)
      : null;
    const messageAuditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'message.create',
      resourceType: 'message',
      resourceId: message.id,
      metadata: { channel_id: channel.id, scope_id: channel.scope_id, thread_id: message.thread_id },
    }, sql);
    const messageOutbox = await createFlightDeckPgChatOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: message.scope_id,
      channelId: message.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.message.created',
      entityType: 'message',
      entityId: message.id,
      operation: 'created',
      entityRowVersion: message.row_version,
      payload: {
        event_type: 'message.created',
        workspace_id: message.workspace_id,
        scope_id: message.scope_id,
        channel_id: message.channel_id,
        thread_id: message.thread_id,
        entity_type: 'message',
        entity_id: message.id,
        actor_id: context.actor.id,
        actor_npub: auth.userNpub,
        created_at: message.created_at,
        mentions: canonicalMentions,
      },
    }, sql);
    if (!thread) return { replayed: false as const, message, thread, auditId: messageAuditId, outbox: messageOutbox, threadOutbox: null, viewStateOutbox, attachmentLinks };

    const threadOperation = createdThread ? 'thread.create' : 'thread.update';
    const threadAuditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: threadOperation,
      resourceType: 'thread',
      resourceId: thread.id,
      metadata: { channel_id: channel.id, scope_id: channel.scope_id, source_message_id: thread.source_message_id, message_id: message.id },
    }, sql);
    const threadOutbox = await createFlightDeckPgChatOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: thread.scope_id,
      channelId: thread.channel_id,
      actorId: context.actor.id,
      eventType: createdThread ? 'flightdeck_pg.thread.created' : 'flightdeck_pg.thread.updated',
      entityType: 'thread',
      entityId: thread.id,
      operation: createdThread ? 'created' : 'updated',
      entityRowVersion: thread.row_version,
      payload: { thread_id: thread.id, source_message_id: thread.source_message_id, unarchived_by_message_id: createdThread ? null : message.id, activity_version: Number(thread.activity_version) },
    }, sql);
      return { replayed: false as const, message, thread, auditId: messageAuditId, threadAuditId, outbox: messageOutbox, threadOutbox, threadOperation, viewStateOutbox, attachmentLinks };
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Failed to create message';
    if (messageText.includes('already attached')) {
      return jsonError(c, 409, 'message_attachment_conflict', messageText, identity);
    }
    throw error;
  }
  if ('conflict' in payload) return jsonError(c, 409, 'idempotency_conflict', 'client_request_id was already used for a materially different message', identity);
  if (payload.replayed) {
    return c.json({
      identity,
      message: serializeFlightDeckPgMessage(payload.message),
      ...(payload.thread ? { thread: serializeFlightDeckPgThread(payload.thread) } : {}),
      created: false,
      replayed: true,
    });
  }
  await evaluateFlightDeckPgNotificationOutboxEvent(payload.outbox.id).catch(() => undefined);

  return c.json({
    identity,
    message: serializeFlightDeckPgMessage(payload.message),
    ...(payload.thread ? { thread: serializeFlightDeckPgThread(payload.thread) } : {}),
    audit: { event_id: payload.auditId, operation: 'message.create', actor_npub: auth.userNpub },
    outbox: payload.outbox,
    ...(payload.threadOutbox ? { thread_outbox: payload.threadOutbox } : {}),
    ...(payload.viewStateOutbox ? { view_state_outbox: payload.viewStateOutbox } : {}),
    ...(payload.threadOperation ? { thread_operation: payload.threadOperation } : {}),
    attachment_links: payload.attachmentLinks.links.map((link) => ({ id: link.id, storage_object_id: link.storage_object_id })),
    created: true,
    replayed: false,
  }, 201);
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/messages/:messageId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const messageId = c.req.param('messageId');
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const message = await resolveFlightDeckPgMessage(context.workspace.id, messageId);
  if (!message) return jsonError(c, 404, 'message_not_found', 'Flight Deck PG message not found', identity);
  if (message.created_by_actor_id !== context.actor.id) {
    return jsonError(c, 403, 'message_author_required', 'Only the message author may edit this message', identity);
  }

  const rowVersion = optionalRowVersion({ row_version: body.row_version });
  const messageBody = String(body.body ?? '').trim();
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (rowVersion === null) fields.push({ path: 'row_version', code: 'required', message: 'row_version is required for message edits' });
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  const mentionSource = body.mentions !== undefined ? body.mentions : metadata?.mentions;
  const previousMentions = Array.isArray(message.metadata?.mentions) ? message.metadata.mentions : [];
  const effectiveMentionSource = mentionSource === undefined ? previousMentions : mentionSource;
  const parsedMentions = parseAgentMentionInputs(effectiveMentionSource, body.mentions !== undefined ? 'mentions' : 'metadata.mentions');
  fields.push(...parsedMentions.errors);
  const mergedMetadata = { ...message.metadata, ...(metadata ?? {}) };
  const parsedAttachments = parseFlightDeckPgMessageAttachmentStorageObjectIds(mergedMetadata.attachments);
  fields.push(...parsedAttachments.errors);
  const hasAttachments = parsedAttachments.storageObjectIds.length > 0;
  if (!messageBody && !hasAttachments) fields.push({ path: 'body', code: 'required', message: 'body must be non-empty unless metadata.attachments contains at least one attachment' });
  if (fields.length || rowVersion === null || Number.isNaN(rowVersion)) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId: message.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const attachmentValidation = await validateFlightDeckPgMessageAttachmentObjects({
    actorNpub: auth.userNpub,
    workspaceId: context.workspace.id,
    storageObjectIds: parsedAttachments.storageObjectIds,
    messageId: message.id,
  });
  if (!attachmentValidation.ok) {
    return validationError(c, identity, [{
      path: 'metadata.attachments',
      code: attachmentValidation.reason === 'workspace-mismatch' ? 'workspace_mismatch' : 'not_attachable',
      message: `storage object ${attachmentValidation.storageObjectId} is not attachable in this workspace`,
    }]);
  }

  const canonicalMentions: Array<{ type: 'agent'; actor_id: string; npub: string; label?: string }> = [];
  for (const mention of parsedMentions.mentions) {
    const actor = await resolveFlightDeckPgActorByNpub(mention.npub);
    if (!actor) return validationError(c, identity, [{ path: 'metadata.mentions', code: 'unknown_actor', message: 'mentioned identity is not a workspace actor' }]);
    const mentionDecision = await authorizeFlightDeckPgOperation({
      actorNpub: actor.npub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'channel.read',
      resource: { type: 'channel', channelId: message.channel_id },
    });
    if (!mentionDecision.allowed) return validationError(c, identity, [{ path: 'metadata.mentions', code: 'inaccessible_actor', message: 'mentioned actor is not permitted in this channel' }]);
    canonicalMentions.push({ type: 'agent', actor_id: actor.id, npub: actor.npub, ...(mention.label ? { label: mention.label } : actor.display_name ? { label: actor.display_name } : {}) });
  }

  const revision = rowVersion + 1;
  const signatureValidation = validateFlightDeckPgMessageInstructionSignature({
    value: body.message_signature,
    body: messageBody,
    actorNpub: auth.userNpub,
    workspaceId: context.workspace.id,
    channelId: message.channel_id,
    threadId: message.thread_id,
    messageId,
    revision,
  });
  if (signatureValidation.errors.length || !signatureValidation.signature) {
    return validationError(c, identity, signatureValidation.errors);
  }

  const previousActorIds = new Set(previousMentions.flatMap((mention) => {
    if (!mention || typeof mention !== 'object' || Array.isArray(mention)) return [];
    const actorId = (mention as Record<string, unknown>).actor_id;
    return typeof actorId === 'string' ? [actorId] : [];
  }));
  const newlyAddedMentions = canonicalMentions.filter((mention) => !previousActorIds.has(mention.actor_id));
  const revisionIdempotencyKey = `message:${messageId}:revision:${revision}`;
  const messageMetadata = {
    ...mergedMetadata,
    mentions: canonicalMentions,
    [AGENT_INSTRUCTION_SIGNATURE_METADATA_KEY]: signatureValidation.signature,
  };

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const updated = await updateFlightDeckPgMessage({
      workspaceId: context.workspace.id,
      messageId,
      body: messageBody,
      metadata: messageMetadata,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (!updated) return null;
    const attachmentLinks = await syncFlightDeckPgMessageAttachmentLinks({
      workspaceId: context.workspace.id,
      channelId: updated.channel_id,
      messageId: updated.id,
      storageObjectIds: parsedAttachments.storageObjectIds,
      createdByActorId: context.actor.id,
    }, sql);
    Object.assign(updated, { created_by_actor_npub: auth.userNpub, created_by_actor_label: context.actor.display_name });
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'message.revise',
      resourceType: 'message',
      resourceId: updated.id,
      metadata: { channel_id: updated.channel_id, scope_id: updated.scope_id, thread_id: updated.thread_id, row_version: updated.row_version, revision_idempotency_key: revisionIdempotencyKey },
    }, sql);
    const outbox = await createFlightDeckPgChatOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: updated.scope_id,
      channelId: updated.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.message.revised',
      entityType: 'message',
      entityId: updated.id,
      operation: 'updated',
      entityRowVersion: updated.row_version,
      payload: {
        event_type: 'message.revised',
        workspace_id: updated.workspace_id,
        scope_id: updated.scope_id,
        channel_id: updated.channel_id,
        thread_id: updated.thread_id,
        entity_type: 'message',
        entity_id: updated.id,
        message_id: updated.id,
        revision: updated.row_version,
        revision_idempotency_key: revisionIdempotencyKey,
        actor_id: context.actor.id,
        actor_npub: auth.userNpub,
        mentions: canonicalMentions,
        newly_added_mentions: newlyAddedMentions,
        updated_at: updated.updated_at,
      },
    }, sql);
    return { message: updated, auditId, outbox, attachmentLinks };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Message row_version is stale', identity);
  await evaluateFlightDeckPgNotificationOutboxEvent(payload.outbox.id).catch(() => undefined);

  return c.json({
    identity,
    message: serializeFlightDeckPgMessage(payload.message),
    revision: payload.message.row_version,
    revision_idempotency_key: revisionIdempotencyKey,
    newly_added_mentions: newlyAddedMentions,
    audit: { event_id: payload.auditId, operation: 'message.revise', actor_npub: auth.userNpub },
    outbox: payload.outbox,
    attachment_links: payload.attachmentLinks.links.map((link) => ({ id: link.id, storage_object_id: link.storage_object_id })),
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/messages/:messageId/attachments/repair', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const messageId = c.req.param('messageId');
  const message = await resolveFlightDeckPgMessage(context.workspace.id, messageId);
  if (!message) return jsonError(c, 404, 'message_not_found', 'Flight Deck PG message not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId: message.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const parsedAttachments = parseFlightDeckPgMessageAttachmentStorageObjectIds(message.metadata.attachments);
  if (parsedAttachments.errors.length) return validationError(c, identity, parsedAttachments.errors);
  if (!parsedAttachments.storageObjectIds.length) {
    return validationError(c, identity, [{ path: 'metadata.attachments', code: 'required', message: 'message has no storage attachments to repair' }]);
  }

  const attachmentValidation = await validateFlightDeckPgMessageAttachmentObjects({
    actorNpub: auth.userNpub,
    workspaceId: context.workspace.id,
    storageObjectIds: parsedAttachments.storageObjectIds,
    messageId: message.id,
  });
  if (!attachmentValidation.ok) {
    return validationError(c, identity, [{
      path: 'metadata.attachments',
      code: attachmentValidation.reason === 'workspace-mismatch' ? 'workspace_mismatch' : 'not_attachable',
      message: `storage object ${attachmentValidation.storageObjectId} is not attachable in this workspace`,
    }]);
  }

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const attachmentLinks = await syncFlightDeckPgMessageAttachmentLinks({
        workspaceId: context.workspace.id,
        channelId: message.channel_id,
        messageId: message.id,
        storageObjectIds: parsedAttachments.storageObjectIds,
        createdByActorId: context.actor.id,
      }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'message.attachments.repair',
        resourceType: 'message',
        resourceId: message.id,
        metadata: {
          channel_id: message.channel_id,
          scope_id: message.scope_id,
          storage_object_ids: parsedAttachments.storageObjectIds,
          created_links: attachmentLinks.created,
          retained_links: attachmentLinks.retained,
          tombstoned_links: attachmentLinks.tombstoned,
        },
      }, sql);
      return { attachmentLinks, auditId };
    });

    return c.json({
      identity,
      message_id: message.id,
      storage_object_ids: parsedAttachments.storageObjectIds,
      attachment_links: payload.attachmentLinks.links.map((link) => ({ id: link.id, storage_object_id: link.storage_object_id })),
      repair: {
        created: payload.attachmentLinks.created,
        retained: payload.attachmentLinks.retained,
        tombstoned: payload.attachmentLinks.tombstoned,
        idempotent: payload.attachmentLinks.created === 0 && payload.attachmentLinks.tombstoned === 0,
      },
      audit: { event_id: payload.auditId, operation: 'message.attachments.repair', actor_npub: auth.userNpub },
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Failed to repair message attachments';
    if (messageText.includes('already attached')) {
      return jsonError(c, 409, 'message_attachment_conflict', messageText, identity);
    }
    return c.json({ error: messageText, code: 'message_attachment_repair_failed', identity }, 500);
  }
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/messages/:messageId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const messageId = c.req.param('messageId');
  const rowVersion = optionalRowVersion({ row_version: c.req.query('row_version') });
  if (Number.isNaN(rowVersion)) return validationError(c, identity, [{ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' }]);

  const message = await resolveFlightDeckPgMessage(context.workspace.id, messageId);
  if (!message) return jsonError(c, 404, 'message_not_found', 'Flight Deck PG message not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId: message.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const deleted = await deleteFlightDeckPgMessage({
      workspaceId: context.workspace.id,
      messageId,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (!deleted) return null;
    await tombstoneFlightDeckPgStorageLinksForEntity({
      workspaceId: context.workspace.id,
      entityType: 'message',
      entityId: deleted.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'message.delete',
      resourceType: 'message',
      resourceId: deleted.id,
      metadata: { channel_id: deleted.channel_id, scope_id: deleted.scope_id, thread_id: deleted.thread_id, row_version: deleted.row_version },
    }, sql);
    const outbox = await createFlightDeckPgChatOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: deleted.scope_id,
      channelId: deleted.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.message.deleted',
      entityType: 'message',
      entityId: deleted.id,
      operation: 'deleted',
      entityRowVersion: deleted.row_version,
      payload: { message_id: deleted.id, thread_id: deleted.thread_id },
    }, sql);
    return { message: deleted, auditId, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Message row_version is stale', identity);

  return c.json({
    identity,
    message: serializeFlightDeckPgMessage(payload.message),
    audit: { event_id: payload.auditId, operation: 'message.delete', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId/docs', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const access = await authorizeFlightDeckPgStorageRead({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'doc',
    channelId,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.read or channel.read');

  const docs = await listFlightDeckPgChannelDocs({
    workspaceId: context.workspace.id,
    channelId,
    limit: parseLimit(c),
    archived: c.req.query('archived') === 'true',
  });
  return c.json({
    identity,
    channel_id: channelId,
    docs: docs.map((doc) => serializeFlightDeckPgDoc(doc)),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/channels/:channelId/docs', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const title = String(body.title || '').trim();
  const storageObjectId = String(body.storage_object_id || '').trim();
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!title) fields.push({ path: 'title', code: 'required', message: 'title must be a non-empty string' });
  if (!storageObjectId) fields.push({ path: 'storage_object_id', code: 'required', message: 'storage_object_id must be a storage object UUID' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'doc',
    channelId,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const doc = await createFlightDeckPgDoc({
        workspaceId: context.workspace.id,
        channel,
        storageObjectId,
        title,
        summary: typeof body.summary === 'string' ? body.summary : null,
        metadata: metadata ?? undefined,
        actorId: context.actor.id,
      }, sql);
      await snapshotFlightDeckPgDocVersion({ doc, actorId: context.actor.id, operation: 'created' }, sql);
      const link = await createFlightDeckPgStorageLink({
        workspaceId: context.workspace.id,
        channelId: channel.id,
        entityType: 'doc',
        entityId: doc.id,
        storageObjectId,
        metadata: { doc_id: doc.id, title: doc.title },
        createdByActorId: context.actor.id,
      }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'doc.create',
        resourceType: 'doc',
        resourceId: doc.id,
        metadata: { channel_id: channel.id, scope_id: channel.scope_id, storage_object_id: storageObjectId, storage_link_id: link.id },
      }, sql);
      const outbox = await createFlightDeckPgDocOutboxEvent({
        workspaceId: context.workspace.id,
        scopeId: doc.scope_id,
        channelId: doc.channel_id,
        actorId: context.actor.id,
        eventType: 'flightdeck_pg.doc.created',
        entityId: doc.id,
        operation: 'created',
        entityRowVersion: doc.row_version,
        payload: { doc_id: doc.id, storage_object_id: storageObjectId },
      }, sql);
      return { doc, link, auditId, outbox };
    });

    return c.json({
      identity,
      doc: serializeFlightDeckPgDoc(payload.doc),
      storage_link: { id: payload.link.id, storage_object_id: payload.link.storage_object_id },
      audit: { event_id: payload.auditId, operation: 'doc.create', actor_npub: auth.userNpub },
      outbox: payload.outbox,
    }, 201);
  } catch (error) {
    const sqlCode = (error as { code?: string }).code;
    if (sqlCode === '23505') {
      return jsonError(c, 409, 'doc_storage_object_conflict', 'Storage object is already attached to an active Flight Deck PG doc', identity);
    }
    const message = error instanceof Error ? error.message : 'Flight Deck PG doc could not be created';
    return jsonError(c, 400, 'validation_error', message, identity);
  }
});

flightDeckPgRouter.get('/workspaces/:workspaceId/edit-leases', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const entityType = normalizeEditLeaseEntityType(c.req.query('entity_type'));
  const entityId = String(c.req.query('entity_id') || '').trim();
  const fields: { path: string; code: string; message: string }[] = [];
  if (!entityType) fields.push({ path: 'entity_type', code: 'invalid', message: 'entity_type must be task or document' });
  if (!entityId) fields.push({ path: 'entity_id', code: 'required', message: 'entity_id is required' });
  if (fields.length) return validationError(c, identity, fields);

  const lease = await getActiveFlightDeckPgEditLease({
    workspaceId: context.workspace.id,
    entityType: entityType!,
    entityId,
  });
  return c.json({ identity, lease: lease ? serializeFlightDeckPgEditLease(lease) : null });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/edit-leases/acquire', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const entityType = normalizeEditLeaseEntityType(body.entity_type);
  const entityId = String(body.entity_id || '').trim();
  const ttlSeconds = body.ttl_seconds === undefined ? 120 : Number(body.ttl_seconds);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!entityType) fields.push({ path: 'entity_type', code: 'invalid', message: 'entity_type must be task or document' });
  if (!entityId) fields.push({ path: 'entity_id', code: 'required', message: 'entity_id is required' });
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 600) {
    fields.push({ path: 'ttl_seconds', code: 'invalid', message: 'ttl_seconds must be between 30 and 600' });
  }
  if (fields.length) return validationError(c, identity, fields);

  if (entityType === 'task') {
    const task = await resolveFlightDeckPgTask(context.workspace.id, entityId);
    if (!task) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'task.update',
      resource: { type: 'channel', channelId: task.channel_id },
    });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'task.update');
  } else {
    const doc = await resolveFlightDeckPgDoc(context.workspace.id, entityId);
    if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);
    const access = await authorizeFlightDeckPgStorageAttach({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      entityType: 'doc',
      channelId: doc.channel_id,
    });
    if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');
  }

  const acquire = await getDb().begin(async (tx) => acquireFlightDeckPgEditLease({
    workspaceId: context.workspace.id,
    entityType: entityType!,
    entityId,
    fieldPath: body.field_path === undefined || body.field_path === null ? null : String(body.field_path),
    actorId: context.actor.id,
    actorNpub: auth.userNpub,
    leaseSeconds: ttlSeconds,
  }, asDbClient(tx)));

  if (!acquire.ok) {
    return jsonError(c, 409, 'edit_lease_held', 'edit lease is held', identity, {
      holder_actor_npub: acquire.lease.holder_actor_npub,
      expires_at: acquire.lease.expires_at,
    });
  }

  return c.json({
    identity,
    lease: acquire.lease,
  }, 201);
});

flightDeckPgRouter.post('/workspaces/:workspaceId/edit-leases/:leaseId/renew', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const leaseToken = requiredLeaseToken(body);
  const ttlSeconds = body.ttl_seconds === undefined ? 120 : Number(body.ttl_seconds);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!leaseToken) fields.push({ path: 'lease_token', code: 'required', message: 'lease_token is required' });
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 600) {
    fields.push({ path: 'ttl_seconds', code: 'invalid', message: 'ttl_seconds must be between 30 and 600' });
  }
  if (fields.length) return validationError(c, identity, fields);

  const lease = await renewFlightDeckPgEditLease({
    workspaceId: context.workspace.id,
    leaseId: c.req.param('leaseId'),
    actorId: context.actor.id,
    leaseToken,
    leaseSeconds: ttlSeconds,
  });
  if (!lease.ok) return jsonError(c, 409, lease.reason, 'PG edit lease is invalid or expired', identity);
  return c.json({ identity, lease: lease.lease });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/edit-leases/:leaseId/release', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c).catch(() => null);
  const leaseToken = body ? requiredLeaseToken(body) : '';
  const lease = await releaseFlightDeckPgEditLease({
    workspaceId: context.workspace.id,
    leaseId: c.req.param('leaseId'),
    actorId: context.actor.id,
    leaseToken,
  });
  return c.json({
    identity,
    released: Boolean(lease),
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/docs/:docId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);

  const readable = await resolveReadableFlightDeckPgStorageObject({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    storageObjectId: doc.storage_object_id,
  });
  if (!readable.ok) {
    if (readable.reason === 'permission-denied' && readable.access) {
      return storageAuthorizationError(c, readable.access, identity, 'doc.read or channel.read');
    }
    return jsonError(c, 404, 'doc_body_not_found', 'Flight Deck PG doc body storage object was not found', identity);
  }
  if (readable.link.entity_type !== 'doc' || readable.link.entity_id !== doc.id || readable.link.channel_id !== doc.channel_id) {
    return jsonError(c, 404, 'doc_body_not_found', 'Flight Deck PG doc body storage link was not found', identity);
  }

  return c.json({
    identity,
    doc: serializeFlightDeckPgDoc(doc, {
      storageObject: serializeFlightDeckPgStorageObjectMetadata(readable.storageObject),
    }),
    canonical_version: serializeFlightDeckPgDocVersionIdentity({
      version_id: flightDeckPgCanonicalDocVersionId(doc.id, doc.row_version),
      row_version: doc.row_version,
      storage_object_id: doc.storage_object_id,
      body_sha256_hex: readable.storageObject.sha256_hex,
      size_bytes: Number(readable.storageObject.size_bytes),
    }),
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/docs/:docId/versions', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);

  const access = await authorizeFlightDeckPgStorageRead({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'doc',
    channelId: doc.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.read or channel.read');

  const versions = await listFlightDeckPgDocVersions({
    workspaceId: context.workspace.id,
    docId: doc.id,
    limit: parseLimit(c),
  });
  const serialized = [];
  for (const version of versions) {
    const content = await getStorageObjectContent(version.storage_object_id);
    serialized.push(serializeFlightDeckPgDocVersion(version, {
      content: content
        ? {
            object_id: version.storage_object_id,
            content_type: content.row.content_type,
            size_bytes: content.size,
            sha256_hex: content.row.sha256_hex,
            ...parseFlightDeckPgStoredDocumentContent(content.bytes),
          }
        : {
            object_id: version.storage_object_id,
            missing: true,
          },
    }));
  }

  return c.json({
    identity,
    doc_id: doc.id,
    versions: serialized,
    next_cursor: null,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/docs/:docId/recoveries', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);
  const access = await authorizeFlightDeckPgStorageRead({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, entityType: 'doc', channelId: doc.channel_id });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.read or channel.read');
  const rawState = c.req.query('state');
  const state = rawState === undefined || rawState === '' ? 'open' : rawState;
  if (!['open', 'promoted', 'discarded', 'all'].includes(state)) {
    return validationError(c, identity, [{ path: 'state', code: 'invalid', message: 'state must be open, promoted, discarded, or all' }]);
  }
  const recoveries = await listFlightDeckPgDocRecoveryVersions({
    workspaceId: context.workspace.id,
    docId: doc.id,
    limit: parseLimit(c),
    state: state === 'all' ? null : state as 'open' | 'promoted' | 'discarded',
  });
  return c.json({ identity, doc_id: doc.id, recoveries: recoveries.map(serializeFlightDeckPgDocRecoveryVersion), next_cursor: null });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/docs/:docId/recoveries/:recoveryId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);
  const access = await authorizeFlightDeckPgStorageRead({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, entityType: 'doc', channelId: doc.channel_id });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.read or channel.read');
  const recovery = await resolveFlightDeckPgDocRecoveryVersion({ workspaceId: context.workspace.id, docId: doc.id, recoveryId: c.req.param('recoveryId') });
  if (!recovery) return jsonError(c, 404, 'doc_recovery_not_found', 'Document recovery version not found', identity);
  const currentHead = await resolveFlightDeckPgDocVersionIdentity({ workspaceId: context.workspace.id, docId: doc.id });
  return c.json({
    identity,
    recovery: serializeFlightDeckPgDocRecoveryVersion(recovery),
    current_head: currentHead ? serializeFlightDeckPgDocVersionIdentity(currentHead.identity) : null,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/docs/:docId/recoveries/:recoveryId/body', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);
  const recovery = await resolveFlightDeckPgDocRecoveryVersion({ workspaceId: context.workspace.id, docId: doc.id, recoveryId: c.req.param('recoveryId') });
  if (!recovery) return jsonError(c, 404, 'doc_recovery_not_found', 'Document recovery version not found', identity);
  const readable = await resolveReadableFlightDeckPgStorageObject({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, storageObjectId: recovery.storage_object_id });
  if (!readable.ok) {
    if (readable.reason === 'permission-denied' && readable.access) return storageAuthorizationError(c, readable.access, identity, 'doc.read or channel.read');
    return jsonError(c, 404, 'doc_recovery_body_not_found', 'Document recovery body storage object was not found', identity);
  }
  if (readable.link.entity_type !== 'doc' || readable.link.entity_id !== doc.id || readable.link.channel_id !== recovery.channel_id) {
    return jsonError(c, 404, 'doc_recovery_body_not_found', 'Document recovery body storage link was not found', identity);
  }
  if (!readable.storageObject.completed_at) return jsonError(c, 409, 'doc_recovery_body_upload_incomplete', 'Document recovery body upload is not completed', identity);
  const content = await getStorageObjectContent(recovery.storage_object_id);
  if (!content) return jsonError(c, 404, 'doc_recovery_body_content_missing', 'Document recovery body content is missing', identity);
  return c.json({
    identity,
    recovery: serializeFlightDeckPgDocRecoveryVersion(recovery),
    body: {
      object_id: recovery.storage_object_id,
      content_type: readable.storageObject.content_type,
      size_bytes: content.size,
      sha256_hex: readable.storageObject.sha256_hex,
      encoding: 'base64',
      base64_data: Buffer.from(content.bytes).toString('base64'),
      ...parseFlightDeckPgStoredDocumentContent(content.bytes),
    },
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/docs/:docId/recoveries/:recoveryId/promote', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const docId = c.req.param('docId');
  const recoveryId = c.req.param('recoveryId');
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, docId);
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);
  const access = await authorizeFlightDeckPgStorageAttach({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, entityType: 'doc', channelId: doc.channel_id });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');
  const recovery = await resolveFlightDeckPgDocRecoveryVersion({ workspaceId: context.workspace.id, docId, recoveryId });
  if (!recovery) return jsonError(c, 404, 'doc_recovery_not_found', 'Document recovery version not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const expectedHeadRowVersion = optionalRowVersion(body);
  const expectedHeadVersionId = body.base_version_id === undefined || body.base_version_id === null ? null : String(body.base_version_id).trim();
  const expectedHeadBodySha256Hex = optionalSha256Hex(body.base_body_sha256_hex);
  const leaseToken = requiredLeaseToken(body);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!expectedHeadRowVersion || Number.isNaN(expectedHeadRowVersion)) fields.push({ path: 'row_version', code: 'required', message: 'row_version must identify the current canonical head' });
  if (!expectedHeadBodySha256Hex) fields.push({ path: 'base_body_sha256_hex', code: expectedHeadBodySha256Hex === '' ? 'invalid' : 'required', message: 'base_body_sha256_hex must identify the current canonical body' });
  if (body.base_version_id !== undefined && !expectedHeadVersionId) fields.push({ path: 'base_version_id', code: 'invalid', message: 'base_version_id must be non-empty when provided' });
  if (!leaseToken) fields.push({ path: 'lease_token', code: 'required', message: 'lease_token is required to promote a recovery version' });
  if (fields.length) return validationError(c, identity, fields);
  const leaseError = await requireValidFlightDeckPgEditLeaseForSave(c, { identity, workspaceId: context.workspace.id, actorId: context.actor.id, entityType: 'document', entityId: docId, rowVersion: expectedHeadRowVersion, leaseToken });
  if (leaseError) return leaseError;

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const promotion = await promoteFlightDeckPgDocRecoveryVersion({
      workspaceId: context.workspace.id,
      docId,
      recoveryId,
      actorId: context.actor.id,
      signerNpub: auth.signerNpub,
      expectedHeadRowVersion: expectedHeadRowVersion!,
      expectedHeadVersionId,
      expectedHeadBodySha256Hex: expectedHeadBodySha256Hex!,
    }, sql);
    if (!promotion || promotion.outcome !== 'promoted') return promotion;
    const promotedLink = await ensureFlightDeckPgDocStorageLink({ workspaceId: context.workspace.id, channelId: promotion.doc.channel_id, docId, storageObjectId: promotion.recovery.storage_object_id, actorId: context.actor.id, metadata: { doc_id: docId, recovery_id: promotion.recovery.id, recovery_state: 'promoted' } }, sql);
    const activity = await advanceFlightDeckPgResourceActivity({ workspaceId: context.workspace.id, actorId: context.actor.id, resourceType: 'document', resourceId: promotion.doc.id }, sql);
    promotion.doc.activity_version = activity.resource.activity_version;
    const viewStateOutbox = await createFlightDeckPgResourceViewStateOutboxEvent({ workspaceId: context.workspace.id, actorId: context.actor.id, state: activity.state, activityVersion: Number(activity.resource.activity_version) }, sql);
    await snapshotFlightDeckPgDocVersion({ doc: promotion.doc, actorId: context.actor.id, operation: 'updated' }, sql);
    const promotedBody = await documentBodyVersionInfo(promotion.recovery.storage_object_id);
    const priorBodyVersion = {
      storage_object_id: promotion.priorHeadIdentity.storage_object_id,
      sha256_hex: promotion.priorHeadIdentity.body_sha256_hex,
      size_bytes: promotion.priorHeadIdentity.size_bytes,
    };
    const currentMentions = Array.isArray(promotion.doc.metadata?.mentions) ? promotion.doc.metadata.mentions as Array<{ actor_id: string }> : [];
    const priorMentions = Array.isArray(promotion.priorHead.metadata?.mentions) ? promotion.priorHead.metadata.mentions : [];
    const newlyAdded = addedAgentMentions(priorMentions, currentMentions);
    const auditId = await writeFlightDeckPgAudit({ workspaceId: context.workspace.id, actorId: context.actor.id, action: 'doc.recovery.promote', resourceType: 'doc_recovery', resourceId: promotion.recovery.id, metadata: { doc_id: docId, prior_head_row_version: promotion.priorHead.row_version, promoted_head_row_version: promotion.doc.row_version, storage_object_id: promotion.recovery.storage_object_id, storage_link_id: promotedLink.link.id } }, sql);
    const outbox = await createFlightDeckPgDocOutboxEvent({ workspaceId: context.workspace.id, scopeId: promotion.doc.scope_id, channelId: promotion.doc.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.doc.recovery_promoted', entityId: docId, operation: 'updated', entityRowVersion: promotion.doc.row_version, payload: { doc_id: docId, recovery_id: promotion.recovery.id, prior_body_version: priorBodyVersion, body_version: promotedBody, canonical_advanced: true, author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } } }, sql);
    const mentionOutbox = newlyAdded.length > 0
      ? await createFlightDeckPgDocOutboxEvent({ workspaceId: context.workspace.id, scopeId: promotion.doc.scope_id, channelId: promotion.doc.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.document_mention_added', entityId: docId, operation: 'updated', entityRowVersion: promotion.doc.row_version, payload: { trigger: 'document_mention_added', document_id: docId, doc_id: docId, workspace_id: context.workspace.id, scope_id: promotion.doc.scope_id, channel_id: promotion.doc.channel_id, document_row_version: promotion.doc.row_version, body_version: promotedBody, prior_body_version: priorBodyVersion, current_body_hash: promotedBody.sha256_hex, prior_body_hash: priorBodyVersion.sha256_hex, added_mentions: newlyAdded, author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } } }, sql)
      : null;
    return { ...promotion, auditId, outbox, mentionOutbox, viewStateOutbox, promotedBody };
  });
  if (!payload) return jsonError(c, 404, 'doc_recovery_not_found', 'Document recovery version not found', identity);
  if (payload.outcome === 'head_conflict') return c.json({ identity, code: 'recovery_promotion_conflict', message: 'Canonical document head changed; refresh before promoting this recovery version', recovery: serializeFlightDeckPgDocRecoveryVersion(payload.recovery), current_head: serializeFlightDeckPgDocVersionIdentity(payload.headIdentity) }, 409);
  if (payload.outcome === 'resolved') {
    if (payload.recovery.resolution_state === 'promoted') return c.json({ identity, idempotent_replay: true, doc: serializeFlightDeckPgDoc(payload.head), canonical_version: serializeFlightDeckPgDocVersionIdentity(payload.headIdentity), recovery: serializeFlightDeckPgDocRecoveryVersion(payload.recovery) });
    return c.json({ identity, code: 'doc_recovery_already_resolved', message: 'Document recovery version has already been discarded', recovery: serializeFlightDeckPgDocRecoveryVersion(payload.recovery) }, 409);
  }
  return c.json({
    identity,
    doc: serializeFlightDeckPgDoc(payload.doc),
    canonical_version: serializeFlightDeckPgDocVersionIdentity({ version_id: flightDeckPgCanonicalDocVersionId(payload.doc.id, payload.doc.row_version), row_version: payload.doc.row_version, storage_object_id: payload.doc.storage_object_id, body_sha256_hex: payload.promotedBody.sha256_hex, size_bytes: payload.promotedBody.size_bytes }),
    recovery: serializeFlightDeckPgDocRecoveryVersion(payload.recovery),
    audit: { event_id: payload.auditId, operation: 'doc.recovery.promote', actor_npub: auth.userNpub },
    outbox: payload.outbox,
    mention_outbox: payload.mentionOutbox,
    view_state_outbox: payload.viewStateOutbox,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/docs/:docId/recoveries/:recoveryId/discard', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const docId = c.req.param('docId');
  const recoveryId = c.req.param('recoveryId');
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, docId);
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);
  const access = await authorizeFlightDeckPgStorageAttach({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, entityType: 'doc', channelId: doc.channel_id });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');
  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const discarded = await discardFlightDeckPgDocRecoveryVersion({ workspaceId: context.workspace.id, docId, recoveryId, actorId: context.actor.id, signerNpub: auth.signerNpub }, sql);
    if (!discarded) return null;
    if (!discarded.changed) return { kind: 'unchanged' as const, recovery: discarded.recovery };
    const retainedLink = await ensureFlightDeckPgDocStorageLink({ workspaceId: context.workspace.id, channelId: doc.channel_id, docId, storageObjectId: discarded.recovery.storage_object_id, actorId: context.actor.id, metadata: { doc_id: docId, recovery_id: discarded.recovery.id, recovery_state: 'discarded' } }, sql);
    const auditId = await writeFlightDeckPgAudit({ workspaceId: context.workspace.id, actorId: context.actor.id, action: 'doc.recovery.discard', resourceType: 'doc_recovery', resourceId: discarded.recovery.id, metadata: { doc_id: docId, canonical_row_version: doc.row_version, storage_object_id: discarded.recovery.storage_object_id, storage_link_id: retainedLink.link.id, storage_link_retained: true } }, sql);
    const outbox = await createFlightDeckPgDocOutboxEvent({ workspaceId: context.workspace.id, scopeId: doc.scope_id, channelId: doc.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.doc.recovery_discarded', entityId: docId, operation: 'updated', entityRowVersion: doc.row_version, payload: { doc_id: docId, recovery_id: discarded.recovery.id, canonical_advanced: false, storage_link_retained: true, author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } } }, sql);
    return { kind: 'changed' as const, recovery: discarded.recovery, auditId, outbox };
  });
  if (!payload) return jsonError(c, 404, 'doc_recovery_not_found', 'Document recovery version not found', identity);
  if (payload.kind === 'unchanged' && payload.recovery.resolution_state === 'promoted') return c.json({ identity, code: 'doc_recovery_already_resolved', message: 'Promoted recovery versions cannot be discarded', recovery: serializeFlightDeckPgDocRecoveryVersion(payload.recovery) }, 409);
  return c.json({
    identity,
    recovery: serializeFlightDeckPgDocRecoveryVersion(payload.recovery),
    idempotent_replay: payload.kind === 'unchanged',
    audit: payload.kind === 'changed' ? { event_id: payload.auditId, operation: 'doc.recovery.discard', actor_npub: auth.userNpub } : null,
    outbox: payload.kind === 'changed' ? payload.outbox : null,
  });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/docs/:docId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const docId = c.req.param('docId');
  const existing = await resolveFlightDeckPgDoc(context.workspace.id, docId);
  if (!existing) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const rowVersion = optionalRowVersion(body);
  const leaseToken = requiredLeaseToken(body);
  const title = body.title === undefined ? undefined : String(body.title || '').trim();
  const channelId = body.channel_id === undefined ? undefined : String(body.channel_id || '').trim();
  const storageObjectId = body.storage_object_id === undefined ? undefined : String(body.storage_object_id || '').trim();
  const bodySave = storageObjectId !== undefined;
  const baseAvailable = body.base_available === false ? false : true;
  const baseVersionId = body.base_version_id === undefined || body.base_version_id === null ? null : String(body.base_version_id).trim();
  const baseBodySha256Hex = optionalSha256Hex(body.base_body_sha256_hex);
  const metadata = optionalObject(body.metadata);
  const mentionSource = body.mentions !== undefined ? body.mentions : metadata?.mentions;
  const archived = body.archived === undefined ? undefined : body.archived as boolean;
  const fields: { path: string; code: string; message: string }[] = [];
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (body.title !== undefined && !title) fields.push({ path: 'title', code: 'invalid', message: 'title must be non-empty when provided' });
  if (body.channel_id !== undefined && !channelId) fields.push({ path: 'channel_id', code: 'invalid', message: 'channel_id must be non-empty when provided' });
  if (body.storage_object_id !== undefined && !storageObjectId) fields.push({ path: 'storage_object_id', code: 'invalid', message: 'storage_object_id must be non-empty when provided' });
  if (body.base_available !== undefined && typeof body.base_available !== 'boolean') fields.push({ path: 'base_available', code: 'invalid', message: 'base_available must be a boolean when provided' });
  if (bodySave && baseAvailable && !rowVersion) fields.push({ path: 'row_version', code: 'required', message: 'row_version is required when a complete document base is available' });
  if (bodySave && baseAvailable && baseBodySha256Hex === null) fields.push({ path: 'base_body_sha256_hex', code: 'required', message: 'base_body_sha256_hex must identify the complete canonical base body' });
  if (body.base_version_id !== undefined && !baseVersionId) fields.push({ path: 'base_version_id', code: 'invalid', message: 'base_version_id must be non-empty when provided' });
  if (body.base_body_sha256_hex !== undefined && baseBodySha256Hex === '') fields.push({ path: 'base_body_sha256_hex', code: 'invalid', message: 'base_body_sha256_hex must be a lowercase or uppercase SHA-256 hex digest' });
  if (bodySave && channelId !== undefined) fields.push({ path: 'channel_id', code: 'unsupported_combination', message: 'channel_id cannot be combined with a document body save; use the document move route separately' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (archived !== undefined && typeof archived !== 'boolean') fields.push({ path: 'archived', code: 'invalid', message: 'archived must be a boolean when provided' });
  if (fields.length) return validationError(c, identity, fields);

  let targetChannel = null;
  if (channelId && channelId !== existing.channel_id) {
    targetChannel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
    if (!targetChannel) return jsonError(c, 404, 'channel_not_found', 'Target channel not found', identity);
  }

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'doc',
    channelId: existing.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');
  if (targetChannel) {
    const targetAccess = await authorizeFlightDeckPgStorageAttach({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      entityType: 'doc',
      channelId: targetChannel.id,
    });
    if (!targetAccess.allowed) return storageAuthorizationError(c, targetAccess, identity, 'doc.write or channel.write');
  }

  const effectiveMentionSource = mentionSource === undefined ? existing.metadata?.mentions : mentionSource;
  const canonicalMentions = await canonicalDocMentions({
    value: effectiveMentionSource,
    path: body.mentions !== undefined ? 'mentions' : 'metadata.mentions',
    workspaceId: context.workspace.id,
    appNpub: context.workspace.app_npub,
    channelId: targetChannel?.id ?? existing.channel_id,
  });
  if (canonicalMentions.errors.length) return validationError(c, identity, canonicalMentions.errors);
  const previousMentions = Array.isArray(existing.metadata?.mentions) ? existing.metadata.mentions : [];
  const newlyAddedMentions = addedAgentMentions(previousMentions, canonicalMentions.mentions);
  const canonicalMetadata = metadata === undefined && mentionSource === undefined
    ? undefined
    : { ...(metadata ?? existing.metadata ?? {}), mentions: canonicalMentions.mentions };
  const [priorBody, currentBody] = bodySave
    ? [null, null]
    : await Promise.all([
        documentBodyVersionInfo(existing.storage_object_id),
        documentBodyVersionInfo(existing.storage_object_id),
      ]);

  const archiveOnly = archived !== undefined && title === undefined && channelId === undefined && storageObjectId === undefined && body.summary === undefined && body.metadata === undefined;
  const qualifyingDocUpdate = title !== undefined || storageObjectId !== undefined || body.summary !== undefined;
  const leaseError = archiveOnly || bodySave ? null : await requireValidFlightDeckPgEditLeaseForSave(c, {
    identity,
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    entityType: 'document',
    entityId: docId,
    rowVersion,
    leaseToken,
  });
  if (leaseError) return leaseError;

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const submittedPatch = {
        ...(title !== undefined ? { title } : {}),
        ...(body.summary !== undefined ? { summary: body.summary === null ? null : String(body.summary) } : {}),
        ...(canonicalMetadata !== undefined ? { metadata: canonicalMetadata } : {}),
        ...(archived !== undefined ? { archived } : {}),
      };
      const saveDecision = storageObjectId
        ? await decideFlightDeckPgDocBodySave({
            workspaceId: context.workspace.id,
            docId,
            storageObjectId,
            actorId: context.actor.id,
            signerNpub: auth.signerNpub,
            baseAvailable,
            baseRowVersion: rowVersion,
            baseVersionId,
            baseBodySha256Hex,
            submittedPatch,
          }, sql)
        : null;
      if (storageObjectId && !saveDecision) return { kind: 'not_found' as const };
      if (saveDecision?.outcome === 'recovery') {
        const linked = await ensureFlightDeckPgDocStorageLink({
          workspaceId: context.workspace.id,
          channelId: saveDecision.recovery.channel_id,
          docId,
          storageObjectId: storageObjectId!,
          actorId: context.actor.id,
          metadata: { doc_id: docId, recovery_id: saveDecision.recovery.id, recovery_state: 'open' },
        }, sql);
        const auditId = saveDecision.created
          ? await writeFlightDeckPgAudit({
              workspaceId: context.workspace.id,
              actorId: context.actor.id,
              action: 'doc.recovery.create',
              resourceType: 'doc_recovery',
              resourceId: saveDecision.recovery.id,
              metadata: {
                doc_id: docId,
                reason_code: saveDecision.recovery.reason_code,
                head_row_version: saveDecision.headIdentity.row_version,
                submitted_storage_object_id: storageObjectId,
                storage_link_id: linked.link.id,
              },
            }, sql)
          : null;
        const outbox = saveDecision.created
          ? await createFlightDeckPgDocOutboxEvent({
              workspaceId: context.workspace.id,
              scopeId: saveDecision.recovery.scope_id,
              channelId: saveDecision.recovery.channel_id,
              actorId: context.actor.id,
              eventType: 'flightdeck_pg.doc.recovery_created',
              entityId: docId,
              operation: 'created',
              entityRowVersion: saveDecision.headIdentity.row_version,
              payload: {
                doc_id: docId,
                recovery_id: saveDecision.recovery.id,
                reason_code: saveDecision.recovery.reason_code,
                canonical_advanced: false,
                base: serializeFlightDeckPgDocRecoveryVersion(saveDecision.recovery).base,
                current_head: serializeFlightDeckPgDocVersionIdentity(saveDecision.headIdentity),
                submitted_body: serializeFlightDeckPgDocRecoveryVersion(saveDecision.recovery).submitted_body,
                author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub },
              },
            }, sql)
          : null;
        return { kind: 'recovery' as const, ...saveDecision, link: linked.link, auditId, outbox };
      }

      if (saveDecision?.outcome === 'canonical') {
        const lease = await validateFlightDeckPgEditLease({
          workspaceId: context.workspace.id,
          entityType: 'document',
          entityId: docId,
          actorId: context.actor.id,
          leaseToken,
        }, sql);
        if (!lease.ok) return { kind: 'lease_error' as const, reason: lease.reason };
      }
      const doc = await updateFlightDeckPgDoc({
        workspaceId: context.workspace.id,
        docId,
        actorId: context.actor.id,
        rowVersion: saveDecision?.outcome === 'canonical' ? saveDecision.headIdentity.row_version : rowVersion,
        patch: {
          title,
          scopeId: targetChannel?.scope_id,
          channelId: targetChannel?.id,
          storageObjectId,
          summary: body.summary === undefined ? undefined : (body.summary === null ? null : String(body.summary)),
          metadata: canonicalMetadata,
          archived,
        },
      }, sql);
      if (!doc) return null;
      const activity = qualifyingDocUpdate ? await advanceFlightDeckPgResourceActivity({ workspaceId: context.workspace.id, actorId: context.actor.id, resourceType: 'document', resourceId: doc.id }, sql) : null;
      if (activity) doc.activity_version = activity.resource.activity_version;
      const viewStateOutbox = activity
        ? await createFlightDeckPgResourceViewStateOutboxEvent({ workspaceId: context.workspace.id, actorId: context.actor.id, state: activity.state, activityVersion: Number(activity.resource.activity_version) }, sql)
        : null;
      await snapshotFlightDeckPgDocVersion({ doc, actorId: context.actor.id, operation: 'updated' }, sql);
      let link = null;
      if (storageObjectId && storageObjectId !== existing.storage_object_id) {
        link = (await ensureFlightDeckPgDocStorageLink({
          workspaceId: context.workspace.id,
          channelId: doc.channel_id,
          docId: doc.id,
          storageObjectId,
          metadata: { doc_id: doc.id, title: doc.title },
          actorId: context.actor.id,
        }, sql)).link;
      }
      const priorBodyVersion = saveDecision?.outcome === 'canonical'
        ? {
            storage_object_id: saveDecision.headIdentity.storage_object_id,
            sha256_hex: saveDecision.headIdentity.body_sha256_hex,
            size_bytes: saveDecision.headIdentity.size_bytes,
          }
        : priorBody!;
      const currentBodyVersion = saveDecision?.outcome === 'canonical'
        ? {
            storage_object_id: saveDecision.submittedIdentity.storage_object_id,
            sha256_hex: saveDecision.submittedIdentity.body_sha256_hex,
            size_bytes: saveDecision.submittedIdentity.size_bytes,
          }
        : currentBody!;
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'doc.update',
        resourceType: 'doc',
        resourceId: doc.id,
        metadata: { channel_id: doc.channel_id, scope_id: doc.scope_id, row_version: doc.row_version },
      }, sql);
      const outbox = await createFlightDeckPgDocOutboxEvent({
        workspaceId: context.workspace.id,
        scopeId: doc.scope_id,
        channelId: doc.channel_id,
        actorId: context.actor.id,
        eventType: 'flightdeck_pg.doc.updated',
        entityId: doc.id,
        operation: 'updated',
        entityRowVersion: doc.row_version,
        payload: { doc_id: doc.id, storage_object_id: doc.storage_object_id, body_version: currentBodyVersion, prior_body_version: priorBodyVersion, mentions: canonicalMentions.mentions, newly_added_mentions: newlyAddedMentions, activity_version: Number(doc.activity_version), author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
      }, sql);
      const mentionOutbox = newlyAddedMentions.length > 0
        ? await createFlightDeckPgDocOutboxEvent({
            workspaceId: context.workspace.id,
            scopeId: doc.scope_id,
            channelId: doc.channel_id,
            actorId: context.actor.id,
            eventType: 'flightdeck_pg.document_mention_added',
            entityId: doc.id,
            operation: 'updated',
            entityRowVersion: doc.row_version,
            payload: { trigger: 'document_mention_added', document_id: doc.id, doc_id: doc.id, workspace_id: doc.workspace_id, scope_id: doc.scope_id, channel_id: doc.channel_id, document_row_version: doc.row_version, body_version: currentBodyVersion, prior_body_version: priorBodyVersion, current_body_hash: currentBodyVersion.sha256_hex, prior_body_hash: priorBodyVersion.sha256_hex, added_mentions: newlyAddedMentions, author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
          }, sql)
        : null;
      const canonicalVersion = {
        version_id: flightDeckPgCanonicalDocVersionId(doc.id, doc.row_version),
        row_version: doc.row_version,
        storage_object_id: doc.storage_object_id,
        body_sha256_hex: currentBodyVersion.sha256_hex,
        size_bytes: currentBodyVersion.size_bytes,
      };
      return { kind: 'canonical' as const, doc, link, auditId, outbox, mentionOutbox, viewStateOutbox, canonicalVersion };
    });
    if (!payload || payload.kind === 'not_found') return jsonError(c, 409, 'stale_row_version', 'Doc row_version is stale', identity);
    if (payload.kind === 'lease_error') return jsonError(c, 409, payload.reason, 'A valid PG edit lease is required to advance the canonical document', identity);
    if (payload.kind === 'recovery') {
      return c.json({
        identity,
        code: 'document_recovery_created',
        message: 'The submitted document body was preserved as a non-head recovery version',
        canonical_advanced: false,
        current_head: serializeFlightDeckPgDocVersionIdentity(payload.headIdentity),
        recovery: serializeFlightDeckPgDocRecoveryVersion(payload.recovery),
        idempotent_replay: !payload.created,
        storage_link: { id: payload.link.id, storage_object_id: payload.link.storage_object_id },
        audit: payload.auditId ? { event_id: payload.auditId, operation: 'doc.recovery.create', actor_npub: auth.userNpub } : null,
        outbox: payload.outbox,
      }, 409);
    }

    return c.json({
      identity,
      doc: serializeFlightDeckPgDoc(payload.doc),
      canonical_version: serializeFlightDeckPgDocVersionIdentity(payload.canonicalVersion),
      storage_link: payload.link ? { id: payload.link.id, storage_object_id: payload.link.storage_object_id } : null,
      audit: { event_id: payload.auditId, operation: 'doc.update', actor_npub: auth.userNpub },
      outbox: payload.outbox,
      mention_outbox: payload.mentionOutbox,
      ...(payload.viewStateOutbox ? { view_state_outbox: payload.viewStateOutbox } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Flight Deck PG doc could not be updated';
    return jsonError(c, 400, 'validation_error', message, identity);
  }
});

flightDeckPgRouter.post('/workspaces/:workspaceId/docs/:docId/move', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const docId = c.req.param('docId');
  const existing = await resolveFlightDeckPgDoc(context.workspace.id, docId);
  if (!existing) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const destinationChannelId = String(body.destination_channel_id || '').trim();
  const destinationScopeId = body.destination_scope_id === undefined ? '' : String(body.destination_scope_id || '').trim();
  const rowVersion = optionalRowVersion(body);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!destinationChannelId) fields.push({ path: 'destination_channel_id', code: 'required', message: 'destination_channel_id is required' });
  else if (!isUuid(destinationChannelId)) fields.push({ path: 'destination_channel_id', code: 'invalid', message: 'destination_channel_id must be a UUID' });
  if (body.destination_scope_id !== undefined && (!destinationScopeId || !isUuid(destinationScopeId))) fields.push({ path: 'destination_scope_id', code: 'invalid', message: 'destination_scope_id must be a UUID when provided' });
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (fields.length) return validationError(c, identity, fields);
  if (destinationChannelId === existing.channel_id) return jsonError(c, 409, 'same_destination', 'Document is already in the destination channel', identity);

  const destinationChannel = await resolveFlightDeckPgChannel(context.workspace.id, destinationChannelId);
  if (!destinationChannel) return jsonError(c, 404, 'destination_channel_not_found', 'Destination channel was not found in this workspace', identity);
  if (destinationScopeId && destinationChannel.scope_id !== destinationScopeId) {
    return jsonError(c, 400, 'destination_scope_mismatch', 'Destination channel does not belong to destination_scope_id', identity);
  }

  const sourceRead = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'doc.read', resource: { type: 'channel', channelId: existing.channel_id } });
  if (!sourceRead.allowed) return authorizationError(c, sourceRead, identity, 'doc.read');
  const sourceWrite = await authorizeFlightDeckPgStorageAttach({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, entityType: 'doc', channelId: existing.channel_id });
  if (!sourceWrite.allowed) return storageAuthorizationError(c, sourceWrite, identity, 'doc.write or channel.write');
  const destinationRead = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.read', resource: { type: 'channel', channelId: destinationChannel.id } });
  if (!destinationRead.allowed) return authorizationError(c, destinationRead, identity, 'channel.read');
  const destinationWrite = await authorizeFlightDeckPgStorageAttach({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, entityType: 'doc', channelId: destinationChannel.id });
  if (!destinationWrite.allowed) return storageAuthorizationError(c, destinationWrite, identity, 'doc.write or channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const doc = await moveFlightDeckPgDoc({ workspaceId: context.workspace.id, docId, destinationChannel, actorId: context.actor.id, rowVersion }, sql);
    if (!doc) return null;
    const activity = await advanceFlightDeckPgResourceActivity({ workspaceId: context.workspace.id, actorId: context.actor.id, resourceType: 'document', resourceId: doc.id }, sql);
    doc.activity_version = activity.resource.activity_version;
    await snapshotFlightDeckPgDocVersion({ doc, actorId: context.actor.id, operation: 'updated' }, sql);
    const movement = { from: { scope_id: existing.scope_id, channel_id: existing.channel_id }, to: { scope_id: doc.scope_id, channel_id: doc.channel_id } };
    const auditId = await writeFlightDeckPgAudit({ workspaceId: context.workspace.id, actorId: context.actor.id, action: 'doc.move', resourceType: 'doc', resourceId: doc.id, metadata: { ...movement, row_version: doc.row_version } }, sql);
    const sourceOutbox = await createFlightDeckPgDocOutboxEvent({ workspaceId: context.workspace.id, scopeId: existing.scope_id, channelId: existing.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.doc.moved', entityId: doc.id, operation: 'updated', entityRowVersion: doc.row_version, payload: { doc_id: doc.id, movement, location_role: 'source' } }, sql);
    const destinationOutbox = await createFlightDeckPgDocOutboxEvent({ workspaceId: context.workspace.id, scopeId: doc.scope_id, channelId: doc.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.doc.moved', entityId: doc.id, operation: 'updated', entityRowVersion: doc.row_version, payload: { doc_id: doc.id, movement, location_role: 'destination', activity_version: Number(doc.activity_version) } }, sql);
    return { doc, auditId, sourceOutbox, destinationOutbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Document row_version is stale', identity);
  return c.json({ identity, doc: serializeFlightDeckPgDoc(payload.doc), movement: { from: { scope_id: existing.scope_id, channel_id: existing.channel_id }, to: { scope_id: payload.doc.scope_id, channel_id: payload.doc.channel_id } }, audit: { event_id: payload.auditId, operation: 'doc.move', actor_npub: auth.userNpub }, outbox: { source: payload.sourceOutbox, destination: payload.destinationOutbox } });
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/docs/:docId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const docId = c.req.param('docId');
  const existing = await resolveFlightDeckPgDoc(context.workspace.id, docId);
  if (!existing) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);
  const rowVersion = optionalRowVersion({ row_version: c.req.query('row_version') });
  if (Number.isNaN(rowVersion)) return validationError(c, identity, [{ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' }]);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'doc',
    channelId: existing.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const doc = await deleteFlightDeckPgDoc({
      workspaceId: context.workspace.id,
      docId,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (!doc) return null;
    await snapshotFlightDeckPgDocVersion({ doc, actorId: context.actor.id, operation: 'deleted' }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'doc.delete',
      resourceType: 'doc',
      resourceId: doc.id,
      metadata: { channel_id: doc.channel_id, scope_id: doc.scope_id, row_version: doc.row_version },
    }, sql);
    const outbox = await createFlightDeckPgDocOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: doc.scope_id,
      channelId: doc.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.doc.deleted',
      entityId: doc.id,
      operation: 'deleted',
      entityRowVersion: doc.row_version,
      payload: { doc_id: doc.id },
    }, sql);
    return { doc, auditId, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Doc row_version is stale', identity);

  return c.json({
    identity,
    doc: serializeFlightDeckPgDoc(payload.doc),
    audit: { event_id: payload.auditId, operation: 'doc.delete', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/docs/:docId/body', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);

  const readable = await resolveReadableFlightDeckPgStorageObject({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    storageObjectId: doc.storage_object_id,
  });
  if (!readable.ok) {
    if (readable.reason === 'permission-denied' && readable.access) {
      return storageAuthorizationError(c, readable.access, identity, 'doc.read or channel.read');
    }
    return jsonError(c, 404, 'doc_body_not_found', 'Flight Deck PG doc body storage object was not found', identity);
  }
  if (readable.link.entity_type !== 'doc' || readable.link.entity_id !== doc.id || readable.link.channel_id !== doc.channel_id) {
    return jsonError(c, 404, 'doc_body_not_found', 'Flight Deck PG doc body storage link was not found', identity);
  }
  if (!readable.storageObject.completed_at) {
    return jsonError(c, 409, 'doc_body_upload_incomplete', 'Flight Deck PG doc body storage object upload is not completed', identity, {
      doc: serializeFlightDeckPgDoc(doc, {
        storageObject: serializeFlightDeckPgStorageObjectMetadata(readable.storageObject),
      }),
    });
  }

  const content = await getStorageObjectContent(doc.storage_object_id);
  if (!content) return jsonError(c, 404, 'doc_body_content_missing', 'Flight Deck PG doc body content is missing', identity);

  return c.json({
    identity,
    doc: serializeFlightDeckPgDoc(doc, {
      storageObject: serializeFlightDeckPgStorageObjectMetadata(readable.storageObject),
    }),
    body: {
      object_id: readable.storageObject.id,
      content_type: readable.storageObject.content_type,
      size_bytes: content.size,
      sha256_hex: readable.storageObject.sha256_hex,
      encoding: 'base64',
      base64_data: Buffer.from(content.bytes).toString('base64'),
    },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/docs/:docId/comments', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);

  const access = await authorizeFlightDeckPgStorageRead({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'doc',
    channelId: doc.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.read or channel.read');

  const comments = await listFlightDeckPgDocComments({
    workspaceId: context.workspace.id,
    docId: doc.id,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    doc_id: doc.id,
    comments: comments.map(serializeFlightDeckPgDocComment),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/docs/:docId/comments', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const commentBody = String(body.body || '').trim();
  const parentCommentId = typeof body.parent_comment_id === 'string' && body.parent_comment_id.trim()
    ? body.parent_comment_id.trim()
    : null;
  const metadata = optionalObject(body.metadata);
  const mentionSource = body.mentions !== undefined ? body.mentions : metadata?.mentions;
  const fields: { path: string; code: string; message: string }[] = [];
  if (!commentBody) fields.push({ path: 'body', code: 'required', message: 'body must be a non-empty string' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'doc',
    channelId: doc.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');

  const canonicalMentions = await canonicalDocMentions({
    value: mentionSource,
    path: body.mentions !== undefined ? 'mentions' : 'metadata.mentions',
    workspaceId: context.workspace.id,
    appNpub: context.workspace.app_npub,
    channelId: doc.channel_id,
  });
  if (canonicalMentions.errors.length) return validationError(c, identity, canonicalMentions.errors);
  const commentMetadata = { ...(metadata ?? {}), ...(mentionSource !== undefined ? { mentions: canonicalMentions.mentions } : {}) };
  const bodyVersion = await documentBodyVersionInfo(doc.storage_object_id);

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const comment = await createFlightDeckPgDocComment({
        workspaceId: context.workspace.id,
        doc,
        body: commentBody,
        parentCommentId,
        metadata: commentMetadata,
        actorId: context.actor.id,
      }, sql);
      const activity = await advanceFlightDeckPgResourceActivity({ workspaceId: context.workspace.id, actorId: context.actor.id, resourceType: 'document', resourceId: doc.id }, sql);
      const viewStateOutbox = await createFlightDeckPgResourceViewStateOutboxEvent({ workspaceId: context.workspace.id, actorId: context.actor.id, state: activity.state, activityVersion: Number(activity.resource.activity_version) }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'doc_comment.create',
        resourceType: 'doc_comment',
        resourceId: comment.id,
        metadata: { doc_id: doc.id, parent_comment_id: parentCommentId },
      }, sql);
      const outbox = await createFlightDeckPgDocOutboxEvent({
        workspaceId: context.workspace.id,
        scopeId: comment.scope_id,
        channelId: comment.channel_id,
        actorId: context.actor.id,
        eventType: 'flightdeck_pg.doc_comment.created',
        entityType: 'doc_comment',
        entityId: comment.id,
        operation: 'created',
        entityRowVersion: comment.row_version,
        payload: { doc_id: doc.id, comment_id: comment.id, parent_comment_id: parentCommentId, mentions: canonicalMentions.mentions, activity_version: Number(activity.resource.activity_version), author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
      }, sql);
      const mentionOutbox = canonicalMentions.mentions.length > 0
        ? await createFlightDeckPgDocOutboxEvent({
            workspaceId: context.workspace.id,
            scopeId: comment.scope_id,
            channelId: comment.channel_id,
            actorId: context.actor.id,
            eventType: 'flightdeck_pg.document_comment_mention_added',
            entityType: 'doc_comment',
            entityId: comment.id,
            operation: 'created',
            entityRowVersion: comment.row_version,
            payload: { trigger: 'document_comment_mention_added', document_id: doc.id, doc_id: doc.id, comment_id: comment.id, parent_comment_id: comment.parent_comment_id, workspace_id: comment.workspace_id, scope_id: comment.scope_id, channel_id: comment.channel_id, document_row_version: doc.row_version, comment_row_version: comment.row_version, body_version: bodyVersion, current_body_hash: bodyVersion.sha256_hex, added_mentions: canonicalMentions.mentions, author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
          }, sql)
        : null;
      return { comment, auditId, outbox, mentionOutbox, activityVersion: Number(activity.resource.activity_version), viewStateOutbox };
    });
    await evaluateFlightDeckPgNotificationOutboxEvent(payload.outbox.id).catch(() => undefined);

    return c.json({
      identity,
      comment: serializeFlightDeckPgDocComment(payload.comment),
      audit: { event_id: payload.auditId, operation: 'doc_comment.create', actor_npub: auth.userNpub },
      outbox: payload.outbox,
      mention_outbox: payload.mentionOutbox,
      activity_version: payload.activityVersion,
      view_state_outbox: payload.viewStateOutbox,
    }, 201);
  } catch (error) {
    const sqlCode = (error as { code?: string }).code;
    if (sqlCode === '23503') {
      return jsonError(c, 404, 'parent_comment_not_found', 'Parent document comment was not found', identity);
    }
    const message = error instanceof Error ? error.message : 'Flight Deck PG doc comment could not be created';
    return jsonError(c, 400, 'validation_error', message, identity);
  }
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/docs/:docId/comments/:commentId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);

  const existing = await resolveFlightDeckPgDocComment(context.workspace.id, doc.id, c.req.param('commentId'));
  if (!existing) return jsonError(c, 404, 'doc_comment_not_found', 'Flight Deck PG doc comment not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const status = String(body.comment_status || '').trim();
  const rowVersion = optionalRowVersion(body);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!['open', 'resolved'].includes(status)) fields.push({ path: 'comment_status', code: 'invalid', message: 'comment_status must be open or resolved' });
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'doc',
    channelId: doc.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const currentMetadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? existing.metadata
      : {};
    const comment = await updateFlightDeckPgDocComment({
      workspaceId: context.workspace.id,
      docId: doc.id,
      commentId: existing.id,
      actorId: context.actor.id,
      metadata: { ...currentMetadata, comment_status: status },
      rowVersion,
    }, sql);
    if (!comment) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'doc_comment.update',
      resourceType: 'doc_comment',
      resourceId: comment.id,
      metadata: { doc_id: doc.id, comment_status: status, row_version: comment.row_version },
    }, sql);
    const outbox = await createFlightDeckPgDocOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: comment.scope_id,
      channelId: comment.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.doc_comment.updated',
      entityType: 'doc_comment',
      entityId: comment.id,
      operation: 'updated',
      entityRowVersion: comment.row_version,
      payload: { doc_id: doc.id, comment_id: comment.id, comment_status: status },
    }, sql);
    return { comment, auditId, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Doc comment row_version is stale', identity);

  return c.json({
    identity,
    comment: serializeFlightDeckPgDocComment(payload.comment),
    audit: { event_id: payload.auditId, operation: 'doc_comment.update', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/docs/:docId/comments/:commentId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const doc = await resolveFlightDeckPgDoc(context.workspace.id, c.req.param('docId'));
  if (!doc) return jsonError(c, 404, 'doc_not_found', 'Flight Deck PG doc not found', identity);

  const existing = await resolveFlightDeckPgDocComment(context.workspace.id, doc.id, c.req.param('commentId'));
  if (!existing) return jsonError(c, 404, 'doc_comment_not_found', 'Flight Deck PG doc comment not found', identity);
  const rowVersion = optionalRowVersion({ row_version: c.req.query('row_version') });
  if (Number.isNaN(rowVersion)) return validationError(c, identity, [{ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' }]);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'doc',
    channelId: doc.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const comment = await deleteFlightDeckPgDocComment({
      workspaceId: context.workspace.id,
      docId: doc.id,
      commentId: existing.id,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (!comment) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'doc_comment.delete',
      resourceType: 'doc_comment',
      resourceId: comment.id,
      metadata: { doc_id: doc.id, parent_comment_id: comment.parent_comment_id, row_version: comment.row_version },
    }, sql);
    const outbox = await createFlightDeckPgDocOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: comment.scope_id,
      channelId: comment.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.doc_comment.deleted',
      entityType: 'doc_comment',
      entityId: comment.id,
      operation: 'deleted',
      entityRowVersion: comment.row_version,
      payload: { doc_id: doc.id, comment_id: comment.id, parent_comment_id: comment.parent_comment_id },
    }, sql);
    return { comment, auditId, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Doc comment row_version is stale', identity);

  return c.json({
    identity,
    comment: serializeFlightDeckPgDocComment(payload.comment),
    audit: { event_id: payload.auditId, operation: 'doc_comment.delete', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId/file-folders', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const access = await authorizeFlightDeckPgStorageRead({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.read or channel.read');

  const folders = await listFlightDeckPgChannelFileFolders({
    workspaceId: context.workspace.id,
    channelId,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    channel_id: channelId,
    folders: folders.map((folder) => serializeFlightDeckPgFileFolder(folder)),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/channels/:channelId/file-folders', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const parentFolderId = body.parent_folder_id === undefined || body.parent_folder_id === null
    ? null
    : String(body.parent_folder_id || '').trim() || null;
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!title) fields.push({ path: 'title', code: 'required', message: 'title must be a non-empty string' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.write or channel.write');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);
  const parentPlacement = await resolveFileFolderPlacement({
    workspaceId: context.workspace.id,
    scopeId: channel.scope_id,
    channelId: channel.id,
    folderId: parentFolderId,
  });
  if (parentPlacement.invalid) return jsonError(c, 400, 'folder_scope_mismatch', 'Parent folder must belong to the same scope and channel', identity);

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const folder = await createFlightDeckPgFileFolder({
      workspaceId: context.workspace.id,
      channel,
      title,
      parentFolderId: parentPlacement.folderId,
      metadata: metadata ?? undefined,
      actorId: context.actor.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'file_folder.create',
      resourceType: 'file_folder',
      resourceId: folder.id,
      metadata: { channel_id: folder.channel_id, scope_id: folder.scope_id, parent_folder_id: folder.parent_folder_id },
    }, sql);
    const outbox = await createFlightDeckPgFileFolderOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: folder.scope_id,
      channelId: folder.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.file_folder.created',
      entityId: folder.id,
      operation: 'created',
      entityRowVersion: folder.row_version,
      payload: { folder_id: folder.id, parent_folder_id: folder.parent_folder_id },
    }, sql);
    return { folder, auditId, outbox };
  });

  return c.json({
    identity,
    folder: serializeFlightDeckPgFileFolder(payload.folder),
    audit: { event_id: payload.auditId, operation: 'file_folder.create', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/file-folders/:folderId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const folder = await resolveFlightDeckPgFileFolder(context.workspace.id, c.req.param('folderId'));
  if (!folder) return jsonError(c, 404, 'folder_not_found', 'Flight Deck PG file folder not found', identity);

  const access = await authorizeFlightDeckPgStorageRead({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId: folder.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.read or channel.read');

  return c.json({ identity, folder: serializeFlightDeckPgFileFolder(folder) });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/file-folders/:folderId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const folderId = c.req.param('folderId');
  const existing = await resolveFlightDeckPgFileFolder(context.workspace.id, folderId);
  if (!existing) return jsonError(c, 404, 'folder_not_found', 'Flight Deck PG file folder not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const rowVersion = optionalRowVersion(body);
  const title = body.title === undefined ? undefined : String(body.title || '').trim();
  const parentFolderId = body.parent_folder_id === undefined
    ? undefined
    : (body.parent_folder_id === null ? null : String(body.parent_folder_id || '').trim() || null);
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (body.title !== undefined && !title) fields.push({ path: 'title', code: 'invalid', message: 'title must be non-empty when provided' });
  if (parentFolderId && parentFolderId === existing.id) fields.push({ path: 'parent_folder_id', code: 'invalid', message: 'folder cannot be its own parent' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId: existing.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.write or channel.write');

  const parentPlacement = await resolveFileFolderPlacement({
    workspaceId: context.workspace.id,
    scopeId: existing.scope_id,
    channelId: existing.channel_id,
    folderId: parentFolderId,
  });
  if (parentPlacement.invalid) return jsonError(c, 400, 'folder_scope_mismatch', 'Parent folder must belong to the same scope and channel', identity);

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const folder = await updateFlightDeckPgFileFolder({
      workspaceId: context.workspace.id,
      folderId,
      actorId: context.actor.id,
      rowVersion,
      patch: {
        title,
        parentFolderId: parentFolderId === undefined ? undefined : parentPlacement.folderId,
        metadata: metadata ?? undefined,
      },
    }, sql);
    if (!folder) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'file_folder.update',
      resourceType: 'file_folder',
      resourceId: folder.id,
      metadata: { channel_id: folder.channel_id, scope_id: folder.scope_id, parent_folder_id: folder.parent_folder_id, row_version: folder.row_version },
    }, sql);
    const outbox = await createFlightDeckPgFileFolderOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: folder.scope_id,
      channelId: folder.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.file_folder.updated',
      entityId: folder.id,
      operation: 'updated',
      entityRowVersion: folder.row_version,
      payload: { folder_id: folder.id, parent_folder_id: folder.parent_folder_id },
    }, sql);
    return { folder, auditId, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Folder row_version is stale', identity);

  return c.json({
    identity,
    folder: serializeFlightDeckPgFileFolder(payload.folder),
    audit: { event_id: payload.auditId, operation: 'file_folder.update', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/file-folders/:folderId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const folderId = c.req.param('folderId');
  const existing = await resolveFlightDeckPgFileFolder(context.workspace.id, folderId);
  if (!existing) return jsonError(c, 404, 'folder_not_found', 'Flight Deck PG file folder not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const rowVersion = optionalRowVersion(body);
  const mode = body.mode === undefined || body.mode === null ? 'empty-only' : String(body.mode || '').trim();
  const clientMutationId = typeof body.client_mutation_id === 'string' && body.client_mutation_id.trim()
    ? body.client_mutation_id.trim()
    : null;
  const fields: { path: string; code: string; message: string }[] = [];
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (mode !== 'empty-only') fields.push({ path: 'mode', code: 'unsupported', message: 'mode must be empty-only' });
  if (body.client_mutation_id !== undefined && (typeof body.client_mutation_id !== 'string' || !body.client_mutation_id.trim())) {
    fields.push({ path: 'client_mutation_id', code: 'invalid', message: 'client_mutation_id must be a non-empty string when provided' });
  }
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId: existing.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.write or channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const deleted = await deleteFlightDeckPgFileFolder({
      workspaceId: context.workspace.id,
      folderId,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (deleted.status !== 'deleted') return deleted;
    const folder = deleted.folder;
    const tombstone = {
      entity_type: 'folder',
      entity_id: folder.id,
      workspace_id: folder.workspace_id,
      scope_id: folder.scope_id,
      channel_id: folder.channel_id,
      parent_folder_id: folder.parent_folder_id,
      name: folder.title,
      row_version: folder.row_version,
      deleted_at: folder.deleted_at,
      deleted_by_actor_id: folder.deleted_by_actor_id,
      client_mutation_id: clientMutationId,
    };
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'file_folder.delete',
      resourceType: 'file_folder',
      resourceId: folder.id,
      metadata: { channel_id: folder.channel_id, scope_id: folder.scope_id, parent_folder_id: folder.parent_folder_id, row_version: folder.row_version, client_mutation_id: clientMutationId },
    }, sql);
    const outbox = await createFlightDeckPgFileFolderOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: folder.scope_id,
      channelId: folder.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.file_folder.deleted',
      entityId: folder.id,
      operation: 'deleted',
      entityRowVersion: folder.row_version,
      payload: { folder_id: folder.id, tombstone },
    }, sql);
    return { status: 'deleted' as const, folder, tombstone, auditId, outbox };
  });

  if (payload.status === 'not_found') return jsonError(c, 404, 'folder_not_found', 'Flight Deck PG file folder not found', identity);
  if (payload.status === 'stale') {
    return jsonError(c, 409, 'stale_row_version', 'Folder row_version is stale', identity, {
      folder: serializeFlightDeckPgFileFolder(payload.folder),
    });
  }
  if (payload.status === 'not_empty') {
    return jsonError(c, 409, 'folder_not_empty', 'Folder contains active files or child folders', identity, {
      active_file_count: payload.activeFileCount,
      active_folder_count: payload.activeFolderCount,
      folder: serializeFlightDeckPgFileFolder(payload.folder),
    });
  }

  return c.json({
    identity,
    folder: serializeFlightDeckPgFileFolder(payload.folder),
    tombstone: payload.tombstone,
    audit: { event_id: payload.auditId, operation: 'file_folder.delete', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId/files', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const access = await authorizeFlightDeckPgStorageRead({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.read or channel.read');

  const files = await listFlightDeckPgChannelFiles({
    workspaceId: context.workspace.id,
    channelId,
    limit: parseLimit(c),
    archived: c.req.query('archived') === 'true',
  });
  return c.json({
    identity,
    channel_id: channelId,
    files: files.map((file) => serializeFlightDeckPgFile(file)),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/channels/:channelId/files', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const storageObjectId = String(body.storage_object_id || '').trim();
  const displayName = typeof body.display_name === 'string' && body.display_name.trim() ? body.display_name.trim() : null;
  const description = typeof body.description === 'string' ? body.description : null;
  const folderId = body.folder_id === undefined || body.folder_id === null ? null : String(body.folder_id || '').trim();
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!storageObjectId) fields.push({ path: 'storage_object_id', code: 'required', message: 'storage_object_id must be a storage object UUID' });
  if (body.display_name !== undefined && typeof body.display_name !== 'string') {
    fields.push({ path: 'display_name', code: 'invalid', message: 'display_name must be a string when provided' });
  }
  if (body.display_name !== undefined && typeof body.display_name === 'string' && !body.display_name.trim()) {
    fields.push({ path: 'display_name', code: 'invalid', message: 'display_name must be non-empty when provided' });
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    fields.push({ path: 'description', code: 'invalid', message: 'description must be a string when provided' });
  }
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.write or channel.write');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);
  const folderPlacement = await resolveFileFolderPlacement({
    workspaceId: context.workspace.id,
    scopeId: channel.scope_id,
    channelId: channel.id,
    folderId,
  });
  if (folderPlacement.invalid) return jsonError(c, 400, 'folder_scope_mismatch', 'Folder must belong to the same scope and channel as the file', identity);

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const file = await createFlightDeckPgFile({
        workspaceId: context.workspace.id,
        channel,
        storageObjectId,
        folderId: folderPlacement.folderId,
        displayName,
        description,
        metadata: metadata ?? undefined,
        actorId: context.actor.id,
      }, sql);
      const link = await createFlightDeckPgStorageLink({
        workspaceId: context.workspace.id,
        channelId: channel.id,
        entityType: 'file',
        entityId: file.id,
        storageObjectId,
        metadata: { file_id: file.id, display_name: file.display_name, folder_id: file.folder_id },
        createdByActorId: context.actor.id,
      }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'file.create',
        resourceType: 'file',
        resourceId: file.id,
        metadata: { channel_id: channel.id, scope_id: channel.scope_id, folder_id: file.folder_id, storage_object_id: storageObjectId, storage_link_id: link.id },
      }, sql);
      const outbox = await createFlightDeckPgFileOutboxEvent({
        workspaceId: context.workspace.id,
        scopeId: file.scope_id,
        channelId: file.channel_id,
        actorId: context.actor.id,
        eventType: 'flightdeck_pg.file.created',
        entityId: file.id,
        operation: 'created',
        entityRowVersion: file.row_version,
        payload: { file_id: file.id, folder_id: file.folder_id, storage_object_id: storageObjectId },
      }, sql);
      return { file, link, auditId, outbox };
    });

    return c.json({
      identity,
      file: serializeFlightDeckPgFile(payload.file),
      storage_link: { id: payload.link.id, storage_object_id: payload.link.storage_object_id },
      audit: { event_id: payload.auditId, operation: 'file.create', actor_npub: auth.userNpub },
      outbox: payload.outbox,
    }, 201);
  } catch (error) {
    const sqlCode = (error as { code?: string }).code;
    if (sqlCode === '23505') {
      return jsonError(c, 409, 'file_storage_object_conflict', 'Storage object is already attached to an active Flight Deck PG file', identity);
    }
    const message = error instanceof Error ? error.message : 'Flight Deck PG file could not be created';
    return jsonError(c, 400, 'validation_error', message, identity);
  }
});

flightDeckPgRouter.get('/workspaces/:workspaceId/files/:fileId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const file = await resolveFlightDeckPgFile(context.workspace.id, c.req.param('fileId'));
  if (!file) return jsonError(c, 404, 'file_not_found', 'Flight Deck PG file not found', identity);

  const readable = await resolveReadableFlightDeckPgStorageObject({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    storageObjectId: file.storage_object_id,
  });
  if (!readable.ok) {
    if (readable.reason === 'permission-denied' && readable.access) {
      return storageAuthorizationError(c, readable.access, identity, 'file.read or channel.read');
    }
    return jsonError(c, 404, 'file_object_not_found', 'Flight Deck PG file storage object was not found', identity);
  }
  if (readable.link.entity_type !== 'file' || readable.link.entity_id !== file.id || readable.link.channel_id !== file.channel_id) {
    return jsonError(c, 404, 'file_object_not_found', 'Flight Deck PG file storage link was not found', identity);
  }

  return c.json({
    identity,
    file: serializeFlightDeckPgFile(file, {
      storageObject: serializeFlightDeckPgStorageObjectMetadata(readable.storageObject),
    }),
  });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/files/:fileId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const fileId = c.req.param('fileId');
  const existing = await resolveFlightDeckPgFile(context.workspace.id, fileId);
  if (!existing) return jsonError(c, 404, 'file_not_found', 'Flight Deck PG file not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const rowVersion = optionalRowVersion(body);
  const channelId = body.channel_id === undefined ? undefined : String(body.channel_id || '').trim();
  const folderId = body.folder_id === undefined ? undefined : (body.folder_id === null ? null : String(body.folder_id || '').trim());
  const displayName = body.display_name === undefined ? undefined : String(body.display_name || '').trim();
  const description = body.description === undefined ? undefined : (body.description === null ? null : String(body.description));
  const metadata = optionalObject(body.metadata);
  const archived = body.archived === undefined ? undefined : body.archived;
  const fields: { path: string; code: string; message: string }[] = [];
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (body.channel_id !== undefined && !channelId) fields.push({ path: 'channel_id', code: 'invalid', message: 'channel_id must be non-empty when provided' });
  if (body.display_name !== undefined && !displayName) fields.push({ path: 'display_name', code: 'invalid', message: 'display_name must be non-empty when provided' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (archived !== undefined && typeof archived !== 'boolean') fields.push({ path: 'archived', code: 'invalid', message: 'archived must be a boolean when provided' });
  if (fields.length) return validationError(c, identity, fields);

  let targetChannel = null;
  if (channelId && channelId !== existing.channel_id) {
    targetChannel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
    if (!targetChannel) return jsonError(c, 404, 'channel_not_found', 'Target channel not found', identity);
  }

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId: existing.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.write or channel.write');
  if (targetChannel) {
    const targetAccess = await authorizeFlightDeckPgStorageAttach({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      entityType: 'file',
      channelId: targetChannel.id,
    });
    if (!targetAccess.allowed) return storageAuthorizationError(c, targetAccess, identity, 'file.write or channel.write');
  }
  const effectiveScopeId = targetChannel?.scope_id || existing.scope_id;
  const effectiveChannelId = targetChannel?.id || existing.channel_id;
  const folderPlacement = await resolveFileFolderPlacement({
    workspaceId: context.workspace.id,
    scopeId: effectiveScopeId,
    channelId: effectiveChannelId,
    folderId: folderId === undefined && !targetChannel ? existing.folder_id : folderId,
  });
  if (folderPlacement.invalid) return jsonError(c, 400, 'folder_scope_mismatch', 'Folder must belong to the same scope and channel as the file', identity);

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const file = await updateFlightDeckPgFile({
        workspaceId: context.workspace.id,
        fileId,
        actorId: context.actor.id,
        rowVersion,
        patch: {
          scopeId: targetChannel?.scope_id,
          channelId: targetChannel?.id,
          folderId: folderId === undefined && !targetChannel ? undefined : folderPlacement.folderId,
          displayName,
          description,
          metadata: metadata ?? undefined,
          archived,
        },
      }, sql);
      if (!file) return null;
      if (targetChannel) {
        await sql`
          UPDATE flightdeck_pg_storage_links
          SET
            scope_id = ${targetChannel.scope_id},
            channel_id = ${targetChannel.id},
            metadata = metadata || ${sql.json(asDbJson({ file_id: file.id, display_name: file.display_name, folder_id: file.folder_id }))}::jsonb
          WHERE workspace_id = ${context.workspace.id}
            AND entity_type = 'file'
            AND entity_id = ${file.id}
            AND storage_object_id = ${file.storage_object_id}
            AND deleted_at IS NULL
        `;
      }
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'file.update',
        resourceType: 'file',
        resourceId: file.id,
        metadata: { channel_id: file.channel_id, scope_id: file.scope_id, folder_id: file.folder_id, row_version: file.row_version },
      }, sql);
      const outbox = await createFlightDeckPgFileOutboxEvent({
        workspaceId: context.workspace.id,
        scopeId: file.scope_id,
        channelId: file.channel_id,
        actorId: context.actor.id,
        eventType: 'flightdeck_pg.file.updated',
        entityId: file.id,
        operation: 'updated',
        entityRowVersion: file.row_version,
        payload: { file_id: file.id, folder_id: file.folder_id, storage_object_id: file.storage_object_id },
      }, sql);
      return { file, auditId, outbox };
    });
    if (!payload) return jsonError(c, 409, 'stale_row_version', 'File row_version is stale', identity);

    return c.json({
      identity,
      file: serializeFlightDeckPgFile(payload.file),
      audit: { event_id: payload.auditId, operation: 'file.update', actor_npub: auth.userNpub },
      outbox: payload.outbox,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Flight Deck PG file could not be updated';
    return jsonError(c, 400, 'validation_error', message, identity);
  }
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/files/:fileId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const fileId = c.req.param('fileId');
  const existing = await resolveFlightDeckPgFile(context.workspace.id, fileId);
  if (!existing) return jsonError(c, 404, 'file_not_found', 'Flight Deck PG file not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const rowVersion = optionalRowVersion(body);
  const clientMutationId = typeof body.client_mutation_id === 'string' && body.client_mutation_id.trim()
    ? body.client_mutation_id.trim()
    : null;
  const fields: { path: string; code: string; message: string }[] = [];
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (body.client_mutation_id !== undefined && (typeof body.client_mutation_id !== 'string' || !body.client_mutation_id.trim())) {
    fields.push({ path: 'client_mutation_id', code: 'invalid', message: 'client_mutation_id must be a non-empty string when provided' });
  }
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId: existing.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.write or channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const deleted = await deleteFlightDeckPgFile({
      workspaceId: context.workspace.id,
      fileId,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (deleted.status !== 'deleted') return deleted;
    const file = deleted.file;
    const storageLinks = await tombstoneFlightDeckPgStorageLinksForEntity({
      workspaceId: context.workspace.id,
      entityType: 'file',
      entityId: file.id,
    }, sql);
    const tombstone = {
      entity_type: 'file',
      entity_id: file.id,
      workspace_id: file.workspace_id,
      scope_id: file.scope_id,
      channel_id: file.channel_id,
      parent_folder_id: file.folder_id,
      name: file.display_name,
      row_version: file.row_version,
      deleted_at: file.deleted_at,
      deleted_by_actor_id: file.deleted_by_actor_id,
      current_version_id: file.current_version_id,
      storage_object_id: file.storage_object_id,
      file_version_id: deleted.version.id,
      client_mutation_id: clientMutationId,
    };
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'file.delete',
      resourceType: 'file',
      resourceId: file.id,
      metadata: { channel_id: file.channel_id, scope_id: file.scope_id, folder_id: file.folder_id, row_version: file.row_version, file_version_id: deleted.version.id, storage_links_tombstoned: storageLinks.length, client_mutation_id: clientMutationId },
    }, sql);
    const outbox = await createFlightDeckPgFileOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: file.scope_id,
      channelId: file.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.file.deleted',
      entityId: file.id,
      operation: 'deleted',
      entityRowVersion: file.row_version,
      payload: { file_id: file.id, folder_id: file.folder_id, storage_object_id: file.storage_object_id, file_version_id: deleted.version.id, tombstone },
    }, sql);
    return { status: 'deleted' as const, file, version: deleted.version, tombstone, storageLinks, auditId, outbox };
  });

  if (payload.status === 'not_found') return jsonError(c, 404, 'file_not_found', 'Flight Deck PG file not found', identity);
  if (payload.status === 'stale') {
    return jsonError(c, 409, 'stale_row_version', 'File row_version is stale', identity, {
      file: serializeFlightDeckPgFile(payload.file, { currentVersion: payload.currentVersion }),
      current_version: payload.currentVersion ? serializeFlightDeckPgFileVersion(payload.currentVersion) : null,
    });
  }

  return c.json({
    identity,
    file: serializeFlightDeckPgFile(payload.file, { currentVersion: payload.version }),
    version: serializeFlightDeckPgFileVersion(payload.version),
    tombstone: payload.tombstone,
    storage_links_tombstoned: payload.storageLinks.length,
    audit: { event_id: payload.auditId, operation: 'file.delete', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/files/:fileId/versions', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const file = await resolveFlightDeckPgFile(
    context.workspace.id,
    c.req.param('fileId'),
    undefined,
    { includeDeleted: true },
  );
  if (!file) return jsonError(c, 404, 'file_not_found', 'Flight Deck PG file not found', identity);

  const access = await authorizeFlightDeckPgStorageRead({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId: file.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.read or channel.read');

  const versions = await listFlightDeckPgFileVersions({
    workspaceId: context.workspace.id,
    fileId: file.id,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    file_id: file.id,
    current_version_id: file.current_version_id,
    versions: versions.map((version) => serializeFlightDeckPgFileVersion(version)),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/files/:fileId/versions', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const fileId = c.req.param('fileId');
  const existing = await resolveFlightDeckPgFile(context.workspace.id, fileId);
  if (!existing) return jsonError(c, 404, 'file_not_found', 'Flight Deck PG file not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const baseVersionId = String(body.base_version_id || '').trim();
  const storageObjectId = String(body.storage_object_id || '').trim();
  const clientMutationId = typeof body.client_mutation_id === 'string' && body.client_mutation_id.trim()
    ? body.client_mutation_id.trim()
    : null;
  const fields: { path: string; code: string; message: string }[] = [];
  if (!baseVersionId) fields.push({ path: 'base_version_id', code: 'required', message: 'base_version_id is required for optimistic conflict detection' });
  else if (!isUuid(baseVersionId)) fields.push({ path: 'base_version_id', code: 'invalid', message: 'base_version_id must be a UUID' });
  if (!storageObjectId) fields.push({ path: 'storage_object_id', code: 'required', message: 'storage_object_id must be a storage object UUID' });
  else if (!isUuid(storageObjectId)) fields.push({ path: 'storage_object_id', code: 'invalid', message: 'storage_object_id must be a UUID' });
  if (body.client_mutation_id !== undefined && (typeof body.client_mutation_id !== 'string' || !body.client_mutation_id.trim())) {
    fields.push({ path: 'client_mutation_id', code: 'invalid', message: 'client_mutation_id must be a non-empty string when provided' });
  }
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'file',
    channelId: existing.channel_id,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'file.write or channel.write');

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const replacement = await replaceFlightDeckPgFileContent({
        workspaceId: context.workspace.id,
        fileId,
        actorId: context.actor.id,
        baseVersionId,
        storageObjectId,
      }, sql);
      if (replacement.status !== 'replaced') return replacement;

      const link = await createFlightDeckPgStorageLink({
        workspaceId: context.workspace.id,
        channelId: replacement.file.channel_id,
        entityType: 'file',
        entityId: replacement.file.id,
        storageObjectId,
        metadata: {
          file_id: replacement.file.id,
          display_name: replacement.file.display_name,
          folder_id: replacement.file.folder_id,
          file_version_id: replacement.version.id,
          base_version_id: baseVersionId,
          client_mutation_id: clientMutationId,
        },
        createdByActorId: context.actor.id,
      }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'file.version.create',
        resourceType: 'file',
        resourceId: replacement.file.id,
        metadata: {
          channel_id: replacement.file.channel_id,
          scope_id: replacement.file.scope_id,
          folder_id: replacement.file.folder_id,
          storage_object_id: storageObjectId,
          storage_link_id: link.id,
          file_version_id: replacement.version.id,
          base_version_id: baseVersionId,
          client_mutation_id: clientMutationId,
        },
      }, sql);
      const outbox = await createFlightDeckPgFileOutboxEvent({
        workspaceId: context.workspace.id,
        scopeId: replacement.file.scope_id,
        channelId: replacement.file.channel_id,
        actorId: context.actor.id,
        eventType: 'flightdeck_pg.file.version.created',
        entityId: replacement.file.id,
        operation: 'updated',
        entityRowVersion: replacement.file.row_version,
        payload: {
          file_id: replacement.file.id,
          folder_id: replacement.file.folder_id,
          storage_object_id: storageObjectId,
          file_version_id: replacement.version.id,
          base_version_id: baseVersionId,
          operation: replacement.version.operation,
          client_mutation_id: clientMutationId,
        },
      }, sql);
      return { ...replacement, link, auditId, outbox };
    });

    if (payload.status === 'not_found') return jsonError(c, 404, 'file_not_found', 'Flight Deck PG file not found', identity);
    if (payload.status === 'stale') {
      const currentStorageObject = payload.currentVersion
        ? await getStorageObject(payload.currentVersion.storage_object_id)
        : null;
      return jsonError(c, 409, 'stale_base_version', 'File base_version_id is stale', identity, {
        file: serializeFlightDeckPgFile(payload.file, {
          storageObject: currentStorageObject ? serializeFlightDeckPgStorageObjectMetadata(currentStorageObject) : null,
          currentVersion: payload.currentVersion,
          currentVersionStorageObject: currentStorageObject,
        }),
        current_version: payload.currentVersion
          ? serializeFlightDeckPgFileVersion(payload.currentVersion, { storageObject: currentStorageObject })
          : null,
      });
    }

    const storageObject = await getStorageObject(payload.version.storage_object_id);
    return c.json({
      identity,
      file: serializeFlightDeckPgFile(payload.file, {
        storageObject: storageObject ? serializeFlightDeckPgStorageObjectMetadata(storageObject) : null,
        currentVersion: payload.version,
        currentVersionStorageObject: storageObject,
      }),
      version: serializeFlightDeckPgFileVersion(payload.version, { storageObject }),
      storage_link: { id: payload.link.id, storage_object_id: payload.link.storage_object_id },
      audit: { event_id: payload.auditId, operation: 'file.version.create', actor_npub: auth.userNpub },
      outbox: payload.outbox,
    }, 201);
  } catch (error) {
    const sqlCode = (error as { code?: string }).code;
    if (sqlCode === '23505') {
      return jsonError(c, 409, 'file_storage_object_conflict', 'Storage object is already attached to an active Flight Deck PG object', identity);
    }
    const message = error instanceof Error ? error.message : 'Flight Deck PG file version could not be created';
    return jsonError(c, 400, 'validation_error', message, identity);
  }
});

flightDeckPgRouter.get('/workspaces/:workspaceId/files/:fileId/object', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const file = await resolveFlightDeckPgFile(context.workspace.id, c.req.param('fileId'));
  if (!file) return jsonError(c, 404, 'file_not_found', 'Flight Deck PG file not found', identity);

  const readable = await resolveReadableFlightDeckPgStorageObject({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    storageObjectId: file.storage_object_id,
  });
  if (!readable.ok) {
    if (readable.reason === 'permission-denied' && readable.access) {
      return storageAuthorizationError(c, readable.access, identity, 'file.read or channel.read');
    }
    return jsonError(c, 404, 'file_object_not_found', 'Flight Deck PG file storage object was not found', identity);
  }
  if (readable.link.entity_type !== 'file' || readable.link.entity_id !== file.id || readable.link.channel_id !== file.channel_id) {
    return jsonError(c, 404, 'file_object_not_found', 'Flight Deck PG file storage link was not found', identity);
  }
  if (!readable.storageObject.completed_at) {
    return jsonError(c, 409, 'file_object_upload_incomplete', 'Flight Deck PG file storage object upload is not completed', identity, {
      file: serializeFlightDeckPgFile(file, {
        storageObject: serializeFlightDeckPgStorageObjectMetadata(readable.storageObject),
      }),
    });
  }

  const content = await getStorageObjectContent(file.storage_object_id);
  if (!content) return jsonError(c, 404, 'file_object_content_missing', 'Flight Deck PG file content is missing', identity);

  const etag = storageObjectEtag(readable.storageObject.sha256_hex);
  const commonHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
  };
  if (etag) commonHeaders.ETag = etag;

  const byteRange = parseSingleByteRange(c.req.header('range'), content.size);
  if (byteRange && !byteRange.ok) {
    for (const [name, value] of Object.entries(commonHeaders)) c.header(name, value);
    c.header('Content-Range', `bytes */${content.size}`);
    return jsonError(c, 416, 'range_not_satisfiable', 'Requested byte range is not satisfiable for this file object', identity, {
      object_id: readable.storageObject.id,
      size_bytes: content.size,
    });
  }

  if (byteRange?.ok) {
    const partial = content.bytes.slice(byteRange.start, byteRange.end + 1);
    return new Response(partial, {
      status: 206,
      headers: {
        ...commonHeaders,
        'Content-Type': readable.storageObject.content_type || 'application/octet-stream',
        'Content-Length': String(partial.byteLength),
        'Content-Range': `bytes ${byteRange.start}-${byteRange.end}/${content.size}`,
        'Content-Disposition': `inline; filename="${readable.storageObject.file_name || `${readable.storageObject.id}.bin`}"`,
      },
    });
  }

  c.header('Accept-Ranges', 'bytes');
  if (etag) c.header('ETag', etag);
  return c.json({
    identity,
    file: serializeFlightDeckPgFile(file, {
      storageObject: serializeFlightDeckPgStorageObjectMetadata(readable.storageObject),
    }),
    object: {
      object_id: readable.storageObject.id,
      content_type: readable.storageObject.content_type,
      file_name: readable.storageObject.file_name,
      size_bytes: content.size,
      sha256_hex: readable.storageObject.sha256_hex,
      encoding: 'base64',
      base64_data: Buffer.from(content.bytes).toString('base64'),
    },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId/audio-notes', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const access = await authorizeFlightDeckPgStorageRead({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'audio_note',
    channelId,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'audio_note.read or channel.read');

  const audioNotes = await listFlightDeckPgChannelAudioNotes({
    workspaceId: context.workspace.id,
    channelId,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    channel_id: channelId,
    audio_notes: audioNotes.map((audioNote) => serializeFlightDeckPgAudioNote(audioNote)),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/channels/:channelId/audio-notes', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const storageObjectId = String(body.storage_object_id || '').trim();
  const mimeType = String(body.mime_type || '').trim();
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
  const targetType = typeof body.target_type === 'string' && body.target_type.trim()
    ? body.target_type.trim() as FlightDeckPgReactionTargetType
    : null;
  const targetId = typeof body.target_id === 'string' && body.target_id.trim() ? body.target_id.trim() : null;
  const requestedThreadId = typeof body.thread_id === 'string' && body.thread_id.trim() ? body.thread_id.trim() : null;
  const durationSeconds = optionalNonNegativeNumber(body.duration_seconds);
  const sizeBytes = optionalNonNegativeNumber(body.size_bytes);
  const mediaEncryption = optionalObject(body.media_encryption);
  const metadata = optionalObject(body.metadata);
  const waveformPreview = body.waveform_preview === undefined ? undefined : body.waveform_preview;
  const transcriptPreview = typeof body.transcript_preview === 'string' ? body.transcript_preview : null;
  const recordState = String(body.record_state || 'active').trim();
  const fields: { path: string; code: string; message: string }[] = [];
  if (!storageObjectId) fields.push({ path: 'storage_object_id', code: 'required', message: 'storage_object_id must be a storage object UUID' });
  if (!mimeType) fields.push({ path: 'mime_type', code: 'required', message: 'mime_type must be a non-empty string' });
  if (body.title !== undefined && typeof body.title !== 'string') fields.push({ path: 'title', code: 'invalid', message: 'title must be a string when provided' });
  if (body.title !== undefined && typeof body.title === 'string' && !body.title.trim()) fields.push({ path: 'title', code: 'invalid', message: 'title must be non-empty when provided' });
  if ((targetType && !targetId) || (!targetType && targetId)) fields.push({ path: 'target_id', code: 'invalid', message: 'target_type and target_id must be provided together' });
  if (targetType && !reactionTargetTypes.has(targetType)) fields.push({ path: 'target_type', code: 'invalid', message: reactionTargetTypesMessage });
  if (body.thread_id !== undefined && (!requestedThreadId || typeof body.thread_id !== 'string')) fields.push({ path: 'thread_id', code: 'invalid', message: 'thread_id must be a non-empty thread UUID when provided' });
  if (Number.isNaN(durationSeconds)) fields.push({ path: 'duration_seconds', code: 'invalid', message: 'duration_seconds must be non-negative when provided' });
  if (Number.isNaN(sizeBytes)) fields.push({ path: 'size_bytes', code: 'invalid', message: 'size_bytes must be non-negative when provided' });
  if (mediaEncryption === null) fields.push({ path: 'media_encryption', code: 'invalid', message: 'media_encryption must be an object when provided' });
  if (waveformPreview !== undefined && !Array.isArray(waveformPreview)) fields.push({ path: 'waveform_preview', code: 'invalid', message: 'waveform_preview must be an array when provided' });
  if (body.transcript_preview !== undefined && typeof body.transcript_preview !== 'string') fields.push({ path: 'transcript_preview', code: 'invalid', message: 'transcript_preview must be a string when provided' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (!['active', 'archived'].includes(recordState)) fields.push({ path: 'record_state', code: 'invalid', message: 'record_state must be active or archived' });
  if (fields.length) return validationError(c, identity, fields);

  const access = await authorizeFlightDeckPgStorageAttach({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    entityType: 'audio_note',
    channelId,
  });
  if (!access.allowed) return storageAuthorizationError(c, access, identity, 'audio_note.write or channel.write');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);

  const target = targetType && targetId
    ? await resolveFlightDeckPgReactionTarget(context.workspace.id, targetType, targetId)
    : null;
  if (targetType && targetId && !target) {
    return jsonError(c, 404, 'audio_note_target_not_found', 'Flight Deck PG audio note target was not found', identity);
  }
  if (target && target.channelId !== channel.id) {
    return jsonError(c, 400, 'audio_note_target_channel_mismatch', 'Audio note target must belong to the target channel', identity);
  }
  const requestedThread = requestedThreadId ? await resolveFlightDeckPgThread(context.workspace.id, requestedThreadId) : null;
  if (requestedThreadId && !requestedThread) {
    return jsonError(c, 404, 'audio_note_thread_not_found', 'Flight Deck PG audio note thread was not found', identity);
  }
  if (requestedThread && requestedThread.channel_id !== channel.id) {
    return jsonError(c, 400, 'audio_note_thread_channel_mismatch', 'Audio note thread must belong to the target channel', identity);
  }
  if (target?.threadId && requestedThreadId && target.threadId !== requestedThreadId) {
    return jsonError(c, 400, 'audio_note_thread_target_mismatch', 'Audio note thread_id must match the target thread', identity);
  }
  const threadId = target?.threadId ?? requestedThread?.id ?? null;

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const audioNote = await createFlightDeckPgAudioNote({
        workspaceId: context.workspace.id,
        channel,
        storageObjectId,
        targetType,
        targetId,
        threadId,
        title,
        mimeType,
        durationSeconds,
        sizeBytes,
        mediaEncryption: mediaEncryption ?? undefined,
        waveformPreview: Array.isArray(waveformPreview) ? waveformPreview : undefined,
        transcriptText: typeof body.transcript_text === 'string' ? body.transcript_text : null,
        transcriptPreview,
        transcriptStatus: typeof body.transcript_status === 'string' ? body.transcript_status : null,
        summary: typeof body.summary === 'string' ? body.summary : null,
        recordState: recordState as 'active' | 'archived',
        metadata: metadata ?? undefined,
        actorId: context.actor.id,
      }, sql);
      const link = await createFlightDeckPgStorageLink({
        workspaceId: context.workspace.id,
        channelId: channel.id,
        entityType: 'audio_note',
        entityId: audioNote.id,
        storageObjectId,
        metadata: { audio_note_id: audioNote.id, title: audioNote.title, mime_type: audioNote.mime_type },
        createdByActorId: context.actor.id,
      }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'audio_note.create',
        resourceType: 'audio_note',
        resourceId: audioNote.id,
        metadata: { channel_id: channel.id, scope_id: channel.scope_id, storage_object_id: storageObjectId, storage_link_id: link.id },
      }, sql);
      const outbox = await createFlightDeckPgAudioNoteOutboxEvent({
        workspaceId: context.workspace.id,
        scopeId: audioNote.scope_id,
        channelId: audioNote.channel_id,
        actorId: context.actor.id,
        eventType: 'flightdeck_pg.audio_note.created',
        entityId: audioNote.id,
        operation: 'created',
        entityRowVersion: audioNote.row_version,
        payload: { audio_note_id: audioNote.id, storage_object_id: storageObjectId, target_type: targetType, target_id: targetId },
      }, sql);
      return { audioNote, link, auditId, outbox };
    });

    return c.json({
      identity,
      audio_note: serializeFlightDeckPgAudioNote(payload.audioNote),
      storage_link: { id: payload.link.id, storage_object_id: payload.link.storage_object_id },
      audit: { event_id: payload.auditId, operation: 'audio_note.create', actor_npub: auth.userNpub },
      outbox: payload.outbox,
    }, 201);
  } catch (error) {
    const sqlCode = (error as { code?: string }).code;
    if (sqlCode === '23505') {
      return jsonError(c, 409, 'audio_note_storage_object_conflict', 'Storage object is already attached to an active Flight Deck PG audio note', identity);
    }
    const message = error instanceof Error ? error.message : 'Flight Deck PG audio note could not be created';
    return jsonError(c, 400, 'validation_error', message, identity);
  }
});

flightDeckPgRouter.get('/workspaces/:workspaceId/audio-notes/:audioNoteId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const audioNote = await resolveFlightDeckPgAudioNote(context.workspace.id, c.req.param('audioNoteId'));
  if (!audioNote) return jsonError(c, 404, 'audio_note_not_found', 'Flight Deck PG audio note not found', identity);

  const readable = await resolveReadableFlightDeckPgStorageObject({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    storageObjectId: audioNote.storage_object_id,
  });
  if (!readable.ok) {
    if (readable.reason === 'permission-denied' && readable.access) {
      return storageAuthorizationError(c, readable.access, identity, 'audio_note.read or channel.read');
    }
    return jsonError(c, 404, 'audio_note_media_not_found', 'Flight Deck PG audio note media storage object was not found', identity);
  }
  if (readable.link.entity_type !== 'audio_note' || readable.link.entity_id !== audioNote.id || readable.link.channel_id !== audioNote.channel_id) {
    return jsonError(c, 404, 'audio_note_media_not_found', 'Flight Deck PG audio note media storage link was not found', identity);
  }

  return c.json({
    identity,
    audio_note: serializeFlightDeckPgAudioNote(audioNote, {
      storageObject: serializeFlightDeckPgStorageObjectMetadata(readable.storageObject),
    }),
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/audio-notes/:audioNoteId/media', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const audioNote = await resolveFlightDeckPgAudioNote(context.workspace.id, c.req.param('audioNoteId'));
  if (!audioNote) return jsonError(c, 404, 'audio_note_not_found', 'Flight Deck PG audio note not found', identity);

  const readable = await resolveReadableFlightDeckPgStorageObject({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    storageObjectId: audioNote.storage_object_id,
  });
  if (!readable.ok) {
    if (readable.reason === 'permission-denied' && readable.access) {
      return storageAuthorizationError(c, readable.access, identity, 'audio_note.read or channel.read');
    }
    return jsonError(c, 404, 'audio_note_media_not_found', 'Flight Deck PG audio note media storage object was not found', identity);
  }
  if (readable.link.entity_type !== 'audio_note' || readable.link.entity_id !== audioNote.id || readable.link.channel_id !== audioNote.channel_id) {
    return jsonError(c, 404, 'audio_note_media_not_found', 'Flight Deck PG audio note media storage link was not found', identity);
  }
  if (!readable.storageObject.completed_at) {
    return jsonError(c, 409, 'audio_note_media_upload_incomplete', 'Flight Deck PG audio note media storage object upload is not completed', identity, {
      audio_note: serializeFlightDeckPgAudioNote(audioNote, {
        storageObject: serializeFlightDeckPgStorageObjectMetadata(readable.storageObject),
      }),
    });
  }

  const content = await getStorageObjectContent(audioNote.storage_object_id);
  if (!content) return jsonError(c, 404, 'audio_note_media_content_missing', 'Flight Deck PG audio note media content is missing', identity);

  return c.json({
    identity,
    audio_note: serializeFlightDeckPgAudioNote(audioNote, {
      storageObject: serializeFlightDeckPgStorageObjectMetadata(readable.storageObject),
    }),
    media: {
      object_id: readable.storageObject.id,
      content_type: readable.storageObject.content_type,
      file_name: readable.storageObject.file_name,
      size_bytes: content.size,
      sha256_hex: readable.storageObject.sha256_hex,
      encoding: 'base64',
      base64_data: Buffer.from(content.bytes).toString('base64'),
    },
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/reactions', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const targetType = String(c.req.query('target_type') || '').trim() as FlightDeckPgReactionTargetType;
  const targetId = String(c.req.query('target_id') || '').trim();
  const fields: { path: string; code: string; message: string }[] = [];
  if (!targetType || !reactionTargetTypes.has(targetType)) fields.push({ path: 'target_type', code: 'invalid', message: reactionTargetTypesMessage });
  if (!targetId) fields.push({ path: 'target_id', code: 'required', message: 'target_id must be a typed Flight Deck PG record UUID' });
  if (fields.length) return validationError(c, identity, fields);

  const target = await resolveFlightDeckPgReactionTarget(context.workspace.id, targetType, targetId);
  if (!target) return jsonError(c, 404, 'reaction_target_not_found', 'Flight Deck PG reaction target was not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.read',
    resource: { type: 'channel', channelId: target.channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');

  const reactions = await listFlightDeckPgReactionsForTarget({
    workspaceId: context.workspace.id,
    targetType: target.targetType,
    targetId: target.targetId,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    target_type: target.targetType,
    target_id: target.targetId,
    target: { target_type: target.targetType, target_id: target.targetId, channel_id: target.channelId },
    reactions: reactions.map(serializeFlightDeckPgReaction),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/reactions', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const targetType = String(body.target_type || '').trim() as FlightDeckPgReactionTargetType;
  const targetId = String(body.target_id || '').trim();
  const emoji = String(body.emoji || '').trim();
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!targetType || !reactionTargetTypes.has(targetType)) fields.push({ path: 'target_type', code: 'invalid', message: reactionTargetTypesMessage });
  if (!targetId) fields.push({ path: 'target_id', code: 'required', message: 'target_id must be a typed Flight Deck PG record UUID' });
  if (!emoji) fields.push({ path: 'emoji', code: 'required', message: 'emoji must be a non-empty string' });
  if (emoji && !reactionEmojis.has(emoji as FlightDeckPgReactionEmoji)) fields.push({ path: 'emoji', code: 'invalid', message: 'emoji must be one of thumbs_up, smile, heart, eyes, party, or white_check_mark' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const target = await resolveFlightDeckPgReactionTarget(context.workspace.id, targetType, targetId);
  if (!target) return jsonError(c, 404, 'reaction_target_not_found', 'Flight Deck PG reaction target was not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId: target.channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const reaction = await createFlightDeckPgReaction({
      workspaceId: context.workspace.id,
      target,
      emoji: emoji as FlightDeckPgReactionEmoji,
      emojiShortcode: reactionEmojiShortcodes[emoji as FlightDeckPgReactionEmoji],
      metadata: metadata ?? undefined,
      actorId: context.actor.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'reaction.create',
      resourceType: 'reaction',
      resourceId: reaction.id,
      metadata: { channel_id: target.channelId, scope_id: target.scopeId, target_type: target.targetType, target_id: target.targetId },
    }, sql);
    const outbox = await createFlightDeckPgReactionOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: reaction.scope_id,
      channelId: reaction.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.reaction.created',
      entityId: reaction.id,
      operation: 'created',
      entityRowVersion: reaction.row_version,
      payload: { reaction_id: reaction.id, target_type: reaction.target_type, target_id: reaction.target_id, emoji: reaction.emoji },
    }, sql);
    return { reaction, auditId, outbox };
  });

  return c.json({
    identity,
    reaction: serializeFlightDeckPgReaction(payload.reaction),
    audit: { event_id: payload.auditId, operation: 'reaction.create', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  }, 201);
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/reactions/:reactionId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const reaction = await resolveFlightDeckPgReaction(context.workspace.id, c.req.param('reactionId'));
  if (!reaction) return jsonError(c, 404, 'reaction_not_found', 'Flight Deck PG reaction not found', identity);

  if (reaction.created_by_actor_id !== context.actor.id) {
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'channel.manage',
      resource: { type: 'channel', channelId: reaction.channel_id },
    });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.manage');
  }

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const deleted = await deleteFlightDeckPgReaction({
      workspaceId: context.workspace.id,
      reactionId: reaction.id,
      actorId: context.actor.id,
    }, sql);
    if (!deleted) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'reaction.delete',
      resourceType: 'reaction',
      resourceId: deleted.id,
      metadata: { channel_id: deleted.channel_id, scope_id: deleted.scope_id, target_type: deleted.target_type, target_id: deleted.target_id },
    }, sql);
    const outbox = await createFlightDeckPgReactionOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: deleted.scope_id,
      channelId: deleted.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.reaction.deleted',
      entityId: deleted.id,
      operation: 'deleted',
      entityRowVersion: deleted.row_version,
      payload: { reaction_id: deleted.id, target_type: deleted.target_type, target_id: deleted.target_id, emoji: deleted.emoji },
    }, sql);
    return { reaction: deleted, auditId, outbox };
  });
  if (!payload) return jsonError(c, 404, 'reaction_not_found', 'Flight Deck PG reaction not found', identity);

  return c.json({
    identity,
    reaction: serializeFlightDeckPgReaction(payload.reaction),
    audit: { event_id: payload.auditId, operation: 'reaction.delete', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/agent-activities', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const channelId = String(c.req.query('channel_id') || '').trim();
  const threadId = String(c.req.query('thread_id') || '').trim();
  const activityId = String(c.req.query('activity_id') || '').trim();
  if (!channelId) return validationError(c, identity, [{ path: 'channel_id', code: 'required', message: 'channel_id is required' }]);
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.read',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  const activities = await listFlightDeckPgAgentActivities({
    workspaceId: context.workspace.id,
    channelId,
    threadId: threadId || null,
    activityId: activityId || null,
    limit: parseLimit(c),
  });
  return c.json({ identity, agent_activities: activities.map(serializeFlightDeckPgAgentActivity), next_cursor: null });
});

flightDeckPgRouter.put('/workspaces/:workspaceId/agent-activities/:activityId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const activityId = c.req.param('activityId').trim();
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const channelId = String(body.channel_id || '').trim();
  const threadId = String(body.thread_id || '').trim();
  const triggerMessageId = String(body.trigger_message_id || '').trim();
  const turnId = String(body.turn_id || '').trim();
  const sessionId = String(body.session_id || '').trim();
  const agentNpub = String(body.agent_npub || '').trim();
  const state = String(body.state || '').trim() as FlightDeckPgAgentActivityState;
  const visibility = String(body.visibility || '').trim();
  const sequence = Number(body.sequence);
  const label = normalizeOptionalText(body.label);
  const summary = normalizeOptionalText(body.summary);
  const activityBody = normalizeOptionalText(body.body);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!activityId) fields.push({ path: 'activity_id', code: 'required', message: 'activity_id is required' });
  if (!channelId) fields.push({ path: 'channel_id', code: 'required', message: 'channel_id is required' });
  if (!threadId) fields.push({ path: 'thread_id', code: 'required', message: 'thread_id is required' });
  if (!triggerMessageId) fields.push({ path: 'trigger_message_id', code: 'required', message: 'trigger_message_id is required' });
  if (!turnId) fields.push({ path: 'turn_id', code: 'required', message: 'turn_id is required' });
  if (turnId.length > 255) fields.push({ path: 'turn_id', code: 'too_long', message: 'turn_id must be at most 255 characters' });
  if (!sessionId) fields.push({ path: 'session_id', code: 'required', message: 'session_id is required' });
  if (!agentNpub) fields.push({ path: 'agent_npub', code: 'required', message: 'agent_npub is required' });
  if (agentNpub && agentNpub !== auth.userNpub) fields.push({ path: 'agent_npub', code: 'mismatch', message: 'agent_npub must match the authenticated publisher' });
  if (!agentActivityStates.has(state)) fields.push({ path: 'state', code: 'invalid', message: 'state must be one of accepted, working, waiting, completed, failed, or cancelled' });
  if (visibility !== 'user_visible') fields.push({ path: 'visibility', code: 'invalid', message: 'visibility must be user_visible' });
  if (!Number.isSafeInteger(sequence) || sequence < 0) fields.push({ path: 'sequence', code: 'invalid', message: 'sequence must be a non-negative safe integer' });
  if (label && label.length > 120) fields.push({ path: 'label', code: 'too_long', message: 'label must be at most 120 characters' });
  if (summary && summary.length > 500) fields.push({ path: 'summary', code: 'too_long', message: 'summary must be at most 500 characters' });
  if (activityBody && activityBody.length > 8000) fields.push({ path: 'body', code: 'too_long', message: 'body must be at most 8000 characters' });
  if (fields.length) return validationError(c, identity, fields);

  const thread = await resolveFlightDeckPgThread(context.workspace.id, threadId);
  const triggerMessage = await resolveFlightDeckPgMessage(context.workspace.id, triggerMessageId);
  if (!thread || thread.deleted_at || thread.channel_id !== channelId) return jsonError(c, 404, 'agent_activity_thread_not_found', 'Agent activity thread not found in channel', identity);
  if (!triggerMessage || triggerMessage.deleted_at || triggerMessage.channel_id !== channelId || triggerMessage.thread_id !== threadId) {
    return jsonError(c, 404, 'agent_activity_trigger_message_not_found', 'Trigger message not found in thread', identity);
  }
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const expiresInSeconds = Math.max(30, Math.min(3600, Math.floor(Number(body.expires_in_seconds || 300))));
  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const upsert = await upsertFlightDeckPgAgentActivity({
      workspaceId: context.workspace.id,
      scopeId: thread.scope_id,
      channelId,
      threadId,
      triggerMessageId,
      turnId,
      sessionId,
      activityId,
      agentNpub,
      publisherActorId: context.actor.id,
      state,
      label,
      summary,
      body: activityBody,
      sequence,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    }, sql);
    if (upsert.outcome === 'stale' || upsert.outcome === 'terminal' || upsert.outcome === 'identity_mismatch') return { ...upsert, auditId: null, outbox: null };
    if (upsert.outcome === 'idempotent') return { ...upsert, auditId: null, outbox: null };
    const serialized = serializeFlightDeckPgAgentActivity(upsert.activity);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'agent_activity.upsert',
      resourceType: 'agent_activity',
      resourceId: upsert.activity.id,
      metadata: { activity_id: activityId, turn_id: turnId, sequence, state, channel_id: channelId, thread_id: threadId },
    }, sql);
    const outbox = await createFlightDeckPgAgentActivityOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: thread.scope_id,
      channelId,
      actorId: context.actor.id,
      entityId: upsert.activity.id,
      operation: upsert.outcome,
      sequence,
      payload: { agent_activity: serialized, activity_id: activityId, turn_id: turnId, thread_id: threadId, trigger_message_id: triggerMessageId },
    }, sql);
    return { ...upsert, auditId, outbox };
  });
  if (payload.outcome === 'stale' || payload.outcome === 'terminal' || payload.outcome === 'identity_mismatch') {
    const identityMismatch = payload.outcome === 'identity_mismatch';
    return c.json({
      error: identityMismatch ? 'agent_activity_turn_identity_mismatch' : payload.outcome === 'terminal' ? 'agent_activity_terminal' : 'stale_agent_activity_sequence',
      code: identityMismatch ? 'agent_activity_turn_identity_mismatch' : payload.outcome === 'terminal' ? 'agent_activity_terminal' : 'stale_agent_activity_sequence',
      message: identityMismatch ? 'Agent activity turn_id is immutable' : payload.outcome === 'terminal' ? 'Terminal agent activity cannot be changed' : 'Agent activity sequence must increase',
      identity,
      current: serializeFlightDeckPgAgentActivity(payload.activity),
    }, 409);
  }
  return c.json({
    identity,
    agent_activity: serializeFlightDeckPgAgentActivity(payload.activity),
    idempotent: payload.outcome === 'idempotent',
    audit: payload.auditId ? { event_id: payload.auditId, operation: 'agent_activity.upsert', actor_npub: auth.userNpub } : null,
    outbox: payload.outbox,
  }, payload.outcome === 'created' ? 201 : 200);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/response-activities', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const targetType = String(c.req.query('target_type') || '').trim() as FlightDeckPgResponseActivityTargetType;
  const targetId = String(c.req.query('target_id') || '').trim();
  const channelId = String(c.req.query('channel_id') || '').trim();
  const includeCleared = c.req.query('include_cleared') === 'true';
  const fields: { path: string; code: string; message: string }[] = [];
  if (targetType && !responseActivityTargetTypes.has(targetType)) {
    fields.push({ path: 'target_type', code: 'invalid', message: 'target_type must be one of chat_thread, task_comment, or doc_comment' });
  }
  if (fields.length) return validationError(c, identity, fields);

  const readChannelId = channelId || (targetType && targetId
    ? (await resolveFlightDeckPgResponseActivityTarget(context.workspace.id, targetType, targetId))?.channelId || ''
    : '');
  if (readChannelId) {
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'channel.read',
      resource: { type: 'channel', channelId: readChannelId },
    });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  } else {
    const workspaceDecision = await authorizeFlightDeckPgOperation({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'workspace.read',
      resource: { type: 'workspace' },
    });
    if (!workspaceDecision.allowed) return authorizationError(c, workspaceDecision, identity, 'workspace.read');
  }

  const activities = await listFlightDeckPgResponseActivities({
    workspaceId: context.workspace.id,
    targetType: targetType || null,
    targetId: targetId || null,
    channelId: channelId || null,
    includeCleared,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    response_activities: activities.map(serializeFlightDeckPgResponseActivity),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/response-activities', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const targetType = String(body.target_type || '').trim() as FlightDeckPgResponseActivityTargetType;
  const targetId = String(body.target_id || body.thread_id || body.parent_comment_id || '').trim();
  const status = String(body.status || '').trim() as FlightDeckPgResponseActivityStatus;
  const severity = String(body.severity || '').trim() as FlightDeckPgResponseActivitySeverity;
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!responseActivityTargetTypes.has(targetType)) fields.push({ path: 'target_type', code: 'invalid', message: 'target_type must be one of chat_thread, task_comment, or doc_comment' });
  if (!targetId) fields.push({ path: 'target_id', code: 'required', message: 'target_id must be a non-empty UUID string' });
  if (!responseActivityStatuses.has(status)) fields.push({ path: 'status', code: 'invalid', message: 'status must be one of queued, thinking, drafting, publishing, failed, or cleared' });
  if (severity && !responseActivitySeverities.has(severity)) fields.push({ path: 'severity', code: 'invalid', message: 'severity must be one of info, warning, or error' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const target = await resolveFlightDeckPgResponseActivityTarget(context.workspace.id, targetType, targetId);
  if (!target) return jsonError(c, 404, 'response_activity_target_not_found', 'Flight Deck PG response activity target not found', identity);

  if (target.targetType === 'task_comment') {
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'task.comment',
      resource: { type: 'channel', channelId: target.channelId || '' },
    });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'task.comment');
  } else if (target.targetType === 'doc_comment') {
    const access = await authorizeFlightDeckPgStorageAttach({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      entityType: 'doc',
      channelId: target.channelId || '',
    });
    if (!access.allowed) return storageAuthorizationError(c, access, identity, 'doc.write or channel.write');
  } else {
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: auth.userNpub,
      appNpub: context.workspace.app_npub,
      workspaceId: context.workspace.id,
      permission: 'channel.write',
      resource: { type: 'channel', channelId: target.channelId || '' },
    });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');
  }

  const expiresInSeconds = Math.max(5, Math.min(600, Math.floor(Number(body.expires_in_seconds || 90))));
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const activityType = normalizeOptionalText(body.activity_type) || 'agent_response';
  const label = normalizeOptionalText(body.label);
  const message = normalizeOptionalText(body.message);
  const pipelineRunId = normalizeOptionalText(body.pipeline_run_id);
  const sourceMessageId = normalizeOptionalText(body.source_message_id);

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const activity = await upsertFlightDeckPgResponseActivity({
      workspaceId: context.workspace.id,
      target,
      actorId: context.actor.id,
      actorNpub: auth.userNpub,
      activityType,
      status,
      severity: severity || null,
      label,
      message,
      pipelineRunId,
      sourceMessageId,
      metadata: metadata ?? undefined,
      expiresAt,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'response_activity.upsert',
      resourceType: 'response_activity',
      resourceId: activity.id,
      metadata: { target_type: target.targetType, target_id: target.targetId, status },
    }, sql);
    const serialized = serializeFlightDeckPgResponseActivity(activity);
    const outbox = await createFlightDeckPgResponseActivityOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: activity.scope_id,
      channelId: activity.channel_id,
      actorId: context.actor.id,
      eventType: status === 'cleared' ? 'flightdeck_pg.response_activity.cleared' : 'flightdeck_pg.response_activity.upserted',
      entityId: activity.id,
      operation: status === 'cleared' ? 'cleared' : 'upserted',
      entityRowVersion: activity.row_version,
      payload: { response_activity: serialized, target_type: target.targetType, target_id: target.targetId },
    }, sql);
    return { activity, auditId, outbox };
  });

  return c.json({
    identity,
    response_activity: serializeFlightDeckPgResponseActivity(payload.activity),
    audit: { event_id: payload.auditId, operation: 'response_activity.upsert', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  }, 201);
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/response-activities/:activityId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const activityId = c.req.param('activityId');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const activity = await clearFlightDeckPgResponseActivity({
      workspaceId: context.workspace.id,
      activityId,
      actorId: context.actor.id,
    }, sql);
    if (!activity) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'response_activity.clear',
      resourceType: 'response_activity',
      resourceId: activity.id,
      metadata: { target_type: activity.target_type, target_id: activity.target_id },
    }, sql);
    const serialized = serializeFlightDeckPgResponseActivity(activity);
    const outbox = await createFlightDeckPgResponseActivityOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: activity.scope_id,
      channelId: activity.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.response_activity.cleared',
      entityId: activity.id,
      operation: 'cleared',
      entityRowVersion: activity.row_version,
      payload: { response_activity: serialized, target_type: activity.target_type, target_id: activity.target_id },
    }, sql);
    return { activity, auditId, outbox };
  });
  if (!payload) return jsonError(c, 404, 'response_activity_not_found', 'Flight Deck PG response activity not found', identity);

  return c.json({
    identity,
    response_activity: serializeFlightDeckPgResponseActivity(payload.activity),
    audit: { event_id: payload.auditId, operation: 'response_activity.clear', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/daily-notes', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const notes = await listFlightDeckPgDailyNotes({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId: c.req.query('owner_actor_id') || null,
    ownerNpub: c.req.query('owner_npub') || c.req.query('owner_actor_npub') || null,
    noteDate: c.req.query('date') || c.req.query('note_date') || null,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    daily_notes: notes.map(serializeFlightDeckPgDailyNote),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/daily-notes', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const noteDate = String(body.note_date || body.date || '').trim();
  const title = String(body.title || 'Daily note').trim();
  const status = String(body.status || 'active').trim();
  const metadata = optionalObject(body.metadata);
  const scopeId = String(body.scope_id || '').trim() || null;
  const channelId = String(body.channel_id || '').trim() || null;
  let items: unknown[] = [];
  const fields: { path: string; code: string; message: string }[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(noteDate)) fields.push({ path: 'note_date', code: 'invalid', message: 'note_date must be YYYY-MM-DD' });
  if (!title) fields.push({ path: 'title', code: 'required', message: 'title must be a non-empty string' });
  if (!['active', 'archived'].includes(status)) fields.push({ path: 'status', code: 'invalid', message: 'status must be active or archived' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  try {
    items = normalizeDailyScopeItems(body.items);
  } catch (error) {
    fields.push({ path: 'items', code: 'invalid', message: error instanceof Error ? error.message : 'items are invalid' });
  }
  if (fields.length) return validationError(c, identity, fields);

  const ownerActorId = await resolveDailyScopeOwnerActor(context, body);
  if (!ownerActorId) return jsonError(c, 404, 'daily_scope_owner_not_found', 'Daily Scope owner is not a workspace member', identity);
  let contextScopeId = scopeId;
  let contextChannelId = channelId;
  if (channelId) {
    const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
    if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);
    if (scopeId && channel.scope_id !== scopeId) {
      return validationError(c, identity, [{ path: 'scope_id', code: 'invalid', message: 'scope_id must match the daily note channel scope' }]);
    }
    contextScopeId = channel.scope_id;
    contextChannelId = channel.id;
  }
  const canWrite = await actorCanAccessFlightDeckPgDailyScope({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId,
    access: 'write',
  });
  if (!canWrite) return dailyScopePermissionDenied(c, identity, 'daily_note.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const previous = await resolveFlightDeckPgDailyNoteForOwnerDate({
      workspaceId: context.workspace.id,
      ownerActorId,
      noteDate,
    }, sql);
    const note = await upsertFlightDeckPgDailyNote({
      workspaceId: context.workspace.id,
      ownerActorId,
      scopeId: contextScopeId,
      channelId: contextChannelId,
      noteDate,
      title,
      body: typeof body.body === 'string' ? body.body : null,
      focus: typeof body.focus === 'string' ? body.focus : null,
      items,
      status: status as 'active' | 'archived',
      metadata: metadata ?? undefined,
      actorId: context.actor.id,
    }, sql);
    const previousFingerprint = previous ? dailyNoteVersionContentFingerprint(previous) : null;
    const nextFingerprint = dailyNoteVersionContentFingerprint(note);
    if (!previous || previousFingerprint !== nextFingerprint) {
      await snapshotFlightDeckPgDailyNoteVersion({
        note,
        actorId: context.actor.id,
        operation: !previous ? 'created' : 'updated',
      }, sql);
    }
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'daily_note.upsert',
      resourceType: 'daily_note',
      resourceId: note.id,
      metadata: { note_date: noteDate, owner_actor_id: ownerActorId, scope_id: contextScopeId, channel_id: contextChannelId, updated_by_actor_id: context.actor.id },
    }, sql);
    const outbox = await createFlightDeckPgDailyNoteOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: contextScopeId,
      channelId: contextChannelId,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.daily_note.updated',
      entityId: note.id,
      operation: note.row_version > 1 ? 'updated' : 'created',
      entityRowVersion: note.row_version,
      payload: { daily_note_id: note.id, owner_actor_id: ownerActorId, note_date: noteDate, scope_id: contextScopeId, channel_id: contextChannelId, updated_by_actor_id: context.actor.id },
    }, sql);
    return { note, auditId, outbox };
  });

  return c.json({
    identity,
    daily_note: serializeFlightDeckPgDailyNote(payload.note),
    audit: { event_id: payload.auditId, operation: 'daily_note.upsert', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  }, payload.note.row_version > 1 ? 200 : 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/daily-notes/:dailyNoteId/versions', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const note = await resolveFlightDeckPgDailyNote(context.workspace.id, c.req.param('dailyNoteId'));
  if (!note) return jsonError(c, 404, 'daily_note_not_found', 'Flight Deck PG daily note not found', identity);

  const canRead = await actorCanAccessFlightDeckPgDailyScope({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId: note.owner_actor_id,
    access: 'read',
  });
  if (!canRead) return dailyScopePermissionDenied(c, identity, 'daily_note.read');

  const versions = await listFlightDeckPgDailyNoteVersions({
    workspaceId: context.workspace.id,
    dailyNoteId: note.id,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    daily_note_id: note.id,
    versions: versions.map(serializeFlightDeckPgDailyNoteVersion),
    next_cursor: null,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/daily-notes/:dailyNoteId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const note = await resolveFlightDeckPgDailyNote(context.workspace.id, c.req.param('dailyNoteId'));
  if (!note) return jsonError(c, 404, 'daily_note_not_found', 'Flight Deck PG daily note not found', identity);

  const canRead = await actorCanAccessFlightDeckPgDailyScope({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId: note.owner_actor_id,
    access: 'read',
  });
  if (!canRead) return dailyScopePermissionDenied(c, identity, 'daily_note.read');
  return c.json({ identity, daily_note: serializeFlightDeckPgDailyNote(note) });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/daily-scope/agent-access', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const ownerActorId = c.req.query('owner_actor_id') || context.actor.id;
  if (ownerActorId !== context.actor.id) return dailyScopePermissionDenied(c, identity, 'daily_note.write');
  const access = await listFlightDeckPgDailyScopeAgentAccess({ workspaceId: context.workspace.id, ownerActorId });
  return c.json({ identity, access });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/daily-scope/agent-access', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const agentActorId = String(body.agent_actor_id || '').trim();
  const agentNpub = String(body.agent_npub || body.agent_actor_npub || '').trim();
  const agent = agentActorId
    ? { id: agentActorId }
    : agentNpub
      ? await resolveFlightDeckPgActorByNpub(agentNpub)
      : null;
  if (!agent?.id) return validationError(c, identity, [{ path: 'agent_actor_id', code: 'required', message: 'agent_actor_id or agent_npub is required' }]);
  const membership = await getFlightDeckPgWorkspaceMembership(context.workspace.id, agent.id);
  if (!membership) return jsonError(c, 404, 'daily_scope_agent_not_found', 'Daily Scope agent is not a workspace member', identity);
  if (agent.id === context.actor.id) return validationError(c, identity, [{ path: 'agent_actor_id', code: 'invalid', message: 'agent must be different from owner' }]);
  const row = await upsertFlightDeckPgDailyScopeAgentAccess({
    workspaceId: context.workspace.id,
    ownerActorId: context.actor.id,
    agentActorId: agent.id,
    canRead: body.can_read !== false,
    canWrite: body.can_write !== false,
    actorId: context.actor.id,
  });
  return c.json({ identity, access: row }, 201);
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/daily-scope/agent-access/:agentActorId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const row = await revokeFlightDeckPgDailyScopeAgentAccess({
    workspaceId: context.workspace.id,
    ownerActorId: context.actor.id,
    agentActorId: c.req.param('agentActorId'),
    actorId: context.actor.id,
  });
  return c.json({ identity, revoked: Boolean(row), access: row });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/personal-wapps', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const ownerActorId = c.req.query('owner_actor_id') || null;
  const ownerNpub = c.req.query('owner_npub') || c.req.query('owner_actor_npub') || null;
  const wapps = await listFlightDeckPgPersonalWapps({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId,
    ownerNpub,
    includeArchived: c.req.query('include_archived') === 'true',
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    personal_wapps: wapps.map(serializeFlightDeckPgPersonalWapp),
    next_cursor: null,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/personal-wapps/origin-policy', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const origin = String(c.req.query('origin') || '').trim();
  if (!origin || !isHttpUrl(origin)) {
    return validationError(c, identity, [{ path: 'origin', code: 'invalid', message: 'origin must be an http(s) origin' }]);
  }

  const wapps = await listFlightDeckPgPersonalWapps({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    includeArchived: false,
  });
  return c.json({
    identity,
    policy: resolveFlightDeckPgPersonalWappOriginPolicy(origin, wapps),
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/personal-wapps', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const title = String(body.title || '').trim();
  const launchUrl = String(body.launch_url || body.launchUrl || '').trim();
  const status = String(body.status || 'active').trim();
  let metadata = optionalObject(body.metadata);
  const sortOrder = parsePersonalWappSortOrder(body.sort_order);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!title) fields.push({ path: 'title', code: 'required', message: 'title must be a non-empty string' });
  if (!launchUrl || !isHttpUrl(launchUrl)) fields.push({ path: 'launch_url', code: 'invalid', message: 'launch_url must be an http(s) URL' });
  if (!['active', 'archived'].includes(status)) fields.push({ path: 'status', code: 'invalid', message: 'status must be active or archived' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (body.sort_order !== undefined && sortOrder === null) fields.push({ path: 'sort_order', code: 'invalid', message: 'sort_order must be a non-negative integer' });
  if (metadata && fields.length === 0) {
    const signerValidation = normalizeFlightDeckPgPersonalWappSignerMetadata({
      metadata,
      launchUrl,
    });
    fields.push(...signerValidation.errors);
    metadata = signerValidation.metadata;
  }
  if (fields.length) return validationError(c, identity, fields);

  const ownerActorId = await resolveDailyScopeOwnerActor(context, body);
  if (!ownerActorId) return jsonError(c, 404, 'personal_wapp_owner_not_found', 'Personal WApp owner is not a workspace member', identity);
  let canWrite = await actorCanAccessFlightDeckPgDailyScope({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId,
    access: 'write',
  });
  if (!canWrite) {
    try {
      await evaluateWappManagement({ workspaceId: context.workspace.id, actorId: context.actor.id, ownerActorId, request: { wapp_installation_id: String(body.wapp_installation_id || body.wapp_id || ''), app_id: String(body.app_id || ''), scope_id: String(body.scope_id || ''), channel_id: String(body.channel_id || ''), registered_open_origins: [new URL(launchUrl).origin] } });
      canWrite = true;
    } catch (error) { if (!(error instanceof WappManagementError)) throw error; }
  }
  if (!canWrite) return personalWappPermissionDenied(c, identity, 'personal_wapp.write');

  const explicitIconUrl = normalizeOptionalText(body.icon_url || body.iconUrl);
  const iconUrl = explicitIconUrl || await resolveInheritedPersonalWappIcon(launchUrl);
  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const wapp = await upsertFlightDeckPgPersonalWapp({
      workspaceId: context.workspace.id,
      ownerActorId,
      scopeId: String(body.scope_id || '').trim() || null,
      channelId: String(body.channel_id || '').trim() || null,
      title,
      description: normalizeOptionalText(body.description),
      launchUrl,
      iconUrl,
      appId: normalizeOptionalText(body.app_id || body.appId),
      externalWappId: normalizeOptionalText(body.wapp_id || body.wappId),
      sourceWingmanUrl: normalizeOptionalText(body.source_wingman_url || body.sourceWingmanUrl),
      sortOrder,
      status: status as 'active' | 'archived',
      metadata: metadata ?? undefined,
      actorId: context.actor.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'personal_wapp.create',
      resourceType: 'personal_wapp',
      resourceId: wapp.id,
      metadata: { owner_actor_id: ownerActorId, title, updated_by_actor_id: context.actor.id },
    }, sql);
    const outbox = await createFlightDeckPgPersonalWappOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: wapp.scope_id,
      channelId: wapp.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.personal_wapp.created',
      entityId: wapp.id,
      operation: 'created',
      entityRowVersion: wapp.row_version,
      payload: { personal_wapp_id: wapp.id, owner_actor_id: ownerActorId, updated_by_actor_id: context.actor.id },
    }, sql);
    return { wapp, auditId, outbox };
  });

  return c.json({
    identity,
    personal_wapp: serializeFlightDeckPgPersonalWapp(payload.wapp),
    audit: { event_id: payload.auditId, operation: 'personal_wapp.create', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/personal-wapps/:personalWappId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const wapp = await resolveFlightDeckPgPersonalWapp(context.workspace.id, c.req.param('personalWappId'));
  if (!wapp) return jsonError(c, 404, 'personal_wapp_not_found', 'Flight Deck PG personal WApp not found', identity);
  const canRead = await actorCanAccessFlightDeckPgDailyScope({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId: wapp.owner_actor_id,
    access: 'read',
  });
  if (!canRead) return personalWappPermissionDenied(c, identity, 'personal_wapp.read');
  return c.json({ identity, personal_wapp: serializeFlightDeckPgPersonalWapp(wapp) });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/personal-wapps/:personalWappId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const existing = await resolveFlightDeckPgPersonalWapp(context.workspace.id, c.req.param('personalWappId'));
  if (!existing) return jsonError(c, 404, 'personal_wapp_not_found', 'Flight Deck PG personal WApp not found', identity);
  let canWrite = await actorCanAccessFlightDeckPgDailyScope({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId: existing.owner_actor_id,
    access: 'write',
  });
  if (!canWrite) {
    try {
      await evaluateWappManagement({ workspaceId: context.workspace.id, actorId: context.actor.id, ownerActorId: existing.owner_actor_id, request: { wapp_installation_id: existing.wapp_id || '', app_id: existing.app_id || '', scope_id: String(body.scope_id ?? existing.scope_id ?? ''), channel_id: String(body.channel_id ?? existing.channel_id ?? ''), registered_open_origins: [new URL(String(body.launch_url || body.launchUrl || existing.launch_url)).origin] } });
      canWrite = true;
    } catch (error) { if (!(error instanceof WappManagementError)) throw error; }
  }
  if (!canWrite) return personalWappPermissionDenied(c, identity, 'personal_wapp.write');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const title = body.title === undefined ? existing.title : String(body.title || '').trim();
  const launchUrl = body.launch_url === undefined && body.launchUrl === undefined
    ? existing.launch_url
    : String(body.launch_url || body.launchUrl || '').trim();
  const status = body.status === undefined ? existing.status : String(body.status || '').trim();
  let metadata = body.metadata === undefined ? existing.metadata : optionalObject(body.metadata);
  const sortOrder = body.sort_order === undefined ? existing.sort_order : parsePersonalWappSortOrder(body.sort_order);
  const iconProvided = body.icon_url !== undefined || body.iconUrl !== undefined;
  const fields: { path: string; code: string; message: string }[] = [];
  if (!title) fields.push({ path: 'title', code: 'required', message: 'title must be a non-empty string' });
  if (!launchUrl || !isHttpUrl(launchUrl)) fields.push({ path: 'launch_url', code: 'invalid', message: 'launch_url must be an http(s) URL' });
  if (!['active', 'archived'].includes(status)) fields.push({ path: 'status', code: 'invalid', message: 'status must be active or archived' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (body.sort_order !== undefined && sortOrder === null) fields.push({ path: 'sort_order', code: 'invalid', message: 'sort_order must be a non-negative integer' });
  if (metadata && fields.length === 0) {
    const signerValidation = normalizeFlightDeckPgPersonalWappSignerMetadata({
      metadata,
      launchUrl,
    });
    fields.push(...signerValidation.errors);
    metadata = signerValidation.metadata;
  }
  if (fields.length) return validationError(c, identity, fields);

  const explicitIconUrl = iconProvided ? normalizeOptionalText(body.icon_url || body.iconUrl) : existing.icon_url;
  const launchUrlChanged = launchUrl !== existing.launch_url;
  const iconUrl = explicitIconUrl || (launchUrlChanged || !existing.icon_url ? await resolveInheritedPersonalWappIcon(launchUrl) : existing.icon_url);
  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const wapp = await upsertFlightDeckPgPersonalWapp({
      workspaceId: context.workspace.id,
      wappId: existing.id,
      ownerActorId: existing.owner_actor_id,
      scopeId: body.scope_id === undefined ? existing.scope_id : String(body.scope_id || '').trim() || null,
      channelId: body.channel_id === undefined ? existing.channel_id : String(body.channel_id || '').trim() || null,
      title,
      description: body.description === undefined ? existing.description : normalizeOptionalText(body.description),
      launchUrl,
      iconUrl,
      appId: body.app_id === undefined && body.appId === undefined ? existing.app_id : normalizeOptionalText(body.app_id || body.appId),
      externalWappId: body.wapp_id === undefined && body.wappId === undefined ? existing.wapp_id : normalizeOptionalText(body.wapp_id || body.wappId),
      sourceWingmanUrl: body.source_wingman_url === undefined && body.sourceWingmanUrl === undefined ? existing.source_wingman_url : normalizeOptionalText(body.source_wingman_url || body.sourceWingmanUrl),
      sortOrder,
      status: status as 'active' | 'archived',
      metadata: metadata ?? undefined,
      actorId: context.actor.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'personal_wapp.update',
      resourceType: 'personal_wapp',
      resourceId: wapp.id,
      metadata: { owner_actor_id: wapp.owner_actor_id, title, updated_by_actor_id: context.actor.id },
    }, sql);
    const outbox = await createFlightDeckPgPersonalWappOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: wapp.scope_id,
      channelId: wapp.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.personal_wapp.updated',
      entityId: wapp.id,
      operation: 'updated',
      entityRowVersion: wapp.row_version,
      payload: { personal_wapp_id: wapp.id, owner_actor_id: wapp.owner_actor_id, updated_by_actor_id: context.actor.id },
    }, sql);
    return { wapp, auditId, outbox };
  });

  return c.json({
    identity,
    personal_wapp: serializeFlightDeckPgPersonalWapp(payload.wapp),
    audit: { event_id: payload.auditId, operation: 'personal_wapp.update', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/personal-wapps/:personalWappId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const existing = await resolveFlightDeckPgPersonalWapp(context.workspace.id, c.req.param('personalWappId'));
  if (!existing) return jsonError(c, 404, 'personal_wapp_not_found', 'Flight Deck PG personal WApp not found', identity);
  let canWrite = await actorCanAccessFlightDeckPgDailyScope({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId: existing.owner_actor_id,
    access: 'write',
  });
  if (!canWrite) {
    try {
      await evaluateWappManagement({ workspaceId: context.workspace.id, actorId: context.actor.id, ownerActorId: existing.owner_actor_id, request: { wapp_installation_id: existing.wapp_id || '', app_id: existing.app_id || '', scope_id: existing.scope_id || '', channel_id: existing.channel_id || '', registered_open_origins: [new URL(existing.launch_url).origin] } });
      canWrite = true;
    } catch (error) { if (!(error instanceof WappManagementError)) throw error; }
  }
  if (!canWrite) return personalWappPermissionDenied(c, identity, 'personal_wapp.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const wapp = await archiveFlightDeckPgPersonalWapp({
      workspaceId: context.workspace.id,
      ownerActorId: existing.owner_actor_id,
      wappId: existing.id,
      actorId: context.actor.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'personal_wapp.archive',
      resourceType: 'personal_wapp',
      resourceId: existing.id,
      metadata: { owner_actor_id: existing.owner_actor_id, updated_by_actor_id: context.actor.id },
    }, sql);
    const outbox = await createFlightDeckPgPersonalWappOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: existing.scope_id,
      channelId: existing.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.personal_wapp.deleted',
      entityId: existing.id,
      operation: 'deleted',
      entityRowVersion: wapp?.row_version ?? existing.row_version + 1,
      payload: { personal_wapp_id: existing.id, owner_actor_id: existing.owner_actor_id, updated_by_actor_id: context.actor.id },
    }, sql);
    return { wapp, auditId, outbox };
  });

  return c.json({
    identity,
    deleted: Boolean(payload.wapp),
    personal_wapp: payload.wapp ? serializeFlightDeckPgPersonalWapp(payload.wapp) : null,
    audit: { event_id: payload.auditId, operation: 'personal_wapp.archive', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/personal-wapps/reorder', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const orderedIds = Array.isArray(body.ordered_ids)
    ? body.ordered_ids.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) {
    return validationError(c, identity, [{ path: 'ordered_ids', code: 'invalid', message: 'ordered_ids must contain unique personal WApp ids' }]);
  }
  const ownerActorId = await resolveDailyScopeOwnerActor(context, body);
  if (!ownerActorId) return jsonError(c, 404, 'personal_wapp_owner_not_found', 'Personal WApp owner is not a workspace member', identity);
  const canWrite = await actorCanAccessFlightDeckPgDailyScope({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    ownerActorId,
    access: 'write',
  });
  if (!canWrite) return personalWappPermissionDenied(c, identity, 'personal_wapp.write');

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const wapps = await reorderFlightDeckPgPersonalWapps({
        workspaceId: context.workspace.id,
        ownerActorId,
        orderedIds,
        actorId: context.actor.id,
      }, sql);
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'personal_wapp.reorder',
        resourceType: 'personal_wapp',
        resourceId: ownerActorId,
        metadata: { owner_actor_id: ownerActorId, ordered_ids: orderedIds, updated_by_actor_id: context.actor.id },
      }, sql);
      const outbox = await createFlightDeckPgPersonalWappOutboxEvent({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        eventType: 'flightdeck_pg.personal_wapp.reordered',
        entityId: ownerActorId,
        operation: 'updated',
        entityRowVersion: null,
        payload: { owner_actor_id: ownerActorId, ordered_ids: orderedIds, updated_by_actor_id: context.actor.id },
      }, sql);
      return { wapps, auditId, outbox };
    });
    return c.json({
      identity,
      personal_wapps: payload.wapps.map(serializeFlightDeckPgPersonalWapp),
      audit: { event_id: payload.auditId, operation: 'personal_wapp.reorder', actor_npub: auth.userNpub },
      outbox: payload.outbox,
    });
  } catch (error) {
    return validationError(c, identity, [{ path: 'ordered_ids', code: 'invalid', message: error instanceof Error ? error.message : 'ordered_ids are invalid' }]);
  }
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId/threads/:threadId/workroom-context', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');
  const threadId = c.req.param('threadId');
  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.read',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  const thread = await resolveFlightDeckPgThread(context.workspace.id, threadId);
  if (!thread || thread.channel_id !== channelId) return c.json({ identity, isWorkroom: false });
  const workroom = await resolveFlightDeckPgWorkroomByThread({ workspaceId: context.workspace.id, channelId, threadId });
  if (!workroom) return c.json({ identity, isWorkroom: false });

  const participantNpub = c.req.query('participant_npub') || c.req.query('actor_npub') || auth.userNpub;
  const limit = parseLimit(c);
  const [participants, events, links, approvals] = await Promise.all([
    listFlightDeckPgWorkroomParticipants({ workspaceId: context.workspace.id, workroomId: workroom.id }),
    listFlightDeckPgWorkroomEvents({ workspaceId: context.workspace.id, workroomId: workroom.id, limit }),
    listFlightDeckPgWorkroomLinks({ workspaceId: context.workspace.id, workroomId: workroom.id, limit }),
    listFlightDeckPgTypedApprovals({ workspaceId: context.workspace.id, targetType: 'workroom', targetId: workroom.id, status: null, limit }),
  ]);
  const participant = participants.find((item) => item.actor_npub === participantNpub) ?? null;
  const repo = objectValue(workroom.repo);
  const branches = objectValue(workroom.branches);
  return c.json({
    identity,
    isWorkroom: true,
    workroom: {
      id: workroom.id,
      workspaceId: workroom.workspace_id,
      scopeId: workroom.scope_id,
      channelId: workroom.channel_id,
      threadId: workroom.thread_id ?? threadId,
      name: workroom.title,
      goal: workroom.goal,
      state: typedWorkroomState(workroom.status),
      repo: {
        provider: repo.provider ?? null,
        owner: repo.owner ?? null,
        name: repo.name ?? null,
        url: repo.url ?? null,
        integrationBranch: branches.integration ?? null,
        productionBranch: branches.production ?? null,
      },
    },
    participant: participant ? typedParticipantMetadata(participant) : null,
    appTargets: typedAppTargets(workroom.app_targets, branches),
    recentEvents: events.map(serializeFlightDeckPgWorkroomEvent),
    recentLinks: links.map(serializeFlightDeckPgWorkroomLink),
    openApprovals: approvals.filter((approval) => approval.status === 'requested' || approval.status === 'in_review').map(serializeFlightDeckPgTypedApproval),
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/workrooms/search', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const workrooms = await listVisibleFlightDeckPgWorkrooms({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    groupIds: context.groupIds,
    limit: parseLimit(c),
    scopeId: c.req.query('scope_id') || null,
    channelId: c.req.query('channel_id') || null,
    query: c.req.query('q') || c.req.query('query') || null,
  });
  return c.json({ identity, workrooms: workrooms.map(serializeFlightDeckPgWorkroom), next_cursor: null });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/workrooms', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const status = c.req.query('status') as FlightDeckPgWorkroomStatus | undefined;
  if (status && !workroomStatuses.has(status)) {
    return validationError(c, identity, [{ path: 'status', code: 'invalid', message: 'status is not a valid workroom status' }]);
  }

  const workrooms = await listVisibleFlightDeckPgWorkrooms({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    groupIds: context.groupIds,
    limit: parseLimit(c),
    scopeId: c.req.query('scope_id') || null,
    channelId: c.req.query('channel_id') || null,
    status: status ?? null,
  });
  return c.json({ identity, workrooms: workrooms.map(serializeFlightDeckPgWorkroom), next_cursor: null });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/workrooms', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const title = String(body.title || '').trim();
  const goal = String(body.goal || '').trim();
  const channelId = String(body.channel_id || '').trim();
  const repo = optionalObject(body.repo);
  const branches = optionalObject(body.branches);
  const appTargets = optionalObject(body.app_targets);
  const approvalPolicy = optionalObject(body.approval_policy);
  const archivePolicy = optionalObject(body.archive_policy);
  const metadata = optionalObject(body.metadata);
  const rawParticipants = Array.isArray(body.participants) ? body.participants : [];
  const fields: { path: string; code: string; message: string }[] = [];
  if (!title) fields.push({ path: 'title', code: 'required', message: 'title must be a non-empty string' });
  if (!goal) fields.push({ path: 'goal', code: 'required', message: 'goal must be a non-empty string' });
  if (!channelId) fields.push({ path: 'channel_id', code: 'required', message: 'channel_id is required' });
  if (repo === null) fields.push({ path: 'repo', code: 'invalid', message: 'repo must be an object when provided' });
  if (branches === null) fields.push({ path: 'branches', code: 'invalid', message: 'branches must be an object when provided' });
  if (appTargets === null) fields.push({ path: 'app_targets', code: 'invalid', message: 'app_targets must be an object when provided' });
  if (approvalPolicy === null) fields.push({ path: 'approval_policy', code: 'invalid', message: 'approval_policy must be an object when provided' });
  if (archivePolicy === null) fields.push({ path: 'archive_policy', code: 'invalid', message: 'archive_policy must be an object when provided' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (body.participants !== undefined && !Array.isArray(body.participants)) fields.push({ path: 'participants', code: 'invalid', message: 'participants must be an array when provided' });
  const participants = rawParticipants.map((item, index) => {
    const participant = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
    const actorNpub = String(participant?.actor_npub || participant?.npub || '').trim();
    const kind = String(participant?.kind || 'human').trim() as FlightDeckPgWorkroomParticipantKind;
    const role = String(participant?.role || 'contributor').trim() as FlightDeckPgWorkroomParticipantRole;
    const status = String(participant?.status || 'invited').trim() as FlightDeckPgWorkroomParticipantStatus;
    const accessStatus = participant?.access_status === undefined ? undefined : String(participant.access_status).trim() as FlightDeckPgWorkroomAccessStatus;
    const participantMetadata = optionalObject(participant?.metadata);
    if (!participant) fields.push({ path: `participants.${index}`, code: 'invalid', message: 'participant must be an object' });
    if (!actorNpub) fields.push({ path: `participants.${index}.actor_npub`, code: 'required', message: 'actor_npub is required' });
    if (!workroomParticipantKinds.has(kind)) fields.push({ path: `participants.${index}.kind`, code: 'invalid', message: 'kind is not valid' });
    if (!workroomParticipantRoles.has(role)) fields.push({ path: `participants.${index}.role`, code: 'invalid', message: 'role is not valid' });
    if (!workroomParticipantStatuses.has(status)) fields.push({ path: `participants.${index}.status`, code: 'invalid', message: 'status is not valid' });
    if (accessStatus && !workroomAccessStatuses.has(accessStatus)) fields.push({ path: `participants.${index}.access_status`, code: 'invalid', message: 'access_status is not valid' });
    if (participantMetadata === null) fields.push({ path: `participants.${index}.metadata`, code: 'invalid', message: 'metadata must be an object when provided' });
    return { actorNpub, kind, role, label: typeof participant?.label === 'string' ? participant.label : null, status, accessStatus, metadata: participantMetadata ?? {} };
  });
  if (fields.length) return validationError(c, identity, fields);

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);
  if (body.scope_id && String(body.scope_id) !== channel.scope_id) {
    return validationError(c, identity, [{ path: 'scope_id', code: 'mismatch', message: 'scope_id does not match channel scope' }]);
  }
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'channel.write',
    resource: { type: 'channel', channelId: channel.id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const workroom = await createFlightDeckPgWorkroom({
      workspaceId: context.workspace.id,
      channel,
      title,
      goal,
      integrationAutopilotNpub: typeof body.integration_autopilot_npub === 'string' ? body.integration_autopilot_npub.trim() || null : null,
      repo: repo ?? undefined,
      branches: branches ?? undefined,
      appTargets: appTargets ?? undefined,
      approvalPolicy: approvalPolicy ?? undefined,
      archivePolicy: archivePolicy ?? undefined,
      metadata: metadata ?? undefined,
      actorId: context.actor.id,
    }, sql);
    const event = await createFlightDeckPgWorkroomEvent({
      workspaceId: context.workspace.id,
      workroom,
      event: { eventType: 'created', actorNpub: auth.userNpub, actorId: context.actor.id, title: 'Workroom created' },
    }, sql);
    const createdParticipants = [];
    const failedParticipants = [];
    for (const participant of participants) {
      const created = await createFlightDeckPgWorkroomParticipant({ workspaceId: context.workspace.id, workroomId: workroom.id, participant }, sql);
      createdParticipants.push(created);
      if (created.access_status === 'failed') {
        failedParticipants.push(created);
        await createFlightDeckPgWorkroomEvent({
          workspaceId: context.workspace.id,
          workroom,
          event: {
            eventType: 'access_grant_failed',
            actorNpub: auth.userNpub,
            actorId: context.actor.id,
            targetType: 'participant',
            targetRef: created.actor_npub,
            title: 'Participant access failed',
            payload: { actor_npub: created.actor_npub, access_issue: created.access_issue },
          },
        }, sql);
      }
    }
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'workroom.create',
      resourceType: 'workroom',
      resourceId: workroom.id,
      metadata: { channel_id: channel.id, scope_id: channel.scope_id, failed_participants: failedParticipants.length },
    }, sql);
    const outbox = await createFlightDeckPgWorkroomOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: workroom.scope_id,
      channelId: workroom.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.workroom.created',
      entityType: 'workroom',
      entityId: workroom.id,
      operation: 'created',
      entityRowVersion: workroom.row_version,
      payload: { workroom_id: workroom.id },
    }, sql);
    return { workroom, event, participants: createdParticipants, auditId, outbox };
  });

  return c.json({
    identity,
    workroom: serializeFlightDeckPgWorkroom(payload.workroom),
    participants: payload.participants.map(serializeFlightDeckPgWorkroomParticipant),
    event: serializeFlightDeckPgWorkroomEvent(payload.event),
    audit: { event_id: payload.auditId, operation: 'workroom.create', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/workrooms/:workroomId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.read', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  const [participants, events, links] = await Promise.all([
    listFlightDeckPgWorkroomParticipants({ workspaceId: context.workspace.id, workroomId: workroom.id }),
    listFlightDeckPgWorkroomEvents({ workspaceId: context.workspace.id, workroomId: workroom.id, limit: parseLimit(c) }),
    listFlightDeckPgWorkroomLinks({ workspaceId: context.workspace.id, workroomId: workroom.id, limit: parseLimit(c) }),
  ]);
  return c.json({
    identity,
    workroom: serializeFlightDeckPgWorkroom(workroom),
    participants: participants.map(serializeFlightDeckPgWorkroomParticipant),
    events: events.map(serializeFlightDeckPgWorkroomEvent),
    links: links.map(serializeFlightDeckPgWorkroomLink),
  });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/workrooms/:workroomId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const existing = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!existing) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const rowVersion = optionalRowVersion(body);
  const status = body.status === undefined ? undefined : String(body.status).trim() as FlightDeckPgWorkroomStatus;
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (body.title !== undefined && !String(body.title).trim()) fields.push({ path: 'title', code: 'invalid', message: 'title must be non-empty when provided' });
  if (body.goal !== undefined && !String(body.goal).trim()) fields.push({ path: 'goal', code: 'invalid', message: 'goal must be non-empty when provided' });
  if (status !== undefined && !workroomStatuses.has(status)) fields.push({ path: 'status', code: 'invalid', message: 'status is not valid' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.write', resource: { type: 'channel', channelId: existing.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');
  const updated = await updateFlightDeckPgWorkroom({
    workspaceId: context.workspace.id,
    workroomId: existing.id,
    actorId: context.actor.id,
    rowVersion,
    patch: {
      title: body.title === undefined ? undefined : String(body.title).trim(),
      goal: body.goal === undefined ? undefined : String(body.goal).trim(),
      status,
      integrationAutopilotNpub: body.integration_autopilot_npub === undefined ? undefined : String(body.integration_autopilot_npub || '').trim() || null,
      repo: optionalObject(body.repo) ?? undefined,
      branches: optionalObject(body.branches) ?? undefined,
      appTargets: optionalObject(body.app_targets) ?? undefined,
      approvalPolicy: optionalObject(body.approval_policy) ?? undefined,
      archivePolicy: optionalObject(body.archive_policy) ?? undefined,
      metadata: metadata ?? undefined,
    },
  });
  if (!updated) return jsonError(c, 409, 'stale_row_version', 'Workroom row_version is stale', identity);
  return c.json({ identity, workroom: serializeFlightDeckPgWorkroom(updated) });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/workrooms/:workroomId/start', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const existing = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!existing) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c) ?? {};
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.write', resource: { type: 'channel', channelId: existing.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');
  const rowVersion = optionalRowVersion(body);
  if (Number.isNaN(rowVersion)) return validationError(c, identity, [{ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' }]);
  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    let workroom = await updateFlightDeckPgWorkroom({ workspaceId: context.workspace.id, workroomId: existing.id, actorId: context.actor.id, rowVersion, patch: { status: 'active' } }, sql);
    if (!workroom) return null;
    const event = await createFlightDeckPgWorkroomEvent({ workspaceId: context.workspace.id, workroom, event: { eventType: 'started', actorNpub: auth.userNpub, actorId: context.actor.id, title: 'Workroom started' } }, sql);
    const channel = await resolveFlightDeckPgChannel(context.workspace.id, workroom.channel_id, sql);
    const link = `/api/v4/flightdeck-pg/workspaces/${context.workspace.id}/workrooms/${workroom.id}`;
    const announcementBody = `Workroom Started: ${workroom.title}, by ${auth.userNpub}.\nGoal: ${workroom.goal}`;
    const announcementMetadata = {
      kind: 'workroom_announcement',
      workroom_id: workroom.id,
      workroom_title: workroom.title,
      workroom_goal: workroom.goal,
      workroom_status: 'started',
      workroom_link: link,
      started_by_npub: auth.userNpub,
    };
    const thread = channel ? await createFlightDeckPgThread({
      workspaceId: context.workspace.id,
      channel,
      title: `Workroom: ${workroom.title}`.slice(0, 120),
      latest: announcementBody,
      metadata: { kind: 'workroom_thread', workroom_id: workroom.id },
      actorId: context.actor.id,
    }, sql) : null;
    const message = channel ? await createFlightDeckPgMessage({
      workspaceId: context.workspace.id,
      channel,
      body: announcementBody,
      threadId: thread?.id ?? null,
      metadata: { ...announcementMetadata, workroom_thread_id: thread?.id ?? null },
      actorId: context.actor.id,
    }, sql) : null;
    const announcementThread = thread && message ? await attachFlightDeckPgThreadSourceMessage({
      workspaceId: context.workspace.id,
      threadId: thread.id,
      sourceMessageId: message.id,
      latest: message.body,
      actorId: context.actor.id,
    }, sql) : thread;
    if (message) {
      const previousMetadata = workroom.metadata && typeof workroom.metadata === 'object' && !Array.isArray(workroom.metadata)
        ? workroom.metadata as Record<string, unknown>
        : {};
      workroom = await updateFlightDeckPgWorkroom({
        workspaceId: context.workspace.id,
        workroomId: workroom.id,
        actorId: context.actor.id,
        rowVersion: workroom.row_version,
        patch: {
          threadId: announcementThread?.id ?? thread?.id ?? null,
          metadata: {
            ...previousMetadata,
            announcement_message_id: message.id,
            announcement_thread_id: announcementThread?.id ?? thread?.id ?? null,
            announcement_channel_id: workroom.channel_id,
            announcement_link: link,
          },
        },
      }, sql) ?? workroom;
    }
    const chatOutbox = message ? await createFlightDeckPgChatOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: workroom.scope_id,
      channelId: workroom.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.message.created',
      entityType: 'message',
      entityId: message.id,
      operation: 'created',
      entityRowVersion: message.row_version,
      payload: { message_id: message.id, thread_id: announcementThread?.id ?? thread?.id ?? null, workroom_id: workroom.id },
    }, sql) : null;
    const threadOutbox = announcementThread ? await createFlightDeckPgChatOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: announcementThread.scope_id,
      channelId: announcementThread.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.thread.created',
      entityType: 'thread',
      entityId: announcementThread.id,
      operation: 'created',
      entityRowVersion: announcementThread.row_version,
      payload: { thread_id: announcementThread.id, source_message_id: announcementThread.source_message_id, workroom_id: workroom.id },
    }, sql) : null;
    const outbox = await createFlightDeckPgWorkroomOutboxEvent({ workspaceId: context.workspace.id, scopeId: workroom.scope_id, channelId: workroom.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.workroom.started', entityType: 'workroom', entityId: workroom.id, operation: 'started', entityRowVersion: workroom.row_version, payload: { workroom_id: workroom.id, announcement_message_id: message?.id ?? null, announcement_thread_id: announcementThread?.id ?? thread?.id ?? null } }, sql);
    return { workroom, event, message, thread: announcementThread, chatOutbox, threadOutbox, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Workroom row_version is stale', identity);
  return c.json({
    identity,
    workroom: serializeFlightDeckPgWorkroom(payload.workroom),
    event: serializeFlightDeckPgWorkroomEvent(payload.event),
    announcement_message: payload.message ? serializeFlightDeckPgMessage(payload.message) : null,
    announcement_thread: payload.thread ? serializeFlightDeckPgThread(payload.thread) : null,
    outbox: payload.outbox,
    ...(payload.threadOutbox ? { thread_outbox: payload.threadOutbox } : {}),
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/workrooms/:workroomId/archive', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const existing = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!existing) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c) ?? {};
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.manage', resource: { type: 'channel', channelId: existing.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.manage');
  const rowVersion = optionalRowVersion(body);
  if (Number.isNaN(rowVersion)) return validationError(c, identity, [{ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' }]);
  const workroom = await archiveFlightDeckPgWorkroom({ workspaceId: context.workspace.id, workroomId: existing.id, actorId: context.actor.id, rowVersion });
  if (!workroom) return jsonError(c, 409, 'stale_row_version', 'Workroom row_version is stale', identity);
  await createFlightDeckPgWorkroomEvent({ workspaceId: context.workspace.id, workroom, event: { eventType: 'archived', actorNpub: auth.userNpub, actorId: context.actor.id, title: 'Workroom archived' } });
  return c.json({ identity, workroom: serializeFlightDeckPgWorkroom(workroom) });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/workrooms/:workroomId/participants', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.read', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  const participants = await listFlightDeckPgWorkroomParticipants({ workspaceId: context.workspace.id, workroomId: workroom.id });
  return c.json({ identity, participants: participants.map(serializeFlightDeckPgWorkroomParticipant) });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/workrooms/:workroomId/participants', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const actorNpub = String(body.actor_npub || body.npub || '').trim();
  const kind = String(body.kind || 'human').trim() as FlightDeckPgWorkroomParticipantKind;
  const role = String(body.role || 'contributor').trim() as FlightDeckPgWorkroomParticipantRole;
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!actorNpub) fields.push({ path: 'actor_npub', code: 'required', message: 'actor_npub is required' });
  if (!workroomParticipantKinds.has(kind)) fields.push({ path: 'kind', code: 'invalid', message: 'kind is not valid' });
  if (!workroomParticipantRoles.has(role)) fields.push({ path: 'role', code: 'invalid', message: 'role is not valid' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.manage', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.manage');
  const participant = await createFlightDeckPgWorkroomParticipant({ workspaceId: context.workspace.id, workroomId: workroom.id, participant: { actorNpub, kind, role, label: typeof body.label === 'string' ? body.label : null, metadata: metadata ?? {} } });
  return c.json({ identity, participant: serializeFlightDeckPgWorkroomParticipant(participant) }, 201);
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/workrooms/:workroomId/participants/:participantId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const role = body.role === undefined ? undefined : String(body.role).trim() as FlightDeckPgWorkroomParticipantRole;
  const status = body.status === undefined ? undefined : String(body.status).trim() as FlightDeckPgWorkroomParticipantStatus;
  const accessStatus = body.access_status === undefined ? undefined : String(body.access_status).trim() as FlightDeckPgWorkroomAccessStatus;
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (role !== undefined && !workroomParticipantRoles.has(role)) fields.push({ path: 'role', code: 'invalid', message: 'role is not valid' });
  if (status !== undefined && !workroomParticipantStatuses.has(status)) fields.push({ path: 'status', code: 'invalid', message: 'status is not valid' });
  if (accessStatus !== undefined && !workroomAccessStatuses.has(accessStatus)) fields.push({ path: 'access_status', code: 'invalid', message: 'access_status is not valid' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.manage', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.manage');
  const sql = getDb();
  const [participant] = await sql<any[]>`
    UPDATE flightdeck_pg_workroom_participants
    SET
      role = COALESCE(${role ?? null}, role),
      status = COALESCE(${status ?? null}, status),
      access_status = COALESCE(${accessStatus ?? null}, access_status),
      access_issue = CASE WHEN ${body.access_issue !== undefined} THEN ${typeof body.access_issue === 'string' ? body.access_issue : null} ELSE access_issue END,
      metadata = COALESCE(${metadata === undefined ? null : sql.json(asDbJson(metadata ?? {}))}, metadata),
      updated_at = NOW()
    WHERE workspace_id = ${context.workspace.id}
      AND workroom_id = ${workroom.id}
      AND id = ${c.req.param('participantId')}
    RETURNING *
  `;
  if (!participant) return jsonError(c, 404, 'participant_not_found', 'Flight Deck PG workroom participant not found', identity);
  return c.json({ identity, participant: serializeFlightDeckPgWorkroomParticipant(participant) });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/workrooms/:workroomId/events', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.read', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  const events = await listFlightDeckPgWorkroomEvents({ workspaceId: context.workspace.id, workroomId: workroom.id, limit: parseLimit(c) });
  return c.json({ identity, events: events.map(serializeFlightDeckPgWorkroomEvent), next_cursor: null });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/workrooms/:workroomId/events', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const eventType = String(body.event_type || 'note').trim() as FlightDeckPgWorkroomEventType;
  const visibility = String(body.visibility || 'room').trim() as FlightDeckPgWorkroomEventVisibility;
  const payloadObject = optionalObject(body.payload);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!workroomEventTypes.has(eventType)) fields.push({ path: 'event_type', code: 'invalid', message: 'event_type is not valid' });
  if (!workroomEventVisibilities.has(visibility)) fields.push({ path: 'visibility', code: 'invalid', message: 'visibility is not valid' });
  if (payloadObject === null) fields.push({ path: 'payload', code: 'invalid', message: 'payload must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.write', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');
  const event = await createFlightDeckPgWorkroomEvent({ workspaceId: context.workspace.id, workroom, event: { eventType, visibility, actorNpub: auth.userNpub, actorId: context.actor.id, targetType: typeof body.target_type === 'string' ? body.target_type : null, targetRef: typeof body.target_ref === 'string' ? body.target_ref : null, title: typeof body.title === 'string' ? body.title : null, body: typeof body.body === 'string' ? body.body : null, payload: payloadObject ?? {} } });
  return c.json({ identity, event: serializeFlightDeckPgWorkroomEvent(event) }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/workrooms/:workroomId/links', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.read', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  const links = await listFlightDeckPgWorkroomLinks({ workspaceId: context.workspace.id, workroomId: workroom.id, limit: parseLimit(c) });
  return c.json({ identity, links: links.map(serializeFlightDeckPgWorkroomLink), next_cursor: null });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/workrooms/:workroomId/links', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const linkType = String(body.link_type || '').trim() as FlightDeckPgWorkroomLinkType;
  const targetType = String(body.target_type || '').trim();
  const targetId = typeof body.target_id === 'string' && body.target_id.trim() ? body.target_id.trim() : null;
  const externalUrl = typeof body.external_url === 'string' && body.external_url.trim() ? body.external_url.trim() : null;
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!workroomLinkTypes.has(linkType)) fields.push({ path: 'link_type', code: 'invalid', message: 'link_type is not valid' });
  if (!targetType) fields.push({ path: 'target_type', code: 'required', message: 'target_type is required' });
  if (!targetId && !externalUrl) fields.push({ path: 'target_id', code: 'required', message: 'target_id or external_url is required' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.write', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');
  const link = await createFlightDeckPgWorkroomLink({ workspaceId: context.workspace.id, workroom, actorId: context.actor.id, link: { linkType, targetType, targetId, externalUrl, label: typeof body.label === 'string' ? body.label : null, status: typeof body.status === 'string' ? body.status : null, metadata: metadata ?? {} } });
  return c.json({ identity, link: serializeFlightDeckPgWorkroomLink(link) }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/approvals', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const targetType = c.req.query('target_type') || null;
  const targetId = c.req.query('target_id') || null;
  const action = c.req.query('action') || null;
  const status = c.req.query('status') as FlightDeckPgApprovalStatus | undefined;
  if (status && !typedApprovalStatuses.has(status)) return validationError(c, identity, [{ path: 'status', code: 'invalid', message: 'status is not valid' }]);
  if (targetType === 'workroom' && targetId) {
    const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, targetId);
    if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
    const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.read', resource: { type: 'channel', channelId: workroom.channel_id } });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  } else {
    const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'workspace.manage', resource: { type: 'workspace' } });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'workspace.manage');
  }
  const approvals = await listFlightDeckPgTypedApprovals({ workspaceId: context.workspace.id, targetType, targetId, action, status: status ?? null, limit: parseLimit(c) });
  return c.json({ identity, approvals: approvals.map(serializeFlightDeckPgTypedApproval), next_cursor: null });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/workrooms/:workroomId/approvals', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const action = String(body.action || 'production_merge').trim();
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (action !== 'production_merge') fields.push({ path: 'action', code: 'invalid', message: 'only production_merge approvals are supported for workrooms' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  const approvalMetadata = metadata ?? {};
  if (typeof approvalMetadata.to_branch !== 'string' || !approvalMetadata.to_branch.trim()) fields.push({ path: 'metadata.to_branch', code: 'required', message: 'metadata.to_branch is required' });
  if (typeof approvalMetadata.commit !== 'string' || !approvalMetadata.commit.trim()) fields.push({ path: 'metadata.commit', code: 'required', message: 'metadata.commit is required' });
  if (fields.length) return validationError(c, identity, fields);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.write', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');
  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const approval = await createFlightDeckPgTypedApproval({
      workspaceId: context.workspace.id,
      workroom,
      targetType: 'workroom',
      action: 'production_merge',
      title: typeof body.title === 'string' ? body.title : 'Production merge approval',
      summary: typeof body.summary === 'string' ? body.summary : null,
      requestedByActorId: context.actor.id,
      requestedByNpub: auth.userNpub,
      reviewerNpub: typeof body.reviewer_npub === 'string' ? body.reviewer_npub : null,
      metadata: { ...approvalMetadata, requested_by: auth.userNpub },
    }, sql);
    const event = await createFlightDeckPgWorkroomEvent({ workspaceId: context.workspace.id, workroom, event: { eventType: 'approval_requested', actorNpub: auth.userNpub, actorId: context.actor.id, targetType: 'approval', targetRef: approval.id, title: 'Production merge approval requested', payload: { approval_id: approval.id, action: approval.action, metadata: approval.metadata } } }, sql);
    const outbox = await createFlightDeckPgWorkroomOutboxEvent({ workspaceId: context.workspace.id, scopeId: workroom.scope_id, channelId: workroom.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.approval.requested', entityType: 'workroom_event', entityId: event.id, operation: 'created', entityRowVersion: null, payload: { workroom_id: workroom.id, approval_id: approval.id } }, sql);
    return { approval, event, outbox };
  });
  return c.json({ identity, approval: serializeFlightDeckPgTypedApproval(payload.approval), event: serializeFlightDeckPgWorkroomEvent(payload.event), outbox: payload.outbox }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/approvals/:approvalId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const approval = await resolveFlightDeckPgTypedApproval(context.workspace.id, c.req.param('approvalId'));
  if (!approval) return jsonError(c, 404, 'approval_not_found', 'Flight Deck PG approval not found', identity);
  if (approval.target_type === 'workroom') {
    const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, approval.target_id);
    if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
    const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.read', resource: { type: 'channel', channelId: workroom.channel_id } });
    if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  }
  return c.json({ identity, approval: serializeFlightDeckPgTypedApproval(approval) });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/approvals/:approvalId/decision', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const approval = await resolveFlightDeckPgTypedApproval(context.workspace.id, c.req.param('approvalId'));
  if (!approval) return jsonError(c, 404, 'approval_not_found', 'Flight Deck PG approval not found', identity);
  const workroom = approval.target_type === 'workroom' ? await resolveFlightDeckPgWorkroom(context.workspace.id, approval.target_id) : null;
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const status = String(body.status || '').trim() as FlightDeckPgApprovalStatus;
  const rowVersion = optionalRowVersion(body);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!typedApprovalDecisionStatuses.has(status)) fields.push({ path: 'status', code: 'invalid', message: 'status must be approved, rejected, superseded, or cancelled' });
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (fields.length) return validationError(c, identity, fields);
  const policyApprovers = Array.isArray(workroom.approval_policy?.human_approver_npubs)
    ? workroom.approval_policy.human_approver_npubs.filter((value): value is string => typeof value === 'string')
    : [];
  const participants = await listFlightDeckPgWorkroomParticipants({ workspaceId: context.workspace.id, workroomId: workroom.id });
  const participantApprover = participants.some((participant) => (
    participant.actor_npub === auth.userNpub
    && participant.role === 'human_approver'
    && participant.access_status === 'granted'
    && participant.status !== 'removed'
  ));
  if (status === 'approved' && !policyApprovers.includes(auth.userNpub) && !participantApprover) {
    return jsonError(c, 403, 'approval_approver_required', 'Actor is not an allowed human approver for this workroom', identity);
  }
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.write', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.write');
  const updated = await decideFlightDeckPgTypedApproval({ workspaceId: context.workspace.id, approvalId: approval.id, actorId: context.actor.id, actorNpub: auth.userNpub, status: status as any, decisionNote: typeof body.decision_note === 'string' ? body.decision_note : null, rowVersion });
  if (!updated) return jsonError(c, 409, 'approval_not_decidable', 'Approval is not in a decidable state or row_version is stale', identity);
  const event = await createFlightDeckPgWorkroomEvent({ workspaceId: context.workspace.id, workroom, event: { eventType: 'approval_decided', actorNpub: auth.userNpub, actorId: context.actor.id, targetType: 'approval', targetRef: updated.id, title: `Approval ${updated.status}`, payload: { approval_id: updated.id, status: updated.status } } });
  return c.json({ identity, approval: serializeFlightDeckPgTypedApproval(updated), event: serializeFlightDeckPgWorkroomEvent(event) });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/workrooms/:workroomId/production-merge/check', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const workroom = await resolveFlightDeckPgWorkroom(context.workspace.id, c.req.param('workroomId'));
  if (!workroom) return jsonError(c, 404, 'workroom_not_found', 'Flight Deck PG workroom not found', identity);
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const toBranch = String(body.to_branch || '').trim();
  const commit = String(body.commit || '').trim();
  const repo = typeof body.repo === 'string' ? body.repo.trim() : null;
  const fields: { path: string; code: string; message: string }[] = [];
  if (!toBranch) fields.push({ path: 'to_branch', code: 'required', message: 'to_branch is required' });
  if (!commit) fields.push({ path: 'commit', code: 'required', message: 'commit is required' });
  if (fields.length) return validationError(c, identity, fields);
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission: 'channel.read', resource: { type: 'channel', channelId: workroom.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'channel.read');
  const approved = await hasApprovedFlightDeckPgProductionMergeApproval({ workspaceId: context.workspace.id, workroomId: workroom.id, toBranch, commit, repo });
  if (!approved) return jsonError(c, 409, 'production_merge_approval_required', 'Production merge requires an approved matching workroom approval', identity, { approved: false });
  return c.json({ identity, approved: true });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/search', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const query = String(c.req.query('q') || '').trim();
  const scopeId = String(c.req.query('scope_id') || '').trim() || null;
  const mode = String(c.req.query('mode') || (scopeId ? 'subtree' : 'workspace')).trim();
  const rawLimit = Number(c.req.query('limit') || 5);
  const fields: { path: string; code: string; message: string }[] = [];
  if (query.length < 2) fields.push({ path: 'q', code: 'too_short', message: 'q must contain at least two characters' });
  if (!['subtree', 'outside_subtree', 'workspace'].includes(mode)) fields.push({ path: 'mode', code: 'invalid', message: 'mode must be subtree, outside_subtree, or workspace' });
  if ((mode === 'subtree' || mode === 'outside_subtree') && !scopeId) fields.push({ path: 'scope_id', code: 'required', message: 'scope_id is required for scoped search modes' });
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 5) fields.push({ path: 'limit', code: 'invalid', message: 'limit must be an integer from 1 to 5' });
  if (fields.length) return validationError(c, identity, fields);

  const results = await searchVisibleFlightDeckPgRecords({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    groupIds: context.groupIds,
    query,
    scopeId,
    mode: mode as 'subtree' | 'outside_subtree' | 'workspace',
    limit: rawLimit,
  });
  return c.json({
    identity,
    query,
    scope_id: scopeId,
    mode,
    results: results.map((item) => ({
      ...item,
      updated_at: item.updated_at instanceof Date ? item.updated_at.toISOString() : item.updated_at,
    })),
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/resource-view-states', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const resourceTypeRaw = c.req.query('resource_type')?.trim() || null;
  if (resourceTypeRaw && !['thread', 'task', 'document'].includes(resourceTypeRaw)) {
    return validationError(c, identity, [{ path: 'resource_type', code: 'invalid', message: 'resource_type must be thread, task, or document' }]);
  }
  const cursor = decodeFlightDeckPgResourceViewStateCursor(c.req.query('cursor'));
  if (!cursor) return validationError(c, identity, [{ path: 'cursor', code: 'invalid', message: 'cursor must be a valid resource view-state cursor' }]);
  const limit = parseLimit(c);
  const payload = await listVisibleFlightDeckPgResourceViewStates({
    workspaceId: context.workspace.id,
    actorId: context.actor.id,
    groupIds: context.groupIds,
    resourceType: resourceTypeRaw as FlightDeckPgResourceViewStateType | null,
    channelId: c.req.query('channel_id')?.trim() || null,
    after: c.req.query('cursor') ? cursor : null,
    limit: limit + 1,
  });
  const hasMore = payload.states.length > limit;
  const states = payload.states.slice(0, limit);
  return c.json({
    identity,
    states: states.map(serializeFlightDeckPgResourceViewState),
    baseline_created: payload.baselineCreated,
    next_cursor: hasMore && states.length ? encodeFlightDeckPgResourceViewStateCursor(states.at(-1)!) : null,
  });
});

flightDeckPgRouter.put('/workspaces/:workspaceId/resource-view-states/:resourceType/:resourceId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const resourceType = c.req.param('resourceType') as FlightDeckPgResourceViewStateType;
  if (!['thread', 'task', 'document'].includes(resourceType)) return jsonError(c, 404, 'resource_not_found', 'View-state resource not found', identity);
  const resource = await resolveFlightDeckPgResourceActivity(context.workspace.id, resourceType, c.req.param('resourceId'));
  if (!resource) return jsonError(c, 404, 'resource_not_found', 'View-state resource not found', identity);
  const permission = resourceType === 'thread' ? 'channel.read' : resourceType === 'task' ? 'task.read' : 'doc.read';
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission, resource: { type: 'channel', channelId: resource.channel_id } });
  if (!decision.allowed) return authorizationError(c, decision, identity, permission);
  if (resourceType === 'thread' && context.actor.kind !== 'human' && !(await isFlightDeckPgThreadParticipant({ workspaceId: context.workspace.id, threadId: resource.resource_id, actorId: context.actor.id, actorNpub: auth.userNpub }))) {
    return jsonError(c, 403, 'thread_participation_required', 'Bot must participate in the thread to update its view state', identity);
  }
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const requested = Number(body.viewed_activity_version);
  if (!Number.isSafeInteger(requested) || requested < 0) return validationError(c, identity, [{ path: 'viewed_activity_version', code: 'invalid', message: 'viewed_activity_version must be a non-negative safe integer' }]);
  if (requested > Number(resource.activity_version)) return jsonError(c, 409, 'activity_version_ahead', 'viewed_activity_version cannot exceed the resource activity_version', identity, { activity_version: Number(resource.activity_version) });
  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const marked = await markFlightDeckPgResourceViewed({ workspaceId: context.workspace.id, actorId: context.actor.id, resource, viewedActivityVersion: requested }, sql);
    const outbox = marked.changed ? await createFlightDeckPgResourceViewStateOutboxEvent({ workspaceId: context.workspace.id, actorId: context.actor.id, state: marked.state, activityVersion: Number(resource.activity_version) }, sql) : null;
    return { ...marked, outbox };
  });
  return c.json({ identity, state: serializeFlightDeckPgResourceViewState({ ...payload.state, activity_version: resource.activity_version }), changed: payload.changed, outbox: payload.outbox });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/resource-view-states/mark-viewed', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const resourcesInput = Array.isArray(body.resources) ? body.resources : null;
  if (!resourcesInput || resourcesInput.length === 0 || resourcesInput.length > 500) return validationError(c, identity, [{ path: 'resources', code: 'invalid', message: 'resources must contain 1 to 500 explicit resources' }]);
  const resources: Array<NonNullable<Awaited<ReturnType<typeof resolveFlightDeckPgResourceActivity>>>> = [];
  for (const [index, item] of resourcesInput.entries()) {
    const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const resourceType = String(value.resource_type || '') as FlightDeckPgResourceViewStateType;
    const resourceId = String(value.resource_id || '').trim();
    if (!['thread', 'task', 'document'].includes(resourceType) || !resourceId) return validationError(c, identity, [{ path: `resources.${index}`, code: 'invalid', message: 'each resource needs resource_type and resource_id' }]);
    const resource = await resolveFlightDeckPgResourceActivity(context.workspace.id, resourceType, resourceId);
    if (!resource) return jsonError(c, 404, 'resource_not_found', 'A requested view-state resource was not found', identity, { index, resource_type: resourceType, resource_id: resourceId });
    const permission = resourceType === 'thread' ? 'channel.read' : resourceType === 'task' ? 'task.read' : 'doc.read';
    const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission, resource: { type: 'channel', channelId: resource.channel_id } });
    if (!decision.allowed) return authorizationError(c, decision, identity, permission);
    if (resourceType === 'thread' && context.actor.kind !== 'human' && !(await isFlightDeckPgThreadParticipant({ workspaceId: context.workspace.id, threadId: resourceId, actorId: context.actor.id, actorNpub: auth.userNpub }))) return jsonError(c, 403, 'thread_participation_required', 'Bot must participate in every requested thread', identity);
    resources.push(resource);
  }
  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const states = [];
    const outbox = [];
    for (const resource of resources) {
      const marked = await markFlightDeckPgResourceViewed({ workspaceId: context.workspace.id, actorId: context.actor.id, resource, viewedActivityVersion: Number(resource.activity_version) }, sql);
      states.push({ ...marked.state, activity_version: resource.activity_version });
      if (marked.changed) outbox.push(await createFlightDeckPgResourceViewStateOutboxEvent({ workspaceId: context.workspace.id, actorId: context.actor.id, state: marked.state, activityVersion: Number(resource.activity_version) }, sql));
    }
    return { states, outbox };
  });
  return c.json({ identity, states: payload.states.map(serializeFlightDeckPgResourceViewState), changed_count: payload.outbox.length, outbox: payload.outbox });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/channels/:channelId/tasks', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.read',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.read');

  const tasks = await listFlightDeckPgChannelTasks({
    workspaceId: context.workspace.id,
    channelId,
    limit: parseLimit(c),
  });
  const tasksWithAssignments = await withFlightDeckPgTaskAssignments(context.workspace.id, tasks);
  return c.json({
    identity,
    channel_id: channelId,
    tasks: tasksWithAssignments.map(serializeFlightDeckPgTask),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/channels/:channelId/tasks', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const channelId = c.req.param('channelId');

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const title = String(body.title || '').trim();
  const state = String(body.state || 'new').trim() as FlightDeckPgTaskState;
  const priority = String(body.priority || 'sand').trim() as FlightDeckPgTaskPriority;
  const metadata = optionalObject(body.metadata);
  const taskMetadata = taskMetadataFromBody(body, metadata ?? undefined);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!title) fields.push({ path: 'title', code: 'required', message: 'title must be a non-empty string' });
  if (!taskStates.has(state)) fields.push({ path: 'state', code: 'invalid', message: 'state is not a valid task state' });
  if (!taskPriorities.has(priority)) fields.push({ path: 'priority', code: 'invalid', message: 'priority is not a valid task priority' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.create',
    resource: { type: 'channel', channelId },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.create');

  const channel = await resolveFlightDeckPgChannel(context.workspace.id, channelId);
  if (!channel) return jsonError(c, 404, 'channel_not_found', 'Flight Deck PG channel not found', identity);

  const mentionSource = body.mentions !== undefined ? body.mentions : metadata?.mentions;
  const canonicalMentions = await canonicalTaskMentions({ value: mentionSource, path: body.mentions !== undefined ? 'mentions' : 'metadata.mentions', workspaceId: context.workspace.id, appNpub: context.workspace.app_npub, channelId });
  if (canonicalMentions.errors.length) return validationError(c, identity, canonicalMentions.errors);
  const canonicalTaskMetadata = { ...(taskMetadata ?? {}), ...(mentionSource !== undefined ? { mentions: canonicalMentions.mentions } : {}) };

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const task = await createFlightDeckPgTask({
      workspaceId: context.workspace.id,
      channel,
      title,
      description: typeof body.description === 'string' ? body.description : null,
      state,
      priority,
      threadId: typeof body.thread_id === 'string' ? body.thread_id : null,
      metadata: canonicalTaskMetadata,
      actorId: context.actor.id,
    }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'task.create',
      resourceType: 'task',
      resourceId: task.id,
      metadata: { channel_id: channel.id, scope_id: channel.scope_id },
    }, sql);
    const outbox = await createFlightDeckPgTaskOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: task.scope_id,
      channelId: task.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.task.created',
      entityType: 'task',
      entityId: task.id,
      operation: 'created',
      entityRowVersion: task.row_version,
      payload: { task_id: task.id, task: serializeFlightDeckPgTask(task), mentions: canonicalMentions.mentions, author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
    }, sql);
    return { task, auditId, outbox };
  });

  return c.json({
    identity,
    task: serializeFlightDeckPgTask(payload.task),
    audit: { event_id: payload.auditId, operation: 'task.create', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  }, 201);
});

flightDeckPgRouter.get('/workspaces/:workspaceId/scopes/:scopeId/tasks', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;

  const tasks = await listVisibleFlightDeckPgScopeTasks({
    workspaceId: context.workspace.id,
    scopeId: c.req.param('scopeId'),
    actorId: context.actor.id,
    groupIds: context.groupIds,
    limit: parseLimit(c),
  });
  const tasksWithAssignments = await withFlightDeckPgTaskAssignments(context.workspace.id, tasks);
  return c.json({
    identity,
    scope_id: c.req.param('scopeId'),
    tasks: tasksWithAssignments.map(serializeFlightDeckPgTask),
    next_cursor: null,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/tasks/:taskId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const task = await resolveFlightDeckPgTask(context.workspace.id, c.req.param('taskId'));
  if (!task) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.read',
    resource: { type: 'channel', channelId: task.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.read');

  const [taskWithAssignments] = await withFlightDeckPgTaskAssignments(context.workspace.id, [task]);
  return c.json({ identity, task: serializeFlightDeckPgTask(taskWithAssignments) });
});

flightDeckPgRouter.patch('/workspaces/:workspaceId/tasks/:taskId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const taskId = c.req.param('taskId');
  const existing = await resolveFlightDeckPgTask(context.workspace.id, taskId);
  if (!existing) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);

  const rowVersion = optionalRowVersion(body);
  const priority = body.priority === undefined ? undefined : String(body.priority).trim() as FlightDeckPgTaskPriority;
  const metadata = optionalObject(body.metadata);
  const taskMetadata = taskMetadataFromBody(body, metadata ?? undefined);
  const fields: { path: string; code: string; message: string }[] = [];
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (body.title !== undefined && !String(body.title).trim()) fields.push({ path: 'title', code: 'invalid', message: 'title must be non-empty when provided' });
  if (priority !== undefined && !taskPriorities.has(priority)) fields.push({ path: 'priority', code: 'invalid', message: 'priority is not a valid task priority' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.update',
    resource: { type: 'channel', channelId: existing.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.update');
  const qualifyingTaskUpdate = body.title !== undefined || body.description !== undefined || body.priority !== undefined;

  const mentionSource = body.mentions !== undefined ? body.mentions : metadata?.mentions;
  const effectiveMentionSource = mentionSource === undefined ? existing.metadata?.mentions : mentionSource;
  const canonicalMentions = await canonicalTaskMentions({ value: effectiveMentionSource, path: body.mentions !== undefined ? 'mentions' : 'metadata.mentions', workspaceId: context.workspace.id, appNpub: context.workspace.app_npub, channelId: existing.channel_id });
  if (canonicalMentions.errors.length) return validationError(c, identity, canonicalMentions.errors);
  const previousMentions = Array.isArray(existing.metadata?.mentions) ? existing.metadata.mentions : [];
  const canonicalTaskMetadata = taskMetadata === undefined && mentionSource === undefined
    ? undefined
    : { ...(taskMetadata ?? existing.metadata ?? {}), mentions: canonicalMentions.mentions };

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const task = await updateFlightDeckPgTask({
      workspaceId: context.workspace.id,
      taskId,
      actorId: context.actor.id,
      rowVersion: null,
      patch: {
        title: body.title === undefined ? undefined : String(body.title).trim(),
        description: body.description === undefined ? undefined : (body.description === null ? null : String(body.description)),
        priority,
        metadata: canonicalTaskMetadata,
      },
    }, sql);
    if (!task) return null;
    const activity = qualifyingTaskUpdate ? await advanceFlightDeckPgResourceActivity({ workspaceId: context.workspace.id, actorId: context.actor.id, resourceType: 'task', resourceId: task.id }, sql) : null;
    if (activity) task.activity_version = activity.resource.activity_version;
    const viewStateOutbox = activity ? await createFlightDeckPgResourceViewStateOutboxEvent({ workspaceId: context.workspace.id, actorId: context.actor.id, state: activity.state, activityVersion: Number(activity.resource.activity_version) }, sql) : null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'task.update',
      resourceType: 'task',
      resourceId: task.id,
      metadata: { row_version: task.row_version },
    }, sql);
    const outbox = await createFlightDeckPgTaskOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: task.scope_id,
      channelId: task.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.task.updated',
      entityType: 'task',
      entityId: task.id,
      operation: 'updated',
      entityRowVersion: task.row_version,
      payload: { task_id: task.id, task: serializeFlightDeckPgTask(task), mentions: { previous: previousMentions, current: canonicalMentions.mentions }, activity_version: Number(task.activity_version), author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
    }, sql);
    return { task, auditId, outbox, viewStateOutbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Task row_version is stale', identity);

  return c.json({
    identity,
    task: serializeFlightDeckPgTask(payload.task),
    audit: { event_id: payload.auditId, operation: 'task.update', actor_npub: auth.userNpub },
    outbox: payload.outbox,
    ...(payload.viewStateOutbox ? { view_state_outbox: payload.viewStateOutbox } : {}),
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/tasks/:taskId/move', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const taskId = c.req.param('taskId');
  const existing = await resolveFlightDeckPgTask(context.workspace.id, taskId);
  if (!existing) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const destinationChannelId = String(body.destination_channel_id || '').trim();
  const destinationScopeId = body.destination_scope_id === undefined ? '' : String(body.destination_scope_id || '').trim();
  const rowVersion = optionalRowVersion(body);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!destinationChannelId) fields.push({ path: 'destination_channel_id', code: 'required', message: 'destination_channel_id is required' });
  else if (!isUuid(destinationChannelId)) fields.push({ path: 'destination_channel_id', code: 'invalid', message: 'destination_channel_id must be a UUID' });
  if (body.destination_scope_id !== undefined && (!destinationScopeId || !isUuid(destinationScopeId))) fields.push({ path: 'destination_scope_id', code: 'invalid', message: 'destination_scope_id must be a UUID when provided' });
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (fields.length) return validationError(c, identity, fields);
  if (destinationChannelId === existing.channel_id) return jsonError(c, 409, 'same_destination', 'Task is already in the destination channel', identity);

  const destinationChannel = await resolveFlightDeckPgChannel(context.workspace.id, destinationChannelId);
  if (!destinationChannel) return jsonError(c, 404, 'destination_channel_not_found', 'Destination channel was not found in this workspace', identity);
  if (destinationScopeId && destinationChannel.scope_id !== destinationScopeId) {
    return jsonError(c, 400, 'destination_scope_mismatch', 'Destination channel does not belong to destination_scope_id', identity);
  }

  for (const [permission, channelId] of [['task.read', existing.channel_id], ['task.update', existing.channel_id], ['channel.read', destinationChannel.id], ['task.create', destinationChannel.id]] as const) {
    const decision = await authorizeFlightDeckPgOperation({ actorNpub: auth.userNpub, appNpub: context.workspace.app_npub, workspaceId: context.workspace.id, permission, resource: { type: 'channel', channelId } });
    if (!decision.allowed) return authorizationError(c, decision, identity, permission);
  }

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const task = await moveFlightDeckPgTask({ workspaceId: context.workspace.id, taskId, destinationChannel, actorId: context.actor.id, rowVersion }, sql);
    if (!task) return null;
    const activity = await advanceFlightDeckPgResourceActivity({ workspaceId: context.workspace.id, actorId: context.actor.id, resourceType: 'task', resourceId: task.id }, sql);
    task.activity_version = activity.resource.activity_version;
    const movement = { from: { scope_id: existing.scope_id, channel_id: existing.channel_id }, to: { scope_id: task.scope_id, channel_id: task.channel_id } };
    const auditId = await writeFlightDeckPgAudit({ workspaceId: context.workspace.id, actorId: context.actor.id, action: 'task.move', resourceType: 'task', resourceId: task.id, metadata: { ...movement, row_version: task.row_version } }, sql);
    const eventAuthor = { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub };
    const sourceOutbox = await createFlightDeckPgTaskOutboxEvent({ workspaceId: context.workspace.id, scopeId: existing.scope_id, channelId: existing.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.task.moved', entityType: 'task', entityId: task.id, operation: 'updated', entityRowVersion: task.row_version, payload: { task_id: task.id, movement, location_role: 'source', author: eventAuthor } }, sql);
    const destinationOutbox = await createFlightDeckPgTaskOutboxEvent({ workspaceId: context.workspace.id, scopeId: task.scope_id, channelId: task.channel_id, actorId: context.actor.id, eventType: 'flightdeck_pg.task.moved', entityType: 'task', entityId: task.id, operation: 'updated', entityRowVersion: task.row_version, payload: { task_id: task.id, task: serializeFlightDeckPgTask(task), movement, location_role: 'destination', activity_version: Number(task.activity_version), author: eventAuthor } }, sql);
    return { task, auditId, sourceOutbox, destinationOutbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Task row_version is stale', identity);
  const [taskWithAssignments] = await withFlightDeckPgTaskAssignments(context.workspace.id, [payload.task]);
  return c.json({ identity, task: serializeFlightDeckPgTask(taskWithAssignments), movement: { from: { scope_id: existing.scope_id, channel_id: existing.channel_id }, to: { scope_id: payload.task.scope_id, channel_id: payload.task.channel_id } }, audit: { event_id: payload.auditId, operation: 'task.move', actor_npub: auth.userNpub }, outbox: { source: payload.sourceOutbox, destination: payload.destinationOutbox } });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/tasks/:taskId/state', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const taskId = c.req.param('taskId');
  const existing = await resolveFlightDeckPgTask(context.workspace.id, taskId);
  if (!existing) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const state = String(body.state || '').trim() as FlightDeckPgTaskState;
  const rowVersion = optionalRowVersion(body);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!taskStates.has(state)) fields.push({ path: 'state', code: 'invalid', message: 'state is not a valid task state' });
  if (Number.isNaN(rowVersion)) fields.push({ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.update',
    resource: { type: 'channel', channelId: existing.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.update');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const task = await updateFlightDeckPgTaskState({
      workspaceId: context.workspace.id,
      taskId,
      actorId: context.actor.id,
      state,
      rowVersion: null,
    }, sql);
    if (!task) return null;
    const activity = await advanceFlightDeckPgResourceActivity({ workspaceId: context.workspace.id, actorId: context.actor.id, resourceType: 'task', resourceId: task.id }, sql);
    task.activity_version = activity.resource.activity_version;
    const viewStateOutbox = await createFlightDeckPgResourceViewStateOutboxEvent({ workspaceId: context.workspace.id, actorId: context.actor.id, state: activity.state, activityVersion: Number(activity.resource.activity_version) }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'task.state',
      resourceType: 'task',
      resourceId: task.id,
      metadata: { state, row_version: task.row_version },
    }, sql);
    const outbox = await createFlightDeckPgTaskOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: task.scope_id,
      channelId: task.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.task.updated',
      entityType: 'task',
      entityId: task.id,
      operation: 'updated',
      entityRowVersion: task.row_version,
      payload: { task_id: task.id, state, activity_version: Number(task.activity_version) },
    }, sql);
    return { task, auditId, outbox, viewStateOutbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Task row_version is stale', identity);

  return c.json({
    identity,
    task: serializeFlightDeckPgTask(payload.task),
    audit: { event_id: payload.auditId, operation: 'task.state', actor_npub: auth.userNpub },
    outbox: payload.outbox,
    view_state_outbox: payload.viewStateOutbox,
  });
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/tasks/:taskId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const taskId = c.req.param('taskId');
  const existing = await resolveFlightDeckPgTask(context.workspace.id, taskId);
  if (!existing) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);
  const rowVersion = optionalRowVersion({ row_version: c.req.query('row_version') });
  if (Number.isNaN(rowVersion)) return validationError(c, identity, [{ path: 'row_version', code: 'invalid', message: 'row_version must be a positive integer' }]);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.update',
    resource: { type: 'channel', channelId: existing.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.update');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const task = await deleteFlightDeckPgTask({
      workspaceId: context.workspace.id,
      taskId,
      actorId: context.actor.id,
      rowVersion,
    }, sql);
    if (!task) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'task.delete',
      resourceType: 'task',
      resourceId: task.id,
      metadata: { channel_id: task.channel_id, scope_id: task.scope_id, row_version: task.row_version },
    }, sql);
    const outbox = await createFlightDeckPgTaskOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: task.scope_id,
      channelId: task.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.task.deleted',
      entityType: 'task',
      entityId: task.id,
      operation: 'deleted',
      entityRowVersion: task.row_version,
      payload: { task_id: task.id },
    }, sql);
    return { task, auditId, outbox };
  });
  if (!payload) return jsonError(c, 409, 'stale_row_version', 'Task row_version is stale', identity);

  return c.json({
    identity,
    task: serializeFlightDeckPgTask(payload.task),
    audit: { event_id: payload.auditId, operation: 'task.delete', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});

flightDeckPgRouter.get('/workspaces/:workspaceId/tasks/:taskId/comments', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const task = await resolveFlightDeckPgTask(context.workspace.id, c.req.param('taskId'));
  if (!task) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.read',
    resource: { type: 'channel', channelId: task.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.read');

  const comments = await listFlightDeckPgTaskComments({
    workspaceId: context.workspace.id,
    taskId: task.id,
    limit: parseLimit(c),
  });
  return c.json({
    identity,
    task_id: task.id,
    comments: comments.map(serializeFlightDeckPgTaskComment),
    next_cursor: null,
  });
});

flightDeckPgRouter.post('/workspaces/:workspaceId/tasks/:taskId/comments', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const task = await resolveFlightDeckPgTask(context.workspace.id, c.req.param('taskId'));
  if (!task) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const commentBody = String(body.body || '').trim();
  const metadata = optionalObject(body.metadata);
  const fields: { path: string; code: string; message: string }[] = [];
  if (!commentBody) fields.push({ path: 'body', code: 'required', message: 'body must be a non-empty string' });
  if (metadata === null) fields.push({ path: 'metadata', code: 'invalid', message: 'metadata must be an object when provided' });
  if (fields.length) return validationError(c, identity, fields);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.comment',
    resource: { type: 'channel', channelId: task.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.comment');

  const mentionSource = body.mentions !== undefined ? body.mentions : metadata?.mentions;
  const canonicalMentions = await canonicalTaskMentions({ value: mentionSource, path: body.mentions !== undefined ? 'mentions' : 'metadata.mentions', workspaceId: context.workspace.id, appNpub: context.workspace.app_npub, channelId: task.channel_id });
  if (canonicalMentions.errors.length) return validationError(c, identity, canonicalMentions.errors);
  const commentMetadata = { ...(metadata ?? {}), ...(mentionSource !== undefined ? { mentions: canonicalMentions.mentions } : {}) };

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const comment = await createFlightDeckPgTaskComment({
      workspaceId: context.workspace.id,
      task,
      body: commentBody,
      threadId: typeof body.thread_id === 'string' ? body.thread_id : null,
      metadata: commentMetadata,
      actorId: context.actor.id,
    }, sql);
    const activity = await advanceFlightDeckPgResourceActivity({ workspaceId: context.workspace.id, actorId: context.actor.id, resourceType: 'task', resourceId: task.id }, sql);
    const viewStateOutbox = await createFlightDeckPgResourceViewStateOutboxEvent({ workspaceId: context.workspace.id, actorId: context.actor.id, state: activity.state, activityVersion: Number(activity.resource.activity_version) }, sql);
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'task_comment.create',
      resourceType: 'task_comment',
      resourceId: comment.id,
      metadata: { task_id: task.id },
    }, sql);
    const outbox = await createFlightDeckPgTaskOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: comment.scope_id,
      channelId: comment.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.task_comment.created',
      entityType: 'task_comment',
      entityId: comment.id,
      operation: 'created',
      entityRowVersion: comment.row_version,
      payload: { task_id: task.id, comment_id: comment.id, comment: serializeFlightDeckPgTaskComment(Object.assign(comment, { created_by_actor_npub: auth.userNpub })), mentions: canonicalMentions.mentions, activity_version: Number(activity.resource.activity_version), author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
    }, sql);
    return { comment, auditId, outbox, activityVersion: Number(activity.resource.activity_version), viewStateOutbox };
  });
  await evaluateFlightDeckPgNotificationOutboxEvent(payload.outbox.id).catch(() => undefined);

  return c.json({
    identity,
    comment: serializeFlightDeckPgTaskComment(Object.assign(payload.comment, { created_by_actor_npub: auth.userNpub })),
    audit: { event_id: payload.auditId, operation: 'task_comment.create', actor_npub: auth.userNpub },
    outbox: payload.outbox,
    activity_version: payload.activityVersion,
    view_state_outbox: payload.viewStateOutbox,
  }, 201);
});

flightDeckPgRouter.post('/workspaces/:workspaceId/tasks/:taskId/assignments', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const task = await resolveFlightDeckPgTask(context.workspace.id, c.req.param('taskId'));
  if (!task) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);

  const body = await readJsonBody(c);
  if (!body) return validationError(c, identity, [{ path: 'body', code: 'invalid_json', message: 'body must be valid JSON' }]);
  const actorId = String(body.actor_id || '').trim();
  if (!actorId) return validationError(c, identity, [{ path: 'actor_id', code: 'required', message: 'actor_id must be a non-empty UUID string' }]);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.update',
    resource: { type: 'channel', channelId: task.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.update');

  try {
    const payload = await getDb().begin(async (tx) => {
      const sql = asDbClient(tx);
      const assignmentResult = await assignFlightDeckPgTask({
        workspaceId: context.workspace.id,
        task,
        actorId: context.actor.id,
        assigneeActorId: actorId,
      }, sql);
      const assignment = assignmentResult.assignment;
      if (!assignmentResult.changed) {
        return { assignment, auditId: null, outbox: null, changed: false };
      }
      const auditId = await writeFlightDeckPgAudit({
        workspaceId: context.workspace.id,
        actorId: context.actor.id,
        action: 'task_assignment.create',
        resourceType: 'task_assignment',
        resourceId: task.id,
        metadata: { task_id: task.id, actor_id: actorId },
      }, sql);
      const outbox = await createFlightDeckPgTaskOutboxEvent({
        workspaceId: context.workspace.id,
        scopeId: task.scope_id,
        channelId: task.channel_id,
        actorId: context.actor.id,
        eventType: 'flightdeck_pg.task_assignment.assigned',
        entityType: 'task_assignment',
        entityId: task.id,
        operation: 'assigned',
        entityRowVersion: assignment.row_version,
        payload: { task_id: task.id, actor_id: actorId, assignee: { actor_id: actorId, actor_npub: assignment.actor_npub ?? null }, transition: { previous: 'absent', current: 'present' }, assignment: serializeFlightDeckPgTaskAssignment(assignment), author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
      }, sql);
      return { assignment, auditId, outbox, changed: true };
    });
    if (payload.outbox) await evaluateFlightDeckPgNotificationOutboxEvent(payload.outbox.id).catch(() => undefined);

    return c.json({
      identity,
      assignment: serializeFlightDeckPgTaskAssignment(payload.assignment),
      changed: payload.changed,
      audit: payload.auditId ? { event_id: payload.auditId, operation: 'task_assignment.create', actor_npub: auth.userNpub } : null,
      outbox: payload.outbox,
    }, payload.changed ? 201 : 200);
  } catch (error) {
    return jsonError(c, 400, 'validation_error', error instanceof Error ? error.message : 'Task assignment could not be created', identity);
  }
});

flightDeckPgRouter.delete('/workspaces/:workspaceId/tasks/:taskId/assignments/:actorId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const result = await requireFlightDeckPgContext(c, auth.userNpub);
  if ('response' in result) return result.response;
  const { context, identity } = result;
  const task = await resolveFlightDeckPgTask(context.workspace.id, c.req.param('taskId'));
  if (!task) return jsonError(c, 404, 'task_not_found', 'Flight Deck PG task not found', identity);

  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: auth.userNpub,
    appNpub: context.workspace.app_npub,
    workspaceId: context.workspace.id,
    permission: 'task.update',
    resource: { type: 'channel', channelId: task.channel_id },
  });
  if (!decision.allowed) return authorizationError(c, decision, identity, 'task.update');

  const payload = await getDb().begin(async (tx) => {
    const sql = asDbClient(tx);
    const assignment = await unassignFlightDeckPgTask({
      workspaceId: context.workspace.id,
      task,
      actorId: context.actor.id,
      assigneeActorId: c.req.param('actorId'),
    }, sql);
    if (!assignment) return null;
    const auditId = await writeFlightDeckPgAudit({
      workspaceId: context.workspace.id,
      actorId: context.actor.id,
      action: 'task_assignment.delete',
      resourceType: 'task_assignment',
      resourceId: task.id,
      metadata: { task_id: task.id, actor_id: c.req.param('actorId') },
    }, sql);
    const outbox = await createFlightDeckPgTaskOutboxEvent({
      workspaceId: context.workspace.id,
      scopeId: task.scope_id,
      channelId: task.channel_id,
      actorId: context.actor.id,
      eventType: 'flightdeck_pg.task_assignment.unassigned',
      entityType: 'task_assignment',
      entityId: task.id,
      operation: 'unassigned',
      entityRowVersion: assignment.row_version,
      payload: { task_id: task.id, actor_id: c.req.param('actorId'), assignee: { actor_id: assignment.actor_id, actor_npub: assignment.actor_npub ?? null }, transition: { previous: 'present', current: 'absent' }, assignment: serializeFlightDeckPgTaskAssignment(assignment), author: { actor_id: context.actor.id, actor_npub: auth.userNpub, signer_npub: auth.signerNpub } },
    }, sql);
    return { assignment, auditId, outbox };
  });
  if (!payload) return jsonError(c, 404, 'assignment_not_found', 'Flight Deck PG task assignment not found', identity);

  return c.json({
    identity,
    assignment: serializeFlightDeckPgTaskAssignment(payload.assignment),
    audit: { event_id: payload.auditId, operation: 'task_assignment.delete', actor_npub: auth.userNpub },
    outbox: payload.outbox,
  });
});
