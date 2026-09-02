import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { config } from '../config';
import {
  authorizeFlightDeckPgOperation,
  type FlightDeckPgAuthorizationDecision,
} from '../services/flightdeck-pg-authorization';
import {
  buildFlightDeckPgIdentity,
  resolveFlightDeckPgRequestContext,
} from '../services/flightdeck-pg-api';
import {
  WappActivityError,
  assertWappPublishingGrantActive,
  countVisibleWappActivity,
  decodeWappActivityCursor,
  deleteWappActivityMute,
  encodeWappActivityCursor,
  enforceWappInstallationRate,
  hashNormalizedWappActivityPayload,
  listVisibleWappActivity,
  listWappActivityMutes,
  listWappPublishingGrants,
  normalizeWappActivityPayload,
  normalizeWappPublishingGrantInput,
  publishWappActivity,
  putWappActivityMute,
  recordWappPublishingRejection,
  replaceWappPublishingGrant,
  resolvePublisherGrant,
  resolveVisibleWappActivity,
  resolveWappPublishingGrantByInstallation,
  revokeWappPublishingGrant,
  rotateWappPublisherKey,
  serializeWappPublishingGrant,
  setWappPublishingGrantDisabled,
  updateWappActivityUserState,
  type PublisherGrantContext,
  type WappActivityMuteTarget,
} from '../services/wapp-activity';
import { evaluateWappManagement, WappManagementError } from '../services/wapp-management';
import { getDb } from '../db';

export const wappActivityPublisherRouter = new Hono();
export const wappActivityFlightDeckRouter = new Hono();

type HumanContext = Awaited<ReturnType<typeof resolveFlightDeckPgRequestContext>> & {
  workspace: NonNullable<Awaited<ReturnType<typeof resolveFlightDeckPgRequestContext>>['workspace']>;
  actor: NonNullable<Awaited<ReturnType<typeof resolveFlightDeckPgRequestContext>>['actor']>;
  membership: NonNullable<Awaited<ReturnType<typeof resolveFlightDeckPgRequestContext>>['membership']>;
};

function errorResponse(c: Context, error: unknown, identity?: unknown) {
  if (error instanceof WappActivityError) {
    if (error.status === 429) c.header('Retry-After', String(error.details.retry_after_seconds || 60));
    return c.json({ error: error.message, code: error.code, status: error.status, ...(identity ? { identity } : {}), details: error.details }, error.status);
  }
  console.error('WApp activity route failed', error);
  return c.json({ error: 'Internal WApp activity error', code: 'internal_error', status: 500, ...(identity ? { identity } : {}) }, 500);
}

function authorizationResponse(c: Context, decision: FlightDeckPgAuthorizationDecision, identity: unknown) {
  const status = decision.category === 'auth-error' ? 401 : decision.category === 'validation-error' ? 400 : 403;
  return c.json({ error: status === 403 ? 'Permission denied' : 'Authorization failed', code: status === 403 ? 'permission_denied' : decision.reason, status, identity, details: { reason: decision.reason } }, status);
}

async function requireHumanContext(c: Context): Promise<{ auth: { signerNpub: string; userNpub: string }; context: HumanContext; identity: ReturnType<typeof buildFlightDeckPgIdentity> } | Response> {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const context = await resolveFlightDeckPgRequestContext({ workspaceId: c.req.param('workspaceId') || '', actorNpub: auth.userNpub });
  const identity = buildFlightDeckPgIdentity(context.workspace, context.workspace?.app_npub ?? config.flightDeck.appNpub);
  if (!context.workspace) return c.json({ error: 'Workspace not found', code: 'workspace_not_found', status: 404, identity }, 404);
  if (!context.actor || !context.membership) return c.json({ error: 'Workspace membership required', code: 'workspace_membership_required', status: 403, identity }, 403);
  return { auth, context: context as HumanContext, identity };
}

async function requireWorkspaceManager(c: Context) {
  const result = await requireHumanContext(c);
  if (result instanceof Response) return result;
  const decision = await authorizeFlightDeckPgOperation({
    actorNpub: result.auth.userNpub,
    appNpub: result.context.workspace.app_npub,
    workspaceId: result.context.workspace.id,
    permission: 'workspace.manage',
    resource: { type: 'workspace' },
  });
  if (!decision.allowed) return authorizationResponse(c, decision, result.identity);
  return result;
}

