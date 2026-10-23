import { beforeAll, afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { randomUUID, createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { previewNamespaceArchive, applyNamespaceArchive } from '../src/services/namespace-console-archive';

// All DML and concurrency fixtures live in a unique schema, never existing data.
const schema = 'archive_test_' + randomUUID().replaceAll('-', '');
const customSchema = 'wapp_fixture_' + randomUUID().replaceAll('-', '').slice(0,12);
const key = new Uint8Array(32).fill(106), foreignKey = new Uint8Array(32).fill(107);
const owner = nip19.npubEncode(getPublicKey(key)), other = nip19.npubEncode(getPublicKey(foreignKey));
const appIdentity = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(108)));
let admin: ReturnType<typeof postgres>, db: ReturnType<typeof postgres>;
const app = createApp();
const options = () => ({ host: config.db.host, port: config.db.port, database: config.db.database, username: config.db.user, password: config.db.password, onnotice: () => {} });
const tables = ['workspace_apps','workspace_app_rows','workspace_app_db_namespaces','workspace_app_schema_manifests','flightdeck_pg_workspaces','flightdeck_pg_wapp_installations','flightdeck_pg_wapp_publishing_grants','flightdeck_pg_personal_wapps','namespace_console_archives','namespace_console_archive_receipts','v4_workspaces','v4_groups','v4_group_members'];
beforeAll(async () => {
  admin = postgres({ ...options(), max: 1 });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  await admin.unsafe(`CREATE SCHEMA "${customSchema}"`);
  await admin.unsafe(`CREATE TABLE "${customSchema}".content (id int, retained text); INSERT INTO "${customSchema}".content VALUES (1,'Retained custom row')`);
  db = postgres({ ...options(), max: 4, connection: { search_path: schema + ',public' } }); setDb(db);
  for (const t of tables) await db.unsafe(`CREATE TABLE "${schema}"."${t}" (LIKE public."${t}" INCLUDING ALL)`);
  await db`CREATE TABLE graph_fixture (owner_npub text, app_npub text, retained text)`;
  await db`INSERT INTO graph_fixture VALUES (${owner},${appIdentity},'unmeasured graph stays intact')`;
});
afterAll(async () => { if (db) await db.end(); if (admin) { await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.unsafe(`DROP SCHEMA IF EXISTS "${customSchema}" CASCADE`); await admin.end(); } });
async function seed(id: string = randomUUID(), address = owner) {
  await db`INSERT INTO workspace_apps (workspace_owner_npub,app_npub,app_name,created_by_npub,capabilities) VALUES (${address},${id},'Disposable registration',${address},'[]')`;
  return id;
}
const preview = (id: string, action: 'archive'|'restore' = 'archive', address = owner) => previewNamespaceArchive(address,id,address,action,db);
const apply = (p: any, overrides = {}, address = owner, id = p.app_npub, actor = address) => applyNamespaceArchive(address,id,actor,{ action:p.action, preview_token:p.preview_token, confirmation:p.confirmation, ...overrides },db);
async function request(id: string, operation: string, body: any, signingKey = key, address = owner) {
  const url = 'http://localhost/api/v4/workspaces/' + address + '/namespace-inventory/' + id + '/' + operation;
  const raw = JSON.stringify(body);
  const event = finalizeEvent({ kind:27235, created_at:Math.floor(Date.now()/1000), tags:[['u',url],['method','POST'],['payload',createHash('sha256').update(raw).digest('hex')]],content:'' },signingKey);
  return app.request(url,{ method:'POST',body:raw,headers:{'content-type':'application/json',authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')} });
}
test('preview is read-only; owner/app isolation, exact confirmation and signed token binding', async () => {
  const id = await seed(); await seed(id,other);
  const [before] = await db`SELECT count(*)::int count FROM namespace_console_archive_receipts`;
  const p = await preview(id); expect(p.allowed).toBe(true); expect(p.entry.shared_rows).toBe('0');
  const [after] = await db`SELECT count(*)::int count FROM namespace_console_archive_receipts`; expect(after).toEqual(before);
  await expect(apply(p,{confirmation:'archive'})).rejects.toThrow('Exact confirmation');
  await expect(apply(p,{preview_token:p.preview_token!.slice(0,-5)+'wrong'})).rejects.toThrow('Invalid preview');
  await expect(apply(p,{confirmation:p.confirmation},other)).rejects.toThrow('mismatch');
  await expect(apply(p,{},owner,id,other)).rejects.toThrow('mismatch');
  expect((await request(id,'preview',{action:'archive'},foreignKey)).status).toBe(403);
  expect((await request(id,'visibility',{action:'delete'})).status).toBe(400);
  const response = await request(id,'preview',{action:'archive'}); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
  const result = await apply(p); expect(result.archived).toBe(true);
  const [foreign] = await db`SELECT count(*)::int count FROM namespace_console_archives WHERE workspace_owner_npub=${other}`; expect(foreign!.count).toBe(0);
});
test('populated and unknown stores are retained; restore and deterministic retry do not repeat transitions', async () => {
  const id = await seed(appIdentity);
  await db`INSERT INTO workspace_app_rows (workspace_owner_npub,app_npub,collection,row_id,visibility,owner_npub,data,created_by_npub,updated_by_npub) VALUES (${owner},${id},'notes','one','private',${owner},'{}',${owner},${owner})`;
  await db`INSERT INTO workspace_app_db_namespaces (workspace_owner_npub,app_npub,schema_name,app_slug,provisioned_by_npub) VALUES (${owner},${id},${customSchema},'fixture',${owner})`;
  await db`INSERT INTO workspace_app_schema_manifests (workspace_owner_npub,app_npub,schema_hash,owner_ciphertext,created_by_npub) VALUES (${owner},${id},'fixture-hash','fixture-ciphertext',${owner})`;
  const p = await preview(id); expect(p.entry.shared_rows).toBe('1'); expect(p.entry.database_tables).toBe(1); expect(p.entry.schema_manifests).toBe(1); expect(p.impact).toContain('not fully measured'); expect(p.impact).toContain('Permanent deletion is unavailable');
  const result = await apply(p); const retry = await apply(p); expect(retry.replayed).toBe(true); expect(retry.archive_revision).toBe(result.archive_revision);
  const restored = await apply(await preview(id,'restore')); expect(restored.archived).toBe(false);
  expect((await apply(p)).archived).toBe(true); // original receipt, not a second archive
  const [state] = await db`SELECT archived,revision::text FROM namespace_console_archives WHERE workspace_owner_npub=${owner} AND app_npub=${id}`; expect(state!.archived).toBe(false); expect(state!.revision).toBe('2');
  const [row] = await db`SELECT count(*)::int count FROM workspace_app_rows WHERE app_npub=${id}`; expect(row!.count).toBe(1);
  expect((await db`SELECT * FROM graph_fixture`)).toHaveLength(1);
  expect((await db.unsafe(`SELECT * FROM "${customSchema}".content`))).toHaveLength(1);
  expect((await db`SELECT * FROM workspace_app_schema_manifests WHERE app_npub=${id}`)).toHaveLength(1);
  expect((await db`SELECT * FROM workspace_app_db_namespaces WHERE app_npub=${id}`)).toHaveLength(1);
  const [registration] = await db`SELECT enabled FROM workspace_apps WHERE app_npub=${id}`; expect(registration!.enabled).toBe(true);
});
test('stale registration, sidecar and shared-count previews fail closed', async () => {
  const id = await seed(); const p = await preview(id);
  await db`UPDATE workspace_apps SET app_name='Changed name' WHERE app_npub=${id}`;
  await expect(apply(p)).rejects.toThrow('Preview changed');
  const p2 = await preview(id); await apply(await preview(id)); await expect(apply(p2)).rejects.toThrow('Preview changed');
  const p3 = await preview(id,'restore');
  await db`INSERT INTO workspace_app_rows (workspace_owner_npub,app_npub,collection,row_id,visibility,owner_npub,data,created_by_npub,updated_by_npub) VALUES (${owner},${id},'notes','new','private',${owner},'{}',${owner},${owner})`;
  await expect(apply(p3)).rejects.toThrow('Preview changed');
});
test('active current publisher protected; same app at another owner and historical roles do not leak', async () => {
  const id = await seed();
  await db`INSERT INTO flightdeck_pg_wapp_installations (wapp_installation_id,app_id,publisher_npub,owner_npub,display_name) VALUES (${randomUUID()},'fixture',${id},${owner},'Current fixture')`;
  const p = await preview(id); expect(p.allowed).toBe(false); expect(p.preview_token).toBeNull(); expect(p.entry.active_installations).toBe(1);
  const previous = await seed(); await db`UPDATE flightdeck_pg_wapp_installations SET previous_publisher_npubs=ARRAY[${previous}] WHERE publisher_npub=${id}`;
  const historic = await preview(previous); expect(historic.entry.previous_publishers).toBe(1); expect(historic.allowed).toBe(true); await apply(historic);
  await seed(id,other); expect((await preview(id,'archive',other)).entry.current_publishers).toBe(0);
});
test('concurrent registration update before target lock invalidates preview; concurrent archive retry serializes', async () => {
  const id = await seed(); const p = await preview(id);
  let locked!: () => void, release!: () => void;
  const ready = new Promise<void>(r => locked=r), gate = new Promise<void>(r => release=r);
  const writer = db.begin(async transaction => { const tx = transaction as unknown as typeof db; await tx`UPDATE workspace_apps SET app_name='Concurrent registration' WHERE app_npub=${id}`; locked(); await gate; });
  await ready; const mutation = apply(p); release(); await writer;
  await expect(mutation).rejects.toThrow('Preview changed');
  const current = await preview(id); const results = await Promise.all([apply(current),apply(current)]); expect(results.filter(r=>r.replayed)).toHaveLength(1);
});
test('collector failure blocks preview and mutation without partial archive', async () => {
  const id = await seed(); const p = await preview(id);
  await db`ALTER TABLE flightdeck_pg_wapp_installations RENAME COLUMN publisher_npub TO broken_fixture`;
  try { expect((await request(id,'preview',{action:'archive'})).status).toBe(503); expect((await request(id,'visibility',{action:'archive',preview_token:p.preview_token,confirmation:p.confirmation})).status).toBe(503); }
  finally { await db`ALTER TABLE flightdeck_pg_wapp_installations RENAME COLUMN broken_fixture TO publisher_npub`; }
  const [state] = await db`SELECT count(*)::int count FROM namespace_console_archives WHERE app_npub=${id}`; expect(state!.count).toBe(0);
});

test('waiting on selected registration never blocks an unrelated owner writer', async () => {
  const id = await seed(); const p = await preview(id);
  let locked!:()=>void, release!:()=>void;
  const ready = new Promise<void>(r=>locked=r), gate = new Promise<void>(r=>release=r);
  const holder = db.begin(async transaction=>{const tx = transaction as unknown as typeof db; await tx`SELECT id FROM workspace_apps WHERE workspace_owner_npub=${owner} AND app_npub=${id} FOR UPDATE`;locked();await gate;});
  await ready; const pending = apply(p);
  try {
    const write = seed(randomUUID(),other);
    const outcome = await Promise.race([write.then(()=>true), new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),1000))]);
    expect(outcome).toBe(true);
  } finally { release(); await holder; }
  expect((await pending).archived).toBe(true);
});
test('new active publisher after preview invalidates archive; grant and launcher independently protect', async () => {
  const id = await seed(); const p = await preview(id); const installation = randomUUID();
  await db`INSERT INTO flightdeck_pg_wapp_installations (id,wapp_installation_id,app_id,publisher_npub,owner_npub,display_name,lifecycle_status) VALUES (${installation},${randomUUID()},'fixture',${id},${owner},'Concurrent active','active')`;
  await expect(apply(p)).rejects.toThrow('Preview changed');
  await db`UPDATE flightdeck_pg_wapp_installations SET lifecycle_status='inactive' WHERE id=${installation}`;
  const ws = randomUUID(), actor = randomUUID();
  await db`INSERT INTO flightdeck_pg_wapp_publishing_grants (workspace_id,installation_id,status,capabilities,registered_open_origins,approved_by_actor_id,approved_by_npub) VALUES (${ws},${installation},'active',ARRAY['activity.publish'],ARRAY['https://fixture.invalid'],${actor},${owner})`;
  expect((await preview(id)).allowed).toBe(false);
  await db`UPDATE flightdeck_pg_wapp_publishing_grants SET status='disabled' WHERE installation_id=${installation}`;
  await db`INSERT INTO flightdeck_pg_personal_wapps (workspace_id,owner_actor_id,title,launch_url,app_id,wapp_id,source_wingman_url,status,created_by_actor_id,updated_by_actor_id,wapp_installation_id) VALUES (${ws},${actor},'Fixture launcher','https://fixture.invalid','fixture','fixture','https://fixture.invalid','active',${actor},${actor},${installation})`;
  expect((await preview(id)).allowed).toBe(false);
});
test('expired preview and deleted/recreated registration are rejected', async () => {
  const id = await seed(); const p = await preview(id); const now = Date.now;
  Date.now=()=>now()+301_000;
  try { await expect(apply(p)).rejects.toThrow('expired'); } finally {Date.now=now;}
  const p2=await preview(id);await db`DELETE FROM workspace_apps WHERE app_npub=${id}`;await seed(id);
  await expect(apply(p2)).rejects.toThrow('Preview changed');
});
