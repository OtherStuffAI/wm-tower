import { requireNip98AuthResolved } from './auth';
import { hostingBillingRouter } from './routes/hosting-billing';
import { hostingWriteBlock, stripeAvailability } from './services/hosting-billing';
import { blossomRouter } from './routes/blossom';
import { driveRouter } from './routes/drive';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getTowerBuildInfo } from './build-info';
import { config } from './config';
import { buildAdminInterfaceHtml, buildDocsHtml, buildOpenApiDocument, buildSuperbasedDashboardHtml, buildTableViewerHtml } from './openapi';
import { sseHub } from './sse-hub';
import { adminRouter } from './routes/admin';
import { appDbRouter } from './routes/app-db';
import { billingRouter, workspaceBillingRouter } from './routes/billing';
import { flightDeckPgRouter } from './routes/flightdeck-pg';
import { groupsRouter } from './routes/groups';
import { graphRouter } from './routes/graph';
import { learningRouter } from './routes/learning';
import { gitOidcRouter } from './routes/git-oidc';
import { recordsRouter } from './routes/records';
import { storageRouter } from './routes/storage';
import { streamRouter } from './routes/stream';
import { userRouter } from './routes/user';
import { workspacesRouter } from './routes/workspaces';
import { wappActivityFlightDeckRouter, wappActivityPublisherRouter } from './routes/wapp-activity';
import { wappManagementRouter } from './routes/wapp-management';
import { buildNstackServiceDiscovery } from './services/nstack-discovery';

export function createApp() {
  const app = new Hono();

  app.use('*', cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'Authorization', 'x-wingman-workspace-owner', 'x-flightdeck-pg-app-npub', 'x-wingman-git-service-token', 'x-learning-grant-id', 'Range', 'If-Range', '*'],
    exposeHeaders: ['x-wingman-stale-version', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'],
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      service_npub: config.service.npub || null,
      build: getTowerBuildInfo(),
      sse_connections: sseHub.getClientCount(),
      hosting_billing: { version: 1, runner: 'embedded_db_locked', stripe: stripeAvailability() },
      graph: {
        enabled: Boolean(config.graph?.enabled),
        allowed_npubs_configured: (config.graph?.allowedNpubs?.length || 0) > 0,
      },
      git: {
        authentication_only: true,
        oidc_configured: Boolean(config.git.oidcIssuer && config.git.oidcAllowedNpubs.length),
      },
    });
  });
  app.get('/version', (c) => c.json(getTowerBuildInfo()));
  app.get('/.well-known/nstack.json', async (c) => {
    const descriptor = await buildNstackServiceDiscovery();
    c.header('Cache-Control', `public, max-age=${descriptor.cache_ttl_seconds}, stale-if-error=${descriptor.cache_ttl_seconds * 2}`);
    c.header('X-Content-Type-Options', 'nosniff');
    return c.json(descriptor);
  });
  app.get('/openapi.json', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(buildOpenApiDocument(origin));
  });
  app.get('/docs', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.html(buildDocsHtml(origin));
  });
  app.get('/admin', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.html(buildAdminInterfaceHtml(origin));
  });
  app.get('/table-viewer', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.html(buildTableViewerHtml(origin));
  });
  app.get('/ui', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.html(buildSuperbasedDashboardHtml(origin));
  });

  // Shared exhaustion boundary applies to all UUID PG/Drive/WApp mutations. Reads, export and payments remain accessible.
  const hostedWriteBoundary: import('hono').MiddlewareHandler = async (c, next) => {
    if (!['GET','HEAD','OPTIONS'].includes(c.req.method)) {
      if (!/^[0-9a-f-]{36}$/i.test(c.req.param('workspaceId')!)) return c.json({error:'Invalid workspace UUID'},400);
      const auth = await requireNip98AuthResolved(c);
      if (auth instanceof Response) return auth;
      const block = await hostingWriteBlock(c.req.param('workspaceId')!);
      if (block) return c.json(block, 402);
    }
    await next();
  };
  app.use('/api/v4/flightdeck-pg/workspaces/:workspaceId/*', hostedWriteBoundary);
  app.use('/api/v4/flightdeck-pg/workspaces/:workspaceId', hostedWriteBoundary);
  app.use('/api/v4/wapp-activity/workspaces/:workspaceId/*', hostedWriteBoundary);
  app.route('/api/v4/hosting-billing', hostingBillingRouter);
  app.route('/api/v4/groups', groupsRouter);
  app.route('/api/v4/git/oidc', gitOidcRouter);
  // Legacy Git authority endpoints are retired. Forgejo owns all authorization.
  app.all('/api/v4/git/*', (c) => c.json({ error: 'retired', message: 'Use native Forgejo Git and API endpoints' }, 410));
  app.route('/api/v4/graph', graphRouter);
  app.route('/api/v4/learning', learningRouter);
  app.route('/api/v4/billing', billingRouter);
  app.route('/api/v4/flightdeck-pg', driveRouter);
  app.route('/api/v4/flightdeck-pg', flightDeckPgRouter);
  app.route('/api/v4/flightdeck-pg', wappActivityFlightDeckRouter);
  app.route('/api/v4/flightdeck-pg', wappManagementRouter);
  app.route('/api/v4/wapp-activity', wappActivityPublisherRouter);
  app.route('/api/v4/workspaces', workspacesRouter);
  app.route('/api/v4/workspaces', workspaceBillingRouter);
  app.route('/api/v4/workspaces', appDbRouter);
  app.route('/api/v4/records', recordsRouter);
  app.route('/api/v4/storage', storageRouter);
  app.route('/api/v4/workspaces', streamRouter);
  app.route('/api/v4/user', userRouter);
  app.route('/api/v4/admin', adminRouter);

  app.route('/', blossomRouter);

  return app;
}
