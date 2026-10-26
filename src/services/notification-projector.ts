import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { effectiveFlightDeckPgThreadTitle } from './flightdeck-pg-thread-titles';
import { listChannelRecipients } from './flightdeck-pg-notifications';
import {
  type Sql, type RuleRow, asJson, CORE_SOURCE, CORE_CATEGORIES, MAX_INTAKE_ATTEMPTS, MENTION_WINDOW_SECONDS, RECIPIENT_PAGE,
  canonicalAudience, categoryDef, isUuid, lockRecipient, lockRecipients, plainText, resolveRuleMode, topCategory,
} from './notification-core';

type IntakeRow = {
  id: string; workspace_id: string; kind: 'outbox' | 'event'; outbox_event_id: string | null; event_id: string | null;
  attempt_count: number; resume_after: string | null;
};
type OutboxRow = {
  id: string; workspace_id: string; scope_id: string | null; channel_id: string | null; actor_id: string | null;
  event_type: string; entity_type: string; entity_id: string | null; payload: Record<string, any>; created_at: Date;
};
type EventRow = {
  id: string; workspace_id: string; source_app_id: string; category: string; severity: string; op: string; subject: any; recipients: any;
  snapshot: any; audience: any; action: any; group_key: string | null; target_event_key: string | null; trigger_actor_id: string | null;
  subject_activity_version: string | null; occurred_at: Date; expires_at: Date | null; producer_kind: string;
};

export type ProjectionStats = { claimed: number; done: number; failed: number; dead: number };

const hintOp = (created: boolean) => (created ? 'created' : 'updated');

// ---------------------------------------------------------------------------------------------------------------
// Queue claiming (SKIP LOCKED lease). Projection and `done` commit in the same transaction, so a crash between
// claim and commit leaves a leased row that is recovered after lease expiry.
// ---------------------------------------------------------------------------------------------------------------
export async function claimIntake(sql: Sql, owner: string, limit: number, leaseSeconds: number): Promise<IntakeRow[]> {
  return sql<IntakeRow[]>`
    UPDATE flightdeck_pg_notification_intake i
    SET state = 'leased', lease_owner = ${owner}, lease_until = NOW() + make_interval(secs => ${leaseSeconds}), attempt_count = attempt_count + 1
    WHERE i.id IN (
      SELECT id FROM flightdeck_pg_notification_intake
      WHERE state IN ('pending', 'leased') AND next_attempt_at <= NOW() AND (state = 'pending' OR lease_until < NOW())
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING i.id, i.workspace_id, i.kind, i.outbox_event_id, i.event_id, i.attempt_count, i.resume_after
  `;
}

export async function processIntakeBatch(
  options: { sql?: Sql; owner?: string; limit?: number; leaseSeconds?: number; beforeCommit?: (row: IntakeRow) => void | Promise<void> } = {},
): Promise<ProjectionStats> {
  const sql = options.sql ?? getDb();
  const owner = options.owner ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  const rows = await claimIntake(sql, owner, options.limit ?? 25, options.leaseSeconds ?? 60);
  const stats: ProjectionStats = { claimed: rows.length, done: 0, failed: 0, dead: 0 };
  for (const row of rows) {
    try {
      await sql.begin(async (tx) => {
        const outcome = await projectIntakeRow(tx as unknown as Sql, row);
        if (options.beforeCommit) await options.beforeCommit(row);
        if (outcome.more) {
          await tx`UPDATE flightdeck_pg_notification_intake SET state = 'pending', lease_owner = NULL, lease_until = NULL,
            resume_after = ${outcome.more}, attempt_count = 0, next_attempt_at = NOW() WHERE id = ${row.id}`;
        } else {
          await tx`UPDATE flightdeck_pg_notification_intake SET state = 'done', done_at = NOW(), lease_owner = NULL, lease_until = NULL,
            resume_after = NULL, last_error = NULL WHERE id = ${row.id}`;
        }
      });
      stats.done += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const dead = row.attempt_count >= MAX_INTAKE_ATTEMPTS;
      await sql`
        UPDATE flightdeck_pg_notification_intake
        SET state = ${dead ? 'dead' : 'pending'}, lease_owner = NULL, lease_until = NULL, last_error = ${message},
            next_attempt_at = NOW() + make_interval(secs => ${Math.min(3600, 2 ** row.attempt_count * 5)})
        WHERE id = ${row.id}`;
      stats[dead ? 'dead' : 'failed'] += 1;
      console.error(`[notifications] projection ${dead ? 'dead-lettered' : 'failed'} intake=${row.id} attempt=${row.attempt_count}: ${message}`);
    }
  }
  return stats;
}

async function projectIntakeRow(tx: Sql, row: IntakeRow): Promise<{ more: string | null }> {
  let event: EventRow | null = null;
  if (row.kind === 'outbox') {
    const [outbox] = await tx<OutboxRow[]>`SELECT * FROM flightdeck_pg_outbox_events WHERE id = ${row.outbox_event_id!} AND workspace_id = ${row.workspace_id}`;
    if (!outbox) return { more: null };
    event = await ensureRuleEvent(tx, outbox);
  } else {
    [event] = await tx<EventRow[]>`SELECT * FROM flightdeck_pg_notification_events WHERE id = ${row.event_id!} AND workspace_id = ${row.workspace_id}`;
  }
  if (!event) return { more: null };
  if (event.source_app_id === CORE_SOURCE) return projectRuleEvent(tx, event, row.resume_after);
  return projectExternalEvent(tx, event, row.resume_after);
}

