import { Hono } from 'hono';
import { requireNip98Auth } from '../auth';
import { buildAdminAgentConnectPackage, buildSuperBasedConnectionToken } from '../admin-token';
import { config } from '../config';
import { getDb } from '../db';
import { getInsufficientCreditsBlock, getOperationalBillingOverview } from '../services/billing';
import { generatedFlightDeckPgWorkspaceServiceNpub, setupFlightDeckPgDevWorkspace } from '../services/flightdeck-pg-setup';
import { getTowerProfile, updateTowerProfile } from '../services/tower-profile';
import { measureWorkspaceUsage } from '../services/usage';
import { listWorkspaceApps, listWorkspaceAppSchemaManifests } from '../services/workspace-apps';
import {
  listWorkspaceRecordFamilyMetadata,
  listWorkspaceRecordMetadata,
  listWorkspaceStorageMetadata,
} from '../services/workspace-inspection';
import type { UpdateTowerProfileInput } from '../types';

export const adminRouter = new Hono();

const VIEWER_TABLES = [
  'flightdeck_pg_actors',
  'flightdeck_pg_workspaces',
  'flightdeck_pg_workspace_memberships',
  'flightdeck_pg_groups',
  'flightdeck_pg_group_memberships',
  'flightdeck_pg_group_edges',
  'flightdeck_pg_scopes',
  'flightdeck_pg_channels',
  'flightdeck_pg_permission_definitions',
  'flightdeck_pg_permission_grants',
  'flightdeck_pg_audit_events',
  'flightdeck_pg_storage_links',
  'flightdeck_pg_docs',
  'flightdeck_pg_file_folders',
  'flightdeck_pg_files',
  'flightdeck_pg_audio_notes',
  'flightdeck_pg_messages',
  'flightdeck_pg_threads',
  'flightdeck_pg_reactions',
  'flightdeck_pg_tasks',
  'flightdeck_pg_daily_notes',
  'flightdeck_pg_daily_note_versions',
  'flightdeck_pg_task_assignments',
  'flightdeck_pg_task_comments',
  'flightdeck_pg_task_watchers',
  'flightdeck_pg_outbox_events',
  'v4_workspaces',
  'v4_groups',
  'v4_group_epochs',
  'v4_group_members',
  'v4_group_member_keys',
  'v4_record_checkouts',
  'v4_records',
  'v4_record_group_payloads',
  'v4_storage_objects',
  'user_profiles',
  'user_workspace_keys',
  'workspace_credit_accounts',
  'workspace_credit_transactions',
  'workspace_credit_orders',
  'workspace_usage_hourly_audits',
  'workspace_apps',
  'workspace_app_schema_manifests',
  'workspace_app_schema_group_payloads',
  'workspace_app_rows',
] as const;

type ViewerTableName = (typeof VIEWER_TABLES)[number];
const RESET_CONFIRMATION = 'WIPE V4 DATA';

type FlightDeckPgAdminSetupRequest = {
  workspace_name?: string | null;
  workspace_description?: string | null;
  app_npub?: string | null;
  workspace_service_npub?: string | null;
  workspace_owner_npub?: string | null;
  creator_npub?: string | null;
  smoke_scope_name?: string | null;
  smoke_channel_name?: string | null;
  second_actor_npub?: string | null;
  second_actor_display_name?: string | null;
};

type DeleteWorkspaceRequest = {
  confirmation?: string | null;
  delete_flightdeck_pg?: boolean | null;
  delete_storage_metadata?: boolean | null;
};

type BulkWorkspaceDeleteRequest = {
  workspace_ids?: string[] | null;
  confirmation?: string | null;
  delete_flightdeck_pg?: boolean | null;
  delete_storage_metadata?: boolean | null;
};

type AdminWorkspaceSummary = {
  workspace_id: string;
  workspace_owner_npub: string;
  creator_npub: string;
  name: string;
  description: string;
  default_group_id: string | null;
  default_group_npub: string | null;
  created_at: string;
  updated_at: string;
  backend?: 'encrypted' | 'flightdeck_pg';
};

function isViewerTableName(value: string): value is ViewerTableName {
  return VIEWER_TABLES.includes(value as ViewerTableName);
}

function normalizeLimit(value: string | undefined): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

function normalizeOffset(value: string | undefined): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function defaultOrderBy(table: ViewerTableName, columns: { column_name: string }[] = []): string {
  const columnNames = new Set(columns.map((column) => column.column_name));
  switch (table) {
    case 'v4_workspaces':
      return 'updated_at DESC, created_at DESC';
    case 'v4_records':
      return 'updated_at DESC, version DESC';
    case 'v4_record_group_payloads':
      return 'record_row_id DESC';
    case 'v4_storage_objects':
    case 'workspace_credit_transactions':
    case 'workspace_credit_orders':
    case 'workspace_usage_hourly_audits':
    case 'workspace_apps':
      return 'created_at DESC';
    case 'workspace_credit_accounts':
      return 'updated_at DESC, created_at DESC';
    case 'v4_group_members':
    case 'v4_group_member_keys':
    case 'v4_group_epochs':
      return 'created_at DESC';
    case 'v4_groups':
    default:
      if (columnNames.has('updated_at') && columnNames.has('created_at')) return 'updated_at DESC, created_at DESC';
      if (columnNames.has('created_at')) return 'created_at DESC';
      if (columnNames.has('updated_at')) return 'updated_at DESC';
      if (columnNames.has('id')) return 'id ASC';
      return '1 ASC';
  }
}

