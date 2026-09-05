import { createHash, createPrivateKey, randomBytes, sign as signBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { nip19, verifyEvent } from 'nostr-tools';
import { config } from '../config';
import { resolveForgejoLoginIdentity } from '../services/forgejo-login-identity';

const NIP98_KIND = 27235;
const challenges = new Map<string, AuthorizationRequest>();
const codes = new Map<string, AuthorizationGrant>();
const accessTokens = new Map<string, AccessGrant>();
const MAX_TRANSIENT_GRANTS = 10_000;

type AuthorizationRequest = {
  clientId: string; redirectUri: string; state: string; scope: string;
  nonce: string | null; codeChallenge: string | null; expiresAt: number;
};
type ActorClaims = { sub: string; preferred_username: string; name?: string; email: string; email_verified: true };
type AuthorizationGrant = AuthorizationRequest & { actor: ActorClaims; authTime: number };
type AccessGrant = { actor: ActorClaims; clientId: string; scope: string; expiresAt: number };

function storeTransient<T extends { expiresAt: number }>(store: Map<string, T>, key: string, value: T) {
  if (store.size >= MAX_TRANSIENT_GRANTS) {
    const now = Date.now();
    for (const [candidate, entry] of store) {
      if (entry.expiresAt <= now) store.delete(candidate);
    }
  }
  while (store.size >= MAX_TRANSIENT_GRANTS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  store.set(key, value);
}

function token(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
function hash(value: string) { return createHash('sha256').update(value).digest('base64url'); }
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function singleTag(event: any, name: string): string | null {
  const tags = event?.tags?.filter((tag: unknown) => Array.isArray(tag) && tag[0] === name) ?? [];
  return tags.length === 1 && typeof tags[0]?.[1] === 'string' ? tags[0][1] : null;
}
function noStore(c: Context) {
  c.header('cache-control', 'no-store');
  c.header('pragma', 'no-cache');
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
}
function configured() {
  return /^https:\/\//.test(config.git.oidcIssuer)
    && config.git.oidcClientId.length > 0
    && config.git.oidcClientSecret.length >= 32
    && config.git.oidcSigningKey.includes('PRIVATE KEY')
    && /^https:\/\//.test(config.git.oidcRedirectUri);
}
function oidcError(c: Context, status: number, error: string, description: string) {
  noStore(c);
  return c.json({ error, error_description: description }, status as any);
}
function escapeHtml(value: unknown) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function loginPage(requestId: string, request: AuthorizationRequest) {
  const completionUrl = `${config.git.oidcIssuer}/authorize/complete`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Forgejo</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10151c;color:#edf2f7;font:16px/1.5 system-ui,sans-serif}.card{width:min(32rem,calc(100% - 3rem));padding:2.5rem;border:1px solid #2c3847;border-radius:18px;background:#17202b;box-shadow:0 20px 60px #0007}h1{margin:.2rem 0 .7rem;font-size:1.8rem}p{color:#b9c5d3}button{width:100%;margin-top:1rem;padding:.85rem;border:0;border-radius:10px;background:#65d5a5;color:#08140f;font-weight:750;font-size:1rem;cursor:pointer}button:disabled{opacity:.55}.mark{color:#65d5a5;font-weight:800;letter-spacing:.08em}#status{color:#f1b8a8}</style></head><body><main class="card"><div class="mark">WINGMAN</div><h1>Sign in to Forgejo</h1><p>Authorize <strong>${escapeHtml(request.clientId)}</strong> using your Nostr browser signer. Forgejo receives a stable Tower account ID, never your private key.</p><button id="login">Sign with Nostr</button><p id="status" role="status"></p></main><script>
const id=${JSON.stringify(requestId)},url=${JSON.stringify(completionUrl)},button=document.querySelector('#login'),status=document.querySelector('#status');const hex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');button.onclick=async()=>{button.disabled=true;try{if(!window.nostr?.signEvent)throw new Error('No Nostr browser extension was found.');const body=JSON.stringify({request_id:id}),payload=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))),expiration=${Math.floor(request.expiresAt / 1000)};const event=await window.nostr.signEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method','POST'],['payload',payload],['nonce',id],['aud',${JSON.stringify(config.git.oidcClientId)}],['expiration',String(expiration)]]});const response=await fetch(url,{method:'POST',headers:{authorization:'Nostr '+btoa(JSON.stringify(event)),'content-type':'application/json','accept':'application/json'},body});const result=await response.json();if(!response.ok)throw new Error(result.error_description||'Sign-in was denied.');location.assign(result.redirect_to)}catch(error){status.textContent=error instanceof Error?error.message:'Sign-in failed.';button.disabled=false}};</script></body></html>`;
}
function jwt(claims: Record<string, unknown>) {
  const key = createPrivateKey(config.git.oidcSigningKey);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'tower-git-oidc-1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = signBytes('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
function clientAuthenticated(c: Context, form: URLSearchParams) {
  const basic = c.req.header('authorization');
  let id = form.get('client_id') || ''; let secret = form.get('client_secret') || '';
  if (basic?.startsWith('Basic ')) {
    try { const decoded = Buffer.from(basic.slice(6), 'base64').toString(); const at = decoded.indexOf(':'); id = decodeURIComponent(decoded.slice(0, at)); secret = decodeURIComponent(decoded.slice(at + 1)); } catch {}
  }
  return safeEqual(id, config.git.oidcClientId) && safeEqual(secret, config.git.oidcClientSecret);
}

export const gitOidcRouter = new Hono();

gitOidcRouter.get('/.well-known/openid-configuration', (c) => {
  if (!configured()) return oidcError(c, 503, 'temporarily_unavailable', 'Tower OIDC is not configured');
  return c.json({ issuer: config.git.oidcIssuer, authorization_endpoint: `${config.git.oidcIssuer}/authorize`, token_endpoint: `${config.git.oidcIssuer}/token`, userinfo_endpoint: `${config.git.oidcIssuer}/userinfo`, jwks_uri: `${config.git.oidcIssuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], scopes_supported: ['openid', 'profile', 'email'], claims_supported: ['sub', 'preferred_username', 'name', 'email', 'email_verified'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'] });
});

