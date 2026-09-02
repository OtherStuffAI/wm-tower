import { Hono } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { getInsufficientCreditsBlock } from '../services/billing';
import {
  canAccessStorageObject,
  completeStorageObject,
  getStorageDownloadUrl,
  getStorageObject,
  getStorageObjectContent,
  getStorageUploadUrl,
  prepareStorageObject,
  writeStorageObject,
} from '../services/storage';
import type { CompleteStorageInput, PrepareStorageInput } from '../types';
import { resolveReadableFlightDeckPgMessageAttachment } from '../services/flightdeck-pg-storage-access';

export const storageRouter = new Hono();

async function resolveReadablePrivateStorageObject(objectId: string, actorNpub: string) {
  return await canAccessStorageObject(objectId, actorNpub)
    ?? await resolveReadableFlightDeckPgMessageAttachment({ actorNpub, storageObjectId: objectId });
}

storageRouter.post('/prepare', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const authNpub = auth.userNpub;

  const body = await c.req.json<PrepareStorageInput>();
  if (!body?.owner_npub) return c.json({ error: 'owner_npub required' }, 400);
  if (!body?.content_type) return c.json({ error: 'content_type required' }, 400);

  const billingBlock = await getInsufficientCreditsBlock(body.owner_npub);
  if (billingBlock) return c.json(billingBlock, 402);

  try {
    const row = await prepareStorageObject(body, authNpub);
    const origin = new URL(c.req.url).origin;
    const uploadUrl = await getStorageUploadUrl(row.id);
    const downloadUrl = await getStorageDownloadUrl(row.id);
    return c.json({
      object_id: row.id,
      owner_npub: row.owner_npub,
      owner_group_id: row.owner_group_id,
      access_group_ids: row.access_group_ids,
      is_public: row.is_public,
      file_name: row.file_name,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      upload_url: uploadUrl || `${origin}/api/v4/storage/${row.id}`,
      complete_url: `${origin}/api/v4/storage/${row.id}/complete`,
      content_url: `${origin}/api/v4/storage/${row.id}/content`,
      download_url: downloadUrl || `${origin}/api/v4/storage/${row.id}/content`,
      completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to prepare storage object';
    const status = message.includes('not authorized') || message.includes('not a member') || message.includes('only the workspace owner') || message.includes('does not match')
      ? 403
      : 500;
    return c.json({ error: message }, status);
  }
});

storageRouter.get('/:objectId', async (c) => {
  const objectId = c.req.param('objectId');
  if (!objectId) return c.json({ error: 'objectId required' }, 400);

  // Check if public first
  const obj = await getStorageObject(objectId);
  if (obj?.is_public) {
    const origin = new URL(c.req.url).origin;
    const downloadUrl = obj.completed_at ? await getStorageDownloadUrl(obj.id) : null;
    return c.json({
      object_id: obj.id,
      owner_npub: obj.owner_npub,
      owner_group_id: obj.owner_group_id,
      created_by_npub: obj.created_by_npub,
      access_group_ids: obj.access_group_ids,
      is_public: obj.is_public,
      file_name: obj.file_name,
      content_type: obj.content_type,
      size_bytes: obj.size_bytes,
      sha256_hex: obj.sha256_hex,
      content_url: `${origin}/api/v4/storage/${obj.id}/content`,
      download_url: downloadUrl,
      created_at: obj.created_at instanceof Date ? obj.created_at.toISOString() : obj.created_at,
      completed_at: obj.completed_at instanceof Date ? obj.completed_at.toISOString() : obj.completed_at,
    });
  }

  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const authNpub = auth.userNpub;

  const row = await resolveReadablePrivateStorageObject(objectId, authNpub);
  if (!row) return c.json({ error: 'storage object not found or not readable by this npub' }, 404);

  const origin = new URL(c.req.url).origin;
  const downloadUrl = row.completed_at ? await getStorageDownloadUrl(row.id) : null;
  return c.json({
    object_id: row.id,
    owner_npub: row.owner_npub,
    owner_group_id: row.owner_group_id,
    created_by_npub: row.created_by_npub,
    access_group_ids: row.access_group_ids,
    is_public: row.is_public,
    file_name: row.file_name,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    sha256_hex: row.sha256_hex,
    content_url: `${origin}/api/v4/storage/${row.id}/content`,
    download_url: downloadUrl,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
  });
});

storageRouter.put('/:objectId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const authNpub = auth.userNpub;

  const objectId = c.req.param('objectId');
  if (!objectId) return c.json({ error: 'objectId required' }, 400);

  const body = await c.req.json<{ base64_data?: string }>().catch(() => ({}));
  const base64Data = String(body?.base64_data || '').trim();
  if (!base64Data) return c.json({ error: 'base64_data required' }, 400);

  const buffer = new Uint8Array(Buffer.from(base64Data, 'base64'));
  const row = await writeStorageObject(objectId, buffer, authNpub);
  if (!row) return c.json({ error: 'storage object not found or not writable by this npub' }, 404);

  return c.json({
    object_id: row.id,
    size_bytes: buffer.byteLength,
    content_type: row.content_type,
  });
});