function trimBodyString(value: unknown): string {
  return String(value || '').trim();
}

function requireAdminNpub(authNpub: string) {
  if (authNpub !== config.adminNpub) {
    return new Response(JSON.stringify({ error: 'admin npub required' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  return null;
}

async function collectViewerTableCounts(sqlLike: ReturnType<typeof getDb>) {
  const counts: Record<ViewerTableName, number> = {} as Record<ViewerTableName, number>;
  for (const tableName of VIEWER_TABLES) {
    const [countRow] = await sqlLike.unsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM ${tableName}`,
    );
    counts[tableName] = Number.parseInt(countRow?.count || '0', 10);
  }
  return counts;
}

async function countRows(rowsPromise: Promise<{ count: string }[]>) {
  const [row] = await rowsPromise;
  return Number.parseInt(row?.count || '0', 10);
}

async function deleteRows(rowsPromise: Promise<unknown[]>) {
  const rows = await rowsPromise;
  return rows.length;
}

async function collectWorkspaceDeleteCounts(
  sqlLike: ReturnType<typeof getDb>,
  workspace: { workspace_id: string; workspace_owner_npub: string },
  options: { deleteFlightDeckPg: boolean; deleteStorageMetadata: boolean },
) {
  // PG-only workspaces delete exactly themselves; matching by owner npub
  // would sweep up every other PG workspace the same npub owns.
  const fdPgIds = options.deleteFlightDeckPg
    ? (workspace.backend === 'flightdeck_pg'
      ? await sqlLike<{ id: string }[]>`
          SELECT id
          FROM flightdeck_pg_workspaces
          WHERE id = ${workspace.workspace_id}
        `
      : await sqlLike<{ id: string }[]>`
          SELECT id
          FROM flightdeck_pg_workspaces
          WHERE v4_workspace_id = ${workspace.workspace_id}
             OR workspace_owner_npub = ${workspace.workspace_owner_npub}
        `)
    : [];
  const fdPgWorkspaceIds = fdPgIds.map((row) => row.id);

  const counts: Record<string, number> = workspace.backend === 'flightdeck_pg' ? {
    flightdeck_pg_workspaces: fdPgWorkspaceIds.length,
  } : {
    flightdeck_pg_workspaces: fdPgWorkspaceIds.length,
    v4_record_checkouts: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM v4_record_checkouts
      WHERE workspace_service_npub = ${workspace.workspace_owner_npub}
    `),
    v4_records: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM v4_records
      WHERE owner_npub = ${workspace.workspace_owner_npub}
    `),
    v4_record_group_payloads: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM v4_record_group_payloads rgp
      JOIN v4_records r ON r.id = rgp.record_row_id
      WHERE r.owner_npub = ${workspace.workspace_owner_npub}
    `),
    v4_storage_objects: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM v4_storage_objects
      WHERE owner_npub = ${workspace.workspace_owner_npub}
    `),
    v4_groups: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM v4_groups
      WHERE owner_npub = ${workspace.workspace_owner_npub}
    `),
    v4_group_members: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM v4_group_members gm
      JOIN v4_groups g ON g.id = gm.group_id
      WHERE g.owner_npub = ${workspace.workspace_owner_npub}
    `),
    v4_group_member_keys: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM v4_group_member_keys gmk
      JOIN v4_groups g ON g.id = gmk.group_id
      WHERE g.owner_npub = ${workspace.workspace_owner_npub}
    `),
    v4_group_epochs: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM v4_group_epochs ge
      JOIN v4_groups g ON g.id = ge.group_id
      WHERE g.owner_npub = ${workspace.workspace_owner_npub}
    `),
    user_workspace_keys: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM user_workspace_keys
      WHERE workspace_owner_npub = ${workspace.workspace_owner_npub}
    `),
    workspace_apps: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM workspace_apps
      WHERE workspace_owner_npub = ${workspace.workspace_owner_npub}
    `),
    workspace_app_schema_manifests: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM workspace_app_schema_manifests
      WHERE workspace_owner_npub = ${workspace.workspace_owner_npub}
    `),
    workspace_app_rows: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM workspace_app_rows
      WHERE workspace_owner_npub = ${workspace.workspace_owner_npub}
    `),
    workspace_credit_accounts: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM workspace_credit_accounts
      WHERE workspace_owner_npub = ${workspace.workspace_owner_npub}
    `),
    workspace_credit_transactions: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM workspace_credit_transactions
      WHERE workspace_owner_npub = ${workspace.workspace_owner_npub}
    `),
    workspace_credit_orders: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM workspace_credit_orders
      WHERE workspace_owner_npub = ${workspace.workspace_owner_npub}
    `),
    workspace_usage_hourly_audits: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM workspace_usage_hourly_audits
      WHERE workspace_owner_npub = ${workspace.workspace_owner_npub}
    `),
    v4_workspaces: await countRows(sqlLike`
      SELECT COUNT(*)::text AS count
      FROM v4_workspaces
      WHERE id = ${workspace.workspace_id}
    `),
  };

  if (fdPgWorkspaceIds.length > 0) {
    const fdPgTableNames = [
      'flightdeck_pg_outbox_events',
      'flightdeck_pg_reactions',
      'flightdeck_pg_task_assignments',
      'flightdeck_pg_task_watchers',
      'flightdeck_pg_task_comments',
      'flightdeck_pg_messages',
      'flightdeck_pg_daily_note_versions',
      'flightdeck_pg_daily_notes',
      'flightdeck_pg_tasks',
      'flightdeck_pg_threads',
      'flightdeck_pg_audio_notes',
      'flightdeck_pg_files',
      'flightdeck_pg_file_folders',
      'flightdeck_pg_docs',
      'flightdeck_pg_storage_links',
      'flightdeck_pg_audit_events',
      'flightdeck_pg_permission_grants',
      'flightdeck_pg_channels',
      'flightdeck_pg_scopes',
      'flightdeck_pg_group_edges',
      'flightdeck_pg_group_memberships',
      'flightdeck_pg_groups',
      'flightdeck_pg_workspace_memberships',
    ];
    for (const tableName of fdPgTableNames) {
      const [reg] = await sqlLike.unsafe<{ table_name: string | null }[]>(
        `SELECT to_regclass('${tableName}')::text AS table_name`,
      );
      if (!reg?.table_name) continue;
      const [row] = await sqlLike.unsafe<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM ${tableName} WHERE workspace_id = ANY($1::uuid[])`,
        [fdPgWorkspaceIds],
      );
      counts[tableName] = Number.parseInt(row?.count || '0', 10);
    }
  }

  return { counts, fdPgWorkspaceIds };
}

