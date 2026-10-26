import { createHash } from 'node:crypto';
import { NotificationError, type Sql } from './notification-core';
import { loadApnsConfig, normalizeApnsEnvironment, type ApnsEnvironment } from './notification-apns';

export const PLATFORMS = ['web', 'ios', 'ipados', 'macos', 'android'] as const;
export const PERMISSION_STATES = ['granted', 'denied', 'unknown'] as const;
export const DEFAULT_LEASE_SECONDS = 7 * 24 * 3600;
export const MAX_LEASE_SECONDS = 30 * 24 * 3600;
const CLIENT_APP_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const BUNDLE_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const TOKEN_RE = /^[0-9a-f]{64,200}$/;

type InstallationRow = {
  id: string; actor_id: string; client_app_id: string; platform: string; device_label: string | null; app_version: string | null;
  permission_state: string; enrolled_workspace_ids: string[]; status: string;
};
type TransportRow = {
  id: string; installation_id: string; actor_id: string; kind: string; address: string; environment: ApnsEnvironment | null; bundle_id: string | null;
  preview: string; lease_expires_at: Date; status: string;
};

const iso = (value: Date | string) => new Date(value).toISOString();
const bad = (message: string) => new NotificationError(400, 'validation_error', message);

export type InstallationInput = {
  client_app_id?: string; platform?: string; device_label?: string | null; app_version?: string | null; permission_state?: string;
};

export function parseInstallationInput(body: Record<string, any>, require: boolean): InstallationInput {
  const out: InstallationInput = {};
  if (body.client_app_id !== undefined) {
    if (typeof body.client_app_id !== 'string' || !CLIENT_APP_RE.test(body.client_app_id)) throw bad('client_app_id must be a client app slug');
    out.client_app_id = body.client_app_id;
  } else if (require) throw bad('client_app_id is required');
  if (body.platform !== undefined) {
    if (!PLATFORMS.includes(body.platform)) throw bad(`platform must be one of ${PLATFORMS.join(', ')}`);
    out.platform = body.platform;
  } else if (require) throw bad('platform is required');
  if (body.permission_state !== undefined) {
    if (!PERMISSION_STATES.includes(body.permission_state)) throw bad(`permission_state must be one of ${PERMISSION_STATES.join(', ')}`);
    out.permission_state = body.permission_state;
  }
  for (const key of ['device_label', 'app_version'] as const) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && (typeof body[key] !== 'string' || body[key].length > 64)) throw bad(`${key} must be a string of at most 64 characters`);
    out[key] = body[key];
  }
  return out;
}

export type ApnsInput = { device_token: string; environment: ApnsEnvironment; bundle_id: string; preview: 'generic' | 'full'; lease_seconds: number };

export function parseApnsInput(body: Record<string, any>): ApnsInput {
  const token = typeof body.device_token === 'string' ? body.device_token.toLowerCase() : '';
  if (!TOKEN_RE.test(token) || token.length % 2 !== 0) throw bad('device_token must be 64..200 hex characters');
  const environment = normalizeApnsEnvironment(body.environment);
  if (!environment) throw bad('environment must be sandbox or production');
  if (typeof body.bundle_id !== 'string' || body.bundle_id.length > 155 || !BUNDLE_RE.test(body.bundle_id)) throw bad('bundle_id is invalid');
  const preview = body.preview ?? 'generic';
  if (preview !== 'generic' && preview !== 'full') throw bad('preview must be generic or full');
  const lease = body.lease_seconds ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isInteger(lease) || lease < 1 || lease > MAX_LEASE_SECONDS) throw bad(`lease_seconds must be an integer between 1 and ${MAX_LEASE_SECONDS}`);
  return { device_token: token, environment, bundle_id: body.bundle_id, preview, lease_seconds: lease };
}

