import { createHash } from 'crypto';
import { nip19, verifyEvent } from 'nostr-tools';
import { getEffectiveRequestUrl, verifyStrictNip98Mutation } from '../auth';
import { config } from '../config';
import { getDb } from '../db';
import type { FlightDeckPgHostedSignupRequest } from '../types';
import { serializeFlightDeckPgWorkspaceDescriptor } from './flightdeck-pg-api';
import { generatedFlightDeckPgWorkspaceServiceNpub, setupFlightDeckPgDevWorkspace } from './flightdeck-pg-setup';

export const HOSTED_SIGNUP_TERMS_VERSION = 'hosted-free-v1';
export const HOSTED_SIGNUP_ALLOWANCE_BYTES = 1_000_000_000;

export class HostedSignupError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

function oneTag(event: any, name: string): string | null {
  const tags = event?.tags?.filter((tag: unknown) => Array.isArray(tag) && tag[0] === name) ?? [];
  return tags.length === 1 && typeof tags[0][1] === 'string' ? tags[0][1] : null;
}

export async function verifyHostedSignupSignatures(request: Request, rawBody: string) {
  const user = await verifyStrictNip98Mutation(request.headers.get('authorization'), request, rawBody);
  if (!user.ok) throw new HostedSignupError(user.reasonCode, 401);
  if (user.userNpub !== user.signerNpub) throw new HostedSignupError('direct_user_signature_required', 403);

  const encoded = request.headers.get('x-flightdeck-site-attestation');
  if (!encoded) throw new HostedSignupError('site_attestation_required', 403);
  let event: any;
  try { event = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw new HostedSignupError('site_attestation_invalid', 403); }
  let validSiteEvent = false;
  try { validSiteEvent = verifyEvent(event); } catch { /* malformed event */ }
  if (!validSiteEvent) throw new HostedSignupError('site_attestation_invalid', 403);
  const siteNpub = nip19.npubEncode(event.pubkey);
  if (!config.flightDeck.hostedSignupSiteNpubs.includes(siteNpub)) {
    throw new HostedSignupError('site_not_allowed', 403);
  }
  const now = Math.floor(Date.now() / 1000);
  if (event.kind !== 27235 || !Number.isSafeInteger(event.created_at)
    || Math.abs(now - event.created_at) > 60) throw new HostedSignupError('site_attestation_expired', 403);
  const payloadHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  if (oneTag(event, 'u') !== getEffectiveRequestUrl(request).toString()
    || oneTag(event, 'method') !== 'POST'
    || oneTag(event, 'payload') !== payloadHash
    || oneTag(event, 'user_event_id') !== user.eventId) {
    throw new HostedSignupError('site_attestation_mismatch', 403);
  }
  return { user, siteNpub, siteEventId: String(event.id), payloadHash };
}

export function parseHostedSignupBody(rawBody: string): FlightDeckPgHostedSignupRequest {
  let body: any;
  try { body = JSON.parse(rawBody); } catch { throw new HostedSignupError('invalid_json', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'idempotency_key,terms_version,workspace_name') {
    throw new HostedSignupError('invalid_body', 400);
  }
  const name = body.workspace_name;
  if (typeof name !== 'string' || name !== name.trim() || name.length < 1 || name.length > 80) {
    throw new HostedSignupError('invalid_workspace_name', 400);
  }
  if (typeof body.idempotency_key !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotency_key)) {
    throw new HostedSignupError('invalid_idempotency_key', 400);
  }
  if (body.terms_version !== HOSTED_SIGNUP_TERMS_VERSION) throw new HostedSignupError('terms_version_required', 400);
  return body as FlightDeckPgHostedSignupRequest;
}

