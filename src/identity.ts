/**
 * Service identity bootstrap.
 *
 * On startup, ensures the SuperBased instance has a stable Nostr keypair.
 * If SUPERBASED_SERVICE_NSEC is missing from .env, generates a new one.
 * If the nsec exists but derived pubkey/npub values are stale, recomputes them.
 * Persists all three values back to .env idempotently.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '../.env');

interface ServiceIdentity {
  nsec: string;
  pubkeyHex: string;
  npub: string;
}

function parseEnvFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(path)) return entries;

  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    entries.set(key, value);
  }
  return entries;
}

function writeEnvFile(path: string, entries: Map<string, string>): void {
  // Preserve original file content structure, updating/appending as needed
  let lines: string[] = [];
  const written = new Set<string>();

  if (existsSync(path)) {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        lines.push(line);
        continue;
      }
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex < 0) {
        lines.push(line);
        continue;
      }
      const key = trimmed.slice(0, eqIndex).trim();
      if (entries.has(key)) {
        lines.push(`${key}=${entries.get(key)}`);
        written.add(key);
      } else {
        lines.push(line);
      }
    }
  }

  // Append any new keys not already in the file
  for (const [key, value] of entries) {
    if (!written.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  // Ensure trailing newline
  const output = lines.join('\n').replace(/\n*$/, '\n');
  writeFileSync(path, output, 'utf-8');
}

function deriveIdentity(nsec: string): ServiceIdentity {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') throw new Error('Invalid nsec');
  const secretKey = decoded.data as Uint8Array;
  const pubkeyHex = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkeyHex);
  return { nsec, pubkeyHex, npub };
}

function generateIdentity(): ServiceIdentity {
  const secretKey = generateSecretKey();
  const nsec = nip19.nsecEncode(secretKey);
  const pubkeyHex = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkeyHex);
  return { nsec, pubkeyHex, npub };
}

export function bootstrapServiceIdentity(): ServiceIdentity {
  const env = parseEnvFile(ENV_PATH);
  const existingNsec = process.env.SUPERBASED_SERVICE_NSEC || env.get('SUPERBASED_SERVICE_NSEC');

  let identity: ServiceIdentity;
  let needsWrite = false;

  if (existingNsec) {
    identity = deriveIdentity(existingNsec);

    // Check if derived values need updating in .env
    const currentPubkey = env.get('SUPERBASED_SERVICE_PUBKEY_HEX');
    const currentNpub = env.get('SUPERBASED_SERVICE_NPUB');

    if (currentPubkey !== identity.pubkeyHex || currentNpub !== identity.npub) {
      needsWrite = true;
    }
    if (!env.has('SUPERBASED_SERVICE_NSEC')) {
      needsWrite = true;
    }
  } else {
    identity = generateIdentity();
    needsWrite = true;
  }

  if (needsWrite) {
    env.set('SUPERBASED_SERVICE_NSEC', identity.nsec);
    env.set('SUPERBASED_SERVICE_PUBKEY_HEX', identity.pubkeyHex);
    env.set('SUPERBASED_SERVICE_NPUB', identity.npub);
    writeEnvFile(ENV_PATH, env);
  }

  return identity;
}
