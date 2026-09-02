import { getDb } from '../db';
import { config } from '../config';
import { resolveWsKeyNpub } from './user-workspace-keys';
import type { CompleteStorageInput, PrepareStorageInput, V4StorageObject } from '../types';

function createS3Client(endpoint: string) {
  return new Bun.S3Client({
    accessKeyId: config.storage.s3AccessKey,
    secretAccessKey: config.storage.s3SecretKey,
    bucket: config.storage.s3Bucket,
    region: config.storage.s3Region,
    endpoint,
    virtualHostedStyle: !config.storage.s3ForcePathStyle,
  });
}

const storageBucket = createS3Client(config.storage.s3Endpoint);
let inMemoryStorageForTest = false;
const inMemoryStorageBytes = new Map<string, Uint8Array>();

export function enableInMemoryStorageForTest() {
  inMemoryStorageForTest = true;
  inMemoryStorageBytes.clear();
}

export function resetInMemoryStorageForTest() {
  inMemoryStorageForTest = false;
  inMemoryStorageBytes.clear();
}

function sanitizeFilename(name: string | null | undefined) {
  const trimmed = String(name || '').trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return safe || 'file.bin';
}

function buildStorageKey(rowId: string, ownerNpub: string, ownerGroupId: string | null, fileName: string | null | undefined) {
  if (ownerGroupId) {
    return `v4/${ownerNpub}/${ownerGroupId}/${rowId}-${sanitizeFilename(fileName)}`;
  }
  return `v4/${ownerNpub}/${rowId}-${sanitizeFilename(fileName)}`;
}

/**
 * Verify that authNpub is authorized to upload to the given workspace/group.
 *
 * - If owner_group_id is set: authNpub must be a member of that group,
 *   and the group must belong to the workspace identified by owner_npub.
 * - If owner_group_id is null (workspace-owned): authNpub must be the workspace owner.
 */
