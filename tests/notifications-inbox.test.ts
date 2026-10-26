import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { claimIntake, processIntakeBatch } from '../src/services/notification-projector';
import { runMaintenance, startNotificationWorker, stopNotificationWorker } from '../src/services/notification-worker';
import { listVisibleFlightDeckPgEvents } from '../src/services/flightdeck-pg-api';

const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('shared notification inbox against disposable Postgres', () => {
  const database = `notif_inbox_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  // 0 owner, 1 alice, 2 bob, 3 carol (member, no channel grant), 4 producer signer (not a member), 5 dave (workspace 2 owner)
  const secrets = [201, 202, 203, 204, 205, 206].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((s) => nip19.npubEncode(getPublicKey(s)));
  let db: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createApp>;
  let actors: string[] = [];
  let w1: string, w2: string, scope: string, ch1: string, ch2: string, scope2: string, ch3: string;
  const base = (w = w1) => `/api/v4/flightdeck-pg/workspaces/${w}`;

  async function call(path: string, method = 'GET', actor = 0, body?: unknown) {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const event = finalizeEvent({
      kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
      tags: [['u', `http://localhost${path}`], ['method', method], ...(data ? [['payload', createHash('sha256').update(data).digest('hex')]] : [])],
    }, secrets[actor]!);
    const response = await app.request(path, {
      method, body: data,
      headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Type': 'application/json' },
    });
    return { status: response.status, body: (await response.json()) as any, headers: response.headers };
  }
  const n = (suffix: string, method = 'GET', actor = 0, body?: unknown, w = w1) => call(`${base(w)}/notifications${suffix}`, method, actor, body);
  const drain = async () => { for (let i = 0; i < 20; i++) if ((await processIntakeBatch({ sql: db, limit: 50 })).claimed === 0) return; };
  const grant = (actor: string, channel: string, permission: string, w = w1) =>
    db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${actor},'channel',${channel},${permission})`;

  const manage = (actor: string, w = w1) =>
    db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w},'actor',${actor},'workspace','workspace.manage')`;

  async function thread(author: number, channel = ch1, activity = 0) {
    const [t] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id,activity_version)
      VALUES(${w1},${scope},${channel},'Roadmap sync',${actors[author]!},${actors[author]!},${activity}) RETURNING id`;
    return t!.id as string;
  }
  const mention = (i: number) => ({ type: 'agent', actor_id: actors[i], npub: npubs[i], label: `User ${i}` });
  async function message(author: number, o: { thread?: string | null; channel?: string; mentions?: number[]; kind?: 'created' | 'revised'; added?: number[] } = {}) {
    const channel = o.channel ?? ch1;
    const [m] = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id)
      VALUES(${w1},${scope},${channel},${o.thread ?? null},'secret body text',${actors[author]!},${actors[author]!}) RETURNING id`;
    const payload = o.kind === 'revised'
      ? { newly_added_mentions: (o.added ?? []).map(mention) }
      : { mentions: (o.mentions ?? []).map(mention) };
    const [ob] = await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${channel},${actors[author]!},${`flightdeck_pg.message.${o.kind ?? 'created'}`},'message',${m!.id},'created',${db.json(payload as any)}) RETURNING id`;
    return { messageId: m!.id as string, outboxId: ob!.id as string };
  }
  async function task(author: number, title = 'Ship inbox') {
    const [t] = await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id,activity_version)
      VALUES(${w1},${scope},${ch1},${title},${actors[author]!},${actors[author]!},3) RETURNING id`;
    return t!.id as string;
  }
  const inbox = async (actor: number, query = '') => (await n(`/items${query}`, 'GET', actor)).body;

  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    for (const npub of npubs) {
      const [a] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id`;
      actors.push(a!.id);
    }
    await db`UPDATE flightdeck_pg_actors SET display_name = ${'Alice'} WHERE id = ${actors[1]!}`;
    const mk = async (name: string, owner: number, svc: string) => {
      const [w] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${'tower' + svc},${'service' + svc},${npubs[owner]!},'app',${name}) RETURNING id`;
      return w!.id as string;
    };
    w1 = await mk('One', 0, '1'); w2 = await mk('Two', 5, '2');
    for (const [i, role] of ['owner', 'member', 'member', 'member'].entries()) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w1},${actors[i]!},${role})`;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w2},${actors[5]!},'owner')`;
    const [s] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w1},'Main','project') RETURNING id`; scope = s!.id;
    const [c1] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'General') RETURNING id`; ch1 = c1!.id;
    const [c2] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'Private') RETURNING id`; ch2 = c2!.id;
    for (const i of [0, 1, 2]) { await grant(actors[i]!, ch1, 'channel.read'); await grant(actors[i]!, ch1, 'task.read'); }
    await grant(actors[0]!, ch2, 'channel.read');
    const [s2] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w2},'Main','project') RETURNING id`; scope2 = s2!.id;
    const [c3] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w2},${scope2},'General') RETURNING id`; ch3 = c3!.id;
    await grant(actors[5]!, ch3, 'channel.read', w2);
    // Source/queue/evaluate administration is the EFFECTIVE workspace.manage permission (owner role alone is not enough).
    await manage(actors[0]!); await manage(actors[5]!, w2);
    setDb(db); app = createApp();
  });
  afterAll(async () => {
    stopNotificationWorker();
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  });

  test('schema is idempotent on re-run and the intake/bridge triggers are installed', async () => {
    await ensureRuntimeSchema(db); await ensureRuntimeSchema(db);
    const triggers = await db`SELECT tgname FROM pg_trigger WHERE tgname IN ('fd_notification_intake_capture','fd_notification_view_bridge')`;
    expect(triggers.map((t) => t.tgname).sort()).toEqual(['fd_notification_intake_capture', 'fd_notification_view_bridge']);
    expect((await n('/items', 'GET', 1)).body.inbox_started_at).toBeTruthy();
  });

  test('upgraded database: pre-existing outbox rows do not flood the inbox (empty from activation)', async () => {
    // Simulate a database that predates the feature: history exists, the capture trigger does not.
    await db`DROP TRIGGER fd_notification_intake_capture ON flightdeck_pg_outbox_events`;
    await message(1, { mentions: [2] });
    await message(1, { mentions: [2], channel: ch2 });
    await ensureRuntimeSchema(db);
    await drain();
    expect((await db`SELECT 1 FROM flightdeck_pg_notification_intake`).length).toBe(0);
    expect((await inbox(2)).items).toEqual([]);
    expect((await n('/counts', 'GET', 2)).body.unread_total).toBe(0);
  });

  let bobMentionItem: any;
  let threadA: string;
  test('structured mention + channel membership yields ONE item per recipient with merged reasons; author/outsider excluded', async () => {
    threadA = await thread(1);
    await message(1, { thread: threadA, mentions: [2] });
    await drain();
    const bob = await inbox(2);
    expect(bob.items).toHaveLength(1);
    bobMentionItem = bob.items[0];
    expect(bobMentionItem.category).toBe('mention');
    expect(bobMentionItem.reasons.sort()).toEqual(['chat_thread', 'mention']);
    expect(bobMentionItem.presentation.title).toBe('Alice mentioned you');
    expect(JSON.stringify(bobMentionItem)).not.toContain('secret body text');
    expect(bobMentionItem.schema).toBe('org.wingman.notification.item');
    expect(bobMentionItem.source).toEqual({ app_id: 'flightdeck.core', label: 'Flight Deck', kind: 'tower_rule' });
    expect((await inbox(0)).items.map((i: any) => i.category)).toEqual(['chat_thread']); // plain reader
    expect((await inbox(1)).items).toHaveLength(0); // author
    expect((await inbox(3)).items).toHaveLength(0); // member without channel grant
  });

  test('visible @-tags have no routing authority (only structured mentions notify)', async () => {
    await grant(actors[3]!, ch2, 'channel.read');
    const t = await thread(1, ch2);
    const [m] = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id)
      VALUES(${w1},${scope},${ch2},${t},${`hello @[Carol](mention:person:${actors[3]})`},${actors[1]!},${actors[1]!}) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch2},${actors[1]!},'flightdeck_pg.message.created','message',${m!.id},'created','{}')`;
    await drain();
    const carol = (await inbox(3)).items;
    expect(carol.map((i: any) => i.category)).toEqual(['chat_thread']); // reader only: the tag was not a mention
    expect((await inbox(2)).items.filter((i: any) => i.subject.thread_id === t)).toHaveLength(0); // bob cannot read ch2
  });

  test('replaying an intake row (restart/duplicate delivery) creates no second item or sequence', async () => {
    const before = (await n('/counts', 'GET', 2)).body.head_seq;
    const all = (await inbox(0, '?view=all&limit=100')).items.length;
    await db`UPDATE flightdeck_pg_notification_intake SET state='pending', next_attempt_at=NOW()`;
    await drain();
    expect((await inbox(2)).items).toHaveLength(1);
    expect((await inbox(0, '?view=all&limit=100')).items).toHaveLength(all);
    expect((await n('/counts', 'GET', 2)).body.head_seq).toBe(before);
  });

  test('cross-actor and cross-workspace isolation', async () => {
    const id = bobMentionItem.id;
    expect((await n(`/items/${id}`, 'GET', 0)).status).toBe(404);
    expect((await n(`/items/${id}`, 'GET', 3)).status).toBe(404);
    expect((await n(`/items/${id}`, 'PATCH', 0, { mutation_id: randomUUID(), expected_row_version: 1, patch: { read: true } })).status).toBe(404);
    expect((await n(`/items/${id}`, 'GET', 5, undefined, w1)).status).toBe(403); // not a member of w1
    expect((await n(`/items/${id}`, 'GET', 5, undefined, w2)).status).toBe(404); // right actor, wrong workspace
    expect((await n('/items', 'GET', 4)).status).toBe(403); // non-member producer cannot read any inbox
  });

  test('counts equal the list under the same visibility predicate; changes carry through_seq and head_seq', async () => {
    const counts = (await n('/counts', 'GET', 2)).body;
    expect(counts.unread_total).toBe(1);
    expect(counts.by_category).toEqual({ mention: 1 });
    expect(counts.badge).toBe(1);
    const changes = (await n('/changes?after_seq=0', 'GET', 2)).body;
    expect(changes.changes).toHaveLength(1);
    expect(changes.through_seq).toBe(changes.head_seq);
    expect(changes.has_more).toBe(false);
    expect((await n(`/changes?after_seq=${changes.head_seq}`, 'GET', 2)).body).toMatchObject({ changes: [], through_seq: changes.head_seq, has_more: false });
    expect((await n('/changes?after_seq=999', 'GET', 2)).status).toBe(410);
    expect((await n('/changes?after_seq=0&x=1', 'GET', 2)).status).toBe(400);
  });

  test('CAS: read, replay, stale version conflict, mutation id reuse', async () => {
    const id = bobMentionItem.id;
    const mutation = randomUUID();
    const read = await n(`/items/${id}`, 'PATCH', 2, { mutation_id: mutation, expected_row_version: bobMentionItem.row_version, patch: { read: true } });
    expect(read.status).toBe(200);
    expect(read.body.item.state).toMatchObject({ read: true, read_reason: 'user' });
    expect(read.body.item.row_version).toBe(bobMentionItem.row_version + 1);
    const replay = await n(`/items/${id}`, 'PATCH', 2, { mutation_id: mutation, expected_row_version: bobMentionItem.row_version, patch: { read: true } });
    expect(replay.status).toBe(200);
    expect(replay.body.item.row_version).toBe(read.body.item.row_version);
    const stale = await n(`/items/${id}`, 'PATCH', 2, { mutation_id: randomUUID(), expected_row_version: bobMentionItem.row_version, patch: { dismissed: true } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('state_conflict');
    expect(stale.body.item.id).toBe(id);
    const reused = await n(`/items/${id}`, 'PATCH', 2, { mutation_id: mutation, expected_row_version: 1, patch: { read: false } });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('mutation_id_reused');
    expect((await n('/counts', 'GET', 2)).body.unread_total).toBe(0);
    const unread = await n(`/items/${id}`, 'PATCH', 2, { mutation_id: randomUUID(), expected_row_version: read.body.item.row_version, patch: { read: false } });
    expect(unread.body.item.state.read).toBe(false);
    bobMentionItem = unread.body.item;
    expect((await n(`/items/${id}`, 'PATCH', 2, { mutation_id: randomUUID(), expected_row_version: 1, patch: {} })).status).toBe(400);
    expect((await n(`/items/${id}`, 'PATCH', 2, { mutation_id: 'nope', expected_row_version: 1, patch: { read: true } })).status).toBe(400);
  });

  test('folding bumps row_version so a stale device cannot acknowledge newly folded activity; a read item never mutates', async () => {
    const staleVersion = bobMentionItem.row_version;
    await message(1, { thread: threadA, mentions: [2] });
    await drain();
    const folded = (await inbox(2)).items.find((i: any) => i.id === bobMentionItem.id);
    expect(folded.group.event_count).toBe(2);
    expect(folded.row_version).toBeGreaterThan(staleVersion);
    expect(folded.change_seq).toBeGreaterThan(bobMentionItem.change_seq);
    const stale = await n(`/items/${folded.id}`, 'PATCH', 2, { mutation_id: randomUUID(), expected_row_version: staleVersion, patch: { read: true } });
    expect(stale.status).toBe(409);
    expect((await n('/counts', 'GET', 2)).body.unread_total).toBe(1);
    const ok = await n(`/items/${folded.id}`, 'PATCH', 2, { mutation_id: randomUUID(), expected_row_version: folded.row_version, patch: { read: true } });
    expect(ok.status).toBe(200);
    // Same 10-minute window, but the group is read: new activity creates a NEW item and leaves history alone.
    await message(1, { thread: threadA, mentions: [2] });
    await drain();
    const items = (await inbox(2)).items;
    expect(items.filter((i: any) => i.category === 'mention')).toHaveLength(2);
    expect(items.find((i: any) => i.id === folded.id).state.read).toBe(true);
    expect(items.find((i: any) => i.id === folded.id).group.event_count).toBe(2);
  });

  test('DM precedence, edit-added mentions notify once, assignment and task-comment mentions', async () => {
    const [dm] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind,participant_npubs) VALUES(${w1},${scope},'dm','dm',${[npubs[1]!, npubs[2]!]}::text[]) RETURNING id`;
    await grant(actors[1]!, dm!.id, 'channel.read'); await grant(actors[2]!, dm!.id, 'channel.read');
    await message(1, { channel: dm!.id, mentions: [2] });
    await drain();
    const dmItem = (await inbox(2, '?category=dm')).items[0];
    expect(dmItem.reasons.sort()).toEqual(['dm', 'mention']);
    expect(dmItem.category).toBe('dm');

    const t = await thread(1);
    const created = await message(1, { thread: t });
    await drain();
    const before = (await inbox(2)).items.length;
    // Revision adds a mention for carol-less bob: only the mention is delivered; readers get nothing new.
    const ob = await db`SELECT 1`; void ob;
    const rev = await message(1, { thread: t, kind: 'revised', added: [2] });
    await drain();
    const after = (await inbox(2)).items;
    expect(after.length).toBe(before + 1);
    expect((await inbox(0)).items.filter((i: any) => i.subject.thread_id === t)).toHaveLength(1); // only the creation
    await db`UPDATE flightdeck_pg_notification_intake SET state='pending', next_attempt_at=NOW() WHERE outbox_event_id=${rev.outboxId}`;
    await drain();
    expect((await inbox(2)).items.length).toBe(before + 1);
    void created;

    const tk = await task(1);
    await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch1},${actors[1]!},'flightdeck_pg.task_assignment.assigned','task_assignment',${tk},'assigned',${db.json({ task_id: tk, assignee_actor_id: actors[2] } as any)})`;
    const [comment] = await db`INSERT INTO flightdeck_pg_task_comments(workspace_id,scope_id,channel_id,task_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${w1},${scope},${ch1},${tk},'ping',${actors[1]!},${actors[1]!}) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch1},${actors[1]!},'flightdeck_pg.task_comment.created','task_comment',${comment!.id},'created',${db.json({ mentions: [mention(0)], activity_version: 4 } as any)})`;
    await drain();
    expect((await inbox(2, '?category=task_assignment')).items[0].action.target).toEqual({ kind: 'task', task_id: tk });
    expect((await inbox(0, '?category=comment_tag')).items[0].subject).toMatchObject({ kind: 'task', task_id: tk, comment_id: comment!.id });
  });

  test('doc comment structured mentions notify as comment_tag with the document target', async () => {
    await grant(actors[2]!, ch1, 'doc.read');
    const [obj] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,storage_path) VALUES(${npubs[0]!},${npubs[0]!},'text/markdown','notif/doc.md') RETURNING id`;
    const [doc] = await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,storage_object_id,title,created_by_actor_id,updated_by_actor_id,activity_version)
      VALUES(${w1},${scope},${ch1},${obj!.id},'Design doc',${actors[1]!},${actors[1]!},6) RETURNING id`;
    const [comment] = await db`INSERT INTO flightdeck_pg_doc_comments(workspace_id,scope_id,channel_id,doc_id,body,created_by_actor_id,updated_by_actor_id)
      VALUES(${w1},${scope},${ch1},${doc!.id},'see this',${actors[1]!},${actors[1]!}) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch1},${actors[1]!},'flightdeck_pg.doc_comment.created','doc_comment',${comment!.id},'created',${db.json({ mentions: [mention(2)], activity_version: 6 } as any)})`;
    await drain();
    const item = (await inbox(2, '?category=comment_tag')).items.find((i: any) => i.subject.doc_id === doc!.id);
    expect(item.action.target).toEqual({ kind: 'doc', doc_id: doc!.id, comment_id: comment!.id });
    expect(item.presentation.body).toBe('Design doc');
    expect(item.subject.activity_version).toBe(6);
  });

  test('observed-version read bridge: older view does not clear newer activity; born-read after view', async () => {
    const t = await thread(1, ch1, 10);
    await message(1, { thread: t, mentions: [2] });
    await drain();
    await db`UPDATE flightdeck_pg_threads SET activity_version=14 WHERE id=${t}`;
    await message(1, { thread: t, mentions: [2] });
    await drain();
    const find = async () => (await inbox(2)).items.find((i: any) => i.subject.thread_id === t && i.category === 'mention');
    let item = await find();
    expect(item.subject.activity_version).toBe(14);
    expect(item.group.event_count).toBe(2);
    const writeView = (viewed: number) => db`
      INSERT INTO flightdeck_pg_resource_view_states(workspace_id,viewer_actor_id,resource_type,resource_id,scope_id,channel_id,viewed_activity_version)
      VALUES(${w1},${actors[2]!},'thread',${t},${scope},${ch1},${viewed})
      ON CONFLICT (workspace_id,viewer_actor_id,resource_type,resource_id) DO UPDATE SET viewed_activity_version = GREATEST(flightdeck_pg_resource_view_states.viewed_activity_version, EXCLUDED.viewed_activity_version)`;
    await writeView(10);
    expect((await find()).state.read).toBe(false); // observed 10 < 14: newer activity stays unread
    await writeView(8); // stale device: monotone watermark
    expect((await find()).state.read).toBe(false);
    const seqBefore = item.change_seq;
    await writeView(14);
    item = await find();
    expect(item.state).toMatchObject({ read: true, read_reason: 'subject_viewed' });
    expect(item.change_seq).toBeGreaterThan(seqBefore);
    // Inbox read never advances the resource watermark.
    const [view] = await db`SELECT viewed_activity_version FROM flightdeck_pg_resource_view_states WHERE viewer_actor_id=${actors[2]!} AND resource_id=${t}`;
    expect(Number(view!.viewed_activity_version)).toBe(14);
    // Born read: activity <= viewed at projection time.
    await db`UPDATE flightdeck_pg_threads SET activity_version=15 WHERE id=${t}`;
    await writeView(20);
    await message(1, { thread: t, mentions: [2] });
    await drain();
    const born = (await inbox(2, '?view=all')).items.filter((i: any) => i.subject.thread_id === t && i.group.event_count === 1);
    expect(born[0].state).toMatchObject({ read: true, read_reason: 'already_viewed' });
    // Newer activity after the view stays unread.
    await db`UPDATE flightdeck_pg_threads SET activity_version=21 WHERE id=${t}`;
    await message(1, { thread: t, mentions: [2] });
    await drain();
    expect((await inbox(2, '?view=unread')).items.some((i: any) => i.subject.thread_id === t)).toBe(true);
  });

  test('cold start snapshot-then-replay converges while items change between pages', async () => {
    const client = new Map<string, any>();
    let local = 0;
    const apply = (c: any) => {
      if (c.change_type === 'remove') client.delete(c.id);
      else if (c.state.dismissed || c.state.archived) client.delete(c.id);
      else if (!client.has(c.id) || client.get(c.id).change_seq <= c.change_seq) client.set(c.id, c);
    };
    const first = (await n('/items?view=inbox&limit=2', 'GET', 2)).body;
    const snapshotSeq = first.head_seq;
    first.items.forEach(apply);
    // Concurrent activity after the snapshot: a new item, a dismissal of an already-listed one and a read.
    await message(1, { thread: await thread(1), mentions: [2] }); await drain();
    const victim = first.items[0];
    await n(`/items/${victim.id}`, 'PATCH', 2, { mutation_id: randomUUID(), expected_row_version: victim.row_version, patch: { dismissed: true } });
    let cursor = first.next_cursor;
    while (cursor) {
      const page = (await n(`/items?view=inbox&limit=2&cursor=${encodeURIComponent(cursor)}`, 'GET', 2)).body;
      page.items.forEach(apply); cursor = page.next_cursor;
    }
    local = snapshotSeq;
    for (;;) {
      const delta = (await n(`/changes?after_seq=${local}&limit=1`, 'GET', 2)).body;
      delta.changes.forEach(apply); local = delta.through_seq;
      if (!delta.has_more) break;
    }
    const truth = (await inbox(2, '?view=inbox&limit=100')).items;
    expect([...client.keys()].sort()).toEqual(truth.map((i: any) => i.id).sort());
    for (const item of truth) expect(client.get(item.id).row_version).toBe(item.row_version);
  });

  test('cursors are bound to workspace, actor, route and filter', async () => {
    for (let i = 0; i < 2; i++) { await message(1, { thread: await thread(1), mentions: [2] }); }
    await drain();
    const page = (await n('/items?limit=1', 'GET', 2)).body;
    expect(page.next_cursor).toBeTruthy();
    expect((await n(`/items?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`, 'GET', 2)).status).toBe(200);
    expect((await n(`/items?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`, 'GET', 0)).body.code).toBe('invalid_cursor');
    expect((await n(`/items?limit=1&view=unread&cursor=${encodeURIComponent(page.next_cursor)}`, 'GET', 2)).body.code).toBe('invalid_cursor');
    expect((await n(`/items?limit=1&cursor=${encodeURIComponent(page.next_cursor + 'x')}`, 'GET', 2)).body.code).toBe('invalid_cursor');
    expect((await n('/items?cursor=garbage', 'GET', 2)).status).toBe(400);
  });

  test('bulk: up_to_seq touches only the observed boundary, mutation replay is idempotent, ids are bounded', async () => {
    const unread = (await inbox(2, '?view=unread&limit=100')).items;
    expect(unread.length).toBeGreaterThan(2);
    const boundary = Math.max(...unread.slice(1).map((i: any) => i.change_seq));
    const newest = unread.reduce((a: any, b: any) => (a.change_seq > b.change_seq ? a : b));
    const mutation = randomUUID();
    const body = { mutation_id: mutation, op: 'mark_read', selector: { up_to_seq: boundary - 1 } };
    const first = await n('/bulk', 'POST', 2, body);
    expect(first.status).toBe(200);
    expect(first.body.affected).toBeGreaterThan(0);
    const stillUnread = (await inbox(2, '?view=unread&limit=100')).items;
    expect(stillUnread.some((i: any) => i.id === newest.id)).toBe(true);
    expect((await n('/bulk', 'POST', 2, body)).body).toMatchObject({ affected: first.body.affected, mutation_id: mutation });
    expect((await n('/bulk', 'POST', 2, { ...body, selector: { up_to_seq: 1 } })).body.code).toBe('mutation_id_reused');
    expect((await n('/bulk', 'POST', 2, { mutation_id: randomUUID(), op: 'dismiss', selector: { ids: Array.from({ length: 201 }, () => randomUUID()) } })).status).toBe(400);
    expect((await n('/bulk', 'POST', 2, { mutation_id: randomUUID(), op: 'explode', selector: { ids: [randomUUID()] } })).status).toBe(400);
    const archive = await n('/bulk', 'POST', 2, { mutation_id: randomUUID(), op: 'archive', selector: { ids: [newest.id, randomUUID()] } });
    expect(archive.body.affected).toBe(1);
    expect((await inbox(2, '?view=archived')).items.map((i: any) => i.id)).toContain(newest.id);
    expect((await inbox(2)).items.map((i: any) => i.id)).not.toContain(newest.id);
  });

  test('rules: inbox off suppresses creation, unknown categories rejected, alert rules mirror legacy preferences', async () => {
    const put = await n('/rules', 'PUT', 3, { mutation_id: randomUUID(), rules: [{ source_app_id: 'flightdeck.core', category: 'chat_thread', channel: 'inbox', mode: 'off', expected_row_version: 0 }] });
    expect(put.status).toBe(200); expect(put.body.rules).toHaveLength(1);
    expect((await n('/rules', 'PUT', 3, { mutation_id: randomUUID(), rules: [{ category: 'bogus', channel: 'inbox', mode: 'off', expected_row_version: 0 }] })).body.code).toBe('unknown_category');
    expect((await n('/rules', 'PUT', 3, { mutation_id: randomUUID(), rules: [{ category: 'mention', channel: 'inbox', mode: 'off', extra: 1, expected_row_version: 0 }] })).status).toBe(400);
    expect((await n('/rules', 'PUT', 3, { mutation_id: randomUUID(), rules: [{ category: 'mention', channel: 'inbox', mode: 'off' }] })).status).toBe(400); // expected_row_version is required
    await grant(actors[3]!, ch1, 'channel.read');
    await message(1, { thread: await thread(1) });
    await drain();
    expect((await inbox(3)).items.filter((i: any) => i.category === 'chat_thread' && i.subject.channel_id === ch1)).toHaveLength(0); // chat_thread inbox off
    await n('/rules', 'PUT', 1, { mutation_id: randomUUID(), rules: [{ source_app_id: 'flightdeck.core', category: 'mention', channel: 'alert', mode: 'off', expected_row_version: 0 }] });
    expect((await db`SELECT mentions_enabled FROM flightdeck_pg_notification_preferences WHERE actor_id=${actors[1]!} AND workspace_id=${w1}`)[0]!.mentions_enabled).toBe(false);
    const legacy = await call(`${base()}/notifications/preferences`, 'PATCH', 1, { dms_enabled: false });
    expect(legacy.status).toBe(200);
    const rules = (await n('/rules', 'GET', 1)).body.rules;
    expect(rules.find((r: any) => r.category === 'dm' && r.channel === 'alert').mode).toBe('off');
    const cats = (await n('/categories', 'GET', 1)).body.sources[0];
    expect(cats.app_id).toBe('flightdeck.core');
    expect(cats.categories.map((c: any) => c.category)).toContain('task_assignment');
    await db`DELETE FROM flightdeck_pg_notification_rules WHERE actor_id=${actors[3]!}`;
  });

  test('access loss is tombstoned immediately, content-free, before any background sweep', async () => {
    const t = await thread(1);
    await message(1, { thread: t, mentions: [2] });
    await drain();
    const item = (await inbox(2)).items.find((i: any) => i.subject.thread_id === t);
    const ack = { mutation_id: randomUUID(), expected_row_version: item.row_version, patch: { read: true } };
    expect((await n(`/items/${item.id}`, 'PATCH', 2, ack)).status).toBe(200);
    const head = (await n('/counts', 'GET', 2)).body;
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at = NOW() WHERE principal_actor_id=${actors[2]!} AND resource_channel_id=${ch1}`;
    // An exact retry after access loss must not replay the stored receipt (it embeds item content).
    const replay = await n(`/items/${item.id}`, 'PATCH', 2, ack);
    expect(replay.status).toBe(404);
    expect(JSON.stringify(replay.body)).not.toContain('"presentation"');
    const delta = (await n(`/changes?after_seq=${head.head_seq}`, 'GET', 2)).body;
    const tombstone = delta.changes.find((c: any) => c.id === item.id);
    expect(tombstone).toMatchObject({ schema: 'org.wingman.notification.tombstone', change_type: 'remove', removal_reason: 'access_lost' });
    expect(Object.keys(tombstone).sort()).toEqual(['change_seq', 'change_type', 'id', 'removal_reason', 'schema', 'version', 'workspace_id']);
    expect(delta.through_seq).toBeGreaterThan(head.head_seq); // invalidation changed the recovery context
    expect((await inbox(2, '?view=all&limit=100')).items.filter((i: any) => i.subject.channel_id === ch1)).toHaveLength(0);
    const listed = (await inbox(2, '?view=unread&limit=100')).items.length;
    expect((await n('/counts', 'GET', 2)).body.unread_total).toBe(listed); // count == list after revocation
    expect((await n(`/items/${item.id}`, 'GET', 2)).body.item.change_type).toBe('remove');
    const [stored] = await db`SELECT presentation, subject FROM flightdeck_pg_notification_items WHERE id=${item.id}`;
    expect(stored!.presentation).toEqual({});
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at = NULL WHERE principal_actor_id=${actors[2]!} AND resource_channel_id=${ch1}`;
  });

  test('deleted subjects disappear for the recipient', async () => {
    const t = await thread(1);
    await message(1, { thread: t, mentions: [2] });
    await drain();
    expect((await inbox(2)).items.some((i: any) => i.subject.thread_id === t)).toBe(true);
    await db`UPDATE flightdeck_pg_threads SET deleted_at = NOW() WHERE id=${t}`;
    expect((await inbox(2)).items.some((i: any) => i.subject?.thread_id === t)).toBe(false);
  });

  test('hint events are actor-private, content-free and hidden from managed audiences', async () => {
    const mine = await listVisibleFlightDeckPgEvents({ workspaceId: w1, actorId: actors[2]!, groupIds: [], afterRowVersion: 0, limit: 500 }, db);
    const hints = mine.filter((e) => e.entity_type === 'notification_item');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.every((e) => (e.payload as any).recipient_actor_id === actors[2])).toBe(true);
    expect(JSON.stringify(hints)).not.toMatch(/title|body|Alice/);
    const others = await listVisibleFlightDeckPgEvents({ workspaceId: w1, actorId: actors[3]!, groupIds: [], afterRowVersion: 0, limit: 500, includeWorkspaceEvents: true }, db);
    expect(others.some((e) => e.entity_type === 'notification_item' && (e.payload as any).recipient_actor_id !== actors[3])).toBe(false);
    const owner = await listVisibleFlightDeckPgEvents({ workspaceId: w1, actorId: actors[0]!, groupIds: [], afterRowVersion: 0, limit: 500, includeWorkspaceEvents: true }, db);
    expect(owner.some((e) => e.entity_type === 'notification_item' && (e.payload as any).recipient_actor_id === actors[2])).toBe(false);
  });

  // ---------------------------------------------------------------- external producers
  const producerCall = (path: string, method = 'GET', body?: unknown, w = w1, actor = 4) => call(`${base(w)}${path}`, method, actor, body);
  const eventBody = (o: Record<string, unknown> = {}) => ({
    schema: 'org.wingman.notification.event', version: 1, event_key: `k-${randomUUID()}`, category: 'capture_failed', severity: 'high',
    subject: { kind: 'app_object', app_id: 'blinkers', object_type: 'capture', object_id: 'c-1' },
    recipients: { mode: 'actors', actor_ids: [actors[1]] }, group_key: 'capture:c-1', ...o,
  });
  const sourceBody = (o: Record<string, unknown> = {}) => ({
    kind: 'app', display_name: 'Blinkers', producer_signer_npub: npubs[4], allowed_recipient_mode: 'actor_list',
    allowed_recipient_actor_ids: [actors[1], actors[2]], max_severity: 'high', rate_per_minute: 100,
    allowed_categories: [{ category: 'capture_failed', label: 'Capture failed' }], ...o,
  });

  test('producer grants: only effective workspace.manage registers sources; reserved ids/categories refused', async () => {
    const noGrant = await call(`${base()}/notification-sources/blinkers`, 'PUT', 1, sourceBody());
    expect(noGrant.status).toBe(403);
    expect(noGrant.body).toMatchObject({ code: 'permission_denied', required_permission: 'workspace.manage' });
    expect((await call(`${base()}/notification-sources/flightdeck.core`, 'PUT', 0, sourceBody())).body.code).toBe('reserved_source');
    expect((await call(`${base()}/notification-sources/blinkers`, 'PUT', 0, sourceBody({ allowed_categories: [{ category: 'mention', label: 'x' }] }))).body.code).toBe('reserved_source');
    const ok = await call(`${base()}/notification-sources/blinkers`, 'PUT', 0, sourceBody());
    expect(ok.status).toBe(200);
    expect(ok.body.source.categories[0].category).toBe('capture_failed');
    expect((await producerCall('/notification-producers/grants/me')).body.grant.source_app_id).toBe('blinkers');
    expect((await producerCall('/notification-producers/grants/me', 'GET', undefined, w1, 3)).status).toBe(403);
    expect((await producerCall('/notification-events', 'POST', eventBody(), w2, 4)).body.code).toBe('source_not_registered'); // no grant in workspace 2
  });

  test('producer ingest: validation, spoofing, recipient policy, replay and key reuse', async () => {
    const body = eventBody();
    const created = await producerCall('/notification-events', 'POST', body);
    expect(created.status).toBe(201);
    expect(created.body.replayed).toBe(false);
    const replay = await producerCall('/notification-events', 'POST', body);
    expect(replay.status).toBe(200);
    expect(replay.body.event.id).toBe(created.body.event.id);
    expect((await producerCall('/notification-events', 'POST', { ...body, severity: 'low' })).body.code).toBe('event_key_reused');
    expect((await producerCall('/notification-events', 'POST', eventBody({ source_app_id: 'flightdeck.core' }))).body.code).toBe('reserved_source');
    expect((await producerCall('/notification-events', 'POST', eventBody({ source_app_id: 'other' }))).body.code).toBe('source_mismatch');
    expect((await producerCall('/notification-events', 'POST', eventBody({ category: 'mention' }))).body.code).toBe('reserved_source');
    expect((await producerCall('/notification-events', 'POST', eventBody({ category: 'unlisted' }))).body.code).toBe('category_not_granted');
    expect((await producerCall('/notification-events', 'POST', eventBody({ recipients: { mode: 'actors', actor_ids: [actors[3]] } }))).body.code).toBe('recipient_not_allowed');
    expect((await producerCall('/notification-events', 'POST', eventBody({ severity: 'critical' }))).body.code).toBe('severity_not_allowed');
    expect((await producerCall('/notification-events', 'POST', eventBody({ subject: { kind: 'thread', thread_id: randomUUID() } }))).body.code).toBe('subject_kind_not_allowed');
    expect((await producerCall('/notification-events', 'POST', eventBody({ event_key: 'bad key!' }))).status).toBe(400);
    expect((await producerCall('/notification-events', 'POST', eventBody({ surprise: 1 }))).status).toBe(400);
    const big = await producerCall('/notification-events', 'POST', eventBody({ payload: 'x'.repeat(17000) }));
    expect(big.status).toBe(413);
    const text = await producerCall('/notification-events', 'POST', eventBody({ title: 'Reset your password at evil.example', presentation: { title: 'x' } }));
    expect(text.body.presentation_downgraded).toBe(true);
    expect((await producerCall(`/notification-events/${created.body.event.id}`)).body.event.event_key).toBe(body.event_key);
    expect((await producerCall(`/notification-events/${created.body.event.id}`, 'GET', undefined, w1, 3)).status).toBe(404);
  });

  test('producer events project to metadata-only items for allowed recipients only; two apps share one read state', async () => {
    await drain();
    const alice = await inbox(1, '?source_app_id=blinkers');
    expect(alice.items.length).toBeGreaterThan(0);
    const item = alice.items[0];
    expect(item.source).toEqual({ app_id: 'blinkers', label: 'Blinkers', kind: 'app' });
    expect(item.presentation).toMatchObject({ title: 'Blinkers', body: 'Capture failed' });
    expect(JSON.stringify(item)).not.toContain('evil.example');
    expect((await inbox(2, '?source_app_id=blinkers')).items).toHaveLength(0);
    expect((await n(`/items/${item.id}`, 'GET', 2)).status).toBe(404);
    // Same actor, "second app": a fresh reader starts from its own cursor yet sees the shared state.
    const appA = (await n('/counts', 'GET', 1)).body;
    await n(`/items/${item.id}`, 'PATCH', 1, { mutation_id: randomUUID(), expected_row_version: item.row_version, patch: { read: true } });
    const appB = (await n('/counts', 'GET', 1)).body;
    expect(appB.unread_total).toBe(appA.unread_total - 1);
    const delta = (await n(`/changes?after_seq=${appA.head_seq}`, 'GET', 1)).body;
    expect(delta.changes.find((c: any) => c.id === item.id).state.read).toBe(true);
    // audience restricted to another client app: excluded from the badge but still in the actor's inbox.
    await producerCall('/notification-events', 'POST', eventBody({ audience: { client_apps: ['blinkers'] }, group_key: 'aud-1' }));
    await drain();
    const counts = (await n('/counts', 'GET', 1)).body;
    expect(counts.unread_total - counts.badge).toBeGreaterThan(0);
  });

  test('resolve and withdraw are source-scoped; another source cannot touch the item', async () => {
    await call(`${base()}/notification-sources/watcher`, 'PUT', 0, sourceBody({ display_name: 'Watcher', producer_signer_npub: npubs[0]!, allowed_recipient_actor_ids: [actors[1]] }));
    const publish = eventBody({ group_key: 'job-7', recipients: { mode: 'actors', actor_ids: [actors[1]] } });
    await producerCall('/notification-events', 'POST', publish); await drain();
    const open = (await inbox(1, '?view=unread&source_app_id=blinkers')).items.find((i: any) => i.group.key === 'ext:job-7');
    expect(open).toBeTruthy();
    // watcher (a different source, signer = owner) resolving the same group key must not affect blinkers' item.
    await producerCall('/notification-events', 'POST', { schema: 'org.wingman.notification.event', version: 1, event_key: 'w-res', op: 'resolve', category: 'capture_failed', group_key: 'job-7' }, w1, 0);
    await drain();
    expect((await inbox(1, '?view=unread&source_app_id=blinkers')).items.some((i: any) => i.id === open.id)).toBe(true);
    const res = await producerCall('/notification-events', 'POST', { schema: 'org.wingman.notification.event', version: 1, event_key: 'b-res', op: 'resolve', category: 'capture_failed', group_key: 'job-7' });
    expect(res.status).toBe(201); await drain();
    const resolved = (await n(`/items/${open.id}`, 'GET', 1)).body.item;
    expect(resolved).toMatchObject({ status: 'resolved', state: { read: true, read_reason: 'resolved' } });
    const second = await producerCall('/notification-events', 'POST', eventBody({ group_key: 'job-8' }));
    await drain();
    const wd = await producerCall(`/notification-events/${second.body.event.id}/withdraw`, 'POST', {});
    expect(wd.status).toBe(201); await drain();
    const gone = (await inbox(1, '?source_app_id=blinkers&limit=100')).items.find((i: any) => i.group.key === 'ext:job-8');
    expect(gone).toBeUndefined();
    expect((await n('/changes?after_seq=0&limit=200', 'GET', 1)).body.changes.some((c: any) => c.removal_reason === 'withdrawn')).toBe(true);
  });

  test('rate limit, disable and revoke (content-free tombstones, new events refused immediately)', async () => {
    await call(`${base()}/notification-sources/blinkers`, 'PUT', 0, sourceBody({ rate_per_minute: 1 }));
    const limited = await producerCall('/notification-events', 'POST', eventBody());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    await call(`${base()}/notification-sources/blinkers`, 'PUT', 0, sourceBody({ rate_per_minute: 100 }));
    const live = (await inbox(1, '?source_app_id=blinkers&limit=100')).items;
    expect(live.length).toBeGreaterThan(0);
    const head = (await n('/counts', 'GET', 1)).body.head_seq;
    const ackBody = { mutation_id: randomUUID(), expected_row_version: live[0].row_version, patch: { read: true } };
    expect((await n(`/items/${live[0].id}`, 'PATCH', 1, ackBody)).status).toBe(200);
    const denied = await call(`${base()}/notification-sources/blinkers/revoke`, 'POST', 1, {});
    expect(denied.status).toBe(403); expect(denied.body.code).toBe('permission_denied');
    const revoked = await call(`${base()}/notification-sources/blinkers/revoke`, 'POST', 0, {});
    expect(revoked.body.tombstoned).toBe(live.length);
    expect((await producerCall('/notification-events', 'POST', eventBody())).body.code).toBe('source_not_active');
    const delta = (await n(`/changes?after_seq=${head}&limit=200`, 'GET', 1)).body.changes;
    expect(delta.filter((c: any) => c.removal_reason === 'source_revoked')).toHaveLength(live.length);
    expect(delta.every((c: any) => !c.presentation)).toBe(true);
    expect((await inbox(1, '?source_app_id=blinkers')).items).toHaveLength(0);
    const replay = await n(`/items/${live[0].id}`, 'PATCH', 1, ackBody); // exact retry must not return the stored content receipt
    expect(replay.status).toBe(404);
    expect(JSON.stringify(replay.body)).not.toContain('"presentation"');
    expect((await call(`${base()}/notification-sources/blinkers`, 'PUT', 0, sourceBody())).body.code).toBe('source_revoked');
  });

  test('concurrent workers projecting events for the same group converge on one folded item', async () => {
    const t = await thread(1);
    await message(1, { thread: t, mentions: [2] });
    await message(1, { thread: t, mentions: [2] });
    await message(1, { thread: t, mentions: [2] });
    await Promise.all([processIntakeBatch({ sql: db, limit: 1 }), processIntakeBatch({ sql: db, limit: 1 }), processIntakeBatch({ sql: db, limit: 1 })]);
    await db`UPDATE flightdeck_pg_notification_intake SET next_attempt_at = NOW()`;
    await drain();
    const mine = (await inbox(2, '?view=all&limit=100')).items.filter((i: any) => i.subject.thread_id === t && i.category === 'mention');
    expect(mine).toHaveLength(1);
    expect(mine[0].group.event_count).toBe(3);
    const seqs = await db`SELECT change_seq FROM flightdeck_pg_notification_items WHERE recipient_actor_id=${actors[2]!} AND workspace_id=${w1}`;
    expect(new Set(seqs.map((r) => String(r.change_seq))).size).toBe(seqs.length); // sequence stays unique per recipient
  });

  // ---------------------------------------------------------------- durability
  test('projection crash/restart: abandoned lease recovers once; rollback before commit leaves no partial item', async () => {
    const t = await thread(1);
    await message(1, { thread: t, mentions: [2] });
    // Worker A claims then "crashes" (never completes).
    const claimed = await claimIntake(db as any, 'worker-a', 5, 60);
    expect(claimed.length).toBeGreaterThan(0);
    expect((await processIntakeBatch({ sql: db, limit: 5 })).claimed).toBe(0); // lease still held
    await db`UPDATE flightdeck_pg_notification_intake SET lease_until = NOW() - INTERVAL '1 second' WHERE state='leased'`;
    // Worker B fails after writing but before commit: everything rolls back.
    const failed = await processIntakeBatch({ sql: db, limit: 5, beforeCommit: () => { throw new Error('simulated crash before commit'); } });
    expect(failed.failed).toBeGreaterThan(0);
    expect((await inbox(2)).items.some((i: any) => i.subject.thread_id === t)).toBe(false);
    const [row] = await db`SELECT state, attempt_count, last_error FROM flightdeck_pg_notification_intake WHERE state='pending' AND last_error IS NOT NULL LIMIT 1`;
    expect(row!.last_error).toContain('simulated crash');
    await db`UPDATE flightdeck_pg_notification_intake SET next_attempt_at = NOW()`;
    await drain();
    expect((await inbox(2)).items.filter((i: any) => i.subject.thread_id === t)).toHaveLength(1);
  });

  test('poison events dead-letter after bounded attempts and are observable to admins only', async () => {
    const [ob] = await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch1},${actors[1]!},'flightdeck_pg.message.created','message',${randomUUID()},'created','{}') RETURNING id`;
    await db`UPDATE flightdeck_pg_notification_intake SET attempt_count = 7 WHERE outbox_event_id=${ob!.id}`;
    const stats = await processIntakeBatch({ sql: db, beforeCommit: () => { throw new Error('poison'); } });
    expect(stats.dead).toBe(1);
    const queue = (await call(`${base()}/admin/notifications/queue`, 'GET', 0)).body.queue;
    expect(queue.dead).toBeGreaterThanOrEqual(1);
    expect(queue.worker).toHaveProperty('enabled');
    expect((await call(`${base()}/admin/notifications/queue`, 'GET', 1)).status).toBe(403);
  });

  test('the server-side worker really starts and projects without manual draining', async () => {
    Bun.env.NOTIF_POLL_MS = '50';
    startNotificationWorker(db as any);
    const t = await thread(1);
    await message(1, { thread: t, mentions: [2] });
    const deadline = Date.now() + 5000;
    let found = false;
    while (Date.now() < deadline && !found) {
      found = (await inbox(2)).items.some((i: any) => i.subject.thread_id === t);
      if (!found) await Bun.sleep(100);
    }
    stopNotificationWorker();
    expect(found).toBe(true);
    const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(entry).toMatch(/startNotificationWorker\(\);/);
  });

  test('retention: old read items expire to tombstones, tombstones are pruned and old cursors reset', async () => {
    const [victim] = (await inbox(2, '?view=all&limit=100')).items.filter((i: any) => i.state.read && i.source.app_id === 'flightdeck.core');
    await db`UPDATE flightdeck_pg_notification_items SET updated_at = NOW() - INTERVAL '120 days' WHERE id=${victim.id}`;
    expect((await runMaintenance(db as any)).tombstoned).toBeGreaterThanOrEqual(1);
    expect((await n(`/items/${victim.id}`, 'GET', 2)).body.item.removal_reason).toBe('expired');
    const [{ max }] = await db`SELECT MAX(change_seq) AS max FROM flightdeck_pg_notification_items WHERE removed_at IS NOT NULL AND recipient_actor_id=${actors[2]!}`;
    await db`UPDATE flightdeck_pg_notification_items SET removed_at = NOW() - INTERVAL '40 days' WHERE id=${victim.id}`;
    await runMaintenance(db as any);
    const [cursor] = await db`SELECT tombstone_floor_seq FROM flightdeck_pg_notification_cursors WHERE actor_id=${actors[2]!} AND workspace_id=${w1}`;
    expect(Number(cursor!.tombstone_floor_seq)).toBeGreaterThan(0);
    void max;
    const reset = await n('/changes?after_seq=0', 'GET', 2);
    expect(reset.status).toBe(410);
    expect(reset.body.code).toBe('reset_required');
  });

  // ---------------------------------------------------------------- legacy hardening + discovery
  test('legacy evaluate is workspace-bound and workspace.manage only; push endpoints cannot be taken over', async () => {
    const [foreign] = await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,operation,payload)
      VALUES(${w2},${scope2},${ch3},${actors[5]!},'flightdeck_pg.message.created','message','created','{}') RETURNING id`;
    expect((await call(`${base()}/notifications/evaluate`, 'POST', 0, { outbox_event_id: foreign!.id })).status).toBe(404);
    expect((await call(`${base()}/notifications/evaluate`, 'POST', 1, { outbox_event_id: foreign!.id })).status).toBe(403);
    expect((await call(`${base(w2)}/notifications/evaluate`, 'POST', 5, { outbox_event_id: foreign!.id })).status).toBe(200);
    const sub = { endpoint: 'https://push.example/endpoint-1', keys: { p256dh: 'p', auth: 'a' } };
    expect((await call(`${base()}/notifications/subscriptions`, 'POST', 1, sub)).status).toBe(201);
    expect((await call(`${base()}/notifications/subscriptions`, 'POST', 1, sub)).status).toBe(201); // own renewal
    const takeover = await call(`${base()}/notifications/subscriptions`, 'POST', 2, sub);
    expect(takeover.status).toBe(409);
    expect(takeover.body.code).toBe('transport_owned');
    expect((await db`SELECT actor_id FROM flightdeck_pg_push_subscriptions WHERE endpoint=${sub.endpoint}`)[0]!.actor_id).toBe(actors[1]);
  });

  test('descriptor advertises the capability; NIP-98 only; hosted flag can hide it', async () => {
    const descriptor = (await call(`${base()}/descriptor`, 'GET', 1)).body;
    expect(descriptor.capabilities).toContain('notifications_inbox_v1');
    expect(descriptor.notifications).toMatchObject({ inbox_v1: true, capability: 'notifications.inbox.v1', alerts: false, transports: [] });
    const unauth = await app.request(`${base()}/notifications/items`);
    expect(unauth.status).toBe(401);
    Bun.env.NOTIF_INBOX_API = 'off';
    expect((await n('/items', 'GET', 1)).body.code).toBe('notifications_not_enabled');
    expect((await call(`${base()}/descriptor`, 'GET', 1)).body.notifications.inbox_v1).toBe(false);
    delete Bun.env.NOTIF_INBOX_API;
  });
});
