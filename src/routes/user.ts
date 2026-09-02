import { Hono } from 'hono';
import type { Context } from 'hono';
import { jsonAgentChatError } from '../agent-chat-errors';
import { requireNip98Auth, requireNip98AuthResolved } from '../auth';
import {
  identityNormalizationErrorBody,
  isIdentityNormalizationError,
  normalizeWorkspaceServiceNpub,
  normalizeWorkspaceUserKeyNpub,
} from '../identity-normalization';
import {
  ensureUserProfile,
  registerWorkspaceKey,
  listWorkspaceKeys,
  rotateWorkspaceKey,
  getWorkspaceKeyMappings,
  revokeWorkspaceKey,
  touchWorkspaceKeyLastSeen,
} from '../services/user-workspace-keys';
import { listWorkspacesForMember } from '../services/workspaces';
import type { RegisterWorkspaceKeyInput, RotateWorkspaceKeyInput } from '../types';

export const userRouter = new Hono();

function workspaceKeyResponse(key: {
  user_npub: string;
  workspace_owner_npub: string;
  ws_key_npub: string;
  ws_key_epoch: number;
  active: boolean;
  device_label?: string | null;
  device_platform?: string | null;
  device_policy?: Record<string, unknown> | null;
  last_seen_at?: Date | string | null;
  revoked_at?: Date | string | null;
  registered_at?: Date | string | null;
}) {
  return {
    user_npub: key.user_npub,
    workspace_owner_npub: key.workspace_owner_npub,
    workspace_service_npub: key.workspace_owner_npub,
    ws_key_npub: key.ws_key_npub,
    workspace_user_key_npub: key.ws_key_npub,
    ws_key_epoch: key.ws_key_epoch,
    active: key.active,
    device_npub: key.ws_key_npub,
    label: key.device_label ?? null,
    platform: key.device_platform ?? null,
    policy: key.device_policy ?? {},
    last_seen_at: key.last_seen_at ?? null,
    revoked_at: key.revoked_at ?? null,
    registered_at: key.registered_at ?? null,
  };
}

function deviceResponse(key: Parameters<typeof workspaceKeyResponse>[0]) {
  const response = workspaceKeyResponse(key);
  return {
    id: response.device_npub,
    device_npub: response.device_npub,
    user_npub: response.user_npub,
    workspace_owner_npub: response.workspace_owner_npub,
    workspace_service_npub: response.workspace_service_npub,
    label: response.label,
    platform: response.platform,
    policy: response.policy,
    status: response.active ? 'active' : 'revoked',
    active: response.active,
    last_seen_at: response.last_seen_at,
    revoked_at: response.revoked_at,
    registered_at: response.registered_at,
  };
}

