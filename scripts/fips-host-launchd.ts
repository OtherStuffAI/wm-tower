import { resolve } from 'node:path';
import { readFipsIngressConfig } from '../src/fips-ingress';

// Render only; installation/activation is an explicit manager operation.
// Read only the named public file, never Tower's runtime secrets or node keys.
export function renderFipsHostPlist(env: Record<string, string | undefined>, bunPath: string, repo: string) {
  const config = readFipsIngressConfig(env);
  if (!config) throw new Error('Public FIPS settings must explicitly enable the gateway');
  const xml = (text: string) => text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
  const publicEnv = {
    TOWER_FIPS_ENABLED: 'true', TOWER_FIPS_INGRESS_MODE: 'docker',
    TOWER_FIPS_NODE_NPUB: config.nodeNpub, TOWER_FIPS_MESH_ADDRESS: config.meshAddress,
    TOWER_FIPS_PORT: String(config.port),
    TOWER_FIPS_DAEMON_CONTROL_SOCKET: env.TOWER_FIPS_DAEMON_CONTROL_SOCKET || '/var/run/fips/control.sock',
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>studio.otherstuff.tower-fips-host</string>
<key>ProgramArguments</key><array><string>${xml(bunPath)}</string><string>run</string><string>${xml(resolve(repo, 'src/fips-host-gateway.ts'))}</string></array>
<!-- Avoid loading the repository .env into the host gateway. -->
<key>WorkingDirectory</key><string>/var/empty</string>
<key>EnvironmentVariables</key><dict>${Object.entries(publicEnv).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(resolve(repo, '.runtime/fips-host/stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(repo, '.runtime/fips-host/stderr.log'))}</string>
</dict></plist>
`;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: bun scripts/fips-host-launchd.ts <public .env.fips file>');
  const env: Record<string, string> = {};
  for (const line of (await Bun.file(path).text()).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(TOWER_FIPS_[A-Z_]+)=([^\s#"']+)$/.exec(trimmed);
    if (!match) throw new Error('Use only unquoted public TOWER_FIPS_* values in the gateway env file');
    env[match[1]] = match[2];
  }
  process.stdout.write(renderFipsHostPlist(env, process.execPath, resolve(import.meta.dir, '..')));
}
