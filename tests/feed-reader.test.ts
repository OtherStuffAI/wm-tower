import { beforeAll, afterAll, test, expect } from 'bun:test';
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb, closeDb } from '../src/db';
import { config } from '../src/config';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { listVisibleFlightDeckPgEvents, listVisibleFlightDeckPgEventsForAudience } from '../src/services/flightdeck-pg-api';
import { buildOpenApiDocument } from '../src/openapi';
import { normalizeFeedSource } from '../src/services/feed-reader';
import { readFileSync } from 'node:fs';

// Run only against a dedicated test database; never initialize the live database.
if (!config.db.database.includes('test')) throw new Error('Feed reader tests require dedicated test DB_NAME');
const sql=postgres({host:config.db.host,port:config.db.port,username:config.db.user,password:config.db.password,database:config.db.database,onnotice:()=>{}});
const secrets=[new Uint8Array(32).fill(91),new Uint8Array(32).fill(92)];
let app: ReturnType<typeof createApp>;
const actors:string[]=[];const workspaces:string[]=[];const connections:string[]=[];
const mutation=(version=0)=>({mutation_id:randomUUID(),expected_row_version:version});
const source=(w=0)=>({kind:'wapp',autopilot_connection_id:connections[w],installation_id:'00000000-0000-4000-8000-000000000091',feed_id:'editions',endpoint:'/feed/editions',format:'jsonfeed-1.1'});
const base=(w=0)=>`/api/v4/flightdeck-pg/workspaces/${workspaces[w]}/feed-subscriptions`;
async function req(path:string, method='GET', actor=0, body?:any) {
  const data=body===undefined?undefined:JSON.stringify(body);
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',`http://localhost${path}`],['method',method],...(data?[['payload',createHash('sha256').update(data).digest('hex')]]:[])]},secrets[actor]!);
  const res=await app.request(path,{method,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,'Content-Type':'application/json'},body:data});
  return {status:res.status,body:await res.json() as any};
}
beforeAll(async()=> {
  setDb(sql);app=createApp();
  for(let a=0;a<2;a++) {
    const npub=nip19.npubEncode(getPublicKey(secrets[a]!));
    const [actor]=await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') ON CONFLICT(npub) DO UPDATE SET kind='human' RETURNING id`;actors.push(actor!.id);
  }
  for(let w=0;w<2;w++) {
    const [workspace]=await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('npub1testtower',${'npub1testfeed'+randomUUID()},${nip19.npubEncode(getPublicKey(secrets[0]!))},'npub1testfeedapp','Feed test',${actors[0]!}) RETURNING id`;
    workspaces.push(workspace!.id);
    for(const actor of actors) await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role,created_by_actor_id) VALUES(${workspace!.id},${actor},'member',${actors[0]!})`;
    const [conn]=await sql`INSERT INTO flightdeck_pg_autopilot_connections(workspace_id,installation_id,display_name,fips_endpoint,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspace!.id},${'ap-'+randomUUID()},'Portable logical instance','http://test.fips:8000',${actors[0]!},${actors[0]!}) RETURNING id`;connections.push(conn!.id);
  }
});
afterAll(async()=>{await closeDb();});
let sub:any;
test('subscribe replay, source dedup and portable identity are reader/workspace scoped',async()=> {
  const body={...mutation(),source:source()};
  const first=await req(base(),'POST',0,body);expect(first.status).toBe(200);sub=first.body.subscription;
  expect(sub.reader_actor_id).toBe(actors[0]);expect(sub.source_key).toBeUndefined();
  expect(await req(base(),'POST',0,body)).toEqual(first);
  expect((await req(base(),'POST',0,{...mutation(),source:source(),title:'another title'})).body.subscription.id).toBe(sub.id);
  expect((await req(base(),'POST',0,{...body,title:'changed'})).status).toBe(409);
  const second=await req(base(),'POST',1,{...mutation(),source:source()});expect(second.body.subscription.id).not.toBe(sub.id);
  expect((await req(base(1),'POST',0,{...mutation(),source:source(1)})).body.subscription.id).not.toBe(sub.id);
  expect((await req(base(1),'POST',0,{...mutation(),source:source()})).status).toBe(400);
  expect((await req(base(),'POST',0,{...mutation(),source:{...source(),autopilot_connection_id:randomUUID()}})).status).toBe(400);
});
test('every personal route hides another reader/workspace and rejects actor overrides',async()=> {
  for(const [w,a] of [[0,1],[1,0],[1,1]]) {
    expect((await req(`${base(w)}/${sub.id}`,'GET',a)).status).toBe(404);
    expect((await req(`${base(w)}/${sub.id}/item-states`,'GET',a)).status).toBe(404);
    expect((await req(`${base(w)}/${sub.id}`,'PATCH',a,{...mutation(1),patch:{title:'forged'}})).status).toBe(404);
    expect((await req(`${base(w)}/${sub.id}`,'DELETE',a,mutation(1))).status).toBe(404);
    expect((await req(`${base(w)}/${sub.id}/item-states`,'PUT',a,{...mutation(),item_id:'x',patch:{read:true}})).status).toBe(404);
    const list=await req(base(w),'GET',a);expect(list.body.subscriptions.every((r:any)=>r.reader_actor_id===actors[a]&&r.workspace_id===workspaces[w])).toBe(true);
  }
  expect((await req(base(),'POST',0,{...mutation(),source:source(),reader_actor_id:actors[1]})).status).toBe(400);
  expect((await req(base()+`?reader_actor_id=${actors[1]}`)).status).toBe(400);
});
test('field CAS preserves independent flags, idempotent replay and explicit unread',async()=> {
  const path=`${base()}/${sub.id}/item-states`;const body={...mutation(),item_id:'edition:1',patch:{read:true,saved:true}};
  const created=await req(path,'PUT',0,body);expect(created.status).toBe(200);expect(created.body.item_state.row_version).toBe(1);
  expect(await req(path,'PUT',0,body)).toEqual(created);
  const writes=await Promise.all([req(path,'PUT',0,{...mutation(1),item_id:'edition:1',patch:{dismissed:true}}),req(path,'PUT',0,{...mutation(1),item_id:'edition:1',patch:{read:false}})]);
  expect(writes.map(x=>x.status).sort()).toEqual([200,409]);
  const current=(await req(path)).body.item_states[0];expect(current.saved).toBe(true);
  const unread=await req(path,'PUT',0,{...mutation(current.row_version),item_id:'edition:1',patch:{read:false}});
  expect(unread.body.item_state.read).toBe(false);expect(unread.body.item_state.saved).toBe(true);
  expect((await req(path,'PUT',0,{...body,patch:{read:false}})).status).toBe(409);
  expect((await req(path,'PUT',0,{...mutation(),item_id:'edition:2',patch:{title:'private'}})).status).toBe(400);
});
test('unsubscribe retains identity/flags; stale subscribe cannot resurrect tombstone',async()=> {
  const original=(await req(`${base()}/${sub.id}`)).body.subscription;
  const unsub=await req(`${base()}/${sub.id}`,'DELETE',0,mutation(original.row_version));expect(unsub.status).toBe(200);
  expect(unsub.body.subscription.status).toBe('unsubscribed');
  expect((await req(base(),'POST',0,{...mutation(),source:source()})).status).toBe(409);
  expect((await req(`${base()}/${sub.id}`,'PATCH',0,{...mutation(original.row_version),patch:{status:'active'}})).status).toBe(409);
  expect((await req(`${base()}/${sub.id}/item-states`,'PUT',0,{...mutation(),item_id:'offline',patch:{read:true}})).status).toBe(409);
  expect((await req(`${base()}/${sub.id}/item-states`)).body.item_states[0].saved).toBe(true);
  const resub=await req(`${base()}/${sub.id}`,'PATCH',0,{...mutation(unsub.body.subscription.row_version),patch:{status:'active'}});
  expect(resub.body.subscription.id).toBe(sub.id);expect((await req(`${base()}/${sub.id}/item-states`)).body.item_states).toHaveLength(1);
});
test('keyset cursor misuse rejected across reader, workspace and route',async()=> {
  for(let i=0;i<3;i++) await req(base(),'POST',0,{...mutation(),source:{kind:'public',url:`https://example.invalid/${i}#fragment`,format:'rss'}});
  const first=await req(base()+'?limit=1');const cursor=first.body.next_cursor;expect(cursor).toBeTruthy();
  expect((await req(base()+`?cursor=${cursor}&limit=1`)).status).toBe(200);
  expect((await req(base()+`?cursor=${cursor}`,'GET',1)).status).toBe(400);
  expect((await req(base(1)+`?cursor=${cursor}`)).status).toBe(400);
  expect((await req(`${base()}/${sub.id}/item-states?cursor=${cursor}`)).status).toBe(400);
  expect((await req(base()+'?cursor=bad')).status).toBe(400);
  expect((await req(base()+'?limit=201')).status).toBe(400);
});
test('manager audience does not delegate personal feed events',async()=> {
  const page=await listVisibleFlightDeckPgEventsForAudience({workspaceId:workspaces[0]!,afterRowVersion:0,limit:200,audience:actors.map((actorId,a)=>({actorId,npub:nip19.npubEncode(getPublicKey(secrets[a]!)),groupIds:[],includeWorkspaceEvents:true}))});
  expect(page.events.some(({event})=>event.entity_type.startsWith('feed_'))).toBe(false);
});
test('event HTTP pages filter by actual reader in both workspaces',async()=> {
  for(let w=0;w<2;w++) for(let a=0;a<2;a++) {
    let cursor='';let count=0;
    for(let page=0;page<100;page++) {
      const path=`/api/v4/flightdeck-pg/workspaces/${workspaces[w]}/events?limit=1${cursor?'&cursor='+cursor:''}`;
      const response=await req(path,'GET',a);expect(response.status).toBe(200);
      for(const event of response.body.events) if(event.entity_type.startsWith('feed_')) {
        expect(event.payload.reader_actor_id).toBe(actors[a]);expect(event.workspace_id).toBe(workspaces[w]);count++;
      }
      if(!response.body.events.length) break;
      cursor=response.body.next_cursor;
    }
    if(w===0||a===0) expect(count).toBeGreaterThan(0);
  }
});
test('outbox visibility remains reader-only even with workspace-read access',async()=> {
  for(const workspaceId of workspaces) for(const actorId of actors) {
    const events=await listVisibleFlightDeckPgEvents({workspaceId,actorId,groupIds:[],afterRowVersion:0,limit:200,includeWorkspaceEvents:true});
    const personal=events.filter(e=>e.entity_type.startsWith('feed_'));
    expect(personal.every(e=>e.payload.reader_actor_id===actorId && e.workspace_id===workspaceId)).toBe(true);
    expect(personal.some(e=>e.payload.reader_actor_id!==actorId)).toBe(false);
  }
});
async function hydrate(w:number,a:number,cursor?:string) {
  const changes:any[]=[];let page:any;
  for(let i=0;i<200;i++) {
    page=await readFlightDeckRecordPage({workspaceId:workspaces[w]!,actorId:actors[a]!,cursor,limit:2});
    changes.push(...page.changes);cursor=page.next_cursor;
    if(!page.has_more) return {changes,cursor};
  }
  throw new Error('Recovery failed to terminate');
}
test('two-client snapshot and lost-event delta recovery isolate every page',async()=> {
  for(let w=0;w<2;w++) for(let a=0;a<2;a++) {
    const result=await hydrate(w,a);const personal=result.changes.filter(c=>c.family.startsWith('feed_'));
    expect(personal.length).toBeGreaterThanOrEqual(w===0||a===0?1:0);
    expect(personal.every(c=>c.row.reader_actor_id===actors[a] && c.row.workspace_id===workspaces[w])).toBe(true);
  }
  const client=await hydrate(0,0);const other=await hydrate(0,0);
  const row=(await req(`${base()}/${sub.id}/item-states`)).body.item_states[0];
  await req(`${base()}/${sub.id}/item-states`,'PUT',0,{...mutation(row.row_version),item_id:row.item_id,patch:{saved:false}});
  const recovered=await hydrate(0,0,client.cursor);const second=await hydrate(0,0,other.cursor);
  expect(recovered.changes.filter(c=>c.family==='feed_item_state').at(-1).row.saved).toBe(false);
  expect(second.changes).toEqual(recovered.changes);
  await expect(readFlightDeckRecordPage({workspaceId:workspaces[1]!,actorId:actors[0]!,cursor:client.cursor})).rejects.toThrow('reset_required');
  await expect(readFlightDeckRecordPage({workspaceId:workspaces[0]!,actorId:actors[1]!,cursor:client.cursor})).rejects.toThrow('reset_required');
});
test('schema upgrade replay preserves reader/publisher data and bootstrap schema matches runtime',async()=> {
  const before=await sql`SELECT * FROM flightdeck_pg_feed_subscriptions ORDER BY id`;
  const legacy=await sql`SELECT count(*)::int AS count FROM flightdeck_pg_wapp_publishing_grants`;
  await ensureRuntimeSchema(sql);await ensureRuntimeSchema(sql);
  expect([...(await sql`SELECT * FROM flightdeck_pg_feed_subscriptions ORDER BY id`)]).toEqual([...before]);
  expect([...(await sql`SELECT count(*)::int AS count FROM flightdeck_pg_wapp_publishing_grants`)]).toEqual([...legacy]);
  const bootstrap=readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8');
  expect(bootstrap.split('-- feed_reader_v1\n')[1]!.split('-- end_feed_reader_v1')[0]).toBe(readFileSync(new URL('../src/schema/feed-reader-v1.sql',import.meta.url),'utf8'));
});
test('OpenAPI documents every feed route and metadata-only schemas',()=> {
  const doc=buildOpenApiDocument('http://localhost');
  expect(doc['x-wapp-feed-reader-source-build']).toBe(1);
  for(const path of [base().replace(workspaces[0]!,'{workspaceId}'),base().replace(workspaces[0]!,'{workspaceId}')+'/{subscriptionId}',base().replace(workspaces[0]!,'{workspaceId}')+'/{subscriptionId}/item-states']) expect((doc.paths as any)[path]).toBeTruthy();
  expect(normalizeFeedSource({kind:'public',url:'https://example.invalid/feed?b=2&a=1#x',format:'rss'})).toEqual({kind:'public',url:'https://example.invalid/feed?b=2&a=1',format:'rss'});
  expect(()=>normalizeFeedSource({...source(),endpoint:'//evil.invalid/feed'})).toThrow();
  const credentialUrl=new URL('https://example.invalid/');credentialUrl.username='test';credentialUrl.password='test';
  expect(()=>normalizeFeedSource({kind:'public',url:credentialUrl.href,format:'rss'})).toThrow();
});

