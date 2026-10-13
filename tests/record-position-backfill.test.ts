import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

// Explicit disposable PostgreSQL only; never use the live Tower database.
const port = Number(process.env.RECORD_TEST_PORT);
const migration = readFileSync(new URL('../src/schema/additive-record-access-v1.sql', import.meta.url), 'utf8');
const backfill = migration.slice(migration.indexOf(' UPDATE flightdeck_pg_record_current c SET position='), migration.indexOf(' UPDATE flightdeck_pg_record_cursors'));
const bootstrap = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8');

describe.skipIf(!port || port === 5432)('startup position backfill on disposable PostgreSQL', () => {
  const database = `tower_position_${process.pid}_${Date.now()}`;
  const options = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  let db: ReturnType<typeof postgres>;
  beforeAll(async () => {
    const admin = postgres({ ...options, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...options, database });
    await db.unsafe(`CREATE TABLE flightdeck_pg_record_current (
      workspace_id uuid, family text, id text, position bigint NOT NULL DEFAULT 0, row jsonb DEFAULT '{}',
      PRIMARY KEY(workspace_id,family,id));
      CREATE TABLE flightdeck_pg_record_journal (
      workspace_id uuid, family text, id text, position bigint, operation text, row jsonb DEFAULT '{}',
      PRIMARY KEY(workspace_id,position));`);
  });
  afterAll(async () => {
    await db?.end(); const admin = postgres({ ...options, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
  });
  test('bootstrap and runtime use the same position repair', () => {
    expect(bootstrap).toContain(backfill.trim());
  });
  test('repairs max by workspace/family/id, preserves absent/zero history and nonzero positions', async () => {
    const w = '00000000-0000-0000-0000-000000000001';
    const other = '00000000-0000-0000-0000-000000000002';
    await db`INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,position) VALUES
      (${w},'message','same',0),(${w},'task','same',0),(${other},'message','same',0),
      (${w},'message','missing',0),(${w},'message','zero',0),(${w},'message','preserved',17)`;
    await db`INSERT INTO flightdeck_pg_record_journal(workspace_id,family,id,position,operation) VALUES
      (${w},'message','same',2,'upsert'),(${w},'message','same',9,'delete'),
      (${w},'task','same',22,'upsert'),(${other},'message','same',33,'upsert'),
      (${w},'message','zero',0,'upsert'),(${w},'message','preserved',99,'upsert')`;
    const journal = await db`SELECT * FROM flightdeck_pg_record_journal ORDER BY workspace_id,position`;
    await db.unsafe(backfill);
    const rows = await db`SELECT workspace_id,family,id,position::text,row,xmin::text AS version FROM flightdeck_pg_record_current ORDER BY workspace_id,family,id`;
    expect(rows.map(r => r.position)).toEqual(['0','17','9','0','22','33']);
    await db.unsafe(backfill);
    expect(await db`SELECT workspace_id,family,id,position::text,row,xmin::text AS version FROM flightdeck_pg_record_current ORDER BY workspace_id,family,id`).toEqual(rows);
    // A previously missing journal entry must still be repaired on a later run.
    await db`INSERT INTO flightdeck_pg_record_journal(workspace_id,family,id,position,operation) VALUES (${w},'message','missing',100,'upsert')`;
    await db.unsafe(backfill);
    expect((await db`SELECT position::text FROM flightdeck_pg_record_current WHERE id='missing'`)[0]!.position).toBe('100');
    expect(await db`SELECT * FROM flightdeck_pg_record_journal WHERE position<>100 ORDER BY workspace_id,position`).toEqual(journal);
  });
  test('26k zero-position rows and 62k journal entries repair and repeat within a bounded time', async () => {
    await db.unsafe(`TRUNCATE flightdeck_pg_record_current,flightdeck_pg_record_journal;
      INSERT INTO flightdeck_pg_record_current(workspace_id,family,id)
        SELECT '00000000-0000-0000-0000-000000000001','message',n::text FROM generate_series(1,26000) n;
      INSERT INTO flightdeck_pg_record_journal(workspace_id,family,id,position,operation)
        SELECT '00000000-0000-0000-0000-000000000001','message',((n-1)%20000+1)::text,n,'upsert' FROM generate_series(1,62000) n;
      ANALYZE flightdeck_pg_record_current; ANALYZE flightdeck_pg_record_journal;
      SET statement_timeout='5s';`);
    const start = performance.now(); await db.unsafe(backfill); const first = performance.now()-start;
    const [result] = await db`SELECT count(*) FILTER (WHERE position=0)::int AS missing,
      count(*) FILTER (WHERE position>0)::int AS repaired FROM flightdeck_pg_record_current`;
    expect(result).toEqual({ missing: 6000, repaired: 20000 });
    expect((await db`SELECT count(*)::int AS n FROM flightdeck_pg_record_current c JOIN
      (SELECT id,max(position) AS position FROM flightdeck_pg_record_journal GROUP BY id) j USING(id)
      WHERE c.position<>j.position`)[0]!.n).toBe(0);
    const repeat = performance.now(); for(let i=0;i<5;i++) await db.unsafe(backfill);
    console.log(`position backfill: 26000 current/62000 journal; first=${first.toFixed(2)}ms; five repeats=${(performance.now()-repeat).toFixed(2)}ms`);
  });
});