async function verifyUploadAuthorization(
  ownerNpub: string,
  ownerGroupId: string | null,
  authNpub: string,
): Promise<{ authorized: boolean; reason?: string }> {
  const sql = getDb();

  // Resolve workspace
  const [workspace] = await sql<{ creator_npub: string; workspace_owner_npub: string }[]>`
    SELECT creator_npub, workspace_owner_npub
    FROM v4_workspaces
    WHERE workspace_owner_npub = ${ownerNpub}
    LIMIT 1
  `;

  if (!workspace) {
    return { authorized: false, reason: 'owner_npub does not match any workspace' };
  }

  if (!ownerGroupId) {
    // Workspace-owned: only workspace creator can upload
    if (authNpub !== workspace.creator_npub) {
      return { authorized: false, reason: 'only the workspace owner can upload workspace-owned objects' };
    }
    return { authorized: true };
  }

  // Group-owned: verify group belongs to this workspace and authNpub is a member
  const [group] = await sql<{ id: string; owner_npub: string }[]>`
    SELECT id, owner_npub
    FROM v4_groups
    WHERE id = ${ownerGroupId}
    LIMIT 1
  `;

  if (!group) {
    return { authorized: false, reason: 'owner_group_id does not match any group' };
  }

  if (group.owner_npub !== workspace.workspace_owner_npub) {
    return { authorized: false, reason: 'group does not belong to this workspace' };
  }

  const [membership] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM v4_group_members
    WHERE group_id = ${ownerGroupId}
      AND member_npub = ${authNpub}
    LIMIT 1
  `;

  if (!membership?.ok) {
    return { authorized: false, reason: 'authenticated npub is not a member of the specified group' };
  }

  return { authorized: true };
}

export async function prepareStorageObject(input: PrepareStorageInput, authNpub: string): Promise<V4StorageObject> {
  const sql = getDb();
  const fileName = String(input.file_name || '').trim() || null;
  const contentType = String(input.content_type || '').trim() || 'application/octet-stream';
  const sizeBytes = Number.isFinite(Number(input.size_bytes)) ? Number(input.size_bytes) : 0;
  const ownerGroupId = String(input.owner_group_id || '').trim() || null;
  const accessGroupIds = [...new Set((input.access_group_ids || []).map((value) => String(value || '').trim()).filter(Boolean))];
  const isPublic = input.is_public === true;

  // Verify upload authorization
  const auth = await verifyUploadAuthorization(input.owner_npub, ownerGroupId, authNpub);
  if (!auth.authorized) {
    throw new Error(auth.reason || 'upload not authorized');
  }

  const [row] = await sql<V4StorageObject[]>`
    INSERT INTO v4_storage_objects (owner_npub, owner_group_id, created_by_npub, access_group_ids, is_public, file_name, content_type, size_bytes, storage_path)
    VALUES (${input.owner_npub}, ${ownerGroupId}, ${authNpub}, ${accessGroupIds}, ${isPublic}, ${fileName}, ${contentType}, ${sizeBytes}, '')
    RETURNING *
  `;

  const storagePath = buildStorageKey(row.id, row.owner_npub, row.owner_group_id, fileName);

  const [updated] = await sql<V4StorageObject[]>`
    UPDATE v4_storage_objects
    SET storage_path = ${storagePath}
    WHERE id = ${row.id}
    RETURNING *
  `;

  return updated;
}

export async function prepareStorageObjectForAuthorizedOwner(input: PrepareStorageInput, authNpub: string): Promise<V4StorageObject> {
  const sql = getDb();
  const ownerNpub = String(input.owner_npub || '').trim();
  const fileName = String(input.file_name || '').trim() || null;
  const contentType = String(input.content_type || '').trim() || 'application/octet-stream';
  const sizeBytes = Number.isFinite(Number(input.size_bytes)) ? Number(input.size_bytes) : 0;
  const ownerGroupId = String(input.owner_group_id || '').trim() || null;
  const accessGroupIds = [...new Set((input.access_group_ids || []).map((value) => String(value || '').trim()).filter(Boolean))];
  const isPublic = input.is_public === true;

  if (!ownerNpub) throw new Error('owner_npub required');

  const [row] = await sql<V4StorageObject[]>`
    INSERT INTO v4_storage_objects (owner_npub, owner_group_id, created_by_npub, access_group_ids, is_public, file_name, content_type, size_bytes, storage_path)
    VALUES (${ownerNpub}, ${ownerGroupId}, ${authNpub}, ${accessGroupIds}, ${isPublic}, ${fileName}, ${contentType}, ${sizeBytes}, '')
    RETURNING *
  `;

  const storagePath = buildStorageKey(row.id, row.owner_npub, row.owner_group_id, fileName);

  const [updated] = await sql<V4StorageObject[]>`
    UPDATE v4_storage_objects
    SET storage_path = ${storagePath}
    WHERE id = ${row.id}
    RETURNING *
  `;

  return updated;
}

export async function getStorageUploadUrl(objectId: string): Promise<string | null> {
  const row = await getStorageObject(objectId);
  if (!row || row.completed_at) return null;

  const publicEndpoint = config.storage.s3PublicEndpoint;
  if (!publicEndpoint) return null;

  const publicBucket = createS3Client(publicEndpoint);
  return publicBucket.presign(row.storage_path, {
    method: 'PUT',
    type: row.content_type || 'application/octet-stream',
    expiresIn: Math.max(60, config.storage.presignUploadTtlSeconds),
  });
}

export async function getStorageObject(objectId: string): Promise<V4StorageObject | null> {
  const sql = getDb();
  const [row] = await sql<V4StorageObject[]>`
    SELECT *
    FROM v4_storage_objects
    WHERE id = ${objectId}
    LIMIT 1
  `;
  return row || null;
}

/**
 * Check if authNpub can access a storage object. Returns the object if accessible, null otherwise.
 * Also handles is_public — pass authNpub as null for unauthenticated public access.
 */
export async function canAccessStorageObject(objectId: string, authNpub: string | null): Promise<V4StorageObject | null> {
  const sql = getDb();
  const row = await getStorageObject(objectId);
  if (!row) return null;

  // Public objects are accessible by anyone
  if (row.is_public) return row;

  // All remaining checks require authentication
  if (!authNpub) return null;

  // Resolve created_by_npub in case the object was created with a ws_key
  const creatorRealNpub = await resolveWsKeyNpub(row.created_by_npub) ?? row.created_by_npub;

  // Owner or uploader can always read
  if (row.owner_npub === authNpub || creatorRealNpub === authNpub) return row;

  // Check if authNpub is the workspace creator (workspace owner can always read)
  const [workspace] = await sql<{ creator_npub: string }[]>`
    SELECT creator_npub
    FROM v4_workspaces
    WHERE workspace_owner_npub = ${row.owner_npub}
    LIMIT 1
  `;
  if (workspace?.creator_npub === authNpub) return row;

  // Check group-based read access via stable group UUIDs
  const accessGroups = Array.isArray(row.access_group_ids)
    ? row.access_group_ids.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (accessGroups.length === 0) return null;

  const [membership] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM v4_group_members gm
    WHERE gm.group_id = ANY(${accessGroups}::uuid[])
      AND gm.member_npub = ${authNpub}
    LIMIT 1
  `;

  return membership?.ok ? row : null;
}

