import { createHash, randomUUID } from 'crypto';
import { getDb } from '../db';
import { config } from '../config';
import { splitSqlStatements } from '../schema/sql-statements';
import type {
  CreateWappDbTableRowInput,
  CreateWorkspaceAppRowInput,
  QueryWappDbTableRowsInput,
  RunWappDbMigrationsInput,
  UpdateWappDbTableRowInput,
  UpdateWorkspaceAppRowInput,
  WappDbMigrationRecord,
  WappDbNamespace,
  WappDbNamespaceDescriptor,
  WorkspaceAppRow,
  WorkspaceAppRowResponse,
  WorkspaceAppRowVisibility,
} from '../types';

type DbClient = ReturnType<typeof getDb>;

export class AppDbError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'AppDbError';
    this.code = code;
    this.status = status;
  }
}

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const VALID_MIGRATION_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const WAPP_DB_RESERVED_TABLES = new Set(['schema_migrations']);
const VISIBILITIES = new Set<WorkspaceAppRowVisibility>(['private', 'group', 'workspace']);
const WAPP_DB_LIMITS = {
  max_tables: 100,
  max_columns_per_table: 100,
  max_query_limit: 500,
  statement_timeout_ms: 30000,
};
const WAPP_DB_CAPABILITIES = {
  migrations: true,
  crud: true,
  query: true,
  public_app_data: true,
};

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function serializeRow(row: WorkspaceAppRow): WorkspaceAppRowResponse {
  return {
    id: row.id,
    workspace_owner_npub: row.workspace_owner_npub,
    app_npub: row.app_npub,
    collection: row.collection,
    row_id: row.row_id,
    owner_npub: row.owner_npub,
    visibility: row.visibility,
    group_id: row.group_id,
    data: row.data,
    metadata: row.metadata || {},
    created_by_npub: row.created_by_npub,
    updated_by_npub: row.updated_by_npub,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  };
}

function normalizeCollection(collection: string): string {
  const normalized = String(collection || '').trim();
  if (!VALID_NAME.test(normalized)) {
    throw new AppDbError('bad_collection', 400, 'collection must be 1-128 chars of letters, numbers, dot, underscore, colon, or dash');
  }
  return normalized;
}

function normalizeRowId(rowId: string): string {
  const normalized = String(rowId || '').trim();
  if (!normalized || normalized.length > 256 || normalized.includes('/')) {
    throw new AppDbError('bad_row_id', 400, 'row_id must be 1-256 chars and cannot contain /');
  }
  return normalized;
}

function normalizeVisibility(value: unknown): WorkspaceAppRowVisibility {
  const normalized = String(value || 'private').trim() as WorkspaceAppRowVisibility;
  if (!VISIBILITIES.has(normalized)) {
    throw new AppDbError('bad_visibility', 400, 'visibility must be private, group, or workspace');
  }
  return normalized;
}

function normalizeJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (Array.isArray(value) || typeof value !== 'object') {
    throw new AppDbError('bad_json_object', 400, `${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function normalizeJsonValue(value: unknown): unknown {
  return value === undefined ? {} : value;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizeIdentifier(value: string, field: string): string {
  const normalized = String(value || '').trim();
  if (!VALID_IDENTIFIER.test(normalized)) {
    throw new AppDbError(`bad_${field}`, 400, `${field} must be a safe SQL identifier`);
  }
  return normalized;
}

function normalizeMigrationVersion(value: string): string {
  const normalized = String(value || '').trim();
  if (!VALID_MIGRATION_VERSION.test(normalized)) {
    throw new AppDbError('bad_migration_version', 400, 'migration version must be 1-128 chars of letters, numbers, dot, underscore, colon, or dash');
  }
  return normalized;
}

function normalizeChecksum(value: string): string {
  const normalized = String(value || '').trim();
  if (!/^sha256:[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new AppDbError('bad_migration_checksum', 400, 'migration checksum must be sha256:<64 hex chars>');
  }
  return `sha256:${normalized.slice('sha256:'.length).toLowerCase()}`;
}

function checksumSql(sqlText: string): string {
  return `sha256:${createHash('sha256').update(sqlText, 'utf8').digest('hex')}`;
}

function normalizeAppSlug(value: unknown, appNpub: string): string {
  const fallback = `app_${createHash('sha256').update(appNpub).digest('hex').slice(0, 8)}`;
  const raw = String(value || fallback).trim().toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 32);
  return /^[a-z][a-z0-9_]{0,31}$/.test(slug) ? slug : fallback;
}

function buildSchemaName(workspaceOwnerNpub: string, appNpub: string, appSlug: string): string {
  const hash = createHash('sha256')
    .update(`${workspaceOwnerNpub}:${appNpub}`)
    .digest('hex')
    .slice(0, 12);
  return `wapp_${normalizeAppSlug(appSlug, appNpub)}_${hash}`.slice(0, 63);
}

function rowToNamespace(row: WappDbNamespace): WappDbNamespace {
  return {
    ...row,
    metadata: row.metadata || {},
  };
}

function serializeMigration(row: WappDbMigrationRecord) {
  return {
    version: row.version,
    checksum: row.checksum,
    applied_at: toIsoString(row.applied_at),
  };
}

function migrationTableSql(schemaName: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${quoteIdent(schemaName)}.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

function normalizeSqlIdentifierPart(part: string): string {
  const trimmed = part.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function parseSqlIdentifierPath(value: string): string[] {
  return value.split('.').map(normalizeSqlIdentifierPart);
}

function assertNotReservedMigrationTarget(target: string, schemaName: string) {
  const parts = parseSqlIdentifierPath(target);
  const objectName = parts[parts.length - 1];
  if (parts.length > 2) {
    throw new AppDbError('migration_schema_forbidden', 400, 'migration may only reference the allocated app schema');
  }
  if (parts.length === 2 && parts[0] !== schemaName) {
    throw new AppDbError('migration_schema_forbidden', 400, 'migration may only reference the allocated app schema');
  }
  if (WAPP_DB_RESERVED_TABLES.has(objectName)) {
    throw new AppDbError('migration_reserved_object', 400, 'migration may not modify Tower-managed migration history');
  }
}

function assertNoReservedMigrationTargets(statement: string, schemaName: string) {
  const ident = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*))?`;
  const targetMatch =
    statement.match(new RegExp(String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${ident})\b`, 'i'))
    || statement.match(new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${ident})\b`, 'i'))
    || statement.match(new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${ident}\s+ON\s+(?:ONLY\s+)?(${ident})\b`, 'i'));
  if (targetMatch?.[1]) {
    assertNotReservedMigrationTarget(targetMatch[1].replace(/\s*\.\s*/g, '.'), schemaName);
    return;
  }

  const dropTableMatch = statement.match(new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(.+?)(?:\s+(?:CASCADE|RESTRICT))?$`, 'i'));
  if (!dropTableMatch?.[1]) return;

  for (const target of dropTableMatch[1].split(',')) {
    const trimmed = target.trim();
    if (trimmed) assertNotReservedMigrationTarget(trimmed.replace(/\s*\.\s*/g, '.'), schemaName);
  }
}

function sqlIdentifierPattern(): string {
  return String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*))?`;
}

function normalizeSqlIdentifierPath(value: string): string[] {
  return parseSqlIdentifierPath(value.replace(/\s*\.\s*/g, '.'));
}

function assertPlainCreateTableStatement(statement: string, schemaName: string) {
  const ident = sqlIdentifierPattern();
  const match = statement.match(new RegExp(String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${ident})\s*(.*)$`, 'i'));
  if (!match) return;

  const target = match[1];
  const remainder = match[2].trim();
  assertNotReservedMigrationTarget(target.replace(/\s*\.\s*/g, '.'), schemaName);
  if (!remainder.startsWith('(')) {
    throw new AppDbError('migration_statement_unsupported', 400, 'migration statement is not supported in v1');
  }
  if (/\b(AS\s+SELECT|SELECT|LIKE|INHERITS|PARTITION\s+OF)\b/i.test(remainder)) {
    throw new AppDbError('migration_statement_forbidden', 400, 'migration contains a forbidden statement');
  }
}

function assertNoCrossSchemaReferences(statement: string, schemaName: string) {
  const ident = sqlIdentifierPattern();
  const referencePattern = new RegExp(String.raw`\bREFERENCES\s+(${ident})\b`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = referencePattern.exec(statement))) {
    const parts = normalizeSqlIdentifierPath(match[1]);
    if (parts.length !== 2 || parts[0] !== schemaName) {
      throw new AppDbError('migration_schema_forbidden', 400, 'migration may only reference the allocated app schema');
    }
    assertNotReservedMigrationTarget(match[1], schemaName);
  }
}

function assertAppSigner(appNpub: string, signerNpub: string) {
  if (signerNpub !== appNpub) {
    throw new AppDbError('app_signer_required', 403, 'request must be signed by the registered app npub');
  }
}

function assertDescriptorSigner(appNpub: string, signerNpub: string) {
  const adminNpub = String(config.adminNpub || '').trim();
  const serviceNpub = String(config.service.npub || '').trim();
  if (signerNpub === appNpub || (adminNpub && signerNpub === adminNpub) || (serviceNpub && signerNpub === serviceNpub)) {
    return;
  }
  throw new AppDbError('app_or_admin_signer_required', 403, 'request must be signed by the app, Tower admin, or Tower service identity');
}

