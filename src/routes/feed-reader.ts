import type { Hono, Context } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { resolveFlightDeckPgRequestContext } from '../services/flightdeck-pg-api';
import { FeedReaderError, getFeedSubscription, listFeedRows, mutateFeed, feedUuid } from '../services/feed-reader';

/** Mounted on the typed PG router. Actor comes exclusively from verified NIP-98. */
export function registerFeedReaderRoutes(router: Hono) {
  const base='/workspaces/:workspaceId/feed-subscriptions';
  const handle=(operation: 'list'|'get'|'states'|'subscribe'|'patch'|'unsubscribe'|'state')=>async(c: Context)=> {
    c.header('Cache-Control','private, no-store');
    try {
      const auth=await requireNip98AuthResolved(c);
      if(auth instanceof Response) return auth;
      const workspaceId=c.req.param('workspaceId')!;
      if(!feedUuid.test(workspaceId)) throw new FeedReaderError(400,'invalid_request');
      const context=await resolveFlightDeckPgRequestContext({workspaceId,actorNpub:auth.userNpub});
      if(!context.workspace) return c.json({error:{code:'workspace_not_found',message:'Workspace unavailable',retryable:false}},404);
      if(!context.actor || !context.membership) return c.json({error:{code:'workspace_membership_required',message:'Membership required',retryable:false}},403);
      const reader={workspaceId:context.workspace.id,actorId:context.actor.id};
      const id=c.req.param('subscriptionId')??null;
      if(operation==='list'||operation==='states') {
        if(Object.keys(c.req.query()).some(k=>!['cursor','limit'].includes(k))) throw new FeedReaderError(400,'invalid_request');
        return c.json(await listFeedRows(reader,operation==='states'?id:null,c.req.query('cursor'),Number(c.req.query('limit')??50)));
      }
      if(Object.keys(c.req.query()).length) throw new FeedReaderError(400,'invalid_request');
      if(operation==='get') return c.json({subscription:await getFeedSubscription(reader,id!)});
      // Bound request data before parsing or persisting mutation acknowledgements.
      const raw=await c.req.text();
      if(Buffer.byteLength(raw)>16384) throw new FeedReaderError(400,'invalid_request');
      let body: unknown;
      try {body=JSON.parse(raw);} catch {throw new FeedReaderError(400,'invalid_request');}
      return c.json(await mutateFeed(reader,operation,id,body));
    } catch(error) {
      if(error instanceof FeedReaderError) return c.json({error:{code:error.code,message:error.code,retryable:false}},error.status);
      throw error;
    }
  };
  router.get(base,handle('list'));router.post(base,handle('subscribe'));
  router.get(`${base}/:subscriptionId`,handle('get'));
  router.patch(`${base}/:subscriptionId`,handle('patch'));
  router.delete(`${base}/:subscriptionId`,handle('unsubscribe'));
  router.get(`${base}/:subscriptionId/item-states`,handle('states'));
  router.put(`${base}/:subscriptionId/item-states`,handle('state'));
}
