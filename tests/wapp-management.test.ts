import { describe, expect, test } from 'bun:test';
import { buildOpenApiDocument } from '../src/openapi';
import { WappManagementError, claimInstallIntent, evaluateWappManagement, normalizeInstallIntent, normalizeWappManagementFilters } from '../src/services/wapp-management';

describe('delegated WApp management contract', () => {
  test('maps only exact HTTPS origins and activity.publish', () => {
    expect(normalizeWappManagementFilters({
      open_origins: ['https://wapp.agent.example.invalid'],
      capabilities: ['activity.publish'],
      channel_ids: ['sample-wapp-feed'],
    })).toMatchObject({ open_origins: ['https://wapp.agent.example.invalid'], capabilities: ['activity.publish'] });
    for (const origin of ['http://wapp.agent.example.invalid', 'https://wapp.agent.example.invalid/path', 'https://user@example.invalid']) {
      expect(() => normalizeWappManagementFilters({ open_origins: [origin] })).toThrow(WappManagementError);
    }
    expect(() => normalizeWappManagementFilters({ capabilities: ['channel.write'] })).toThrow(/activity.publish/);
  });

  test('acceptance fixture request stays Feed-only and does not model messages', () => {
    const request = normalizeInstallIntent({
      client_request_id: 'sample-wapp-1', app_id: 'sample-wapp', app_version: '1',
      wapp_installation_id: '00000000-0000-4000-8000-000000000001', title: 'Sample WApp',
      launch_url: 'https://wapp.agent.example.invalid/?story=one',
      autopilot_origin: 'https://wapp.agent.example.invalid',
      autopilot_npub: 'npub1autopilot',
      registered_open_origins: ['https://wapp.agent.example.invalid'],
      capabilities: ['activity.publish'], destinations: [{ scope_id: 'scope', channel_id: 'feed' }],
    });
    expect(request.capabilities).toEqual(['activity.publish']);
    expect(request).not.toHaveProperty('message');
    expect(request).not.toHaveProperty('channel.write');
  });

  test('template creation is cleanly step-up protected in v1', () => {
    expect(() => normalizeInstallIntent({ template_id: 'new-template' })).toThrow(/unsupported in v1/);
  });

  test('an installation intent is bound to one explicit Autopilot identity', () => {
    expect(() => normalizeInstallIntent({
      client_request_id: 'missing-identity', app_id: 'book', app_version: '1', title: 'Book',
      launch_url: 'https://book.example.invalid', autopilot_origin: 'https://autopilot.example.invalid',
      registered_open_origins: ['https://book.example.invalid'], capabilities: ['activity.publish'], destinations: [],
    })).toThrow(/autopilot_npub is required/);
  });

  test('claim is compare-and-set, identity-bound, and replay-safe', async () => {
    let pending = true;
    const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      const signer = values.includes('npub1autopilot') ? 'npub1autopilot' : values.includes('npub1wrong') ? 'npub1wrong' : null;
      const version = values.includes(7) ? 7 : values.includes(6) ? 6 : null;
      if (!pending || signer !== 'npub1autopilot' || version !== 7) return Promise.resolve([]);
      pending = false;
      return Promise.resolve([{ id: 'intent', status: 'claimed', intent_version: 8, claimed_by_npub: signer }]);
    }) as any;
    sql.json = (value: unknown) => value;
    const input = { workspaceId: 'workspace', id: 'intent', signerNpub: 'npub1autopilot', challenge: 'once', intentVersion: 7, observed: {} };
    await expect(claimInstallIntent(input, sql)).resolves.toMatchObject({ status: 'claimed', intent_version: 8 });
    await expect(claimInstallIntent(input, sql)).rejects.toMatchObject({ code: 'intent_not_claimable' });
    pending = true;
    await expect(claimInstallIntent({ ...input, signerNpub: 'npub1wrong' }, sql)).rejects.toMatchObject({ code: 'intent_not_claimable' });
    await expect(claimInstallIntent({ ...input, intentVersion: 6 }, sql)).rejects.toMatchObject({ code: 'intent_not_claimable' });
  });

  test('Sample WApp filters reject sibling origins, other destinations, and channel authority', async () => {
    const row = { id: 'delegation', filters: { installation_ids: ['00000000-0000-4000-8000-000000000001'], app_ids: ['sample-wapp'], scope_ids: ['scope'], channel_ids: ['feed'], capabilities: ['activity.publish'], open_origins: ['https://wapp.agent.example.invalid'], autopilot_origins: ['https://wapp.agent.example.invalid'] }, valid_from: new Date(), expires_at: new Date(Date.now()+60_000), revoked_at: null, created_at: new Date(), updated_at: new Date() };
    const sql = (() => Promise.resolve([row])) as any;
    const base = { workspaceId: 'workspace', actorId: 'agent', ownerActorId: 'operator', request: { wapp_installation_id: '00000000-0000-4000-8000-000000000001', app_id: 'sample-wapp', scope_id: 'scope', destinations: [{ scope_id: 'scope', channel_id: 'feed' }], capabilities: ['activity.publish'], registered_open_origins: ['https://wapp.agent.example.invalid'], autopilot_origin: 'https://wapp.agent.example.invalid' } };
    await expect(evaluateWappManagement(base, sql)).resolves.toMatchObject({ owner: false });
    await expect(evaluateWappManagement({ ...base, request: { ...base.request, registered_open_origins: ['https://evil.wapp.agent.example.invalid'] } }, sql)).rejects.toMatchObject({ code: 'origin_not_allowed' });
    await expect(evaluateWappManagement({ ...base, request: { ...base.request, destinations: [{ scope_id: 'scope', channel_id: 'other' }] } }, sql)).rejects.toMatchObject({ code: 'destination_not_allowed' });
    await expect(evaluateWappManagement({ ...base, request: { ...base.request, capabilities: ['channel.write'] } }, sql)).rejects.toMatchObject({ code: 'resource_filter_denied' });
    const revokedSql = (() => Promise.resolve([{ ...row, revoked_at: new Date() }])) as any;
    await expect(evaluateWappManagement(base, revokedSql)).rejects.toMatchObject({ code: 'delegation_revoked' });
    const expiredSql = (() => Promise.resolve([{ ...row, expires_at: new Date(Date.now()-1) }])) as any;
    await expect(evaluateWappManagement(base, expiredSql)).rejects.toMatchObject({ code: 'delegation_expired' });
  });

  test('OpenAPI publishes delegation and saga routes', () => {
    const paths = buildOpenApiDocument('https://tower.example.invalid').paths as Record<string, unknown>;
    for (const path of [
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-delegations',
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-install-intents',
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-install-intents/{intentId}/claim',
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-install-intents/{intentId}/complete',
    ]) expect(paths[path]).toBeDefined();
  });
});