async function requireRegisteredApp(sql: DbClient, workspaceOwnerNpub: string, appNpub: string) {
  const [app] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM workspace_apps
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      AND app_npub = ${appNpub}
      AND enabled = true
    LIMIT 1
  `;
  if (!app?.ok) {
    throw new AppDbError('app_not_found', 404, 'workspace app not found');
  }
}

async function getNamespace(
  sql: DbClient,
  workspaceOwnerNpub: string,
  appNpub: string,
): Promise<WappDbNamespace | null> {
  const [namespace] = await sql<WappDbNamespace[]>`
    SELECT *
    FROM workspace_app_db_namespaces
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      AND app_npub = ${appNpub}
    LIMIT 1
  `;
  return namespace ? rowToNamespace(namespace) : null;
}

async function requireNamespace(sql: DbClient, workspaceOwnerNpub: string, appNpub: string): Promise<WappDbNamespace> {
  await requireRegisteredApp(sql, workspaceOwnerNpub, appNpub);
  const namespace = await getNamespace(sql, workspaceOwnerNpub, appNpub);
  if (!namespace) {
    throw new AppDbError('namespace_not_provisioned', 404, 'app database namespace not provisioned');
  }
  return namespace;
}

export async function getWappDbDescriptor(
  workspaceOwnerNpub: string,
  appNpub: string,
  signerNpub: string,
): Promise<WappDbNamespaceDescriptor> {
  const sql = getDb();
  assertDescriptorSigner(appNpub, signerNpub);
  await requireRegisteredApp(sql, workspaceOwnerNpub, appNpub);
  const namespace = await getNamespace(sql, workspaceOwnerNpub, appNpub);
  if (!namespace) {
    throw new AppDbError('namespace_not_provisioned', 404, 'app database namespace not provisioned');
  }
  return {
    workspace_owner_npub: workspaceOwnerNpub,
    app_npub: appNpub,
    schema_name: namespace.schema_name,
    capabilities: WAPP_DB_CAPABILITIES,
    limits: WAPP_DB_LIMITS,
  };
}

export async function provisionWappDbNamespace(
  workspaceOwnerNpub: string,
  appNpub: string,
  input: { app_slug?: unknown } | null,
  signerNpub: string,
): Promise<WappDbNamespaceDescriptor> {
  const sql = getDb();
  assertDescriptorSigner(appNpub, signerNpub);
  await requireRegisteredApp(sql, workspaceOwnerNpub, appNpub);
  const appSlug = normalizeAppSlug(input?.app_slug, appNpub);
  const schemaName = buildSchemaName(workspaceOwnerNpub, appNpub, appSlug);

  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
    await tx.unsafe(migrationTableSql(schemaName));
    await tx`
      INSERT INTO workspace_app_db_namespaces (
        workspace_owner_npub,
        app_npub,
        schema_name,
        app_slug,
        provisioned_by_npub,
        metadata
      )
      VALUES (
        ${workspaceOwnerNpub},
        ${appNpub},
        ${schemaName},
        ${appSlug},
        ${signerNpub},
        ${tx.json({} as any)}
      )
      ON CONFLICT (workspace_owner_npub, app_npub)
      DO UPDATE SET updated_at = NOW()
    `;
  });

  return getWappDbDescriptor(workspaceOwnerNpub, appNpub, signerNpub);
}

function assertAllowedMigrationStatement(statement: string, schemaName: string) {
  const compact = statement.replace(/\s+/g, ' ').trim();
  if (!compact) return;
  const forbidden = /\b(CREATE\s+EXTENSION|CREATE\s+DATABASE|DROP\s+DATABASE|CREATE\s+ROLE|ALTER\s+ROLE|DROP\s+ROLE|GRANT|REVOKE|DROP\s+SCHEMA|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|ALTER\s+FUNCTION|DROP\s+FUNCTION|CREATE\s+TRIGGER|ALTER\s+TRIGGER|DROP\s+TRIGGER|CALL|DO)\b/i;
  if (forbidden.test(compact)) {
    throw new AppDbError('migration_statement_forbidden', 400, 'migration contains a forbidden statement');
  }
  const allowed = /^(CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX|CREATE\s+SEQUENCE|ALTER\s+SEQUENCE|DROP\s+TABLE)\b/i;
  if (!allowed.test(compact)) {
    throw new AppDbError('migration_statement_unsupported', 400, 'migration statement is not supported in v1');
  }
  assertPlainCreateTableStatement(compact, schemaName);
  assertNoCrossSchemaReferences(compact, schemaName);
  assertNoReservedMigrationTargets(compact, schemaName);
  const schemaRef = /(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*\./g;
  let match: RegExpExecArray | null;
  while ((match = schemaRef.exec(compact))) {
    const referencedSchema = match[1] || match[2];
    if (referencedSchema !== schemaName) {
      throw new AppDbError('migration_schema_forbidden', 400, 'migration may only reference the allocated app schema');
    }
  }
}

export async function runWappDbMigrations(
  workspaceOwnerNpub: string,
  appNpub: string,
  input: RunWappDbMigrationsInput,
  signerNpub: string,
) {
  const sql = getDb();
  assertAppSigner(appNpub, signerNpub);
  const namespace = await requireNamespace(sql, workspaceOwnerNpub, appNpub);
  if (!Array.isArray(input?.migrations) || input.migrations.length < 1) {
    throw new AppDbError('bad_migrations', 400, 'migrations must be a non-empty array');
  }
  if (input.migrations.length > 50) {
    throw new AppDbError('too_many_migrations', 400, 'at most 50 migrations can be applied per request');
  }

  const applied = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${WAPP_DB_LIMITS.statement_timeout_ms}`);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${namespace.schema_name}))`;
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(namespace.schema_name)}`);
    await tx.unsafe(migrationTableSql(namespace.schema_name));
    await tx.unsafe(`SET LOCAL search_path TO ${quoteIdent(namespace.schema_name)}`);

    const appliedRows: ReturnType<typeof serializeMigration>[] = [];
    for (const migrationInput of input.migrations) {
      const version = normalizeMigrationVersion(migrationInput?.version);
      const checksum = normalizeChecksum(migrationInput?.checksum);
      const sqlText = String(migrationInput?.sql || '');
      if (!sqlText.trim()) throw new AppDbError('bad_migration_sql', 400, 'migration sql required');
      if (checksumSql(sqlText) !== checksum) {
        throw new AppDbError('migration_checksum_invalid', 400, 'migration checksum does not match sql');
      }

      const [existing] = await tx<WappDbMigrationRecord[]>`
        SELECT version, checksum, applied_at
        FROM ${tx(namespace.schema_name)}.schema_migrations
        WHERE version = ${version}
        LIMIT 1
      `;
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new AppDbError('migration_checksum_conflict', 409, 'migration version already applied with a different checksum');
        }
        appliedRows.push(serializeMigration(existing));
        continue;
      }

      const statements = splitSqlStatements(sqlText);
      if (statements.length < 1) throw new AppDbError('bad_migration_sql', 400, 'migration sql required');
      for (const statement of statements) {
        assertAllowedMigrationStatement(statement, namespace.schema_name);
        await tx.unsafe(statement);
      }

      const [record] = await tx<WappDbMigrationRecord[]>`
        INSERT INTO ${tx(namespace.schema_name)}.schema_migrations (version, checksum)
        VALUES (${version}, ${checksum})
        RETURNING version, checksum, applied_at
      `;
      appliedRows.push(serializeMigration(record));
    }
    return appliedRows;
  });

  return {
    workspace_owner_npub: workspaceOwnerNpub,
    app_npub: appNpub,
    schema_name: namespace.schema_name,
    applied,
  };
}

