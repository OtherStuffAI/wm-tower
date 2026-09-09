import { isIP } from 'node:net';
import { nip19 } from 'nostr-tools';

/** Public, operator-supplied transport settings. No node discovery or key access. */
export interface FipsIngressConfig {
  nodeNpub: string;
  meshAddress: string;
  port: number;
  origin: string;
  bindAddress: string;
  bindPort: number;
}

// Fixed private Docker seam: the host gateway cannot select an arbitrary target.
export const FIPS_DOCKER_PORT = 43101;

export function readFipsIngressConfig(env: Record<string, string | undefined>): FipsIngressConfig | null {
  if (!env.TOWER_FIPS_ENABLED || env.TOWER_FIPS_ENABLED === 'false') return null;
  if (env.TOWER_FIPS_ENABLED !== 'true') throw new Error('TOWER_FIPS_ENABLED must be true or false');
  const nodeNpub = env.TOWER_FIPS_NODE_NPUB || '';
  try {
    const decoded = nip19.decode(nodeNpub);
    if (decoded.type !== 'npub' || nip19.npubEncode(decoded.data) !== nodeNpub) throw new Error();
  } catch {
    throw new Error('TOWER_FIPS_NODE_NPUB must be a canonical checksummed node npub');
  }
  const meshAddress = env.TOWER_FIPS_MESH_ADDRESS || '';
  if (isIP(meshAddress) !== 6 || !/^fd[0-9a-f]{2}:/i.test(meshAddress) || meshAddress.includes('%')) {
    throw new Error('TOWER_FIPS_MESH_ADDRESS must be an exact fd00::/8 FIPS IPv6 address');
  }
  const portText = env.TOWER_FIPS_PORT || '';
  const port = Number(portText);
  if (!/^[1-9][0-9]*$/.test(portText) || !Number.isSafeInteger(port) || port > 65535) {
    throw new Error('TOWER_FIPS_PORT must be an explicit port from 1 to 65535');
  }
  const mode = env.TOWER_FIPS_INGRESS_MODE || 'mesh';
  if (!['mesh', 'docker'].includes(mode)) throw new Error('TOWER_FIPS_INGRESS_MODE must be mesh or docker');
  if (mode === 'docker' && Number(env.PORT || '3100') === FIPS_DOCKER_PORT) {
    throw new Error('Dedicated ingress must not share the ordinary Tower port');
  }
  return { nodeNpub, meshAddress, port, origin: new URL(`http://${nodeNpub}.fips:${port}`).origin,
    bindAddress: mode === 'docker' ? '0.0.0.0' : meshAddress,
    bindPort: mode === 'docker' ? FIPS_DOCKER_PORT : port };
}

type AppFetch = (request: Request) => Response | Promise<Response>;

/** Installed only on the dedicated ingress socket (direct mesh or private Docker). */
export function createFipsIngressFetch(config: FipsIngressConfig, appFetch: AppFetch): AppFetch {
  const authority = new URL(config.origin).host;
  return (request) => {
    // Host is checked, never used to select a destination or a signing origin.
    const host = request.headers.get('host');
    if (host !== authority && !(config.port === 80 && host === `${authority}:80`)) {
      return Response.json({ error: 'fips_host_mismatch' }, { status: 421 });
    }
    const incoming = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name === 'forwarded' || name.startsWith('x-forwarded-') || name.startsWith('cf-')
        || ['x-real-ip', 'x-original-url', 'x-rewrite-url', 'x-original-host'].includes(name)) {
        headers.delete(name);
      }
    }
    headers.set('host', authority);
    // Concatenation preserves leading // in paths without treating it as an authority.
    // Body, signal, Origin, authorization and stream responses pass through unchanged.
    const canonical = new Request(`${config.origin}${incoming.pathname}${incoming.search}`, request);
    return appFetch(new Request(canonical, { headers }));
  };
}

type ListenerOptions = { hostname: string; port: number; idleTimeout: 0; fetch: AppFetch };

/** A failed optional bind cannot prevent the ordinary Tower listener starting. */
export function startFipsIngress(
  appFetch: AppFetch,
  env: Record<string, string | undefined> = process.env,
  serve: (options: ListenerOptions) => { stop: () => unknown } = (options) => Bun.serve(options),
  report: (message: string) => void = console.info,
) {
  try {
    const config = readFipsIngressConfig(env);
    if (!config) return { status: 'disabled' as const };
    const server = serve({
      hostname: config.bindAddress,
      port: config.bindPort,
      idleTimeout: 0,
      fetch: createFipsIngressFetch(config, appFetch),
    });
    report(`[tower-fips] listening ${config.origin} on ${config.bindAddress}:${config.bindPort}`);
    return { status: 'listening' as const, config, server };
  } catch {
    // Do not log supplied config or raw runtime errors: an operator may paste a secret.
    report('[tower-fips] unavailable: validate TOWER_FIPS_* public settings and dedicated ingress bind in this network namespace; HTTPS is unchanged');
    return { status: 'unavailable' as const };
  }
}
