import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Opt in only with the port of a dedicated disposable Postgres container.
const port = Number(process.env.MIGRATION_TEST_PORT);
const repo = new URL('..', import.meta.url).pathname;
describe.skipIf(!port || port === 5432)('existing checkpoint database attention upgrade', () => {
  test('actual runner upgrades ed78118, preserves checkpoints/read positions, and repeats without journal changes', async () => {
    const database = `tower_attention_upgrade_${randomUUID().replaceAll('-', '')}`;
    const temporary = mkdtempSync(join(tmpdir(), 'tower-attention-upgrade-'));
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
    function command(args: string[], cwd: string) {
      return Bun.spawnSync(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    }
    function archive(commit: string) {
      const destination = join(temporary, commit);
      const tar = join(temporary, `${commit}.tar`);
      for (const [args, cwd] of [
        [['git', 'archive', commit, '--output', tar, 'src', 'package.json', 'bun.lock'], repo],
        [['mkdir', destination], repo],
        [['tar', '-xf', tar, '-C', destination], repo],
      ] as [string[], string][]) {
        const result = command(args, cwd);
        if (result.exitCode) throw new Error(result.stderr.toString());
      }
      symlinkSync(join(repo, 'node_modules'), join(destination, 'node_modules'));
      return destination;
    }
    function init(cwd: string, failure = false) {
      const result = command([process.execPath, 'run', 'src/schema/run-migrations.ts'], cwd);
      if (failure) {
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain('column t.attention does not exist');
        console.log('Reproduced f621716 failure: column t.attention does not exist');
      } else {
        if (result.exitCode) throw new Error(result.stderr.toString());
        expect(result.stdout.toString()).toContain('Migrations complete.');
      }
    }
    const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
    const sql = postgres({ ...conn, database });
    try {
      init(archive('ed78118')); // Old actual entrypoint creates DB; no new bootstrap applied.
      expect(await sql`SELECT 1 FROM information_schema.columns WHERE table_name='flightdeck_pg_tasks' AND column_name='attention'`).toHaveLength(0);
      const [author] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('upgrade-author','human') RETURNING id`;
      const [viewer] = await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('upgrade-viewer','human') RETURNING id`;
      const [workspace] = await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
        VALUES('upgrade-tower','upgrade-workspace','upgrade-owner','upgrade-app','Upgrade') RETURNING id`;
      const w = workspace!.id, a = author!.id, v = viewer!.id;
      for (const id of [a,v]) await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w},${id},'member')`;
      const [scope] = await sql`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Upgrade','project') RETURNING id`;
      const [channel] = await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${scope!.id},'Upgrade') RETURNING id`;
      const [task] = await sql`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id,activity_version,metadata)
        VALUES(${w},${scope!.id},${channel!.id},'Assigned existing task',${a},${a},7,${sql.json({assigned_to_npub:'upgrade-viewer'})}) RETURNING id`;
      const [storage] = await sql`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,file_name,content_type,storage_path)
        VALUES('upgrade-owner','upgrade-owner','doc','text/plain','upgrade-doc') RETURNING id`;
      const [doc] = await sql`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,storage_object_id,title,created_by_actor_id,updated_by_actor_id,activity_version)
        VALUES(${w},${scope!.id},${channel!.id},${storage!.id},'Existing document',${a},${a},4) RETURNING id`;
      await sql`INSERT INTO flightdeck_pg_resource_view_states(workspace_id,viewer_actor_id,resource_type,resource_id,scope_id,channel_id,viewed_activity_version)
        VALUES(${w},${v},'task',${task!.id},${scope!.id},${channel!.id},3)`;
      const client = randomUUID(), epoch = randomUUID(), cursor = randomUUID(), token = randomUUID();
      const state = { mode:'delta', after:'17', epoch, protocol_version:2 };
      await sql`INSERT INTO flightdeck_pg_record_clients(workspace_id,actor_id,client_id,epoch,initial_state,checkpoint_cursor,checkpoint_state,revision)
        VALUES(${w},${v},${client},${epoch},${sql.json(state)},${cursor},${sql.json(state)},2)`;
      await sql`INSERT INTO flightdeck_pg_record_page_tokens(token,workspace_id,actor_id,client_id,epoch,state,base_revision)
        VALUES(${token},${w},${v},${client},${epoch},${sql.json(state)},2)`;
      const clients = await sql`SELECT * FROM flightdeck_pg_record_clients`;
      const tokens = await sql`SELECT * FROM flightdeck_pg_record_page_tokens`;
      const journal = await sql`SELECT * FROM flightdeck_pg_record_journal ORDER BY position`;
      init(archive('f621716'), true); // Locks down the real reported ordering failure.
      init(repo);
      expect((await sql`SELECT attention FROM flightdeck_pg_tasks WHERE id=${task!.id}`)[0]!.attention.policy_version).toBe(1);
      expect((await sql`SELECT attention FROM flightdeck_pg_docs WHERE id=${doc!.id}`)[0]!.attention.policy_version).toBe(1);
      const [view] = await sql`SELECT * FROM flightdeck_pg_resource_view_states WHERE resource_id=${task!.id}`;
      expect(Number(view!.viewed_activity_version)).toBe(3);
      expect(Number(view!.attention_activity_version)).toBe(7);
      expect(view!.attention_unread).toBe(true);
      const [projection] = await sql`SELECT row FROM flightdeck_pg_record_current WHERE family='task' AND id=${task!.id}`;
      expect(projection!.row.attention.policy_version).toBe(1);
      expect(await sql`SELECT * FROM flightdeck_pg_record_clients`).toEqual(clients);
      expect(await sql`SELECT * FROM flightdeck_pg_record_page_tokens`).toEqual(tokens);
      // Existing journal rows are immutable; only additive projection changes are allowed.
      expect((await sql`SELECT * FROM flightdeck_pg_record_journal ORDER BY position`).slice(0,journal.length)).toEqual(journal);
      const upgradedJournal = await sql`SELECT * FROM flightdeck_pg_record_journal ORDER BY position`;
      const upgradedCurrent = await sql`SELECT * FROM flightdeck_pg_record_current ORDER BY family,id`;
      init(repo);
      expect(await sql`SELECT * FROM flightdeck_pg_record_journal ORDER BY position`).toEqual(upgradedJournal);
      expect(await sql`SELECT * FROM flightdeck_pg_record_current ORDER BY family,id`).toEqual(upgradedCurrent);
      expect(await sql`SELECT * FROM flightdeck_pg_record_clients`).toEqual(clients);
      expect(await sql`SELECT * FROM flightdeck_pg_record_page_tokens`).toEqual(tokens);
      console.log('ed78118 -> fixed actual run-migrations upgrade and repeat passed; read watermark/checkpoint/page tokens and historical journal preserved');
    } finally {
      await sql.end();
      const admin = postgres({ ...conn, database:'postgres' });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      rmSync(temporary, { recursive:true, force:true });
    }
  }, 120_000);
});
