import type { Context, Hono } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { getDb } from '../db';
import { buildFlightDeckPgIdentity, resolveFlightDeckPgRequestContext } from '../services/flightdeck-pg-api';
import { authorizeFlightDeckPgOperation, resolveFlightDeckPgWorkspace } from '../services/flightdeck-pg-authorization';
import { NotificationError, UUID_RE, inboxApiEnabled, isUuid, type Sql } from '../services/notification-core';
import {
  ITEM_VIEWS, bulkMutate, getCounts, getItem, getRulesState, listCategories, listChanges, listItems, patchItem, putRules,
  type BulkOp, type RuleInput,
} from '../services/notification-inbox';
import {
  getProducerEvent, grantSummary, ingestProducerEvent, listSources, resolveProducerGrant, setSourceStatus, upsertSource, type SourceInput,
} from '../services/notification-producers';
import {
  parseApnsInput, parseInstallationInput, putApnsTransport, putInstallation, removeEnrollment, revokeTransport,
} from '../services/notification-registry';
import { queueStats } from '../services/notification-worker';

const MAX_BODY = 16 * 1024;

type Identity = ReturnType<typeof buildFlightDeckPgIdentity>;

function fail(c: Context, identity: Identity | null, error: NotificationError) {
  const headers: Record<string, string> = {};
  if (error.code === 'rate_limited') headers['Retry-After'] = String(error.extra.retry_after ?? 60);
  return c.json({ error: error.message, code: error.code, status: error.status, identity, ...error.extra }, error.status as 400, headers);
}

async function readBody(c: Context): Promise<{ raw: string; body: Record<string, any> }> {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > MAX_BODY) throw new NotificationError(413, 'payload_too_large', 'Body exceeds 16 KiB');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new NotificationError(400, 'validation_error', 'body must be valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NotificationError(400, 'validation_error', 'body must be a JSON object');
  return { raw, body: body as Record<string, any> };
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], path = 'body') {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new NotificationError(400, 'validation_error', `${path}.${key} is not allowed`);
}

function queryKeys(c: Context, allowed: string[]) {
  for (const key of Object.keys(c.req.query())) if (!allowed.includes(key)) throw new NotificationError(400, 'validation_error', `unknown query parameter ${key}`);
}

function intParam(c: Context, name: string, fallback: number, min: number, max: number) {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^-?\d+$/.test(raw) || value < min || value > max) throw new NotificationError(400, 'validation_error', `${name} must be an integer between ${min} and ${max}`);
  return value;
}

/** Consumer routes: actor comes only from verified NIP-98 and an active workspace membership. */
type ConsumerCtx = { c: Context; sql: Sql; identity: Identity; workspaceId: string; actorId: string; role: string; userNpub: string; signerNpub: string; appNpub: string };
function consumer(handler: (ctx: ConsumerCtx) => Promise<Response>, options: { sensitiveErrors?: boolean } = {}) {
  return async (c: Context) => {
    c.header('Cache-Control', 'private, no-store');
    let identity: Identity | null = null;
    try {
      const auth = await requireNip98AuthResolved(c);
      if (auth instanceof Response) return auth;
      const workspaceId = c.req.param('workspaceId') ?? '';
      if (!UUID_RE.test(workspaceId)) throw new NotificationError(400, 'validation_error', 'invalid workspace id');
      const sql = getDb();
      const context = await resolveFlightDeckPgRequestContext({ workspaceId, actorNpub: auth.userNpub }, sql);
      identity = buildFlightDeckPgIdentity(context.workspace, context.workspace?.app_npub ?? '');
      if (!context.workspace) throw new NotificationError(404, 'workspace_not_found', 'Flight Deck PG workspace not found');
      if (!context.actor || !context.membership) throw new NotificationError(403, 'workspace_membership_required', 'Actor is not a member of this Flight Deck PG workspace');
      if (!inboxApiEnabled()) throw new NotificationError(404, 'notifications_not_enabled', 'Notification inbox is not enabled on this Tower');
      return await handler({ c, sql, identity, workspaceId: context.workspace.id, actorId: context.actor.id, role: context.membership.role, userNpub: auth.userNpub, signerNpub: auth.signerNpub, appNpub: context.workspace.app_npub });
    } catch (error) {
      if (error instanceof NotificationError) return fail(c, identity, error);
      if (options.sensitiveErrors) return failSensitive(c, identity, error);
      throw error;
    }
  };
}

