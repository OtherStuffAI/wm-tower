import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { setDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest, prepareStorageObjectForAuthorizedOwner, writeStorageObject, completeStorageObject } from '../src/services/storage';
import { createApp } from '../src/server';
import { buildOpenApiDocument } from '../src/openapi';

const keys = [91,92,93].map(n => new Uint8Array(32).fill(n));
const npubs = keys.map(key => nip19.npubEncode(getPublicKey(key)));
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const app = createApp();
let sql: ReturnType<typeof postgres>;
let database: string;
const createdPaths: string[] = [];
const realS3 = process.env.BLOSSOM_PUBLICATION_REAL_S3 === '1';
const originalPublicOrigin = config.directHttpsUrl;
let workspaceId: string, channelId: string, scopeId: string;
let actors: string[];
function request(path: string, method = 'GET', who = 0, payload: unknown = {}) {
  const event = finalizeEvent({ kind:27235, created_at:Math.floor(Date.now()/1000), tags:[['u',`http://localhost${path}`],['method',method],...(method==='PUT'?[['payload',hash(JSON.stringify(payload))]]:[])], content:'' }, keys[who]);
  return app.request(path,{method,...(method==='PUT'?{body:JSON.stringify(payload)}:{}),headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`}});
}
async function file(bytes: Uint8Array, complete = true) {
  const storage = await prepareStorageObjectForAuthorizedOwner({ owner_npub:npubs[0], content_type:'audio/mpeg', file_name:'private-podcast-name.mp3' }, npubs[0]);
  createdPaths.push(storage.storage_path);
  await writeStorageObject(storage.id,bytes,npubs[0]);
  if (complete) await completeStorageObject(storage.id,{},npubs[0]);
  const [f] = await sql`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,display_name,created_by_actor_id,updated_by_actor_id)
    VALUES(${workspaceId},${scopeId},${channelId},${storage.id},'Podcast',${actors[0]},${actors[0]}) RETURNING *`;
  const [v] = await sql`INSERT INTO flightdeck_pg_file_versions(workspace_id,file_id,version_number,storage_object_id,created_by_actor_id)
    VALUES(${workspaceId},${f.id},1,${storage.id},${actors[0]}) RETURNING *`;
  await sql`UPDATE flightdeck_pg_files SET current_version_id=${v.id} WHERE id=${f.id}`;
  return { storage, f, v, path:`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${f.id}/versions/${v.id}/blossom`, status:`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${f.id}/blossom`, sha:hash(bytes) };
}
beforeAll(async () => {
  config.directHttpsUrl = 'http://localhost';
  const options={host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),username:process.env.DB_USER||'postgres',password:process.env.DB_PASSWORD||'postgres'};
  const admin=postgres({...options,database:'postgres'});
  database=`tower_publication_${randomUUID().replaceAll('-','')}`;
  await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
  sql=postgres({...options,database});setDb(sql);
  for(const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8'))) await sql.unsafe(statement);
  if (!realS3) enableInMemoryStorageForTest();
  actors=[];
  for(const npub of npubs){ const [a]=await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id`;actors.push(a.id); }
  const [w]=await sql`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
    VALUES('npub1publicationtower','npub1publicationworkspace',${npubs[0]},'npub1publicationapp','Publication fixture',${actors[0]}) RETURNING id`;
  workspaceId=w.id;
  for(const [i,actor] of actors.entries()) await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${actor},${i===0?'owner':'member'})`;
  const [s]=await sql`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Publication','project') RETURNING id`;scopeId=s.id;
  const [c]=await sql`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'Podcast') RETURNING id`;channelId=c.id;
  for(const [i,actor] of actors.entries()) for(const permission of i===2?['file.read','channel.read']:['file.read','file.write','channel.read','channel.write'])
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${workspaceId},'actor',${actor},'channel',${channelId},${permission})`;
});
afterAll(async()=>{
  config.directHttpsUrl = originalPublicOrigin;
  if (realS3) {
    const bucket = new Bun.S3Client({endpoint:config.storage.s3Endpoint,region:config.storage.s3Region,accessKeyId:config.storage.s3AccessKey,secretAccessKey:config.storage.s3SecretKey,bucket:config.storage.s3Bucket});
    for (const path of createdPaths) await bucket.delete(path);
  }
  resetInMemoryStorageForTest(); if(sql)await sql.end();
  if (database) {
    const admin=postgres({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),username:process.env.DB_USER||'postgres',password:process.env.DB_PASSWORD||'postgres',database:'postgres'});
    await admin.unsafe(`DROP DATABASE ${database}`); await admin.end();
  }
});
describe('explicit Blossom file publication',()=>{
  test.skipIf(!process.env.BLOSSOM_PUBLICATION_CLI_ENTRY)('Wingman CLI publishes and unpublishes against the supported Tower API', async () => {
    const { runFlightDeckPgCli } = await import(process.env.BLOSSOM_PUBLICATION_CLI_ENTRY!);
    const savedSession = process.env.SESSION_ID, savedCapability = process.env.WINGMAN_CAPABILITY;
    delete process.env.SESSION_ID; delete process.env.WINGMAN_CAPABILITY;
    try {
      const f = await file(new Uint8Array([71,72,73]));
      const run = (command: string, extra: string[] = []) => runFlightDeckPgCli(['file',command,f.f.id,'--workspace',workspaceId,'--tower-url','http://localhost','--app-npub','npub1publicationapp','--key',Buffer.from(keys[0]).toString('hex'),'--json',...extra], {
        fetchImpl: (input: string, init: RequestInit) => app.fetch(new Request(input, init)),
      });
      const published = await run('publish',['--version',f.v.id,'--public']);
      expect(published.exitCode).toBe(0); expect(JSON.parse(published.stdout).versions[0].public).toBe(true);
      expect((await app.request('/'+f.sha)).status).toBe(200);
      const status = await run('blossom'); expect(status.exitCode).toBe(0); expect(JSON.parse(status.stdout).versions[0].published_by_you).toBe(true);
      const unpublished = await run('unpublish',['--version',f.v.id]); expect(unpublished.exitCode).toBe(0);
      expect((await app.request('/'+f.sha)).status).toBe(401);
    } finally {
      if (savedSession === undefined) delete process.env.SESSION_ID; else process.env.SESSION_ID = savedSession;
      if (savedCapability === undefined) delete process.env.WINGMAN_CAPABILITY; else process.env.WINGMAN_CAPABILITY = savedCapability;
    }
  });
  test('documents status and both lifecycle routes',()=>{
    const api=buildOpenApiDocument('http://localhost');
    expect(api.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}/blossom'].get.security).toEqual([{nip98:[]}]);
    expect(api.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}/versions/{versionId}/blossom'].delete.description).toContain('calling actor');
  });
  test('write permission explicitly publishes verified bytes; private metadata/ACLs stay unchanged',async()=>{
    const bytes=new Uint8Array([1,2,3,4,5,6]);const f=await file(bytes);
    expect((await app.request('/'+f.sha)).status).toBe(401);
    expect((await request(f.path,'PUT',2)).status).toBe(403);
    expect((await app.request(f.path,{method:'PUT'})).status).toBe(401);
    const published=await request(f.path,'PUT');expect(published.status).toBe(200);
    const result=await published.json();expect(result.changed).toBe(true);expect(result.versions[0]).toMatchObject({published_by_you:true,public:true,sha256_hex:f.sha,blossom_url:`http://localhost/${f.sha}`});
    expect((await (await request(f.path,'PUT')).json()).changed).toBe(false);
    const get=await app.request('/'+f.sha);expect(get.status).toBe(200);expect(hash(new Uint8Array(await get.arrayBuffer()))).toBe(f.sha);
    expect(get.headers.get('content-disposition')).not.toContain('private-podcast');
    const head=await app.request('/'+f.sha,{method:'HEAD'});expect(head.status).toBe(200);expect(head.headers.get('content-length')).toBe('6');expect(await head.text()).toBe('');
    const range=await app.request('/'+f.sha,{headers:{Range:'bytes=1-3'}});expect(range.status).toBe(206);expect(range.headers.get('content-range')).toBe('bytes 1-3/6');expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([2,3,4]);
    const [storage]=await sql`SELECT * FROM v4_storage_objects WHERE id=${f.storage.id}`;expect(storage.is_public).toBe(false);expect(storage.owner_npub).toBe(npubs[0]);
    expect((await app.request(`/api/v4/storage/${f.storage.id}`)).status).not.toBe(200);
    expect((await request(f.path,'DELETE',2)).status).toBe(403);
    expect((await (await request(f.path,'DELETE')).json()).changed).toBe(true);
    expect((await app.request('/'+f.sha)).status).toBe(401);
    expect((await (await request(f.path,'DELETE')).json()).changed).toBe(false);
  });
  test('independent actors and duplicate hashes survive another reference unpublish',async()=>{
    const bytes=new Uint8Array([9,8,7]);const a=await file(bytes),b=await file(bytes);
    expect((await request(a.path,'PUT')).status).toBe(200);expect((await request(a.path,'PUT',1)).status).toBe(200);expect((await request(b.path,'PUT')).status).toBe(200);
    const status=await (await request(a.status)).json();expect(status.versions[0].publication_count).toBe(2);
    await request(a.path,'DELETE');expect((await app.request('/'+a.sha)).status).toBe(200);
    await request(a.path,'DELETE',1);expect((await app.request('/'+a.sha)).status).toBe(200);
    const independent = await (await request(a.status)).json();
    expect(independent.versions[0]).toMatchObject({ public:true, published_by_you:false, publication_count:0, blossom_url:`http://localhost/${a.sha}` });
    await request(b.path,'DELETE');expect((await app.request('/'+a.sha)).status).toBe(401);
    await sql`UPDATE v4_storage_objects SET is_public=true WHERE id=${b.storage.id}`;
    await request(a.path,'PUT');await request(a.path,'DELETE');expect((await app.request('/'+a.sha)).status).toBe(200);
  });
  test('new version stays private; deletion withdraws only the deleted file reference',async()=>{
    const a=await file(new Uint8Array([11,12]));await request(a.path,'PUT');
    const b=await file(new Uint8Array([13,14]));
    await sql`UPDATE flightdeck_pg_files SET deleted_at=NOW() WHERE id=${b.f.id}`;
    await sql`UPDATE flightdeck_pg_files SET storage_object_id=${b.storage.id} WHERE id=${a.f.id}`;
    const [v]=await sql`INSERT INTO flightdeck_pg_file_versions(workspace_id,file_id,version_number,storage_object_id,base_version_id,operation,created_by_actor_id)
      VALUES(${workspaceId},${a.f.id},2,${b.storage.id},${a.v.id},'replaced',${actors[0]}) RETURNING id`;
    await sql`UPDATE flightdeck_pg_files SET current_version_id=${v.id} WHERE id=${a.f.id}`;
    expect((await app.request('/'+a.sha)).status).toBe(200);expect((await app.request('/'+b.sha)).status).toBe(401);
    const foreign=a.path.replace(a.v.id,b.v.id);expect((await request(foreign,'PUT')).status).toBe(404);
    await sql`UPDATE flightdeck_pg_files SET deleted_at=NOW() WHERE id=${a.f.id}`;
    expect((await request(a.path,'PUT')).status).toBe(404);expect((await app.request('/'+a.sha)).status).toBe(401);
  });
  test('missing, incomplete, deleted versions and invalid identifiers produce clear errors',async()=>{
    const a=await file(new Uint8Array([21]),false);
    const incomplete=await request(a.path,'PUT');expect(incomplete.status).toBe(409);expect((await incomplete.json()).code).toBe('storage_incomplete');
    await sql`UPDATE v4_storage_objects SET completed_at=NOW(),storage_path='missing-publication-bytes' WHERE id=${a.storage.id}`;
    const missing=await request(a.path,'PUT');expect(missing.status).toBe(409);expect((await missing.json()).code).toBe('storage_unavailable');
    expect((await request(a.path.replace(a.v.id,randomUUID()),'PUT')).status).toBe(404);
    expect((await request(a.path.replace(a.v.id,'invalid'),'PUT')).status).toBe(400);
    await sql`UPDATE flightdeck_pg_file_versions SET operation='deleted' WHERE id=${a.v.id}`;
    expect((await request(a.path,'PUT')).status).toBe(404);
  });
  test('file write permission cannot publish another workspace owner’s object', async () => {
    const a = await file(new Uint8Array([61,62]));
    const readable = await request(a.status, 'GET', 2);
    expect(readable.status).toBe(200); expect((await readable.json()).can_publish).toBe(false);
    await sql`UPDATE v4_storage_objects SET owner_npub=${npubs[1]} WHERE id=${a.storage.id}`;
    const denied = await request(a.path,'PUT'); expect(denied.status).toBe(404);
    expect((await denied.json()).code).toBe('storage_object_not_found');
    expect((await app.request('/'+a.sha)).status).toBe(401);
  });
  test('changing stored bytes does not silently publish new bytes and unpublish tolerates missing bytes',async()=>{
    const a=await file(new Uint8Array([31,32]));await request(a.path,'PUT');
    const replacement=await file(new Uint8Array([33,34]));
    await sql`UPDATE v4_storage_objects SET storage_path=${replacement.storage.storage_path} WHERE id=${a.storage.id}`;
    expect((await app.request('/'+a.sha)).status).toBe(401);expect((await app.request('/'+replacement.sha)).status).toBe(401);
    const changed=await request(a.path,'PUT');expect(changed.status).toBe(409);expect((await changed.json()).code).toBe('publication_hash_changed');
    await sql`UPDATE v4_storage_objects SET storage_path='missing-changed-bytes' WHERE id=${a.storage.id}`;
    expect((await request(a.path,'DELETE')).status).toBe(200);
  });
});