function diffCounts(before: Record<string, number>, after: Record<string, number>) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const deleted: Record<string, number> = {};
  for (const key of keys) {
    deleted[key] = Math.max(0, (before[key] || 0) - (after[key] || 0));
  }
  return deleted;
}

async function deleteFlightDeckPgWorkspaceRows(sqlLike: ReturnType<typeof getDb>, workspaceIds: string[]) {
  const deleted: Record<string, number> = {};
  if (workspaceIds.length === 0) return deleted;

  const tableOrder = [
    'flightdeck_pg_outbox_events',
    'flightdeck_pg_reactions',
    'flightdeck_pg_task_assignments',
    'flightdeck_pg_task_watchers',
    'flightdeck_pg_task_comments',
    'flightdeck_pg_messages',
    'flightdeck_pg_daily_note_versions',
    'flightdeck_pg_daily_notes',
    'flightdeck_pg_tasks',
    'flightdeck_pg_threads',
    'flightdeck_pg_audio_notes',
    'flightdeck_pg_files',
    'flightdeck_pg_file_folders',
    'flightdeck_pg_docs',
    'flightdeck_pg_storage_links',
    'flightdeck_pg_audit_events',
    'flightdeck_pg_permission_grants',
    'flightdeck_pg_channels',
    'flightdeck_pg_scopes',
    'flightdeck_pg_group_edges',
    'flightdeck_pg_group_memberships',
    'flightdeck_pg_groups',
    'flightdeck_pg_workspace_memberships',
    'flightdeck_pg_workspaces',
  ];

  for (const tableName of tableOrder) {
    const [reg] = await sqlLike.unsafe<{ table_name: string | null }[]>(
      `SELECT to_regclass('${tableName}')::text AS table_name`,
    );
    if (!reg?.table_name) continue;
    const rows = await sqlLike.unsafe<{ deleted: number }[]>(
      `DELETE FROM ${tableName} WHERE ${tableName === 'flightdeck_pg_workspaces' ? 'id' : 'workspace_id'} = ANY($1::uuid[]) RETURNING 1 AS deleted`,
      [workspaceIds],
    );
    deleted[tableName] = rows.length;
  }

  return deleted;
}

function normalizeWorkspaceDeleteOptions(body: DeleteWorkspaceRequest | BulkWorkspaceDeleteRequest | null | undefined) {
  return {
    deleteFlightDeckPg: body?.delete_flightdeck_pg !== false,
    deleteStorageMetadata: body?.delete_storage_metadata !== false,
  };
}

function responseWorkspaceDeleteOptions(options: { deleteFlightDeckPg: boolean; deleteStorageMetadata: boolean }) {
  return {
    delete_flightdeck_pg: options.deleteFlightDeckPg,
    delete_storage_metadata: options.deleteStorageMetadata,
  };
}

function normalizeWorkspaceIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function sumDeleteCounts(results: { before?: Record<string, number>; after?: Record<string, number>; deleted?: Record<string, number> }[]) {
  const totals = {
    before: {} as Record<string, number>,
    after: {} as Record<string, number>,
    deleted: {} as Record<string, number>,
  };

  for (const result of results) {
    for (const [key, value] of Object.entries(result.before || {})) totals.before[key] = (totals.before[key] || 0) + value;
    for (const [key, value] of Object.entries(result.after || {})) totals.after[key] = (totals.after[key] || 0) + value;
    for (const [key, value] of Object.entries(result.deleted || {})) totals.deleted[key] = (totals.deleted[key] || 0) + value;
  }

  return totals;
}

async function listAdminFlightDeckPgWorkspaceSummaries(
  sqlLike: ReturnType<typeof getDb>,
  workspaceIds: string[] | null = null,
): Promise<AdminWorkspaceSummary[]> {
  const rows = workspaceIds
    ? (workspaceIds.length === 0
      ? []
      : await sqlLike<AdminWorkspaceSummary[]>`
          SELECT
            w.id AS workspace_id,
            w.workspace_owner_npub,
            COALESCE(creator.npub, '') AS creator_npub,
            w.name,
            COALESCE(w.description, '') AS description,
            w.created_at,
            w.updated_at
          FROM flightdeck_pg_workspaces w
          LEFT JOIN flightdeck_pg_actors creator
            ON creator.id = w.created_by_actor_id
          WHERE w.id IN ${sqlLike(workspaceIds)}
          ORDER BY w.updated_at DESC, w.created_at DESC
        `)
    : await sqlLike<AdminWorkspaceSummary[]>`
        SELECT
          w.id AS workspace_id,
          w.workspace_owner_npub,
          COALESCE(creator.npub, '') AS creator_npub,
          w.name,
          COALESCE(w.description, '') AS description,
          w.created_at,
          w.updated_at
        FROM flightdeck_pg_workspaces w
        LEFT JOIN flightdeck_pg_actors creator
          ON creator.id = w.created_by_actor_id
        ORDER BY w.updated_at DESC, w.created_at DESC
      `;
  return rows.map((row) => ({
    ...row,
    default_group_id: null,
    default_group_npub: null,
    backend: 'flightdeck_pg' as const,
  }));
}

async function getAdminWorkspaceById(sqlLike: ReturnType<typeof getDb>, workspaceId: string) {
  const [workspace] = await sqlLike<AdminWorkspaceSummary[]>`
    SELECT
      w.id AS workspace_id,
      w.workspace_owner_npub,
      w.creator_npub,
      w.name,
      w.description,
      w.default_group_id,
      g.group_npub AS default_group_npub,
      w.created_at,
      w.updated_at
    FROM v4_workspaces w
    LEFT JOIN v4_groups g
      ON g.id = w.default_group_id
    WHERE w.id = ${workspaceId}
    LIMIT 1
  `;

  if (workspace) return { ...workspace, backend: 'encrypted' as const };
  const [pgWorkspace] = await listAdminFlightDeckPgWorkspaceSummaries(sqlLike, [workspaceId]);
  return pgWorkspace || null;
}

async function listAdminWorkspacesByIds(sqlLike: ReturnType<typeof getDb>, workspaceIds: string[]) {
  if (workspaceIds.length === 0) return [];
  const v4Workspaces = await sqlLike<AdminWorkspaceSummary[]>`
    SELECT
      w.id AS workspace_id,
      w.workspace_owner_npub,
      w.creator_npub,
      w.name,
      w.description,
      w.default_group_id,
      g.group_npub AS default_group_npub,
      w.created_at,
      w.updated_at
    FROM v4_workspaces w
    LEFT JOIN v4_groups g
      ON g.id = w.default_group_id
    WHERE w.id IN ${sqlLike(workspaceIds)}
    ORDER BY w.updated_at DESC, w.created_at DESC
  `;
  const foundIds = new Set(v4Workspaces.map((workspace) => workspace.workspace_id));
  const missingIds = workspaceIds.filter((workspaceId) => !foundIds.has(workspaceId));
  const pgWorkspaces = await listAdminFlightDeckPgWorkspaceSummaries(sqlLike, missingIds);
  return [
    ...v4Workspaces.map((workspace) => ({ ...workspace, backend: 'encrypted' as const })),
    ...pgWorkspaces,
  ];
}

async function previewWorkspaceDelete(
  sqlLike: ReturnType<typeof getDb>,
  workspace: AdminWorkspaceSummary,
  options: { deleteFlightDeckPg: boolean; deleteStorageMetadata: boolean },
) {
  const before = await collectWorkspaceDeleteCounts(sqlLike, workspace, options);
  return {
    workspace,
    before: before.counts,
    fd_pg_workspace_ids: before.fdPgWorkspaceIds,
  };
}

