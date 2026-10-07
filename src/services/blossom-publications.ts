import { getDb } from '../db';
import { verifyStorageIdentity, storageObjectsByHash } from './storage';
import { resolveFlightDeckPgFileVersion } from './flightdeck-pg-api';
import { authorizeFlightDeckPgStorageAttach, authorizeFlightDeckPgStorageRead } from './flightdeck-pg-storage-access';
import { isFlightDeckPgThreadParticipant } from './flightdeck-pg-api';
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
  if (row) return true;
  const refs = await sql`
    SELECT p.*, m.channel_id, m.thread_id, a.npub, a.kind, w.app_npub
    FROM flightdeck_pg_blossom_message_publications p
    JOIN flightdeck_pg_storage_links l ON l.id=p.link_id AND l.workspace_id=p.workspace_id
      AND l.entity_type='message' AND l.entity_id=p.message_id AND l.storage_object_id=p.storage_object_id AND l.deleted_at IS NULL
    JOIN flightdeck_pg_messages m ON m.workspace_id=p.workspace_id AND m.id=p.message_id
      AND m.channel_id=l.channel_id AND m.scope_id=l.scope_id AND m.deleted_at IS NULL
    JOIN flightdeck_pg_workspaces w ON w.id=p.workspace_id
    JOIN v4_storage_objects s ON s.id=p.storage_object_id AND s.owner_npub=w.workspace_owner_npub
    JOIN flightdeck_pg_actors a ON a.id=p.actor_id
    WHERE p.storage_object_id=${storageObjectId} AND p.sha256_hex=${hash} AND p.revoked_at IS NULL
      AND (m.thread_id IS NULL OR EXISTS (SELECT 1 FROM flightdeck_pg_threads t
        WHERE t.workspace_id=m.workspace_id AND t.id=m.thread_id AND t.channel_id=m.channel_id AND t.scope_id=m.scope_id AND t.deleted_at IS NULL))
  `;
  for (const ref of refs) {
    const access = await authorizeFlightDeckPgStorageAttach({ actorNpub: ref.npub, appNpub: ref.app_npub,
      workspaceId: ref.workspace_id, entityType: 'message', channelId: ref.channel_id }, sql);
    if (!access.allowed || !(await authorizeFlightDeckPgStorageRead({ actorNpub: ref.npub, appNpub: ref.app_npub,
      workspaceId: ref.workspace_id, entityType: 'message', channelId: ref.channel_id }, sql)).allowed) continue;
    if (ref.kind !== 'human' && ref.thread_id && !await isFlightDeckPgThreadParticipant({
      workspaceId: ref.workspace_id, threadId: ref.thread_id, actorId: ref.actor_id, actorNpub: ref.npub }, sql)) continue;
    return true;
  }
  return false;
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

/** Resolve the actual active source, including channel/scope consistency. */
export async function messageAttachmentSource(input: { workspaceId: string; messageId: string; storageObjectId: string }, sql: DbClient = getDb()) {
  const [source] = await sql`
    SELECT l.id AS link_id, m.channel_id, m.thread_id FROM flightdeck_pg_storage_links l
    JOIN flightdeck_pg_messages m ON m.workspace_id=l.workspace_id AND m.id=l.entity_id
      AND m.channel_id=l.channel_id AND m.scope_id=l.scope_id AND m.deleted_at IS NULL
    WHERE l.workspace_id=${input.workspaceId} AND l.entity_type='message' AND l.entity_id=${input.messageId}
      AND l.storage_object_id=${input.storageObjectId} AND l.deleted_at IS NULL
      AND (m.thread_id IS NULL OR EXISTS (SELECT 1 FROM flightdeck_pg_threads t
        WHERE t.workspace_id=m.workspace_id AND t.id=m.thread_id AND t.channel_id=m.channel_id AND t.scope_id=m.scope_id AND t.deleted_at IS NULL))
  `;
  return source ?? null;
}

