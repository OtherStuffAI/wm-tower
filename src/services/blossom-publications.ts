import { getDb } from '../db';
import { verifyStorageIdentity, storageObjectsByHash } from './storage';
import { resolveFlightDeckPgFileVersion } from './flightdeck-pg-api';
import type { V4StorageObject } from '../types';

type DbClient = ReturnType<typeof getDb>;
export class BlossomPublicationError extends Error {
  constructor(public code: string, public status: 404 | 409, message: string) { super(message); }
}

/** Public authority is a separate, version/hash-pinned reference; storage ACLs stay private. */
export async function hasBlossomPublication(storageObjectId: string, hash: string, sql: DbClient = getDb()) {
  const [row] = await sql`
    SELECT 1 FROM flightdeck_pg_blossom_publications p
    JOIN flightdeck_pg_files f ON f.workspace_id=p.workspace_id AND f.id=p.file_id
    JOIN flightdeck_pg_file_versions v ON v.workspace_id=p.workspace_id AND v.id=p.version_id AND v.file_id=p.file_id AND v.storage_object_id=p.storage_object_id
    WHERE p.storage_object_id=${storageObjectId} AND p.sha256_hex=${hash}
      AND p.revoked_at IS NULL AND f.deleted_at IS NULL AND v.operation <> 'deleted'
    LIMIT 1
  `;
  return !!row;
}

export async function fileBlossomPublications(input: {
  workspaceId: string; fileId: string; actorId: string; origin: string;
}, sql: DbClient = getDb()) {
  const rows = await sql`
    SELECT v.id AS version_id, v.version_number, v.storage_object_id, s.sha256_hex,
      s.is_public, s.completed_at, v.operation,
      EXISTS (SELECT 1 FROM flightdeck_pg_blossom_publications p WHERE p.workspace_id=v.workspace_id
        AND p.version_id=v.id AND p.actor_id=${input.actorId} AND p.revoked_at IS NULL) AS published_by_you,
      (SELECT COUNT(*)::integer FROM flightdeck_pg_blossom_publications p WHERE p.workspace_id=v.workspace_id
        AND p.version_id=v.id AND p.revoked_at IS NULL) AS publication_count
    FROM flightdeck_pg_file_versions v
    JOIN v4_storage_objects s ON s.id=v.storage_object_id
    WHERE v.workspace_id=${input.workspaceId} AND v.file_id=${input.fileId}
    ORDER BY v.version_number DESC
  `;
  const versions = [];
  for (const row of rows) {
    const [object] = await sql<V4StorageObject[]>`SELECT * FROM v4_storage_objects WHERE id=${row.storage_object_id}`;
    const verified = row.operation !== 'deleted' && object ? await verifyStorageIdentity(object) : null;
    let isPublic = false;
    if (verified) {
      // A hash URL is shared by identical bytes, including independently published copies.
      for (const candidate of await storageObjectsByHash(verified.sha256_hex!)) {
        if (!candidate.is_public && !await hasBlossomPublication(candidate.id, verified.sha256_hex!, sql)) continue;
        const publicBytes = await verifyStorageIdentity(candidate);
        if (publicBytes?.sha256_hex === verified.sha256_hex) { isPublic = true; break; }
      }
    }
    versions.push({ ...row, sha256_hex: verified?.sha256_hex ?? null,
      available: !!verified, public: isPublic,
      blossom_url: isPublic ? `${input.origin}/${verified!.sha256_hex}` : null });
  }
  return { file_id: input.fileId, versions };
}

export async function mutateBlossomPublication(input: {
  workspaceId: string; fileId: string; versionId: string; actorId: string;
  workspaceOwnerNpub: string; publish: boolean;
}, sql: DbClient) {
  // Serialize publication with file replacement/deletion and repeated operations.
  const [locked] = await sql`SELECT id FROM flightdeck_pg_files WHERE workspace_id=${input.workspaceId} AND id=${input.fileId} AND deleted_at IS NULL FOR UPDATE`;
  if (!locked) throw new BlossomPublicationError('file_not_found', 404, 'File is missing or deleted');
  const version = await resolveFlightDeckPgFileVersion({ workspaceId: input.workspaceId, versionId: input.versionId }, sql);
  if (!version || version.file_id !== input.fileId || version.operation === 'deleted')
    throw new BlossomPublicationError('file_version_not_found', 404, 'Selected file version is missing or deleted');
  if (!input.publish) {
    const changed = await sql`UPDATE flightdeck_pg_blossom_publications SET revoked_at=NOW()
      WHERE workspace_id=${input.workspaceId} AND version_id=${input.versionId} AND actor_id=${input.actorId} AND revoked_at IS NULL RETURNING version_id`;
    return changed.length > 0;
  }
  const [object] = await sql<V4StorageObject[]>`SELECT * FROM v4_storage_objects WHERE id=${version.storage_object_id}`;
  if (!object || object.owner_npub !== input.workspaceOwnerNpub)
    throw new BlossomPublicationError('storage_object_not_found', 404, 'Selected storage object is unavailable in this workspace');
  if (!object.completed_at) throw new BlossomPublicationError('storage_incomplete', 409, 'File upload is not complete');
  const verified = await verifyStorageIdentity(object);
  if (!verified) throw new BlossomPublicationError('storage_unavailable', 409, 'Stored bytes are missing or could not be verified');
  const [existing] = await sql`SELECT sha256_hex, revoked_at FROM flightdeck_pg_blossom_publications
    WHERE workspace_id=${input.workspaceId} AND version_id=${input.versionId} AND actor_id=${input.actorId}`;
  if (existing && existing.sha256_hex !== verified.sha256_hex)
    throw new BlossomPublicationError('publication_hash_changed', 409, 'Published immutable bytes changed; upload a new file version');
  if (existing && !existing.revoked_at) return false;
  await sql`INSERT INTO flightdeck_pg_blossom_publications (workspace_id,file_id,version_id,actor_id,storage_object_id,sha256_hex)
    VALUES (${input.workspaceId},${input.fileId},${input.versionId},${input.actorId},${object.id},${verified.sha256_hex!})
    ON CONFLICT (workspace_id,version_id,actor_id) DO UPDATE SET revoked_at=NULL,published_at=NOW()`;
  return true;
}
