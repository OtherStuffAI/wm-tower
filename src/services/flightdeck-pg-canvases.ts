import { getDb } from '../db';
import { createHash } from 'node:crypto';
import type {
  FlightDeckPgCanvas,
  FlightDeckPgCanvasLayout,
  FlightDeckPgCanvasNaplet,
  FlightDeckPgCanvasSourceType,
  FlightDeckPgCanvasViewport,
  FlightDeckPgCanvasVisibilityMode,
  FlightDeckPgWorkspaceRole,
} from '../types';
import { authorizeFlightDeckPgOperation } from './flightdeck-pg-authorization';
import {
  listFlightDeckPgChannelMessages,
  listFlightDeckPgChannelTasks,
  resolveFlightDeckPgDoc,
  resolveFlightDeckPgFile,
  resolveFlightDeckPgFileVersion,
  resolveFlightDeckPgThread,
} from './flightdeck-pg-api';
import { getStorageObjectContent } from './storage';

type DbClient = ReturnType<typeof getDb>;

type CanvasVisibility = {
  mode: FlightDeckPgCanvasVisibilityMode;
  actor_ids: string[];
  group_ids: string[];
};

export type FlightDeckPgCanvasView = FlightDeckPgCanvas & {
  actor_ids: string[];
  group_ids: string[];
  can_manage: boolean;
};

export type CanvasReadyNaplet = {
  id: string;
  access: 'ready';
  layout: FlightDeckPgCanvasLayout;
  source: { type: FlightDeckPgCanvasSourceType; id: string };
  title: string;
  content: Record<string, unknown>;
  row_version: number;
};

export type CanvasDeniedNaplet = {
  id: string;
  access: 'denied';
  layout: FlightDeckPgCanvasLayout;
  row_version: number;
};

export class FlightDeckPgCanvasConflictError extends Error {
  constructor(message = 'Canvas row_version is stale') {
    super(message);
    this.name = 'FlightDeckPgCanvasConflictError';
  }
}

export class FlightDeckPgCanvasValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlightDeckPgCanvasValidationError';
  }
}

export function flightDeckPgCanvasCanManage(input: { actorId: string; creatorActorId: string; canManageWorkspace: boolean }) {
  return input.canManageWorkspace || input.actorId === input.creatorActorId;
}

export function flightDeckPgCanvasIsVisible(input: {
  mode: FlightDeckPgCanvasVisibilityMode;
  actorId: string;
  groupIds: string[];
  creatorActorId: string;
  actorIds: string[];
  visibleGroupIds: string[];
  canManageWorkspace: boolean;
}) {
  return input.mode === 'workspace'
    || flightDeckPgCanvasCanManage(input)
    || input.actorIds.includes(input.actorId)
    || input.visibleGroupIds.some((groupId) => input.groupIds.includes(groupId));
}

export function assertCompleteFlightDeckPgCanvasOrder(currentIds: string[], requestedIds: string[]) {
  if (new Set(requestedIds).size !== requestedIds.length
    || currentIds.length !== requestedIds.length
    || currentIds.some((id) => !requestedIds.includes(id))) {
    throw new FlightDeckPgCanvasConflictError('Canvas visibility changed; refresh before reordering');
  }
}

export function requireFlightDeckPgCanvasMutation<T>(row: T | null | undefined, message = 'Canvas row_version is stale'): T {
  if (!row) throw new FlightDeckPgCanvasConflictError(message);
  return row;
}

