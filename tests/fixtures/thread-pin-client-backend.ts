/** Disposable production HTTP route + Postgres fixture, driven by client tests.
 * Synthetic test keys never leave this process. No human/bot key fallback.
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { getPublicKey, nip19, finalizeEvent } from 'nostr-tools';
import { splitSqlStatements } from '../../src/schema/sql-statements';
for (const line of readFileSync(new URL('../../.env.example',import.meta.url),'utf8').split('\n')) {
 const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&!process.env[m[1]!])process.env[m[1]!]=m[2]!;
}
const port=Number(process.env.RECORD_TEST_PORT);
if(!port || port===5432)throw Error('Disposable RECORD_TEST_PORT required');
const {setDb}=await import('../../src/db');
const {createApp}=await import('../../src/server');
const name=`pin_clients_${process.pid}_${Date.now()}`;
const conn={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${name}`);await admin.end();
const db=postgres({...conn,database:name});
for(const statement of splitSqlStatements(readFileSync(new URL('../../src/schema/001_init.sql',import.meta.url),'utf8')))await db.unsafe(statement);
// Force every pin key above the actor keys: snapshot retirement must resume
// from the row primary key, never the actor UUID.
await db`ALTER TABLE flightdeck_pg_thread_pins ALTER COLUMN id SET DEFAULT ('f' || substring(gen_random_uuid()::text from 2))::uuid`;
const keys=[new Uint8Array(32).fill(121),new Uint8Array(32).fill(122)];
const npubs=keys.map(k=>nip19.npubEncode(getPublicKey(k)));
const actors=await db`INSERT INTO flightdeck_pg_actors(id,npub,kind) VALUES('10000000-0000-4000-8000-000000000001',${npubs[0]!},'human'),('20000000-0000-4000-8000-000000000002',${npubs[1]!},'human') RETURNING id`;
const [ws]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service',${npubs[0]!},${npubs[0]!},'Two clients') RETURNING id`;
const w=ws!.id,a=actors[0]!.id;
for(const actor of actors)await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w},${actor.id},'member')`;
const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Fixture','project') RETURNING id`;
const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${scope!.id},'Fixture') RETURNING id`;
await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${a},'channel',${channel!.id},'channel.read')`;
const threads=await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${w},${scope!.id},${channel!.id},'First',${a},${a}),(${w},${scope!.id},${channel!.id},'Second',${a},${a}),(${w},${scope!.id},${channel!.id},'Third',${a},${a}) RETURNING id`;
setDb(db);
const app=createApp(),server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.fetch});
console.log(JSON.stringify({ready:true,baseUrl:`http://127.0.0.1:${server.port}`,workspaceId:w,actorIds:actors.map(r=>r.id),npubs,channelId:channel!.id,threadIds:threads.map(r=>r.id)}));
let done=false;
async function cleanup(){if(done)return;done=true;server.stop(true);await db.end();const connAdmin=postgres({...conn,database:'postgres'});await connAdmin.unsafe(`DROP DATABASE IF EXISTS ${name}`);await connAdmin.end();process.exit(0);}
const lines=createInterface({input:process.stdin});
lines.on('line',async line=>{
 try{const input=JSON.parse(line);if(input.stop){await cleanup();return;}
 console.log(JSON.stringify({id:input.id,event:finalizeEvent(input.event,keys[input.actor||0]!)}));}
 catch(error){console.log(JSON.stringify({error:String(error)}));}
});
lines.on('close',cleanup);process.on('SIGTERM',cleanup);
