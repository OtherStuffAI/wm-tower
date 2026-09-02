import { Hono } from 'hono';
import { requireNip98Auth, requireNip98AuthResolved } from '../auth';
import { config } from '../config';
import {
  identityNormalizationErrorBody,
  isIdentityNormalizationError,
  normalizeWorkspaceServiceNpub,
} from '../identity-normalization';
import {
  canManageWorkspace,
  createWorkspace,
  listWorkspacesForMember,
  recoverWorkspace,
  updateWorkspace,
} from '../services/workspaces';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from '../types';

export const workspacesRouter = new Hono();

function uniqueMembers(memberKeys: { member_npub: string }[]) {
  return new Set((memberKeys || []).map((entry) => String(entry.member_npub || '').trim()).filter(Boolean)).size;
}

workspacesRouter.post('/', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;

  const body = await c.req.json<CreateWorkspaceInput>();
  let workspaceServiceNpub: string | undefined;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body as unknown as Record<string, unknown>, [
      'workspace_owner_npub',
      'workspace_service_npub',
    ]);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }
  if (!workspaceServiceNpub || !body.name || !body.wrapped_workspace_nsec || !body.wrapped_by_npub) {
    return c.json({ error: 'workspace_owner_npub or workspace_service_npub, name, wrapped_workspace_nsec, and wrapped_by_npub required' }, 400);
  }
  if (body.wrapped_by_npub !== authNpub) {
    return c.json({ error: 'wrapped_by_npub must match authenticated npub' }, 403);
  }
  if (!body.default_group_npub || !body.private_group_npub) {
    return c.json({ error: 'default_group_npub and private_group_npub required' }, 400);
  }
  if (!body.admin_group_npub) {
    return c.json({ error: 'admin_group_npub required' }, 400);
  }
  if (!Array.isArray(body.default_group_member_keys) || body.default_group_member_keys.length === 0) {
    return c.json({ error: 'default_group_member_keys required' }, 400);
  }
  if (!Array.isArray(body.admin_group_member_keys) || body.admin_group_member_keys.length === 0) {
    return c.json({ error: 'admin_group_member_keys required' }, 400);
  }
  if (!Array.isArray(body.private_group_member_keys) || body.private_group_member_keys.length === 0) {
    return c.json({ error: 'private_group_member_keys required' }, 400);
  }
  if (uniqueMembers(body.default_group_member_keys) !== body.default_group_member_keys.length) {
    return c.json({ error: 'default_group_member_keys must contain unique members' }, 400);
  }
  if (uniqueMembers(body.admin_group_member_keys) !== body.admin_group_member_keys.length) {
    return c.json({ error: 'admin_group_member_keys must contain unique members' }, 400);
  }
  if (uniqueMembers(body.private_group_member_keys) !== body.private_group_member_keys.length) {
    return c.json({ error: 'private_group_member_keys must contain unique members' }, 400);
  }
  if (!body.default_group_member_keys.some((entry) => entry.member_npub === authNpub)) {
    return c.json({ error: 'creator must be present in default_group_member_keys' }, 400);
  }
  if (!body.admin_group_member_keys.some((entry) => entry.member_npub === authNpub)) {
    return c.json({ error: 'creator must be present in admin_group_member_keys' }, 400);
  }
  if (!body.private_group_member_keys.some((entry) => entry.member_npub === authNpub)) {
    return c.json({ error: 'creator must be present in private_group_member_keys' }, 400);
  }

  try {
    const normalizedBody = {
      ...body,
      workspace_owner_npub: workspaceServiceNpub,
    };
    const result = await createWorkspace(normalizedBody, authNpub);
    return c.json({
      workspace_id: result.workspace.id,
      workspace_npub: result.workspace.workspace_owner_npub,
      workspace_owner_npub: result.workspace.workspace_owner_npub,
      workspace_service_npub: result.workspace.workspace_owner_npub,
      creator_npub: result.workspace.creator_npub,
      name: result.workspace.name,
      slug: result.workspace.slug,
      description: result.workspace.description,
      avatar_url: result.workspace.avatar_url,
      direct_https_url: config.directHttpsUrl,
      service_npub: config.service.npub || null,
      default_group_id: result.defaultGroup.id,
      default_group_npub: result.defaultGroup.group_npub,
      admin_group_id: result.adminGroup.id,
      admin_group_npub: result.adminGroup.group_npub,
      private_group_id: result.privateGroup.id,
      private_group_npub: result.privateGroup.group_npub,
      wrapped_workspace_nsec: result.workspace.wrapped_workspace_nsec,
      wrapped_by_npub: result.workspace.wrapped_by_npub,
      created_at: result.workspace.created_at,
      updated_at: result.workspace.updated_at,
    }, 201);
  } catch (error) {
    if (error instanceof Error && /duplicate key value/i.test(error.message)) {
      return c.json({ error: 'workspace or group identity already exists' }, 409);
    }
    return c.json({ error: error instanceof Error ? error.message : 'Failed to create workspace' }, 500);
  }
});

