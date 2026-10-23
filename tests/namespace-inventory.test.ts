import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { config } from '../src/config';
import { createApp } from '../src/server';
import { collectNamespaceInventory } from '../src/services/namespace-inventory';

// One connection and temporary registry tables: never change real registrations,
// workspaces, memberships or databases. Only a uniquely named test schema is created.
const ownerKey = new Uint8Array(32).fill(101), otherKey = new Uint8Array(32).fill(102);
const owner = nip19.npubEncode(getPublicKey(ownerKey)), other = nip19.npubEncode(getPublicKey(otherKey));
const schema = 'inventory_test_' + randomUUID().replaceAll('-', '');
let db: ReturnType<typeof postgres>;
const app = createApp();
const path = (address: string = owner) => '/api/v4/workspaces/' + address + '/namespace-inventory';
function signed(address: string = owner, key = ownerKey) {
  const p = path(address);
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', 'http://localhost' + p], ['method', 'GET']], content: '' }, key);
  return app.request('http://localhost' + p, { headers: { Authorization: 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64') } });
}
beforeAll(async () => {
  db = postgres({ host: config.db.host, port: config.db.port, database: config.db.database, username: config.db.user, password: config.db.password, max: 1, onnotice: () => {} });
  setDb(db);
  await db`CREATE TEMP TABLE v4_workspaces (id uuid, workspace_owner_npub text, creator_npub text, admin_group_id uuid)`;
  await db`CREATE TEMP TABLE v4_groups (id uuid, owner_npub text, group_kind text, created_at timestamptz)`;
  await db`CREATE TEMP TABLE v4_group_members (group_id uuid, member_npub text)`;
  await db`INSERT INTO v4_workspaces VALUES (${randomUUID()},'legacy-address',${owner},NULL)`;
  await db`CREATE TEMP TABLE workspace_apps (workspace_owner_npub text, app_npub text, app_name text, enabled boolean, capabilities jsonb)`;
  await db`CREATE TEMP TABLE workspace_app_db_namespaces (workspace_owner_npub text, app_npub text, schema_name text, app_slug text)`;
  await db`CREATE TEMP TABLE workspace_app_rows (workspace_owner_npub text, app_npub text, collection text)`;
  await db`INSERT INTO workspace_app_rows VALUES (${owner},'same-app','notes'), (${owner},'same-app','notes'), (${owner},'second-app','private'), (${other},'same-app','secret')`;
  await db.unsafe(`CREATE SCHEMA "${schema}"`);
  await db.unsafe(`CREATE TABLE "${schema}".notes(id int); CREATE TABLE "${schema}".schema_migrations(id int)`);
  await db`INSERT INTO workspace_apps VALUES (${owner},'same-app','Example Notes',true,'[]'), (${owner},'second-app','Empty registration',false,'[]'), (${other},'same-app','Other owner secret name',true,'[]')`;
  await db`INSERT INTO workspace_app_db_namespaces VALUES (${owner},'same-app',${schema},'notes'), (${other},'same-app','other_owner_private_schema','private')`;
});
afterAll(async () => {
  if (db) { await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await db.end(); }
});
test('owner/app join isolates same app identity; metadata excludes credentials and migration tables', async () => {
  const response = await signed(); expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const data = await response.json();
  expect(data.apps).toHaveLength(2); expect(data.scope).toBe('owner_app_namespace');
  const notes = data.apps.find((a: any) => a.app_npub === 'same-app');
  expect(notes.shared_rows).toBe('2'); expect(notes.shared_collections).toBe(1);
  expect(data.apps.find((a: any) => a.app_npub === 'second-app').shared_rows).toBe('1');
  expect(notes.database_tables).toBe(1); expect(notes.schema_name).toBe(schema);
  expect(data.apps.find((a: any) => a.app_npub === 'second-app').schema_name).toBeNull();
  expect(JSON.stringify(data)).not.toContain('Other owner secret'); expect(JSON.stringify(data)).not.toContain('other_owner_private_schema');
  expect(Object.keys(notes).sort()).toEqual(['app_name','app_npub','app_slug','capabilities','database_tables','enabled','schema_name','shared_collections','shared_rows']);
});
test('foreign owner denied and unsigned caller rejected before inventory reads', async () => {
  expect((await signed(owner, otherKey)).status).toBe(403);
  expect((await app.request('http://localhost' + path())).status).toBe(401);
  const own = await signed(other, otherKey); expect(own.status).toBe(200);
  expect((await own.json()).apps).toHaveLength(1);
});
test('empty owner succeeds, failed collector is unavailable rather than empty', async () => {
  const empty = await collectNamespaceInventory('unregistered-owner', db); expect(empty.apps).toEqual([]); expect(empty.truncated).toBe(false);
  await db`ALTER TABLE workspace_app_db_namespaces RENAME COLUMN app_npub TO unavailable_app_fixture`;
  try { const response = await signed(); expect(response.status).toBe(503); expect((await response.json()).apps).toBeUndefined(); }
  finally { await db`ALTER TABLE workspace_app_db_namespaces RENAME COLUMN unavailable_app_fixture TO app_npub`; }
});

test('read-only legacy management check never repairs missing admin groups', async () => {
  expect((await signed('legacy-address')).status).toBe(200);
  const [workspace] = await db`SELECT admin_group_id FROM v4_workspaces WHERE workspace_owner_npub = 'legacy-address'`;
  expect(workspace!.admin_group_id).toBeNull();
  const [groups] = await db`SELECT count(*)::int AS count FROM v4_groups`; expect(groups!.count).toBe(0);
});

test('read-only lookup preserves existing admin group membership without repairing workspace', async () => {
  const group = randomUUID();
  await db`INSERT INTO v4_workspaces VALUES (${randomUUID()},'legacy-admin-address',${owner},NULL)`;
  await db`INSERT INTO v4_groups VALUES (${group},'legacy-admin-address','workspace_admin',NOW())`;
  await db`INSERT INTO v4_group_members VALUES (${group},${other})`;
  expect((await signed('legacy-admin-address', otherKey)).status).toBe(200);
  expect((await signed('legacy-address', otherKey)).status).toBe(403);
  const [workspace] = await db`SELECT admin_group_id FROM v4_workspaces WHERE workspace_owner_npub = 'legacy-admin-address'`;
  expect(workspace!.admin_group_id).toBeNull();
});
