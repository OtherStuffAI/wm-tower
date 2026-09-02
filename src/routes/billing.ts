import { Hono } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { config } from '../config';
import {
  createWorkspaceCreditPurchase,
  getInsufficientCreditsBlock,
  getWorkspaceBillingDetails,
  getWorkspaceBillingStatus,
  listWorkspaceBillingStatuses,
  listWorkspaceCreditTransactions,
  refreshWorkspaceCreditOrderStatus,
} from '../services/billing';
import { canManageWorkspace, listWorkspacesForMember } from '../services/workspaces';
import { measureWorkspaceUsage } from '../services/usage';
import {
  buildWorkspaceAppNamespaceDescriptor,
  buildWorkspaceAppConnectionDetails,
  createWorkspaceApp,
  getWorkspaceApp,
  listWorkspaceAppSchemaManifests,
  listWorkspaceApps,
  publishWorkspaceAppSchemaManifest,
} from '../services/workspace-apps';
import {
  listWorkspaceRecordFamilyMetadata,
  listWorkspaceRecordMetadata,
  listWorkspaceStorageMetadata,
} from '../services/workspace-inspection';

export const billingRouter = new Hono();
export const workspaceBillingRouter = new Hono();

function normalizeLimit(value: string | undefined): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

async function requireWorkspaceManager(c: any, workspaceOwnerNpub: string, userNpub: string) {
  if (!workspaceOwnerNpub) return c.json({ error: 'workspaceOwnerNpub path param required' }, 400);
  if (!(await canManageWorkspace(workspaceOwnerNpub, userNpub))) {
    return c.json({ error: 'Not authorized to manage this workspace' }, 403);
  }
  return null;
}

billingRouter.get('/workspaces', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const visible = await listWorkspacesForMember(auth.userNpub);
  const manageable: string[] = [];
  for (const workspace of visible) {
    if (await canManageWorkspace(workspace.workspace_owner_npub, auth.userNpub)) {
      manageable.push(workspace.workspace_owner_npub);
    }
  }
  const workspaces = await listWorkspaceBillingStatuses(manageable);
  return c.json({ billing_mode: config.billing.mode, workspaces });
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/billing/status', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  const status = await getWorkspaceBillingStatus(workspaceOwnerNpub);
  if (!status) return c.json({ error: 'workspace not found' }, 404);
  return c.json(status);
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/billing', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  const details = await getWorkspaceBillingDetails(workspaceOwnerNpub);
  if (!details) return c.json({ error: 'workspace not found' }, 404);
  return c.json(details);
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/billing/transactions', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  const transactions = await listWorkspaceCreditTransactions(workspaceOwnerNpub, normalizeLimit(c.req.query('limit')));
  return c.json({ workspace_owner_npub: workspaceOwnerNpub, transactions });
});

workspaceBillingRouter.post('/:workspaceOwnerNpub/billing/purchase', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  const body = await c.req.json<{ quantity_credits?: number }>().catch(() => null);
  const quantityCredits = Number(body?.quantity_credits);
  try {
    const order = await createWorkspaceCreditPurchase(workspaceOwnerNpub, auth.userNpub, quantityCredits);
    return c.json({
      order_id: order.id,
      mginx_order_id: order.mginx_order_id,
      product_id: order.product_id,
      quantity_credits: order.quantity_credits,
      amount_sats: order.amount_sats,
      invoice: order.bolt11,
      bolt11: order.bolt11,
      status: order.status,
      expires_at: (order as any).expires_at || null,
      created_at: order.created_at,
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create purchase';
    const status = ['BAD_QUANTITY', 'BILLING_DISABLED'].includes((error as any)?.code) ? 400 : 502;
    return c.json({ error: message }, status);
  }
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/billing/orders/:orderId/status', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const orderId = String(c.req.param('orderId') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  const order = await refreshWorkspaceCreditOrderStatus(workspaceOwnerNpub, orderId);
  if (!order) return c.json({ error: 'order not found' }, 404);
  return c.json({
    order_id: order.id,
    mginx_order_id: order.mginx_order_id,
    product_id: order.product_id,
    status: order.status,
    quantity_credits: order.quantity_credits,
    amount_sats: order.amount_sats,
    invoice: order.bolt11,
    bolt11: order.bolt11,
    expires_at: null,
    created_at: order.created_at,
    paid_at: order.paid_at,
    updated_at: order.updated_at,
  });
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/usage', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  return c.json(await measureWorkspaceUsage(workspaceOwnerNpub));
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/records/metadata', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  return c.json(await listWorkspaceRecordMetadata(workspaceOwnerNpub, {
    limit: Number.parseInt(String(c.req.query('limit') || ''), 10),
    offset: Number.parseInt(String(c.req.query('offset') || ''), 10),
    record_family_hash: c.req.query('record_family_hash') || undefined,
  }));
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/records/families', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  return c.json(await listWorkspaceRecordFamilyMetadata(workspaceOwnerNpub));
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/storage/metadata', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  const publicQuery = c.req.query('public');
  const completedQuery = c.req.query('completed');
  const boolValue = (value: string | undefined): boolean | undefined => {
    if (value === undefined) return undefined;
    return /^(1|true|yes)$/i.test(value);
  };

  return c.json(await listWorkspaceStorageMetadata(workspaceOwnerNpub, {
    limit: Number.parseInt(String(c.req.query('limit') || ''), 10),
    offset: Number.parseInt(String(c.req.query('offset') || ''), 10),
    public: boolValue(publicQuery),
    completed: boolValue(completedQuery),
  }));
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/apps', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  return c.json({ workspace_owner_npub: workspaceOwnerNpub, apps: await listWorkspaceApps(workspaceOwnerNpub) });
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/app-schemas', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  if (!workspaceOwnerNpub) return c.json({ error: 'workspaceOwnerNpub path param required' }, 400);

  const visible = await listWorkspacesForMember(auth.userNpub);
  if (!visible.some((workspace) => workspace.workspace_owner_npub === workspaceOwnerNpub)) {
    return c.json({ error: 'Not authorized for this workspace' }, 403);
  }

  const latest = !/^(0|false|no)$/i.test(String(c.req.query('latest') || 'true'));
  const appNpub = String(c.req.query('app_npub') || '').trim() || undefined;
  const schemas = await listWorkspaceAppSchemaManifests(workspaceOwnerNpub, auth.userNpub, {
    app_npub: appNpub,
    latest,
  });
  return c.json({ workspace_owner_npub: workspaceOwnerNpub, schemas });
});