export async function listWappDbMigrations(workspaceOwnerNpub: string, appNpub: string, signerNpub: string) {
  const sql = getDb();
  assertDescriptorSigner(appNpub, signerNpub);
  const namespace = await requireNamespace(sql, workspaceOwnerNpub, appNpub);
  const rows = await sql<WappDbMigrationRecord[]>`
    SELECT version, checksum, applied_at
    FROM ${sql(namespace.schema_name)}.schema_migrations
    ORDER BY applied_at ASC, version ASC
  `;
  return {
    workspace_owner_npub: workspaceOwnerNpub,
    app_npub: appNpub,
    schema_name: namespace.schema_name,
    migrations: rows.map(serializeMigration),
  };
}

function sqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value;
}

function normalizeLimitNumber(value: unknown, fallback = 100): number {
  const parsed = Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : fallback, 1), WAPP_DB_LIMITS.max_query_limit);
}

function normalizeOffsetNumber(value: unknown): number {
  const parsed = Number(value);
  return Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : 0, 0);
}

function buildWhereClause(input: QueryWappDbTableRowsInput, params: unknown[]): string {
  const where = input.where || {};
  if (Array.isArray(where) || typeof where !== 'object') {
    throw new AppDbError('bad_where', 400, 'where must be an object');
  }
  const clauses: string[] = [];
  for (const [fieldInput, condition] of Object.entries(where)) {
    const field = quoteIdent(normalizeIdentifier(fieldInput, 'field'));
    if (Array.isArray(condition) || typeof condition !== 'object' || condition === null) {
      throw new AppDbError('bad_where_condition', 400, 'where conditions must be objects');
    }
    const entries = Object.entries(condition as Record<string, unknown>);
    if (entries.length !== 1) throw new AppDbError('bad_where_condition', 400, 'each where field must have exactly one operator');
    const [op, value] = entries[0];
    if (op === 'is_null') {
      clauses.push(`${field} IS ${value ? '' : 'NOT '}NULL`);
      continue;
    }
    if (op === 'in') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
        throw new AppDbError('bad_where_in', 400, 'in operator requires 1-100 values');
      }
      const placeholders = value.map((item) => {
        params.push(sqlValue(item));
        return `$${params.length}`;
      });
      clauses.push(`${field} IN (${placeholders.join(', ')})`);
      continue;
    }
    params.push(sqlValue(value));
    const placeholder = `$${params.length}`;
    if (op === 'eq') clauses.push(`${field} = ${placeholder}`);
    else if (op === 'neq') clauses.push(`${field} <> ${placeholder}`);
    else if (op === 'lt') clauses.push(`${field} < ${placeholder}`);
    else if (op === 'lte') clauses.push(`${field} <= ${placeholder}`);
    else if (op === 'gt') clauses.push(`${field} > ${placeholder}`);
    else if (op === 'gte') clauses.push(`${field} >= ${placeholder}`);
    else if (op === 'contains') clauses.push(`${field} @> ${placeholder}::jsonb`);
    else throw new AppDbError('bad_where_operator', 400, 'unsupported where operator');
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

