import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';

import { finalizeEvent, nip19, getPublicKey } from 'nostr-tools';
let router: any;
let previousConfig: any;
let runtimeConfig: any;
let issuer = 'https://tower.example.test/api/v4/git/oidc';
let redirectUri = 'https://forgejo.example.test/user/oauth2/tower/callback';
let clientSecret = 's'.repeat(40);
const requestOrigin = 'https://router.example.test';

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const defaults: Record<string, string> = {
    SUPERBASED_DIRECT_HTTPS_URL: 'https://tower.example.test', ADMIN_NPUB: 'npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul',
    STORAGE_S3_ENDPOINT_PUBLIC: 'https://storage.example.test', STORAGE_S3_ACCESS_KEY: 'test', STORAGE_S3_SECRET_KEY: 'test',
    DB_USER: 'postgres', DB_PASSWORD: 'postgres', GRAPH_DB_ADMIN_USER: 'postgres', GRAPH_DB_ADMIN_PASSWORD: 'postgres', GRAPH_DB_APP_USER: 'graph', GRAPH_DB_APP_PASSWORD: 'postgres',
    FLIGHT_DECK_PG_APP_NPUB: 'npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul',
    GIT_OIDC_ISSUER: issuer, GIT_OIDC_CLIENT_ID: 'forgejo', GIT_OIDC_CLIENT_SECRET: clientSecret,
    GIT_OIDC_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), GIT_OIDC_REDIRECT_URI: redirectUri,
  };
  for (const [name, value] of Object.entries(defaults)) {
    if (!process.env[name] && !process.env[`${name}_FILE`]) process.env[name] = value;
  }
  router = (await import('../src/routes/git-oidc')).gitOidcRouter;
  const runtime = (await import('../src/config')).config.git;
  previousConfig = { ...runtime };
  runtimeConfig = runtime;
  Object.assign(runtime, { oidcIssuer: issuer, oidcClientId: 'forgejo', oidcClientSecret: clientSecret, oidcRedirectUri: redirectUri, oidcSigningKey: defaults.GIT_OIDC_SIGNING_KEY, oidcAllowedNpubs: [] });
  issuer = runtime.oidcIssuer;
  redirectUri = runtime.oidcRedirectUri;
  clientSecret = runtime.oidcClientSecret;
});

afterAll(() => Object.assign(runtimeConfig, previousConfig));

describe('Tower Forgejo OIDC provider', () => {
  test('publishes discovery metadata and an RSA signing key', async () => {
    const discovery = await router.request(`${requestOrigin}/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'] });
    const jwks = await router.request(`${requestOrigin}/jwks`);
    expect(jwks.status).toBe(200);
    expect((await jwks.json()).keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: 'tower-git-oidc-1' });
  });

  test('accepts only the registered client, callback, code flow, and openid scope', async () => {
    const valid = new URL(`${requestOrigin}/authorize`); valid.search = new URLSearchParams({ client_id: 'forgejo', redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile email', state: 'opaque-state' }).toString();
    const page = await router.request(valid);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Sign with Nostr');
    valid.searchParams.set('redirect_uri', 'https://attacker.example/callback');
    expect((await router.request(valid)).status).toBe(400);
  });

  test('rejects unauthenticated and invented authorization-code exchanges', async () => {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: 'invented', redirect_uri: redirectUri });
    expect((await router.request(`${requestOrigin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })).status).toBe(401);
    expect((await router.request(`${requestOrigin}/token`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`forgejo:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body })).status).toBe(400);
  });
  test('structured challenge binds Nostr proof, rejects unlisted signers and replay', async () => {
    const secret = new Uint8Array(32).fill(121);
    const url = new URL(`${requestOrigin}/authorize`);
    url.search = new URLSearchParams({ client_id: 'forgejo', redirect_uri: redirectUri, response_type: 'code', scope: 'openid', state: 'native-state', nonce: 'native-nonce' }).toString();
    const response = await router.request(url, { headers: { accept: 'application/json' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const challenge = await response.json();
    expect(challenge).toMatchObject({ client_id: 'forgejo', completion_url: `${issuer}/authorize/complete` });
    const body = JSON.stringify({ request_id: challenge.request_id });
    const proof = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [
      ['u', challenge.completion_url], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')],
      ['nonce', challenge.request_id], ['aud', challenge.client_id], ['expiration', String(challenge.expires_at)],
    ] }, secret);
    expect(runtimeConfig.oidcAllowedNpubs).not.toContain(nip19.npubEncode(getPublicKey(secret)));
    const submit = () => router.request(`${requestOrigin}/authorize/complete`, { method: 'POST', headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(proof)).toString('base64')}`, 'content-type': 'application/json' }, body });
    expect((await submit()).status).toBe(403);
    expect((await submit()).status).toBe(401);
  });

  test('rejects tampered, duplicate, foreign and expired Nostr bindings', async () => {
    const secret = new Uint8Array(32).fill(122);
    for (const mutation of ['u', 'method', 'payload', 'nonce', 'aud', 'expiration', 'duplicate', 'old']) {
      const url = new URL(`${requestOrigin}/authorize`);
      url.search = new URLSearchParams({ client_id: 'forgejo', redirect_uri: redirectUri, response_type: 'code', scope: 'openid', state: 'binding-state' }).toString();
      const challenge = await (await router.request(url, { headers: { accept: 'application/json' } })).json();
      const body = JSON.stringify({ request_id: challenge.request_id });
      const tags = [['u', challenge.completion_url], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')], ['nonce', challenge.request_id], ['aud', challenge.client_id], ['expiration', String(challenge.expires_at)]];
      if (mutation === 'duplicate') tags.push(['nonce', challenge.request_id]);
      else if (mutation !== 'old') tags.find(tag => tag[0] === mutation)![1] = mutation === 'expiration' ? '1' : 'foreign';
      const proof = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000) - (mutation === 'old' ? 120 : 0), content: '', tags }, secret);
      const response = await router.request(`${requestOrigin}/authorize/complete`, { method: 'POST', headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(proof)).toString('base64')}`, 'content-type': 'application/json' }, body });
      expect(response.status).toBe(401);
    }
  });

});
