import { getDb } from '../db';

function clampLimit(value: number | undefined, fallback = 100): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.min(Math.trunc(value), 500);
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 0) return 0;
  return Math.trunc(value);
}

export async function listWorkspaceRecordMetadata(
  workspaceOwnerNpub: string,
  options: {
    limit?: number;
    offset?: number;
    record_family_hash?: string;
  } = {},
) {
  const sql = getDb();
  const limit = clampLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const recordFamilyHash = String(options.record_family_hash || '').trim() || null;

  const rows = await sql<{
    record_id: string;
    record_family_hash: string;
    latest_version: number;
    previous_version: number;
    signature_npub: string;
    owner_ciphertext_bytes: number;
    group_payload_count: string;
    group_payload_bytes: string;
    total_versions: string;
    latest_created_at: Date;
    latest_updated_at: Date;
  }[]>`
    WITH latest_records AS (
      SELECT DISTINCT ON (record_id)
        id,
        record_id,
        record_family_hash,
        version,
        previous_version,
        signature_npub,
        owner_ciphertext,
        created_at,
        updated_at
      FROM v4_records
      WHERE owner_npub = ${workspaceOwnerNpub}
        AND (${recordFamilyHash}::text IS NULL OR record_family_hash = ${recordFamilyHash})
      ORDER BY record_id, version DESC
    ),
    version_counts AS (
      SELECT record_id, COUNT(*)::text AS total_versions
      FROM v4_records
      WHERE owner_npub = ${workspaceOwnerNpub}
        AND (${recordFamilyHash}::text IS NULL OR record_family_hash = ${recordFamilyHash})
      GROUP BY record_id
    )
    SELECT
      lr.record_id,
      lr.record_family_hash,
      lr.version AS latest_version,
      lr.previous_version,
      lr.signature_npub,
      octet_length(lr.owner_ciphertext) AS owner_ciphertext_bytes,
      COUNT(rgp.id)::text AS group_payload_count,
      COALESCE(SUM(octet_length(rgp.ciphertext)), 0)::text AS group_payload_bytes,
      vc.total_versions,
      lr.created_at AS latest_created_at,
      lr.updated_at AS latest_updated_at
    FROM latest_records lr
    JOIN version_counts vc ON vc.record_id = lr.record_id
    LEFT JOIN v4_record_group_payloads rgp ON rgp.record_row_id = lr.id
    GROUP BY
      lr.id,
      lr.record_id,
      lr.record_family_hash,
      lr.version,
      lr.previous_version,
      lr.signature_npub,
      lr.owner_ciphertext,
      lr.created_at,
      lr.updated_at,
      vc.total_versions
    ORDER BY lr.updated_at DESC, lr.record_id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(DISTINCT record_id)::text AS count
    FROM v4_records
    WHERE owner_npub = ${workspaceOwnerNpub}
      AND (${recordFamilyHash}::text IS NULL OR record_family_hash = ${recordFamilyHash})
  `;

  return {
    workspace_owner_npub: workspaceOwnerNpub,
    limit,
    offset,
    total: Number.parseInt(countRow?.count || '0', 10),
    records: rows.map((row) => ({
      ...row,
      group_payload_count: Number.parseInt(row.group_payload_count || '0', 10),
      group_payload_bytes: Number.parseInt(row.group_payload_bytes || '0', 10),
      total_versions: Number.parseInt(row.total_versions || '0', 10),
      latest_created_at: row.latest_created_at instanceof Date ? row.latest_created_at.toISOString() : row.latest_created_at,
      latest_updated_at: row.latest_updated_at instanceof Date ? row.latest_updated_at.toISOString() : row.latest_updated_at,
    })),
  };
}

