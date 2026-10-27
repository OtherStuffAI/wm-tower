import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import http2 from 'node:http2';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { buildOpenApiDocument } from '../src/openapi';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { processIntakeBatch } from '../src/services/notification-projector';
import { alertStatus, processAlertBatch } from '../src/services/notification-alerts';
import { classifyApnsResult, loadApnsConfig, providerToken, resetApnsJwtCache, sendApns, type ApnsResult, type ApnsSender, type ApnsSendInput } from '../src/services/notification-apns';
import { transportAdvertisement } from '../src/services/notification-registry';

// Push delivery v1. Runs against a disposable Postgres with generated fixtures only (no owner keys, no real provider):
// RECORD_TEST_PORT=<free port> bun test ./tests/notifications-push.test.ts
const port = Number(process.env.RECORD_TEST_PORT);
const TOPIC = 'studio.example.pushtest';
describe.skipIf(!port || port === 5432)('notification push delivery against disposable Postgres', () => {
  const database = `notif_push_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const secrets = [401, 402, 403, 404, 405].map((n) => new Uint8Array(32).fill(n));
  const npubs = secrets.map((s) => nip19.npubEncode(getPublicKey(s)));
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyPem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const savedEnv: Record<string, string | undefined> = {};
  let db: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createApp>;
  const actors: string[] = [];
  let w1: string, scope: string, ch1: string;
  const base = () => `/api/v4/flightdeck-pg/workspaces/${w1}`;

  const configure = () => {
    Object.assign(process.env, { APNS_AUTH_KEY: keyPem, APNS_KEY_ID: 'TESTKEYID1', APNS_TEAM_ID: 'TESTTEAM12', APNS_TOPIC: TOPIC, NOTIF_PUBLIC_ORIGIN: 'https://tower.example' });
    delete process.env.APNS_AUTH_KEY_FILE;
  };
  const unconfigure = () => { for (const k of ['APNS_AUTH_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC']) delete process.env[k]; };

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
    const text = await response.text();
    return { status: response.status, text, body: (text ? JSON.parse(text) : {}) as any };
  }
  const n = (suffix: string, method = 'GET', actor = 0, body?: unknown) => call(`${base()}/notifications${suffix}`, method, actor, body);
  const drain = async () => { for (let i = 0; i < 20; i++) if ((await processIntakeBatch({ sql: db, limit: 50 })).claimed === 0) return; };
  const grant = (actor: string, channel: string, permission: string) =>
    db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w1},'actor',${actor},'channel',${channel},${permission})`;
  const token = () => randomBytes(32).toString('hex');
  const apnsBody = (tok: string, extra: Record<string, unknown> = {}) => ({ device_token: tok, environment: 'sandbox', bundle_id: TOPIC, preview: 'generic', lease_seconds: 604800, permission_state: 'granted', ...extra });
  const transportBody = (tok: string) => { const { permission_state: _p, ...rest } = apnsBody(tok); return rest; };
  const register = (actor: number, installation: string, tok: string, extra: Record<string, unknown> = {}) =>
    n(`/apns-devices/${installation}`, 'PUT', actor, apnsBody(tok, extra));

  const mention = (i: number) => ({ type: 'agent', actor_id: actors[i], npub: npubs[i], label: `User ${i}` });
  async function threadFor(author: number) {
    const [t] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id,activity_version)
      VALUES(${w1},${scope},${ch1},'Private roadmap title',${actors[author]!},${actors[author]!},0) RETURNING id`;
    return t!.id as string;
  }
  async function message(author: number, thread: string, mentions: number[]) {
    const [m] = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id)
      VALUES(${w1},${scope},${ch1},${thread},'secret body text',${actors[author]!},${actors[author]!}) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,channel_id,actor_id,event_type,entity_type,entity_id,operation,payload)
      VALUES(${w1},${scope},${ch1},${actors[author]!},'flightdeck_pg.message.created','message',${m!.id},'created',${db.json({ mentions: mentions.map(mention) } as any)})`;
    await drain();
  }
  /** Alice (1) mentions Bob (2) in a fresh thread; returns the thread id. */
  async function ping(mentions = [2]) { const t = await threadFor(1); await message(1, t, mentions); return t; }

  const alertsFor = (actor = 2) => db`SELECT * FROM flightdeck_pg_notification_alerts WHERE recipient_actor_id = ${actors[actor]!} ORDER BY created_at, generation`;
  const sendOk: ApnsSender = async () => ({ status: 200, reason: null, apnsId: 'id', retryAfterMs: null });
  function recorder(result: Partial<ApnsResult> | (() => Partial<ApnsResult> | Error) = {}, delayMs = 0) {
    const calls: ApnsSendInput[] = [];
    const sender: ApnsSender = async (_config, input) => {
      calls.push(input);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const out = typeof result === 'function' ? result() : result;
      if (out instanceof Error) throw out;
      return { status: 200, reason: null, apnsId: 'id', retryAfterMs: null, ...out };
    };
    return { calls, sender };
  }
  /** Retires every Bob/Carol installation and registers one clean sandbox installation for Bob. */
  async function freshBob(extra: Record<string, unknown> = {}) {
    await db`UPDATE flightdeck_pg_notification_installations SET status = 'revoked', enrolled_workspace_ids = '{}'`;
    await db`UPDATE flightdeck_pg_notification_transports SET status = 'revoked'`;
    await db`DELETE FROM flightdeck_pg_notification_alerts`;
    await db`DELETE FROM flightdeck_pg_notification_rules WHERE channel = 'alert'`;
    alertStatus.breakerOpenUntil = 0;
    const installation = randomUUID(); const tok = token();
    const res = await register(2, installation, tok, extra);
    expect(res.status).toBe(200);
    return { installation, tok };
  }

  beforeAll(async () => {
    for (const k of ['APNS_AUTH_KEY', 'APNS_AUTH_KEY_FILE', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC', 'NOTIF_PUBLIC_ORIGIN', 'APNS_HOST_SANDBOX', 'APNS_HOST_PRODUCTION', 'APNS_ENVIRONMENTS', 'APNS_EXTRA_TOPICS']) savedEnv[k] = process.env[k];
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database, max: 20 });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    await ensureRuntimeSchema(db);
    for (const npub of npubs) actors.push((await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id`)[0]!.id);
    await db`UPDATE flightdeck_pg_actors SET display_name = 'Alice' WHERE id = ${actors[1]!}`;
    w1 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-push','service-push',${npubs[0]!},'app','Push') RETURNING id`)[0]!.id;
    for (const [i, role] of ['owner', 'member', 'member', 'member'].entries()) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w1},${actors[i]!},${role})`;
    scope = (await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w1},'Main','project') RETURNING id`)[0]!.id;
    ch1 = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w1},${scope},'General') RETURNING id`)[0]!.id;
    for (const i of [0, 1, 2, 3]) await grant(actors[i]!, ch1, 'channel.read');
    setDb(db); app = createApp();
    configure();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end();
  });
  beforeEach(() => { configure(); resetApnsJwtCache(); });

  test('schema is idempotent; an upgraded database starts with no alerts', async () => {
    await ensureRuntimeSchema(db); await ensureRuntimeSchema(db);
    expect((await db`SELECT COUNT(*)::int AS c FROM flightdeck_pg_notification_alerts`)[0]!.c).toBe(0);
  });

  test('without provider config: registry works, readiness is explicit, nothing is queued or sent', async () => {
    unconfigure();
    expect(transportAdvertisement()).toMatchObject({ alerts: false, transports: ['apns'], transport_status: { apns: { ready: false, reason: 'provider_not_configured' } } });
    const installation = randomUUID();
    const res = await register(2, installation, token());
    expect(res.status).toBe(200);
    expect(res.body.delivery).toEqual({ ready: false, reason: 'provider_not_configured' });
    await ping();
    expect((await db`SELECT COUNT(*)::int AS c FROM flightdeck_pg_notification_alerts`)[0]!.c).toBe(0);
    const { calls, sender } = recorder();
    expect((await processAlertBatch({ sql: db, sender })).claimed).toBe(0);
    expect(calls).toHaveLength(0);
    // An alert that was queued earlier stays queued (not faked as sent) while the provider is missing.
    configure();
    await ping();
    expect((await alertsFor()).length).toBe(1);
    unconfigure();
    expect((await processAlertBatch({ sql: db, sender })).claimed).toBe(0);
    expect((await alertsFor())[0]!.state).toBe('pending');
    // An invalid key is also "not ready", never a crash.
    process.env.APNS_AUTH_KEY = 'not a pem'; process.env.APNS_KEY_ID = 'K'; process.env.APNS_TEAM_ID = 'T'; process.env.APNS_TOPIC = TOPIC;
    expect(transportAdvertisement().transport_status.apns).toMatchObject({ ready: false, reason: 'provider_key_invalid' });
  });

  test('registry contract: alias shape, lease, no token echo, environment alias, renewal, ownership, revoke', async () => {
    await freshBob();
    const installation = randomUUID(); const tok = token();
    const res = await register(2, installation, tok, { environment: 'development' });
    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).not.toContain(tok);
    expect(res.body.device).toMatchObject({ installation_id: installation, kind: 'apns', environment: 'sandbox', bundle_id: TOPIC, preview: 'generic', status: 'active', token_suffix: tok.slice(-6) });
    expect(res.body.device.lease_expires_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(res.body.device.lease_expires_at) - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    expect(res.body.installation).toMatchObject({ client_app_id: 'ambulando', platform: 'ios', status: 'active', enrolled_workspace_ids: [w1] });
    expect(res.body.delivery).toEqual({ ready: true });
    // permission not granted (or never reported): registered with a lease, honestly not ready, never queued
    const unknown = await n(`/apns-devices/${randomUUID()}`, 'PUT', 2, { device_token: token(), environment: 'sandbox', bundle_id: TOPIC });
    expect(unknown.status).toBe(200);
    expect(unknown.body.installation.permission_state).toBe('unknown');
    expect(unknown.body.delivery).toEqual({ ready: false, reason: 'permission_not_granted' });
    expect(unknown.body.device.lease_expires_at).toBeTruthy();

    // renewal: same row, new lease
    const renew = await register(2, installation, tok, { lease_seconds: 3600 });
    expect(renew.status).toBe(200);
    expect(Date.parse(renew.body.device.lease_expires_at) - Date.now()).toBeLessThan(3700_000);
    expect((await db`SELECT COUNT(*)::int AS c FROM flightdeck_pg_notification_transports WHERE address = ${tok}`)[0]!.c).toBe(1);

    // another actor: neither the token nor the installation id can be taken
    const stolen = await register(3, randomUUID(), tok);
    expect(stolen.status).toBe(409); expect(stolen.body.code).toBe('transport_owned');
    const hijack = await register(3, installation, token());
    expect(hijack.status).toBe(409); expect(hijack.body.code).toBe('installation_owned');
    expect((await db`SELECT actor_id FROM flightdeck_pg_notification_transports WHERE address = ${tok}`)[0]!.actor_id).toBe(actors[2]);
    expect((await call(`${base()}/notifications/apns-devices/${installation}`, 'DELETE', 3)).status).toBe(404); // not their row

    // validation
    expect((await register(2, installation, 'abcd')).body.code).toBe('validation_error');
    expect((await register(2, installation, token(), { environment: 'mars' })).status).toBe(400);
    expect((await register(2, installation, token(), { bundle_id: 'com.other.app' })).body.code).toBe('bundle_not_allowed');
    expect((await register(2, installation, token(), { lease_seconds: 99999999 })).status).toBe(400);
    expect((await n(`/apns-devices/${installation}`, 'PUT', 2, { ...apnsBody(token()), extra: 1 })).status).toBe(400);
    expect((await n(`/installations/${installation}/transports/fcm`, 'PUT', 2, transportBody(token()))).body.code).toBe('transport_not_implemented');

    // revoke, then the released token may be claimed by someone else
    const del = await call(`${base()}/notifications/apns-devices/${installation}`, 'DELETE', 2);
    expect(del.status).toBe(200); expect(del.body).toMatchObject({ revoked: true, remaining_workspace_ids: [] });
    expect((await call(`${base()}/notifications/apns-devices/${installation}`, 'DELETE', 2)).status).toBe(404);
    expect((await register(3, randomUUID(), tok)).status).toBe(200);
  });

  test('unexpected registry database failures never log or return the device token', async () => {
    await freshBob();
    const installation = randomUUID(); const tok = token();
    expect((await register(2, installation, tok)).status).toBe(200);
    // A database error whose message and detail carry the generated fixture token, as a driver error with bound parameters could.
    await db.unsafe(`CREATE OR REPLACE FUNCTION fd_test_leak() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'leak %', COALESCE(NEW.address, OLD.address) USING DETAIL = COALESCE(NEW.address, OLD.address), ERRCODE = 'XX001'; END $$`);
    await db.unsafe('CREATE TRIGGER fd_test_leak BEFORE INSERT OR UPDATE OR DELETE ON flightdeck_pg_notification_transports FOR EACH ROW EXECUTE FUNCTION fd_test_leak()');
    const logged: string[] = [];
    const originals = { error: console.error, warn: console.warn, log: console.log };
    const capture = (...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}\n${JSON.stringify(a)}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    console.error = capture; console.warn = capture; console.log = capture;
    let results: { status: number; text: string; body: any }[];
    try {
      const other = token();
      results = [
        await register(2, randomUUID(), other),
        await register(2, installation, tok, { lease_seconds: 3600 }),
        await n(`/installations/${installation}/transports/apns`, 'PUT', 2, transportBody(tok)),
        await n(`/installations/${installation}/transports/apns`, 'DELETE', 2),
        await n(`/apns-devices/${installation}`, 'DELETE', 2),
      ];
      logged.push(other);
      for (const r of results.slice(0, 2)) expect(r.text.includes(other) || r.text.includes(tok)).toBe(false);
      expect(logged.slice(0, -1).join('\n').includes(other)).toBe(false);
    } finally {
      console.error = originals.error; console.warn = originals.warn; console.log = originals.log;
      await db.unsafe('DROP TRIGGER IF EXISTS fd_test_leak ON flightdeck_pg_notification_transports');
      await db.unsafe('DROP FUNCTION IF EXISTS fd_test_leak()');
    }
    const failures = results.filter((r) => r.status === 500);
    expect(failures.length).toBeGreaterThanOrEqual(3);
    for (const r of failures) {
      expect(r.body).toMatchObject({ code: 'push_registration_failed', status: 500, error: 'Push registration failed' });
      expect(r.text.includes(tok)).toBe(false);
    }
    expect(results[0]!.status).toBe(500);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.every((line) => !line.includes(tok) && !line.includes('leak '))).toBe(true);
    expect(logged.some((line) => line.includes('push registration failed') && line.includes('XX001'))).toBe(true);

    // expected failures are unchanged once the fault is gone
    expect((await register(3, randomUUID(), tok)).body.code).toBe('transport_owned');
    expect((await register(3, installation, token())).body.code).toBe('installation_owned');
    expect((await register(2, installation, 'abcd')).body.code).toBe('validation_error');
  });

  test('a lease-expired token is released to a new owner; a live one is not', async () => {
    await freshBob();
    const tok = token();
    expect((await register(2, randomUUID(), tok)).status).toBe(200);
    expect((await register(3, randomUUID(), tok)).status).toBe(409);
    await db`UPDATE flightdeck_pg_notification_transports SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE address = ${tok}`;
    expect((await register(3, randomUUID(), tok)).status).toBe(200);
    expect((await db`SELECT actor_id FROM flightdeck_pg_notification_transports WHERE address = ${tok}`)[0]!.actor_id).toBe(actors[3]);
  });

  test('canonical routes: installation first, enrollment is per workspace, transport needs enrollment', async () => {
    await freshBob();
    const id = randomUUID();
    const early = await n(`/installations/${id}/transports/apns`, 'PUT', 2, transportBody(token()));
    expect(early.status).toBe(404);
    const inst = await n(`/installations/${id}`, 'PUT', 2, { client_app_id: 'ambulando', platform: 'ipados', permission_state: 'granted' });
    expect(inst.status).toBe(200);
    expect(inst.body.installation.enrolled_workspace_ids).toEqual([w1]);
    expect((await n(`/installations/${id}/transports/apns`, 'PUT', 2, transportBody(token()))).status).toBe(200);
    expect((await n(`/installations/${id}`, 'PUT', 3, { client_app_id: 'ambulando', platform: 'ios' })).body.code).toBe('installation_owned');
    // a second workspace enrollment keeps the token alive when the first is removed
    const w2 = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('t2','s2',${npubs[0]!},'app','Two') RETURNING id`)[0]!.id;
    await db`UPDATE flightdeck_pg_notification_installations SET enrolled_workspace_ids = ARRAY[${w1}, ${w2}]::uuid[] WHERE id = ${id}`;
    const one = await n(`/installations/${id}`, 'DELETE', 2);
    expect(one.body).toEqual(expect.objectContaining({ revoked: true, remaining_workspace_ids: [w2] }));
    expect((await db`SELECT status FROM flightdeck_pg_notification_transports WHERE installation_id = ${id}`)[0]!.status).toBe('active');
    await ping();
    // enrolled elsewhere only: this installation gets no alert for this workspace (the fresh Bob installation does)
    expect((await db`SELECT 1 FROM flightdeck_pg_notification_alerts a JOIN flightdeck_pg_notification_transports t ON t.id = a.transport_id WHERE t.installation_id = ${id}`)).toHaveLength(0);
  });

  test('visible alert payload: env/topic/collapse/expiration, fd v1 routing ids, generic text, no private content', async () => {
    const { tok } = await freshBob();
    const thread = await ping();
    const [alert] = await alertsFor();
    expect(alert).toMatchObject({ state: 'pending', generation: 1 });
    const { calls, sender } = recorder();
    const stats = await processAlertBatch({ sql: db, sender });
    expect(stats).toMatchObject({ claimed: 1, sent: 1 });
    expect(calls).toHaveLength(1);
    const call0 = calls[0]!;
    expect(call0).toMatchObject({ environment: 'sandbox', deviceToken: tok, topic: TOPIC });
    expect(call0.collapseId.length).toBeLessThanOrEqual(64);
    expect(call0.expiration * 1000 - Date.now()).toBeGreaterThan(23 * 3600_000);
    const payload = JSON.parse(call0.body);
    const [item] = await db`SELECT id, change_seq FROM flightdeck_pg_notification_items WHERE recipient_actor_id = ${actors[2]!} AND subject->>'thread_id' = ${thread}`;
    expect(payload.aps).toMatchObject({ alert: { title: 'You were mentioned', body: '' }, sound: 'default' });
    expect(payload.aps['content-available']).toBe(1);
    expect(typeof payload.aps.badge).toBe('number');
    expect(payload.fd).toMatchObject({ v: 1, origin: 'https://tower.example', tower_service_npub: 'tower-push', workspace_id: w1, category: 'mention', thread_id: thread, channel_id: ch1, notification_id: item!.id, change_seq: Number(item!.change_seq), source_app_id: 'flightdeck.core' });
    expect(payload.fd.task_id).toBeUndefined();
    // opaque ids: no raw group key anywhere, stable per group
    const [grp] = await db`SELECT group_key FROM flightdeck_pg_notification_items WHERE id = ${item!.id}`;
    expect(grp!.group_key).toBeTruthy();
    expect(call0.body).not.toContain(grp!.group_key);
    expect(payload.aps['thread-id']).toMatch(/^t-[0-9a-f]{32}$/);
    expect(call0.collapseId).toMatch(/^n-[0-9a-f]{40}$/);
    expect(call0.collapseId).not.toContain(grp!.group_key);
    for (const secret of ['secret body text', 'Alice', 'Private roadmap title', 'mentioned you', tok]) expect(call0.body).not.toContain(secret);
    expect((await alertsFor())[0]).toMatchObject({ state: 'sent', attempt_count: 1, provider_status: 200 });
    const attempts = await db`SELECT outcome, provider_status FROM flightdeck_pg_notification_alert_attempts WHERE alert_id = ${alert!.id}`;
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ outcome: 'sent', provider_status: 200 });
    // sending again is a no-op (sent alerts are never claimed)
    expect((await processAlertBatch({ sql: db, sender })).claimed).toBe(0);
  });

  test('preview: full text only when transport AND alert rule both opt in', async () => {
    await freshBob({ preview: 'full' });
    await ping();
    const first = recorder();
    await processAlertBatch({ sql: db, sender: first.sender });
    expect(JSON.parse(first.calls[0]!.body).aps.alert.title).toBe('You were mentioned'); // rule did not opt in
    const put = await n('/rules', 'PUT', 2, { mutation_id: randomUUID(), rules: [{ source_app_id: 'flightdeck.core', category: 'mention', client_app_id: '*', channel: 'alert', mode: 'on', preview: 'full', expected_row_version: 0 }] });
    expect(put.status).toBe(200);
    await ping();
    const second = recorder();
    await processAlertBatch({ sql: db, sender: second.sender });
    expect(JSON.parse(second.calls[0]!.body).aps.alert.title).toBe('Alice mentioned you');
    // transport still generic => generic even though the rule allows full
    await db`UPDATE flightdeck_pg_notification_transports SET preview = 'generic' WHERE status = 'active'`;
    await ping();
    const third = recorder();
    await processAlertBatch({ sql: db, sender: third.sender });
    expect(JSON.parse(third.calls[0]!.body).aps.alert.title).toBe('You were mentioned');
  });

  test('per-app alert preference and audience: only the opted-in client app gets an alert', async () => {
    await freshBob();
    const other = randomUUID();
    expect((await n(`/apns-devices/${other}`, 'PUT', 2, { ...apnsBody(token()), client_app_id: 'otherapp' })).status).toBe(200);
    const put = await n('/rules', 'PUT', 2, { mutation_id: randomUUID(), rules: [{ category: 'mention', source_app_id: 'flightdeck.core', client_app_id: 'otherapp', channel: 'alert', mode: 'off', expected_row_version: 0 }] });
    expect(put.status).toBe(200);
    await ping();
    const rows = await alertsFor();
    expect(rows).toHaveLength(1);
    const [tr] = await db`SELECT i.client_app_id FROM flightdeck_pg_notification_transports t JOIN flightdeck_pg_notification_installations i ON i.id = t.installation_id WHERE t.id = ${rows[0]!.transport_id}`;
    expect(tr!.client_app_id).toBe('ambulando');
  });

  test('late checks suppress instead of sending (read, revoked, lease, permission, rule, owner, membership, access)', async () => {
    type Scenario = [string, (ctx: { installation: string; tok: string; thread: string }) => Promise<void>, string[]];
    const scenarios: Scenario[] = [
      ['read before send', async ({ thread }) => { await db`UPDATE flightdeck_pg_notification_items SET read_at = NOW() WHERE recipient_actor_id = ${actors[2]!} AND subject->>'thread_id' = ${thread}`; }, ['read_before_send']],
      ['transport revoked', async ({ installation }) => { await call(`${base()}/notifications/apns-devices/${installation}`, 'DELETE', 2); }, ['transport_revoked']],
      ['lease expired', async ({ tok }) => { await db`UPDATE flightdeck_pg_notification_transports SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE address = ${tok}`; }, ['lease_expired']],
      ['permission denied', async ({ installation }) => { await db`UPDATE flightdeck_pg_notification_installations SET permission_state = 'denied' WHERE id = ${installation}`; }, ['permission_not_granted']],
      ['permission unknown', async ({ installation }) => { await db`UPDATE flightdeck_pg_notification_installations SET permission_state = 'unknown' WHERE id = ${installation}`; }, ['permission_not_granted']],
      ['alert rule turned off', async () => { await n('/rules', 'PUT', 2, { mutation_id: randomUUID(), rules: [{ category: 'mention', source_app_id: 'flightdeck.core', channel: 'alert', mode: 'off', expected_row_version: 0 }] }); }, ['alert_rule_off']],
      ['transport owner changed', async ({ tok }) => { await db`UPDATE flightdeck_pg_notification_transports SET actor_id = ${actors[3]!} WHERE address = ${tok}`; }, ['transport_owner_changed']],
      ['enrollment removed in the database', async ({ installation }) => { await db`UPDATE flightdeck_pg_notification_installations SET enrolled_workspace_ids = '{}' WHERE id = ${installation}`; }, ['not_enrolled']],
      ['stale token status', async ({ tok }) => { await db`UPDATE flightdeck_pg_notification_transports SET status = 'stale' WHERE address = ${tok}`; }, ['transport_revoked']],
      ['record access revoked', async () => { await db`UPDATE flightdeck_pg_permission_grants SET revoked_at = NOW() WHERE principal_actor_id = ${actors[2]!} AND resource_channel_id = ${ch1}`; }, ['no_access', 'item_removed']],
      ['item tombstoned (removed)', async ({ thread }) => { await db`UPDATE flightdeck_pg_notification_items SET removed_at = NOW(), removal_reason = 'source_revoked' WHERE recipient_actor_id = ${actors[2]!} AND subject->>'thread_id' = ${thread}`; }, ['item_removed']],
      ['membership removed', async () => { await db`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id = ${w1} AND actor_id = ${actors[2]!}`; }, ['membership_revoked']],
    ];
    for (const [name, mutate, reasons] of scenarios) {
      const { installation, tok } = await freshBob();
      const thread = await ping();
      expect((await alertsFor()).filter((a) => a.state === 'pending').length, name).toBe(1);
      await mutate({ installation, tok, thread });
      const { calls, sender } = recorder();
      await processAlertBatch({ sql: db, sender });
      expect(calls, name).toHaveLength(0);
      const states = await alertsFor();
      expect(states.at(-1)!.state, name).toBe('suppressed');
      expect(reasons, name).toContain(states.at(-1)!.reason);
      // restore for the next scenario
      await db`UPDATE flightdeck_pg_permission_grants SET revoked_at = NULL WHERE principal_actor_id = ${actors[2]!} AND resource_channel_id = ${ch1}`;
      await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w1},${actors[2]!},'member') ON CONFLICT DO NOTHING`;
      // deleting a membership cascades the actor's grants
      if (!(await db`SELECT 1 FROM flightdeck_pg_permission_grants WHERE principal_actor_id = ${actors[2]!} AND resource_channel_id = ${ch1} AND revoked_at IS NULL`).length) await grant(actors[2]!, ch1, 'channel.read');
    }
  });

  test('provider outcomes: transient backoff, 429 retry-after, stale token, credential breaker, permanent, network, exhaustion', async () => {
    const run = async (result: Partial<ApnsResult> | Error, prep?: () => Promise<void>) => {
      const { tok } = await freshBob(); await ping(); if (prep) await prep();
      const r = recorder(() => result);
      await processAlertBatch({ sql: db, sender: r.sender });
      const [alert] = await alertsFor();
      const [transport] = await db`SELECT status FROM flightdeck_pg_notification_transports WHERE address = ${tok}`;
      return { alert: alert!, transport: transport!.status as string };
    };
    const t503 = await run({ status: 503, reason: 'ServiceUnavailable' });
    expect(t503.alert).toMatchObject({ state: 'failed', attempt_count: 1, provider_status: 503, error_class: 'ServiceUnavailable' });
    expect(new Date(t503.alert.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(20_000);
    const attempts = await db`SELECT outcome FROM flightdeck_pg_notification_alert_attempts WHERE alert_id = ${t503.alert.id}`;
    expect(attempts.map((a) => a.outcome)).toEqual(['transient']);
    // not retried before next_attempt_at
    expect((await processAlertBatch({ sql: db, sender: recorder().sender })).claimed).toBe(0);

    const t429 = await run({ status: 429, reason: 'TooManyRequests', retryAfterMs: 120_000 });
    expect(new Date(t429.alert.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(100_000);

    for (const result of [{ status: 410, reason: 'Unregistered' }, { status: 400, reason: 'BadDeviceToken' }, { status: 400, reason: 'DeviceTokenNotForTopic' }]) {
      const out = await run(result);
      expect(out.transport).toBe('stale');
      expect(out.alert).toMatchObject({ state: 'dead', reason: 'transport_gone' });
    }
    // a stale transport never delivers again, and further alerts are not queued for it
    await ping();
    expect((await alertsFor()).filter((a) => a.state === 'pending')).toHaveLength(0);

    const cred = await run({ status: 403, reason: 'ExpiredProviderToken' });
    expect(cred.alert).toMatchObject({ state: 'failed', reason: 'provider_credential', attempt_count: 0 });
    expect(cred.transport).toBe('active');
    expect(alertStatus.breakerOpenUntil).toBeGreaterThan(Date.now());
    expect((await processAlertBatch({ sql: db, sender: recorder().sender })).claimed).toBe(0); // breaker open
    alertStatus.breakerOpenUntil = 0;

    expect((await run({ status: 400, reason: 'PayloadEmpty' })).alert).toMatchObject({ state: 'dead', reason: 'provider_rejected' });
    const net = await run(new Error('socket hang up'));
    expect(net.alert).toMatchObject({ state: 'failed', error_class: 'network_error' });
    expect((await run(new Error('apns_timeout'))).alert.error_class).toBe('timeout');
    const exhausted = await run({ status: 503, reason: 'ServiceUnavailable' }, async () => { await db`UPDATE flightdeck_pg_notification_alerts SET attempt_count = 5 WHERE state = 'pending'`; });
    expect(exhausted.alert).toMatchObject({ state: 'dead', reason: 'retries_exhausted', attempt_count: 6 });
  });

  test('two workers never send one alert twice; a crashed lease is recovered with a write-ahead record', async () => {
    await freshBob(); await ping();
    const r = recorder({}, 80);
    const [a, b] = await Promise.all([processAlertBatch({ sql: db, sender: r.sender, owner: 'w-a' }), processAlertBatch({ sql: db, sender: r.sender, owner: 'w-b' })]);
    expect(r.calls).toHaveLength(1);
    expect(a.sent + b.sent).toBe(1);

    await freshBob(); await ping();
    const [alert] = (await alertsFor()).slice(-1);
    // simulate a worker that wrote its attempt, then died before the provider answered
    await db`UPDATE flightdeck_pg_notification_alerts SET state = 'leased', lease_owner = 'dead-worker', lease_until = NOW() - INTERVAL '1 second', attempt_count = 1 WHERE id = ${alert!.id}`;
    await db`INSERT INTO flightdeck_pg_notification_alert_attempts(alert_id, attempt_no) VALUES (${alert!.id}, 1)`;
    // a live lease is not stolen
    const live = recorder();
    await db`UPDATE flightdeck_pg_notification_alerts SET lease_until = NOW() + INTERVAL '30 seconds' WHERE id = ${alert!.id}`;
    expect((await processAlertBatch({ sql: db, sender: live.sender })).claimed).toBe(0);
    await db`UPDATE flightdeck_pg_notification_alerts SET lease_until = NOW() - INTERVAL '1 second' WHERE id = ${alert!.id}`;
    const rec = recorder();
    expect((await processAlertBatch({ sql: db, sender: rec.sender })).sent).toBe(1);
    const attempts = await db`SELECT attempt_no, outcome FROM flightdeck_pg_notification_alert_attempts WHERE alert_id = ${alert!.id} ORDER BY attempt_no`;
    expect(attempts.map((x) => [x.attempt_no, x.outcome])).toEqual([[1, 'interrupted'], [2, 'sent']]);
  });

  test('a folded item re-alerts under a new generation only after the previous alert left the queue', async () => {
    await freshBob();
    const thread = await threadFor(1);
    await message(1, thread, [2]);
    expect((await alertsFor())).toHaveLength(1);
    await message(1, thread, [2]); // folds while the first alert is still pending: no sibling
    expect((await alertsFor())).toHaveLength(1);
    const first = recorder();
    await processAlertBatch({ sql: db, sender: first.sender });
    await message(1, thread, [2]); // folds after delivery: new generation, same collapse id
    const rows = await alertsFor();
    expect(rows.map((r) => [r.generation, r.state])).toEqual([[1, 'sent'], [2, 'pending']]);
    const second = recorder();
    await processAlertBatch({ sql: db, sender: second.sender });
    expect(second.calls[0]!.collapseId).toBe(first.calls[0]!.collapseId);
  });

  test('an alert insert failure aborts the projection: no item commits, intake retries, then exactly one item and alert', async () => {
    await freshBob();
    const items = async () => (await db`SELECT COUNT(*)::int AS c FROM flightdeck_pg_notification_items WHERE recipient_actor_id = ${actors[2]!}`)[0]!.c as number;
    const before = await items();
    await db.unsafe(`CREATE OR REPLACE FUNCTION test_fail_alert_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced alert insert failure'; END $$ LANGUAGE plpgsql`);
    await db.unsafe('CREATE TRIGGER test_fail_alert_insert BEFORE INSERT ON flightdeck_pg_notification_alerts FOR EACH ROW EXECUTE FUNCTION test_fail_alert_insert()');
    const originalError = console.error; console.error = () => {};
    try { await ping(); } finally { console.error = originalError; await db.unsafe('DROP TRIGGER test_fail_alert_insert ON flightdeck_pg_notification_alerts'); }
    expect(await items()).toBe(before);
    expect((await alertsFor()).length).toBe(0);
    const failed = await db`SELECT state, last_error FROM flightdeck_pg_notification_intake WHERE last_error LIKE '%forced alert insert failure%'`;
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.state === 'pending')).toBe(true);
    await db`UPDATE flightdeck_pg_notification_intake SET next_attempt_at = NOW() WHERE state = 'pending'`;
    await drain();
    expect(await items()).toBe(before + 1);
    expect((await alertsFor()).length).toBe(1);
    expect((await db`SELECT COUNT(*)::int AS c FROM flightdeck_pg_notification_intake WHERE state = 'pending'`)[0]!.c).toBe(0);
  });

  test('a lease that expired before the provider call sends nothing and burns no attempt; claims never exceed what runs at once', async () => {
    await freshBob();
    for (let i = 0; i < 10; i++) await ping();
    const wide = recorder({}, 20);
    const stats = await processAlertBatch({ sql: db, sender: wide.sender, limit: 25 });
    expect(stats.claimed).toBe(8);
    expect(wide.calls).toHaveLength(8);

    await freshBob(); await ping();
    const [alert] = await alertsFor();
    const old = recorder(); const fresh = recorder();
    const oldRun = await processAlertBatch({
      sql: db, sender: old.sender, owner: 'old-owner',
      // the old owner stalls past its lease; another worker reclaims and delivers before the old one reaches the provider
      beforeSend: async () => {
        await db`UPDATE flightdeck_pg_notification_alerts SET lease_until = NOW() - INTERVAL '1 second' WHERE id = ${alert!.id}`;
        expect((await processAlertBatch({ sql: db, sender: fresh.sender, owner: 'new-owner' })).sent).toBe(1);
      },
    });
    expect(old.calls).toHaveLength(0);
    expect(fresh.calls).toHaveLength(1);
    expect(oldRun.sent).toBe(0);
    expect(oldRun.skipped).toBe(1);
    const [row] = await alertsFor();
    expect(row!.state).toBe('sent');
    expect(row!.attempt_count).toBe(1);
    const attempts = await db`SELECT attempt_no, outcome FROM flightdeck_pg_notification_alert_attempts WHERE alert_id = ${alert!.id}`;
    expect(attempts.map((x) => [x.attempt_no, x.outcome])).toEqual([[1, 'sent']]);
  });

  test('ES256 key must be P-256; the provider token follows key rotation under unchanged ids', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.APNS_AUTH_KEY = p384;
    expect(loadApnsConfig()).toEqual({ ready: false, reason: 'provider_key_invalid' });
    expect(transportAdvertisement().transport_status.apns).toMatchObject({ ready: false, reason: 'provider_key_invalid' });

    const check = (jwt: string, publicKey: import('node:crypto').KeyObject) => {
      const [h, c, sig] = jwt.split('.');
      return verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'));
    };
    const rotated = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const load = (pem: string) => { process.env.APNS_AUTH_KEY = pem; const r = loadApnsConfig(); if (!r.ready) throw new Error(r.reason); return r.config; };
    const first = providerToken(load(keyPem), 1_000_000);
    expect(providerToken(load(keyPem), 1_000_500)).toBe(first); // same key: cached
    const second = providerToken(load(rotated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), 1_001_000);
    expect(second).not.toBe(first);
    expect(check(first, ec.publicKey)).toBe(true);
    expect(check(second, rotated.publicKey)).toBe(true);
    expect(check(second, ec.publicKey)).toBe(false);
  });

  test('no eligible https origin for a transport: delivery is explicitly not ready and nothing is queued', async () => {
    await freshBob();
    delete process.env.NOTIF_PUBLIC_ORIGIN;
    const res = await register(2, randomUUID(), token()); // test requests arrive over http://localhost: no https origin to fall back on
    expect(res.status).toBe(200);
    expect(res.body.delivery).toEqual({ ready: false, reason: 'origin_unavailable' });
    expect(transportAdvertisement()).toMatchObject({ public_origin_configured: false });
    await ping();
    expect((await alertsFor()).length).toBe(0);

    process.env.NOTIF_PUBLIC_ORIGIN = 'https://tower.example';
    expect(transportAdvertisement()).toMatchObject({ public_origin_configured: true });
    const ok = await register(2, randomUUID(), token());
    expect(ok.body.delivery).toEqual({ ready: true });
  });

  test('real HTTP/2 adapter: environment routing, headers, ES256 provider token, and error mapping', async () => {
    await freshBob();
    const seen: Record<'sandbox' | 'production', { headers: http2.IncomingHttpHeaders; body: string }[]> = { sandbox: [], production: [] };
    const servers: http2.Http2Server[] = [];
    let respond: { status: number; reason?: string } = { status: 200 };
    const start = (env: 'sandbox' | 'production') => new Promise<string>((resolve) => {
      const server = http2.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          seen[env].push({ headers: { ...req.headers, ':path': req.url }, body: Buffer.concat(chunks).toString() });
          res.writeHead(respond.status, { 'apns-id': 'fake-id', 'content-type': 'application/json' });
          res.end(respond.reason ? JSON.stringify({ reason: respond.reason }) : '');
        });
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as any).port}`));
    });
    try {
      process.env.APNS_HOST_SANDBOX = await start('sandbox');
      process.env.APNS_HOST_PRODUCTION = await start('production');
      const prodInstall = randomUUID(); const prodTok = token();
      expect((await n(`/apns-devices/${prodInstall}`, 'PUT', 2, apnsBody(prodTok, { environment: 'production' }))).status).toBe(200);
      const [sandboxTok] = (await db`SELECT address FROM flightdeck_pg_notification_transports WHERE environment = 'sandbox' AND status = 'active'`).map((r) => r.address as string);
      await ping();
      const stats = await processAlertBatch({ sql: db, sender: sendApns });
      expect(stats).toMatchObject({ claimed: 2, sent: 2 });
      expect(seen.sandbox).toHaveLength(1); expect(seen.production).toHaveLength(1);
      expect(seen.sandbox[0]!.headers[':path']).toBe(`/3/device/${sandboxTok}`);
      expect(seen.production[0]!.headers[':path']).toBe(`/3/device/${prodTok}`);
      for (const env of ['sandbox', 'production'] as const) {
        const h = seen[env][0]!.headers;
        expect(h['apns-push-type']).toBe('alert'); expect(h['apns-priority']).toBe('10'); expect(h['apns-topic']).toBe(TOPIC);
        expect(String(h['apns-collapse-id']).length).toBeLessThanOrEqual(64); expect(Number(h['apns-expiration'])).toBeGreaterThan(Date.now() / 1000);
        const jwt = String(h.authorization).replace(/^bearer /, '').split('.');
        expect(JSON.parse(Buffer.from(jwt[0]!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'TESTKEYID1' });
        expect(JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString()).iss).toBe('TESTTEAM12');
        expect(verify('sha256', Buffer.from(`${jwt[0]}.${jwt[1]}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2]!, 'base64url'))).toBe(true);
        expect(JSON.parse(seen[env][0]!.body).aps.alert.title).toBe('You were mentioned');
      }
      // the provider token is cached across sends
      const before = seen.sandbox[0]!.headers.authorization;
      await ping();
      await processAlertBatch({ sql: db, sender: sendApns });
      expect(seen.sandbox[1]!.headers.authorization).toBe(before);
      // Apple error mapping through the real transport
      respond = { status: 410, reason: 'Unregistered' };
      await ping();
      await processAlertBatch({ sql: db, sender: sendApns });
      expect((await db`SELECT status FROM flightdeck_pg_notification_transports WHERE address = ${sandboxTok!}`)[0]!.status).toBe('stale');
      // unreachable provider = transient, never "sent"
      process.env.APNS_HOST_PRODUCTION = 'http://127.0.0.1:9';
      expect((await n(`/apns-devices/${randomUUID()}`, 'PUT', 2, apnsBody(token(), { environment: 'production' }))).status).toBe(200);
      respond = { status: 200 };
      await ping();
      await processAlertBatch({ sql: db, sender: sendApns });
      const last = (await alertsFor()).at(-1)!; expect([last.state, last.reason, last.error_class]).toEqual(['failed', 'transient', 'network_error']);
    } finally {
      for (const s of servers) s.close();
      delete process.env.APNS_HOST_SANDBOX; delete process.env.APNS_HOST_PRODUCTION;
    }
  });

  test('a stream that closes without a complete HTTP response is transient: no hidden sender retry, retried only by the worker, never dead', async () => {
    let drop = 0;
    let requests = 0;
    let mode: 'cancel' | 'headers_then_reset' = 'cancel';
    const server = http2.createServer((req, res) => {
      requests += 1;
      req.resume();
      req.on('end', () => {
        if (drop > 0) {
          drop -= 1;
          if (mode === 'cancel') { req.stream.close(http2.constants.NGHTTP2_CANCEL); return; }
          res.writeHead(200, { 'apns-id': 'fake-id' }); res.write('{"reason":"Partial');
          setTimeout(() => req.stream.close(http2.constants.NGHTTP2_CANCEL), 20);
          return;
        }
        res.writeHead(200, { 'apns-id': 'fake-id' }); res.end('');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      process.env.APNS_HOST_SANDBOX = `http://127.0.0.1:${(server.address() as any).port}`;
      // each provider request is exactly one worker attempt: a reset surfaces as a retryable failure, not provider_rejected or dead
      for (const m of ['cancel', 'headers_then_reset'] as const) {
        mode = m; drop = 1; requests = 0;
        await freshBob();
        await ping();
        expect(await processAlertBatch({ sql: db, sender: sendApns })).toMatchObject({ claimed: 1, sent: 0, dead: 0, retried: 1 });
        expect(requests).toBe(1);
        const last = (await alertsFor()).at(-1)!;
        expect([last.state, last.reason]).toEqual(['failed', 'transient']);
        expect(['no_response', 'network_error']).toContain(last.error_class);
        const attempt = (await db`SELECT outcome, provider_status FROM flightdeck_pg_notification_alert_attempts WHERE alert_id = ${last.id}`)[0]!;
        expect(attempt.outcome).toBe('transient');
        expect(attempt.provider_status).toBeNull();
      }
      // headers followed by a premature reset must reject at the sender, never resolve with the partial status
      mode = 'headers_then_reset'; drop = 1;
      const loaded = loadApnsConfig(); if (!loaded.ready) throw new Error(loaded.reason); const cfg = loaded.config;
      const input = { environment: 'sandbox', deviceToken: 'a'.repeat(64), topic: 'studio.test', collapseId: 'n-x', expiration: 0, body: '{}' } as ApnsSendInput;
      await expect(sendApns(cfg, input)).rejects.toThrow();
      // a failed request evicts only its own session: a concurrent request on the shared session still completes, and the next send works
      mode = 'cancel'; drop = 1;
      const settled = await Promise.allSettled([sendApns(cfg, input), sendApns(cfg, input)]);
      expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((await sendApns(cfg, input)).status).toBe(200);
    } finally {
      server.close();
      delete process.env.APNS_HOST_SANDBOX;
    }
  });

  test('descriptor, admin queue and OpenAPI describe the push surface', async () => {
    const doc = buildOpenApiDocument('http://localhost') as any;
    for (const path of ['installations/{installationId}', 'installations/{installationId}/transports/{kind}', 'apns-devices/{installationId}']) {
      expect(doc.paths[`/api/v4/flightdeck-pg/workspaces/{workspaceId}/notifications/${path}`]).toBeTruthy();
    }
    expect(transportAdvertisement()).toMatchObject({ alerts: true, transport_status: { apns: { ready: true, environments: ['sandbox', 'production'] } } });
    expect(transportAdvertisement().transports).not.toContain('fcm');
    const queue = await call(`${base()}/admin/notifications/queue`, 'GET', 0);
    expect(queue.status === 200 || queue.status === 403).toBe(true);
  });
});
