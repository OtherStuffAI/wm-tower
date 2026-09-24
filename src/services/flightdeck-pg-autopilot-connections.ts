import { getDb } from '../db';
import type { FlightDeckPgAutopilotConnection, FlightDeckPgWorkspaceAgent } from '../types';

type DbClient = ReturnType<typeof getDb>;

export function normalizeAutopilotInstallationId(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeAutopilotAgentId(value: string): string {
  return value.trim();
}

export function serializeAutopilotConnection(row: FlightDeckPgAutopilotConnection) {
  return { ...row, capabilities: row.capabilities ?? [], metadata: row.metadata ?? {} };
}

export function serializeWorkspaceAgent(row: FlightDeckPgWorkspaceAgent) {
  return { ...row, capabilities: row.capabilities ?? [], metadata: row.metadata ?? {} };
}

export async function listAutopilotConnections(workspaceId: string, includeArchived = false, sql: DbClient = getDb()) {
  return sql<FlightDeckPgAutopilotConnection[]>`
    SELECT * FROM flightdeck_pg_autopilot_connections
    WHERE workspace_id=${workspaceId}
      AND (${includeArchived} OR archived_at IS NULL)
    ORDER BY lower(installation_id), id
  `;
}

export async function resolveAutopilotConnection(workspaceId: string, id: string, sql: DbClient = getDb()) {
  const [row] = await sql<FlightDeckPgAutopilotConnection[]>`
    SELECT * FROM flightdeck_pg_autopilot_connections WHERE workspace_id=${workspaceId} AND id=${id} LIMIT 1
  `;
  return row ?? null;
}

export async function createAutopilotConnection(input: {
  workspaceId: string; installationId: string; displayName: string; fipsEndpoint: string;
  fipsTransportNpub: string | null;
  httpsEndpoint: string | null; apiVersion: string; capabilities: string[];
  metadata: Record<string, unknown>; actorId: string;
}, sql: DbClient = getDb()) {
  const installationId = normalizeAutopilotInstallationId(input.installationId);
  const [row] = await sql<FlightDeckPgAutopilotConnection[]>`
    INSERT INTO flightdeck_pg_autopilot_connections (
      workspace_id, installation_id, display_name, fips_endpoint, fips_transport_npub, https_endpoint,
      api_version, capabilities, metadata, created_by_actor_id, updated_by_actor_id
    ) VALUES (
      ${input.workspaceId}, ${installationId}, ${input.displayName}, ${input.fipsEndpoint}, ${input.fipsTransportNpub}, ${input.httpsEndpoint},
      ${input.apiVersion}, ${sql.json(input.capabilities)}, ${sql.json(input.metadata as any)}, ${input.actorId}, ${input.actorId}
    )
    ON CONFLICT (workspace_id, installation_id) WHERE archived_at IS NULL DO NOTHING
    RETURNING *
  `;
  if (row) return { row, created: true as const };
  const [existing] = await sql<FlightDeckPgAutopilotConnection[]>`
    SELECT * FROM flightdeck_pg_autopilot_connections
    WHERE workspace_id=${input.workspaceId} AND installation_id=${installationId} AND archived_at IS NULL LIMIT 1
  `;
  return { row: existing!, created: false as const };
}

export async function updateAutopilotConnection(input: {
  workspaceId: string; id: string; actorId: string; rowVersion?: number | null;
  patch: { displayName?: string; fipsEndpoint?: string; fipsTransportNpub?: string; httpsEndpoint?: string | null; apiVersion?: string; capabilities?: string[]; metadata?: Record<string, unknown> };
}, sql: DbClient = getDb()) {
  const p = input.patch;
  const [row] = await sql<FlightDeckPgAutopilotConnection[]>`
    UPDATE flightdeck_pg_autopilot_connections SET
      display_name=COALESCE(${p.displayName ?? null},display_name),
      fips_endpoint=COALESCE(${p.fipsEndpoint ?? null},fips_endpoint),
      fips_transport_npub=COALESCE(${p.fipsTransportNpub ?? null},fips_transport_npub),
      https_endpoint=CASE WHEN ${p.httpsEndpoint !== undefined} THEN ${p.httpsEndpoint ?? null} ELSE https_endpoint END,
      api_version=COALESCE(${p.apiVersion ?? null},api_version),
      capabilities=CASE WHEN ${p.capabilities !== undefined} THEN ${sql.json(p.capabilities ?? [])}::jsonb ELSE capabilities END,
      metadata=CASE WHEN ${p.metadata !== undefined} THEN ${sql.json((p.metadata ?? {}) as any)}::jsonb ELSE metadata END,
      updated_by_actor_id=${input.actorId}, row_version=row_version+1, updated_at=NOW()
    WHERE workspace_id=${input.workspaceId} AND id=${input.id} AND archived_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version=${input.rowVersion ?? null})
    RETURNING *
  `;
  return row ?? null;
}

export async function archiveAutopilotConnection(input: { workspaceId: string; id: string; actorId: string; rowVersion?: number | null }, sql: DbClient = getDb()) {
  const [row] = await sql<FlightDeckPgAutopilotConnection[]>`
    UPDATE flightdeck_pg_autopilot_connections SET archived_at=NOW(), archived_by_actor_id=${input.actorId},
      updated_by_actor_id=${input.actorId}, row_version=row_version+1, updated_at=NOW()
    WHERE workspace_id=${input.workspaceId} AND id=${input.id} AND archived_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version=${input.rowVersion ?? null})
    RETURNING *
  `;
  return row ?? null;
}

export async function listWorkspaceAgents(workspaceId: string, connectionId?: string | null, includeArchived = false, sql: DbClient = getDb()) {
  return sql<FlightDeckPgWorkspaceAgent[]>`
    SELECT * FROM flightdeck_pg_workspace_agents
    WHERE workspace_id=${workspaceId}
      AND (${connectionId ?? null}::uuid IS NULL OR connection_id=${connectionId ?? null})
      AND (${includeArchived} OR archived_at IS NULL)
    ORDER BY sort_order, lower(display_name), id
  `;
}

export async function resolveWorkspaceAgent(workspaceId: string, id: string, sql: DbClient = getDb()) {
  const [row] = await sql<FlightDeckPgWorkspaceAgent[]>`
    SELECT * FROM flightdeck_pg_workspace_agents WHERE workspace_id=${workspaceId} AND id=${id} LIMIT 1
  `;
  return row ?? null;
}

export async function createWorkspaceAgent(input: {
  workspaceId: string; connectionId: string; agentId: string; agentNpub: string; displayName: string;
  avatarUrl: string | null; capabilities: string[]; sortOrder: number; isVisible: boolean;
  metadata: Record<string, unknown>; actorId: string;
}, sql: DbClient = getDb()) {
  const [row] = await sql<FlightDeckPgWorkspaceAgent[]>`
    INSERT INTO flightdeck_pg_workspace_agents (
      workspace_id, connection_id, agent_id, agent_npub, display_name, avatar_url,
      capabilities, sort_order, is_visible, metadata, created_by_actor_id, updated_by_actor_id
    ) VALUES (
      ${input.workspaceId}, ${input.connectionId}, ${normalizeAutopilotAgentId(input.agentId)}, ${input.agentNpub},
      ${input.displayName}, ${input.avatarUrl}, ${sql.json(input.capabilities)}, ${input.sortOrder}, ${input.isVisible},
      ${sql.json(input.metadata as any)}, ${input.actorId}, ${input.actorId}
    ) RETURNING *
  `;
  return row;
}

export async function updateWorkspaceAgent(input: {
  workspaceId: string; id: string; actorId: string; rowVersion?: number | null;
  patch: { displayName?: string; avatarUrl?: string | null; capabilities?: string[]; sortOrder?: number; isVisible?: boolean; metadata?: Record<string, unknown> };
}, sql: DbClient = getDb()) {
  const p = input.patch;
  const [row] = await sql<FlightDeckPgWorkspaceAgent[]>`
    UPDATE flightdeck_pg_workspace_agents SET
      display_name=COALESCE(${p.displayName ?? null},display_name),
      avatar_url=CASE WHEN ${p.avatarUrl !== undefined} THEN ${p.avatarUrl ?? null} ELSE avatar_url END,
      capabilities=CASE WHEN ${p.capabilities !== undefined} THEN ${sql.json(p.capabilities ?? [])}::jsonb ELSE capabilities END,
      sort_order=CASE WHEN ${p.sortOrder !== undefined} THEN ${p.sortOrder ?? 0} ELSE sort_order END,
      is_visible=CASE WHEN ${p.isVisible !== undefined} THEN ${p.isVisible ?? true} ELSE is_visible END,
      metadata=CASE WHEN ${p.metadata !== undefined} THEN ${sql.json((p.metadata ?? {}) as any)}::jsonb ELSE metadata END,
      updated_by_actor_id=${input.actorId}, row_version=row_version+1, updated_at=NOW()
    WHERE workspace_id=${input.workspaceId} AND id=${input.id} AND archived_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version=${input.rowVersion ?? null})
    RETURNING *
  `;
  return row ?? null;
}

export async function archiveWorkspaceAgent(input: { workspaceId: string; id: string; actorId: string; rowVersion?: number | null }, sql: DbClient = getDb()) {
  const [row] = await sql<FlightDeckPgWorkspaceAgent[]>`
    UPDATE flightdeck_pg_workspace_agents SET archived_at=NOW(), archived_by_actor_id=${input.actorId},
      updated_by_actor_id=${input.actorId}, row_version=row_version+1, updated_at=NOW()
    WHERE workspace_id=${input.workspaceId} AND id=${input.id} AND archived_at IS NULL
      AND (${input.rowVersion ?? null}::integer IS NULL OR row_version=${input.rowVersion ?? null})
    RETURNING *
  `;
  return row ?? null;
}

export async function createAutopilotRecordOutboxEvent(input: {
  workspaceId: string; actorId: string; entityType: 'autopilot_connection' | 'workspace_agent'; entityId: string;
  operation: 'created' | 'updated' | 'archived'; rowVersion: number; payload: Record<string, unknown>;
}, sql: DbClient = getDb()) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events (
      workspace_id, actor_id, event_type, entity_type, entity_id, operation, entity_row_version, payload
    ) VALUES (
      ${input.workspaceId}, ${input.actorId}, ${`flightdeck_pg.${input.entityType}.${input.operation}`},
      ${input.entityType}, ${input.entityId}, ${input.operation}, ${input.rowVersion}, ${sql.json(input.payload as any)}
    ) RETURNING id,row_version
  `;
  return event;
}
