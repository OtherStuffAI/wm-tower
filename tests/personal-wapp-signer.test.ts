import { describe, expect, test } from 'bun:test';
import {
  normalizeFlightDeckPgPersonalWappSignerMetadata,
  resolveFlightDeckPgPersonalWappOriginPolicy,
} from '../src/services/flightdeck-pg-api';
import { createApp } from '../src/server';

function wapp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wapp-1', workspace_id: 'workspace-1', owner_actor_id: 'actor-1', scope_id: null,
    channel_id: null, title: 'Trusted app', description: null,
    launch_url: 'https://trusted.example.invalid/app', icon_url: null, app_id: 'app-identity-1',
    wapp_id: 'assignment-1', source_wingman_url: null, sort_order: 0, status: 'active',
    metadata: { signer: { enabled: true, allowed_origins: ['https://trusted.example.invalid'] } },
    row_version: 1, created_by_actor_id: 'actor-1', updated_by_actor_id: 'actor-1',
    deleted_at: null, created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01'),
    ...overrides,
  } as any;
}

describe('Flight Deck PG personal WApp signer metadata', () => {
  test('origin-policy route requires NIP-98 authentication before revealing policy', async () => {
    const response = await createApp().request(
      '/api/v4/flightdeck-pg/workspaces/workspace-1/personal-wapps/origin-policy?origin=https%3A%2F%2Ftrusted.example.invalid',
    );
    expect(response.status).toBe(401);
  });

  test('normalizes a trusted signer profile for serialization and storage', () => {
    const result = normalizeFlightDeckPgPersonalWappSignerMetadata({
      launchUrl: 'https://example-wapp.agent.example.invalid/app',
      metadata: {
        signer: {
          enabled: true,
          allowed_origins: [
            'https://example-wapp.agent.example.invalid/app',
            'https://example-wapp.agent.example.invalid',
          ],
          allowed_nip98_target_origins: ['https://tower.example.invalid/api'],
        },
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.profile).toEqual({
      enabled: true,
      allowed_origins: ['https://example-wapp.agent.example.invalid'],
      allowed_nip98_target_origins: ['https://tower.example.invalid'],
      allowed_event_kinds: [27235],
      capabilities: ['nip98'],
      trust_version: 1,
    });
    expect(result.metadata.signer).toEqual(result.profile);
  });

  test('fails closed when signer metadata does not include launch origin', () => {
    const result = normalizeFlightDeckPgPersonalWappSignerMetadata({
      launchUrl: 'https://example-wapp.agent.example.invalid/app',
      metadata: {
        signer: {
          enabled: true,
          allowed_origins: ['https://different.example.invalid'],
        },
      },
    });

    expect(result.errors.map((error) => error.code)).toContain(
      'launch_origin_required',
    );
  });

  test('fails closed for malformed signer profile values', () => {
    const result = normalizeFlightDeckPgPersonalWappSignerMetadata({
      launchUrl: 'https://example-wapp.agent.example.invalid/app',
      metadata: {
        signer: {
          enabled: true,
          allowed_origins: ['file:///tmp/nope'],
          allowed_event_kinds: [1],
          capabilities: ['signEvent'],
          trust_version: 0,
        },
      },
    });

    expect(result.errors.map((error) => error.path)).toContain(
      'metadata.signer.allowed_origins.0',
    );
    expect(result.errors.map((error) => error.code)).toContain(
      'nip98_required',
    );
    expect(result.errors.map((error) => error.path)).toContain(
      'metadata.signer.trust_version',
    );
    expect(result.profile).toBeNull();
  });

  test('allows explicitly disabled signer profile without origins', () => {
    const result = normalizeFlightDeckPgPersonalWappSignerMetadata({
      launchUrl: 'https://example-wapp.agent.example.invalid/app',
      metadata: {
        signer: {
          enabled: false,
        },
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.profile).toEqual({
      enabled: false,
      allowed_origins: [],
      allowed_nip98_target_origins: [],
      allowed_event_kinds: [27235],
      capabilities: ['nip98'],
      trust_version: 1,
    });
  });

  test('returns Tower-owned WApp identity only for an exact trusted origin', () => {
    const result = resolveFlightDeckPgPersonalWappOriginPolicy('https://trusted.example.invalid/path', [wapp()]);
    expect(result.trusted).toBe(true);
    expect(result.origin).toBe('https://trusted.example.invalid');
    expect(result.personal_wapp?.app_id).toBe('app-identity-1');
    expect(result.personal_wapp?.wapp_id).toBe('assignment-1');
    expect(result.signer_profile?.allowed_event_kinds).toEqual([27235]);
  });

  test('fails closed for unregistered, disabled, archived, and ambiguous origins', () => {
    expect(resolveFlightDeckPgPersonalWappOriginPolicy('https://other.example.invalid', [wapp()]).reason).toBe('not_registered');
    expect(resolveFlightDeckPgPersonalWappOriginPolicy('https://trusted.example.invalid', [
      wapp({ metadata: { signer: { enabled: false } } }),
    ]).trusted).toBe(false);
    expect(resolveFlightDeckPgPersonalWappOriginPolicy('https://trusted.example.invalid', [
      wapp({ status: 'archived' }),
    ]).trusted).toBe(false);
    expect(resolveFlightDeckPgPersonalWappOriginPolicy('https://trusted.example.invalid', [
      wapp(), wapp({ id: 'wapp-2', app_id: 'app-identity-2' }),
    ]).reason).toBe('ambiguous_origin');
  });
});
