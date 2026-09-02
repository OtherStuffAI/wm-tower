import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { cleanupWappActivity, listVisibleWappActivity, resolveVisibleWappActivity } from '../src/services/wapp-activity';
import { createWappDelegation } from '../src/services/wapp-management';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_wapp_activity';
const ownerSecret = new Uint8Array(32).fill(71);
const memberSecret = new Uint8Array(32).fill(72);
const publisherSecret = new Uint8Array(32).fill(73);
const nextPublisherSecret = new Uint8Array(32).fill(74);
const unknownPublisherSecret = new Uint8Array(32).fill(75);
const ownerNpub = nip19.npubEncode(getPublicKey(ownerSecret));
const memberNpub = nip19.npubEncode(getPublicKey(memberSecret));
const publisherNpub = nip19.npubEncode(getPublicKey(publisherSecret));
const nextPublisherNpub = nip19.npubEncode(getPublicKey(nextPublisherSecret));

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
let workspaceId: string;
let scopeId: string;
let channelId: string;
let otherChannelId: string;
let ownerActorId: string;
let memberActorId: string;

function splitSqlStatements(migration: string): string[] {
  const statements: string[] = [];
  let current = '';
  let dollarQuote: string | null = null;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  for (let i = 0; i < migration.length; i += 1) {
    const char = migration[i];
    const next = migration[i + 1];
    if (lineComment) { if (char === '\n') { lineComment = false; current += char; } continue; }
    if (!singleQuoted && !doubleQuoted && !dollarQuote && char === '-' && next === '-') { lineComment = true; i += 1; continue; }
    if (!singleQuoted && !doubleQuoted && char === '$') {
      const match = migration.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) { const tag = match[0]; dollarQuote = dollarQuote === tag ? null : dollarQuote || tag; current += tag; i += tag.length - 1; continue; }
    }
    current += char;
    if (dollarQuote) continue;
    if (!doubleQuoted && char === "'" && migration[i - 1] !== '\\') { singleQuoted = !singleQuoted; continue; }
    if (!singleQuoted && char === '"') { doubleQuoted = !doubleQuoted; continue; }
    if (!singleQuoted && !doubleQuoted && char === ';') { const statement = current.slice(0, -1).trim(); if (statement) statements.push(statement); current = ''; }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function authHeader(path: string, method: string, secret: Uint8Array, body?: unknown) {
  const tags = [['u', `http://localhost${path}`], ['method', method.toUpperCase()]];
  if (body !== undefined) tags.push(['payload', createHash('sha256').update(JSON.stringify(body)).digest('hex')]);
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, secret);
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

async function request(path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', secret: Uint8Array, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers, Authorization: authHeader(path, method, secret, body) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = response.status === 304 ? null : await response.json();
  return { response, json };
}

function grantBody() {
  return {
    app_id: 'kindling-runtime',
    publisher_npub: publisherNpub,
    owner_npub: ownerNpub,
    display_name: 'Kindling',
    capabilities: ['activity.publish'],
    destinations: [{ scope_id: scopeId, channel_id: channelId }],
    registered_open_origins: ['https://kindling.example.invalid'],
  };
}

function publication(externalId: string, version = 1, patch: Record<string, unknown> = {}) {
  return {
    external_id: externalId,
    version,
    scope_id: scopeId,
    channel_id: channelId,
    category: 'lead',
    title: 'New lead',
    summary: 'Reach out today',
    occurred_at: new Date().toISOString(),
    priority: 'normal',
    state: 'active',
    open_url: 'https://kindling.example.invalid/leads/123',
    ...patch,
  };
}

beforeAll(async () => {
  const admin = postgres({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), database: 'postgres', username: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres' });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`); await admin.unsafe(`CREATE DATABASE ${TEST_DB}`); } finally { await admin.end(); }
  sql = postgres({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), database: TEST_DB, username: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres' });
  const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/schema/001_init.sql'), 'utf8');
  for (const statement of splitSqlStatements(migration)) await sql.unsafe(statement);
  setDb(sql);
  app = createApp();

  [ownerActorId] = (await sql<{ id: string }[]>`INSERT INTO flightdeck_pg_actors (npub, kind, display_name) VALUES (${ownerNpub}, 'human', 'Owner') RETURNING id`).map((row) => row.id);
  [memberActorId] = (await sql<{ id: string }[]>`INSERT INTO flightdeck_pg_actors (npub, kind, display_name) VALUES (${memberNpub}, 'human', 'Member') RETURNING id`).map((row) => row.id);
  [workspaceId] = (await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_workspaces (tower_service_npub, workspace_service_npub, workspace_owner_npub, app_npub, name, slug, created_by_actor_id)
    VALUES ('npub1tower', 'npub1workspace', ${ownerNpub}, ${config.flightDeck.appNpub}, 'WApp Test', 'wapp-test', ${ownerActorId}) RETURNING id
  `).map((row) => row.id);
  await sql`INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id) VALUES (${workspaceId}, ${ownerActorId}, 'owner', ${ownerActorId}), (${workspaceId}, ${memberActorId}, 'member', ${ownerActorId})`;
  [scopeId] = (await sql<{ id: string }[]>`INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id) VALUES (${workspaceId}, 'Sales', 'department', ${ownerActorId}) RETURNING id`).map((row) => row.id);
  const channels = await sql<{ id: string; name: string }[]>`
    INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, created_by_actor_id)
    VALUES (${workspaceId}, ${scopeId}, 'Leads', ${ownerActorId}), (${workspaceId}, ${scopeId}, 'Private', ${ownerActorId}) RETURNING id, name
  `;
  channelId = channels.find((row) => row.name === 'Leads')!.id;
  otherChannelId = channels.find((row) => row.name === 'Private')!.id;
  await sql`
    INSERT INTO flightdeck_pg_permission_grants (workspace_id, principal_type, principal_actor_id, resource_type, permission, created_by_actor_id)
    VALUES (${workspaceId}, 'actor', ${ownerActorId}, 'workspace', 'workspace.manage', ${ownerActorId})
  `;
  await sql`
    INSERT INTO flightdeck_pg_permission_grants (workspace_id, principal_type, principal_actor_id, resource_type, resource_scope_id, resource_channel_id, permission, created_by_actor_id)
    VALUES
      (${workspaceId}, 'actor', ${ownerActorId}, 'channel', ${scopeId}, ${channelId}, 'channel.read', ${ownerActorId}),
      (${workspaceId}, 'actor', ${memberActorId}, 'channel', ${scopeId}, ${channelId}, 'channel.read', ${ownerActorId})
  `;
});

afterAll(async () => { await closeDb(); });

describe('WApp-to-Flight-Deck publishing v1', () => {
  test('registers a non-member publisher and exposes only its signed self-grant', async () => {
    const path = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/wapp-publishing-grants/kindling-installation`;
    const created = await request(path, 'PUT', ownerSecret, grantBody());
    expect(created.response.status).toBe(201);
    expect(created.json.grant).toMatchObject({ app_id: 'kindling-runtime', wapp_installation_id: 'kindling-installation', publisher_npub: publisherNpub, flightdeck_app_npub: config.flightDeck.appNpub, owner_npub: ownerNpub, status: 'active' });

    const selfPath = `/api/v4/wapp-activity/workspaces/${workspaceId}/grants/me`;
    const own = await request(selfPath, 'GET', publisherSecret);
    expect(own.response.status).toBe(200);
    expect(own.json.grant.destinations).toHaveLength(1);
    const cached = await request(selfPath, 'GET', publisherSecret, undefined, { 'If-None-Match': own.response.headers.get('etag')! });
    expect(cached.response.status).toBe(304);

    const unknown = await request(selfPath, 'GET', unknownPublisherSecret);
    expect(unknown.response.status).toBe(403);
    expect(unknown.json.code).toBe('publisher_not_registered');
    const humanRoute = await request(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/wapp-activity/counts`, 'GET', publisherSecret);
    expect(humanRoute.response.status).toBe(403);
    expect(humanRoute.json.code).toBe('workspace_membership_required');
  });

  test('enforces destinations, safe origins, lifecycle versions, and tombstones', async () => {
    await sql`DELETE FROM flightdeck_pg_wapp_publication_buckets`;
    const path = `/api/v4/wapp-activity/workspaces/${workspaceId}/items`;
    const wrongDestination = await request(path, 'POST', publisherSecret, publication('wrong', 1, { channel_id: otherChannelId }));
    expect(wrongDestination.response.status).toBe(403);
    expect(wrongDestination.json.code).toBe('destination_not_allowed');
    const wrongScope = await request(path, 'POST', publisherSecret, publication('wrong-scope', 1, { scope_id: '00000000-0000-4000-8000-000000000001' }));
    expect(wrongScope.response.status).toBe(409);
    expect(wrongScope.json.code).toBe('destination_scope_changed');
    const unsafe = await request(path, 'POST', publisherSecret, publication('unsafe', 1, { open_url: 'https://evil.example.invalid/lead' }));
    expect(unsafe.response.status).toBe(400);
    expect(unsafe.json.code).toBe('unsafe_open_url');
    const actions = await request(path, 'POST', publisherSecret, { ...publication('actions'), actions: [{ id: 'silent' }] });
    expect(actions.response.status).toBe(400);
    expect(actions.json.code).toBe('validation_failed');
    const declaredIdentity = await request(path, 'POST', publisherSecret, { ...publication('declared-identity'), wapp_installation_id: 'some-other-installation' });
    expect(declaredIdentity.response.status).toBe(400);
    expect(declaredIdentity.json).toMatchObject({ code: 'validation_failed', details: { field: 'wapp_installation_id' } });
    const oversized = await request(path, 'POST', publisherSecret, publication('oversized', 1, { summary: 'x'.repeat(17 * 1024) }));
    expect(oversized.response.status).toBe(413);
    expect(oversized.json.code).toBe('payload_too_large');

    await sql`DELETE FROM flightdeck_pg_wapp_publication_buckets`;
    const initial = publication('lead-1');
    const created = await request(path, 'POST', publisherSecret, initial);
    expect(created.response.status).toBe(201);
    expect(created.json.replayed).toBe(false);
    const replay = await request(path, 'POST', publisherSecret, initial);
    expect(replay.response.status).toBe(200);
    expect(replay.json.replayed).toBe(true);
    const conflict = await request(path, 'POST', publisherSecret, publication('lead-1', 1, { title: 'Changed' }));
    expect(conflict.response.status).toBe(409);
    expect(conflict.json.code).toBe('version_conflict');
    const resolved = await request(path, 'POST', publisherSecret, publication('lead-1', 2, { state: 'resolved' }));
    expect(resolved.response.status).toBe(201);
    const stale = await request(path, 'POST', publisherSecret, publication('lead-1', 1));
    expect(stale.response.status).toBe(409);
    expect(stale.json.code).toBe('stale_version');
    const withdrawn = await request(path, 'POST', publisherSecret, publication('lead-1', 3, { state: 'withdrawn' }));
    expect(withdrawn.response.status).toBe(201);
    const resurrect = await request(path, 'POST', publisherSecret, publication('lead-1', 4));
    expect(resurrect.response.status).toBe(409);
    expect(resurrect.json.code).toBe('withdrawn_tombstone');
  });

  test('applies current ACL to feed, counts, events, read state, dismissal, and mutes', async () => {
    await sql`DELETE FROM flightdeck_pg_wapp_publication_buckets`;
    const publishPath = `/api/v4/wapp-activity/workspaces/${workspaceId}/items`;
    const adminPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/wapp-publishing-grants/kindling-installation`;
    const expandedGrant = grantBody();
    expandedGrant.destinations.push({ scope_id: scopeId, channel_id: otherChannelId });
    expect((await request(adminPath, 'PUT', ownerSecret, expandedGrant)).response.status).toBe(201);
    const privateItem = await request(publishPath, 'POST', publisherSecret, publication('private-item', 1, { channel_id: otherChannelId }));
    expect(privateItem.response.status).toBe(201);
    const first = await request(publishPath, 'POST', publisherSecret, publication('lead-feed'));
    const itemId = first.json.item.id;
    const listPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/wapp-activity/items`;
    const countsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/wapp-activity/counts`;
    const initialVisible = await request(listPath, 'GET', memberSecret);
    expect(initialVisible.json.items.some((item: any) => item.id === itemId)).toBe(true);
    expect(initialVisible.json.items.some((item: any) => item.id === privateItem.json.item.id)).toBe(false);
    expect((await request(countsPath, 'GET', memberSecret)).json.counts.unread).toBeGreaterThan(0);

    const statePath = `${listPath}/${itemId}/user-state`;
    const read = await request(statePath, 'PATCH', memberSecret, { read: true });
    expect(read.json.state.unread).toBe(false);
    await request(publishPath, 'POST', publisherSecret, publication('lead-feed', 2, { title: 'Updated lead' }));
    const detail = await request(`${listPath}/${itemId}`, 'GET', memberSecret);
    expect(detail.json.item.unread).toBe(true);
    await request(statePath, 'PATCH', memberSecret, { dismissed: true });
    expect((await request(listPath, 'GET', memberSecret)).json.items.some((item: any) => item.id === itemId)).toBe(false);
    await request(publishPath, 'POST', publisherSecret, publication('lead-feed', 3, { title: 'Still dismissed' }));
    expect((await request(listPath, 'GET', memberSecret)).json.items.some((item: any) => item.id === itemId)).toBe(false);

    const mutePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/wapp-activity/mutes/category/lead`;
    expect((await request(mutePath, 'PUT', memberSecret, {})).response.status).toBe(201);
    await request(publishPath, 'POST', publisherSecret, publication('lead-muted'));
    expect((await request(listPath, 'GET', memberSecret)).json.items.some((item: any) => item.external_id === 'lead-muted')).toBe(false);
    await request(mutePath, 'DELETE', memberSecret);
    expect((await request(listPath, 'GET', memberSecret)).json.items.some((item: any) => item.external_id === 'lead-muted')).toBe(true);

    const events = await request(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events`, 'GET', memberSecret);
    expect(events.json.events.some((event: any) => event.entity_type === 'wapp_activity_item')).toBe(true);
    expect(events.json.events.some((event: any) => event.entity_id === privateItem.json.item.id)).toBe(false);
    await request(adminPath, 'PUT', ownerSecret, grantBody());
    await sql`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaceId} AND actor_id=${memberActorId}`;
    const lost = await request(countsPath, 'GET', memberSecret);
    expect(lost.response.status).toBe(403);
  });

  test('derives current reader-safe open-link authority for list and detail reads', async () => {
    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspaceId}, ${memberActorId}, 'member', ${ownerActorId})
      ON CONFLICT (workspace_id, actor_id) DO NOTHING
    `;
    await sql`
      INSERT INTO flightdeck_pg_permission_grants
        (workspace_id, principal_type, principal_actor_id, resource_type, resource_scope_id, resource_channel_id, permission, created_by_actor_id)
      VALUES (${workspaceId}, 'actor', ${memberActorId}, 'channel', ${scopeId}, ${channelId}, 'channel.read', ${ownerActorId})
      ON CONFLICT DO NOTHING
    `;
    await sql`DELETE FROM flightdeck_pg_wapp_publication_buckets`;
    const adminPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/wapp-publishing-grants/kindling-installation`;
    expect((await request(adminPath, 'PUT', ownerSecret, grantBody())).response.status).toBe(201);
    const publishPath = `/api/v4/wapp-activity/workspaces/${workspaceId}/items`;
    const linked = await request(publishPath, 'POST', publisherSecret, publication('authority-linked'));
    const noUrl = await request(publishPath, 'POST', publisherSecret, publication('authority-no-url', 1, { open_url: null }));
    expect(linked.response.status).toBe(201);
    expect(noUrl.response.status).toBe(201);

    const serviceList = await listVisibleWappActivity({ workspaceId, actorId: memberActorId, groupIds: [], limit: 200 });
    const serviceLinked = serviceList.find((item) => item.id === linked.json.item.id)!;
    const serviceDetail = await resolveVisibleWappActivity({ workspaceId, itemId: linked.json.item.id, actorId: memberActorId, groupIds: [] });
    expect(serviceLinked).toMatchObject({ source_status: 'active', open_url_allowed: true });
    expect(serviceDetail).toMatchObject({ source_status: 'active', open_url_allowed: true });
    expect(serviceList.find((item) => item.id === noUrl.json.item.id)).toMatchObject({ source_status: 'active', open_url: null, open_url_allowed: false });
    expect(serviceLinked).not.toHaveProperty('registered_open_origins');

    const listPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/wapp-activity/items`;
    const readerList = await request(listPath, 'GET', memberSecret);
    const readerLinked = readerList.json.items.find((item: any) => item.id === linked.json.item.id);
    const readerDetail = await request(`${listPath}/${linked.json.item.id}`, 'GET', memberSecret);
    expect(readerLinked).toMatchObject({ source_status: 'active', open_url_allowed: true });
    expect(readerDetail.json.item).toMatchObject({ source_status: 'active', open_url_allowed: true });
    expect(readerLinked).not.toHaveProperty('registered_open_origins');
    expect(readerDetail.json.item).not.toHaveProperty('registered_open_origins');
    expect((await request(adminPath, 'GET', memberSecret)).response.status).toBe(403);

    await sql`UPDATE flightdeck_pg_wapp_publishing_grants SET status='disabled', disable_open_links=false WHERE workspace_id=${workspaceId}`;
    expect((await request(listPath, 'GET', memberSecret)).json.items.find((item: any) => item.id === linked.json.item.id)).toMatchObject({ source_status: 'disabled', open_url_allowed: false });
    expect((await request(`${listPath}/${linked.json.item.id}`, 'GET', memberSecret)).json.item).toMatchObject({ source_status: 'disabled', open_url_allowed: false });

    await sql`UPDATE flightdeck_pg_wapp_publishing_grants SET status='revoked' WHERE workspace_id=${workspaceId}`;
    expect((await request(listPath, 'GET', memberSecret)).json.items.find((item: any) => item.id === linked.json.item.id)).toMatchObject({ source_status: 'revoked', open_url_allowed: false });

    await sql`UPDATE flightdeck_pg_wapp_publishing_grants SET status='active', disable_open_links=true WHERE workspace_id=${workspaceId}`;
    expect((await request(`${listPath}/${linked.json.item.id}`, 'GET', memberSecret)).json.item).toMatchObject({ source_status: 'active', open_url_allowed: false });

    await sql`UPDATE flightdeck_pg_wapp_publishing_grants SET disable_open_links=false, registered_open_origins=ARRAY['https://replacement.example.invalid']::TEXT[] WHERE workspace_id=${workspaceId}`;
    expect((await request(listPath, 'GET', memberSecret)).json.items.find((item: any) => item.id === linked.json.item.id)).toMatchObject({ source_status: 'active', open_url_allowed: false });

    expect((await request(adminPath, 'PUT', ownerSecret, grantBody())).response.status).toBe(201);
  });

  test('rotates keys, rejects stale keys, and applies disable, revoke, archive, and rate limits immediately', async () => {
    await sql`DELETE FROM flightdeck_pg_wapp_publication_buckets`;
    const adminBase = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/wapp-publishing-grants/kindling-installation`;
    const publishPath = `/api/v4/wapp-activity/workspaces/${workspaceId}/items`;
    const disabled = await request(`${adminBase}/disable`, 'POST', ownerSecret, { disabled: true, reason: 'pause' });
    expect(disabled.json.grant.status).toBe('disabled');
    expect((await request(publishPath, 'POST', publisherSecret, publication('disabled'))).json.code).toBe('publishing_grant_disabled');
    await request(`${adminBase}/disable`, 'POST', ownerSecret, { disabled: false });

    await createWappDelegation({
      workspaceId,
      ownerActorId,
      delegateActorId: memberActorId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      filters: { installation_ids: ['kindling-installation'], capabilities: ['activity.publish'] },
    });
    const rotated = await request(`${adminBase}/rotate`, 'POST', memberSecret, { current_publisher_npub: publisherNpub, new_publisher_npub: nextPublisherNpub, nonce: 'rotation-1', expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect(rotated.response.status).toBe(200);
    const oldSelf = await request(`/api/v4/wapp-activity/workspaces/${workspaceId}/grants/me`, 'GET', publisherSecret);
    expect(oldSelf.json.code).toBe('stale_publisher_key');
    expect((await request(`/api/v4/wapp-activity/workspaces/${workspaceId}/grants/me`, 'GET', nextPublisherSecret)).response.status).toBe(200);

    const previousMinute = config.wappActivity.installationRequestsPerMinute;
    const previousBurst = config.wappActivity.installationBurstRequests;
    const previousDestination = config.wappActivity.destinationRequestsPerMinute;
    config.wappActivity.installationRequestsPerMinute = 2;
    config.wappActivity.installationBurstRequests = 100;
    config.wappActivity.destinationRequestsPerMinute = 100;
    await sql`DELETE FROM flightdeck_pg_wapp_publication_buckets`;
    expect((await request(publishPath, 'POST', nextPublisherSecret, publication('rate-1'))).response.status).toBe(201);
    expect((await request(publishPath, 'POST', nextPublisherSecret, publication('rate-2'))).response.status).toBe(201);
    const limited = await request(publishPath, 'POST', nextPublisherSecret, publication('rate-3'));
    expect(limited.response.status).toBe(429);
    expect(limited.json.code).toBe('rate_limited');
    config.wappActivity.installationRequestsPerMinute = previousMinute;
    config.wappActivity.installationBurstRequests = previousBurst;
    config.wappActivity.destinationRequestsPerMinute = previousDestination;
    await sql`DELETE FROM flightdeck_pg_wapp_publication_buckets`;

    await sql`UPDATE flightdeck_pg_channels SET archived_at=NOW() WHERE id=${channelId}`;
    const archived = await request(publishPath, 'POST', nextPublisherSecret, publication('archived'));
    expect(archived.json.code).toBe('channel_unavailable');
    await sql`UPDATE flightdeck_pg_channels SET archived_at=NULL WHERE id=${channelId}`;

    const revoked = await request(`${adminBase}/revoke`, 'POST', ownerSecret, { reason: 'done', disable_open_links: true });
    expect(revoked.json.grant.status).toBe('revoked');
    const denied = await request(publishPath, 'POST', nextPublisherSecret, publication('revoked'));
    expect(denied.json.code).toBe('publishing_grant_revoked');
    const audit = await sql<{ action: string; outcome: string }[]>`SELECT action, outcome FROM flightdeck_pg_wapp_publishing_audit WHERE workspace_id=${workspaceId}`;
    expect(audit.some((row) => row.action === 'publisher.rotate' && row.outcome === 'accepted')).toBe(true);
    expect(audit.some((row) => row.action === 'activity.publish' && row.outcome === 'rejected')).toBe(true);
  });

  test('cleans retained projection payloads and security audit on configured boundaries', async () => {
    await sql`UPDATE flightdeck_pg_wapp_activity_items SET updated_at=NOW()-INTERVAL '100 days' WHERE state='withdrawn'`;
    await sql`UPDATE flightdeck_pg_wapp_activity_versions SET created_at=NOW()-INTERVAL '100 days'`;
    await sql`UPDATE flightdeck_pg_wapp_publishing_audit SET created_at=NOW()-INTERVAL '366 days' WHERE action='publisher.rotate'`;
    const cleaned = await cleanupWappActivity();
    expect(Number(cleaned.items)).toBeGreaterThan(0);
    expect(Number(cleaned.versions)).toBeGreaterThan(0);
    expect(Number(cleaned.audit)).toBeGreaterThan(0);
    const [remaining] = await sql<{ count: number }[]>`SELECT COUNT(*)::integer AS count FROM flightdeck_pg_wapp_publishing_audit WHERE action='publisher.rotate'`;
    expect(Number(remaining.count)).toBe(0);
  });
});
