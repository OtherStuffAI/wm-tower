import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { recordFamilies } from '../../src/services/flightdeck-record-families';
/** Deterministic cross-repo wire fixtures; independent of Tower/database runtime.
 * Import or copy this generator alongside flightdeck-record-delta-v1.json.
 * Chunk slices can split UTF-8 code points. Assemble bytes, verify and then parse. */
export function boundedSnapshotWireFixtures() {
  const source=JSON.parse(readFileSync(new URL('./flightdeck-record-delta-v1.json',import.meta.url),'utf8')).canonical_upserts;
  const change=structuredClone(source.changes.find((c:any)=>c.family==='message'));
  change.row.body='€'.repeat(400000);
  const actorIds=new Set(['created_by_actor_id','updated_by_actor_id'].map(key=>change.row[key]));
  const actors=source.actors.filter((a:any)=>actorIds.has(a.actor_id));
  const envelope={change,actors},bytes=Buffer.from(JSON.stringify(envelope));
  const manifest={manifest_id:'90000000-0000-4000-8000-000000000001',family:change.family,id:change.id,version:change.version,
    sha256:createHash('sha256').update(bytes).digest('hex'),total_bytes:bytes.length,chunk_bytes:262144,chunk_count:Math.ceil(bytes.length/262144)};
  const page={protocol_version:2,client_id:'90000000-0000-4000-8000-000000000002',checkpoint_revision:'0',families:Object.keys(recordFamilies),
    mode:'delta',changes:[],actors:[],access_revision:'4',access_changes:[],catchup:null,retention_policy:'retain_downloaded',
    next_cursor:'90000000-0000-4000-8000-000000000003',has_more:false,snapshot_id:null,snapshot_complete:false,partitions_complete:[],
    bounds:{max_rows:200,max_bytes:1048576},handover:{target_position:change.version,through_position:change.version,complete:true,
      authority_epoch:'90000000-0000-4000-8000-000000000004',access_revision:'4'},large_records:[manifest]};
  return {page,envelope,bytes,chunks:Array.from({length:manifest.chunk_count},(_,i)=>bytes.subarray(i*262144,(i+1)*262144)),
    acknowledgement:{cursor:page.next_cursor,expected_revision:page.checkpoint_revision,large_record_receipts:[{manifest_id:manifest.manifest_id,sha256:manifest.sha256}]},
    empty_progress:{...page,has_more:true,large_records:[],handover:{...page.handover,complete:false}},
    fail_closed:{status:413,body:{error:'record_too_large',protocol_version:2}},
    errors:['extension_required','large_record_ack_required','large_record_receipt_required','large_record_changed','page_token_invalid','record_access_required']};
}
