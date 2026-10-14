import { getDb } from '../db';
import { authorizeFlightDeckPgOperation, getEffectiveFlightDeckPgGroupIds, canReadFlightDeckPgContextScope } from './flightdeck-pg-authorization';
export type RecordEntry = { family: string; id: string; operation: 'upsert' | 'delete'; position: string; row: Record<string, any>; bytes: number };
type Db = ReturnType<typeof getDb>;
/** Shared current-authority check for pages, chunk reads and receipt acknowledgements. */
export function recordVisibility(workspaceId: string, actorId: string, viewer: {npub:string;app_npub:string}, sql: Db) {
    const decisions = new Map<string, boolean>();
    let effectiveGroups: string[] | undefined;
    async function grant(permission: string, type: 'channel' | 'scope', id: string): Promise<boolean> {
      if (!id) return false;
      const key = `${permission}:${id}`;
      if (decisions.has(key)) return decisions.get(key)!;
      const decision = await authorizeFlightDeckPgOperation({ actorNpub: viewer.npub, appNpub: viewer.app_npub,
        workspaceId: workspaceId, permission,
        resource: type === 'channel' ? { type, channelId: id } : { type, scopeId: id } }, sql);
      decisions.set(key, decision.allowed);
      return decision.allowed;
    }
    async function visible(e: RecordEntry): Promise<boolean> {
      const r = e.row;
      if (['scope_order','thread_pin'].includes(e.family)) return r.actor_id === actorId;
      // A lifecycle tombstone carries identifiers only. Current grants still
      // authorize delivery after archival; revoked grants/membership are checked on every page.
      if (e.operation === 'delete' && ['scope','channel'].includes(e.family)) {
        effectiveGroups ??= await getEffectiveFlightDeckPgGroupIds(workspaceId, actorId, sql);
        const groups = effectiveGroups.length ? effectiveGroups : ['00000000-0000-0000-0000-000000000000'];
        const [allowed] = await sql`SELECT 1 FROM flightdeck_pg_permission_grants g
          WHERE g.workspace_id=${workspaceId} AND g.revoked_at IS NULL
          AND ((g.principal_type='actor' AND g.principal_actor_id=${actorId}) OR (g.principal_type='group' AND g.principal_group_id IN ${sql(groups)}))
          AND (( ${e.family}='channel' AND g.resource_type='channel' AND g.resource_channel_id::text=${e.id}
              AND g.permission IN ('channel.read','task.read','doc.read','file.read','audio_note.read'))
            OR (${e.family}='scope' AND ((g.resource_type='scope' AND g.resource_scope_id::text=${e.id}
              AND g.permission IN ('scope.read','scope.manage','context.edit')) OR (g.resource_type='channel' AND g.permission='channel.read'
              AND EXISTS(SELECT 1 FROM flightdeck_pg_channels c WHERE c.workspace_id=g.workspace_id AND c.id=g.resource_channel_id AND c.scope_id::text=${e.id}))))) LIMIT 1`;
        return !!allowed;
      }
      if (e.family === 'feed_subscription' || e.family === 'feed_item_state') return r.reader_actor_id === actorId;
      if (e.family === 'daily_note' || e.family === 'personal_wapp') return r.owner_actor_id === actorId;
      if (e.family === 'autopilot_connection' || e.family === 'workspace_agent') {
        const key = 'workspace.read';
        if (!decisions.has(key)) {
          const decision = await authorizeFlightDeckPgOperation({ actorNpub: viewer.npub, appNpub: viewer.app_npub,
            workspaceId: workspaceId, permission: 'workspace.read', resource: { type: 'workspace' } }, sql);
          decisions.set(key, decision.allowed);
        }
        return decisions.get(key)!;
      }
      if (['context_component', 'context_reference'].includes(e.family)) {
        effectiveGroups ??= await getEffectiveFlightDeckPgGroupIds(workspaceId, actorId, sql);
        const key = `context-scope:${r.scope_id}`;
        if (!decisions.has(key)) decisions.set(key, await canReadFlightDeckPgContextScope({
          workspaceId: workspaceId, scopeId: r.scope_id, actorId: actorId, groupIds: effectiveGroups }, sql));
        return decisions.get(key)!;
      }
      if (e.family === 'scope') {
        const [scope] = await sql`SELECT 1 FROM flightdeck_pg_scopes WHERE workspace_id=${workspaceId} AND id=${e.id} AND archived_at IS NULL`;
        if (!scope) return false;
        if (await grant('scope.read', 'scope', e.id) || await grant('context.edit', 'scope', e.id) || await grant('scope.manage', 'scope', e.id)) return true;
        effectiveGroups ??= await getEffectiveFlightDeckPgGroupIds(workspaceId, actorId, sql);
        const groups = effectiveGroups.length ? effectiveGroups : ['00000000-0000-0000-0000-000000000000'];
        const [childGrant] = await sql`SELECT 1 FROM flightdeck_pg_permission_grants pg
          JOIN flightdeck_pg_channels c ON c.workspace_id=pg.workspace_id AND c.id=pg.resource_channel_id
          WHERE pg.workspace_id=${workspaceId} AND c.scope_id=${e.id} AND c.archived_at IS NULL
          AND pg.resource_type='channel' AND pg.permission='channel.read' AND pg.revoked_at IS NULL
          AND ((pg.principal_type='actor' AND pg.principal_actor_id=${actorId})
            OR (pg.principal_type='group' AND pg.principal_group_id IN ${sql(groups)})) LIMIT 1`;
        return !!childGrant;
      }
      if (e.family === 'resource_view_state' && r.viewer_actor_id !== actorId) return false;
      const parentType = e.family === 'resource_view_state' ? r.resource_type
        : ['task_comment','task_assignment'].includes(e.family) ? 'task' : e.family === 'doc_comment' ? 'document' : e.family === 'message' && r.thread_id ? 'thread' : null;
      const parentId = e.family === 'resource_view_state' ? r.resource_id : parentType === 'task' ? r.task_id : parentType === 'thread' ? r.thread_id : r.doc_id;
      if (parentType && e.operation !== 'delete') {
        const table = { task: 'flightdeck_pg_tasks', document: 'flightdeck_pg_docs', thread: 'flightdeck_pg_threads' }[parentType as 'task'];
        if (!table || !parentId) return false;
        const key = `parent:${parentType}:${parentId}`;
        if (!decisions.has(key)) {
          const [parent] = await sql`SELECT 1 FROM ${sql(table)} WHERE workspace_id=${workspaceId} AND id=${parentId} AND deleted_at IS NULL`;
          decisions.set(key, !!parent);
        }
        if (!decisions.get(key)) return false;
      }
      const channelId = e.family === 'channel' ? e.id : r.channel_id;
      if (!channelId) return false;
      const activeKey = `active:${channelId}`;
      if (!decisions.has(activeKey)) {
        const [active] = await sql`SELECT 1 FROM flightdeck_pg_channels c JOIN flightdeck_pg_scopes s ON s.workspace_id=c.workspace_id AND s.id=c.scope_id WHERE c.workspace_id=${workspaceId} AND c.id=${channelId} AND c.archived_at IS NULL AND s.archived_at IS NULL`;
        decisions.set(activeKey, !!active);
      }
      if (!decisions.get(activeKey)) return false;
      const target = e.family === 'resource_view_state' ? (r.resource_type === 'document' ? 'doc' : r.resource_type) : e.family;
      if (target.startsWith('task')) return grant('task.read', 'channel', channelId);
      if (['doc','doc_comment','file','audio_note'].includes(target)) {
        return await grant(`${target === 'doc_comment' ? 'doc' : target}.read`, 'channel', channelId)
          || await grant('channel.read', 'channel', channelId);
      }
      return grant('channel.read', 'channel', channelId);
    }
    return visible;
}
