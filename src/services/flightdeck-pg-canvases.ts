import { getDb } from '../db';
import { createHash } from 'node:crypto';
import type {
  FlightDeckPgCanvas,
  FlightDeckPgCanvasComment,
  FlightDeckPgCanvasElement,
  FlightDeckPgCanvasElementKind,
  FlightDeckPgCanvasLayout,
  FlightDeckPgCanvasNaplet,
  FlightDeckPgCanvasSourceType,
  FlightDeckPgCanvasViewport,
  FlightDeckPgCanvasVisibilityMode,
  FlightDeckPgWorkspaceRole,
} from '../types';
import { authorizeFlightDeckPgOperation, resolveFlightDeckPgActorByNpub, resolveFlightDeckPgWorkspace, getFlightDeckPgWorkspaceMembership, getEffectiveFlightDeckPgGroupIds } from './flightdeck-pg-authorization';
import {
  listFlightDeckPgChannelMessages,
  listFlightDeckPgChannelTasks,
  resolveFlightDeckPgDoc,
  resolveFlightDeckPgThread,
} from './flightdeck-pg-api';
import { resolveFlightDeckPgExcalidrawBoard } from './flightdeck-pg-excalidraw-boards';
import { resolveFlightDeckPgHtmlArtifact } from './flightdeck-pg-html-artifacts';
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

export type CanvasNapletSource = { type: FlightDeckPgCanvasSourceType; id: string; version_id?: string | null };

export type CanvasResolvedSource = { title: string; content: Record<string, unknown>; source?: CanvasNapletSource };

