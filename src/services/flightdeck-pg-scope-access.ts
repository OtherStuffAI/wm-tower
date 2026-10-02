import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { authorizeFlightDeckPgOperation, canReadFlightDeckPgContextScope, getEffectiveFlightDeckPgGroupIds, resolveFlightDeckPgActorByNpub } from './flightdeck-pg-authorization';
import { validateFlightDeckPgEditLease, releaseFlightDeckPgEditLease } from './flightdeck-pg-api';
import { ContextTreeError, contextUuid, type ContextTreeActor } from './flightdeck-pg-context-tree';
type Db = ReturnType<typeof getDb>;
const roles = { context_editor: ['context.edit'], scope_manager: ['scope.manage'] } as const;
const ownedPermissions = ['context.edit', 'scope.manage'];
export type ScopeAccessRole = keyof typeof roles;

async function grants(input: ContextTreeActor, sql: Db) {
  return sql`SELECT g.*, a.display_name AS actor_label,a.npub AS actor_npub,a.kind AS actor_kind,p.name AS group_label
    FROM flightdeck_pg_permission_grants g LEFT JOIN flightdeck_pg_actors a ON a.id=g.principal_actor_id
    LEFT JOIN flightdeck_pg_groups p ON p.workspace_id=g.workspace_id AND p.id=g.principal_group_id
    WHERE g.workspace_id=${input.workspaceId} AND g.resource_type='scope' AND g.resource_scope_id=${input.scopeId}
      AND g.revoked_at IS NULL ORDER BY g.id`;
}
function revision(rows: any[]) {
  return createHash('sha256').update(JSON.stringify(rows.map(r => [r.id,r.permission,r.principal_actor_id,r.principal_group_id]))).digest('hex');
}
function bundles(rows: any[]) {
  const result = new Map<string, any>();
  for (const row of rows) {
    const id = row.principal_actor_id || row.principal_group_id, key = `${row.principal_type}:${id}`;
    const b = result.get(key) || { principal_type: row.principal_type, principal_id: id,
      label: row.actor_label || row.group_label || (row.actor_kind === 'agent' ? 'Unnamed agent' : row.principal_type === 'group' ? 'Unnamed group' : 'Unnamed person'),
      kind: row.actor_kind || 'group', permissions: [], grant_ids: [] };
    b.permissions.push(row.permission); b.grant_ids.push(row.id); result.set(key,b);
  }
  return [...result.values()].map(b => ({...b, role: b.permissions.includes('scope.manage') ? 'scope_manager' : b.permissions.includes('context.edit') ? 'context_editor' : 'custom'}));
}

/** Adapter over canonical grants. Roles are presentation; edits only add their permission.
 * Explicit revocation removes role permissions and preserves arbitrary/custom grants. */
