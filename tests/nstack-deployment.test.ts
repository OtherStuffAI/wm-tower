import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dir, '..');
const compose = readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8');
const blossom = readFileSync(join(root, 'deploy/nstack/blossom.yml'), 'utf8');
const relay = readFileSync(join(root, 'deploy/nstack/render-relay-config.sh'), 'utf8');
const env = readFileSync(join(root, '.env.prod.example'), 'utf8');

describe('supported Nstack deployment contract', () => {
  test('pins persistent relay and full Blossom image manifests', () => {
    expect(compose).toContain('scsibug/nostr-rs-relay:0.10.0@sha256:48d54c2d2781577cf3ed2951112f0953dc2c5e7c9d2ea20c64e8c0fa37d16e4d');
    expect(compose).toContain('hzrd149/blossom-server:6.4.1@sha256:446fa6c4b0ca529a1fbceabf5ea75839b5b76dfb0d0e1d150f3bae5f9a52b3b8');
    expect(compose).toContain('tower-nostr-relay-data:/usr/src/app/db');
    expect(compose).toContain('tower-blossom-data:/app/data');
    expect(compose).toContain('tower-nostr-relay-data:');
    expect(compose).toContain('tower-blossom-data:');
    expect(compose.match(/healthcheck:/g)?.length).toBeGreaterThanOrEqual(7);
  });

  test('keeps sidecar listeners on loopback and requires explicit public origins', () => {
    expect(compose).toContain('${NOSTR_RELAY_HOST_BIND_ADDRESS:-127.0.0.1}:${NOSTR_RELAY_HOST_PORT:-7777}:8080');
    expect(compose).toContain('${BLOSSOM_HOST_BIND_ADDRESS:-127.0.0.1}:${BLOSSOM_HOST_PORT:-3002}:3000');
    expect(compose).toContain('${NOSTR_RELAY_PUBLIC_ORIGIN:?set NOSTR_RELAY_PUBLIC_ORIGIN}');
    expect(compose).toContain('${NSTACK_BLOSSOM_PUBLIC_ORIGIN:?set NSTACK_BLOSSOM_PUBLIC_ORIGIN}');
    expect(compose).toContain('${BLOSSOM_PUBLIC_DOMAIN:?set BLOSSOM_PUBLIC_DOMAIN}');
    expect(compose).toContain('${BLOSSOM_PUBLISH_PUBKEY:?set BLOSSOM_PUBLISH_PUBKEY}');
    expect(env).toContain('NOSTR_RELAY_PUBLIC_ORIGIN=wss://relay.example.com');
    expect(env).toContain('NSTACK_BLOSSOM_PUBLIC_ORIGIN=https://blossom.example.com');
    expect(env).toContain('BLOSSOM_PUBLISH_PUBKEY=replace-with-64-character-hex-pubkey');
    expect(env).not.toContain('NOSTR_RELAY_NSEC=');
  });

  test('relay defaults to signed allowlisted publishing with bounded resources', () => {
    expect(statSync(join(root, 'deploy/nstack/render-relay-config.sh')).mode & 0o111).not.toBe(0);
    expect(relay).toContain('pubkey_whitelist = [$allowlist]');
    expect(relay).toContain('nip42_auth = true');
    expect(relay).toContain('nip42_dms = true');
    expect(relay).toContain('messages_per_sec = 5');
    expect(relay).toContain('subscriptions_per_min = 30');
    expect(relay).toContain('max_event_bytes = 65536');
    expect(compose).toContain('NOSTR_RELAY_PUBLISH_PUBKEYS: ${NOSTR_RELAY_PUBLISH_PUBKEYS:?set NOSTR_RELAY_PUBLISH_PUBKEYS}');
    expect(compose).toContain('pids_limit: 128');
  });

  test('relay renderer fails closed and emits a valid allowlist shape', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nstack-relay-config-'));
    const output = join(directory, 'relay.toml');
    try {
      const valid = Bun.spawn(['bash', join(root, 'deploy/nstack/render-relay-config.sh')], {
        env: {
          ...Bun.env,
          NOSTR_RELAY_PUBLIC_ORIGIN: 'wss://relay.example.test',
          NOSTR_RELAY_PUBLISH_PUBKEYS: `${'a'.repeat(64)},${'B'.repeat(64)}`,
          NOSTR_RELAY_CONFIG_PATH: output,
          NOSTR_RELAY_VALIDATE_ONLY: 'true',
        },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(await valid.exited).toBe(0);
      const rendered = readFileSync(output, 'utf8');
      expect(rendered).toContain(`relay_url = "wss://relay.example.test"`);
      expect(rendered).toContain(`pubkey_whitelist = ["${'a'.repeat(64)}", "${'b'.repeat(64)}"]`);

      for (const [origin, publishers] of [['https://relay.example.test', 'a'.repeat(64)], ['wss://relay.example.test', 'not-a-pubkey']]) {
        const invalid = Bun.spawn(['bash', join(root, 'deploy/nstack/render-relay-config.sh')], {
          env: { ...Bun.env, NOSTR_RELAY_PUBLIC_ORIGIN: origin, NOSTR_RELAY_PUBLISH_PUBKEYS: publishers, NOSTR_RELAY_CONFIG_PATH: output, NOSTR_RELAY_VALIDATE_ONLY: 'true' },
          stdout: 'pipe', stderr: 'pipe',
        });
        expect(await invalid.exited).toBe(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('Blossom enables the full authenticated surface with integrity and retention limits', () => {
    for (const setting of ['upload:', 'mirror:', 'delete:', 'list:', 'media:', 'report:']) expect(blossom).toContain(setting);
    expect(blossom.match(/requireAuth: true/g)?.length).toBe(5);
    expect(blossom).toContain('maxSize: 104857600');
    expect(blossom).toContain('allowListOthers: false');
    expect(blossom).toContain('removeWhenNoOwners: true');
    expect(blossom).toContain('expiration: 14 days');
    expect(blossom).toContain('connectTimeout: 10000');
    expect(blossom).toContain('bodyTimeout: 120000');
    expect(blossom).toContain('keepExif: false');
    expect(blossom.match(/pubkeys: \["\$\{BLOSSOM_PUBLISH_PUBKEY\}"\]/g)?.length).toBe(6);
    expect(blossom.match(/requirePubkeyInRule: true/g)?.length).toBe(2);
    expect(blossom).not.toContain('requirePubkeyInRule: false');
    expect(compose).toContain('BLOSSOM_REQUIRE_CONFIG: "1"');
    expect(compose).toContain('cap_drop: ["ALL"]');
    expect(compose).toContain('/deno-dir:size=1g,mode=1777,exec');
  });
});
