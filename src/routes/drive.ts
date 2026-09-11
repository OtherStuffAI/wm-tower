import { getWorkspaceKeyBinding } from '../services/user-workspace-keys';
import { Hono } from 'hono';
import { getEffectiveRequestUrl, requireNip98AuthResolved } from '../auth';
import { resolveFlightDeckPgRequestContext } from '../services/flightdeck-pg-api';
import {
  discoverDriveShares,
  driveHostPolicy,
  driveId,
  DriveError,
  saveDriveShare,
} from '../services/drive';

export const driveRouter = new Hono();
driveRouter.onError((e, c) =>
  e instanceof DriveError
    ? c.json({ code: e.code }, e.status as any)
    : c.json({ code: 'drive_internal_error' }, 500),
);
driveRouter.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
const base = '/workspaces/:workspaceId/drive/shares';
driveRouter.get(`${base}/:shareId/policy`, async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  return c.json(
    await driveHostPolicy(
      driveId(c.req.param('workspaceId')),
      c.req.param('shareId'),
      auth.signerNpub,
    ),
  );
});
driveRouter.on(['GET', 'PUT'], [base, `${base}/:shareId`], async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const ctx = await resolveFlightDeckPgRequestContext({
    workspaceId: driveId(c.req.param('workspaceId')!),
    actorNpub: auth.userNpub,
  });
  if (!ctx.workspace || !ctx.actor || !ctx.membership)
    throw new DriveError('workspace_membership_required', 403);
  if (auth.signerNpub !== auth.userNpub) {
    const binding = ctx.workspace.workspace_service_npub
      ? await getWorkspaceKeyBinding(auth.signerNpub, ctx.workspace.workspace_service_npub)
      : null;
    if (!binding?.active || binding.user_npub !== auth.userNpub)
      throw new DriveError('workspace_key_invalid', 403);
  }
  if (c.req.method === 'GET')
    return c.json({ shares: await discoverDriveShares(ctx.workspace.id, ctx.actor.id) });
  // Human owner proof must be direct: v1 does not silently delegate private Drive administration.
  if (auth.signerNpub !== auth.userNpub) throw new DriveError('direct_owner_required', 403);
  if (Number(c.req.header('content-length') || 0) > 16384)
    throw new DriveError('body_too_large', 413);
  const raw = await c.req.text();
  if (raw.length > 16384) throw new DriveError('body_too_large', 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new DriveError('invalid_json');
  }
  return c.json({
    share: await saveDriveShare(
      ctx.workspace.id,
      c.req.param('shareId') || '',
      ctx.actor.id,
      auth.userNpub,
      getEffectiveRequestUrl(c.req.raw).toString(),
      body,
    ),
  });
});
