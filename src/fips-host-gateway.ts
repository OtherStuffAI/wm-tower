import { connect, createServer, type Socket } from 'node:net';
import { FIPS_DOCKER_PORT, readFipsIngressConfig } from './fips-ingress';

/** Byte-transparent TCP forwarder: no HTTP parsing, DNS, keys, redirects or target input.
 * The dedicated Tower listener owns the fixed Host and canonical NIP-98 boundary.
 */
export function createFipsHostGateway() {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ host: '127.0.0.1', port: FIPS_DOCKER_PORT, allowHalfOpen: true });
    sockets.add(client);
    sockets.add(upstream);
    const destroy = () => { client.destroy(); upstream.destroy(); };
    const connecting = setTimeout(destroy, 5000);
    upstream.once('connect', () => clearTimeout(connecting));
    // pipe propagates backpressure and FIN in each direction; errors/disconnects
    // tear down the pair, including quiet SSE connections. No stream idle timeout.
    client.on('error', destroy);
    upstream.on('error', destroy);
    for (const socket of [client, upstream]) socket.once('close', () => {
      clearTimeout(connecting);
      sockets.delete(socket);
      destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return { server, stop() { server.close(); for (const socket of sockets) socket.destroy(); } };
}

type FipsDaemonStatus = { npub?: unknown; ipv6_addr?: unknown; persistent?: unknown; state?: unknown; tun_state?: unknown };

async function inspectConfiguredDaemon(env: Record<string, string | undefined>): Promise<FipsDaemonStatus> {
  const socket = env.TOWER_FIPS_DAEMON_CONTROL_SOCKET || '/var/run/fips/control.sock';
  const child = Bun.spawn(['/usr/local/bin/fipsctl', '--socket', socket, 'show', 'status'], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) throw new Error('Configured native FIPS daemon is unavailable');
  return JSON.parse(stdout);
}

export async function startFipsHostGateway(
  env: Record<string, string | undefined> = process.env,
  inspectDaemon: (env: Record<string, string | undefined>) => Promise<FipsDaemonStatus> = inspectConfiguredDaemon,
) {
  const config = readFipsIngressConfig(env);
  if (!config) throw new Error('Host gateway requires explicit FIPS enablement');
  const daemon = await inspectDaemon(env);
  if (daemon.npub !== config.nodeNpub || daemon.ipv6_addr !== config.meshAddress
    || daemon.persistent !== true || daemon.state !== 'running' || daemon.tun_state !== 'active') {
    throw new Error('Native FIPS daemon identity/address/readiness does not match public gateway configuration');
  }
  const gateway = createFipsHostGateway();
  await new Promise<void>((resolve, reject) => {
    gateway.server.once('error', reject);
    gateway.server.listen({ host: config.meshAddress, port: config.port, ipv6Only: true }, () => {
      gateway.server.removeListener('error', reject);
      resolve();
    });
  });
  return { ...gateway, config };
}

if (import.meta.main) {
  try {
    const gateway = await startFipsHostGateway();
    console.info(`[tower-fips-host] ${gateway.config.origin} on [${gateway.config.meshAddress}]:${gateway.config.port} -> 127.0.0.1:${FIPS_DOCKER_PORT}`);
    gateway.server.on('error', () => { console.error('[tower-fips-host] listener failed'); gateway.stop(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => gateway.stop());
  } catch {
    console.error('[tower-fips-host] unavailable: check public FIPS settings and native mesh interface/bind');
    process.exitCode = 1;
  }
}
