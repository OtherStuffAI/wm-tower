import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { boundedSnapshotWireFixtures } from './fixtures/bounded-record-snapshots-v1';
import { recordSyncDiscovery } from '../src/services/flightdeck-record-checkpoints';
import { buildOpenApiDocument } from '../src/openapi';

test('negotiated discovery/OpenAPI and cross-repo chunk fixtures preserve v1/v2 and exact byte assembly',()=>{
  expect(recordSyncDiscovery.protocol_versions).toEqual([1,2]);
  expect(recordSyncDiscovery.extensions).toEqual(['bounded_snapshot_v1','chunked_v1']);
  const api=buildOpenApiDocument('https://tower.example.test') as any;
  const base='/api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync';
  expect(api.paths[base].get.parameters.find((p:any)=>p.name==='extension').schema.enum).toEqual(['bounded_snapshot_v1']);
  expect(api.paths[base].get.responses['200'].content['application/json'].schema.properties.large_records.maxItems).toBe(1);
  expect(api.paths[base+'/clients/{clientId}/pages/{cursor}/large-records/{manifestId}/chunks/{index}'].get.responses['200'].content['application/octet-stream']).toBeDefined();
  const staticFixture=JSON.parse(readFileSync(new URL('./fixtures/bounded-record-snapshots-v1.json',import.meta.url),'utf8'));
  const f=boundedSnapshotWireFixtures();expect(staticFixture.page).toEqual(f.page);expect(staticFixture.acknowledgement).toEqual(f.acknowledgement);
  const assembled=Buffer.concat(f.chunks);
  expect(assembled.length).toBe(f.page.large_records[0]!.total_bytes);
  expect(createHash('sha256').update(assembled).digest('hex')).toBe(f.page.large_records[0]!.sha256);
  expect(JSON.parse(assembled.toString('utf8'))).toEqual(f.envelope);
  expect(f.chunks.every(c=>c.length<=262144)).toBe(true);
  expect(assembled.length).toBeGreaterThan(1048576);
  expect(Buffer.byteLength(JSON.stringify(f.page))).toBeLessThan(1048576);
  expect(f.empty_progress.has_more).toBe(true);expect(f.empty_progress.handover.complete).toBe(false);
});
