import { nip19, verifyEvent, type Event } from 'nostr-tools';
import { getDb } from '../db';

type DbClient = ReturnType<typeof getDb>;
export const FLIGHTDECK_PG_IDENTITY_ROTATION_KIND = 33359;
export const FLIGHTDECK_PG_IDENTITY_ROTATION_PROTOCOL = 'flightdeck_pg_agent_identity_rotation';
const MAX_PROOF_LIFETIME_SECONDS = 600;
const MAX_CLOCK_SKEW_SECONDS = 60;
const npubPattern = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{50,}$/i;
const rotationIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export type AgentIdentityRotationProof = Event;
export type AgentIdentityRotationRequest = {
  rotation_id: string;
  old_npub: string;
  new_npub: string;
  proof: AgentIdentityRotationProof;
};
export type AgentIdentityRotationResult = {
  status: 'completed' | 'idempotent_replay';
  actor_id: string;
  old_npub: string;
  new_npub: string;
  rotation_id: string;
  proof_event_id: string;
  completed_at: string;
  migration_counts: Record<string, number>;
  warnings: string[];
};

export class AgentIdentityRotationError extends Error {
  constructor(public code: 'invalid_proof'|'stale_identity'|'conflict'|'unsupported_records', message: string, public status: 400|409|422 = 400) { super(message); }
}

function tag(event: Event, name: string): string | null {
  const values = event.tags.filter((entry) => entry[0] === name);
  return values.length === 1 && values[0]?.length === 2 ? values[0][1]! : null;
}

export function rotationProofContent(input: { tower_origin: string; workspace_id: string; actor_id: string; old_npub: string; new_npub: string; rotation_id: string; created_at: number; expires_at: number }) {
  return JSON.stringify({
    protocol: FLIGHTDECK_PG_IDENTITY_ROTATION_PROTOCOL,
    version: 1,
    tower_origin: input.tower_origin,
    workspace_id: input.workspace_id,
    actor_id: input.actor_id,
    old_npub: input.old_npub,
    new_npub: input.new_npub,
    rotation_id: input.rotation_id,
    created_at: input.created_at,
    expires_at: input.expires_at,
  });
}

export function validateAgentIdentityRotationProof(input: AgentIdentityRotationRequest & { towerOrigin: string; workspaceId: string; actorId: string; now?: number }) {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!rotationIdPattern.test(input.rotation_id) || !npubPattern.test(input.old_npub) || !npubPattern.test(input.new_npub) || input.old_npub === input.new_npub) throw new AgentIdentityRotationError('invalid_proof', 'Invalid rotation identity fields');
  const proof = input.proof;
  if (!proof || !verifyEvent(proof) || proof.kind !== FLIGHTDECK_PG_IDENTITY_ROTATION_KIND) throw new AgentIdentityRotationError('invalid_proof', 'New-key rotation proof is invalid');
  let signerNpub = '';
  try { signerNpub = nip19.npubEncode(proof.pubkey); } catch {}
  if (signerNpub !== input.new_npub) throw new AgentIdentityRotationError('invalid_proof', 'Rotation proof must be signed by new_npub');
  const expiresAt = Number(tag(proof, 'expires_at'));
  if (!Number.isInteger(proof.created_at) || !Number.isInteger(expiresAt) || proof.created_at > now + MAX_CLOCK_SKEW_SECONDS || proof.created_at < now - MAX_PROOF_LIFETIME_SECONDS || expiresAt < now || expiresAt > proof.created_at + MAX_PROOF_LIFETIME_SECONDS) throw new AgentIdentityRotationError('invalid_proof', 'Rotation proof is stale or has an invalid expiry');
  const expected = rotationProofContent({ tower_origin: input.towerOrigin, workspace_id: input.workspaceId, actor_id: input.actorId, old_npub: input.old_npub, new_npub: input.new_npub, rotation_id: input.rotation_id, created_at: proof.created_at, expires_at: expiresAt });
  const expectedTags: Record<string, string> = { protocol: FLIGHTDECK_PG_IDENTITY_ROTATION_PROTOCOL, tower_origin: input.towerOrigin, workspace_id: input.workspaceId, actor_id: input.actorId, old_npub: input.old_npub, new_npub: input.new_npub, rotation_id: input.rotation_id, expires_at: String(expiresAt) };
  if (proof.content.length > 2_048 || proof.tags.length !== Object.keys(expectedTags).length || proof.content !== expected || Object.entries(expectedTags).some(([name, value]) => tag(proof, name) !== value)) throw new AgentIdentityRotationError('invalid_proof', 'Rotation proof context does not match the request');
  return { proofEventId: proof.id, proofCreatedAt: new Date(proof.created_at * 1000), proofExpiresAt: new Date(expiresAt * 1000) };
}

function serialize(row: any, replay: boolean): AgentIdentityRotationResult {
  return { status: replay ? 'idempotent_replay' : 'completed', actor_id: row.actor_id, old_npub: row.old_npub, new_npub: row.new_npub, rotation_id: row.rotation_id, proof_event_id: row.proof_event_id, completed_at: new Date(row.completed_at).toISOString(), migration_counts: row.migration_counts, warnings: row.warnings };
}