gitOidcRouter.get('/jwks', (c) => {
  if (!configured()) return oidcError(c, 503, 'temporarily_unavailable', 'Tower OIDC is not configured');
  const jwk = createPrivateKey(config.git.oidcSigningKey).export({ format: 'jwk' }) as JsonWebKey;
  return c.json({ keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid: 'tower-git-oidc-1' }] });
});

gitOidcRouter.get('/authorize', (c) => {
  noStore(c);
  if (!configured()) return oidcError(c, 503, 'temporarily_unavailable', 'Tower OIDC is not configured');
  const clientId = c.req.query('client_id') || '', redirectUri = c.req.query('redirect_uri') || '';
  const responseType = c.req.query('response_type') || '', scope = c.req.query('scope') || '';
  const state = c.req.query('state') || '', codeChallenge = c.req.query('code_challenge') || null;
  if (clientId !== config.git.oidcClientId || redirectUri !== config.git.oidcRedirectUri || responseType !== 'code' || !state || !scope.split(/\s+/).includes('openid')) return oidcError(c, 400, 'invalid_request', 'The authorization request is invalid');
  if (codeChallenge && c.req.query('code_challenge_method') !== 'S256') return oidcError(c, 400, 'invalid_request', 'Only S256 PKCE is supported');
  const requestId = token();
  const request: AuthorizationRequest = { clientId, redirectUri, state, scope, nonce: c.req.query('nonce') || null, codeChallenge, expiresAt: Date.now() + 60_000 };
  storeTransient(challenges, hash(requestId), request);
  if (c.req.header('accept')?.includes('application/json')) {
    return c.json({ request_id: requestId, completion_url: `${config.git.oidcIssuer}/authorize/complete`, client_id: request.clientId, expires_at: Math.floor(request.expiresAt / 1000) });
  }
  return c.html(loginPage(requestId, request));
});