export async function createWappDbTableRow(
  workspaceOwnerNpub: string,
  appNpub: string,
  tableInput: string,
  input: CreateWappDbTableRowInput,
  signerNpub: string,
) {
  const sql = getDb();
  assertAppSigner(appNpub, signerNpub);
  const namespace = await requireNamespace(sql, workspaceOwnerNpub, appNpub);
  const table = normalizeIdentifier(tableInput, 'table');
  const data = normalizeJsonObject(input?.data, 'data');
  const id = input?.id === undefined ? randomUUID() : String(input.id || '').trim();
  if (!id || id.length > 256 || id.includes('/')) throw new AppDbError('bad_id', 400, 'id must be 1-256 chars and cannot contain /');
  const fields = { ...data, id };
  const columns = Object.keys(fields).map((field) => normalizeIdentifier(field, 'field'));
  const params = Object.values(fields).map(sqlValue);
  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const query = `INSERT INTO ${quoteIdent(namespace.schema_name)}.${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders}) RETURNING *`;
  try {
    const [row] = await sql.unsafe(query, params);
    return { workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, schema_name: namespace.schema_name, table, row };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as any).code) : '';
    if (code === '23505') throw new AppDbError('row_conflict', 409, 'row already exists');
    if (code === '42P01') throw new AppDbError('table_not_found', 404, 'table not found');
    throw error;
  }
}

export async function queryWappDbTableRows(
  workspaceOwnerNpub: string,
  appNpub: string,
  tableInput: string,
  input: QueryWappDbTableRowsInput,
  signerNpub: string,
) {
  const sql = getDb();
  assertAppSigner(appNpub, signerNpub);
  const namespace = await requireNamespace(sql, workspaceOwnerNpub, appNpub);
  const table = normalizeIdentifier(tableInput, 'table');
  const select = Array.isArray(input?.select) && input.select.length
    ? input.select.map((field) => quoteIdent(normalizeIdentifier(field, 'field'))).join(', ')
    : '*';
  const params: unknown[] = [];
  const whereClause = buildWhereClause(input || {}, params);
  const order = Array.isArray(input?.order) ? input.order : [];
  const orderClause = order.length
    ? `ORDER BY ${order.map((entry) => {
        const field = quoteIdent(normalizeIdentifier(entry?.field, 'field'));
        const dir = String(entry?.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        return `${field} ${dir}`;
      }).join(', ')}`
    : '';
  const limit = normalizeLimitNumber(input?.limit);
  const offset = normalizeOffsetNumber(input?.offset);
  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;
  const query = `SELECT ${select} FROM ${quoteIdent(namespace.schema_name)}.${quoteIdent(table)} ${whereClause} ${orderClause} LIMIT ${limitParam} OFFSET ${offsetParam}`;
  try {
    const rows = await sql.unsafe(query, params);
    return { workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, schema_name: namespace.schema_name, table, rows };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as any).code) : '';
    if (code === '42P01') throw new AppDbError('table_not_found', 404, 'table not found');
    throw error;
  }
}

