/** Run after the focused isolated suite; never uses shared DB configuration. */
import postgres from 'postgres';
import { writeFileSync } from 'node:fs';
import { listEffectiveFlightDeckPgThreadMessages } from '../services/flightdeck-pg-api';
const port=Number(process.env.RECORD_TEST_PORT), database=process.env.RECORD_TEST_DATABASE||'';
if(!port||port===5432||!/^tower_record_delta_\d+$/.test(database))throw new Error('Explicit disposable RECORD_TEST_PORT and RECORD_TEST_DATABASE required');
let driverBytes=0,payloadRows=0,rangeQuery='',rangeParameters:unknown[]=[];
const db=postgres({host:'127.0.0.1',port,username:'postgres',password:'postgres',database,onnotice:()=>{},
  transform:{row(row){driverBytes+=Buffer.byteLength(JSON.stringify(row));if('body' in row)payloadRows++;return row;}},
  debug(_connection,query,parameters){if(query.trimStart().startsWith('SELECT m.*,m.created_at::text AS cursor_created_at')){rangeQuery=query;rangeParameters=parameters;}},
});
try {
  const [leaf]=await db`SELECT workspace_id,channel_id,thread_id FROM flightdeck_pg_messages WHERE body='leaf' LIMIT 1`;
  if(!leaf)throw new Error('Run full focused record-delta suite to create deep branch fixture');
  await db`ANALYZE flightdeck_pg_messages`;
  const input={workspaceId:leaf.workspace_id,channelId:leaf.channel_id,threadId:leaf.thread_id,limit:20,
    afterCreatedAt:'2026-01-01T00:00:00.123999Z',afterId:'80000000-0000-4000-8000-000000011970'};
  const times:number[]=[];let rows=0;
  for(let n=0;n<31;n++){
    driverBytes=0;payloadRows=0;const start=performance.now();
    rows=(await listEffectiveFlightDeckPgThreadMessages(input,db)).length;
    if(n)times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);
  const measurement={history:12000,branch_depth:50,limit:20,rows,payload_rows:payloadRows,driver_bytes:driverBytes,median_ms:times[15],p95_ms:times[28]};
  const plan=await db.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${rangeQuery}`,rangeParameters as any[]);
  const [size]=await db`SELECT pg_relation_size('idx_fd_message_thread_effective_timeline')::text AS index_bytes`;
  writeFileSync(new URL('../../docs/design/flightdeck-branches-benchmark.json',import.meta.url),JSON.stringify({postgres:'16 isolated localhost',samples:30,measurement,index_bytes:size!.index_bytes,query:rangeQuery,plan:plan[0]!['QUERY PLAN']},null,2)+'\n');
  console.log(JSON.stringify(measurement));
}finally{await db.end();}