storageRouter.post('/:objectId/complete', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const authNpub = auth.userNpub;

  const objectId = c.req.param('objectId');
  if (!objectId) return c.json({ error: 'objectId required' }, 400);

  const body = await c.req.json<CompleteStorageInput>().catch(() => ({} as CompleteStorageInput));
  const row = await completeStorageObject(objectId, body, authNpub);
  if (!row) return c.json({ error: 'storage object not found or not writable by this npub' }, 404);

  return c.json({
    object_id: row.id,
    owner_npub: row.owner_npub,
    owner_group_id: row.owner_group_id,
    access_group_ids: row.access_group_ids,
    is_public: row.is_public,
    file_name: row.file_name,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    content_url: `${new URL(c.req.url).origin}/api/v4/storage/${row.id}/content`,
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
  });
});

storageRouter.get('/:objectId/download-url', async (c) => {
  const objectId = c.req.param('objectId');
  if (!objectId) return c.json({ error: 'objectId required' }, 400);

  // Check if public first
  const obj = await getStorageObject(objectId);
  if (obj?.is_public) {
    const origin = new URL(c.req.url).origin;
    return c.json({
      object_id: obj.id,
      content_url: `${origin}/api/v4/storage/${obj.id}/content`,
      download_url: (await getStorageDownloadUrl(obj.id)) || `${origin}/api/v4/storage/${obj.id}/content`,
    });
  }

  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const authNpub = auth.userNpub;

  const row = await resolveReadablePrivateStorageObject(objectId, authNpub);
  if (!row) return c.json({ error: 'storage object not found or not readable by this npub' }, 404);

  const origin = new URL(c.req.url).origin;
  return c.json({
    object_id: row.id,
    content_url: `${origin}/api/v4/storage/${row.id}/content`,
    download_url: (await getStorageDownloadUrl(row.id)) || `${origin}/api/v4/storage/${row.id}/content`,
  });
});

storageRouter.get('/:objectId/content', async (c) => {
  const objectId = c.req.param('objectId');
  if (!objectId) return c.json({ error: 'objectId required' }, 400);

  // Check if public first
  const obj = await getStorageObject(objectId);
  if (obj?.is_public) {
    if (!obj.completed_at) return c.json({ error: 'storage object upload not completed' }, 409);
    const content = await getStorageObjectContent(objectId);
    if (!content) return c.json({ error: 'storage object content missing' }, 404);
    const { bytes, size } = content;
    return new Response(bytes, {
      headers: {
        'Content-Type': obj.content_type || 'application/octet-stream',
        'Content-Length': String(obj.size_bytes || size || 0),
        'Content-Disposition': `inline; filename=\"${obj.file_name || `${obj.id}.bin`}\"`,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const authNpub = auth.userNpub;

  const row = await resolveReadablePrivateStorageObject(objectId, authNpub);
  if (!row) return c.json({ error: 'storage object not found or not readable by this npub' }, 404);
  if (!row.completed_at) return c.json({ error: 'storage object upload not completed' }, 409);

  const content = await getStorageObjectContent(objectId);
  if (!content) return c.json({ error: 'storage object content missing' }, 404);
  const { bytes, size } = content;

  return new Response(bytes, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Length': String(row.size_bytes || size || 0),
      'Content-Disposition': `inline; filename=\"${row.file_name || `${row.id}.bin`}\"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
});