test('signed SSE streams expose only actual reader events across both workspaces',async()=> {
  for(let w=0;w<2;w++) for(let a=0;a<2;a++) {
    if(w===1&&a===1) await req(base(w),'POST',a,{...mutation(),source:source(w)});
    const path=`/api/v4/flightdeck-pg/workspaces/${workspaces[w]}/events/stream?limit=200`;
    const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',`http://localhost${path}`],['method','GET']]},secrets[a]!);
    const response=await app.request(path,{headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`}});
    expect(response.status).toBe(200);const reader=response.body!.getReader();let buffer='';let found=false;
    const timeout=setTimeout(()=>{void reader.cancel();},2000);
    try {
      while(!found) {
        const part=await reader.read();if(part.done) break;buffer+=new TextDecoder().decode(part.value);
        const frames=buffer.split('\n\n');buffer=frames.pop()!;
        for(const frame of frames) {
          if(!frame.includes('event: flightdeck_pg.event')) continue;
          const line=frame.split('\n').find(l=>l.startsWith('data: '));if(!line) continue;
          const row=JSON.parse(line.slice(6));
          if(row.entity_type.startsWith('feed_')) {
            expect(row.payload.reader_actor_id).toBe(actors[a]);expect(row.workspace_id).toBe(workspaces[w]);found=true;
          }
        }
      }
      expect(found).toBe(true);
    } finally {clearTimeout(timeout);await reader.cancel();}
  }
});
test('feed routes require real signer and workspace membership',async()=> {
  expect((await app.request(base())).status).toBe(401);
  await sql`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${workspaces[1]!} AND actor_id=${actors[1]!}`;
  expect((await req(base(1),'GET',1)).status).toBe(403);
  expect((await req(base(1),'POST',1,{...mutation(),source:source(1)})).status).toBe(403);
  await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaces[1]!},${actors[1]!},'member')`;
});

test('composite state identity rejects cross-reader/workspace binding and explicit workspace deletion cascades metadata',async()=> {
  for(const [workspaceId,actorId] of [[workspaces[0]!,actors[1]!],[workspaces[1]!,actors[0]!]]) {
    let code='';
    try {await sql`INSERT INTO flightdeck_pg_feed_item_states(workspace_id,reader_actor_id,subscription_id,item_id)
      VALUES(${workspaceId},${actorId},${sub.id},'forged')`;} catch(error) {code=(error as any).code;}
    expect(code).toBe('23503');
  }
  const [workspace]=await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
    VALUES('test',${'npub1deletefeed'+randomUUID()},'test','test','Explicit delete fixture') RETURNING id`;
  const [subscription]=await sql`INSERT INTO flightdeck_pg_feed_subscriptions(workspace_id,reader_actor_id,source,source_key)
    VALUES(${workspace!.id},${actors[0]!},${sql.json({kind:'public',url:'https://example.invalid/feed',format:'rss'})},${sql.json(['public','https://example.invalid/feed'])}) RETURNING id`;
  await sql`INSERT INTO flightdeck_pg_feed_item_states(workspace_id,reader_actor_id,subscription_id,item_id) VALUES(${workspace!.id},${actors[0]!},${subscription!.id},'test')`;
  await sql`INSERT INTO flightdeck_pg_feed_mutations(workspace_id,reader_actor_id,mutation_id,request_hash,acknowledgement) VALUES(${workspace!.id},${actors[0]!},${randomUUID()},'test','{}')`;
  await sql`INSERT INTO flightdeck_pg_feed_cursors(workspace_id,reader_actor_id,route,after_id) VALUES(${workspace!.id},${actors[0]!},'test',${subscription!.id})`;
  await sql`DELETE FROM flightdeck_pg_workspaces WHERE id=${workspace!.id}`;
  for(const table of ['subscriptions','item_states','mutations','cursors']) expect(await sql`SELECT 1 FROM ${sql('flightdeck_pg_feed_'+table)} WHERE workspace_id=${workspace!.id}`).toHaveLength(0);
});
