import { getDb } from '../db';
import { authorizeFlightDeckPgOperation } from './flightdeck-pg-authorization';
import { resolveFlightDeckPgFile } from './flightdeck-pg-api';
import { resolveFlightDeckPgFileVersionObject } from './flightdeck-pg-html-artifacts';
import { authorizeFlightDeckPgStorageAttach } from './flightdeck-pg-storage-access';

type DbClient = ReturnType<typeof getDb>;

// Excalidraw boards are ordinary Flight Deck Files whose versions hold a scene
// document. A canvas naplet names the File and always follows its current
// version; history is browsed viewer-locally through the File version routes.
// The naplet projection is metadata only: scene bytes are read through the
// exact File version object route, which re-authorizes and re-hashes them.
export const EXCALIDRAW_BOARD_CONTENT_TYPE = 'application/vnd.excalidraw+json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export type ExcalidrawBoardContent = {
  file_id: string;
  current_version_id: string;
  current_version_number: number;
  content_type: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
  updated_by_actor_npub: string | null;
  can_write: boolean;
};

export type ResolvedExcalidrawBoard = { title: string; fileId: string; content: ExcalidrawBoardContent };

/** Media type without parameters, lower-cased. */
export function excalidrawBoardMediaType(contentType: string | null | undefined) {
  return String(contentType || '').split(';')[0]!.trim().toLowerCase();
}

async function actorNpub(actorId: string, sql: DbClient) {
  const [row] = await sql<{ npub: string }[]>`SELECT npub FROM flightdeck_pg_actors WHERE id = ${actorId} LIMIT 1`;
  return row?.npub ?? null;
}

/**
 * Resolve a board File for one viewer. Channel file.read is checked before any
 * version metadata is read; missing, archived, unreadable, foreign-partition,
 * digestless or non-Excalidraw current versions all resolve to null so callers
 * can return the non-disclosing denied projection.
 */
export async function resolveFlightDeckPgExcalidrawBoard(
  input: { workspaceId: string; appNpub: string; actorNpub: string; sourceId: string },
  sql: DbClient = getDb(),
): Promise<ResolvedExcalidrawBoard | null> {
  if (!UUID.test(input.sourceId)) return null;
  const file = await resolveFlightDeckPgFile(input.workspaceId, input.sourceId, sql);
  if (!file || file.archived_at) return null;
  const read = await authorizeFlightDeckPgOperation({
    actorNpub: input.actorNpub, appNpub: input.appNpub, workspaceId: input.workspaceId,
    permission: 'file.read', resource: { type: 'channel', channelId: file.channel_id },
  }, sql);
  if (!read.allowed) return null;

  if (!file.current_version_id) return null;
  const current = await resolveFlightDeckPgFileVersionObject({ workspaceId: input.workspaceId, fileId: file.id, versionId: file.current_version_id }, sql);
  if (!current) return null;
  if (excalidrawBoardMediaType(current.object.content_type) !== EXCALIDRAW_BOARD_CONTENT_TYPE) return null;
  const sha256 = String(current.object.sha256_hex || '').toLowerCase();
  const size = Number(current.object.size_bytes);
  if (!SHA256.test(sha256) || !Number.isSafeInteger(size) || size < 0) return null;

  // UX hint only; the version POST re-checks the same storage attach rule.
  const write = await authorizeFlightDeckPgStorageAttach({
    actorNpub: input.actorNpub, appNpub: input.appNpub, workspaceId: input.workspaceId,
    entityType: 'file', channelId: file.channel_id,
  }, sql);
  return {
    title: file.display_name || 'Excalidraw board',
    fileId: file.id,
    content: {
      file_id: file.id,
      current_version_id: current.version.id,
      current_version_number: Number(current.version.version_number),
      content_type: EXCALIDRAW_BOARD_CONTENT_TYPE,
      size_bytes: size,
      sha256,
      updated_at: new Date(current.version.created_at).toISOString(),
      updated_by_actor_npub: await actorNpub(current.version.created_by_actor_id, sql),
      can_write: write.allowed,
    },
  };
}
