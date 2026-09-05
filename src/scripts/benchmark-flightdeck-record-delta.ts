/** Run after isolated record-delta tests, against their disposable DB only. */
import postgres from 'postgres';
import { readFlightDeckRecordPage } from '../services/flightdeck-record-delta';
import { readFileSync, writeFileSync } from 'node:fs';
const port=Number(process.env.RECORD_TEST_PORT), database=process.env.RECORD_TEST_DATABASE||'';
if(!port||port===5432||!/^tower_record_delta_\d+$/.test(database))throw new Error('Explicit disposable RECORD_TEST_PORT and RECORD_TEST_DATABASE required');
const db=postgres({host:'127.0.0.1',port,username:'postgres',password:'postgres',database,onnotice:()=>{}});
const [ctx]=await db`SELECT c.workspace_id,c.scope_id,c.id AS channel_id,m.actor_id FROM flightdeck_pg_channels c JOIN flightdeck_pg_workspace_memberships m ON m.workspace_id=c.workspace_id WHERE c.name='Test' LIMIT 1`;
const {workspace_id:w,scope_id:s,channel_id:c,actor_id:a}=ctx!;
const results:any[]=process.env.RECORD_BENCHMARK_SECONDARY_ONLY ? JSON.parse(readFileSync(new URL('../../docs/design/flightdeck-record-delta-v1-benchmark.json',import.meta.url),'utf8')).results : [];
let previous=0;
for(const n of (process.env.RECORD_BENCHMARK_SECONDARY_ONLY ? [] : [1_000,10_000,100_000])){
  const writeStart=performance.now();
  for(let batch=previous+1;batch<=n;batch+=1000) await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_at,created_by_actor_id,updated_by_actor_id)
    SELECT ${w},${s},${c},'benchmark '||g, '2025-01-01'::timestamptz + g*interval '1 millisecond',${a},${a} FROM generate_series(${batch}::integer,${Math.min(batch+999,n)}::integer) g`;
  const writeMs=performance.now()-writeStart;previous=n;
  await db`ANALYZE flightdeck_pg_messages`;await db`ANALYZE flightdeck_pg_record_journal`;await db`ANALYZE flightdeck_pg_record_current`;
  const [clock]=await db`SELECT position::text,epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${w}`;
  const [token]=await db`INSERT INTO flightdeck_pg_record_cursors(workspace_id,actor_id,epoch,state) VALUES(${w},${a},${clock!.epoch},${db.json({mode:'delta',boundary:clock!.position,after:clock!.position,family:'',id:'',snapshotId:null})}) RETURNING token`;
  await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${w},${s},${c},'one-message delta',${a},${a})`;
  const [anchor]=await db`SELECT ('2025-01-01'::timestamptz + ${n-50}*interval '1 millisecond')::text AS timestamp`;
  const oldQuery=()=>db`SELECT * FROM flightdeck_pg_messages m WHERE workspace_id=${w} AND channel_id=${c} AND deleted_at IS NULL AND (date_trunc('milliseconds',created_at),id)>(date_trunc('milliseconds',${anchor!.timestamp}::timestamptz),'00000000-0000-0000-0000-000000000000'::uuid) ORDER BY date_trunc('milliseconds',created_at),id LIMIT 50`;
  const newQuery=()=>db`SELECT * FROM flightdeck_pg_messages m WHERE workspace_id=${w} AND channel_id=${c} AND deleted_at IS NULL AND (date_trunc('milliseconds',created_at AT TIME ZONE 'UTC'),id)>(date_trunc('milliseconds',${anchor!.timestamp}::timestamptz AT TIME ZONE 'UTC'),'00000000-0000-0000-0000-000000000000'::uuid) ORDER BY date_trunc('milliseconds',created_at AT TIME ZONE 'UTC'),id LIMIT 50`;
  async function measure(fn:()=>PromiseLike<any>){const times:number[]=[];let value:any;for(let i=0;i<31;i++){const start=performance.now();value=await fn();if(i)times.push(performance.now()-start);}times.sort((a,b)=>a-b);return {median_ms:times[15],p95_ms:times[28],rows:value.changes?.length??value.length,payload_bytes:Buffer.byteLength(JSON.stringify(value))};}
  const legacyBundle=()=>db`SELECT * FROM flightdeck_pg_messages WHERE workspace_id=${w} AND channel_id=${c} AND deleted_at IS NULL ORDER BY created_at,id LIMIT 10000`;
  const baseline=await measure(oldQuery),indexed=await measure(newQuery),bundle=await measure(legacyBundle);
  const delta=await measure(()=>readFlightDeckRecordPage({workspaceId:w,actorId:a,cursor:token!.token},db));
  const oldPlan=await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM flightdeck_pg_messages WHERE workspace_id=${w} AND channel_id=${c} AND deleted_at IS NULL AND (date_trunc('milliseconds',created_at),id)>(date_trunc('milliseconds',${anchor!.timestamp}::timestamptz),'00000000-0000-0000-0000-000000000000'::uuid) ORDER BY date_trunc('milliseconds',created_at),id LIMIT 50`;
  const newPlan=await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM flightdeck_pg_messages WHERE workspace_id=${w} AND channel_id=${c} AND deleted_at IS NULL AND (date_trunc('milliseconds',created_at AT TIME ZONE 'UTC'),id)>(date_trunc('milliseconds',${anchor!.timestamp}::timestamptz AT TIME ZONE 'UTC'),'00000000-0000-0000-0000-000000000000'::uuid) ORDER BY date_trunc('milliseconds',created_at AT TIME ZONE 'UTC'),id LIMIT 50`;
  const deltaPlan=await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM flightdeck_pg_record_journal WHERE workspace_id=${w} AND position>${clock!.position}::bigint ORDER BY position LIMIT 201`;
  const sizes=await db`SELECT relname,pg_total_relation_size(oid)::text AS bytes FROM pg_class WHERE relname IN ('flightdeck_pg_messages','flightdeck_pg_record_current','flightdeck_pg_record_journal','idx_fd_message_timeline','idx_fd_message_thread_timeline')`;
  results.push({history:n,insert_ms:writeMs,baseline_window:baseline,indexed_window:indexed,legacy_message_bundle:bundle,record_delta:delta,old_plan:oldPlan[0]!['QUERY PLAN'],indexed_plan:newPlan[0]!['QUERY PLAN'],delta_plan:deltaPlan[0]!['QUERY PLAN'],sizes});
  console.log(JSON.stringify({history:n,baseline,indexed,bundle,delta,insert_ms:writeMs}));
}
// Large board/comment fixtures validate the actual mixed-order and target predicates.
const [board]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${s},'benchmark-board-'||gen_random_uuid()::text) RETURNING id`;
const boardChannel=board!.id;
for(let batch=1;batch<=10000;batch+=1000) await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,updated_at,created_by_actor_id,updated_by_actor_id)
 SELECT ${w},${s},${boardChannel},'board '||g,'2025-01-01T00:00:00Z'::timestamptz+g*interval '1 millisecond',${a},${a} FROM generate_series(${batch}::integer,${batch+999}::integer) g`;
const [task]=await db`SELECT id FROM flightdeck_pg_tasks WHERE workspace_id=${w} AND channel_id=${boardChannel} ORDER BY updated_at LIMIT 1`;
for(let batch=1;batch<=10000;batch+=1000) await db`INSERT INTO flightdeck_pg_task_comments(workspace_id,scope_id,channel_id,task_id,body,created_at,created_by_actor_id,updated_by_actor_id)
 SELECT ${w},${s},${boardChannel},${task!.id},'comment '||g,'2025-01-01T00:00:00Z'::timestamptz+g*interval '1 millisecond',${a},${a} FROM generate_series(${batch}::integer,${batch+999}::integer) g`;
await db`ANALYZE flightdeck_pg_tasks`;await db`ANALYZE flightdeck_pg_task_comments`;
const boardPlan=await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM flightdeck_pg_tasks WHERE workspace_id=${w} AND channel_id=${boardChannel} AND state='new' AND deleted_at IS NULL
 AND (-extract(epoch FROM updated_at AT TIME ZONE 'UTC'),id)>(-extract(epoch FROM '2025-01-01T00:00:01Z'::timestamptz AT TIME ZONE 'UTC'),'00000000-0000-0000-0000-000000000000'::uuid)
 ORDER BY (-extract(epoch FROM updated_at AT TIME ZONE 'UTC')),id LIMIT 20`;
const commentPlan=await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT tc.*,creator.npub AS created_by_actor_npub FROM flightdeck_pg_task_comments tc LEFT JOIN flightdeck_pg_actors creator ON creator.id=tc.created_by_actor_id
 WHERE tc.workspace_id=${w} AND tc.task_id=${task!.id} AND tc.deleted_at IS NULL
 AND (tc.created_at,tc.id)>('2025-01-01T00:00:09Z'::timestamptz,'00000000-0000-0000-0000-000000000000'::uuid)
 ORDER BY tc.created_at,tc.id LIMIT 20`;
const secondary={tasks:10000,comments:10000,board_plan:boardPlan[0]!['QUERY PLAN'],comment_plan:commentPlan[0]!['QUERY PLAN']};
writeFileSync(new URL('../../docs/design/flightdeck-record-delta-v1-benchmark.json',import.meta.url),JSON.stringify({platform:process.platform,arch:process.arch,postgres:'16 isolated localhost',samples:30,insert_batch_rows:1000,results,secondary},null,2)+'\n');
await db.end();
