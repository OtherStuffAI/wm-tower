import { getDb } from '../db';
import type { NamespaceInventory } from '../types';

// Owner-addressed metadata only. The route must authorize that exact address;
// a typed UUID or a backing workspace mapping never confers this authority.
export async function collectNamespaceInventory(owner: string, db = getDb()): Promise<NamespaceInventory> {
  return db.begin(async transaction => {
    const tx = transaction as unknown as typeof db;
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SELECT set_config('statement_timeout', '3000', true)`;
    const apps = await namespaceEntries(owner, tx);
    return {
      workspace_owner_npub: owner, scope: 'owner_app_namespace',
      provenance: 'workspace_apps + workspace_app_rows + workspace_app_db_namespaces + information_schema.tables + same-owner publisher references + namespace_console_archives',
      apps: apps.slice(0, 500), truncated: apps.length > 500,
      coverage: 'Registration and shared owner/app metadata only; not a full data or runtime inventory. Shared rows include all visibility classes. Custom-schema contents, graph, legacy records, storage, Git and external stores are unmeasured and retained. Zero counters never prove emptiness. Console archive preserves all data, registration flags, grants and runtime authority.',
    };
  });
}

export async function namespaceEntries(owner: string, tx = getDb(), app: string | null = null) {
    return await tx<NamespaceInventory['apps']>`
      SELECT a.id, a.app_npub, a.app_name, a.enabled, a.capabilities, a.created_at, a.updated_at,
        COALESCE(archive.archived, false) AS archived, COALESCE(archive.revision, 0)::text AS archive_revision,
        (SELECT count(*)::int FROM workspace_app_schema_manifests m WHERE m.workspace_owner_npub=a.workspace_owner_npub AND m.app_npub=a.app_npub) AS schema_manifests,
        (SELECT count(*)::int FROM flightdeck_pg_workspaces w WHERE w.workspace_owner_npub=a.workspace_owner_npub AND w.app_npub=a.app_npub) AS typed_workspaces,
        (SELECT count(*)::int FROM flightdeck_pg_wapp_installations i WHERE i.owner_npub=a.workspace_owner_npub AND i.publisher_npub=a.app_npub) AS current_publishers,
        (SELECT count(*)::int FROM flightdeck_pg_wapp_installations i WHERE i.owner_npub=a.workspace_owner_npub AND a.app_npub=ANY(i.previous_publisher_npubs)) AS previous_publishers,
        (SELECT count(*)::int FROM flightdeck_pg_wapp_installations i WHERE i.owner_npub=a.workspace_owner_npub AND i.publisher_npub=a.app_npub AND i.lifecycle_status='active') AS active_installations,
        (SELECT count(*)::int FROM flightdeck_pg_wapp_publishing_grants g JOIN flightdeck_pg_wapp_installations i ON i.id=g.installation_id WHERE i.owner_npub=a.workspace_owner_npub AND i.publisher_npub=a.app_npub AND g.status='active') AS active_grants,
        (SELECT count(*)::int FROM flightdeck_pg_personal_wapps w JOIN flightdeck_pg_wapp_installations i ON i.id=w.wapp_installation_id WHERE i.owner_npub=a.workspace_owner_npub AND i.publisher_npub=a.app_npub AND w.status='active' AND w.deleted_at IS NULL) AS active_launchers,
        n.schema_name, n.app_slug,
        (SELECT count(*)::text FROM workspace_app_rows r WHERE r.workspace_owner_npub = a.workspace_owner_npub AND r.app_npub = a.app_npub) AS shared_rows,
        (SELECT count(DISTINCT collection)::int FROM workspace_app_rows r WHERE r.workspace_owner_npub = a.workspace_owner_npub AND r.app_npub = a.app_npub) AS shared_collections,
        CASE WHEN n.schema_name IS NULL THEN NULL ELSE (
          SELECT count(*)::int FROM information_schema.tables t
          WHERE t.table_schema = n.schema_name AND t.table_type = 'BASE TABLE'
            AND t.table_name <> 'schema_migrations'
        ) END AS database_tables
      FROM workspace_apps a
      LEFT JOIN namespace_console_archives archive ON archive.workspace_owner_npub=a.workspace_owner_npub AND archive.app_npub=a.app_npub
      LEFT JOIN workspace_app_db_namespaces n
        ON n.workspace_owner_npub = a.workspace_owner_npub AND n.app_npub = a.app_npub
      WHERE a.workspace_owner_npub = ${owner} AND (${app}::text IS NULL OR a.app_npub=${app})
      ORDER BY a.app_name, a.app_npub LIMIT 501
    `;
}
