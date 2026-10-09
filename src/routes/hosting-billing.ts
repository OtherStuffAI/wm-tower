import { Hono } from 'hono';
import { requireNip98AuthResolved, verifyStrictNip98Mutation } from '../auth';
import { config } from '../config';
import { getDb } from '../db';
import { authorizeFlightDeckPgOperation } from '../services/flightdeck-pg-authorization';
import { resolveFlightDeckPgRequestContext } from '../services/flightdeck-pg-api';
import { grantHostingCredit, hostingStatus, HostingError } from '../services/hosting-billing';
import { createHostingCheckout, receiveHostingStripeWebhook } from '../services/hosting-stripe';
export const hostingBillingRouter=new Hono();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
hostingBillingRouter.post('/stripe/webhook',async c=>{
  try {return c.json(await receiveHostingStripeWebhook(Buffer.from(await c.req.arrayBuffer()),c.req.header('stripe-signature')??null));}
  catch(e){if(e instanceof HostingError)return c.json({code:e.code,error:e.message},e.status as any);throw e;}
});
hostingBillingRouter.all('/workspaces/:workspaceId/:operation',async c=> {
  c.header('Cache-Control','private, no-store');
  try {
    const id=c.req.param('workspaceId'),op=c.req.param('operation'),write=c.req.method==='POST';
    if(!uuid.test(id)||!['status','usage','ledger','checkout','grant'].includes(op))throw new HostingError(404,'not_found');
    if(write?!['checkout','grant'].includes(op):c.req.method!=='GET'||!['status','usage','ledger'].includes(op))throw new HostingError(405,'method_not_allowed');
    let actor:string,body:any;
    if(write){const raw=await c.req.text();if(Buffer.byteLength(raw)>4096)throw new HostingError(400,'body_too_large');
      const proof=await verifyStrictNip98Mutation(c.req.header('authorization')??null,c.req.raw,raw);
      if(!proof.ok)throw new HostingError(401,proof.reasonCode);actor=proof.userNpub;
      try{body=JSON.parse(raw);}catch{throw new HostingError(400,'invalid_json');}
    }else{const auth=await requireNip98AuthResolved(c);if(auth instanceof Response)return auth;actor=auth.userNpub;}
    const context=await resolveFlightDeckPgRequestContext({workspaceId:id,actorNpub:actor});
    if(!context.workspace)throw new HostingError(404,'workspace_not_found');
    const [accountOwner]=await getDb()`SELECT a.owner_actor_id FROM hosting_workspace_accounts l JOIN hosting_accounts a ON a.id=l.account_id WHERE l.workspace_id=${id}`;
    const isAccountOwner=Boolean(accountOwner && context.actor?.id===accountOwner.owner_actor_id);
    const platformAdmin=actor===config.adminNpub;
    if(op==='grant'&&!platformAdmin)throw new HostingError(403,'platform_admin_required');
    if(!platformAdmin){
      const owner=isAccountOwner;
      const decision=await authorizeFlightDeckPgOperation({workspaceId:id,actorNpub:actor,appNpub:context.workspace.app_npub,permission:'workspace.manage',resource:{type:'workspace'}});
      if(!owner&&!decision.allowed)throw new HostingError(403,'workspace_manager_required');
    }
    const status=await hostingStatus(id);
    if(op==='status')return c.json({...status,can_top_up:isAccountOwner});
    const accountId=(status as any).account_id;
    if(!accountId)throw new HostingError(409,'billing_not_enabled_for_workspace');
    if(op==='checkout') {
      // Only account owner can spend into the account; managers may monitor.
      if(!isAccountOwner)throw new HostingError(403,'account_owner_required');
      return c.json(await createHostingCheckout(accountId,body),201);
    }
    if(op==='grant') {
      if(!body||Object.keys(body).sort().join(',')!=='amount_cents,idempotency_key,reason')throw new HostingError(400,'invalid_grant');
      return c.json({entry:await grantHostingCredit(accountId,body.amount_cents,body.idempotency_key,body.reason,actor)});
    }
    const limit=Math.max(1,Math.min(200,Math.floor(Number(c.req.query('limit'))||50)));
    // Ledger is shared financial data. Managers get workspace debits only, owners get account ledger.
    const owner=isAccountOwner||platformAdmin;
    const entries=op==='usage'?await getDb()`SELECT * FROM hosting_usage_hours WHERE workspace_id=${id} ORDER BY hour DESC LIMIT ${limit}`:
      await getDb()`SELECT * FROM hosting_ledger WHERE account_id=${accountId} AND (${owner} OR workspace_id=${id}::uuid) ORDER BY created_at DESC,id DESC LIMIT ${limit}`;
    return c.json({workspace_id:id,account_id:accountId,entries});
  }catch(e){if(e instanceof HostingError)return c.json({code:e.code,error:e.message},e.status as any);throw e;}
});