async function attachment(bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lwAAAABJRU5ErkJggg==','base64')), complete = true) {
  const storage = await prepareStorageObjectForAuthorizedOwner({ owner_npub:npubs[0], content_type:'image/png', file_name:'secret-attachment-name.png' }, npubs[0]);
  createdPaths.push(storage.storage_path);
  await writeStorageObject(storage.id,bytes,npubs[0]);
  if (complete) await completeStorageObject(storage.id,{},npubs[0]);
  const [message] = await sql`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,metadata,created_by_actor_id,updated_by_actor_id)
    VALUES(${workspaceId},${scopeId},${channelId},'Secret private message',${sql.json({attachments:[{storage_object_id:storage.id,kind:'image',filename:'secret.png'}]})},${actors[0]},${actors[0]}) RETURNING *`;
  const [link] = await sql`INSERT INTO flightdeck_pg_storage_links(workspace_id,scope_id,channel_id,entity_type,entity_id,storage_object_id,created_by_actor_id)
    VALUES(${workspaceId},${scopeId},${channelId},'message',${message.id},${storage.id},${actors[0]}) RETURNING *`;
  return { storage, message, link, bytes, sha:hash(bytes), path:`/api/v4/flightdeck-pg/workspaces/${workspaceId}/messages/${message.id}/attachments/${storage.id}/blossom`, consent:{public:true,expected_link_id:link.id,expected_sha256:hash(bytes)} };
}