async function deleteWorkspaceDatabaseRows(
  sqlLike: ReturnType<typeof getDb>,
  workspace: AdminWorkspaceSummary,
  options: { deleteFlightDeckPg: boolean; deleteStorageMetadata: boolean },
) {
  const before = await collectWorkspaceDeleteCounts(sqlLike, workspace, options);

  const direct_deleted: Record<string, number> = {};
  if (options.deleteFlightDeckPg) {
    Object.assign(direct_deleted, await deleteFlightDeckPgWorkspaceRows(sqlLike, before.fdPgWorkspaceIds));
  }

  // PG-only workspaces own no v4 rows; the owner-npub-keyed deletes below
  // would destroy unrelated legacy data for the same npub.
  if (workspace.backend !== 'flightdeck_pg') {
    direct_deleted.user_workspace_keys = await deleteRows(sqlLike`
      DELETE FROM user_workspace_keys
      WHERE workspace_owner_npub = ${workspace.workspace_owner_npub}
      RETURNING 1
    `);

    direct_deleted.v4_record_checkouts = await deleteRows(sqlLike`
      DELETE FROM v4_record_checkouts
      WHERE workspace_service_npub = ${workspace.workspace_owner_npub}
      RETURNING 1
    `);

    if (options.deleteStorageMetadata) {
      direct_deleted.v4_storage_objects = await deleteRows(sqlLike`
        DELETE FROM v4_storage_objects
        WHERE owner_npub = ${workspace.workspace_owner_npub}
        RETURNING 1
      `);
    }

    direct_deleted.v4_records = await deleteRows(sqlLike`
      DELETE FROM v4_records
      WHERE owner_npub = ${workspace.workspace_owner_npub}
      RETURNING 1
    `);

    direct_deleted.v4_workspaces = await deleteRows(sqlLike`
      DELETE FROM v4_workspaces
      WHERE id = ${workspace.workspace_id}
      RETURNING 1
    `);

    direct_deleted.v4_groups = await deleteRows(sqlLike`
      DELETE FROM v4_groups
      WHERE owner_npub = ${workspace.workspace_owner_npub}
      RETURNING 1
    `);
  }

  const after = await collectWorkspaceDeleteCounts(sqlLike, workspace, options);

  return {
    workspace,
    before: before.counts,
    after: after.counts,
    deleted: diffCounts(before.counts, after.counts),
    direct_deleted,
  };
}

