import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { getDb, closeDb } from '../db';
import { config } from '../config';
import { ensureRuntimeSchema } from './ensure-runtime-schema';
import { splitSqlStatements } from './sql-statements';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function ensureDatabaseExists(): Promise<void> {
  const adminOpts: Parameters<typeof postgres>[0] = {
    database: 'postgres',
  };

  if (config.db.host) adminOpts.host = config.db.host;
  if (config.db.port) adminOpts.port = config.db.port;
  if (config.db.user) adminOpts.username = config.db.user;
  if (config.db.password) adminOpts.password = config.db.password;

  const admin = postgres(adminOpts);
  try {
    const rows = await admin<{ exists: number }[]>`
      SELECT 1 as exists FROM pg_database WHERE datname = ${config.db.database}
    `;

    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${config.db.database.replace(/"/g, '""')}"`);
      console.log(`Created database ${config.db.database}`);
    }
  } finally {
    await admin.end();
  }
}

async function run() {
  await ensureDatabaseExists();

  const sql = getDb();

  const migrationPath = join(__dirname, '001_init.sql');
  const migration = readFileSync(migrationPath, 'utf-8');

  const statements = splitSqlStatements(migration);

  const tableStatements = statements.filter((statement) =>
    /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/i.test(statement),
  );
  const bootstrapStatements = statements.filter((statement) => {
    if (/^(CREATE\s+TABLE|CREATE\s+SEQUENCE)\s+IF\s+NOT\s+EXISTS\s+/i.test(statement)) return true;
    const functionName = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\(/i.exec(statement)?.[1];
    // Only table dependencies belong in this early pass. Other functions can
    // reference columns added by ensureRuntimeSchema (e.g. task attention).
    return !!functionName && tableStatements.some((table) =>
      new RegExp(`\\b${functionName}\\s*\\(`, 'i').test(table),
    );
  });
  const groupsTableStatement = bootstrapStatements.find((statement) =>
    /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+v4_groups\b/i.test(statement),
  );

  if (!groupsTableStatement) {
    throw new Error('Missing v4_groups bootstrap statement in 001_init.sql');
  }

  // A fresh database needs base tables before runtime ALTER/backfill statements
  // can run. Older databases need the runtime ALTER statements before later
  // indexes and foreign keys in 001_init.sql reference newer columns.
  // Include table dependency functions in source order: generated columns and
  // defaults can depend on functions declared before their table. Do not hoist all tables ahead
  // of those dependencies (or all functions ahead of their table types).
  for (const statement of bootstrapStatements) {
    await sql.unsafe(statement);
  }
  await ensureRuntimeSchema();

  console.log(`Running ${statements.length} migration statements...`);

  for (let i = 0; i < statements.length; i++) {
    await sql.unsafe(statements[i]);
    console.log(`  [${i + 1}/${statements.length}] OK`);
  }

  console.log('Migrations complete.');
  await closeDb();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