export async function messageAttachmentBlossom(input: {
  workspaceId: string; messageId: string; storageObjectId: string; actorId: string;
  workspaceOwnerNpub: string; origin: string;
}, sql: DbClient = getDb()) {
  const source = await messageAttachmentSource(input, sql);
  if (!source) throw new BlossomPublicationError('attachment_not_found', 404, 'Message attachment is missing or removed');
  const [object] = await sql<V4StorageObject[]>`SELECT * FROM v4_storage_objects WHERE id=${input.storageObjectId} AND owner_npub=${input.workspaceOwnerNpub}`;
  if (!object) throw new BlossomPublicationError('storage_object_not_found', 404, 'Attachment is unavailable in this workspace');
  const verified = await verifyStorageIdentity(object);
  const [refs] = await sql`SELECT COUNT(*)::integer AS publication_count,
    COALESCE(BOOL_OR(actor_id=${input.actorId}),false) AS published_by_you
    FROM flightdeck_pg_blossom_message_publications WHERE workspace_id=${input.workspaceId}
      AND link_id=${source.link_id} AND revoked_at IS NULL`;
  let isPublic = false;
  if (verified) for (const candidate of await storageObjectsByHash(verified.sha256_hex!)) {
    if (!candidate.is_public && !await hasBlossomPublication(candidate.id, verified.sha256_hex!, sql)) continue;
    if ((await verifyStorageIdentity(candidate))?.sha256_hex === verified.sha256_hex) { isPublic = true; break; }
  }
  return { message_id: input.messageId, attachment: {
    storage_object_id: input.storageObjectId, link_id: source.link_id,
    sha256_hex: verified?.sha256_hex ?? null, available: !!verified,
    ...refs, public: isPublic, blossom_url: isPublic ? `${input.origin}/${verified!.sha256_hex}` : null,
  } };
}

export async function mutateMessageAttachmentBlossom(input: {
  workspaceId: string; messageId: string; storageObjectId: string; actorId: string;
  workspaceOwnerNpub: string; publish: boolean; expectedLinkId?: string; expectedSha256?: string;
}, sql: DbClient) {
  // Message edits/deletion lock this same row. Pin consent to the existing link lifetime.
  const [message] = await sql`SELECT id FROM flightdeck_pg_messages
    WHERE workspace_id=${input.workspaceId} AND id=${input.messageId} AND deleted_at IS NULL FOR UPDATE`;
  const source = message && await messageAttachmentSource(input, sql);
  if (!source) throw new BlossomPublicationError('attachment_not_found', 404, 'Message attachment is missing or removed');
  if (input.expectedLinkId && source.link_id !== input.expectedLinkId)
    throw new BlossomPublicationError('attachment_source_changed', 409, 'Attachment source changed; refresh publication status');
  if (!input.publish) {
    const changed = await sql`UPDATE flightdeck_pg_blossom_message_publications SET revoked_at=NOW()
      WHERE workspace_id=${input.workspaceId} AND link_id=${source.link_id} AND actor_id=${input.actorId} AND revoked_at IS NULL RETURNING link_id`;
    return changed.length > 0;
  }
  const [object] = await sql<V4StorageObject[]>`SELECT * FROM v4_storage_objects WHERE id=${input.storageObjectId} AND owner_npub=${input.workspaceOwnerNpub}`;
  if (!object) throw new BlossomPublicationError('storage_object_not_found', 404, 'Attachment is unavailable in this workspace');
  if (!object.completed_at) throw new BlossomPublicationError('storage_incomplete', 409, 'Attachment upload is not complete');
  const verified = await verifyStorageIdentity(object);
  if (!verified) throw new BlossomPublicationError('storage_unavailable', 409, 'Stored bytes are missing or could not be verified');
  const prior = await sql`SELECT sha256_hex FROM flightdeck_pg_blossom_message_publications
    WHERE workspace_id=${input.workspaceId} AND link_id=${source.link_id}`;
  if (verified.sha256_hex !== input.expectedSha256 || prior.some(p => p.sha256_hex !== verified.sha256_hex))
    throw new BlossomPublicationError('publication_hash_changed', 409, 'Attachment bytes changed; refresh or attach a new object');
  const changed = await sql`INSERT INTO flightdeck_pg_blossom_message_publications
    (workspace_id,message_id,link_id,actor_id,storage_object_id,sha256_hex)
    VALUES (${input.workspaceId},${input.messageId},${source.link_id},${input.actorId},${input.storageObjectId},${verified.sha256_hex!})
    ON CONFLICT (workspace_id,link_id,actor_id) DO UPDATE SET revoked_at=NULL,published_at=NOW()
      WHERE flightdeck_pg_blossom_message_publications.revoked_at IS NOT NULL RETURNING link_id`;
  return changed.length > 0;
}
