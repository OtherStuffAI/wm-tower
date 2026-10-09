import Stripe from 'stripe';
import { getDb } from '../db';
import { centsUnits, lockedAccount, HostingError } from './hosting-billing';
type Db=ReturnType<typeof getDb>;
export function hostingStripeClient() {
  const key=process.env.STRIPE_SECRET_KEY;
  const mode=process.env.HOSTING_STRIPE_MODE||'test';
  // Live rollout stays blocked until refund/dispute reconciliation and live acceptance are reviewed.
  if(mode!=='test')throw new HostingError(503,'stripe_live_rollout_blocked');
  if(!key||!process.env.STRIPE_WEBHOOK_SECRET||!process.env.HOSTING_STRIPE_RETURN_URLS)throw new HostingError(503,'stripe_unconfigured');
  if(!key.startsWith('sk_test_')&&!key.startsWith('rk_test_'))throw new HostingError(503,'stripe_mode_mismatch');
  return new Stripe(key,{maxNetworkRetries:2,timeout:15000});
}
export async function createHostingCheckout(accountId:string,body:unknown,db:Db=getDb(),client=hostingStripeClient()) {
  const b=body as any;
  if(!b||Object.keys(b).sort().join(',')!=='amount_cents,idempotency_key,return_url'||![500,1000,2500,5000,10000].includes(b.amount_cents)
    ||typeof b.idempotency_key!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(b.idempotency_key)||typeof b.return_url!=='string')throw new HostingError(400,'invalid_checkout');
  const allowed=(process.env.HOSTING_STRIPE_RETURN_URLS||'').split(',').map(s=>s.trim());
  if(!allowed.includes(b.return_url))throw new HostingError(400,'return_url_not_allowed');
  let u:URL;try{u=new URL(b.return_url);}catch{throw new HostingError(400,'invalid_return_url');}
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw new HostingError(400,'invalid_return_url');
  const order=await db.begin(async transaction=>{
    const tx=transaction as unknown as Db;
    await tx`SELECT id FROM hosting_accounts WHERE id=${accountId} FOR UPDATE`;
    const [o]=await tx`INSERT INTO hosting_checkout_orders(account_id,idempotency_key,amount_cents,return_url,mode)
      VALUES(${accountId},${b.idempotency_key},${b.amount_cents},${b.return_url},'test')
      ON CONFLICT(account_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`;
    if(o!.amount_cents!==b.amount_cents||o!.return_url!==b.return_url||o!.mode!=='test')throw new HostingError(409,'idempotency_conflict');return o!;
  });
  const session=order.session_id?await client.checkout.sessions.retrieve(order.session_id):await client.checkout.sessions.create({
    mode:'payment',allowed_payment_method_types:['card'],client_reference_id:order.id,
    metadata:{hosting_order_id:order.id,hosting_account_id:accountId},
    payment_intent_data:{metadata:{hosting_order_id:order.id,hosting_account_id:accountId}},
    line_items:[{price_data:{currency:'usd',unit_amount:order.amount_cents,product_data:{name:'Prepaid Tower hosting credit'}},quantity:1}],
    success_url:b.return_url,cancel_url:b.return_url,
  },{idempotencyKey:`hosting-v1:${order.id}`});
  if(session.livemode)throw new HostingError(503,'stripe_mode_mismatch');
  await db`UPDATE hosting_checkout_orders SET session_id=${session.id} WHERE id=${order.id} AND (session_id IS NULL OR session_id=${session.id})`;
  return {order_id:order.id,checkout_url:session.url,mode:'test',amount_cents:order.amount_cents};
}
export async function fulfillHostingCheckout(session:Stripe.Checkout.Session,db:Db=getDb()) {
  if(session.livemode||session.mode!=='payment'||session.payment_status!=='paid')return {credited:false};
  if(!session.metadata?.hosting_order_id)return {credited:false};
  return db.begin(async transaction=>{
    const tx=transaction as unknown as Db;
    const [o]=await tx`SELECT * FROM hosting_checkout_orders WHERE id=${session.metadata!.hosting_order_id} FOR UPDATE`;
    if(!o)return {credited:false};
    if(o.mode!=='test'||session.client_reference_id!==o.id||session.metadata!.hosting_account_id!==o.account_id||session.currency!=='usd'||session.amount_total!==o.amount_cents
      ||(o.session_id&&o.session_id!==session.id)||typeof session.payment_intent!=='string')throw new HostingError(400,'stripe_binding_mismatch');
    if(o.fulfilled_at)return {credited:false,duplicate:true};
    const a=await lockedAccount(o.account_id,tx,new Date());
    const amount=centsUnits(o.amount_cents),paid=BigInt(a!.paid_units)+amount;
    // Unique payment_intent prevents two orders ever crediting the same payment.
    await tx`UPDATE hosting_checkout_orders SET session_id=${session.id},payment_intent=${session.payment_intent},fulfilled_at=now() WHERE id=${o.id}`;
    await tx`UPDATE hosting_accounts SET paid_units=${paid.toString()},depleted_at=CASE WHEN ${paid.toString()}::numeric+promo_units>0 THEN NULL ELSE depleted_at END WHERE id=${o.account_id}`;
    await tx`INSERT INTO hosting_ledger(account_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason,metadata)
      VALUES(${o.account_id},'stripe',${amount.toString()},${paid.toString()},${a!.promo_units},${`stripe:${session.payment_intent}`},'Verified paid Stripe Checkout',${tx.json({session_id:session.id,payment_intent:session.payment_intent,mode:'test'})})`;
    return {credited:true};
  });
}
export async function receiveHostingStripeWebhook(raw:Buffer,signature:string|null,db:Db=getDb(),client=hostingStripeClient()) {
  if(!signature)throw new HostingError(400,'stripe_signature_required');
  let event:Stripe.Event;
  try {event=await client.webhooks.constructEventAsync(raw,signature,process.env.STRIPE_WEBHOOK_SECRET!);}catch{throw new HostingError(400,'stripe_signature_invalid');}
  if(event.livemode)throw new HostingError(400,'stripe_mode_mismatch');
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))return {received:true,credited:false};
  const object=event.data.object as Stripe.Checkout.Session;
  // Retrieve authoritative paid state; event ordering never rolls a paid order back.
  const session=await client.checkout.sessions.retrieve(object.id);
  return {received:true,...await fulfillHostingCheckout(session,db)};
}
