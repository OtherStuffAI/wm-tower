import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { ensureServiceIdentity } from '../src/service-identity';

const ORIGINAL_ENV = {
  SUPERBASED_SERVICE_NSEC: process.env.SUPERBASED_SERVICE_NSEC,
  SUPERBASED_SERVICE_PUBKEY_HEX: process.env.SUPERBASED_SERVICE_PUBKEY_HEX,
  SUPERBASED_SERVICE_NPUB: process.env.SUPERBASED_SERVICE_NPUB,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
});

describe('ensureServiceIdentity', () => {
  test('creates and persists service identity when missing', async () => {
    delete process.env.SUPERBASED_SERVICE_NSEC;
    delete process.env.SUPERBASED_SERVICE_PUBKEY_HEX;
    delete process.env.SUPERBASED_SERVICE_NPUB;

    const dir = await mkdtemp(join(tmpdir(), 'coworker-service-identity-'));
    const envPath = join(dir, '.env');

    try {
      const result = await ensureServiceIdentity(envPath);
      const contents = await readFile(envPath, 'utf8');

      expect(result.created).toBe(true);
      expect(result.nsec.startsWith('nsec1')).toBe(true);
      expect(result.npub.startsWith('npub1')).toBe(true);
      expect(contents).toContain(`SUPERBASED_SERVICE_NSEC=${result.nsec}`);
      expect(contents).toContain(`SUPERBASED_SERVICE_PUBKEY_HEX=${result.pubkeyHex}`);
      expect(contents).toContain(`SUPERBASED_SERVICE_NPUB=${result.npub}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('uses env-provided service identity without writing an env file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coworker-service-identity-'));
    const envPath = join(dir, '.env');

    delete process.env.SUPERBASED_SERVICE_PUBKEY_HEX;
    delete process.env.SUPERBASED_SERVICE_NPUB;
    process.env.SUPERBASED_SERVICE_NSEC = nip19.nsecEncode(generateSecretKey());

    try {
      const result = await ensureServiceIdentity(envPath);

      expect(result.created).toBe(false);
      expect(process.env.SUPERBASED_SERVICE_PUBKEY_HEX).toBe(result.pubkeyHex);
      expect(process.env.SUPERBASED_SERVICE_NPUB).toBe(result.npub);

      let fileExists = true;
      try {
        await access(envPath);
      } catch {
        fileExists = false;
      }

      expect(fileExists).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