export async function getWappDbTableRow(
  workspaceOwnerNpub: string,
  appNpub: string,
  tableInput: string,
  idInput: string,
  signerNpub: string,
) {
  const result = await queryWappDbTableRows(workspaceOwnerNpub, appNpub, tableInput, {
    where: { id: { eq: idInput } },
    limit: 1,
  }, signerNpub);
  return {
    workspace_owner_npub: result.workspace_owner_npub,
    app_npub: result.app_npub,
    schema_name: result.schema_name,
    table: result.table,
    row: result.rows[0] || null,
  };
}

export async function updateWappDbTableRow(
  workspaceOwnerNpub: string,
  appNpub: string,
  tableInput: string,
  idInput: string,
  input: UpdateWappDbTableRowInput,
  signerNpub: string,
) {
  const sql = getDb();
  assertAppSigner(appNpub, signerNpub);
  const namespace = await requireNamespace(sql, workspaceOwnerNpub, appNpub);
  const table = normalizeIdentifier(tableInput, 'table');
  const id = String(idInput || '').trim();
  if (!id || id.length > 256 || id.includes('/')) throw new AppDbError('bad_id', 400, 'id must be 1-256 chars and cannot contain /');
  const set = normalizeJsonObject(input?.set, 'set');
  if (Object.prototype.hasOwnProperty.call(set, 'id')) {
    throw new AppDbError('bad_set', 400, 'id cannot be changed');
  }
  const entries = Object.entries(set);
  if (!entries.length) throw new AppDbError('bad_set', 400, 'set must include at least one field');
  const params = entries.map(([, value]) => sqlValue(value));
  const assignments = entries.map(([field], index) => `${quoteIdent(normalizeIdentifier(field, 'field'))} = $${index + 1}`);
  params.push(id);
  const query = `UPDATE ${quoteIdent(namespace.schema_name)}.${quoteIdent(table)} SET ${assignments.join(', ')} WHERE "id" = $${params.length} RETURNING *`;
  try {
    const [row] = await sql.unsafe(query, params);
    return { workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, schema_name: namespace.schema_name, table, row: row || null };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as any).code) : '';
    if (code === '42P01') throw new AppDbError('table_not_found', 404, 'table not found');
    throw error;
  }
}

export async function deleteWappDbTableRow(
  workspaceOwnerNpub: string,
  appNpub: string,
  tableInput: string,
  idInput: string,
  signerNpub: string,
) {
  const sql = getDb();
  assertAppSigner(appNpub, signerNpub);
  const namespace = await requireNamespace(sql, workspaceOwnerNpub, appNpub);
  const table = normalizeIdentifier(tableInput, 'table');
  const id = String(idInput || '').trim();
  if (!id || id.length > 256 || id.includes('/')) throw new AppDbError('bad_id', 400, 'id must be 1-256 chars and cannot contain /');
  try {
    const [row] = await sql.unsafe(`DELETE FROM ${quoteIdent(namespace.schema_name)}.${quoteIdent(table)} WHERE "id" = $1 RETURNING id`, [id]);
    return { workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, schema_name: namespace.schema_name, table, id, deleted: Boolean(row) };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as any).code) : '';
    if (code === '42P01') throw new AppDbError('table_not_found', 404, 'table not found');
    throw error;
  }
}

async function isWorkspaceMember(sql: DbClient, workspaceOwnerNpub: string, userNpub: string): Promise<boolean> {
  const [membership] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM v4_workspaces w
    LEFT JOIN v4_groups g
      ON g.owner_npub = w.workspace_owner_npub
    LEFT JOIN v4_group_members gm
      ON gm.group_id = g.id
     AND gm.member_npub = ${userNpub}
    WHERE w.workspace_owner_npub = ${workspaceOwnerNpub}
      AND (w.creator_npub = ${userNpub} OR gm.member_npub IS NOT NULL)
    LIMIT 1
  `;
  return membership?.ok === 1;
}

async function isGroupMember(
  sql: DbClient,
  workspaceOwnerNpub: string,
  groupId: string | null | undefined,
  userNpub: string,
): Promise<boolean> {
  if (!groupId) return false;
  const [membership] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM v4_groups g
    JOIN v4_group_members gm
      ON gm.group_id = g.id
     AND gm.member_npub = ${userNpub}
    WHERE g.owner_npub = ${workspaceOwnerNpub}
      AND g.id = ${groupId}
    LIMIT 1
  `;
  return membership?.ok === 1;
}

async function assertWorkspaceMember(sql: DbClient, workspaceOwnerNpub: string, userNpub: string) {
  if (!(await isWorkspaceMember(sql, workspaceOwnerNpub, userNpub))) {
    throw new AppDbError('workspace_forbidden', 403, 'not a current member of this workspace');
  }
}

