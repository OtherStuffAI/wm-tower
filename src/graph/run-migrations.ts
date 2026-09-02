import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { config } from '../config';
import { closeGraphDbs, getGraphAdminDb } from './db';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ownerRole = 'tower_graph_owner';

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function adminOptions(database: string): postgres.Options<{}> {
  const opts: postgres.Options<{}> = {
    database,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  };

  if (config.graph.db.host) opts.host = config.graph.db.host;
  if (config.graph.db.port) opts.port = config.graph.db.port;
  if (config.graph.db.adminUser) opts.username = config.graph.db.adminUser;
  if (config.graph.db.adminPassword) opts.password = config.graph.db.adminPassword;

  return opts;
}

async function ensureDatabaseExists(): Promise<void> {
  const admin = postgres(adminOptions('postgres'));

  try {
    const rows = await admin<{ exists: number }[]>`
      SELECT 1 as exists FROM pg_database WHERE datname = ${config.graph.db.database}
    `;

    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE ${quoteIdent(config.graph.db.database)}`);
      console.log(`Created graph database ${config.graph.db.database}`);
    }
  } finally {
    await admin.end();
  }
}

async function ensureRoles(sql: ReturnType<typeof getGraphAdminDb>): Promise<void> {
  const [owner] = await sql<{ exists: number }[]>`
    SELECT 1 AS exists FROM pg_roles WHERE rolname = ${ownerRole}
  `;
  if (!owner) {
    await sql.unsafe(`CREATE ROLE ${quoteIdent(ownerRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  } else {
    await sql.unsafe(`ALTER ROLE ${quoteIdent(ownerRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }

  const [app] = await sql<{ exists: number }[]>`
    SELECT 1 AS exists FROM pg_roles WHERE rolname = ${config.graph.db.appUser}
  `;
  if (!app) {
    await sql.unsafe(`CREATE ROLE ${quoteIdent(config.graph.db.appUser)} LOGIN PASSWORD ${quoteLiteral(config.graph.db.appPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  } else {
    await sql.unsafe(`ALTER ROLE ${quoteIdent(config.graph.db.appUser)} LOGIN PASSWORD ${quoteLiteral(config.graph.db.appPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }
}

async function applyOwnershipAndGrants(sql: ReturnType<typeof getGraphAdminDb>): Promise<void> {
  const tables = [
    'graph_memories',
    'graph_memory_acl',
    'graph_entities',
    'graph_memory_entities',
    'graph_import_runs',
    'graph_repository_checkpoints',
    'graph_schema_snapshots',
    'graph_nodes',
    'graph_node_labels',
    'graph_edges',
  ];

  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(config.graph.db.appUser)}`);

  for (const table of tables) {
    await sql.unsafe(`ALTER TABLE ${quoteIdent(table)} OWNER TO ${quoteIdent(ownerRole)}`);
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteIdent(table)} TO ${quoteIdent(config.graph.db.appUser)}`);
  }

  await sql.unsafe(`GRANT EXECUTE ON FUNCTION graph_current_group_ids() TO ${quoteIdent(config.graph.db.appUser)}`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION graph_has_group(uuid) TO ${quoteIdent(config.graph.db.appUser)}`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION graph_scope_visible(text, text, text, uuid) TO ${quoteIdent(config.graph.db.appUser)}`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION graph_scope_writable(text, text, text, text, uuid, text) TO ${quoteIdent(config.graph.db.appUser)}`);
}

export async function runGraphMigrations() {
  await ensureDatabaseExists();

  const sql = getGraphAdminDb();

  await ensureRoles(sql);
  await sql`SELECT set_config('app.graph_name', ${config.graph.ageGraphName}, false)`;

  const migrationPath = join(__dirname, 'migrations', '001_graph_init.sql');
  const migration = readFileSync(migrationPath, 'utf-8');

  console.log('Running graph database migration 001_graph_init.sql...');
  await sql.unsafe(migration);
  await applyOwnershipAndGrants(sql);
  console.log('Graph database migrations complete.');

  await closeGraphDbs();
}

if (import.meta.main) {
  runGraphMigrations().catch(async (err) => {
    console.error('Graph migration failed:', err);
    await closeGraphDbs().catch(() => undefined);
    process.exit(1);
  });
}