adminRouter.get('/tables', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const sql = getDb();
  const tables = [];

  for (const tableName of VIEWER_TABLES) {
    const columns = await sql.unsafe<{ column_name: string; data_type: string }[]>(
      `
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${tableName}'
        ORDER BY ordinal_position
      `
    );

    const [countRow] = await sql.unsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM ${tableName}`
    );

    tables.push({
      table: tableName,
      row_count: Number.parseInt(countRow?.count || '0', 10),
      columns,
    });
  }

  return c.json({
    viewer: authNpub,
    tables,
  });
});

adminRouter.get('/tables/:table', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const table = c.req.param('table');
  if (!isViewerTableName(table)) {
    return c.json({ error: 'unknown table' }, 404);
  }

  const limit = normalizeLimit(c.req.query('limit'));
  const offset = normalizeOffset(c.req.query('offset'));
  const sql = getDb();

  const columns = await sql.unsafe<{ column_name: string; data_type: string }[]>(
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}'
      ORDER BY ordinal_position
    `
  );

  const [countRow] = await sql.unsafe<{ count: string }[]>(
    `SELECT COUNT(*)::text AS count FROM ${table}`
  );

  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT * FROM ${table} ORDER BY ${defaultOrderBy(table, columns)} LIMIT ${limit} OFFSET ${offset}`
  );

  return c.json({
    viewer: authNpub,
    table,
    row_count: Number.parseInt(countRow?.count || '0', 10),
    limit,
    offset,
    columns,
    rows,
  });
});

adminRouter.get('/workspaces', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const sql = getDb();
  const workspaces = await sql<{
    workspace_id: string;
    workspace_owner_npub: string;
    creator_npub: string;
    name: string;
    description: string;
    default_group_id: string | null;
    default_group_npub: string | null;
    created_at: string;
    updated_at: string;
  }[]>`
    SELECT
      w.id AS workspace_id,
      w.workspace_owner_npub,
      w.creator_npub,
      w.name,
      w.description,
      w.default_group_id,
      g.group_npub AS default_group_npub,
      w.created_at,
      w.updated_at
    FROM v4_workspaces w
    LEFT JOIN v4_groups g
      ON g.id = w.default_group_id
    ORDER BY w.updated_at DESC, w.created_at DESC
  `;

  const pgWorkspaces = await listAdminFlightDeckPgWorkspaceSummaries(sql);
  const merged = [
    ...workspaces.map((workspace) => ({ ...workspace, backend: 'encrypted' as const })),
    ...pgWorkspaces,
  ].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  return c.json({
    viewer: authNpub,
    workspaces: merged,
  });
});

adminRouter.get('/workspaces/:workspaceId/inspect', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const workspaceId = String(c.req.param('workspaceId') || '').trim();
  if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

  const limit = normalizeLimit(c.req.query('limit'));
  const offset = normalizeOffset(c.req.query('offset'));
  const sql = getDb();
  const [workspace] = await sql<{
    workspace_id: string;
    workspace_owner_npub: string;
    creator_npub: string;
    name: string;
    description: string;
    default_group_id: string | null;
    default_group_npub: string | null;
    created_at: string;
    updated_at: string;
  }[]>`
    SELECT
      w.id AS workspace_id,
      w.workspace_owner_npub,
      w.creator_npub,
      w.name,
      w.description,
      w.default_group_id,
      g.group_npub AS default_group_npub,
      w.created_at,
      w.updated_at
    FROM v4_workspaces w
    LEFT JOIN v4_groups g
      ON g.id = w.default_group_id
    WHERE w.id = ${workspaceId}
    LIMIT 1
  `;

  if (!workspace) {
    const [pgWorkspace] = await listAdminFlightDeckPgWorkspaceSummaries(sql, [workspaceId]);
    if (!pgWorkspace) return c.json({ error: 'workspace not found' }, 404);

    const members = await sql<{ npub: string; display_name: string | null; kind: string; role: string }[]>`
      SELECT a.npub, a.display_name, a.kind, m.role
      FROM flightdeck_pg_workspace_memberships m
      JOIN flightdeck_pg_actors a ON a.id = m.actor_id
      WHERE m.workspace_id = ${workspaceId}
      ORDER BY m.created_at ASC
      LIMIT ${limit}
    `;
    const pgCountTables = [
      'flightdeck_pg_workspace_memberships',
      'flightdeck_pg_groups',
      'flightdeck_pg_scopes',
      'flightdeck_pg_channels',
      'flightdeck_pg_permission_grants',
      'flightdeck_pg_threads',
      'flightdeck_pg_messages',
      'flightdeck_pg_tasks',
      'flightdeck_pg_task_comments',
      'flightdeck_pg_docs',
      'flightdeck_pg_files',
      'flightdeck_pg_file_folders',
      'flightdeck_pg_audio_notes',
      'flightdeck_pg_daily_notes',
      'flightdeck_pg_daily_note_versions',
      'flightdeck_pg_reactions',
    ];
    const counts: Record<string, number> = {};
    for (const tableName of pgCountTables) {
      // Some PG tables are provisioned by the runtime schema step and may be
      // absent on minimally-migrated databases; skip rather than fail inspect.
      const [reg] = await sql.unsafe<{ table_name: string | null }[]>(
        `SELECT to_regclass('${tableName}')::text AS table_name`,
      );
      if (!reg?.table_name) continue;
      const [row] = await sql.unsafe<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM ${tableName} WHERE workspace_id = $1`,
        [workspaceId],
      );
      counts[tableName] = Number.parseInt(row?.count || '0', 10);
    }

    return c.json({
      viewer: authNpub,
      workspace: pgWorkspace,
      usage: null,
      pg: { members, counts },
    });
  }

  const [
    usage,
    recordFamilies,
    records,
    storage,
    apps,
    appSchemas,
  ] = await Promise.all([
    measureWorkspaceUsage(workspace.workspace_owner_npub),
    listWorkspaceRecordFamilyMetadata(workspace.workspace_owner_npub),
    listWorkspaceRecordMetadata(workspace.workspace_owner_npub, { limit, offset }),
    listWorkspaceStorageMetadata(workspace.workspace_owner_npub, { limit, offset }),
    listWorkspaceApps(workspace.workspace_owner_npub),
    listWorkspaceAppSchemaManifests(workspace.workspace_owner_npub, authNpub, { latest: true }).catch(() => []),
  ]);

  return c.json({
    viewer: authNpub,
    workspace,
    usage,
    record_families: recordFamilies.families,
    records,
    storage,
    apps,
    app_schemas: appSchemas,
  });
});

adminRouter.post('/workspaces/delete-preview', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const body = await c.req.json<BulkWorkspaceDeleteRequest>().catch(() => null);
  const workspaceIds = normalizeWorkspaceIds(body?.workspace_ids);
  if (workspaceIds.length === 0) return c.json({ error: 'workspace_ids required' }, 400);
  if (workspaceIds.length > 100) return c.json({ error: 'bulk delete preview is limited to 100 workspaces' }, 400);

  const options = normalizeWorkspaceDeleteOptions(body);
  const sql = getDb();
  const workspaces = await listAdminWorkspacesByIds(sql, workspaceIds);
  const foundIds = new Set(workspaces.map((workspace) => workspace.workspace_id));
  const missing_workspace_ids = workspaceIds.filter((workspaceId) => !foundIds.has(workspaceId));
  if (missing_workspace_ids.length > 0) {
    return c.json({ error: 'workspace not found', missing_workspace_ids }, 404);
  }

  const previews = [];
  for (const workspace of workspaces) {
    previews.push(await previewWorkspaceDelete(sql, workspace, options));
  }

  return c.json({
    viewer: authNpub,
    selected_count: workspaces.length,
    confirmation_required: `DELETE ${workspaces.length} WORKSPACES`,
    options: responseWorkspaceDeleteOptions(options),
    workspaces: previews,
    totals: sumDeleteCounts(previews),
    note: 'Preview only. Object-storage blobs are not removed by workspace delete.',
  });
});

