import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server';
import {
  flightDeckPgContractFixturePaths,
  flightDeckPgContractNames,
  type FlightDeckPgContractFixture,
} from '../src/types';

describe('OpenAPI docs', () => {
  const app = createApp();

  test('GET /openapi.json exposes the API spec', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('SuperBased V4 API');
    expect(body.paths['/api/v4/records/sync']).toBeDefined();
    expect(body.paths['/api/v4/records/{record_id}/checkout/acquire']).toBeDefined();
    expect(body.paths['/api/v4/records/{record_id}/checkout/release']).toBeDefined();
    expect(body.paths['/api/v4/records/{record_id}/checkout/renew']).toBeDefined();
    expect(body.paths['/api/v4/records/{record_id}/history']).toBeDefined();
    expect(body.paths['/api/v4/groups']).toBeDefined();
    expect(body.paths['/api/v4/groups/keys']).toBeDefined();
    expect(body.paths['/api/v4/admin/tower']).toBeDefined();
    expect(body.paths['/admin']).toBeDefined();
    expect(body.paths['/api/v4/admin/workspaces/{workspaceId}/inspect']?.get?.security).toEqual([{ nip98: [] }]);
    expect(body.paths['/api/v4/admin/workspaces/{workspaceId}']?.delete?.security).toEqual([{ nip98: [] }]);
    expect(body.paths['/api/v4/admin/workspaces/delete-preview']?.post?.security).toEqual([{ nip98: [] }]);
    expect(body.paths['/api/v4/admin/workspaces/bulk-delete']?.post?.security).toEqual([{ nip98: [] }]);
    expect(body.paths['/api/v4/admin/flightdeck-pg/workspaces']?.post?.security).toEqual([{ nip98: [] }]);
    expect(body.paths['/api/v4/admin/flightdeck-pg/workspaces'].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/FlightDeckPgAdminWorkspaceSetupRequest');
    expect(body.paths['/api/v4/admin/flightdeck-pg/workspaces'].post.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/FlightDeckPgAdminWorkspaceSetupResponse');
    expect(body.paths['/ui']).toBeDefined();
    expect(body.paths['/api/v4/admin/billing/overview']).toBeDefined();
    expect(body.paths['/api/v4/billing/workspaces']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/billing/status']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/billing/purchase']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/records/families']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/records/metadata']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/storage/metadata']).toBeDefined();
    expect(body.paths['/version']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/app-schemas']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/schemas']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/connection-token']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/descriptor']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/provision']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/migrations']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/tables/{table}/rows']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/tables/{table}/rows/{rowId}']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/tables/{table}/query']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/{collection}/rows']).toBeDefined();
    expect(body.paths['/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/{collection}/rows/{rowId}']).toBeDefined();
    expect(body.paths['/api/v4/user/workspace-key-mappings']).toBeDefined();
    expect(body.paths['/api/v4/flightdeck-pg/service'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.service_metadata']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/descriptor'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.workspace_descriptor']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/me'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.me']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/members'].post).toBeDefined();
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.scopes.list']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes'].post['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.scopes.create']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}'].patch).toBeTruthy();
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}/channels'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.channels.list']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}/channels'].post['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.channels.create']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/grants'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.channel_grants.list']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/grants'].post['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.channel_grants.create']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/events'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.events.list']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/events'].get.parameters.map((param: any) => param.name)).toEqual(
      expect.arrayContaining(['workspaceId', 'cursor', 'since', 'limit', 'audience_npub'])
    );
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/event-subscription-agents'].put.description).toContain('event_subscription.manage');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/events/stream'].get.description).toContain('revalidates');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/events/stream'].get.description).toContain('transport-only token');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/events/stream'].get.parameters.map((param: any) => param.name)).toContain('token');
    expect(body.components.securitySchemes.nip98.description).toContain('complete canonical request URL');
    expect(body.components.securitySchemes.nip98.description).toContain('exact query parameters and their order');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/events'].get.description).toContain('stable event_id/cursor');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/tasks'].post.description).toContain('metadata.mentions');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}'].patch.description).toContain('previous/current mention arrays');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}'].patch.description).toContain('document_mention_added');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}/comments'].post.description).toContain('parent_comment_id');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/invocations'].post.description).toContain('full_document_review_requested');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/comments'].post.description).toContain('signer provenance');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/assignments'].post.description).toContain('absent-to-present');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/sync'].get.parameters.map((param: any) => param.name)).toEqual(
      ['workspaceId', 'cursor', 'limit']
    );
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/tree'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.drive.tree']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/tree'].get.parameters.map((param: any) => param.name)).toEqual(
      expect.arrayContaining(['workspaceId', 'scope_id', 'channel_id', 'parent_folder_id', 'cursor', 'limit'])
    );
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/delta'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.drive.delta']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/delta'].get.parameters.map((param: any) => param.name)).toEqual(
      expect.arrayContaining(['workspaceId', 'cursor', 'since', 'scope_id', 'channel_id', 'limit'])
    );
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}/versions'].post['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.files.versions.create']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}/versions'].get['x-flightdeck-pg-contract-fixture']).toBe(flightDeckPgContractFixturePaths['flightdeck_pg.files.versions.list']);
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}/versions'].get.parameters.map((param: any) => param.name)).toEqual(
      ['workspaceId', 'fileId', 'limit'],
    );
    const flightDeckPgTaskOperations = [
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/events', method: 'get', errors: ['400', '401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/sync', method: 'get', errors: ['400', '401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/tree', method: 'get', errors: ['400', '401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/delta', method: 'get', errors: ['400', '401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}/versions', method: 'post', errors: ['400', '401', '403', '404', '409'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}/versions', method: 'get', errors: ['401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/tasks', method: 'get', errors: ['401', '403'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/tasks', method: 'post', errors: ['400', '401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}/tasks', method: 'get', errors: ['401', '403'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}', method: 'get', errors: ['401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}', method: 'patch', errors: ['400', '401', '403', '404', '409'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/state', method: 'post', errors: ['400', '401', '403', '404', '409'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/comments', method: 'get', errors: ['401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/comments', method: 'post', errors: ['400', '401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/assignments', method: 'post', errors: ['400', '401', '403', '404'] },
      { path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/assignments/{actorId}', method: 'delete', errors: ['401', '403', '404'] },
    ];
    for (const { path, method, errors } of flightDeckPgTaskOperations) {
      const operation = body.paths[path]?.[method];
      expect(operation).toBeDefined();
      expect(operation.tags).toContain('Flight Deck PG');
      expect(operation.security).toEqual([{ nip98: [] }]);
      for (const status of errors) {
        expect(operation.responses[status]?.content?.['application/json']?.schema?.$ref).toBe('#/components/schemas/ErrorResponse');
      }
    }
    expect(body['x-flightdeck-pg-contract-fixtures']).toEqual(flightDeckPgContractFixturePaths);
    expect(body.paths['/api/v4/graph/search']).toBeDefined();
    expect(body.paths['/api/v4/graph/repository-checkpoints'].get.parameters.map((param: any) => param.name)).toEqual(
      ['source', 'workspace_owner_npub', 'visibility', 'owner_npub', 'actor_npub', 'agent_npub', 'source_app_npub', 'group_id', 'corpus_id', 'repository_id', 'limit'],
    );
    expect(body.paths['/api/v4/graph/repository-checkpoints'].get.parameters[0].required).toBe(true);
    expect(body.paths['/api/v4/graph/repository-checkpoints'].get.responses['200'].content['application/json'].schema.properties.checkpoints.items.$ref)
      .toBe('#/components/schemas/GraphRepositoryCheckpoint');
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/search']?.get.parameters.map((param: any) => param.name)).toEqual(
      ['workspaceId', 'q', 'scope_id', 'mode', 'limit'],
    );
    expect(body.paths['/api/v4/graph/search'].get.parameters.map((param: any) => param.name)).toEqual(
      expect.arrayContaining(['q', 'workspace_owner_npub', 'visibility', 'actor_npub', 'agent_npub', 'source_app_npub', 'source', 'label', 'relationship_type', 'limit'])
    );
    expect(body.paths['/api/v4/groups'].get.parameters[0].name).toBe('npub');
    expect(body.paths['/api/v4/records'].get.parameters.map((param: any) => param.name)).toEqual(
      expect.arrayContaining(['owner_npub', 'viewer_npub', 'record_family_hash', 'since', 'limit', 'offset'])
    );
    expect(body.paths['/api/v4/records/sync'].post.parameters.map((param: any) => param.name)).toEqual(
      expect.arrayContaining(['x-superbased-strict-group-id-writes', 'x-superbased-identity-strict'])
    );
    expect(body.components.schemas.WrappedKeyEntry.required).toContain('name');
    expect(body.components.schemas.HealthResponse.properties.tower_name).toBeUndefined();
    expect(body.components.schemas.HealthResponse.properties.tower_description).toBeUndefined();
    expect(body.components.schemas.HealthResponse.required).toContain('build');
    expect(body.components.schemas.HealthResponse.properties.build.$ref).toBe('#/components/schemas/TowerBuildInfo');
    expect(body.components.schemas.TowerBuildInfo.required).toEqual(
      ['name', 'version', 'git_commit', 'git_branch', 'build_time', 'runtime']
    );
    expect(body.components.schemas.FetchRecordsResponse.required).toContain('audit');
    expect(body.components.schemas.SyncRequest.properties.workspace_service_npub).toBeDefined();
    expect(body.components.schemas.SyncRequest.properties.strict_group_id_writes).toBeDefined();
    expect(body.components.schemas.SyncRecordInput.properties.workspace_service_npub).toBeDefined();
    expect(body.components.schemas.SyncRecordInput.properties.write_group_npub.deprecated).toBe(true);
    expect(body.components.schemas.SyncRecordInput.properties.checkout).toBeDefined();
    expect(body.components.schemas.SyncRecordInput.properties.checkout.description).toContain('checkout_required');
    expect(body.components.schemas.SyncRecordInput.properties.checkout.description).toContain('optimistic_write');
    expect(body.components.schemas.SyncResponse.required).toContain('warnings');
    expect(body.components.schemas.SyncRejectedRecord.properties.code.enum).toContain('checkout_missing');
    expect(body.components.schemas.SyncWarning.properties.code.enum).toContain('legacy_write_group_npub');
    expect(body.components.schemas.AcquireCheckoutRequest.properties.workspace_service_npub).toBeDefined();
    expect(body.components.schemas.AcquireCheckoutRequest.properties.ws_key_npub).toBeUndefined();
    expect(body.components.schemas.AcquireCheckoutRequest.properties.idempotency_key.format).toBe('uuid');
    expect(body.components.schemas.AcquireCheckoutRequest.required).toEqual(
      expect.arrayContaining(['workspace_service_npub', 'user_npub', 'workspace_user_key_npub', 'record_family_hash'])
    );
    expect(body.paths['/api/v4/records/sync'].post.description).toContain('checkout_required');
    expect(body.paths['/api/v4/records/sync'].post.description).toContain('signature_npub');
    expect(body.paths['/api/v4/records/{record_id}/checkout/acquire'].post.description).toContain('checkout_required');
    expect(body.paths['/api/v4/records/{record_id}/checkout/release'].post.description).toContain('canonical delegated clients');
    expect(body.paths['/api/v4/records/{record_id}/checkout/renew'].post.description).toContain('canonical delegated clients');
    expect(body.components.schemas.RecordCheckoutState.properties.checked_out_by_workspace_user_key_npub).toBeDefined();
    expect(body.components.schemas.RegisterWorkspaceKeyRequest.properties.workspace_user_key_npub).toBeDefined();
    expect(body.components.schemas.WorkspaceKeyMappingsResponse.required).toContain('mappings');
    expect(body.components.schemas.RecordsAuditInfo.required).toContain('workspace_service_npub');
    expect(body.components.schemas.RecordsAuditInfo.required).toContain('workspace_user_key_npub');
    expect(body.components.schemas.BillingStatus.properties.billing_state.enum).toContain('read_only_grace');
    expect(body.components.schemas.WorkspaceUsage.required).toContain('estimated_credits_per_hour');
    expect(body.components.schemas.WorkspaceAppSchemaManifest.required).toContain('group_payloads');
    expect(body.components.schemas.PublishWorkspaceAppSchemaRequest.required).toContain('owner_payload');
    expect(body.components.schemas.WorkspaceAppDbRow.properties.visibility.enum).toEqual(['private', 'group', 'workspace']);
    expect(body.components.schemas.GraphSearchResponse.required).toEqual(['query', 'results', 'total', 'limit']);
    expect(body.components.schemas.GraphSearchResult.properties.kind.enum).toEqual(['node', 'edge', 'memory']);
    expect(body.components.schemas.GraphRepositoryDeltaRequest.description).toContain('another repository in the same corpus');
    const wappActivityItemAuthority = body.components.schemas.WappActivityItem.allOf[1];
    expect(wappActivityItemAuthority.required).toEqual(expect.arrayContaining(['source_status', 'open_url_allowed']));
    expect(wappActivityItemAuthority.properties.source_status.enum).toEqual(['active', 'disabled', 'revoked']);
    expect(wappActivityItemAuthority.properties.open_url_allowed.type).toBe('boolean');
    expect(wappActivityItemAuthority.properties.registered_open_origins).toBeUndefined();
    expect(body.paths['/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-activity/items/{itemId}'].get.responses['200'].content['application/json'].schema.properties.item.$ref).toBe('#/components/schemas/WappActivityItem');
    const gitRepositories = body.paths['/api/v4/git/workspaces/{workspaceId}/repositories'];
    expect(gitRepositories.post.security).toEqual([{ nip98: [] }]);
    expect(gitRepositories.get.security).toEqual([{ nip98: [] }]);
    expect(body.paths['/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}'].get).toBeDefined();
    expect(body.paths['/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/grants'].post.requestBody.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/CreateGitRepositoryGrantRequest');
    expect(body.paths['/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/policy'].patch.description).toContain('service-managed');
    expect(body.paths['/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/audit-events'].get.description).toContain('Capability plaintext');
    expect(body.paths['/api/v4/git/credential-exchanges'].post.description).toContain('60-second');
    expect(body.paths['/api/v4/git/credential-exchanges'].post.responses['201'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/GitCredentialExchangeResponse');
    expect(body.paths['/api/v4/git/internal/capabilities/introspect'].post.security).toEqual([{ gitInternalService: [] }]);
    expect(body.paths['/api/v4/git/internal/capabilities/revoke'].post.security).toEqual([{ gitInternalService: [] }]);
    expect(body.components.schemas.GitCredentialExchangeResponse.properties.capability.writeOnly).toBe(true);
    expect(body.components.schemas.GitAuditEvent.properties.capability).toBeUndefined();
    expect(body.components.securitySchemes.gitInternalService.name).toBe('x-wingman-git-service-token');
  });

  test('Flight Deck PG contract fixtures are parseable and linked', async () => {
    const fixtureDir = join(import.meta.dir, '..', 'fixtures', 'flightdeck-pg');
    const fixtureFiles = readdirSync(fixtureDir).filter((file) => file.endsWith('.json') && file !== 'manifest.json');
    const fixtures = fixtureFiles.map((file) => JSON.parse(readFileSync(join(fixtureDir, file), 'utf8')) as FlightDeckPgContractFixture);
    const fixturesByName = new Map(fixtures.map((fixture) => [fixture.contract_name, fixture]));
    const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8')) as { contracts: Record<string, string> };

    expect(new Set(fixturesByName.keys())).toEqual(new Set(flightDeckPgContractNames));
    expect(manifest.contracts).toEqual(flightDeckPgContractFixturePaths);

    for (const contractName of flightDeckPgContractNames) {
      const fixture = fixturesByName.get(contractName);
      expect(fixture).toBeDefined();
      expect(fixture!.fixture_version).toBe(1);
      expect(fixture!.route).toStartWith('/api/v4/');
      expect(['GET', 'POST', 'PATCH', 'DELETE']).toContain(fixture!.method);
      expect(fixture!.required_nip98_actor).toBeTruthy();
      expect(fixture!.required_app_npub).toBeTruthy();
      expect(Array.isArray(fixture!.required_permissions)).toBe(true);
      expect(fixture!.response_shape).toBeDefined();
      expect(fixture!.example.response).toBeDefined();
      expect(fixture!.stable_identity_fields).toEqual([
        'tower_service_npub',
        'workspace_service_npub',
        'workspace_owner_npub',
        'workspace_id',
        'app_npub',
      ]);
      expect((fixture!.example.response.identity as Record<string, unknown>).tower_service_npub).toBeDefined();
      expect((fixture!.example.response.identity as Record<string, unknown>).workspace_service_npub).toBeDefined();
      expect((fixture!.example.response.identity as Record<string, unknown>).app_npub).toBe(fixture!.required_app_npub);
      expect(Object.values(flightDeckPgContractFixturePaths)).toContain(`fixtures/flightdeck-pg/${fixtureFiles.find((file) => fixturesByName.get(contractName) === fixture)}`);
    }
  });

  test('GET /docs exposes a docs page', async () => {
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('SwaggerUIBundle');
    expect(html).toContain('/openapi.json');
  });

  test('GET /ui exposes the Tower-hosted dashboard shell', async () => {
    const res = await app.request('/ui');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('Superbased Tower');
    expect(html).toContain('/api/v4/billing/workspaces');
    expect(html).toContain('/records/metadata');
    expect(html).toContain('/records/families');
    expect(html).toContain('/storage/metadata');
    expect(html).toContain('Total record storage');
    expect(html).toContain('Total S3/object storage');
    expect(html).toContain('Observed App Spaces');
    expect(html).toContain('/app-schemas');
    expect(html).toContain('Schema manifest');
  });
});