export async function runScopeAccess(input: ContextTreeActor, body?: unknown, db: Db = getDb()) {
  return db.begin('isolation level read committed', async tx => {
    const sql = tx as unknown as Db;
    if (!contextUuid.test(input.scopeId)) throw new ContextTreeError(400,'validation_error','Invalid scope');
    const [scope] = await sql`SELECT id FROM flightdeck_pg_scopes WHERE workspace_id=${input.workspaceId} AND id=${input.scopeId} AND archived_at IS NULL FOR UPDATE`;
    if (!scope) throw new ContextTreeError(404,'scope_not_found');
    const actor = await resolveFlightDeckPgActorByNpub(input.actorNpub,sql);
    if (!actor) throw new ContextTreeError(403,'permission_denied');
    const groupIds = await getEffectiveFlightDeckPgGroupIds(input.workspaceId,actor.id,sql);
    if (!await canReadFlightDeckPgContextScope({...input,actorId:actor.id,groupIds},sql)) throw new ContextTreeError(404,'scope_not_found');
    const manager = await authorizeFlightDeckPgOperation({...input,permission:'scope.manage',resource:{type:'scope',scopeId:input.scopeId}},sql);
    let rows = await grants(input,sql);
    let audit: any = null;
    if (body !== undefined) {
      if (!manager.allowed) throw new ContextTreeError(403,'permission_denied','scope.manage required');
      const b = body as Record<string, any>;
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['principal_type','principal_id','role','revoke','expected_revision','lease_token'].includes(k))
        || !['actor','group'].includes(b.principal_type) || !contextUuid.test(String(b.principal_id))
        || (b.revoke !== true && !Object.hasOwn(roles,b.role)) || (b.revoke !== undefined && b.revoke !== true)) throw new ContextTreeError(400,'validation_error','Choose a workspace person, agent or group and role');
      if (b.expected_revision !== revision(rows)) throw new ContextTreeError(409,'scope_access_conflict','Access changed; refresh before saving');
      const lease = await validateFlightDeckPgEditLease({workspaceId:input.workspaceId,entityType:'scope',entityId:input.scopeId,actorId:actor.id,leaseToken:b.lease_token},sql);
      if (!lease.ok) throw new ContextTreeError(409,lease.reason,'A valid scope edit lease is required');
      const [principal] = b.principal_type === 'actor'
        ? await sql`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${input.workspaceId} AND actor_id=${b.principal_id}`
        : await sql`SELECT id FROM flightdeck_pg_groups WHERE workspace_id=${input.workspaceId} AND id=${b.principal_id}`;
      if (!principal) throw new ContextTreeError(400,'validation_error','Principal must belong to this workspace');
      if (b.revoke) {
        await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${input.workspaceId}
          AND resource_type='scope' AND resource_scope_id=${input.scopeId} AND revoked_at IS NULL AND permission IN ${sql(ownedPermissions)}
          AND principal_type=${b.principal_type} AND (principal_actor_id=${b.principal_type==='actor'?b.principal_id:null}::uuid OR principal_group_id=${b.principal_type==='group'?b.principal_id:null}::uuid)`;
      } else {
        for (const permission of roles[b.role as ScopeAccessRole]) {
          if (rows.some(r => r.principal_type===b.principal_type && (r.principal_actor_id||r.principal_group_id)===b.principal_id && r.permission===permission)) continue;
          await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,principal_group_id,resource_type,resource_scope_id,permission,created_by_actor_id)
            VALUES(${input.workspaceId},${b.principal_type},${b.principal_type==='actor'?b.principal_id:null},${b.principal_type==='group'?b.principal_id:null},'scope',${input.scopeId},${permission},${actor.id})`;
        }
      }
      const [event] = await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,actor_id,action,resource_type,resource_id,metadata)
        VALUES(${input.workspaceId},${actor.id},${b.revoke?'scope_grant.revoke':'scope_grant.create'},'scope',${input.scopeId},${sql.json({principal_type:b.principal_type,principal_id:b.principal_id,role:b.role??null})}) RETURNING id`;
      audit = {event_id:event!.id,actor_npub:input.actorNpub};
      await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,scope_id,actor_id,event_type,entity_type,entity_id,operation,payload)
        VALUES(${input.workspaceId},${input.scopeId},${actor.id},'scope.access_updated','scope',${input.scopeId},'updated',${sql.json({scope_id:input.scopeId,access_changed:true})})`;
      await releaseFlightDeckPgEditLease({workspaceId:input.workspaceId,leaseId:lease.lease.id,actorId:actor.id,leaseToken:b.lease_token},sql);
      rows = await grants(input,sql);
    }
    // Readers see only their own provenance. Scope managers can inspect all workspace members.
    const members = manager.allowed ? await sql`SELECT a.id,a.display_name,a.kind FROM flightdeck_pg_workspace_memberships m JOIN flightdeck_pg_actors a ON a.id=m.actor_id WHERE m.workspace_id=${input.workspaceId}` : [{id:actor.id,display_name:actor.display_name,kind:actor.kind}];
    const effective = [];
    for (const m of members) {
      const groups = await getEffectiveFlightDeckPgGroupIds(input.workspaceId,m.id,sql);
      const sources = rows.filter(r => r.principal_actor_id===m.id || (r.principal_type==='group' && groups.includes(r.principal_group_id)));
      const permissions = [...new Set(sources.map(r=>r.permission))];
      if (!permissions.includes('scope.manage') && !permissions.includes('context.edit')) continue;
      effective.push({actor_id:m.id,label:m.display_name || (m.kind==='agent'?'Unnamed agent':'Unnamed person'),kind:m.kind,
        role:permissions.includes('scope.manage')?'scope_manager':'context_editor',sources:sources.filter(r=>ownedPermissions.includes(r.permission)).map(r=>({grant_id:r.id,permission:r.permission,via:r.principal_type==='group'?r.group_label:'Direct',group_id:r.principal_group_id}))});
    }
    const currentManage = await authorizeFlightDeckPgOperation({...input,permission:'scope.manage',resource:{type:'scope',scopeId:input.scopeId}},sql);
    return {scope_id:input.scopeId,revision:revision(rows),can_manage:currentManage.allowed,grants:manager.allowed?bundles(rows):[],effective_access:effective,...(audit?{audit}:{})};
  });
}
