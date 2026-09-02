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
import { gitRouter } from './routes/git';
import { gitOidcRouter } from './routes/git-oidc';
import { recordsRouter } from './routes/records';
import { storageRouter } from './routes/storage';
import { streamRouter } from './routes/stream';
import { userRouter } from './routes/user';
import { workspacesRouter } from './routes/workspaces';
import { wappActivityFlightDeckRouter, wappActivityPublisherRouter } from './routes/wapp-activity';
import { wappManagementRouter } from './routes/wapp-management';

export function createApp() {
  const app = new Hono();

  app.use('*', cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'Authorization', 'x-wingman-workspace-owner', 'x-flightdeck-pg-app-npub', 'x-wingman-git-service-token'],
    exposeHeaders: ['x-wingman-stale-version'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      service_npub: config.service.npub || null,
      build: getTowerBuildInfo(),
      sse_connections: sseHub.getClientCount(),
      graph: {
        enabled: Boolean(config.graph?.enabled),
        allowed_npubs_configured: (config.graph?.allowedNpubs?.length || 0) > 0,
      },
      git: {
        authority_configured: Boolean(config.git.capabilityHashKey && config.git.internalServiceToken && config.git.audience),
        forgejo_webhook_configured: Boolean(config.git.forgejoWebhookSecret && config.git.forgejoWebhookUrl),
        gateway_separate_process: true,
      },
    });
  });
  app.get('/version', (c) => c.json(getTowerBuildInfo()));
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

  app.route('/api/v4/groups', groupsRouter);
  app.route('/api/v4/git/oidc', gitOidcRouter);
  app.route('/api/v4/git', gitRouter);
  app.route('/api/v4/graph', graphRouter);
  app.route('/api/v4/billing', billingRouter);
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

  return app;
}
