import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

// Explicit isolated Postgres only. Never reset/recreate an existing database.
const port = Number(process.env.MIGRATION_TEST_PORT);
describe.skipIf(!port || port === 5432)('actual db:init migration runner', () => {
  test('bootstraps function-dependent tables and preserves data on repeated init', async () => {
    const database = `tower_migration_${randomUUID().replaceAll('-', '')}`;
    const env = {
      ...process.env,
      DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_NAME: database,
      DB_USER: 'postgres', DB_PASSWORD: 'postgres',
      SUPERBASED_DIRECT_HTTPS_URL: 'http://127.0.0.1:3100',
      ADMIN_NPUB: 'npub1migrationtest', FLIGHT_DECK_PG_APP_NPUB: 'npub1migrationtest',
      STORAGE_S3_ENDPOINT_PUBLIC: 'http://127.0.0.1:9000',
      STORAGE_S3_ACCESS_KEY: 'test', STORAGE_S3_SECRET_KEY: 'test',
      GRAPH_DB_ADMIN_USER: 'postgres', GRAPH_DB_ADMIN_PASSWORD: 'postgres',
      GRAPH_DB_APP_USER: 'postgres', GRAPH_DB_APP_PASSWORD: 'postgres',
    };
    const init = () => {
      const result = Bun.spawnSync([process.execPath, 'run', 'db:init'], {
        cwd: new URL('..', import.meta.url).pathname, env,
        stdout: 'pipe', stderr: 'pipe',
      });
      if (result.exitCode !== 0) {
        throw new Error(`db:init exited ${result.exitCode}: ${result.stderr.toString()}\n${result.stdout.toString()}`);
      }
      expect(result.stdout.toString()).toContain('Migrations complete.');
    };
    init(); // The real runner creates the fresh database, not a raw SQL replay.
    const sql = postgres({ host: '127.0.0.1', port, database, username: 'postgres', password: 'postgres', onnotice: () => {} });
    try {
      await sql`INSERT INTO tower_metadata (tower_name) VALUES ('migration sentinel')`;
      const [actor] = await sql`INSERT INTO flightdeck_pg_actors (npub, kind, display_name) VALUES ('npub1migrationtest', 'human', 'Migration') RETURNING id`;
      const [workspace] = await sql`INSERT INTO flightdeck_pg_workspaces (tower_service_npub, workspace_service_npub, workspace_owner_npub, app_npub, name, created_by_actor_id)
        VALUES ('tower', 'workspace', 'owner', 'app', 'Migration', ${actor!.id}) RETURNING id`;
      await sql`SELECT flightdeck_pg_record_emit(${workspace!.id}::uuid, 'task', '{"id":"sentinel","channel_id":"channel"}'::jsonb, 'upsert')`;
      const before = await sql`SELECT * FROM flightdeck_pg_record_current WHERE workspace_id = ${workspace!.id} AND family = 'task'`;
      expect(before).toHaveLength(1);
      expect(before[0]!.context.channel_id).toBe('channel');
      const journal = await sql`SELECT * FROM flightdeck_pg_record_journal WHERE workspace_id = ${workspace!.id} AND family = 'task'`;
      init();
      init();
      expect(await sql`SELECT * FROM flightdeck_pg_record_current WHERE workspace_id = ${workspace!.id} AND family = 'task'`).toEqual(before);
      expect(await sql`SELECT * FROM flightdeck_pg_record_journal WHERE workspace_id = ${workspace!.id} AND family = 'task'`).toEqual(journal);
      expect((await sql`SELECT tower_name FROM tower_metadata`)[0]!.tower_name).toBe('migration sentinel');
    } finally {
      await sql.end();
    }
  }, 120_000);
});
