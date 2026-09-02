import { buildAdminAgentConnectPackage, buildSuperBasedConnectionToken } from '../admin-token';
import { config } from '../config';
import { getDb } from '../db';
import type {
  GroupPayloadInput,
  WorkspaceApp,
  WorkspaceAppNamespaceDescriptor,
  WorkspaceAppSchemaFamily,
  WorkspaceAppSchemaGroupPayload,
  WorkspaceAppSchemaManifest,
  WorkspaceAppSchemaResponse,
} from '../types';
import { getTowerProfile } from './tower-profile';

type DbClient = ReturnType<typeof getDb>;

function toIsoString(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeSchemaFamilies(value: unknown): WorkspaceAppSchemaFamily[] {
  if (!Array.isArray(value)) return [];
  const families: WorkspaceAppSchemaFamily[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const recordFamilyHash = String(source.record_family_hash || '').trim();
    if (!recordFamilyHash || seen.has(recordFamilyHash)) continue;
    seen.add(recordFamilyHash);
    const parsedVersion = Number(source.schema_version);
    const schemaVersion = Number.isInteger(parsedVersion) && parsedVersion > 0 ? parsedVersion : 1;
    const family: WorkspaceAppSchemaFamily = {
      record_family_hash: recordFamilyHash,
      schema_version: schemaVersion,
    };
    const collectionSpace = String(source.collection_space || '').trim();
    const schemaHash = String(source.schema_hash || '').trim();
    const title = String(source.title || '').trim();
    const summary = String(source.summary || '').trim();
    if (collectionSpace) family.collection_space = collectionSpace;
    if (schemaHash) family.schema_hash = schemaHash;
    if (title) family.title = title;
    if (summary) family.summary = summary;
    families.push(family);
  }
  return families;
}

function normalizeAppCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const capabilities: string[] = [];
  for (const item of value) {
    const capability = String(item || '').trim();
    if (!capability || seen.has(capability)) continue;
    if (!/^[a-z][a-z0-9_.:-]*$/.test(capability)) continue;
    seen.add(capability);
    capabilities.push(capability);
  }
  return capabilities;
}

const collectionCapabilityMap: Record<string, string> = {
  scope: 'pg_scopes',
  scopes: 'pg_scopes',
  channel: 'pg_channels',
  channels: 'pg_channels',
  task: 'pg_tasks',
  tasks: 'pg_tasks',
  daily_note: 'pg_daily_notes',
  daily_notes: 'pg_daily_notes',
  dailynote: 'pg_daily_notes',
  dailynotes: 'pg_daily_notes',
  comment: 'pg_comments',
  comments: 'pg_comments',
  chat: 'pg_chat',
  message: 'pg_chat',
  messages: 'pg_chat',
};

function inferCapabilitiesFromFamilies(families: WorkspaceAppSchemaFamily[]): string[] {
  const inferred = new Set<string>();
  for (const family of families) {
    const candidates = [
      family.collection_space,
      family.record_family_hash.includes(':') ? family.record_family_hash.split(':').pop() : '',
    ];
    for (const candidate of candidates) {
      const normalized = String(candidate || '').trim().toLowerCase();
      const capability = collectionCapabilityMap[normalized];
      if (capability) inferred.add(capability);
    }
  }
  return [...inferred].sort();
}