// ---------------------------------------------------------------------------------------------------------------
// Tower rules: build an immutable structured snapshot from the committed outbox event.
// ---------------------------------------------------------------------------------------------------------------
type Snapshot = {
  skip?: string; kind: string; trigger_actor_id: string | null; mention_actor_ids: string[]; assignee_actor_id?: string | null;
  channel_kind?: string; channel_name?: string | null; context_title?: string | null; mode: 'channel_readers' | 'mentions' | 'assignee';
  acl_family: string | null; resource_type: string | null; resource_id: string | null; scope_id: string | null; channel_id: string | null;
  subject: Record<string, unknown>; action_target: Record<string, unknown>; dm_participant_npubs?: string[];
};

function mentionActorIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : Array.isArray((value as any)?.current) ? (value as any).current : [];
  return [...new Set(list.map((m: any) => (m && typeof m === 'object' && isUuid(m.actor_id) ? m.actor_id : null)).filter(Boolean) as string[])];
}

async function buildSnapshot(tx: Sql, ob: OutboxRow): Promise<{ snapshot: Snapshot; category: string; version: number | null }> {
  const w = ob.workspace_id;
  const payload = ob.payload ?? {};
  const author = ob.actor_id;
  const skip = (reason: string): { snapshot: Snapshot; category: string; version: number | null } => ({
    snapshot: { skip: reason, kind: ob.event_type, trigger_actor_id: author, mention_actor_ids: [], mode: 'mentions', acl_family: null, resource_type: null, resource_id: null, scope_id: ob.scope_id, channel_id: ob.channel_id, subject: {}, action_target: {} },
    category: 'chat_thread', version: null,
  });

  if (ob.event_type === 'flightdeck_pg.message.created' || ob.event_type === 'flightdeck_pg.message.revised') {
    if (!ob.entity_id) return skip('no_entity');
    const [message] = await tx<{ id: string; thread_id: string | null; channel_id: string; scope_id: string; created_by_actor_id: string; thread_title: string | null; thread_activity: string | null; source_body: string | null }[]>`
      SELECT m.id, m.thread_id, m.channel_id, m.scope_id, m.created_by_actor_id, t.title AS thread_title, t.activity_version AS thread_activity, src.body AS source_body
      FROM flightdeck_pg_messages m
      LEFT JOIN flightdeck_pg_threads t ON t.workspace_id = m.workspace_id AND t.id = m.thread_id AND t.deleted_at IS NULL
      LEFT JOIN flightdeck_pg_messages src ON src.workspace_id = t.workspace_id AND src.id = t.source_message_id AND src.deleted_at IS NULL
      WHERE m.workspace_id = ${w} AND m.id = ${ob.entity_id} AND m.deleted_at IS NULL`;
    if (!message) return skip('subject_deleted');
    const [channel] = await tx<{ id: string; name: string; kind: string; participant_npubs: string[] | null }[]>`
      SELECT id, name, kind, participant_npubs FROM flightdeck_pg_channels WHERE workspace_id = ${w} AND id = ${message.channel_id}`;
    if (!channel) return skip('channel_missing');
    const revised = ob.event_type.endsWith('.revised');
    // Structured canonical mentions only: visible @[..] text has no routing authority.
    const mentions = mentionActorIds(revised ? payload.newly_added_mentions : payload.mentions);
    const threaded = Boolean(message.thread_id);
    const title = threaded ? effectiveFlightDeckPgThreadTitle(message.thread_title, message.source_body) : channel.name;
    return {
      snapshot: {
        kind: revised ? 'message.revised' : 'message.created', trigger_actor_id: message.created_by_actor_id, mention_actor_ids: mentions,
        channel_kind: channel.kind, channel_name: channel.name, context_title: title, mode: revised ? 'mentions' : 'channel_readers',
        dm_participant_npubs: channel.kind === 'dm' ? (channel.participant_npubs ?? []) : undefined,
        acl_family: threaded ? 'thread' : 'message', resource_type: threaded ? 'thread' : null, resource_id: message.thread_id,
        scope_id: message.scope_id, channel_id: message.channel_id,
        subject: threaded
          ? { kind: 'thread', scope_id: message.scope_id, channel_id: message.channel_id, thread_id: message.thread_id, message_id: message.id }
          : { kind: 'channel', scope_id: message.scope_id, channel_id: message.channel_id, message_id: message.id },
        action_target: threaded
          ? { kind: 'thread', channel_id: message.channel_id, thread_id: message.thread_id, message_id: message.id }
          : { kind: 'channel', channel_id: message.channel_id, message_id: message.id },
      },
      category: mentions.length ? 'mention' : 'chat_thread',
      version: threaded && message.thread_activity != null ? Number(message.thread_activity) : null,
    };
  }

  if (ob.event_type === 'flightdeck_pg.task_comment.created') {
    const [row] = await tx<{ id: string; task_id: string; channel_id: string; scope_id: string; created_by_actor_id: string; title: string; activity_version: string }[]>`
      SELECT c.id, c.task_id, c.channel_id, c.scope_id, c.created_by_actor_id, t.title, t.activity_version
      FROM flightdeck_pg_task_comments c JOIN flightdeck_pg_tasks t ON t.workspace_id = c.workspace_id AND t.id = c.task_id AND t.deleted_at IS NULL
      WHERE c.workspace_id = ${w} AND c.id = ${ob.entity_id} AND c.deleted_at IS NULL`;
    if (!row) return skip('subject_deleted');
    return {
      snapshot: {
        kind: 'task_comment.created', trigger_actor_id: row.created_by_actor_id, mention_actor_ids: mentionActorIds(payload.mentions), context_title: row.title, mode: 'mentions',
        acl_family: 'task', resource_type: 'task', resource_id: row.task_id, scope_id: row.scope_id, channel_id: row.channel_id,
        subject: { kind: 'task', scope_id: row.scope_id, channel_id: row.channel_id, task_id: row.task_id, comment_id: row.id },
        action_target: { kind: 'task', task_id: row.task_id, comment_id: row.id },
      },
      category: 'comment_tag', version: Number(payload.activity_version ?? row.activity_version),
    };
  }

  if (ob.event_type === 'flightdeck_pg.doc_comment.created') {
    const [row] = await tx<{ id: string; doc_id: string; channel_id: string; scope_id: string; created_by_actor_id: string; title: string; activity_version: string }[]>`
      SELECT c.id, c.doc_id, c.channel_id, c.scope_id, c.created_by_actor_id, d.title, d.activity_version
      FROM flightdeck_pg_doc_comments c JOIN flightdeck_pg_docs d ON d.workspace_id = c.workspace_id AND d.id = c.doc_id AND d.deleted_at IS NULL
      WHERE c.workspace_id = ${w} AND c.id = ${ob.entity_id} AND c.deleted_at IS NULL`;
    if (!row) return skip('subject_deleted');
    return {
      snapshot: {
        kind: 'doc_comment.created', trigger_actor_id: row.created_by_actor_id, mention_actor_ids: mentionActorIds(payload.mentions), context_title: row.title, mode: 'mentions',
        acl_family: 'doc_comment', resource_type: 'document', resource_id: row.doc_id, scope_id: row.scope_id, channel_id: row.channel_id,
        subject: { kind: 'doc', scope_id: row.scope_id, channel_id: row.channel_id, doc_id: row.doc_id, comment_id: row.id },
        action_target: { kind: 'doc', doc_id: row.doc_id, comment_id: row.id },
      },
      category: 'comment_tag', version: Number(payload.activity_version ?? row.activity_version),
    };
  }

  if (ob.event_type === 'flightdeck_pg.task_assignment.assigned') {
    const assignee = [payload.assignee_actor_id, payload.actor_id].find(isUuid) ?? null;
    const taskId = [payload.task_id, ob.entity_id].find(isUuid) ?? null;
    if (!assignee || !taskId) return skip('no_assignee');
    const [task] = await tx<{ id: string; title: string; channel_id: string; scope_id: string; activity_version: string }[]>`
      SELECT id, title, channel_id, scope_id, activity_version FROM flightdeck_pg_tasks WHERE workspace_id = ${w} AND id = ${taskId} AND deleted_at IS NULL`;
    if (!task) return skip('subject_deleted');
    return {
      snapshot: {
        kind: 'task_assignment.assigned', trigger_actor_id: author, mention_actor_ids: [], assignee_actor_id: assignee, context_title: task.title, mode: 'assignee',
        acl_family: 'task', resource_type: 'task', resource_id: task.id, scope_id: task.scope_id, channel_id: task.channel_id,
        subject: { kind: 'task', scope_id: task.scope_id, channel_id: task.channel_id, task_id: task.id },
        action_target: { kind: 'task', task_id: task.id },
      },
      category: 'task_assignment', version: Number(payload.activity_version ?? task.activity_version),
    };
  }

  if (ob.event_type === 'flightdeck_pg.task.created' || ob.event_type === 'flightdeck_pg.task.updated') {
    const created = ob.event_type.endsWith('.created');
    const taskId = [payload.task_id, ob.entity_id].find(isUuid) ?? null;
    if (!taskId) return skip('no_entity');
    // Assignee: the metadata assignment (assigned_to_npub). On update only a CHANGE notifies (emitter carries previous/current).
    let assigneeNpub: string | null = null;
    let mentionSource: unknown;
    if (created) {
      assigneeNpub = typeof payload.task?.assigned_to_npub === 'string' && payload.task.assigned_to_npub ? payload.task.assigned_to_npub : null;
      mentionSource = payload.mentions;
    } else {
      const change = payload.assignment;
      if (change && typeof change.current_npub === 'string' && change.current_npub && change.current_npub !== change.previous_npub) assigneeNpub = change.current_npub;
      const previous = new Set(mentionActorIds(payload.mentions?.previous));
      mentionSource = mentionActorIds(payload.mentions?.current).filter((id) => !previous.has(id)).map((actor_id) => ({ actor_id }));
    }
    const mentions = mentionActorIds(mentionSource);
    if (!assigneeNpub && !mentions.length) return skip('no_new_recipients');
    const [task] = await tx<{ id: string; title: string; channel_id: string; scope_id: string; activity_version: string }[]>`
      SELECT id, title, channel_id, scope_id, activity_version FROM flightdeck_pg_tasks WHERE workspace_id = ${w} AND id = ${taskId} AND deleted_at IS NULL`;
    if (!task) return skip('subject_deleted');
    const [assignee] = assigneeNpub ? await tx<{ id: string }[]>`SELECT id FROM flightdeck_pg_actors WHERE npub = ${assigneeNpub}` : [];
    if (!assignee && !mentions.length) return skip('no_assignee');
    return {
      snapshot: {
        kind: ob.event_type.replace('flightdeck_pg.', ''), trigger_actor_id: author, mention_actor_ids: mentions, assignee_actor_id: assignee?.id ?? null,
        context_title: task.title, mode: 'assignee',
        acl_family: 'task', resource_type: 'task', resource_id: task.id, scope_id: task.scope_id, channel_id: task.channel_id,
        subject: { kind: 'task', scope_id: task.scope_id, channel_id: task.channel_id, task_id: task.id },
        action_target: { kind: 'task', task_id: task.id },
      },
      category: assignee ? 'task_assignment' : 'mention',
      version: Number(payload.task?.activity_version ?? payload.activity_version ?? task.activity_version),
    };
  }

  // Document BODY mentions only. document_comment_mention_added is deliberately not captured: doc_comment.created already
  // carries the same mentions, so capturing both would notify twice.
  if (ob.event_type === 'flightdeck_pg.document_mention_added') {
    const docId = [payload.doc_id, payload.document_id, ob.entity_id].find(isUuid) ?? null;
    const mentions = mentionActorIds(payload.added_mentions);
    if (!docId || !mentions.length) return skip('no_new_recipients');
    const [doc] = await tx<{ id: string; title: string; channel_id: string; scope_id: string; activity_version: string }[]>`
      SELECT id, title, channel_id, scope_id, activity_version FROM flightdeck_pg_docs WHERE workspace_id = ${w} AND id = ${docId} AND deleted_at IS NULL`;
    if (!doc) return skip('subject_deleted');
    return {
      snapshot: {
        kind: 'document_mention_added', trigger_actor_id: author, mention_actor_ids: mentions, context_title: doc.title, mode: 'mentions',
        acl_family: 'doc', resource_type: 'document', resource_id: doc.id, scope_id: doc.scope_id, channel_id: doc.channel_id,
        subject: { kind: 'doc', scope_id: doc.scope_id, channel_id: doc.channel_id, doc_id: doc.id },
        action_target: { kind: 'doc', doc_id: doc.id },
      },
      category: 'mention', version: Number(doc.activity_version),
    };
  }
  return skip('unsupported_event_type');
}