async function assertCanUseVisibility(
  sql: DbClient,
  workspaceOwnerNpub: string,
  userNpub: string,
  visibility: WorkspaceAppRowVisibility,
  groupId: string | null | undefined,
) {
  if (visibility === 'group') {
    if (!groupId) throw new AppDbError('group_id_required', 400, 'group_id required for group visibility');
    if (!(await isGroupMember(sql, workspaceOwnerNpub, groupId, userNpub))) {
      throw new AppDbError('group_forbidden', 403, 'not a current member of this group');
    }
    return;
  }

  await assertWorkspaceMember(sql, workspaceOwnerNpub, userNpub);
}

async function canWriteRow(sql: DbClient, row: WorkspaceAppRow, userNpub: string): Promise<boolean> {
  if (row.owner_npub === userNpub) return true;
  if (row.visibility === 'group') {
    return isGroupMember(sql, row.workspace_owner_npub, row.group_id, userNpub);
  }
  if (row.visibility === 'workspace') {
    return isWorkspaceMember(sql, row.workspace_owner_npub, userNpub);
  }
  return false;
}

function visibleRowCondition(sql: DbClient, viewerNpub: string) {
  return sql`
    (
      r.owner_npub = ${viewerNpub}
      OR (
        r.visibility = 'group'
        AND EXISTS (
          SELECT 1
          FROM v4_group_members gm
          WHERE gm.group_id = r.group_id
            AND gm.member_npub = ${viewerNpub}
        )
      )
      OR (
        r.visibility = 'workspace'
        AND EXISTS (
          SELECT 1
          FROM v4_groups g
          JOIN v4_group_members gm
            ON gm.group_id = g.id
           AND gm.member_npub = ${viewerNpub}
          WHERE g.owner_npub = r.workspace_owner_npub
        )
      )
    )
  `;
}

export async function createWorkspaceAppRow(
  workspaceOwnerNpub: string,
  appNpub: string,
  collectionInput: string,
  input: CreateWorkspaceAppRowInput,
  userNpub: string,
): Promise<WorkspaceAppRowResponse> {
  const sql = getDb();
  const collection = normalizeCollection(collectionInput);
  const rowId = input.row_id ? normalizeRowId(input.row_id) : randomUUID();
  const ownerNpub = String(input.owner_npub || userNpub).trim();
  if (ownerNpub !== userNpub) {
    throw new AppDbError('owner_forbidden', 403, 'owner_npub must match authenticated user');
  }
  const visibility = normalizeVisibility(input.visibility);
  const groupId = visibility === 'group' ? String(input.group_id || '').trim() : null;
  const data = normalizeJsonValue(input.data);
  const metadata = normalizeJsonObject(input.metadata, 'metadata');

  await requireRegisteredApp(sql, workspaceOwnerNpub, appNpub);
  await assertCanUseVisibility(sql, workspaceOwnerNpub, userNpub, visibility, groupId);

  try {
    const [row] = await sql<WorkspaceAppRow[]>`
      INSERT INTO workspace_app_rows (
        workspace_owner_npub,
        app_npub,
        collection,
        row_id,
        owner_npub,
        visibility,
        group_id,
        data,
        metadata,
        created_by_npub,
        updated_by_npub
      )
      VALUES (
        ${workspaceOwnerNpub},
        ${appNpub},
        ${collection},
        ${rowId},
        ${ownerNpub},
        ${visibility},
        ${groupId},
        ${sql.json(data as any)},
        ${sql.json(metadata as any)},
        ${userNpub},
        ${userNpub}
      )
      RETURNING *
    `;
    return serializeRow(row);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as any).code) : '';
    if (code === '23505') {
      throw new AppDbError('row_conflict', 409, 'row already exists');
    }
    throw error;
  }
}

