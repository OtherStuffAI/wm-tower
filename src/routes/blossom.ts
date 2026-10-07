import { hasBlossomPublication } from '../services/blossom-publications';
import { Hono } from 'hono';
import { nip19, verifyEvent } from 'nostr-tools';
import { getEffectiveRequestUrl, verifyNip98Auth } from '../auth';
import { resolveWsKeyNpub } from '../services/user-workspace-keys';
import { verifyStorageIdentity, openVerifiedStorageStream, hasActiveStorageReference, canAccessStorageObject, storageObjectsByHash } from '../services/storage';
import { resolveReadableFlightDeckPgBlossomObject } from '../services/flightdeck-pg-storage-access';

export const blossomRouter = new Hono();
blossomRouter.use('/:blob', async (c, next) => {
  await next();
  if (c.req.method === 'HEAD') c.res = new Response(null, { status: c.res.status, headers: c.res.headers });
});

export function verifyBlossomToken(request: Request, hash: string): string | null {
  try {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Nostr ')) return null;
    const event = JSON.parse(Buffer.from(header.slice(6), 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    if (!verifyEvent(event) || event.kind !== 24242 || event.created_at > now || !event.content.trim()) return null;
    const tags = (name: string) => event.tags.filter((t: string[]) => t[0] === name).map((t: string[]) => t[1]);
    const expiry = tags('expiration');
    if (expiry.length !== 1 || !/^\d+$/.test(expiry[0]) || Number(expiry[0]) <= now) return null;
    const action = tags('t');
    if (action.length !== 1 || action[0] !== 'get') return null;
    const servers = tags('server');
    if (servers.length && !servers.includes(getEffectiveRequestUrl(request).hostname.toLowerCase())) return null;
    const hashes = tags('x');
    if (hashes.length && !hashes.includes(hash)) return null;
    return nip19.npubEncode(event.pubkey);
  } catch { return null; }
}

// A single range is sufficient for media seeking; multipart ranges are rejected.
export function parseBlobRange(value: string | null, size: number) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  if (match.slice(1).some(n => n && !Number.isSafeInteger(Number(n)))) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end || (!match[1] && Number(match[2]) === 0)) return false;
  return { start, end };
}

blossomRouter.on(['GET', 'HEAD'], '/:blob', async (c, next) => {
  const name = c.req.param('blob');
  // Leave unrelated Tower paths alone.
  if (!/^[0-9a-fA-F]{64}(?:\.|$)/.test(name)) return next();
  const match = /^([0-9a-f]{64})(?:\.[a-zA-Z0-9]+)?$/.exec(name);
  if (!match) return c.json({ error: 'malformed blob path' }, 400);
  const hash = match[1];
  const candidates = await storageObjectsByHash(hash);
  let actor: string | null = null;
  if (c.req.header('authorization')) {
    const signer = verifyBlossomToken(c.req.raw, hash) ?? await verifyNip98Auth(c.req.raw);
    if (!signer) return c.json({ error: 'invalid authorization' }, 401);
    actor = await resolveWsKeyNpub(signer) ?? signer;
  }
  for (const row of candidates) {
    const accessible = actor
      ? await canAccessStorageObject(row.id, actor) ?? await resolveReadableFlightDeckPgBlossomObject({ actorNpub: actor, storageObjectId: row.id })
      : await canAccessStorageObject(row.id, null) ?? (await hasBlossomPublication(row.id, hash) ? row : null);
    if (!accessible || !await hasActiveStorageReference(row.id)) continue;
    const verified = await verifyStorageIdentity(row);
    if (!verified || verified.sha256_hex !== hash) continue;
    const size = Number(verified.size_bytes);
    const headers = new Headers({
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'ETag': `"${hash}"`,
      'Cache-Control': 'no-store',
      'Vary': 'Authorization',
      'X-Content-Type-Options': 'nosniff',
      // User supplied HTML/SVG must not run in Tower's authenticated origin.
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': `inline; filename="${(actor ? row.file_name || 'file.bin' : hash).replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    });
    const range = c.req.method === 'GET' && (!c.req.header('if-range') || c.req.header('if-range') === headers.get('etag'))
      ? parseBlobRange(c.req.header('range') || null, size) : null;
    if (range === false) {
      headers.set('Content-Range', `bytes */${size}`);
      headers.delete('Content-Length');
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      headers.set('Content-Length', String(range.end - range.start + 1));
      const stream = await openVerifiedStorageStream(verified, range);
      if (!stream) continue;
      return new Response(stream, { status: 206, headers });
    }
    if (c.req.method === 'HEAD') return new Response(null, { headers });
    const stream = await openVerifiedStorageStream(verified, null);
    if (!stream) continue;
    return new Response(stream, { headers });
  }
  // Anonymous negatives deliberately reveal neither existence nor private metadata.
  return c.json({ error: actor ? 'blob not found' : 'authorization required or blob unavailable' }, actor ? 404 : 401);
});
