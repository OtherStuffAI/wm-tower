import { test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { generateSecretKey, getPublicKey, finalizeEvent, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { driveV1Sql } from '../src/schema/drive-v1';
import {
  normalizeDriveShare,
  saveDriveShare,
  discoverDriveShares,
  driveHostPolicy,
  verifyDriveHostProof,
} from '../src/services/drive';

const owner = generateSecretKey(),
  host = generateSecretKey(),
  member = generateSecretKey();
const npub = (key: Uint8Array) => nip19.npubEncode(getPublicKey(key));
const endpoint = `http://${npub(host)}.fips:7345`;
const workspace = crypto.randomUUID(),
  otherWorkspace = crypto.randomUUID(),
  ownerId = crypto.randomUUID(),
  memberId = crypto.randomUUID(),
  id = crypto.randomUUID();
const url = `https://tower.example/api/v4/flightdeck-pg/workspaces/${workspace}/drive/shares/${id}`;
const sql = process.env.DRIVE_TEST_DATABASE_URL
  ? postgres(process.env.DRIVE_TEST_DATABASE_URL.replace('/drive_test', `/drive_service_test_${process.pid}`), { max: 2, onnotice: () => {} })
  : null;
const body = (revision = 0, audience = 'private', enabled = true) => {
  const data = normalizeDriveShare({
    name: 'Selected folder',
    host_name: 'Desktop',
    host_npub: npub(host),
    endpoint,
    audience,
    enabled,
    previous_revision: revision,
  });
  const proof = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [
        ['protocol', 'fips-drive-register-v1'],
        ['u', url],
        ['owner', npub(owner)],
        ['payload', createHash('sha256').update(JSON.stringify(data)).digest('hex')],
      ],
    },
    host,
  );
  return { ...data, host_proof: proof };
};
test('strict metadata schema rejects paths, indexes, bytes, invalid origins and host proof mixing', () => {
  for (const extra of [
    { root: '/secret' },
    { entries: [] },
    { bytes: 'a' },
    { endpoint: 'https://public.example' },
    { audience: 'public' },
  ])
    expect(() => normalizeDriveShare({ ...body(), ...extra })).toThrow();
  const b = body();
  expect(() =>
    verifyDriveHostProof(b.host_proof, url, npub(owner), normalizeDriveShare(b)),
  ).not.toThrow();
  expect(() =>
    verifyDriveHostProof(b.host_proof, url + 'x', npub(owner), normalizeDriveShare(b)),
  ).toThrow();
  expect(() =>
    verifyDriveHostProof(b.host_proof, url, npub(member), normalizeDriveShare(b)),
  ).toThrow();
  expect(() =>
    verifyDriveHostProof(
      b.host_proof,
      url,
      npub(owner),
      normalizeDriveShare(b),
      Date.now() + 61000,
    ),
  ).toThrow();
});
beforeAll(async () => {
  if (!sql) return;
  if (!process.env.DRIVE_TEST_DATABASE_URL!.endsWith('/drive_test'))
    throw new Error('Use dedicated drive_test DB');
  const admin = postgres(process.env.DRIVE_TEST_DATABASE_URL!, { onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE drive_service_test_${process.pid}`);
  await admin.end();
  setDb(sql);
  await sql.unsafe(
    `CREATE TABLE flightdeck_pg_workspaces(id UUID PRIMARY KEY); CREATE TABLE flightdeck_pg_actors(id UUID PRIMARY KEY,npub TEXT); CREATE TABLE flightdeck_pg_workspace_memberships(workspace_id UUID,actor_id UUID);`,
  );
  await sql.unsafe(driveV1Sql);
  await sql`INSERT INTO flightdeck_pg_workspaces VALUES (${workspace}),(${otherWorkspace})`;
  await sql`INSERT INTO flightdeck_pg_actors VALUES (${ownerId},${npub(owner)}),(${memberId},${npub(member)})`;
  await sql`INSERT INTO flightdeck_pg_workspace_memberships VALUES (${workspace},${ownerId}),(${workspace},${memberId})`;
});
afterAll(async () => {
  await sql?.end();
});
test.skipIf(!sql)(
  'private owner across devices; member/admin denied; workspace sharing; host isolation; CAS; expiry contract and reconnect removal',
  async () => {
    await saveDriveShare(workspace, id, ownerId, npub(owner), url, body());
    expect((await discoverDriveShares(workspace, ownerId)).length).toBe(1);
    expect(await discoverDriveShares(workspace, memberId)).toHaveLength(0);
    expect(await discoverDriveShares(otherWorkspace, ownerId)).toHaveLength(0);
    const privatePolicy = await driveHostPolicy(workspace, id, npub(host));
    expect(privatePolicy.allowed_npubs).toEqual([npub(owner)]);
    expect(privatePolicy.max_age_seconds).toBe(900);
    await expect(driveHostPolicy(workspace, id, npub(member))).rejects.toThrow('host_required');
    await expect(
      saveDriveShare(workspace, id, memberId, npub(member), url, body(1)),
    ).rejects.toThrow();
    await expect(saveDriveShare(workspace, id, ownerId, npub(owner), url, body())).rejects.toThrow(
      'revision_conflict',
    );
    await saveDriveShare(workspace, id, ownerId, npub(owner), url, body(1, 'workspace'));
    expect(await discoverDriveShares(workspace, memberId)).toHaveLength(1);
    const shared = await driveHostPolicy(workspace, id, npub(host));
    expect(shared.allowed_npubs).toHaveLength(2);
    await sql!`DELETE FROM flightdeck_pg_workspace_memberships WHERE actor_id=${memberId}`;
    const refreshed = await driveHostPolicy(workspace, id, npub(host));
    expect(refreshed.allowed_npubs).toEqual([npub(owner)]);
    expect(refreshed.policy_revision).not.toBe(shared.policy_revision);
    await saveDriveShare(workspace, id, ownerId, npub(owner), url, body(2, 'workspace', false));
    expect(await discoverDriveShares(workspace, ownerId)).toHaveLength(0);
    expect((await driveHostPolicy(workspace, id, npub(host))).allowed_npubs).toHaveLength(0);
    const columns =
      await sql!`SELECT column_name FROM information_schema.columns WHERE table_name='flightdeck_pg_drive_shares'`;
    expect(
      columns.some((c) => ['root', 'path', 'content', 'entries', 'bytes'].includes(c.column_name)),
    ).toBe(false);
  },
);