async function resolveSchemaPayloadGroup(
  sql: DbClient,
  workspaceOwnerNpub: string,
  payload: GroupPayloadInput,
) {
  const groupId = String(payload.group_id || '').trim();
  if (groupId) {
    const targetEpoch = Number.isInteger(payload.group_epoch) ? payload.group_epoch : null;
    const rows = targetEpoch == null
      ? await sql<{ group_id: string; group_npub: string; epoch: number }[]>`
          SELECT ge.group_id, ge.group_npub, ge.epoch
          FROM v4_group_epochs ge
          JOIN v4_groups g
            ON g.id = ge.group_id
          WHERE ge.group_id = ${groupId}
            AND g.owner_npub = ${workspaceOwnerNpub}
          ORDER BY ge.epoch DESC
          LIMIT 1
        `
      : await sql<{ group_id: string; group_npub: string; epoch: number }[]>`
          SELECT ge.group_id, ge.group_npub, ge.epoch
          FROM v4_group_epochs ge
          JOIN v4_groups g
            ON g.id = ge.group_id
          WHERE ge.group_id = ${groupId}
            AND ge.epoch = ${targetEpoch}
            AND g.owner_npub = ${workspaceOwnerNpub}
          LIMIT 1
        `;
    return rows[0] ?? null;
  }

  const groupNpub = String(payload.group_npub || '').trim();
  if (!groupNpub) return null;
  const [row] = await sql<{ group_id: string; group_npub: string; epoch: number }[]>`
    SELECT ge.group_id, ge.group_npub, ge.epoch
    FROM v4_group_epochs ge
    JOIN v4_groups g
      ON g.id = ge.group_id
    WHERE ge.group_npub = ${groupNpub}
      AND g.owner_npub = ${workspaceOwnerNpub}
    LIMIT 1
  `;
  return row ?? null;
}

async function buildSchemaResponses(
  sql: DbClient,
  rows: (WorkspaceAppSchemaManifest & { app_name: string })[],
): Promise<WorkspaceAppSchemaResponse[]> {
  if (rows.length === 0) return [];
  const manifestIds = rows.map((row) => row.id);
  const payloads = await sql<WorkspaceAppSchemaGroupPayload[]>`
    SELECT *
    FROM workspace_app_schema_group_payloads
    WHERE manifest_id IN ${sql(manifestIds)}
    ORDER BY id ASC
  `;
  const payloadsByManifest = new Map<string, WorkspaceAppSchemaGroupPayload[]>();
  for (const payload of payloads) {
    const existing = payloadsByManifest.get(payload.manifest_id);
    if (existing) existing.push(payload);
    else payloadsByManifest.set(payload.manifest_id, [payload]);
  }

  return rows.map((row) => ({
    id: row.id,
    workspace_owner_npub: row.workspace_owner_npub,
    app_npub: row.app_npub,
    app_name: row.app_name,
    schema_hash: row.schema_hash,
    schema_version: row.schema_version,
    record_families: normalizeSchemaFamilies(row.record_families),
    owner_payload: { ciphertext: row.owner_ciphertext },
    group_payloads: (payloadsByManifest.get(row.id) || []).map((payload) => ({
      group_id: payload.group_id ?? undefined,
      group_epoch: payload.group_epoch ?? undefined,
      group_npub: payload.group_npub,
      ciphertext: payload.ciphertext,
      write: payload.can_write,
    })),
    created_by_npub: row.created_by_npub,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  }));
}

export async function listWorkspaceApps(workspaceOwnerNpub: string): Promise<WorkspaceApp[]> {
  return getDb()<WorkspaceApp[]>`
    SELECT *
    FROM workspace_apps
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
    ORDER BY created_at DESC
  `;
}

export async function createWorkspaceApp(
  workspaceOwnerNpub: string,
  appNpub: string,
  appName: string,
  createdByNpub: string,
  options: { capabilities?: unknown; enabled?: boolean } = {},
): Promise<WorkspaceApp> {
  const normalizedName = String(appName || '').trim() || appNpub;
  const hasCapabilities = Array.isArray(options.capabilities);
  const hasEnabled = typeof options.enabled === 'boolean';
  const capabilities = normalizeAppCapabilities(options.capabilities);
  const sql = getDb();
  const [app] = await sql<WorkspaceApp[]>`
    INSERT INTO workspace_apps (workspace_owner_npub, app_npub, app_name, enabled, capabilities, created_by_npub)
    VALUES (
      ${workspaceOwnerNpub},
      ${appNpub},
      ${normalizedName},
      ${hasEnabled ? options.enabled === true : true},
      ${sql.json(capabilities)},
      ${createdByNpub}
    )
    ON CONFLICT (workspace_owner_npub, app_npub)
    DO UPDATE SET
      app_name = EXCLUDED.app_name,
      enabled = CASE WHEN ${hasEnabled} THEN EXCLUDED.enabled ELSE workspace_apps.enabled END,
      capabilities = CASE WHEN ${hasCapabilities} THEN EXCLUDED.capabilities ELSE workspace_apps.capabilities END,
      updated_at = NOW()
    RETURNING *
  `;
  return app;
}

