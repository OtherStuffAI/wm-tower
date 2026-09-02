import { getDb } from '../db';
import { getEffectiveFlightDeckPgGroupIds, getFlightDeckPgWorkspaceMembership, resolveFlightDeckPgActorByNpub } from './flightdeck-pg-authorization';
import webpush, { type SendResult } from 'web-push';
import { effectiveFlightDeckPgThreadTitle } from './flightdeck-pg-thread-titles';

type DbClient = ReturnType<typeof getDb>;
type DbJsonValue = Parameters<DbClient['json']>[0];

function asDbJson(value: unknown): DbJsonValue {
  return value as DbJsonValue;
}

export type FlightDeckPgNotificationCategory = 'chat_thread' | 'mention' | 'dm' | 'comment_tag' | 'task_assignment';

export type FlightDeckPgMention = {
  type: string;
  id: string;
  label: string | null;
};

export type FlightDeckPgNotificationPreferenceRow = {
  workspace_id: string;
  actor_id: string;
  chat_threads_enabled: boolean;
  mentions_enabled: boolean;
  dms_enabled: boolean;
  comment_tags_enabled: boolean;
  task_assignments_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export type FlightDeckPgPushSubscriptionRow = {
  id: string;
  actor_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string | null;
  platform: string | null;
  user_agent: string | null;
  app_version: string | null;
  last_seen_workspace_id: string | null;
  status: 'active' | 'revoked' | 'stale' | 'failed';
  failure_count: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  revoked_at: Date | null;
  stale_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type OutboxEventRow = {
  id: string;
  workspace_id: string;
  scope_id: string | null;
  channel_id: string | null;
  actor_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  operation: string;
  payload: Record<string, unknown>;
};

type ActorRow = {
  id: string;
  npub: string;
  display_name: string | null;
};

type NotificationCandidate = {
  category: FlightDeckPgNotificationCategory;
  actorId: string;
  body: string;
  route: string;
  target: Record<string, unknown>;
};

export function getFlightDeckPgVapidPublicKey() {
  return (Bun.env.FLIGHTDECK_WEB_PUSH_VAPID_PUBLIC_KEY || Bun.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim() || null;
}

function getPushDeliveryConfig() {
  const publicKey = getFlightDeckPgVapidPublicKey();
  const privateKey = (Bun.env.FLIGHTDECK_WEB_PUSH_VAPID_PRIVATE_KEY || Bun.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim();
  const subject = (Bun.env.FLIGHTDECK_WEB_PUSH_SUBJECT || Bun.env.WEB_PUSH_SUBJECT || '').trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export function extractFlightDeckMentions(text: string): FlightDeckPgMention[] {
  const mentions: FlightDeckPgMention[] = [];
  const pattern = /@\[([^\]]+)\]\(mention:([a-zA-Z_][a-zA-Z0-9_-]*):([^)]+)\)/g;
  for (const match of text.matchAll(pattern)) {
    const rawType = (match[2] || '').toLowerCase();
    mentions.push({
      label: match[1] || null,
      type: rawType === 'doc' ? 'document' : rawType,
      id: decodeURIComponent(match[3] || '').trim(),
    });
  }
  return mentions;
}

function uniqueActorCandidates(candidates: NotificationCandidate[]): NotificationCandidate[] {
  const seen = new Set<string>();
  const output: NotificationCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.category}:${candidate.actorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

function uuidOrNull(value: unknown): string | null {
  const text = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
}

export async function getFlightDeckPgNotificationPreferences(
  workspaceId: string,
  actorId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgNotificationPreferenceRow> {
  const [row] = await sql<FlightDeckPgNotificationPreferenceRow[]>`
    INSERT INTO flightdeck_pg_notification_preferences (workspace_id, actor_id)
    VALUES (${workspaceId}, ${actorId})
    ON CONFLICT (workspace_id, actor_id) DO UPDATE SET updated_at = flightdeck_pg_notification_preferences.updated_at
    RETURNING *
  `;
  return row;
}

export async function updateFlightDeckPgNotificationPreferences(
  input: {
    workspaceId: string;
    actorId: string;
    patch: Partial<Record<'chat_threads_enabled' | 'mentions_enabled' | 'dms_enabled' | 'comment_tags_enabled' | 'task_assignments_enabled', boolean>>;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgNotificationPreferenceRow> {
  const current = await getFlightDeckPgNotificationPreferences(input.workspaceId, input.actorId, sql);
  const [row] = await sql<FlightDeckPgNotificationPreferenceRow[]>`
    UPDATE flightdeck_pg_notification_preferences
    SET
      chat_threads_enabled = ${input.patch.chat_threads_enabled ?? current.chat_threads_enabled},
      mentions_enabled = ${input.patch.mentions_enabled ?? current.mentions_enabled},
      dms_enabled = ${input.patch.dms_enabled ?? current.dms_enabled},
      comment_tags_enabled = ${input.patch.comment_tags_enabled ?? current.comment_tags_enabled},
      task_assignments_enabled = ${input.patch.task_assignments_enabled ?? current.task_assignments_enabled},
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND actor_id = ${input.actorId}
    RETURNING *
  `;
  return row;
}

export async function upsertFlightDeckPgPushSubscription(
  input: {
    workspaceId: string;
    actorId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceLabel?: string | null;
    platform?: string | null;
    userAgent?: string | null;
    appVersion?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPushSubscriptionRow> {
  const [row] = await sql<FlightDeckPgPushSubscriptionRow[]>`
    INSERT INTO flightdeck_pg_push_subscriptions (
      actor_id, endpoint, p256dh, auth, device_label, platform, user_agent, app_version, last_seen_workspace_id, status, revoked_at, stale_at
    )
    VALUES (
      ${input.actorId}, ${input.endpoint}, ${input.p256dh}, ${input.auth}, ${input.deviceLabel ?? null}, ${input.platform ?? null},
      ${input.userAgent ?? null}, ${input.appVersion ?? null}, ${input.workspaceId}, 'active', NULL, NULL
    )
    ON CONFLICT (endpoint)
    DO UPDATE SET
      actor_id = EXCLUDED.actor_id,
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      device_label = COALESCE(EXCLUDED.device_label, flightdeck_pg_push_subscriptions.device_label),
      platform = COALESCE(EXCLUDED.platform, flightdeck_pg_push_subscriptions.platform),
      user_agent = COALESCE(EXCLUDED.user_agent, flightdeck_pg_push_subscriptions.user_agent),
      app_version = COALESCE(EXCLUDED.app_version, flightdeck_pg_push_subscriptions.app_version),
      last_seen_workspace_id = EXCLUDED.last_seen_workspace_id,
      status = 'active',
      revoked_at = NULL,
      stale_at = NULL,
      updated_at = NOW()
    RETURNING *
  `;
  return row;
}

export async function listFlightDeckPgPushSubscriptionsForActor(
  actorId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPushSubscriptionRow[]> {
  return sql<FlightDeckPgPushSubscriptionRow[]>`
    SELECT *
    FROM flightdeck_pg_push_subscriptions
    WHERE actor_id = ${actorId}
    ORDER BY status ASC, updated_at DESC
  `;
}

export async function revokeFlightDeckPgPushSubscription(
  input: { actorId: string; subscriptionId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgPushSubscriptionRow | null> {
  const [row] = await sql<FlightDeckPgPushSubscriptionRow[]>`
    UPDATE flightdeck_pg_push_subscriptions
    SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
    WHERE id = ${input.subscriptionId}
      AND actor_id = ${input.actorId}
    RETURNING *
  `;
  return row ?? null;
}

async function resolvePersonMentionActor(
  workspaceId: string,
  mentionId: string,
  sql: DbClient,
): Promise<ActorRow | null> {
  if (mentionId.startsWith('npub1')) {
    const actor = await resolveFlightDeckPgActorByNpub(mentionId, sql);
    if (!actor) return null;
    const membership = await getFlightDeckPgWorkspaceMembership(workspaceId, actor.id, sql);
    return membership ? actor : null;
  }
  const actorId = uuidOrNull(mentionId);
  if (!actorId) return null;
  const [actor] = await sql<ActorRow[]>`
    SELECT a.id, a.npub, a.display_name
    FROM flightdeck_pg_actors a
    JOIN flightdeck_pg_workspace_memberships wm ON wm.actor_id = a.id
    WHERE wm.workspace_id = ${workspaceId}
      AND a.id = ${actorId}
    LIMIT 1
  `;
  return actor ?? null;
}

async function canReadChannel(workspaceId: string, channelId: string, actorId: string, permission: 'channel.read' | 'doc.read' | 'task.read', sql: DbClient) {
  const groupIds = await getEffectiveFlightDeckPgGroupIds(workspaceId, actorId, sql);
  const effectiveGroupIds = groupIds.length ? groupIds : ['00000000-0000-0000-0000-000000000000'];
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT true AS ok
    FROM flightdeck_pg_permission_grants pg
    WHERE pg.workspace_id = ${workspaceId}
      AND pg.resource_type = 'channel'
      AND pg.resource_channel_id = ${channelId}
      AND pg.permission IN (${permission}, 'channel.read')
      AND pg.revoked_at IS NULL
      AND (
        (pg.principal_type = 'actor' AND pg.principal_actor_id = ${actorId})
        OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(effectiveGroupIds)})
      )
    LIMIT 1
  `;
  return Boolean(row?.ok);
}

async function listChannelRecipients(workspaceId: string, channelId: string, sql: DbClient): Promise<ActorRow[]> {
  return sql<ActorRow[]>`
    WITH RECURSIVE granted_groups(group_id) AS (
      SELECT pg.principal_group_id
      FROM flightdeck_pg_permission_grants pg
      WHERE pg.workspace_id = ${workspaceId}
        AND pg.resource_type = 'channel'
        AND pg.resource_channel_id = ${channelId}
        AND pg.permission = 'channel.read'
        AND pg.revoked_at IS NULL
        AND pg.principal_type = 'group'
        AND pg.principal_group_id IS NOT NULL
      UNION
      SELECT ge.child_group_id
      FROM flightdeck_pg_group_edges ge
      JOIN granted_groups gg ON gg.group_id = ge.parent_group_id
      WHERE ge.workspace_id = ${workspaceId}
    ),
    recipient_actors(actor_id) AS (
      SELECT pg.principal_actor_id
      FROM flightdeck_pg_permission_grants pg
      WHERE pg.workspace_id = ${workspaceId}
        AND pg.resource_type = 'channel'
        AND pg.resource_channel_id = ${channelId}
        AND pg.permission = 'channel.read'
        AND pg.revoked_at IS NULL
        AND pg.principal_type = 'actor'
        AND pg.principal_actor_id IS NOT NULL
      UNION
      SELECT gm.actor_id
      FROM flightdeck_pg_group_memberships gm
      JOIN granted_groups gg ON gg.group_id = gm.group_id
      WHERE gm.workspace_id = ${workspaceId}
    )
    SELECT DISTINCT a.id, a.npub, a.display_name
    FROM recipient_actors ra
    JOIN flightdeck_pg_actors a ON a.id = ra.actor_id
    JOIN flightdeck_pg_workspace_memberships wm ON wm.workspace_id = ${workspaceId} AND wm.actor_id = a.id
    ORDER BY a.display_name ASC NULLS LAST, a.npub ASC
  `;
}

async function buildCandidates(event: OutboxEventRow, sql: DbClient): Promise<NotificationCandidate[]> {
  const workspaceId = event.workspace_id;
  if (!event.channel_id) return [];
  const [workspace] = await sql<{ name: string }[]>`SELECT name FROM flightdeck_pg_workspaces WHERE id = ${workspaceId} LIMIT 1`;
  if (!workspace) return [];

  if (event.event_type === 'flightdeck_pg.message.created' && event.entity_id) {
    const [message] = await sql<{ id: string; body: string; thread_id: string | null; channel_id: string; created_by_actor_id: string; thread_title: string | null; source_message_body: string | null }[]>`
      SELECT m.id, m.body, m.thread_id, m.channel_id, m.created_by_actor_id, t.title AS thread_title, source.body AS source_message_body
      FROM flightdeck_pg_messages m
      LEFT JOIN flightdeck_pg_threads t ON t.workspace_id = m.workspace_id AND t.id = m.thread_id AND t.deleted_at IS NULL
      LEFT JOIN flightdeck_pg_messages source ON source.workspace_id = t.workspace_id AND source.id = t.source_message_id AND source.deleted_at IS NULL
      WHERE m.workspace_id = ${workspaceId}
        AND m.id = ${event.entity_id}
        AND m.deleted_at IS NULL
      LIMIT 1
    `;
    const [channel] = await sql<{ id: string; name: string; kind: string; participant_npubs: string[] | null }[]>`
      SELECT id, name, kind, participant_npubs
      FROM flightdeck_pg_channels
      WHERE workspace_id = ${workspaceId}
        AND id = ${event.channel_id}
      LIMIT 1
    `;
    if (!message || !channel) return [];
    const route = `/workspaces/${workspaceId}/channels/${channel.id}${message.thread_id ? `/threads/${message.thread_id}` : ''}`;
    const threadTitle = message.thread_id
      ? effectiveFlightDeckPgThreadTitle(message.thread_title, message.source_message_body)
      : channel.name;
    const candidates: NotificationCandidate[] = [];
    if (channel.kind === 'dm') {
      for (const participantNpub of stringArray(channel.participant_npubs)) {
        const actor = await resolveFlightDeckPgActorByNpub(participantNpub, sql);
        if (!actor || actor.id === message.created_by_actor_id) continue;
        const membership = await getFlightDeckPgWorkspaceMembership(workspaceId, actor.id, sql);
        if (membership) {
          candidates.push({ category: 'dm', actorId: actor.id, body: `New DM: ${threadTitle}`, route, target: { channel_id: channel.id, thread_id: message.thread_id, thread_title: threadTitle } });
        }
      }
      return uniqueActorCandidates(candidates);
    }

    for (const actor of await listChannelRecipients(workspaceId, channel.id, sql)) {
      if (actor.id === message.created_by_actor_id) continue;
      candidates.push({
        category: 'chat_thread',
        actorId: actor.id,
        body: message.thread_id ? `Thread Update: ${threadTitle}` : `Channel Update: ${channel.name}`,
        route,
        target: { channel_id: channel.id, thread_id: message.thread_id, ...(message.thread_id ? { thread_title: threadTitle } : {}) },
      });
    }
    for (const mention of extractFlightDeckMentions(message.body).filter((entry) => entry.type === 'person')) {
      const actor = await resolvePersonMentionActor(workspaceId, mention.id, sql);
      if (!actor || actor.id === message.created_by_actor_id) continue;
      if (await canReadChannel(workspaceId, channel.id, actor.id, 'channel.read', sql)) {
        candidates.push({
          category: 'mention',
          actorId: actor.id,
          body: message.thread_id ? `Mentioned in ${threadTitle}` : `Mentioned in ${channel.name}`,
          route,
          target: { channel_id: channel.id, thread_id: message.thread_id, mention_id: mention.id, ...(message.thread_id ? { thread_title: threadTitle } : {}) },
        });
      }
    }
    return uniqueActorCandidates(candidates);
  }

  if (event.event_type === 'flightdeck_pg.task_comment.created' && event.entity_id) {
    const [comment] = await sql<{ id: string; body: string; task_id: string; channel_id: string; created_by_actor_id: string }[]>`
      SELECT id, body, task_id, channel_id, created_by_actor_id
      FROM flightdeck_pg_task_comments
      WHERE workspace_id = ${workspaceId}
        AND id = ${event.entity_id}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    const [task] = comment ? await sql<{ title: string }[]>`
      SELECT title FROM flightdeck_pg_tasks WHERE workspace_id = ${workspaceId} AND id = ${comment.task_id} LIMIT 1
    ` : [];
    if (!comment || !task) return [];
    const route = `/workspaces/${workspaceId}/tasks/${comment.task_id}`;
    const candidates: NotificationCandidate[] = [];
    for (const mention of extractFlightDeckMentions(comment.body).filter((entry) => entry.type === 'person')) {
      const actor = await resolvePersonMentionActor(workspaceId, mention.id, sql);
      if (!actor || actor.id === comment.created_by_actor_id) continue;
      if (await canReadChannel(workspaceId, comment.channel_id, actor.id, 'task.read', sql)) {
        candidates.push({
          category: 'comment_tag',
          actorId: actor.id,
          body: `New Comment in ${task.title}`,
          route,
          target: { task_id: comment.task_id, comment_id: comment.id, mention_id: mention.id },
        });
      }
    }
    return uniqueActorCandidates(candidates);
  }

  if (event.event_type === 'flightdeck_pg.doc_comment.created' && event.entity_id) {
    const [comment] = await sql<{ id: string; body: string; doc_id: string; channel_id: string; created_by_actor_id: string }[]>`
      SELECT id, body, doc_id, channel_id, created_by_actor_id
      FROM flightdeck_pg_doc_comments
      WHERE workspace_id = ${workspaceId}
        AND id = ${event.entity_id}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    const [doc] = comment ? await sql<{ title: string }[]>`
      SELECT title FROM flightdeck_pg_docs WHERE workspace_id = ${workspaceId} AND id = ${comment.doc_id} LIMIT 1
    ` : [];
    if (!comment || !doc) return [];
    const route = `/workspaces/${workspaceId}/docs/${comment.doc_id}`;
    const candidates: NotificationCandidate[] = [];
    for (const mention of extractFlightDeckMentions(comment.body).filter((entry) => entry.type === 'person')) {
      const actor = await resolvePersonMentionActor(workspaceId, mention.id, sql);
      if (!actor || actor.id === comment.created_by_actor_id) continue;
      if (await canReadChannel(workspaceId, comment.channel_id, actor.id, 'doc.read', sql)) {
        candidates.push({
          category: 'comment_tag',
          actorId: actor.id,
          body: `New Comment in ${doc.title}`,
          route,
          target: { doc_id: comment.doc_id, comment_id: comment.id, mention_id: mention.id },
        });
      }
    }
    return uniqueActorCandidates(candidates);
  }

  if (event.event_type === 'flightdeck_pg.task_assignment.assigned') {
    const actorId = uuidOrNull(event.payload?.actor_id) ?? uuidOrNull(event.payload?.assignee_actor_id);
    const taskId = uuidOrNull(event.payload?.task_id) ?? event.entity_id;
    if (!actorId || !taskId || actorId === event.actor_id) return [];
    const [task] = await sql<{ id: string; title: string; channel_id: string; scope_id: string; scope_name: string; channel_name: string }[]>`
      SELECT t.id, t.title, t.channel_id, t.scope_id, s.name AS scope_name, c.name AS channel_name
      FROM flightdeck_pg_tasks t
      JOIN flightdeck_pg_scopes s ON s.workspace_id = t.workspace_id AND s.id = t.scope_id
      JOIN flightdeck_pg_channels c ON c.workspace_id = t.workspace_id AND c.id = t.channel_id
      WHERE t.workspace_id = ${workspaceId}
        AND t.id = ${taskId}
        AND t.deleted_at IS NULL
      LIMIT 1
    `;
    if (!task) return [];
    if (!(await canReadChannel(workspaceId, task.channel_id, actorId, 'task.read', sql))) return [];
    return [{
      category: 'task_assignment',
      actorId,
      body: `Task Assigned: ${task.scope_name} | ${task.channel_name}`,
      route: `/workspaces/${workspaceId}/tasks/${task.id}`,
      target: { task_id: task.id, channel_id: task.channel_id, scope_id: task.scope_id },
    }];
  }

  return [];
}

function preferenceEnabled(preferences: FlightDeckPgNotificationPreferenceRow, category: FlightDeckPgNotificationCategory) {
  if (category === 'chat_thread') return preferences.chat_threads_enabled;
  if (category === 'mention') return preferences.mentions_enabled;
  if (category === 'dm') return preferences.dms_enabled;
  if (category === 'comment_tag') return preferences.comment_tags_enabled;
  return preferences.task_assignments_enabled;
}

async function recordDelivery(
  input: {
    event: OutboxEventRow;
    candidate: NotificationCandidate;
    subscription: FlightDeckPgPushSubscriptionRow | null;
    decision: 'sent' | 'skipped' | 'failed';
    reason?: string | null;
    providerStatus?: number | null;
    providerResponse?: string | null;
  },
  sql: DbClient,
) {
  const [workspace] = await sql<{ name: string }[]>`SELECT name FROM flightdeck_pg_workspaces WHERE id = ${input.event.workspace_id} LIMIT 1`;
  const title = `Flight Deck: ${workspace?.name ?? 'Workspace'}`;
  const dedupeKey = [
    input.event.id,
    input.candidate.category,
    input.candidate.actorId,
    input.subscription?.id ?? 'no-subscription',
  ].join(':');
  const [row] = await sql<{ id: string; decision: string; failure_reason: string | null }[]>`
    INSERT INTO flightdeck_pg_notification_deliveries (
      workspace_id,
      outbox_event_id,
      recipient_actor_id,
      subscription_id,
      category,
      source_entity_type,
      source_entity_id,
      dedupe_key,
      decision,
      title,
      body,
      payload,
      provider_status,
      provider_response,
      failure_reason,
      delivered_at
    )
    VALUES (
      ${input.event.workspace_id},
      ${input.event.id},
      ${input.candidate.actorId},
      ${input.subscription?.id ?? null},
      ${input.candidate.category},
      ${input.event.entity_type},
      ${input.event.entity_id},
      ${dedupeKey},
      ${input.decision},
      ${title},
      ${input.candidate.body},
      ${sql.json(asDbJson({
        title,
        body: input.candidate.body,
        route: input.candidate.route,
        category: input.candidate.category,
        workspace_id: input.event.workspace_id,
        outbox_event_id: input.event.id,
        target: input.candidate.target,
      }))},
      ${input.providerStatus ?? null},
      ${input.providerResponse ?? null},
      ${input.reason ?? null},
      ${input.decision === 'sent' ? sql`NOW()` : null}
    )
    ON CONFLICT (dedupe_key, COALESCE(subscription_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET
      decision = flightdeck_pg_notification_deliveries.decision
    RETURNING id, decision, failure_reason
  `;
  return row;
}

type PushSendOutcome = {
  decision: 'sent' | 'skipped' | 'failed';
  providerStatus: number | null;
  providerResponse: string | null;
  failureReason: string | null;
  stale: boolean;
};

function providerResponseText(result: SendResult | InstanceType<typeof webpush.WebPushError> | Error) {
  if ('body' in result && typeof result.body === 'string' && result.body.trim()) return result.body.slice(0, 2000);
  return result.message.slice(0, 2000);
}

async function sendWebPushNotification(
  subscription: FlightDeckPgPushSubscriptionRow,
  payload: Record<string, unknown>,
): Promise<PushSendOutcome> {
  const config = getPushDeliveryConfig();
  if (!config) {
    return {
      decision: 'failed',
      providerStatus: null,
      providerResponse: null,
      failureReason: 'web_push_not_configured',
      stale: false,
    };
  }

  try {
    const result = await webpush.sendNotification({
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      },
    }, JSON.stringify(payload), {
      vapidDetails: {
        subject: config.subject,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      },
      TTL: 60 * 60,
      urgency: 'high',
      contentEncoding: 'aes128gcm',
    });
    return {
      decision: 'sent',
      providerStatus: result.statusCode,
      providerResponse: result.body || 'accepted',
      failureReason: null,
      stale: false,
    };
  } catch (error) {
    if (error instanceof webpush.WebPushError) {
      return {
        decision: 'failed',
        providerStatus: error.statusCode,
        providerResponse: providerResponseText(error),
        failureReason: error.message,
        stale: error.statusCode === 404 || error.statusCode === 410,
      };
    }
    const message = error instanceof Error ? error.message : 'web_push_delivery_failed';
    return {
      decision: 'failed',
      providerStatus: null,
      providerResponse: message.slice(0, 2000),
      failureReason: message,
      stale: false,
    };
  }
}

async function updateSubscriptionAfterPush(
  subscriptionId: string,
  outcome: PushSendOutcome,
  sql: DbClient,
) {
  if (outcome.decision === 'sent') {
    await sql`
      UPDATE flightdeck_pg_push_subscriptions
      SET last_success_at = NOW(), failure_count = 0, last_failure_at = NULL, updated_at = NOW()
      WHERE id = ${subscriptionId}
    `;
    return;
  }

  await sql`
    UPDATE flightdeck_pg_push_subscriptions
    SET
      status = CASE WHEN ${outcome.stale} THEN 'stale' ELSE status END,
      stale_at = CASE WHEN ${outcome.stale} THEN NOW() ELSE stale_at END,
      failure_count = failure_count + 1,
      last_failure_at = NOW(),
      updated_at = NOW()
    WHERE id = ${subscriptionId}
  `;
}

export async function evaluateFlightDeckPgNotificationOutboxEvent(
  outboxEventId: string,
  sql: DbClient = getDb(),
) {
  const [event] = await sql<OutboxEventRow[]>`
    SELECT *
    FROM flightdeck_pg_outbox_events
    WHERE id = ${outboxEventId}
    LIMIT 1
  `;
  if (!event) return { evaluated: false, reason: 'event_not_found', candidates: 0, deliveries: 0 };

  const candidates = await buildCandidates(event, sql);
  const [workspace] = await sql<{ name: string }[]>`SELECT name FROM flightdeck_pg_workspaces WHERE id = ${event.workspace_id} LIMIT 1`;
  const title = `Flight Deck: ${workspace?.name ?? 'Workspace'}`;
  let deliveries = 0;
  for (const candidate of candidates) {
    const preferences = await getFlightDeckPgNotificationPreferences(event.workspace_id, candidate.actorId, sql);
    if (!preferenceEnabled(preferences, candidate.category)) {
      await recordDelivery({ event, candidate, subscription: null, decision: 'skipped', reason: 'preference_disabled' }, sql);
      deliveries += 1;
      continue;
    }
    const subscriptions = await sql<FlightDeckPgPushSubscriptionRow[]>`
      SELECT *
      FROM flightdeck_pg_push_subscriptions
      WHERE actor_id = ${candidate.actorId}
        AND status = 'active'
      ORDER BY updated_at DESC
    `;
    if (subscriptions.length === 0) {
      await recordDelivery({ event, candidate, subscription: null, decision: 'skipped', reason: 'no_active_subscription' }, sql);
      deliveries += 1;
      continue;
    }
    for (const subscription of subscriptions) {
      const payload = {
        title,
        body: candidate.body,
        route: candidate.route,
        category: candidate.category,
        workspace_id: event.workspace_id,
        outbox_event_id: event.id,
        target: candidate.target,
      };
      const outcome = getPushDeliveryConfig()
        ? await sendWebPushNotification(subscription, payload)
        : {
          decision: 'skipped' as const,
          providerStatus: null,
          providerResponse: null,
          failureReason: 'web_push_not_configured',
          stale: false,
        };
      if (outcome.decision !== 'skipped') await updateSubscriptionAfterPush(subscription.id, outcome, sql);
      await recordDelivery({
        event,
        candidate,
        subscription,
        decision: outcome.decision,
        reason: outcome.failureReason,
        providerStatus: outcome.providerStatus,
        providerResponse: outcome.providerResponse,
      }, sql);
      deliveries += 1;
    }
  }
  return { evaluated: true, candidates: candidates.length, deliveries };
}

export async function listFlightDeckPgNotificationDeliveries(
  input: { workspaceId: string; actorId: string; limit: number },
  sql: DbClient = getDb(),
) {
  return sql<Record<string, unknown>[]>`
    SELECT *
    FROM flightdeck_pg_notification_deliveries
    WHERE workspace_id = ${input.workspaceId}
      AND recipient_actor_id = ${input.actorId}
    ORDER BY created_at DESC
    LIMIT ${input.limit}
  `;
}
