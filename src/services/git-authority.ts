import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config';
import { getDb } from '../db';
import type {
  CreateGitRepositoryGrantRequest,
  CreateGitRepositoryRequest,
  GitWorkspaceNamespace,
  GitAuditEvent,
  GitBranchPolicy,
  GitCapabilityIntrospectionRequest,
  GitCapabilityIntrospectionResponse,
  GitCapabilityScope,
  GitCredentialExchangeRequest,
  GitCredentialExchangeResponse,
  GitRepository,
  GitRepositoryGrant,
  GitRepositoryPermission,
  GitRepositoryPolicy,
  GitService,
  RevokeGitCapabilityRequest,
  UpdateGitRepositoryPolicyRequest,
} from '../types';
import { gitCapabilityScopes, gitRepositoryPermissions } from '../types';
import type { StrictNip98Verification } from '../auth';
import { forgejoShadowUsername } from '../forgejo/identity';
import { authorizeFlightDeckPgOperation } from './flightdeck-pg-authorization';

type DbClient = ReturnType<typeof getDb>;

export class GitAuthorityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

type GitActorContext = {
  actorId: string;
  actorNpub: string;
  actorDisplayName: string | null;
  actorKind: string;
  workspaceId: string;
  workspaceOwnerNpub: string;
  appNpub: string;
  role: string;
  effectiveGroupIds: string[];
};

type GitRepositoryRow = {
  id: string;
  workspace_id: string;
  git_namespace: string;
  scope_id: string | null;
  slug: string;
  display_name: string;
  description: string;
  visibility: 'private';
  default_branch: 'main';
  state: GitRepository['state'];
  policy_revision: number;
  created_by_actor_id: string;
  created_at: Date;
  updated_at: Date;
};

type GitGrantRow = {
  id: string;
  repository_id: string;
  principal_type: 'actor' | 'group';
  principal_actor_id: string | null;
  principal_group_id: string | null;
  permission: GitRepositoryPermission;
  ref_constraints: { prefixes?: unknown };
  created_by_actor_id: string;
  created_at: Date;
  revoked_by_actor_id: string | null;
  revoked_at: Date | null;
};

type GitBranchPolicyRow = {
  id: string;
  ref_name: string;
  branch_class: GitBranchPolicy['branch_class'];
  protected: boolean;
  service_managed: boolean;
  allow_direct_push: boolean;
  allow_force_push: boolean;
  allow_delete: boolean;
  required_approvals: number;
  required_checks: string[];
  merge_methods: GitBranchPolicy['merge_methods'];
};

type GitCapabilityRow = {
  id: string;
  capability_hash_prefix: string;
  workspace_id: string;
  repository_id: string;
  actor_id: string;
  actor_npub: string;
  actor_display_name: string | null;
  signer_npub: string;
  scopes: GitCapabilityScope[];
  audience: string;
  git_service: GitService | null;
  policy_revision: number;
  current_policy_revision: number;
  ref_constraints: { prefixes?: unknown };
  autopilot_instance_npub: string | null;
  session_id: string | null;
  task_id: string | null;
  workroom_id: string | null;
  correlation_id: string;
  issued_at: Date;
  expires_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const namespacePattern = /^[a-z0-9][a-z0-9-]{0,38}$/;
const legacyNamespacePattern = /^wm-[a-f0-9]{32}$/;
const reservedNamespaces = new Set(['admin', 'api', 'assets', 'auth', 'explore', 'health', 'issues', 'milestones', 'org', 'pulls', 'ready', 'repo', 'user', 'v2']);
const permittedWorkPrefixes = ['refs/heads/work/', 'refs/heads/feature/'] as const;
const protectedRefs = new Map<string, 'main' | 'staging' | 'deployed'>([
  ['refs/heads/main', 'main'],
  ['refs/heads/staging', 'staging'],
  ['refs/heads/deployed', 'deployed'],
] as const);

export function fallbackGitWorkspaceNamespace(workspaceId: string): string {
  const compact = workspaceId.toLowerCase().replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/.test(compact)) throw new GitAuthorityError('git_validation_error', 'workspace_id is invalid', 400);
  return `wm-${compact}`;
}

