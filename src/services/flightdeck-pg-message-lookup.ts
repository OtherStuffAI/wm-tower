import { getDb } from '../db';
import type { FlightDeckPgMessage } from '../types';
import { resolveFlightDeckPgThread, type FlightDeckPgThreadRow } from './flightdeck-pg-api';

type LookupMessage = FlightDeckPgMessage & {
  thread_source_message_id: string | null;
  created_by_actor_npub: string | null;
  created_by_actor_label: string | null;
};

/** Resolve only the named message and its current owning thread. Authorization
 * belongs to the route; callers must not expose this result before channel.read.
 * A bare ID cannot select an inherited branch or a legacy client merge alias.
 */
export async function resolveFlightDeckPgMessageLookup(
  workspaceId: string,
  messageId: string,
  sql: ReturnType<typeof getDb> = getDb(),
): Promise<{ message: LookupMessage; thread: FlightDeckPgThreadRow | null } | null> {
  const [message] = await sql<LookupMessage[]>`
    SELECT m.*, t.source_message_id AS thread_source_message_id,
      creator.npub AS created_by_actor_npub, creator.display_name AS created_by_actor_label
    FROM flightdeck_pg_messages m
    LEFT JOIN flightdeck_pg_threads t ON t.workspace_id=m.workspace_id AND t.id=m.thread_id
      AND t.channel_id=m.channel_id AND t.scope_id=m.scope_id AND t.deleted_at IS NULL
    LEFT JOIN flightdeck_pg_actors creator ON creator.id=m.created_by_actor_id
    WHERE m.workspace_id=${workspaceId} AND m.id=${messageId} AND m.deleted_at IS NULL
      AND (m.thread_id IS NULL OR t.id IS NOT NULL)
    LIMIT 1
  `;
  if (!message) return null;
  const thread = message.thread_id ? await resolveFlightDeckPgThread(workspaceId, message.thread_id, sql) : null;
  if (message.thread_id && !thread) return null;
  return { message, thread };
}