async function ensureRuleEvent(tx: Sql, ob: OutboxRow): Promise<EventRow | null> {
  const key = `outbox:${ob.id}`;
  const [existing] = await tx<EventRow[]>`SELECT * FROM flightdeck_pg_notification_events WHERE workspace_id = ${ob.workspace_id} AND source_app_id = ${CORE_SOURCE} AND event_key = ${key}`;
  if (existing) return existing;
  const built = await buildSnapshot(tx, ob);
  const [created] = await tx<EventRow[]>`
    INSERT INTO flightdeck_pg_notification_events (
      workspace_id, source_app_id, event_key, op, category, severity, subject, recipients, snapshot, payload_hash, producer_kind,
      outbox_event_id, trigger_actor_id, subject_activity_version, occurred_at
    ) VALUES (
      ${ob.workspace_id}, ${CORE_SOURCE}, ${key}, 'publish', ${built.category}, 'normal', ${tx.json(asJson(built.snapshot.subject))},
      ${tx.json(asJson({ mode: built.snapshot.mode, mention_actor_ids: built.snapshot.mention_actor_ids }))}, ${tx.json(asJson(built.snapshot))},
      ${ob.id}, 'tower_rule', ${ob.id}, ${built.snapshot.trigger_actor_id}, ${built.version}, ${ob.created_at}
    )
    ON CONFLICT (workspace_id, source_app_id, event_key) DO UPDATE SET payload_hash = EXCLUDED.payload_hash
    RETURNING *`;
  return created ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Recipient resolution (live ACL via the central record-access oracle; reasons from the snapshot).
// ---------------------------------------------------------------------------------------------------------------
async function aclFilter(tx: Sql, workspaceId: string, actorIds: string[], key: string): Promise<Set<string>> {
  if (!actorIds.length) return new Set();
  const rows = await tx<{ id: string }[]>`
    SELECT x.id FROM unnest(${actorIds}::uuid[]) AS x(id)
    WHERE flightdeck_pg_record_access(${workspaceId}::uuid, x.id) @> to_jsonb(${key}::text)`;
  return new Set(rows.map((r) => r.id));
}

async function resolveRuleRecipients(tx: Sql, event: EventRow, snap: Snapshot): Promise<Map<string, Set<string>>> {
  const w = event.workspace_id;
  const reasons = new Map<string, Set<string>>();
  const add = (actor: string, reason: string) => { (reasons.get(actor) ?? reasons.set(actor, new Set()).get(actor)!).add(reason); };
  const family = snap.acl_family ?? 'message';
  const aclKey = (channelId: string) => `channel:${channelId}:${family}`;
  if (!snap.channel_id || snap.skip) return reasons;

  if (snap.mode === 'channel_readers') {
    if (snap.channel_kind === 'dm') {
      const npubs = snap.dm_participant_npubs ?? [];
      const rows = npubs.length
        ? await tx<{ id: string }[]>`SELECT id FROM flightdeck_pg_actors WHERE npub = ANY(${npubs}::text[])`
        : [];
      for (const r of rows) add(r.id, 'dm');
    } else {
      for (const r of await listChannelRecipients(w, snap.channel_id, tx)) add(r.id, 'chat_thread');
    }
  }
  if (snap.mode === 'assignee' && snap.assignee_actor_id) add(snap.assignee_actor_id, 'task_assignment');
  const mentionReason = event.category === 'comment_tag' ? 'comment_tag' : 'mention';
  for (const actor of snap.mention_actor_ids) add(actor, mentionReason);

  reasons.delete(snap.trigger_actor_id ?? '');
  const readable = await aclFilter(tx, w, [...reasons.keys()], aclKey(snap.channel_id));
  for (const actor of [...reasons.keys()]) if (!readable.has(actor)) reasons.delete(actor);
  return reasons;
}

// ---------------------------------------------------------------------------------------------------------------
// Presentation: fixed templates + record titles the recipient can read. Producer text is never used.
// ---------------------------------------------------------------------------------------------------------------
function composePresentation(category: string, actorName: string | null, snap: Snapshot, eventCount: number) {
  const who = plainText(actorName || 'Someone', 60);
  const ctx = plainText(snap.context_title || snap.channel_name || '', 200);
  const icon = category;
  switch (category) {
    case 'mention': return { title: plainText(`${who} mentioned you`, 120), body: ctx, icon, push_preview: 'generic' };
    case 'dm': return { title: plainText(eventCount > 1 ? `${eventCount} new direct messages` : `${who} sent you a message`, 120), body: '', icon, push_preview: 'generic' };
    case 'comment_tag': return { title: plainText(`${who} mentioned you in a comment`, 120), body: ctx, icon, push_preview: 'generic' };
    case 'task_assignment': return { title: plainText(`${who} assigned you a task`, 120), body: ctx, icon, push_preview: 'generic' };
    default: return { title: plainText(eventCount > 1 ? `${eventCount} new messages in ${ctx}` : `New activity in ${ctx}`, 120), body: '', icon, push_preview: 'generic' };
  }
}

function groupKeyFor(category: string, snap: Snapshot, occurredAt: Date) {
  const s = snap.subject as Record<string, string | undefined>;
  const base = s.thread_id ? `thread:${s.thread_id}` : s.task_id ? `task:${s.task_id}` : s.doc_id ? `doc:${s.doc_id}` : `channel:${s.channel_id}`;
  if (category === 'mention') return `mention:${base}:w${Math.floor(occurredAt.getTime() / 1000 / MENTION_WINDOW_SECONDS)}`;
  if (category === 'dm') return `dm:${base}`;
  return `${category}:${base}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Item write: fold into the open group item or create; one item per (event, recipient).
// ---------------------------------------------------------------------------------------------------------------
type ItemSeed = {
  workspaceId: string; recipient: string; source: string; category: string; reasons: string[]; severity: string; groupKey: string | null;
  event: EventRow; subject: any; aclFamily: string | null; aclChannelId: string | null; resourceType: string | null; resourceId: string | null;
  activityVersion: number | null; presentationFor: (eventCount: number) => Record<string, unknown>; action: unknown; audience: string[];
  triggerActorId: string | null; expiresAt: Date | null;
};

/**
 * Lock order: recipient cursor lock -> group/item rows -> next_seq. The viewed watermark (born-read decision) is read AFTER
 * the recipient lock: the view bridge takes the same lock, so a concurrent view commit is either fully visible here or
 * waits for this transaction and then marks the new item read itself.
 * Folding is limited to items with the SAME canonical audience (it is part of the open-group identity).
 */
async function writeItem(tx: Sql, seed: ItemSeed): Promise<'created' | 'folded' | 'duplicate'> {
  await lockRecipient(tx, seed.workspaceId, seed.recipient);
  const [receipt] = await tx`SELECT 1 FROM flightdeck_pg_notification_item_events WHERE event_id = ${seed.event.id} AND recipient_actor_id = ${seed.recipient}`;
  if (receipt) return 'duplicate';

  let existing: { id: string; event_count: number; subject_activity_version: string | null }[] = [];
  if (seed.groupKey) {
    existing = await tx<{ id: string; event_count: number; subject_activity_version: string | null }[]>`
      SELECT id, event_count, subject_activity_version FROM flightdeck_pg_notification_items
      WHERE workspace_id = ${seed.workspaceId} AND recipient_actor_id = ${seed.recipient} AND source_app_id = ${seed.source} AND group_key = ${seed.groupKey}
        AND audience_client_apps = ${seed.audience}::text[]
        AND removed_at IS NULL AND read_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL
      ORDER BY id FOR UPDATE`;
  }
  // The explicit assignment route and task metadata (task.created/updated) both announce one assignment: an open
  // assignment item for the task already says it, so a repeat is absorbed instead of counted.
  if (existing[0] && seed.source === CORE_SOURCE && seed.category === 'task_assignment') return 'duplicate';

  const [seqRow] = await tx<{ s: string }[]>`SELECT flightdeck_pg_notification_next_seq(${seed.workspaceId}::uuid, ${seed.recipient}::uuid) AS s`;
  const seq = Number(seqRow!.s);
  let itemId: string;
  let outcome: 'created' | 'folded';
  if (existing[0]) {
    itemId = existing[0].id;
    const count = existing[0].event_count + 1;
    await tx`
      UPDATE flightdeck_pg_notification_items SET
        event_count = ${count}, last_event_id = ${seed.event.id}, reasons = (SELECT ARRAY(SELECT DISTINCT unnest(reasons || ${seed.reasons}::text[]))),
        subject = jsonb_set(${tx.json(asJson(seed.subject))}::jsonb, '{activity_version}', COALESCE(to_jsonb(GREATEST(subject_activity_version, ${seed.activityVersion}::bigint)), 'null'::jsonb)),
        action = ${tx.json(asJson(seed.action))}, presentation = ${tx.json(asJson(seed.presentationFor(count)))},
        subject_activity_version = GREATEST(subject_activity_version, ${seed.activityVersion}::bigint),
        occurred_at = GREATEST(occurred_at, ${seed.event.occurred_at}), row_version = row_version + 1, change_seq = ${seq}, updated_at = NOW()
      WHERE id = ${itemId}`;
    outcome = 'folded';
  } else {
    const viewed = await viewedVersion(tx, seed.workspaceId, seed.recipient, seed.resourceType, seed.resourceId);
    const bornRead = viewed != null && seed.activityVersion != null && seed.activityVersion <= viewed;
    const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO flightdeck_pg_notification_items (
        workspace_id, recipient_actor_id, source_app_id, category, reasons, severity, group_key, first_event_id, last_event_id, trigger_actor_id,
        subject, acl_family, acl_channel_id, resource_type, resource_id, subject_activity_version, presentation, action, audience_client_apps,
        occurred_at, expires_at, read_at, read_reason, change_seq
      ) VALUES (
        ${seed.workspaceId}, ${seed.recipient}, ${seed.source}, ${seed.category}, ${seed.reasons}::text[], ${seed.severity}, ${seed.groupKey}, ${seed.event.id}, ${seed.event.id}, ${seed.triggerActorId},
        ${tx.json(asJson(seed.subject))}, ${seed.aclFamily}, ${seed.aclChannelId}, ${seed.resourceType}, ${seed.resourceId}, ${seed.activityVersion},
        ${tx.json(asJson(seed.presentationFor(1)))}, ${seed.action == null ? null : tx.json(asJson(seed.action))}, ${seed.audience}::text[],
        ${seed.event.occurred_at}, ${seed.expiresAt}, ${bornRead ? new Date() : null}, ${bornRead ? 'already_viewed' : null}, ${seq}
      ) RETURNING id`;
    itemId = inserted!.id;
    outcome = 'created';
  }
  await tx`INSERT INTO flightdeck_pg_notification_item_events (event_id, recipient_actor_id, item_id) VALUES (${seed.event.id}, ${seed.recipient}, ${itemId})`;
  await tx`SELECT flightdeck_pg_notification_emit_hint(${seed.workspaceId}::uuid, ${seed.recipient}::uuid, ${itemId}::uuid, ${seq}::bigint, ${hintOp(outcome === 'created')})`;
  return outcome;
}

