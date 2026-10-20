import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {adoptRecordCache} from '../src/services/flightdeck-record-adoption';
import {registerRecordClient,readRecordCheckpoint} from '../src/services/flightdeck-record-checkpoints';
import {readFlightDeckRecordPage} from '../src/services/flightdeck-record-delta';
import {normalizePriorityFilters,readRepairManifest,repairRecords} from '../src/services/flightdeck-record-priority';
import {splitSqlStatements} from '../src/schema/sql-statements';
import {buildOpenApiDocument} from '../src/openapi';
import {createApp} from '../src/server';
import {recordAdoptionDiscovery} from '../src/services/flightdeck-record-adoption';

const port=Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port||port===5432)('existing cache adoption v1',()=>{
  const database=`tower_record_adoption_${process.pid}_${Date.now()}`;
  const connection={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
  const appNpub='adoption-app';
  let db:ReturnType<typeof postgres>;let workspaceId:string,otherWorkspaceId:string,actorId:string,otherActorId:string,scopeId:string,channelId:string;
  beforeAll(async()=>{const admin=postgres({...connection,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${database}`);await admin.end();
    db=postgres({...connection,database});for(const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8')))await db.unsafe(statement);
    const actors=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('npub1adopter','human'),('npub1foreign','human') RETURNING id,npub`;
    actorId=actors.find(row=>row.npub==='npub1adopter')!.id;otherActorId=actors.find(row=>row.npub==='npub1foreign')!.id;
    const [workspace]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('tower','workspace','owner',${appNpub},'Adoption',${actorId}) RETURNING id`;workspaceId=workspace!.id;
    const [other]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('tower','workspace-other','owner-other',${appNpub},'Other',${actorId}) RETURNING id`;otherWorkspaceId=other!.id;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${actorId},'owner'),(${workspaceId},${otherActorId},'member'),(${otherWorkspaceId},${actorId},'owner')`;
    const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Scope','project') RETURNING id`;scopeId=scope!.id;
    const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'Channel') RETURNING id`;channelId=channel!.id;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission)
      VALUES(${workspaceId},'actor',${actorId},'scope',${scopeId},'scope.read')`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${workspaceId},'actor',${actorId},'channel',${channelId},'channel.read')`;
    for(let i=0;i<8;i++)await message(`cached ${i}`);
    const deleted=await message('cached tombstone');await db`DELETE FROM flightdeck_pg_messages WHERE id=${deleted}`;
  });
  afterAll(async()=>{await db?.end();const admin=postgres({...connection,database:'postgres'});await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);await admin.end();});
  const viewer=()=>({workspaceId,actorId,appNpub});
  const client=(clientId:string)=>({...viewer(),clientId});
  async function message(body:string){const [row]=await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id)
    VALUES(${workspaceId},${scopeId},${channelId},${body},${actorId},${actorId}) RETURNING id`;return row!.id;}
  async function manifestCursor(filters=normalizePriorityFilters({})){const page=await readRepairManifest({...viewer(),filters,limit:1},db);return page.next_cursor;}
  async function start(clientId:string,manifest_cursor?:string,request_id=randomUUID()){
    manifest_cursor??=await manifestCursor();
    const checkpoint=await registerRecordClient({workspaceId,actorId,clientId},db);
    const request={request_id,manifest_cursor,expected_checkpoint_revision:checkpoint.checkpoint_revision};
    const response=await adoptRecordCache(client(clientId),request,db);
    return {checkpoint,response,request};
  }
  const exact=(challenge:any[])=>challenge.map(({family,id,state,version})=>({family,id,state,version}));
  async function finish(clientId:string,response:any,missingId?:string){let repairs=0,pages=0;
    while(response.status!=='adopted'){
      if(response.status==='inventory_required'){
        pages++;const inventory=exact(response.challenge).map((entry:any)=>entry.id===missingId?{family:entry.family,id:entry.id,state:'missing'}:entry);
        response=await adoptRecordCache(client(clientId),{cursor:response.cursor,inventory},db);
      }else{
        repairs+=response.records.length;const repaired=await repairRecords({...viewer(),records:response.records.map((entry:any)=>({family:entry.family,id:entry.id,version:entry.version}))},db);
        response=await adoptRecordCache(client(clientId),{cursor:response.cursor,repaired:repaired.changes.map(change=>({family:change.family,id:change.id,state:change.operation==='delete'?'deleted':'active',version:change.version}))},db);
      }
    }
    return {response,repairs,pages};
  }

  test('a complete cache transfers no bodies and atomically supersedes an issued snapshot',async()=>{const clientId=randomUUID();const {checkpoint,response}=await start(clientId);const oldInitial=checkpoint.initial_cursor;
    const issued=await readFlightDeckRecordPage({workspaceId,actorId,clientId,protocolVersion:2,cursor:oldInitial},db);expect(issued.mode).toBe('snapshot');
    const done=await finish(clientId,response);expect(done.repairs).toBe(0);expect(done.response.status).toBe('adopted');
    const saved=await readRecordCheckpoint({workspaceId,actorId,clientId},db);expect(saved.checkpoint_cursor).toBe(done.response.checkpoint.checkpoint_cursor);expect(saved.initial_cursor).toBe(saved.checkpoint_cursor);
    const delta=await readFlightDeckRecordPage({workspaceId,actorId,clientId,protocolVersion:2,cursor:saved.checkpoint_cursor!},db);expect(delta.mode).toBe('delta');expect(delta.changes).toEqual([]);
    await expect(readFlightDeckRecordPage({workspaceId,actorId,clientId,protocolVersion:2,cursor:oldInitial},db)).rejects.toMatchObject({code:'page_token_invalid'});
    await expect(readFlightDeckRecordPage({workspaceId,actorId,clientId,protocolVersion:2,cursor:issued.next_cursor},db)).rejects.toMatchObject({code:'page_token_invalid'});
  });

  test('one missing row returns only that selective repair and retries are idempotent',async()=>{const target=await message('one mismatch');const clientId=randomUUID();let {response,request}=await start(clientId);
    const inventory=exact(response.challenge).map((entry:any)=>entry.id===target?{family:entry.family,id:entry.id,state:'missing'}:entry);const cursor=response.cursor;
    response=await adoptRecordCache(client(clientId),{cursor,inventory},db);expect(response.status).toBe('repair_required');expect(response.records.map((entry:any)=>entry.id)).toEqual([target]);
    const retry=await adoptRecordCache(client(clientId),{cursor,inventory},db);expect(retry).toEqual(response);
    expect(await adoptRecordCache(client(clientId),request,db)).toEqual(response);
    await expect(adoptRecordCache(client(clientId),{cursor,inventory:[]},db)).rejects.toMatchObject({code:'adoption_cursor_invalid'});
    const repaired=await repairRecords({...viewer(),records:response.records},db);
    await expect(adoptRecordCache(client(clientId),{cursor:response.cursor,repaired:[]},db)).rejects.toMatchObject({code:'adoption_repair_incomplete'});
    const done=await finish(clientId,response,target);expect(done.repairs).toBe(1);expect(done.response.status).toBe('adopted');
    expect(repaired.changes[0]!.id).toBe(target);
  });

  test('an explicit canonical tombstone is selectively repaired before adoption',async()=>{const tombstone=await message('delete for adoption');await db`DELETE FROM flightdeck_pg_messages WHERE id=${tombstone}`;
    const clientId=randomUUID();let {response}=await start(clientId);
    while(response.status==='inventory_required'&&!response.challenge.some((entry:any)=>entry.id===tombstone))response=await adoptRecordCache(client(clientId),{cursor:response.cursor,inventory:exact(response.challenge)},db);
    expect(response.status).toBe('inventory_required');const inventory=exact(response.challenge).map((entry:any)=>entry.id===tombstone?{family:entry.family,id:entry.id,state:'missing'}:entry);
    response=await adoptRecordCache(client(clientId),{cursor:response.cursor,inventory},db);expect(response.status).toBe('repair_required');expect(response.records).toContainEqual(expect.objectContaining({id:tombstone,state:'deleted'}));
    const repair=await repairRecords({...viewer(),records:response.records},db);const deleted=repair.changes.find(change=>change.id===tombstone);expect(deleted).toMatchObject({operation:'delete',row:null});
    response=await adoptRecordCache(client(clientId),{cursor:response.cursor,repaired:repair.changes.map(change=>({family:change.family,id:change.id,state:change.operation==='delete'?'deleted':'active',version:change.version}))},db);
    expect((await finish(clientId,response)).response.status).toBe('adopted');
  });

  test('partial, forged, reordered, filtered and foreign proofs preserve the old snapshot',async()=>{const clientId=randomUUID();const filtered=await manifestCursor(normalizePriorityFilters({families:['message']}));
    const registered=await registerRecordClient({workspaceId,actorId,clientId},db);
    const issued=await readFlightDeckRecordPage({workspaceId,actorId,clientId,protocolVersion:2,cursor:registered.initial_cursor},db);
    await expect(adoptRecordCache(client(clientId),{request_id:randomUUID(),manifest_cursor:filtered,expected_checkpoint_revision:'0'},db)).rejects.toMatchObject({code:'adoption_manifest_invalid'});
    const {response}=await start(clientId);await expect(adoptRecordCache(client(clientId),{cursor:response.cursor,inventory:exact(response.challenge).slice(1)},db)).rejects.toMatchObject({code:'adoption_inventory_incomplete'});
    const forged=exact(response.challenge);forged[0]={...forged[0],id:randomUUID()};await expect(adoptRecordCache(client(clientId),{cursor:response.cursor,inventory:forged},db)).rejects.toMatchObject({code:'adoption_inventory_invalid'});
    await expect(adoptRecordCache(client(clientId),{cursor:response.cursor,inventory:exact(response.challenge).reverse()},db)).rejects.toMatchObject({code:'adoption_inventory_invalid'});
    await expect(adoptRecordCache({...client(clientId),appNpub:'wrong'},{cursor:response.cursor,inventory:exact(response.challenge)},db)).rejects.toMatchObject({status:403});
    await expect(adoptRecordCache({workspaceId,actorId:otherActorId,appNpub,clientId},{cursor:response.cursor,inventory:exact(response.challenge)},db)).rejects.toMatchObject({code:'adoption_cursor_invalid'});
    await expect(adoptRecordCache({workspaceId:otherWorkspaceId,actorId,appNpub,clientId},{cursor:response.cursor,inventory:exact(response.challenge)},db)).rejects.toMatchObject({code:'adoption_cursor_invalid'});
    const unchanged=await readRecordCheckpoint({workspaceId,actorId,clientId},db);expect(unchanged.initial_cursor).toBe(registered.initial_cursor);expect(unchanged.checkpoint_cursor).toBeNull();
    const resumed=await readFlightDeckRecordPage({workspaceId,actorId,clientId,protocolVersion:2,cursor:issued.next_cursor},db);
    expect(resumed.checkpoint_revision).toBe('0');expect(resumed.next_cursor).toBeTruthy();
  });

  test('authority, checkpoint and idle-expiry races fail closed without retiring snapshot state',async()=>{const clientId=randomUUID();const requestId=randomUUID();const started=await start(clientId,undefined,requestId);const oldInitial=started.checkpoint.initial_cursor;
    await db`UPDATE flightdeck_pg_record_clock SET access_revision=access_revision+1 WHERE workspace_id=${workspaceId}`;
    await expect(adoptRecordCache(client(clientId),{cursor:started.response.cursor,inventory:exact(started.response.challenge)},db)).rejects.toMatchObject({code:'adoption_authority_changed'});
    await expect(adoptRecordCache(client(clientId),started.request,db)).rejects.toMatchObject({code:'adoption_authority_changed'});
    expect((await readRecordCheckpoint({workspaceId,actorId,clientId},db)).initial_cursor).toBe(oldInitial);

    const epochId=randomUUID();const epoch=await start(epochId);await db`UPDATE flightdeck_pg_record_clock SET epoch=${randomUUID()} WHERE workspace_id=${workspaceId}`;
    await expect(adoptRecordCache(client(epochId),{cursor:epoch.response.cursor,inventory:exact(epoch.response.challenge)},db)).rejects.toMatchObject({code:'adoption_authority_changed'});

    const racingId=randomUUID();const racing=await start(racingId);const page=await readFlightDeckRecordPage({workspaceId,actorId,clientId:racingId,protocolVersion:2,cursor:racing.checkpoint.initial_cursor},db);
    await db`UPDATE flightdeck_pg_record_clients SET checkpoint_cursor=${page.next_cursor},checkpoint_state=(SELECT state FROM flightdeck_pg_record_page_tokens WHERE token=${page.next_cursor}),revision=revision+1 WHERE client_id=${racingId}`;
    await expect(adoptRecordCache(client(racingId),{cursor:racing.response.cursor,inventory:exact(racing.response.challenge)},db)).rejects.toMatchObject({code:'adoption_checkpoint_conflict'});

    const expiringId=randomUUID();const expiring=await start(expiringId);await db`UPDATE flightdeck_pg_record_adoptions SET last_used_at=now()-interval '8 days' WHERE adoption_id=${expiring.response.adoption_id}`;
    await expect(adoptRecordCache(client(expiringId),{cursor:expiring.response.cursor,inventory:exact(expiring.response.challenge)},db)).rejects.toMatchObject({code:'adoption_expired'});
    await expect(adoptRecordCache(client(expiringId),expiring.request,db)).rejects.toMatchObject({code:'adoption_expired'});
    expect((await readRecordCheckpoint({workspaceId,actorId,clientId:expiringId},db)).checkpoint_cursor).toBeNull();
  });

  test('repair receipts must be complete, ordered and current',async()=>{const targets=[await message('stale receipt one'),await message('stale receipt two')];const clientId=randomUUID();let {response}=await start(clientId);
    while(response.status==='inventory_required'&&!targets.every(target=>response.challenge.some((entry:any)=>entry.id===target)))response=await adoptRecordCache(client(clientId),{cursor:response.cursor,inventory:exact(response.challenge)},db);
    const inventory=exact(response.challenge).map((entry:any)=>targets.includes(entry.id)?{family:entry.family,id:entry.id,state:'missing'}:entry);response=await adoptRecordCache(client(clientId),{cursor:response.cursor,inventory},db);
    expect(response.status).toBe('repair_required');const receipts=response.records.map((entry:any)=>({family:entry.family,id:entry.id,state:entry.state,version:entry.version}));
    await expect(adoptRecordCache(client(clientId),{cursor:response.cursor,repaired:receipts.slice(1)},db)).rejects.toMatchObject({code:'adoption_repair_incomplete'});
    await expect(adoptRecordCache(client(clientId),{cursor:response.cursor,repaired:[...receipts].reverse()},db)).rejects.toMatchObject({code:'adoption_repair_incomplete'});
    await expect(adoptRecordCache(client(clientId),{cursor:response.cursor,repaired:receipts.map((entry:any,index:number)=>index?entry:{...entry,version:String(BigInt(entry.version)+1n)})},db)).rejects.toMatchObject({code:'adoption_repair_incomplete'});
    expect((await readRecordCheckpoint({workspaceId,actorId,clientId},db)).checkpoint_cursor).toBeNull();
  });

  test('large manifest work stays page-bounded and completes without body transfer',async()=>{for(let i=0;i<1200;i++)await message(`large cache ${i}`);
    const clientId=randomUUID();const {response}=await start(clientId);let current=response,pages=0,largest=0;
    while(current.status!=='adopted'){expect(current.status).toBe('inventory_required');largest=Math.max(largest,current.challenge.length);pages++;
      current=await adoptRecordCache(client(clientId),{cursor:current.cursor,inventory:exact(current.challenge)},db);}
    expect(largest).toBeLessThanOrEqual(200);expect(pages).toBeGreaterThan(5);expect(current.checkpoint.checkpoint_cursor).toBeTruthy();
  },30_000);
});

test('cache adoption is explicit in discovery, OpenAPI and NIP-98 route gating',async()=>{
  expect(recordAdoptionDiscovery).toMatchObject({version:1,requires_unfiltered_manifest:true,max_inventory_rows:200,checkpoint_mode:'delta_at_captured_head'});
  const api=buildOpenApiDocument('https://tower.example.test') as any;
  const path='/api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync/clients/{clientId}/adoption';
  const operation=api.paths[path].post;expect(operation.summary).toMatch(/Adopt an existing/);expect(operation.requestBody.content['application/json'].schema.oneOf).toHaveLength(3);
  expect(operation.responses['409'].description).toMatch(/existing snapshot remains recoverable/);
  const app=createApp();const response=await app.request('/api/v4/flightdeck-pg/workspaces/00000000-0000-4000-8000-000000000001/record-sync/clients/00000000-0000-4000-8000-000000000002/adoption?protocol_version=2',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  expect(response.status).toBe(401);
});
