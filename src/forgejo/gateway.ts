import { Hono } from 'hono';

export type GatewayOptions = { forgejoUrl: string; publicOrigin?: string; fetchImpl?: typeof fetch };
const stripped = ['host', 'connection', 'content-length', 'x-webauth-user', 'x-webauth-email', 'x-webauth-fullname', 'x-forwarded-user', 'x-remote-user', 'x-gitea-user', 'x-forgejo-user', 'x-wingman-git-service-token'];

/** Stock reverse proxy only. Forgejo evaluates every native token and permission. */
export function createForgejoGateway(options: GatewayOptions) {
  const upstream = new URL(options.forgejoUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== '/') throw new Error('Forgejo upstream must be an HTTP origin without credentials');
  const publicOrigin = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  if (publicOrigin && (!['http:', 'https:'].includes(publicOrigin.protocol) || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash)) throw new Error('Forgejo public origin must be an HTTP origin without credentials');
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', component: 'forgejo-native-proxy' }));
  app.all('*', async (c) => {
    const incoming = new URL(c.req.url);
    const target = new URL(upstream);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers = new Headers(c.req.raw.headers);
    for (const name of stripped) headers.delete(name);
    // Preserve the public authority for stock Forgejo's Origin/Host CSRF check.
    // The upstream URL controls routing, not the user-facing request authority.
    headers.set('host', publicOrigin?.host ?? incoming.host);
    // Never follow provider redirects with client cookies or Authorization.
    const response = await (options.fetchImpl ?? fetch)(target, {
      method: c.req.method, headers, redirect: 'manual',
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
      duplex: 'half',
    } as RequestInit);
    const outgoing = new Headers(response.headers);
    for (const name of ['content-encoding', 'content-length', 'connection']) outgoing.delete(name);
    return new Response(response.body, { status: response.status, headers: outgoing });
  });
  return app;
}
