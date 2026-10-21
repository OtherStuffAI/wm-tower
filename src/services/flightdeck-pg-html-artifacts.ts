import { createHash } from 'node:crypto';
import { getDb } from '../db';
import type { V4StorageObject } from '../types';
import { authorizeFlightDeckPgOperation } from './flightdeck-pg-authorization';
import { resolveFlightDeckPgFile, resolveFlightDeckPgFileVersion } from './flightdeck-pg-api';
import { getStorageObjectContent } from './storage';

type DbClient = ReturnType<typeof getDb>;

// HTML artifacts are ordinary Flight Deck Files. A canvas naplet names the File
// and either follows its current version or pins one immutable version. Images
// are sibling Files referenced by an exact version/digest manifest embedded in
// the HTML; each reference is re-authorized for the viewer on every read.
export const HTML_ARTIFACT_MAX_HTML_BYTES = 2 * 1024 * 1024;
export const HTML_ARTIFACT_MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const HTML_ARTIFACT_MAX_TOTAL_ASSET_BYTES = 32 * 1024 * 1024;
export const HTML_ARTIFACT_MAX_ASSETS = 64;
export const HTML_ARTIFACT_MANIFEST_ID = 'wingman-artifact-assets';
export const HTML_ARTIFACT_ASSET_CONTENT_TYPES = Object.freeze([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
]);

const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type HtmlArtifactManifestEntry = {
  name: string;
  file_id: string;
  version_id: string;
  sha256: string;
};

export type HtmlArtifactAsset =
  | { name: string; status: 'ready'; file_id: string; version_id: string; sha256: string; size_bytes: number; content_type: string }
  | { name: string; status: 'unavailable' };

export type HtmlArtifactContent = {
  html: string;
  version: string;
  digest: string;
  file_id: string;
  version_id: string;
  version_number: number;
  current_version_id: string | null;
  current_version_number: number | null;
  follows_latest: boolean;
  assets: HtmlArtifactAsset[];
  manifest_error: string | null;
};

export type ResolvedHtmlArtifact = {
  title: string;
  fileId: string;
  pinnedVersionId: string | null;
  content: HtmlArtifactContent;
};

export function htmlArtifactDigestMatches(bytes: Uint8Array, digest: string | null | undefined) {
  return Boolean(digest && /^[0-9a-f]{64}$/i.test(digest)
    && createHash('sha256').update(bytes).digest('hex') === digest.toLowerCase());
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Parse the optional `<script type="application/json" id="wingman-artifact-assets">`
 * manifest. Malformed manifests never block the HTML itself; they produce no
 * assets and a non-sensitive error string the author can act on.
 */
export function parseHtmlArtifactManifest(html: string): { entries: HtmlArtifactManifestEntry[]; error: string | null } {
  const pattern = new RegExp(`<script\\b[^>]*\\bid\\s*=\\s*["']${HTML_ARTIFACT_MANIFEST_ID}["'][^>]*>([\\s\\S]*?)<\\/script\\s*>`, 'gi');
  const matches = [...html.matchAll(pattern)];
  if (!matches.length) return { entries: [], error: null };
  if (matches.length > 1) return { entries: [], error: 'multiple asset manifests' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0]![1]!);
  } catch {
    return { entries: [], error: 'asset manifest is not valid JSON' };
  }
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  if (!object || object.version !== 1 || !Array.isArray(object.assets)) return { entries: [], error: 'asset manifest must be {"version":1,"assets":[...]}' };
  if (object.assets.length > HTML_ARTIFACT_MAX_ASSETS) return { entries: [], error: `asset manifest exceeds ${HTML_ARTIFACT_MAX_ASSETS} entries` };
  const entries: HtmlArtifactManifestEntry[] = [];
  const names = new Set<string>();
  for (const value of object.assets) {
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const entry = {
      name: String(row.name ?? ''),
      file_id: String(row.file_id ?? '').toLowerCase(),
      version_id: String(row.version_id ?? '').toLowerCase(),
      sha256: String(row.sha256 ?? '').toLowerCase(),
    };
    if (!ASSET_NAME.test(entry.name) || names.has(entry.name) || !UUID.test(entry.file_id)
      || !UUID.test(entry.version_id) || !SHA256.test(entry.sha256)) {
      return { entries: [], error: 'asset manifest contains an invalid or duplicate entry' };
    }
    names.add(entry.name);
    entries.push(entry);
  }
  return { entries, error: null };
}

async function workspaceOwnerNpub(workspaceId: string, sql: DbClient) {
  const [row] = await sql<{ workspace_owner_npub: string }[]>`
    SELECT workspace_owner_npub FROM flightdeck_pg_workspaces WHERE id = ${workspaceId} LIMIT 1
  `;
  return row?.workspace_owner_npub ?? null;
}

async function storageRow(objectId: string, sql: DbClient) {
  const [row] = await sql<V4StorageObject[]>`SELECT * FROM v4_storage_objects WHERE id = ${objectId} LIMIT 1`;
  return row ?? null;
}

/** Version must belong to the File in this workspace and its object to the workspace owner partition. */
export async function resolveFlightDeckPgFileVersionObject(
  input: { workspaceId: string; fileId: string; versionId: string },
  sql: DbClient = getDb(),
) {
  if (!UUID.test(input.fileId) || !UUID.test(input.versionId)) return null;
  const version = await resolveFlightDeckPgFileVersion({ workspaceId: input.workspaceId, versionId: input.versionId }, sql);
  if (!version || version.file_id !== input.fileId || version.operation === 'deleted') return null;
  const object = await storageRow(version.storage_object_id, sql);
  if (!object || !object.completed_at) return null;
  const owner = await workspaceOwnerNpub(input.workspaceId, sql);
  if (!owner || object.owner_npub !== owner) return null;
  return { version, object };
}

