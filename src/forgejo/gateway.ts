import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { GitCapabilityIntrospectionResponse, GitCapabilityScope, GitService } from '../types';
import { forgejoDisplayName, forgejoShadowUsername } from './identity';
import { sharingPage } from './sharing-page';

const canonicalGitPath = /^\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9._-]{0,62})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const untrustedIdentityHeaders = new Set(['x-webauth-user', 'x-webauth-email', 'x-webauth-fullname', 'x-forwarded-user', 'x-remote-user', 'x-gitea-user', 'x-forgejo-user', 'x-wingman-git-service-token', 'host', 'content-length']);
// Bun's fetch transparently decompresses upstream response bodies while
// retaining Content-Encoding. Forwarding that stale header makes browsers try
// to decompress already-decoded bytes. Content-Length is coupled to the
// encoded representation, so omit both and let the public proxy frame the
// streamed response.
const strippedResponseHeaders = new Set(['content-encoding', 'content-length', 'server', 'x-powered-by']);

export type GatewayOptions = { towerUrl: string; forgejoUrl: string; internalServiceToken: string; audience: string; browserOrigin?: string; fixedUsername?: string; fetchImpl?: typeof fetch };

function gatewayError(c: Context, status: number, code: string) { return c.json({ error: 'Git gateway request denied', code }, status as any); }
function basicAuthChallenge(c: Context) { c.header('WWW-Authenticate', 'Basic realm="Wingman Git", charset="UTF-8"'); return gatewayError(c, 401, 'git_capability_missing'); }
function parseBasicAuth(header: string | undefined, fixedUsername: string): string | null {
  if (!header?.startsWith('Basic ')) return null;
  try { const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); const separator = decoded.indexOf(':'); return separator >= 0 && decoded.slice(0, separator) === fixedUsername ? decoded.slice(separator + 1) || null : null; } catch { return null; }
}
function operation(c: Context, leaf: string): { service: GitService; scope: GitCapabilityScope } | null {
  const name = leaf === 'info/refs' ? c.req.query('service') : leaf;
  if (name === 'git-upload-pack') return { service: 'upload-pack', scope: 'git.fetch' };
  if (name === 'git-receive-pack') return { service: 'receive-pack', scope: 'git.push.unprotected' };
  return null;
}

