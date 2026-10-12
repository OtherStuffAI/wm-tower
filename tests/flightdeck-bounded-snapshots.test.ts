import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { registerRecordClient, acknowledgeRecordCheckpoint } from '../src/services/flightdeck-record-checkpoints';
import { readLargeRecordChunk } from '../src/services/flightdeck-record-large';
import { seedBoundedRecordWorkload } from './fixtures/bounded-snapshot-workload';
import { recordFamilies } from '../src/services/flightdeck-record-families';
import type { FlightDeckRecordPageV2 } from '../src/types';
const port=Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port===5432)('isolated bounded snapshot extensions',()=>{
  const database=`tower_bounded_${process.pid}_${Date.now()}`;
  const conn={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
  let db:ReturnType<typeof postgres>, workspaceId:string, actorId:string, scopeId:string, channelId:string;
  const timings:number[]=[], byteSizes:number[]=[];
  beforeAll(async()=>{
    const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${database}`);await admin.end();
    db=postgres({...conn,database});
    for(const stmt of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8'))) await db.unsafe(stmt);
    const [a]=await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES('npub1bounded','human','bounded') RETURNING id`;actorId=a!.id;
    const [w]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id) VALUES('tower','workspace','owner','app','bounded',${actorId}) RETURNING id`;workspaceId=w!.id;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${actorId},'owner')`;
    const [s]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'bounded','project') RETURNING id`;scopeId=s!.id;
    const [c]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'bounded') RETURNING id`;channelId=c!.id;
    for(const permission of ['channel.read','task.read','doc.read']) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspaceId},'actor',${actorId},'channel',${channelId},${permission})`;
    for(const permission of ['scope.read','context.edit']) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${workspaceId},'actor',${actorId},'scope',${scopeId},${permission})`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${workspaceId},'actor',${actorId},'workspace','workspace.read')`;
  });
  afterAll(async()=>{await db?.end();const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);await admin.end();});
  const input=(clientId:string)=>({workspaceId,actorId,clientId});
  async function page(clientId:string,cursor:string,limit=200,chunked=false,measured=db) {
    const start=performance.now();
    const p=await readFlightDeckRecordPage({...input(clientId),protocolVersion:2,cursor,limit,extension:'bounded_snapshot_v1',...(chunked?{largeRecords:'chunked_v1'}:{})},measured);
    timings.push(performance.now()-start);byteSizes.push(Buffer.byteLength(JSON.stringify(p)));
    expect(byteSizes.at(-1)).toBeLessThanOrEqual(1048576);
    expect(p.changes.length+(p.actors?.length??0)+(p.access_changes?.length??0)+(p.large_records?.length??0)).toBeLessThanOrEqual(200);
    return p;
  }
  async function ack(clientId:string,p:FlightDeckRecordPageV2,receipts?:any[]) {return acknowledgeRecordCheckpoint({...input(clientId),cursor:p.next_cursor,expectedRevision:p.checkpoint_revision,...(receipts?{largeRecordReceipts:receipts}:{})},db);}
  async function message(body:string) {const [m]=await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},${body},${actorId},${actorId}) RETURNING id`;return m!.id;}
  async function bootstrap(chunked=false) {const clientId=randomUUID(),c=await registerRecordClient(input(clientId),db);let cursor=c.initial_cursor;for(let i=0;i<100;i++){const p=await page(clientId,cursor,200,chunked);await ack(clientId,p);cursor=p.next_cursor;if(p.handover?.complete)return{clientId,cursor};}throw new Error('bootstrap incomplete');}
  test('snapshot and committed target remain finite with writes every page; later round catches updates',async()=>{
    await message('before');const clientId=randomUUID(),c=await registerRecordClient(input(clientId),db);
    let cursor=c.initial_cursor,target:string|null=null,complete=false;const ids=new Set<string>();
    for(let i=0;i<60;i++) {
      await message(`continuous ${i}`);
      const p=await page(clientId,cursor,1);for(const change of p.changes) ids.add(change.id);
      if(p.handover!.target_position!==null){if(target!==null)expect(p.handover!.target_position).toBe(target);target=p.handover!.target_position;}
      await ack(clientId,p);cursor=p.next_cursor;
      if(p.handover!.complete){expect(p.has_more).toBe(false);complete=true;break;}
    }
    expect(complete).toBe(true);const [clock]=await db`SELECT position::text FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`;
    expect(BigInt(clock!.position)).toBeGreaterThan(BigInt(target!));
    await expect(readFlightDeckRecordPage({...input(clientId),protocolVersion:2,cursor},db)).rejects.toMatchObject({code:'extension_required'});
    const p=await page(clientId,cursor);expect(BigInt(p.handover!.target_position!)).toBeGreaterThan(BigInt(target!));
    await ack(clientId,p);await db`DELETE FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId}`;
  });
  test('oversized row and actor manifests: byte chunks, digest receipts, expiry, version change, revocation and lost ack',async()=>{
    const ordinary=await bootstrap();const {clientId,cursor}=await bootstrap(true);const id=await message('€'.repeat(400000));
    await expect(readFlightDeckRecordPage({...input(ordinary.clientId),protocolVersion:2,cursor:ordinary.cursor,extension:'bounded_snapshot_v1'},db)).rejects.toMatchObject({status:413});
    const p=await page(clientId,cursor,200,true),m=p.large_records![0]!;
    expect(p.changes).toEqual([]);expect(m.total_bytes).toBeGreaterThan(1048576);
    await expect(page(clientId,p.next_cursor,200,true)).rejects.toMatchObject({code:'large_record_ack_required'});
    await expect(ack(clientId,p)).rejects.toMatchObject({code:'large_record_receipt_required'});
    let decoded=0;const measured=postgres({...conn,database,transform:{row(row){decoded+=row.data?.length??Buffer.byteLength(JSON.stringify(row));return row;}}});
    const chunks:Buffer[]=[],chunkTimes:number[]=[];let maxChunkDriverBytes=0;
    try {for(let index=0;index<m.chunk_count;index++) {decoded=0;const chunkStart=performance.now();const chunk=await readLargeRecordChunk({...input(clientId),cursor:p.next_cursor,manifestId:m.manifest_id,index},measured);chunkTimes.push(performance.now()-chunkStart);maxChunkDriverBytes=Math.max(maxChunkDriverBytes,decoded);expect(chunk.length).toBeLessThanOrEqual(262144);expect(decoded).toBeLessThan(310000);chunks.push(Buffer.from(chunk));}} finally{await measured.end();}
    const bytes=Buffer.concat(chunks);expect(bytes.length).toBe(m.total_bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(m.sha256);
    const payload=JSON.parse(bytes.toString());expect(payload.change.row.body).toBe('€'.repeat(400000));expect(payload.change.id).toBe(id);expect(payload.actors.length).toBe(1);
    const receipts=[{manifest_id:m.manifest_id,sha256:m.sha256}];const saved=await ack(clientId,p,receipts);
    expect((await ack(clientId,p,receipts)).checkpoint_revision).toBe(saved.checkpoint_revision);
    await expect(ack(clientId,p,[null])).rejects.toMatchObject({code:'large_record_receipt_required'});
    await db`UPDATE flightdeck_pg_record_page_tokens SET last_used_at=now()-interval '8 days' WHERE token=${p.next_cursor}`;
    await expect(readLargeRecordChunk({...input(clientId),cursor:p.next_cursor,manifestId:m.manifest_id,index:0},db)).rejects.toMatchObject({code:'page_token_invalid'});
    expect((await ack(clientId,p,receipts)).checkpoint_revision).toBe(saved.checkpoint_revision);
    await db`UPDATE flightdeck_pg_messages SET body='small' WHERE id=${id}`;
    await db`UPDATE flightdeck_pg_actors SET display_name=repeat('L',1100000) WHERE id=${actorId}`;
    const actorPage=await page(clientId,p.next_cursor,200,true),am=actorPage.large_records![0]!;
    const actorParts:Buffer[]=[];
    for(let index=0;index<am.chunk_count;index++)actorParts.push(Buffer.from(await readLargeRecordChunk({...input(clientId),cursor:actorPage.next_cursor,manifestId:am.manifest_id,index},db)));
    const actorBytes=Buffer.concat(actorParts);expect(createHash('sha256').update(actorBytes).digest('hex')).toBe(am.sha256);
    expect(JSON.parse(actorBytes.toString()).actors[0].display_name.length).toBe(1100000);
    if(process.env.BOUNDED_CHUNK_EVIDENCE_PATH)writeFileSync(process.env.BOUNDED_CHUNK_EVIDENCE_PATH,JSON.stringify({record_bytes:m.total_bytes,record_chunk_count:m.chunk_count,max_chunk_bytes:Math.max(...chunks.map(c=>c.length)),max_chunk_driver_bytes:maxChunkDriverBytes,chunk_ms:chunkTimes,actor_envelope_bytes:am.total_bytes,actor_chunk_count:am.chunk_count},null,2)+'\n');
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${workspaceId} AND permission='channel.read'`;
    await expect(readLargeRecordChunk({...input(clientId),cursor:actorPage.next_cursor,manifestId:am.manifest_id,index:0},db)).rejects.toMatchObject({status:403});
    await expect(ack(clientId,actorPage,[{manifest_id:am.manifest_id,sha256:am.sha256}])).rejects.toMatchObject({status:403});
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${workspaceId} AND permission='channel.read'`;
    await db`UPDATE flightdeck_pg_actors SET display_name='bounded' WHERE id=${actorId}`;
    await expect(readLargeRecordChunk({...input(clientId),cursor:actorPage.next_cursor,manifestId:am.manifest_id,index:0},db)).rejects.toMatchObject({code:'large_record_changed'});
    // Pending snapshot manifests invalidate if the canonical version changes.
    await message('x'.repeat(1100000));const snapClient=randomUUID(),registration=await registerRecordClient(input(snapClient),db);
    let snap=await page(snapClient,registration.initial_cursor,200,true);
    while(!snap.large_records!.length){await ack(snapClient,snap);snap=await page(snapClient,snap.next_cursor,200,true);}
    const sm=snap.large_records![0]!;await db`UPDATE flightdeck_pg_messages SET body='changed' WHERE id=${sm.id}`;
    await expect(readLargeRecordChunk({...input(snapClient),cursor:snap.next_cursor,manifestId:sm.manifest_id,index:0},db)).rejects.toMatchObject({code:'large_record_changed'});
    await db`DELETE FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId}`;
  },30000);
  test('finite certificate includes targeted historic grants; loss filters reads without purging checkpoint',async()=>{
    const [hidden]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'hidden') RETURNING id`;
    const [m]=await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${hidden!.id},'historic hidden',${actorId},${actorId}) RETURNING id`;
    const {clientId,cursor}=await bootstrap();
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspaceId},'actor',${actorId},'channel',${hidden!.id},'channel.read')`;
    let position=cursor,found=false,complete=false,target:string|null=null;
    for(let i=0;i<30;i++){
      await message(`writes during access catchup ${i}`);
      const p=await page(clientId,position,1);
      if(target!==null)expect(p.handover!.target_position).toBe(target);else target=p.handover!.target_position;
      found ||= p.changes.some(c=>c.id===m!.id);
      if(p.catchup)expect(p.snapshot_complete).toBe(false);
      await ack(clientId,p);position=p.next_cursor;
      if(p.handover!.complete){complete=true;break;}
    }
    expect(found).toBe(true);expect(complete).toBe(true);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${workspaceId} AND resource_channel_id=${hidden!.id}`;
    const lost=await page(clientId,position);expect(lost.changes.some(c=>c.channel_id===hidden!.id)).toBe(false);expect(lost.retention_policy).toBe('retain_downloaded');await ack(clientId,lost);
    await db`DELETE FROM flightdeck_pg_channels WHERE id=${hidden!.id}`;await db`DELETE FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId}`;
  });

  test('mid-round grant repairs a historic row updated beyond the original target',async()=>{
    const [hidden]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'mid-round hidden') RETURNING id`;
    const [m]=await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${hidden!.id},'old hidden',${actorId},${actorId}) RETURNING id`;
    const {clientId,cursor}=await bootstrap();
    await message('start active target 1');await message('start active target 2');
    const first=await page(clientId,cursor,1);await ack(clientId,first);expect(first.has_more).toBe(true);const original=first.handover!.target_position!;
    await db`UPDATE flightdeck_pg_messages SET body='repaired beyond original target',row_version=row_version+1 WHERE id=${m!.id}`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspaceId},'actor',${actorId},'channel',${hidden!.id},'channel.read')`;
    let position=first.next_cursor,found=false,complete=false;
    for(let i=0;i<20;i++){
      const p=await page(clientId,position,2);expect(BigInt(p.handover!.target_position!)).toBeGreaterThan(BigInt(original));
      found ||= p.changes.some(c=>c.id===m!.id && c.row?.body==='repaired beyond original target');await ack(clientId,p);position=p.next_cursor;
      if(p.handover!.complete){complete=true;break;}
    }
    expect(found).toBe(true);expect(complete).toBe(true);
    await db`DELETE FROM flightdeck_pg_channels WHERE id=${hidden!.id}`;await db`DELETE FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId}`;
  });

  test('bounded snapshot/delta repairs update/delete/move and late commits against independent authorized state',async()=>{
    const [hidden]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'convergence hidden') RETURNING id`;
    const ids=[];for(let i=0;i<4;i++)ids.push(await message(`original ${i}`));
    const clientId=randomUUID(),registered=await registerRecordClient(input(clientId),db);let cursor=registered.initial_cursor;
    const rows=new Map<string,{version:bigint;row:any|null}>();
    const apply=(p:FlightDeckRecordPageV2)=>{for(const c of p.changes)if(c.family==='message') {const old=rows.get(c.id),version=BigInt(c.version);if(!old || version>=old.version)rows.set(c.id,{version,row:c.operation==='delete'?null:c.row});}};
    let observed:string|undefined;
    for(let i=0;i<20;i++) {const p=await page(clientId,cursor,1);apply(p);await ack(clientId,p);cursor=p.next_cursor;observed=p.changes.find(c=>c.family==='message')?.id;if(observed)break;}
    expect(observed).toBeDefined();const others=ids.filter(id=>id!==observed);
    await db`UPDATE flightdeck_pg_messages SET body='updated during snapshot',row_version=row_version+1 WHERE id=${observed!}`;
    await db`DELETE FROM flightdeck_pg_messages WHERE id=${others[0]!}`;
    await db`UPDATE flightdeck_pg_messages SET channel_id=${hidden!.id},row_version=row_version+1 WHERE id=${others[1]!}`;
    await message('inserted during snapshot');
    let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),allocated=new Promise<void>(resolve=>ready=resolve);
    const late=db.begin(async transaction=>{const sql=transaction as unknown as typeof db;await sql`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},'late commit',${actorId},${actorId})`;ready();await gate;});
    await allocated;let higherCommitted=false;
    const higher=db.begin(async transaction=>{const sql=transaction as unknown as typeof db;await sql`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},'higher commit',${actorId},${actorId})`;}).then(()=>higherCommitted=true);
    await new Promise(resolve=>setTimeout(resolve,20));expect(higherCommitted).toBe(false);release();await Promise.all([late,higher]);
    let complete=false;
    for(let i=0;i<40;i++){const p=await page(clientId,cursor,2);apply(p);await ack(clientId,p);cursor=p.next_cursor;if(p.handover!.complete){complete=true;break;}}
    expect(complete).toBe(true);
    const reference=await db<{id:string;body:string}[]>`SELECT id,body FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId} AND channel_id=${channelId} AND deleted_at IS NULL ORDER BY id`;
    const materialized=[...rows].filter(([,value])=>value.row!==null).map(([id,value])=>({id,body:value.row.body})).toSorted((a,b)=>a.id.localeCompare(b.id));
    expect(materialized).toEqual([...reference]);
    expect(rows.get(others[0]!)?.row??null).toBeNull();expect(rows.get(others[1]!)?.row??null).toBeNull();
    await db`DELETE FROM flightdeck_pg_channels WHERE id=${hidden!.id}`;await db`DELETE FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId}`;
  });

  test('asynchronous continuous writer permits finite bootstrap and committed catchup',async()=>{
    for(let i=0;i<10;i++)await message(`async initial ${i}`);
    const clientId=randomUUID(),registration=await registerRecordClient(input(clientId),db);let cursor=registration.initial_cursor,writing=true,writes=0,complete=false,target:string|null=null;
    const writerTimes:number[]=[];
    const producer=(async()=>{while(writing){const started=performance.now();await message(`async producer ${writes++}`);writerTimes.push(performance.now()-started);}})();
    try {
      for(let i=0;i<100;i++){
        const p=await page(clientId,cursor,2);
        if(target!==null)expect(p.handover!.target_position).toBe(target);else target=p.handover!.target_position;
        await ack(clientId,p);cursor=p.next_cursor;
        if(p.handover!.complete){complete=true;break;}
      }
    }finally{writing=false;await producer;}
    expect(complete).toBe(true);expect(writes).toBeGreaterThan(1);
    const [clock]=await db`SELECT position::text FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`;expect(BigInt(clock!.position)).toBeGreaterThan(BigInt(target!));
    if(process.env.BOUNDED_WRITER_EVIDENCE_PATH)writeFileSync(process.env.BOUNDED_WRITER_EVIDENCE_PATH,JSON.stringify({writes,writer_max_ms:Math.max(...writerTimes),writer_p95_ms:writerTimes.toSorted((a,b)=>a-b)[Math.floor(writerTimes.length*.95)],target,committed_after:clock!.position},null,2)+'\n');
    await db`DELETE FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId}`;
  },30000);

  test('profile growth between sizing and decoding never loads an oversized actor into the driver',async()=>{
    const {clientId,cursor}=await bootstrap(true);await message('profile race');
    let entered!:()=>void,release!:()=>void,paused=false,decodedLargeProfile=false;
    const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const measured=postgres({...conn,database,transform:{row(row){if(row.display_name?.length>1000000)decodedLargeProfile=true;return row;}}});
    const gated=new Proxy(measured,{get(target,key){
      if(key!=='begin')return Reflect.get(target,key);
      return (options:any,callback:any)=>target.begin(options,async transaction=>{
        const wrapped=new Proxy(transaction as unknown as typeof db,{apply(sql,thisArg,args){
          if(!paused && Array.isArray(args[0]) && args[0].join('').includes('WITH profiles AS MATERIALIZED')){paused=true;entered();return gate.then(()=>Reflect.apply(sql,thisArg,args));}
          return Reflect.apply(sql,thisArg,args);
        }});return callback(wrapped);
      });
    }});
    try {
      const reading=page(clientId,cursor,200,true,gated);await ready;
      await db`UPDATE flightdeck_pg_actors SET display_name=repeat('L',1100000) WHERE id=${actorId}`;release();
      const p=await reading;expect(decodedLargeProfile).toBe(false);expect(p.changes).toEqual([]);expect(p.large_records!.length).toBe(1);
    }finally{release();await measured.end();await db`UPDATE flightdeck_pg_actors SET display_name='bounded' WHERE id=${actorId}`;}
    await db`DELETE FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId}`;
  },30000);

  test('cross-repo workload inserts every real domain family through its foreign keys and triggers',async()=>{
    await seedBoundedRecordWorkload(db,{workspaceId,actorId,scopeId,channelId},3);
    for(const [family,table] of Object.entries(recordFamilies)){
      if(family==='message')continue;
      const [count]=await db`SELECT count(*)::int AS n FROM ${db(`flightdeck_pg_${table}`)} WHERE workspace_id=${workspaceId}`;
      expect(count!.n).toBeGreaterThanOrEqual(3);
    }
  },30000);

  test('complete declared traversal beyond 10k in every family, 100k real messages, 2095 real comments and bounded EXPLAIN evidence',async()=>{
    const [task]=await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},'benchmark',${actorId},${actorId}) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_task_comments(workspace_id,scope_id,channel_id,task_id,body,created_by_actor_id,updated_by_actor_id) SELECT ${workspaceId},${scopeId},${channelId},${task!.id},repeat('c',2000),${actorId},${actorId} FROM generate_series(1,2095)`;
    for(let batch=0;batch<100;batch++) await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) SELECT ${workspaceId},${scopeId},${channelId},'benchmark '||(${batch}*1000+i),${actorId},${actorId} FROM generate_series(1,1000) i`;
    await message('x'.repeat(900000));
    await seedBoundedRecordWorkload(db,{workspaceId,actorId,scopeId,channelId,taskId:task!.id});
    const inventory=await db`SELECT family,count(*)::int AS rows,max(bytes)::int AS max_bytes FROM flightdeck_pg_record_current WHERE workspace_id=${workspaceId} GROUP BY family ORDER BY family`;
    for(const family of Object.keys(recordFamilies))expect(inventory.find(r=>r.family===family)!.rows).toBeGreaterThan(10000);
    expect(inventory.find(r=>r.family==='message')!.rows).toBeGreaterThanOrEqual(100000);
    for(const [family,table] of Object.entries(recordFamilies)){const [count]=await db`SELECT count(*)::int AS n FROM ${db(`flightdeck_pg_${table}`)} WHERE workspace_id=${workspaceId}`;expect(count!.n).toBeGreaterThan(10000);}
    await db`ANALYZE flightdeck_pg_record_current`;await db`ANALYZE flightdeck_pg_record_journal`;
    const plans={snapshot:await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT family,id,position,bytes,context FROM flightdeck_pg_record_current WHERE workspace_id=${workspaceId} AND (family,id)>('message','') AND position<=1000000000 ORDER BY family,id LIMIT 201`,
      delta:await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT family,id,position,bytes,context FROM flightdeck_pg_record_journal WHERE workspace_id=${workspaceId} AND position>100 AND position<=1000000000 ORDER BY position LIMIT 201`,
      catchup:await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT family,id,position,bytes,context FROM flightdeck_pg_record_current WHERE workspace_id=${workspaceId} AND family='task_comment' AND COALESCE(context->>'channel_id',CASE WHEN family='channel' THEN id END)=${channelId} AND id>'' AND position<=1000000000 ORDER BY id LIMIT 201`};
    const prefixPlans=[];
    for(const cutoff of [1000,10000,100000]) prefixPlans.push({cutoff,plan:await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT family,id,position,bytes,context FROM flightdeck_pg_record_journal WHERE workspace_id=${workspaceId} AND position>0 AND position<=${cutoff} ORDER BY position LIMIT 201`});
    const clientId=randomUUID(),registered=await registerRecordClient(input(clientId),db);let cursor=registered.initial_cursor,pages=0,empty=0,wireBytes=0;
    const counts=new Map<string,number>(),seen=new Set<string>(),start=performance.now(),ackTimes:number[]=[];
    const startTiming=timings.length;
    while(true) {
      const p=await page(clientId,cursor);pages++;wireBytes+=Buffer.byteLength(JSON.stringify(p));if(!p.changes.length && p.has_more)empty++;
      for(const c of p.changes){const key=c.family+':'+c.id;expect(seen.has(key)).toBe(false);seen.add(key);counts.set(c.family,(counts.get(c.family)??0)+1);}
      const ackStart=performance.now();await ack(clientId,p);ackTimes.push(performance.now()-ackStart);cursor=p.next_cursor;
      if(p.handover!.complete)break;if(pages>2000)throw new Error('not finite');
    }
    // Real scopes/channels are intentionally hidden without grants. Private
    // scope orders belong to other actors; exactly one belongs to this viewer.
    for(const r of inventory) if(!['scope','channel','scope_order'].includes(r.family))expect(counts.get(r.family)).toBe(r.rows);
    expect(counts.get('scope_order')).toBe(1);
    expect(counts.get('scope')).toBe(1);expect(counts.get('channel')).toBe(1);expect(empty).toBeGreaterThan(0);
    const sort=(xs:number[])=>xs.toSorted((a,b)=>a-b),values=sort(timings.slice(startTiming)),acks=sort(ackTimes);
    const evidence={fixture:'real 100001 messages, 2095 2KB comments and 10001 real domain rows/family via FKs and triggers; scopes/channels and other actors scope orders deliberately hidden',inventory,plans,prefix_plans:prefixPlans,
      pages,empty_progress_pages:empty,wire_bytes:wireBytes,bootstrap_ms:performance.now()-start,page_p95_ms:values[Math.floor(values.length*.95)],page_max_ms:values.at(-1),ack_p95_ms:acks[Math.floor(acks.length*.95)],max_page_bytes:Math.max(...byteSizes),peak_rss_bytes:process.resourceUsage().maxRSS,counts:Object.fromEntries(counts)};
    if(process.env.BOUNDED_EVIDENCE_PATH)writeFileSync(process.env.BOUNDED_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');
    expect(evidence.page_p95_ms).toBeLessThan(1000);
  },600000);
});
