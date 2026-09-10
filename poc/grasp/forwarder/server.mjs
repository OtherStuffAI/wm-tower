import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function createForwarder(canonicalHost, targetPort = 60546) {
  const allowed = (request) => request.headers.host === canonicalHost;
  const server = http.createServer((request, response) => {
    if (!allowed(request)) { response.writeHead(403); response.end(); request.resume(); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: targetPort,
      method: request.method, path: request.url, headers: request.headers }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (request, client, head) => {
    if (!allowed(request)) { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    const upstream = net.createConnection({ host: '127.0.0.1', port: targetPort }, () => {
      let headers = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
      for (let i = 0; i < request.rawHeaders.length; i += 2) headers += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
      upstream.write(headers + '\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  server.requestTimeout = 0;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const routing = JSON.parse(readFileSync(new URL('../fips.json', import.meta.url), 'utf8'));
  const canonical = new URL(routing.url);
  const port = Number(process.env.PORT ?? process.env.WEB_APP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port !== Number(canonical.port)) {
    throw new Error('Managed port must match the allocated canonical FIPS address');
  }
  const server = createForwarder(canonical.host);
  server.listen(port, '127.0.0.1', () => console.log(`GRASP forwarding on managed loopback port ${port}`));
  process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); });
}