export async function completeStorageObject(objectId: string, input: CompleteStorageInput, authNpub: string): Promise<V4StorageObject | null> {
  const sql = getDb();
  const existing = await getStorageObject(objectId);
  if (!existing) return null;

  // Resolve created_by_npub in case the object was created with a ws_key
  const creatorRealNpub = await resolveWsKeyNpub(existing.created_by_npub) ?? existing.created_by_npub;
  if (creatorRealNpub !== authNpub) return null;

  if (inMemoryStorageForTest) {
    if (!inMemoryStorageBytes.has(existing.storage_path)) return null;
  } else {
    try {
      await storageBucket.stat(existing.storage_path);
    } catch {
      return null;
    }
  }

  // Use the original created_by_npub for the WHERE clause (matches what's in the DB)
  const [row] = await sql<V4StorageObject[]>`
    UPDATE v4_storage_objects
    SET
      sha256_hex = COALESCE(${input.sha256_hex || null}, sha256_hex),
      size_bytes = COALESCE(${Number.isFinite(Number(input.size_bytes)) ? Number(input.size_bytes) : null}, size_bytes),
      completed_at = NOW()
    WHERE id = ${objectId}
      AND created_by_npub = ${existing.created_by_npub}
    RETURNING *
  `;
  return row || null;
}

export async function writeStorageObject(objectId: string, bytes: Uint8Array, authNpub: string): Promise<V4StorageObject | null> {
  const row = await getStorageObject(objectId);
  if (!row) return null;

  // Resolve created_by_npub in case the object was created with a ws_key
  const creatorRealNpub = await resolveWsKeyNpub(row.created_by_npub) ?? row.created_by_npub;
  if (creatorRealNpub !== authNpub) return null;

  if (inMemoryStorageForTest) {
    inMemoryStorageBytes.set(row.storage_path, new Uint8Array(bytes));
    return row;
  }

  await storageBucket.write(row.storage_path, bytes, { type: row.content_type || 'application/octet-stream' });
  return row;
}

export async function getStorageObjectContent(objectId: string): Promise<{ row: V4StorageObject; bytes: Uint8Array; size: number } | null> {
  const row = await getStorageObject(objectId);
  if (!row) return null;

  if (inMemoryStorageForTest) {
    const bytes = inMemoryStorageBytes.get(row.storage_path);
    if (!bytes) return null;
    return { row, bytes: new Uint8Array(bytes), size: bytes.byteLength };
  }

  try {
    const stat = await storageBucket.stat(row.storage_path);
    const file = storageBucket.file(row.storage_path);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { row, bytes, size: stat.size };
  } catch {
    return null;
  }
}

export async function getStorageDownloadUrl(objectId: string): Promise<string | null> {
  const row = await getStorageObject(objectId);
  if (!row || !row.completed_at) return null;

  const publicEndpoint = config.storage.s3PublicEndpoint;
  if (!publicEndpoint) return null;

  const publicBucket = createS3Client(publicEndpoint);
  return publicBucket.presign(row.storage_path, {
    expiresIn: Math.max(60, config.storage.presignDownloadTtlSeconds),
  });
}
