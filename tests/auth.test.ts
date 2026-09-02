import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { verifyNip98AuthHeader } from '../src/auth';

const secret = new Uint8Array(32).fill(71);
const signerNpub = nip19.npubEncode(getPublicKey(secret));

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function authHeader(input: {
  url: string;
  method?: string;
  body?: string;
  extraTags?: string[][];
}): string {
  const tags: string[][] = [
    ['u', input.url],
    ['method', input.method ?? 'GET'],
    ...(input.body === undefined ? [] : [['payload', sha256Hex(input.body)]]),
    ...(input.extraTags ?? []),
  ];
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, secret);
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

async function verify(requestUrl: string, signedUrl: string, init: RequestInit = {}) {
  const request = new Request(requestUrl, init);
  return verifyNip98AuthHeader(authHeader({
    url: signedUrl,
    method: request.method,
    body: typeof init.body === 'string' ? init.body : undefined,
  }), request);
}

describe('complete canonical NIP-98 URL verification', () => {
  test('accepts the exact complete URL including query order', async () => {
    const url = 'https://tower.example/api/v4/records?cursor=one&limit=50&audience_npub=npub1abc';
    expect(await verify(url, url)).toBe(signerNpub);
  });

  test('rejects changed, missing, additional, and reordered query parameters', async () => {
    const requestUrl = 'https://tower.example/api/v4/records?cursor=one&limit=50';
    const signedUrls = [
      'https://tower.example/api/v4/records?cursor=two&limit=50',
      'https://tower.example/api/v4/records?cursor=one',
      'https://tower.example/api/v4/records?cursor=one&limit=50&extra=1',
      'https://tower.example/api/v4/records?limit=50&cursor=one',
    ];
    for (const signedUrl of signedUrls) {
      expect(await verify(requestUrl, signedUrl)).toBeNull();
    }
  });

  test('rejects a trailing-slash mismatch', async () => {
    expect(await verify(
      'https://tower.example/api/v4/records/?cursor=one',
      'https://tower.example/api/v4/records?cursor=one',
    )).toBeNull();
  });

  test('rejects duplicate u and method tags', async () => {
    const url = 'https://tower.example/api/v4/records?cursor=one';
    const request = new Request(url);
    expect(await verifyNip98AuthHeader(authHeader({
      url,
      extraTags: [['u', url]],
    }), request)).toBeNull();
    expect(await verifyNip98AuthHeader(authHeader({
      url,
      extraTags: [['method', 'GET']],
    }), request)).toBeNull();
  });

  test('rejects empty u and method tags', async () => {
    const url = 'https://tower.example/api/v4/records';
    const request = new Request(url);
    const emptyUTags = [['u', ''], ['method', 'GET']];
    const emptyMethodTags = [['u', url], ['method', '']];
    for (const tags of [emptyUTags, emptyMethodTags]) {
      const event = finalizeEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
      }, secret);
      const header = `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
      expect(await verifyNip98AuthHeader(header, request)).toBeNull();
    }
  });

  test('rejects a POST with the correct payload hash but a changed query', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const request = new Request('https://tower.example/api/v4/records?mode=create', {
      method: 'POST',
      body,
    });
    const header = authHeader({
      url: 'https://tower.example/api/v4/records?mode=replace',
      method: 'POST',
      body,
    });
    expect(await verifyNip98AuthHeader(header, request)).toBeNull();
  });

  test('accepts a reverse-proxied public origin with the exact query', async () => {
    const request = new Request('http://tower:3100/api/v4/records?cursor=one&limit=50', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'tower.example',
      },
    });
    const header = authHeader({ url: 'https://tower.example/api/v4/records?cursor=one&limit=50' });
    expect(await verifyNip98AuthHeader(header, request)).toBe(signerNpub);
  });

  test('excludes only explicitly selected transport query parameters', async () => {
    const request = new Request('https://tower.example/events?cursor=one&token=transport&limit=50');
    const header = authHeader({ url: 'https://tower.example/events?cursor=one&limit=50' });
    expect(await verifyNip98AuthHeader(header, request)).toBeNull();
    expect(await verifyNip98AuthHeader(header, request, {
      excludedQueryParams: ['token'],
    })).toBe(signerNpub);
  });
});
