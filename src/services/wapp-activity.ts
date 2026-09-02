import { createHash } from 'crypto';
import { config } from '../config';
import { getDb } from '../db';

type DbClient = ReturnType<typeof getDb>;
type JsonRecord = Record<string, unknown>;

export type WappPublishingStatus = 'active' | 'disabled' | 'revoked';
export type WappActivityState = 'active' | 'resolved' | 'withdrawn';
export type WappActivityPriority = 'low' | 'normal' | 'high' | 'urgent';
export type WappActivityMuteTarget = 'installation' | 'category';

export class WappActivityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 429 = 400,
    readonly details: JsonRecord = {},
  ) {
    super(message);
  }
}

export interface WappPublishingDestinationInput {
  scope_id: string;
  channel_id: string;
}

export interface WappPublishingGrantInput {
  app_id: string;
  publisher_npub: string;
  owner_npub: string;
  display_name: string;
  capabilities: string[];
  destinations: WappPublishingDestinationInput[];
  registered_open_origins: string[];
}

export interface NormalizedWappActivityPayload {
  external_id: string;
  version: number;
  scope_id: string;
  channel_id: string;
  category: string;
  title: string;
  summary: string;
  occurred_at: string;
  priority: WappActivityPriority;
  state: WappActivityState;
  open_url: string | null;
}

interface InstallationRow {
  id: string;
  wapp_installation_id: string;
  app_id: string;
  publisher_npub: string;
  previous_publisher_npubs: string[];
  owner_npub: string;
  display_name: string;
  key_version: number;
  created_at: Date;
  updated_at: Date;
}

interface GrantRow {
  id: string;
  workspace_id: string;
  installation_id: string;
  status: WappPublishingStatus;
  capabilities: string[];
  registered_open_origins: string[];
  disable_open_links: boolean;
  grant_version: number;
  approved_by_actor_id: string | null;
  approved_by_npub: string;
  last_published_at: Date | null;
  last_rejected_at: Date | null;
  last_rejection_code: string | null;
  disabled_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface DestinationRow {
  grant_id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  scope_name: string;
  channel_name: string;
  current_scope_id: string;
  scope_archived_at: Date | null;
  channel_archived_at: Date | null;
}

interface ActivityItemRow {
  id: string;
  installation_id: string;
  grant_id: string;
  workspace_id: string;
  scope_id: string;
  channel_id: string;
  external_id: string;
  version: number;
  payload_hash: string;
  category: string;
  title: string;
  summary: string;
  occurred_at: Date;
  priority: WappActivityPriority;
  state: WappActivityState;
  open_url: string | null;
  publisher_npub: string;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  withdrawn_at: Date | null;
  wapp_installation_id?: string;
  app_id?: string;
  display_name?: string;
  read_version?: number | null;
  read_at?: Date | null;
  dismissed_at?: Date | null;
  muted?: boolean;
  source_status?: WappPublishingStatus;
  registered_open_origins?: string[];
  disable_open_links?: boolean;
}

export interface PublisherGrantContext {
  installation: InstallationRow;
  grant: GrantRow;
  destinations: DestinationRow[];
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function requireBoundedText(value: unknown, field: string, max: number, allowEmpty = false): string {
  const normalized = text(value);
  if ((!allowEmpty && !normalized) || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new WappActivityError('validation_failed', `${field} is invalid`, 400, { field, max_length: max });
  }
  return normalized;
}

function requireNpub(value: unknown, field: string): string {
  const normalized = text(value);
  if (!/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(normalized)) {
    throw new WappActivityError('validation_failed', `${field} must be an npub`, 400, { field });
  }
  return normalized;
}

export function normalizeRegisteredOpenOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WappActivityError('validation_failed', 'registered_open_origins must be an array');
  const origins = value.map((entry, index) => {
    try {
      const raw = requireBoundedText(entry, `registered_open_origins.${index}`, 2048);
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('not an HTTPS origin');
      return parsed.origin;
    } catch (error) {
      if (error instanceof WappActivityError) throw error;
      throw new WappActivityError('unsafe_open_url', 'Registered open origins must be exact HTTPS origins', 400, { index });
    }
  });
  return [...new Set(origins)].sort();
}

function normalizeOpenUrl(value: unknown, registeredOrigins: string[]): string | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    const parsed = new URL(requireBoundedText(value, 'open_url', 4096));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !registeredOrigins.includes(parsed.origin)) throw new Error('origin rejected');
    return parsed.toString();
  } catch {
    throw new WappActivityError('unsafe_open_url', 'open_url must use an approved HTTPS origin', 400);
  }
}

export function normalizeWappPublishingGrantInput(value: unknown): WappPublishingGrantInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WappActivityError('validation_failed', 'Request body must be an object');
  const body = value as JsonRecord;
  const allowedFields = new Set(['app_id', 'publisher_npub', 'owner_npub', 'display_name', 'capabilities', 'destinations', 'registered_open_origins']);
  const unknownField = Object.keys(body).find((field) => !allowedFields.has(field));
  if (unknownField) throw new WappActivityError('validation_failed', `${unknownField} is not accepted on grant requests`, 400, { field: unknownField });
  const capabilities = Array.isArray(body.capabilities)
    ? [...new Set(body.capabilities.map(text).filter(Boolean))].sort()
    : [];
  if (capabilities.length !== 1 || capabilities[0] !== 'activity.publish') {
    throw new WappActivityError('capability_denied', 'Version one grants require only activity.publish', 403);
  }
  if (!Array.isArray(body.destinations) || body.destinations.length === 0 || body.destinations.length > 200) {
    throw new WappActivityError('validation_failed', 'At least one explicit destination is required');
  }
  const destinations = body.destinations.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new WappActivityError('validation_failed', 'Destination must be an object', 400, { index });
    const row = entry as JsonRecord;
    return {
      scope_id: requireBoundedText(row.scope_id, `destinations.${index}.scope_id`, 128),
      channel_id: requireBoundedText(row.channel_id, `destinations.${index}.channel_id`, 128),
    };
  });
  if (new Set(destinations.map((entry) => entry.channel_id)).size !== destinations.length) {
    throw new WappActivityError('validation_failed', 'Destination channel IDs must be unique');
  }
  return {
    app_id: requireBoundedText(body.app_id, 'app_id', 128),
    publisher_npub: requireNpub(body.publisher_npub, 'publisher_npub'),
    owner_npub: requireNpub(body.owner_npub, 'owner_npub'),
    display_name: requireBoundedText(body.display_name, 'display_name', 160),
    capabilities,
    destinations,
    registered_open_origins: normalizeRegisteredOpenOrigins(body.registered_open_origins ?? []),
  };
}