/** Honest delivery state for one transport: tells the client whether Tower can actually buzz this device. */
export function deliveryState(installation: Pick<InstallationRow, 'permission_state'>, transport: Pick<TransportRow, 'environment' | 'bundle_id'> & { registered_origin?: string | null } | null) {
  const readiness = loadApnsConfig();
  if (!readiness.ready) return { ready: false as const, reason: readiness.reason };
  if (transport?.environment && !readiness.config.environments.has(transport.environment)) return { ready: false as const, reason: 'environment_not_enabled' };
  if (transport?.bundle_id && !readiness.config.topics.has(transport.bundle_id)) return { ready: false as const, reason: 'bundle_not_allowed' };
  if (installation.permission_state !== 'granted') return { ready: false as const, reason: 'permission_not_granted' };
  // The alert envelope needs an https origin: the configured NOTIF_PUBLIC_ORIGIN, else the https origin seen at registration.
  if (transport && !readiness.config.publicOrigin && !transport.registered_origin?.startsWith('https://')) return { ready: false as const, reason: 'origin_unavailable' };
  return { ready: true as const };
}

export function serializeInstallation(row: InstallationRow) {
  return {
    installation_id: row.id, client_app_id: row.client_app_id, platform: row.platform, permission_state: row.permission_state,
    status: row.status, enrolled_workspace_ids: row.enrolled_workspace_ids,
  };
}

export function serializeTransport(row: TransportRow) {
  return {
    installation_id: row.installation_id, kind: row.kind, environment: row.environment, bundle_id: row.bundle_id, preview: row.preview,
    status: row.status, token_suffix: row.address.slice(-6), lease_expires_at: iso(row.lease_expires_at),
  };
}

type Registrant = { actorId: string; workspaceId: string; signerNpub: string; installationId: string };

/** Creates or updates the caller's installation and enrolls the workspace. Another actor's id is refused, never rewritten. */
async function upsertInstallation(tx: Sql, r: Registrant, input: InstallationInput, defaults: { client_app_id: string; platform: string }): Promise<InstallationRow> {
  await tx`
    INSERT INTO flightdeck_pg_notification_installations (id, actor_id, client_app_id, platform, signer_npub)
    VALUES (${r.installationId}, ${r.actorId}, ${input.client_app_id ?? defaults.client_app_id}, ${input.platform ?? defaults.platform}, ${r.signerNpub})
    ON CONFLICT (id) DO NOTHING`;
  const [row] = await tx<InstallationRow[]>`SELECT * FROM flightdeck_pg_notification_installations WHERE id = ${r.installationId} FOR UPDATE`;
  if (!row || row.actor_id !== r.actorId) throw new NotificationError(409, 'installation_owned', 'Installation id belongs to another actor');
  // A revoked installation starts over: stale enrollments from before the revocation must not come back.
  const enrolled = row.status === 'revoked' ? [] : row.enrolled_workspace_ids;
  const next = enrolled.includes(r.workspaceId) ? enrolled : [...enrolled, r.workspaceId];
  const [updated] = await tx<InstallationRow[]>`
    UPDATE flightdeck_pg_notification_installations SET
      client_app_id = ${input.client_app_id ?? (row.status === 'revoked' ? defaults.client_app_id : row.client_app_id)},
      platform = ${input.platform ?? row.platform},
      device_label = ${input.device_label === undefined ? row.device_label : input.device_label},
      app_version = ${input.app_version === undefined ? row.app_version : input.app_version},
      permission_state = ${input.permission_state ?? row.permission_state},
      signer_npub = ${r.signerNpub}, enrolled_workspace_ids = ${next}::uuid[], status = 'active', last_seen_at = NOW()
    WHERE id = ${r.installationId} RETURNING *`;
  return updated!;
}

export async function putInstallation(sql: Sql, r: Registrant, input: InstallationInput) {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    const installation = await upsertInstallation(tx, r, input, { client_app_id: input.client_app_id!, platform: input.platform! });
    const [transport] = await tx<TransportRow[]>`SELECT * FROM flightdeck_pg_notification_transports WHERE installation_id = ${installation.id} AND kind = 'apns' AND status = 'active'`;
    return { installation: serializeInstallation(installation), delivery: deliveryState(installation, transport ?? null) };
  });
}