async function requireWappManager(c: Context, request: Record<string, unknown> = {}, prefetched?: Exclude<Awaited<ReturnType<typeof requireHumanContext>>, Response>) {
  const result = prefetched ?? await requireHumanContext(c);
  if (result instanceof Response) return result;
  const decision = await authorizeFlightDeckPgOperation({ actorNpub: result.auth.userNpub, appNpub: result.context.workspace.app_npub, workspaceId: result.context.workspace.id, permission: 'workspace.manage', resource: { type: 'workspace' } });
  if (decision.allowed) return { ...result, delegation: null };
  const [owner] = await getDb()<any[]>`SELECT a.id FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id AND m.workspace_id=${result.context.workspace.id} WHERE a.npub=${result.context.workspace.workspace_owner_npub}`;
  if (!owner) return authorizationResponse(c, decision, result.identity);
  try {
    const authz = await evaluateWappManagement({ workspaceId: result.context.workspace.id, actorId: result.context.actor.id, ownerActorId: owner.id, request });
    return { ...result, delegation: authz.delegation };
  } catch (error) {
    if (error instanceof WappManagementError) return c.json({ error: error.message, code: error.code, status: error.status, identity: result.identity, details: error.details }, error.status as any);
    throw error;
  }
}

function parseBooleanQuery(value: string | undefined): boolean | null {
  if (value === undefined || value === '') return null;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new WappActivityError('validation_failed', 'Boolean query value is invalid');
}

function parseLimit(value: string | undefined, fallback = 50) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.floor(parsed))) : fallback;
}

