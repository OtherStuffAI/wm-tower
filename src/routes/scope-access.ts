import type { Hono, Context } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { buildFlightDeckPgIdentity, resolveFlightDeckPgRequestContext } from '../services/flightdeck-pg-api';
import { ContextTreeError, contextUuid } from '../services/flightdeck-pg-context-tree';
import { runScopeAccess } from '../services/flightdeck-pg-scope-access';
export function registerScopeAccessRoutes(router: Hono) {
  const handle = (write: boolean) => async (c: Context) => {
    c.header('Cache-Control','private, no-store');
    const auth = await requireNip98AuthResolved(c);
    if (auth instanceof Response) return auth;
    let identity = buildFlightDeckPgIdentity(null,'');
    try {
      const workspaceId = c.req.param('workspaceId')!;
      if (!contextUuid.test(workspaceId)) throw new ContextTreeError(400,'validation_error');
      const context = await resolveFlightDeckPgRequestContext({workspaceId,actorNpub:auth.userNpub});
      identity = buildFlightDeckPgIdentity(context.workspace,context.workspace?.app_npub || '');
      if (!context.workspace) throw new ContextTreeError(404,'workspace_not_found');
      if (!context.membership) throw new ContextTreeError(403,'workspace_membership_required');
      let body;
      if (write) {
        const raw = await c.req.text();
        if (Buffer.byteLength(raw)>16384) throw new ContextTreeError(400,'validation_error');
        try {body=JSON.parse(raw);} catch {throw new ContextTreeError(400,'validation_error');}
      }
      return c.json({identity,...await runScopeAccess({workspaceId,scopeId:c.req.param('scopeId')!,actorNpub:auth.userNpub,appNpub:context.workspace.app_npub},body)});
    } catch (e) {
      if (e instanceof ContextTreeError) return c.json({identity,error:e.message,code:e.code,status:e.status},e.status);
      throw e;
    }
  };
  router.get('/workspaces/:workspaceId/scopes/:scopeId/grants',handle(false));
  router.put('/workspaces/:workspaceId/scopes/:scopeId/grants',handle(true));
}
