import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { getTowerProfile, updateTowerProfile } from '../src/services/tower-profile';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_tower_profile';

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const adminOpts: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
  };
  if (process.env.DB_USER) adminOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) adminOpts.password = process.env.DB_PASSWORD;

  const admin = postgres(adminOpts);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  const testOpts: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: TEST_DB,
  };
  if (process.env.DB_USER) testOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) testOpts.password = process.env.DB_PASSWORD;

  sql = postgres(testOpts);
  setDb(sql);

  const { readFileSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);
  for (const statement of statements) {
    await sql.unsafe(statement);
  }

  app = createApp();
});

afterAll(async () => {
  if (sql) await sql.end();
});

describe('Tower profile', () => {
  test('keeps persisted Tower metadata off the unauthenticated health response', async () => {
    await updateTowerProfile({
      tower_name: 'Mini Family Tower',
      tower_description: 'Private self-hosted SuperBased tower for shared workspaces.',
    });

    const profile = await getTowerProfile();
    expect(profile.tower_name).toBe('Mini Family Tower');
    expect(profile.tower_description).toBe('Private self-hosted SuperBased tower for shared workspaces.');

    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body).not.toHaveProperty('tower_name');
    expect(body).not.toHaveProperty('tower_description');
    expect(body.build.name).toBe('wingman-tower');
    expect(typeof body.build.runtime).toBe('string');
    expect(typeof body.sse_connections).toBe('number');
  });
});
