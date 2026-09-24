import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { createFipsHostGateway, startFipsHostGateway } from '../src/fips-host-gateway';
import { createFipsIngressFetch, FIPS_DOCKER_PORT, readFipsIngressConfig } from '../src/fips-ingress';
import { verifyNip98Auth } from '../src/auth';
import { renderFipsHostPlist } from '../scripts/fips-host-launchd';
import { renderTowerFipsPeerPlist } from '../scripts/fips-tower-peer-launchd';

const key = generateSecretKey(); // disposable test identity, no operational keys
const consumerKey = generateSecretKey();
const env = {
  TOWER_FIPS_ENABLED: 'true', TOWER_FIPS_INGRESS_MODE: 'docker',
  TOWER_FIPS_NODE_NPUB: nip19.npubEncode(getPublicKey(key)),
  TOWER_FIPS_CONSUMER_NPUB: nip19.npubEncode(getPublicKey(consumerKey)),
  TOWER_FIPS_MESH_ADDRESS: 'fd12:3456::1234', TOWER_FIPS_PORT: '43100',
};
const config = readFipsIngressConfig(env)!;
const host = new URL(config.origin).host;
function auth(url: string, body?: string) {
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
    tags: [['u', url], ['method', body === undefined ? 'GET' : 'POST'],
      ...(body === undefined ? [] : [['payload', createHash('sha256').update(body).digest('hex')]])],
  }, key);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

test('host launcher requires explicit native mesh binding and renders only public settings', async () => {
  await expect(startFipsHostGateway({})).rejects.toThrow();
  await expect(startFipsHostGateway({ ...env, TOWER_FIPS_MESH_ADDRESS: '0.0.0.0' })).rejects.toThrow();
  await expect(startFipsHostGateway(env, async () => ({ npub: env.TOWER_FIPS_CONSUMER_NPUB,
    ipv6_addr: env.TOWER_FIPS_MESH_ADDRESS, persistent: true, state: 'running', tun_state: 'active' }))).rejects.toThrow('does not match');
  const plist = renderFipsHostPlist({ ...env, SUPERBASED_SERVICE_NSEC: 'must-not-copy' }, '/bin/bun', '/repo/a&b');
  expect(plist).toContain('/repo/a&amp;b/src/fips-host-gateway.ts');
  expect(plist).toContain('<string>/var/empty</string>');
  expect(plist).not.toContain('must-not-copy');
  expect(plist).not.toContain('127.0.0.1:3100');
  expect(plist).toContain(env.TOWER_FIPS_CONSUMER_NPUB);
  expect(plist).toContain('/var/run/fips-tower.sock');
  const peerPlist = renderTowerFipsPeerPlist('/opt/fips&bin', '/etc/tower&peer/fips.yaml');
  expect(peerPlist).toContain('/opt/fips&amp;bin');
  expect(peerPlist).toContain('/etc/tower&amp;peer/fips.yaml');
});

test('real TCP gateway -> dedicated ingress preserves exact signed bytes, streams and fail-closed behavior', async () => {
  let dispatched = 0;
  let streamCancelled = false;
  let seenUrl = '';
  const ingress = Bun.serve({ hostname: '127.0.0.1', port: FIPS_DOCKER_PORT, idleTimeout: 0,
    fetch: createFipsIngressFetch(config, async req => {
      dispatched++;
      seenUrl = req.url;
      for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'cf-visitor', 'x-original-url']) {
        expect(req.headers.has(name)).toBe(false);
      }
      if (!await verifyNip98Auth(req)) return new Response('unauthorized', { status: 401 });
      if (new URL(req.url).pathname === '/events') {
        expect(req.headers.get('last-event-id')).toBe('42');
        req.signal.addEventListener('abort', () => { streamCancelled = true; });
        return new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('id: 43\ndata: ready 🪽\n\n')); },
          cancel() { streamCancelled = true; },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (new URL(req.url).pathname === '/redirect') return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:1/never-follow' } });
      return new Response(await req.text(), { status: 201, headers: { 'x-canonical-url': req.url } });
    }),
  });
  const gateway = createFipsHostGateway();
  // Test-only loopback substitutes for the host mesh interface. Production start
  // validates fd00::/8 and never permits this bind; destination remains fixed.
  gateway.server.listen({ host: '::1', port: 0, ipv6Only: true });
  await once(gateway.server, 'listening');
  const address = gateway.server.address() as { port: number };
  const base = `http://[::1]:${address.port}`;
  try {
    const path = '/exact%2Fpath?z=%2f&a=1&a=2';
    const body = JSON.stringify({ data: 'mesh 🪽', payload: 'x'.repeat(512 * 1024) });
    const signed = auth(config.origin + path, body);
    const result = await fetch(base + path, { method: 'POST', body, headers: {
      host, authorization: signed, forwarded: 'proto=https;host=evil.example',
      'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'cf-visitor': '{"scheme":"https"}',
      'x-original-url': 'http://evil.example',
    } });
    expect(seenUrl).toBe(config.origin + path);
    expect(result.status).toBe(201);
    expect(await result.text()).toBe(body);
    expect(seenUrl).toBe(config.origin + path);
    expect(result.headers.get('x-canonical-url')).toBe(config.origin + path);
    for (const wrong of ['evil.example', host.replace(':43100', ':43101')]) {
      const before = dispatched;
      const response = await fetch(base + '/health', { headers: { host: wrong } });
      expect(response.status).toBe(421);
      await response.text();
      expect(dispatched).toBe(before);
    }
    for (const authorization of ['', auth('https://tower.example/protected'), auth(config.origin + '/other')]) {
      const response = await fetch(base + '/protected', { headers: { host, authorization, 'x-forwarded-host': 'tower.example', 'x-forwarded-proto': 'https' } });
      expect(response.status).toBe(401);
      await response.text();
    }
    const mutated = await fetch(base + path, { method: 'POST', body: body + ' ', headers: { host, authorization: signed } });
    expect(mutated.status).toBe(401);
    await mutated.text();
    const redirect = await fetch(base + '/redirect', { redirect: 'manual', headers: { host, authorization: auth(config.origin + '/redirect') } });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get('location')).toBe('http://127.0.0.1:1/never-follow');
    // Raw client closes the real TCP connection after receiving a first event;
    // no buffered whole-response proxy can pass this check.
    const socket = connect({ host: '::1', port: address.port });
    await once(socket, 'connect');
    socket.write(`GET /events HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${auth(config.origin + '/events')}\r\nLast-Event-ID: 42\r\n\r\n`);
    let wire = '';
    const streamResult = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('stream did not arrive')); }, 2000);
      socket.on('data', chunk => {
        wire += chunk.toString();
        if (wire.includes('data: ready')) { clearTimeout(timer); socket.destroy(); resolve(); }
      });
      socket.on('error', reject);
    });
    await streamResult;
    expect(wire).toContain('text/event-stream');
    for (let i = 0; i < 100 && !streamCancelled; i++) await Bun.sleep(10);
    expect(streamCancelled).toBe(true);
    ingress.stop(true);
    await expect(fetch(base + '/health', { headers: { host }, signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  } finally {
    gateway.stop();
    ingress.stop(true);
  }
}, 15000);
