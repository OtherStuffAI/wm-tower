import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '../src/config';
import { buildOpenApiDocument } from '../src/openapi';
import { createApp } from '../src/server';
import { buildNstackServiceDiscovery, resetNstackHealthCacheForTest } from '../src/services/nstack-discovery';

const original = structuredClone(config.nstack);

afterEach(() => {
  Object.assign(config.nstack, structuredClone(original));
  resetNstackHealthCacheForTest();
});

function runtimeConfig() {
  const runtime = structuredClone(config);
  runtime.directHttpsUrl = 'https://tower.example.test';
  runtime.service.npub = 'npub1publicserviceidentity';
  runtime.tower.name = 'Example Nstack';
  runtime.nstack.descriptorCacheTtlSeconds = 30;
  return runtime;
}

describe('Nstack service discovery v1', () => {
  test('reports only explicitly configured services and truthful enabled features', async () => {
    const runtime = runtimeConfig();
    runtime.nstack.relay = { enabled: true, publicOrigin: 'wss://relay.example.test', healthUrl: 'http://relay:8080/', version: '0.10.0' };
    runtime.nstack.blossom = {
      enabled: true, publicOrigin: 'https://blossom.example.test', healthUrl: 'http://blossom:3000/', version: '6.4.1',
      mediaEnabled: false, listEnabled: true, mirrorEnabled: true, reportEnabled: false,
    };
    const requested: string[] = [];
    const descriptor = await buildNstackServiceDiscovery({
      config: runtime,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
      fetchImpl: (async (url: string | URL | Request) => { requested.push(String(url)); return new Response('ok'); }) as typeof fetch,
    });

    expect(descriptor.schema).toBe('org.wingman.nstack.services');
    expect(descriptor.schema_version).toBe(1);
    expect(descriptor.services.map((service) => service.id)).toEqual(['tower', 'relay', 'blossom']);
    expect(requested).toEqual(['http://relay:8080/', 'http://blossom:3000/']);
    const blossom = descriptor.services.find((service) => service.id === 'blossom')!;
    expect(blossom.features.buds).toEqual([1, 2, 4, 6, 8, 11, 12]);
    expect(blossom.capabilities).toContain('blob.list');
    expect(blossom.capabilities).not.toContain('blob.media');
    expect(blossom.capabilities).not.toContain('blob.report');
    expect(blossom.availability.status).toBe('available');
  });

  test('omits disabled, malformed, credentialed and non-root public origins', async () => {
    const runtime = runtimeConfig();
    runtime.nstack.relay = { enabled: true, publicOrigin: 'https://not-a-websocket.example.test', healthUrl: '', version: '0.10.0' };
    runtime.nstack.blossom = {
      enabled: true, publicOrigin: 'https://user:secret@blossom.example.test/private', healthUrl: '', version: '6.4.1',
      mediaEnabled: true, listEnabled: true, mirrorEnabled: true, reportEnabled: true,
    };
    const descriptor = await buildNstackServiceDiscovery({ config: runtime });
    expect(descriptor.services.map((service) => service.id)).toEqual(['tower']);

    runtime.nstack.relay.enabled = false;
    runtime.nstack.relay.publicOrigin = 'wss://relay.example.test';
    runtime.nstack.blossom.enabled = false;
    runtime.nstack.blossom.publicOrigin = 'https://blossom.example.test';
    expect((await buildNstackServiceDiscovery({ config: runtime })).services.map((service) => service.id)).toEqual(['tower']);
  });

  test('uses deterministic partial availability without exposing health topology', async () => {
    const runtime = runtimeConfig();
    runtime.nstack.relay = { enabled: true, publicOrigin: 'wss://relay.example.test', healthUrl: 'http://relay:8080/operator/health', version: '0.10.0' };
    runtime.nstack.blossom.enabled = false;
    const descriptor = await buildNstackServiceDiscovery({
      config: runtime,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
      fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
    });
    const encoded = JSON.stringify(descriptor);
    expect(descriptor.services.find((service) => service.id === 'relay')?.availability).toEqual({
      status: 'unavailable', checked_at: '2026-10-19T00:00:00.000Z',
    });
    expect(encoded).not.toContain('http://relay:8080');
    expect(encoded).not.toContain('token');
    expect(encoded).not.toContain('secret');
    expect(encoded).not.toContain('signed_event');
  });

  test('route ignores hostile forwarding headers and publishes cache semantics', async () => {
    config.nstack.relay.enabled = true;
    config.nstack.relay.publicOrigin = 'wss://relay.example.test';
    config.nstack.relay.healthUrl = '';
    config.nstack.blossom.enabled = true;
    config.nstack.blossom.publicOrigin = 'https://blossom.example.test';
    config.nstack.blossom.healthUrl = '';
    const response = await createApp().request('http://localhost/.well-known/nstack.json', {
      headers: { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=30, stale-if-error=60');
    const body = await response.json();
    expect(body.services.find((service: any) => service.id === 'relay').endpoint).toBe('wss://relay.example.test');
    expect(body.services.find((service: any) => service.id === 'blossom').endpoint).toBe('https://blossom.example.test');
    expect(JSON.stringify(body)).not.toContain('evil.example');
    expect(body).not.toHaveProperty('workspaces');
    expect(body).not.toHaveProperty('users');
  });

  test('OpenAPI publishes the canonical unauthenticated contract', () => {
    const api = buildOpenApiDocument('https://tower.example.test');
    expect(api.paths['/.well-known/nstack.json'].get.security).toEqual([]);
    expect(api.components.schemas.NstackServiceDiscoveryV1.properties.schema_version.const).toBe(1);
  });
});
