import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { getDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { DOCUMENT_EDIT_PROTOCOL } from '../src/types';
import { lockDocumentEditAuthority } from '../src/services/document-edit-session';

// An explicit disposable fixture is mandatory; never touch the managed runtime or real user documents.
const port = Number(process.env.DOCUMENT_EDIT_TEST_PORT);
describe.skipIf(!port || port === 5432)('document editing authority on disposable PostgreSQL', () => {
  const database = `document_edit_${process.pid}_${Date.now()}`;
  const conn = {host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
  const secrets = [new Uint8Array(32).fill(123),new Uint8Array(32).fill(124)];
  const identities = secrets.map(s=>nip19.npubEncode(getPublicKey(s)));
  let db:ReturnType<typeof postgres>, previous:ReturnType<typeof postgres>, app:ReturnType<typeof createApp>;
  let workspace:string, channel:string, scope:string, actors:string[];
  const base=()=>`/api/v4/flightdeck-pg/workspaces/${workspace}`;
  async function call(path:string, method='GET',body?:any, actor=0) {
    const bytes=body===undefined?undefined:JSON.stringify(body);
    const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',`http://localhost${path}`],['method',method],...(bytes?[['payload',createHash('sha256').update(bytes).digest('hex')]]:[])]},secrets[actor]!);
    const response=await app.request(path,{method,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,'content-type':'application/json'},body:bytes});
    return {status:response.status,body:await response.json() as any};
  }
  async function storage(text:string) {
    const sha=createHash('sha256').update(text).digest('hex');
    const [row]=await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,sha256_hex,size_bytes,content_type,storage_path,completed_at)
      VALUES(${identities[0]!},${identities[0]!},${sha},${text.length},'text/plain',${`document-edit-fixture/${randomUUID()}`},NOW()) RETURNING *`;
    return row!;
  }
  async function fixture() {
    const object=await storage('original body');
    const [doc]=await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,title,storage_object_id,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspace},${scope},${channel},'Original title',${object.id},${actors[0]!},${actors[0]!}) RETURNING *`;
    return {doc:doc!,object};
  }
  const acquire=(id:string,session?:string,extra={})=>call(`${base()}/edit-leases/acquire`,'POST',{
    entity_type:'document',entity_id:id,ttl_seconds:120,
    ...(session?{document_edit_protocol:DOCUMENT_EDIT_PROTOCOL,editor_session_id:session}:{}),...extra,
  });
  const patch=(id:string,lease:string,version:number,object:any,title='Edited title',extra={})=>call(`${base()}/docs/${id}`,'PATCH',{
    row_version:version,base_available:true,base_body_sha256_hex:object.sha256_hex,storage_object_id:object.id,lease_token:lease,title,...extra,
  });
  beforeAll(async()=>{
    const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${database}`);await admin.end();
    db=postgres({...conn,database});previous=getDb();setDb(db);
    for(const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8')))await db.unsafe(statement);
    const rows=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${identities[0]!},'human'),(${identities[1]!},'human') RETURNING id`;actors=rows.map(r=>r.id);
    const [w]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
      VALUES('document-edit-tower','document-edit-workspace',${identities[0]!},'document-edit-app','Disposable document editing') RETURNING id`;workspace=w!.id;
    for(const actor of actors)await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${actor},'member')`;
    const [s]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspace},'Fixture','project') RETURNING id`;scope=s!.id;
    const [c]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace},${scope},'Fixture') RETURNING id`;channel=c!.id;
    for(const actor of actors)for(const permission of ['channel.read','channel.write','doc.read','doc.write'])await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${workspace},'actor',${actor},'channel',${channel},${permission})`;
    await ensureRuntimeSchema();app=createApp();
  });
  afterAll(async()=>{setDb(previous);await db?.end();const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);await admin.end();});

  test('legacy ordinary saves work; active same-actor editors conflict instead of silently sharing authority',async()=>{
    const {doc,object}=await fixture();const first=await acquire(doc.id);
    expect(first.status).toBe(201);expect(first.body.document_edit_protocol).toBeUndefined();
    const blocked=await acquire(doc.id);expect(blocked.status).toBe(409);expect(blocked.body.code).toBe('edit_lease_held');
    expect(blocked.body.details.lease.id).toBe(first.body.lease.id);
    const saved=await patch(doc.id,first.body.lease.lease_token,1,object);expect(saved.status).toBe(200);
    const missingVersion=await call(`${base()}/docs/${doc.id}`,'PATCH',{title:'Wildcard rename',lease_token:first.body.lease.lease_token});expect(missingVersion.status).toBe(400);
    const archiveMentions=await call(`${base()}/docs/${doc.id}`,'PATCH',{row_version:2,archived:true,mentions:[]});expect(archiveMentions.status).toBe(400);
    const archiveWildcard=await call(`${base()}/docs/${doc.id}`,'PATCH',{archived:true});expect(archiveWildcard.status).toBe(400);
  });
  test('explicit same-actor takeover bumps authority version, snapshots exact head and rejects old renewal/metadata',async()=>{
    const {doc,object}=await fixture(),oldSession=randomUUID();const first=await acquire(doc.id,oldSession);
    const inspected=await call(`${base()}/edit-leases?entity_type=document&entity_id=${doc.id}`);
    expect(inspected.body.document_edit_protocol).toBe(DOCUMENT_EDIT_PROTOCOL);expect(inspected.body.lease.lease_token).toBeUndefined();
    expect(inspected.body.lease.editor_session_id).toBeUndefined();
    const session=randomUUID(),next=await acquire(doc.id,session,{takeover:true,expected_lease_id:first.body.lease.id});
    expect(next.status).toBe(201);expect(next.body.document_edit_protocol).toBe(DOCUMENT_EDIT_PROTOCOL);
    expect(next.body.lease.editor_session_id).toBe(session);expect(next.body.doc.row_version).toBe(2);
    expect(next.body.doc.title).toBe(doc.title);expect(next.body.doc.storage_object_id).toBe(object.id);
    expect(next.body.canonical_version.row_version).toBe(2);expect(next.body.canonical_version.body_sha256_hex).toBe(object.sha256_hex);
    const [snapshot]=await db`SELECT * FROM flightdeck_pg_doc_versions WHERE workspace_id=${workspace} AND doc_id=${doc.id} AND row_version=2`;
    expect(snapshot!.title).toBe(doc.title);expect(snapshot!.storage_object_id).toBe(object.id);
    const [audit]=await db`SELECT metadata FROM flightdeck_pg_audit_events WHERE resource_id=${doc.id} AND action='doc.edit.takeover'`;
    expect(audit!.metadata.authority_barrier).toBe(true);
    expect((await call(`${base()}/edit-leases/${first.body.lease.id}/renew`,'POST',{lease_token:first.body.lease.lease_token,ttl_seconds:120})).status).toBe(409);
    const renamed=await call(`${base()}/docs/${doc.id}`,'PATCH',{row_version:2,lease_token:first.body.lease.lease_token,title:'Stale rename'});
    expect(renamed.status).toBe(409);expect(renamed.body.code).toBe('document_edit_session_superseded');
    expect((await call(`${base()}/edit-leases/${first.body.lease.id}/renew`,'POST',{lease_token:first.body.lease.lease_token,ttl_seconds:120})).body.code).toBe('document_edit_session_superseded');
    expect((await acquire(doc.id,oldSession)).body.code).toBe('document_edit_session_superseded');
    expect((await acquire(doc.id,randomUUID(),{takeover:true,expected_lease_id:first.body.lease.id})).body.code).toBe('edit_lease_changed');
    expect((await call(`${base()}/edit-leases/${first.body.lease.id}/release`,'POST',{lease_token:first.body.lease.lease_token})).body.released).toBe(false);
    expect((await call(`${base()}/edit-leases/${next.body.lease.id}/renew`,'POST',{lease_token:next.body.lease.lease_token,ttl_seconds:120})).body.document_edit_protocol).toBe(DOCUMENT_EDIT_PROTOCOL);
    const staleBody=await patch(doc.id,first.body.lease.lease_token,2,object);
    expect(staleBody.status).toBe(409);expect(staleBody.body.code).toBe('document_edit_session_superseded');
    await db`UPDATE flightdeck_pg_edit_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE id=${next.body.lease.id}`;
    expect((await acquire(doc.id,oldSession)).body.code).toBe('document_edit_session_superseded');
  });
  test('legacy reacquire after takeover expiry preserves unchanged pre-takeover content and title as recovery',async()=>{
    const {doc,object}=await fixture();const first=await acquire(doc.id);
    const next=await acquire(doc.id,randomUUID(),{takeover:true,expected_lease_id:first.body.lease.id});expect(next.status).toBe(201);
    await db`UPDATE flightdeck_pg_edit_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE id=${next.body.lease.id}`;
    const again=await acquire(doc.id);expect(again.status).toBe(201);
    // No follow-up edit is needed to trigger the barrier: this is the exact pre-takeover snapshot.
    const save=await patch(doc.id,again.body.lease.lease_token,1,object,'Original title');
    expect(save.status).toBe(409);expect(save.body.code).toBe('document_recovery_created');
    expect(save.body.recovery.submitted_patch.title).toBe('Original title');expect(save.body.current_head.row_version).toBe(2);
    const [head]=await db`SELECT * FROM flightdeck_pg_docs WHERE id=${doc.id}`;expect(head!.row_version).toBe(2);expect(head!.title).toBe('Original title');
    // New-protocol superseded session remains revoked even after successor lease expiry.
    const before=await acquire(doc.id,randomUUID());expect(before.status).toBe(409);
  });
  test('expired intact document editor can reacquire its session without reviving a superseded session',async()=>{
    const {doc}=await fixture(),session=randomUUID();const first=await acquire(doc.id,session);
    await db`UPDATE flightdeck_pg_edit_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE id=${first.body.lease.id}`;
    const expired=await call(`${base()}/edit-leases/${first.body.lease.id}/renew`,'POST',{lease_token:first.body.lease.lease_token,ttl_seconds:120});
    expect(expired.status).toBe(409);expect(expired.body.code).toBe('lease_expired');
    const resumed=await acquire(doc.id,session);expect(resumed.status).toBe(201);expect(resumed.body.lease.editor_session_id).toBe(session);
    expect(resumed.body.doc.row_version).toBe(1);
  });
  test('recovery promotion validates authority inside the canonical transaction',async()=>{
    const {doc,object}=await fixture();const first=await acquire(doc.id,randomUUID());
    const next=await acquire(doc.id,randomUUID(),{takeover:true,expected_lease_id:first.body.lease.id});
    const recovery=await patch(doc.id,first.body.lease.lease_token,1,object,'Preserved old title');
    expect(recovery.body.code).toBe('document_recovery_created');
    const path=`${base()}/docs/${doc.id}/recoveries/${recovery.body.recovery.id}/promote`;
    const old=await call(path,'POST',{row_version:2,base_body_sha256_hex:object.sha256_hex,lease_token:first.body.lease.lease_token});
    expect(old.status).toBe(409);expect(old.body.code).toBe('document_edit_session_superseded');
    const current=await call(path,'POST',{row_version:2,base_body_sha256_hex:object.sha256_hex,lease_token:next.body.lease.lease_token});
    expect(current.status).toBe(200);expect(current.body.doc.title).toBe('Preserved old title');expect(current.body.doc.row_version).toBe(3);
  });
  test('other actors cannot take over; concurrent acquisitions grant exactly one document authority',async()=>{
    const {doc}=await fixture();const first=await acquire(doc.id,randomUUID());
    const other=await call(`${base()}/edit-leases/acquire`,'POST',{entity_type:'document',entity_id:doc.id,document_edit_protocol:DOCUMENT_EDIT_PROTOCOL,
      editor_session_id:randomUUID(),takeover:true,expected_lease_id:first.body.lease.id},1);
    expect(other.status).toBe(409);expect(other.body.code).toBe('edit_lease_held');
    const fresh=await fixture();const race=await Promise.all([acquire(fresh.doc.id,randomUUID()),acquire(fresh.doc.id,randomUUID())]);
    expect(race.map(r=>r.status).sort()).toEqual([201,409]);
  });
  test('takeover waits for canonical row lock and returns coherent latest content and title',async()=>{
    const {doc,object}=await fixture();const first=await acquire(doc.id,randomUUID());
    let unlock!:()=>void, locked!:()=>void;
    const gate=new Promise<void>(resolve=>{unlock=resolve}),ready=new Promise<void>(resolve=>{locked=resolve});
    const writer=db.begin(async tx=>{
      const sql=tx as unknown as ReturnType<typeof postgres>;
      await lockDocumentEditAuthority(workspace,doc.id,sql);locked();await gate;
      await sql`UPDATE flightdeck_pg_docs SET title='Last canonical rename',row_version=row_version+1 WHERE id=${doc.id}`;
    });
    await ready;
    let finished=false;const pending=acquire(doc.id,randomUUID(),{takeover:true,expected_lease_id:first.body.lease.id}).then(r=>{finished=true;return r});
    await new Promise(resolve=>setTimeout(resolve,50));expect(finished).toBe(false);unlock();await writer;
    const takeover=await pending;expect(takeover.status).toBe(201);expect(takeover.body.doc.title).toBe('Last canonical rename');
    expect(takeover.body.doc.row_version).toBe(3);expect(takeover.body.canonical_version.row_version).toBe(3);
    expect(takeover.body.canonical_version.storage_object_id).toBe(object.id);
  });
  test('takeover transaction rollback preserves prior authority, head, history and audit',async()=>{
    const {doc}=await fixture();const first=await acquire(doc.id,randomUUID());
    const {acquireDocumentEditSession}=await import('../src/services/document-edit-session');
    await expect(db.begin(async tx=>{
      const result=await acquireDocumentEditSession({workspaceId:workspace,entityId:doc.id,actorId:actors[0]!,actorNpub:identities[0]!,
        document_edit_protocol:DOCUMENT_EDIT_PROTOCOL,editor_session_id:randomUUID(),takeover:true,expected_lease_id:first.body.lease.id},tx as unknown as ReturnType<typeof postgres>);
      expect(result.ok).toBe(true);throw new Error('Synthetic downstream transaction failure');
    })).rejects.toThrow('Synthetic downstream transaction failure');
    const [head]=await db`SELECT row_version FROM flightdeck_pg_docs WHERE id=${doc.id}`;expect(head!.row_version).toBe(1);
    expect((await db`SELECT id FROM flightdeck_pg_audit_events WHERE resource_id=${doc.id} AND action='doc.edit.takeover'`)).toHaveLength(0);
    expect((await db`SELECT row_version FROM flightdeck_pg_doc_versions WHERE doc_id=${doc.id} AND row_version=2`)).toHaveLength(0);
    expect((await call(`${base()}/edit-leases/${first.body.lease.id}/renew`,'POST',{lease_token:first.body.lease.lease_token,ttl_seconds:120})).status).toBe(200);
  });
  test('task and scope ordinary acquisition retain their existing same-actor behavior',async()=>{
    const target=randomUUID();
    // Service-level scope helper requires ACL at route; legacy document changes must not alter service semantics.
    const {acquireFlightDeckPgEditLease}=await import('../src/services/flightdeck-pg-api');
    const a=await acquireFlightDeckPgEditLease({workspaceId:workspace,entityType:'scope',entityId:target,actorId:actors[0]!,actorNpub:identities[0]!},db);
    const b=await acquireFlightDeckPgEditLease({workspaceId:workspace,entityType:'scope',entityId:target,actorId:actors[0]!,actorNpub:identities[0]!},db);
    expect(a.ok).toBe(true);expect(b.ok).toBe(true);
  });
});