wappActivityPublisherRouter.get('/workspaces/:workspaceId/grants/me', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  try {
    const context = await resolvePublisherGrant(c.req.param('workspaceId'), auth.signerNpub);
    const etag = `"wapp-grant-${context.grant.id}-${context.grant.grant_version}-${context.grant.status}-${context.installation.key_version}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json({ grant: serializeWappPublishingGrant(context, config.flightDeck.appNpub) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

wappActivityPublisherRouter.post('/workspaces/:workspaceId/items', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const workspaceId = c.req.param('workspaceId');
  let context: PublisherGrantContext | null = null;
  let payloadHash: string | null = null;
  try {
    const raw = await c.req.raw.clone().text();
    if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) throw new WappActivityError('payload_too_large', 'Publication payload exceeds 16 KiB', 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new WappActivityError('validation_failed', 'Request body must be valid JSON'); }
    context = await resolvePublisherGrant(workspaceId, auth.signerNpub);
    assertWappPublishingGrantActive(context);
    await enforceWappInstallationRate(context);
    const payload = normalizeWappActivityPayload(body, context.grant.disable_open_links ? [] : context.grant.registered_open_origins);
    payloadHash = hashNormalizedWappActivityPayload(payload);
    const result = await publishWappActivity({ context, payload, payloadHash });
    return c.json({ item: result.item, replayed: result.replayed, audit: result.auditId ? { event_id: result.auditId, operation: 'activity.publish', publisher_npub: auth.signerNpub } : null, outbox: result.outbox }, result.replayed ? 200 : 201);
  } catch (error) {
    const code = error instanceof WappActivityError ? error.code : 'internal_error';
    await recordWappPublishingRejection({ workspaceId, signerNpub: auth.signerNpub, context, code, payloadHash }).catch(() => undefined);
    return errorResponse(c, error);
  }
});

wappActivityFlightDeckRouter.get('/workspaces/:workspaceId/wapp-publishing-grants', async (c) => {
  const result = await requireWorkspaceManager(c);
  if (result instanceof Response) return result;
  try {
    const grants = await listWappPublishingGrants(result.context.workspace.id);
    return c.json({ identity: result.identity, grants: grants.map((grant) => serializeWappPublishingGrant(grant, result.context.workspace.app_npub)) });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.get('/workspaces/:workspaceId/wapp-publishing-grants/:wappInstallationId', async (c) => {
  const result = await requireWappManager(c, { wapp_installation_id: c.req.param('wappInstallationId') });
  if (result instanceof Response) return result;
  try {
    const grant = await resolveWappPublishingGrantByInstallation(result.context.workspace.id, c.req.param('wappInstallationId'));
    if (!grant) throw new WappActivityError('publishing_grant_not_found', 'Publishing grant not found', 404);
    return c.json({ identity: result.identity, grant: serializeWappPublishingGrant(grant, result.context.workspace.app_npub) });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.put('/workspaces/:workspaceId/wapp-publishing-grants/:wappInstallationId', async (c) => {
  let identity: unknown;
  try {
    const initial = await requireHumanContext(c);
    if (initial instanceof Response) return initial;
    identity = initial.identity;
    const body = await c.req.json().catch(() => null);
    const request = normalizeWappPublishingGrantInput(body);
    const result = await requireWappManager(c, { ...request, wapp_installation_id: c.req.param('wappInstallationId') }, initial);
    if (result instanceof Response) return result;
    identity = result.identity;
    const payload = await replaceWappPublishingGrant({ workspaceId: result.context.workspace.id, wappInstallationId: c.req.param('wappInstallationId'), request, actorId: result.context.actor.id, actorNpub: result.auth.userNpub, signerNpub: result.auth.signerNpub });
    return c.json({ identity: result.identity, grant: serializeWappPublishingGrant(payload.context, result.context.workspace.app_npub), audit: { event_id: payload.auditId, operation: 'grant.replace', actor_npub: result.auth.userNpub } }, 201);
  } catch (error) { return errorResponse(c, error, identity); }
});

wappActivityFlightDeckRouter.post('/workspaces/:workspaceId/wapp-publishing-grants/:wappInstallationId/disable', async (c) => {
  const result = await requireWappManager(c, { wapp_installation_id: c.req.param('wappInstallationId') });
  if (result instanceof Response) return result;
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.disabled !== 'boolean') throw new WappActivityError('validation_failed', 'disabled must be a boolean');
    const payload = await setWappPublishingGrantDisabled({ workspaceId: result.context.workspace.id, wappInstallationId: c.req.param('wappInstallationId'), disabled: body.disabled, reason: String(body.reason || ''), actorId: result.context.actor.id, actorNpub: result.auth.userNpub, signerNpub: result.auth.signerNpub });
    return c.json({ identity: result.identity, grant: serializeWappPublishingGrant(payload.context, result.context.workspace.app_npub), audit: { event_id: payload.auditId, operation: body.disabled ? 'grant.disable' : 'grant.enable', actor_npub: result.auth.userNpub } });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.post('/workspaces/:workspaceId/wapp-publishing-grants/:wappInstallationId/revoke', async (c) => {
  const result = await requireWappManager(c, { wapp_installation_id: c.req.param('wappInstallationId') });
  if (result instanceof Response) return result;
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const payload = await revokeWappPublishingGrant({ workspaceId: result.context.workspace.id, wappInstallationId: c.req.param('wappInstallationId'), reason: String(body.reason || ''), disableOpenLinks: body.disable_open_links === true, actorId: result.context.actor.id, actorNpub: result.auth.userNpub, signerNpub: result.auth.signerNpub });
    return c.json({ identity: result.identity, grant: serializeWappPublishingGrant(payload.context, result.context.workspace.app_npub), audit: { event_id: payload.auditId, operation: 'grant.revoke', actor_npub: result.auth.userNpub } });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.post('/workspaces/:workspaceId/wapp-publishing-grants/:wappInstallationId/rotate', async (c) => {
  const result = await requireWappManager(c, { wapp_installation_id: c.req.param('wappInstallationId') });
  if (result instanceof Response) return result;
  try {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) throw new WappActivityError('validation_failed', 'Request body must be an object');
    const payload = await rotateWappPublisherKey({ workspaceId: result.context.workspace.id, wappInstallationId: c.req.param('wappInstallationId'), currentPublisherNpub: String(body.current_publisher_npub || ''), newPublisherNpub: String(body.new_publisher_npub || ''), nonce: String(body.nonce || ''), expiresAt: String(body.expires_at || ''), actorId: result.context.actor.id, actorNpub: result.auth.userNpub, signerNpub: result.auth.signerNpub });
    return c.json({ identity: result.identity, grant: serializeWappPublishingGrant(payload.context, result.context.workspace.app_npub), audit: { event_id: payload.auditId, operation: 'publisher.rotate', actor_npub: result.auth.userNpub } });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.get('/workspaces/:workspaceId/wapp-activity/items', async (c) => {
  const result = await requireHumanContext(c);
  if (result instanceof Response) return result;
  try {
    const cursorRaw = c.req.query('cursor');
    const cursor = decodeWappActivityCursor(cursorRaw);
    if (cursorRaw && !cursor) throw new WappActivityError('validation_failed', 'cursor is invalid');
    const items = await listVisibleWappActivity({ workspaceId: result.context.workspace.id, actorId: result.context.actor.id, groupIds: result.context.groupIds, unread: parseBooleanQuery(c.req.query('unread')), state: c.req.query('state') || null, installationId: c.req.query('installation_id') || null, category: c.req.query('category') || null, channelId: c.req.query('channel_id') || null, includeResolved: parseBooleanQuery(c.req.query('include_resolved')) ?? false, limit: parseLimit(c.req.query('limit')), cursor });
    return c.json({ identity: result.identity, items, next_cursor: items.length ? encodeWappActivityCursor(items.at(-1) as { occurred_at: string; id: string }) : null });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.get('/workspaces/:workspaceId/wapp-activity/items/:itemId', async (c) => {
  const result = await requireHumanContext(c);
  if (result instanceof Response) return result;
  try {
    const item = await resolveVisibleWappActivity({ workspaceId: result.context.workspace.id, itemId: c.req.param('itemId'), actorId: result.context.actor.id, groupIds: result.context.groupIds });
    if (!item) throw new WappActivityError('activity_item_not_found', 'Activity item not found', 404);
    return c.json({ identity: result.identity, item });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.get('/workspaces/:workspaceId/wapp-activity/counts', async (c) => {
  const result = await requireHumanContext(c);
  if (result instanceof Response) return result;
  try {
    const counts = await countVisibleWappActivity({ workspaceId: result.context.workspace.id, actorId: result.context.actor.id, groupIds: result.context.groupIds });
    return c.json({ identity: result.identity, counts });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.patch('/workspaces/:workspaceId/wapp-activity/items/:itemId/user-state', async (c) => {
  const result = await requireHumanContext(c);
  if (result instanceof Response) return result;
  try {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || (typeof body.read !== 'boolean' && typeof body.dismissed !== 'boolean')) throw new WappActivityError('validation_failed', 'read or dismissed boolean is required');
    if (body.read !== undefined && typeof body.read !== 'boolean') throw new WappActivityError('validation_failed', 'read must be a boolean');
    if (body.dismissed !== undefined && typeof body.dismissed !== 'boolean') throw new WappActivityError('validation_failed', 'dismissed must be a boolean');
    const state = await updateWappActivityUserState({ workspaceId: result.context.workspace.id, itemId: c.req.param('itemId'), actorId: result.context.actor.id, groupIds: result.context.groupIds, ...(typeof body.read === 'boolean' ? { read: body.read } : {}), ...(typeof body.dismissed === 'boolean' ? { dismissed: body.dismissed } : {}) });
    return c.json({ identity: result.identity, state });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.get('/workspaces/:workspaceId/wapp-activity/mutes', async (c) => {
  const result = await requireHumanContext(c);
  if (result instanceof Response) return result;
  try {
    const mutes = await listWappActivityMutes(result.context.workspace.id, result.context.actor.id);
    return c.json({ identity: result.identity, mutes: mutes.map((mute) => ({ ...mute, created_at: mute.created_at.toISOString() })) });
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.put('/workspaces/:workspaceId/wapp-activity/mutes/:targetType/:targetValue', async (c) => {
  const result = await requireHumanContext(c);
  if (result instanceof Response) return result;
  try {
    const mute = await putWappActivityMute(result.context.workspace.id, result.context.actor.id, c.req.param('targetType') as WappActivityMuteTarget, c.req.param('targetValue'));
    return c.json({ identity: result.identity, mute: { ...mute, created_at: mute.created_at.toISOString() } }, 201);
  } catch (error) { return errorResponse(c, error, result.identity); }
});

wappActivityFlightDeckRouter.delete('/workspaces/:workspaceId/wapp-activity/mutes/:targetType/:targetValue', async (c) => {
  const result = await requireHumanContext(c);
  if (result instanceof Response) return result;
  try {
    const deleted = await deleteWappActivityMute(result.context.workspace.id, result.context.actor.id, c.req.param('targetType') as WappActivityMuteTarget, c.req.param('targetValue'));
    return c.json({ identity: result.identity, deleted });
  } catch (error) { return errorResponse(c, error, result.identity); }
});