export async function getWorkspaceApp(workspaceOwnerNpub: string, appNpub: string): Promise<WorkspaceApp | null> {
  const [app] = await getDb()<WorkspaceApp[]>`
    SELECT *
    FROM workspace_apps
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      AND app_npub = ${appNpub}
    LIMIT 1
  `;
  return app || null;
}

export async function publishWorkspaceAppSchemaManifest(
  workspaceOwnerNpub: string,
  appNpub: string,
  input: {
    app_name?: string;
    schema_hash: string;
    schema_version?: number;
    capabilities?: unknown;
    record_families?: unknown;
    owner_payload: { ciphertext: string };
    group_payloads?: GroupPayloadInput[];
  },
  createdByNpub: string,
): Promise<WorkspaceAppSchemaResponse> {
  const schemaHash = String(input.schema_hash || '').trim();
  const ownerCiphertext = String(input.owner_payload?.ciphertext || '').trim();
  if (!schemaHash) throw Object.assign(new Error('schema_hash required'), { code: 'BAD_SCHEMA_INPUT' });
  if (!ownerCiphertext) throw Object.assign(new Error('owner_payload.ciphertext required'), { code: 'BAD_SCHEMA_INPUT' });
  const schemaVersionValue = Number(input.schema_version);
  const schemaVersion = Number.isInteger(schemaVersionValue) && schemaVersionValue > 0 ? schemaVersionValue : 1;
  const recordFamilies = normalizeSchemaFamilies(input.record_families || []);
  if (recordFamilies.length === 0) throw Object.assign(new Error('record_families required'), { code: 'BAD_SCHEMA_INPUT' });
  const inputCapabilities = normalizeAppCapabilities(input.capabilities);
  const capabilities = inputCapabilities.length > 0 ? inputCapabilities : inferCapabilitiesFromFamilies(recordFamilies);

  const sql = getDb();
  return sql.begin(async (tx) => {
    const appName = String(input.app_name || '').trim() || appNpub;
    await tx`
      INSERT INTO workspace_apps (workspace_owner_npub, app_npub, app_name, enabled, capabilities, created_by_npub)
      VALUES (${workspaceOwnerNpub}, ${appNpub}, ${appName}, true, ${tx.json(capabilities)}, ${createdByNpub})
      ON CONFLICT (workspace_owner_npub, app_npub)
      DO UPDATE SET
        app_name = EXCLUDED.app_name,
        enabled = true,
        capabilities = EXCLUDED.capabilities,
        updated_at = NOW()
    `;

    const [manifest] = await tx<WorkspaceAppSchemaManifest[]>`
      INSERT INTO workspace_app_schema_manifests (
        workspace_owner_npub,
        app_npub,
        schema_hash,
        schema_version,
        record_families,
        owner_ciphertext,
        created_by_npub
      )
      VALUES (
        ${workspaceOwnerNpub},
        ${appNpub},
        ${schemaHash},
        ${schemaVersion},
        ${tx.json(recordFamilies)},
        ${ownerCiphertext},
        ${createdByNpub}
      )
      ON CONFLICT (workspace_owner_npub, app_npub, schema_hash)
      DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        record_families = EXCLUDED.record_families,
        owner_ciphertext = EXCLUDED.owner_ciphertext,
        updated_at = NOW()
      RETURNING *
    `;

    await tx`
      DELETE FROM workspace_app_schema_group_payloads
      WHERE manifest_id = ${manifest.id}
    `;

    const groupPayloads = input.group_payloads || [];
    for (const payload of groupPayloads) {
      const ciphertext = String(payload.ciphertext || '').trim();
      if (!ciphertext) continue;
      const resolved = await resolveSchemaPayloadGroup(tx, workspaceOwnerNpub, payload);
      if (!resolved) {
        throw Object.assign(new Error(`schema group payload does not resolve to a workspace group: ${payload.group_id || payload.group_npub || ''}`), {
          code: 'BAD_SCHEMA_GROUP',
        });
      }
      await tx`
        INSERT INTO workspace_app_schema_group_payloads (
          manifest_id,
          group_id,
          group_epoch,
          group_npub,
          ciphertext,
          can_write
        )
        VALUES (
          ${manifest.id},
          ${resolved.group_id},
          ${resolved.epoch},
          ${resolved.group_npub},
          ${ciphertext},
          ${payload.write === true}
        )
      `;
    }

    const [row] = await tx<(WorkspaceAppSchemaManifest & { app_name: string })[]>`
      SELECT m.*, a.app_name
      FROM workspace_app_schema_manifests m
      JOIN workspace_apps a
        ON a.workspace_owner_npub = m.workspace_owner_npub
       AND a.app_npub = m.app_npub
      WHERE m.id = ${manifest.id}
      LIMIT 1
    `;
    return (await buildSchemaResponses(tx, [row]))[0];
  });
}

