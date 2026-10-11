import { test, expect } from 'bun:test';
import { buildOpenApiDocument } from '../src/openapi';
import { recordSyncDiscovery } from '../src/services/flightdeck-record-checkpoints';
import { accessPartition, drainAccessChanges } from '../src/services/flightdeck-record-access';
import type { RecordSyncState } from '../src/services/flightdeck-record-sync-state';

test('additive v1/v2 discovery and OpenAPI retain old routes and define access/retention fields',()=>{
  expect(recordSyncDiscovery.protocol_versions).toEqual([1,2]);
  expect(recordSyncDiscovery.additive_access).toBe(true);
  expect(recordSyncDiscovery.targeted_catchup).toBe(true);
  expect(recordSyncDiscovery.retention_policy).toBe('retain_downloaded');
  const api=buildOpenApiDocument('https://tower.example.test') as any;
  const base='/api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync';
  const page=api.paths[base].get.responses['200'].content['application/json'].schema;
  expect(page.properties.access_changes.maxItems).toBe(50);
  expect(page.properties.catchup.properties.resource_kind.enum).toEqual(['task','document','thread']);
  expect(page.properties.retention_policy.enum).toEqual(['retain_downloaded']);
  expect(page.properties.protocol_version.enum).toEqual([1,2]);
  const checkpoint=api.paths[base+'/clients/{clientId}'].get.responses['200'].content['application/json'].schema;
  expect(checkpoint.properties.access_revision.pattern).toBe('^[0-9]+$');
  expect(checkpoint.properties.retention_policy.enum).toEqual(['retain_downloaded']);
  expect(api.paths[base+'/clients/{clientId}/ack'].post.requestBody.content['application/json'].schema.required).toEqual(['cursor','expected_revision']);
});

test('bounded access notifications preserve personalized watermark partition identity',()=>{
  const key='channel:00000000-0000-4000-8000-000000000001:resource_view_state/task';
  expect(accessPartition(key)).toEqual({family:'resource_view_state',resource_type:'channel',resource_id:'00000000-0000-4000-8000-000000000001',resource_kind:'task'});
  const state:RecordSyncState={mode:'delta',boundary:'10',after:'10',family:'',id:'',snapshotId:null,
    accessChanges:Array.from({length:80},()=>({key,status:'lost'}))};
  expect(drainAccessChanges(state,200)).toHaveLength(50);
  expect(state.accessChanges).toHaveLength(30);
  expect(drainAccessChanges(state,1)).toHaveLength(1);
  expect(state.after).toBe('10');
});