function asJson(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeFlightDeckPgCanvasViewport(value: unknown): FlightDeckPgCanvasViewport {
  const viewport = asJson(value);
  return {
    x: Math.round(finite(viewport.x, 0)),
    y: Math.round(finite(viewport.y, 0)),
    scale: Math.max(0.2, Math.min(3, finite(viewport.scale, 1))),
  };
}

export function normalizeFlightDeckPgCanvasLayout(value: unknown): FlightDeckPgCanvasLayout {
  const layout = asJson(value);
  return {
    x: Math.round(finite(layout.x, 0)),
    y: Math.round(finite(layout.y, 0)),
    width: Math.max(220, Math.min(1200, Math.round(finite(layout.width, 360)))),
    height: Math.max(160, Math.min(1000, Math.round(finite(layout.height, 280)))),
    z: Math.max(1, Math.min(100000, Math.round(finite(layout.z, 1)))),
  };
}

export function serializeFlightDeckPgCanvas(canvas: FlightDeckPgCanvasView) {
  return {
    id: canvas.id,
    title: canvas.title,
    position: Number(canvas.position),
    visibility: {
      mode: canvas.visibility_mode,
      actor_ids: [...canvas.actor_ids].sort(),
      group_ids: [...canvas.group_ids].sort(),
    },
    viewport: normalizeFlightDeckPgCanvasViewport(canvas.viewport),
    row_version: Number(canvas.row_version),
    created_at: canvas.created_at,
    updated_at: canvas.updated_at,
    can_manage: canvas.can_manage,
  };
}

export function deniedFlightDeckPgCanvasNaplet(naplet: Pick<FlightDeckPgCanvasNaplet, 'id' | 'layout' | 'row_version'>): CanvasDeniedNaplet {
  return {
    id: naplet.id,
    access: 'denied',
    layout: normalizeFlightDeckPgCanvasLayout(naplet.layout),
    row_version: Number(naplet.row_version),
  };
}

function groupFilter(groupIds: string[]) {
  return groupIds.length ? groupIds : ['00000000-0000-0000-0000-000000000000'];
}

async function lockFlightDeckPgCanvasVisibilitySet(workspaceId: string, sql: DbClient) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:canvas-visible-set`}, 0))`;
}

