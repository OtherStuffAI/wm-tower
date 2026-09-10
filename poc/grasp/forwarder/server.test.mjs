import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createForwarder } from './server.mjs';

const host = 'synthetic.fips:41007'; // Transport fixture only; no production identity.
const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
test('forwards method, URL, binary body and response; rejects noncanonical hosts', async (t) => {
  const bytes = Buffer.from([0, 255, 1, 13, 10, 128]);
  let observed;
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    observed = { method: req.method, url: req.url, body: Buffer.concat(chunks) };
    res.writeHead(207, { 'x-poc': 'streamed' }); res.write(bytes.subarray(0, 3)); res.end(bytes.subarray(3));
  });
  const proxy = createForwarder(host, await listen(backend)); const port = await listen(proxy);
  t.after(() => { proxy.closeAllConnections(); proxy.close(); backend.closeAllConnections(); backend.close(); });
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/repo/git-receive-pack?x=1', headers: { Host: host } }, async (res) => {
      const chunks = []; for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, header: res.headers['x-poc'], body: Buffer.concat(chunks) });
    });
    req.on('error', reject); req.write(bytes.subarray(0, 2)); req.end(bytes.subarray(2));
  });
  assert.deepEqual(observed, { method: 'POST', url: '/repo/git-receive-pack?x=1', body: bytes });
  assert.deepEqual(result, { status: 207, header: 'streamed', body: bytes });
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 403);
});

test('preserves bytes accompanying an HTTP upgrade and streams the response', { timeout: 5000 }, async (t) => {
  const backend = http.createServer();
  backend.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: poc\r\n\r\n');
    if (head.length) socket.end(head); else socket.once('data', (data) => socket.end(data));
  });
  const proxy = createForwarder(host, await listen(backend)); const port = await listen(proxy);
  t.after(() => { proxy.close(); backend.close(); });
  const client = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => client.destroy()); await once(client, 'connect');
  const chunks = []; client.on('data', (data) => chunks.push(data));
  client.write(`GET /relay HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: poc\r\n\r\ninitial-frame`);
  await once(client, 'end');
  const response = Buffer.concat(chunks).toString();
  assert.match(response, /^HTTP\/1.1 101/); assert.ok(response.endsWith('initial-frame'));
});
