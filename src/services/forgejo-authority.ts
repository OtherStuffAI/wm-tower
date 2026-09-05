import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { getDb } from '../db';
import type {
  GitActorUsername,
  GitActorBootstrap,
  GitForgejoOrganizationDesiredState,
  GitForgejoDesiredState,
  GitForgejoRepositoryBinding,
  GitForgejoWorkspaceBinding,
  GitForgejoWebhookEvidence,
} from '../types';
import { appendGitAuditEvent, ensureGitWorkspaceNamespace, fallbackGitWorkspaceNamespace, GitAuthorityError } from './git-authority';
import { forgejoShadowUsername } from '../forgejo/identity';
import { resolveWsKeyNpub } from './user-workspace-keys';
import type { GitForgejoBrowserActorValidation } from '../types';

export { forgejoShadowUsername } from '../forgejo/identity';

type DbClient = ReturnType<typeof getDb>;

const canonicalNamePattern = /^[a-z0-9][a-z0-9-]{0,38}$/;
const canonicalRepoPattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const deliveryPattern = /^[A-Za-z0-9._:-]{1,200}$/;
const legacyActorUsernamePattern = /^wm-[a-f0-9]{32}$/;
const reservedActorUsernames = new Set(['admin', 'api', 'assets', 'auth', 'explore', 'forgejo', 'git', 'issues', 'milestones', 'org', 'pulls', 'ready', 'repo', 'root', 'tower-identity-reconciler', 'tower-reconciler', 'user', 'v2']);

function serializeActorUsername(row: any, actorId: string): GitActorUsername {
  const fallback = forgejoShadowUsername(actorId);
  return {
    actor_id: actorId,
    username: row?.desired_username ?? fallback,
    applied_username: row?.applied_username ?? fallback,
    state: row?.forgejo_user_id == null && row?.state === 'ready' ? 'pending' : row?.state ?? 'pending',
    last_error_code: row?.last_error_code ?? null,
    created_at: row?.created_at?.toISOString() ?? null,
    updated_at: row?.updated_at?.toISOString() ?? null,
  };
}

export async function appliedForgejoActorUsername(actorId: string, sql: DbClient = getDb()): Promise<string> {
  const fallback = forgejoShadowUsername(actorId);
  await sql`
    INSERT INTO git_forgejo_actor_aliases (actor_id, desired_username, applied_username, state)
    VALUES (${actorId}, ${fallback}, ${fallback}, 'pending')
    ON CONFLICT (actor_id) DO NOTHING
  `;
  const [row] = await sql<{ applied_username: string | null }[]>`
    SELECT applied_username FROM git_forgejo_actor_aliases WHERE actor_id = ${actorId}
  `;
  return row?.applied_username || fallback;
}

async function oidcPreferredForgejoUsername(actorId: string, sql: DbClient) {
  await appliedForgejoActorUsername(actorId, sql);
  const [row] = await sql<{ desired_username: string; applied_username: string | null; forgejo_user_id: string | null }[]>`
    SELECT desired_username, applied_username, forgejo_user_id FROM git_forgejo_actor_aliases WHERE actor_id = ${actorId}
  `;
  return row && row.forgejo_user_id === null ? row.desired_username : row?.applied_username || forgejoShadowUsername(actorId);
}

export async function readGitActorUsername(workspaceId: string, actorNpub: string, sql: DbClient = getDb()): Promise<GitActorUsername> {
  const [actor] = await sql<{ id: string }[]>`
    SELECT actor.id
    FROM flightdeck_pg_actors actor
    JOIN flightdeck_pg_workspace_memberships membership ON membership.actor_id = actor.id
    WHERE membership.workspace_id = ${workspaceId} AND actor.npub = ${actorNpub}
    LIMIT 1
  `;
  if (!actor) throw new GitAuthorityError('git_workspace_not_found', 'Workspace not found', 404);
  const [row] = await sql<any[]>`SELECT * FROM git_forgejo_actor_aliases WHERE actor_id = ${actor.id}`;
  return serializeActorUsername(row, actor.id);
}

export async function gitActorBootstrap(workspaceId: string, actorNpub: string, signerNpub: string, request: boolean, sql: DbClient = getDb()): Promise<GitActorBootstrap> {
  const actor = await readGitActorUsername(workspaceId, actorNpub, sql);
  if (request) {
    await appliedForgejoActorUsername(actor.actor_id, sql);
    await sql`UPDATE git_forgejo_actor_aliases SET state = 'pending', last_error_code = NULL, updated_at = NOW()
      WHERE actor_id = ${actor.actor_id} AND (forgejo_user_id IS NULL OR state = 'error')`;
    await ensureForgejoWorkspaceBinding(workspaceId, sql);
    await appendGitAuditEvent({ workspaceId, actorId: actor.actor_id, actorNpub, signerNpub,
      operation: 'git.actor.bootstrap', decision: 'allow', reasonCode: 'git_actor_bootstrap_requested' }, sql);
  }
  const [alias] = await sql<any[]>`SELECT * FROM git_forgejo_actor_aliases WHERE actor_id = ${actor.actor_id}`;
  const [organization] = await sql<any[]>`SELECT state, last_error_code FROM git_forgejo_workspace_bindings WHERE workspace_id = ${workspaceId}`;
  const accountState = !alias ? 'not_requested' : alias.state === 'error' ? 'error'
    : alias.forgejo_user_id == null || alias.state !== 'ready' ? 'pending' : 'ready';
  const organizationState = organization?.state ?? 'pending';
  return {
    actor_id: actor.actor_id, workspace_id: workspaceId,
    state: accountState === 'not_requested' ? 'not_requested' : accountState === 'error' || organizationState === 'error' ? 'error'
      : accountState === 'ready' && organizationState === 'ready' ? 'ready' : 'pending',
    account_state: accountState, organization_state: organizationState,
    last_error_code: alias?.last_error_code ?? organization?.last_error_code ?? null,
    actor_username: serializeActorUsername(alias, actor.actor_id),
  };
}