export function normalizeWappActivityPayload(value: unknown, registeredOrigins: string[]): NormalizedWappActivityPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WappActivityError('validation_failed', 'Request body must be an object');
  const body = value as JsonRecord;
  const allowedFields = new Set(['external_id', 'version', 'scope_id', 'channel_id', 'category', 'title', 'summary', 'occurred_at', 'priority', 'state', 'open_url']);
  const unknownField = Object.keys(body).find((field) => !allowedFields.has(field));
  if (unknownField) throw new WappActivityError('validation_failed', `${unknownField} is not accepted on publication requests`, 400, { field: unknownField });
  const version = Number(body.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new WappActivityError('validation_failed', 'version must be a positive integer', 400, { field: 'version' });
  const occurredAt = new Date(text(body.occurred_at));
  if (Number.isNaN(occurredAt.getTime())) throw new WappActivityError('validation_failed', 'occurred_at must be an ISO timestamp', 400, { field: 'occurred_at' });
  if (occurredAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) throw new WappActivityError('validation_failed', 'occurred_at cannot be more than 24 hours in the future', 400, { field: 'occurred_at' });
  const priority = text(body.priority || 'normal') as WappActivityPriority;
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw new WappActivityError('validation_failed', 'priority is invalid', 400, { field: 'priority' });
  const state = text(body.state || 'active') as WappActivityState;
  if (!['active', 'resolved', 'withdrawn'].includes(state)) throw new WappActivityError('validation_failed', 'state is invalid', 400, { field: 'state' });
  return {
    external_id: requireBoundedText(body.external_id, 'external_id', 128),
    version,
    scope_id: requireBoundedText(body.scope_id, 'scope_id', 128),
    channel_id: requireBoundedText(body.channel_id, 'channel_id', 128),
    category: requireBoundedText(body.category, 'category', 128),
    title: requireBoundedText(body.title, 'title', 160),
    summary: requireBoundedText(body.summary ?? '', 'summary', 1200, true),
    occurred_at: occurredAt.toISOString(),
    priority,
    state,
    open_url: normalizeOpenUrl(body.open_url, registeredOrigins),
  };
}

export function hashNormalizedWappActivityPayload(payload: NormalizedWappActivityPayload): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function serializeInstallation(row: InstallationRow) {
  return {
    app_id: row.app_id,
    wapp_installation_id: row.wapp_installation_id,
    publisher_npub: row.publisher_npub,
    owner_npub: row.owner_npub,
    display_name: row.display_name,
    publisher_key_version: row.key_version,
  };
}

function serializeDestination(row: DestinationRow) {
  return {
    scope_id: row.scope_id,
    scope_name: row.scope_name,
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    available: row.current_scope_id === row.scope_id && !row.scope_archived_at && !row.channel_archived_at,
  };
}

export function serializeWappPublishingGrant(context: PublisherGrantContext, flightdeckAppNpub: string) {
  const { installation, grant, destinations } = context;
  return {
    grant_id: grant.id,
    ...serializeInstallation(installation),
    flightdeck_app_npub: flightdeckAppNpub,
    workspace_id: grant.workspace_id,
    grant_version: grant.grant_version,
    status: grant.status,
    capabilities: grant.capabilities,
    destinations: destinations.map(serializeDestination),
    registered_open_origins: grant.registered_open_origins,
    disable_open_links: grant.disable_open_links,
    approved_by_npub: grant.approved_by_npub,
    last_published_at: grant.last_published_at?.toISOString() ?? null,
    last_rejected_at: grant.last_rejected_at?.toISOString() ?? null,
    last_rejection_code: grant.last_rejection_code,
    disabled_at: grant.disabled_at?.toISOString() ?? null,
    revoked_at: grant.revoked_at?.toISOString() ?? null,
    created_at: grant.created_at.toISOString(),
    updated_at: grant.updated_at.toISOString(),
  };
}

async function destinationsForGrant(grantId: string, sql: DbClient): Promise<DestinationRow[]> {
  return sql<DestinationRow[]>`
    SELECT d.*, s.name AS scope_name, c.name AS channel_name, c.scope_id AS current_scope_id,
      s.archived_at AS scope_archived_at, c.archived_at AS channel_archived_at
    FROM flightdeck_pg_wapp_publishing_destinations d
    JOIN flightdeck_pg_scopes s ON s.workspace_id=d.workspace_id AND s.id=d.scope_id
    JOIN flightdeck_pg_channels c ON c.workspace_id=d.workspace_id AND c.id=d.channel_id
    WHERE d.grant_id=${grantId}
    ORDER BY s.name ASC, c.name ASC, c.id ASC
  `;
}

async function grantContextFromRows(installation: InstallationRow, grant: GrantRow, sql: DbClient): Promise<PublisherGrantContext> {
  return { installation, grant, destinations: await destinationsForGrant(grant.id, sql) };
}

export async function resolvePublisherGrant(
  workspaceId: string,
  signerNpub: string,
  sql: DbClient = getDb(),
): Promise<PublisherGrantContext> {
  const [installation] = await sql<InstallationRow[]>`
    SELECT * FROM flightdeck_pg_wapp_installations
    WHERE publisher_npub=${signerNpub}
    LIMIT 1
  `;
  if (!installation) {
    const [stale] = await sql<{ id: string }[]>`
      SELECT id FROM flightdeck_pg_wapp_installations
      WHERE ${signerNpub}=ANY(previous_publisher_npubs)
      LIMIT 1
    `;
    throw new WappActivityError(stale ? 'stale_publisher_key' : 'publisher_not_registered', stale ? 'Publisher key has been rotated' : 'Publisher is not registered', 403);
  }
  const [grant] = await sql<GrantRow[]>`
    SELECT * FROM flightdeck_pg_wapp_publishing_grants
    WHERE workspace_id=${workspaceId} AND installation_id=${installation.id}
    LIMIT 1
  `;
  if (!grant) throw new WappActivityError('publishing_grant_not_found', 'Publishing grant not found', 404);
  return grantContextFromRows(installation, grant, sql);
}

