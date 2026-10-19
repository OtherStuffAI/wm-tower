import { createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';

const towerOrigin = requiredOrigin('NSTACK_SMOKE_TOWER_ORIGIN', ['http:', 'https:']);
const relayOrigin = requiredOrigin('NSTACK_SMOKE_RELAY_ORIGIN', ['ws:', 'wss:']);
const blossomOrigin = requiredOrigin('NSTACK_SMOKE_BLOSSOM_ORIGIN', ['http:', 'https:']);
const expectedTowerEndpoint = optionalOrigin('NSTACK_SMOKE_EXPECTED_TOWER_ENDPOINT', ['http:', 'https:'], towerOrigin);
const expectedRelayEndpoint = optionalOrigin('NSTACK_SMOKE_EXPECTED_RELAY_ENDPOINT', ['ws:', 'wss:'], relayOrigin);
const expectedBlossomEndpoint = optionalOrigin('NSTACK_SMOKE_EXPECTED_BLOSSOM_ENDPOINT', ['http:', 'https:'], blossomOrigin);
const nsec = String(process.env.NSTACK_SMOKE_NSEC || '').trim();
if (!nsec.startsWith('nsec1')) throw new Error('NSTACK_SMOKE_NSEC must be supplied outside tracked files');
const decoded = nip19.decode(nsec);
if (decoded.type !== 'nsec') throw new Error('NSTACK_SMOKE_NSEC is not an nsec');
const secret = decoded.data;
const pubkey = getPublicKey(secret);

function requiredOrigin(name: string, protocols: string[]) {
  const value = String(process.env[name] || '').trim();
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${name} must be a root ${protocols.join(' or ')} origin`);
  }
  return url.origin;
}

function optionalOrigin(name: string, protocols: string[], fallback: string) {
  return process.env[name] ? requiredOrigin(name, protocols) : fallback;
}

function event(kind: number, content: string, tags: string[][]) {
  return finalizeEvent({ kind, content, tags, created_at: Math.floor(Date.now() / 1000) - 1 }, secret);
}

function budAuth(action: 'upload' | 'delete', hash: string) {
  const authorization = event(24242, `Nstack smoke ${action}`, [
    ['t', action], ['x', hash], ['server', new URL(expectedBlossomEndpoint).hostname.toLowerCase()],
    ['expiration', String(Math.floor(Date.now() / 1000) + 120)],
  ]);
  return `Nostr ${Buffer.from(JSON.stringify(authorization)).toString('base64url')}`;
}

async function descriptorSmoke() {
  const response = await fetch(`${towerOrigin}/.well-known/nstack.json`);
  if (!response.ok) throw new Error(`descriptor returned ${response.status}`);
  const descriptor = await response.json() as any;
  if (descriptor.schema !== 'org.wingman.nstack.services' || descriptor.schema_version !== 1) throw new Error('descriptor schema mismatch');
  const byId = new Map(descriptor.services.map((service: any) => [service.id, service]));
  if (byId.get('tower')?.endpoint !== expectedTowerEndpoint) throw new Error('Tower descriptor endpoint mismatch');
  if (byId.get('relay')?.endpoint !== expectedRelayEndpoint) throw new Error('relay descriptor endpoint mismatch');
  if (byId.get('blossom')?.endpoint !== expectedBlossomEndpoint) throw new Error('Blossom descriptor endpoint mismatch');
  if (!byId.get('relay')?.features?.nips?.includes(1)) throw new Error('relay does not advertise NIP-01');
  for (const bud of [1, 2, 4, 5, 6, 8, 9, 11, 12]) {
    if (!byId.get('blossom')?.features?.buds?.includes(bud)) throw new Error(`Blossom does not advertise BUD-${String(bud).padStart(2, '0')}`);
  }
}

async function relaySmoke() {
  const socket = new WebSocket(relayOrigin);
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  socket.onmessage = (message) => {
    queue.push(JSON.parse(String(message.data)));
    wake?.();
    wake = null;
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay WebSocket open timeout')), 10_000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('relay WebSocket failed')); };
  });
  const next = async (predicate: (message: any) => boolean) => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return queue.splice(index, 1)[0];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(250, until - Date.now()));
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    throw new Error('relay response timeout');
  };

  const challenge = await next((message) => message[0] === 'AUTH');
  const auth = event(22242, '', [['relay', expectedRelayEndpoint], ['challenge', challenge[1]]]);
  socket.send(JSON.stringify(['AUTH', auth]));
  const authResult = await next((message) => message[0] === 'OK' && message[1] === auth.id);
  if (!authResult[2]) throw new Error(`relay AUTH rejected: ${authResult[3] || 'unknown'}`);

  const note = event(1, `nstack-smoke-${crypto.randomUUID()}`, [['client', 'wingman-tower-smoke']]);
  socket.send(JSON.stringify(['EVENT', note]));
  const publish = await next((message) => message[0] === 'OK' && message[1] === note.id);
  if (!publish[2]) throw new Error(`relay publish rejected: ${publish[3] || 'unknown'}`);
  const subscription = `smoke-${crypto.randomUUID()}`;
  socket.send(JSON.stringify(['REQ', subscription, { ids: [note.id], authors: [pubkey] }]));
  const received = await next((message) => message[0] === 'EVENT' && message[1] === subscription && message[2]?.id === note.id);
  if (received[2].content !== note.content) throw new Error('relay query returned different content');
  await next((message) => message[0] === 'EOSE' && message[1] === subscription);
  socket.send(JSON.stringify(['CLOSE', subscription]));
  socket.close();
}

async function blossomSmoke() {
  const bytes = new TextEncoder().encode(`nstack-blossom-smoke-${crypto.randomUUID()}`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const upload = await fetch(`${blossomOrigin}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: budAuth('upload', hash),
      'Content-Type': 'text/plain',
      'Content-Length': String(bytes.length),
      'X-SHA-256': hash,
    },
    body: bytes,
  });
  if (![200, 201].includes(upload.status)) throw new Error(`Blossom upload returned ${upload.status}: ${await upload.text()}`);
  const descriptor = await upload.json() as any;
  if (descriptor.sha256 !== hash || descriptor.size !== bytes.length) throw new Error('Blossom descriptor integrity mismatch');

  const head = await fetch(`${blossomOrigin}/${hash}`, { method: 'HEAD' });
  if (!head.ok || head.headers.get('content-length') !== String(bytes.length)) throw new Error('Blossom HEAD integrity mismatch');
  const get = await fetch(`${blossomOrigin}/${hash}`);
  if (!get.ok || Buffer.compare(Buffer.from(await get.arrayBuffer()), Buffer.from(bytes)) !== 0) throw new Error('Blossom GET integrity mismatch');
  const remove = await fetch(`${blossomOrigin}/${hash}`, { method: 'DELETE', headers: { Authorization: budAuth('delete', hash) } });
  if (![200, 204].includes(remove.status)) throw new Error(`Blossom owner delete returned ${remove.status}: ${await remove.text()}`);
  if ((await fetch(`${blossomOrigin}/${hash}`, { method: 'HEAD' })).status !== 404) throw new Error('Blossom deleted blob remains available');
}

await descriptorSmoke();
await relaySmoke();
await blossomSmoke();
console.log(JSON.stringify({ ok: true, descriptor: true, relay_publish_query: true, blossom_upload_head_get_owner_delete: true }));