export async function listWorkspaceAppRows(
  workspaceOwnerNpub: string,
  appNpub: string,
  collectionInput: string,
  userNpub: string,
  options: {
    limit?: number;
    offset?: number;
    owner_npub?: string;
    visibility?: WorkspaceAppRowVisibility;
    group_id?: string;
  } = {},
): Promise<WorkspaceAppRowResponse[]> {
  const sql = getDb();
  const collection = normalizeCollection(collectionInput);
  const limit = Math.min(Math.max(Number.isFinite(options.limit) ? Math.trunc(Number(options.limit)) : 100, 1), 500);
  const offset = Math.max(Number.isFinite(options.offset) ? Math.trunc(Number(options.offset)) : 0, 0);
  const ownerNpub = String(options.owner_npub || '').trim();
  const visibility = options.visibility ? normalizeVisibility(options.visibility) : '';
  const groupId = String(options.group_id || '').trim();

  await requireRegisteredApp(sql, workspaceOwnerNpub, appNpub);
  await assertWorkspaceMember(sql, workspaceOwnerNpub, userNpub);

  const rows = await sql<WorkspaceAppRow[]>`
    SELECT r.*
    FROM workspace_app_rows r
    WHERE r.workspace_owner_npub = ${workspaceOwnerNpub}
      AND r.app_npub = ${appNpub}
      AND r.collection = ${collection}
      AND (${ownerNpub || null}::text IS NULL OR r.owner_npub = ${ownerNpub || null})
      AND (${visibility || null}::text IS NULL OR r.visibility = ${visibility || null})
      AND (${groupId || null}::uuid IS NULL OR r.group_id = ${groupId || null})
      AND ${visibleRowCondition(sql, userNpub)}
    ORDER BY r.updated_at DESC, r.created_at DESC, r.row_id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows.map(serializeRow);
}

export async function getWorkspaceAppRow(
  workspaceOwnerNpub: string,
  appNpub: string,
  collectionInput: string,
  rowIdInput: string,
  userNpub: string,
): Promise<WorkspaceAppRowResponse | null> {
  const sql = getDb();
  const collection = normalizeCollection(collectionInput);
  const rowId = normalizeRowId(rowIdInput);

  await requireRegisteredApp(sql, workspaceOwnerNpub, appNpub);
  await assertWorkspaceMember(sql, workspaceOwnerNpub, userNpub);

  const [row] = await sql<WorkspaceAppRow[]>`
    SELECT r.*
    FROM workspace_app_rows r
    WHERE r.workspace_owner_npub = ${workspaceOwnerNpub}
      AND r.app_npub = ${appNpub}
      AND r.collection = ${collection}
      AND r.row_id = ${rowId}
      AND ${visibleRowCondition(sql, userNpub)}
    LIMIT 1
  `;
  return row ? serializeRow(row) : null;
}

export async function updateWorkspaceAppRow(
  workspaceOwnerNpub: string,
  appNpub: string,
  collectionInput: string,
  rowIdInput: string,
  input: UpdateWorkspaceAppRowInput,
  userNpub: string,
): Promise<WorkspaceAppRowResponse | null> {
  const sql = getDb();
  const collection = normalizeCollection(collectionInput);
  const rowId = normalizeRowId(rowIdInput);

  await requireRegisteredApp(sql, workspaceOwnerNpub, appNpub);
  await assertWorkspaceMember(sql, workspaceOwnerNpub, userNpub);

  const [current] = await sql<WorkspaceAppRow[]>`
    SELECT *
    FROM workspace_app_rows
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      AND app_npub = ${appNpub}
      AND collection = ${collection}
      AND row_id = ${rowId}
    LIMIT 1
  `;
  if (!current) return null;
  if (!(await canWriteRow(sql, current, userNpub))) return null;

  const nextVisibility = input.visibility === undefined ? current.visibility : normalizeVisibility(input.visibility);
  const nextGroupId = nextVisibility === 'group'
    ? String(input.group_id === undefined ? current.group_id || '' : input.group_id || '').trim()
    : null;
  await assertCanUseVisibility(sql, workspaceOwnerNpub, userNpub, nextVisibility, nextGroupId);

  const nextData = input.data === undefined ? current.data : normalizeJsonValue(input.data);
  const nextMetadata = input.metadata === undefined ? current.metadata || {} : normalizeJsonObject(input.metadata, 'metadata');

  const [updated] = await sql<WorkspaceAppRow[]>`
    UPDATE workspace_app_rows
    SET visibility = ${nextVisibility},
        group_id = ${nextGroupId},
        data = ${sql.json(nextData as any)},
        metadata = ${sql.json(nextMetadata as any)},
        updated_by_npub = ${userNpub},
        updated_at = NOW()
    WHERE id = ${current.id}
    RETURNING *
  `;
  return serializeRow(updated);
}

export async function deleteWorkspaceAppRow(
  workspaceOwnerNpub: string,
  appNpub: string,
  collectionInput: string,
  rowIdInput: string,
  userNpub: string,
): Promise<boolean> {
  const sql = getDb();
  const collection = normalizeCollection(collectionInput);
  const rowId = normalizeRowId(rowIdInput);

  await requireRegisteredApp(sql, workspaceOwnerNpub, appNpub);
  await assertWorkspaceMember(sql, workspaceOwnerNpub, userNpub);

  const [current] = await sql<WorkspaceAppRow[]>`
    SELECT *
    FROM workspace_app_rows
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      AND app_npub = ${appNpub}
      AND collection = ${collection}
      AND row_id = ${rowId}
    LIMIT 1
  `;
  if (!current) return false;
  if (!(await canWriteRow(sql, current, userNpub))) return false;

  await sql`
    DELETE FROM workspace_app_rows
    WHERE id = ${current.id}
  `;
  return true;
}