// POST /api/v4/user/workspace-keys — register a workspace session key
// Intentionally uses requireNip98Auth (not Resolved) — registration must be
// signed by the real user npub. A workspace key cannot register itself.
userRouter.post('/workspace-keys', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;

  const body = await c.req.json<RegisterWorkspaceKeyInput>();

  let workspaceServiceNpub: string | undefined;
  let workspaceUserKeyNpub: string | undefined;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body as unknown as Record<string, unknown>, [
      'workspace_owner_npub',
      'workspace_service_npub',
    ]);
    workspaceUserKeyNpub = normalizeWorkspaceUserKeyNpub(body as unknown as Record<string, unknown>);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }

  if (!workspaceServiceNpub || !workspaceUserKeyNpub) {
    return c.json({ error: 'workspace_owner_npub or workspace_service_npub, and ws_key_npub or workspace_user_key_npub required' }, 400);
  }

  // Verify user has access to the workspace
  const workspaces = await listWorkspacesForMember(authNpub);
  const hasAccess = workspaces.some(
    (w) => w.workspace_owner_npub === workspaceServiceNpub,
  );
  if (!hasAccess) {
    return jsonAgentChatError(
      c,
      403,
      'workspace_access_denied',
      'user does not have access to this workspace',
      {
        workspace_owner_npub: workspaceServiceNpub,
        actor_npub: authNpub,
        ws_key_npub: null,
      },
    );
  }

  try {
    await ensureUserProfile(authNpub);
    const key = await registerWorkspaceKey(
      authNpub,
      workspaceServiceNpub,
      workspaceUserKeyNpub,
      {
        label: typeof body.device_label === 'string' ? body.device_label : typeof body.label === 'string' ? body.label : null,
        platform: typeof body.device_platform === 'string' ? body.device_platform : typeof body.platform === 'string' ? body.platform : null,
        policy: body.device_policy && typeof body.device_policy === 'object' && !Array.isArray(body.device_policy)
          ? body.device_policy as Record<string, unknown>
          : body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy)
            ? body.policy as Record<string, unknown>
            : null,
      },
    );
    return c.json(workspaceKeyResponse(key), 201);
  } catch (err: any) {
    if (err.code === 'KEY_CONFLICT') {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// GET /api/v4/user/workspace-keys — list workspace keys for the authenticated user
userRouter.get('/workspace-keys', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;

  const keys = await listWorkspaceKeys(authNpub);
  return c.json({ keys: keys.map(workspaceKeyResponse) });
});

// POST /api/v4/user/devices — register a first-class device key.
// This is a device-oriented facade over workspace user keys: devices are still
// Nostr keys and normal Tower requests still use NIP-98.
userRouter.post('/devices', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;

  const body = await c.req.json<Record<string, unknown>>();

  let workspaceServiceNpub: string | undefined;
  let deviceNpub: string | undefined;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body, [
      'workspace_owner_npub',
      'workspace_service_npub',
    ]);
    deviceNpub = normalizeWorkspaceUserKeyNpub(body, [
      'device_npub',
      'ws_key_npub',
      'workspace_user_key_npub',
    ]);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }

  if (!workspaceServiceNpub || !deviceNpub) {
    return c.json({ error: 'workspace_owner_npub or workspace_service_npub, and device_npub required' }, 400);
  }

  const workspaces = await listWorkspacesForMember(authNpub);
  const hasAccess = workspaces.some((w) => w.workspace_owner_npub === workspaceServiceNpub);
  if (!hasAccess) {
    return jsonAgentChatError(
      c,
      403,
      'workspace_access_denied',
      'user does not have access to this workspace',
      {
        workspace_owner_npub: workspaceServiceNpub,
        actor_npub: authNpub,
        ws_key_npub: null,
      },
    );
  }

  try {
    await ensureUserProfile(authNpub);
    const key = await registerWorkspaceKey(authNpub, workspaceServiceNpub, deviceNpub, {
      label: typeof body.label === 'string' ? body.label : typeof body.device_label === 'string' ? body.device_label : null,
      platform: typeof body.platform === 'string' ? body.platform : typeof body.device_platform === 'string' ? body.device_platform : null,
      policy: body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy)
        ? body.policy as Record<string, unknown>
        : body.device_policy && typeof body.device_policy === 'object' && !Array.isArray(body.device_policy)
          ? body.device_policy as Record<string, unknown>
          : null,
    });
    return c.json({ device: deviceResponse(key) }, 201);
  } catch (err: any) {
    if (err.code === 'KEY_CONFLICT') {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// GET /api/v4/user/devices — list registered devices for the authenticated user.
userRouter.get('/devices', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;

  const keys = await listWorkspaceKeys(authNpub);
  return c.json({ devices: keys.map(deviceResponse) });
});

// POST /api/v4/user/devices/:deviceNpub/seen — record last successful use.
userRouter.post('/devices/:deviceNpub/seen', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  let workspaceServiceNpub: string | undefined;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body, [
      'workspace_owner_npub',
      'workspace_service_npub',
    ]);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }
  if (!workspaceServiceNpub) {
    return c.json({ error: 'workspace_owner_npub or workspace_service_npub required' }, 400);
  }

  const deviceNpub = c.req.param('deviceNpub');
  if (!deviceNpub) return c.json({ error: 'device_npub required' }, 400);

  const key = await touchWorkspaceKeyLastSeen(authNpub, workspaceServiceNpub, deviceNpub);
  if (!key) return c.json({ error: 'device not found' }, 404);
  return c.json({ device: deviceResponse(key) });
});