/**
 * Unexpected failure on a route that handles raw device tokens/addresses. Database driver errors can carry the query,
 * bound parameters or detail text, and the default error handler logs the whole error, so never pass it on: log a
 * constant message plus the sanitized SQLSTATE only and answer with a generic 500.
 */
function failSensitive(c: Context, identity: Identity | null, error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  console.error('push registration failed', typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? { sqlstate: code } : {});
  return fail(c, identity, new NotificationError(500, 'push_registration_failed', 'Push registration failed'));
}

/** Push registry routes: consumer routes whose unexpected errors are never logged or returned verbatim. */
const pushConsumer = (handler: (ctx: ConsumerCtx) => Promise<Response>) => consumer(handler, { sensitiveErrors: true });

/**
 * Source/queue administration needs the EFFECTIVE `workspace.manage` permission (direct, group or role grants through the
 * central authorizer). Membership role alone is not authority; there is no owner/admin fallback. Error shape matches the
 * Flight Deck PG authorizationError.
 */
async function requireWorkspaceManage(ctx: Pick<ConsumerCtx, 'userNpub' | 'appNpub' | 'workspaceId'>) {
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: ctx.userNpub, appNpub: ctx.appNpub, workspaceId: ctx.workspaceId, permission: 'workspace.manage', resource: { type: 'workspace' },
  });
  if (decision.allowed) return;
  const extra = { required_permission: 'workspace.manage' };
  if (decision.category === 'auth-error') throw new NotificationError(401, decision.reason, 'Flight Deck PG authentication failed', extra);
  if (decision.category === 'validation-error') throw new NotificationError(400, decision.reason, 'Flight Deck PG authorization request is invalid', extra);
  throw new NotificationError(403, 'permission_denied', 'Actor does not have the required Flight Deck PG permission', { reason: decision.reason, ...extra });
}

const OPS: BulkOp[] = ['mark_read', 'mark_unread', 'dismiss', 'archive', 'unarchive'];
const SLUG = /^[a-z*][a-z0-9_.*-]{0,63}$/;
/** A concrete client application slug for view filtering ('*' is not a client). */
const CLIENT_SLUG = /^[a-z][a-z0-9_.-]{0,63}$/;
function clientAppParam(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CLIENT_SLUG.test(value)) throw new NotificationError(400, 'validation_error', `${path} must be a client app slug`);
  return value;
}