export async function rotateFlightDeckPgAgentIdentity(input: AgentIdentityRotationRequest & { towerOrigin: string; workspaceId: string; actorId: string; requesterNpub: string }, sql: DbClient = getDb()): Promise<AgentIdentityRotationResult> {
  const verified = validateAgentIdentityRotationProof(input);
  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${input.actorId}, 0))`;
    const [prior] = await db<any[]>`SELECT * FROM flightdeck_pg_actor_identity_rotations WHERE rotation_id=${input.rotation_id}`;
    if (prior) {
      if (prior.actor_id !== input.actorId || prior.old_npub !== input.old_npub || prior.new_npub !== input.new_npub || prior.proof_event_id !== verified.proofEventId) throw new AgentIdentityRotationError('conflict', 'rotation_id is already bound to another rotation', 409);
      return serialize(prior, true);
    }
    const [actor] = await db<any[]>`SELECT id,npub,kind,created_at FROM flightdeck_pg_actors WHERE id=${input.actorId} FOR UPDATE`;
    if (!actor || actor.kind !== 'agent') throw new AgentIdentityRotationError('conflict', 'Agent actor was not found', 409);
    if (actor.npub !== input.old_npub || input.requesterNpub !== input.old_npub) throw new AgentIdentityRotationError('stale_identity', 'Authenticated old identity no longer matches the actor', 409);
    const [membership] = await db<any[]>`SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId}`;
    if (!membership) throw new AgentIdentityRotationError('conflict', 'Actor is not a member of the context workspace', 409);
    const [collision] = await db<any[]>`SELECT id FROM flightdeck_pg_actors WHERE npub=${input.new_npub}`;
    if (collision) throw new AgentIdentityRotationError('conflict', 'new_npub is already bound to an actor', 409);
    const [unsupported] = await db<any[]>`SELECT COUNT(*)::int count FROM user_workspace_keys WHERE active=true AND (user_npub=${input.old_npub} OR ws_key_npub=${input.old_npub})`;
    if (unsupported?.count) throw new AgentIdentityRotationError('unsupported_records', 'Agent identity is bound to user workspace keys and cannot be rotated automatically', 422);
    const [workspaceCount] = await db<any[]>`SELECT COUNT(*)::int count FROM flightdeck_pg_workspace_memberships WHERE actor_id=${input.actorId}`;
    const [settings] = await db<any[]>`WITH changed AS (UPDATE flightdeck_pg_personal_agent_settings SET autopilot_agents=(SELECT COALESCE(jsonb_agg(CASE WHEN item->>'agent_npub'=${input.old_npub} THEN jsonb_set(item,'{agent_npub}',to_jsonb(${input.new_npub}::text)) ELSE item END ORDER BY ord), '[]'::jsonb) FROM jsonb_array_elements(autopilot_agents) WITH ORDINALITY AS entries(item,ord)), row_version=row_version+1, updated_at=NOW() WHERE autopilot_agents @> ${db.json([{agent_npub: input.old_npub}] as any)} RETURNING 1) SELECT COUNT(*)::int count FROM changed`;
    const [channels] = await db<any[]>`
      WITH changed AS (
        UPDATE flightdeck_pg_channels channel
        SET participant_npubs = (
          SELECT array_agg(mapped_npub ORDER BY first_ordinality)
          FROM (
            SELECT mapped_npub, MIN(ordinality) AS first_ordinality
            FROM (
              SELECT
                CASE WHEN participant.npub = ${input.old_npub} THEN ${input.new_npub} ELSE participant.npub END AS mapped_npub,
                participant.ordinality
              FROM unnest(channel.participant_npubs) WITH ORDINALITY AS participant(npub, ordinality)
            ) resolved
            GROUP BY mapped_npub
          ) deduplicated
        ), updated_at = NOW()
        WHERE ${input.old_npub} = ANY(channel.participant_npubs)
        RETURNING 1
      )
      SELECT COUNT(*)::int count FROM changed
    `;
    const [updated] = await db<any[]>`UPDATE flightdeck_pg_actors SET npub=${input.new_npub},updated_at=NOW() WHERE id=${input.actorId} AND npub=${input.old_npub} RETURNING id`;
    if (!updated) throw new AgentIdentityRotationError('stale_identity', 'Actor identity changed concurrently', 409);
    const completedAt = new Date();
    await db`INSERT INTO flightdeck_pg_actor_identity_history(actor_id,npub,valid_from,valid_until,rotation_id,proof_event_id) VALUES(${input.actorId},${input.old_npub},${actor.created_at},${completedAt},${input.rotation_id},${verified.proofEventId})`;
    const counts = { workspaces: workspaceCount?.count ?? 0, actor_binding: 1, personal_agent_routing: settings?.count ?? 0, channel_participants: channels?.count ?? 0, memberships: 0, group_memberships: 0, permission_grants: 0, task_assignments: 0, task_watchers: 0, event_subscription_agents: 0, daily_scope_access: 0, authored_history: 0 };
    const [audit] = await db<any[]>`INSERT INTO flightdeck_pg_actor_identity_rotations(rotation_id,actor_id,context_workspace_id,old_npub,new_npub,requester_npub,proof_event_id,proof_created_at,proof_expires_at,completed_at,migration_counts,warnings) VALUES(${input.rotation_id},${input.actorId},${input.workspaceId},${input.old_npub},${input.new_npub},${input.requesterNpub},${verified.proofEventId},${verified.proofCreatedAt},${verified.proofExpiresAt},${completedAt},${db.json(counts as any)},${db.json([] as any)}) RETURNING *`;
    return serialize(audit, false);
  }) as Promise<AgentIdentityRotationResult>;
}
