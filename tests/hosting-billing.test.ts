import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import Stripe from 'stripe';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb, closeDb } from '../src/db';
import { config } from '../src/config';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { linkHostedAccount, grantHostingCredit, auditHostingHour, coveredBytes, USD_UNITS, unitsUsd, hostingStatus, runHostingBillingTick } from '../src/services/hosting-billing';
import { fulfillHostingCheckout, receiveHostingStripeWebhook, createHostingCheckout, hostingStripeClient } from '../src/services/hosting-stripe';
import { storageUsageSnapshot } from '../src/services/workspace-storage-usage';
import { createApp } from '../src/server';
const usage=(id:string, hour:Date, bytes:number|null)=>storageUsageSnapshot(id,hour.toISOString(),[
  {id:'objects',label:'Objects',bytes,status:bytes===null?'unavailable':'partial',measurement:bytes===null?'unavailable':'registered_bytes',reason:'Completed linked object fixture'},
  {id:'database',label:'Database',bytes:0,status:'partial',measurement:'logical_estimate',reason:'Fixture'},
  {id:'graph',label:'Graph',bytes:null,status:'unavailable',measurement:'unavailable',reason:'Unsupported'},
]);
test('exact tariff and fractional precision; incomplete required categories fail closed',()=>{
  expect(unitsUsd(1_000_000_000n*720n)).toBe('5.000000000000');
  expect(coveredBytes(usage('x',new Date(),null))).toBeNull();
  expect(coveredBytes(usage('x',new Date(),1))).toBe(1n);
  expect(unitsUsd(1n)).toBe('0.000000000006');
});
const port=Number(process.env.HOSTING_TEST_PORT);
describe.skipIf(!port||port===5432)('USD hosting on disposable PostgreSQL',()=>{
  const conn={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
  const name=`tower_hosting_${process.pid}_${Date.now()}`;
  let db:ReturnType<typeof postgres>, actor:string,account:string,a:string,b:string, outsider:string;
  const ownerKey=new Uint8Array(32).fill(91),outsiderKey=new Uint8Array(32).fill(92);
  const owner=nip19.npubEncode(getPublicKey(ownerKey)),other=nip19.npubEncode(getPublicKey(outsiderKey));
  const app=createApp();
  const stripe=new Stripe('sk_test_fixture');
  const hour=new Date('2026-09-01T00:00:00Z');
  beforeAll(async()=>{
    const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${name}`);await admin.end();
    db=postgres({...conn,database:name});setDb(db);
    for(const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8')))await db.unsafe(statement);
    const [o]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${owner},'human') RETURNING id`;actor=o!.id;
    const [m]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${other},'human') RETURNING id`;outsider=m!.id;
    [a,b]=[randomUUID(),randomUUID()];
    for(const id of [a,b]){
      await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${id},'tower',${id},${owner},'hosting-fixture','Hosting')`;
      await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${id},${actor},'owner'),(${id},${outsider},'admin')`;
    }
  });
  afterAll(async()=>{await closeDb();});
  function req(op:string,key=ownerKey,body?:unknown,method=body?'POST':'GET'){
    const path=`http://localhost/api/v4/hosting-billing/workspaces/${a}/${op}`,raw=body?JSON.stringify(body):undefined;
    const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:randomUUID(),tags:[['u',path],['method',method],...(raw?[['payload',createHash('sha256').update(raw).digest('hex')]]:[])]},key);
    return app.request(path,{method,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`},body:raw});
  }
  test('concurrent links create one welcome grant, shared account; existing rows are unlinked',async()=>{
    expect((await hostingStatus(a,db) as any).billing_mode).toBe('legacy_unlinked');
    const results=await Promise.all(Array.from({length:10},(_,i)=>db.begin(tx=>linkHostedAccount(i%2?a:b,actor,tx as any))));
    account=results[0]!.id;expect(new Set(results.map(r=>r.id)).size).toBe(1);
    const entries=await db`SELECT * FROM hosting_ledger WHERE account_id=${account}`;expect(entries.length).toBe(1);expect(entries[0]!.amount_units).toBe((5n*USD_UNITS).toString());
    await db`UPDATE hosting_workspace_accounts SET enabled_at=${hour} WHERE account_id=${account}`;
    await db`UPDATE hosting_accounts SET promo_expires_at='2027-01-01' WHERE id=${account}`;
  });
  test('joining never creates customer credit; a separately owned workspace gets a distinct once-only account',async()=>{
    const before=await db`SELECT id FROM hosting_accounts WHERE owner_actor_id=${outsider}`;expect(before.length).toBe(0);
    const id=randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${id},'tower',${id},${other},'hosting-fixture','Other customer')`;
    const result=await db.begin(tx=>linkHostedAccount(id,outsider,tx as any));expect(result.id).not.toBe(account);
    await expect(db.begin(tx=>linkHostedAccount(a,outsider,tx as any))).rejects.toThrow('billing_owner_conflict');
  });
  test('admin grants are concurrent-safe, audited and reject conflicting retries',async()=>{
    const grants=await Promise.all(Array.from({length:10},()=>grantHostingCredit(account,500,'fixture-grant','Reviewed fixture',owner,db)));
    expect(new Set(grants.map(g=>g!.id)).size).toBe(1);
    const [row]=await db`SELECT paid_units FROM hosting_accounts WHERE id=${account}`;expect(row!.paid_units).toBe((5n*USD_UNITS).toString());
    await expect(grantHostingCredit(account,1000,'fixture-grant','Reviewed fixture',owner,db)).rejects.toThrow('idempotency_conflict');
    await expect(grantHostingCredit(account,1,'bad',undefined as any,owner,db)).rejects.toThrow('invalid_grant');
  });
  test('720 contemporaneous 1GB hours equal exactly $5; retried hourly charges debit once',async()=>{
    for(let n=0;n<720;n++){
      const h=new Date(hour.getTime()+n*3600000);
      const sample=usage(a,h,1_000_000_000);
      if(n===0){const rows=await Promise.all(Array.from({length:8},()=>auditHostingHour(a,h,sample,db,h)));expect(rows.every(r=>r!.debit_units==='1000000000')).toBe(true);}
      else await auditHostingHour(a,h,sample,db,h);
    }
    const [sum]=await db`SELECT sum(debit_units)::text AS total,count(*)::int AS count FROM hosting_usage_hours WHERE workspace_id=${a}`;
    expect(sum!.total).toBe((5n*USD_UNITS).toString());expect(sum!.count).toBe(720);
    const h=new Date(hour.getTime()+720*3600000);await auditHostingHour(a,h,usage(a,h,1),db,h);
    const [row]=await db`SELECT paid_units,promo_units FROM hosting_accounts WHERE id=${account}`;expect(row!.paid_units).toBe((5n*USD_UNITS-1n).toString());expect(row!.promo_units).toBe('0');
  });
  test('unknown samples and restart catchup never fabricate historical charges',async()=>{
    const h=new Date(hour.getTime()+721*3600000);
    expect((await auditHostingHour(a,h,usage(a,h,null),db,h))!.status).toBe('unavailable');
    expect((await auditHostingHour(a,new Date(h.getTime()+3600000),usage(a,h,999),db,new Date(h.getTime()+3600000)))!.status).toBe('unavailable');
    const now=new Date(h.getTime()+3*3600000);
    await runHostingBillingTick(db,now,async(id)=>usage(id,now,1));
    await runHostingBillingTick(db,now,async(id)=>usage(id,now,500));
    const rows=await db`SELECT * FROM hosting_usage_hours WHERE workspace_id=${a} AND hour>${h} ORDER BY hour`;
    expect(rows.map(r=>r.status)).toEqual(['unavailable','missed','charged']);expect(rows[2]!.debit_units).toBe('1');
    const status=await hostingStatus(a,db,now) as any;expect(status.hourly_burn_usd).not.toBeNull();expect(status.estimated_runout_at).toBeNull();
  });
  test('owner/manager reads, workspace admin cannot mint; strict mutation signatures required',async()=>{
    expect((await app.request(`http://localhost/api/v4/hosting-billing/workspaces/${a}/status`)).status).toBe(401);
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${a},'actor',${outsider},'workspace','workspace.manage')`;
    expect((await req('status')).status).toBe(200);expect((await req('status',outsiderKey)).status).toBe(200);
    const target=`http://localhost/api/v4/hosting-billing/workspaces/${a}/grant`;
    const noPayload=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:randomUUID(),tags:[['u',target],['method','POST']]},ownerKey);
    expect((await app.request(target,{method:'POST',body:JSON.stringify({amount_cents:1,idempotency_key:'unsigned-body',reason:'fixture'}),headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(noPayload)).toString('base64')}`}})).status).toBe(401);
    expect((await req('grant',outsiderKey,{amount_cents:500,idempotency_key:'unauthorized',reason:'No'})).status).toBe(403);
    const old=config.adminNpub;config.adminNpub=owner;
    try {expect((await req('grant',ownerKey,{amount_cents:100,idempotency_key:'api-grant',reason:'Audited API fixture'})).status).toBe(200);}finally{config.adminNpub=old;}
    expect((await req('checkout',outsiderKey,{amount_cents:500,idempotency_key:'owner-only',return_url:'https://example.test'})).status).toBe(403);
  });
  test('exhaustion blocks PG mutation while reads/billing/grants remain accessible; 21-day grace',async()=>{
    await db`UPDATE hosting_accounts SET paid_units=0,promo_units=0,depleted_at=now() WHERE id=${account}`;
    const target=`http://localhost/api/v4/flightdeck-pg/workspaces/${a}/tasks`;
    const signed=(method='POST',url=target)=>{const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:randomUUID(),tags:[['u',url],['method',method],['payload',createHash('sha256').update('{}').digest('hex')]]},ownerKey);return {method,body:'{}',headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`}};};
    const mutation=await app.request(target,signed());expect(mutation.status).toBe(402);
    const root=`http://localhost/api/v4/flightdeck-pg/workspaces/${a}`;
    expect((await app.request(root,signed('DELETE',root))).status).toBe(402);
    const publisher=`http://localhost/api/v4/wapp-activity/workspaces/${a}/items`;
    expect((await app.request(publisher,signed('POST',publisher))).status).toBe(402);
    const status=await (await req('status')).json();expect(status.billing_state).toBe('read_only_grace');expect(Date.parse(status.grace_ends_at)-Date.parse(status.depleted_at)).toBe(21*86400000);
    await db`UPDATE hosting_accounts SET paid_units=${(-USD_UNITS).toString()} WHERE id=${account}`;
    await grantHostingCredit(account,1,'insufficient-restore','Partial deficit payment',owner,db);
    expect((await app.request(target,signed())).status).toBe(402);
    await grantHostingCredit(account,500,'restore','Restore fixture',owner,db);
    const restored=await app.request(target,signed());expect(restored.status).not.toBe(402);
  });
  let order:string;
  function session(paid=true){return {id:'cs_test_fixture',mode:'payment',livemode:false,payment_status:paid?'paid':'unpaid',currency:'usd',amount_total:500,payment_intent:'pi_fixture',client_reference_id:order,metadata:{hosting_order_id:order,hosting_account_id:account}} as unknown as Stripe.Checkout.Session;}
  test('promo expiry is audited once; missing measurements do not independently mark depletion',async()=>{
    const id=randomUUID();
    await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES(${id},'tower',${id},${other},'hosting-fixture','Expired promo')`;
    const result=await db.begin(tx=>linkHostedAccount(id,outsider,tx as any));
    const now=new Date(),h=new Date(Math.floor(now.getTime()/3600000)*3600000);
    await db`UPDATE hosting_workspace_accounts SET enabled_at=${h} WHERE workspace_id=${id}`;
    await db`UPDATE hosting_accounts SET promo_expires_at=${new Date(h.getTime()-1)} WHERE id=${result.id}`;
    await Promise.all([auditHostingHour(id,h,usage(id,h,null),db,now),auditHostingHour(id,h,usage(id,h,null),db,now)]);
    const [a]=await db`SELECT * FROM hosting_accounts WHERE id=${result.id}`;expect(a!.promo_units).toBe('0');expect(a!.depleted_at).toBeNull();
    expect((await db`SELECT * FROM hosting_ledger WHERE account_id=${result.id} AND kind='promo_expiry'`).length).toBe(1);
  });
  test('test Checkout server amounts/returns/account binding and retries',async()=>{
    process.env.HOSTING_STRIPE_RETURN_URLS='https://example.test/billing';
    let calls=0;const mock={checkout:{sessions:{create:async(params:any,opts:any)=>{calls++;expect(params.line_items[0].price_data.unit_amount).toBe(500);expect(params.metadata.hosting_account_id).toBe(account);expect(opts.idempotencyKey).toStartWith('hosting-v1:');return {id:'cs_test_fixture',url:'https://checkout.stripe.com/test',livemode:false};},retrieve:async()=>({id:'cs_test_fixture',url:'https://checkout.stripe.com/test',livemode:false})}}};
    const body={amount_cents:500,idempotency_key:'checkout-fixture',return_url:'https://example.test/billing'};
    const result=await createHostingCheckout(account,body,db,mock as any);order=result.order_id;
    expect((await createHostingCheckout(account,body,db,mock as any)).order_id).toBe(order);expect(calls).toBe(1);
    await expect(createHostingCheckout(account,{...body,amount_cents:1},db,mock as any)).rejects.toThrow('invalid_checkout');
    await expect(createHostingCheckout(account,{...body,return_url:'https://evil.test'},db,mock as any)).rejects.toThrow('return_url_not_allowed');
  });
  test('unpaid, duplicate concurrent paid and account mismatch fulfillment',async()=>{
    expect(await fulfillHostingCheckout(session(false),db)).toEqual({credited:false});
    await expect(fulfillHostingCheckout({...session(),amount_total:1000},db)).rejects.toThrow('stripe_binding_mismatch');
    const results=await Promise.all(Array.from({length:8},()=>fulfillHostingCheckout(session(),db)));expect(results.filter(r=>r.credited).length).toBe(1);
    const entries=await db`SELECT * FROM hosting_ledger WHERE kind='stripe' AND account_id=${account}`;expect(entries.length).toBe(1);expect(entries[0]!.amount_units).toBe((5n*USD_UNITS).toString());
    expect(await fulfillHostingCheckout(session(false),db)).toEqual({credited:false});
  });
  test('SDK raw-body webhook verification rejects tampering; verified retries grant no duplicate',async()=>{
    process.env.STRIPE_WEBHOOK_SECRET='whsec_fixture';
    const raw=Buffer.from(JSON.stringify({id:'evt_fixture',object:'event',type:'checkout.session.completed',livemode:false,data:{object:session()}}));
    const signature=await stripe.webhooks.generateTestHeaderStringAsync({payload:raw.toString(),secret:'whsec_fixture'});
    const mock={webhooks:stripe.webhooks,checkout:{sessions:{retrieve:async()=>session()}}};
    expect(await receiveHostingStripeWebhook(raw,signature,db,mock as any)).toMatchObject({received:true,credited:false,duplicate:true});
    await expect(receiveHostingStripeWebhook(Buffer.from(raw.toString()+' '),signature,db,mock as any)).rejects.toThrow('stripe_signature_invalid');
    await expect(receiveHostingStripeWebhook(raw,null,db,mock as any)).rejects.toThrow('stripe_signature_required');
    delete process.env.STRIPE_SECRET_KEY;expect(()=>hostingStripeClient()).toThrow('stripe_unconfigured');
    process.env.HOSTING_STRIPE_MODE='live';expect(()=>hostingStripeClient()).toThrow('stripe_live_rollout_blocked');delete process.env.HOSTING_STRIPE_MODE;
  });
});
