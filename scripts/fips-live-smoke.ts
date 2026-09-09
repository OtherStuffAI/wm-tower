// Manager-only post-activation read smoke. No operational keys or state writes.
import { readFipsIngressConfig } from '../src/fips-ingress';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const publicEnv: Record<string, string> = {};
for (const line of (await Bun.file(resolve(repo, '.env.fips')).text()).split(/\r?\n/)) {
  const match = /^(TOWER_FIPS_[A-Z_]+)=([^\s#"']+)$/.exec(line.trim());
  if (match) publicEnv[match[1]] = match[2];
}
const config = readFipsIngressConfig(publicEnv);
if (!config) throw new Error('Explicit public FIPS config required');
const fdEnv = await Bun.file(resolve(repo, '../flightdeck/.env')).text();
const appNpub = /^FLIGHT_DECK_PG_APP_NPUB=["']?([^"'\r\n]+)["']?$/m.exec(fdEnv)?.[1];
if (!appNpub) throw new Error('Flight Deck public app npub unavailable');
const { buildBotCryptoAuthHeader, resolveCapabilityBrokerUrl } = await import(resolve(repo, '../autopilot/clis/lib/auth.ts'));
const https = 'https://sb4.otherstuff.studio';
const broker = resolveCapabilityBrokerUrl(https);
const workspace = '2e5caefd-dd65-45d2-b747-ee874e8e5fc9';
const task = 'b5f96311-d672-46ca-ab2d-e0bb0cdde8f8';
const path = `/api/v4/flightdeck-pg/workspaces/${workspace}/tasks/${task}`;
const meshSocket = `http://[${config.meshAddress}]:${config.port}`;
async function read(mesh: boolean, authorization?: string) {
  const response = await fetch((mesh ? meshSocket : https) + path, {
    redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'x-flightdeck-pg-app-npub': appNpub!, ...(authorization ? { authorization } : {}),
      ...(mesh ? { host: new URL(config!.origin).host } : {}) },
  });
  return { status: response.status, body: await response.json() };
}
const publicAuth = await buildBotCryptoAuthHeader(broker, https + path, 'GET');
const meshAuth = await buildBotCryptoAuthHeader(broker, config.origin + path, 'GET');
const publicRead = await read(false, publicAuth);
const meshRead = await read(true, meshAuth);
for (const result of [publicRead, meshRead]) {
  if (result.status !== 200 || result.body.task?.id !== task || result.body.task?.workspace_id !== workspace) {
    throw new Error(`Signed task read failed: HTTP ${result.status}`);
  }
}
if (JSON.stringify(publicRead.body.identity) !== JSON.stringify(meshRead.body.identity)) throw new Error('Transport identity mismatch');
for (const authorization of [undefined, publicAuth]) {
  if ((await read(true, authorization)).status !== 401) throw new Error('Mesh did not reject absent/wrong-origin auth');
}
console.log(`PASS: HTTPS and ${config.origin} signed task reads share workspace/task/service identity; unsigned and HTTPS-signed mesh rejected`);
