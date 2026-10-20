import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';

// Explicit disposable PostgreSQL only; never use the live Tower database.
const port = Number(process.env.RECORD_TEST_PORT);
const bootstrap = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8');
const repair = bootstrap.split('-- archived_lifecycle_tombstones_v1')[1]!.split('-- end_archived_lifecycle_tombstones_v1')[0]!;

describe.skipIf(!port || port === 5432)('pre-journal archived lifecycle tombstone repair', () => {
  const dbName = `tower_archived_tombstones_${process.pid}_${Date.now()}`;
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  let db: ReturnType<typeof postgres>;
  let workspaceId: string, readerId: string, outsiderId: string, revokedId: string;
  let legacyScope: string, legacyChannel: string, legacySibling: string, liveScope: string, liveArchived: string, active: string, restored: string;

  async function actor(npub: string) {
    const [a] = await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${npub},'human',${npub}) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${a!.id},'member')`;
    return a!.id as string;
  }
  async function channel(scopeId: string, name: string) {
    const [c] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},${name}) RETURNING id`;
    return c!.id as string;
  }
  async function grant(actorId: string, channelId: string) {
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${workspaceId},'actor',${actorId},'channel',${channelId},'channel.read')`;
  }
  const journal = () => db`SELECT position::text,family,id,operation FROM flightdeck_pg_record_journal WHERE workspace_id=${workspaceId} ORDER BY flightdeck_pg_record_journal.position`;
  const deletes = (family: string, id: string) => db`SELECT position::text FROM flightdeck_pg_record_journal
    WHERE workspace_id=${workspaceId} AND family=${family} AND id=${id} AND operation='delete'`;
  async function synced(actorId: string) {
    let p = await readFlightDeckRecordPage({ workspaceId, actorId }, db);
    while (p.has_more) p = await readFlightDeckRecordPage({ workspaceId, actorId, cursor: p.next_cursor }, db);
    return p.next_cursor;
  }
  async function drain(actorId: string, cursor: string) {
    const changes = [];
    let p = await readFlightDeckRecordPage({ workspaceId, actorId, cursor }, db);
    changes.push(...p.changes);
    while (p.has_more) { p = await readFlightDeckRecordPage({ workspaceId, actorId, cursor: p.next_cursor }, db); changes.push(...p.changes); }
    return changes;
  }

  beforeAll(async () => {
    const admin = postgres({ ...conn, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${dbName}`); await admin.end();
    db = postgres({ ...conn, database: dbName });
    for (const statement of splitSqlStatements(bootstrap)) await db.unsafe(statement);
    const [owner] = await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES('npub1tombstoneowner','human','Owner') RETURNING id`;
    const [w] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('tower','workspace','owner','app','Tombstones',${owner!.id}) RETURNING id`; workspaceId = w!.id;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${owner!.id},'owner')`;
    readerId = await actor('npub1tombstonereader');
    outsiderId = await actor('npub1tombstoneoutsider');
    revokedId = await actor('npub1tombstonerevoked');

    // Pre-journal history: rows and archival exist without capture triggers;
    // the trigger install later backfilled them into current (archived included).
    await db.unsafe(`ALTER TABLE flightdeck_pg_scopes DISABLE TRIGGER fd_record_scope;
      ALTER TABLE flightdeck_pg_channels DISABLE TRIGGER fd_record_channel`);
    [{ id: legacyScope }] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Legacy','project') RETURNING id` as any;
    legacyChannel = await channel(legacyScope, 'Legacy features');
    legacySibling = await channel(legacyScope, 'Legacy implementation');
    await db`UPDATE flightdeck_pg_channels SET archived_at=now()-interval '90 days' WHERE scope_id=${legacyScope}`;
    await db`UPDATE flightdeck_pg_scopes SET archived_at=now()-interval '90 days' WHERE id=${legacyScope}`;
    await db.unsafe(`INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row)
      SELECT workspace_id,'scope',id::text,to_jsonb(s) FROM flightdeck_pg_scopes s WHERE archived_at IS NOT NULL
      UNION ALL SELECT workspace_id,'channel',id::text,to_jsonb(c) FROM flightdeck_pg_channels c WHERE archived_at IS NOT NULL;
      ALTER TABLE flightdeck_pg_scopes ENABLE TRIGGER fd_record_scope;
      ALTER TABLE flightdeck_pg_channels ENABLE TRIGGER fd_record_channel`);

    // Journal-era lifecycle: archived, active and restored resources.
    [{ id: liveScope }] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Live','project') RETURNING id` as any;
    liveArchived = await channel(liveScope, 'Archived after journal');
    active = await channel(liveScope, 'Active');
    restored = await channel(liveScope, 'Restored');
    for (const id of [legacyChannel, legacySibling, liveArchived, active, restored]) await grant(readerId, id);
    await grant(revokedId, legacyChannel);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE principal_actor_id=${revokedId}`;
    await db`UPDATE flightdeck_pg_channels SET archived_at=now() WHERE id IN (${liveArchived},${restored})`;
    await db`UPDATE flightdeck_pg_channels SET archived_at=NULL WHERE id=${restored}`;
  });
  afterAll(async () => {
    await db?.end(); const admin = postgres({ ...conn, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end();
  });

  test('bootstrap carries the repair as one statement and runtime extracts the same block', () => {
    expect(splitSqlStatements(bootstrap).filter(s => s.includes("PERFORM flightdeck_pg_record_emit(t.workspace_id,t.family,t.row,'delete')"))).toHaveLength(1);
    const runtime = readFileSync(new URL('../src/schema/ensure-runtime-schema.ts', import.meta.url), 'utf8');
    expect(runtime).toContain("split('-- archived_lifecycle_tombstones_v1')[1]!.split('-- end_archived_lifecycle_tombstones_v1')");
  });

  test('fresh bootstrap leaves pre-journal archived rows without tombstones (the observed gap)', async () => {
    // The fixture was archived after bootstrap ran, so this proves the gap exists before repair.
    expect(await deletes('scope', legacyScope)).toHaveLength(0);
    expect(await deletes('channel', legacyChannel)).toHaveLength(0);
    expect(await deletes('channel', legacySibling)).toHaveLength(0);
    expect(await deletes('channel', liveArchived)).toHaveLength(1);
  });

  test('emits each missing lifecycle tombstone exactly once and is a no-op on rerun', async () => {
    const readerCursor = await synced(readerId);
    const outsiderCursor = await synced(outsiderId);
    const revokedCursor = await synced(revokedId);
    const before = await journal();
    const [clockBefore] = await db`SELECT position::text,epoch,access_revision::text FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`;

    await db.unsafe(repair);
    const after = await journal();
    expect(after.slice(0, before.length)).toEqual(before);
    const added = after.slice(before.length);
    expect(added.map(e => [e.family, e.id, e.operation])).toEqual([
      ...[legacyChannel, legacySibling].sort().map(id => ['channel', id, 'delete']),
      ['scope', legacyScope, 'delete'],
    ]);
    // Already-covered, active and restored resources are untouched.
    for (const id of [liveArchived, active, restored]) expect(added.some(e => e.id === id)).toBe(false);
    const [clockAfter] = await db`SELECT position::text,epoch,access_revision::text FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`;
    expect(BigInt(clockAfter!.position)).toBe(BigInt(clockBefore!.position) + 3n);
    expect([clockAfter!.epoch, clockAfter!.access_revision]).toEqual([clockBefore!.epoch, clockBefore!.access_revision]);
    // The stale snapshot material and heads now reflect the archival.
    expect(await db`SELECT id FROM flightdeck_pg_record_current WHERE workspace_id=${workspaceId}
      AND id IN (${legacyScope},${legacyChannel},${legacySibling})`).toHaveLength(0);
    expect((await db`SELECT DISTINCT operation FROM flightdeck_pg_record_heads WHERE workspace_id=${workspaceId}
      AND id IN (${legacyScope},${legacyChannel},${legacySibling})`).map(h => h.operation)).toEqual(['delete']);

    await db.unsafe(repair);
    expect(await journal()).toEqual(after);

    // Delivery is grant-bound: only the current channel.read holder learns of them.
    const readerChanges = await drain(readerId, readerCursor);
    expect(readerChanges.map(c => [c.family, c.id, c.operation, c.row])).toEqual([
      ...[legacyChannel, legacySibling].sort().map(id => ['channel', id, 'delete', null]),
      ['scope', legacyScope, 'delete', null],
    ]);
    expect(await drain(outsiderId, outsiderCursor)).toEqual([]);
    expect(await drain(revokedId, revokedCursor)).toEqual([]);
    // Archived channels remain unreadable; fresh snapshots do not resurface them.
    let snapshot = await readFlightDeckRecordPage({ workspaceId, actorId: readerId }, db);
    const seen = [...snapshot.changes];
    while (snapshot.has_more) { snapshot = await readFlightDeckRecordPage({ workspaceId, actorId: readerId, cursor: snapshot.next_cursor }, db); seen.push(...snapshot.changes); }
    expect(seen.filter(c => [legacyScope, legacyChannel, legacySibling, liveArchived].includes(c.id) && c.operation === 'upsert')).toEqual([]);
  });

  test('later archival and restoration keep the normal trigger contract after repair', async () => {
    await db`UPDATE flightdeck_pg_channels SET archived_at=NULL WHERE id=${legacySibling}`;
    await db`UPDATE flightdeck_pg_scopes SET archived_at=NULL WHERE id=${legacyScope}`;
    const before = await journal();
    await db.unsafe(repair);
    expect(await journal()).toEqual(before);
    await db`UPDATE flightdeck_pg_channels SET archived_at=now() WHERE id=${legacySibling}`;
    await db`UPDATE flightdeck_pg_scopes SET archived_at=now() WHERE id=${legacyScope}`;
    const archived = await journal();
    await db.unsafe(repair);
    expect(await journal()).toEqual(archived);
    expect(await deletes('channel', legacySibling)).toHaveLength(2);
    expect(await deletes('scope', legacyScope)).toHaveLength(2);
  });

  test('runtime schema upgrade applies the repair idempotently', async () => {
    const { setDb, getDb } = await import('../src/db');
    const previous = getDb();
    const { ensureRuntimeSchema } = await import('../src/schema/ensure-runtime-schema');
    await db.unsafe(`ALTER TABLE flightdeck_pg_channels DISABLE TRIGGER fd_record_channel`);
    const pending = await channel(liveScope, 'Pending archive');
    await db`UPDATE flightdeck_pg_channels SET archived_at=now()-interval '30 days' WHERE id=${pending}`;
    await db.unsafe(`ALTER TABLE flightdeck_pg_channels ENABLE TRIGGER fd_record_channel`);
    const before = await journal();
    setDb(db);
    try { await ensureRuntimeSchema(); await ensureRuntimeSchema(); } finally { setDb(previous); }
    const after = await journal();
    // Startup also seeds the DMs scope (an upsert); only the repair emits deletes.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).filter(e => e.operation === 'delete').map(e => [e.family, e.id])).toEqual([['channel', pending]]);
  }, 60000);
});