async function loadRules(tx: Sql, workspaceId: string, actorIds: string[]): Promise<Map<string, RuleRow[]>> {
  const map = new Map<string, RuleRow[]>();
  if (!actorIds.length) return map;
  const rows = await tx<(RuleRow & { actor_id: string })[]>`
    SELECT actor_id, source_app_id, category, client_app_id, channel, mode, preview, row_version
    FROM flightdeck_pg_notification_rules WHERE workspace_id = ${workspaceId} AND actor_id = ANY(${actorIds}::uuid[])`;
  for (const r of rows) (map.get(r.actor_id) ?? map.set(r.actor_id, []).get(r.actor_id)!).push(r);
  return map;
}

async function viewedVersion(tx: Sql, workspaceId: string, actorId: string, resourceType: string | null, resourceId: string | null) {
  if (!resourceType || !resourceId) return null;
  const [row] = await tx<{ v: string }[]>`
    SELECT viewed_activity_version AS v FROM flightdeck_pg_resource_view_states
    WHERE workspace_id = ${workspaceId} AND viewer_actor_id = ${actorId} AND resource_type = ${resourceType} AND resource_id = ${resourceId}`;
  return row ? Number(row.v) : null;
}

async function projectRuleEvent(tx: Sql, event: EventRow, resumeAfter: string | null): Promise<{ more: string | null }> {
  const snap = event.snapshot as Snapshot;
  if (snap.skip) {
    await tx`UPDATE flightdeck_pg_notification_events SET state = 'projected', recipient_count = 0 WHERE id = ${event.id}`;
    return { more: null };
  }
  const reasons = await resolveRuleRecipients(tx, event, snap);
  const ordered = [...reasons.keys()].sort().filter((id) => !resumeAfter || id > resumeAfter);
  const page = ordered.slice(0, RECIPIENT_PAGE);
  const rulesByActor = await loadRules(tx, event.workspace_id, page);
  const [trigger] = snap.trigger_actor_id ? await tx<{ display_name: string | null }[]>`SELECT display_name FROM flightdeck_pg_actors WHERE id = ${snap.trigger_actor_id}` : [];
  const version = event.subject_activity_version == null ? null : Number(event.subject_activity_version);
  let projected = 0;
  for (const recipient of page) {
    const recipientReasons = reasons.get(recipient)!;
    const category = topCategory(recipientReasons);
    const def = categoryDef(category) ?? CORE_CATEGORIES[0]!;
    const inbox = resolveRuleMode(rulesByActor.get(recipient) ?? [], 'inbox', CORE_SOURCE, category, def.default_inbox);
    if (inbox === 'off' && !def.mandatory) continue;
    const groupKey = groupKeyFor(category, snap, event.occurred_at);
    const result = await writeItem(tx, {
      workspaceId: event.workspace_id, recipient, source: CORE_SOURCE, category, reasons: [...recipientReasons], severity: def.default_severity,
      groupKey, event, subject: { ...snap.subject, activity_version: version }, aclFamily: snap.acl_family, aclChannelId: snap.channel_id,
      resourceType: snap.resource_type, resourceId: snap.resource_id, activityVersion: version,
      presentationFor: (count) => composePresentation(category, trigger?.display_name ?? null, snap, count), action: { type: 'open', target: snap.action_target },
      audience: ['*'], triggerActorId: snap.trigger_actor_id, expiresAt: null,
    });
    if (result !== 'duplicate') projected += 1;
  }
  const hasMore = ordered.length > page.length;
  await tx`UPDATE flightdeck_pg_notification_events SET state = 'projected', recipient_count = COALESCE(recipient_count, 0) + ${projected} WHERE id = ${event.id}`;
  return { more: hasMore ? page[page.length - 1]! : null };
}