export type CanvasReadyNaplet = {
  id: string;
  access: 'ready';
  layout: FlightDeckPgCanvasLayout;
  source: CanvasNapletSource;
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

export type CanvasCommentView = FlightDeckPgCanvasComment & {
  author_npub: string;
  author_label: string | null;
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

export function normalizeFlightDeckPgCanvasElementLayout(value: unknown): FlightDeckPgCanvasLayout {
  const layout = asJson(value);
  return {
    x: Math.round(finite(layout.x, 0)),
    y: Math.round(finite(layout.y, 0)),
    width: Math.max(8, Math.min(4000, Math.round(finite(layout.width, 180)))),
    height: Math.max(8, Math.min(4000, Math.round(finite(layout.height, 100)))),
    z: Math.max(1, Math.min(100000, Math.round(finite(layout.z, 1)))),
  };
}

export function normalizeFlightDeckPgCanvasAnchor(value: unknown) {
  const anchor = asJson(value);
  return { x: Math.round(finite(anchor.x, 0)), y: Math.round(finite(anchor.y, 0)) };
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
    sourceVersionId?: string | null;
    displayTitle?: string | null;
    layout: FlightDeckPgCanvasLayout;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgCanvasNaplet> {
  const [naplet] = await sql<FlightDeckPgCanvasNaplet[]>`
    INSERT INTO flightdeck_pg_canvas_naplets
      (workspace_id, canvas_id, source_type, source_id, source_version_id, display_title, layout, created_by_actor_id, updated_by_actor_id)
    VALUES (
      ${input.workspaceId}, ${input.canvasId}, ${input.sourceType}, ${input.sourceId}, ${input.sourceVersionId ?? null}, ${input.displayTitle ?? null},
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
    /** HTML version policy; applied together with the normalized File source id. */
    htmlSource?: { fileId: string; versionId: string | null };
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgCanvasNaplet> {
  const [naplet] = await sql<FlightDeckPgCanvasNaplet[]>`
    UPDATE flightdeck_pg_canvas_naplets SET
      display_title = CASE WHEN ${input.displayTitleProvided === true} THEN ${input.displayTitle ?? null} ELSE display_title END,
      layout = COALESCE(${input.layout ? sql.json(input.layout as any) : null}::jsonb, layout),
      source_id = CASE WHEN ${Boolean(input.htmlSource)} AND source_type = 'html' THEN ${input.htmlSource?.fileId ?? null}::uuid ELSE source_id END,
      source_version_id = CASE WHEN ${Boolean(input.htmlSource)} AND source_type = 'html' THEN ${input.htmlSource?.versionId ?? null}::uuid ELSE source_version_id END,
      updated_by_actor_id = ${input.actorId},
      row_version = row_version + 1,
      updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${input.napletId}
      AND deleted_at IS NULL AND row_version = ${input.expectedRowVersion}
    RETURNING *
  `;
  return requireFlightDeckPgCanvasMutation(naplet, 'Canvas naplet row_version is stale');
}

export async function deleteFlightDeckPgCanvasNaplet(
  input: { workspaceId: string; canvasId: string; napletId: string; actorId: string; expectedRowVersion: number },
  sql: DbClient = getDb(),
) {
  const [naplet] = await sql<FlightDeckPgCanvasNaplet[]>`
    UPDATE flightdeck_pg_canvas_naplets SET deleted_at = NOW(), updated_at = NOW(),
      updated_by_actor_id = ${input.actorId}, row_version = row_version + 1
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${input.napletId}
      AND deleted_at IS NULL AND row_version = ${input.expectedRowVersion}
    RETURNING *
  `;
  return requireFlightDeckPgCanvasMutation(naplet, 'Canvas naplet row_version is stale');
}

export async function listFlightDeckPgCanvasElements(workspaceId: string, canvasId: string, sql: DbClient = getDb()) {
  return sql<FlightDeckPgCanvasElement[]>`
    SELECT * FROM flightdeck_pg_canvas_elements
    WHERE workspace_id = ${workspaceId} AND canvas_id = ${canvasId} AND deleted_at IS NULL
    ORDER BY COALESCE((layout->>'z')::integer, 1), created_at, id
  `;
}

export function serializeFlightDeckPgCanvasElement(element: FlightDeckPgCanvasElement) {
  return {
    id: element.id,
    kind: element.kind,
    layout: normalizeFlightDeckPgCanvasElementLayout(element.layout),
    data: asJson(element.data),
    row_version: Number(element.row_version),
    created_at: element.created_at,
    updated_at: element.updated_at,
  };
}

export async function createFlightDeckPgCanvasElement(
  input: { workspaceId: string; canvasId: string; actorId: string; kind: FlightDeckPgCanvasElementKind; layout: FlightDeckPgCanvasLayout; data: Record<string, unknown> },
  sql: DbClient = getDb(),
) {
  const [element] = await sql<FlightDeckPgCanvasElement[]>`
    INSERT INTO flightdeck_pg_canvas_elements
      (workspace_id, canvas_id, kind, layout, data, created_by_actor_id, updated_by_actor_id)
    VALUES (${input.workspaceId}, ${input.canvasId}, ${input.kind}, ${sql.json(input.layout as any)}, ${sql.json(input.data as any)}, ${input.actorId}, ${input.actorId})
    RETURNING *
  `;
  return element;
}

export async function updateFlightDeckPgCanvasElement(
  input: { workspaceId: string; canvasId: string; elementId: string; actorId: string; expectedRowVersion: number; layout?: FlightDeckPgCanvasLayout; data?: Record<string, unknown> },
  sql: DbClient = getDb(),
) {
  const [element] = await sql<FlightDeckPgCanvasElement[]>`
    UPDATE flightdeck_pg_canvas_elements SET
      layout = COALESCE(${input.layout ? sql.json(input.layout as any) : null}::jsonb, layout),
      data = COALESCE(${input.data ? sql.json(input.data as any) : null}::jsonb, data),
      updated_by_actor_id = ${input.actorId}, row_version = row_version + 1, updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${input.elementId}
      AND deleted_at IS NULL AND row_version = ${input.expectedRowVersion}
    RETURNING *
  `;
  return requireFlightDeckPgCanvasMutation(element, 'Canvas element row_version is stale');
}

export async function deleteFlightDeckPgCanvasElement(
  input: { workspaceId: string; canvasId: string; elementId: string; actorId: string; expectedRowVersion: number },
  sql: DbClient = getDb(),
) {
  const [element] = await sql<FlightDeckPgCanvasElement[]>`
    UPDATE flightdeck_pg_canvas_elements SET deleted_at = NOW(), updated_at = NOW(),
      updated_by_actor_id = ${input.actorId}, row_version = row_version + 1
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${input.elementId}
      AND deleted_at IS NULL AND row_version = ${input.expectedRowVersion}
    RETURNING *
  `;
  return requireFlightDeckPgCanvasMutation(element, 'Canvas element row_version is stale');
}

export async function listFlightDeckPgCanvasComments(workspaceId: string, canvasId: string, sql: DbClient = getDb()) {
  return sql<CanvasCommentView[]>`
    SELECT c.*, a.npub AS author_npub, a.display_name AS author_label
    FROM flightdeck_pg_canvas_comments c
    JOIN flightdeck_pg_actors a ON a.id = c.created_by_actor_id
    WHERE c.workspace_id = ${workspaceId} AND c.canvas_id = ${canvasId} AND c.deleted_at IS NULL
    ORDER BY c.created_at, c.id
  `;
}

export function canvasCommentPermissions(comment: CanvasCommentView, comments: CanvasCommentView[], actorId: string, canManage: boolean) {
  const owns = comment.created_by_actor_id === actorId;
  const root = !comment.parent_comment_id;
  return {
    can_delete: canManage || (owns && (!root || comments.filter(row => row.parent_comment_id === comment.id).every(row => row.created_by_actor_id === actorId))),
    can_retarget: root && (canManage || owns),
    retarget_preserves_position: true,
    can_resolve: root && (canManage || owns),
  };
}

export function serializeFlightDeckPgCanvasComment(comment: CanvasCommentView, readableNapletIds?: Set<string>) {
  const napletReadable = comment.anchor_type !== 'naplet' || Boolean(comment.anchor_naplet_id && readableNapletIds?.has(comment.anchor_naplet_id));
  return {
    id: comment.id,
    anchor: comment.anchor_type === 'naplet' && napletReadable
      ? { type: 'naplet', naplet_id: comment.anchor_naplet_id, ...(comment.anchor.positioned ? normalizeFlightDeckPgCanvasAnchor(comment.anchor) : {}) }
      : { type: 'canvas', ...normalizeFlightDeckPgCanvasAnchor(comment.anchor) },
    parent_comment_id: comment.parent_comment_id,
    body: comment.body,
    resolved_at: comment.resolved_at,
    author: { actor_id: comment.created_by_actor_id, npub: comment.author_npub, label: comment.author_label || comment.author_npub },
    row_version: Number(comment.row_version),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

export async function createFlightDeckPgCanvasComment(
  input: { workspaceId: string; canvasId: string; actorId: string; anchorType: 'canvas' | 'naplet'; anchorNapletId?: string | null; anchor: { x: number; y: number; positioned?: boolean }; parentCommentId?: string | null; body: string },
  sql: DbClient = getDb(),
) {
  let anchorType = input.anchorType;
  let anchorNapletId = input.anchorNapletId ?? null;
  let anchor = input.anchor;
  if (input.parentCommentId) {
    const [parent] = await sql<{ id: string; parent_comment_id: string | null; anchor_type: 'canvas' | 'naplet'; anchor_naplet_id: string | null; anchor: { x: number; y: number; positioned?: boolean } }[]>`
      SELECT id, parent_comment_id, anchor_type, anchor_naplet_id, anchor FROM flightdeck_pg_canvas_comments
      WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${input.parentCommentId} AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!parent || parent.parent_comment_id) throw new FlightDeckPgCanvasValidationError('parent_comment_id must identify a root Canvas comment');
    anchorType = parent.anchor_type;
    anchorNapletId = parent.anchor_naplet_id;
    anchor = parent.anchor;
  }
  if (anchorType === 'naplet') {
    const [naplet] = await sql<{ id: string }[]>`
      SELECT id FROM flightdeck_pg_canvas_naplets
      WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${anchorNapletId} AND deleted_at IS NULL
    `;
    if (!naplet) throw new FlightDeckPgCanvasValidationError('anchor naplet is unavailable');
  }
  const [comment] = await sql<CanvasCommentView[]>`
    INSERT INTO flightdeck_pg_canvas_comments
      (workspace_id, canvas_id, anchor_type, anchor_naplet_id, anchor, parent_comment_id, body, created_by_actor_id, updated_by_actor_id)
    VALUES (${input.workspaceId}, ${input.canvasId}, ${anchorType}, ${anchorNapletId}, ${sql.json(anchor as any)}, ${input.parentCommentId ?? null}, ${input.body}, ${input.actorId}, ${input.actorId})
    RETURNING *, ''::text AS author_npub, NULL::text AS author_label
  `;
  return comment;
}

export async function setFlightDeckPgCanvasCommentResolved(
  input: { workspaceId: string; canvasId: string; commentId: string; actorId: string; expectedRowVersion: number; resolved: boolean },
  sql: DbClient = getDb(),
) {
  const [comment] = await sql<CanvasCommentView[]>`
    UPDATE flightdeck_pg_canvas_comments SET
      resolved_at = CASE WHEN ${input.resolved} THEN NOW() ELSE NULL END,
      resolved_by_actor_id = CASE WHEN ${input.resolved} THEN ${input.actorId}::uuid ELSE NULL END,
      updated_by_actor_id = ${input.actorId}, row_version = row_version + 1, updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${input.commentId}
      AND parent_comment_id IS NULL AND deleted_at IS NULL AND row_version = ${input.expectedRowVersion}
    RETURNING *, ''::text AS author_npub, NULL::text AS author_label
  `;
  return requireFlightDeckPgCanvasMutation(comment, 'Canvas comment row_version is stale');
}

export async function retargetFlightDeckPgCanvasComment(
  input: { workspaceId: string; canvasId: string; commentId: string; actorId: string; expectedRowVersion: number; anchorType: 'canvas' | 'naplet'; anchorNapletId: string | null; anchor: { x: number; y: number; positioned?: boolean } },
  sql: DbClient = getDb(),
) {
  // Root CAS also serializes with reply creation and deletion's root lock.
  const [comment] = await sql<CanvasCommentView[]>`
    UPDATE flightdeck_pg_canvas_comments SET anchor_type = ${input.anchorType}, anchor_naplet_id = ${input.anchorNapletId},
      anchor = ${sql.json(input.anchor as any)}, updated_by_actor_id = ${input.actorId}, row_version = row_version + 1, updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${input.commentId}
      AND parent_comment_id IS NULL AND deleted_at IS NULL AND row_version = ${input.expectedRowVersion}
    RETURNING *, ''::text AS author_npub, NULL::text AS author_label
  `;
  requireFlightDeckPgCanvasMutation(comment, 'Canvas comment row_version is stale');
  await sql`
    UPDATE flightdeck_pg_canvas_comments SET anchor_type = ${input.anchorType}, anchor_naplet_id = ${input.anchorNapletId},
      anchor = ${sql.json(input.anchor as any)}, updated_by_actor_id = ${input.actorId}, row_version = row_version + 1, updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND parent_comment_id = ${input.commentId} AND deleted_at IS NULL
  `;
  return comment;
}

export class CanvasCommentPermissionError extends Error {}

export function assertCanvasCommentDeletion(comment: CanvasCommentView, comments: CanvasCommentView[], actorId: string, canManage: boolean, expectedReplies?: Record<string, number>) {
  if (!canvasCommentPermissions(comment, comments, actorId, canManage).can_delete) throw new CanvasCommentPermissionError('Only the author or a Canvas manager may delete; threads containing other authors require a manager');
  if (!comment.parent_comment_id) {
    const replies = comments.filter(row => row.parent_comment_id === comment.id);
    if (!expectedReplies || Object.keys(expectedReplies).length !== replies.length || replies.some(row => expectedReplies[row.id] !== Number(row.row_version))) {
      throw new FlightDeckPgCanvasConflictError('Replies changed; refresh and confirm the thread again');
    }
  }
}

export async function deleteFlightDeckPgCanvasComment(
  input: { workspaceId: string; canvasId: string; commentId: string; actorId: string; canManage: boolean; expectedRowVersion: number; expectedReplies?: Record<string, number> },
  sql: DbClient = getDb(),
) {
  const [existing] = await sql<CanvasCommentView[]>`SELECT * FROM flightdeck_pg_canvas_comments WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${input.commentId} AND deleted_at IS NULL`;
  if (!existing) throw new FlightDeckPgCanvasConflictError('Canvas comment no longer exists');
  // All mutations lock root before reply; new replies also hold this lock.
  const [root] = await sql<CanvasCommentView[]>`SELECT * FROM flightdeck_pg_canvas_comments WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND id = ${existing.parent_comment_id || existing.id} AND deleted_at IS NULL FOR UPDATE`;
  if (!root) throw new FlightDeckPgCanvasConflictError('Canvas thread no longer exists');
  const comments = await listFlightDeckPgCanvasComments(input.workspaceId, input.canvasId, sql);
  const comment = comments.find(row => row.id === input.commentId);
  if (!comment || Number(comment.row_version) !== input.expectedRowVersion) throw new FlightDeckPgCanvasConflictError('Canvas comment row_version is stale');
  assertCanvasCommentDeletion(comment, comments, input.actorId, input.canManage, input.expectedReplies);
  return sql<CanvasCommentView[]>`
    UPDATE flightdeck_pg_canvas_comments SET deleted_at = NOW(), updated_at = NOW(), updated_by_actor_id = ${input.actorId}, row_version = row_version + 1
    WHERE workspace_id = ${input.workspaceId} AND canvas_id = ${input.canvasId} AND deleted_at IS NULL
      AND (id = ${input.commentId} OR parent_comment_id = ${input.commentId})
    RETURNING *, ''::text AS author_npub, NULL::text AS author_label
  `;
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
    sourceVersionId?: string | null;
    requestedVersionId?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<CanvasResolvedSource | null> {
  if (input.sourceType === 'canvas') {
    if (input.sourceVersionId || input.requestedVersionId) return null;
    const actor = await resolveFlightDeckPgActorByNpub(input.actorNpub, sql);
    const workspace = await resolveFlightDeckPgWorkspace(input.workspaceId, sql);
    if (!actor || !workspace || workspace.app_npub !== input.appNpub) return null;
    const membership = await getFlightDeckPgWorkspaceMembership(workspace.id, actor.id, sql);
    if (!membership) return null;
    const groupIds = await getEffectiveFlightDeckPgGroupIds(workspace.id, actor.id, sql);
    const management = await authorizeFlightDeckPgOperation({ actorNpub: input.actorNpub, appNpub: input.appNpub, workspaceId: workspace.id, permission: 'workspace.manage', resource: { type: 'workspace' } }, sql);
    // Resolve definition visibility only. Never traverse the destination's naplets.
    const destination = await resolveVisibleFlightDeckPgCanvas({ workspaceId: workspace.id, actorId: actor.id, groupIds, workspaceRole: membership.role, canManageWorkspace: management.allowed, canvasId: input.sourceId }, sql);
    return destination ? { title: destination.title, content: { title: destination.title } } : null;
  }
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

  if (input.sourceType === 'excalidraw') {
    // Boards always follow the File's current version; pins are not supported.
    if (input.sourceVersionId) return null;
    const board = await resolveFlightDeckPgExcalidrawBoard({ workspaceId: input.workspaceId, appNpub: input.appNpub, actorNpub: input.actorNpub, sourceId: input.sourceId }, sql);
    if (!board) return null;
    return { title: board.title, content: board.content, source: { type: 'excalidraw', id: board.fileId } };
  }

  const artifact = await resolveFlightDeckPgHtmlArtifact({
    workspaceId: input.workspaceId,
    appNpub: input.appNpub,
    actorNpub: input.actorNpub,
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId ?? null,
    requestedVersionId: input.requestedVersionId ?? null,
  }, sql);
  if (!artifact) return null;
  return {
    title: artifact.title,
    content: artifact.content,
    source: { type: 'html', id: artifact.fileId, version_id: artifact.pinnedVersionId },
  };
}

export async function serializeAuthorizedFlightDeckPgCanvasNaplet(
  input: { workspaceId: string; appNpub: string; actorNpub: string; naplet: FlightDeckPgCanvasNaplet },
  sql: DbClient = getDb(),
  sourceResolver: typeof resolveFlightDeckPgCanvasSource = resolveFlightDeckPgCanvasSource,
): Promise<CanvasReadyNaplet | CanvasDeniedNaplet> {
  try {
    if (input.naplet.source_type === 'canvas' && input.naplet.source_id === input.naplet.canvas_id) return deniedFlightDeckPgCanvasNaplet(input.naplet);
    const source = await sourceResolver({
      workspaceId: input.workspaceId,
      appNpub: input.appNpub,
      actorNpub: input.actorNpub,
      sourceType: input.naplet.source_type,
      sourceId: input.naplet.source_id,
      sourceVersionId: input.naplet.source_version_id ?? null,
    }, sql);
    if (!source) return deniedFlightDeckPgCanvasNaplet(input.naplet);
    return {
      id: input.naplet.id,
      access: 'ready',
      layout: normalizeFlightDeckPgCanvasLayout(input.naplet.layout),
      source: source.source ?? { type: input.naplet.source_type, id: input.naplet.source_id },
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
    entityType: 'canvas' | 'canvas_naplet' | 'canvas_order' | 'canvas_element' | 'canvas_comment';
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