async function revokeDeviceRoute(c: Context) {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;

  const deviceNpub = c.req.param('deviceNpub');
  if (!deviceNpub) return c.json({ error: 'device_npub required' }, 400);

  const key = await revokeWorkspaceKey(authNpub, deviceNpub);
  if (!key) return c.json({ error: 'device not found' }, 404);
  return c.json({ device: deviceResponse(key) });
}

// POST/DELETE /api/v4/user/devices/:deviceNpub/revoke — revoke a device key.
userRouter.post('/devices/:deviceNpub/revoke', revokeDeviceRoute);
userRouter.delete('/devices/:deviceNpub', revokeDeviceRoute);

// POST /api/v4/user/workspace-keys/rotate — rotate a workspace session key
// Intentionally requires the real user signer — rotation is a privileged
// operation. The user must re-engage their extension/bunker signer to rotate.
userRouter.post('/workspace-keys/rotate', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;

  const body = await c.req.json<RotateWorkspaceKeyInput>();

  let workspaceServiceNpub: string | undefined;
  let newWorkspaceUserKeyNpub: string | undefined;
  let oldWorkspaceUserKeyNpub: string | undefined;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body as unknown as Record<string, unknown>, [
      'workspace_owner_npub',
      'workspace_service_npub',
    ]);
    newWorkspaceUserKeyNpub = normalizeWorkspaceUserKeyNpub(body as unknown as Record<string, unknown>, [
      'new_ws_key_npub',
      'new_workspace_user_key_npub',
    ]);
    oldWorkspaceUserKeyNpub = normalizeWorkspaceUserKeyNpub(body as unknown as Record<string, unknown>, [
      'old_ws_key_npub',
      'old_workspace_user_key_npub',
    ]);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }

  if (!workspaceServiceNpub || !newWorkspaceUserKeyNpub || !oldWorkspaceUserKeyNpub) {
    return c.json(
      { error: 'workspace_owner_npub or workspace_service_npub, new_ws_key_npub or new_workspace_user_key_npub, and old_ws_key_npub or old_workspace_user_key_npub required' },
      400,
    );
  }

  try {
    await ensureUserProfile(authNpub);
    const key = await rotateWorkspaceKey(
      authNpub,
      workspaceServiceNpub,
      newWorkspaceUserKeyNpub,
      oldWorkspaceUserKeyNpub,
    );
    return c.json(workspaceKeyResponse(key));
  } catch (err: any) {
    if (err.code === 'NOT_FOUND') {
      return c.json({ error: err.message }, 404);
    }
    if (err.code === 'KEY_CONFLICT') {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// GET /api/v4/user/workspace-key-mappings?workspace_owner_npub=<npub>
// Returns ws_key_npub → user_npub mappings for display resolution.
// Accepts workspace key auth so clients can call this after bootstrap.
userRouter.get('/workspace-key-mappings', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  let workspaceServiceNpub: string | undefined;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub({
      workspace_owner_npub: c.req.query('workspace_owner_npub'),
      workspace_service_npub: c.req.query('workspace_service_npub'),
    }, ['workspace_owner_npub', 'workspace_service_npub']);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }
  if (!workspaceServiceNpub) {
    return c.json({ error: 'workspace_owner_npub or workspace_service_npub query param required' }, 400);
  }

  const mappings = await getWorkspaceKeyMappings(workspaceServiceNpub);
  return c.json({
    mappings: mappings.map((mapping) => ({
      ...mapping,
      workspace_service_npub: mapping.workspace_owner_npub,
      workspace_user_key_npub: mapping.ws_key_npub,
    })),
  });
});