export async function ensureGitWorkspaceNamespace(workspaceId: string, sql: DbClient = getDb()): Promise<string> {
  const [workspace] = await sql<{ slug: string }[]>`SELECT slug FROM flightdeck_pg_workspaces WHERE id = ${workspaceId}`;
  if (!workspace) throw new GitAuthorityError('git_workspace_not_found', 'Workspace not found', 404);
  const slug = String(workspace.slug || '').trim().toLowerCase();
  let candidate = namespacePattern.test(slug) && !reservedNamespaces.has(slug) && !legacyNamespacePattern.test(slug)
    ? slug
    : fallbackGitWorkspaceNamespace(workspaceId);
  const [actorAlias] = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM git_forgejo_actor_aliases
      WHERE lower(desired_username) = ${candidate} OR lower(applied_username) = ${candidate}
    ) AS present
  `;
  if (actorAlias?.present) candidate = fallbackGitWorkspaceNamespace(workspaceId);
  try {
    await sql`
      INSERT INTO git_workspace_namespaces (workspace_id, namespace)
      VALUES (${workspaceId}, ${candidate})
      ON CONFLICT (workspace_id) DO NOTHING
    `;
  } catch (error: any) {
    if (error?.code === '23505') throw new GitAuthorityError('git_namespace_conflict', 'Workspace Git namespace is already claimed', 409);
    throw error;
  }
  const [row] = await sql<{ namespace: string }[]>`SELECT namespace FROM git_workspace_namespaces WHERE workspace_id = ${workspaceId}`;
  if (!row) throw new GitAuthorityError('git_namespace_unavailable', 'Workspace Git namespace is unavailable', 409);
  return row.namespace;
}

function explicitGitNamespace(value: unknown): string {
  const namespace = normalizeString(value, 'namespace', 39).toLowerCase();
  if (!namespacePattern.test(namespace) || reservedNamespaces.has(namespace) || legacyNamespacePattern.test(namespace)) {
    throw new GitAuthorityError('git_namespace_invalid', 'Git namespace is invalid or reserved', 400);
  }
  return namespace;
}

export async function claimGitWorkspaceNamespace(
  workspaceId: string,
  actorNpub: string,
  signerNpub: string,
  requestedNamespace: unknown,
  sql: DbClient = getDb(),
): Promise<GitWorkspaceNamespace> {
  assertUuid(workspaceId, 'workspace_id');
  const actor = await resolveActorContext(workspaceId, actorNpub, sql);
  if (!actor) throw new GitAuthorityError('git_workspace_not_found', 'Workspace not found', 404);
  if (!['owner', 'admin'].includes(actor.role)) {
    throw new GitAuthorityError('git_namespace_claim_denied', 'Git namespace claims require workspace owner or admin authority', 403);
  }
  const namespace = explicitGitNamespace(requestedNamespace);
  try {
    return await sql.begin(async (tx) => {
      const db = tx as unknown as DbClient;
      await db`SELECT id FROM flightdeck_pg_workspaces WHERE id = ${workspaceId} FOR UPDATE`;
      await db`SELECT pg_advisory_xact_lock(hashtext('git-forgejo-global-name'))`;
      const [actorAlias] = await db<{ present: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM git_forgejo_actor_aliases
          WHERE lower(desired_username) = ${namespace} OR lower(applied_username) = ${namespace}
        ) AS present
      `;
      if (actorAlias?.present) throw new GitAuthorityError('git_namespace_conflict', 'Workspace Git namespace is already claimed', 409);
      const [repository] = await db<{ present: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM git_repositories WHERE workspace_id = ${workspaceId} AND archived_at IS NULL) AS present
      `;
      const [organization] = await db<{ forgejo_owner: string; state: string }[]>`
        SELECT forgejo_owner, state FROM git_forgejo_workspace_bindings WHERE workspace_id = ${workspaceId}
      `;
      const [existing] = await db<any[]>`SELECT * FROM git_workspace_namespaces WHERE workspace_id = ${workspaceId}`;
      if ((repository?.present || organization?.state === 'ready') && existing?.namespace !== namespace) {
        throw new GitAuthorityError('git_namespace_locked', 'Git namespace is locked after Forgejo organization provisioning or repository creation', 409);
      }
      const [row] = await db<any[]>`
        INSERT INTO git_workspace_namespaces (workspace_id, namespace)
        VALUES (${workspaceId}, ${namespace})
        ON CONFLICT (workspace_id) DO UPDATE
        SET namespace = EXCLUDED.namespace, updated_at = NOW()
        RETURNING *
      `;
      await db`
        INSERT INTO git_forgejo_workspace_bindings (workspace_id, forgejo_owner, state)
        VALUES (${workspaceId}, ${namespace}, 'pending')
        ON CONFLICT (workspace_id) DO UPDATE
        SET forgejo_owner = EXCLUDED.forgejo_owner, state = 'pending',
            last_error_code = NULL, reconciled_at = NULL, updated_at = NOW()
      `;
      await appendGitAuditEvent({
        workspaceId, actorId: actor.actorId, actorNpub, signerNpub,
        operation: 'git.namespace.claim', decision: 'allow',
        reasonCode: existing ? 'git_namespace_updated' : 'git_namespace_claimed',
      }, db);
      return {
        workspace_id: row.workspace_id,
        namespace: row.namespace,
        locked: Boolean(repository?.present),
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      };
    });
  } catch (error: any) {
    if (error instanceof GitAuthorityError) throw error;
    if (error?.code === '23505') throw new GitAuthorityError('git_namespace_conflict', 'Workspace Git namespace is already claimed', 409);
    throw error;
  }
}
const repositoryPermissionSet = new Set<string>(gitRepositoryPermissions);
const capabilityScopeSet = new Set<string>(gitCapabilityScopes);

const defaultBranchRules: Array<Omit<GitBranchPolicy, 'policy_id'>> = [
  {
    ref_name: 'refs/heads/main',
    branch_class: 'main',
    protected: true,
    service_managed: true,
    allow_direct_push: false,
    allow_force_push: false,
    allow_delete: false,
    required_approvals: 1,
    required_checks: [],
    merge_methods: ['squash'],
  },
  {
    ref_name: 'refs/heads/staging',
    branch_class: 'staging',
    protected: true,
    service_managed: true,
    allow_direct_push: false,
    allow_force_push: false,
    allow_delete: false,
    required_approvals: 0,
    required_checks: [],
    merge_methods: ['squash'],
  },
  {
    ref_name: 'refs/heads/deployed',
    branch_class: 'deployed',
    protected: true,
    service_managed: true,
    allow_direct_push: false,
    allow_force_push: false,
    allow_delete: false,
    required_approvals: 0,
    required_checks: [],
    merge_methods: ['squash'],
  },
  ...permittedWorkPrefixes.map((refName) => ({
    ref_name: refName,
    branch_class: 'work' as const,
    protected: false,
    service_managed: false,
    allow_direct_push: true,
    allow_force_push: false,
    allow_delete: false,
    required_approvals: 0,
    required_checks: [],
    merge_methods: ['squash'] as Array<'squash'>,
  })),
];

function assertUuid(value: string, field: string): string {
  const normalized = String(value || '').trim();
  if (!uuidPattern.test(normalized)) {
    throw new GitAuthorityError('git_validation_error', `${field} must be a UUID`, 400);
  }
  return normalized;
}

function normalizeString(value: unknown, field: string, maxLength: number, required = true): string {
  const normalized = String(value ?? '').trim();
  if ((required && !normalized) || normalized.length > maxLength) {
    throw new GitAuthorityError('git_validation_error', `${field} is invalid`, 400);
  }
  return normalized;
}

function normalizeRefPrefixes(input: unknown, permission: GitRepositoryPermission): string[] {
  const defaults = permission === 'git.repo.write' || permission === 'git.branch.create'
    ? [...permittedWorkPrefixes]
    : [];
  if (input === undefined || input === null) return defaults;
  if (!Array.isArray(input) || input.length > 20) {
    throw new GitAuthorityError('git_ref_constraints_invalid', 'ref_constraints.prefixes must be an array', 400);
  }
  const prefixes = [...new Set(input.map((value) => String(value || '').trim()))];
  if (
    prefixes.some((prefix) =>
      !permittedWorkPrefixes.some((allowed) => prefix.startsWith(allowed))
      || prefix.includes('..')
      || prefix.includes('@{')
      || prefix.includes('\\')
      || prefix.includes('//')
      || prefix.length > 200
      || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(prefix))
  ) {
    throw new GitAuthorityError('git_ref_constraints_invalid', 'Only safe work/ or feature/ ref prefixes are allowed', 400);
  }
  if ((permission === 'git.repo.read' || permission === 'git.repo.admin') && prefixes.length > 0) {
    throw new GitAuthorityError('git_ref_constraints_invalid', 'This permission does not accept ref constraints', 400);
  }
  return prefixes.sort();
}

function normalizeBranchRules(input: UpdateGitRepositoryPolicyRequest['branch_rules']): Array<Omit<GitBranchPolicy, 'policy_id'>> {
  if (!Array.isArray(input) || input.length < 3 || input.length > 20) {
    throw new GitAuthorityError('git_policy_invalid', 'branch_rules must contain the protected refs and optional work rules', 400);
  }
  const seen = new Set<string>();
  const rules = input.map((rule) => {
    const refName = normalizeString(rule.ref_name, 'ref_name', 200);
    if (seen.has(refName)) throw new GitAuthorityError('git_policy_invalid', 'branch_rules contain duplicate refs', 400);
    seen.add(refName);
    const requiredChecks = Array.isArray(rule.required_checks)
      ? [...new Set(rule.required_checks.map((item) => normalizeString(item, 'required_check', 128)))].sort()
      : [];
    const mergeMethods = Array.isArray(rule.merge_methods)
      ? [...new Set(rule.merge_methods)]
      : [];
    if (mergeMethods.length === 0 || mergeMethods.some((method) => !['squash', 'merge', 'rebase'].includes(method))) {
      throw new GitAuthorityError('git_policy_invalid', 'merge_methods are invalid', 400);
    }
    if (!Number.isSafeInteger(rule.required_approvals) || rule.required_approvals < 0 || rule.required_approvals > 20) {
      throw new GitAuthorityError('git_policy_invalid', 'required_approvals is invalid', 400);
    }

    const protectedClass = protectedRefs.get(refName);
    if (protectedClass) {
      if (
        rule.branch_class !== protectedClass
        || rule.protected !== true
        || rule.service_managed !== true
        || rule.allow_direct_push !== false
        || rule.allow_force_push !== false
        || rule.allow_delete !== false
      ) {
        throw new GitAuthorityError('git_protected_ref_not_writable', `${refName} must remain protected and service-managed`, 400);
      }
    } else {
      if (
        rule.branch_class !== 'work'
        || !permittedWorkPrefixes.includes(refName as typeof permittedWorkPrefixes[number])
        || rule.protected !== false
        || rule.service_managed !== false
        || rule.allow_direct_push !== true
        || rule.allow_force_push !== false
        || rule.allow_delete !== false
      ) {
        throw new GitAuthorityError('git_policy_invalid', 'Only non-force-push work/ and feature/ rules are supported in v1', 400);
      }
    }
    return {
      ref_name: refName,
      branch_class: rule.branch_class,
      protected: Boolean(rule.protected),
      service_managed: Boolean(rule.service_managed),
      allow_direct_push: Boolean(rule.allow_direct_push),
      allow_force_push: Boolean(rule.allow_force_push),
      allow_delete: Boolean(rule.allow_delete),
      required_approvals: rule.required_approvals,
      required_checks: requiredChecks,
      merge_methods: mergeMethods as GitBranchPolicy['merge_methods'],
    };
  });
  for (const requiredRef of protectedRefs.keys()) {
    if (!seen.has(requiredRef)) throw new GitAuthorityError('git_policy_invalid', `${requiredRef} is required`, 400);
  }
  return rules;
}

function serializeRepository(row: GitRepositoryRow): GitRepository {
  return {
    repository_id: row.id,
    workspace_id: row.workspace_id,
    git_namespace: row.git_namespace,
    git_path: `${row.git_namespace}/${row.slug}`,
    scope_id: row.scope_id,
    slug: row.slug,
    display_name: row.display_name,
    description: row.description,
    visibility: row.visibility,
    default_branch: row.default_branch,
    state: row.state,
    policy_revision: Number(row.policy_revision),
    created_by_actor_id: row.created_by_actor_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function normalizeStoredPrefixes(value: { prefixes?: unknown } | null | undefined): string[] {
  return Array.isArray(value?.prefixes)
    ? value.prefixes.filter((item): item is string => typeof item === 'string')
    : [];
}

function serializeGrant(row: GitGrantRow): GitRepositoryGrant {
  return {
    grant_id: row.id,
    repository_id: row.repository_id,
    principal_type: row.principal_type,
    principal_actor_id: row.principal_actor_id,
    principal_group_id: row.principal_group_id,
    permission: row.permission,
    ref_constraints: { prefixes: normalizeStoredPrefixes(row.ref_constraints) },
    created_by_actor_id: row.created_by_actor_id,
    created_at: row.created_at.toISOString(),
    revoked_by_actor_id: row.revoked_by_actor_id,
    revoked_at: row.revoked_at?.toISOString() ?? null,
  };
}

function serializeBranchPolicy(row: GitBranchPolicyRow): GitBranchPolicy {
  return {
    policy_id: row.id,
    ref_name: row.ref_name,
    branch_class: row.branch_class,
    protected: row.protected,
    service_managed: row.service_managed,
    allow_direct_push: row.allow_direct_push,
    allow_force_push: row.allow_force_push,
    allow_delete: row.allow_delete,
    required_approvals: Number(row.required_approvals),
    required_checks: row.required_checks,
    merge_methods: row.merge_methods,
  };
}

async function resolveActorContext(workspaceId: string, actorNpub: string, sql: DbClient): Promise<GitActorContext | null> {
  const [row] = await sql<{
    actor_id: string;
    actor_npub: string;
    actor_display_name: string | null;
    actor_kind: string;
    workspace_id: string;
    workspace_owner_npub: string;
    app_npub: string;
    role: string;
  }[]>`
    SELECT actor.id AS actor_id, actor.npub AS actor_npub, actor.display_name AS actor_display_name,
           actor.kind AS actor_kind,
           workspace.id AS workspace_id, workspace.workspace_owner_npub, workspace.app_npub, membership.role
    FROM flightdeck_pg_workspaces workspace
    JOIN flightdeck_pg_actors actor ON actor.npub = ${actorNpub}
    JOIN flightdeck_pg_workspace_memberships membership
      ON membership.workspace_id = workspace.id AND membership.actor_id = actor.id
    WHERE workspace.id = ${workspaceId}
    LIMIT 1
  `;
  if (!row) return null;
  const groups = await sql<{ group_id: string }[]>`
    WITH RECURSIVE effective_groups(group_id) AS (
      SELECT group_id FROM flightdeck_pg_group_memberships
      WHERE workspace_id = ${workspaceId} AND actor_id = ${row.actor_id}
      UNION
      SELECT edge.parent_group_id
      FROM flightdeck_pg_group_edges edge
      JOIN effective_groups child ON child.group_id = edge.child_group_id
      WHERE edge.workspace_id = ${workspaceId}
    )
    SELECT group_id FROM effective_groups ORDER BY group_id
  `;
  return {
    actorId: row.actor_id,
    actorNpub: row.actor_npub,
    actorDisplayName: row.actor_display_name,
    actorKind: row.actor_kind,
    workspaceId: row.workspace_id,
    workspaceOwnerNpub: row.workspace_owner_npub,
    appNpub: row.app_npub,
    role: row.role,
    effectiveGroupIds: groups.map((group) => group.group_id),
  };
}

async function actorHasPermission(
  repositoryId: string,
  actor: GitActorContext,
  permission: GitRepositoryPermission,
  sql: DbClient,
): Promise<boolean> {
  const [grant] = await sql<{ id: string }[]>`
    SELECT id
    FROM git_repository_grants
    WHERE repository_id = ${repositoryId}
      AND permission = ${permission}
      AND revoked_at IS NULL
      AND (
        (principal_type = 'actor' AND principal_actor_id = ${actor.actorId})
        OR (principal_type = 'group' AND principal_group_id = ANY(${actor.effectiveGroupIds}::uuid[]))
      )
    LIMIT 1
  `;
  return Boolean(grant);
}

async function actorCanSeeRepository(repositoryId: string, actor: GitActorContext, sql: DbClient): Promise<boolean> {
  const [grant] = await sql<{ id: string }[]>`
    SELECT id
    FROM git_repository_grants
    WHERE repository_id = ${repositoryId}
      AND revoked_at IS NULL
      AND (
        (principal_type = 'actor' AND principal_actor_id = ${actor.actorId})
        OR (principal_type = 'group' AND principal_group_id = ANY(${actor.effectiveGroupIds}::uuid[]))
      )
    LIMIT 1
  `;
  return Boolean(grant);
}

async function requireVisibleRepository(
  workspaceId: string,
  repositoryId: string,
  actorNpub: string,
  sql: DbClient,
): Promise<{ repository: GitRepositoryRow; actor: GitActorContext }> {
  const actor = await resolveActorContext(workspaceId, actorNpub, sql);
  if (!actor) throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  const [repository] = await sql<GitRepositoryRow[]>`
    SELECT repository.id, repository.workspace_id, namespace.namespace AS git_namespace,
           repository.scope_id, repository.slug, repository.display_name, repository.description, repository.visibility,
           repository.default_branch, repository.state, repository.policy_revision,
           repository.created_by_actor_id, repository.created_at, repository.updated_at
    FROM git_repositories repository
    JOIN git_workspace_namespaces namespace ON namespace.workspace_id = repository.workspace_id
    WHERE repository.workspace_id = ${workspaceId} AND repository.id = ${repositoryId} AND repository.archived_at IS NULL
    LIMIT 1
  `;
  if (!repository || !await actorCanSeeRepository(repository.id, actor, sql)) {
    throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  }
  return { repository, actor };
}

async function requireRepositoryAdmin(
  workspaceId: string,
  repositoryId: string,
  actorNpub: string,
  sql: DbClient,
): Promise<{ repository: GitRepositoryRow; actor: GitActorContext }> {
  const resolved = await requireVisibleRepository(workspaceId, repositoryId, actorNpub, sql);
  if (!await actorHasPermission(repositoryId, resolved.actor, 'git.repo.admin', sql)) {
    throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  }
  return resolved;
}

export async function appendGitAuditEvent(input: {
  source?: 'tower' | 'wingman-git' | 'forgejo';
  workspaceId?: string | null;
  repositoryId?: string | null;
  actorId?: string | null;
  actorNpub?: string | null;
  signerNpub?: string | null;
  operation: string;
  requestedScope?: string | null;
  service?: GitService | null;
  decision: 'allow' | 'deny';
  reasonCode: string;
  policyRevision?: number | null;
  capabilityHashPrefix?: string | null;
  autopilotInstanceNpub?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  workroomId?: string | null;
  correlationId?: string | null;
}, sql: DbClient = getDb()): Promise<string> {
  const [event] = await sql<{ id: string }[]>`
    INSERT INTO git_audit_events (
      source, workspace_id, repository_id, actor_id, actor_npub, signer_npub,
      operation, requested_scope, git_service, decision, reason_code,
      policy_revision, capability_hash_prefix, autopilot_instance_npub,
      session_id, task_id, workroom_id, correlation_id
    ) VALUES (
      ${input.source ?? 'tower'}, ${input.workspaceId ?? null}, ${input.repositoryId ?? null},
      ${input.actorId ?? null}, ${input.actorNpub ?? null}, ${input.signerNpub ?? null},
      ${input.operation}, ${input.requestedScope ?? null}, ${input.service ?? null},
      ${input.decision}, ${input.reasonCode}, ${input.policyRevision ?? null},
      ${input.capabilityHashPrefix ?? null}, ${input.autopilotInstanceNpub ?? null},
      ${input.sessionId ?? null}, ${input.taskId ?? null}, ${input.workroomId ?? null},
      ${input.correlationId ?? null}
    )
    RETURNING id
  `;
  if (input.workspaceId) {
    await sql`
      INSERT INTO flightdeck_pg_outbox_events (
        workspace_id, actor_id, event_type, entity_type, entity_id, operation, payload
      ) VALUES (
        ${input.workspaceId}, ${input.actorId ?? null}, 'git.security.decision',
        'git_audit_event', ${event.id}, ${input.operation},
        ${sql.json({
          event_id: event.id,
          repository_id: input.repositoryId ?? null,
          decision: input.decision,
          reason_code: input.reasonCode,
          policy_revision: input.policyRevision ?? null,
          correlation_id: input.correlationId ?? null,
        })}
      )
    `;
  }
  return event.id;
}

async function insertBranchRules(repository: GitRepositoryRow, rules: Array<Omit<GitBranchPolicy, 'policy_id'>>, sql: DbClient) {
  for (const rule of rules) {
    await sql`
      INSERT INTO git_branch_policies (
        workspace_id, repository_id, ref_name, branch_class, protected,
        service_managed, allow_direct_push, allow_force_push, allow_delete,
        required_approvals, required_checks, merge_methods
      ) VALUES (
        ${repository.workspace_id}, ${repository.id}, ${rule.ref_name}, ${rule.branch_class},
        ${rule.protected}, ${rule.service_managed}, ${rule.allow_direct_push},
        ${rule.allow_force_push}, ${rule.allow_delete}, ${rule.required_approvals},
        ${rule.required_checks}, ${rule.merge_methods}
      )
    `;
  }
}

export async function createGitRepository(
  workspaceId: string,
  actorNpub: string,
  signerNpub: string,
  input: CreateGitRepositoryRequest,
  sql: DbClient = getDb(),
): Promise<GitRepository> {
  assertUuid(workspaceId, 'workspace_id');
  const actor = await resolveActorContext(workspaceId, actorNpub, sql);
  if (!actor) throw new GitAuthorityError('git_workspace_not_found', 'Workspace not found', 404);
  if (!['owner', 'admin'].includes(actor.role)) {
    throw new GitAuthorityError('git_repository_create_denied', 'Repository creation requires workspace owner or admin authority', 403);
  }
  const gitNamespace = await ensureGitWorkspaceNamespace(workspaceId, sql);
  const slug = normalizeString(input.slug, 'slug', 63).toLowerCase();
  if (!slugPattern.test(slug)) throw new GitAuthorityError('git_repository_slug_invalid', 'Repository slug is invalid', 400);
  const displayName = normalizeString(input.display_name, 'display_name', 160);
  const description = normalizeString(input.description, 'description', 2000, false);
  const scopeId = input.scope_id ? assertUuid(input.scope_id, 'scope_id') : null;
  if (scopeId) {
    const [scope] = await sql<{ id: string }[]>`
      SELECT id FROM flightdeck_pg_scopes
      WHERE workspace_id = ${workspaceId} AND id = ${scopeId} AND archived_at IS NULL
    `;
    if (!scope) throw new GitAuthorityError('git_scope_not_found', 'Scope not found', 404);
  }

  try {
    return await sql.begin(async (tx) => {
      const db = tx as unknown as DbClient;
      const [repository] = await db<GitRepositoryRow[]>`
        INSERT INTO git_repositories (
          workspace_id, scope_id, slug, display_name, description, created_by_actor_id
        ) VALUES (${workspaceId}, ${scopeId}, ${slug}, ${displayName}, ${description}, ${actor.actorId})
        RETURNING id, workspace_id, scope_id, slug, display_name, description, visibility,
                  default_branch, state, policy_revision, created_by_actor_id, created_at, updated_at
      `;
      repository.git_namespace = gitNamespace;
      await insertBranchRules(repository, defaultBranchRules, db);
      await db`
        INSERT INTO git_repository_grants (
          workspace_id, repository_id, principal_type, principal_actor_id,
          permission, ref_constraints, created_by_actor_id
        ) VALUES (
          ${workspaceId}, ${repository.id}, 'actor', ${actor.actorId},
          'git.repo.admin', ${db.json({ prefixes: [] })}, ${actor.actorId}
        )
      `;
      await appendGitAuditEvent({
        workspaceId,
        repositoryId: repository.id,
        actorId: actor.actorId,
        actorNpub,
        signerNpub,
        operation: 'git.repository.create',
        decision: 'allow',
        reasonCode: 'git_repository_created',
        policyRevision: 1,
        correlationId: randomUUID(),
      }, db);
      return serializeRepository(repository);
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new GitAuthorityError('git_repository_slug_conflict', 'A repository with this slug already exists', 409);
    }
    throw error;
  }
}

export async function listGitRepositories(workspaceId: string, actorNpub: string, sql: DbClient = getDb()): Promise<GitRepository[]> {
  assertUuid(workspaceId, 'workspace_id');
  const actor = await resolveActorContext(workspaceId, actorNpub, sql);
  if (!actor) return [];
  const rows = await sql<GitRepositoryRow[]>`
    SELECT DISTINCT repository.id, repository.workspace_id, namespace.namespace AS git_namespace,
           repository.scope_id, repository.slug,
           repository.display_name, repository.description, repository.visibility,
           repository.default_branch, repository.state, repository.policy_revision,
           repository.created_by_actor_id, repository.created_at, repository.updated_at
    FROM git_repositories repository
    JOIN git_workspace_namespaces namespace ON namespace.workspace_id = repository.workspace_id
    JOIN git_repository_grants repository_grant
      ON repository_grant.repository_id = repository.id
      AND repository_grant.revoked_at IS NULL
    WHERE repository.workspace_id = ${workspaceId}
      AND repository.archived_at IS NULL
      AND (
        (repository_grant.principal_type = 'actor' AND repository_grant.principal_actor_id = ${actor.actorId})
        OR (
          repository_grant.principal_type = 'group'
          AND repository_grant.principal_group_id = ANY(${actor.effectiveGroupIds}::uuid[])
        )
      )
    ORDER BY repository.created_at DESC
  `;
  return rows.map(serializeRepository);
}

export async function resolveGitRepositoryPath(
  workspaceId: string,
  path: string,
  actorNpub: string,
  sql: DbClient = getDb(),
): Promise<{ canonical_path: string; repository: GitRepository }> {
  assertUuid(workspaceId, 'workspace_id');
  const match = /^\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9._-]{0,62})\.git$/.exec(String(path || ''));
  if (!match) throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  const actor = await resolveActorContext(workspaceId, actorNpub, sql);
  if (!actor) throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  const [repository] = await sql<GitRepositoryRow[]>`
    SELECT repository.id, repository.workspace_id, namespace.namespace AS git_namespace,
           repository.scope_id, repository.slug, repository.display_name, repository.description,
           repository.visibility, repository.default_branch, repository.state,
           repository.policy_revision, repository.created_by_actor_id,
           repository.created_at, repository.updated_at
    FROM git_repositories repository
    JOIN git_workspace_namespaces namespace ON namespace.workspace_id = repository.workspace_id
    WHERE repository.workspace_id = ${workspaceId}
      AND namespace.namespace = ${match[1]}
      AND repository.slug = ${match[2]}
      AND repository.archived_at IS NULL
    LIMIT 1
  `;
  if (!repository || !await actorCanSeeRepository(repository.id, actor, sql)) {
    throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  }
  return {
    canonical_path: `/${repository.git_namespace}/${repository.slug}.git`,
    repository: serializeRepository(repository),
  };
}

export async function readGitRepository(workspaceId: string, repositoryId: string, actorNpub: string, sql: DbClient = getDb()): Promise<GitRepository> {
  assertUuid(repositoryId, 'repository_id');
  const { repository } = await requireVisibleRepository(workspaceId, repositoryId, actorNpub, sql);
  return serializeRepository(repository);
}

export async function authorizeGitIssueOperation(
  workspaceId: string,
  repositoryId: string,
  actorNpub: string,
  access: 'read' | 'write',
  sql: DbClient = getDb(),
): Promise<{
  repository: GitRepository;
  actorId: string;
  actorNpub: string;
  actorDisplayName: string | null;
}> {
  assertUuid(workspaceId, 'workspace_id');
  assertUuid(repositoryId, 'repository_id');
  const resolved = await requireVisibleRepository(workspaceId, repositoryId, actorNpub, sql);
  if (access === 'write') {
    const grants = await applicableGrantRows(repositoryId, resolved.actor, sql);
    if (!grants.some((grant) => ['git.repo.write', 'git.repo.admin'].includes(grant.permission))) {
      throw new GitAuthorityError('git_issue_write_denied', 'Repository issue write access is not granted', 403);
    }
  }
  return {
    repository: serializeRepository(resolved.repository),
    actorId: resolved.actor.actorId,
    actorNpub: resolved.actor.actorNpub,
    actorDisplayName: resolved.actor.actorDisplayName,
  };
}

export async function listGitRepositoryGrants(workspaceId: string, repositoryId: string, actorNpub: string, sql: DbClient = getDb()): Promise<GitRepositoryGrant[]> {
  const { repository } = await requireRepositoryAdmin(workspaceId, repositoryId, actorNpub, sql);
  const rows = await sql<GitGrantRow[]>`
    SELECT id, repository_id, principal_type, principal_actor_id, principal_group_id,
           permission, ref_constraints, created_by_actor_id, created_at, revoked_by_actor_id, revoked_at
    FROM git_repository_grants
    WHERE repository_id = ${repository.id}
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map(serializeGrant);
}