export async function resolveWappPublishingGrantByInstallation(
  workspaceId: string,
  wappInstallationId: string,
  sql: DbClient = getDb(),
): Promise<PublisherGrantContext | null> {
  const rows = await sql<Array<InstallationRow & { grant_id: string }>>`
    SELECT i.*, g.id AS grant_id
    FROM flightdeck_pg_wapp_installations i
    JOIN flightdeck_pg_wapp_publishing_grants g ON g.installation_id=i.id
    WHERE g.workspace_id=${workspaceId} AND i.wapp_installation_id=${wappInstallationId}
    LIMIT 1
  `;
  const installation = rows[0];
  if (!installation) return null;
  const [grant] = await sql<GrantRow[]>`SELECT * FROM flightdeck_pg_wapp_publishing_grants WHERE id=${installation.grant_id}`;
  return grant ? grantContextFromRows(installation, grant, sql) : null;
}

export async function listWappPublishingGrants(workspaceId: string, sql: DbClient = getDb()): Promise<PublisherGrantContext[]> {
  const rows = await sql<Array<InstallationRow & { grant_id: string }>>`
    SELECT i.*, g.id AS grant_id
    FROM flightdeck_pg_wapp_publishing_grants g
    JOIN flightdeck_pg_wapp_installations i ON i.id=g.installation_id
    WHERE g.workspace_id=${workspaceId}
    ORDER BY i.display_name ASC, i.wapp_installation_id ASC
  `;
  return Promise.all(rows.map(async (installation) => {
    const [grant] = await sql<GrantRow[]>`SELECT * FROM flightdeck_pg_wapp_publishing_grants WHERE id=${installation.grant_id}`;
    return grantContextFromRows(installation, grant!, sql);
  }));
}

async function validateDestinations(workspaceId: string, destinations: WappPublishingDestinationInput[], sql: DbClient) {
  for (const destination of destinations) {
    const [channel] = await sql<{ id: string; scope_id: string; archived_at: Date | null; scope_archived_at: Date | null }[]>`
      SELECT c.id, c.scope_id, c.archived_at, s.archived_at AS scope_archived_at
      FROM flightdeck_pg_channels c
      JOIN flightdeck_pg_scopes s ON s.workspace_id=c.workspace_id AND s.id=c.scope_id
      WHERE c.workspace_id=${workspaceId} AND c.id=${destination.channel_id}
      LIMIT 1
    `;
    if (!channel || channel.scope_id !== destination.scope_id) throw new WappActivityError('destination_scope_changed', 'Destination channel does not belong to the stated scope', 409, { ...destination });
    if (channel.archived_at || channel.scope_archived_at) throw new WappActivityError('channel_unavailable', 'Archived destinations cannot receive publications', 409, { ...destination });
  }
}