export async function listVisibleFlightDeckPgCanvases(
  input: {
    workspaceId: string;
    actorId: string;
    groupIds: string[];
    workspaceRole: FlightDeckPgWorkspaceRole;
    canManageWorkspace: boolean;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgCanvasView[]> {
  const groups = groupFilter(input.groupIds);
  return sql<FlightDeckPgCanvasView[]>`
    SELECT
      c.*,
      COALESCE(o.position, c.position)::integer AS position,
      COALESCE(array_agg(DISTINCT vp.principal_actor_id::text)
        FILTER (WHERE vp.principal_actor_id IS NOT NULL), ARRAY[]::text[]) AS actor_ids,
      COALESCE(array_agg(DISTINCT vp.principal_group_id::text)
        FILTER (WHERE vp.principal_group_id IS NOT NULL), ARRAY[]::text[]) AS group_ids,
      (${input.canManageWorkspace} OR c.created_by_actor_id = ${input.actorId})::boolean AS can_manage
    FROM flightdeck_pg_canvases c
    LEFT JOIN flightdeck_pg_canvas_visibility_principals vp
      ON vp.workspace_id = c.workspace_id AND vp.canvas_id = c.id
    LEFT JOIN flightdeck_pg_canvas_orders o
      ON o.workspace_id = c.workspace_id AND o.canvas_id = c.id AND o.viewer_actor_id = ${input.actorId}
    WHERE c.workspace_id = ${input.workspaceId}
      AND c.deleted_at IS NULL
      AND (
        c.visibility_mode = 'workspace'
        OR ${input.canManageWorkspace}
        OR c.created_by_actor_id = ${input.actorId}
        OR EXISTS (
          SELECT 1 FROM flightdeck_pg_canvas_visibility_principals visible
          WHERE visible.workspace_id = c.workspace_id AND visible.canvas_id = c.id
            AND (
              (visible.principal_type = 'actor' AND visible.principal_actor_id = ${input.actorId})
              OR (visible.principal_type = 'group' AND visible.principal_group_id IN ${sql(groups)})
            )
        )
      )
    GROUP BY c.id, o.position
    ORDER BY COALESCE(o.position, c.position), c.id
  `;
}

export async function resolveVisibleFlightDeckPgCanvas(
  input: Parameters<typeof listVisibleFlightDeckPgCanvases>[0] & { canvasId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgCanvasView | null> {
  const canvases = await listVisibleFlightDeckPgCanvases(input, sql);
  return canvases.find((canvas) => canvas.id === input.canvasId) ?? null;
}

export async function validateFlightDeckPgCanvasVisibility(
  workspaceId: string,
  visibility: CanvasVisibility,
  sql: DbClient = getDb(),
) {
  const actorIds = [...new Set(visibility.actor_ids)];
  const groupIds = [...new Set(visibility.group_ids)];
  if (visibility.mode === 'workspace' && (actorIds.length || groupIds.length)) {
    throw new FlightDeckPgCanvasValidationError('workspace visibility cannot include actor_ids or group_ids');
  }
  if (visibility.mode === 'restricted' && actorIds.length + groupIds.length === 0) {
    throw new FlightDeckPgCanvasValidationError('restricted visibility requires at least one actor_id or group_id');
  }
  if (actorIds.length) {
    const actors = await sql<{ actor_id: string }[]>`
      SELECT actor_id FROM flightdeck_pg_workspace_memberships
      WHERE workspace_id = ${workspaceId} AND actor_id IN ${sql(actorIds)}
    `;
    if (actors.length !== actorIds.length) throw new FlightDeckPgCanvasValidationError('visibility contains an actor outside this workspace');
  }
  if (groupIds.length) {
    const groups = await sql<{ id: string }[]>`
      SELECT id FROM flightdeck_pg_groups
      WHERE workspace_id = ${workspaceId} AND id IN ${sql(groupIds)}
    `;
    if (groups.length !== groupIds.length) throw new FlightDeckPgCanvasValidationError('visibility contains a group outside this workspace');
  }
  return { mode: visibility.mode, actor_ids: actorIds, group_ids: groupIds };
}

async function replaceCanvasVisibility(
  input: { workspaceId: string; canvasId: string; actorId: string; visibility: CanvasVisibility },
  sql: DbClient,
) {
  const visibility = await validateFlightDeckPgCanvasVisibility(input.workspaceId, input.visibility, sql);
  await sql`
    DELETE FROM flightdeck_pg_canvas_visibility_principals
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId}
  `;
  for (const actorId of visibility.actor_ids) {
    await sql`
      INSERT INTO flightdeck_pg_canvas_visibility_principals
        (workspace_id, canvas_id, principal_type, principal_actor_id, created_by_actor_id)
      VALUES (${input.workspaceId}, ${input.canvasId}, 'actor', ${actorId}, ${input.actorId})
    `;
  }
  for (const groupId of visibility.group_ids) {
    await sql`
      INSERT INTO flightdeck_pg_canvas_visibility_principals
        (workspace_id, canvas_id, principal_type, principal_group_id, created_by_actor_id)
      VALUES (${input.workspaceId}, ${input.canvasId}, 'group', ${groupId}, ${input.actorId})
    `;
  }
  return visibility;
}

export async function createFlightDeckPgCanvas(
  input: { workspaceId: string; actorId: string; title: string; visibility: CanvasVisibility; viewport?: FlightDeckPgCanvasViewport },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgCanvas> {
  await lockFlightDeckPgCanvasVisibilitySet(input.workspaceId, sql);
  const visibility = await validateFlightDeckPgCanvasVisibility(input.workspaceId, input.visibility, sql);
  const [position] = await sql<{ next_position: number }[]>`
    SELECT COALESCE(MAX(position), 0) + 1 AS next_position
    FROM flightdeck_pg_canvases WHERE workspace_id = ${input.workspaceId} AND deleted_at IS NULL
  `;
  const [canvas] = await sql<FlightDeckPgCanvas[]>`
    INSERT INTO flightdeck_pg_canvases
      (workspace_id, title, position, visibility_mode, viewport, created_by_actor_id, updated_by_actor_id)
    VALUES (
      ${input.workspaceId}, ${input.title}, ${Number(position?.next_position ?? 1)}, ${visibility.mode},
      ${sql.json((input.viewport ?? normalizeFlightDeckPgCanvasViewport(null)) as any)}, ${input.actorId}, ${input.actorId}
    )
    RETURNING *
  `;
  await replaceCanvasVisibility({ workspaceId: input.workspaceId, canvasId: canvas.id, actorId: input.actorId, visibility }, sql);
  return canvas;
}

export async function updateFlightDeckPgCanvas(
  input: {
    workspaceId: string;
    canvasId: string;
    actorId: string;
    expectedRowVersion: number;
    title?: string;
    viewport?: FlightDeckPgCanvasViewport;
    visibility?: CanvasVisibility;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgCanvas> {
  if (input.visibility) await lockFlightDeckPgCanvasVisibilitySet(input.workspaceId, sql);
  const visibility = input.visibility
    ? await validateFlightDeckPgCanvasVisibility(input.workspaceId, input.visibility, sql)
    : null;
  const [canvas] = await sql<FlightDeckPgCanvas[]>`
    UPDATE flightdeck_pg_canvases SET
      title = COALESCE(${input.title ?? null}, title),
      viewport = COALESCE(${input.viewport ? sql.json(input.viewport as any) : null}::jsonb, viewport),
      visibility_mode = COALESCE(${visibility?.mode ?? null}, visibility_mode),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId} AND id = ${input.canvasId}
      AND deleted_at IS NULL AND row_version = ${input.expectedRowVersion}
    RETURNING *
  `;
  const updated = requireFlightDeckPgCanvasMutation(canvas);
  if (visibility) {
    await replaceCanvasVisibility({ workspaceId: input.workspaceId, canvasId: updated.id, actorId: input.actorId, visibility }, sql);
  }
  return updated;
}

export async function reorderVisibleFlightDeckPgCanvases(
  input: Parameters<typeof listVisibleFlightDeckPgCanvases>[0] & { canvasIds: string[] },
  sql: DbClient = getDb(),
) {
  await lockFlightDeckPgCanvasVisibilitySet(input.workspaceId, sql);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.actorId}:canvas-order`}, 0))`;
  const visible = await listVisibleFlightDeckPgCanvases(input, sql);
  const currentIds = visible.map((canvas) => canvas.id);
  assertCompleteFlightDeckPgCanvasOrder(currentIds, input.canvasIds);
  for (const [index, canvasId] of input.canvasIds.entries()) {
    await sql`
      INSERT INTO flightdeck_pg_canvas_orders (workspace_id, viewer_actor_id, canvas_id, position)
      VALUES (${input.workspaceId}, ${input.actorId}, ${canvasId}, ${index + 1})
      ON CONFLICT (workspace_id, viewer_actor_id, canvas_id) DO UPDATE SET
        position = EXCLUDED.position,
        row_version = flightdeck_pg_canvas_orders.row_version + 1,
        updated_at = NOW()
    `;
  }
  return listVisibleFlightDeckPgCanvases(input, sql);
}

export async function listFlightDeckPgCanvasNaplets(
  workspaceId: string,
  canvasId: string,
  sql: DbClient = getDb(),
): Promise<FlightDeckPgCanvasNaplet[]> {
  return sql<FlightDeckPgCanvasNaplet[]>`
    SELECT * FROM flightdeck_pg_canvas_naplets
    WHERE workspace_id = ${workspaceId} AND canvas_id = ${canvasId} AND deleted_at IS NULL
    ORDER BY COALESCE((layout->>'z')::integer, 1), created_at, id
  `;
}

export async function createFlightDeckPgCanvasNaplet(
  input: {
    workspaceId: string;
    canvasId: string;
    actorId: string;
    sourceType: FlightDeckPgCanvasSourceType;
    sourceId: string;
    displayTitle?: string | null;
    layout: FlightDeckPgCanvasLayout;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgCanvasNaplet> {
  const [naplet] = await sql<FlightDeckPgCanvasNaplet[]>`
    INSERT INTO flightdeck_pg_canvas_naplets
      (workspace_id, canvas_id, source_type, source_id, display_title, layout, created_by_actor_id, updated_by_actor_id)
    VALUES (
      ${input.workspaceId}, ${input.canvasId}, ${input.sourceType}, ${input.sourceId}, ${input.displayTitle ?? null},
      ${sql.json(input.layout as any)}, ${input.actorId}, ${input.actorId}
    )
    RETURNING *
  `;
  return naplet;
}

export async function updateFlightDeckPgCanvasNaplet(
  input: {
    workspaceId: string;
    canvasId: string;
    napletId: string;
    actorId: string;
    expectedRowVersion: number;
    displayTitle?: string | null;
    displayTitleProvided?: boolean;
    layout?: FlightDeckPgCanvasLayout;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgCanvasNaplet> {
  const [naplet] = await sql<FlightDeckPgCanvasNaplet[]>`
    UPDATE flightdeck_pg_canvas_naplets SET
      display_title = CASE WHEN ${input.displayTitleProvided === true} THEN ${input.displayTitle ?? null} ELSE display_title END,
      layout = COALESCE(${input.layout ? sql.json(input.layout as any) : null}::jsonb, layout),
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${input.napletId}
      AND deleted_at IS NULL AND row_version = ${input.expectedRowVersion}
    RETURNING *
  `;
  return requireFlightDeckPgCanvasMutation(naplet, 'Canvas naplet row_version is stale');
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function flightDeckPgCanvasDigestMatches(bytes: Uint8Array, digest: string | null | undefined) {
  return Boolean(digest && /^[0-9a-f]{64}$/i.test(digest)
    && createHash('sha256').update(bytes).digest('hex') === digest.toLowerCase());
}

async function readableStorageText(objectId: string, maximumBytes: number) {
  const object = await getStorageObjectContent(objectId);
  if (!object || !object.row.completed_at || object.size > maximumBytes) return null;
  try {
    return {
      text: decodeUtf8(object.bytes),
      row: object.row,
      bytes: object.bytes,
    };
  } catch {
    return null;
  }
}

export async function resolveFlightDeckPgCanvasSource(
  input: {
    workspaceId: string;
    appNpub: string;
    actorNpub: string;
    sourceType: FlightDeckPgCanvasSourceType;
    sourceId: string;
  },
  sql: DbClient = getDb(),
): Promise<{ title: string; content: Record<string, unknown> } | null> {
  if (input.sourceType === 'document') {
    const doc = await resolveFlightDeckPgDoc(input.workspaceId, input.sourceId, sql);
    if (!doc || doc.archived_at) return null;
    const access = await authorizeFlightDeckPgOperation({ actorNpub: input.actorNpub, appNpub: input.appNpub, workspaceId: input.workspaceId, permission: 'doc.read', resource: { type: 'channel', channelId: doc.channel_id } }, sql);
    if (!access.allowed) return null;
    const body = await readableStorageText(doc.storage_object_id, 4 * 1024 * 1024);
    if (!body) return null;
    return { title: doc.title, content: { title: doc.title, body: body.text, updated_at: doc.updated_at.toISOString() } };
  }

  if (input.sourceType === 'task_list') {
    const [channel] = await sql<{ id: string; archived_at: Date | null }[]>`
      SELECT id, archived_at FROM flightdeck_pg_channels
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.sourceId} LIMIT 1
    `;
    if (!channel || channel.archived_at) return null;
    const access = await authorizeFlightDeckPgOperation({ actorNpub: input.actorNpub, appNpub: input.appNpub, workspaceId: input.workspaceId, permission: 'task.read', resource: { type: 'channel', channelId: channel.id } }, sql);
    if (!access.allowed) return null;
    const tasks = await listFlightDeckPgChannelTasks({ workspaceId: input.workspaceId, channelId: channel.id, limit: 200 }, sql);
    return { title: 'Tasks', content: { tasks: tasks.map((task) => ({ id: task.id, title: task.title, state: task.state })) } };
  }

  if (input.sourceType === 'chat_thread') {
    const thread = await resolveFlightDeckPgThread(input.workspaceId, input.sourceId, sql);
    if (!thread || (thread as typeof thread & { archived_at?: Date | null }).archived_at) return null;
    const access = await authorizeFlightDeckPgOperation({ actorNpub: input.actorNpub, appNpub: input.appNpub, workspaceId: input.workspaceId, permission: 'channel.read', resource: { type: 'channel', channelId: thread.channel_id } }, sql);
    if (!access.allowed) return null;
    const messages = await listFlightDeckPgChannelMessages({ workspaceId: input.workspaceId, channelId: thread.channel_id, threadId: thread.id, limit: 200 }, sql);
    return {
      title: thread.title,
      content: { messages: messages.map((message) => ({
        id: message.id,
        author: (message as typeof message & { created_by_actor_label?: string | null; created_by_actor_npub?: string | null }).created_by_actor_label
          ?? (message as typeof message & { created_by_actor_npub?: string | null }).created_by_actor_npub
          ?? '',
        body: message.body,
        created_at: message.created_at.toISOString(),
      })) },
    };
  }

  const version = await resolveFlightDeckPgFileVersion({ workspaceId: input.workspaceId, versionId: input.sourceId }, sql);
  if (!version) return null;
  const file = await resolveFlightDeckPgFile(input.workspaceId, version.file_id, sql);
  if (!file || file.archived_at) return null;
  const access = await authorizeFlightDeckPgOperation({ actorNpub: input.actorNpub, appNpub: input.appNpub, workspaceId: input.workspaceId, permission: 'file.read', resource: { type: 'channel', channelId: file.channel_id } }, sql);
  if (!access.allowed) return null;
  const packaged = await readableStorageText(version.storage_object_id, 2 * 1024 * 1024);
  if (!packaged || !['text/html', 'application/xhtml+xml'].includes(packaged.row.content_type.toLowerCase())) return null;
  const digest = packaged.row.sha256_hex;
  if (!flightDeckPgCanvasDigestMatches(packaged.bytes, digest)) return null;
  return {
    title: file.display_name || 'HTML',
    content: { html: packaged.text, version: String(version.version_number), digest: digest.toLowerCase() },
  };
}

export async function serializeAuthorizedFlightDeckPgCanvasNaplet(
  input: { workspaceId: string; appNpub: string; actorNpub: string; naplet: FlightDeckPgCanvasNaplet },
  sql: DbClient = getDb(),
  sourceResolver: typeof resolveFlightDeckPgCanvasSource = resolveFlightDeckPgCanvasSource,
): Promise<CanvasReadyNaplet | CanvasDeniedNaplet> {
  try {
    const source = await sourceResolver({
      workspaceId: input.workspaceId,
      appNpub: input.appNpub,
      actorNpub: input.actorNpub,
      sourceType: input.naplet.source_type,
      sourceId: input.naplet.source_id,
    }, sql);
    if (!source) return deniedFlightDeckPgCanvasNaplet(input.naplet);
    return {
      id: input.naplet.id,
      access: 'ready',
      layout: normalizeFlightDeckPgCanvasLayout(input.naplet.layout),
      source: { type: input.naplet.source_type, id: input.naplet.source_id },
      title: input.naplet.display_title || source.title,
      content: source.content,
      row_version: Number(input.naplet.row_version),
    };
  } catch {
    // Source lookup, storage absence, and authorization failure intentionally
    // collapse to the same non-disclosing snapshot result.
    return deniedFlightDeckPgCanvasNaplet(input.naplet);
  }
}

export async function createFlightDeckPgCanvasOutboxEvent(
  input: {
    workspaceId: string;
    actorId: string;
    eventType: string;
    entityType: 'canvas' | 'canvas_naplet' | 'canvas_order';
    entityId: string;
    operation: string;
    entityRowVersion?: number | null;
    payload?: Record<string, unknown>;
  },
  sql: DbClient = getDb(),
) {
  const [event] = await sql<{ id: string; row_version: number }[]>`
    INSERT INTO flightdeck_pg_outbox_events
      (workspace_id, actor_id, event_type, entity_type, entity_id, operation, entity_row_version, payload)
    VALUES (
      ${input.workspaceId}, ${input.actorId}, ${input.eventType}, ${input.entityType}, ${input.entityId},
      ${input.operation}, ${input.entityRowVersion ?? null}, ${sql.json((input.payload ?? {}) as any)}
    )
    RETURNING id, row_version
  `;
  return event;
}
