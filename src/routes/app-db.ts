import { Hono } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import {
  AppDbError,
  createWappDbTableRow,
  createWorkspaceAppRow,
  deleteWappDbTableRow,
  deleteWorkspaceAppRow,
  getWappDbDescriptor,
  getWappDbTableRow,
  getWorkspaceAppRow,
  listWorkspaceAppRows,
  listWappDbMigrations,
  provisionWappDbNamespace,
  queryWappDbTableRows,
  runWappDbMigrations,
  updateWappDbTableRow,
  updateWorkspaceAppRow,
} from '../services/app-db';
import type {
  CreateWappDbTableRowInput,
  CreateWorkspaceAppRowInput,
  QueryWappDbTableRowsInput,
  RunWappDbMigrationsInput,
  UpdateWappDbTableRowInput,
  UpdateWorkspaceAppRowInput,
  WorkspaceAppRowVisibility,
} from '../types';

export const appDbRouter = new Hono();

function normalizeLimit(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function appDbErrorResponse(c: any, error: unknown) {
  if (error instanceof AppDbError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  return c.json({ error: error instanceof Error ? error.message : 'App database request failed' }, 500);
}

function routeParams(c: any) {
  return {
    workspaceOwnerNpub: String(c.req.param('workspaceOwnerNpub') || '').trim(),
    appNpub: String(c.req.param('appNpub') || '').trim(),
    collection: String(c.req.param('collection') || '').trim(),
    table: String(c.req.param('table') || '').trim(),
    rowId: String(c.req.param('rowId') || '').trim(),
  };
}

appDbRouter.get('/:workspaceOwnerNpub/apps/:appNpub/db/descriptor', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub } = routeParams(c);

  try {
    return c.json(await getWappDbDescriptor(workspaceOwnerNpub, appNpub, auth.signerNpub));
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.post('/:workspaceOwnerNpub/apps/:appNpub/db/provision', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub } = routeParams(c);
  const body = await c.req.json<{ app_slug?: string }>().catch(() => ({}));

  try {
    const descriptor = await provisionWappDbNamespace(workspaceOwnerNpub, appNpub, body, auth.signerNpub);
    return c.json(descriptor, 201);
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.get('/:workspaceOwnerNpub/apps/:appNpub/db/migrations', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub } = routeParams(c);

  try {
    return c.json(await listWappDbMigrations(workspaceOwnerNpub, appNpub, auth.signerNpub));
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.post('/:workspaceOwnerNpub/apps/:appNpub/db/migrations', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub } = routeParams(c);
  const body = await c.req.json<RunWappDbMigrationsInput>().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required', code: 'bad_json' }, 400);

  try {
    return c.json(await runWappDbMigrations(workspaceOwnerNpub, appNpub, body, auth.signerNpub));
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.get('/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, table } = routeParams(c);

  try {
    return c.json(await queryWappDbTableRows(workspaceOwnerNpub, appNpub, table, {
      limit: normalizeLimit(c.req.query('limit')),
      offset: normalizeLimit(c.req.query('offset')),
      order: [{ field: String(c.req.query('order_by') || 'id'), dir: c.req.query('order_dir') === 'desc' ? 'desc' : 'asc' }],
    }, auth.signerNpub));
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.post('/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/query', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, table } = routeParams(c);
  const body = await c.req.json<QueryWappDbTableRowsInput>().catch(() => ({}));

  try {
    return c.json(await queryWappDbTableRows(workspaceOwnerNpub, appNpub, table, body, auth.signerNpub));
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.post('/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, table } = routeParams(c);
  const body = await c.req.json<CreateWappDbTableRowInput>().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required', code: 'bad_json' }, 400);

  try {
    return c.json(await createWappDbTableRow(workspaceOwnerNpub, appNpub, table, body, auth.signerNpub), 201);
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.get('/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows/:rowId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, table, rowId } = routeParams(c);

  try {
    const result = await getWappDbTableRow(workspaceOwnerNpub, appNpub, table, rowId, auth.signerNpub);
    if (!result.row) return c.json({ error: 'row not found', code: 'row_not_found' }, 404);
    return c.json(result);
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.patch('/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows/:rowId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, table, rowId } = routeParams(c);
  const body = await c.req.json<UpdateWappDbTableRowInput>().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required', code: 'bad_json' }, 400);

  try {
    const result = await updateWappDbTableRow(workspaceOwnerNpub, appNpub, table, rowId, body, auth.signerNpub);
    if (!result.row) return c.json({ error: 'row not found', code: 'row_not_found' }, 404);
    return c.json(result);
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.delete('/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows/:rowId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, table, rowId } = routeParams(c);

  try {
    const result = await deleteWappDbTableRow(workspaceOwnerNpub, appNpub, table, rowId, auth.signerNpub);
    if (!result.deleted) return c.json({ error: 'row not found', code: 'row_not_found' }, 404);
    return c.json(result);
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.get('/:workspaceOwnerNpub/apps/:appNpub/db/:collection/rows', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, collection } = routeParams(c);

  try {
    const rows = await listWorkspaceAppRows(workspaceOwnerNpub, appNpub, collection, auth.userNpub, {
      limit: normalizeLimit(c.req.query('limit')),
      offset: normalizeLimit(c.req.query('offset')),
      owner_npub: c.req.query('owner_npub'),
      visibility: c.req.query('visibility') as WorkspaceAppRowVisibility | undefined,
      group_id: c.req.query('group_id'),
    });
    return c.json({ workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, collection, rows });
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.post('/:workspaceOwnerNpub/apps/:appNpub/db/:collection/rows', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, collection } = routeParams(c);
  const body = await c.req.json<CreateWorkspaceAppRowInput>().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required', code: 'bad_json' }, 400);

  try {
    const row = await createWorkspaceAppRow(workspaceOwnerNpub, appNpub, collection, body, auth.userNpub);
    return c.json({ workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, collection, row }, 201);
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.get('/:workspaceOwnerNpub/apps/:appNpub/db/:collection/rows/:rowId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, collection, rowId } = routeParams(c);

  try {
    const row = await getWorkspaceAppRow(workspaceOwnerNpub, appNpub, collection, rowId, auth.userNpub);
    if (!row) return c.json({ error: 'row not found', code: 'row_not_found' }, 404);
    return c.json({ workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, collection, row });
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.patch('/:workspaceOwnerNpub/apps/:appNpub/db/:collection/rows/:rowId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, collection, rowId } = routeParams(c);
  const body = await c.req.json<UpdateWorkspaceAppRowInput>().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required', code: 'bad_json' }, 400);

  try {
    const row = await updateWorkspaceAppRow(workspaceOwnerNpub, appNpub, collection, rowId, body, auth.userNpub);
    if (!row) return c.json({ error: 'row not found', code: 'row_not_found' }, 404);
    return c.json({ workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, collection, row });
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});

appDbRouter.delete('/:workspaceOwnerNpub/apps/:appNpub/db/:collection/rows/:rowId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { workspaceOwnerNpub, appNpub, collection, rowId } = routeParams(c);

  try {
    const deleted = await deleteWorkspaceAppRow(workspaceOwnerNpub, appNpub, collection, rowId, auth.userNpub);
    if (!deleted) return c.json({ error: 'row not found', code: 'row_not_found' }, 404);
    return c.json({ workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, collection, row_id: rowId, deleted: true });
  } catch (error) {
    return appDbErrorResponse(c, error);
  }
});