workspacesRouter.get('/', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { signerNpub, userNpub } = auth;

  const memberNpub = c.req.query('member_npub') || c.req.query('npub');
  if (!memberNpub) {
    return c.json({ error: 'member_npub query param required' }, 400);
  }
  // Accept member_npub matching either the signer or resolved user identity
  if (memberNpub !== signerNpub && memberNpub !== userNpub) {
    return c.json({ error: 'member_npub must match authenticated npub' }, 403);
  }

  try {
    // Always query by the real user npub for group membership lookups
    const workspaces = await listWorkspacesForMember(userNpub);
    return c.json({
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        workspace_npub: workspace.workspace_owner_npub,
        workspace_service_npub: workspace.workspace_owner_npub,
        direct_https_url: config.directHttpsUrl,
        service_npub: config.service.npub || null,
      })),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to list workspaces' }, 500);
  }
});

workspacesRouter.post('/recover', async (c) => {
  const authNpub = await requireNip98Auth(c);
  if (authNpub instanceof Response) return authNpub;

  const body = await c.req.json<{
    workspace_owner_npub?: string;
    workspace_service_npub?: string;
    name: string;
    wrapped_workspace_nsec: string;
    wrapped_by_npub: string;
  }>();

  let workspaceServiceNpub: string | undefined;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body as unknown as Record<string, unknown>, [
      'workspace_owner_npub',
      'workspace_service_npub',
    ]);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }

  if (!workspaceServiceNpub || !body.name || !body.wrapped_workspace_nsec || !body.wrapped_by_npub) {
    return c.json({ error: 'workspace_owner_npub or workspace_service_npub, name, wrapped_workspace_nsec, and wrapped_by_npub required' }, 400);
  }
  if (body.wrapped_by_npub !== authNpub) {
    return c.json({ error: 'wrapped_by_npub must match authenticated npub' }, 403);
  }

  try {
    const workspace = await recoverWorkspace(
      workspaceServiceNpub,
      authNpub,
      body.name,
      body.wrapped_workspace_nsec,
      body.wrapped_by_npub,
    );

    const workspaces = await listWorkspacesForMember(authNpub);
    const entry = workspaces.find((w) => w.workspace_owner_npub === workspaceServiceNpub);

    return c.json({
      ...(entry || {}),
      workspace_id: workspace.id,
      workspace_npub: workspace.workspace_owner_npub,
      workspace_owner_npub: workspace.workspace_owner_npub,
      workspace_service_npub: workspace.workspace_owner_npub,
      creator_npub: workspace.creator_npub,
      name: workspace.name,
      slug: workspace.slug,
      direct_https_url: config.directHttpsUrl,
      service_npub: config.service.npub || null,
      wrapped_workspace_nsec: workspace.wrapped_workspace_nsec,
      wrapped_by_npub: workspace.wrapped_by_npub,
      created_at: workspace.created_at,
      updated_at: workspace.updated_at,
    }, 201);
  } catch (error) {
    if (error instanceof Error && (error as any).code === 'ALREADY_EXISTS') {
      return c.json({ error: 'workspace already exists' }, 409);
    }
    if (error instanceof Error && (error as any).code === 'NOT_MEMBER') {
      return c.json({ error: 'not a member of any group for this workspace owner' }, 403);
    }
    return c.json({ error: error instanceof Error ? error.message : 'Failed to recover workspace' }, 500);
  }
});

workspacesRouter.patch('/:workspaceOwnerNpub', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { userNpub } = auth;

  const workspaceOwnerNpub = String(c.req.param('workspaceOwnerNpub') || '').trim();
  if (!workspaceOwnerNpub) {
    return c.json({ error: 'workspaceOwnerNpub path param required' }, 400);
  }

  // canManageWorkspace already resolves ws_key internally
  if (!(await canManageWorkspace(workspaceOwnerNpub, userNpub))) {
    return c.json({ error: 'Not authorized to manage this workspace' }, 403);
  }

  const body = await c.req.json<UpdateWorkspaceInput>();
  const hasName = body.name !== undefined;
  const hasSlug = body.slug !== undefined;
  const hasDescription = body.description !== undefined;
  const hasAvatarUrl = body.avatar_url !== undefined;
  if (!hasName && !hasSlug && !hasDescription && !hasAvatarUrl) {
    return c.json({ error: 'name, slug, description, or avatar_url required' }, 400);
  }

  const nextName = hasName ? String(body.name || '').trim() : undefined;
  if (hasName && !nextName) {
    return c.json({ error: 'name cannot be empty' }, 400);
  }

  const nextSlug = hasSlug ? String(body.slug || '').trim() : undefined;
  const nextDescription = hasDescription ? String(body.description || '').trim() : undefined;
  const nextAvatarUrl = hasAvatarUrl
    ? (body.avatar_url == null ? null : String(body.avatar_url || '').trim() || null)
    : undefined;

  try {
    const updated = await updateWorkspace(workspaceOwnerNpub, {
      name: nextName,
      slug: nextSlug,
      description: nextDescription,
      avatar_url: nextAvatarUrl,
    });
    if (!updated) {
      return c.json({ error: 'Workspace not found' }, 404);
    }

    const workspaces = await listWorkspacesForMember(userNpub);
    const workspace = workspaces.find((entry) => entry.workspace_owner_npub === workspaceOwnerNpub);
    if (!workspace) {
      return c.json({ error: 'Workspace not visible to actor after update' }, 404);
    }

    return c.json({
      ...workspace,
      workspace_npub: workspace.workspace_owner_npub,
      workspace_service_npub: workspace.workspace_owner_npub,
      direct_https_url: config.directHttpsUrl,
      service_npub: config.service.npub || null,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to update workspace' }, 500);
  }
});