export async function createGitRepositoryGrant(
  workspaceId: string,
  repositoryId: string,
  actorNpub: string,
  signerNpub: string,
  input: CreateGitRepositoryGrantRequest,
  sql: DbClient = getDb(),
): Promise<{ grant: GitRepositoryGrant; policyRevision: number }> {
  const { repository, actor } = await requireRepositoryAdmin(workspaceId, repositoryId, actorNpub, sql);
  const principalId = assertUuid(input.principal_id, 'principal_id');
  if (!['actor', 'group'].includes(input.principal_type)) {
    throw new GitAuthorityError('git_principal_invalid', 'principal_type must be actor or group', 400);
  }
  if (!repositoryPermissionSet.has(input.permission)) {
    throw new GitAuthorityError('git_permission_invalid', 'Git repository permission is invalid', 400);
  }
  const prefixes = normalizeRefPrefixes(input.ref_constraints?.prefixes, input.permission);
  if (input.principal_type === 'actor') {
    const [membership] = await sql<{ actor_id: string }[]>`
      SELECT actor_id FROM flightdeck_pg_workspace_memberships
      WHERE workspace_id = ${workspaceId} AND actor_id = ${principalId}
    `;
    if (!membership) throw new GitAuthorityError('git_principal_not_found', 'Principal not found', 404);
  } else {
    const [group] = await sql<{ id: string }[]>`
      SELECT id FROM flightdeck_pg_groups WHERE workspace_id = ${workspaceId} AND id = ${principalId}
    `;
    if (!group) throw new GitAuthorityError('git_principal_not_found', 'Principal not found', 404);
  }

  try {
    return await sql.begin(async (tx) => {
      const db = tx as unknown as DbClient;
      const [grant] = await db<GitGrantRow[]>`
        INSERT INTO git_repository_grants (
          workspace_id, repository_id, principal_type, principal_actor_id,
          principal_group_id, permission, ref_constraints, created_by_actor_id
        ) VALUES (
          ${workspaceId}, ${repository.id}, ${input.principal_type},
          ${input.principal_type === 'actor' ? principalId : null},
          ${input.principal_type === 'group' ? principalId : null},
          ${input.permission}, ${db.json({ prefixes })}, ${actor.actorId}
        )
        RETURNING id, repository_id, principal_type, principal_actor_id, principal_group_id,
                  permission, ref_constraints, created_by_actor_id, created_at, revoked_by_actor_id, revoked_at
      `;
      const [updated] = await db<{ policy_revision: number }[]>`
        UPDATE git_repositories
        SET policy_revision = policy_revision + 1, updated_at = NOW()
        WHERE id = ${repository.id}
        RETURNING policy_revision
      `;
      await appendGitAuditEvent({
        workspaceId,
        repositoryId: repository.id,
        actorId: actor.actorId,
        actorNpub,
        signerNpub,
        operation: 'git.grant.create',
        requestedScope: input.permission,
        decision: 'allow',
        reasonCode: 'git_grant_created',
        policyRevision: Number(updated.policy_revision),
        correlationId: randomUUID(),
      }, db);
      return { grant: serializeGrant(grant), policyRevision: Number(updated.policy_revision) };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new GitAuthorityError('git_grant_conflict', 'An active matching grant already exists', 409);
    }
    throw error;
  }
}

export async function revokeGitRepositoryGrant(
  workspaceId: string,
  repositoryId: string,
  grantId: string,
  actorNpub: string,
  signerNpub: string,
  sql: DbClient = getDb(),
): Promise<{ grant: GitRepositoryGrant; policyRevision: number }> {
  const { repository, actor } = await requireRepositoryAdmin(workspaceId, repositoryId, actorNpub, sql);
  assertUuid(grantId, 'grant_id');
  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    const [existing] = await db<GitGrantRow[]>`
      SELECT id, repository_id, principal_type, principal_actor_id, principal_group_id,
             permission, ref_constraints, created_by_actor_id, created_at, revoked_by_actor_id, revoked_at
      FROM git_repository_grants
      WHERE repository_id = ${repository.id} AND id = ${grantId} AND revoked_at IS NULL
      FOR UPDATE
    `;
    if (!existing) throw new GitAuthorityError('git_grant_not_found', 'Grant not found', 404);
    if (existing.permission === 'git.repo.admin') {
      const [{ count }] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM git_repository_grants
        WHERE repository_id = ${repository.id} AND permission = 'git.repo.admin' AND revoked_at IS NULL
      `;
      if (Number(count) <= 1) {
        throw new GitAuthorityError('git_last_admin_grant', 'The final repository administrator grant cannot be revoked', 409);
      }
    }
    const [grant] = await db<GitGrantRow[]>`
      UPDATE git_repository_grants
      SET revoked_at = NOW(), revoked_by_actor_id = ${actor.actorId}
      WHERE id = ${grantId}
      RETURNING id, repository_id, principal_type, principal_actor_id, principal_group_id,
                permission, ref_constraints, created_by_actor_id, created_at, revoked_by_actor_id, revoked_at
    `;
    const [updated] = await db<{ policy_revision: number }[]>`
      UPDATE git_repositories SET policy_revision = policy_revision + 1, updated_at = NOW()
      WHERE id = ${repository.id}
      RETURNING policy_revision
    `;
    await appendGitAuditEvent({
      workspaceId,
      repositoryId: repository.id,
      actorId: actor.actorId,
      actorNpub,
      signerNpub,
      operation: 'git.grant.revoke',
      requestedScope: existing.permission,
      decision: 'allow',
      reasonCode: 'git_grant_revoked',
      policyRevision: Number(updated.policy_revision),
      correlationId: randomUUID(),
    }, db);
    return { grant: serializeGrant(grant), policyRevision: Number(updated.policy_revision) };
  });
}

export async function readGitRepositoryPolicy(workspaceId: string, repositoryId: string, actorNpub: string, sql: DbClient = getDb()): Promise<GitRepositoryPolicy> {
  const { repository } = await requireVisibleRepository(workspaceId, repositoryId, actorNpub, sql);
  const rows = await sql<GitBranchPolicyRow[]>`
    SELECT id, ref_name, branch_class, protected, service_managed, allow_direct_push,
           allow_force_push, allow_delete, required_approvals, required_checks, merge_methods
    FROM git_branch_policies WHERE repository_id = ${repository.id}
    ORDER BY CASE branch_class WHEN 'main' THEN 1 WHEN 'staging' THEN 2 WHEN 'deployed' THEN 3 ELSE 4 END, ref_name
  `;
  return {
    repository_id: repository.id,
    policy_revision: Number(repository.policy_revision),
    branch_rules: rows.map(serializeBranchPolicy),
  };
}

export async function updateGitRepositoryPolicy(
  workspaceId: string,
  repositoryId: string,
  actorNpub: string,
  signerNpub: string,
  input: UpdateGitRepositoryPolicyRequest,
  sql: DbClient = getDb(),
): Promise<GitRepositoryPolicy> {
  const { repository, actor } = await requireRepositoryAdmin(workspaceId, repositoryId, actorNpub, sql);
  if (!Number.isSafeInteger(input.expected_policy_revision) || input.expected_policy_revision < 1) {
    throw new GitAuthorityError('git_policy_invalid', 'expected_policy_revision is invalid', 400);
  }
  const rules = normalizeBranchRules(input.branch_rules);
  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    const [updated] = await db<GitRepositoryRow[]>`
      UPDATE git_repositories
      SET policy_revision = policy_revision + 1, updated_at = NOW()
      WHERE id = ${repository.id} AND policy_revision = ${input.expected_policy_revision}
      RETURNING id, workspace_id, scope_id, slug, display_name, description, visibility,
                default_branch, state, policy_revision, created_by_actor_id, created_at, updated_at
    `;
    if (!updated) throw new GitAuthorityError('git_policy_revision_conflict', 'Repository policy revision changed', 409);
    await db`DELETE FROM git_branch_policies WHERE repository_id = ${repository.id}`;
    await insertBranchRules(updated, rules, db);
    const rows = await db<GitBranchPolicyRow[]>`
      SELECT id, ref_name, branch_class, protected, service_managed, allow_direct_push,
             allow_force_push, allow_delete, required_approvals, required_checks, merge_methods
      FROM git_branch_policies WHERE repository_id = ${repository.id}
      ORDER BY CASE branch_class WHEN 'main' THEN 1 WHEN 'staging' THEN 2 WHEN 'deployed' THEN 3 ELSE 4 END, ref_name
    `;
    await appendGitAuditEvent({
      workspaceId,
      repositoryId: repository.id,
      actorId: actor.actorId,
      actorNpub,
      signerNpub,
      operation: 'git.policy.update',
      decision: 'allow',
      reasonCode: 'git_policy_updated',
      policyRevision: Number(updated.policy_revision),
      correlationId: randomUUID(),
    }, db);
    return { repository_id: repository.id, policy_revision: Number(updated.policy_revision), branch_rules: rows.map(serializeBranchPolicy) };
  });
}

export async function consumeGitCredentialExchangeEvent(
  verification: Extract<StrictNip98Verification, { ok: true }>,
  sql: DbClient = getDb(),
): Promise<boolean> {
  const rows = await sql<{ event_id: string }[]>`
    INSERT INTO git_credential_exchange_events (
      event_id, body_sha256, signer_npub, event_created_at
    ) VALUES (
      ${verification.eventId}, ${verification.payloadHash}, ${verification.signerNpub},
      to_timestamp(${verification.eventCreatedAt})
    )
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `;
  return rows.length === 1;
}

export async function finishGitCredentialExchangeEvent(input: {
  eventId: string;
  actorId?: string | null;
  workspaceId?: string | null;
  repositoryId?: string | null;
  decision: 'allow' | 'deny';
  reasonCode: string;
}, sql: DbClient = getDb()) {
  await sql`
    UPDATE git_credential_exchange_events
    SET actor_id = ${input.actorId ?? null}, workspace_id = ${input.workspaceId ?? null},
        repository_id = ${input.repositoryId ?? null}, decision = ${input.decision},
        reason_code = ${input.reasonCode}
    WHERE event_id = ${input.eventId}
  `;
}

export async function consumeGitNip98MutationEvent(
  operation: string,
  verification: Extract<StrictNip98Verification, { ok: true }>,
  sql: DbClient = getDb(),
): Promise<{ state: 'consumed' | 'cached' | 'replayed'; result?: unknown }> {
  const rows = await sql<{ event_id: string }[]>`
    INSERT INTO git_nip98_mutation_events (
      event_id, operation, body_sha256, signer_npub, event_created_at
    ) VALUES (
      ${verification.eventId}, ${operation}, ${verification.payloadHash}, ${verification.signerNpub},
      to_timestamp(${verification.eventCreatedAt})
    )
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `;
  if (rows.length === 1) return { state: 'consumed' };
  const [existing] = await sql<any[]>`
    SELECT operation, body_sha256, signer_npub, decision, result
    FROM git_nip98_mutation_events WHERE event_id = ${verification.eventId}
  `;
  if (
    existing?.operation === operation
    && existing?.body_sha256 === verification.payloadHash
    && existing?.signer_npub === verification.signerNpub
    && existing?.decision === 'allow'
    && existing?.result
  ) {
    return { state: 'cached', result: existing.result };
  }
  return { state: 'replayed' };
}

export async function finishGitNip98MutationEvent(input: {
  eventId: string;
  actorId?: string | null;
  workspaceId?: string | null;
  repositoryId?: string | null;
  decision: 'allow' | 'deny';
  reasonCode: string;
  result?: unknown;
}, sql: DbClient = getDb()) {
  await sql`
    UPDATE git_nip98_mutation_events
    SET actor_id = ${input.actorId ?? null}, workspace_id = ${input.workspaceId ?? null},
        repository_id = ${input.repositoryId ?? null}, decision = ${input.decision},
        reason_code = ${input.reasonCode},
        result = ${input.result === undefined ? null : sql.json(input.result as any)}
    WHERE event_id = ${input.eventId}
  `;
}

function assertGitRuntimeConfigured() {
  if (!config.git.capabilityHashKey || config.git.capabilityHashKey.length < 32 || !config.git.audience) {
    throw new GitAuthorityError('git_capability_service_unconfigured', 'Git capability issuance is not configured', 503);
  }
}

function hashCapability(capability: string): string {
  assertGitRuntimeConfigured();
  return createHmac('sha256', config.git.capabilityHashKey).update(capability, 'utf8').digest('hex');
}

function permissionForScope(scope: GitCapabilityScope): GitRepositoryPermission {
  if (scope === 'git.fetch') return 'git.repo.read';
  if (scope === 'git.push.branch_create') return 'git.branch.create';
  return 'git.repo.write';
}

function transportAuthorityForGrants(grants: GitGrantRow[]): {
  scopes: GitCapabilityScope[];
  prefixes: string[];
} {
  const scopes = new Set<GitCapabilityScope>();
  const prefixes = new Set<string>();
  for (const grant of grants) {
    if (grant.permission === 'git.repo.read') scopes.add('git.fetch');
    if (grant.permission === 'git.repo.write') {
      scopes.add('git.fetch');
      scopes.add('git.push.unprotected');
      normalizeStoredPrefixes(grant.ref_constraints).forEach((prefix) => prefixes.add(prefix));
    }
    if (grant.permission === 'git.branch.create') {
      scopes.add('git.fetch');
      scopes.add('git.push.branch_create');
      normalizeStoredPrefixes(grant.ref_constraints).forEach((prefix) => prefixes.add(prefix));
    }
    if (grant.permission === 'git.repo.admin') {
      scopes.add('git.fetch');
      scopes.add('git.push.unprotected');
      scopes.add('git.push.branch_create');
      permittedWorkPrefixes.forEach((prefix) => prefixes.add(prefix));
    }
  }
  return {
    scopes: [...scopes].sort(),
    prefixes: [...prefixes].sort(),
  };
}

async function signerIsActiveForActor(
  signerNpub: string,
  actor: GitActorContext,
  sql: DbClient,
): Promise<boolean> {
  if (signerNpub === actor.actorNpub) return true;
  const [binding] = await sql<{ active: boolean }[]>`
    SELECT active
    FROM user_workspace_keys
    WHERE workspace_owner_npub = ${actor.workspaceOwnerNpub}
      AND user_npub = ${actor.actorNpub}
      AND ws_key_npub = ${signerNpub}
      AND active = true
      AND revoked_at IS NULL
    LIMIT 1
  `;
  return binding?.active === true;
}

function validateServiceScopes(service: GitService, scopes: GitCapabilityScope[]) {
  if (
    scopes.length === 0
    || scopes.some((scope) => !capabilityScopeSet.has(scope))
    || (service === 'upload-pack' && (scopes.length !== 1 || scopes[0] !== 'git.fetch'))
    || (service === 'receive-pack' && scopes.some((scope) => scope === 'git.fetch'))
  ) {
    throw new GitAuthorityError('git_service_scope_mismatch', 'Requested scopes do not match the Git service', 400);
  }
}

async function validateCorrelationContext(
  workspaceId: string,
  actor: GitActorContext,
  taskId: string | null,
  workroomId: string | null,
  sql: DbClient,
) {
  const contexts: Array<{ kind: 'task' | 'workroom'; id: string; table: 'flightdeck_pg_tasks' | 'flightdeck_pg_workrooms' }> = [];
  if (taskId) contexts.push({ kind: 'task', id: taskId, table: 'flightdeck_pg_tasks' });
  if (workroomId) contexts.push({ kind: 'workroom', id: workroomId, table: 'flightdeck_pg_workrooms' });
  for (const context of contexts) {
    const rows = await sql.unsafe<{ channel_id: string }[]>(
      `SELECT channel_id FROM ${context.table} WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1`,
      [workspaceId, context.id],
    );
    const resource = rows[0];
    if (!resource) {
      throw new GitAuthorityError('git_context_not_found', `${context.kind}_id is not visible in this workspace`, 404);
    }
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: actor.actorNpub,
      appNpub: actor.appNpub,
      workspaceId,
      permission: 'channel.read',
      resource: { type: 'channel', channelId: resource.channel_id },
    }, sql);
    if (!decision.allowed) {
      throw new GitAuthorityError('git_context_not_authorized', `${context.kind}_id is not authorized for this actor`, 403);
    }
  }
}

async function applicableGrantRows(repositoryId: string, actor: GitActorContext, sql: DbClient): Promise<GitGrantRow[]> {
  return sql<GitGrantRow[]>`
    SELECT id, repository_id, principal_type, principal_actor_id, principal_group_id,
           permission, ref_constraints, created_by_actor_id, created_at, revoked_by_actor_id, revoked_at
    FROM git_repository_grants
    WHERE repository_id = ${repositoryId} AND revoked_at IS NULL
      AND (
        (principal_type = 'actor' AND principal_actor_id = ${actor.actorId})
        OR (principal_type = 'group' AND principal_group_id = ANY(${actor.effectiveGroupIds}::uuid[]))
      )
  `;
}

export async function exchangeGitCredential(
  input: GitCredentialExchangeRequest,
  verification: Extract<StrictNip98Verification, { ok: true }>,
  sql: DbClient = getDb(),
): Promise<GitCredentialExchangeResponse> {
  assertGitRuntimeConfigured();
  const repositoryId = assertUuid(input.repository_id, 'repository_id');
  if (input.audience !== config.git.audience) {
    throw new GitAuthorityError('git_audience_invalid', 'Requested audience is not configured', 403);
  }
  const legacyFieldCount = [input.actor_id, input.service, input.requested_scopes]
    .filter((value) => value !== undefined).length;
  if (legacyFieldCount !== 0 && legacyFieldCount !== 3) {
    throw new GitAuthorityError('git_legacy_request_invalid', 'Legacy actor_id, service, and requested_scopes must be supplied together', 400);
  }
  const correlationId = input.correlation_id
    ? normalizeString(input.correlation_id, 'correlation_id', 128)
    : randomUUID();
  const [repository] = await sql<GitRepositoryRow[]>`
    SELECT id, workspace_id, scope_id, slug, display_name, description, visibility,
           default_branch, state, policy_revision, created_by_actor_id, created_at, updated_at
    FROM git_repositories WHERE id = ${repositoryId} AND archived_at IS NULL
  `;
  if (!repository) throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  const actor = await resolveActorContext(repository.workspace_id, verification.userNpub, sql);
  if (!actor || !await actorCanSeeRepository(repository.id, actor, sql)) {
    throw new GitAuthorityError('git_repository_not_found', 'Repository not found', 404);
  }
  const grants = await applicableGrantRows(repository.id, actor, sql);
  const currentAuthority = transportAuthorityForGrants(grants);
  if (currentAuthority.scopes.length === 0) {
    throw new GitAuthorityError('git_transport_not_granted', 'No Git transport scope is currently granted', 403);
  }
  let service: GitService | null = null;
  let scopes = currentAuthority.scopes;
  let prefixes = currentAuthority.prefixes;
  if (legacyFieldCount === 3) {
    const requestedActorId = assertUuid(input.actor_id!, 'actor_id');
    if (actor.actorId !== requestedActorId) {
      throw new GitAuthorityError('git_actor_mismatch', 'The requested actor does not match the resolved NIP-98 actor', 403);
    }
    if (!['upload-pack', 'receive-pack'].includes(input.service!)) {
      throw new GitAuthorityError('git_service_invalid', 'Git service is invalid', 400);
    }
    const requestedScopes = [...new Set(input.requested_scopes ?? [])].sort() as GitCapabilityScope[];
    validateServiceScopes(input.service!, requestedScopes);
    for (const scope of requestedScopes) {
      if (!currentAuthority.scopes.includes(scope)) {
        throw new GitAuthorityError('git_scope_not_granted', `Requested scope ${scope} is not granted`, 403);
      }
    }
    service = input.service!;
    scopes = requestedScopes;
    const requestedPermissions = new Set(requestedScopes.map(permissionForScope));
    prefixes = [...new Set(grants.flatMap((grant) => {
      if (grant.permission === 'git.repo.admin' && requestedScopes.some((scope) => scope !== 'git.fetch')) {
        return [...permittedWorkPrefixes];
      }
      return requestedPermissions.has(grant.permission)
        ? normalizeStoredPrefixes(grant.ref_constraints)
        : [];
    }))].sort();
  }
  const autopilotInstanceNpub = input.autopilot_instance_npub
    ? normalizeString(input.autopilot_instance_npub, 'autopilot_instance_npub', 128)
    : null;
  const sessionId = input.session_id ? normalizeString(input.session_id, 'session_id', 128) : null;
  const taskId = input.task_id ? assertUuid(input.task_id, 'task_id') : null;
  const workroomId = input.workroom_id ? assertUuid(input.workroom_id, 'workroom_id') : null;
  await validateCorrelationContext(repository.workspace_id, actor, taskId, workroomId, sql);
  const expiresAt = new Date(Date.now() + config.git.capabilityTtlSeconds * 1000);
  const opaqueCapability = randomBytes(32).toString('base64url');
  const capabilityHash = hashCapability(opaqueCapability);
  const capabilityHashPrefix = capabilityHash.slice(0, 12);

  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    const [capability] = await db<{ id: string }[]>`
      INSERT INTO git_capabilities (
        capability_hash, capability_hash_prefix, workspace_id, repository_id,
        actor_id, signer_npub, scopes, audience, git_service, policy_revision,
        ref_constraints, autopilot_instance_npub, session_id, task_id, workroom_id,
        correlation_id, expires_at
      ) VALUES (
        ${capabilityHash}, ${capabilityHashPrefix}, ${repository.workspace_id}, ${repository.id},
        ${actor.actorId}, ${verification.signerNpub}, ${scopes}, ${input.audience},
        ${service}, ${repository.policy_revision}, ${db.json({ prefixes })},
        ${autopilotInstanceNpub}, ${sessionId}, ${taskId}, ${workroomId},
        ${correlationId}, ${expiresAt}
      )
      RETURNING id
    `;
    await appendGitAuditEvent({
      workspaceId: repository.workspace_id,
      repositoryId: repository.id,
      actorId: actor.actorId,
      actorNpub: actor.actorNpub,
      signerNpub: verification.signerNpub,
      operation: 'git.credential.issue',
      requestedScope: scopes.join(','),
      service,
      decision: 'allow',
      reasonCode: 'git_capability_issued',
      policyRevision: Number(repository.policy_revision),
      capabilityHashPrefix,
      autopilotInstanceNpub,
      sessionId,
      taskId,
      workroomId,
      correlationId,
    }, db);
    await finishGitCredentialExchangeEvent({
      eventId: verification.eventId,
      actorId: actor.actorId,
      workspaceId: repository.workspace_id,
      repositoryId: repository.id,
      decision: 'allow',
      reasonCode: 'git_capability_issued',
    }, db);
    return {
      capability_id: capability.id,
      username: 'nostr',
      capability: opaqueCapability,
      repository_id: repository.id,
      actor_id: actor.actorId,
      signer_npub: verification.signerNpub,
      audience: input.audience,
      service,
      scopes,
      policy_revision: Number(repository.policy_revision),
      expires_at: expiresAt.toISOString(),
    };
  });
}

async function loadCapabilityByOpaqueSecret(opaqueCapability: string, sql: DbClient): Promise<GitCapabilityRow | null> {
  const capabilityHash = hashCapability(opaqueCapability);
  const [row] = await sql<GitCapabilityRow[]>`
    SELECT capability.id, capability.capability_hash_prefix, capability.workspace_id,
           capability.repository_id, capability.actor_id, actor.npub AS actor_npub,
           actor.display_name AS actor_display_name,
           capability.signer_npub, capability.scopes, capability.audience,
           capability.git_service, capability.policy_revision,
           repository.policy_revision AS current_policy_revision,
           capability.ref_constraints, capability.autopilot_instance_npub,
           capability.session_id, capability.task_id, capability.workroom_id,
           capability.correlation_id, capability.issued_at, capability.expires_at,
           capability.last_seen_at, capability.revoked_at
    FROM git_capabilities capability
    JOIN git_repositories repository ON repository.id = capability.repository_id
    JOIN flightdeck_pg_actors actor ON actor.id = capability.actor_id
    WHERE capability.capability_hash = ${capabilityHash}
    LIMIT 1
  `;
  return row ?? null;
}

function inactiveIntrospection(reasonCode: string): GitCapabilityIntrospectionResponse {
  return { active: false, reason_code: reasonCode };
}

function serviceAcceptsRequiredScope(service: GitService, scope: GitCapabilityScope): boolean {
  return service === 'upload-pack' ? scope === 'git.fetch' : scope !== 'git.fetch';
}

export async function introspectGitCapability(
  input: GitCapabilityIntrospectionRequest,
  sql: DbClient = getDb(),
): Promise<GitCapabilityIntrospectionResponse> {
  assertGitRuntimeConfigured();
  const correlationId = input.correlation_id
    ? normalizeString(input.correlation_id, 'correlation_id', 128)
    : randomUUID();
  const requestedRepositoryId = assertUuid(input.repository_id, 'repository_id');
  if (!capabilityScopeSet.has(input.required_scope)) {
    throw new GitAuthorityError('git_scope_invalid', 'required_scope is invalid', 400);
  }
  if (!['upload-pack', 'receive-pack'].includes(input.service)) {
    throw new GitAuthorityError('git_service_invalid', 'Git service is invalid', 400);
  }
  const capability = await loadCapabilityByOpaqueSecret(String(input.capability || ''), sql);
  const deny = async (reasonCode: string) => {
    await appendGitAuditEvent({
      source: 'wingman-git',
      workspaceId: capability?.workspace_id ?? null,
      repositoryId: capability?.repository_id ?? null,
      actorId: capability?.actor_id ?? null,
      actorNpub: capability?.actor_npub ?? null,
      signerNpub: capability?.signer_npub ?? null,
      operation: 'git.capability.introspect',
      requestedScope: input.required_scope,
      service: input.service,
      decision: 'deny',
      reasonCode,
      policyRevision: capability?.current_policy_revision ?? null,
      capabilityHashPrefix: capability?.capability_hash_prefix ?? null,
      correlationId,
    }, sql);
    return inactiveIntrospection(reasonCode);
  };
  if (!capability) return deny('git_capability_unknown');
  if (capability.revoked_at) return deny('git_capability_revoked');
  if (capability.expires_at.getTime() <= Date.now()) return deny('git_capability_expired');
  if (capability.repository_id !== requestedRepositoryId) return deny('git_capability_wrong_repository');
  if (capability.audience !== input.audience || input.audience !== config.git.audience) return deny('git_capability_wrong_audience');
  if (capability.git_service !== null && capability.git_service !== input.service) return deny('git_capability_wrong_service');
  if (Number(capability.policy_revision) !== Number(capability.current_policy_revision)) return deny('git_capability_stale_policy');
  if (!capability.scopes.includes(input.required_scope)) return deny('git_capability_missing_scope');
  if (!serviceAcceptsRequiredScope(input.service, input.required_scope)) return deny('git_capability_service_scope_mismatch');
  const actor = await resolveActorContext(capability.workspace_id, capability.actor_npub, sql);
  if (!actor || actor.actorId !== capability.actor_id) return deny('git_capability_actor_inactive');
  if (!await signerIsActiveForActor(capability.signer_npub, actor, sql)) {
    return deny('git_capability_signer_inactive');
  }
  const currentAuthority = transportAuthorityForGrants(
    await applicableGrantRows(capability.repository_id, actor, sql),
  );
  if (!currentAuthority.scopes.includes(input.required_scope)) {
    return deny('git_capability_access_revoked');
  }
  const issuedPrefixes = normalizeStoredPrefixes(capability.ref_constraints);
  if (issuedPrefixes.some((prefix) => !currentAuthority.prefixes.includes(prefix))) {
    return deny('git_capability_ref_constraints_stale');
  }

  await sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    await db`UPDATE git_capabilities SET last_seen_at = NOW() WHERE id = ${capability.id}`;
    await appendGitAuditEvent({
      source: 'wingman-git',
      workspaceId: capability.workspace_id,
      repositoryId: capability.repository_id,
      actorId: capability.actor_id,
      actorNpub: capability.actor_npub,
      signerNpub: capability.signer_npub,
      operation: 'git.capability.introspect',
      requestedScope: input.required_scope,
      service: input.service,
      decision: 'allow',
      reasonCode: 'git_capability_active',
      policyRevision: Number(capability.current_policy_revision),
      capabilityHashPrefix: capability.capability_hash_prefix,
      correlationId,
    }, db);
  });
  const [actorAlias] = await sql<{ applied_username: string | null }[]>`
    SELECT applied_username FROM git_forgejo_actor_aliases WHERE actor_id = ${capability.actor_id}
  `;
  return {
    active: true,
    reason_code: 'git_capability_active',
    capability_id: capability.id,
    repository_id: capability.repository_id,
    actor_id: capability.actor_id,
    actor_username: actorAlias?.applied_username || forgejoShadowUsername(capability.actor_id),
    ...(capability.actor_display_name ? { actor_display_name: capability.actor_display_name } : {}),
    signer_npub: capability.signer_npub,
    audience: capability.audience,
    service: input.service,
    scopes: capability.scopes,
    ref_constraints: { prefixes: normalizeStoredPrefixes(capability.ref_constraints) },
    policy_revision: Number(capability.policy_revision),
    expires_at: capability.expires_at.toISOString(),
  };
}

export async function revokeGitCapability(
  input: RevokeGitCapabilityRequest,
  sql: DbClient = getDb(),
): Promise<{ revoked: true; capability_id: string; reason_code: string }> {
  assertGitRuntimeConfigured();
  const capabilityId = assertUuid(input.capability_id, 'capability_id');
  const repositoryId = assertUuid(input.repository_id, 'repository_id');
  const reason = normalizeString(input.reason, 'reason', 240);
  const correlationId = input.correlation_id
    ? normalizeString(input.correlation_id, 'correlation_id', 128)
    : randomUUID();
  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    const [capability] = await db<GitCapabilityRow[]>`
      SELECT capability.id, capability.capability_hash_prefix, capability.workspace_id,
             capability.repository_id, capability.actor_id, actor.npub AS actor_npub,
             capability.signer_npub, capability.scopes, capability.audience,
             capability.git_service, capability.policy_revision,
             repository.policy_revision AS current_policy_revision,
             capability.ref_constraints, capability.autopilot_instance_npub,
             capability.session_id, capability.task_id, capability.workroom_id,
             capability.correlation_id, capability.issued_at, capability.expires_at,
             capability.last_seen_at, capability.revoked_at
      FROM git_capabilities capability
      JOIN git_repositories repository ON repository.id = capability.repository_id
      JOIN flightdeck_pg_actors actor ON actor.id = capability.actor_id
      WHERE capability.id = ${capabilityId}
      FOR UPDATE
    `;
    if (!capability || capability.repository_id !== repositoryId || capability.audience !== input.audience) {
      throw new GitAuthorityError('git_capability_not_found', 'Capability not found', 404);
    }
    if (!capability.revoked_at) {
      await db`
        UPDATE git_capabilities
        SET revoked_at = NOW(), revoked_by_service = 'wingman-git', revocation_reason = ${reason}
        WHERE id = ${capability.id}
      `;
    }
    await appendGitAuditEvent({
      source: 'wingman-git',
      workspaceId: capability.workspace_id,
      repositoryId: capability.repository_id,
      actorId: capability.actor_id,
      actorNpub: capability.actor_npub,
      signerNpub: capability.signer_npub,
      operation: 'git.capability.revoke',
      service: capability.git_service,
      decision: 'allow',
      reasonCode: capability.revoked_at ? 'git_capability_already_revoked' : 'git_capability_revoked',
      policyRevision: Number(capability.current_policy_revision),
      capabilityHashPrefix: capability.capability_hash_prefix,
      correlationId,
    }, db);
    return {
      revoked: true,
      capability_id: capability.id,
      reason_code: capability.revoked_at ? 'git_capability_already_revoked' : 'git_capability_revoked',
    };
  });
}

export async function listGitAuditEvents(
  workspaceId: string,
  repositoryId: string,
  actorNpub: string,
  limit = 100,
  sql: DbClient = getDb(),
): Promise<GitAuditEvent[]> {
  const { repository } = await requireRepositoryAdmin(workspaceId, repositoryId, actorNpub, sql);
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 100;
  const rows = await sql<any[]>`
    SELECT id, source, workspace_id, repository_id, actor_id, actor_npub, signer_npub,
           operation, requested_scope, git_service, decision, reason_code,
           policy_revision, capability_hash_prefix, autopilot_instance_npub,
           session_id, task_id, workroom_id, correlation_id, occurred_at
    FROM git_audit_events
    WHERE repository_id = ${repository.id}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${safeLimit}
  `;
  return rows.map((row) => ({
    event_id: row.id,
    source: row.source,
    workspace_id: row.workspace_id,
    repository_id: row.repository_id,
    actor_id: row.actor_id,
    actor_npub: row.actor_npub,
    signer_npub: row.signer_npub,
    operation: row.operation,
    requested_scope: row.requested_scope,
    service: row.git_service,
    decision: row.decision,
    reason_code: row.reason_code,
    policy_revision: row.policy_revision === null ? null : Number(row.policy_revision),
    capability_hash_prefix: row.capability_hash_prefix,
    autopilot_instance_npub: row.autopilot_instance_npub,
    session_id: row.session_id,
    task_id: row.task_id,
    workroom_id: row.workroom_id,
    correlation_id: row.correlation_id,
    occurred_at: row.occurred_at.toISOString(),
  }));
}
