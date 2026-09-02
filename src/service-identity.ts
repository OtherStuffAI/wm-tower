import { readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
const SERVICE_NSEC_KEY = 'SUPERBASED_SERVICE_NSEC';
const SERVICE_PUBKEY_HEX_KEY = 'SUPERBASED_SERVICE_PUBKEY_HEX';
const SERVICE_NPUB_KEY = 'SUPERBASED_SERVICE_NPUB';

function decodeSecretKey(value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, 'hex'));
  }

  try {
    const decoded = nip19.decode(trimmed);
    return decoded.type === 'nsec' ? decoded.data : null;
  } catch {
    return null;
  }
}

function setEnvAssignment(contents: string, key: string, value: string) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');

  if (!contents.trim()) return `${line}\n`;
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }

  return contents.endsWith('\n') ? `${contents}${line}\n` : `${contents}\n${line}\n`;
}

export async function ensureServiceIdentity(envPath = ENV_PATH) {
  const providedSecret = decodeSecretKey(process.env[SERVICE_NSEC_KEY] || '');
  let envContents = '';
  if (!providedSecret) {
    try {
      envContents = await readFile(envPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const decodedSecret = providedSecret
    ?? decodeSecretKey(envContents.match(/^SUPERBASED_SERVICE_NSEC=(.+)$/m)?.[1] || '');
  const secretKey = decodedSecret ?? generateSecretKey();
  const nsec = nip19.nsecEncode(secretKey);
  const pubkeyHex = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkeyHex);

  if (!providedSecret) {
    const nextEnv = [
      [SERVICE_NSEC_KEY, nsec],
      [SERVICE_PUBKEY_HEX_KEY, pubkeyHex],
      [SERVICE_NPUB_KEY, npub],
    ].reduce((contents, [key, value]) => setEnvAssignment(contents, key, value), envContents);

    if (nextEnv !== envContents) {
      await writeFile(envPath, nextEnv, 'utf8');
    }
  }

  process.env[SERVICE_NSEC_KEY] = nsec;
  process.env[SERVICE_PUBKEY_HEX_KEY] = pubkeyHex;
  process.env[SERVICE_NPUB_KEY] = npub;

  return {
    envPath,
    created: !decodedSecret,
    nsec,
    pubkeyHex,
    npub,
  };
}