export async function listPendingForgejoRepositories(sql: DbClient = getDb()) {
  return sql<{ repository_id: string }[]>`SELECT repository.id AS repository_id FROM git_repositories repository
    LEFT JOIN git_forgejo_repository_bindings binding ON binding.repository_id = repository.id
    WHERE repository.archived_at IS NULL AND repository.state <> 'archived'
      AND (binding.repository_id IS NULL OR binding.state <> 'ready' OR binding.applied_policy_revision IS DISTINCT FROM repository.policy_revision)
    ORDER BY repository.id`;
}

export async function requestGitActorUsername(
  workspaceId: string,
  actorNpub: string,
  signerNpub: string,
  requestedUsername: unknown,
  sql: DbClient = getDb(),
): Promise<GitActorUsername> {
  const username = String(requestedUsername || '').trim().toLowerCase();
  if (!canonicalNamePattern.test(username) || legacyActorUsernamePattern.test(username) || reservedActorUsernames.has(username)) {
    throw new GitAuthorityError('git_actor_username_invalid', 'Forgejo username is invalid or reserved', 400);
  }
  const [actor] = await sql<{ id: string }[]>`
    SELECT actor.id
    FROM flightdeck_pg_actors actor
    JOIN flightdeck_pg_workspace_memberships membership ON membership.actor_id = actor.id
    WHERE membership.workspace_id = ${workspaceId} AND actor.npub = ${actorNpub}
    LIMIT 1
  `;
  if (!actor) throw new GitAuthorityError('git_workspace_not_found', 'Workspace not found', 404);
  try {
    return await sql.begin(async (tx) => {
      const db = tx as unknown as DbClient;
      await db`SELECT pg_advisory_xact_lock(hashtext('git-forgejo-global-name'))`;
      const [namespace] = await db<{ present: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM git_workspace_namespaces WHERE lower(namespace) = ${username}) AS present
      `;
      if (namespace?.present) throw new GitAuthorityError('git_actor_username_conflict', 'Forgejo username is already claimed', 409);
      const [existing] = await db<any[]>`SELECT * FROM git_forgejo_actor_aliases WHERE actor_id = ${actor.id} FOR UPDATE`;
      const [row] = await db<any[]>`
        INSERT INTO git_forgejo_actor_aliases (actor_id, desired_username, applied_username, state)
        VALUES (${actor.id}, ${username}, NULL, 'pending')
        ON CONFLICT (actor_id) DO UPDATE
        SET desired_username = EXCLUDED.desired_username,
            state = CASE WHEN git_forgejo_actor_aliases.forgejo_user_id IS NOT NULL AND git_forgejo_actor_aliases.applied_username = EXCLUDED.desired_username THEN 'ready' ELSE 'pending' END,
            last_error_code = NULL,
            updated_at = NOW()
        RETURNING *
      `;
      await appendGitAuditEvent({
        actorId: actor.id, actorNpub, signerNpub, operation: 'git.actor_username.request',
        decision: 'allow', reasonCode: existing ? 'git_actor_username_change_requested' : 'git_actor_username_requested',
      }, db);
      return serializeActorUsername(row, actor.id);
    });
  } catch (error: any) {
    if (error instanceof GitAuthorityError) throw error;
    if (error?.code === '23505') throw new GitAuthorityError('git_actor_username_conflict', 'Forgejo username is already claimed', 409);
    throw error;
  }
}

export async function listPendingForgejoActorAliases(sql: DbClient = getDb()) {
  const rows = await sql<any[]>`
    SELECT alias.*, actor.npub, actor.display_name
    FROM git_forgejo_actor_aliases alias
    JOIN flightdeck_pg_actors actor ON actor.id = alias.actor_id
    WHERE alias.state = 'pending'
    ORDER BY alias.updated_at, alias.actor_id
  `;
  return rows.map((row) => ({
    actor_id: row.actor_id,
    actor_npub: row.npub,
    display_name: row.display_name,
    current_username: row.applied_username || forgejoShadowUsername(row.actor_id),
    desired_username: row.desired_username,
    state: row.state,
    last_error_code: row.last_error_code,
  }));
}

export async function listForgejoActorBindings(sql: DbClient = getDb()) {
  const rows = await sql<any[]>`
    SELECT alias.actor_id, alias.applied_username, alias.forgejo_user_id, alias.desired_username, alias.state
    FROM git_forgejo_actor_aliases alias
    ORDER BY alias.actor_id
  `;
  return rows.map((row) => ({
    actor_id: row.actor_id,
    current_username: row.applied_username || forgejoShadowUsername(row.actor_id),
    desired_username: row.desired_username,
    state: row.state,
    forgejo_user_id: row.forgejo_user_id === null ? null : Number(row.forgejo_user_id),
  }));
}

export async function syncForgejoActorBinding(input: {
  actorId: string; forgejoUserId: number; username: string; desiredUsername?: string;
}, sql: DbClient = getDb()) {
  const username = String(input.username || '').trim().toLowerCase();
  if (!canonicalNamePattern.test(username) || !Number.isSafeInteger(input.forgejoUserId) || input.forgejoUserId <= 0) {
    throw new GitAuthorityError('git_forgejo_actor_binding_invalid', 'Forgejo actor binding is invalid', 400);
  }
  try {
    const [row] = await sql<any[]>`
      UPDATE git_forgejo_actor_aliases
      SET desired_username = ${username}, applied_username = ${username}, forgejo_user_id = ${input.forgejoUserId},
          state = 'ready', last_error_code = NULL, reconciled_at = NOW(), updated_at = NOW()
      WHERE actor_id = ${input.actorId}
        AND (forgejo_user_id IS NULL OR forgejo_user_id = ${input.forgejoUserId})
        AND (${input.desiredUsername ?? null}::text IS NULL OR desired_username = ${input.desiredUsername ?? null})
      RETURNING *
    `;
    if (!row) throw new GitAuthorityError('git_forgejo_actor_binding_conflict', 'Actor binding changed or is already linked to another provider ID; reread current state', 409);
    return serializeActorUsername(row, input.actorId);
  } catch (error: any) {
    if (error instanceof GitAuthorityError) throw error;
    if (error?.code === '23505') throw new GitAuthorityError('git_forgejo_actor_binding_conflict', 'Forgejo account is already linked to another Tower actor', 409);
    throw error;
  }
}

export async function acknowledgeForgejoActorAlias(input: {
  actorId: string;
  desiredUsername: string;
  ok: boolean;
  errorCode?: string | null;
}, sql: DbClient = getDb()): Promise<GitActorUsername> {
  const [row] = await sql<any[]>`
    UPDATE git_forgejo_actor_aliases
    SET applied_username = CASE WHEN ${input.ok} THEN desired_username ELSE applied_username END,
        state = ${input.ok ? 'ready' : 'error'},
        last_error_code = ${input.ok ? null : String(input.errorCode || 'git_forgejo_actor_rename_failed').slice(0, 200)},
        reconciled_at = CASE WHEN ${input.ok} THEN NOW() ELSE reconciled_at END,
        updated_at = NOW()
    WHERE actor_id = ${input.actorId} AND desired_username = ${input.desiredUsername}
    RETURNING *
  `;
  if (!row) throw new GitAuthorityError('git_actor_username_reconciliation_stale', 'Actor username reconciliation is stale', 409);
  return serializeActorUsername(row, input.actorId);
}

export function canonicalForgejoOwner(workspaceId: string): string {
  return fallbackGitWorkspaceNamespace(workspaceId);
}

export function canonicalForgejoRepository(repositoryId: string): string {
  const compact = repositoryId.toLowerCase().replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/.test(compact)) throw new GitAuthorityError('git_validation_error', 'repository_id is invalid', 400);
  return `r-${compact}`;
}

function serializeWorkspaceBinding(row: any): GitForgejoWorkspaceBinding {
  return {
    workspace_id: row.workspace_id,
    forgejo_owner: row.forgejo_owner,
    desired_generation: Number(row.desired_generation),
    state: row.state,
    reconciled_at: row.reconciled_at?.toISOString() ?? null,
  };
}

export async function ensureForgejoWorkspaceBinding(
  workspaceId: string,
  sql: DbClient = getDb(),
): Promise<GitForgejoWorkspaceBinding> {
  const forgejoOwner = await ensureGitWorkspaceNamespace(workspaceId, sql);
  const [row] = await sql<any[]>`
    INSERT INTO git_forgejo_workspace_bindings (workspace_id, forgejo_owner)
    VALUES (${workspaceId}, ${forgejoOwner})
    ON CONFLICT (workspace_id) DO UPDATE
    SET forgejo_owner = EXCLUDED.forgejo_owner,
        desired_generation = git_forgejo_workspace_bindings.desired_generation +
          CASE WHEN git_forgejo_workspace_bindings.forgejo_owner = EXCLUDED.forgejo_owner THEN 0 ELSE 1 END,
        state = CASE
          WHEN git_forgejo_workspace_bindings.forgejo_owner = EXCLUDED.forgejo_owner
          THEN git_forgejo_workspace_bindings.state ELSE 'pending'
        END,
        updated_at = NOW()
    RETURNING *
  `;
  return serializeWorkspaceBinding(row);
}

export async function listPendingForgejoWorkspaceBindings(sql: DbClient = getDb()) {
  const rows = await sql<any[]>`
    SELECT binding.*
    FROM git_forgejo_workspace_bindings binding
    JOIN flightdeck_pg_workspaces workspace ON workspace.id = binding.workspace_id
    WHERE binding.state IN ('pending', 'error')
    ORDER BY binding.updated_at, binding.workspace_id
  `;
  return rows.map(serializeWorkspaceBinding);
}

export async function readForgejoOrganizationDesiredState(
  workspaceId: string,
  sql: DbClient = getDb(),
): Promise<GitForgejoOrganizationDesiredState> {
  const binding = await ensureForgejoWorkspaceBinding(workspaceId, sql);
  const [workspace] = await sql<{ name: string }[]>`
    SELECT name FROM flightdeck_pg_workspaces WHERE id = ${workspaceId}
  `;
  const actorAccess = await sql<any[]>`
    SELECT membership.actor_id, alias.applied_username AS username,
      CASE WHEN membership.role IN ('owner', 'admin') OR EXISTS (
        SELECT 1
        FROM flightdeck_pg_group_memberships group_membership
        JOIN flightdeck_pg_groups workspace_group ON workspace_group.id = group_membership.group_id
        WHERE group_membership.workspace_id = membership.workspace_id
          AND group_membership.actor_id = membership.actor_id
          AND lower(workspace_group.name) = 'admins'
      ) THEN 'owner' ELSE 'member' END AS organization_role
    FROM flightdeck_pg_workspace_memberships membership
    JOIN git_forgejo_actor_aliases alias ON alias.actor_id = membership.actor_id
    WHERE membership.workspace_id = ${workspaceId}
      AND alias.forgejo_user_id IS NOT NULL
      AND alias.applied_username IS NOT NULL
    ORDER BY alias.applied_username
  `;
  const managed = await sql<{ username: string }[]>`
    SELECT applied_username AS username
    FROM git_forgejo_actor_aliases
    WHERE forgejo_user_id IS NOT NULL AND applied_username IS NOT NULL
    ORDER BY applied_username
  `;
  return {
    ...binding,
    display_name: workspace.name,
    actor_access: actorAccess,
    managed_usernames: managed.map((row) => row.username),
  };
}

export async function acknowledgeForgejoOrganizationReconciliation(input: {
  workspaceId: string;
  forgejoOwner: string;
  desiredGeneration: number;
  ok: boolean;
  errorCode?: string | null;
}, sql: DbClient = getDb()): Promise<GitForgejoWorkspaceBinding> {
  if (!Number.isSafeInteger(input.desiredGeneration) || input.desiredGeneration < 1) {
    throw new GitAuthorityError('git_organization_reconciliation_stale', 'Organization reconciliation is stale', 409);
  }
  const [row] = await sql<any[]>`
    UPDATE git_forgejo_workspace_bindings
    SET state = ${input.ok ? 'ready' : 'error'},
        last_error_code = ${input.ok ? null : String(input.errorCode || 'git_forgejo_organization_reconciliation_failed').slice(0, 200)},
        reconciled_at = ${input.ok ? new Date() : null},
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId} AND forgejo_owner = ${input.forgejoOwner}
      AND desired_generation = ${input.desiredGeneration}
    RETURNING *
  `;
  if (!row) throw new GitAuthorityError('git_organization_reconciliation_stale', 'Organization reconciliation is stale', 409);
  return serializeWorkspaceBinding(row);
}

function serializeBinding(row: any): GitForgejoRepositoryBinding {
  return {
    repository_id: row.repository_id,
    workspace_id: row.workspace_id,
    forgejo_owner: row.forgejo_owner,
    forgejo_repository: row.forgejo_repository,
    desired_policy_revision: Number(row.desired_policy_revision),
    applied_policy_revision: row.applied_policy_revision === null ? null : Number(row.applied_policy_revision),
    state: row.state,
    reconciled_at: row.reconciled_at?.toISOString() ?? null,
  };
}

export async function ensureForgejoBinding(repositoryId: string, sql: DbClient = getDb()): Promise<GitForgejoRepositoryBinding> {
  const [repository] = await sql<any[]>`
    SELECT repository.id, repository.workspace_id, repository.slug, repository.policy_revision
    FROM git_repositories repository
    JOIN flightdeck_pg_workspaces workspace ON workspace.id = repository.workspace_id
    WHERE repository.id = ${repositoryId} AND repository.archived_at IS NULL
  `;
  if (!repository) throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  const forgejoOwner = (await ensureForgejoWorkspaceBinding(repository.workspace_id, sql)).forgejo_owner;
  const [row] = await sql<any[]>`
    INSERT INTO git_forgejo_repository_bindings (
      repository_id, workspace_id, forgejo_owner, forgejo_repository, desired_policy_revision
    ) VALUES (
      ${repository.id}, ${repository.workspace_id}, ${forgejoOwner},
      ${repository.slug}, ${repository.policy_revision}
    )
    ON CONFLICT (repository_id) DO UPDATE
    SET forgejo_owner = EXCLUDED.forgejo_owner,
        forgejo_repository = EXCLUDED.forgejo_repository,
        desired_policy_revision = EXCLUDED.desired_policy_revision,
        applied_policy_revision = CASE
          WHEN git_forgejo_repository_bindings.forgejo_owner = EXCLUDED.forgejo_owner
           AND git_forgejo_repository_bindings.forgejo_repository = EXCLUDED.forgejo_repository
          THEN git_forgejo_repository_bindings.applied_policy_revision
          ELSE NULL
        END,
        state = CASE
          WHEN git_forgejo_repository_bindings.reconciliation_token IS NULL
           AND git_forgejo_repository_bindings.forgejo_owner = EXCLUDED.forgejo_owner
           AND git_forgejo_repository_bindings.forgejo_repository = EXCLUDED.forgejo_repository
           AND git_forgejo_repository_bindings.applied_policy_revision = EXCLUDED.desired_policy_revision THEN 'ready'
          ELSE 'pending'
        END,
        updated_at = NOW()
    RETURNING *
  `;
  return serializeBinding(row);
}

export async function resolveForgejoRepositoryPath(owner: string, repository: string, sql: DbClient = getDb()) {
  if (!canonicalNamePattern.test(owner) || !canonicalRepoPattern.test(repository)) {
    throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  }
  const [row] = await sql<any[]>`
    SELECT binding.*, repo.state AS repository_state, repo.policy_revision
    FROM git_forgejo_repository_bindings binding
    JOIN git_repositories repo ON repo.id = binding.repository_id
    WHERE binding.forgejo_owner = ${owner} AND binding.forgejo_repository = ${repository}
      AND repo.archived_at IS NULL
  `;
  if (!row) throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  return {
    ...serializeBinding(row),
    ready: row.state === 'ready' && row.reconciliation_token === null
      && Number(row.applied_policy_revision) === Number(row.policy_revision)
      && row.repository_state === 'active',
  };
}

export async function readForgejoDesiredState(repositoryId: string, sql: DbClient = getDb()): Promise<GitForgejoDesiredState> {
  const binding = await ensureForgejoBinding(repositoryId, sql);
  const [repository] = await sql<any[]>`
    SELECT display_name, description, default_branch, binding.reconciliation_token
    FROM git_repositories repository JOIN git_forgejo_repository_bindings binding ON binding.repository_id = repository.id
    WHERE repository.id = ${repositoryId}
  `;
  const branchRules = await sql<any[]>`
    SELECT id AS policy_id, ref_name, branch_class, protected, service_managed,
           allow_direct_push, allow_force_push, allow_delete, required_approvals,
           required_checks, merge_methods
    FROM git_branch_policies WHERE repository_id = ${repositoryId} ORDER BY ref_name
  `;
  const actorAccess = await sql<any[]>`
    WITH RECURSIVE effective_group_memberships(workspace_id, group_id, actor_id) AS (
      SELECT workspace_id, group_id, actor_id FROM flightdeck_pg_group_memberships
      UNION
      SELECT edge.workspace_id, edge.parent_group_id, membership.actor_id
      FROM flightdeck_pg_group_edges edge
      JOIN effective_group_memberships membership
        ON membership.workspace_id = edge.workspace_id
       AND membership.group_id = edge.child_group_id
    ), principals AS (
      SELECT principal_actor_id AS actor_id, permission
      FROM git_repository_grants
      WHERE repository_id = ${repositoryId} AND revoked_at IS NULL AND principal_type = 'actor'
      UNION ALL
      SELECT member.actor_id, repository_grant.permission
      FROM git_repository_grants repository_grant
      JOIN effective_group_memberships member
        ON member.workspace_id = repository_grant.workspace_id
       AND member.group_id = repository_grant.principal_group_id
      WHERE repository_grant.repository_id = ${repositoryId}
        AND repository_grant.revoked_at IS NULL
        AND repository_grant.principal_type = 'group'
    )
    SELECT principals.actor_id, actor.display_name, alias.applied_username,
      CASE WHEN membership.role IN ('owner', 'admin') THEN 'owner' ELSE 'member' END AS organization_role,
      CASE
        WHEN bool_or(permission = 'git.repo.admin') THEN 'admin'
        WHEN bool_or(permission IN ('git.repo.write', 'git.branch.create')) THEN 'write'
        ELSE 'read'
      END AS permission
    FROM principals
    JOIN flightdeck_pg_actors actor ON actor.id = principals.actor_id
    JOIN flightdeck_pg_workspace_memberships membership
      ON membership.workspace_id = ${binding.workspace_id}
     AND membership.actor_id = principals.actor_id
    LEFT JOIN git_forgejo_actor_aliases alias ON alias.actor_id = principals.actor_id
    GROUP BY principals.actor_id, actor.display_name, alias.applied_username, membership.role
  `;
  return {
    ...binding,
    reconciliation_token: repository.reconciliation_token,
    display_name: repository.display_name,
    description: repository.description,
    private: true,
    default_branch: repository.default_branch,
    branch_rules: branchRules.map((row) => ({
      ...row,
      required_approvals: Number(row.required_approvals),
    })),
    actor_access: actorAccess.map((row) => ({
      actor_id: row.actor_id,
      shadow_username: row.applied_username || forgejoShadowUsername(row.actor_id),
      display_name: row.display_name,
      permission: row.permission,
      organization_role: row.organization_role,
    })),
  };
}

/**
 * Revalidates a browser actor against Tower on every proxied request. The
 * global reconciliation gate is intentionally conservative: while any active
 * repository has stale Forgejo policy, no browser session is allowed through.
 * This prevents stale collaborator rows from leaking repository metadata.
 */
export async function validateForgejoBrowserActor(input: {
  signerNpub: string;
  expectedActorId?: string | null;
}, sql: DbClient = getDb()): Promise<GitForgejoBrowserActorValidation> {
  const signerNpub = String(input.signerNpub || '').trim();
  const actorNpub = await resolveWsKeyNpub(signerNpub) ?? signerNpub;
  const [actor] = await sql<{ id: string; npub: string; display_name: string | null }[]>`
    SELECT id, npub, display_name FROM flightdeck_pg_actors WHERE npub = ${actorNpub} LIMIT 1
  `;
  if (!actor || (input.expectedActorId && actor.id !== input.expectedActorId)) {
    if (!input.expectedActorId) await appendGitAuditEvent({
      source: 'tower', actorNpub, signerNpub, operation: 'git.browser.login',
      decision: 'deny', reasonCode: 'git_browser_actor_unknown',
    }, sql);
    return { active: false, reason_code: 'git_browser_actor_unknown' };
  }
  const actorUsername = await oidcPreferredForgejoUsername(actor.id, sql);

  const [stale] = await sql<{ stale: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM git_repositories repository
      LEFT JOIN git_forgejo_repository_bindings binding ON binding.repository_id = repository.id
      WHERE repository.archived_at IS NULL
        AND repository.state <> 'archived'
        AND (
          binding.repository_id IS NULL
          OR binding.state <> 'ready'
          OR binding.applied_policy_revision IS DISTINCT FROM repository.policy_revision
        )
    ) AS stale
  `;
  if (stale?.stale) {
    if (!input.expectedActorId) await appendGitAuditEvent({
      source: 'tower', actorId: actor.id, actorNpub: actor.npub, signerNpub,
      operation: 'git.browser.login', decision: 'deny', reasonCode: 'git_browser_reconciliation_stale',
    }, sql);
    return { active: false, reason_code: 'git_browser_reconciliation_stale' };
  }

  const [organizationStale] = await sql<{ stale: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM flightdeck_pg_workspace_memberships membership
      LEFT JOIN git_forgejo_workspace_bindings binding ON binding.workspace_id = membership.workspace_id
      WHERE membership.actor_id = ${actor.id}
        AND (binding.workspace_id IS NULL OR binding.state <> 'ready')
    ) AS stale
  `;
  if (organizationStale?.stale) {
    if (!input.expectedActorId) await appendGitAuditEvent({
      source: 'tower', actorId: actor.id, actorNpub: actor.npub, signerNpub,
      operation: 'git.browser.login', decision: 'deny', reasonCode: 'git_browser_reconciliation_stale',
    }, sql);
    return { active: false, reason_code: 'git_browser_reconciliation_stale' };
  }

  const organizations = await sql<any[]>`
    SELECT membership.workspace_id, binding.forgejo_owner,
      CASE WHEN membership.role IN ('owner', 'admin') OR EXISTS (
        SELECT 1
        FROM flightdeck_pg_group_memberships group_membership
        JOIN flightdeck_pg_groups workspace_group ON workspace_group.id = group_membership.group_id
        WHERE group_membership.workspace_id = membership.workspace_id
          AND group_membership.actor_id = membership.actor_id
          AND lower(workspace_group.name) = 'admins'
      ) THEN 'owner' ELSE 'member' END AS organization_role
    FROM flightdeck_pg_workspace_memberships membership
    JOIN git_forgejo_workspace_bindings binding ON binding.workspace_id = membership.workspace_id
    WHERE membership.actor_id = ${actor.id} AND binding.state = 'ready'
    ORDER BY binding.forgejo_owner
  `;

  const rows = await sql<any[]>`
    WITH RECURSIVE actor_groups(workspace_id, group_id) AS (
      SELECT workspace_id, group_id FROM flightdeck_pg_group_memberships WHERE actor_id = ${actor.id}
      UNION
      SELECT edge.workspace_id, edge.parent_group_id
      FROM flightdeck_pg_group_edges edge
      JOIN actor_groups membership
        ON membership.workspace_id = edge.workspace_id
       AND membership.group_id = edge.child_group_id
    ), effective_access AS (
      SELECT repository_grant.repository_id, repository_grant.workspace_id, repository_grant.permission
      FROM git_repository_grants repository_grant
      WHERE repository_grant.revoked_at IS NULL
        AND (
          (repository_grant.principal_type = 'actor' AND repository_grant.principal_actor_id = ${actor.id})
          OR (repository_grant.principal_type = 'group' AND EXISTS (
            SELECT 1 FROM actor_groups membership
            WHERE membership.workspace_id = repository_grant.workspace_id
              AND membership.group_id = repository_grant.principal_group_id
          ))
        )
    )
    SELECT access.repository_id, access.workspace_id, binding.forgejo_owner,
           binding.forgejo_repository,
           CASE
             WHEN bool_or(access.permission = 'git.repo.admin') THEN 'admin'
             WHEN bool_or(access.permission IN ('git.repo.write', 'git.branch.create')) THEN 'write'
             ELSE 'read'
           END AS permission
    FROM effective_access access
    JOIN git_repositories repository ON repository.id = access.repository_id
    JOIN git_forgejo_repository_bindings binding ON binding.repository_id = access.repository_id
    WHERE repository.archived_at IS NULL AND repository.state = 'active'
      AND binding.state = 'ready'
      AND binding.applied_policy_revision = repository.policy_revision
    GROUP BY access.repository_id, access.workspace_id, binding.forgejo_owner, binding.forgejo_repository
    ORDER BY binding.forgejo_owner, binding.forgejo_repository
  `;
  if (rows.length === 0 && organizations.length === 0) {
    if (!input.expectedActorId) await appendGitAuditEvent({
      source: 'tower', actorId: actor.id, actorNpub: actor.npub, signerNpub,
      operation: 'git.browser.login', decision: 'deny', reasonCode: 'git_browser_actor_unentitled',
    }, sql);
    return { active: false, reason_code: 'git_browser_actor_unentitled' };
  }
  if (!input.expectedActorId) await appendGitAuditEvent({
    source: 'tower', actorId: actor.id, actorNpub: actor.npub, signerNpub,
    operation: 'git.browser.login', decision: 'allow', reasonCode: 'git_browser_session_created',
  }, sql);
  return {
    active: true,
    reason_code: 'git_browser_actor_active',
    actor_id: actor.id,
    actor_npub: actor.npub,
    actor_username: actorUsername,
    ...(actor.display_name ? { actor_display_name: actor.display_name } : {}),
    signer_npub: signerNpub,
    organizations: organizations.map((row) => ({
      workspace_id: row.workspace_id,
      forgejo_owner: row.forgejo_owner,
      organization_role: row.organization_role,
    })),
    repositories: rows.map((row) => ({
      repository_id: row.repository_id,
      workspace_id: row.workspace_id,
      forgejo_owner: row.forgejo_owner,
      forgejo_repository: row.forgejo_repository,
      permission: row.permission,
    })),
  };
}

export async function beginForgejoReconciliation(repositoryId: string, token: string, sql: DbClient = getDb()) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new GitAuthorityError('git_reconciliation_token_invalid', 'Reconciliation token is required', 400);
  }
  return sql.begin(async tx => {
    const db = tx as unknown as DbClient;
    await db`SELECT id FROM git_repositories WHERE id = ${repositoryId} FOR UPDATE`;
    await ensureForgejoBinding(repositoryId, db);
    const [binding] = await db<any[]>`UPDATE git_forgejo_repository_bindings SET reconciliation_token = ${token}, state = 'pending'
      WHERE repository_id = ${repositoryId} AND reconciliation_token IS NULL RETURNING repository_id`;
    if (!binding) throw new GitAuthorityError('git_reconciliation_busy', 'Repository reconciliation is already in progress', 409);
    return readForgejoDesiredState(repositoryId, db);
  });
}

export async function acknowledgeForgejoReconciliation(input: {
  repositoryId: string;
  appliedPolicyRevision: number;
  reconciliationToken: string;
  ok: boolean;
  errorCode?: string | null;
}, sql: DbClient = getDb()): Promise<GitForgejoRepositoryBinding> {
  if (!Number.isSafeInteger(input.appliedPolicyRevision) || input.appliedPolicyRevision < 1) {
    throw new GitAuthorityError('git_validation_error', 'applied_policy_revision is invalid', 400);
  }
  const result = await sql.begin(async tx => {
    const db = tx as unknown as DbClient;
    const [repository] = await db<any[]>`SELECT policy_revision FROM git_repositories WHERE id = ${input.repositoryId} FOR UPDATE`;
    const [binding] = await db<any[]>`SELECT * FROM git_forgejo_repository_bindings WHERE repository_id = ${input.repositoryId} FOR UPDATE`;
    if (!input.reconciliationToken || binding?.reconciliation_token !== input.reconciliationToken) {
      throw new GitAuthorityError('git_reconciliation_token_invalid', 'Reconciliation attempt does not own this repository', 409);
    }
    const current = Number(repository.policy_revision) === input.appliedPolicyRevision;
    const ready = current && input.ok;
    const [row] = await db<any[]>`UPDATE git_forgejo_repository_bindings
      SET reconciliation_token = NULL, applied_policy_revision = ${ready ? input.appliedPolicyRevision : null},
        state = ${ready ? 'ready' : 'pending'}, last_error_code = ${ready ? null : current ? String(input.errorCode || 'git_forgejo_reconciliation_failed').slice(0, 200) : 'git_reconciliation_stale'},
        reconciled_at = ${ready ? new Date() : null}, updated_at = NOW() WHERE repository_id = ${input.repositoryId} RETURNING *`;
    if (ready) await db`UPDATE git_repositories SET state = 'active', updated_at = NOW() WHERE id = ${input.repositoryId}`;
    return { row, current };
  });
  if (!result.current) throw new GitAuthorityError('git_reconciliation_stale', 'Reconciliation revision is stale; retry current authority', 409);
  return serializeBinding(result.row);
}

function verifyWebhookSignature(body: string, provided: string): boolean {
  const secret = config.git.forgejoWebhookSecret;
  if (!secret || secret.length < 32) throw new GitAuthorityError('git_forgejo_webhook_unconfigured', 'Forgejo webhook ingestion is not configured', 503);
  const normalized = provided.toLowerCase().replace(/^sha256=/, '');
  if (!/^[a-f0-9]{64}$/.test(normalized)) return false;
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(normalized, 'hex'));
}

function normalizeSha(value: unknown): string | null {
  const sha = String(value || '').toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(sha) ? sha : null;
}

export async function ingestForgejoWebhook(input: {
  rawBody: string;
  signature: string;
  deliveryId: string;
  eventType: string;
}, sql: DbClient = getDb()): Promise<{ duplicate: boolean; evidence?: GitForgejoWebhookEvidence }> {
  if (input.eventType !== 'push') throw new GitAuthorityError('git_forgejo_event_unsupported', 'Forgejo webhook event is not supported', 400);
  if (!verifyWebhookSignature(input.rawBody, input.signature)) {
    throw new GitAuthorityError('git_forgejo_webhook_signature_invalid', 'Forgejo webhook signature is invalid', 401);
  }
  if (!deliveryPattern.test(input.deliveryId)) throw new GitAuthorityError('git_forgejo_delivery_invalid', 'Forgejo delivery id is invalid', 400);
  if (Buffer.byteLength(input.rawBody, 'utf8') > 1_048_576) throw new GitAuthorityError('git_forgejo_webhook_too_large', 'Forgejo webhook is too large', 413);
  let payload: any;
  try { payload = JSON.parse(input.rawBody); } catch { throw new GitAuthorityError('git_validation_error', 'Webhook body must be valid JSON', 400); }
  const owner = String(payload?.repository?.owner?.username || payload?.repository?.owner?.login || '');
  const repository = String(payload?.repository?.name || '');
  const binding = await resolveForgejoRepositoryPath(owner, repository, sql);
  const bodyHash = createHash('sha256').update(input.rawBody, 'utf8').digest('hex');
  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    const deliveries = await db<{ delivery_id: string }[]>`
      INSERT INTO git_forgejo_webhook_deliveries (delivery_id, event_type, repository_id, body_sha256)
      VALUES (${input.deliveryId}, ${input.eventType.slice(0, 100)}, ${binding.repository_id}, ${bodyHash})
      ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id
    `;
    if (deliveries.length === 0) return { duplicate: true };
    const occurredAt = new Date(payload?.head_commit?.timestamp || payload?.commits?.[0]?.timestamp || Date.now());
    const safeOccurredAt = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
    const [event] = await db<any[]>`
      INSERT INTO git_forgejo_events (
        delivery_id, repository_id, event_type, actor_shadow_username, ref_name,
        old_sha, new_sha, forced, created, deleted, occurred_at
      ) VALUES (
        ${input.deliveryId}, ${binding.repository_id}, ${input.eventType.slice(0, 100)},
        ${String(payload?.sender?.username || payload?.pusher?.username || '').slice(0, 100) || null},
        ${/^refs\/[A-Za-z0-9._/-]+$/.test(String(payload?.ref || '')) ? payload.ref : null},
        ${normalizeSha(payload?.before)}, ${normalizeSha(payload?.after)}, ${Boolean(payload?.forced)},
        ${Boolean(payload?.created)}, ${Boolean(payload?.deleted)}, ${safeOccurredAt}
      ) RETURNING *
    `;
    await appendGitAuditEvent({
      source: 'forgejo', workspaceId: binding.workspace_id, repositoryId: binding.repository_id,
      operation: `git.forgejo.${input.eventType.slice(0, 80)}`, decision: 'allow',
      reasonCode: 'git_forgejo_webhook_verified', policyRevision: binding.desired_policy_revision,
      correlationId: input.deliveryId,
    }, db);
    return {
      duplicate: false,
      evidence: {
        event_id: event.id, delivery_id: event.delivery_id, event_type: event.event_type,
        repository_id: event.repository_id, actor_shadow_username: event.actor_shadow_username,
        ref_name: event.ref_name, old_sha: event.old_sha, new_sha: event.new_sha,
        forced: event.forced, created: event.created, deleted: event.deleted,
        occurred_at: event.occurred_at.toISOString(),
      },
    };
  });
}
