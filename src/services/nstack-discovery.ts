import { config } from '../config';
import { getTowerBuildInfo } from '../build-info';
import type { NstackServiceAvailability, NstackServiceDescriptor, NstackServiceDiscoveryV1 } from '../types';

const DESCRIPTOR_SCHEMA = 'org.wingman.nstack.services' as const;
const HEALTH_TIMEOUT_MS = 1_500;

type DiscoveryConfig = typeof config;
type FetchLike = typeof fetch;
type HealthCacheEntry = { expiresAt: number; value: { status: NstackServiceAvailability; checked_at: string } };
const healthCache = new Map<string, HealthCacheEntry>();

function configuredPublicOrigin(value: string, kind: 'https' | 'wss'): string | null {
  try {
    if (!value) return null;
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const allowed = kind === 'https'
      ? (url.protocol === 'https:' || (local && url.protocol === 'http:'))
      : (url.protocol === 'wss:' || (local && url.protocol === 'ws:'));
    if (!allowed || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredHealthUrl(value: string): string | null {
  try {
    if (!value) return null;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function availability(
  cacheKey: string,
  healthUrl: string,
  ttlSeconds: number,
  fetchImpl: FetchLike,
  now: () => Date,
): Promise<{ status: NstackServiceAvailability; checked_at: string | null }> {
  const url = configuredHealthUrl(healthUrl);
  if (!url) return { status: 'unknown', checked_at: null };
  const nowMs = now().getTime();
  const cached = healthCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) return cached.value;
  const checked_at = new Date(nowMs).toISOString();
  let status: NstackServiceAvailability = 'unavailable';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: cacheKey === 'relay' ? 'application/nostr+json' : 'application/json, text/html;q=0.5' },
      signal: controller.signal,
    });
    status = response.ok ? 'available' : 'unavailable';
  } catch {
    status = 'unavailable';
  } finally {
    clearTimeout(timer);
  }
  const value = { status, checked_at };
  healthCache.set(cacheKey, { value, expiresAt: nowMs + ttlSeconds * 1_000 });
  return value;
}

export function resetNstackHealthCacheForTest() {
  healthCache.clear();
}

export async function buildNstackServiceDiscovery(
  input: {
    config?: DiscoveryConfig;
    fetchImpl?: FetchLike;
    now?: () => Date;
  } = {},
): Promise<NstackServiceDiscoveryV1> {
  const runtime = input.config ?? config;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const ttl = runtime.nstack.descriptorCacheTtlSeconds;
  const services: NstackServiceDescriptor[] = [];

  const towerOrigin = configuredPublicOrigin(runtime.directHttpsUrl, 'https');
  if (towerOrigin) {
    services.push({
      id: 'tower',
      kind: 'tower',
      endpoint: towerOrigin,
      version: getTowerBuildInfo().version || 'unknown',
      protocols: ['https', 'nip-98'],
      capabilities: ['workspace.authenticated_discovery', 'records.sync', 'storage.private', 'flightdeck.pg'],
      features: { nips: [98] },
      availability: { status: 'available', checked_at: now().toISOString() },
    });
  }

  const relayOrigin = runtime.nstack.relay.enabled
    ? configuredPublicOrigin(runtime.nstack.relay.publicOrigin, 'wss')
    : null;
  if (relayOrigin) {
    services.push({
      id: 'relay',
      kind: 'nostr_relay',
      endpoint: relayOrigin,
      version: runtime.nstack.relay.version,
      protocols: ['nostr-relay'],
      capabilities: ['events.publish', 'events.query', 'events.subscribe', 'events.persist'],
      features: { nips: [1, 2, 9, 11, 12, 15, 16, 20, 22, 33, 40, 42] },
      availability: await availability('relay', runtime.nstack.relay.healthUrl, ttl, fetchImpl, now),
    });
  }

  const blossomOrigin = runtime.nstack.blossom.enabled
    ? configuredPublicOrigin(runtime.nstack.blossom.publicOrigin, 'https')
    : null;
  if (blossomOrigin) {
    const buds = [1, 2, 6, 8, 11, 12];
    const capabilities = ['blob.get', 'blob.head', 'blob.upload', 'blob.delete'];
    if (runtime.nstack.blossom.listEnabled) capabilities.push('blob.list');
    if (runtime.nstack.blossom.mirrorEnabled) { buds.push(4); capabilities.push('blob.mirror'); }
    if (runtime.nstack.blossom.mediaEnabled) { buds.push(5); capabilities.push('blob.media'); }
    if (runtime.nstack.blossom.reportEnabled) { buds.push(9); capabilities.push('blob.report'); }
    buds.sort((a, b) => a - b);
    services.push({
      id: 'blossom',
      kind: 'blossom',
      endpoint: blossomOrigin,
      version: runtime.nstack.blossom.version,
      protocols: ['blossom'],
      capabilities,
      features: { buds },
      availability: await availability('blossom', runtime.nstack.blossom.healthUrl, ttl, fetchImpl, now),
    });
  }

  return {
    schema: DESCRIPTOR_SCHEMA,
    schema_version: 1,
    generated_at: now().toISOString(),
    cache_ttl_seconds: ttl,
    stack: { tower_npub: runtime.service.npub || null, name: runtime.tower.name },
    services,
  };
}
