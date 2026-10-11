import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { registerRecordClient, readRecordCheckpoint, acknowledgeRecordCheckpoint, retireRecordClient, RECORD_CLIENT_LIMIT } from '../src/services/flightdeck-record-checkpoints';
import { setDb, getDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { buildOpenApiDocument } from '../src/openapi';

// This suite creates and drops its own database, never the shared Tower runtime.
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('durable device record checkpoints v2', () => {
  const database = `tower_record_checkpoint_${process.pid}_${Date.now()}`;
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const secret = generateSecretKey(), foreignSecret = generateSecretKey();
  const npub = nip19.npubEncode(getPublicKey(secret)), foreignNpub = nip19.npubEncode(getPublicKey(foreignSecret));
  let db: ReturnType<typeof postgres>, previousDb: ReturnType<typeof postgres>;
  let workspaceId: string, actorId: string, foreignActorId: string, scopeId: string, channelId: string, otherWorkspace: string;
  const app = createApp();
  beforeAll(async () => {
    const admin = postgres({ ...conn, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...conn, database }); previousDb = getDb(); setDb(db);
    for (const stmt of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(stmt);
    for (const identity of [npub, foreignNpub]) {
      const [actor] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${identity},'human') RETURNING id`;
      if (identity === npub) actorId = actor!.id; else foreignActorId = actor!.id;
    }
    const [w] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
      VALUES('checkpoint-tower','checkpoint-workspace',${npub},'checkpoint-app','Checkpoints') RETURNING id`; workspaceId = w!.id;
    const [other] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
      VALUES('checkpoint-tower','checkpoint-other',${npub},'checkpoint-app','Other') RETURNING id`; otherWorkspace = other!.id;
    for (const workspace of [workspaceId, otherWorkspace]) for (const id of [actorId, foreignActorId]) {
      await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${id},'member')`;
    }
    const [s] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Test','project') RETURNING id`; scopeId = s!.id;
    const [c] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'Test') RETURNING id`; channelId = c!.id;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission)
      VALUES(${workspaceId},'actor',${actorId},'scope',${scopeId},'scope.read')`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${workspaceId},'actor',${actorId},'channel',${channelId},'channel.read')`;
    for (let i = 0; i < 8; i++) await message(`initial ${i}`);
    await ensureRuntimeSchema();
  });
  afterAll(async () => {
    setDb(previousDb); await db?.end();
    const admin = postgres({ ...conn, database: 'postgres' }); await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
  });
  const input = (clientId: string) => ({ workspaceId, actorId, clientId });
  async function register() { const clientId = randomUUID(); return registerRecordClient(input(clientId), db); }
  async function page(clientId: string, cursor: string, limit = 200) {
    return readFlightDeckRecordPage({ ...input(clientId), protocolVersion: 2, cursor, limit }, db);
  }
  async function ack(clientId: string, cursor: string, expectedRevision: string) {
    return acknowledgeRecordCheckpoint({ ...input(clientId), cursor, expectedRevision }, db);
  }
  async function synced(clientId: string, cursor: string) {
    let p = await page(clientId, cursor); while (p.has_more) p = await page(clientId, p.next_cursor); return p;
  }
  async function message(body: string, sql = db) {
    const [row] = await sql`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspaceId},${scopeId},${channelId},${body},${actorId},${actorId}) RETURNING id`; return row!.id;
  }
  const base = () => `/api/v4/flightdeck-pg/workspaces/${workspaceId}/record-sync`;
  async function request(path: string, method = 'GET', body?: unknown, key = secret) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const tags = [['u', `http://localhost${path}`], ['method', method]];
    if (method === 'POST') tags.push(['payload', createHash('sha256').update(raw).digest('hex')]);
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now()/1000), content: '', tags }, key);
    return app.request(path, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: raw } : {}) });
  }

  test('two devices, v1 coexistence, explicit local resume and page delivery never acknowledge', async () => {
    const a = await register(), b = await register();
    const pa = await synced(a.client_id, a.initial_cursor);
    const saved = await ack(a.client_id, pa.next_cursor, pa.checkpoint_revision);
    const pb = await page(b.client_id, b.initial_cursor, 1);
    expect(pb.mode).toBe('snapshot');
    expect((await readRecordCheckpoint(input(b.client_id), db)).checkpoint_cursor).toBeNull();
    const bSaved = await ack(b.client_id, pb.next_cursor, pb.checkpoint_revision);
    expect(bSaved.checkpoint_cursor).not.toBe(saved.checkpoint_cursor);
    const replay = await page(a.client_id, a.initial_cursor, 1);
    expect(replay.mode).toBe('snapshot'); // never replace older local position with saved delta
    expect((await readRecordCheckpoint(input(a.client_id), db)).checkpoint_cursor).toBe(saved.checkpoint_cursor);
    const v1 = await readFlightDeckRecordPage({ workspaceId, actorId }, db);
    expect(v1.protocol_version).toBe(1); expect('client_id' in v1).toBe(false);
    await expect(page(a.client_id, v1.next_cursor)).rejects.toMatchObject({ code: 'page_token_invalid' });
    await expect(readFlightDeckRecordPage({ workspaceId, actorId, cursor: pb.next_cursor }, db)).rejects.toMatchObject({ code: 'reset_required' });
    await expect(readFlightDeckRecordPage({ ...input(a.client_id), protocolVersion: 2 }, db)).rejects.toMatchObject({ code: 'cursor_required' });
  });

  test('snapshot continuation persists independently, terminal handover repairs concurrent writes', async () => {
    const a = await register(); const first = await page(a.client_id, a.initial_cursor, 1);
    const committed = await ack(a.client_id, first.next_cursor, '0');
    const [state] = await db`SELECT checkpoint_state FROM flightdeck_pg_record_clients WHERE client_id=${a.client_id}`;
    expect(state!.checkpoint_state.mode).toBe('snapshot'); expect(state!.checkpoint_state.snapshotId).toBe(first.snapshot_id);
    await db`DELETE FROM flightdeck_pg_record_page_tokens WHERE client_id=${a.client_id}`;
    const id = await message('during snapshot');
    let p = await page(a.client_id, committed.checkpoint_cursor!, 2);
    while (!p.snapshot_complete) { expect(p.snapshot_id).toBe(first.snapshot_id); p = await page(a.client_id, p.next_cursor, 2); }
    expect(p.mode).toBe('snapshot'); expect(p.has_more).toBe(true);
    const terminal = await ack(a.client_id, p.next_cursor, p.checkpoint_revision);
    const handover = await page(a.client_id, terminal.checkpoint_cursor!);
    expect(handover.mode).toBe('delta'); expect(handover.changes.some(c => c.id === id)).toBe(true);
    expect((await ack(a.client_id, handover.next_cursor, handover.checkpoint_revision)).checkpoint_revision).toBe('3');
  });

  test('lost ack reply retries after disposable expiry; concurrent branch acks have one winner', async () => {
    const a = await register(); const p = await page(a.client_id, a.initial_cursor, 1);
    const saved = await ack(a.client_id, p.next_cursor, '0');
    await db`UPDATE flightdeck_pg_record_page_tokens SET last_used_at=now()-interval '8 days' WHERE token=${p.next_cursor}`;
    expect((await ack(a.client_id, p.next_cursor, '0')).checkpoint_revision).toBe(saved.checkpoint_revision);
    const branch1 = await page(a.client_id, saved.checkpoint_cursor!, 1);
    const branch2 = await page(a.client_id, saved.checkpoint_cursor!, 2);
    const results = await Promise.allSettled([ack(a.client_id, branch1.next_cursor, '1'), ack(a.client_id, branch2.next_cursor, '1')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.code).toBe('checkpoint_conflict');
    expect((await readRecordCheckpoint(input(a.client_id), db)).checkpoint_revision).toBe('2');
  });

  test('out-of-order and snapshot regression cannot overwrite a newer checkpoint; older cursor still resumes', async () => {
    const a = await register();
    const first = await page(a.client_id, a.initial_cursor, 1), second = await page(a.client_id, first.next_cursor, 1);
    await ack(a.client_id, second.next_cursor, '0');
    await expect(ack(a.client_id, first.next_cursor, '0')).rejects.toMatchObject({ code: 'checkpoint_conflict' });
    const older = await page(a.client_id, a.initial_cursor, 1);
    expect(older.checkpoint_revision).toBe('1');
    await expect(ack(a.client_id, older.next_cursor, '1')).rejects.toMatchObject({ code: 'checkpoint_regression' });
    const localOlder = await page(a.client_id, first.next_cursor, 1);
    expect(localOlder.changes.map(c => c.id)).toEqual(second.changes.map(c => c.id));
    const delta = await synced(a.client_id, second.next_cursor);
    await ack(a.client_id, delta.next_cursor, '1');
    const snapshotAgain = await page(a.client_id, a.initial_cursor, 2);
    await expect(ack(a.client_id, snapshotAgain.next_cursor, '2')).rejects.toMatchObject({ code: 'checkpoint_regression' });
  });

  test('delta out-of-order acks and same-token concurrent retries never regress', async () => {
    const a = await register(), initial = await synced(a.client_id, a.initial_cursor);
    await ack(a.client_id, initial.next_cursor, '0');
    await message('delta first'); const first = await page(a.client_id, initial.next_cursor, 1);
    await message('delta second'); const second = await page(a.client_id, first.next_cursor, 1);
    const replies = await Promise.all([ack(a.client_id, second.next_cursor, '1'), ack(a.client_id, second.next_cursor, '1')]);
    expect(replies.map(r => r.checkpoint_revision)).toEqual(['2','2']);
    await expect(ack(a.client_id, first.next_cursor, '1')).rejects.toMatchObject({code:'checkpoint_conflict'});
    const replay = await page(a.client_id, initial.next_cursor, 1);
    expect(replay.changes).toEqual(first.changes);
    await expect(ack(a.client_id, replay.next_cursor, replay.checkpoint_revision)).rejects.toMatchObject({code:'checkpoint_regression'});
    expect((await readRecordCheckpoint(input(a.client_id),db)).checkpoint_cursor).toBe(second.next_cursor);
  });

  test('durable checkpoint survives >512 legacy and other-device pages and old seven-day TTL', async () => {
    const a = await register(), b = await register();
    const pa = await synced(a.client_id, a.initial_cursor); const saved = await ack(a.client_id, pa.next_cursor, '0');
    await db`UPDATE flightdeck_pg_record_clients SET created_at=now()-interval '30 days',last_active_at=now()-interval '8 days' WHERE client_id=${a.client_id}`;
    await db`UPDATE flightdeck_pg_record_page_tokens SET created_at=now()-interval '30 days',last_used_at=now()-interval '8 days' WHERE client_id=${a.client_id}`;
    let v1 = await readFlightDeckRecordPage({ workspaceId, actorId }, db); while (v1.has_more) v1 = await readFlightDeckRecordPage({ workspaceId, actorId, cursor: v1.next_cursor }, db);
    let other = await synced(b.client_id, b.initial_cursor);
    for (let i = 0; i < 515; i++) {
      await message(`retention ${i}`);
      v1 = await readFlightDeckRecordPage({ workspaceId, actorId, cursor: v1.next_cursor }, db);
      other = await page(b.client_id, other.next_cursor);
    }
    const [tokens] = await db`SELECT count(*)::int AS n FROM flightdeck_pg_record_page_tokens WHERE client_id=${b.client_id}`;
    expect(tokens!.n).toBe(512);
    expect((await readRecordCheckpoint(input(a.client_id), db)).checkpoint_cursor).toBe(saved.checkpoint_cursor);
    const recovered = await page(a.client_id, saved.checkpoint_cursor!);
    expect(recovered.mode).toBe('delta'); expect(recovered.changes.length).toBeGreaterThan(0);
    await db`DELETE FROM flightdeck_pg_record_page_tokens WHERE client_id=${a.client_id}`;
    expect((await ack(a.client_id, saved.checkpoint_cursor!, '0')).checkpoint_revision).toBe('1');
    expect((await page(a.client_id, saved.checkpoint_cursor!)).mode).toBe('delta');
  }, 30000);

  test('exact actor/workspace/client binding rejects stolen page and acknowledgement tokens', async () => {
    const a = await register(), b = await register(); const p = await page(a.client_id, a.initial_cursor, 1);
    await expect(page(b.client_id, p.next_cursor)).rejects.toMatchObject({ code: 'page_token_invalid' });
    await expect(ack(b.client_id, p.next_cursor, '0')).rejects.toMatchObject({ code: 'page_token_invalid' });
    for (const changed of [{ actorId: foreignActorId }, { workspaceId: otherWorkspace }]) {
      await registerRecordClient({ ...input(a.client_id), ...changed }, db);
      await expect(readFlightDeckRecordPage({ ...input(a.client_id), ...changed, protocolVersion: 2, cursor: p.next_cursor }, db)).rejects.toMatchObject({ code: 'page_token_invalid' });
      await expect(acknowledgeRecordCheckpoint({ ...input(a.client_id), ...changed, cursor: p.next_cursor, expectedRevision: '0' }, db)).rejects.toMatchObject({ code: 'page_token_invalid' });
    }
  });

  test('token expiry and client abandonment differ, unknown/expired/reset state is explicit', async () => {
    const a = await register(); const p = await page(a.client_id, a.initial_cursor, 1);
    await db`UPDATE flightdeck_pg_record_page_tokens SET last_used_at=now()-interval '8 days' WHERE token=${p.next_cursor}`;
    await expect(page(a.client_id, p.next_cursor)).rejects.toMatchObject({ code: 'page_token_invalid' });
    await expect(ack(a.client_id, p.next_cursor, '0')).rejects.toMatchObject({ code: 'page_token_invalid' });
    expect((await readRecordCheckpoint(input(a.client_id), db)).checkpoint_revision).toBe('0');
    await db`UPDATE flightdeck_pg_record_clients SET last_active_at=now()-interval '91 days' WHERE client_id=${a.client_id}`;
    await expect(readRecordCheckpoint(input(a.client_id), db)).rejects.toMatchObject({ code: 'client_expired' });
    await expect(registerRecordClient(input(a.client_id), db)).rejects.toMatchObject({ code: 'client_expired' });
    await expect(readRecordCheckpoint(input(randomUUID()), db)).rejects.toMatchObject({ code: 'client_not_registered' });
    const fresh = await register();
    expect((await db`SELECT 1 FROM flightdeck_pg_record_clients WHERE client_id=${a.client_id}`).length).toBe(0);
    expect((await db`SELECT 1 FROM flightdeck_pg_record_page_tokens WHERE client_id=${a.client_id}`).length).toBe(0);
    expect(fresh.checkpoint_revision).toBe('0');
  });

  test('client registration rejects capacity without evicting active state; concurrent last slot bounded', async () => {
    const target = { workspaceId: otherWorkspace, actorId, clientId: randomUUID() };
    await db`DELETE FROM flightdeck_pg_record_clients WHERE workspace_id=${otherWorkspace} AND actor_id=${actorId}`;
    for (let i = 0; i < RECORD_CLIENT_LIMIT - 1; i++) await registerRecordClient({ ...target, clientId: randomUUID() }, db);
    const attempts = await Promise.allSettled([registerRecordClient(target, db), registerRecordClient({ ...target, clientId: randomUUID() }, db)]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((attempts.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('client_capacity');
    const [count] = await db`SELECT count(*)::int AS n FROM flightdeck_pg_record_clients WHERE workspace_id=${otherWorkspace} AND actor_id=${actorId}`;
    expect(count!.n).toBe(RECORD_CLIENT_LIMIT);
    await expect(registerRecordClient({ ...target, clientId: randomUUID() }, db)).rejects.toMatchObject({ code: 'client_capacity' });
    const [old] = await db`SELECT client_id FROM flightdeck_pg_record_clients WHERE workspace_id=${otherWorkspace} AND actor_id=${actorId} LIMIT 1`;
    await retireRecordClient({ ...target, clientId: old!.client_id }, db);
    expect((await registerRecordClient({ ...target, clientId: randomUUID() }, db)).checkpoint_revision).toBe('0');
  });

  test('upgrade from pre-v2 schema installs tables without changing legacy epoch or cursor', async () => {
    const upgradeDatabase = `${database}_upgrade`;
    const admin = postgres({ ...conn, database:'postgres' });
    await admin.unsafe(`CREATE DATABASE ${upgradeDatabase}`);
    const oldDb = postgres({ ...conn, database:upgradeDatabase });
    try {
      const source = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8')
        .replace(/-- flightdeck_record_checkpoints_v2[\s\S]*?-- end_flightdeck_record_checkpoints_v2/, '')
        .replace(/-- additive_record_access_v1[\s\S]*?-- end_additive_record_access_v1/, '');
      for (const stmt of splitSqlStatements(source)) await oldDb.unsafe(stmt);
      const [actor] = await oldDb`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('npub1upgradefixture','human') RETURNING id`;
      const [workspace] = await oldDb`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
        VALUES('upgrade-tower','upgrade-workspace','upgrade-owner','upgrade-app','Upgrade') RETURNING id`;
      await oldDb`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace!.id},${actor!.id},'member')`;
      // Stabilize existing group/grant startup backfills first. They legitimately
      // reset a newly seeded workspace and are independent of this extension.
      await ensureRuntimeSchema(oldDb);
      // Recreate the precise pre-v2 schema after legacy runtime stabilization.
      await oldDb`DROP TABLE flightdeck_pg_record_page_tokens`;
      await oldDb`DROP TABLE flightdeck_pg_record_clients`;
      await oldDb`ALTER TABLE flightdeck_pg_record_clock DROP COLUMN journal_floor`;
      await oldDb`INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(${workspace!.id}) ON CONFLICT DO NOTHING`;
      const [clock] = await oldDb`SELECT epoch,position::text FROM flightdeck_pg_record_clock WHERE workspace_id=${workspace!.id}`;
      const [legacy] = await oldDb`INSERT INTO flightdeck_pg_record_cursors(workspace_id,actor_id,epoch,state,created_at,last_used_at)
        VALUES(${workspace!.id},${actor!.id},${clock!.epoch},${oldDb.json({mode:'delta',boundary:clock!.position,after:clock!.position,family:'',id:'',snapshotId:null})},now()-interval '2 days',now()-interval '1 day') RETURNING *`;
      // Explicit injected connection; no shared runtime database is touched.
      await ensureRuntimeSchema(oldDb); await ensureRuntimeSchema(oldDb);
      const [after] = await oldDb`SELECT * FROM flightdeck_pg_record_cursors WHERE token=${legacy!.token}`;
      expect({...after,state:legacy!.state}).toEqual({...legacy,state:legacy!.state});
      expect(after!.state.access).toBeArray();
      const [newClock] = await oldDb`SELECT epoch,journal_floor::text FROM flightdeck_pg_record_clock WHERE workspace_id=${workspace!.id}`;
      expect(newClock!.epoch).toBe(clock!.epoch); expect(newClock!.journal_floor).toBe('0');
      expect((await readFlightDeckRecordPage({workspaceId:workspace!.id,actorId:actor!.id,cursor:legacy!.token},oldDb)).next_cursor).toBe(legacy!.token);
      const client = await registerRecordClient({workspaceId:workspace!.id,actorId:actor!.id,clientId:randomUUID()},oldDb);
      expect(client.checkpoint_revision).toBe('0');
    } finally {
      await oldDb.end(); await admin.unsafe(`DROP DATABASE IF EXISTS ${upgradeDatabase}`); await admin.end();
    }
  }, 30000);

  test('runtime additive upgrade is idempotent and preserves legacy and acknowledged snapshot state', async () => {
    const a = await register(); const p = await page(a.client_id, a.initial_cursor, 1); await ack(a.client_id, p.next_cursor, '0');
    const legacy = await readFlightDeckRecordPage({ workspaceId, actorId }, db);
    const [old] = await db`SELECT * FROM flightdeck_pg_record_cursors WHERE token=${legacy.next_cursor}`;
    const [saved] = await db`SELECT * FROM flightdeck_pg_record_clients WHERE client_id=${a.client_id}`;
    await ensureRuntimeSchema(); await ensureRuntimeSchema();
    const [after] = await db`SELECT * FROM flightdeck_pg_record_cursors WHERE token=${legacy.next_cursor}`;
    expect(after).toEqual(old);
    const [device] = await db`SELECT * FROM flightdeck_pg_record_clients WHERE client_id=${a.client_id}`;
    expect(device).toEqual(saved);
    expect((await page(a.client_id, saved!.checkpoint_cursor)).snapshot_id).toBe(p.snapshot_id);
  }, 30000);

  test('authenticated discovery/register/read/ack contract; bad protocol/device and payload rejected', async () => {
    const service = await request('/api/v4/flightdeck-pg/service'); expect(service.status).toBe(200);
    expect((await service.json()).record_sync).toMatchObject({ protocol_versions: [1,2], device_checkpoints: true });
    const clientId = randomUUID(), path = `${base()}/clients/${clientId}?protocol_version=2`;
    expect((await app.request(path, { method: 'POST' })).status).toBe(401);
    const registered = await request(path, 'POST'); expect(registered.status).toBe(200);
    const a = await registered.json(); expect(a.checkpoint_cursor).toBeNull();
    const repeat = await request(path, 'POST'); expect((await repeat.json()).initial_cursor).toBe(a.initial_cursor);
    const read = await request(path); expect((await read.json()).checkpoint_revision).toBe('0');
    const pg = await request(`${base()}?protocol_version=2&client_id=${clientId}&cursor=${a.initial_cursor}&limit=1`);
    expect(pg.status).toBe(200); const p = await pg.json(); expect(p.protocol_version).toBe(2);
    const ackPath = `${base()}/clients/${clientId}/ack?protocol_version=2`, payload = { cursor: p.next_cursor, expected_revision: p.checkpoint_revision };
    const committed = await request(ackPath, 'POST', payload); expect(committed.status).toBe(200); expect((await committed.json()).checkpoint_revision).toBe('1');
    expect((await request(ackPath, 'POST', payload)).status).toBe(200);
    const foreign = await request(ackPath, 'POST', payload, foreignSecret); expect(foreign.status).toBe(409);
    expect((await request(`${base()}?protocol_version=1`)).status).toBe(200);
    for (const version of ['', '3', '02', '1,2']) expect((await request(`${base()}?protocol_version=${version}`)).status).toBe(400);
    for (const bad of ['x', '00000000-0000-0000-0000-000000000000', clientId.toUpperCase()]) {
      expect((await request(`${base()}/clients/${bad}?protocol_version=2`, 'POST')).status).toBe(400);
    }
    expect((await request(`${base()}?protocol_version=2&cursor=${p.next_cursor}`)).status).toBe(400);
    expect((await request(`${base()}?protocol_version=2&client_id=${clientId}`)).status).toBe(400);
    expect((await request(ackPath, 'POST', { ...payload, expected_revision: 1 })).status).toBe(400);
    expect((await request(ackPath, 'POST', { ...payload, state: {} })).status).toBe(400);
    const signed = finalizeEvent({ kind:27235, created_at:Math.floor(Date.now()/1000), content:'', tags:[['u',`http://localhost${ackPath}`],['method','POST'],['payload', createHash('sha256').update(JSON.stringify(payload)).digest('hex')]] }, secret);
    const tampered = await app.request(ackPath, { method:'POST', headers:{ Authorization:`Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}`, 'content-type':'application/json' }, body:JSON.stringify({...payload, expected_revision:'99'}) });
    expect(tampered.status).toBe(401);
    expect((await request(path, 'DELETE')).status).toBe(200);
    expect((await request(path, 'DELETE')).status).toBe(200);
    expect((await request(path)).status).toBe(409);
    expect((await db`SELECT 1 FROM flightdeck_pg_record_page_tokens WHERE client_id=${clientId}`).length).toBe(0);
    const document = buildOpenApiDocument('http://localhost') as any;
    expect(document.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync'].get.parameters.find((p:any)=>p.name==='protocol_version').schema.enum).toEqual([1,2]);
    expect(document.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync/clients/{clientId}/ack'].post.requestBody).toBeDefined();
  });

  // Pause real transactions at the authority lock, without mocking decisions.
  function pauseAtClock(afterLock = false) {
    let enter!: () => void, release!: () => void, paused = false;
    const ready = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
    const connection = new Proxy(db, { get(target, key) {
      if (key !== 'begin') return Reflect.get(target, key);
      return (...args: any[]) => {
        const callback = args.pop();
        const wrappedCallback = async (tx: any) => callback(new Proxy(tx, { apply(sql, self, values) {
          if (!paused && Array.isArray(values[0]) && values[0].join('').includes('FOR SHARE')) {
            paused = true;
            if (afterLock) return Promise.resolve(Reflect.apply(sql, self, values)).then(async rows => { enter(); await gate; return rows; });
            enter(); return gate.then(() => Reflect.apply(sql, self, values));
          }
          return Reflect.apply(sql, self, values);
        } }));
        return args.length ? target.begin(args[0], wrappedCallback) : target.begin(wrappedCallback);
      };
    } });
    return { connection, ready, release };
  }

  test('page reset race retries fresh authority and leaves checkpoint untouched', async () => {
    const a = await register(); const p = await page(a.client_id, a.initial_cursor, 1); await ack(a.client_id, p.next_cursor, '0');
    const paused = pauseAtClock();
    const reading = readFlightDeckRecordPage({ ...input(a.client_id), protocolVersion:2, cursor:p.next_cursor }, paused.connection);
    await paused.ready;
    await db`UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid() WHERE workspace_id=${workspaceId}`;
    paused.release(); await expect(reading).rejects.toMatchObject({ code:'reset_required' });
    const [saved] = await db`SELECT checkpoint_cursor,revision::text FROM flightdeck_pg_record_clients WHERE client_id=${a.client_id}`;
    expect(saved!.checkpoint_cursor).toBe(p.next_cursor); expect(saved!.revision).toBe('1');
  });

  test('ack reset race rejects when reset wins; clock share lock makes later reset wait', async () => {
    let a = await register(); let p = await page(a.client_id, a.initial_cursor, 1);
    const before = pauseAtClock();
    const acknowledging = acknowledgeRecordCheckpoint({ ...input(a.client_id), cursor:p.next_cursor, expectedRevision:'0' }, before.connection);
    await before.ready;
    await db`UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid() WHERE workspace_id=${workspaceId}`;
    before.release(); await expect(acknowledging).rejects.toMatchObject({ code:'reset_required' });
    const [unchanged] = await db`SELECT revision::text FROM flightdeck_pg_record_clients WHERE client_id=${a.client_id}`; expect(unchanged!.revision).toBe('0');
    a = await register(); p = await page(a.client_id, a.initial_cursor, 1);
    const after = pauseAtClock(true);
    const lockedAck = acknowledgeRecordCheckpoint({ ...input(a.client_id), cursor:p.next_cursor, expectedRevision:'0' }, after.connection);
    await after.ready;
    const resetting = db`UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid() WHERE workspace_id=${workspaceId}`.execute();
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const [row] = await db`SELECT 1 FROM pg_stat_activity WHERE datname=${database} AND wait_event_type='Lock' AND query LIKE '%SET epoch=gen_random_uuid()%'`;
        if (row) { waiting = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
    } finally { after.release(); }
    expect((await lockedAck).checkpoint_revision).toBe('1'); await resetting;
    await expect(readRecordCheckpoint(input(a.client_id), db)).rejects.toMatchObject({ code:'reset_required' });
  });

  test('temporary cleanup is bounded per client and concurrent pages keep immutable state', async () => {
    const a = await register(); const first = await page(a.client_id, a.initial_cursor, 1);
    const [saved] = await db`SELECT * FROM flightdeck_pg_record_page_tokens WHERE token=${first.next_cursor}`;
    await db`INSERT INTO flightdeck_pg_record_page_tokens(workspace_id,actor_id,client_id,epoch,state,base_revision,last_used_at)
      SELECT ${workspaceId},${actorId},${a.client_id},${saved!.epoch},${db.json(saved!.state)},0,now()-interval '8 days' FROM generate_series(1,100)`;
    await page(a.client_id, first.next_cursor, 1);
    const [expired] = await db`SELECT count(*)::int AS n FROM flightdeck_pg_record_page_tokens WHERE client_id=${a.client_id} AND last_used_at<now()-interval '7 days'`;
    expect(expired!.n).toBe(36);
    const pages = await Promise.all([page(a.client_id, first.next_cursor, 1), page(a.client_id, first.next_cursor, 1)]);
    expect(pages[0].changes).toEqual(pages[1].changes);
    const [same] = await db`SELECT state,epoch,base_revision::text,created_at FROM flightdeck_pg_record_page_tokens WHERE token=${first.next_cursor}`;
    expect(same!.state).toEqual(saved!.state); expect(same!.epoch).toBe(saved!.epoch);
    expect(same!.base_revision).toBe(String(saved!.base_revision)); expect(same!.created_at).toEqual(saved!.created_at);
    for (const p of pages) expect((await page(a.client_id, p.next_cursor)).protocol_version).toBe(2);
  });

  test('journal prefix loss and declared floor never silently jump forward', async () => {
    const a = await register(); const p = await synced(a.client_id, a.initial_cursor); await ack(a.client_id, p.next_cursor, '0');
    await message('after checkpoint, pruned');
    const [clock] = await db`SELECT position::text FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`;
    await db`UPDATE flightdeck_pg_record_clock SET journal_floor=position WHERE workspace_id=${workspaceId}`;
    await expect(page(a.client_id, p.next_cursor)).rejects.toMatchObject({ code:'history_pruned' });
    await expect(readRecordCheckpoint(input(a.client_id), db)).rejects.toMatchObject({ code:'history_pruned' });
    await db`UPDATE flightdeck_pg_record_clock SET journal_floor=0 WHERE workspace_id=${workspaceId}`;
    await db`DELETE FROM flightdeck_pg_record_journal WHERE workspace_id=${workspaceId} AND position<=${clock!.position}::bigint`;
    await expect(page(a.client_id, p.next_cursor)).rejects.toMatchObject({ code:'history_pruned' });
    const fresh = await register(); expect((await page(fresh.client_id, fresh.initial_cursor)).mode).toBe('snapshot');
  });

  test('grant revocation retains read/checkpoint/ack continuity; membership loss denies all future requests', async () => {
    const a = await register(); const p = await page(a.client_id, a.initial_cursor, 1); await ack(a.client_id, p.next_cursor, '0');
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${workspaceId} AND permission='channel.read'`;
    const filtered=await page(a.client_id,p.next_cursor);expect(filtered.changes.some(c=>c.family==='message')).toBe(false);
    expect((await readRecordCheckpoint(input(a.client_id),db)).checkpoint_cursor).toBe(p.next_cursor);
    expect((await ack(a.client_id,p.next_cursor,'0')).checkpoint_cursor).toBe(p.next_cursor);
    expect((await registerRecordClient(input(a.client_id),db)).client_id).toBe(a.client_id);
    const b = await register(); const snapshot = await synced(b.client_id, b.initial_cursor);
    expect(snapshot.changes.some(c => c.family==='message')).toBe(false);
    await db`DELETE FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId}`;
    await db`DELETE FROM flightdeck_pg_permission_grants WHERE workspace_id=${workspaceId} AND principal_actor_id=${actorId}`;
    await db`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${actorId}`;
    await expect(page(b.client_id, snapshot.next_cursor)).rejects.toMatchObject({ status:403 });
    await expect(readRecordCheckpoint(input(b.client_id), db)).rejects.toMatchObject({ status:403 });
    await expect(ack(b.client_id, snapshot.next_cursor, '0')).rejects.toMatchObject({ status:403 });
    expect((await request(`${base()}/clients/${b.client_id}?protocol_version=2`)).status).toBe(403);
  });
});
