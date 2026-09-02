import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_flightdeck_pg_outbox_cursors';

let sql: ReturnType<typeof postgres>;
let workspaceId: string;

beforeAll(async () => {
  const connection = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
  const admin = postgres({ ...connection, database: 'postgres' });

  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  sql = postgres({ ...connection, database: TEST_DB });

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  for (const statement of splitSqlStatements(migration)) {
    await sql.unsafe(statement);
  }
  await ensureRuntimeSchema(sql);

  const [actor] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
    VALUES ('npub1outboxcursorschemaowner', 'human', 'Outbox Cursor Schema Owner')
    RETURNING id
  `;
  const [workspace] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_workspaces (
      tower_service_npub,
      workspace_service_npub,
      workspace_owner_npub,
      app_npub,
      name,
      created_by_actor_id
    )
    VALUES (
      'npub1outboxcursortower',
      'npub1outboxcursorworkspace',
      'npub1outboxcursorowner',
      'npub1outboxcursorapp',
      'Outbox Cursor Schema',
      ${actor.id}
    )
    RETURNING id
  `;
  workspaceId = workspace.id;
});

afterAll(async () => {
  await sql.end();
});

async function insertOutboxEvent(eventType: string, rowVersion?: number) {
  if (rowVersion === undefined) {
    const [event] = await sql<{ id: string; row_version: number }[]>`
      INSERT INTO flightdeck_pg_outbox_events (workspace_id, event_type, payload)
      VALUES (${workspaceId}, ${eventType}, '{}'::jsonb)
      RETURNING id, row_version
    `;
    return event;
  }

  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (workspace_id, event_type, payload, row_version)
    VALUES (${workspaceId}, ${eventType}, '{}'::jsonb, ${rowVersion})
    RETURNING id, row_version
  `;
  return event;
}

async function resetOutboxSequence() {
  await sql`DELETE FROM flightdeck_pg_outbox_events`;
  await sql.unsafe('ALTER SEQUENCE flightdeck_pg_outbox_events_row_version_seq RESTART WITH 1');
}

describe('Flight Deck PG outbox cursor schema', () => {
  test('initializes a clean database with a working first cursor', async () => {
    await ensureRuntimeSchema(sql);
    const event = await insertOutboxEvent('flightdeck_pg.schema.clean');

    expect(event.row_version).toBe(1);
  });

  test('preserves sparse high cursors across repeated schema assurance', async () => {
    await resetOutboxSequence();
    const events = await Promise.all([
      insertOutboxEvent('flightdeck_pg.schema.sparse-low', 101),
      insertOutboxEvent('flightdeck_pg.schema.sparse-high', 1001),
    ]);

    await ensureRuntimeSchema(sql);
    await ensureRuntimeSchema(sql);

    const stored = await sql<{ id: string; row_version: number }[]>`
      SELECT id, row_version
      FROM flightdeck_pg_outbox_events
      ORDER BY row_version
    `;
    expect(Array.from(stored)).toEqual([
      { id: events[0].id, row_version: 101 },
      { id: events[1].id, row_version: 1001 },
    ]);

    const next = await insertOutboxEvent('flightdeck_pg.schema.after-sparse');
    expect(next.row_version).toBe(1002);
  });

  test('does not rewind a sequence ahead of the table maximum', async () => {
    await resetOutboxSequence();
    const historical = await Promise.all([
      insertOutboxEvent('flightdeck_pg.schema.historical-low', 2001),
      insertOutboxEvent('flightdeck_pg.schema.historical-high', 8001),
    ]);
    await sql.unsafe(
      "SELECT setval('flightdeck_pg_outbox_events_row_version_seq', 12001, true)",
    );

    await ensureRuntimeSchema(sql);
    await ensureRuntimeSchema(sql);

    const [sequence] = await sql<{ last_value: string; is_called: boolean }[]>`
      SELECT last_value, is_called
      FROM flightdeck_pg_outbox_events_row_version_seq
    `;
    const stored = await sql<{ id: string; row_version: number }[]>`
      SELECT id, row_version
      FROM flightdeck_pg_outbox_events
      ORDER BY row_version
    `;
    expect(sequence).toEqual({ last_value: '12001', is_called: true });
    expect(Array.from(stored)).toEqual([
      { id: historical[0].id, row_version: 2001 },
      { id: historical[1].id, row_version: 8001 },
    ]);

    const next = await insertOutboxEvent('flightdeck_pg.schema.after-ahead-sequence');
    expect(next.row_version).toBe(12002);
    expect(next.row_version).toBeGreaterThan(Math.max(...stored.map((event) => event.row_version)));
  });

  test('rejects legacy duplicate cursors without rewriting either row', async () => {
    await resetOutboxSequence();
    await sql.unsafe('DROP INDEX idx_flightdeck_pg_outbox_events_row_version');
    const duplicates = await Promise.all([
      insertOutboxEvent('flightdeck_pg.schema.duplicate-a', 15001),
      insertOutboxEvent('flightdeck_pg.schema.duplicate-b', 15001),
    ]);

    try {
      await ensureRuntimeSchema(sql);
      throw new Error('Expected duplicate cursor schema assurance to fail');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('23505');
    }

    const stored = await sql<{ id: string; row_version: number }[]>`
      SELECT id, row_version
      FROM flightdeck_pg_outbox_events
      ORDER BY id
    `;
    expect(Array.from(stored)).toEqual(
      duplicates
        .map((event) => ({ id: event.id, row_version: 15001 }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );

    await sql`DELETE FROM flightdeck_pg_outbox_events WHERE id = ${duplicates[1].id}`;
    await ensureRuntimeSchema(sql);
  });
});