// ---------------------------------------------------------------------------------------------------------------
// External producer events (metadata-only app_object items).
// ---------------------------------------------------------------------------------------------------------------
async function projectExternalEvent(tx: Sql, event: EventRow, resumeAfter: string | null): Promise<{ more: string | null }> {
  const w = event.workspace_id;
  const [source] = await tx<{ display_name: string; grant_status: string; allowed_recipient_mode: string; allowed_recipient_actor_ids: string[]; allowed_client_apps: string[] }[]>`
    SELECT display_name, grant_status, allowed_recipient_mode, allowed_recipient_actor_ids, allowed_client_apps
    FROM flightdeck_pg_notification_sources WHERE workspace_id = ${w} AND source_app_id = ${event.source_app_id}`;
  // Revoked/disabled sources project nothing even if the event was accepted earlier.
  if (!source || source.grant_status !== 'active') {
    await tx`UPDATE flightdeck_pg_notification_events SET state = 'rejected', recipient_count = 0 WHERE id = ${event.id}`;
    return { more: null };
  }

  if (event.op === 'resolve') {
    // Canonical order: recipient locks (ascending) first, then the item rows.
    const affected = await tx<{ recipient_actor_id: string }[]>`
      SELECT DISTINCT recipient_actor_id FROM flightdeck_pg_notification_items
      WHERE workspace_id = ${w} AND source_app_id = ${event.source_app_id} AND group_key = ${`ext:${event.group_key}`} AND removed_at IS NULL AND status = 'active'`;
    await lockRecipients(tx, affected.map((a) => ({ workspaceId: w, actorId: a.recipient_actor_id })));
    const items = await tx<{ id: string; recipient_actor_id: string }[]>`
      SELECT id, recipient_actor_id FROM flightdeck_pg_notification_items
      WHERE workspace_id = ${w} AND source_app_id = ${event.source_app_id} AND group_key = ${`ext:${event.group_key}`} AND removed_at IS NULL AND status = 'active'
      ORDER BY recipient_actor_id, id FOR UPDATE`;
    for (const item of items) {
      const [s] = await tx<{ s: string }[]>`SELECT flightdeck_pg_notification_next_seq(${w}::uuid, ${item.recipient_actor_id}::uuid) AS s`;
      await tx`UPDATE flightdeck_pg_notification_items SET status = 'resolved', read_at = COALESCE(read_at, NOW()), read_reason = COALESCE(read_reason, 'resolved'),
        row_version = row_version + 1, change_seq = ${Number(s!.s)}, updated_at = NOW() WHERE id = ${item.id}`;
      await tx`SELECT flightdeck_pg_notification_emit_hint(${w}::uuid, ${item.recipient_actor_id}::uuid, ${item.id}::uuid, ${Number(s!.s)}::bigint, 'state')`;
    }
    await tx`UPDATE flightdeck_pg_notification_events SET state = 'projected', recipient_count = ${items.length} WHERE id = ${event.id}`;
    return { more: null };
  }

  if (event.op === 'withdraw') {
    // Withdrawing an event tombstones every item that ever received it (a folded item is withdrawn whole; documented v1 limit).
    const targets = () => tx<{ id: string; recipient_actor_id: string }[]>`
      SELECT DISTINCT i.id, i.recipient_actor_id FROM flightdeck_pg_notification_items i
      JOIN flightdeck_pg_notification_item_events ie ON ie.item_id = i.id
      JOIN flightdeck_pg_notification_events target ON target.id = ie.event_id
      WHERE i.workspace_id = ${w} AND i.source_app_id = ${event.source_app_id} AND target.workspace_id = ${w}
        AND target.source_app_id = ${event.source_app_id} AND target.event_key = ${event.target_event_key} AND i.removed_at IS NULL
      ORDER BY i.recipient_actor_id, i.id`;
    await lockRecipients(tx, (await targets()).map((t) => ({ workspaceId: w, actorId: t.recipient_actor_id })));
    const items = await targets();
    for (const item of items) await tombstoneItem(tx, w, item.recipient_actor_id, item.id, 'withdrawn');
    await tx`UPDATE flightdeck_pg_notification_events SET state = 'projected', recipient_count = ${items.length} WHERE id = ${event.id}`;
    return { more: null };
  }

  // publish
  const requested: string[] = Array.isArray(event.recipients?.actor_ids) ? event.recipients.actor_ids.filter(isUuid) : [];
  const policyOk = (id: string) => source.allowed_recipient_mode === 'owner_only' ? false : source.allowed_recipient_actor_ids.includes(id);
  let candidates = [...new Set(requested)].filter((id) => source.allowed_recipient_mode === 'owner_only' || policyOk(id)).sort();
  if (source.allowed_recipient_mode === 'owner_only') {
    const owners = await tx<{ actor_id: string }[]>`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id = ${w} AND role = 'owner' AND actor_id = ANY(${candidates}::uuid[])`;
    candidates = owners.map((o) => o.actor_id).sort();
  }
  const members = candidates.length
    ? new Set((await tx<{ actor_id: string }[]>`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id = ${w} AND actor_id = ANY(${candidates}::uuid[])`).map((m) => m.actor_id))
    : new Set<string>();
  const ordered = candidates.filter((id) => members.has(id) && (!resumeAfter || id > resumeAfter));
  const page = ordered.slice(0, RECIPIENT_PAGE);
  const rules = await loadRules(tx, w, page);
  const [cat] = await tx<{ label: string; default_severity: string; default_inbox: 'on' | 'off'; grouping: string }[]>`
    SELECT label, default_severity, default_inbox, grouping FROM flightdeck_pg_notification_categories
    WHERE workspace_id = ${w} AND source_app_id = ${event.source_app_id} AND category = ${event.category}`;
  if (!cat) {
    await tx`UPDATE flightdeck_pg_notification_events SET state = 'rejected', recipient_count = 0 WHERE id = ${event.id}`;
    return { more: null };
  }
  let projected = 0;
  for (const recipient of page) {
    if (resolveRuleMode(rules.get(recipient) ?? [], 'inbox', event.source_app_id, event.category, cat.default_inbox) === 'off') continue;
    const audience = canonicalAudience(event.audience?.client_apps);
    const result = await writeItem(tx, {
      workspaceId: w, recipient, source: event.source_app_id, category: event.category, reasons: [event.category], severity: event.severity,
      groupKey: event.group_key && cat.grouping !== 'none' ? `ext:${event.group_key}` : null, event,
      subject: event.subject, aclFamily: null, aclChannelId: null, resourceType: null, resourceId: null, activityVersion: null,
      // Generic registry template only: no producer text, no object title, no preview.
      presentationFor: () => ({ title: plainText(source.display_name, 120), body: plainText(cat.label, 280), icon: 'attention', push_preview: 'generic' }),
      action: event.action, audience, triggerActorId: null,
      expiresAt: event.expires_at,
    });
    if (result !== 'duplicate') projected += 1;
  }
  const hasMore = ordered.length > page.length;
  await tx`UPDATE flightdeck_pg_notification_events SET state = 'projected', recipient_count = COALESCE(recipient_count, 0) + ${projected} WHERE id = ${event.id}`;
  return { more: hasMore ? page[page.length - 1]! : null };
}