async function writePublishingAudit(input: {
  workspaceId?: string | null;
  installationId?: string | null;
  grantId?: string | null;
  itemId?: string | null;
  actorId?: string | null;
  signerNpub: string;
  action: string;
  outcome: 'accepted' | 'rejected';
  errorCode?: string | null;
  payloadHash?: string | null;
  metadata?: JsonRecord;
}, sql: DbClient): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_wapp_publishing_audit
      (workspace_id, installation_id, grant_id, item_id, actor_id, signer_npub, action, outcome, error_code, payload_hash, metadata)
    VALUES (${input.workspaceId ?? null}, ${input.installationId ?? null}, ${input.grantId ?? null}, ${input.itemId ?? null}, ${input.actorId ?? null},
      ${input.signerNpub}, ${input.action}, ${input.outcome}, ${input.errorCode ?? null}, ${input.payloadHash ?? null}, ${sql.json((input.metadata ?? {}) as any)})
    RETURNING id
  `;
  return row!.id;
}

export async function recordWappPublishingRejection(input: {
  workspaceId: string;
  signerNpub: string;
  context?: PublisherGrantContext | null;
  code: string;
  payloadHash?: string | null;
}, sql: DbClient = getDb()): Promise<void> {
  await writePublishingAudit({
    workspaceId: input.workspaceId,
    installationId: input.context?.installation.id,
    grantId: input.context?.grant.id,
    signerNpub: input.signerNpub,
    action: 'activity.publish',
    outcome: 'rejected',
    errorCode: input.code,
    payloadHash: input.payloadHash,
  }, sql);
  if (input.context) {
    await sql`UPDATE flightdeck_pg_wapp_publishing_grants SET last_rejected_at=NOW(), last_rejection_code=${input.code}, updated_at=NOW() WHERE id=${input.context.grant.id}`;
  }
}

export async function replaceWappPublishingGrant(input: {
  workspaceId: string;
  wappInstallationId: string;
  request: WappPublishingGrantInput;
  actorId: string;
  actorNpub: string;
  signerNpub: string;
}, sql: DbClient = getDb()): Promise<{ context: PublisherGrantContext; auditId: string }> {
  await validateDestinations(input.workspaceId, input.request.destinations, sql);
  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    const [existing] = await db<InstallationRow[]>`SELECT * FROM flightdeck_pg_wapp_installations WHERE wapp_installation_id=${input.wappInstallationId} FOR UPDATE`;
    let installation = existing;
    if (!installation) {
      [installation] = await db<InstallationRow[]>`
        INSERT INTO flightdeck_pg_wapp_installations (wapp_installation_id, app_id, publisher_npub, owner_npub, display_name)
        VALUES (${input.wappInstallationId}, ${input.request.app_id}, ${input.request.publisher_npub}, ${input.request.owner_npub}, ${input.request.display_name})
        RETURNING *
      `;
    } else {
      if (installation.app_id !== input.request.app_id || installation.owner_npub !== input.request.owner_npub) {
        throw new WappActivityError('installation_identity_conflict', 'Stable installation identity fields cannot be replaced', 409);
      }
      if (installation.publisher_npub !== input.request.publisher_npub) {
        throw new WappActivityError('publisher_key_mismatch', 'Use the rotate endpoint to change publisher_npub', 409);
      }
      [installation] = await db<InstallationRow[]>`
        UPDATE flightdeck_pg_wapp_installations SET display_name=${input.request.display_name}, updated_at=NOW()
        WHERE id=${installation.id} RETURNING *
      `;
    }
    const [grant] = await db<GrantRow[]>`
      INSERT INTO flightdeck_pg_wapp_publishing_grants
        (workspace_id, installation_id, status, capabilities, registered_open_origins, approved_by_actor_id, approved_by_npub)
      VALUES (${input.workspaceId}, ${installation!.id}, 'active', ${input.request.capabilities}, ${input.request.registered_open_origins}, ${input.actorId}, ${input.actorNpub})
      ON CONFLICT (workspace_id, installation_id) DO UPDATE SET
        status='active', capabilities=EXCLUDED.capabilities, registered_open_origins=EXCLUDED.registered_open_origins,
        disable_open_links=false, grant_version=flightdeck_pg_wapp_publishing_grants.grant_version+1,
        approved_by_actor_id=EXCLUDED.approved_by_actor_id, approved_by_npub=EXCLUDED.approved_by_npub,
        disabled_at=NULL, revoked_at=NULL, updated_at=NOW()
      RETURNING *
    `;
    await db`DELETE FROM flightdeck_pg_wapp_publishing_destinations WHERE grant_id=${grant!.id}`;
    for (const destination of input.request.destinations) {
      await db`
        INSERT INTO flightdeck_pg_wapp_publishing_destinations (grant_id, workspace_id, scope_id, channel_id)
        VALUES (${grant!.id}, ${input.workspaceId}, ${destination.scope_id}, ${destination.channel_id})
      `;
    }
    const auditId = await writePublishingAudit({ workspaceId: input.workspaceId, installationId: installation!.id, grantId: grant!.id, actorId: input.actorId, signerNpub: input.signerNpub, action: existing ? 'grant.replace' : 'grant.create', outcome: 'accepted', metadata: { actor_npub: input.actorNpub, destinations: input.request.destinations } }, db);
    return { context: await grantContextFromRows(installation!, grant!, db), auditId };
  }) as Promise<{ context: PublisherGrantContext; auditId: string }>;
}

export async function setWappPublishingGrantDisabled(input: { workspaceId: string; wappInstallationId: string; disabled: boolean; reason?: string | null; actorId: string; actorNpub: string; signerNpub: string }, sql: DbClient = getDb()) {
  const current = await resolveWappPublishingGrantByInstallation(input.workspaceId, input.wappInstallationId, sql);
  if (!current) throw new WappActivityError('publishing_grant_not_found', 'Publishing grant not found', 404);
  if (current.grant.status === 'revoked') throw new WappActivityError('publishing_grant_revoked', 'Revoked grants must be explicitly replaced', 409);
  const [grant] = await sql<GrantRow[]>`
    UPDATE flightdeck_pg_wapp_publishing_grants SET status=${input.disabled ? 'disabled' : 'active'},
      disabled_at=${input.disabled ? new Date() : null}, grant_version=grant_version+1,
      approved_by_actor_id=${input.actorId}, approved_by_npub=${input.actorNpub}, updated_at=NOW()
    WHERE id=${current.grant.id} RETURNING *
  `;
  const auditId = await writePublishingAudit({ workspaceId: input.workspaceId, installationId: current.installation.id, grantId: grant!.id, actorId: input.actorId, signerNpub: input.signerNpub, action: input.disabled ? 'grant.disable' : 'grant.enable', outcome: 'accepted', metadata: { actor_npub: input.actorNpub, reason: text(input.reason) || null } }, sql);
  return { context: await grantContextFromRows(current.installation, grant!, sql), auditId };
}

export async function revokeWappPublishingGrant(input: { workspaceId: string; wappInstallationId: string; reason?: string | null; disableOpenLinks: boolean; actorId: string; actorNpub: string; signerNpub: string }, sql: DbClient = getDb()) {
  const current = await resolveWappPublishingGrantByInstallation(input.workspaceId, input.wappInstallationId, sql);
  if (!current) throw new WappActivityError('publishing_grant_not_found', 'Publishing grant not found', 404);
  const [grant] = await sql<GrantRow[]>`
    UPDATE flightdeck_pg_wapp_publishing_grants SET status='revoked', revoked_at=COALESCE(revoked_at,NOW()),
      disable_open_links=${input.disableOpenLinks}, grant_version=grant_version+1,
      approved_by_actor_id=${input.actorId}, approved_by_npub=${input.actorNpub}, updated_at=NOW()
    WHERE id=${current.grant.id} RETURNING *
  `;
  const auditId = await writePublishingAudit({ workspaceId: input.workspaceId, installationId: current.installation.id, grantId: grant!.id, actorId: input.actorId, signerNpub: input.signerNpub, action: 'grant.revoke', outcome: 'accepted', metadata: { actor_npub: input.actorNpub, reason: text(input.reason) || null, disable_open_links: input.disableOpenLinks } }, sql);
  return { context: await grantContextFromRows(current.installation, grant!, sql), auditId };
}

export async function rotateWappPublisherKey(input: { workspaceId: string; wappInstallationId: string; currentPublisherNpub: string; newPublisherNpub: string; nonce: string; expiresAt: string; actorId: string; actorNpub: string; signerNpub: string }, sql: DbClient = getDb()) {
  const current = await resolveWappPublishingGrantByInstallation(input.workspaceId, input.wappInstallationId, sql);
  if (!current) throw new WappActivityError('publishing_grant_not_found', 'Publishing grant not found', 404);
  const currentNpub = requireNpub(input.currentPublisherNpub, 'current_publisher_npub');
  const nextNpub = requireNpub(input.newPublisherNpub, 'new_publisher_npub');
  if (current.installation.publisher_npub !== currentNpub) throw new WappActivityError('stale_publisher_key', 'current_publisher_npub is stale', 409);
  if (currentNpub === nextNpub) throw new WappActivityError('validation_failed', 'new_publisher_npub must differ from the current key');
  const nonce = requireBoundedText(input.nonce, 'nonce', 256);
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 10 * 60 * 1000) {
    throw new WappActivityError('validation_failed', 'expires_at must be within the next 10 minutes');
  }
  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    const [installation] = await db<InstallationRow[]>`
      UPDATE flightdeck_pg_wapp_installations SET publisher_npub=${nextNpub},
        previous_publisher_npubs=array_append(previous_publisher_npubs, publisher_npub), key_version=key_version+1, updated_at=NOW()
      WHERE id=${current.installation.id} AND publisher_npub=${currentNpub}
      RETURNING *
    `;
    if (!installation) throw new WappActivityError('stale_publisher_key', 'Publisher key changed concurrently', 409);
    const [grant] = await db<GrantRow[]>`
      UPDATE flightdeck_pg_wapp_publishing_grants SET grant_version=grant_version+1,
        approved_by_actor_id=${input.actorId}, approved_by_npub=${input.actorNpub}, updated_at=NOW()
      WHERE id=${current.grant.id} RETURNING *
    `;
    const auditId = await writePublishingAudit({ workspaceId: input.workspaceId, installationId: installation.id, grantId: grant!.id, actorId: input.actorId, signerNpub: input.signerNpub, action: 'publisher.rotate', outcome: 'accepted', metadata: { actor_npub: input.actorNpub, previous_publisher_npub: currentNpub, publisher_npub: nextNpub, nonce, expires_at: expiresAt.toISOString() } }, db);
    return { context: await grantContextFromRows(installation, grant!, db), auditId };
  }) as Promise<{ context: PublisherGrantContext; auditId: string }>;
}

function bucketStart(now: number, seconds: number): Date {
  return new Date(Math.floor(now / (seconds * 1000)) * seconds * 1000);
}

async function incrementBucket(type: 'installation_minute' | 'installation_burst' | 'destination_minute', key: string, window: Date, limit: number, sql: DbClient) {
  const [bucket] = await sql<{ request_count: number }[]>`
    INSERT INTO flightdeck_pg_wapp_publication_buckets (bucket_type, bucket_key, window_started_at, request_count)
    VALUES (${type}, ${key}, ${window}, 1)
    ON CONFLICT (bucket_type, bucket_key, window_started_at) DO UPDATE SET request_count=flightdeck_pg_wapp_publication_buckets.request_count+1, updated_at=NOW()
    RETURNING request_count
  `;
  if (Number(bucket!.request_count) > limit) throw new WappActivityError('rate_limited', 'Publication rate limit exceeded', 429, { bucket: type, retry_after_seconds: type === 'installation_burst' ? config.wappActivity.installationBurstWindowSeconds : 60 });
}

export async function enforceWappInstallationRate(context: PublisherGrantContext, sql: DbClient = getDb()) {
  const now = Date.now();
  await incrementBucket('installation_minute', context.installation.id, bucketStart(now, 60), config.wappActivity.installationRequestsPerMinute, sql);
  await incrementBucket('installation_burst', context.installation.id, bucketStart(now, config.wappActivity.installationBurstWindowSeconds), config.wappActivity.installationBurstRequests, sql);
}

export async function enforceWappDestinationRate(context: PublisherGrantContext, channelId: string, sql: DbClient = getDb()) {
  await incrementBucket('destination_minute', `${context.installation.id}:${context.grant.workspace_id}:${channelId}`, bucketStart(Date.now(), 60), config.wappActivity.destinationRequestsPerMinute, sql);
}

export function assertWappPublishingGrantActive(context: PublisherGrantContext) {
  if (context.grant.status === 'disabled') throw new WappActivityError('publishing_grant_disabled', 'Publishing grant is disabled', 403);
  if (context.grant.status === 'revoked') throw new WappActivityError('publishing_grant_revoked', 'Publishing grant is revoked', 403);
  if (!context.grant.capabilities.includes('activity.publish')) throw new WappActivityError('capability_denied', 'Grant does not allow activity.publish', 403);
}

function serializeActivityItem(row: ActivityItemRow) {
  const readVersion = row.read_version ?? null;
  const sourceStatus = row.source_status ?? null;
  const openUrlAllowed = (() => {
    if (sourceStatus !== 'active' || row.disable_open_links || !row.open_url) return false;
    try {
      const parsed = new URL(row.open_url);
      return parsed.protocol === 'https:' && (row.registered_open_origins ?? []).includes(parsed.origin);
    } catch {
      return false;
    }
  })();
  return {
    id: row.id,
    app_id: row.app_id ?? null,
    wapp_installation_id: row.wapp_installation_id ?? null,
    publisher_npub: row.publisher_npub,
    display_name: row.display_name ?? null,
    workspace_id: row.workspace_id,
    scope_id: row.scope_id,
    channel_id: row.channel_id,
    external_id: row.external_id,
    version: row.version,
    category: row.category,
    title: row.title,
    summary: row.summary,
    occurred_at: row.occurred_at.toISOString(),
    priority: row.priority,
    state: row.state,
    open_url: row.open_url,
    source_status: sourceStatus,
    open_url_allowed: openUrlAllowed,
    read_at: row.read_at?.toISOString() ?? null,
    dismissed_at: row.dismissed_at?.toISOString() ?? null,
    unread: readVersion === null || readVersion < row.version,
    muted: Boolean(row.muted),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function serializeCurrentGrantAuthority(context: PublisherGrantContext) {
  return {
    source_status: context.grant.status,
    registered_open_origins: context.grant.registered_open_origins,
    disable_open_links: context.grant.disable_open_links,
  };
}

export async function publishWappActivity(input: { context: PublisherGrantContext; payload: NormalizedWappActivityPayload; payloadHash: string }, sql: DbClient = getDb()) {
  assertWappPublishingGrantActive(input.context);
  const destination = input.context.destinations.find((row) => row.channel_id === input.payload.channel_id);
  if (!destination) throw new WappActivityError('destination_not_allowed', 'Destination is not approved', 403);
  if (destination.current_scope_id !== destination.scope_id) throw new WappActivityError('destination_scope_changed', 'Destination channel moved and must be reapproved', 409);
  if (destination.scope_id !== input.payload.scope_id) throw new WappActivityError('destination_scope_changed', 'Destination scope no longer matches the grant', 409);
  if (destination.channel_archived_at || destination.scope_archived_at) throw new WappActivityError('channel_unavailable', 'Destination is archived', 409);
  await enforceWappDestinationRate(input.context, input.payload.channel_id, sql);
  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    const [current] = await db<ActivityItemRow[]>`
      SELECT * FROM flightdeck_pg_wapp_activity_items
      WHERE installation_id=${input.context.installation.id} AND workspace_id=${input.context.grant.workspace_id}
        AND channel_id=${input.payload.channel_id} AND external_id=${input.payload.external_id}
      FOR UPDATE
    `;
    if (current) {
      if (input.payload.version === current.version && input.payloadHash === current.payload_hash) {
        return { item: serializeActivityItem({ ...current, ...serializeInstallation(input.context.installation), ...serializeCurrentGrantAuthority(input.context) } as ActivityItemRow), replayed: true, auditId: null, outbox: null };
      }
      if (input.payload.version === current.version) throw new WappActivityError('version_conflict', 'The same version was already published with a different payload', 409, { current_version: current.version });
      if (input.payload.version < current.version) throw new WappActivityError('stale_version', 'Publication version is stale', 409, { current_version: current.version });
      if (current.state === 'withdrawn') throw new WappActivityError('withdrawn_tombstone', 'Withdrawn activity identities cannot be resurrected', 409);
    }
    let item: ActivityItemRow;
    let operation: 'created' | 'updated' | 'withdrawn';
    if (!current) {
      [item] = await db<ActivityItemRow[]>`
        INSERT INTO flightdeck_pg_wapp_activity_items
          (installation_id, grant_id, workspace_id, scope_id, channel_id, external_id, version, payload_hash, category, title, summary, occurred_at, priority, state, open_url, publisher_npub, resolved_at, withdrawn_at)
        VALUES (${input.context.installation.id}, ${input.context.grant.id}, ${input.context.grant.workspace_id}, ${input.payload.scope_id}, ${input.payload.channel_id},
          ${input.payload.external_id}, ${input.payload.version}, ${input.payloadHash}, ${input.payload.category}, ${input.payload.title}, ${input.payload.summary},
          ${input.payload.occurred_at}, ${input.payload.priority}, ${input.payload.state}, ${input.payload.open_url}, ${input.context.installation.publisher_npub},
          ${input.payload.state === 'resolved' ? new Date() : null}, ${input.payload.state === 'withdrawn' ? new Date() : null})
        RETURNING *
      `;
      operation = input.payload.state === 'withdrawn' ? 'withdrawn' : 'created';
    } else {
      [item] = await db<ActivityItemRow[]>`
        UPDATE flightdeck_pg_wapp_activity_items SET version=${input.payload.version}, payload_hash=${input.payloadHash}, category=${input.payload.category},
          title=${input.payload.title}, summary=${input.payload.summary}, occurred_at=${input.payload.occurred_at}, priority=${input.payload.priority},
          state=${input.payload.state}, open_url=${input.payload.open_url}, publisher_npub=${input.context.installation.publisher_npub}, updated_at=NOW(),
          resolved_at=CASE WHEN ${input.payload.state}='resolved' THEN NOW() ELSE NULL END,
          withdrawn_at=CASE WHEN ${input.payload.state}='withdrawn' THEN NOW() ELSE NULL END
        WHERE id=${current.id} RETURNING *
      `;
      operation = input.payload.state === 'withdrawn' ? 'withdrawn' : 'updated';
    }
    await db`
      INSERT INTO flightdeck_pg_wapp_activity_versions (item_id, version, payload_hash, payload, publisher_npub)
      VALUES (${item!.id}, ${input.payload.version}, ${input.payloadHash}, ${db.json(input.payload as any)}, ${input.context.installation.publisher_npub})
    `;
    const auditId = await writePublishingAudit({ workspaceId: input.context.grant.workspace_id, installationId: input.context.installation.id, grantId: input.context.grant.id, itemId: item!.id, signerNpub: input.context.installation.publisher_npub, action: 'activity.publish', outcome: 'accepted', payloadHash: input.payloadHash, metadata: { external_id: input.payload.external_id, version: input.payload.version, operation } }, db);
    const eventType = `flightdeck_pg.wapp_activity.${operation}`;
    const [outbox] = await db<{ id: string; row_version: number }[]>`
      INSERT INTO flightdeck_pg_outbox_events (workspace_id, scope_id, channel_id, event_type, entity_type, entity_id, operation, entity_row_version, payload)
      VALUES (${item!.workspace_id}, ${item!.scope_id}, ${item!.channel_id}, ${eventType}, 'wapp_activity_item', ${item!.id}, ${operation}, ${item!.version},
        ${db.json({ item_id: item!.id, wapp_installation_id: input.context.installation.wapp_installation_id, version: item!.version, state: item!.state } as any)})
      RETURNING id, row_version
    `;
    await db`UPDATE flightdeck_pg_wapp_publishing_grants SET last_published_at=NOW(), last_rejection_code=NULL, updated_at=NOW() WHERE id=${input.context.grant.id}`;
    return { item: serializeActivityItem({ ...item!, ...serializeInstallation(input.context.installation), ...serializeCurrentGrantAuthority(input.context) } as ActivityItemRow), replayed: false, auditId, outbox };
  });
}

function visibleGrantSql(sql: DbClient, actorId: string, groupIds: string[], itemAlias = 'i') {
  const ids = groupIds.length ? groupIds : ['00000000-0000-0000-0000-000000000000'];
  return sql`
    EXISTS (
      SELECT 1 FROM flightdeck_pg_permission_grants pg
      WHERE pg.workspace_id=${sql.unsafe(itemAlias)}.workspace_id
        AND pg.resource_type='channel' AND pg.resource_channel_id=${sql.unsafe(itemAlias)}.channel_id
        AND pg.permission='channel.read' AND pg.revoked_at IS NULL
        AND ((pg.principal_type='actor' AND pg.principal_actor_id=${actorId}) OR (pg.principal_type='group' AND pg.principal_group_id IN ${sql(ids)}))
    )
  `;
}

export async function listVisibleWappActivity(input: { workspaceId: string; actorId: string; groupIds: string[]; unread?: boolean | null; state?: string | null; installationId?: string | null; category?: string | null; channelId?: string | null; includeResolved?: boolean; limit: number; cursor?: { occurredAt: Date; id: string } | null }, sql: DbClient = getDb()) {
  const rows = await sql<ActivityItemRow[]>`
    SELECT i.*, installation.wapp_installation_id, installation.app_id, installation.display_name,
      current_grant.status AS source_status, current_grant.registered_open_origins, current_grant.disable_open_links,
      user_state.read_version, user_state.read_at, user_state.dismissed_at,
      EXISTS (SELECT 1 FROM flightdeck_pg_wapp_activity_mutes m WHERE m.workspace_id=i.workspace_id AND m.actor_id=${input.actorId}
        AND ((m.target_type='installation' AND m.target_value=installation.wapp_installation_id) OR (m.target_type='category' AND m.target_value=i.category))) AS muted
    FROM flightdeck_pg_wapp_activity_items i
    JOIN flightdeck_pg_wapp_installations installation ON installation.id=i.installation_id
    JOIN flightdeck_pg_wapp_publishing_grants current_grant
      ON current_grant.workspace_id=i.workspace_id AND current_grant.installation_id=i.installation_id
    JOIN flightdeck_pg_channels channel ON channel.workspace_id=i.workspace_id AND channel.id=i.channel_id AND channel.archived_at IS NULL
    JOIN flightdeck_pg_scopes scope ON scope.workspace_id=i.workspace_id AND scope.id=channel.scope_id AND scope.archived_at IS NULL
    LEFT JOIN flightdeck_pg_wapp_activity_user_state user_state ON user_state.item_id=i.id AND user_state.actor_id=${input.actorId}
    WHERE i.workspace_id=${input.workspaceId} AND i.state<>'withdrawn'
      AND user_state.dismissed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM flightdeck_pg_wapp_activity_mutes m WHERE m.workspace_id=i.workspace_id AND m.actor_id=${input.actorId}
        AND ((m.target_type='installation' AND m.target_value=installation.wapp_installation_id) OR (m.target_type='category' AND m.target_value=i.category)))
      AND ${visibleGrantSql(sql, input.actorId, input.groupIds)}
      AND (${input.unread ?? null}::boolean IS NULL OR (${input.unread ?? null}=((user_state.read_version IS NULL) OR user_state.read_version<i.version)))
      AND (${input.state ?? null}::text IS NULL OR i.state=${input.state ?? null})
      AND (${input.installationId ?? null}::text IS NULL OR installation.wapp_installation_id=${input.installationId ?? null})
      AND (${input.category ?? null}::text IS NULL OR i.category=${input.category ?? null})
      AND (${input.channelId ?? null}::uuid IS NULL OR i.channel_id=${input.channelId ?? null})
      AND (i.state<>'resolved' OR (${input.includeResolved ?? false} AND i.resolved_at >= NOW()-(${config.wappActivity.resolvedHistoryDays}::integer*INTERVAL '1 day')))
      AND (i.state<>'active' OR i.occurred_at >= NOW()-(${config.wappActivity.activeMaxAgeDays}::integer*INTERVAL '1 day'))
      AND (${input.cursor?.occurredAt ?? null}::timestamptz IS NULL OR (i.occurred_at, i.id) < (${input.cursor?.occurredAt ?? null}, ${input.cursor?.id ?? null}::uuid))
    ORDER BY i.occurred_at DESC, i.id DESC
    LIMIT ${input.limit}
  `;
  return rows.map(serializeActivityItem);
}

export async function resolveVisibleWappActivity(input: { workspaceId: string; itemId: string; actorId: string; groupIds: string[] }, sql: DbClient = getDb()) {
  const [row] = await sql<ActivityItemRow[]>`
    SELECT i.*, installation.wapp_installation_id, installation.app_id, installation.display_name,
      current_grant.status AS source_status, current_grant.registered_open_origins, current_grant.disable_open_links,
      user_state.read_version, user_state.read_at, user_state.dismissed_at,
      EXISTS (SELECT 1 FROM flightdeck_pg_wapp_activity_mutes m WHERE m.workspace_id=i.workspace_id AND m.actor_id=${input.actorId}
        AND ((m.target_type='installation' AND m.target_value=installation.wapp_installation_id) OR (m.target_type='category' AND m.target_value=i.category))) AS muted
    FROM flightdeck_pg_wapp_activity_items i
    JOIN flightdeck_pg_wapp_installations installation ON installation.id=i.installation_id
    JOIN flightdeck_pg_wapp_publishing_grants current_grant
      ON current_grant.workspace_id=i.workspace_id AND current_grant.installation_id=i.installation_id
    JOIN flightdeck_pg_channels channel ON channel.workspace_id=i.workspace_id AND channel.id=i.channel_id AND channel.archived_at IS NULL
    JOIN flightdeck_pg_scopes scope ON scope.workspace_id=i.workspace_id AND scope.id=channel.scope_id AND scope.archived_at IS NULL
    LEFT JOIN flightdeck_pg_wapp_activity_user_state user_state ON user_state.item_id=i.id AND user_state.actor_id=${input.actorId}
    WHERE i.workspace_id=${input.workspaceId} AND i.id=${input.itemId} AND i.state<>'withdrawn'
      AND ${visibleGrantSql(sql, input.actorId, input.groupIds)}
    LIMIT 1
  `;
  return row ? serializeActivityItem(row) : null;
}

export async function countVisibleWappActivity(input: { workspaceId: string; actorId: string; groupIds: string[] }, sql: DbClient = getDb()) {
  const [row] = await sql<{ active: number; unread: number }[]>`
    SELECT COUNT(*) FILTER (WHERE i.state='active')::integer AS active,
      COUNT(*) FILTER (WHERE i.state='active' AND (user_state.read_version IS NULL OR user_state.read_version<i.version))::integer AS unread
    FROM flightdeck_pg_wapp_activity_items i
    JOIN flightdeck_pg_wapp_installations installation ON installation.id=i.installation_id
    JOIN flightdeck_pg_channels channel ON channel.workspace_id=i.workspace_id AND channel.id=i.channel_id AND channel.archived_at IS NULL
    JOIN flightdeck_pg_scopes scope ON scope.workspace_id=i.workspace_id AND scope.id=channel.scope_id AND scope.archived_at IS NULL
    LEFT JOIN flightdeck_pg_wapp_activity_user_state user_state ON user_state.item_id=i.id AND user_state.actor_id=${input.actorId}
    WHERE i.workspace_id=${input.workspaceId} AND i.state<>'withdrawn' AND user_state.dismissed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM flightdeck_pg_wapp_activity_mutes m WHERE m.workspace_id=i.workspace_id AND m.actor_id=${input.actorId}
        AND ((m.target_type='installation' AND m.target_value=installation.wapp_installation_id) OR (m.target_type='category' AND m.target_value=i.category)))
      AND ${visibleGrantSql(sql, input.actorId, input.groupIds)}
      AND (i.state<>'resolved' OR i.resolved_at >= NOW()-(${config.wappActivity.resolvedHistoryDays}::integer*INTERVAL '1 day'))
  `;
  return { active: Number(row?.active || 0), unread: Number(row?.unread || 0) };
}

export async function updateWappActivityUserState(input: { workspaceId: string; itemId: string; actorId: string; groupIds: string[]; read?: boolean; dismissed?: boolean }, sql: DbClient = getDb()) {
  const item = await resolveVisibleWappActivity({ workspaceId: input.workspaceId, itemId: input.itemId, actorId: input.actorId, groupIds: input.groupIds }, sql);
  if (!item) throw new WappActivityError('activity_item_not_found', 'Activity item not found', 404);
  const readVersion = input.read === undefined ? undefined : input.read ? Number(item.version) : null;
  const [state] = await sql<{ read_version: number | null; read_at: Date | null; dismissed_at: Date | null }[]>`
    INSERT INTO flightdeck_pg_wapp_activity_user_state (workspace_id, item_id, actor_id, read_version, read_at, dismissed_at)
    VALUES (${input.workspaceId}, ${input.itemId}, ${input.actorId}, ${readVersion ?? null}, ${input.read ? new Date() : null}, ${input.dismissed ? new Date() : null})
    ON CONFLICT (item_id, actor_id) DO UPDATE SET
      read_version=CASE WHEN ${input.read === undefined} THEN flightdeck_pg_wapp_activity_user_state.read_version ELSE ${readVersion ?? null} END,
      read_at=CASE WHEN ${input.read === undefined} THEN flightdeck_pg_wapp_activity_user_state.read_at WHEN ${input.read ?? false} THEN NOW() ELSE NULL END,
      dismissed_at=CASE WHEN ${input.dismissed === undefined} THEN flightdeck_pg_wapp_activity_user_state.dismissed_at WHEN ${input.dismissed ?? false} THEN COALESCE(flightdeck_pg_wapp_activity_user_state.dismissed_at,NOW()) ELSE NULL END,
      updated_at=NOW()
    RETURNING read_version, read_at, dismissed_at
  `;
  return { read_at: state!.read_at?.toISOString() ?? null, dismissed_at: state!.dismissed_at?.toISOString() ?? null, unread: state!.read_version === null || Number(state!.read_version) < Number(item.version) };
}

export async function listWappActivityMutes(workspaceId: string, actorId: string, sql: DbClient = getDb()) {
  return sql<{ target_type: WappActivityMuteTarget; target_value: string; created_at: Date }[]>`
    SELECT target_type, target_value, created_at FROM flightdeck_pg_wapp_activity_mutes
    WHERE workspace_id=${workspaceId} AND actor_id=${actorId}
    ORDER BY target_type ASC, target_value ASC
  `;
}

export async function putWappActivityMute(workspaceId: string, actorId: string, targetType: WappActivityMuteTarget, targetValue: string, sql: DbClient = getDb()) {
  if (!['installation', 'category'].includes(targetType)) throw new WappActivityError('validation_failed', 'targetType must be installation or category');
  const normalized = requireBoundedText(targetValue, 'targetValue', 128);
  const [mute] = await sql<{ target_type: WappActivityMuteTarget; target_value: string; created_at: Date }[]>`
    INSERT INTO flightdeck_pg_wapp_activity_mutes (workspace_id, actor_id, target_type, target_value)
    VALUES (${workspaceId}, ${actorId}, ${targetType}, ${normalized})
    ON CONFLICT (workspace_id, actor_id, target_type, target_value) DO UPDATE SET target_value=EXCLUDED.target_value
    RETURNING target_type, target_value, created_at
  `;
  return mute!;
}

export async function deleteWappActivityMute(workspaceId: string, actorId: string, targetType: WappActivityMuteTarget, targetValue: string, sql: DbClient = getDb()) {
  const rows = await sql<{ target_value: string }[]>`
    DELETE FROM flightdeck_pg_wapp_activity_mutes
    WHERE workspace_id=${workspaceId} AND actor_id=${actorId} AND target_type=${targetType} AND target_value=${targetValue}
    RETURNING target_value
  `;
  return rows.length > 0;
}

export async function cleanupWappActivity(now = new Date(), sql: DbClient = getDb()) {
  const [versions, items, audit, buckets] = await Promise.all([
    sql`DELETE FROM flightdeck_pg_wapp_activity_versions WHERE created_at < ${now} - (${config.wappActivity.projectionRetentionDays}::integer * INTERVAL '1 day')`,
    sql`DELETE FROM flightdeck_pg_wapp_activity_items WHERE state IN ('resolved','withdrawn') AND updated_at < ${now} - (${config.wappActivity.projectionRetentionDays}::integer * INTERVAL '1 day')`,
    sql`DELETE FROM flightdeck_pg_wapp_publishing_audit WHERE created_at < ${now} - (${config.wappActivity.auditRetentionDays}::integer * INTERVAL '1 day')`,
    sql`DELETE FROM flightdeck_pg_wapp_publication_buckets WHERE window_started_at < ${now} - INTERVAL '2 days'`,
  ]);
  return { versions: versions.count, items: items.count, audit: audit.count, buckets: buckets.count };
}

export function encodeWappActivityCursor(item: { occurred_at: string; id: string }) {
  return Buffer.from(JSON.stringify({ v: 1, occurred_at: item.occurred_at, id: item.id }), 'utf8').toString('base64url');
}

export function decodeWappActivityCursor(raw: string | null | undefined): { occurredAt: Date; id: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as JsonRecord;
    const occurredAt = new Date(text(parsed.occurred_at));
    const id = text(parsed.id);
    return parsed.v === 1 && !Number.isNaN(occurredAt.getTime()) && /^[0-9a-f-]{36}$/i.test(id) ? { occurredAt, id } : null;
  } catch {
    return null;
  }
}
