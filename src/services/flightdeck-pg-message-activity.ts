import { getDb } from '../db';
import type { FlightDeckPgMessageActivityRange, FlightDeckPgMessageActivityResponse } from '../types';

type DbClient = ReturnType<typeof getDb>;

export function parseMessageActivityRange(value: string | undefined): FlightDeckPgMessageActivityRange | null {
  return value === '7d' || value === '30d' || value === 'all' ? value : null;
}

/** Caller must resolve membership/groups in the same repeatable-read snapshot. */
export async function readFlightDeckPgMessageActivity(
  input: { workspaceId: string; actorId: string; groupIds: string[]; range: FlightDeckPgMessageActivityRange },
  sql: DbClient,
): Promise<Omit<FlightDeckPgMessageActivityResponse, 'identity'>> {
  // Millisecond precision matches JSON instants exactly, including interval edges.
  const [window] = await sql<{ as_of: Date; from: Date | null }[]>`
    SELECT date_trunc('milliseconds', transaction_timestamp()) AS as_of,
      CASE WHEN ${input.range} = 'all' THEN NULL
        ELSE date_trunc('milliseconds', transaction_timestamp()) -
          CASE WHEN ${input.range} = '7d' THEN interval '168 hours' ELSE interval '720 hours' END
      END AS "from"
  `;
  const groups = input.groupIds.length ? input.groupIds : ['00000000-0000-0000-0000-000000000000'];
  const rows = await sql<{ channel_id: string; scope_id: string; count: string }[]>`
    WITH readable_channels AS MATERIALIZED (
      SELECT c.id, c.scope_id
      FROM flightdeck_pg_channels c
      JOIN flightdeck_pg_scopes s ON s.workspace_id = c.workspace_id AND s.id = c.scope_id
      WHERE c.workspace_id = ${input.workspaceId}
        AND c.archived_at IS NULL AND s.archived_at IS NULL
        AND EXISTS (
          SELECT 1 FROM flightdeck_pg_permission_grants pg
          WHERE pg.workspace_id = c.workspace_id AND pg.resource_type = 'channel'
            AND pg.resource_channel_id = c.id AND pg.permission = 'channel.read'
            AND pg.revoked_at IS NULL
            AND ((pg.principal_type = 'actor' AND pg.principal_actor_id = ${input.actorId})
              OR (pg.principal_type = 'group' AND pg.principal_group_id IN ${sql(groups)}))
        )
    )
    SELECT c.id AS channel_id, c.scope_id, counts.count
    FROM readable_channels c
    CROSS JOIN LATERAL (
      SELECT count(*)::text AS count
      FROM flightdeck_pg_messages m
      WHERE m.workspace_id = ${input.workspaceId} AND m.channel_id = c.id
        AND m.deleted_at IS NULL
        AND (${window.from}::timestamptz IS NULL OR m.created_at >= ${window.from})
        AND m.created_at < ${window.as_of}
    ) counts
    ORDER BY c.scope_id, c.id
  `;
  const asOf = window.as_of.toISOString();
  return {
    workspace_id: input.workspaceId, range: input.range,
    from: window.from?.toISOString() ?? null, to: asOf, as_of: asOf, complete: true,
    channels: rows.map(row => {
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Message activity count exceeds safe integer range');
      return { channel_id: row.channel_id, scope_id: row.scope_id, count };
    }),
  };
}
