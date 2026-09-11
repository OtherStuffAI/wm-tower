import { createHash } from 'node:crypto';
import { nip19, verifyEvent } from 'nostr-tools';
import { getDb } from '../db';
import type { DriveShare } from '../types';

export class DriveError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const DRIVE_POLICY_MAX_AGE_SECONDS = 900; // Implementation choice, not a product-approved timeout.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function driveId(value: string) {
  if (!uuid.test(value)) throw new DriveError('invalid_id');
  return value;
}
export function normalizeDriveShare(body: any) {
  const allowed = [
    'name',
    'host_name',
    'host_npub',
    'endpoint',
    'audience',
    'enabled',
    'previous_revision',
    'host_proof',
  ];
  if (!body || Object.keys(body).some((k) => !allowed.includes(k)))
    throw new DriveError('unknown_field');
  for (const k of ['name', 'host_name'])
    if (
      typeof body[k] !== 'string' ||
      !body[k].trim() ||
      body[k].length > 120 ||
      /[\x00-\x1f]/.test(body[k])
    )
      throw new DriveError('invalid_name');
  if (
    !['private', 'workspace'].includes(body.audience) ||
    typeof body.enabled !== 'boolean' ||
    !Number.isSafeInteger(body.previous_revision) ||
    body.previous_revision < 0
  )
    throw new DriveError('invalid_policy');
  try {
    if (nip19.decode(String(body.host_npub)).type !== 'npub') throw 0;
  } catch {
    throw new DriveError('invalid_host');
  }
  if (
    !/^http:\/\/npub1[023456789acdefghjklmnpqrstuvwxyz]{58}\.fips:[0-9]{1,5}$/.test(body.endpoint)
  )
    throw new DriveError('invalid_endpoint');
  const u = new URL(body.endpoint);
  if (!u.port || Number(u.port) < 1024 || Number(u.port) > 65535 || u.origin !== body.endpoint)
    throw new DriveError('invalid_endpoint');
  return {
    name: body.name.trim(),
    host_name: body.host_name.trim(),
    host_npub: body.host_npub,
    endpoint: body.endpoint,
    audience: body.audience,
    enabled: body.enabled,
    previous_revision: body.previous_revision,
  };
}
// The host service co-signs the exact owner registration, independently of mesh identity.
export function verifyDriveHostProof(
  event: any,
  url: string,
  ownerNpub: string,
  share: ReturnType<typeof normalizeDriveShare>,
  now = Date.now(),
) {
  const digest = createHash('sha256').update(JSON.stringify(share)).digest('hex');
  const tags = [
    ['protocol', 'fips-drive-register-v1'],
    ['u', url],
    ['owner', ownerNpub],
    ['payload', digest],
  ];
  try {
    if (
      event.kind !== 27235 ||
      event.content !== '' ||
      Math.abs(now / 1000 - event.created_at) > 60 ||
      JSON.stringify(event.tags) !== JSON.stringify(tags) ||
      nip19.npubEncode(event.pubkey) !== share.host_npub ||
      !verifyEvent(event)
    )
      throw 0;
  } catch {
    throw new DriveError('invalid_host_proof', 403);
  }
}
export async function saveDriveShare(
  workspace: string,
  id: string,
  actorId: string,
  ownerNpub: string,
  url: string,
  body: any,
) {
  driveId(id);
  const data = normalizeDriveShare(body);
  verifyDriveHostProof(body.host_proof, url, ownerNpub, data);
  return getDb().begin(async (tx) => {
    const sql = tx as unknown as ReturnType<typeof getDb>;
    // Serialize creation as well as CAS updates to prevent owner replacement races.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
    const [old] = await sql`SELECT * FROM flightdeck_pg_drive_shares WHERE id=${id} FOR UPDATE`;
    if (old && (old.workspace_id !== workspace || old.owner_actor_id !== actorId))
      throw new DriveError('owner_required', 403);
    if (Number(old?.revision ?? 0) !== data.previous_revision)
      throw new DriveError('revision_conflict', 409);
    await sql`DELETE FROM flightdeck_pg_drive_proofs WHERE expires_at < NOW()`;
    const proof =
      await sql`INSERT INTO flightdeck_pg_drive_proofs VALUES (${body.host_proof.id}, NOW()+INTERVAL '120 seconds') ON CONFLICT DO NOTHING RETURNING event_id`;
    if (!proof.length) throw new DriveError('replayed_proof', 409);
    const [share] =
      await sql`INSERT INTO flightdeck_pg_drive_shares (id,workspace_id,owner_actor_id,host_npub,endpoint,name,host_name,audience,enabled)
      VALUES (${id},${workspace},${actorId},${data.host_npub},${data.endpoint},${data.name},${data.host_name},${data.audience},${data.enabled})
      ON CONFLICT (id) DO UPDATE SET host_npub=EXCLUDED.host_npub,endpoint=EXCLUDED.endpoint,name=EXCLUDED.name,host_name=EXCLUDED.host_name,audience=EXCLUDED.audience,enabled=EXCLUDED.enabled,revision=flightdeck_pg_drive_shares.revision+1,updated_at=NOW() RETURNING *`;
    return share;
  });
}
export async function discoverDriveShares(workspace: string, actorId: string) {
  return getDb()<DriveShare[]>`SELECT s.*, a.npub AS owner_npub FROM flightdeck_pg_drive_shares s
    JOIN flightdeck_pg_actors a ON a.id=s.owner_actor_id
    JOIN flightdeck_pg_workspace_memberships m ON m.workspace_id=s.workspace_id AND m.actor_id=s.owner_actor_id
    WHERE s.workspace_id=${workspace} AND s.enabled AND (s.audience='workspace' OR s.owner_actor_id=${actorId}) ORDER BY s.id LIMIT 1000`;
}
export async function driveHostPolicy(workspace: string, id: string, signerNpub: string) {
  driveId(id);
  // One repeatable-read snapshot binds policy and membership, including owner removal/rotation.
  return getDb().begin('isolation level repeatable read', async (tx) => {
    const sql = tx as unknown as ReturnType<typeof getDb>;
    const [share] =
      await sql`SELECT s.*, a.npub AS owner_npub FROM flightdeck_pg_drive_shares s JOIN flightdeck_pg_actors a ON a.id=s.owner_actor_id WHERE s.workspace_id=${workspace} AND s.id=${id} AND s.host_npub=${signerNpub}`;
    if (!share) throw new DriveError('host_required', 403);
    const members =
      await sql`SELECT a.npub FROM flightdeck_pg_workspace_memberships m JOIN flightdeck_pg_actors a ON a.id=m.actor_id WHERE m.workspace_id=${workspace} ORDER BY a.npub`;
    const memberNpubs = members.map((m) => m.npub as string);
    const active = memberNpubs.includes(share.owner_npub);
    const allowed =
      active && share.enabled
        ? share.audience === 'private'
          ? [share.owner_npub]
          : memberNpubs
        : [];
    const revision = createHash('sha256')
      .update(JSON.stringify([share.revision, share.owner_npub, allowed]))
      .digest('hex');
    return {
      version: 1,
      workspace_id: workspace,
      share: { ...share, enabled: share.enabled && active },
      allowed_npubs: allowed,
      policy_revision: revision,
      verified_at: new Date().toISOString(),
      max_age_seconds: DRIVE_POLICY_MAX_AGE_SECONDS,
    };
  });
}
