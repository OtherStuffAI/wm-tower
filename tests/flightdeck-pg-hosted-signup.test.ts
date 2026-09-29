import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { setDb, closeDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';

const dbName = 'coworker_v4_test_hosted_signup';
const userSecret = new Uint8Array(32).fill(81);
const siteSecret = new Uint8Array(32).fill(82);
const otherSecret = new Uint8Array(32).fill(83);
const userNpub = nip19.npubEncode(getPublicKey(userSecret));
const siteNpub = nip19.npubEncode(getPublicKey(siteSecret));
const path = '/api/v4/flightdeck-pg/hosted/workspaces';
const url = `http://localhost${path}`;
const app = createApp();
let sql: ReturnType<typeof postgres>;
const oldSites = config.flightDeck.hostedSignupSiteNpubs;
const oldHourly = config.flightDeck.hostedSignupHourlyLimit;
const oldMax = config.flightDeck.hostedSignupMaxWorkspaces;

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const body = (name: string, key = crypto.randomUUID()) => JSON.stringify({ workspace_name: name, idempotency_key: key, terms_version: 'hosted-free-v1' });
function sign(secret: Uint8Array, rawBody: string, extra: string[][] = [], target = url, method = 'POST', timestamp = Math.floor(Date.now() / 1000)) {
  return finalizeEvent({ kind: 27235, created_at: timestamp,
    tags: [['u', target], ['method', method], ['payload', hash(rawBody)], ...extra], content: crypto.randomUUID() }, secret);
}
function encode(event: object) { return Buffer.from(JSON.stringify(event)).toString('base64'); }
async function send(rawBody: string, options: { user?: any; site?: any; omitUser?: boolean; omitSite?: boolean } = {}) {
  const user = options.user ?? sign(userSecret, rawBody);
  const site = options.site ?? sign(siteSecret, rawBody, [['user_event_id', user.id]]);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!options.omitUser) headers.authorization = `Nostr ${encode(user)}`;
  if (!options.omitSite) headers['x-flightdeck-site-attestation'] = encode(site);
  const response = await app.request(path, { method: 'POST', headers, body: rawBody });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, user, site };
}

