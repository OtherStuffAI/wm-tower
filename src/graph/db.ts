import postgres from 'postgres';
import { config } from '../config';

export type GraphDb = ReturnType<typeof postgres>;

let graphAdminDb: GraphDb | null = null;
let graphDb: GraphDb | null = null;

function baseOptions(database: string): postgres.Options<{}> {
  const opts: postgres.Options<{}> = {
    database,
    idle_timeout: 20,
    connect_timeout: 10,
  };

  if (config.graph.db.host) opts.host = config.graph.db.host;
  if (config.graph.db.port) opts.port = config.graph.db.port;

  return opts;
}

export function getGraphAdminDb(): GraphDb {
  if (graphAdminDb) return graphAdminDb;

  const opts = baseOptions(config.graph.db.database);
  opts.max = 1;
  opts.username = config.graph.db.adminUser;
  opts.password = config.graph.db.adminPassword;

  graphAdminDb = postgres(opts);
  return graphAdminDb;
}

export function getGraphDb(): GraphDb {
  if (graphDb) return graphDb;

  const opts = baseOptions(config.graph.db.database);
  opts.max = config.graph.db.max;
  opts.username = config.graph.db.appUser;
  opts.password = config.graph.db.appPassword;

  graphDb = postgres(opts);
  return graphDb;
}

export async function closeGraphDbs(): Promise<void> {
  if (graphAdminDb) {
    await graphAdminDb.end();
    graphAdminDb = null;
  }

  if (graphDb) {
    await graphDb.end();
    graphDb = null;
  }
}
