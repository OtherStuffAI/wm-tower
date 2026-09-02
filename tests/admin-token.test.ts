import { describe, expect, test } from 'bun:test';
import { buildAdminAgentConnectPackage, buildSuperBasedConnectionToken } from '../src/admin-token';

function decodeToken(token: string) {
  return JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
}

describe('admin connection token helpers', () => {
  test('buildSuperBasedConnectionToken emits a Yoke-compatible token', () => {
    const token = buildSuperBasedConnectionToken({
      directHttpsUrl: 'https://tower.example.invalid',
      serviceNpub: 'npub1service',
      towerName: 'Other Stuff Tower',
      towerDescription: 'Shared tower for the family workspace',
      workspaceOwnerNpub: 'npub1workspace',
      appNpub: 'npub1app',
      relayUrls: ['wss://nos.lol'],
    });

    expect(decodeToken(token)).toEqual({
      type: 'superbased_connection',
      version: 2,
      direct_https_url: 'https://tower.example.invalid',
      service_npub: 'npub1service',
      tower_name: 'Other Stuff Tower',
      tower_description: 'Shared tower for the family workspace',
      workspace_owner_npub: 'npub1workspace',
      app_npub: 'npub1app',
      relay: 'wss://nos.lol',
    });
  });

  test('buildAdminAgentConnectPackage wraps the connection token', () => {
    const pkg = buildAdminAgentConnectPackage({
      directHttpsUrl: 'https://tower.example.invalid',
      serviceNpub: 'npub1service',
      towerName: 'Other Stuff Tower',
      towerDescription: 'Shared tower for the family workspace',
      workspaceOwnerNpub: 'npub1workspace',
      appNpub: 'npub1app',
    });

    expect(pkg.kind).toBe('coworker_agent_connect');
    expect(pkg.app.app_npub).toBe('npub1app');
    expect(pkg.workspace.owner_npub).toBe('npub1workspace');
    expect(pkg.service.name).toBe('Other Stuff Tower');
    expect(pkg.service.description).toBe('Shared tower for the family workspace');
    expect(decodeToken(pkg.connection_token).app_npub).toBe('npub1app');
  });
});