export async function listWorkspaceRecordFamilyMetadata(workspaceOwnerNpub: string) {
  const sql = getDb();
  const rows = await sql<{
    record_family_hash: string;
    latest_record_count: string;
    total_versions: string;
    owner_ciphertext_bytes: string;
    group_payload_bytes: string;
    latest_updated_at: Date;
  }[]>`
    SELECT
      r.record_family_hash,
      COUNT(DISTINCT r.record_id)::text AS latest_record_count,
      COUNT(*)::text AS total_versions,
      COALESCE(SUM(octet_length(r.owner_ciphertext)), 0)::text AS owner_ciphertext_bytes,
      COALESCE((
        SELECT SUM(octet_length(rgp.ciphertext))
        FROM v4_record_group_payloads rgp
        JOIN v4_records r2 ON r2.id = rgp.record_row_id
        WHERE r2.owner_npub = ${workspaceOwnerNpub}
          AND r2.record_family_hash = r.record_family_hash
      ), 0)::text AS group_payload_bytes,
      MAX(r.updated_at) AS latest_updated_at
    FROM v4_records r
    WHERE r.owner_npub = ${workspaceOwnerNpub}
    GROUP BY r.record_family_hash
    ORDER BY MAX(r.updated_at) DESC, r.record_family_hash ASC
  `;

  return {
    workspace_owner_npub: workspaceOwnerNpub,
    families: rows.map((row) => {
      const ownerBytes = Number.parseInt(row.owner_ciphertext_bytes || '0', 10);
      const groupBytes = Number.parseInt(row.group_payload_bytes || '0', 10);
      return {
        record_family_hash: row.record_family_hash,
        app_namespace: appNamespaceFromFamily(row.record_family_hash),
        collection_space: collectionSpaceFromFamily(row.record_family_hash),
        latest_record_count: Number.parseInt(row.latest_record_count || '0', 10),
        total_versions: Number.parseInt(row.total_versions || '0', 10),
        owner_ciphertext_bytes: ownerBytes,
        group_payload_bytes: groupBytes,
        total_bytes: ownerBytes + groupBytes,
        latest_updated_at: row.latest_updated_at instanceof Date ? row.latest_updated_at.toISOString() : row.latest_updated_at,
      };
    }),
  };
}

function appNamespaceFromFamily(recordFamilyHash: string): string | null {
  const hash = String(recordFamilyHash || '').trim();
  const index = hash.lastIndexOf(':');
  return index > 0 ? hash.slice(0, index) : null;
}

function collectionSpaceFromFamily(recordFamilyHash: string): string {
  const hash = String(recordFamilyHash || '').trim();
  const index = hash.lastIndexOf(':');
  return index >= 0 && index < hash.length - 1 ? hash.slice(index + 1) : hash;
}

export async function listWorkspaceStorageMetadata(
  workspaceOwnerNpub: string,
  options: {
    limit?: number;
    offset?: number;
    public?: boolean;
    completed?: boolean;
  } = {},
) {
  const sql = getDb();
  const limit = clampLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const publicFilter = options.public;
  const completedFilter = options.completed;

  const rows = await sql<{
    object_id: string;
    owner_npub: string;
    owner_group_id: string | null;
    created_by_npub: string;
    access_group_ids: string[];
    is_public: boolean;
    file_name: string | null;
    content_type: string;
    size_bytes: number;
    sha256_hex: string | null;
    created_at: Date;
    completed_at: Date | null;
  }[]>`
    SELECT
      id AS object_id,
      owner_npub,
      owner_group_id,
      created_by_npub,
      access_group_ids,
      is_public,
      file_name,
      content_type,
      size_bytes,
      sha256_hex,
      created_at,
      completed_at
    FROM v4_storage_objects
    WHERE owner_npub = ${workspaceOwnerNpub}
      AND (${publicFilter ?? null}::boolean IS NULL OR is_public = ${publicFilter ?? null})
      AND (${completedFilter ?? null}::boolean IS NULL OR (completed_at IS NOT NULL) = ${completedFilter ?? null})
    ORDER BY created_at DESC, id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM v4_storage_objects
    WHERE owner_npub = ${workspaceOwnerNpub}
      AND (${publicFilter ?? null}::boolean IS NULL OR is_public = ${publicFilter ?? null})
      AND (${completedFilter ?? null}::boolean IS NULL OR (completed_at IS NOT NULL) = ${completedFilter ?? null})
  `;

  return {
    workspace_owner_npub: workspaceOwnerNpub,
    limit,
    offset,
    total: Number.parseInt(countRow?.count || '0', 10),
    objects: rows.map((row) => ({
      ...row,
      size_bytes: Number(row.size_bytes || 0),
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
    })),
  };
}