/**
 * Content-free tombstone: purge presentation text and identifying columns, allocate a sequence, hint the recipient.
 * Takes the recipient lock first (canonical order). Callers that tombstone several recipients must pre-sort by
 * (workspace, recipient, id). Returns null when the item was already removed.
 */
export async function tombstoneItem(tx: Sql, workspaceId: string, recipientId: string, itemId: string, reason: string) {
  await lockRecipient(tx, workspaceId, recipientId);
  const [live] = await tx`SELECT 1 FROM flightdeck_pg_notification_items WHERE id = ${itemId} AND removed_at IS NULL FOR UPDATE`;
  if (!live) return null;
  const [s] = await tx<{ s: string }[]>`SELECT flightdeck_pg_notification_next_seq(${workspaceId}::uuid, ${recipientId}::uuid) AS s`;
  const seq = Number(s!.s);
  await tx`
    UPDATE flightdeck_pg_notification_items SET removed_at = NOW(), removal_reason = ${reason}, presentation = '{}'::jsonb, action = NULL,
      subject = jsonb_build_object('kind', subject->>'kind'), trigger_actor_id = NULL, resource_id = NULL, acl_channel_id = NULL, acl_family = NULL,
      group_key = NULL, reasons = '{}'::text[], row_version = row_version + 1, change_seq = ${seq}, updated_at = NOW()
    WHERE id = ${itemId}`;
  await tx`SELECT flightdeck_pg_notification_emit_hint(${workspaceId}::uuid, ${recipientId}::uuid, ${itemId}::uuid, ${seq}::bigint, 'removed')`;
  return seq;
}
