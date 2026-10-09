import { getDb } from '../db';
import type { WorkspaceStorageUsage, WorkspaceStorageUsageCategory } from '../types';

const TTL_MS = 60_000;
const MAX_ENTRIES = 128;
const MAX_COLLECTORS = 2;
type Db = ReturnType<typeof getDb>;
const unavailable = (id: string, label: string, reason: string): WorkspaceStorageUsageCategory => ({
  id, label, bytes: null, status: 'unavailable', measurement: 'unavailable', reason,
});

export function storedBytes(value: unknown): number {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(number) || number < 0) throw new Error('Invalid stored-byte measurement');
  return number;
}

export function storageUsageSnapshot(workspaceId: string, collectedAt: string, categories: WorkspaceStorageUsageCategory[]): WorkspaceStorageUsage {
  const measured = categories.filter(row => row.bytes !== null);
  const sum = measured.reduce((total, row) => total + storedBytes(row.bytes), 0);
  const total = measured.length && Number.isSafeInteger(sum) ? sum : null;
  return {
    workspace_id: workspaceId, collected_at: collectedAt, cache_ttl_seconds: TTL_MS / 1000,
    categories, total_bytes: total, coverage: 'partial',
    total_description: 'Covered stored-byte subtotal, including logical database estimates. Not whole-workspace disk usage. Unavailable stores and unlinked objects are excluded; database indexes, TOAST, WAL, backups and shared infrastructure are excluded.',
  };
}

// A bounded, read-only collector. No provider disk walk and no billing dependency.
export async function collectWorkspaceStorageUsage(workspaceId: string, db: Db = getDb()): Promise<WorkspaceStorageUsage> {
  const categories = [
    unavailable('objects', 'S3 / object storage', 'Object metadata collection failed or exceeded its time budget.'),
    unavailable('database', 'Database', 'Database collection failed or exceeded its time budget.'),
    unavailable('graph', 'Graph', 'Tower graph uses separate RLS-protected storage and owner-npub attribution. A complete workspace-UUID byte counter is not supported; whole-server disk and actor-visible subsets are not workspace usage.'),
    unavailable('git', 'Git / Forgejo', 'Forgejo owns repositories and permissions. No authoritative repository-to-Tower-workspace mapping or workspace byte provider is configured.'),
    unavailable('grasp', 'GRASP', 'GRASP owns its repository and relay store independently (currently a private PoC). No supported workspace attribution and stored-byte provider exists.'),
    unavailable('other', 'Other stores', 'Legacy encrypted records, WApp namespaces, unlinked objects, backups and external stores do not have complete workspace-UUID attribution in this collector.'),
  ];
  // Discover only direct Flight Deck UUID-owned rows; indirect/shared rows are explicitly excluded.
  // Fixed public schema and a table cap bound catalog work. Identifier quoting prevents SQL injection.
  let tables: { table_name: string; has_object: boolean }[] = [];
  try {
    tables = await db.begin(async tx => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SELECT set_config('statement_timeout', '3000', true)`;
      return tx<{ table_name: string; has_object: boolean }[]>`
        SELECT c.table_name, bool_or(c.column_name = 'storage_object_id') AS has_object
        FROM information_schema.columns c
        JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.table_name LIKE 'flightdeck\\_pg\\_%' ESCAPE '\\'
        GROUP BY c.table_name
        HAVING bool_or(c.column_name = 'workspace_id' AND c.udt_name = 'uuid')
        ORDER BY c.table_name LIMIT 129
      `;
    }) as typeof tables;
    if (!tables.length || tables.length > 128) throw new Error('Unsupported catalog coverage');
  } catch {
    return storageUsageSnapshot(workspaceId, new Date().toISOString(), categories);
  }
  const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
  try {
    const bytes = await db.begin(async tx => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SELECT set_config('statement_timeout', '3000', true)`;
      const sums = tables.map(table => `SELECT COALESCE(SUM(octet_length(to_jsonb(r)::text)),0)::numeric AS bytes FROM public.${identifier(table.table_name)} r WHERE workspace_id = $1::uuid`);
      const [row] = await tx.unsafe(`SELECT SUM(bytes)::text AS bytes FROM (${sums.join(' UNION ALL ')}) measured`, [workspaceId]);
      return storedBytes(row?.bytes);
    });
    categories[1] = { id: 'database', label: 'Database', bytes, status: 'partial', measurement: 'logical_estimate', reason: 'UTF-8 serialized JSON byte estimate of direct workspace-UUID Flight Deck rows (including retained history and metadata). Excludes indirect/shared rows, indexes, TOAST, WAL and physical disk overhead.' };
  } catch { /* An unavailable measurement is never zero. */ }
  const refs = tables.filter(table => table.has_object);
  if (refs.length) {
    try {
      const bytes = await db.begin(async tx => {
        await tx`SET TRANSACTION READ ONLY`;
        await tx`SELECT set_config('statement_timeout', '3000', true)`;
        const selections = refs.map(table => `SELECT storage_object_id FROM public.${identifier(table.table_name)} WHERE workspace_id = $1::uuid`);
        const [row] = await tx.unsafe(`
          WITH refs AS (${selections.join(' UNION ')}), objects AS (
            SELECT o.storage_path, MIN(o.size_bytes) AS low, MAX(o.size_bytes) AS high
            FROM v4_storage_objects o JOIN refs r ON r.storage_object_id = o.id
            WHERE o.completed_at IS NOT NULL GROUP BY o.storage_path
          ) SELECT COALESCE(SUM(high),0)::text AS bytes,
            COUNT(*) FILTER (WHERE low <> high OR low < 0)::int AS conflicts FROM objects`, [workspaceId]);
        if (Number(row?.conflicts) !== 0) throw new Error('Conflicting object sizes');
        return storedBytes(row?.bytes);
      });
      categories[0] = { id: 'objects', label: 'S3 / object storage', bytes, status: 'partial', measurement: 'registered_bytes', reason: 'Completed object sizes registered in Tower and referenced by this workspace, including retained versions. Each storage path counted once; shared objects counted once within this workspace. Unlinked uploads, provider versions and backups excluded; not a bucket disk scan.' };
    } catch { /* Keep reason and null. */ }
  }
  return storageUsageSnapshot(workspaceId, new Date().toISOString(), categories);
}

export function createStorageUsageCache(collect: (workspaceId: string) => Promise<WorkspaceStorageUsage> = collectWorkspaceStorageUsage, now = Date.now) {
  const cache = new Map<string, { expires: number; value: WorkspaceStorageUsage }>();
  const pending = new Map<string, Promise<WorkspaceStorageUsage>>();
  return async (workspaceId: string): Promise<WorkspaceStorageUsage> => {
    const cached = cache.get(workspaceId);
    if (cached && cached.expires > now()) return cached.value;
    const inflight = pending.get(workspaceId);
    if (inflight) return inflight;
    if (pending.size >= MAX_COLLECTORS) throw new Error('storage_usage_busy');
    const work = Promise.resolve().then(() => collect(workspaceId)).then(value => {
      cache.delete(workspaceId);
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(workspaceId, { expires: now() + TTL_MS, value });
      return value;
    }).finally(() => pending.delete(workspaceId));
    pending.set(workspaceId, work);
    return work;
  };
}
export const getWorkspaceStorageUsage = createStorageUsageCache();