export function createForgejoGateway(options: GatewayOptions) {
  const app = new Hono(), fetchImpl = options.fetchImpl ?? fetch;
  const towerUrl = options.towerUrl.replace(/\/+$/, ''), forgejoUrl = options.forgejoUrl.replace(/\/+$/, '');
  const browserOrigin = String(options.browserOrigin || '').replace(/\/+$/, ''), fixedUsername = options.fixedUsername || 'nostr';
  app.get('/health', (c) => c.json({ status: 'ok', component: 'tower-git-gateway' }));
  app.get('/ready', async (c) => {
    if (!towerUrl || !forgejoUrl || options.internalServiceToken.length < 32 || !options.audience || !/^https:\/\//.test(browserOrigin)) return gatewayError(c, 503, 'git_gateway_unconfigured');
    try { const [tower, forgejo] = await Promise.all([fetchImpl(`${towerUrl}/health`), fetchImpl(`${forgejoUrl}/api/healthz`)]); return tower.ok && forgejo.ok ? c.json({ status: 'ready' }) : gatewayError(c, 503, 'git_gateway_dependency_unavailable'); } catch { return gatewayError(c, 503, 'git_gateway_dependency_unavailable'); }
  });
  app.all('*', async (c) => {
    const url = new URL(c.req.url), gitMatch = canonicalGitPath.exec(url.pathname);
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(url.pathname); } catch { return gatewayError(c, 400, 'git_path_invalid'); }
    if (decodedPath !== url.pathname && (/\/settings\/collaboration(?:\/|$)/i.test(decodedPath)
      || /^\/org\/[^/]+\/teams(?:\/|$)/i.test(decodedPath) || /^\/api\//i.test(decodedPath))) {
      return gatewayError(c, 403, 'git_sharing_tower_required');
    }
    const sharing = /^\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9._-]{0,62})\/settings\/collaboration\/?$/.exec(url.pathname);
    if (sharing) {
      c.header('cache-control', 'no-store');
      c.header('x-frame-options', 'DENY');
      c.header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      if (c.req.method === 'GET') return c.html(sharingPage(sharing[1], sharing[2]));
      return gatewayError(c, 409, 'git_sharing_reload_required');
    }
    if (/^\/api\/v4\/git\/forgejo\/sharing\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,62}$/.test(url.pathname)) {
      if (!['GET', 'POST'].includes(c.req.method)) return gatewayError(c, 405, 'git_sharing_method_invalid');
      // Only a signed public request crosses this seam. No cookies, service token,
      // or caller-supplied forwarding/identity headers can become administrator intent.
      if (!c.req.header('authorization')?.startsWith('Nostr ')) return gatewayError(c, 401, 'nip98_auth_required');
      try {
        const origin = new URL(browserOrigin || url.origin);
        const headers = new Headers({ authorization: c.req.header('authorization')!, 'content-type': 'application/json',
          'x-forwarded-host': origin.host, 'x-forwarded-proto': origin.protocol.slice(0, -1) });
        const response = await fetchImpl(`${towerUrl}${url.pathname}${url.search}`, { method: c.req.method, headers,
          body: c.req.method === 'POST' ? await c.req.text() : undefined, redirect: 'manual' });
        return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      } catch { return gatewayError(c, 503, 'git_authority_unavailable'); }
    }
    // Native provider sharing writes cannot bypass Tower through old tabs,
    // alternate collaboration actions, organization team forms, or REST APIs.
    if (/\/settings\/collaboration(?:\/|$)/i.test(url.pathname)
      || (!['GET', 'HEAD'].includes(c.req.method) && /^\/org\/[^/]+\/teams(?:\/|$)/i.test(url.pathname))
      || /^\/api\//i.test(url.pathname)) return gatewayError(c, 403, 'git_sharing_tower_required');
    if (!gitMatch) {
      if (/\.git(?:\/|$)/.test(url.pathname)) return gatewayError(c, 404, 'git_repository_not_found');
      const repoPath = /^\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9._-]{0,62})(?:\/|$)/i.exec(decodedPath.toLowerCase());
      const providerRoots = new Set(['user', 'org', 'assets', 'avatar', 'avatars', 'attachments', 'repo', 'explore', 'notifications']);
      if (repoPath && !providerRoots.has(repoPath[1])) {
        try {
          const resolved = await fetchImpl(`${towerUrl}/api/v4/git/internal/forgejo/resolve?owner=${encodeURIComponent(repoPath[1])}&repository=${encodeURIComponent(repoPath[2])}`, {
            headers: { 'x-wingman-git-service-token': options.internalServiceToken },
          });
          if (!resolved.ok) return gatewayError(c, resolved.status === 404 ? 404 : 503, 'git_repository_not_found');
          if (!(await resolved.json() as any).ready) return gatewayError(c, 503, 'git_reconciliation_stale');
        } catch { return gatewayError(c, 503, 'git_authority_unavailable'); }
      }
      return proxyBrowserRequest(c, url, forgejoUrl, fetchImpl);
    }
    const requestedOperation = operation(c, gitMatch[3]);
    if (!requestedOperation || (gitMatch[3] === 'info/refs' ? c.req.method !== 'GET' : c.req.method !== 'POST')) return gatewayError(c, 400, 'git_service_invalid');
    const capability = parseBasicAuth(c.req.header('authorization'), fixedUsername); if (!capability) return basicAuthChallenge(c);
    const correlationId = randomUUID();
    try {
      const bindingResponse = await fetchImpl(`${towerUrl}/api/v4/git/internal/forgejo/resolve?owner=${encodeURIComponent(gitMatch[1])}&repository=${encodeURIComponent(gitMatch[2])}`, { headers: { 'x-wingman-git-service-token': options.internalServiceToken } });
      if (!bindingResponse.ok) return gatewayError(c, bindingResponse.status === 404 ? 404 : 503, 'git_reconciliation_unavailable');
      const binding = await bindingResponse.json() as any; if (!binding.ready) return gatewayError(c, 503, 'git_reconciliation_stale');
      const response = await fetchImpl(`${towerUrl}/api/v4/git/internal/capabilities/introspect`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wingman-git-service-token': options.internalServiceToken }, body: JSON.stringify({ capability, repository_id: binding.repository_id, audience: options.audience, service: requestedOperation.service, required_scope: requestedOperation.scope, correlation_id: correlationId }) });
      if (!response.ok) return gatewayError(c, 503, 'git_authority_unavailable');
      const introspection = await response.json() as GitCapabilityIntrospectionResponse;
      if (!introspection.active || !introspection.actor_id) return gatewayError(c, 403, introspection.reason_code || 'git_capability_inactive');
      return proxyCapabilityRequest(c, url, forgejoUrl, fetchImpl, introspection.actor_username || forgejoShadowUsername(introspection.actor_id), introspection.actor_display_name, correlationId);
    } catch { return gatewayError(c, 503, 'git_gateway_dependency_unavailable'); }
  });
  return app;
}

async function proxyBrowserRequest(c: Context, url: URL, forgejoUrl: string, fetchImpl: typeof fetch) {
  try {
    const headers = new Headers(); for (const [name, value] of c.req.raw.headers.entries()) if (!untrustedIdentityHeaders.has(name.toLowerCase())) headers.set(name, value);
    headers.set('accept-encoding', 'identity');
    const upstream = await fetchImpl(`${forgejoUrl}${url.pathname}${url.search}`, { method: c.req.method, headers, body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body, redirect: 'manual', duplex: 'half' } as RequestInit);
    const responseHeaders = new Headers(); for (const [name, value] of upstream.headers.entries()) if (!strippedResponseHeaders.has(name.toLowerCase())) responseHeaders.append(name, value);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch { return gatewayError(c, 503, 'git_gateway_dependency_unavailable'); }
}

async function proxyCapabilityRequest(c: Context, url: URL, forgejoUrl: string, fetchImpl: typeof fetch, username: string, displayName: string | undefined, correlationId: string) {
  try {
    const headers = new Headers(); for (const [name, value] of c.req.raw.headers.entries()) if (!untrustedIdentityHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'authorization' && name.toLowerCase() !== 'cookie') headers.set(name, value);
    headers.set('accept-encoding', 'identity');
    headers.set('x-webauth-user', username); const fullName = forgejoDisplayName(displayName); if (fullName) headers.set('x-webauth-fullname', fullName); headers.set('x-wingman-correlation-id', correlationId);
    const upstream = await fetchImpl(`${forgejoUrl}${url.pathname}${url.search}`, { method: c.req.method, headers, body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body, redirect: 'manual', duplex: 'half' } as RequestInit);
    const responseHeaders = new Headers(); for (const [name, value] of upstream.headers.entries()) if (!strippedResponseHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') responseHeaders.append(name, value); responseHeaders.set('x-wingman-correlation-id', correlationId);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch { return gatewayError(c, 503, 'git_gateway_dependency_unavailable'); }
}