async function canReadFileChannel(
  input: { workspaceId: string; appNpub: string; actorNpub: string; channelId: string },
  sql: DbClient,
) {
  const access = await authorizeFlightDeckPgOperation({
    actorNpub: input.actorNpub, appNpub: input.appNpub, workspaceId: input.workspaceId,
    permission: 'file.read', resource: { type: 'channel', channelId: input.channelId },
  }, sql);
  return access.allowed;
}

async function resolveManifestAssets(
  input: { workspaceId: string; appNpub: string; actorNpub: string; entries: HtmlArtifactManifestEntry[] },
  sql: DbClient,
): Promise<HtmlArtifactAsset[]> {
  const channelAccess = new Map<string, boolean>();
  let total = 0;
  const assets: HtmlArtifactAsset[] = [];
  for (const entry of input.entries) {
    const unavailable = { name: entry.name, status: 'unavailable' as const };
    const file = await resolveFlightDeckPgFile(input.workspaceId, entry.file_id, sql);
    if (!file || file.archived_at) { assets.push(unavailable); continue; }
    if (!channelAccess.has(file.channel_id)) {
      channelAccess.set(file.channel_id, await canReadFileChannel({ ...input, channelId: file.channel_id }, sql));
    }
    if (!channelAccess.get(file.channel_id)) { assets.push(unavailable); continue; }
    const resolved = await resolveFlightDeckPgFileVersionObject({ workspaceId: input.workspaceId, fileId: file.id, versionId: entry.version_id }, sql);
    const object = resolved?.object;
    const contentType = String(object?.content_type || '').toLowerCase();
    const size = Number(object?.size_bytes);
    if (!object || String(object.sha256_hex || '').toLowerCase() !== entry.sha256
      || !HTML_ARTIFACT_ASSET_CONTENT_TYPES.includes(contentType)
      || !Number.isSafeInteger(size) || size < 1 || size > HTML_ARTIFACT_MAX_ASSET_BYTES
      || total + size > HTML_ARTIFACT_MAX_TOTAL_ASSET_BYTES) {
      assets.push(unavailable);
      continue;
    }
    total += size;
    assets.push({ name: entry.name, status: 'ready', file_id: file.id, version_id: entry.version_id, sha256: entry.sha256, size_bytes: size, content_type: contentType });
  }
  return assets;
}

/**
 * Resolve an HTML artifact for one viewer. `sourceId` is a File id (current
 * contract) or, for naplets created before follow-latest, an immutable File
 * version id, which is treated as a pin. `requestedVersionId` lets a viewer
 * browse another version of the same File without changing the naplet.
 * Authorization happens before any version metadata or bytes are read.
 */
export async function resolveFlightDeckPgHtmlArtifact(
  input: {
    workspaceId: string;
    appNpub: string;
    actorNpub: string;
    sourceId: string;
    sourceVersionId?: string | null;
    requestedVersionId?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<ResolvedHtmlArtifact | null> {
  if (!UUID.test(input.sourceId)) return null;
  let file = await resolveFlightDeckPgFile(input.workspaceId, input.sourceId, sql);
  let pinnedVersionId = input.sourceVersionId ?? null;
  if (!file) {
    const legacy = await resolveFlightDeckPgFileVersion({ workspaceId: input.workspaceId, versionId: input.sourceId }, sql);
    if (!legacy) return null;
    file = await resolveFlightDeckPgFile(input.workspaceId, legacy.file_id, sql);
    pinnedVersionId = legacy.id;
  }
  if (!file || file.archived_at) return null;
  if (!await canReadFileChannel({ ...input, channelId: file.channel_id }, sql)) return null;

  const targetVersionId = input.requestedVersionId || pinnedVersionId || file.current_version_id;
  if (!targetVersionId) return null;
  const target = await resolveFlightDeckPgFileVersionObject({ workspaceId: input.workspaceId, fileId: file.id, versionId: targetVersionId }, sql);
  if (!target) return null;
  if (!HTML_CONTENT_TYPES.includes(String(target.object.content_type || '').toLowerCase())) return null;
  if (Number(target.object.size_bytes) > HTML_ARTIFACT_MAX_HTML_BYTES) return null;
  const stored = await getStorageObjectContent(target.object.id);
  if (!stored || stored.size > HTML_ARTIFACT_MAX_HTML_BYTES) return null;
  const digest = String(target.object.sha256_hex || '').toLowerCase();
  if (!htmlArtifactDigestMatches(stored.bytes, digest)) return null;
  let html: string;
  try {
    html = decodeUtf8(stored.bytes);
  } catch {
    return null;
  }

  const current = file.current_version_id
    ? await resolveFlightDeckPgFileVersion({ workspaceId: input.workspaceId, versionId: file.current_version_id }, sql)
    : null;
  const manifest = parseHtmlArtifactManifest(html);
  const assets = await resolveManifestAssets({ ...input, entries: manifest.entries }, sql);
  return {
    title: file.display_name || 'HTML',
    fileId: file.id,
    pinnedVersionId,
    content: {
      html,
      version: String(target.version.version_number),
      digest,
      file_id: file.id,
      version_id: target.version.id,
      version_number: Number(target.version.version_number),
      current_version_id: current?.file_id === file.id ? current.id : null,
      current_version_number: current?.file_id === file.id ? Number(current.version_number) : null,
      follows_latest: !pinnedVersionId,
      assets,
      manifest_error: manifest.error,
    },
  };
}