/** Withdraws every pending alert of the given transports (they will never be sent). */
async function suppressPending(tx: Sql, where: { transportIds: string[] }, reason: string) {
  if (!where.transportIds.length) return;
  await tx`
    UPDATE flightdeck_pg_notification_alerts SET state = 'suppressed', reason = ${reason}, lease_owner = NULL, lease_until = NULL
    WHERE transport_id = ANY(${where.transportIds}::uuid[]) AND state IN ('pending', 'failed', 'leased')`;
}

export async function removeEnrollment(sql: Sql, r: Registrant) {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    const [row] = await tx<InstallationRow[]>`SELECT * FROM flightdeck_pg_notification_installations WHERE id = ${r.installationId} AND actor_id = ${r.actorId} AND status = 'active' FOR UPDATE`;
    if (!row) throw new NotificationError(404, 'installation_not_found', 'No active installation for this actor');
    const remaining = row.enrolled_workspace_ids.filter((id) => id !== r.workspaceId);
    if (remaining.length === row.enrolled_workspace_ids.length) throw new NotificationError(404, 'installation_not_found', 'Installation is not enrolled in this workspace');
    if (remaining.length) {
      await tx`UPDATE flightdeck_pg_notification_installations SET enrolled_workspace_ids = ${remaining}::uuid[], last_seen_at = NOW() WHERE id = ${row.id}`;
    } else {
      const transports = await tx<{ id: string }[]>`
        UPDATE flightdeck_pg_notification_transports SET status = 'revoked', updated_at = NOW() WHERE installation_id = ${row.id} AND status = 'active' RETURNING id`;
      await suppressPending(tx, { transportIds: transports.map((t) => t.id) }, 'transport_revoked');
      await tx`UPDATE flightdeck_pg_notification_installations SET enrolled_workspace_ids = '{}', status = 'revoked', last_seen_at = NOW() WHERE id = ${row.id}`;
    }
    return { revoked: true as const, remaining_workspace_ids: remaining };
  });
}

export async function revokeTransport(sql: Sql, r: Registrant, kind: string) {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    const [inst] = await tx<InstallationRow[]>`SELECT * FROM flightdeck_pg_notification_installations WHERE id = ${r.installationId} AND actor_id = ${r.actorId} AND status = 'active' FOR UPDATE`;
    if (!inst) throw new NotificationError(404, 'installation_not_found', 'No active installation for this actor');
    const revoked = await tx<{ id: string }[]>`
      UPDATE flightdeck_pg_notification_transports SET status = 'revoked', updated_at = NOW()
      WHERE installation_id = ${r.installationId} AND kind = ${kind} AND actor_id = ${r.actorId} AND status = 'active' RETURNING id`;
    if (!revoked.length) throw new NotificationError(404, 'installation_not_found', 'No active transport');
    await suppressPending(tx, { transportIds: revoked.map((t) => t.id) }, 'transport_revoked');
    return { revoked: true as const, remaining_workspace_ids: inst.enrolled_workspace_ids };
  });
}

/**
 * Registers or renews an APNs token for the caller's installation. `implicit` (the Apple alias route) creates the installation
 * and enrolls the workspace in the same transaction; the canonical route requires both to exist already.
 */