workspaceBillingRouter.post('/:workspaceOwnerNpub/apps', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  const body = await c.req.json<{ app_npub?: string; app_name?: string; capabilities?: unknown; enabled?: boolean }>().catch(() => null);
  const appNpub = String(body?.app_npub || '').trim();
  if (!appNpub) return c.json({ error: 'app_npub required' }, 400);

  const app = await createWorkspaceApp(workspaceOwnerNpub, appNpub, String(body?.app_name || '').trim(), auth.userNpub, {
    capabilities: body?.capabilities,
    enabled: body?.enabled,
  });
  return c.json({ workspace_owner_npub: workspaceOwnerNpub, app }, 201);
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/apps/:appNpub/descriptor', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const appNpub = String(c.req.param('appNpub') || '').trim();
  if (!workspaceOwnerNpub) return c.json({ error: 'workspaceOwnerNpub path param required' }, 400);
  if (!appNpub) return c.json({ error: 'appNpub path param required' }, 400);

  const visible = await listWorkspacesForMember(auth.userNpub);
  if (!visible.some((workspace) => workspace.workspace_owner_npub === workspaceOwnerNpub)) {
    return c.json({ error: 'Not authorized for this workspace' }, 403);
  }

  const descriptor = await buildWorkspaceAppNamespaceDescriptor(workspaceOwnerNpub, appNpub);
  return c.json({ viewer: auth.userNpub, descriptor });
});

workspaceBillingRouter.get('/:workspaceOwnerNpub/apps/:appNpub/schemas', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const appNpub = String(c.req.param('appNpub') || '').trim();
  if (!workspaceOwnerNpub) return c.json({ error: 'workspaceOwnerNpub path param required' }, 400);
  if (!appNpub) return c.json({ error: 'appNpub path param required' }, 400);

  const visible = await listWorkspacesForMember(auth.userNpub);
  if (!visible.some((workspace) => workspace.workspace_owner_npub === workspaceOwnerNpub)) {
    return c.json({ error: 'Not authorized for this workspace' }, 403);
  }

  const latest = !/^(0|false|no)$/i.test(String(c.req.query('latest') || 'false'));
  const schemas = await listWorkspaceAppSchemaManifests(workspaceOwnerNpub, auth.userNpub, {
    app_npub: appNpub,
    latest,
  });
  return c.json({ workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, schemas });
});

workspaceBillingRouter.post('/:workspaceOwnerNpub/apps/:appNpub/schemas', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const appNpub = String(c.req.param('appNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;
  if (!appNpub) return c.json({ error: 'appNpub path param required' }, 400);

  const body = await c.req.json<{
    app_name?: string;
    schema_hash?: string;
    schema_version?: number;
    capabilities?: unknown;
    record_families?: unknown;
    owner_payload?: { ciphertext?: string };
    group_payloads?: any[];
  }>().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required' }, 400);

  try {
    const schema = await publishWorkspaceAppSchemaManifest(workspaceOwnerNpub, appNpub, {
      app_name: body.app_name,
      schema_hash: String(body.schema_hash || '').trim(),
      schema_version: body.schema_version,
      capabilities: body.capabilities,
      record_families: body.record_families,
      owner_payload: { ciphertext: String(body.owner_payload?.ciphertext || '').trim() },
      group_payloads: Array.isArray(body.group_payloads) ? body.group_payloads : [],
    }, auth.userNpub);
    return c.json({ workspace_owner_npub: workspaceOwnerNpub, app_npub: appNpub, schema }, 201);
  } catch (error) {
    const code = (error as any)?.code;
    const status = code === 'BAD_SCHEMA_INPUT' || code === 'BAD_SCHEMA_GROUP' ? 400 : 500;
    return c.json({ error: error instanceof Error ? error.message : 'Failed to publish app schema' }, status);
  }
});

async function appConnectionTokenResponse(c: any) {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  const appNpub = String(c.req.param('appNpub') || '').trim();
  const authError = await requireWorkspaceManager(c, workspaceOwnerNpub, auth.userNpub);
  if (authError) return authError;

  const billingBlock = await getInsufficientCreditsBlock(workspaceOwnerNpub);
  if (billingBlock) return c.json(billingBlock, 402);

  const app = await getWorkspaceApp(workspaceOwnerNpub, appNpub);
  if (!app) return c.json({ error: 'workspace app not found' }, 404);
  const relayUrls = c.req.query('relay')
    ? [String(c.req.query('relay')).trim()].filter(Boolean)
    : [];
  const details = await buildWorkspaceAppConnectionDetails(workspaceOwnerNpub, appNpub, relayUrls);
  return c.json({ viewer: auth.userNpub, app, ...details });
}

workspaceBillingRouter.get('/:workspaceOwnerNpub/apps/:appNpub/connection-token', appConnectionTokenResponse);
workspaceBillingRouter.post('/:workspaceOwnerNpub/apps/:appNpub/connection-token', appConnectionTokenResponse);