adminRouter.post('/workspaces/bulk-delete', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const body = await c.req.json<BulkWorkspaceDeleteRequest>().catch(() => null);
  const workspaceIds = normalizeWorkspaceIds(body?.workspace_ids);
  if (workspaceIds.length === 0) return c.json({ error: 'workspace_ids required' }, 400);
  if (workspaceIds.length > 100) return c.json({ error: 'bulk delete is limited to 100 workspaces' }, 400);

  const options = normalizeWorkspaceDeleteOptions(body);
  const confirmationRequired = `DELETE ${workspaceIds.length} WORKSPACES`;
  const confirmation = trimBodyString(body?.confirmation);
  if (confirmation !== confirmationRequired) {
    return c.json({
      error: 'confirmation must match required phrase',
      confirmation_required: confirmationRequired,
    }, 400);
  }

  const sql = getDb();
  const workspaces = await listAdminWorkspacesByIds(sql, workspaceIds);
  const foundIds = new Set(workspaces.map((workspace) => workspace.workspace_id));
  const missing_workspace_ids = workspaceIds.filter((workspaceId) => !foundIds.has(workspaceId));
  if (missing_workspace_ids.length > 0) {
    return c.json({ error: 'workspace not found', missing_workspace_ids }, 404);
  }

  const results = await sql.begin(async (tx) => {
    const deletedWorkspaces = [];
    for (const workspace of workspaces) {
      deletedWorkspaces.push(await deleteWorkspaceDatabaseRows(tx as ReturnType<typeof getDb>, workspace, options));
    }
    return deletedWorkspaces;
  });

  return c.json({
    viewer: authNpub,
    selected_count: workspaces.length,
    confirmation_required: confirmationRequired,
    options: responseWorkspaceDeleteOptions(options),
    workspaces: results,
    totals: sumDeleteCounts(results),
    note: 'Workspace database rows were deleted in one transaction. Object-storage blobs were not removed from object storage.',
  });
});

adminRouter.delete('/workspaces/:workspaceId', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const workspaceId = String(c.req.param('workspaceId') || '').trim();
  if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

  const body = await c.req.json<DeleteWorkspaceRequest>().catch(() => null);
  const options = normalizeWorkspaceDeleteOptions(body);

  const sql = getDb();
  const workspace = await getAdminWorkspaceById(sql, workspaceId);

  if (!workspace) return c.json({ error: 'workspace not found' }, 404);

  const confirmation = trimBodyString(body?.confirmation);
  if (confirmation !== workspace.workspace_owner_npub) {
    return c.json({
      error: 'confirmation must match workspace_owner_npub',
      confirmation_required: workspace.workspace_owner_npub,
    }, 400);
  }

  const result = await sql.begin((tx) => deleteWorkspaceDatabaseRows(tx as ReturnType<typeof getDb>, workspace, options));

  return c.json({
    viewer: authNpub,
    workspace,
    options: responseWorkspaceDeleteOptions(options),
    ...result,
    note: 'Workspace database rows were deleted. Object-storage blobs were not removed from object storage.',
  });
});

adminRouter.get('/billing/overview', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const overview = await getOperationalBillingOverview();
  return c.json({
    viewer: authNpub,
    ...overview,
  });
});

adminRouter.get('/tower', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const towerProfile = await getTowerProfile();
  return c.json({
    viewer: authNpub,
    direct_https_url: config.directHttpsUrl,
    service_npub: config.service.npub || null,
    tower_name: towerProfile.tower_name,
    tower_description: towerProfile.tower_description,
    updated_at: towerProfile.updated_at,
  });
});

adminRouter.patch('/tower', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const body = await c.req.json<UpdateTowerProfileInput>().catch(() => null);
  const hasTowerName = body?.tower_name !== undefined;
  const hasTowerDescription = body?.tower_description !== undefined;
  if (!hasTowerName && !hasTowerDescription) {
    return c.json({ error: 'tower_name or tower_description required' }, 400);
  }

  const towerProfile = await updateTowerProfile({
    tower_name: hasTowerName ? String(body?.tower_name || '').trim() || null : undefined,
    tower_description: hasTowerDescription ? String(body?.tower_description || '').trim() || null : undefined,
  });

  return c.json({
    viewer: authNpub,
    direct_https_url: config.directHttpsUrl,
    service_npub: config.service.npub || null,
    tower_name: towerProfile.tower_name,
    tower_description: towerProfile.tower_description,
    updated_at: towerProfile.updated_at,
  });
});

