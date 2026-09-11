import { test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent, nip19 } from 'nostr-tools';
import { Hono } from 'hono';
import { driveRouter } from '../src/routes/drive';
import { setDb } from '../src/db';
import { normalizeDriveShare } from '../src/services/drive';
const enabled = !!process.env.DRIVE_TEST_DATABASE_URL;
const owner = generateSecretKey(),
  member = generateSecretKey(),
  adminKey = generateSecretKey(),
  host = generateSecretKey(),
  stranger = generateSecretKey();
const npub = (key: Uint8Array) => nip19.npubEncode(getPublicKey(key));
let sql: ReturnType<typeof postgres>,
  workspace: string,
  id = crypto.randomUUID();
const app = new Hono().route('/api/v4/flightdeck-pg', driveRouter);
const base = () =>
  `https://tower.example/api/v4/flightdeck-pg/workspaces/${workspace}/drive/shares`;
async function request(key: Uint8Array, url: string, method = 'GET', body?: unknown) {
  const raw = body ? JSON.stringify(body) : undefined;
  const tags = [
    ['u', url],
    ['method', method],
  ];
  if (raw) tags.push(['payload', createHash('sha256').update(raw).digest('hex')]);
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags },
    key,
  );
  return app.request(url, {
    method,
    body: raw,
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
      'content-type': 'application/json',
    },
  });
}
function body(revision = 0, audience = 'private') {
  const value = normalizeDriveShare({
    name: 'Folder',
    host_name: 'Desktop',
    host_npub: npub(host),
    endpoint: `http://${npub(host)}.fips:7345`,
    audience,
    enabled: true,
    previous_revision: revision,
  });
  return {
    ...value,
    host_proof: finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [
          ['protocol', 'fips-drive-register-v1'],
          ['u', `${base()}/${id}`],
          ['owner', npub(owner)],
          ['payload', createHash('sha256').update(JSON.stringify(value)).digest('hex')],
        ],
      },
      host,
    ),
  };
}
beforeAll(async () => {
  if (!enabled) return;
  const connection = process.env.DRIVE_TEST_DATABASE_URL!;
  if (!connection.endsWith('/drive_test')) throw new Error('Dedicated drive_test server required');
  const admin = postgres(connection, { onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE drive_route_test_${process.pid}`);
  await admin.end();
  sql = postgres(connection.replace('/drive_test', `/drive_route_test_${process.pid}`), {
    max: 2,
    onnotice: () => {},
  });
  setDb(sql);
  await sql.unsafe(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'));
  const actorIds = [];
  for (const key of [owner, member, adminKey]) {
    const [a] =
      await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES (${npub(key)},'human') RETURNING id`;
    actorIds.push(a.id);
  }
  const [w] =
    await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES (${npub(host)},${npub(host)},${npub(owner)},${npub(host)},'Drive fixture') RETURNING id`;
  workspace = w.id;
  for (let n = 0; n < actorIds.length; n++)
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES (${workspace},${actorIds[n]},${['owner', 'member', 'admin'][n]})`;
});
afterAll(async () => {
  await sql?.end();
});
test.skipIf(!enabled)(
  'real typed routes authenticate owner/host independently and never grant admin private access',
  async () => {
    const registration = await request(owner, `${base()}/${id}`, 'PUT', body());
    expect(registration.status).toBe(200);
    for (const key of [member, adminKey]) {
      const r = await request(key, base());
      expect(r.status).toBe(200);
      expect((await r.json()).shares).toHaveLength(0);
    }
    expect((await request(stranger, base())).status).toBe(403);
    expect((await (await request(owner, base())).json()).shares).toHaveLength(1);
    const keyA = generateSecretKey(),
      keyB = generateSecretKey(),
      workspaceAHost = generateSecretKey();
    await sql`INSERT INTO user_profiles(user_npub) VALUES (${npub(owner)})`;
    await sql`INSERT INTO user_workspace_keys(user_npub, workspace_owner_npub, ws_key_npub)
      VALUES (${npub(owner)}, ${npub(workspaceAHost)}, ${npub(keyA)}),
             (${npub(owner)}, ${npub(host)}, ${npub(keyB)})`;
    expect((await request(keyA, base())).status).toBe(403);
    expect((await (await request(keyB, base())).json()).shares).toHaveLength(1);
    await sql`UPDATE user_workspace_keys SET active=false WHERE ws_key_npub=${npub(keyB)}`;
    // The global identity-resolution cache is warm; fresh target-scoped authorization still revokes.
    expect((await request(keyB, base())).status).toBe(403);

    expect((await request(member, `${base()}/${id}/policy`)).status).toBe(403);
    const policy = await request(host, `${base()}/${id}/policy`);
    expect(policy.status).toBe(200);
    expect((await policy.json()).allowed_npubs).toEqual([npub(owner)]);
    expect((await request(adminKey, `${base()}/${id}`, 'PUT', body(1))).status).toBe(403);
    expect((await request(owner, `${base()}/${id}`, 'PUT', body(1, 'workspace'))).status).toBe(200);
    expect((await (await request(member, base())).json()).shares).toHaveLength(1);
    expect(
      (await request(owner, `${base()}/${id}`, 'PUT', { ...body(2), root: '/private' })).status,
    ).toBe(400);
    const bytes = await sql`SELECT count(*)::int as count FROM v4_storage_objects`;
    expect(bytes[0].count).toBe(0);
  },
);
