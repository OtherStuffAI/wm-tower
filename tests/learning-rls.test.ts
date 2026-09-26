import { expect, test } from 'bun:test';
import postgres from 'postgres';
import { learningV1Sql } from '../src/schema/learning-v1';

// Explicit opt-in: creates and drops a disposable database on the selected server.
test.skipIf(process.env.LEARNING_RLS_TEST !== '1')('learning request role enforces private-row RLS in PostgreSQL', async () => {
  const database = `tower_learning_rls_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const options = {
    host: process.env.LEARNING_RLS_TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    max: 1,
  };
  const admin = postgres({ ...options, database: 'postgres' });
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    sql = postgres({ ...options, database });
    await sql.unsafe(learningV1Sql);
    await sql`CREATE TABLE other_tower_rows (value text NOT NULL)`;
    await sql`INSERT INTO other_tower_rows (value) VALUES ('outside learning')`;
    const role = await sql`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'tower_learning_rls_v1'`;
    expect(role[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    const owner = await sql`SELECT pg_get_userbyid(relowner) AS owner, relforcerowsecurity FROM pg_class WHERE oid = 'learning_plans'::regclass`;
    expect(owner[0]).toMatchObject({ owner: options.username, relforcerowsecurity: true });
    const a = 'npub1rlstestlearneraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'npub1rlstestlearnerbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const bot = 'npub1rlstestbotccccccccccccccccccccccccccccccccccccccccccccc';
    const actor = async <T>(npub: string, learner: string, fn: (tx: any) => Promise<T>) => sql!.begin(async tx => {
      await tx`SET LOCAL ROLE tower_learning_rls_v1`;
      await tx`SELECT set_config('app.learning_actor_npub', ${npub}, true)`;
      await tx`SELECT set_config('app.learning_learner_npub', ${learner}, true)`;
      const identity = await tx`SELECT current_user, current_setting('row_security') AS row_security`;
      expect(identity[0]).toMatchObject({ current_user: 'tower_learning_rls_v1', row_security: 'on' });
      return fn(tx);
    });
    await actor(a, a, tx => tx`INSERT INTO learning_profiles (learner_npub) VALUES (${a})`);
    await actor(b, b, tx => tx`INSERT INTO learning_profiles (learner_npub) VALUES (${b})`);
    await actor(a, a, tx => tx`INSERT INTO learning_plans (learner_npub, goal, corpus, curriculum_version, milestones) VALUES (${a}, 'moon-phases', 'learning.space.v1', 'test', '[]')`);
    await actor(b, b, tx => tx`INSERT INTO learning_plans (learner_npub, goal, corpus, curriculum_version, milestones) VALUES (${b}, 'moon-phases', 'learning.space.v1', 'test', '[]')`);
    expect((await actor(a, a, tx => tx`SELECT learner_npub FROM learning_plans`)).map(row => row.learner_npub)).toEqual([a]);
    expect((await actor(b, b, tx => tx`SELECT learner_npub FROM learning_plans`)).map(row => row.learner_npub)).toEqual([b]);
    expect(await actor(a, '', tx => tx`SELECT learner_npub FROM learning_plans`)).toHaveLength(0);
    await actor(a, a, async tx => {
      const nested = await tx.savepoint((inner: any) => inner`SELECT current_user, count(*)::int AS visible FROM learning_plans`);
      expect(nested[0]).toMatchObject({ current_user: 'tower_learning_rls_v1', visible: 1 });
    });
    await expect(actor(a, a, tx => tx`INSERT INTO learning_plans (learner_npub, goal, corpus, curriculum_version, milestones) VALUES (${b}, 'cross', 'learning.space.v1', 'test', '[]')`)).rejects.toThrow();
    await expect(actor(a, a, tx => tx`SELECT * FROM other_tower_rows`)).rejects.toThrow();
    const grant = await actor(a, a, tx => tx`INSERT INTO learning_delegations (learner_npub, grantee_npub, role, can_write) VALUES (${a}, ${bot}, 'reviewer', true) RETURNING id`);
    expect((await actor(bot, '', tx => tx`SELECT learner_npub FROM learning_delegations WHERE id = ${grant[0].id} AND revoked_at IS NULL`))[0].learner_npub).toBe(a);
    await actor(a, a, tx => tx`UPDATE learning_delegations SET revoked_at = now() WHERE id = ${grant[0].id}`);
    expect(await actor(bot, '', tx => tx`SELECT learner_npub FROM learning_delegations WHERE id = ${grant[0].id} AND revoked_at IS NULL`)).toHaveLength(0);
    expect((await sql`SELECT 1.0::numeric AS value`)[0].value).toBe('1.0');
    expect((await sql`SELECT current_user`)[0].current_user).toBe(options.username);
  } finally {
    if (sql) await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
