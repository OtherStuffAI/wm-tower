# Workspace stored-byte usage

`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/storage-usage` is an additive
NIP-98 authenticated API. Tower resolves the requested UUID, requires current
membership and `workspace.manage`, then reads a cached or newly collected snapshot.
Authorization precedes every cache read: permission revocation applies immediately.
This does not change the legacy owner-npub billing usage API.

The response contains `workspace_id`, `collected_at`, `cache_ttl_seconds`,
`categories`, nullable `total_bytes`, `coverage` and `total_description`.
Every category has `id`, `label`, nullable `bytes`, `status`, `measurement` and
`reason`. The OpenAPI route and `WorkspaceStorageUsage` types describe this shape.
A null measurement is unavailable, never zero. Zero means measured zero within
the explicitly stated coverage. The subtotal is null when no store was measured.

| Category | Current coverage |
| --- | --- |
| S3 / object storage | Completed Tower object metadata referenced by direct UUID-owned Flight Deck tables, including retained object versions and deleted links. Object IDs are deduplicated across references, then storage paths across metadata rows. Unlinked uploads, provider versions and backups are excluded. This is a registered byte counter, not a physical bucket verification. |
| Database | UTF-8 serialized JSON byte estimate of direct UUID-owned Flight Deck rows. Includes retained history and metadata; excludes indirect/shared rows, indexes, TOAST, WAL, backups and physical allocation. |
| Graph | Unavailable: separate RLS-protected graph database with owner-npub attribution lacks a complete workspace-UUID byte counter. An actor-visible subset or whole-server disk would be misleading. |
| Git / Forgejo | Unavailable: native Forgejo owns repositories, permissions and storage. No authoritative workspace mapping/measurement provider is configured. Historical Tower Git ownership is not used. |
| GRASP | Unavailable: independent repository/relay store, currently a private PoC. Workspace read membership is not repository ownership and no supported byte attribution exists. |
| Other stores | Unavailable: legacy encrypted records, WApp namespaces, unlinked uploads, backups and external stores are not completely attributable by workspace UUID in this collector. |

Objects and logical database row estimates measure separate representations:
object contents are counted only in objects; database rows include their reference
metadata. This is a mixed covered subtotal including estimates, not total disk or
billing usage. Shared objects count once *within* a workspace, so sums across
workspaces are not a provider-wide physical total. Conflicting sizes for one path
invalidate the object category. Invalid/unsafe integer counts invalidate that
measurement rather than returning a fabricated zero.

Collection uses a read-only, fixed-public-schema catalog of direct
`flightdeck_pg_` base tables with UUID `workspace_id`, capped at 128 tables.
The catalog, database aggregate and object aggregate each have a 3-second SQL
statement deadline in their own transaction; failures preserve other measured
categories. Identifiers come from the catalog and are quoted. No recursive file,
Git or bucket scan runs on rendering. Each process caches at most 128 snapshots
for 60 seconds, coalesces same-workspace requests and admits at most two collectors.
Refresh requests the current snapshot without bypassing these bounds.
HTTP responses use `Cache-Control: private, no-store`. No new schema, background
worker, credential or lifecycle change is required.

Source tests use a disposable PostgreSQL fixture and real signed in-process Hono
requests. Activate the new Tower source through the manager-controlled local
rebuild/restart before claiming live validation. Remote deployment and provider
integration remain separate operations.