export async function putApnsTransport(
  sql: Sql, r: Registrant, input: ApnsInput, opts: { implicit: InstallationInput | null; origin: string | null },
) {
  const readiness = loadApnsConfig();
  if (readiness.ready && !readiness.config.topics.has(input.bundle_id)) throw new NotificationError(400, 'bundle_not_allowed', 'bundle_id is not on this Tower\'s push allow-list');
  const hash = createHash('sha256').update(input.device_token).digest('hex');
  const origin = opts.origin && opts.origin.startsWith('https://') ? opts.origin : null;

  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    let installation: InstallationRow;
    if (opts.implicit) {
      const mapped = readiness.ready ? readiness.config.topics.get(input.bundle_id) : undefined;
      installation = await upsertInstallation(tx, r, opts.implicit, { client_app_id: mapped ?? 'ambulando', platform: 'ios' });
    } else {
      const [row] = await tx<InstallationRow[]>`SELECT * FROM flightdeck_pg_notification_installations WHERE id = ${r.installationId} FOR UPDATE`;
      if (!row || row.status !== 'active') throw new NotificationError(404, 'installation_not_found', 'Register the installation first');
      if (row.actor_id !== r.actorId) throw new NotificationError(409, 'installation_owned', 'Installation id belongs to another actor');
      if (!row.enrolled_workspace_ids.includes(r.workspaceId)) throw new NotificationError(409, 'workspace_not_enrolled', 'Installation is not enrolled in this workspace');
      installation = row;
    }

    const [existing] = await tx<TransportRow[]>`SELECT * FROM flightdeck_pg_notification_transports WHERE kind = 'apns' AND address_hash = ${hash} FOR UPDATE`;
    if (existing && existing.actor_id !== r.actorId) {
      const live = existing.status === 'active' && new Date(existing.lease_expires_at).getTime() > Date.now();
      if (live) {
        await tx`INSERT INTO flightdeck_pg_notification_audit (workspace_id, signer_npub, action, outcome, error_code) VALUES (${r.workspaceId}, ${r.signerNpub}, 'transport_register', 'rejected', 'transport_owned')`;
        throw new NotificationError(409, 'transport_owned', 'This device token is registered to another actor');
      }
    }

    // One active transport per installation: the new registration supersedes the old one.
    const superseded = await tx<{ id: string }[]>`
      UPDATE flightdeck_pg_notification_transports SET status = 'revoked', updated_at = NOW()
      WHERE installation_id = ${installation.id} AND kind = 'apns' AND status = 'active' AND id IS DISTINCT FROM ${existing?.id ?? null}::uuid RETURNING id`;
    await suppressPending(tx, { transportIds: superseded.map((t) => t.id) }, 'transport_revoked');

    let row: TransportRow;
    if (existing) {
      // Pending alerts addressed to a previous owner or installation must not follow the token.
      if (existing.actor_id !== r.actorId || existing.installation_id !== installation.id) await suppressPending(tx, { transportIds: [existing.id] }, 'transport_owner_changed');
      [row] = await tx<TransportRow[]>`
        UPDATE flightdeck_pg_notification_transports SET
          installation_id = ${installation.id}, actor_id = ${r.actorId}, address = ${input.device_token}, environment = ${input.environment}, bundle_id = ${input.bundle_id},
          preview = ${input.preview}, registered_origin = ${origin}, lease_expires_at = NOW() + make_interval(secs => ${input.lease_seconds}),
          status = 'active', failure_count = 0, updated_at = NOW()
        WHERE id = ${existing.id} RETURNING *`;
    } else {
      [row] = await tx<TransportRow[]>`
        INSERT INTO flightdeck_pg_notification_transports (installation_id, actor_id, kind, address, address_hash, environment, bundle_id, preview, registered_origin, lease_expires_at)
        VALUES (${installation.id}, ${r.actorId}, 'apns', ${input.device_token}, ${hash}, ${input.environment}, ${input.bundle_id}, ${input.preview}, ${origin}, NOW() + make_interval(secs => ${input.lease_seconds}))
        RETURNING *`;
    }
    return { installation: serializeInstallation(installation), device: serializeTransport(row!), delivery: deliveryState(installation, row!) };
  });
}

/** Content-free transport readiness for the workspace descriptor. */
export function transportAdvertisement() {
  const readiness = loadApnsConfig();
  return {
    transports: ['apns'],
    alerts: readiness.ready,
    // false: each transport must have registered over https (delivery.reason=origin_unavailable otherwise)
    public_origin_configured: readiness.ready && readiness.config.publicOrigin !== null,
    transport_status: {
      apns: readiness.ready
        ? { ready: true, environments: [...readiness.config.environments] }
        : { ready: false, reason: readiness.reason, environments: [] as string[] },
    },
    push_envelope_v: 1,
  };
}
