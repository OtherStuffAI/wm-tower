import type { GitForgejoDesiredState, GitForgejoOrganizationDesiredState } from '../types';

export class ForgejoAdapterError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}

export type ForgejoClientOptions = {
  baseUrl: string;
  controlToken: string;
  webhookUrl?: string;
  webhookSecret?: string;
  fetchImpl?: typeof fetch;
};

// Forgejo 16 validates team names with AlphaDashDot, so keep this provider
// label slug-safe. The stable Tower grants remain the authority identifiers.
const towerMembersTeamName = 'tower-members';

/**
 * Control-plane-only Forgejo adapter. The token belongs to a non-admin service
 * account that owns only Tower-managed organizations. The smart-HTTP gateway
 * does not instantiate this class or receive this token.
 */
export class ForgejoClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ForgejoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.baseUrl || !options.controlToken) throw new ForgejoAdapterError('forgejo_unconfigured', 'Forgejo adapter is not configured', 503);
  }

  private async request(path: string, init: RequestInit = {}, accepted = [200, 201, 204]): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `token ${this.options.controlToken}`,
        ...init.headers,
      },
    });
    if (!accepted.includes(response.status)) {
      // Deliberately omit response bodies: providers may echo credentials or
      // sensitive repository metadata in error details.
      throw new ForgejoAdapterError('forgejo_api_error', `Forgejo API request failed with status ${response.status}`, response.status);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  private async ensureOrganization(name: string) {
    const existing = await this.fetchImpl(`${this.baseUrl}/api/v1/orgs/${encodeURIComponent(name)}`, {
      headers: { authorization: `token ${this.options.controlToken}`, accept: 'application/json' },
    });
    if (existing.status === 200) return;
    if (existing.status !== 404) throw new ForgejoAdapterError('forgejo_api_error', `Forgejo organization lookup failed with status ${existing.status}`, existing.status);
    await this.request('/orgs', { method: 'POST', body: JSON.stringify({ username: name, visibility: 'private' }) });
  }

  private async ensureRepository(state: GitForgejoDesiredState) {
    const path = `/repos/${encodeURIComponent(state.forgejo_owner)}/${encodeURIComponent(state.forgejo_repository)}`;
    const existing = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      headers: { authorization: `token ${this.options.controlToken}`, accept: 'application/json' },
    });
    if (existing.status === 404) {
      await this.request(`/orgs/${encodeURIComponent(state.forgejo_owner)}/repos`, {
        method: 'POST',
        body: JSON.stringify({
          name: state.forgejo_repository,
          description: state.description,
          private: true,
          default_branch: state.default_branch,
          auto_init: true,
        }),
      });
      return;
    }
    if (existing.status !== 200) throw new ForgejoAdapterError('forgejo_api_error', `Forgejo repository lookup failed with status ${existing.status}`, existing.status);
    const repository = await existing.json() as any;
    if (!repository.private) throw new ForgejoAdapterError('forgejo_repository_public', 'Forgejo repository unexpectedly became public', 409);
    await this.request(path, {
      method: 'PATCH',
      body: JSON.stringify({ description: state.description, private: true, default_branch: state.default_branch }),
    });
  }

  private async reconcileOrganizationMembership(state: GitForgejoDesiredState | GitForgejoOrganizationDesiredState) {
    const organization = encodeURIComponent(state.forgejo_owner);
    const accessRows = state.actor_access.map((access) => ({
      username: 'username' in access ? access.username : access.shadow_username,
      organization_role: access.organization_role,
    }));
    const teams = await this.request(`/orgs/${organization}/teams?limit=100`);
    if (!Array.isArray(teams)) throw new ForgejoAdapterError('forgejo_api_error', 'Forgejo organization teams response was invalid', 502);
    const owners = teams.find((team) => team?.permission === 'owner');
    if (!owners?.id) throw new ForgejoAdapterError('forgejo_owners_team_missing', 'Forgejo organization Owners team was not found', 409);

    let members = teams.find((team) => team?.name === towerMembersTeamName);
    if (!members?.id && accessRows.some((access) => access.organization_role === 'member')) {
      members = await this.request(`/orgs/${organization}/teams`, {
        method: 'POST',
        body: JSON.stringify({
          name: towerMembersTeamName,
          description: 'Tower-authorized organization members. Repository access remains managed by Tower.',
          permission: 'read',
          includes_all_repositories: false,
          can_create_org_repo: false,
          units: ['repo.code'],
        }),
      });
      if (!members?.id) throw new ForgejoAdapterError('forgejo_api_error', 'Forgejo member team creation response was invalid', 502);
    }

    const managed = new Set('managed_usernames' in state ? state.managed_usernames : accessRows.map((access) => access.username));
    const desiredOwners = new Set(accessRows.filter((access) => access.organization_role === 'owner').map((access) => access.username));
    const desiredMembers = new Set(accessRows.filter((access) => access.organization_role === 'member').map((access) => access.username));
    for (const [team, desired] of [[owners, desiredOwners], [members, desiredMembers]] as const) {
      if (!team?.id) continue;
      const current = await this.request(`/teams/${encodeURIComponent(String(team.id))}/members?limit=1000`);
      if (!Array.isArray(current)) throw new ForgejoAdapterError('forgejo_api_error', 'Forgejo organization members response was invalid', 502);
      for (const member of current) {
        const username = String(member?.username || member?.login || '');
        if (username && managed.has(username) && !desired.has(username)) {
          await this.request(`/teams/${encodeURIComponent(String(team.id))}/members/${encodeURIComponent(username)}`, { method: 'DELETE' }, [204, 404]);
        }
      }
    }

    for (const access of accessRows) {
      const desiredTeamId = access.organization_role === 'owner' ? owners.id : members?.id;
      const obsoleteTeamId = access.organization_role === 'owner' ? members?.id : owners.id;
      if (!desiredTeamId) throw new ForgejoAdapterError('forgejo_members_team_missing', 'Forgejo member team was not found', 409);
      await this.request(`/teams/${encodeURIComponent(String(desiredTeamId))}/members/${encodeURIComponent(access.username)}`, { method: 'PUT' }, [204]);
      if (obsoleteTeamId) {
        await this.request(`/teams/${encodeURIComponent(String(obsoleteTeamId))}/members/${encodeURIComponent(access.username)}`, { method: 'DELETE' }, [204, 404]);
      }
    }
  }

  private async reconcileCollaborators(state: GitForgejoDesiredState) {
    const base = `/repos/${encodeURIComponent(state.forgejo_owner)}/${encodeURIComponent(state.forgejo_repository)}/collaborators`;
    const collaborators = await this.request(base);
    const desired = new Set(state.actor_access.map((access) => access.shadow_username));
    if (Array.isArray(collaborators)) {
      for (const collaborator of collaborators) {
        const username = String(collaborator?.username || collaborator?.login || '');
        if (username && !desired.has(username)) {
          await this.request(`${base}/${encodeURIComponent(username)}`, { method: 'DELETE' }, [204]);
        }
      }
    }
    for (const access of state.actor_access) {
      await this.request(
        `${base}/${encodeURIComponent(access.shadow_username)}`,
        { method: 'PUT', body: JSON.stringify({ permission: access.permission }) },
        [204],
      );
    }
  }

  private async reconcileProtectedBranches(state: GitForgejoDesiredState) {
    for (const rule of state.branch_rules) {
      const rawBranchName = rule.ref_name.replace(/^refs\/heads\//, '');
      const branchName = rawBranchName.endsWith('/') ? `${rawBranchName}*` : rawBranchName;
      const path = `/repos/${encodeURIComponent(state.forgejo_owner)}/${encodeURIComponent(state.forgejo_repository)}/branch_protections/${encodeURIComponent(branchName)}`;
      const payload = {
        branch_name: branchName,
        enable_push: rule.allow_direct_push,
        enable_force_push: false,
        enable_deletion: false,
        enable_merge_whitelist: false,
        required_approvals: rule.required_approvals,
        dismiss_stale_approvals: true,
        block_on_rejected_reviews: true,
        block_on_outdated_branch: true,
      };
      const current = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
        headers: { authorization: `token ${this.options.controlToken}`, accept: 'application/json' },
      });
      if (current.status === 404) await this.request(`/repos/${encodeURIComponent(state.forgejo_owner)}/${encodeURIComponent(state.forgejo_repository)}/branch_protections`, { method: 'POST', body: JSON.stringify(payload) });
      else if (current.status === 200) await this.request(path, { method: 'PATCH', body: JSON.stringify(payload) });
      else throw new ForgejoAdapterError('forgejo_api_error', `Forgejo branch protection lookup failed with status ${current.status}`, current.status);
    }
  }

  private async reconcileWebhook(state: GitForgejoDesiredState) {
    if (!this.options.webhookUrl || !this.options.webhookSecret) return;
    if (this.options.webhookSecret.length < 32) throw new ForgejoAdapterError('forgejo_webhook_secret_invalid', 'Forgejo webhook secret is too short', 503);
    const base = `/repos/${encodeURIComponent(state.forgejo_owner)}/${encodeURIComponent(state.forgejo_repository)}/hooks`;
    const hooks = await this.request(base);
    const existing = Array.isArray(hooks) ? hooks.find((hook) => hook?.config?.url === this.options.webhookUrl) : null;
    const payload = {
      type: 'forgejo', active: true, events: ['push'],
      config: { url: this.options.webhookUrl, content_type: 'json', secret: this.options.webhookSecret },
    };
    if (existing?.id) await this.request(`${base}/${encodeURIComponent(String(existing.id))}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await this.request(base, { method: 'POST', body: JSON.stringify(payload) });
  }

  async reconcile(state: GitForgejoDesiredState): Promise<void> {
    await this.ensureOrganization(state.forgejo_owner);
    await this.ensureRepository(state);
    await this.reconcileOrganizationMembership(state);
    await this.reconcileCollaborators(state);
    await this.reconcileProtectedBranches(state);
    await this.reconcileWebhook(state);
  }

  async reconcileOrganization(state: GitForgejoOrganizationDesiredState): Promise<void> {
    await this.ensureOrganization(state.forgejo_owner);
    await this.reconcileOrganizationMembership(state);
  }
}
