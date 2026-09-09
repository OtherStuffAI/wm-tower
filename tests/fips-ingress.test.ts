import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { createFipsIngressFetch, readFipsIngressConfig, startFipsIngress } from '../src/fips-ingress';
import { getEffectiveRequestUrl, verifyNip98Auth } from '../src/auth';
import { createApp } from '../src/server';

// Ephemeral test identity only. Operational/live signing must use the broker.
const testKey = generateSecretKey();
const nodeNpub = nip19.npubEncode(getPublicKey(testKey));
const env = {
  TOWER_FIPS_ENABLED: 'true', TOWER_FIPS_NODE_NPUB: nodeNpub,
  TOWER_FIPS_MESH_ADDRESS: 'fd12:3456::1234', TOWER_FIPS_PORT: '43100',
};
const config = readFipsIngressConfig(env)!;
const host = new URL(config.origin).host;
function request(path: string, headers: Record<string, string> = {}, body?: string) {
  return new Request(`http://[${config.meshAddress}]:${config.port}${path}`, {
    headers: { host, ...headers }, method: body === undefined ? 'GET' : 'POST', body,
  });
}
function auth(url: string, body?: string) {
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
    tags: [['u', url], ['method', body === undefined ? 'GET' : 'POST'],
      ...(body === undefined ? [] : [['payload', createHash('sha256').update(body).digest('hex')]])],
  }, testKey);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

describe('explicit FIPS endpoint', () => {
  test('disabled by default; validates complete public settings', () => {
    expect(readFipsIngressConfig({})).toBeNull();
    expect(config.origin).toBe(`http://${nodeNpub}.fips:43100`);
    for (const override of [
      { TOWER_FIPS_ENABLED: 'yes' }, { TOWER_FIPS_NODE_NPUB: `${nodeNpub.slice(0, -1)}x` },
      { TOWER_FIPS_NODE_NPUB: nodeNpub.toUpperCase() }, { TOWER_FIPS_NODE_NPUB: `${nodeNpub}.fips` },
      ...['::', '::1', '127.0.0.1', 'fe80::1', '2001:db8::1', 'fd12::1%en0', '[fd12::1]', ''].map(TOWER_FIPS_MESH_ADDRESS => ({ TOWER_FIPS_MESH_ADDRESS })),
      ...['', '0', '65536', '-1', '43100x', '4.5', '043100'].map(TOWER_FIPS_PORT => ({ TOWER_FIPS_PORT })),
    ]) expect(() => readFipsIngressConfig({ ...env, ...override })).toThrow();
  });
  test('binds only exact configured address and port; failure leaves the app usable', async () => {
    const app = createApp();
    let options: any;
    const logs: string[] = [];
    expect(startFipsIngress(app.fetch, env, (input) => {
      options = input; return { stop() {} };
    }, message => logs.push(message)).status).toBe('listening');
    expect(options.hostname).toBe(env.TOWER_FIPS_MESH_ADDRESS);
    expect(options.port).toBe(43100);
    expect(options.idleTimeout).toBe(0);
    expect(startFipsIngress(app.fetch, env, () => { throw new Error('EADDRNOTAVAIL'); }, message => logs.push(message)).status).toBe('unavailable');
    expect((await app.request('/health')).status).toBe(200);
    expect(startFipsIngress(app.fetch, { ...env, TOWER_FIPS_NODE_NPUB: 'secret-input' }, () => { throw new Error(); }, message => logs.push(message)).status).toBe('unavailable');
    expect(logs.join(' ')).not.toContain('secret-input');
  });
});

describe('fixed mesh request boundary', () => {
  test('rejects arbitrary and missing Host before app dispatch', async () => {
    const fetch = createFipsIngressFetch(config, () => { throw new Error('must not dispatch'); });
    for (const host of ['evil.example', `${nodeNpub}.fips:43101`, `${nodeNpub}.fips:43100,evil.example`, '']) {
      expect((await fetch(request('/health', { host }))).status).toBe(421);
    }
    expect((await fetch(new Request(`${config.origin}/health`))).status).toBe(421);
  });
  test('strips forwarding hints and preserves exact endpoint/path/query, Origin and auth', async () => {
    const fetch = createFipsIngressFetch(config, req => {
      expect(getEffectiveRequestUrl(req).href).toBe(`${config.origin}//evil.example/path?a=%2F&b=2`);
      expect(req.headers.get('origin')).toBe('https://flightdeck.example');
      expect(req.headers.get('authorization')).toBe('Nostr untouched');
      for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'cf-visitor', 'x-original-url', 'x-real-ip']) expect(req.headers.has(name)).toBe(false);
      return new Response('ok');
    });
    await fetch(request('//evil.example/path?a=%2F&b=2', {
      forwarded: 'host=evil.example;proto=https', 'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https', 'cf-visitor': '{"scheme":"https"}',
      'x-original-url': 'https://evil.example', 'x-real-ip': '127.0.0.1',
      origin: 'https://flightdeck.example', authorization: 'Nostr untouched',
    }));
  });
  test('NIP98 verifies mesh URL and body; public URL forwarding attack fails', async () => {
    const fetch = createFipsIngressFetch(config, async req => new Response('', { status: await verifyNip98Auth(req) ? 200 : 401 }));
    const path = '/api/v4/records/sync?cursor=one&limit=2';
    const body = '{"hello":"mesh"}';
    expect((await fetch(request(path, { authorization: auth(config.origin + path, body) }, body))).status).toBe(200);
    for (const signedUrl of ['https://tower.example' + path, config.origin + path.replace('one', 'two')]) {
      expect((await fetch(request(path, { authorization: auth(signedUrl, body), 'x-forwarded-host': 'tower.example', 'x-forwarded-proto': 'https' }, body))).status).toBe(401);
    }
    expect((await fetch(request(path, { authorization: auth(config.origin + path, body) }, body + ' '))).status).toBe(401);
  });
  test('same Tower health, CORS and protected route rejection without database access', async () => {
    const app = createApp();
    const fetch = createFipsIngressFetch(config, app.fetch);
    const health = await fetch(request('/health', { origin: 'https://flightdeck.example' }));
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
    expect(health.headers.get('access-control-allow-credentials')).toBeNull();
    for (const path of ['/api/v4/user/workspace-key-mappings', '/api/v4/storage/prepare']) {
      expect((await fetch(request(path, {}, path.endsWith('prepare') ? '{}' : undefined))).status).toBe(401);
    }
    expect((await app.request('/api/v4/user/workspace-key-mappings')).status).toBe(401);
  });
  test('passes response streams, storage URLs and cancellation without buffering or rewriting', async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: ready\n\n')); } }), {
      headers: { 'content-type': 'text/event-stream', location: 'https://s3.example/object', 'set-cookie': 'session=x; Secure; SameSite=None' },
    });
    let received: Request;
    const fetch = createFipsIngressFetch(config, req => { received = req; return response; });
    const result = await fetch(new Request(config.origin + '/events', { headers: { host, 'last-event-id': '42' }, signal: controller.signal }));
    expect(result).toBe(response);
    expect(received!.headers.get('last-event-id')).toBe('42');
    controller.abort();
    expect(received!.signal.aborted).toBe(true);
    expect(result.headers.get('location')).toBe('https://s3.example/object');
    expect(result.headers.get('set-cookie')).toContain('Secure');
    await result.body!.cancel();
  });
});
