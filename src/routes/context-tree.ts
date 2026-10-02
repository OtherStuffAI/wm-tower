import type { Hono, Context } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { buildFlightDeckPgIdentity, resolveFlightDeckPgRequestContext } from '../services/flightdeck-pg-api';
import { ContextTreeError, contextUuid, runContextTree, type ContextTreeOperation } from '../services/flightdeck-pg-context-tree';

/** Existing typed PG auth transport and identity/error envelopes. */
export function registerContextTreeRoutes(router: Hono) {
  const base = '/workspaces/:workspaceId/scopes/:scopeId/context/components';
  const handle = (operation: ContextTreeOperation) => async (c: Context) => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await requireNip98AuthResolved(c);
    if (auth instanceof Response) return auth;
    let identity = buildFlightDeckPgIdentity(null, c.req.header('x-flightdeck-pg-app-npub') ?? '');
    try {
      const workspaceId = c.req.param('workspaceId')!;
      if (!contextUuid.test(workspaceId)) throw new ContextTreeError(400, 'validation_error', 'workspaceId must be a UUID');
      const context = await resolveFlightDeckPgRequestContext({ workspaceId, actorNpub: auth.userNpub });
      identity = buildFlightDeckPgIdentity(context.workspace, context.workspace?.app_npub ?? '');
      if (!context.workspace) throw new ContextTreeError(404, 'workspace_not_found');
      if (!context.actor || !context.membership) throw new ContextTreeError(403, 'workspace_membership_required');
      const query = c.req.query();
      if (Object.keys(query).some(k => !['limit', 'cursor', 'app_npub'].includes(k))
        || (!['list', 'references'].includes(operation) && ('limit' in query || 'cursor' in query))) throw new ContextTreeError(400, 'validation_error', 'Unexpected query parameter');
      let body: unknown;
      if (['create', 'update', 'attach', 'unlink', 'delete'].includes(operation)) {
        const raw = await c.req.text();
        if (Buffer.byteLength(raw) > 16384) throw new ContextTreeError(400, 'validation_error', 'Body too large');
        try { body = JSON.parse(raw); } catch { throw new ContextTreeError(400, 'validation_error', 'body must be valid JSON'); }
      }
      const payload = await runContextTree({ workspaceId, scopeId: c.req.param('scopeId')!, actorNpub: auth.userNpub, appNpub: context.workspace.app_npub }, operation,
        { componentId: c.req.param('componentId'), referenceId: c.req.param('referenceId'), body, limit: query.limit, cursor: query.cursor });
      return c.json({ identity, ...payload }, operation === 'create' || operation === 'attach' ? 201 : 200);
    } catch (error) {
      if (error instanceof ContextTreeError) return c.json({ error: error.message, code: error.code, status: error.status, identity,
        ...(error.status === 403 && error.code === 'permission_denied' ? { required_permission: 'scope.manage' } : {}) }, error.status);
      throw error;
    }
  };
  router.get(base, handle('list'));
  router.post(base, handle('create'));
  router.patch(`${base}/:componentId`, handle('update'));
  router.get(`${base}/:componentId/references`, handle('references'));
  router.post(`${base}/:componentId/references`, handle('attach'));
  router.delete(`${base}/:componentId/references/:referenceId`, handle('unlink'));
  router.get(`${base}/:componentId/delete-preview`, handle('preview'));
  router.post(`${base}/:componentId/delete`, handle('delete'));
}
