import { getDb } from '../db';
import { listFlightDeckPgWorkspaceMembers } from './flightdeck-pg-api';
import { authorizeFlightDeckPgOperation, getFlightDeckPgWorkspaceMembership, resolveFlightDeckPgWorkspace } from './flightdeck-pg-authorization';
import { evaluateWappManagement, WappManagementError } from './wapp-management';

type DbClient = ReturnType<typeof getDb>;

// A service may resolve only the scope selected by its approved installation
// intent. Publishing destinations do not themselves confer reader permission.
export async function resolveAutopilotWappScopeAccess(
  input: { workspaceId: string; installationId: string; signerNpub: string },
  sql: DbClient = getDb(),
) {
  const intents = await sql<any[]>`
    SELECT intent.*, owner.npub AS owner_npub,
      installation.lifecycle_status, installation.wapp_installation_id AS installed_id
    FROM flightdeck_pg_wapp_install_intents intent
    JOIN flightdeck_pg_actors owner ON owner.id = intent.owner_actor_id
    LEFT JOIN flightdeck_pg_wapp_installations installation ON installation.id = intent.installation_id
    WHERE intent.workspace_id = ${input.workspaceId}
      AND intent.request->>'wapp_installation_id' = ${input.installationId}
      AND intent.request->>'autopilot_npub' = ${input.signerNpub}
    ORDER BY intent.created_at DESC
    LIMIT 2
  `;
  if (intents.length !== 1) {
    throw new WappManagementError('installation_intent_unresolvable', 'Exactly one installation intent for this workspace and Autopilot is required', 409);
  }
  const intent = intents[0];
  const request = intent.request;
  if (intent.workspace_id !== input.workspaceId || request.wapp_installation_id !== input.installationId || request.autopilot_npub !== input.signerNpub) {
    throw new WappManagementError('installation_identity_mismatch', 'Installation intent identity does not match the request', 403);
  }
  if (!['pending', 'claimed', 'active'].includes(intent.status)
    || (intent.status !== 'pending' && intent.claimed_by_npub !== input.signerNpub)
    || (intent.status === 'active' && (intent.lifecycle_status !== 'active' || intent.installed_id !== input.installationId))) {
    throw new WappManagementError('installation_not_active', 'Installation intent or installation is not active for this Autopilot', 403);
  }
  const workspace = await resolveFlightDeckPgWorkspace(input.workspaceId, sql);
  if (!workspace || workspace.workspace_owner_npub !== intent.owner_npub
    || !await getFlightDeckPgWorkspaceMembership(input.workspaceId, intent.owner_actor_id, sql)
    || !await getFlightDeckPgWorkspaceMembership(input.workspaceId, intent.actor_id, sql)) {
    throw new WappManagementError('workspace_membership_required', 'Installation owner and author must remain members of the selected workspace', 403);
  }
  await evaluateWappManagement({
    workspaceId: input.workspaceId,
    ownerActorId: intent.owner_actor_id,
    actorId: intent.actor_id,
    delegationId: intent.delegation_id,
    request,
  }, sql);
  const scopeId = request.scope_id || request.destinations?.[0]?.scope_id;
  if (!scopeId) throw new WappManagementError('scope_required', 'Installation intent has no reader scope', 409);
  const [scope] = await sql<Array<{ id: string; workspace_id: string }>>`
    SELECT id, workspace_id FROM flightdeck_pg_scopes
    WHERE workspace_id = ${input.workspaceId} AND id = ${scopeId} AND archived_at IS NULL
  `;
  if (!scope || scope.workspace_id !== input.workspaceId || scope.id !== scopeId) {
    throw new WappManagementError('scope_not_found', 'Installation scope is missing, archived, or outside the workspace', 409);
  }
  const members = await listFlightDeckPgWorkspaceMembers(input.workspaceId, sql);
  const allowedNpubs = new Set<string>([intent.owner_npub]);
  for (const { actor, membership } of members) {
    if (membership.workspace_id !== input.workspaceId || membership.actor_id !== actor.id) {
      throw new WappManagementError('workspace_membership_mismatch', 'Scope reader membership does not match the workspace', 409);
    }
    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: actor.npub,
      appNpub: workspace.app_npub,
      workspaceId: input.workspaceId,
      permission: 'scope.read',
      resource: { type: 'scope', scopeId },
    }, sql);
    if (decision.allowed) allowedNpubs.add(actor.npub);
    else if (decision.category !== 'permission-denied') {
      throw new WappManagementError('scope_authorization_unavailable', `Scope authorization failed: ${decision.reason}`, 503);
    }
  }
  return {
    workspace_id: workspace.id,
    workspace_owner_npub: workspace.workspace_owner_npub,
    owner_npub: intent.owner_npub,
    wapp_installation_id: input.installationId,
    scope,
    allowed_npubs: [...allowedNpubs].sort(),
  };
}