describe('direct message attachment publication', () => {
  test.skipIf(!process.env.BLOSSOM_PUBLICATION_CLI_ENTRY)('supported CLI publishes chat-only PNG through the real source route without creating a File', async () => {
    const { runFlightDeckPgCli } = await import(process.env.BLOSSOM_PUBLICATION_CLI_ENTRY!);
    const savedSession=process.env.SESSION_ID,savedCapability=process.env.WINGMAN_CAPABILITY;
    delete process.env.SESSION_ID;delete process.env.WINGMAN_CAPABILITY;
    try {
      const a=await attachment();
      const run=(action:string,extra:string[]=[])=>runFlightDeckPgCli(['attachment',action,a.storage.id,'--message',a.message.id,'--workspace',workspaceId,'--tower-url','http://localhost','--app-npub','npub1publicationapp','--key',Buffer.from(keys[0]).toString('hex'),'--json',...extra],{fetchImpl:(input:string,init:RequestInit)=>app.fetch(new Request(input,init))});
      expect((await run('publish')).exitCode).toBe(1);
      const result=await run('publish',['--public']);expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout).attachment.blossom_url).toBe(`http://localhost/${a.sha}`);
      const get=await app.request('/'+a.sha);expect(hash(new Uint8Array(await get.arrayBuffer()))).toBe(a.sha);
      expect((await run('blossom')).exitCode).toBe(0);expect((await run('unpublish')).exitCode).toBe(0);
      expect((await app.request('/'+a.sha)).status).toBe(401);
      expect(await sql`SELECT id FROM flightdeck_pg_files WHERE storage_object_id=${a.storage.id}`).toHaveLength(0);
    } finally {
      if(savedSession===undefined)delete process.env.SESSION_ID;else process.env.SESSION_ID=savedSession;
      if(savedCapability===undefined)delete process.env.WINGMAN_CAPABILITY;else process.env.WINGMAN_CAPABILITY=savedCapability;
    }
  });
  test('agents require actual owning-thread participation; deleted threads withdraw publication', async () => {
    const a=await attachment(new Uint8Array([81,82,83]));
    const [thread]=await sql`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspaceId},${scopeId},${channelId},'Private thread',${actors[0]},${actors[0]}) RETURNING id`;
    await sql`UPDATE flightdeck_pg_messages SET thread_id=${thread.id} WHERE id=${a.message.id}`;
    await sql`UPDATE flightdeck_pg_actors SET kind='agent' WHERE id=${actors[1]}`;
    expect((await request(a.path,'GET',1)).status).toBe(404);expect((await request(a.path,'PUT',1,a.consent)).status).toBe(404);
    await sql`UPDATE flightdeck_pg_messages SET metadata=${sql.json({mentions:[{npub:npubs[1]}]})} WHERE id=${a.message.id}`;
    expect((await request(a.path,'PUT',1,a.consent)).status).toBe(200);expect((await app.request('/'+a.sha)).status).toBe(200);
    await sql`UPDATE flightdeck_pg_messages SET metadata='{}' WHERE id=${a.message.id}`;
    expect((await app.request('/'+a.sha)).status).toBe(401);
    await request(a.path,'PUT',0,a.consent);
    await sql`UPDATE flightdeck_pg_threads SET deleted_at=NOW() WHERE id=${thread.id}`;
    expect((await app.request('/'+a.sha)).status).toBe(401);expect((await request(a.path)).status).toBe(404);
    await sql`UPDATE flightdeck_pg_actors SET kind='human' WHERE id=${actors[1]}`;
  });

  test('explicit consent, source permission and exact bytes; storage count and source links remain unchanged', async () => {
    const a=await attachment();
    const [before]=await sql`SELECT COUNT(*)::integer AS count FROM v4_storage_objects`;
    expect((await request(a.path,'PUT',0)).status).toBe(400);
    expect((await request(a.path,'PUT',2,a.consent)).status).toBe(403);
    expect((await request(a.path.replace(a.message.id,randomUUID()),'PUT',0,a.consent)).status).toBe(404);
    const initial=await (await request(a.path)).json(); expect(initial.attachment.public).toBe(false);
    const published=await request(a.path,'PUT',0,a.consent);expect(published.status).toBe(200);
    const result=await published.json();expect(result.changed).toBe(true);
    expect(result.attachment).toMatchObject({storage_object_id:a.storage.id,link_id:a.link.id,sha256_hex:a.sha,public:true,published_by_you:true});
    expect(JSON.stringify(result)).not.toContain('Secret'); expect(JSON.stringify(result)).not.toContain('secret');
    expect((await (await request(a.path,'PUT',0,a.consent)).json()).changed).toBe(false);
    const get=await app.request('/'+a.sha);expect(get.status).toBe(200);expect(hash(new Uint8Array(await get.arrayBuffer()))).toBe(a.sha);
    expect(get.headers.get('content-disposition')).not.toContain('secret');
    const head=await app.request('/'+a.sha,{method:'HEAD'});expect(head.status).toBe(200);expect(await head.text()).toBe('');
    const range=await app.request('/'+a.sha,{headers:{Range:'bytes=1-3'}});expect(range.status).toBe(206);expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([...a.bytes.slice(1,4)]);
    const [after]=await sql`SELECT COUNT(*)::integer AS count FROM v4_storage_objects`;expect(after).toEqual(before);
    const [link]=await sql`SELECT * FROM flightdeck_pg_storage_links WHERE id=${a.link.id}`;expect(link).toEqual(a.link);
    const [object]=await sql`SELECT is_public FROM v4_storage_objects WHERE id=${a.storage.id}`;expect(object.is_public).toBe(false);
    const files=await sql`SELECT id FROM flightdeck_pg_files WHERE storage_object_id=${a.storage.id}`;expect(files).toHaveLength(0);
    expect((await app.request(`/api/v4/storage/${a.storage.id}`)).status).not.toBe(200);
    await request(a.path,'DELETE');expect((await (await request(a.path,'DELETE')).json()).changed).toBe(false);
    expect((await app.request('/'+a.sha)).status).toBe(401);
  });
  test('independent actors and File duplicates; permission revocation removes attachment public authority', async () => {
    const a=await attachment(new Uint8Array([51,52,53])), duplicate=await file(a.bytes);
    await request(a.path,'PUT',0,a.consent);await request(a.path,'PUT',1,a.consent);
    expect((await (await request(a.path)).json()).attachment.publication_count).toBe(2);
    await request(duplicate.path,'PUT'); await request(a.path,'DELETE');await request(a.path,'DELETE',1);
    expect((await app.request('/'+a.sha)).status).toBe(200);
    await request(duplicate.path,'DELETE');expect((await app.request('/'+a.sha)).status).toBe(401);
    await request(a.path,'PUT',1,a.consent);
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NOW() WHERE principal_actor_id=${actors[1]} AND permission='channel.write'`;
    expect((await app.request('/'+a.sha)).status).toBe(401);
    expect((await request(a.path,'PUT',1,a.consent)).status).toBe(403);
    await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE principal_actor_id=${actors[1]} AND permission='channel.write'`;
    await request(a.path,'DELETE',1);
  });
  test('removed, reattached and deleted sources never reactivate an old link lifetime', async () => {
    const a=await attachment(new Uint8Array([54,55]));await request(a.path,'PUT',0,a.consent);
    await sql`UPDATE flightdeck_pg_storage_links SET deleted_at=NOW() WHERE id=${a.link.id}`;
    expect((await app.request('/'+a.sha)).status).toBe(401);expect((await request(a.path)).status).toBe(404);
    const [next]=await sql`INSERT INTO flightdeck_pg_storage_links(workspace_id,scope_id,channel_id,entity_type,entity_id,storage_object_id)
      VALUES(${workspaceId},${scopeId},${channelId},'message',${a.message.id},${a.storage.id}) RETURNING id`;
    expect((await app.request('/'+a.sha)).status).toBe(401);
    expect((await request(a.path,'PUT',0,a.consent)).status).toBe(409);
    await request(a.path,'PUT',0,{...a.consent,expected_link_id:next.id});
    await sql`UPDATE flightdeck_pg_messages SET deleted_at=NOW() WHERE id=${a.message.id}`;
    expect((await app.request('/'+a.sha)).status).toBe(401);expect((await request(a.path,'PUT',0,{...a.consent,expected_link_id:next.id})).status).toBe(404);
  });
  test('foreign owner, incomplete, missing and changed bytes cannot publish; unpublish tolerates missing bytes', async () => {
    const a=await attachment(new Uint8Array([56,57]),false);
    expect((await request(a.path,'PUT',0,a.consent)).status).toBe(409);
    await sql`UPDATE v4_storage_objects SET owner_npub=${npubs[1]} WHERE id=${a.storage.id}`;
    expect((await request(a.path,'PUT',0,a.consent)).status).toBe(404);
    await sql`UPDATE v4_storage_objects SET owner_npub=${npubs[0]},completed_at=NOW() WHERE id=${a.storage.id}`;
    expect((await request(a.path,'PUT',0,a.consent)).status).toBe(200);
    const b=await attachment(new Uint8Array([58,59]));
    await sql`UPDATE v4_storage_objects SET storage_path=${b.storage.storage_path} WHERE id=${a.storage.id}`;
    expect((await app.request('/'+a.sha)).status).toBe(401);
    expect((await request(a.path,'PUT',0,{...a.consent,expected_sha256:b.sha})).status).toBe(409);
    await sql`UPDATE v4_storage_objects SET storage_path='missing-message-publication-bytes' WHERE id=${a.storage.id}`;
    expect((await request(a.path,'PUT',0,a.consent)).status).toBe(409);
    expect((await request(a.path,'DELETE')).status).toBe(200);
  });
  test('configured public origin survives internal proxy/FIPS origins while local fixtures retain HTTP', async () => {
    const { blossomPublicOrigin }=await import('../src/services/blossom-origin');
    config.directHttpsUrl='https://tower.example.test';
    expect(blossomPublicOrigin(new Request('http://internal-proxy/path'))).toBe('https://tower.example.test');
    expect(blossomPublicOrigin(new Request('http://private.fips/path'))).toBe('https://tower.example.test');
    config.directHttpsUrl='http://localhost';
    expect(blossomPublicOrigin(new Request('http://localhost/path'))).toBe('http://localhost');
    expect(buildOpenApiDocument('http://localhost').paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/messages/{messageId}/attachments/{storageObjectId}/blossom'].put).toBeDefined();
  });
});
