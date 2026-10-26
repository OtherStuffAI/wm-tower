import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { processIntakeBatch, tombstoneItem } from '../src/services/notification-projector';
import { bulkMutate, patchItem } from '../src/services/notification-inbox';

// Contract v1.1: client_app_id views, rules CAS + rules_revision, effective workspace.manage, event parity,
// canonical lock order. Runs against a disposable Postgres: RECORD_TEST_PORT=<free port> bun test tests/notifications-contract-v11.test.ts
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('notification contract v1.1 against disposable Postgres', () => {
  const database = `notif_v11_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  // 0 manager (direct workspace.manage), 1 alice, 2 bob, 3 carol, 4 producer signer (not a member), 5 delegate (grant added/removed in test),
  // 6 group delegate, 7 role-admin without a grant
  const secrets = [301, 302, 303, 304, 305, 306, 307, 308].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((s) => nip19.npubEncode(getPublicKey(s)));
  let db: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createApp>;
  const actors: string[] = [];
  let w1: string, scope: string, ch1: string;
  const base = () => `/api/v4/flightdeck-pg/workspaces/${w1}`;

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
    return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
  }
  const n = (suffix: string, method = 'GET', actor = 0, body?: unknown) => call(`${base()}/notifications${suffix}`, method, actor, body);
  const drain = async () => { for (let i = 0; i < 20; i++) if ((await processIntakeBatch({ sql: db, limit: 50 })).claimed === 0) return; };
  const grant = (actor: string, channel: string, permission: string) =>
    db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w1},'actor',${actor},'channel',${channel},${permission})`;
  const manage = async (actor: string) => (await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${w1},'actor',${actor},'workspace','workspace.manage') RETURNING id`)[0]!.id as string;
  const items = async (actor: number, query = '') => (await n(`/items${query}`, 'GET', actor)).body;
  const ids = (body: any) => body.items.map((i: any) => i.id).sort();

  // --- external producer helpers (source "blinkers", signer = actor 4)
  const publish = (o: Record<string, unknown> = {}) => call(`${base()}/notification-events`, 'POST', 4, {
    schema: 'org.wingman.notification.event', version: 1, event_key: `k-${randomUUID()}`, category: 'capture_failed', severity: 'high',
    subject: { kind: 'app_object', app_id: 'blinkers', object_type: 'capture', object_id: 'c-1' },
    recipients: { mode: 'actors', actor_ids: [actors[1]] }, ...o,
  });

  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database, max: 20 });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    for (const npub of npubs) actors.push((await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id`)[0]!.id);
    await db`UPDATE flightdeck_pg_actors SET display_name = 'Alice' WHERE id = ${actors[1]!}`;
    w1 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-v11','service-v11',${npubs[0]!},'app','V11') RETURNING id`)[0]!.id;
    for (const [i, role] of ['owner', 'member', 'member', 'member', null, 'agent', 'member', 'admin'].entries()) {
      if (role) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w1},${actors[i]!},${role})`;
    }
    scope = (await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w1},'Main','project') RETURNING id`)[0]!.id;
    ch1 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'General') RETURNING id`)[0]!.id;
    for (const i of [0, 1, 2, 3]) for (const permission of ['channel.read', 'channel.write', 'task.read', 'task.create', 'task.update']) await grant(actors[i]!, ch1, permission);
    await manage(actors[0]!);
    setDb(db); app = createApp();
    const register = await call(`${base()}/notification-sources/blinkers`, 'PUT', 0, {
      kind: 'app', display_name: 'Blinkers', producer_signer_npub: npubs[4], allowed_recipient_mode: 'actor_list',
      allowed_recipient_actor_ids: [actors[1], actors[2], actors[3]], max_severity: 'high', rate_per_minute: 6000,
      allowed_categories: [{ category: 'capture_failed', label: 'Capture failed' }, { category: 'sync_error', label: 'Sync error' }],
    });
    expect(register.status).toBe(200);
  });
  afterAll(async () => {
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  });

  // ------------------------------------------------------------------------------------------------ A3 delegation
  test('A3: source/queue/evaluate need EFFECTIVE workspace.manage (direct or group grant), not a membership role', async () => {
    const paths = [['GET', '/notification-sources'], ['GET', '/admin/notifications/queue']] as const;
    for (const actor of [2, 7]) { // plain member; membership role "admin" without any grant
      for (const [method, path] of paths) {
        const denied = await call(`${base()}${path}`, method, actor);
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({ code: 'permission_denied', required_permission: 'workspace.manage' });
      }
      expect((await call(`${base()}/notifications/evaluate`, 'POST', actor, { outbox_event_id: randomUUID() })).status).toBe(403);
    }
    // Rick-style delegate: membership role "agent" + an effective grant.
    const directGrant = await manage(actors[5]!);
    for (const [method, path] of paths) expect((await call(`${base()}${path}`, method, 5)).status).toBe(200);
    expect((await call(`${base()}/notifications/evaluate`, 'POST', 5, { outbox_event_id: randomUUID() })).status).toBe(404); // authorised, event unknown
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at = NOW() WHERE id = ${directGrant}`;
    expect((await call(`${base()}/notification-sources`, 'GET', 5)).status).toBe(403);
    // Group grant is effective too.
    const [group] = await db`INSERT INTO flightdeck_pg_groups(workspace_id,name,kind) VALUES(${w1},'Notif managers','custom') RETURNING id`;
    await db`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${w1},${group!.id},${actors[6]!})`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,permission) VALUES(${w1},'group',${group!.id},'workspace','workspace.manage')`;
    expect((await call(`${base()}/notification-sources`, 'GET', 6)).status).toBe(200);
    // upsert validates allowed recipients are workspace members.
    const bad = await call(`${base()}/notification-sources/ghost`, 'PUT', 0, {
      kind: 'app', display_name: 'Ghost', producer_signer_npub: npubs[5], allowed_recipient_actor_ids: [randomUUID()], allowed_categories: [{ category: 'x', label: 'X' }],
    });
    expect(bad.status).toBe(400); expect(bad.body.code).toBe('recipient_not_member');
  });

  // ------------------------------------------------------------------------------------------------ A1 app views
  let evAll: string, evA: string, evB: string;
  test('A1: client_app_id view = audience ∧ effective inbox rule; list == count == badge predicate; shared item untouched', async () => {
    for (const body of [
      { group_key: 'g-all', audience: { client_apps: ['*'] } },
      { group_key: 'g-a', audience: { client_apps: ['app-a'] } },
      { group_key: 'g-b', category: 'sync_error', audience: { client_apps: ['app-b'] } },
    ]) expect((await publish(body)).status).toBe(201);
    await drain();
    const all = await items(1);
    expect(all.items).toHaveLength(3); // omitted => no app filtering
    evAll = all.items.find((i: any) => i.group.key === 'ext:g-all').id;
    evA = all.items.find((i: any) => i.group.key === 'ext:g-a').id;
    evB = all.items.find((i: any) => i.group.key === 'ext:g-b').id;
    const expectView = { 'app-a': [evAll, evA], 'app-b': [evAll, evB], 'app-c': [evAll] } as Record<string, string[]>;
    for (const [client, want] of Object.entries(expectView)) {
      const list = await items(1, `?client_app_id=${client}`);
      expect(ids(list)).toEqual([...want].sort());
      const counts = (await n(`/counts?client_app_id=${client}`, 'GET', 1)).body;
      expect(counts.unread_total).toBe(want.length); // list == count
      expect(list.counts.unread_total).toBe(want.length);
      expect(counts.badge).toBe(want.length); // severity high
      expect(Object.values(counts.by_source_app).reduce((a: number, b: any) => a + b, 0)).toBe(want.length);
    }
    expect((await n('/counts', 'GET', 1)).body.unread_total).toBe(3);
    expect((await n('/items?client_app_id=BAD*', 'GET', 1)).status).toBe(400);
  });

  test('A1: a per-client inbox:off rule hides only that app view; most specific key wins; shared row never changes', async () => {
    const before = (await db`SELECT row_version, read_at, removed_at, change_seq FROM flightdeck_pg_notification_items WHERE id = ${evA}`)[0]!;
    const state0 = (await n('/rules', 'GET', 1)).body;
    const put = await n('/rules', 'PUT', 1, { mutation_id: randomUUID(), rules: [
      { source_app_id: 'blinkers', category: 'capture_failed', client_app_id: 'app-a', channel: 'inbox', mode: 'off', expected_row_version: 0 },
    ] });
    expect(put.status).toBe(200);
    expect(put.body.rules_revision).toBe(state0.rules_revision + 1);
    expect(ids(await items(1, '?client_app_id=app-a'))).toEqual([]);
    expect(ids(await items(1, '?client_app_id=app-b'))).toEqual([evAll, evB].sort()); // other apps still see the shared item
    expect(ids(await items(1))).toEqual([evAll, evA, evB].sort()); // unfiltered view unchanged
    expect((await n('/counts?client_app_id=app-a', 'GET', 1)).body.unread_total).toBe(0);
    const after = (await db`SELECT row_version, read_at, removed_at, change_seq FROM flightdeck_pg_notification_items WHERE id = ${evA}`)[0]!;
    expect(after).toEqual(before); // never read/deleted/tombstoned/versioned by a view rule
    // Specificity: (src,*) '*' off hides everything of the source, (src,cat) for app-b 'on' re-shows capture_failed only for app-b.
    const s1 = (await n('/rules', 'GET', 1)).body;
    const put2 = await n('/rules', 'PUT', 1, { mutation_id: randomUUID(), rules: [
      { source_app_id: 'blinkers', category: '*', client_app_id: '*', channel: 'inbox', mode: 'off', expected_row_version: 0 },
      { source_app_id: 'blinkers', category: 'sync_error', client_app_id: 'app-b', channel: 'inbox', mode: 'on', expected_row_version: 0 },
    ] });
    expect(put2.status).toBe(200); expect(put2.body.rules_revision).toBe(s1.rules_revision + 1);
    expect(ids(await items(1, '?client_app_id=app-b'))).toEqual([evB]); // (src,sync_error,app-b)=on beats (src,*,*)=off; capture_failed hidden
    expect(ids(await items(1, '?client_app_id=app-c'))).toEqual([]);
    expect((await n('/counts?client_app_id=app-b', 'GET', 1)).body.unread_total).toBe(1);
    // '*' client rule 'off' also stops NEW shared items for the recipient (projection honours only '*' rules).
    expect((await publish({ group_key: 'g-new', audience: { client_apps: ['*'] } })).status).toBe(201);
    await drain();
    expect(await db`SELECT 1 FROM flightdeck_pg_notification_items WHERE recipient_actor_id = ${actors[1]!} AND group_key = 'ext:g-new'`).toHaveLength(0);
    // Restore: inherit both rows (versioned rows are kept) and the full view returns.
    const s2 = (await n('/rules', 'GET', 1)).body;
    const rv = (c: string, cat: string, client: string) => s2.rules.find((r: any) => r.source_app_id === 'blinkers' && r.category === cat && r.client_app_id === client && r.channel === 'inbox').row_version;
    const back = await n('/rules', 'PUT', 1, { mutation_id: randomUUID(), rules: [
      { source_app_id: 'blinkers', category: 'capture_failed', client_app_id: 'app-a', channel: 'inbox', mode: 'default', expected_row_version: rv('', 'capture_failed', 'app-a') },
      { source_app_id: 'blinkers', category: '*', client_app_id: '*', channel: 'inbox', mode: 'default', expected_row_version: rv('', '*', '*') },
      { source_app_id: 'blinkers', category: 'sync_error', client_app_id: 'app-b', channel: 'inbox', mode: 'default', expected_row_version: rv('', 'sync_error', 'app-b') },
    ] });
    expect(back.status).toBe(200);
    expect(ids(await items(1, '?client_app_id=app-a'))).toEqual([evAll, evA].sort());
  });

  test('A1: changes?client_app_id filters live rows, always carries tombstones, advances through_seq over filtered pages, resets on rules_revision', async () => {
    const snap = await items(2);
    const S = snap.head_seq, R = snap.rules_revision;
    expect(R).toBe((await n('/rules', 'GET', 2)).body.rules_revision);
    // New app-b-only item for Bob.
    expect((await publish({ recipients: { mode: 'actors', actor_ids: [actors[2]] }, group_key: 'g-bob-b', audience: { client_apps: ['app-b'] } })).status).toBe(201);
    await drain();
    const forA = (await n(`/changes?after_seq=${S}&client_app_id=app-a&rules_revision=${R}`, 'GET', 2)).body;
    expect(forA.changes).toEqual([]);
    expect(forA.has_more).toBe(false);
    expect(forA.through_seq).toBe(forA.head_seq); // a page that filtered everything still advances
    expect(forA.head_seq).toBeGreaterThan(S);
    expect(forA.rules_revision).toBe(R);
    const forB = (await n(`/changes?after_seq=${S}&client_app_id=app-b&rules_revision=${R}`, 'GET', 2)).body;
    expect(forB.changes).toHaveLength(1);
    const bobItem = forB.changes[0];
    expect(bobItem.audience.client_apps).toEqual(['app-b']);
    // Page boundary: full page advances to its last row only.
    for (const g of ['p1', 'p2']) await publish({ recipients: { mode: 'actors', actor_ids: [actors[2]] }, group_key: g, audience: { client_apps: ['app-b'] } });
    await drain();
    const page1 = (await n(`/changes?after_seq=${S}&client_app_id=app-b&limit=2`, 'GET', 2)).body;
    expect(page1.has_more).toBe(true);
    expect(page1.through_seq).toBe(Math.max(...page1.changes.map((c: any) => c.change_seq)));
    // Tombstones are content-free and always included, even for a client that could never see the item.
    const t = await db.begin((tx) => tombstoneItem(tx as any, w1, actors[2]!, bobItem.id, 'withdrawn'));
    expect(t).toBeGreaterThan(0);
    const forC = (await n(`/changes?after_seq=${page1.head_seq}&client_app_id=app-c`, 'GET', 2)).body;
    expect(forC.changes.map((c: any) => [c.id, c.schema])).toEqual([[bobItem.id, 'org.wingman.notification.tombstone']]);
    expect(JSON.stringify(forC.changes)).not.toMatch(/presentation|Blinkers/);
    // rules_revision reset.
    const rule = (await n('/rules', 'GET', 2)).body;
    expect((await n('/rules', 'PUT', 2, { mutation_id: randomUUID(), rules: [{ source_app_id: 'blinkers', category: 'sync_error', client_app_id: 'app-z', channel: 'inbox', mode: 'off', expected_row_version: 0 }] })).status).toBe(200);
    const reset = await n(`/changes?after_seq=${forC.head_seq}&client_app_id=app-a&rules_revision=${rule.rules_revision}`, 'GET', 2);
    expect(reset.status).toBe(410);
    expect(reset.body).toMatchObject({ code: 'reset_required', reason: 'rules_changed', rules_revision: rule.rules_revision + 1 });
    expect((await n(`/changes?after_seq=${forC.head_seq}`, 'GET', 2)).status).toBe(200); // optional param
    expect((await n(`/changes?after_seq=${forC.head_seq + 99}`, 'GET', 2)).body.reason).toBe('ahead');
    await db`UPDATE flightdeck_pg_notification_cursors SET tombstone_floor_seq = ${forC.head_seq} WHERE workspace_id = ${w1} AND actor_id = ${actors[2]!}`;
    expect((await n(`/changes?after_seq=0`, 'GET', 2)).body.reason).toBe('tombstone_floor');
    await db`UPDATE flightdeck_pg_notification_cursors SET tombstone_floor_seq = 0 WHERE workspace_id = ${w1} AND actor_id = ${actors[2]!}`;
  });

  test('A1: bulk selector.client_app_id only touches items visible to that client', async () => {
    const head = (await n('/counts', 'GET', 1)).body.head_seq;
    const res = await n('/bulk', 'POST', 1, { mutation_id: randomUUID(), op: 'mark_read', selector: { up_to_seq: head, view: 'unread', client_app_id: 'app-b' } });
    expect(res.status).toBe(200);
    expect(res.body.affected).toBe(2); // g-all + g-b; g-a (app-a only) untouched
    const unread = await items(1, '?view=unread');
    expect(ids(unread)).toEqual([evA]);
    const byIds = await n('/bulk', 'POST', 1, { mutation_id: randomUUID(), op: 'mark_read', selector: { ids: [evA], client_app_id: 'app-b' } });
    expect(byIds.body.affected).toBe(0); // id exists but is not visible to app-b
    expect((await n('/bulk', 'POST', 1, { mutation_id: randomUUID(), op: 'mark_read', selector: { ids: [evA], client_app_id: 'app-a' } })).body.affected).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------ A2 CAS
  test('A2: per-key CAS is atomic; default keeps a versioned row; stale expected 0 cannot resurrect; replay and reuse', async () => {
    const mk = (over: Record<string, unknown>) => ({ source_app_id: 'flightdeck.core', channel: 'inbox', client_app_id: '*', ...over });
    const s0 = (await n('/rules', 'GET', 3)).body;
    expect(s0.rules).toEqual([]);
    const mutation = randomUUID();
    const body = { mutation_id: mutation, rules: [mk({ category: 'mention', mode: 'off', expected_row_version: 0 }), mk({ category: 'dm', mode: 'off', expected_row_version: 0 })] };
    const ok = await n('/rules', 'PUT', 3, body);
    expect(ok.status).toBe(200);
    expect(ok.body.rules.map((r: any) => [r.category, r.mode, r.row_version])).toEqual([['dm', 'off', 1], ['mention', 'off', 1]]);
    expect(ok.body.rules_revision).toBe(s0.rules_revision + 1);
    // Replay of the identical request: stored response, no second bump.
    const replay = await n('/rules', 'PUT', 3, body);
    expect(replay.status).toBe(200); expect(replay.body.rules).toEqual(ok.body.rules); expect(replay.body.rules_revision).toBe(ok.body.rules_revision);
    expect((await n('/rules', 'GET', 3)).body.rules_revision).toBe(ok.body.rules_revision);
    // Same mutation_id, different body.
    const reused = await n('/rules', 'PUT', 3, { ...body, rules: [mk({ category: 'mention', mode: 'on', expected_row_version: 0 })] });
    expect(reused.status).toBe(409); expect(reused.body.code).toBe('mutation_id_reused');
    // All-or-nothing: one fresh key (expected 0 ok), one stale key.
    const conflict = await n('/rules', 'PUT', 3, { mutation_id: randomUUID(), rules: [
      mk({ category: 'comment_tag', mode: 'off', expected_row_version: 0 }), mk({ category: 'mention', mode: 'on', expected_row_version: 0 }),
    ] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('rules_conflict');
    expect(conflict.body.conflicts).toHaveLength(1);
    expect(conflict.body.conflicts[0]).toMatchObject({ category: 'mention', expected_row_version: 0, current: { mode: 'off', row_version: 1 } });
    expect(conflict.body.rules).toEqual(ok.body.rules);
    expect(conflict.body.rules_revision).toBe(ok.body.rules_revision);
    const afterConflict = (await n('/rules', 'GET', 3)).body;
    expect(afterConflict.rules).toEqual(ok.body.rules); // comment_tag NOT written
    expect(afterConflict.rules_revision).toBe(ok.body.rules_revision);
    // default: needs an existing row; keeps it, bumps its row_version, resolves as inherited.
    expect((await n('/rules', 'PUT', 3, { mutation_id: randomUUID(), rules: [mk({ category: 'comment_tag', mode: 'default', expected_row_version: 0 })] })).status).toBe(400);
    expect((await n('/rules', 'PUT', 3, { mutation_id: randomUUID(), rules: [mk({ category: 'mention', mode: 'on', expected_row_version: 1 }), mk({ category: 'mention', mode: 'off', expected_row_version: 1 })] })).status).toBe(400); // repeated key
    const def = await n('/rules', 'PUT', 3, { mutation_id: randomUUID(), rules: [mk({ category: 'mention', mode: 'default', expected_row_version: 1 })] });
    expect(def.status).toBe(200);
    const row = def.body.rules.find((r: any) => r.category === 'mention');
    expect(row).toMatchObject({ mode: 'default', row_version: 2 });
    expect(await db`SELECT 1 FROM flightdeck_pg_notification_rules WHERE actor_id = ${actors[3]!} AND category = 'mention' AND mode = 'default'`).toHaveLength(1); // never physically deleted
    // A stale client still holding "absent" (expected 0) must conflict, not resurrect the override.
    const stale = await n('/rules', 'PUT', 3, { mutation_id: randomUUID(), rules: [mk({ category: 'mention', mode: 'off', expected_row_version: 0 })] });
    expect(stale.status).toBe(409);
    expect(stale.body.conflicts[0].current).toMatchObject({ mode: 'default', row_version: 2 });
    // Inherited mode no longer suppresses projection.
    const t = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${w1},${scope},${ch1},'Dflt',${actors[1]!},${actors[1]!}) RETURNING id`;
    const m = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${w1},${scope},${ch1},${t[0]!.id},'x',${actors[1]!},${actors[1]!}) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch1},${actors[1]!},'flightdeck_pg.message.created','message',${m[0]!.id},'created',${db.json({ mentions: [{ type: 'agent', actor_id: actors[3], npub: npubs[3] }] } as any)})`;
    await drain();
    expect((await items(3)).items.some((i: any) => i.category === 'mention')).toBe(true);
  });

  test('A2: legacy PATCH /notifications/preferences mirrors in ONE transaction, bumps row_version + rules_revision, fails atomically', async () => {
    const before = (await n('/rules', 'GET', 2)).body;
    const legacy = await call(`${base()}/notifications/preferences`, 'PATCH', 2, { dms_enabled: false });
    expect(legacy.status).toBe(200);
    const mid = (await n('/rules', 'GET', 2)).body;
    expect(mid.rules_revision).toBe(before.rules_revision + 1);
    const dm = mid.rules.find((r: any) => r.category === 'dm' && r.channel === 'alert');
    expect(dm).toMatchObject({ mode: 'off', row_version: 1 });
    // A client holding the old row_version conflicts and refetches.
    const again = await call(`${base()}/notifications/preferences`, 'PATCH', 2, { dms_enabled: true });
    expect(again.status).toBe(200);
    const stale = await n('/rules', 'PUT', 2, { mutation_id: randomUUID(), rules: [{ source_app_id: 'flightdeck.core', category: 'dm', channel: 'alert', client_app_id: '*', mode: 'off', expected_row_version: dm.row_version }] });
    expect(stale.status).toBe(409); expect(stale.body.code).toBe('rules_conflict');
    // Mirror failure must roll back the legacy boolean (no catch-and-log divergence).
    await db.unsafe(`CREATE OR REPLACE FUNCTION notif_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'mirror down'; END $$`);
    await db.unsafe(`CREATE TRIGGER notif_test_fail BEFORE INSERT OR UPDATE ON flightdeck_pg_notification_rules FOR EACH ROW EXECUTE FUNCTION notif_test_fail()`);
    try {
      const revBefore = (await n('/rules', 'GET', 2)).body.rules_revision;
      const failed = await call(`${base()}/notifications/preferences`, 'PATCH', 2, { mentions_enabled: false });
      expect(failed.status).toBe(500);
      expect((await db`SELECT mentions_enabled FROM flightdeck_pg_notification_preferences WHERE workspace_id = ${w1} AND actor_id = ${actors[2]!}`)[0]!.mentions_enabled).toBe(true);
      expect((await n('/rules', 'GET', 2)).body.rules_revision).toBe(revBefore);
    } finally {
      await db.unsafe('DROP TRIGGER notif_test_fail ON flightdeck_pg_notification_rules'); await db.unsafe('DROP FUNCTION notif_test_fail()');
    }
    // PUT of an alert 'default' restores the registry default in the legacy boolean.
    const cur = (await n('/rules', 'GET', 2)).body.rules.find((r: any) => r.category === 'dm' && r.channel === 'alert');
    expect((await n('/rules', 'PUT', 2, { mutation_id: randomUUID(), rules: [{ source_app_id: 'flightdeck.core', category: 'dm', channel: 'alert', client_app_id: '*', mode: 'default', expected_row_version: cur.row_version }] })).status).toBe(200);
    expect((await db`SELECT dms_enabled FROM flightdeck_pg_notification_preferences WHERE workspace_id = ${w1} AND actor_id = ${actors[2]!}`)[0]!.dms_enabled).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------ B5 event parity (real routes)
  const mentionOf = (i: number) => ({ type: 'agent', npub: npubs[i], label: `U${i}` });
  const inboxCats = async (actor: number) => (await items(actor, '?view=all&limit=100')).items;
  test('B5: message created/revised outbox events (emitter-shaped payloads): structured mentions only; text-only edit adds nothing', async () => {
    // Message routes require a signed message envelope, so these rows are shaped exactly like the emitter's outbox payloads
    // (message.created {mentions}, message.revised {newly_added_mentions}); task routes below run through the real HTTP handlers.
    const [t] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${w1},${scope},${ch1},'Parity',${actors[1]!},${actors[1]!}) RETURNING id`;
    const [m] = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${w1},${scope},${ch1},${t!.id},'hello team',${actors[1]!},${actors[1]!}) RETURNING id`;
    const emit = (type: string, payload: unknown) => db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch1},${actors[1]!},${type},'message',${m!.id},'created',${db.json(payload as any)})`;
    const forMessage = async (actor: number) => (await inboxCats(actor)).filter((i: any) => i.subject.message_id === m!.id);
    const asMention = (i: number) => ({ type: 'agent', actor_id: actors[i], npub: npubs[i], label: `U${i}` });
    await emit('flightdeck_pg.message.created', { mentions: [asMention(2)] });
    await drain();
    const bob = await forMessage(2);
    expect(bob).toHaveLength(1); expect(bob[0].category).toBe('mention');
    expect(JSON.stringify(bob)).not.toContain('hello team');
    await emit('flightdeck_pg.message.revised', { mentions: [asMention(2)], newly_added_mentions: [] });
    await drain();
    expect((await forMessage(2))[0].group.event_count).toBe(1);
    expect((await forMessage(3)).filter((i: any) => i.reasons.includes('mention'))).toHaveLength(0);
    await emit('flightdeck_pg.message.revised', { mentions: [asMention(2), asMention(3)], newly_added_mentions: [asMention(3)] });
    await drain();
    expect((await forMessage(3)).filter((i: any) => i.reasons.includes('mention'))).toHaveLength(1);
    expect((await forMessage(2))[0].group.event_count).toBe(1);
  });

  let taskId: string;
  test('B5: task metadata assignment (create/update) notifies the assignee once; explicit assign route does not duplicate', async () => {
    const created = await call(`${base()}/channels/${ch1}/tasks`, 'POST', 1, { title: 'Ship v1.1', metadata: { assigned_to_npub: npubs[2] }, mentions: [mentionOf(3)] });
    expect(created.status).toBe(201);
    taskId = created.body.task.id;
    await drain();
    const bob = (await inboxCats(2)).filter((i: any) => i.subject.task_id === taskId);
    expect(bob).toHaveLength(1);
    expect(bob[0]).toMatchObject({ category: 'task_assignment', group: { event_count: 1 } });
    expect(bob[0].presentation.title).toBe('Alice assigned you a task');
    const carol = (await inboxCats(3)).filter((i: any) => i.subject.task_id === taskId);
    expect(carol).toHaveLength(1); expect(carol[0].category).toBe('mention');
    // Explicit assignment route for the same person: absorbed by the open item (ONE item, ONE count).
    const explicit = await call(`${base()}/tasks/${taskId}/assignments`, 'POST', 1, { actor_id: actors[2] });
    expect([200, 201]).toContain(explicit.status);
    await drain();
    const bob2 = (await inboxCats(2)).filter((i: any) => i.subject.task_id === taskId);
    expect(bob2).toHaveLength(1); expect(bob2[0].group.event_count).toBe(1);
    expect((await n('/counts', 'GET', 2)).body.by_category.task_assignment).toBe(1);
    // Update that keeps the assignee and the mentions: nothing new. Reassign to Carol: Carol gets an assignment, Bob none.
    const cur = (await call(`${base()}/tasks/${taskId}`, 'GET', 1)).body.task;
    const same = await call(`${base()}/tasks/${taskId}`, 'PATCH', 1, { title: 'Ship v1.1 now', row_version: cur.row_version });
    expect(same.status).toBe(200);
    await drain();
    expect((await inboxCats(2)).filter((i: any) => i.subject.task_id === taskId)).toHaveLength(1);
    expect((await inboxCats(3)).filter((i: any) => i.subject.task_id === taskId)).toHaveLength(1);
    const re = await call(`${base()}/tasks/${taskId}`, 'PATCH', 1, { metadata: { assigned_to_npub: npubs[3] }, row_version: same.body.task.row_version });
    expect(re.status).toBe(200);
    await drain();
    const carol2 = (await inboxCats(3)).filter((i: any) => i.subject.task_id === taskId);
    expect(carol2.map((i: any) => i.category).sort()).toEqual(['mention', 'task_assignment']);
    expect((await inboxCats(2)).filter((i: any) => i.subject.task_id === taskId)).toHaveLength(1); // not re-notified
  });

  test('B5: document body mention captured once; document_comment_mention_added is NOT captured (doc_comment.created carries mentions)', async () => {
    const [obj] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,storage_path) VALUES(${npubs[1]!},${npubs[1]!},'text/markdown','p/doc') RETURNING id`;
    const [doc] = await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,storage_object_id,title,created_by_actor_id,updated_by_actor_id,activity_version)
      VALUES(${w1},${scope},${ch1},${obj!.id},'Design notes',${actors[1]!},${actors[1]!},4) RETURNING id`;
    const emit = (type: string, payload: unknown, entity = doc!.id) => db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch1},${actors[1]!},${type},'doc',${entity},'updated',${db.json(payload as any)}) RETURNING id`;
    const mention = { type: 'agent', actor_id: actors[2], npub: npubs[2] };
    const [body] = await emit('flightdeck_pg.document_mention_added', { trigger: 'document_mention_added', document_id: doc!.id, doc_id: doc!.id, added_mentions: [mention] });
    const [dup] = await emit('flightdeck_pg.document_comment_mention_added', { trigger: 'document_comment_mention_added', document_id: doc!.id, doc_id: doc!.id, added_mentions: [mention] });
    expect(await db`SELECT 1 FROM flightdeck_pg_notification_intake WHERE outbox_event_id = ${body!.id}`).toHaveLength(1);
    expect(await db`SELECT 1 FROM flightdeck_pg_notification_intake WHERE outbox_event_id = ${dup!.id}`).toHaveLength(0);
    await drain();
    const bobDocs = (await inboxCats(2)).filter((i: any) => i.subject.doc_id === doc!.id);
    expect(bobDocs).toHaveLength(1);
    expect(bobDocs[0]).toMatchObject({ category: 'mention', subject: { kind: 'doc' }, action: { target: { kind: 'doc', doc_id: doc!.id } } });
    expect(bobDocs[0].presentation.title).toBe('Alice mentioned you');
    // An ACL hole (no doc read) never leaks: Carol was not mentioned and gets nothing.
    expect((await inboxCats(3)).filter((i: any) => i.subject.doc_id === doc!.id)).toHaveLength(0);
    // Doc comment path: one item for the mentioned recipient.
    const [comment] = await db`INSERT INTO flightdeck_pg_doc_comments(workspace_id,scope_id,channel_id,doc_id,body,created_by_actor_id,updated_by_actor_id)
      VALUES(${w1},${scope},${ch1},${doc!.id},'see this',${actors[1]!},${actors[1]!}) RETURNING id`;
    await emit('flightdeck_pg.doc_comment.created', { mentions: [{ type: 'agent', actor_id: actors[3], npub: npubs[3] }], activity_version: 5 }, comment!.id);
    await emit('flightdeck_pg.document_comment_mention_added', { trigger: 'document_comment_mention_added', added_mentions: [{ type: 'agent', actor_id: actors[3], npub: npubs[3] }] }, comment!.id);
    await drain();
    const carolComment = (await inboxCats(3)).filter((i: any) => i.subject.comment_id === comment!.id);
    expect(carolComment).toHaveLength(1); expect(carolComment[0].category).toBe('comment_tag');
  });

  // ------------------------------------------------------------------------------------------------ folding + privacy
  test('B4: events with different audience sets never fold; resolve covers both; tombstone scrubs identifying columns', async () => {
    const mkEvent = (audience: string[], key: string) => publish({ event_key: key, group_key: 'job-9', audience: { client_apps: audience }, recipients: { mode: 'actors', actor_ids: [actors[1]] } });
    expect((await mkEvent(['app-a'], 'aud-1')).status).toBe(201);
    expect((await mkEvent(['app-a'], 'aud-2')).status).toBe(201); // same audience folds
    expect((await mkEvent(['app-b'], 'aud-3')).status).toBe(201); // different audience: separate item
    expect((await mkEvent(['app-b', 'app-a'], 'aud-4')).status).toBe(201); // canonical set {a,b}: yet another item
    expect((await mkEvent(['app-a', 'app-b'], 'aud-5')).status).toBe(201); // same canonical set folds into aud-4
    await drain();
    const open = (await items(1, '?view=unread&source_app_id=blinkers')).items.filter((i: any) => i.group.key === 'ext:job-9');
    expect(open.map((i: any) => [i.audience.client_apps.join(','), i.group.event_count]).sort()).toEqual([['app-a', 2], ['app-a,app-b', 2], ['app-b', 1]]);
    const resolve = await publish({ event_key: 'aud-res', op: 'resolve', group_key: 'job-9', recipients: { mode: 'actors', actor_ids: [actors[1]] } });
    expect(resolve.status).toBe(201);
    await drain();
    const resolved = (await items(1, '?view=all&source_app_id=blinkers&limit=100')).items.filter((i: any) => i.group.key === 'ext:job-9');
    expect(resolved.every((i: any) => i.status === 'resolved' && i.state.read)).toBe(true);
    // Scrub on tombstone.
    const target = resolved[0].id;
    await db.begin((tx) => tombstoneItem(tx as any, w1, actors[1]!, target, 'withdrawn'));
    const [row] = await db`SELECT trigger_actor_id, resource_id, acl_channel_id, acl_family, group_key, reasons, presentation, action, subject, removal_reason FROM flightdeck_pg_notification_items WHERE id = ${target}`;
    expect(row).toMatchObject({ trigger_actor_id: null, resource_id: null, acl_channel_id: null, acl_family: null, group_key: null, reasons: [], presentation: {}, action: null, subject: { kind: 'app_object' }, removal_reason: 'withdrawn' });
    expect(await db.begin((tx) => tombstoneItem(tx as any, w1, actors[1]!, target, 'withdrawn'))).toBeNull(); // already removed: no sequence burned
  });

  // ------------------------------------------------------------------------------------------------ B4 locks
  test('B4: PATCH / bulk running concurrently with tombstone on the same recipient never deadlock (canonical lock order)', async () => {
    const N = 10;
    for (let i = 0; i < N; i++) await publish({ group_key: `lock-${i}`, recipients: { mode: 'actors', actor_ids: [actors[2]] } });
    await drain();
    const mine = (await items(2, '?view=unread&limit=100')).items.filter((i: any) => i.group.key?.startsWith('ext:lock-'));
    expect(mine).toHaveLength(N);
    const r = { workspaceId: w1, actorId: actors[2]! };
    const results = await Promise.allSettled([
      ...mine.flatMap((it: any, i: number) => [
        patchItem(db as any, r, { id: it.id, mutationId: randomUUID(), expectedRowVersion: it.row_version, patch: { read: true } }),
        db.begin((tx) => tombstoneItem(tx as any, w1, actors[2]!, it.id, i % 2 ? 'expired' : 'access_lost')),
      ]),
      bulkMutate(db as any, r, { mutationId: randomUUID(), op: 'archive', upToSeq: 1_000_000, view: 'inbox' }),
      bulkMutate(db as any, r, { mutationId: randomUUID(), op: 'mark_read', upToSeq: 1_000_000, view: 'inbox' }),
    ]);
    const deadlocks = results.filter((x) => x.status === 'rejected' && /deadlock|40P01/i.test(String((x as any).reason?.message ?? (x as any).reason?.code)));
    expect(deadlocks).toHaveLength(0);
    // Only domain outcomes: 404 for a patch that lost the race to a tombstone, 409 for one that lost to a bulk change.
    for (const x of results) if (x.status === 'rejected') expect(['notification_not_found', 'state_conflict']).toContain((x as any).reason.code);
    for (const it of mine) expect((await db`SELECT removed_at FROM flightdeck_pg_notification_items WHERE id = ${it.id}`)[0]!.removed_at).not.toBeNull();
  });

  const viewState = (actor: number, resource: string, version: number) => db`
    INSERT INTO flightdeck_pg_resource_view_states(workspace_id,viewer_actor_id,resource_type,resource_id,scope_id,channel_id,viewed_activity_version)
    VALUES(${w1},${actors[actor]!},'thread',${resource},${scope},${ch1},${version})
    ON CONFLICT (workspace_id,viewer_actor_id,resource_type,resource_id) DO UPDATE SET viewed_activity_version = EXCLUDED.viewed_activity_version`;
  async function projectMessageWhileViewing(viewedVersion: number, eventVersion: number) {
    const [t] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id,activity_version) VALUES(${w1},${scope},${ch1},'Race',${actors[1]!},${actors[1]!},${eventVersion}) RETURNING id`;
    const [m] = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${w1},${scope},${ch1},${t!.id},'x',${actors[1]!},${actors[1]!}) RETURNING id`;
    // The viewer transaction advances the watermark and HOLDS the recipient lock (bridge) while projection starts.
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void; const upserted = new Promise<void>((resolve) => { started = resolve; });
    const viewing = db.begin(async (tx) => {
      await tx`INSERT INTO flightdeck_pg_resource_view_states(workspace_id,viewer_actor_id,resource_type,resource_id,scope_id,channel_id,viewed_activity_version)
        VALUES(${w1},${actors[2]!},'thread',${t!.id},${scope},${ch1},${viewedVersion})`;
      started(); await gate;
    });
    await upserted;
    await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch1},${actors[1]!},'flightdeck_pg.message.created','message',${m!.id},'created','{}')`;
    const projecting = processIntakeBatch({ sql: db, limit: 50 });
    await Bun.sleep(400); // projection is now parked on the recipient lock behind the viewer
    release();
    await Promise.all([viewing, projecting]);
    await drain();
    return (await items(2, '?view=all&limit=100')).items.find((i: any) => i.subject.thread_id === t!.id);
  }
  test('B4: view commit concurrent with projection: viewed >= event version => born read; viewed < version => stays unread', async () => {
    const read = await projectMessageWhileViewing(5, 5);
    expect(read.state).toMatchObject({ read: true, read_reason: 'already_viewed' });
    const unread = await projectMessageWhileViewing(5, 6);
    expect(unread.state.read).toBe(false);
    // A later view at the newer version marks it read through the bridge.
    await viewState(2, unread.subject.thread_id, 6);
    expect((await items(2, '?view=all&limit=100')).items.find((i: any) => i.id === unread.id).state).toMatchObject({ read: true, read_reason: 'subject_viewed' });
  });

  test('B4: concurrent projections with overlapping recipients commit without lock failures', async () => {
    const ch2 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'Second') RETURNING id`)[0]!.id as string;
    for (const i of [0, 1, 2, 3]) await grant(actors[i]!, ch2, 'channel.read');
    for (let round = 0; round < 5; round++) {
      for (const channel of [ch1, ch2]) {
        const [t] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${w1},${scope},${channel},'Overlap',${actors[round % 2 ? 0 : 1]!},${actors[round % 2 ? 0 : 1]!}) RETURNING id`;
        const [m] = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${w1},${scope},${channel},${t!.id},'x',${actors[round % 2 ? 0 : 1]!},${actors[round % 2 ? 0 : 1]!}) RETURNING id`;
        await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
          VALUES(${w1},${scope},${channel},${actors[round % 2 ? 0 : 1]!},'flightdeck_pg.message.created','message',${m!.id},'created',${db.json({ mentions: [mentionOf(2), mentionOf(3)] } as any)})`;
      }
      const stats = await Promise.all([1, 2, 3, 4].map(() => processIntakeBatch({ sql: db, limit: 1 })));
      expect(stats.reduce((sum, s) => sum + s.failed + s.dead, 0)).toBe(0);
    }
    await drain();
    expect(await db`SELECT 1 FROM flightdeck_pg_notification_intake WHERE state IN ('dead','pending','leased')`).toHaveLength(0);
  });
});