export async function createHostedSignup(request: Request, rawBody: string) {
  const proof = await verifyHostedSignupSignatures(request, rawBody);
  const body = parseHostedSignupBody(rawBody);
  const owner = proof.user.signerNpub;
  const nameKey = body.workspace_name.normalize('NFKC').toLocaleLowerCase('en-US');
  const sql = getDb();
  return sql.begin(async (tx) => {
    const db = tx as unknown as ReturnType<typeof getDb>;
    // Serialize all signup decisions for one owner across Tower instances.
    await db`SELECT pg_advisory_xact_lock(hashtext(${owner}))`;
    const replay = await db`
      SELECT 1 FROM flightdeck_pg_hosted_signups
      WHERE user_event_id = ${proof.user.eventId} OR site_event_id = ${proof.siteEventId}
      LIMIT 1
    `;
    if (replay.length) throw new HostedSignupError('signature_replayed', 409);
    const existing = await db`
      SELECT s.body_sha256, w.* FROM flightdeck_pg_hosted_signups s
      JOIN flightdeck_pg_workspaces w ON w.id = s.workspace_id
      WHERE s.owner_npub = ${owner} AND s.idempotency_key = ${body.idempotency_key}
      LIMIT 1
    `;
    if (existing.length) {
      if (existing[0].body_sha256 !== proof.payloadHash) throw new HostedSignupError('idempotency_conflict', 409);
      return { workspace_id: existing[0].id, descriptor: serializeFlightDeckPgWorkspaceDescriptor(existing[0] as any, { towerBaseUrl: getEffectiveRequestUrl(request).origin }), replayed: true, policy: hostedPolicy() };
    }
    const names = await db`
      SELECT name FROM flightdeck_pg_workspaces
      WHERE workspace_owner_npub = ${owner} AND app_npub = ${config.flightDeck.appNpub}
    `;
    if (names.some((row) => String(row.name).normalize('NFKC').toLocaleLowerCase('en-US') === nameKey)) {
      throw new HostedSignupError('workspace_name_taken', 409);
    }
    const [{ total, recent }] = await db`
      SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE created_at > now() - interval '1 hour')::integer AS recent
      FROM flightdeck_pg_hosted_signups WHERE owner_npub = ${owner}
    `;
    if (recent >= config.flightDeck.hostedSignupHourlyLimit) throw new HostedSignupError('signup_rate_limited', 429);
    if (total >= config.flightDeck.hostedSignupMaxWorkspaces) throw new HostedSignupError('hosted_workspace_limit', 403);
    const setup = await setupFlightDeckPgDevWorkspace({
      creatorNpub: owner, workspaceOwnerNpub: owner,
      workspaceName: body.workspace_name,
      workspaceDescription: null,
      workspaceServiceNpub: generatedFlightDeckPgWorkspaceServiceNpub(`${owner}:${body.idempotency_key}`),
      appNpub: config.flightDeck.appNpub,
      towerBaseUrl: getEffectiveRequestUrl(request).origin,
    }, db);
    await db`
      UPDATE flightdeck_pg_workspaces SET description = NULL,
        metadata = metadata || ${db.json({ hosted_signup: hostedPolicy() })}
      WHERE id = ${setup.workspace_id}
    `;
    await db`
      INSERT INTO flightdeck_pg_hosted_signups
        (owner_npub, idempotency_key, workspace_id, workspace_name_key, body_sha256, user_event_id, site_event_id, site_npub)
      VALUES (${owner}, ${body.idempotency_key}, ${setup.workspace_id}, ${nameKey}, ${proof.payloadHash}, ${proof.user.eventId}, ${proof.siteEventId}, ${proof.siteNpub})
    `;
    await db`
      INSERT INTO flightdeck_pg_audit_events (workspace_id, actor_id, action, resource_type, resource_id, metadata)
      VALUES (${setup.workspace_id}, ${setup.actors.creator.actor_id}, 'hosted_signup.create', 'workspace', ${setup.workspace_id},
        ${db.json({ user_event_id: proof.user.eventId, site_event_id: proof.siteEventId, site_npub: proof.siteNpub, idempotency_key: body.idempotency_key, terms_version: body.terms_version })})
    `;
    const [workspace] = await db`SELECT * FROM flightdeck_pg_workspaces WHERE id = ${setup.workspace_id}`;
    return { workspace_id: setup.workspace_id,
      descriptor: serializeFlightDeckPgWorkspaceDescriptor(workspace as any, { towerBaseUrl: getEffectiveRequestUrl(request).origin }),
      replayed: false, policy: hostedPolicy() };
  });
}

export function hostedPolicy() {
  return { plan: 'hosted_free', allowance_bytes: HOSTED_SIGNUP_ALLOWANCE_BYTES,
    terms_version: HOSTED_SIGNUP_TERMS_VERSION, billing_state: 'free_allowance',
    payment_required: false } as const;
}
