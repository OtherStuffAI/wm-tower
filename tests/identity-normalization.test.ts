import { describe, expect, test } from 'bun:test';
import {
  IdentityNormalizationError,
  normalizeWorkspaceServiceNpub,
  normalizeWorkspaceUserKeyNpub,
} from '../src/identity-normalization';

describe('identity normalization helpers', () => {
  test('normalizes workspace service aliases to explicit canonical names', () => {
    expect(normalizeWorkspaceServiceNpub({ owner_npub: 'npub-owner' })).toBe('npub-owner');
    expect(normalizeWorkspaceServiceNpub({ workspace_service_npub: 'npub-service' })).toBe('npub-service');
    expect(normalizeWorkspaceServiceNpub({
      owner_npub: 'npub-service',
      workspace_service_npub: 'npub-service',
    })).toBe('npub-service');
  });

  test('rejects mismatched workspace service aliases clearly', () => {
    expect(() => normalizeWorkspaceServiceNpub({
      owner_npub: 'npub-owner',
      workspace_service_npub: 'npub-service',
    })).toThrow(IdentityNormalizationError);
  });

  test('normalizes workspace user key aliases to explicit canonical names', () => {
    expect(normalizeWorkspaceUserKeyNpub({ ws_key_npub: 'npub-ws-key' })).toBe('npub-ws-key');
    expect(normalizeWorkspaceUserKeyNpub({ workspace_user_key_npub: 'npub-workspace-user-key' })).toBe('npub-workspace-user-key');
    expect(normalizeWorkspaceUserKeyNpub({
      ws_key_npub: 'npub-workspace-user-key',
      workspace_user_key_npub: 'npub-workspace-user-key',
    })).toBe('npub-workspace-user-key');
  });

  test('rejects mismatched workspace user key aliases clearly', () => {
    expect(() => normalizeWorkspaceUserKeyNpub({
      ws_key_npub: 'npub-ws-key',
      workspace_user_key_npub: 'npub-workspace-user-key',
    })).toThrow(IdentityNormalizationError);
  });
});