export async function listWorkspaceAppSchemaManifests(
  workspaceOwnerNpub: string,
  viewerNpub: string,
  options: { app_npub?: string; latest?: boolean } = {},
): Promise<WorkspaceAppSchemaResponse[]> {
  const sql = getDb();
  const appNpub = String(options.app_npub || '').trim();
  const latest = options.latest !== false;
  const rows = latest
    ? await sql<(WorkspaceAppSchemaManifest & { app_name: string })[]>`
        WITH visible_manifests AS (
          SELECT m.*, a.app_name
          FROM workspace_app_schema_manifests m
          JOIN workspace_apps a
            ON a.workspace_owner_npub = m.workspace_owner_npub
           AND a.app_npub = m.app_npub
          WHERE m.workspace_owner_npub = ${workspaceOwnerNpub}
            AND (${appNpub || null}::text IS NULL OR m.app_npub = ${appNpub || null})
            AND (
              ${viewerNpub} = m.workspace_owner_npub
              OR EXISTS (
                SELECT 1
                FROM workspace_app_schema_group_payloads gp
                JOIN v4_group_member_keys gmk
                  ON gmk.group_id = gp.group_id
                 AND gmk.key_version = gp.group_epoch
                 AND gmk.member_npub = ${viewerNpub}
                 AND gmk.revoked_at IS NULL
                WHERE gp.manifest_id = m.id
              )
            )
        )
        SELECT DISTINCT ON (app_npub) *
        FROM visible_manifests
        ORDER BY app_npub, schema_version DESC, updated_at DESC
      `
    : await sql<(WorkspaceAppSchemaManifest & { app_name: string })[]>`
        SELECT m.*, a.app_name
        FROM workspace_app_schema_manifests m
        JOIN workspace_apps a
          ON a.workspace_owner_npub = m.workspace_owner_npub
         AND a.app_npub = m.app_npub
        WHERE m.workspace_owner_npub = ${workspaceOwnerNpub}
          AND (${appNpub || null}::text IS NULL OR m.app_npub = ${appNpub || null})
          AND (
            ${viewerNpub} = m.workspace_owner_npub
            OR EXISTS (
              SELECT 1
              FROM workspace_app_schema_group_payloads gp
              JOIN v4_group_member_keys gmk
                ON gmk.group_id = gp.group_id
               AND gmk.key_version = gp.group_epoch
               AND gmk.member_npub = ${viewerNpub}
               AND gmk.revoked_at IS NULL
              WHERE gp.manifest_id = m.id
            )
          )
        ORDER BY m.app_npub ASC, m.schema_version DESC, m.updated_at DESC
      `;

  return buildSchemaResponses(sql, rows);
}

