// ---- Groups ----

export interface V4Group {
  id: string;
  owner_npub: string;
  name: string;
  group_npub: string;
  group_kind: string;
  private_member_npub: string | null;
  created_at: Date;
}

export interface V4GroupEpoch {
  id: string;
  group_id: string;
  epoch: number;
  group_npub: string;
  created_by_npub: string;
  created_at: Date;
  superseded_at: Date | null;
}

export interface V4Workspace {
  id: string;
  workspace_owner_npub: string;
  creator_npub: string;
  name: string;
  slug: string;
  description: string;
  avatar_url: string | null;
  wrapped_workspace_nsec: string;
  wrapped_by_npub: string;
  default_group_id: string | null;
  admin_group_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export type BillingMode = 'disabled' | 'metered';
export type BillingState = 'active' | 'low_balance' | 'read_only_grace' | 'delete_eligible' | 'suspended' | 'disabled';

export interface WorkspaceCreditAccount {
  workspace_owner_npub: string;
  balance_credits: string;
  low_balance_threshold_credits: string;
  billing_state: Exclude<BillingState, 'disabled'>;
  depleted_at: Date | null;
  delete_eligible_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceCreditTransaction {
  id: string;
  workspace_owner_npub: string;
  type: string;
  amount_credits: string;
  balance_before_credits: string;
  balance_after_credits: string;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface WorkspaceCreditOrder {
  id: string;
  workspace_owner_npub: string;
  requested_by_npub: string;
  mginx_order_id: string;
  product_id: string;
  quantity_credits: string;
  amount_sats: number;
  bolt11: string;
  status: 'pending' | 'paid' | 'expired' | 'cancelled';
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}

export interface WorkspaceUsageHourlyAudit {
  id: string;
  workspace_owner_npub: string;
  hour_start: Date;
  record_bytes: number;
  object_bytes: number;
  billable_bytes: number;
  billable_mb: string;
  credits_charged: string;
  balance_after_credits: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface WorkspaceApp {
  id: string;
  workspace_owner_npub: string;
  app_npub: string;
  app_name: string;
  enabled: boolean;
  capabilities: string[];
  created_by_npub: string;
  updated_at: Date;
  created_at: Date;
}

export interface WorkspaceAppSchemaFamily {
  record_family_hash: string;
  collection_space?: string;
  schema_version: number;
  schema_hash?: string;
  title?: string;
  summary?: string;
}

export interface WorkspaceAppSchemaManifest {
  id: string;
  workspace_owner_npub: string;
  app_npub: string;
  schema_hash: string;
  schema_version: number;
  record_families: WorkspaceAppSchemaFamily[];
  owner_ciphertext: string;
  created_by_npub: string;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceAppSchemaGroupPayload {
  id: string;
  manifest_id: string;
  group_id: string | null;
  group_epoch: number | null;
  group_npub: string;
  ciphertext: string;
  can_write: boolean;
}

export interface WorkspaceAppSchemaResponse {
  id: string;
  workspace_owner_npub: string;
  app_npub: string;
  app_name: string;
  schema_hash: string;
  schema_version: number;
  record_families: WorkspaceAppSchemaFamily[];
  owner_payload: { ciphertext: string };
  group_payloads: {
    group_id?: string;
    group_epoch?: number;
    group_npub: string;
    ciphertext: string;
    write: boolean;
  }[];
  created_by_npub: string;
  created_at: string;
  updated_at: string;
}

export interface WappDbNamespace {
  id: string;
  workspace_owner_npub: string;
  app_npub: string;
  schema_name: string;
  app_slug: string;
  provisioned_by_npub: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface WappDbNamespaceDescriptor {
  workspace_owner_npub: string;
  app_npub: string;
  schema_name: string;
  capabilities: {
    migrations: boolean;
    crud: boolean;
    query: boolean;
    public_app_data: boolean;
  };
  limits: {
    max_tables: number;
    max_columns_per_table: number;
    max_query_limit: number;
    statement_timeout_ms: number;
  };
}

// ---- WApp-to-Flight-Deck publishing v1 ----

/** Stable Flight Deck role label: `wapp_management`; canonical API permission: `wapp.manage`. */
export type WappManagementPermission = 'wapp.manage';
export interface WappManagementFilters {
  installation_ids: string[];
  app_ids: string[];
  scope_ids: string[];
  channel_ids: string[];
  capabilities: ('activity.publish')[];
  open_origins: string[];
  autopilot_origins: string[];
}
export type WappInstallIntentStatus = 'pending' | 'claimed' | 'active' | 'failed' | 'revoked' | 'uninstalled' | 'reconciliation_required';

export type WappPublishingGrantStatus = 'active' | 'disabled' | 'revoked';
export type WappActivityProjectionState = 'active' | 'resolved' | 'withdrawn';
export type WappActivityProjectionPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface WappPublishingDestination {
  scope_id: string;
  scope_name?: string;
  channel_id: string;
  channel_name?: string;
  available?: boolean;
}

export interface WappPublishingGrantContract {
  grant_id: string;
  app_id: string;
  wapp_installation_id: string;
  publisher_npub: string;
  flightdeck_app_npub: string;
  owner_npub: string;
  display_name: string;
  publisher_key_version: number;
  workspace_id: string;
  grant_version: number;
  status: WappPublishingGrantStatus;
  capabilities: ['activity.publish'];
  destinations: WappPublishingDestination[];
  registered_open_origins: string[];
  disable_open_links: boolean;
  approved_by_npub: string;
  last_published_at: string | null;
  last_rejected_at: string | null;
  last_rejection_code: string | null;
  disabled_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WappActivityPublishRequest {
  external_id: string;
  version: number;
  scope_id: string;
  channel_id: string;
  category: string;
  title: string;
  summary?: string;
  occurred_at: string;
  priority?: WappActivityProjectionPriority;
  state?: WappActivityProjectionState;
  open_url?: string | null;
}

export interface WappActivityProjectionContract extends WappActivityPublishRequest {
  id: string;
  app_id: string;
  wapp_installation_id: string;
  publisher_npub: string;
  display_name: string;
  workspace_id: string;
  priority: WappActivityProjectionPriority;
  state: WappActivityProjectionState;
  open_url: string | null;
  source_status: WappPublishingGrantStatus;
  open_url_allowed: boolean;
  read_at: string | null;
  dismissed_at: string | null;
  unread: boolean;
  muted: boolean;
  created_at: string;
  updated_at: string;
}

export interface WappDbMigrationInput {
  version: string;
  checksum: string;
  sql: string;
}

export interface RunWappDbMigrationsInput {
  migrations: WappDbMigrationInput[];
}

export interface WappDbMigrationRecord {
  version: string;
  checksum: string;
  applied_at: Date;
}

export interface CreateWappDbTableRowInput {
  id?: string;
  data: Record<string, unknown>;
}

export interface UpdateWappDbTableRowInput {
  set: Record<string, unknown>;
}

export interface QueryWappDbTableRowsInput {
  select?: string[];
  where?: Record<string, Record<string, unknown>>;
  order?: { field: string; dir?: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export interface WorkspaceAppNamespaceDescriptor {
  type: 'wingman_workspace_locator';
  version: 1;
  installed: boolean;
  enabled: boolean;
  app_npub: string;
  app_name: string | null;
  tower_base_url: string;
  tower_service_npub: string | null;
  service_npub: string | null;
  workspace_service_npub: string;
  workspace_owner_npub: string;
  workspace_id: string | null;
  schema_version: number | null;
  schema_hash: string | null;
  capabilities: string[];
  created_at: number | null;
}

export type FlightDeckPgNotificationCategory = 'chat_thread' | 'mention' | 'dm' | 'comment_tag' | 'task_assignment';

export interface FlightDeckPgNotificationPreferences {
  workspace_id: string;
  actor_id: string;
  chat_threads_enabled: boolean;
  mentions_enabled: boolean;
  dms_enabled: boolean;
  comment_tags_enabled: boolean;
  task_assignments_enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface FlightDeckPgPushSubscriptionDevice {
  id: string;
  actor_id: string;
  endpoint: string;
  device_label: string | null;
  platform: string | null;
  user_agent: string | null;
  app_version: string | null;
  last_seen_workspace_id: string | null;
  status: 'active' | 'revoked' | 'stale' | 'failed';
  failure_count: number;
  last_success_at: Date | string | null;
  last_failure_at: Date | string | null;
  revoked_at: Date | string | null;
  stale_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface FlightDeckPgNotificationDeliveryEvidence {
  id: string;
  workspace_id: string;
  outbox_event_id: string;
  recipient_actor_id: string;
  subscription_id: string | null;
  category: FlightDeckPgNotificationCategory;
  source_entity_type: string;
  source_entity_id: string | null;
  decision: 'queued' | 'sent' | 'skipped' | 'failed';
  title: string;
  body: string;
  payload: Record<string, unknown>;
  provider_status: number | null;
  provider_response: string | null;
  failure_reason: string | null;
  created_at: Date | string;
  delivered_at: Date | string | null;
}

export const flightDeckPgContractNames = [
  'flightdeck_pg.service_metadata',
  'flightdeck_pg.workspace_descriptor',
  'flightdeck_pg.me',
  'flightdeck_pg.scopes.list',
  'flightdeck_pg.scopes.create',
  'flightdeck_pg.channels.list',
  'flightdeck_pg.channels.create',
  'flightdeck_pg.channel_threads.list',
  'flightdeck_pg.channel_threads.create',
  'flightdeck_pg.channel_messages.list',
  'flightdeck_pg.channel_messages.create',
  'flightdeck_pg.channel_docs.list',
  'flightdeck_pg.channel_docs.create',
  'flightdeck_pg.docs.read',
  'flightdeck_pg.docs.body.read',
  'flightdeck_pg.channel_files.list',
  'flightdeck_pg.channel_files.create',
  'flightdeck_pg.files.read',
  'flightdeck_pg.files.object.read',
  'flightdeck_pg.files.delete',
  'flightdeck_pg.file_folders.delete',
  'flightdeck_pg.files.versions.list',
  'flightdeck_pg.files.versions.create',
  'flightdeck_pg.drive.tree',
  'flightdeck_pg.drive.delta',
  'flightdeck_pg.channel_audio_notes.list',
  'flightdeck_pg.channel_audio_notes.create',
  'flightdeck_pg.audio_notes.read',
  'flightdeck_pg.audio_notes.media.read',
  'flightdeck_pg.reactions.list',
  'flightdeck_pg.reactions.create',
  'flightdeck_pg.reactions.delete',
  'flightdeck_pg.channel_grants.list',
  'flightdeck_pg.channel_grants.create',
  'flightdeck_pg.events.list',
  'flightdeck_pg.auth_error',
  'flightdeck_pg.permission_denied',
  'flightdeck_pg.validation_error',
] as const;

export type FlightDeckPgContractName = typeof flightDeckPgContractNames[number];

export const flightDeckPgContractFixturePaths: Record<FlightDeckPgContractName, string> = {
  'flightdeck_pg.service_metadata': 'fixtures/flightdeck-pg/service-metadata.json',
  'flightdeck_pg.workspace_descriptor': 'fixtures/flightdeck-pg/workspace-descriptor.json',
  'flightdeck_pg.me': 'fixtures/flightdeck-pg/me.json',
  'flightdeck_pg.scopes.list': 'fixtures/flightdeck-pg/scopes-list.json',
  'flightdeck_pg.scopes.create': 'fixtures/flightdeck-pg/scopes-create.json',
  'flightdeck_pg.channels.list': 'fixtures/flightdeck-pg/channels-list.json',
  'flightdeck_pg.channels.create': 'fixtures/flightdeck-pg/channels-create.json',
  'flightdeck_pg.channel_threads.list': 'fixtures/flightdeck-pg/channel-threads-list.json',
  'flightdeck_pg.channel_threads.create': 'fixtures/flightdeck-pg/channel-threads-create.json',
  'flightdeck_pg.channel_messages.list': 'fixtures/flightdeck-pg/channel-messages-list.json',
  'flightdeck_pg.channel_messages.create': 'fixtures/flightdeck-pg/channel-messages-create.json',
  'flightdeck_pg.channel_docs.list': 'fixtures/flightdeck-pg/channel-docs-list.json',
  'flightdeck_pg.channel_docs.create': 'fixtures/flightdeck-pg/channel-docs-create.json',
  'flightdeck_pg.docs.read': 'fixtures/flightdeck-pg/docs-read.json',
  'flightdeck_pg.docs.body.read': 'fixtures/flightdeck-pg/docs-body-read.json',
  'flightdeck_pg.channel_files.list': 'fixtures/flightdeck-pg/channel-files-list.json',
  'flightdeck_pg.channel_files.create': 'fixtures/flightdeck-pg/channel-files-create.json',
  'flightdeck_pg.files.read': 'fixtures/flightdeck-pg/files-read.json',
  'flightdeck_pg.files.object.read': 'fixtures/flightdeck-pg/files-object-read.json',
  'flightdeck_pg.files.delete': 'fixtures/flightdeck-pg/files-delete.json',
  'flightdeck_pg.file_folders.delete': 'fixtures/flightdeck-pg/file-folders-delete.json',
  'flightdeck_pg.files.versions.list': 'fixtures/flightdeck-pg/files-versions-list.json',
  'flightdeck_pg.files.versions.create': 'fixtures/flightdeck-pg/files-versions-create.json',
  'flightdeck_pg.drive.tree': 'fixtures/flightdeck-pg/drive-tree.json',
  'flightdeck_pg.drive.delta': 'fixtures/flightdeck-pg/drive-delta.json',
  'flightdeck_pg.channel_audio_notes.list': 'fixtures/flightdeck-pg/channel-audio-notes-list.json',
  'flightdeck_pg.channel_audio_notes.create': 'fixtures/flightdeck-pg/channel-audio-notes-create.json',
  'flightdeck_pg.audio_notes.read': 'fixtures/flightdeck-pg/audio-notes-read.json',
  'flightdeck_pg.audio_notes.media.read': 'fixtures/flightdeck-pg/audio-notes-media-read.json',
  'flightdeck_pg.reactions.list': 'fixtures/flightdeck-pg/reactions-list.json',
  'flightdeck_pg.reactions.create': 'fixtures/flightdeck-pg/reactions-create.json',
  'flightdeck_pg.reactions.delete': 'fixtures/flightdeck-pg/reactions-delete.json',
  'flightdeck_pg.channel_grants.list': 'fixtures/flightdeck-pg/channel-grants-list.json',
  'flightdeck_pg.channel_grants.create': 'fixtures/flightdeck-pg/channel-grants-create.json',
  'flightdeck_pg.events.list': 'fixtures/flightdeck-pg/events-list.json',
  'flightdeck_pg.auth_error': 'fixtures/flightdeck-pg/auth-error.json',
  'flightdeck_pg.permission_denied': 'fixtures/flightdeck-pg/permission-denied.json',
  'flightdeck_pg.validation_error': 'fixtures/flightdeck-pg/validation-error.json',
};

export interface FlightDeckPgIdentityFields {
  tower_service_npub: string | null;
  workspace_service_npub: string | null;
  workspace_owner_npub: string | null;
  workspace_id: string | null;
  app_npub: string;
}

export interface FlightDeckPgEventSubscriptionAgentsRequest {
  agent_npubs: string[];
}

export interface FlightDeckPgEventSubscriptionAgentsResponse {
  identity: FlightDeckPgIdentityFields;
  manager_npub: string;
  agent_npubs: string[];
}

export interface FlightDeckPgMultiAgentEventAudienceEvidence {
  visible_to_agent_npubs: string[];
}

export interface FlightDeckPgContractFixture {
  contract_name: FlightDeckPgContractName;
  fixture_version: 1;
  route: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  required_nip98_actor: string;
  required_app_npub: string;
  required_permissions: string[];
  stable_identity_fields: (keyof FlightDeckPgIdentityFields)[];
  request_shape: Record<string, unknown> | null;
  response_shape: Record<string, unknown>;
  example: {
    request: Record<string, unknown> | null;
    response: Record<string, unknown>;
  };
  notes?: string;
}

export type FlightDeckPgActorKind = 'human' | 'agent' | 'app' | 'service';
export type FlightDeckPgWorkspaceRole = 'owner' | 'admin' | 'member' | 'guest' | 'agent' | 'app';

export type FlightDeckPgAgentIdentityRotationStatus = 'completed' | 'idempotent_replay';
export type FlightDeckPgAgentIdentityRotationRequest = {
  rotation_id: string;
  old_npub: string;
  new_npub: string;
  proof: {
    id: string;
    pubkey: string;
    created_at: number;
    kind: 33359;
    tags: string[][];
    content: string;
    sig: string;
  };
};
export type FlightDeckPgAgentIdentityRotationResponse = {
  status: FlightDeckPgAgentIdentityRotationStatus;
  actor_id: string;
  old_npub: string;
  new_npub: string;
  rotation_id: string;
  proof_event_id: string;
  completed_at: string;
  migration_counts: Record<string, number>;
  warnings: string[];
};
export type FlightDeckPgGroupKind = 'system' | 'workspace' | 'scope' | 'channel' | 'dm' | 'agent' | 'app' | 'custom';

export const flightDeckPgPermissions = [
  'workspace.read',
  'workspace.manage',
  'workspace.invite',
  'event_subscription.manage',
  'scope.read',
  'scope.create',
  'scope.manage',
  'channel.read',
  'channel.create',
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
  'daily_note.read',
  'daily_note.write',
] as const;

export type FlightDeckPgPermission = typeof flightDeckPgPermissions[number];
export type FlightDeckPgScopeKind = 'business_unit' | 'department' | 'project' | 'customer' | 'dm' | 'temporary' | 'custom';
export type FlightDeckPgChannelKind = 'channel' | 'dm' | 'system';
export type FlightDeckPgPrincipalType = 'actor' | 'group';
export type FlightDeckPgGrantResourceType = 'workspace' | 'scope' | 'channel';
export type FlightDeckPgTaskState = 'new' | 'ready' | 'in_progress' | 'review' | 'done' | 'archive' | 'backlog' | 'blocked' | 'archived';
export type FlightDeckPgTaskPriority = 'rock' | 'pebble' | 'sand' | 'low' | 'normal' | 'high' | 'urgent';
export type FlightDeckPgOutboxStatus = 'pending' | 'processing' | 'published' | 'failed';
export type FlightDeckPgTaskEntityType = 'task' | 'task_comment' | 'task_assignment' | 'task_watcher';
export type FlightDeckPgChatEntityType = 'message' | 'thread';
export type FlightDeckPgOutboxOperation = 'created' | 'updated' | 'deleted' | 'assigned' | 'unassigned' | 'watched' | 'unwatched';
export type FlightDeckPgInvocationStatus = 'open' | 'closed';
export type FlightDeckPgInvocationRecipientType = 'person' | 'agent';
export type FlightDeckPgInvocationRecipientStatus = 'pending' | 'done';
export type FlightDeckPgInvocationTargetType = 'document' | 'task' | 'file';
export type FlightDeckPgDocumentAgentTrigger = 'document_mention_added' | 'document_comment_mention_added' | 'full_document_review_requested';
export type FlightDeckPgStorageEntityType = 'doc' | 'file' | 'audio_note' | 'message';
export type FlightDeckPgReactionTargetType = 'message' | 'task' | 'task_comment' | 'doc' | 'file' | 'audio_note';
export type FlightDeckPgReactionEmoji = 'thumbs_up' | 'smile' | 'heart' | 'eyes' | 'party' | 'white_check_mark';
export type FlightDeckPgAudioNoteTargetType = FlightDeckPgReactionTargetType;
export type FlightDeckPgDailyNoteStatus = 'active' | 'archived';
export type FlightDeckPgPersonalWappStatus = 'active' | 'archived';
export type FlightDeckPgResponseActivityTargetType = 'chat_thread' | 'task_comment' | 'doc_comment';
export type FlightDeckPgResponseActivityStatus = 'queued' | 'thinking' | 'drafting' | 'publishing' | 'failed' | 'cleared';
export type FlightDeckPgResponseActivitySeverity = 'info' | 'warning' | 'error';
export type FlightDeckPgAgentActivityState = 'accepted' | 'working' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type FlightDeckPgWorkroomStatus =
  | 'draft'
  | 'active'
  | 'waiting_review'
  | 'waiting_approval'
  | 'integrating'
  | 'deploying'
  | 'blocked'
  | 'complete'
  | 'archived';
export type FlightDeckPgWorkroomParticipantKind = 'human' | 'agent' | 'autopilot' | 'app' | 'service';
export type FlightDeckPgWorkroomParticipantRole = 'integration' | 'contributor' | 'reviewer' | 'human_approver' | 'observer';
export type FlightDeckPgWorkroomParticipantStatus = 'invited' | 'active' | 'inactive' | 'removed';
export type FlightDeckPgWorkroomAccessStatus = 'pending' | 'granted' | 'failed' | 'not_required';
export type FlightDeckPgWorkroomEventType =
  | 'created'
  | 'started'
  | 'status_changed'
  | 'participant_invited'
  | 'access_grant_failed'
  | 'artifact_added'
  | 'link_added'
  | 'pr_opened'
  | 'pr_ready'
  | 'review_requested'
  | 'review_complete'
  | 'approval_requested'
  | 'approval_decided'
  | 'merge_started'
  | 'merge_complete'
  | 'deploy_started'
  | 'deploy_complete'
  | 'blocker_added'
  | 'blocker_cleared'
  | 'completed'
  | 'archived'
  | 'note';
export type FlightDeckPgWorkroomEventVisibility = 'room' | 'workspace' | 'private';
export type FlightDeckPgWorkroomLinkType =
  | 'pull_request'
  | 'file'
  | 'doc'
  | 'task'
  | 'artifact'
  | 'app_target'
  | 'preview_url'
  | 'production_url'
  | 'approval'
  | 'deployment'
  | 'thread'
  | 'message'
  | 'external_url';
export type FlightDeckPgApprovalTargetType = 'workroom' | (string & {});
export type FlightDeckPgApprovalAction = 'production_merge' | (string & {});
export type FlightDeckPgApprovalStatus = 'requested' | 'in_review' | 'approved' | 'rejected' | 'superseded' | 'cancelled';
export type FlightDeckPgPermissionResourceType =
  | FlightDeckPgGrantResourceType
  | 'thread'
  | 'task'
  | 'doc'
  | 'file'
  | 'daily_note'
  | 'approval'
  | 'app';

export type FlightDeckPgIsoTimestamp = string;

export interface FlightDeckPgAgentChatConfig {
  enabled: boolean;
  context_prompt: string;
  activation: 'mention_then_continue';
}

export interface FlightDeckPgAgentMention {
  type: 'agent';
  actor_id: string;
  npub: string;
  label?: string;
}

export interface FlightDeckPgMessageRevisionRequest {
  body: string;
  row_version: number;
  mentions?: Array<{ type: 'agent' | 'person'; npub: string; label?: string }>;
  metadata?: Record<string, unknown>;
  message_signature: Record<string, unknown>;
}

export interface FlightDeckPgMessageRevisionEventPayload {
  event_type: 'message.revised';
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  thread_id: string | null;
  entity_type: 'message';
  entity_id: string;
  message_id: string;
  revision: number;
  revision_idempotency_key: string;
  actor_id: string;
  actor_npub: string;
  mentions: FlightDeckPgAgentMention[];
  newly_added_mentions: FlightDeckPgAgentMention[];
  updated_at: Date;
}

export interface FlightDeckPgWorkroomRepoConfig {
  provider?: 'github' | string;
  owner?: string;
  name?: string;
  url?: string;
  [key: string]: unknown;
}

export interface FlightDeckPgWorkroomBranchConfig {
  integration?: string;
  production?: string;
  [key: string]: unknown;
}

export interface FlightDeckPgWorkroomAppTarget {
  autopilot_npub?: string;
  app_id?: string;
  label?: string;
  url_mode?: 'generated' | 'custom_domain' | 'manual' | string;
  url?: string;
  requires_human_approval?: boolean;
  [key: string]: unknown;
}

export interface FlightDeckPgWorkroomAppTargets {
  preview?: FlightDeckPgWorkroomAppTarget;
  production?: FlightDeckPgWorkroomAppTarget;
  [key: string]: unknown;
}

export interface FlightDeckPgWorkroomApprovalPolicy {
  merge_to_production_requires_human?: boolean;
  production_deploy_requires_human?: boolean;
  restart_production_requires_human?: boolean;
  human_approver_npubs?: string[];
  [key: string]: unknown;
}

export interface FlightDeckPgWorkroomArchivePolicy {
  retention?: 'keep' | string;
  [key: string]: unknown;
}

export interface FlightDeckPgProductionMergeApprovalMetadata {
  repo?: string | FlightDeckPgWorkroomRepoConfig;
  from_branch?: string;
  to_branch?: string;
  commit?: string;
  preview_url?: string;
  requested_by?: string;
  integration_autopilot_npub?: string;
  [key: string]: unknown;
}

export interface FlightDeckPgActor {
  id: string;
  npub: string;
  kind: FlightDeckPgActorKind;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface FlightDeckPgWorkspace {
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
}

export interface FlightDeckPgWorkspaceMembership {
  workspace_id: string;
  actor_id: string;
  role: FlightDeckPgWorkspaceRole;
  created_by_actor_id: string | null;
  created_at: Date;
}

export interface FlightDeckPgGroup {
  id: string;
  workspace_id: string;
  name: string;
  kind: FlightDeckPgGroupKind;
  created_by_actor_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface FlightDeckPgScope {
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
}

export interface FlightDeckPgChannel {
  id: string;
  workspace_id: string;
  scope_id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  kind: FlightDeckPgChannelKind;
  position: number | null;
  created_by_actor_id: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export interface FlightDeckPgPermissionDefinition {
  permission: string;
  resource_type: FlightDeckPgPermissionResourceType;
  description: string | null;
  created_at: Date;
}

export interface FlightDeckPgPermissionGrant {
  id: string;
  workspace_id: string;
  principal_type: FlightDeckPgPrincipalType;
  principal_actor_id: string | null;
  principal_group_id: string | null;
  resource_type: FlightDeckPgGrantResourceType;
  resource_scope_id: string | null;
  resource_channel_id: string | null;
  permission: string;
  created_by_actor_id: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

export interface FlightDeckPgTask {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  thread_id: string | null;
  title: string;
  description: string | null;
  state: FlightDeckPgTaskState;
  priority: FlightDeckPgTaskPriority;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  activity_version: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  deleted_at: Date | null;
}

export interface FlightDeckPgThread {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  source_message_id: string | null;
  title: string;
  latest: string | null;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  activity_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgMessage {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  thread_id: string | null;
  body: string;
  client_request_id: string | null;
  client_request_hash: string | null;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgMessageAttachment {
  storage_object_id: string;
  kind?: string;
  filename?: string;
  content_type?: string;
  size_bytes?: number;
  [key: string]: unknown;
}

export interface FlightDeckPgDoc {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  storage_object_id: string;
  title: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  activity_version: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  deleted_at: Date | null;
}

export type FlightDeckPgDocRecoveryReason =
  | 'base_unavailable'
  | 'stale_base'
  | 'base_version_mismatch'
  | 'base_body_mismatch'
  | 'head_body_unverifiable';

export type FlightDeckPgDocRecoveryState = 'open' | 'promoted' | 'discarded';

export interface FlightDeckPgDocVersionIdentity {
  version_id: string;
  row_version: number;
  storage_object_id: string;
  body_sha256_hex: string | null;
  size_bytes: number | null;
}

export interface FlightDeckPgDocRecoveryVersion {
  id: string;
  workspace_id: string;
  doc_id: string;
  scope_id: string;
  channel_id: string;
  storage_object_id: string;
  reason_code: FlightDeckPgDocRecoveryReason;
  base_row_version: number | null;
  base_version_id: string | null;
  base_body_sha256_hex: string | null;
  head_row_version: number;
  head_version_id: string;
  head_storage_object_id: string;
  head_body_sha256_hex: string | null;
  submitted_body_sha256_hex: string;
  submitted_patch: Record<string, unknown>;
  idempotency_key: string;
  resolution_state: FlightDeckPgDocRecoveryState;
  created_by_actor_id: string;
  created_by_signer_npub: string;
  resolved_by_actor_id: string | null;
  resolved_by_signer_npub: string | null;
  resolved_at: Date | null;
  resolution_head_row_version: number | null;
  resolution_metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export type FlightDeckPgResourceViewStateType = 'thread' | 'task' | 'document';

export interface FlightDeckPgResourceViewState {
  workspace_id: string;
  viewer_actor_id: string;
  resource_type: FlightDeckPgResourceViewStateType;
  resource_id: string;
  scope_id: string;
  channel_id: string;
  viewed_activity_version: number;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface FlightDeckPgFile {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  folder_id: string | null;
  storage_object_id: string;
  current_version_id: string | null;
  display_name: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  deleted_at: Date | null;
  deleted_by_actor_id: string | null;
}

export interface FlightDeckPgFileVersion {
  id: string;
  workspace_id: string;
  file_id: string;
  version_number: number;
  storage_object_id: string;
  base_version_id: string | null;
  operation: 'created' | 'replaced' | 'deleted' | 'restored';
  created_by_actor_id: string;
  created_at: Date;
}

export interface FlightDeckPgFileFolder {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  parent_folder_id: string | null;
  title: string;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by_actor_id: string | null;
}

export interface FlightDeckPgAudioNote {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  thread_id: string | null;
  target_type: FlightDeckPgAudioNoteTargetType | null;
  target_id: string | null;
  storage_object_id: string;
  title: string | null;
  mime_type: string;
  duration_seconds: string | number | null;
  size_bytes: string | number | null;
  media_encryption: Record<string, unknown>;
  waveform_preview: unknown[];
  transcript_preview: string | null;
  transcript: string | null;
  transcript_status: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  record_state: 'active' | 'archived';
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgDailyNote {
  id: string;
  workspace_id: string;
  owner_actor_id: string;
  scope_id: string | null;
  channel_id: string | null;
  note_date: string | Date;
  title: string;
  body: string | null;
  focus: string | null;
  items: unknown[];
  status: FlightDeckPgDailyNoteStatus;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgPersonalWapp {
  id: string;
  workspace_id: string;
  owner_actor_id: string;
  scope_id: string | null;
  channel_id: string | null;
  title: string;
  description: string | null;
  launch_url: string;
  icon_url: string | null;
  app_id: string | null;
  wapp_id: string | null;
  source_wingman_url: string | null;
  sort_order: number;
  status: FlightDeckPgPersonalWappStatus;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgTaskComment {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  task_id: string;
  thread_id: string | null;
  body: string;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgDocComment {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  doc_id: string;
  parent_comment_id: string | null;
  body: string;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgTaskAssignment {
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  task_id: string;
  actor_id: string;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgTaskWatcher extends FlightDeckPgTaskAssignment {}

export interface FlightDeckPgReaction {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  target_type: FlightDeckPgReactionTargetType;
  target_id: string;
  emoji: string;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgResponseActivity {
  id: string;
  workspace_id: string;
  scope_id: string | null;
  channel_id: string | null;
  target_type: FlightDeckPgResponseActivityTargetType;
  target_id: string;
  thread_id: string | null;
  task_id: string | null;
  doc_id: string | null;
  parent_comment_id: string | null;
  actor_id: string | null;
  actor_npub: string | null;
  activity_type: string;
  status: FlightDeckPgResponseActivityStatus;
  severity: FlightDeckPgResponseActivitySeverity;
  label: string | null;
  message: string | null;
  pipeline_run_id: string | null;
  source_message_id: string | null;
  metadata: Record<string, unknown>;
  row_version: number;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  cleared_at: Date | null;
}

export interface FlightDeckPgAgentActivity {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  thread_id: string;
  trigger_message_id: string;
  turn_id: string | null;
  session_id: string;
  activity_id: string;
  agent_npub: string;
  publisher_actor_id: string;
  state: FlightDeckPgAgentActivityState;
  label: string | null;
  summary: string | null;
  body: string | null;
  visibility: 'user_visible';
  sequence: number;
  expires_at: Date;
  terminal_at: Date | null;
  created_at: Date;
  updated_at: Date;
  commentary_history?: FlightDeckPgAgentActivityCommentary[];
}

export interface FlightDeckPgAgentActivityCommentary {
  id: string;
  workspace_id: string;
  agent_activity_id: string;
  turn_id: string;
  activity_id: string;
  state: 'working';
  label: string | null;
  summary: string | null;
  body: string | null;
  visibility: 'user_visible';
  sequence: number;
  created_at: Date;
  updated_at: Date;
}

export interface FlightDeckPgInvocationRecipient {
  type: FlightDeckPgInvocationRecipientType;
  npub: string;
  actor_id: string | null;
  status: FlightDeckPgInvocationRecipientStatus;
  metadata?: Record<string, unknown>;
}

export interface FlightDeckPgInvocationTarget {
  type: FlightDeckPgInvocationTargetType;
  id: string;
  title?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FlightDeckPgInvocation {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  created_by_actor_id: string;
  prompt: string;
  recipients: FlightDeckPgInvocationRecipient[];
  targets: FlightDeckPgInvocationTarget[];
  status: FlightDeckPgInvocationStatus;
  metadata: Record<string, unknown>;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export interface FlightDeckPgFullDocumentReviewRequest {
  scope_id: string;
  channel_id: string;
  prompt: string;
  trigger: 'full_document_review_requested';
  client_request_id: string;
  recipients: [FlightDeckPgInvocationRecipient];
  targets: [FlightDeckPgInvocationTarget];
  metadata?: Record<string, unknown>;
}

export interface FlightDeckPgWorkroom {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  thread_id: string | null;
  title: string;
  goal: string;
  status: FlightDeckPgWorkroomStatus;
  integration_autopilot_npub: string | null;
  repo: FlightDeckPgWorkroomRepoConfig;
  branches: FlightDeckPgWorkroomBranchConfig;
  app_targets: FlightDeckPgWorkroomAppTargets;
  approval_policy: FlightDeckPgWorkroomApprovalPolicy;
  archive_policy: FlightDeckPgWorkroomArchivePolicy;
  metadata: Record<string, unknown>;
  created_by_actor_id: string;
  updated_by_actor_id: string;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  archived_at: Date | null;
  deleted_at: Date | null;
}

export interface FlightDeckPgSerializedWorkroom extends Omit<FlightDeckPgWorkroom, 'created_at' | 'updated_at' | 'completed_at' | 'archived_at' | 'deleted_at'> {
  created_at: FlightDeckPgIsoTimestamp;
  updated_at: FlightDeckPgIsoTimestamp;
  completed_at: FlightDeckPgIsoTimestamp | null;
  archived_at: FlightDeckPgIsoTimestamp | null;
  deleted_at: FlightDeckPgIsoTimestamp | null;
}

export interface FlightDeckPgWorkroomParticipant {
  id: string;
  workspace_id: string;
  workroom_id: string;
  actor_npub: string;
  actor_id: string | null;
  kind: FlightDeckPgWorkroomParticipantKind;
  role: FlightDeckPgWorkroomParticipantRole;
  label: string | null;
  status: FlightDeckPgWorkroomParticipantStatus;
  access_status: FlightDeckPgWorkroomAccessStatus;
  access_issue: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface FlightDeckPgSerializedWorkroomParticipant extends Omit<FlightDeckPgWorkroomParticipant, 'created_at' | 'updated_at'> {
  created_at: FlightDeckPgIsoTimestamp;
  updated_at: FlightDeckPgIsoTimestamp;
}

export interface FlightDeckPgWorkroomEvent {
  id: string;
  workspace_id: string;
  workroom_id: string;
  scope_id: string;
  channel_id: string;
  event_type: FlightDeckPgWorkroomEventType;
  actor_npub: string | null;
  actor_id: string | null;
  target_type: string | null;
  target_ref: string | null;
  title: string | null;
  body: string | null;
  payload: Record<string, unknown>;
  visibility: FlightDeckPgWorkroomEventVisibility;
  created_at: Date;
}

export interface FlightDeckPgSerializedWorkroomEvent extends Omit<FlightDeckPgWorkroomEvent, 'created_at'> {
  created_at: FlightDeckPgIsoTimestamp;
}

export interface FlightDeckPgTypedApproval {
  id: string;
  workspace_id: string;
  scope_id: string | null;
  channel_id: string | null;
  target_type: FlightDeckPgApprovalTargetType;
  target_id: string;
  action: FlightDeckPgApprovalAction;
  status: FlightDeckPgApprovalStatus;
  title: string | null;
  summary: string | null;
  requested_by_actor_id: string;
  requested_by_npub: string;
  reviewer_actor_id: string | null;
  reviewer_npub: string | null;
  approver_actor_id: string | null;
  approver_npub: string | null;
  decision_note: string | null;
  metadata: Record<string, unknown>;
  row_version: number;
  requested_at: Date;
  reviewed_at: Date | null;
  approved_at: Date | null;
  rejected_at: Date | null;
  superseded_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface FlightDeckPgSerializedTypedApproval extends Omit<
  FlightDeckPgTypedApproval,
  | 'requested_at'
  | 'reviewed_at'
  | 'approved_at'
  | 'rejected_at'
  | 'superseded_at'
  | 'cancelled_at'
  | 'created_at'
  | 'updated_at'
> {
  requested_at: FlightDeckPgIsoTimestamp;
  reviewed_at: FlightDeckPgIsoTimestamp | null;
  approved_at: FlightDeckPgIsoTimestamp | null;
  rejected_at: FlightDeckPgIsoTimestamp | null;
  superseded_at: FlightDeckPgIsoTimestamp | null;
  cancelled_at: FlightDeckPgIsoTimestamp | null;
  created_at: FlightDeckPgIsoTimestamp;
  updated_at: FlightDeckPgIsoTimestamp;
}

export interface FlightDeckPgWorkroomLink {
  id: string;
  workspace_id: string;
  workroom_id: string;
  scope_id: string;
  channel_id: string;
  link_type: FlightDeckPgWorkroomLinkType;
  target_type: string;
  target_id: string | null;
  external_url: string | null;
  label: string | null;
  status: string | null;
  metadata: Record<string, unknown>;
  created_by_actor_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface FlightDeckPgSerializedWorkroomLink extends Omit<FlightDeckPgWorkroomLink, 'created_at' | 'updated_at'> {
  created_at: FlightDeckPgIsoTimestamp;
  updated_at: FlightDeckPgIsoTimestamp;
}

export interface FlightDeckPgStorageLink {
  id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  entity_type: FlightDeckPgStorageEntityType;
  entity_id: string | null;
  storage_object_id: string;
  metadata: Record<string, unknown>;
  created_by_actor_id: string | null;
  created_at: Date;
  deleted_at: Date | null;
}

export interface FlightDeckPgOutboxEvent {
  id: string;
  workspace_id: string;
  scope_id: string | null;
  channel_id: string | null;
  actor_id: string | null;
  event_type: string;
  entity_type: FlightDeckPgTaskEntityType | FlightDeckPgChatEntityType | string;
  entity_id: string | null;
  operation: FlightDeckPgOutboxOperation | string;
  entity_row_version: number | null;
  payload: Record<string, unknown>;
  status: FlightDeckPgOutboxStatus;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  processed_at: Date | null;
}

export type WorkspaceAppRowVisibility = 'private' | 'group' | 'workspace';

export interface WorkspaceAppRow {
  id: string;
  workspace_owner_npub: string;
  app_npub: string;
  collection: string;
  row_id: string;
  owner_npub: string;
  visibility: WorkspaceAppRowVisibility;
  group_id: string | null;
  data: unknown;
  metadata: Record<string, unknown>;
  created_by_npub: string;
  updated_by_npub: string;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceAppRowResponse {
  id: string;
  workspace_owner_npub: string;
  app_npub: string;
  collection: string;
  row_id: string;
  owner_npub: string;
  visibility: WorkspaceAppRowVisibility;
  group_id: string | null;
  data: unknown;
  metadata: Record<string, unknown>;
  created_by_npub: string;
  updated_by_npub: string;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkspaceAppRowInput {
  row_id?: string;
  owner_npub?: string;
  visibility?: WorkspaceAppRowVisibility;
  group_id?: string | null;
  data?: unknown;
  metadata?: Record<string, unknown>;
}

export interface UpdateWorkspaceAppRowInput {
  visibility?: WorkspaceAppRowVisibility;
  group_id?: string | null;
  data?: unknown;
  metadata?: Record<string, unknown>;
}

// ---- Graph Memory ----

export type GraphMemoryVisibility = 'personal' | 'agent' | 'group' | 'workspace';

export interface GraphMemoryEntityInput {
  entity_type: string;
  entity_key: string;
  display_name?: string;
  relation?: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphMemoryAclInput {
  principal_npub?: string;
  actor_npub?: string;
  group_id?: string;
  access: 'read' | 'write' | 'owner';
}

export interface CreateGraphMemoryInput {
  workspace_owner_npub?: string;
  visibility: GraphMemoryVisibility;
  owner_npub?: string;
  actor_npub?: string;
  source_app_npub?: string;
  group_id?: string;
  memory_type: string;
  title?: string | null;
  summary?: string | null;
  body_ciphertext: string;
  metadata?: Record<string, unknown>;
  entities?: GraphMemoryEntityInput[];
  acl?: GraphMemoryAclInput[];
}

export interface GraphMemory {
  id: string;
  workspace_owner_npub: string | null;
  owner_npub: string | null;
  actor_npub: string | null;
  source_app_npub: string | null;
  group_id: string | null;
  visibility: GraphMemoryVisibility;
  memory_type: string;
  title: string | null;
  summary: string | null;
  body_ciphertext: string;
  metadata: Record<string, unknown>;
  created_by_npub: string;
  updated_by_npub: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListGraphMemoriesFilters {
  workspace_owner_npub?: string;
  visibility?: GraphMemoryVisibility;
  memory_type?: string;
  owner_npub?: string;
  actor_npub?: string;
  source_app_npub?: string;
  group_id?: string;
  limit?: number;
  offset?: number;
}

// ---- Native Graph ----

export type NativeGraphVisibility = 'personal' | 'agent' | 'group';

export interface NativeGraphScopeInput {
  workspace_owner_npub?: string;
  visibility: NativeGraphVisibility;
  owner_npub?: string;
  actor_npub?: string;
  source_app_npub?: string;
  group_id?: string;
}

export interface GraphNodeInput {
  external_id: string;
  labels?: string[];
  node_type?: string;
  properties?: Record<string, unknown>;
  property_mode?: 'merge' | 'replace';
}

export interface GraphEdgeInput {
  external_id?: string;
  from_external_id: string;
  to_external_id: string;
  relationship_type: string;
  properties?: Record<string, unknown>;
  property_mode?: 'merge' | 'replace';
}

export interface GraphSchemaSnapshotInput {
  schema_kind?: string;
  schema: Record<string, unknown>;
}

export interface GraphBulkImportInput extends NativeGraphScopeInput {
  run_id: string;
  source: string;
  metadata?: Record<string, unknown>;
  schema?: GraphSchemaSnapshotInput | Record<string, unknown>;
  nodes?: GraphNodeInput[];
  edges?: GraphEdgeInput[];
}

export interface GraphBulkNodesInput extends NativeGraphScopeInput {
  run_id?: string;
  source: string;
  nodes: GraphNodeInput[];
}

export interface GraphBulkEdgesInput extends NativeGraphScopeInput {
  run_id?: string;
  source: string;
  edges: GraphEdgeInput[];
}

export type GraphRepositoryDeltaMode = 'incremental' | 'full_rebuild';

export interface GraphRepositoryDeltaInput extends NativeGraphScopeInput {
  source: string;
  corpus_id: string;
  repository_id: string;
  base_sha?: string | null;
  head_sha: string;
  schema_version: string;
  mode: GraphRepositoryDeltaMode;
  parser_metadata?: Record<string, unknown>;
  index_metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  schema?: GraphSchemaSnapshotInput | Record<string, unknown>;
  nodes?: GraphNodeInput[];
  edges?: GraphEdgeInput[];
  delete_node_external_ids?: string[];
  delete_edge_external_ids?: string[];
}

export interface NativeGraphRepositoryCheckpoint {
  source: string;
  corpus_id: string;
  repository_id: string;
  head_sha: string;
  schema_version: string;
  parser_metadata: Record<string, unknown>;
  index_metadata: Record<string, unknown>;
  updated_at: Date;
}

export interface ListNativeGraphRepositoryCheckpointsFilters {
  workspace_owner_npub?: string;
  visibility?: NativeGraphVisibility;
  owner_npub?: string;
  actor_npub?: string;
  source_app_npub?: string;
  group_id?: string;
  source: string;
  corpus_id?: string;
  repository_id?: string;
  limit?: number;
}

export interface NativeGraphNode {
  id: string;
  external_id: string;
  source: string;
  run_id: string | null;
  node_type: string | null;
  labels: string[];
  properties: Record<string, unknown>;
  workspace_owner_npub: string | null;
  owner_npub: string | null;
  actor_npub: string | null;
  source_app_npub: string | null;
  group_id: string | null;
  visibility: NativeGraphVisibility;
  created_by_npub: string;
  updated_by_npub: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NativeGraphEdge {
  id: string;
  external_id: string;
  source: string;
  run_id: string | null;
  source_node_id: string;
  target_node_id: string;
  from_external_id?: string;
  to_external_id?: string;
  relationship_type: string;
  properties: Record<string, unknown>;
  workspace_owner_npub: string | null;
  owner_npub: string | null;
  actor_npub: string | null;
  source_app_npub: string | null;
  group_id: string | null;
  visibility: NativeGraphVisibility;
  created_by_npub: string;
  updated_by_npub: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NativeGraphImportRun {
  id: string;
  run_id: string;
  source: string;
  workspace_owner_npub: string | null;
  owner_npub: string | null;
  actor_npub: string | null;
  source_app_npub: string | null;
  group_id: string | null;
  visibility: NativeGraphVisibility;
  status: 'pending' | 'running' | 'completed' | 'failed';
  nodes_upserted: number;
  edges_upserted: number;
  schema_upserted: number;
  metadata: Record<string, unknown>;
  created_by_npub: string;
  updated_by_npub: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListNativeGraphFilters {
  workspace_owner_npub?: string;
  visibility?: NativeGraphVisibility;
  owner_npub?: string;
  actor_npub?: string;
  source_app_npub?: string;
  group_id?: string;
  source?: string;
  run_id?: string;
  label?: string;
  relationship_type?: string;
  limit?: number;
  offset?: number;
}

export interface SearchNativeGraphInput {
  q: string;
  workspace_owner_npub?: string;
  visibility?: NativeGraphVisibility | GraphMemoryVisibility;
  owner_npub?: string;
  actor_npub?: string;
  source_app_npub?: string;
  group_id?: string;
  source?: string;
  label?: string;
  relationship_type?: string;
  limit?: number;
}

export type GraphSearchResult =
  | {
      kind: 'node';
      score: number;
      id: string;
      external_id: string;
      source: string;
      labels: string[];
      title: string | null;
      summary: string | null;
      properties: Record<string, unknown>;
    }
  | {
      kind: 'edge';
      score: number;
      id: string;
      external_id: string;
      source: string;
      relationship_type: string;
      from_external_id: string;
      to_external_id: string;
      summary: string;
      properties: Record<string, unknown>;
    }
  | {
      kind: 'memory';
      score: number;
      id: string;
      memory_type: string;
      title: string | null;
      summary: string | null;
      properties: Record<string, unknown>;
    };

export interface GraphSearchResponse {
  query: string;
  results: GraphSearchResult[];
  total: number;
  limit: number;
}

export interface V4GroupMember {
  id: string;
  group_id: string;
  member_npub: string;
  created_at: Date;
}

export interface V4GroupMemberKey {
  id: string;
  group_id: string;
  member_npub: string;
  wrapped_group_nsec: string;
  wrapped_by_npub: string;
  approved_by_npub: string;
  key_version: number;
  created_at: Date;
  revoked_at: Date | null;
}

export interface MemberKeyInput {
  member_npub: string;
  wrapped_group_nsec: string;
  wrapped_by_npub: string;
}

export interface CreateGroupInput {
  owner_npub: string;
  workspace_service_npub?: string;
  name: string;
  group_npub: string;
  group_kind?: string;
  private_member_npub?: string | null;
  member_keys: MemberKeyInput[];
}

export interface CreateWorkspaceInput {
  workspace_owner_npub: string;
  workspace_service_npub?: string;
  name: string;
  description?: string;
  wrapped_workspace_nsec: string;
  wrapped_by_npub: string;
  default_group_npub: string;
  default_group_name?: string;
  default_group_member_keys: MemberKeyInput[];
  admin_group_npub: string;
  admin_group_name?: string;
  admin_group_member_keys: MemberKeyInput[];
  private_group_npub: string;
  private_group_name?: string;
  private_group_member_keys: MemberKeyInput[];
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
  description?: string;
  avatar_url?: string | null;
}

export interface AddMemberInput {
  member_npub: string;
  wrapped_group_nsec: string;
  wrapped_by_npub: string;
}

export interface WrappedGroupKeyEntry {
  group_id: string;
  group_npub: string;
  epoch: number;
  name: string;
  member_npub: string;
  wrapped_group_nsec: string;
  wrapped_by_npub: string;
  approved_by_npub: string;
  key_version: number;
}

export interface UpdateGroupInput {
  name: string;
}

export interface RotateGroupEpochInput {
  group_npub: string;
  member_keys: MemberKeyInput[];
  name?: string;
}

export type AgentChatErrorCode =
  | 'workspace_access_denied'
  | 'workspace_key_missing'
  | 'workspace_key_revoked'
  | 'workspace_key_invalid'
  | 'group_membership_revoked'
  | 'group_key_missing'
  | 'group_key_epoch_stale'
  | 'record_pull_forbidden'
  | 'record_pull_not_found'
  | 'record_decrypt_failed'
  | 'sse_stream_forbidden'
  | 'sse_stream_lost'
  | 'interrupt_failed'
  | 'thread_unresolved';

export interface AgentChatErrorResponse {
  error: string;
  code: AgentChatErrorCode;
  status: number;
  reason_code?: AgentChatErrorCode;
  workspace_owner_npub?: string | null;
  workspace_service_npub?: string | null;
  user_npub?: string | null;
  signer_npub?: string | null;
  actor_npub?: string | null;
  ws_key_npub?: string | null;
  workspace_user_key_npub?: string | null;
  details?: Record<string, unknown>;
}

export interface WorkspaceListEntry {
  workspace_id: string;
  workspace_owner_npub: string;
  creator_npub: string;
  name: string;
  slug: string;
  description: string;
  avatar_url: string | null;
  default_group_id: string | null;
  default_group_npub: string | null;
  admin_group_id: string | null;
  admin_group_npub: string | null;
  private_group_id: string | null;
  private_group_npub: string | null;
  wrapped_workspace_nsec: string | null;
  wrapped_by_npub: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface V4StorageObject {
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
  storage_path: string;
  created_at: Date;
  completed_at: Date | null;
}

export interface PrepareStorageInput {
  owner_npub: string;
  owner_group_id?: string | null;
  access_group_ids?: string[] | null;
  is_public?: boolean;
  metadata?: Record<string, unknown> | null;
  content_type: string;
  size_bytes?: number | null;
  file_name?: string | null;
}

export interface CompleteStorageInput {
  sha256_hex?: string | null;
  size_bytes?: number | null;
}

// ---- User Profiles ----

export interface UserProfile {
  user_npub: string;
  display_name: string | null;
  avatar_url: string | null;
  credit_balance: number;
  created_at: Date;
}

// ---- User Workspace Keys ----

export interface UserWorkspaceKey {
  user_npub: string;
  workspace_owner_npub: string;
  ws_key_npub: string;
  ws_key_epoch: number;
  active: boolean;
  device_label: string | null;
  device_platform: string | null;
  device_policy: Record<string, unknown>;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  registered_at: Date;
}

export interface RegisterWorkspaceKeyInput {
  workspace_owner_npub: string;
  workspace_service_npub?: string;
  ws_key_npub: string;
  workspace_user_key_npub?: string;
  label?: string;
  device_label?: string;
  platform?: string;
  device_platform?: string;
  policy?: Record<string, unknown>;
  device_policy?: Record<string, unknown>;
}

export interface RotateWorkspaceKeyInput {
  workspace_owner_npub: string;
  workspace_service_npub?: string;
  new_ws_key_npub: string;
  new_workspace_user_key_npub?: string;
  old_ws_key_npub: string;
  old_workspace_user_key_npub?: string;
}

export interface WorkspaceKeyEntry {
  user_npub: string;
  workspace_owner_npub: string;
  workspace_service_npub?: string;
  ws_key_npub: string;
  workspace_user_key_npub?: string;
  ws_key_epoch: number;
  active: boolean;
  device_label?: string | null;
  device_platform?: string | null;
  device_policy?: Record<string, unknown>;
  last_seen_at?: Date | null;
  revoked_at?: Date | null;
  registered_at?: Date;
}

// ---- Tower Profile ----

export interface TowerProfile {
  tower_name: string | null;
  tower_description: string | null;
  updated_at: Date | null;
}

export interface UpdateTowerProfileInput {
  tower_name?: string | null;
  tower_description?: string | null;
}

// ---- Records ----

/**
 * Encrypted group payload for a single record version.
 * Each entry delivers the record content encrypted for a specific group epoch.
 *
 * - group_id: stable group UUID (preferred, resolved by Tower)
 * - group_epoch: integer epoch of the group key used for encryption
 * - group_npub: rotating Nostr pubkey of the group at that epoch
 * - ciphertext: NIP-44 encrypted inner payload (opaque to Tower)
 * - write: whether this group can update the record
 */
export interface GroupPayloadInput {
  group_id?: string;
  group_epoch?: number;
  group_npub: string;
  ciphertext: string;
  write: boolean;
}

/**
 * Inbound record for sync.
 *
 * - signature_npub: the NIP-98 signer — may be a workspace session key,
 *   not necessarily the user's real npub. Tower resolves it to the real
 *   user identity for ownership and membership checks.
 * - write_group_id: stable UUID of the group authorizing a non-owner write
 *   (preferred over write_group_npub).
 * - write_group_npub: rotating npub of the write group (legacy compatibility
 *   only; rejected when strict_group_id_writes is enabled).
 * - owner_payload: encrypted by the workspace session key (or real user
 *   key as fallback).
 * - group_payloads: per-group encrypted delivery, each encrypted with the
 *   group's current epoch key.
 */
export interface SyncRecordInput {
  record_id: string;
  owner_npub: string;
  workspace_service_npub?: string;
  user_npub?: string;
  ws_key_npub?: string;
  workspace_user_key_npub?: string;
  record_family_hash: string;
  version: number;
  previous_version: number;
  signature_npub: string;
  write_group_id?: string;
  write_group_npub?: string;
  force_write?: boolean;
  checkout?: {
    checkout_id: string;
    consume_on_success?: boolean;
  };
  owner_payload: { ciphertext: string };
  group_payloads?: GroupPayloadInput[];
}

export interface SyncRequestBody {
  owner_npub?: string;
  workspace_service_npub?: string;
  user_npub?: string;
  actor_npub?: string;
  viewer_npub?: string;
  signer_npub?: string;
  ws_key_npub?: string;
  workspace_user_key_npub?: string;
  strict_group_id_writes?: boolean;
  records: SyncRecordInput[];
  group_write_tokens?: Record<string, string>;
}

export interface V4Record {
  id: string;
  record_id: string;
  owner_npub: string;
  record_family_hash: string;
  version: number;
  previous_version: number;
  signature_npub: string;
  owner_ciphertext: string;
  created_at: Date;
  updated_at: Date;
}

export interface V4RecordGroupPayload {
  id: string;
  record_row_id: string;
  group_id: string | null;
  group_epoch: number | null;
  group_npub: string;
  ciphertext: string;
  can_write: boolean;
}

export interface RecordResponse {
  record_id: string;
  owner_npub: string;
  record_family_hash: string;
  version: number;
  previous_version: number;
  signature_npub: string;
  owner_payload: { ciphertext: string };
  group_payloads: {
    group_id?: string;
    group_epoch?: number;
    group_npub: string;
    ciphertext: string;
    write: boolean;
  }[];
  updated_at: string;
}

export interface V4RecordCheckout {
  checkout_id: string;
  workspace_service_npub: string;
  record_id: string;
  record_family_hash: string;
  idempotency_key: string | null;
  checked_out_by_user_npub: string;
  checked_out_by_workspace_user_key_npub: string | null;
  checked_out_at: Date;
  lease_expires_at: Date;
  state: 'checked_in' | 'checked_out' | 'expired';
  released_at: Date | null;
}

export interface RecordCheckoutState {
  checkout_id: string;
  state: 'checked_in' | 'checked_out';
  checked_out_by_user_npub?: string;
  checked_out_by_workspace_user_key_npub?: string | null;
  checked_out_at?: string;
  lease_expires_at?: string;
}

export interface AcquireRecordCheckoutInput {
  workspace_service_npub: string;
  user_npub: string;
  workspace_user_key_npub: string;
  record_id: string;
  record_family_hash: string;
  lease_seconds?: number;
  idempotency_key?: string;
}

export interface ReleaseRecordCheckoutInput {
  workspace_service_npub: string;
  user_npub: string;
  workspace_user_key_npub: string;
  record_id: string;
  record_family_hash: string;
  checkout_id: string;
}

export interface RenewRecordCheckoutInput extends ReleaseRecordCheckoutInput {
  lease_seconds?: number;
}

export interface RecordCheckoutResponse {
  record_id: string;
  record_family_hash: string;
  checkout: RecordCheckoutState;
}

export interface FetchRecordsInput {
  owner_npub: string;
  viewer_npub?: string;
  record_family_hash: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface RecordsAuditInfo {
  workspace_owner_npub: string;
  workspace_service_npub: string;
  signer_npub: string;
  user_npub: string;
  viewer_npub: string;
  actor_npub: string;
  ws_key_npub: string | null;
  workspace_user_key_npub: string | null;
}

export interface PaginatedRecordsResponse {
  audit: RecordsAuditInfo;
  records: RecordResponse[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface PaginatedRecordsResult {
  records: RecordResponse[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface FetchRecordsSummaryInput {
  owner_npub: string;
  viewer_npub?: string;
  record_family_hash?: string;
  since?: string;
}

export interface RecordFamilySummary {
  record_family_hash: string;
  latest_updated_at: string;
  latest_record_count: number;
  count_since: number | null;
}

export interface SyncRejectedRecord {
  error: string;
  code: string;
  status: number;
  record_id: string;
  record_family_hash: string;
  workspace_service_npub: string;
  user_npub: string;
  workspace_user_key_npub: string | null;
  tower_latest_version?: number;
  required_previous_version?: number;
  received_previous_version?: number;
  checkout?: RecordCheckoutState;
  reason?: string;
}

export interface RecordsSummaryResponse {
  audit: RecordsAuditInfo;
  families: RecordFamilySummary[];
}

export interface SyncResult {
  synced: number;
  created: number;
  updated: number;
  rejected: SyncRejectedRecord[];
  warnings: {
    code: 'legacy_write_group_npub';
    message: string;
    record_id: string;
    field: 'write_group_npub';
    write_group_id?: string | null;
    write_group_npub: string;
  }[];
}

export interface HeartbeatRequestBody {
  owner_npub?: string;
  workspace_service_npub?: string;
  ws_key_npub?: string;
  workspace_user_key_npub?: string;
  viewer_npub?: string;
  family_cursors: Record<string, string | null>;
}

export interface HeartbeatResponse {
  audit: RecordsAuditInfo;
  stale_families: string[];
  server_cursors: Record<string, string>;
}

export interface HeartbeatCheckResult {
  stale_families: string[];
  server_cursors: Record<string, string>;
}

export interface RecordHistoryResponse {
  audit: RecordsAuditInfo;
  versions: RecordResponse[];
}

// Tower Git authority v1. These permissions and resources are deliberately
// separate from Flight Deck channel grants.
export const gitRepositoryPermissions = [
  'git.repo.read',
  'git.repo.write',
  'git.branch.create',
  'git.repo.admin',
] as const;

export const gitInternalPermissions = [
  'git.capability.introspect',
  'git.capability.revoke',
] as const;

export const gitCapabilityScopes = [
  'git.fetch',
  'git.push.unprotected',
  'git.push.branch_create',
] as const;

export type GitRepositoryPermission = typeof gitRepositoryPermissions[number];
export type GitInternalPermission = typeof gitInternalPermissions[number];
export type GitCapabilityScope = typeof gitCapabilityScopes[number];
export type GitPermission = GitRepositoryPermission | GitInternalPermission;
export type GitResourceType = 'git-workspace' | 'git-repository' | 'git-capability';
export type GitService = 'upload-pack' | 'receive-pack';
export type GitPrincipalType = 'actor' | 'group';

export interface GitRepository {
  repository_id: string;
  workspace_id: string;
  git_namespace: string;
  git_path: string;
  scope_id: string | null;
  slug: string;
  display_name: string;
  description: string;
  visibility: 'private';
  default_branch: 'main';
  state: 'registered' | 'provisioning' | 'active' | 'archived';
  policy_revision: number;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
}

export interface GitIssueAuthor {
  username: string;
  display_name: string | null;
}

export interface GitIssueLabel {
  name: string;
  color: string | null;
}

export interface GitIssue {
  issue_number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  url: string;
  author: GitIssueAuthor;
  labels: GitIssueLabel[];
  comment_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface GitIssueComment {
  comment_id: number;
  issue_number: number;
  body: string;
  url: string;
  author: GitIssueAuthor;
  created_at: string;
  updated_at: string;
}

export interface CreateGitIssueRequest {
  title: string;
  body?: string;
  correlation_id?: string;
}

export interface CreateGitIssueCommentRequest {
  body: string;
  correlation_id?: string;
}

export interface CreateGitRepositoryRequest {
  slug: string;
  display_name: string;
  description?: string;
  scope_id?: string | null;
}

export interface ClaimGitWorkspaceNamespaceRequest {
  namespace: string;
}

export interface GitWorkspaceNamespace {
  workspace_id: string;
  namespace: string;
  locked: boolean;
  created_at: string;
  updated_at: string;
}

export interface GitBranchPolicy {
  policy_id: string;
  ref_name: string;
  branch_class: 'main' | 'staging' | 'deployed' | 'work';
  protected: boolean;
  service_managed: boolean;
  allow_direct_push: boolean;
  allow_force_push: boolean;
  allow_delete: boolean;
  required_approvals: number;
  required_checks: string[];
  merge_methods: Array<'squash' | 'merge' | 'rebase'>;
}

export interface GitRepositoryPolicy {
  repository_id: string;
  policy_revision: number;
  branch_rules: GitBranchPolicy[];
}

export interface UpdateGitRepositoryPolicyRequest {
  expected_policy_revision: number;
  branch_rules: Array<Omit<GitBranchPolicy, 'policy_id'>>;
}

export interface GitRepositoryGrant {
  grant_id: string;
  repository_id: string;
  principal_type: GitPrincipalType;
  principal_actor_id: string | null;
  principal_group_id: string | null;
  permission: GitRepositoryPermission;
  ref_constraints: { prefixes: string[] };
  created_by_actor_id: string;
  created_at: string;
  revoked_by_actor_id: string | null;
  revoked_at: string | null;
}

export interface CreateGitRepositoryGrantRequest {
  principal_type: GitPrincipalType;
  principal_id: string;
  permission: GitRepositoryPermission;
  ref_constraints?: { prefixes?: string[] };
}

export interface GitCredentialExchangeRequest {
  repository_id: string;
  actor_id: string;
  audience: string;
  service: GitService;
  requested_scopes: GitCapabilityScope[];
  autopilot_instance_npub?: string;
  session_id?: string;
  task_id?: string;
  workroom_id?: string;
  correlation_id?: string;
}

export interface GitCredentialExchangeResponse {
  capability_id: string;
  username: 'nostr';
  capability: string;
  repository_id: string;
  actor_id: string;
  signer_npub: string;
  audience: string;
  service: GitService;
  scopes: GitCapabilityScope[];
  policy_revision: number;
  expires_at: string;
}

export interface GitCapabilityIntrospectionRequest {
  capability: string;
  repository_id: string;
  audience: string;
  service: GitService;
  required_scope: GitCapabilityScope;
  correlation_id?: string;
}

export interface GitCapabilityIntrospectionResponse {
  active: boolean;
  reason_code: string;
  capability_id?: string;
  repository_id?: string;
  actor_id?: string;
  actor_username?: string;
  actor_display_name?: string;
  signer_npub?: string;
  audience?: string;
  service?: GitService;
  scopes?: GitCapabilityScope[];
  ref_constraints?: { prefixes: string[] };
  policy_revision?: number;
  expires_at?: string;
}

export interface UpdateGitActorUsernameRequest {
  username: string;
}

export interface GitActorUsername {
  actor_id: string;
  username: string;
  applied_username: string;
  state: 'pending' | 'ready' | 'error';
  last_error_code: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface GitForgejoRepositoryBinding {
  repository_id: string;
  workspace_id: string;
  forgejo_owner: string;
  forgejo_repository: string;
  desired_policy_revision: number;
  applied_policy_revision: number | null;
  state: 'pending' | 'ready' | 'error';
  reconciled_at: string | null;
}

export interface GitForgejoWorkspaceBinding {
  workspace_id: string;
  forgejo_owner: string;
  state: 'pending' | 'ready' | 'error';
  reconciled_at: string | null;
}

export interface GitForgejoOrganizationActorAccess {
  actor_id: string;
  username: string;
  organization_role: 'owner' | 'member';
}

export interface GitForgejoOrganizationDesiredState extends GitForgejoWorkspaceBinding {
  display_name: string;
  actor_access: GitForgejoOrganizationActorAccess[];
  managed_usernames: string[];
}

export interface GitForgejoActorAccess {
  actor_id: string;
  shadow_username: string;
  display_name: string | null;
  permission: 'read' | 'write' | 'admin';
  organization_role: 'owner' | 'member';
}

export interface GitForgejoBrowserRepositoryAccess {
  repository_id: string;
  workspace_id: string;
  forgejo_owner: string;
  forgejo_repository: string;
  permission: 'read' | 'write' | 'admin';
}

export interface GitForgejoBrowserActorValidation {
  active: boolean;
  reason_code: string;
  actor_id?: string;
  actor_npub?: string;
  actor_username?: string;
  actor_display_name?: string;
  signer_npub?: string;
  organizations?: Array<{ workspace_id: string; forgejo_owner: string; organization_role: 'owner' | 'member' }>;
  repositories?: GitForgejoBrowserRepositoryAccess[];
}

export interface GitForgejoDesiredState extends GitForgejoRepositoryBinding {
  display_name: string;
  description: string;
  private: true;
  default_branch: 'main';
  branch_rules: GitBranchPolicy[];
  actor_access: GitForgejoActorAccess[];
}

export interface GitForgejoWebhookEvidence {
  event_id: string;
  delivery_id: string;
  event_type: string;
  repository_id: string;
  actor_shadow_username: string | null;
  ref_name: string | null;
  old_sha: string | null;
  new_sha: string | null;
  forced: boolean;
  created: boolean;
  deleted: boolean;
  occurred_at: string;
}

export interface RevokeGitCapabilityRequest {
  capability_id: string;
  repository_id: string;
  audience: string;
  reason: string;
  correlation_id?: string;
}

export interface GitAuditEvent {
  event_id: string;
  source: 'tower' | 'wingman-git' | 'forgejo';
  workspace_id: string | null;
  repository_id: string | null;
  actor_id: string | null;
  actor_npub: string | null;
  signer_npub: string | null;
  operation: string;
  requested_scope: string | null;
  service: GitService | null;
  decision: 'allow' | 'deny';
  reason_code: string;
  policy_revision: number | null;
  capability_hash_prefix: string | null;
  autopilot_instance_npub: string | null;
  session_id: string | null;
  task_id: string | null;
  workroom_id: string | null;
  correlation_id: string | null;
  occurred_at: string;
}