export function registerNotificationRoutes(router: Hono) {
  const base = '/workspaces/:workspaceId/notifications';

  router.get(`${base}/items`, consumer(async ({ c, sql, identity, workspaceId, actorId }) => {
    queryKeys(c, ['view', 'category', 'source_app_id', 'client_app_id', 'limit', 'cursor', 'installation_id']);
    const view = (c.req.query('view') ?? 'inbox') as typeof ITEM_VIEWS[number];
    if (!ITEM_VIEWS.includes(view)) throw new NotificationError(400, 'validation_error', `view must be one of ${ITEM_VIEWS.join(', ')}`);
    const page = await listItems(sql, { workspaceId, actorId }, {
      view, category: c.req.query('category') || undefined, sourceAppId: c.req.query('source_app_id') || undefined,
      clientAppId: clientAppParam(c.req.query('client_app_id'), 'client_app_id'),
      limit: intParam(c, 'limit', 50, 1, 100), cursor: c.req.query('cursor') || undefined,
    });
    return c.json({ identity, ...page });
  }));

  router.get(`${base}/items/:id`, consumer(async ({ c, sql, identity, workspaceId, actorId }) => {
    queryKeys(c, []);
    return c.json({ identity, item: await getItem(sql, { workspaceId, actorId }, c.req.param('id')!) });
  }));

  router.get(`${base}/changes`, consumer(async ({ c, sql, identity, workspaceId, actorId }) => {
    queryKeys(c, ['after_seq', 'limit', 'client_app_id', 'rules_revision']);
    const afterSeq = intParam(c, 'after_seq', 0, 0, Number.MAX_SAFE_INTEGER);
    const rulesRevision = c.req.query('rules_revision') === undefined ? undefined : intParam(c, 'rules_revision', 0, 0, Number.MAX_SAFE_INTEGER);
    return c.json({ identity, ...(await listChanges(sql, { workspaceId, actorId }, afterSeq, intParam(c, 'limit', 200, 1, 200), {
      clientAppId: clientAppParam(c.req.query('client_app_id'), 'client_app_id'), rulesRevision,
    })) });
  }));

  router.get(`${base}/counts`, consumer(async ({ c, sql, identity, workspaceId, actorId }) => {
    queryKeys(c, ['installation_id', 'client_app_id']);
    return c.json({ identity, ...(await getCounts(sql, { workspaceId, actorId }, { clientAppId: clientAppParam(c.req.query('client_app_id'), 'client_app_id') })) });
  }));

  router.patch(`${base}/items/:id`, consumer(async ({ c, sql, identity, workspaceId, actorId }) => {
    const { body } = await readBody(c);
    onlyKeys(body, ['mutation_id', 'expected_row_version', 'observed_change_seq', 'patch']);
    if (!isUuid(body.mutation_id)) throw new NotificationError(400, 'validation_error', 'mutation_id must be a UUID');
    if (!Number.isInteger(body.expected_row_version) || body.expected_row_version < 1) throw new NotificationError(400, 'validation_error', 'expected_row_version must be a positive integer');
    if (body.observed_change_seq !== undefined && (!Number.isInteger(body.observed_change_seq) || body.observed_change_seq < 0)) throw new NotificationError(400, 'validation_error', 'observed_change_seq must be a non-negative integer');
    const patch = body.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new NotificationError(400, 'validation_error', 'patch is required');
    onlyKeys(patch, ['read', 'dismissed', 'archived'], 'patch');
    const keys = Object.keys(patch);
    if (!keys.length || !keys.every((k) => typeof patch[k] === 'boolean')) throw new NotificationError(400, 'validation_error', 'patch needs at least one boolean of read, dismissed, archived');
    const id = c.req.param('id')!;
    if (!isUuid(id)) throw new NotificationError(404, 'notification_not_found', 'Notification not found');
    return c.json({ identity, ...(await patchItem(sql, { workspaceId, actorId }, {
      id, mutationId: body.mutation_id, expectedRowVersion: body.expected_row_version, observedChangeSeq: body.observed_change_seq, patch,
    })) });
  }));

  router.post(`${base}/bulk`, consumer(async ({ c, sql, identity, workspaceId, actorId }) => {
    const { body } = await readBody(c);
    onlyKeys(body, ['mutation_id', 'op', 'selector']);
    if (!isUuid(body.mutation_id)) throw new NotificationError(400, 'validation_error', 'mutation_id must be a UUID');
    if (!OPS.includes(body.op)) throw new NotificationError(400, 'validation_error', `op must be one of ${OPS.join(', ')}`);
    const selector = body.selector;
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new NotificationError(400, 'validation_error', 'selector is required');
    onlyKeys(selector, ['ids', 'up_to_seq', 'view', 'category', 'source_app_id', 'client_app_id'], 'selector');
    const hasIds = selector.ids !== undefined;
    if (hasIds === (selector.up_to_seq !== undefined)) throw new NotificationError(400, 'validation_error', 'selector needs exactly one of ids or up_to_seq');
    if (hasIds && (!Array.isArray(selector.ids) || selector.ids.length < 1 || selector.ids.length > 200 || !selector.ids.every(isUuid))) throw new NotificationError(400, 'validation_error', 'selector.ids must be 1..200 UUIDs');
    if (!hasIds && (!Number.isInteger(selector.up_to_seq) || selector.up_to_seq < 0)) throw new NotificationError(400, 'validation_error', 'selector.up_to_seq must be a non-negative integer');
    if (selector.view !== undefined && !ITEM_VIEWS.includes(selector.view)) throw new NotificationError(400, 'validation_error', 'selector.view is invalid');
    return c.json({ identity, ...(await bulkMutate(sql, { workspaceId, actorId }, {
      mutationId: body.mutation_id, op: body.op, ids: selector.ids, upToSeq: selector.up_to_seq, view: selector.view,
      category: selector.category, sourceAppId: selector.source_app_id, clientAppId: clientAppParam(selector.client_app_id, 'selector.client_app_id'),
    })) });
  }));

  router.get(`${base}/categories`, consumer(async ({ c, sql, identity, workspaceId }) => {
    queryKeys(c, []);
    return c.json({ identity, sources: await listCategories(sql, workspaceId) });
  }));

  router.get(`${base}/rules`, consumer(async ({ c, sql, identity, workspaceId, actorId }) => {
    queryKeys(c, []);
    return c.json({ identity, ...(await getRulesState(sql, { workspaceId, actorId })) });
  }));

  router.put(`${base}/rules`, consumer(async ({ c, sql, identity, workspaceId, actorId }) => {
    const { body } = await readBody(c);
    onlyKeys(body, ['mutation_id', 'rules']);
    if (!isUuid(body.mutation_id)) throw new NotificationError(400, 'validation_error', 'mutation_id must be a UUID');
    if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 50) throw new NotificationError(400, 'validation_error', 'rules must hold 1..50 entries');
    const rules: RuleInput[] = body.rules.map((rule: any, index: number) => {
      if (!rule || typeof rule !== 'object') throw new NotificationError(400, 'validation_error', `rules.${index} must be an object`);
      onlyKeys(rule, ['source_app_id', 'category', 'client_app_id', 'channel', 'mode', 'preview', 'expected_row_version'], `rules.${index}`);
      const source = rule.source_app_id ?? '*', category = rule.category ?? '*', client = rule.client_app_id ?? '*';
      if (![source, client].every((v) => typeof v === 'string' && SLUG.test(v)) || typeof category !== 'string' || !(category === '*' || /^[a-z][a-z0-9_]{0,63}$/.test(category))) throw new NotificationError(400, 'validation_error', `rules.${index} has an invalid key`);
      if (!['inbox', 'alert'].includes(rule.channel) || !['on', 'off', 'default'].includes(rule.mode)) throw new NotificationError(400, 'validation_error', `rules.${index} channel/mode invalid`);
      if (!Number.isInteger(rule.expected_row_version) || rule.expected_row_version < 0) throw new NotificationError(400, 'validation_error', `rules.${index}.expected_row_version is required (0 when the key was absent)`);
      if (rule.mode === 'default' && rule.expected_row_version < 1) throw new NotificationError(400, 'validation_error', `rules.${index}: mode default needs an existing rule (expected_row_version >= 1)`);
      if (rule.preview != null && (rule.channel !== 'alert' || !['generic', 'sender', 'full'].includes(rule.preview))) throw new NotificationError(400, 'validation_error', `rules.${index}.preview is invalid`);
      return { source_app_id: source, category, client_app_id: client, channel: rule.channel, mode: rule.mode, preview: rule.preview ?? null, expected_row_version: rule.expected_row_version };
    });
    const keys = rules.map((rule) => [rule.source_app_id, rule.category, rule.client_app_id, rule.channel].join('\u0000'));
    if (new Set(keys).size !== keys.length) throw new NotificationError(400, 'validation_error', 'rules must not repeat a key');
    return c.json({ identity, ...(await putRules(sql, { workspaceId, actorId }, body.mutation_id, rules)) });
  }));


  // --- Installations and transports (push registry). Owner is always the verified actor. ---
  const requestOrigin = (c: Context) => {
    const url = new URL(c.req.url);
    const proto = (c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')).split(',')[0]!.trim();
    return `${proto}://${(c.req.header('x-forwarded-host') ?? url.host).split(',')[0]!.trim()}`;
  };
  const installationParam = (c: Context) => {
    const id = c.req.param('installationId') ?? '';
    if (!UUID_RE.test(id)) throw new NotificationError(400, 'validation_error', 'installationId must be a UUID');
    return id.toLowerCase();
  };
  const registrant = (ctx: Pick<ConsumerCtx, 'c' | 'actorId' | 'workspaceId' | 'signerNpub'>) => ({
    actorId: ctx.actorId, workspaceId: ctx.workspaceId, signerNpub: ctx.signerNpub, installationId: installationParam(ctx.c),
  });
  const INSTALLATION_KEYS = ['client_app_id', 'platform', 'app_version', 'device_label', 'permission_state'];
  const APNS_KEYS = ['device_token', 'environment', 'bundle_id', 'preview', 'lease_seconds'];

  router.put(`${base}/installations/:installationId`, pushConsumer(async (ctx) => {
    const { body } = await readBody(ctx.c);
    onlyKeys(body, INSTALLATION_KEYS);
    return ctx.c.json({ identity: ctx.identity, ...(await putInstallation(ctx.sql, registrant(ctx), parseInstallationInput(body, true))) });
  }));

  router.delete(`${base}/installations/:installationId`, pushConsumer(async (ctx) => {
    queryKeys(ctx.c, []);
    return ctx.c.json({ identity: ctx.identity, ...(await removeEnrollment(ctx.sql, registrant(ctx))) });
  }));

  const transportKind = (c: Context) => {
    const kind = c.req.param('kind');
    if (kind === 'apns') return kind;
    if (kind === 'webpush' || kind === 'fcm') throw new NotificationError(400, 'transport_not_implemented', `Transport ${kind} is not implemented on this Tower`);
    throw new NotificationError(400, 'validation_error', 'kind must be apns, webpush or fcm');
  };

  router.put(`${base}/installations/:installationId/transports/:kind`, pushConsumer(async (ctx) => {
    transportKind(ctx.c);
    const { body } = await readBody(ctx.c);
    onlyKeys(body, APNS_KEYS);
    const result = await putApnsTransport(ctx.sql, registrant(ctx), parseApnsInput(body), { implicit: null, origin: requestOrigin(ctx.c) });
    return ctx.c.json({ identity: ctx.identity, ...result });
  }));

  router.delete(`${base}/installations/:installationId/transports/:kind`, pushConsumer(async (ctx) => {
    const kind = transportKind(ctx.c);
    queryKeys(ctx.c, []);
    return ctx.c.json({ identity: ctx.identity, ...(await revokeTransport(ctx.sql, registrant(ctx), kind)) });
  }));

  // Compatibility alias for shipped Apple clients: implicit installation + enrollment.
  router.put(`${base}/apns-devices/:installationId`, pushConsumer(async (ctx) => {
    const { body } = await readBody(ctx.c);
    onlyKeys(body, [...APNS_KEYS, ...INSTALLATION_KEYS]);
    const result = await putApnsTransport(ctx.sql, registrant(ctx), parseApnsInput(body), { implicit: parseInstallationInput(body, false), origin: requestOrigin(ctx.c) });
    return ctx.c.json({ identity: ctx.identity, ...result });
  }));

  router.delete(`${base}/apns-devices/:installationId`, pushConsumer(async (ctx) => {
    queryKeys(ctx.c, []);
    return ctx.c.json({ identity: ctx.identity, ...(await removeEnrollment(ctx.sql, registrant(ctx))) });
  }));

  // --- Producers (external applications). Signer is bound to a registered source; no inbox read access. ---
  const producer = (handler: (ctx: { c: Context; sql: Sql; identity: Identity; workspaceId: string; signers: string[] }) => Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'private, no-store');
    let identity: Identity | null = null;
    try {
      const auth = await requireNip98AuthResolved(c);
      if (auth instanceof Response) return auth;
      const workspaceId = c.req.param('workspaceId') ?? '';
      if (!UUID_RE.test(workspaceId)) throw new NotificationError(400, 'validation_error', 'invalid workspace id');
      const sql = getDb();
      const workspace = await resolveFlightDeckPgWorkspace(workspaceId, sql);
      if (!workspace) throw new NotificationError(404, 'workspace_not_found', 'Flight Deck PG workspace not found');
      identity = buildFlightDeckPgIdentity(workspace, workspace.app_npub);
      if (!inboxApiEnabled()) throw new NotificationError(404, 'notifications_not_enabled', 'Notification inbox is not enabled on this Tower');
      return await handler({ c, sql, identity, workspaceId: workspace.id, signers: [...new Set([auth.signerNpub, auth.userNpub])] });
    } catch (error) {
      if (error instanceof NotificationError) return fail(c, identity, error);
      throw error;
    }
  };

  const ws = '/workspaces/:workspaceId';
  router.get(`${ws}/notification-producers/grants/me`, producer(async ({ sql, c, identity, workspaceId, signers }) => {
    const source = await resolveProducerGrant(sql, workspaceId, signers);
    if (!source) throw new NotificationError(403, 'source_not_registered', 'Signer is not a registered notification producer');
    return c.json({ identity, grant: await grantSummary(sql, source) });
  }));

  router.post(`${ws}/notification-events`, producer(async ({ sql, c, identity, workspaceId, signers }) => {
    const { raw, body } = await readBody(c);
    const result = await ingestProducerEvent(sql, { workspaceId, signers, rawBytes: Buffer.byteLength(raw), body });
    return c.json({ identity, ...result.body }, result.status);
  }));

  router.get(`${ws}/notification-events/:eventId`, producer(async ({ sql, c, identity, workspaceId, signers }) => {
    return c.json({ identity, event: await getProducerEvent(sql, workspaceId, signers, c.req.param('eventId')!) });
  }));

  router.post(`${ws}/notification-events/:eventId/withdraw`, producer(async ({ sql, c, identity, workspaceId, signers }) => {
    const event = await getProducerEvent(sql, workspaceId, signers, c.req.param('eventId')!);
    const withdrawKey = `withdraw:${event.id}`;
    const result = await ingestProducerEvent(sql, {
      workspaceId, signers, rawBytes: 0,
      body: { schema: 'org.wingman.notification.event', version: 1, event_key: withdrawKey, op: 'withdraw', target_event_key: event.event_key },
    });
    return c.json({ identity, ...result.body }, result.status);
  }));

  // --- Owner/admin lifecycle ---
  router.get(`${ws}/notification-sources`, consumer(async ({ c, sql, identity, workspaceId, ...auth }) => {
    await requireWorkspaceManage({ workspaceId, ...auth });
    return c.json({ identity, sources: await listSources(sql, workspaceId) });
  }));

  router.put(`${ws}/notification-sources/:sourceAppId`, consumer(async ({ c, sql, identity, workspaceId, actorId, ...auth }) => {
    await requireWorkspaceManage({ workspaceId, ...auth });
    const { body } = await readBody(c);
    onlyKeys(body, ['kind', 'display_name', 'producer_signer_npub', 'allowed_categories', 'allowed_recipient_mode', 'allowed_recipient_actor_ids', 'allowed_client_apps', 'max_severity', 'rate_per_minute']);
    if (!['agent', 'app', 'wapp_installation'].includes(body.kind)) throw new NotificationError(400, 'validation_error', 'kind must be agent, app or wapp_installation');
    if (typeof body.display_name !== 'string' || !body.display_name.trim()) throw new NotificationError(400, 'validation_error', 'display_name is required');
    if (typeof body.producer_signer_npub !== 'string' || !/^npub1[0-9a-z]{50,}$/.test(body.producer_signer_npub)) throw new NotificationError(400, 'validation_error', 'producer_signer_npub must be an npub');
    const mode = body.allowed_recipient_mode ?? 'actor_list';
    if (!['actor_list', 'owner_only'].includes(mode)) throw new NotificationError(400, 'validation_error', 'allowed_recipient_mode invalid');
    const recipients = body.allowed_recipient_actor_ids ?? [];
    if (!Array.isArray(recipients) || recipients.length > 500 || !recipients.every(isUuid)) throw new NotificationError(400, 'validation_error', 'allowed_recipient_actor_ids must be UUIDs');
    const maxSeverity = body.max_severity ?? 'normal';
    if (!['low', 'normal', 'high'].includes(maxSeverity)) throw new NotificationError(400, 'validation_error', 'max_severity invalid');
    const rate = body.rate_per_minute ?? 60;
    if (!Number.isInteger(rate) || rate < 1 || rate > 6000) throw new NotificationError(400, 'validation_error', 'rate_per_minute invalid');
    const clientApps = body.allowed_client_apps ?? ['*'];
    if (!Array.isArray(clientApps) || !clientApps.every((v: unknown) => typeof v === 'string' && SLUG.test(v as string))) throw new NotificationError(400, 'validation_error', 'allowed_client_apps invalid');
    if (!Array.isArray(body.allowed_categories) || body.allowed_categories.length < 1 || body.allowed_categories.length > 50) throw new NotificationError(400, 'validation_error', 'allowed_categories must hold 1..50 entries');
    const categories = body.allowed_categories.map((cat: any, index: number) => {
      if (!cat || typeof cat !== 'object') throw new NotificationError(400, 'validation_error', `allowed_categories.${index} must be an object`);
      onlyKeys(cat, ['category', 'label', 'default_severity', 'grouping', 'default_inbox', 'default_alert'], `allowed_categories.${index}`);
      if (typeof cat.category !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(cat.category) || typeof cat.label !== 'string' || !cat.label.trim()) throw new NotificationError(400, 'validation_error', `allowed_categories.${index} needs category and label`);
      const sev = cat.default_severity ?? 'normal', grouping = cat.grouping ?? 'subject', inbox = cat.default_inbox ?? 'on', alert = cat.default_alert ?? 'on';
      if (!['low', 'normal', 'high'].includes(sev) || !['none', 'subject'].includes(grouping) || !['on', 'off'].includes(inbox) || !['on', 'off'].includes(alert)) throw new NotificationError(400, 'validation_error', `allowed_categories.${index} has invalid defaults`);
      return { category: cat.category, label: cat.label, default_severity: sev, grouping, default_inbox: inbox, default_alert: alert };
    });
    const input: SourceInput = {
      kind: body.kind, display_name: body.display_name, producer_signer_npub: body.producer_signer_npub, allowed_recipient_mode: mode,
      allowed_recipient_actor_ids: recipients, allowed_client_apps: clientApps, max_severity: maxSeverity, rate_per_minute: rate, categories,
    };
    const row = await upsertSource(sql, workspaceId, c.req.param('sourceAppId')!, actorId, input);
    return c.json({ identity, source: await grantSummary(sql, row) });
  }));

  for (const status of ['disable', 'revoke'] as const) {
    router.post(`${ws}/notification-sources/:sourceAppId/${status}`, consumer(async ({ c, sql, identity, workspaceId, ...auth }) => {
      await requireWorkspaceManage({ workspaceId, ...auth });
      return c.json({ identity, ...(await setSourceStatus(sql, workspaceId, c.req.param('sourceAppId')!, status === 'disable' ? 'disabled' : 'revoked')) });
    }));
  }

  router.get(`${ws}/admin/notifications/queue`, consumer(async ({ c, sql, identity, workspaceId, ...auth }) => {
    await requireWorkspaceManage({ workspaceId, ...auth });
    return c.json({ identity, queue: await queueStats(sql, workspaceId) });
  }));
}