export async function buildWorkspaceAppConnectionDetails(
  workspaceOwnerNpub: string,
  appNpub: string,
  relayUrls: string[] = [],
) {
  const towerProfile = await getTowerProfile();
  const connectionToken = buildSuperBasedConnectionToken({
    directHttpsUrl: config.directHttpsUrl,
    serviceNpub: config.service.npub || null,
    towerName: towerProfile.tower_name,
    towerDescription: towerProfile.tower_description,
    workspaceOwnerNpub,
    appNpub,
    relayUrls,
  });
  const agentConnectPackage = buildAdminAgentConnectPackage({
    directHttpsUrl: config.directHttpsUrl,
    serviceNpub: config.service.npub || null,
    towerName: towerProfile.tower_name,
    towerDescription: towerProfile.tower_description,
    workspaceOwnerNpub,
    appNpub,
    relayUrls,
  });

  return {
    app_npub: appNpub,
    workspace_owner_npub: workspaceOwnerNpub,
    workspace_service_npub: workspaceOwnerNpub,
    direct_https_url: config.directHttpsUrl,
    service_npub: config.service.npub || null,
    tower_name: towerProfile.tower_name,
    tower_description: towerProfile.tower_description,
    connection_token: connectionToken,
    agent_connect_package: agentConnectPackage,
  };
}

export async function buildWorkspaceAppNamespaceDescriptor(
  workspaceOwnerNpub: string,
  appNpub: string,
): Promise<WorkspaceAppNamespaceDescriptor> {
  const sql = getDb();
  const [workspace] = await sql<{ id: string }[]>`
    SELECT id
    FROM v4_workspaces
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
    LIMIT 1
  `;
  const [app] = await sql<WorkspaceApp[]>`
    SELECT *
    FROM workspace_apps
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      AND app_npub = ${appNpub}
    LIMIT 1
  `;
  const [latestSchema] = app
    ? await sql<(WorkspaceAppSchemaManifest & { app_name: string })[]>`
        SELECT m.*, a.app_name
        FROM workspace_app_schema_manifests m
        JOIN workspace_apps a
          ON a.workspace_owner_npub = m.workspace_owner_npub
         AND a.app_npub = m.app_npub
        WHERE m.workspace_owner_npub = ${workspaceOwnerNpub}
          AND m.app_npub = ${appNpub}
        ORDER BY m.schema_version DESC, m.updated_at DESC
        LIMIT 1
      `
    : [];
  const recordFamilies = latestSchema ? normalizeSchemaFamilies(latestSchema.record_families) : [];
  const configuredCapabilities = normalizeAppCapabilities(app?.capabilities || []);
  const capabilities = app?.enabled
    ? (configuredCapabilities.length > 0 ? configuredCapabilities : inferCapabilitiesFromFamilies(recordFamilies))
    : [];
  const enabled = Boolean(app?.enabled && latestSchema);
  const createdAt = app?.created_at ? Math.floor(new Date(app.created_at).getTime() / 1000) : null;

  return {
    type: 'wingman_workspace_locator',
    version: 1,
    installed: Boolean(app),
    enabled,
    app_npub: appNpub,
    app_name: app?.app_name || null,
    tower_base_url: config.directHttpsUrl,
    tower_service_npub: config.service.npub || null,
    service_npub: config.service.npub || null,
    workspace_service_npub: workspaceOwnerNpub,
    workspace_owner_npub: workspaceOwnerNpub,
    workspace_id: workspace?.id || null,
    schema_version: latestSchema?.schema_version ?? null,
    schema_hash: latestSchema?.schema_hash ?? null,
    capabilities,
    created_at: createdAt,
  };
}
