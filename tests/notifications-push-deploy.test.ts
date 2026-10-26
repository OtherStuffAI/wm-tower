import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApnsConfig } from '../src/services/notification-apns';

// Deployment acceptance for APNs custody: generated fixture keys only, nothing read from the host environment or real files.
const NAMES = ['APNS_AUTH_KEY', 'APNS_AUTH_KEY_FILE', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC', 'APNS_ENVIRONMENTS'];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
const dirs: string[] = [];
afterEach(() => {
  for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const pem = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const clear = () => { for (const n of NAMES) delete process.env[n]; };

describe('APNs deployment config', () => {
  test('compose forwards every APNS_/NOTIF_ variable and mounts the key directory read-only (never a single file)', () => {
    const compose = readFileSync(new URL('../docker-compose.prod.yml', import.meta.url), 'utf8');
    for (const name of ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC', 'APNS_AUTH_KEY_FILE', 'APNS_CLIENT_APP_ID', 'APNS_EXTRA_TOPICS', 'APNS_ENVIRONMENTS', 'NOTIF_PUBLIC_ORIGIN', 'NOTIF_ALERTS']) {
      expect(compose).toContain(`      ${name}: \${${name}:-`);
    }
    expect(compose).not.toMatch(/APNS_AUTH_KEY:/); // the raw key is never passed inline by compose
    expect(compose).toContain('${TOWER_APNS_SECRETS_DIR:-./.runtime/tower-apns-secrets}:/run/tower-apns-secrets:ro');
    expect(readFileSync(new URL('../rebuild_deploy_docker.sh', import.meta.url), 'utf8')).toContain('mkdir -p "$SCRIPT_DIR/.runtime/tower-apns-secrets"');
  });

  test('nothing set: not ready, no throw', () => {
    clear();
    expect(loadApnsConfig()).toEqual({ ready: false, reason: 'provider_not_configured' });
  });

  test('compose-style empty values and an empty mounted directory still mean "not configured"', () => {
    clear();
    Object.assign(process.env, { APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_TOPIC: '', APNS_AUTH_KEY_FILE: '' });
    expect(loadApnsConfig()).toEqual({ ready: false, reason: 'provider_not_configured' });
    process.env.APNS_AUTH_KEY_FILE = '/run/tower-apns-secrets/apns-auth-key.p8'; // path set, file absent
    Object.assign(process.env, { APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_TOPIC: 'a.b' });
    expect(loadApnsConfig()).toEqual({ ready: false, reason: 'provider_not_configured' });
  });

  test('key read from a mounted *_FILE becomes ready; inline + file together is refused; bad key is invalid', () => {
    clear();
    const dir = mkdtempSync(join(tmpdir(), 'apns-fixture-')); dirs.push(dir);
    const file = join(dir, 'apns-auth-key.p8');
    writeFileSync(file, pem(), { mode: 0o600 });
    Object.assign(process.env, { APNS_AUTH_KEY_FILE: file, APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_TOPIC: 'studio.example.app' });
    const ready = loadApnsConfig();
    expect(ready.ready).toBe(true);
    process.env.APNS_AUTH_KEY = pem();
    expect(loadApnsConfig()).toEqual({ ready: false, reason: 'provider_not_configured' });
    delete process.env.APNS_AUTH_KEY;
    writeFileSync(file, 'not a key');
    expect(loadApnsConfig()).toEqual({ ready: false, reason: 'provider_key_invalid' });
  });
});
