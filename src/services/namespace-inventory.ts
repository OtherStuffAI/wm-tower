import { getDb } from '../db';
import type { NamespaceInventory } from '../types';

// Owner-addressed metadata only. The route must authorize that exact address;
// a typed UUID or a backing workspace mapping never confers this authority.
export async function collectNamespaceInventory(owner: string, db = getDb()): Promise<NamespaceInventory> {
  return db.begin(async transaction => {
    const tx = transaction as unknown as typeof db;
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SELECT set_config('statement_timeout', '3000', true)`;
    const apps = await tx<NamespaceInventory['apps']>`
      SELECT a.app_npub, a.app_name, a.enabled, a.capabilities,
        n.schema_name, n.app_slug,
        (SELECT count(*)::text FROM workspace_app_rows r WHERE r.workspace_owner_npub = a.workspace_owner_npub AND r.app_npub = a.app_npub) AS shared_rows,
        (SELECT count(DISTINCT collection)::int FROM workspace_app_rows r WHERE r.workspace_owner_npub = a.workspace_owner_npub AND r.app_npub = a.app_npub) AS shared_collections,
        CASE WHEN n.schema_name IS NULL THEN NULL ELSE (
          SELECT count(*)::int FROM information_schema.tables t
          WHERE t.table_schema = n.schema_name AND t.table_type = 'BASE TABLE'
            AND t.table_name <> 'schema_migrations'
        ) END AS database_tables
      FROM workspace_apps a
      LEFT JOIN workspace_app_db_namespaces n
        ON n.workspace_owner_npub = a.workspace_owner_npub AND n.app_npub = a.app_npub
      WHERE a.workspace_owner_npub = ${owner}
      ORDER BY a.app_name, a.app_npub LIMIT 501
    `;
    return {
      workspace_owner_npub: owner, scope: 'owner_app_namespace',
      provenance: 'workspace_apps + workspace_app_rows + workspace_app_db_namespaces + information_schema.tables',
      apps: apps.slice(0, 500), truncated: apps.length > 500,
      coverage: 'Registration, shared app row/collection counts and allocated database schema metadata. Shared owner/app namespaces are not attributable to a single typed workspace. Table counts exclude schema_migrations; zero tables does not prove no app data. Shared row counts include all visibility classes at this owner/app scope, not just rows readable by the caller. Row contents, custom-schema row counts, legacy records, objects, graph, Git and physical bytes are not measured. Registration is not installation or online status.',
    };
  });
}