adminRouter.get('/workspaces/:workspaceId/connection-token', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const workspaceId = String(c.req.param('workspaceId') || '').trim();
  const appNpub = String(c.req.query('app_npub') || '').trim();
  if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
  if (!appNpub) return c.json({ error: 'app_npub query param required' }, 400);

  const sql = getDb();
  const [workspace] = await sql<{
    workspace_id: string;
    workspace_owner_npub: string;
    creator_npub: string;
    name: string;
    description: string;
    default_group_id: string | null;
    default_group_npub: string | null;
    created_at: string;
    updated_at: string;
  }[]>`
    SELECT
      w.id AS workspace_id,
      w.workspace_owner_npub,
      w.creator_npub,
      w.name,
      w.description,
      w.default_group_id,
      g.group_npub AS default_group_npub,
      w.created_at,
      w.updated_at
    FROM v4_workspaces w
    LEFT JOIN v4_groups g
      ON g.id = w.default_group_id
    WHERE w.id = ${workspaceId}
    LIMIT 1
  `;

  if (!workspace) return c.json({ error: 'workspace not found' }, 404);

  const billingBlock = await getInsufficientCreditsBlock(workspace.workspace_owner_npub);
  if (billingBlock) return c.json(billingBlock, 402);

  const relayUrls = c.req.query('relay')
    ? [String(c.req.query('relay')).trim()].filter(Boolean)
    : [];
  const towerProfile = await getTowerProfile();

  const connectionToken = buildSuperBasedConnectionToken({
    directHttpsUrl: config.directHttpsUrl,
    serviceNpub: config.service.npub || null,
    towerName: towerProfile.tower_name,
    towerDescription: towerProfile.tower_description,
    workspaceOwnerNpub: workspace.workspace_owner_npub,
    appNpub,
    relayUrls,
  });

  const agentConnectPackage = buildAdminAgentConnectPackage({
    directHttpsUrl: config.directHttpsUrl,
    serviceNpub: config.service.npub || null,
    towerName: towerProfile.tower_name,
    towerDescription: towerProfile.tower_description,
    workspaceOwnerNpub: workspace.workspace_owner_npub,
    appNpub,
    relayUrls,
  });

  return c.json({
    viewer: authNpub,
    workspace,
    app_npub: appNpub,
    direct_https_url: config.directHttpsUrl,
    service_npub: config.service.npub || null,
    tower_name: towerProfile.tower_name,
    tower_description: towerProfile.tower_description,
    connection_token: connectionToken,
    agent_connect_package: agentConnectPackage,
  });
});

adminRouter.post('/flightdeck-pg/workspaces', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const body = await c.req.json<FlightDeckPgAdminSetupRequest>().catch(() => null);
  const workspaceName = trimBodyString(body?.workspace_name);
  if (!workspaceName) {
    return c.json({ error: 'workspace_name required' }, 400);
  }
  const creatorNpub = trimBodyString(body?.creator_npub);
  if (!creatorNpub) return c.json({ error: 'creator_npub required' }, 400);
  const secondActorNpub = trimBodyString(body?.second_actor_npub);
  const secondActorDisplayName = trimBodyString(body?.second_actor_display_name);
  if ((secondActorNpub && !secondActorDisplayName) || (!secondActorNpub && secondActorDisplayName)) {
    return c.json({ error: 'second_actor_npub and second_actor_display_name must be provided together' }, 400);
  }

  const origin = new URL(c.req.url).origin;
  const appNpub = trimBodyString(body?.app_npub) || config.flightDeck.appNpub;
  const workspaceOwnerNpub = trimBodyString(body?.workspace_owner_npub) || authNpub;
  const result = await setupFlightDeckPgDevWorkspace({
    workspaceName,
    workspaceDescription: trimBodyString(body?.workspace_description) || null,
    appNpub,
    workspaceServiceNpub: trimBodyString(body?.workspace_service_npub) || generatedFlightDeckPgWorkspaceServiceNpub(`${workspaceOwnerNpub}:${appNpub}:${workspaceName}`),
    workspaceOwnerNpub,
    creatorNpub,
    smokeScopeName: trimBodyString(body?.smoke_scope_name) || null,
    smokeChannelName: trimBodyString(body?.smoke_channel_name) || null,
    secondActorNpub,
    secondActorDisplayName,
    towerBaseUrl: origin,
  });

  return c.json({
    viewer: authNpub,
    ...result,
  });
});

adminRouter.post('/reset-database', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;
  const adminError = requireAdminNpub(authNpub);
  if (adminError) return adminError;

  const body = await c.req.json<{ confirmation?: string }>().catch(() => null);
  const confirmation = String(body?.confirmation || '').trim();
  if (confirmation !== RESET_CONFIRMATION) {
    return c.json({
      error: `confirmation must equal "${RESET_CONFIRMATION}"`,
    }, 400);
  }

  const sql = getDb();
  const before = await collectViewerTableCounts(sql);
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `TRUNCATE TABLE ${VIEWER_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
    );
  });
  const after = await collectViewerTableCounts(sql);

  return c.json({
    viewer: authNpub,
    confirmation_required: RESET_CONFIRMATION,
    reset_tables: [...VIEWER_TABLES],
    before,
    after,
    note: 'Tower database rows were deleted. Storage blobs were not removed from object storage.',
  });
});
