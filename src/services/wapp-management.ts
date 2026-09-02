import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../db';

type DbClient = ReturnType<typeof getDb>;
export const WAPP_MANAGEMENT_PERMISSION = 'wapp.manage' as const;
export const WAPP_MANAGEMENT_ROLE = 'wapp_management' as const;

export class WappManagementError extends Error {
  constructor(public code: string, message: string, public status = 400, public details: Record<string, unknown> = {}) { super(message); }
}

export type WappManagementFilters = {
  installation_ids: string[];
  app_ids: string[];
  scope_ids: string[];
  channel_ids: string[];
  capabilities: string[];
  open_origins: string[];
  autopilot_origins: string[];
};

const text = (v: unknown) => String(v ?? '').trim();
const strings = (v: unknown, field: string) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new WappManagementError('validation_failed', `${field} must be an array of non-empty strings`, 400, { field });
  return [...new Set(v.map((x) => x.trim()))].sort();
};
function exactOrigin(v: string, field: string) {
  let url: URL;
  try { url = new URL(v); } catch { throw new WappManagementError('origin_not_allowed', `${field} must contain valid origins`, 400, { field }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== v) {
    throw new WappManagementError('origin_not_allowed', `${field} entries must be exact normalized HTTPS origins`, 400, { field, value: v });
  }
  return url.origin;
}
export function normalizeWappManagementFilters(value: unknown): WappManagementFilters {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const capabilities = strings(o.capabilities, 'filters.capabilities');
  if (capabilities.some((x) => x !== 'activity.publish')) throw new WappManagementError('resource_filter_denied', 'Only activity.publish is supported in v1', 403);
  return {
    installation_ids: strings(o.installation_ids, 'filters.installation_ids'),
    app_ids: strings(o.app_ids, 'filters.app_ids'),
    scope_ids: strings(o.scope_ids, 'filters.scope_ids'),
    channel_ids: strings(o.channel_ids, 'filters.channel_ids'),
    capabilities,
    open_origins: strings(o.open_origins, 'filters.open_origins').map((x) => exactOrigin(x, 'filters.open_origins')),
    autopilot_origins: strings(o.autopilot_origins, 'filters.autopilot_origins').map((x) => exactOrigin(x, 'filters.autopilot_origins')),
  };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');
const nonceHash = (v: string) => createHash('sha256').update(v).digest('hex');
const iso = (v: Date | null) => v?.toISOString() ?? null;
const serialize = (row: any) => ({ ...row, valid_from: iso(row.valid_from), expires_at: iso(row.expires_at), revoked_at: iso(row.revoked_at), created_at: iso(row.created_at), updated_at: iso(row.updated_at), claimed_at: iso(row.claimed_at), completed_at: iso(row.completed_at) });

export async function createWappDelegation(input: { workspaceId: string; ownerActorId: string; delegateActorId: string; expiresAt: string; filters: unknown; ownerSignature?: string | null }, sql: DbClient = getDb()) {
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new WappManagementError('validation_failed', 'expires_at must be in the future');
  const filters = normalizeWappManagementFilters(input.filters);
  const requestHash = hash({ workspace_id: input.workspaceId, owner_actor_id: input.ownerActorId, delegate_actor_id: input.delegateActorId, permission: WAPP_MANAGEMENT_PERMISSION, filters, expires_at: expiresAt.toISOString() });
  const [row] = await sql<any[]>`
    INSERT INTO flightdeck_pg_wapp_delegations (workspace_id,owner_actor_id,delegate_actor_id,permission,filters,expires_at,request_hash,owner_signature,created_by_actor_id)
    SELECT ${input.workspaceId},${input.ownerActorId},${input.delegateActorId},${WAPP_MANAGEMENT_PERMISSION},${sql.json(filters as any)},${expiresAt},${requestHash},${text(input.ownerSignature) || null},${input.ownerActorId}
    WHERE EXISTS (SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${input.workspaceId} AND actor_id=${input.delegateActorId})
    RETURNING *`;
  if (!row) throw new WappManagementError('workspace_membership_required', 'Delegate must be a workspace member', 403);
  return serialize(row);
}

export async function listWappDelegations(workspaceId: string, actorId: string, owner: boolean, sql: DbClient = getDb()) {
  const rows = owner
    ? await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_delegations WHERE workspace_id=${workspaceId} ORDER BY created_at DESC`
    : await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_delegations WHERE workspace_id=${workspaceId} AND delegate_actor_id=${actorId} ORDER BY created_at DESC`;
  return rows.map(serialize);
}
export async function getWappDelegation(workspaceId: string, id: string, actorId: string, owner: boolean, sql: DbClient = getDb()) {
  const [row] = owner
    ? await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_delegations WHERE workspace_id=${workspaceId} AND id=${id}`
    : await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_delegations WHERE workspace_id=${workspaceId} AND id=${id} AND delegate_actor_id=${actorId}`;
  return row ? serialize(row) : null;
}
export async function revokeWappDelegation(workspaceId: string, id: string, actorId: string, sql: DbClient = getDb()) {
  const [row] = await sql<any[]>`UPDATE flightdeck_pg_wapp_delegations SET revoked_at=COALESCE(revoked_at,NOW()),revoked_by_actor_id=${actorId},grant_version=grant_version+1,updated_at=NOW() WHERE workspace_id=${workspaceId} AND id=${id} RETURNING *`;
  return row ? serialize(row) : null;
}

export async function evaluateWappManagement(input: { workspaceId: string; actorId: string; ownerActorId: string; request?: Record<string, any>; delegationId?: string | null }, sql: DbClient = getDb()) {
  if (input.actorId === input.ownerActorId) return { owner: true, delegation: null as any };
  const [row] = await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_delegations WHERE workspace_id=${input.workspaceId} AND delegate_actor_id=${input.actorId} AND owner_actor_id=${input.ownerActorId} AND (${input.delegationId || null}::uuid IS NULL OR id=${input.delegationId || null}) ORDER BY created_at DESC LIMIT 1`;
  if (!row) throw new WappManagementError('delegation_required', 'An active wapp_management delegation is required', 403);
  if (row.revoked_at) throw new WappManagementError('delegation_revoked', 'The delegation has been revoked', 403);
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new WappManagementError('delegation_expired', 'The delegation has expired', 403);
  const f = normalizeWappManagementFilters(row.filters);
  const r = input.request ?? {};
  const exact = (allowed: string[], values: string[], code: string) => { if (allowed.length && values.some((v) => !allowed.includes(v))) throw new WappManagementError(code, 'Request exceeds signed delegation filters', 403); };
  exact(f.installation_ids, [text(r.wapp_installation_id)].filter(Boolean), 'resource_filter_denied');
  exact(f.app_ids, [text(r.app_id)].filter(Boolean), 'resource_filter_denied');
  exact(f.scope_ids, [text(r.scope_id), ...(r.destinations ?? []).map((d: any) => text(d.scope_id))].filter(Boolean), 'delegation_scope_denied');
  exact(f.channel_ids, [text(r.channel_id), ...(r.destinations ?? []).map((d: any) => text(d.channel_id))].filter(Boolean), 'destination_not_allowed');
  exact(f.capabilities, strings(r.capabilities, 'capabilities'), 'resource_filter_denied');
  exact(f.open_origins, strings(r.registered_open_origins, 'registered_open_origins').map((x) => exactOrigin(x, 'registered_open_origins')), 'origin_not_allowed');
  exact(f.autopilot_origins, [text(r.autopilot_origin)].filter(Boolean).map((x) => exactOrigin(x, 'autopilot_origin')), 'origin_not_allowed');
  return { owner: false, delegation: serialize(row) };
}

export function normalizeInstallIntent(value: unknown) {
  const r = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  if (r.template_id) throw new WappManagementError('step_up_required', 'Delegated template creation is unsupported in v1', 403);
  for (const field of ['client_request_id','app_id','app_version','title','launch_url','autopilot_origin','autopilot_npub']) if (!text(r[field])) throw new WappManagementError('validation_failed', `${field} is required`, 400, { field });
  const launch = new URL(text(r.launch_url)); exactOrigin(launch.origin, 'launch_url');
  const request = { client_request_id: text(r.client_request_id), app_id: text(r.app_id), app_version: text(r.app_version), wapp_installation_id: text(r.wapp_installation_id) || null, title: text(r.title), description: text(r.description) || null, icon_url: text(r.icon_url) || null, launch_url: text(r.launch_url), scope_id: text(r.scope_id) || null, channel_id: text(r.channel_id) || null, autopilot_origin: exactOrigin(text(r.autopilot_origin), 'autopilot_origin'), autopilot_npub: text(r.autopilot_npub), registered_open_origins: strings(r.registered_open_origins, 'registered_open_origins').map((x) => exactOrigin(x, 'registered_open_origins')), capabilities: strings(r.capabilities, 'capabilities'), destinations: Array.isArray(r.destinations) ? r.destinations.map((d: any) => ({ scope_id: text(d.scope_id), channel_id: text(d.channel_id) })) : [] };
  if (request.capabilities.some((x) => x !== 'activity.publish')) throw new WappManagementError('resource_filter_denied', 'Only activity.publish is supported in v1', 403);
  if (!request.registered_open_origins.includes(launch.origin)) throw new WappManagementError('origin_not_allowed', 'launch_url origin must be explicitly allowed', 403);
  return request;
}

export async function createInstallIntent(input: { workspaceId: string; ownerActorId: string; actorId: string; signerNpub: string; delegationId?: string | null; request: ReturnType<typeof normalizeInstallIntent> }, sql: DbClient = getDb()) {
  const requestHash = hash(input.request);
  const [existing] = await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_install_intents WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_request_id=${input.request.client_request_id}`;
  if (existing) {
    if (existing.request_hash !== requestHash) throw new WappManagementError('idempotency_conflict', 'client_request_id was reused with different input', 409);
    return { intent: serialize(existing), challenge: null, replayed: true };
  }
  const challenge = randomBytes(32).toString('base64url');
  const [row] = await sql<any[]>`INSERT INTO flightdeck_pg_wapp_install_intents (workspace_id,owner_actor_id,actor_id,signer_npub,delegation_id,client_request_id,request_hash,request,claim_nonce_hash,claim_expires_at) VALUES (${input.workspaceId},${input.ownerActorId},${input.actorId},${input.signerNpub},${input.delegationId || null},${input.request.client_request_id},${requestHash},${sql.json(input.request as any)},${nonceHash(challenge)},NOW()+INTERVAL '10 minutes') RETURNING *`;
  return { intent: serialize(row), challenge, replayed: false };
}
export async function listInstallIntents(workspaceId: string, actorId: string, owner: boolean, sql: DbClient = getDb()) { const rows = owner ? await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_install_intents WHERE workspace_id=${workspaceId} ORDER BY created_at DESC` : await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_install_intents WHERE workspace_id=${workspaceId} AND actor_id=${actorId} ORDER BY created_at DESC`; return rows.map(serialize); }
export async function getInstallIntent(workspaceId: string, id: string, actorId: string, owner: boolean, sql: DbClient = getDb()) { const [r] = owner ? await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_install_intents WHERE workspace_id=${workspaceId} AND id=${id}` : await sql<any[]>`SELECT * FROM flightdeck_pg_wapp_install_intents WHERE workspace_id=${workspaceId} AND id=${id} AND actor_id=${actorId}`; return r ? serialize(r) : null; }

export async function listAutopilotInstallIntents(workspaceId: string, signerNpub: string, sql: DbClient = getDb()) {
  const rows = await sql<any[]>`SELECT intent.*,owner.npub owner_npub FROM flightdeck_pg_wapp_install_intents intent JOIN flightdeck_pg_actors owner ON owner.id=intent.owner_actor_id WHERE intent.workspace_id=${workspaceId} AND intent.request->>'autopilot_npub'=${signerNpub} AND intent.status IN ('pending','claimed','failed') ORDER BY intent.created_at ASC`;
  return rows.map(serialize);
}
export async function getAutopilotInstallIntent(workspaceId: string, id: string, signerNpub: string, sql: DbClient = getDb()) {
  const [row] = await sql<any[]>`SELECT intent.*,owner.npub owner_npub FROM flightdeck_pg_wapp_install_intents intent JOIN flightdeck_pg_actors owner ON owner.id=intent.owner_actor_id WHERE intent.workspace_id=${workspaceId} AND intent.id=${id} AND intent.request->>'autopilot_npub'=${signerNpub}`;
  return row ? serialize(row) : null;
}
export async function issueInstallIntentClaimChallenge(workspaceId: string, id: string, signerNpub: string, intentVersion: number, sql: DbClient = getDb()) {
  const challenge = randomBytes(32).toString('base64url');
  const [row] = await sql<any[]>`UPDATE flightdeck_pg_wapp_install_intents SET claim_nonce_hash=${nonceHash(challenge)},claim_expires_at=NOW()+INTERVAL '10 minutes',intent_version=intent_version+1,updated_at=NOW() WHERE workspace_id=${workspaceId} AND id=${id} AND request->>'autopilot_npub'=${signerNpub} AND status IN ('pending','failed') AND intent_version=${intentVersion} RETURNING *`;
  if (!row) throw new WappManagementError('stale_intent_version', 'Intent is not challengeable by this Autopilot identity at this version', 409);
  return { intent: serialize(row), challenge };
}

export async function claimInstallIntent(input: { workspaceId: string; id: string; signerNpub: string; challenge: string; intentVersion: number; observed: Record<string, unknown> }, sql: DbClient = getDb()) {
  const [row] = await sql<any[]>`UPDATE flightdeck_pg_wapp_install_intents SET status='claimed',claimed_by_npub=${input.signerNpub},claimed_at=NOW(),observed=${sql.json(input.observed as any)},intent_version=intent_version+1,updated_at=NOW() WHERE workspace_id=${input.workspaceId} AND id=${input.id} AND request->>'autopilot_npub'=${input.signerNpub} AND status IN ('pending','failed') AND intent_version=${input.intentVersion} AND claim_expires_at>NOW() AND claim_nonce_hash=${nonceHash(input.challenge)} RETURNING *`;
  if (!row) throw new WappManagementError('intent_not_claimable', 'Intent challenge, state, expiry, or version is invalid', 409);
  return serialize(row);
}

export async function completeInstallIntent(input: { workspaceId: string; id: string; signerNpub: string; intentVersion: number; observed: Record<string, any> }, sql: DbClient = getDb()) {
  return sql.begin(async (tx) => {
    const db = tx as unknown as DbClient;
    const [intent] = await db<any[]>`SELECT * FROM flightdeck_pg_wapp_install_intents WHERE workspace_id=${input.workspaceId} AND id=${input.id} FOR UPDATE`;
    if (!intent || intent.status !== 'claimed') throw new WappManagementError('intent_not_claimable', 'Intent is not claimed', 409);
    if (intent.intent_version !== input.intentVersion) throw new WappManagementError('stale_intent_version', 'intent_version is stale', 409);
    if (intent.claimed_by_npub !== input.signerNpub) throw new WappManagementError('autopilot_attestation_invalid', 'Only the claiming Autopilot identity may complete this intent', 403);
    const req = intent.request as ReturnType<typeof normalizeInstallIntent>;
    if (intent.delegation_id) await evaluateWappManagement({ workspaceId: input.workspaceId, actorId: intent.actor_id, ownerActorId: intent.owner_actor_id, request: req, delegationId: intent.delegation_id }, db);
    const installationId = text(input.observed.wapp_installation_id);
    const publisherNpub = text(input.observed.publisher_npub);
    const appVersion = text(input.observed.app_version);
    if (!installationId || !publisherNpub || !text(input.observed.attestation_hash)) throw new WappManagementError('autopilot_attestation_invalid', 'Installation, publisher and attestation observations are required', 403);
    if (req.wapp_installation_id && req.wapp_installation_id !== installationId) throw new WappManagementError('installation_identity_conflict', 'Observed installation differs from the requested installation', 409);
    if (req.app_version !== appVersion) throw new WappManagementError('stale_app_version', 'Observed app version differs from requested version', 409);
    if (text(input.observed.app_id) !== req.app_id || text(input.observed.launch_url) !== req.launch_url) throw new WappManagementError('autopilot_attestation_invalid', 'Observed app or launch URL differs from the immutable intent', 403);
    const [owner] = await db<any[]>`SELECT npub FROM flightdeck_pg_actors WHERE id=${intent.owner_actor_id}`;
    const [installation] = await db<any[]>`INSERT INTO flightdeck_pg_wapp_installations (wapp_installation_id,app_id,publisher_npub,owner_npub,display_name,autopilot_origin,requested_app_version,observed_app_version,lifecycle_status) VALUES (${installationId},${req.app_id},${publisherNpub},${owner.npub},${req.title},${req.autopilot_origin},${req.app_version},${appVersion},'active') ON CONFLICT (wapp_installation_id) DO UPDATE SET observed_app_version=EXCLUDED.observed_app_version,lifecycle_status='active',updated_at=NOW() WHERE flightdeck_pg_wapp_installations.app_id=EXCLUDED.app_id AND flightdeck_pg_wapp_installations.publisher_npub=EXCLUDED.publisher_npub AND flightdeck_pg_wapp_installations.owner_npub=EXCLUDED.owner_npub RETURNING *`;
    if (!installation) throw new WappManagementError('installation_identity_conflict', 'Stable installation identity fields conflict', 409);
    await db`
      INSERT INTO workspace_apps (
        workspace_owner_npub,
        app_npub,
        app_name,
        enabled,
        capabilities,
        created_by_npub
      )
      VALUES (
        ${installation.owner_npub},
        ${installation.publisher_npub},
        ${installation.display_name},
        true,
        ${db.json(['wapp', 'app-db'])},
        ${intent.signer_npub}
      )
      ON CONFLICT (workspace_owner_npub, app_npub)
      DO UPDATE SET
        app_name = EXCLUDED.app_name,
        enabled = true,
        capabilities = (
          SELECT jsonb_agg(required_capability.capability ORDER BY required_capability.capability)
          FROM (
            SELECT DISTINCT jsonb_array_elements_text(
              workspace_apps.capabilities || EXCLUDED.capabilities
            ) AS capability
          ) required_capability
        ),
        updated_at = NOW()
      WHERE workspace_apps.app_name IS DISTINCT FROM EXCLUDED.app_name
        OR workspace_apps.enabled IS DISTINCT FROM true
        OR NOT workspace_apps.capabilities @> EXCLUDED.capabilities
    `;
    const [launcher] = await db<any[]>`INSERT INTO flightdeck_pg_personal_wapps (workspace_id,owner_actor_id,scope_id,channel_id,title,description,launch_url,icon_url,app_id,wapp_id,source_wingman_url,status,metadata,created_by_actor_id,updated_by_actor_id,wapp_installation_id) VALUES (${input.workspaceId},${intent.owner_actor_id},${req.scope_id},${req.channel_id},${req.title},${req.description},${req.launch_url},${req.icon_url},${req.app_id},${installationId},${req.autopilot_origin},'active',${db.json({ wapp_installation_id: installationId } as any)},${intent.actor_id},${intent.actor_id},${installation.id}) ON CONFLICT (workspace_id,owner_actor_id,wapp_installation_id) WHERE wapp_installation_id IS NOT NULL DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,launch_url=EXCLUDED.launch_url,icon_url=EXCLUDED.icon_url,scope_id=EXCLUDED.scope_id,channel_id=EXCLUDED.channel_id,status='active',updated_by_actor_id=EXCLUDED.updated_by_actor_id,row_version=flightdeck_pg_personal_wapps.row_version+1,updated_at=NOW(),deleted_at=NULL RETURNING *`;
    let grant = null;
    if (req.capabilities.length) {
      [grant] = await db<any[]>`INSERT INTO flightdeck_pg_wapp_publishing_grants (workspace_id,installation_id,status,capabilities,registered_open_origins,approved_by_actor_id,approved_by_npub) VALUES (${input.workspaceId},${installation.id},'active',${req.capabilities},${req.registered_open_origins},${intent.actor_id},${owner.npub}) ON CONFLICT (workspace_id,installation_id) DO UPDATE SET status='active',capabilities=EXCLUDED.capabilities,registered_open_origins=EXCLUDED.registered_open_origins,approved_by_actor_id=EXCLUDED.approved_by_actor_id,approved_by_npub=EXCLUDED.approved_by_npub,grant_version=flightdeck_pg_wapp_publishing_grants.grant_version+1,revoked_at=NULL,updated_at=NOW() RETURNING *`;
      await db`DELETE FROM flightdeck_pg_wapp_publishing_destinations WHERE grant_id=${grant.id}`;
      for (const d of req.destinations) await db`INSERT INTO flightdeck_pg_wapp_publishing_destinations (grant_id,workspace_id,scope_id,channel_id) SELECT ${grant.id},${input.workspaceId},${d.scope_id},${d.channel_id} FROM flightdeck_pg_channels WHERE workspace_id=${input.workspaceId} AND id=${d.channel_id} AND scope_id=${d.scope_id} AND archived_at IS NULL`;
      const [{ count }] = await db<{count:number}[]>`SELECT count(*)::int count FROM flightdeck_pg_wapp_publishing_destinations WHERE grant_id=${grant.id}`;
      if (count !== req.destinations.length) throw new WappManagementError('channel_unavailable', 'A destination is unavailable or changed scope', 409);
    }
    const [done] = await db<any[]>`UPDATE flightdeck_pg_wapp_install_intents SET status='active',installation_id=${installation.id},personal_wapp_id=${launcher.id},observed=${db.json(input.observed as any)},intent_version=intent_version+1,completed_at=NOW(),updated_at=NOW() WHERE id=${intent.id} RETURNING *`;
    await db`INSERT INTO flightdeck_pg_audit_events (workspace_id,actor_id,action,resource_type,resource_id,metadata) VALUES (${input.workspaceId},${intent.actor_id},'wapp_install.complete','wapp_install_intent',${intent.id},${db.json({ owner_actor_id: intent.owner_actor_id, actor_id: intent.actor_id, signer_npub: intent.signer_npub, autopilot_signer_npub: input.signerNpub, publisher_npub: publisherNpub, delegation_id: intent.delegation_id, intent_id: intent.id, request_hash: intent.request_hash, outcome: 'accepted' } as any)})`;
    await db`INSERT INTO flightdeck_pg_outbox_events (workspace_id,actor_id,event_type,entity_type,entity_id,operation,entity_row_version,payload) VALUES (${input.workspaceId},${intent.actor_id},'flightdeck_pg.wapp_installation.active','wapp_installation',${installation.id},'active',${done.intent_version},${db.json({ intent_id: intent.id, installation_id: installationId, personal_wapp_id: launcher.id, grant_id: grant?.id ?? null } as any)})`;
    return { intent: serialize(done), installation, personal_wapp: launcher, grant };
  });
}

export async function failInstallIntent(workspaceId: string, id: string, signerNpub: string, code: string, message: string, observed: unknown, sql: DbClient = getDb()) { const [r] = await sql<any[]>`UPDATE flightdeck_pg_wapp_install_intents SET status='failed',last_error_code=${text(code) || 'installation_failed'},last_error_message=${text(message)},observed=${sql.json((observed && typeof observed === 'object' ? observed : {}) as any)},intent_version=intent_version+1,updated_at=NOW() WHERE workspace_id=${workspaceId} AND id=${id} AND claimed_by_npub=${signerNpub} AND status IN ('claimed','failed') RETURNING *`; if (!r) throw new WappManagementError('intent_not_claimable','Intent cannot be failed by this identity',409); return serialize(r); }

export async function listManagedWappInstallations(workspaceId: string, sql: DbClient = getDb()) {
  return sql<any[]>`SELECT i.*,g.status publishing_status,g.capabilities,g.registered_open_origins,w.id personal_wapp_id,w.scope_id,w.channel_id,w.launch_url FROM flightdeck_pg_wapp_installations i JOIN flightdeck_pg_wapp_install_intents intent ON intent.installation_id=i.id AND intent.workspace_id=${workspaceId} LEFT JOIN flightdeck_pg_wapp_publishing_grants g ON g.workspace_id=intent.workspace_id AND g.installation_id=i.id LEFT JOIN flightdeck_pg_personal_wapps w ON w.workspace_id=intent.workspace_id AND w.wapp_installation_id=i.id ORDER BY i.updated_at DESC`;
}
export async function getManagedWappInstallation(workspaceId: string, installationId: string, sql: DbClient = getDb()) { const rows=await listManagedWappInstallations(workspaceId,sql); return rows.find((r:any)=>r.wapp_installation_id===installationId)??null; }
export async function requestWappReconciliation(workspaceId:string,installationId:string,actorId:string,sql:DbClient=getDb()){const [r]=await sql<any[]>`UPDATE flightdeck_pg_wapp_installations i SET lifecycle_status='reconciliation_required',updated_at=NOW() FROM flightdeck_pg_wapp_install_intents intent WHERE intent.workspace_id=${workspaceId} AND intent.installation_id=i.id AND i.wapp_installation_id=${installationId} RETURNING i.*`;if(!r)throw new WappManagementError('installation_not_found','Installation not found',404);await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,entity_id,operation,payload)VALUES(${workspaceId},${actorId},'flightdeck_pg.wapp_installation.reconcile_requested','wapp_installation',${r.id},'reconcile_requested',${sql.json({wapp_installation_id:installationId} as any)})`;return r;}
export async function revokeManagedWappInstallation(workspaceId:string,installationId:string,actorId:string,sql:DbClient=getDb()){return sql.begin(async(tx)=>{const db=tx as unknown as DbClient;const [r]=await db<any[]>`UPDATE flightdeck_pg_wapp_installations i SET lifecycle_status='revoked',updated_at=NOW() FROM flightdeck_pg_wapp_install_intents intent WHERE intent.workspace_id=${workspaceId} AND intent.installation_id=i.id AND i.wapp_installation_id=${installationId} RETURNING i.*`;if(!r)throw new WappManagementError('installation_not_found','Installation not found',404);await db`UPDATE flightdeck_pg_personal_wapps SET status='archived',deleted_at=COALESCE(deleted_at,NOW()),row_version=row_version+1,updated_by_actor_id=${actorId},updated_at=NOW() WHERE workspace_id=${workspaceId} AND wapp_installation_id=${r.id}`;await db`UPDATE flightdeck_pg_wapp_publishing_grants SET status='revoked',revoked_at=COALESCE(revoked_at,NOW()),disable_open_links=true,grant_version=grant_version+1,updated_at=NOW() WHERE workspace_id=${workspaceId} AND installation_id=${r.id}`;await db`UPDATE flightdeck_pg_wapp_install_intents SET status='revoked',intent_version=intent_version+1,updated_at=NOW() WHERE workspace_id=${workspaceId} AND installation_id=${r.id}`;await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,entity_id,operation,payload)VALUES(${workspaceId},${actorId},'flightdeck_pg.wapp_installation.revoked','wapp_installation',${r.id},'revoked',${db.json({wapp_installation_id:installationId,teardown_requested:true} as any)})`;return r;});}