beforeAll(async () => {
  const options = { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), username: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres' };
  const admin = postgres({ ...options, database: 'postgres' });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`); await admin.unsafe(`CREATE DATABASE ${dbName}`); }
  finally { await admin.end(); }
  sql = postgres({ ...options, database: dbName });
  setDb(sql);
  const migration = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8');
  for (const statement of splitSqlStatements(migration)) await sql.unsafe(statement);
  await ensureRuntimeSchema(sql);
  config.flightDeck.hostedSignupSiteNpubs = [siteNpub];
  config.flightDeck.hostedSignupHourlyLimit = 20;
  config.flightDeck.hostedSignupMaxWorkspaces = 20;
});
afterAll(async () => {
  config.flightDeck.hostedSignupSiteNpubs = oldSites;
  config.flightDeck.hostedSignupHourlyLimit = oldHourly;
  config.flightDeck.hostedSignupMaxWorkspaces = oldMax;
  await closeDb();
});

describe('Hosted PG signup', () => {
  test('ordinary signer creates, lists, opens, and owns the workspace; retry is idempotent', async () => {
    const raw = body('Hosted Alpha');
    const first = await send(raw);
    expect(first.status).toBe(201);
    expect(first.json.descriptor.identity.workspace_owner_npub).toBe(userNpub);
    expect(first.json.policy.allowance_bytes).toBe(1_000_000_000);
    expect(JSON.stringify(first.json)).not.toContain('nsec');
    const membership = await sql`SELECT m.role FROM flightdeck_pg_workspace_memberships m JOIN flightdeck_pg_actors a ON a.id=m.actor_id WHERE m.workspace_id=${first.json.workspace_id} AND a.npub=${userNpub}`;
    expect(membership[0]?.role).toBe('owner');
    const retry = await send(raw);
    expect(retry.status).toBe(200);
    expect(retry.json.workspace_id).toBe(first.json.workspace_id);
    const replay = await send(raw, { user: first.user, site: first.site });
    expect(replay.json.code).toBe('signature_replayed');
    const listing = await app.request('/api/v4/flightdeck-pg/workspaces', { headers: { authorization: `Nostr ${encode(sign(userSecret, '', [], 'http://localhost/api/v4/flightdeck-pg/workspaces', 'GET'))}` } });
    expect(listing.status).toBe(200);
    expect((await listing.json()).workspaces.some((w: any) => w.identity.workspace_id === first.json.workspace_id)).toBe(true);
    const descriptorPath = `/api/v4/flightdeck-pg/workspaces/${first.json.workspace_id}/descriptor`;
    const descriptor = await app.request(descriptorPath, { headers: { authorization: `Nostr ${encode(sign(userSecret, '', [], `http://localhost${descriptorPath}`, 'GET'))}` } });
    expect(descriptor.status).toBe(200);
  });

  test('requires both exact signature layers and rejects owner nomination', async () => {
    const raw = body('Negative Alpha');
    expect((await send(raw, { omitUser: true })).status).toBe(401);
    expect((await send(raw, { omitSite: true })).json.code).toBe('site_attestation_required');
    const user = sign(userSecret, raw);
    expect((await send(raw, { user: { ...user, sig: '0'.repeat(128) } })).json.code).toBe('nip98_invalid_event');
    expect((await send(raw, { site: { ...sign(siteSecret, raw, [['user_event_id', user.id]]), sig: '0'.repeat(128) } })).json.code).toBe('site_attestation_invalid');
    expect((await send(raw, { user, site: sign(otherSecret, raw, [['user_event_id', user.id]]) })).json.code).toBe('site_not_allowed');
    expect((await send(raw, { user, site: sign(siteSecret, raw, [['user_event_id', '0'.repeat(64)]]) })).json.code).toBe('site_attestation_mismatch');
    expect((await send(raw, { user: sign(userSecret, raw, [], `${url}/wrong`) })).json.code).toBe('nip98_url_mismatch');
    expect((await send(raw, { user: sign(userSecret, raw, [], url, 'GET') })).json.code).toBe('nip98_method_mismatch');
    expect((await send(raw, { user: sign(userSecret, raw, [], url, 'POST', Math.floor(Date.now()/1000)-90) })).json.code).toBe('nip98_stale_event');
    expect((await send(raw, { user: sign(userSecret, raw + ' ', []) })).json.code).toBe('nip98_payload_mismatch');
    expect((await send(raw, { user, site: sign(siteSecret, raw, [['user_event_id', user.id]], `${url}/wrong`) })).json.code).toBe('site_attestation_mismatch');
    expect((await send(raw, { user, site: sign(siteSecret, raw, [['user_event_id', user.id]], url, 'GET') })).json.code).toBe('site_attestation_mismatch');
    expect((await send(raw, { user, site: sign(siteSecret, raw, [['user_event_id', user.id]], url, 'POST', Math.floor(Date.now()/1000)-90) })).json.code).toBe('site_attestation_expired');
    expect((await send(JSON.stringify({ ...JSON.parse(raw), workspace_owner_npub: nip19.npubEncode(getPublicKey(otherSecret)) }))).json.code).toBe('invalid_body');
  });

  test('concurrency, duplicate names, rate limit and quota are enforced', async () => {
    const raw = body('Concurrent Alpha');
    const [a, b] = await Promise.all([send(raw), send(raw)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.json.workspace_id).toBe(b.json.workspace_id);
    expect((await send(body('concurrent alpha'))).json.code).toBe('workspace_name_taken');
    config.flightDeck.hostedSignupHourlyLimit = 2;
    expect((await send(body('Hourly Blocked'))).json.code).toBe('signup_rate_limited');
    config.flightDeck.hostedSignupHourlyLimit = 20;
    config.flightDeck.hostedSignupMaxWorkspaces = 2;
    expect((await send(body('Quota Blocked'))).json.code).toBe('hosted_workspace_limit');
  });

  test('idempotency conflict and failed audit roll back the entire workspace', async () => {
    config.flightDeck.hostedSignupMaxWorkspaces = 20;
    const firstBody = body('Conflict Alpha');
    expect((await send(firstBody)).status).toBe(201);
    const changed = JSON.stringify({ ...JSON.parse(firstBody), workspace_name: 'Changed Alpha' });
    expect((await send(changed)).json.code).toBe('idempotency_conflict');

    await sql.unsafe(`CREATE FUNCTION reject_hosted_signup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'hosted_signup.create' THEN RAISE EXCEPTION 'test audit rejection'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER reject_hosted_signup_audit BEFORE INSERT ON flightdeck_pg_audit_events FOR EACH ROW EXECUTE FUNCTION reject_hosted_signup_audit()`);
    try {
      expect((await send(body('Rollback Alpha'))).status).toBe(500);
      const workspaces = await sql`SELECT id FROM flightdeck_pg_workspaces WHERE workspace_owner_npub=${userNpub} AND name='Rollback Alpha'`;
      expect(workspaces).toHaveLength(0);
      const signups = await sql`SELECT workspace_id FROM flightdeck_pg_hosted_signups WHERE owner_npub=${userNpub} AND workspace_name_key='rollback alpha'`;
      expect(signups).toHaveLength(0);
    } finally {
      await sql.unsafe('DROP TRIGGER reject_hosted_signup_audit ON flightdeck_pg_audit_events');
      await sql.unsafe('DROP FUNCTION reject_hosted_signup_audit()');
    }
  });
});
