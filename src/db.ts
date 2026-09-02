import postgres from 'postgres';
import { config } from './config';

let sql: ReturnType<typeof postgres> | null = null;

export function getDb(): ReturnType<typeof postgres> {
  if (sql) return sql;

  const opts: postgres.Options<{}> = {
    database: config.db.database,
    max: config.db.max,
    idle_timeout: 20,
    connect_timeout: 10,
  };

  if (config.db.host) opts.host = config.db.host;
  if (config.db.port) opts.port = config.db.port;
  if (config.db.user) opts.username = config.db.user;
  if (config.db.password) opts.password = config.db.password;

  sql = postgres(opts);
  return sql;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}

/** Allow injecting a connection for tests */
export function setDb(connection: ReturnType<typeof postgres>): void {
  sql = connection;
}