gitOidcRouter.post('/authorize/complete', async (c) => {
  noStore(c);
  const raw = await c.req.raw.clone().text(); let requestId = '';
  try { requestId = String(JSON.parse(raw)?.request_id || ''); } catch {}
  const request = challenges.get(hash(requestId)); challenges.delete(hash(requestId));
  if (!request || request.expiresAt <= Date.now()) return oidcError(c, 401, 'access_denied', 'The authorization request expired');
  const auth = c.req.header('authorization'); let event: any;
  try { event = auth?.startsWith('Nostr ') ? JSON.parse(Buffer.from(auth.slice(6), 'base64').toString()) : null; } catch {}
  const now = Math.floor(Date.now() / 1000), expiration = Number(singleTag(event, 'expiration'));
  let valid = false; try { valid = Boolean(event && verifyEvent(event)); } catch {}
  if (!valid || event.kind !== NIP98_KIND || singleTag(event, 'u') !== `${config.git.oidcIssuer}/authorize/complete` || singleTag(event, 'method') !== 'POST' || singleTag(event, 'payload') !== createHash('sha256').update(raw).digest('hex') || singleTag(event, 'nonce') !== requestId || singleTag(event, 'aud') !== request.clientId || Math.abs(now - Number(event.created_at)) > 60 || expiration !== Math.floor(request.expiresAt / 1000) || expiration <= now) return oidcError(c, 401, 'access_denied', 'The Nostr authorization proof is invalid');
  let signerNpub = ''; try { signerNpub = nip19.npubEncode(event.pubkey); } catch {}
  const actor = signerNpub ? await resolveForgejoLoginIdentity(signerNpub) : null;
  if (!actor) return oidcError(c, 403, 'access_denied', 'This Nostr identity is not allowed to sign in');
  const code = token();
  storeTransient(codes, hash(code), { ...request, authTime: now, actor });
  const redirect = new URL(request.redirectUri); redirect.searchParams.set('code', code); redirect.searchParams.set('state', request.state);
  return c.json({ redirect_to: redirect.toString() });
});

gitOidcRouter.post('/token', async (c) => {
  noStore(c);
  const form = new URLSearchParams(await c.req.text());
  if (!clientAuthenticated(c, form)) { c.header('www-authenticate', 'Basic realm="Tower OIDC"'); return oidcError(c, 401, 'invalid_client', 'Client authentication failed'); }
  const rawCode = form.get('code') || '', grant = codes.get(hash(rawCode)); codes.delete(hash(rawCode));
  if (form.get('grant_type') !== 'authorization_code' || !grant || grant.expiresAt <= Date.now() || form.get('redirect_uri') !== grant.redirectUri) return oidcError(c, 400, 'invalid_grant', 'The authorization code is invalid or expired');
  if (grant.codeChallenge && hash(form.get('code_verifier') || '') !== grant.codeChallenge) return oidcError(c, 400, 'invalid_grant', 'PKCE verification failed');
  const now = Math.floor(Date.now() / 1000), accessToken = token();
  storeTransient(accessTokens, hash(accessToken), { actor: grant.actor, clientId: grant.clientId, scope: grant.scope, expiresAt: Date.now() + 600_000 });
  const idToken = jwt({ iss: config.git.oidcIssuer, aud: grant.clientId, ...grant.actor, iat: now, exp: now + 600, auth_time: grant.authTime, ...(grant.nonce ? { nonce: grant.nonce } : {}) });
  return c.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 600, scope: grant.scope, id_token: idToken });
});

gitOidcRouter.get('/userinfo', (c) => {
  noStore(c);
  const auth = c.req.header('authorization'); const rawToken = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  const grant = rawToken ? accessTokens.get(hash(rawToken)) : null;
  if (!grant || grant.expiresAt <= Date.now()) { if (rawToken) accessTokens.delete(hash(rawToken)); c.header('www-authenticate', 'Bearer error="invalid_token"'); return oidcError(c, 401, 'invalid_token', 'The access token is invalid or expired'); }
  return c.json(grant.actor);
});
