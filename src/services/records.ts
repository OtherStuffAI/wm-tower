import { getDb } from '../db';
import { sseHub } from '../sse-hub';
import {
  isCheckoutRequiredRecordFamily,
  resolveRecordCheckoutPolicy,
} from './record-checkout-policy';
import type {
  AcquireRecordCheckoutInput,
  FetchRecordsInput,
  FetchRecordsSummaryInput,
  GroupPayloadInput,
  HeartbeatCheckResult,
  PaginatedRecordsResult,
  RecordFamilySummary,
  RecordCheckoutResponse,
  RecordCheckoutState,
  ReleaseRecordCheckoutInput,
  RenewRecordCheckoutInput,
  SyncRejectedRecord,
  SyncRecordInput,
  SyncResult,
  V4RecordGroupPayload,
  V4Record,
  V4RecordCheckout,
  RecordResponse,
} from '../types';

type DbClient = ReturnType<typeof getDb>;

const DEFAULT_CHECKOUT_LEASE_SECONDS = 900;
const MIN_CHECKOUT_LEASE_SECONDS = 60;
const MAX_CHECKOUT_LEASE_SECONDS = 3600;

function normalizeLeaseSeconds(leaseSeconds?: number): number {
  if (!Number.isFinite(leaseSeconds)) return DEFAULT_CHECKOUT_LEASE_SECONDS;
  const normalized = Math.trunc(Number(leaseSeconds));
  return Math.min(Math.max(normalized, MIN_CHECKOUT_LEASE_SECONDS), MAX_CHECKOUT_LEASE_SECONDS);
}

function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function serializeCheckout(
  checkout: Pick<V4RecordCheckout, 'checkout_id' | 'state' | 'checked_out_by_user_npub' | 'checked_out_by_workspace_user_key_npub' | 'checked_out_at' | 'lease_expires_at'>,
  stateOverride?: RecordCheckoutState['state'],
): RecordCheckoutState {
  const state = stateOverride ?? (checkout.state === 'checked_out' ? 'checked_out' : 'checked_in');
  return {
    checkout_id: checkout.checkout_id,
    state,
    checked_out_by_user_npub: state === 'checked_out' ? checkout.checked_out_by_user_npub : undefined,
    checked_out_by_workspace_user_key_npub: state === 'checked_out'
      ? checkout.checked_out_by_workspace_user_key_npub
      : undefined,
    checked_out_at: state === 'checked_out' ? toIsoString(checkout.checked_out_at) : undefined,
    lease_expires_at: state === 'checked_out' ? toIsoString(checkout.lease_expires_at) : undefined,
  };
}

function buildSyncRejection(
  params: Omit<SyncRejectedRecord, 'reason'> & { reason?: string },
): SyncRejectedRecord {
  return {
    ...params,
    reason: params.reason || params.error,
  };
}

export class RecordCheckoutError extends Error {
  code: string;
  status: number;
  payload: Record<string, unknown>;

  constructor(
    code: string,
    status: number,
    message: string,
    payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RecordCheckoutError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

class SyncRecordRejectionError extends Error {
  payload: SyncRejectedRecord;

  constructor(payload: SyncRejectedRecord) {
    super(payload.error);
    this.name = 'SyncRecordRejectionError';
    this.payload = payload;
  }
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as any).code) : '';
  const constraintName = typeof error === 'object' && error && 'constraint_name' in error
    ? String((error as any).constraint_name)
    : '';
  if (code !== '23505') return false;
  return !constraint || constraintName === constraint;
}

async function expireStaleCheckouts(tx: DbClient, workspaceServiceNpub: string, recordId: string) {
  await tx`
    UPDATE v4_record_checkouts
    SET state = 'expired',
        released_at = COALESCE(released_at, NOW())
    WHERE workspace_service_npub = ${workspaceServiceNpub}
      AND record_id = ${recordId}
      AND state = 'checked_out'
      AND lease_expires_at <= NOW()
  `;
}

async function getLatestRecord(tx: DbClient, recordId: string) {
  const [latest] = await tx<V4Record[]>`
    SELECT *
    FROM v4_records
    WHERE record_id = ${recordId}
    ORDER BY version DESC
    LIMIT 1
  `;
  return latest ?? null;
}

async function getRecordGroupPayloads(tx: DbClient, recordRowId: string) {
  return tx<V4RecordGroupPayload[]>`
    SELECT *
    FROM v4_record_group_payloads
    WHERE record_row_id = ${recordRowId}
    ORDER BY id ASC
  `;
}

function sortGroupPayloads(payloads: Array<{ group_id?: string | null; group_epoch?: number | null; group_npub: string; ciphertext: string; write?: boolean; can_write?: boolean }>) {
  return payloads
    .map((payload) => ({
      group_id: payload.group_id ?? null,
      group_epoch: payload.group_epoch ?? null,
      group_npub: payload.group_npub,
      ciphertext: payload.ciphertext,
      write: payload.write ?? payload.can_write ?? false,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function areGroupPayloadSetsEquivalent(existing: V4RecordGroupPayload[], incoming?: GroupPayloadInput[]) {
  return JSON.stringify(sortGroupPayloads(existing)) === JSON.stringify(sortGroupPayloads(incoming || []));
}

async function isIdempotentDuplicate(tx: DbClient, latest: V4Record | null, rec: SyncRecordInput) {
  if (!latest) return false;
  if (latest.version !== rec.version) return false;
  if (latest.previous_version !== rec.previous_version) return false;
  if (latest.owner_npub !== rec.owner_npub) return false;
  if (latest.record_family_hash !== rec.record_family_hash) return false;
  if (latest.signature_npub !== rec.signature_npub) return false;
  if (latest.owner_ciphertext !== rec.owner_payload.ciphertext) return false;

  const existingPayloads = await getRecordGroupPayloads(tx, latest.id);
  return areGroupPayloadSetsEquivalent(existingPayloads, rec.group_payloads);
}

async function getCheckoutById(tx: DbClient, checkoutId: string) {
  const [checkout] = await tx<V4RecordCheckout[]>`
    SELECT *
    FROM v4_record_checkouts
    WHERE checkout_id = ${checkoutId}
    LIMIT 1
  `;
  return checkout ?? null;
}

async function getActiveCheckout(tx: DbClient, workspaceServiceNpub: string, recordId: string) {
  await expireStaleCheckouts(tx, workspaceServiceNpub, recordId);
  const [checkout] = await tx<V4RecordCheckout[]>`
    SELECT *
    FROM v4_record_checkouts
    WHERE workspace_service_npub = ${workspaceServiceNpub}
      AND record_id = ${recordId}
      AND state = 'checked_out'
    ORDER BY checked_out_at DESC
    LIMIT 1
  `;
  return checkout ?? null;
}

async function getActiveCheckoutByIdempotencyKey(
  tx: DbClient,
  workspaceServiceNpub: string,
  recordId: string,
  userNpub: string,
  idempotencyKey: string,
) {
  await expireStaleCheckouts(tx, workspaceServiceNpub, recordId);
  const [checkout] = await tx<V4RecordCheckout[]>`
    SELECT *
    FROM v4_record_checkouts
    WHERE workspace_service_npub = ${workspaceServiceNpub}
      AND record_id = ${recordId}
      AND checked_out_by_user_npub = ${userNpub}
      AND idempotency_key = ${idempotencyKey}
      AND state = 'checked_out'
    ORDER BY checked_out_at DESC
    LIMIT 1
  `;
  return checkout ?? null;
}

async function resolveExistingRecordFamily(
  tx: DbClient,
  workspaceServiceNpub: string,
  recordId: string,
  requestedRecordFamilyHash: string,
) {
  const latest = await getLatestRecord(tx, recordId);
  if (latest && latest.owner_npub !== workspaceServiceNpub) {
    throw new RecordCheckoutError(
      'checkout_conflict',
      409,
      'record_id already exists under a different workspace_service_npub',
      {
        record_id: recordId,
        record_family_hash: requestedRecordFamilyHash,
        workspace_service_npub: workspaceServiceNpub,
      },
    );
  }

  if (latest && latest.record_family_hash !== requestedRecordFamilyHash) {
    throw new RecordCheckoutError(
      'checkout_conflict',
      409,
      'record_family_hash is immutable for an existing record_id',
      {
        record_id: recordId,
        record_family_hash: requestedRecordFamilyHash,
        workspace_service_npub: workspaceServiceNpub,
        details: {
          existing_record_family_hash: latest.record_family_hash,
          requested_record_family_hash: requestedRecordFamilyHash,
        },
      },
    );
  }

  return {
    latest,
    effectiveRecordFamilyHash: latest?.record_family_hash ?? requestedRecordFamilyHash,
  };
}

function requireCheckoutManagedFamily(
  workspaceServiceNpub: string,
  recordId: string,
  recordFamilyHash: string,
) {
  if (isCheckoutRequiredRecordFamily(recordFamilyHash)) return;
  throw new RecordCheckoutError(
    'checkout_conflict',
    400,
    'checkout endpoints only support checkout_required record families',
    {
      record_id: recordId,
      record_family_hash: recordFamilyHash,
      workspace_service_npub: workspaceServiceNpub,
    },
  );
}

async function requireCheckoutEditPolicy(
  tx: DbClient,
  workspaceServiceNpub: string,
  userNpub: string,
  recordId: string,
  recordFamilyHash: string,
  workspaceUserKeyNpub?: string | null,
  latest?: V4Record | null,
) {
  if (userNpub === workspaceServiceNpub) return;

  // New checkout-required records have no prior payload to inspect. Sync still
  // enforces group write proof and writable payloads before accepting the write.
  if (!latest) return;

  const [writeAccess] = await tx<{ ok: number }[]>`
    SELECT 1 as ok
    FROM v4_record_group_payloads rgp
    JOIN v4_group_members gm
      ON gm.group_id = rgp.group_id
     AND gm.member_npub = ${userNpub}
    WHERE rgp.record_row_id = ${latest.id}
      AND rgp.can_write = TRUE
    LIMIT 1
  `;
  if (writeAccess?.ok) return;

  throw new RecordCheckoutError(
    'edit_policy_forbidden',
    403,
    'edit policy forbids this actor from checking out this record family',
    {
      record_id: recordId,
      record_family_hash: recordFamilyHash,
      workspace_service_npub: workspaceServiceNpub,
      user_npub: userNpub,
      workspace_user_key_npub: workspaceUserKeyNpub ?? null,
    },
  );
}

async function consumeCheckout(
  tx: DbClient,
  workspaceServiceNpub: string,
  recordId: string,
  checkoutId: string,
) {
  const [updated] = await tx<V4RecordCheckout[]>`
    UPDATE v4_record_checkouts
    SET state = 'checked_in',
        released_at = NOW()
    WHERE checkout_id = ${checkoutId}
      AND workspace_service_npub = ${workspaceServiceNpub}
      AND record_id = ${recordId}
      AND state = 'checked_out'
    RETURNING *
  `;
  if (!updated) {
    throw new RecordCheckoutError(
      'checkout_conflict',
      409,
      'checkout is no longer active for this record',
      {
        record_id: recordId,
        workspace_service_npub: workspaceServiceNpub,
      },
    );
  }
  return updated;
}

function buildCheckoutResponse(
  recordId: string,
  recordFamilyHash: string,
  checkout: RecordCheckoutState,
): RecordCheckoutResponse {
  return {
    record_id: recordId,
    record_family_hash: recordFamilyHash,
    checkout,
  };
}

/**
 * Resolve the write-group reference on a sync record to a canonical group identity.
 * Prefers write_group_id (stable UUID) over write_group_npub (rotating crypto identity).
 * Returns the group's stable group_id, current group_npub, and epoch — or null if unresolvable.
 */
async function resolveWriteGroup(sql: ReturnType<typeof getDb>, rec: SyncRecordInput) {
  const writeGroupId = String(rec.write_group_id || '').trim();
  if (writeGroupId) {
    const [row] = await sql<{ group_id: string; group_npub: string; epoch: number }[]>`
      SELECT g.id AS group_id, ge.group_npub, ge.epoch
      FROM v4_groups g
      JOIN v4_group_epochs ge
        ON ge.group_id = g.id
      WHERE g.id = ${writeGroupId}
      ORDER BY ge.epoch DESC
      LIMIT 1
    `;
    return row ?? null;
  }

  const writeGroupNpub = String(rec.write_group_npub || '').trim();
  if (!writeGroupNpub) return null;

  const [row] = await sql<{ group_id: string; group_npub: string; epoch: number }[]>`
    SELECT g.id AS group_id, ge.group_npub, ge.epoch
    FROM v4_groups g
    JOIN v4_group_epochs ge
      ON ge.group_id = g.id
     AND ge.group_npub = g.group_npub
    WHERE g.group_npub = ${writeGroupNpub}
    LIMIT 1
  `;
  return row ?? null;
}

function recordIncludesWritablePayloadForGroup(
  rec: SyncRecordInput,
  writeGroup: { group_id: string; group_npub: string },
) {
  return (rec.group_payloads || []).some((gp) =>
    gp.write === true
    && (
      String(gp.group_id || '').trim() === writeGroup.group_id
      || String(gp.group_npub || '').trim() === writeGroup.group_npub
    )
  );
}

/**
 * Resolve a group_payload entry to its canonical group identity.
 * resolvePayloadGroup treats group_id as the stable UUID and group_npub as the rotating crypto identity.
 * It maps the client-supplied group_id (stable UUID) or group_npub (rotating crypto identity)
 * to the matching epoch record in v4_group_epochs.
 * Falls back to the raw input values when no epoch row is found.
 */
async function resolvePayloadGroup(sql: ReturnType<typeof getDb>, payload: GroupPayloadInput) {
  const groupId = String(payload.group_id || '').trim();
  if (groupId) {
    const targetEpoch = Number.isInteger(payload.group_epoch) ? payload.group_epoch : null;
    const rows = targetEpoch == null
      ? await sql<{ group_id: string; group_npub: string; epoch: number }[]>`
          SELECT ge.group_id, ge.group_npub, ge.epoch
          FROM v4_group_epochs ge
          WHERE ge.group_id = ${groupId}
          ORDER BY ge.epoch DESC
          LIMIT 1
        `
      : await sql<{ group_id: string; group_npub: string; epoch: number }[]>`
          SELECT ge.group_id, ge.group_npub, ge.epoch
          FROM v4_group_epochs ge
          WHERE ge.group_id = ${groupId}
            AND ge.epoch = ${targetEpoch}
          LIMIT 1
        `;
    return rows[0] ?? {
      group_id: groupId,
      group_npub: String(payload.group_npub || '').trim(),
      epoch: targetEpoch,
    };
  }

  const groupNpub = String(payload.group_npub || '').trim();
  if (!groupNpub) return null;

  const [row] = await sql<{ group_id: string; group_npub: string; epoch: number }[]>`
    SELECT ge.group_id, ge.group_npub, ge.epoch
    FROM v4_group_epochs ge
    WHERE ge.group_npub = ${groupNpub}
    LIMIT 1
  `;

  return row ?? {
      group_id: null,
      group_npub: groupNpub,
      epoch: Number.isInteger(payload.group_epoch) ? payload.group_epoch : null,
    };
}

async function listVisibleMemberNpubsForGroupIds(
  sql: DbClient,
  groupIds: Iterable<string>,
): Promise<string[]> {
  const uniqueGroupIds = [...new Set([...groupIds].map((groupId) => String(groupId || '').trim()).filter(Boolean))];
  if (uniqueGroupIds.length === 0) return [];

  const rows = await sql<{ member_npub: string }[]>`
    SELECT DISTINCT member_npub
    FROM v4_group_members
    WHERE group_id = ANY(${uniqueGroupIds})
  `;
  return rows.map((row) => row.member_npub);
}

async function persistRecordVersion(tx: DbClient, rec: SyncRecordInput) {
  const visibleGroupIds = new Set<string>();
  const [row] = await tx<V4Record[]>`
    INSERT INTO v4_records (
      record_id,
      owner_npub,
      record_family_hash,
      version,
      previous_version,
      signature_npub,
      owner_ciphertext
    )
    VALUES (
      ${rec.record_id},
      ${rec.owner_npub},
      ${rec.record_family_hash},
      ${rec.version},
      ${rec.previous_version},
      ${rec.signature_npub},
      ${rec.owner_payload.ciphertext}
    )
    RETURNING *
  `;

  if (rec.group_payloads && rec.group_payloads.length > 0) {
    for (const gp of rec.group_payloads) {
      const resolvedGroup = await resolvePayloadGroup(tx, gp);
      await tx`
        INSERT INTO v4_record_group_payloads (record_row_id, group_id, group_epoch, group_npub, ciphertext, can_write)
        VALUES (
          ${row.id},
          ${resolvedGroup?.group_id ?? null},
          ${resolvedGroup?.epoch ?? null},
          ${resolvedGroup?.group_npub || gp.group_npub},
          ${gp.ciphertext},
          ${gp.write}
        )
      `;
      if (resolvedGroup?.group_id) {
        visibleGroupIds.add(resolvedGroup.group_id);
      }
    }
  }

  return { row, visibleGroupIds };
}

function buildCheckoutAcquireConflict(
  code: string,
  status: number,
  message: string,
  checkout: V4RecordCheckout,
) {
  throw new RecordCheckoutError(code, status, message, {
    record_id: checkout.record_id,
    record_family_hash: checkout.record_family_hash,
    workspace_service_npub: checkout.workspace_service_npub,
    user_npub: checkout.checked_out_by_user_npub,
    workspace_user_key_npub: checkout.checked_out_by_workspace_user_key_npub,
    checkout: serializeCheckout(checkout),
  });
}

export async function acquireRecordCheckout(input: AcquireRecordCheckoutInput): Promise<RecordCheckoutResponse> {
  const sql = getDb();
  const leaseSeconds = normalizeLeaseSeconds(input.lease_seconds);
  const idempotencyKey = String(input.idempotency_key || '').trim() || null;

  return sql.begin(async (tx) => {
    const { latest, effectiveRecordFamilyHash } = await resolveExistingRecordFamily(
      tx,
      input.workspace_service_npub,
      input.record_id,
      input.record_family_hash,
    );
    requireCheckoutManagedFamily(input.workspace_service_npub, input.record_id, effectiveRecordFamilyHash);
    await requireCheckoutEditPolicy(
      tx,
      input.workspace_service_npub,
      input.user_npub,
      input.record_id,
      effectiveRecordFamilyHash,
      input.workspace_user_key_npub,
      latest,
    );

    if (idempotencyKey) {
      const existingByIdempotencyKey = await getActiveCheckoutByIdempotencyKey(
        tx,
        input.workspace_service_npub,
        input.record_id,
        input.user_npub,
        idempotencyKey,
      );
      if (existingByIdempotencyKey) {
        return buildCheckoutResponse(
          input.record_id,
          existingByIdempotencyKey.record_family_hash,
          serializeCheckout(existingByIdempotencyKey),
        );
      }
    }

    const activeCheckout = await getActiveCheckout(tx, input.workspace_service_npub, input.record_id);
    if (activeCheckout) {
      if (activeCheckout.record_family_hash !== effectiveRecordFamilyHash) {
        buildCheckoutAcquireConflict(
          'checkout_conflict',
          409,
          'record checkout family does not match the existing checkout',
          activeCheckout,
        );
      }
      if (activeCheckout.checked_out_by_user_npub !== input.user_npub) {
        buildCheckoutAcquireConflict(
          'record_checked_out',
          409,
          'record is already checked out by another actor',
          activeCheckout,
        );
      }
      return buildCheckoutResponse(input.record_id, activeCheckout.record_family_hash, serializeCheckout(activeCheckout));
    }

    try {
      const [checkout] = await tx<V4RecordCheckout[]>`
        INSERT INTO v4_record_checkouts (
          workspace_service_npub,
          record_id,
          record_family_hash,
          idempotency_key,
          checked_out_by_user_npub,
          checked_out_by_workspace_user_key_npub,
          lease_expires_at
        )
        VALUES (
          ${input.workspace_service_npub},
          ${input.record_id},
          ${effectiveRecordFamilyHash},
          ${idempotencyKey},
          ${input.user_npub},
          ${input.workspace_user_key_npub ?? null},
          NOW() + (${leaseSeconds} * INTERVAL '1 second')
        )
        RETURNING *
      `;
      return buildCheckoutResponse(input.record_id, checkout.record_family_hash, serializeCheckout(checkout));
    } catch (error) {
      if (!isUniqueViolation(error, 'idx_v4_record_checkouts_active')
        && !isUniqueViolation(error, 'idx_v4_record_checkouts_idempotency')) {
        throw error;
      }
      const checkout = await getActiveCheckout(tx, input.workspace_service_npub, input.record_id);
      if (!checkout) throw error;
      if (checkout.checked_out_by_user_npub !== input.user_npub) {
        buildCheckoutAcquireConflict(
          'record_checked_out',
          409,
          'record is already checked out by another actor',
          checkout,
        );
      }
      return buildCheckoutResponse(input.record_id, checkout.record_family_hash, serializeCheckout(checkout));
    }
  });
}

export async function releaseRecordCheckout(input: ReleaseRecordCheckoutInput): Promise<RecordCheckoutResponse> {
  const sql = getDb();

  return sql.begin(async (tx) => {
    const checkout = await getCheckoutById(tx, input.checkout_id);
    if (!checkout
      || checkout.workspace_service_npub !== input.workspace_service_npub
      || checkout.record_id !== input.record_id
      || checkout.record_family_hash !== input.record_family_hash) {
      throw new RecordCheckoutError('checkout_conflict', 409, 'checkout does not match this record', {
        record_id: input.record_id,
        record_family_hash: input.record_family_hash,
        workspace_service_npub: input.workspace_service_npub,
      });
    }

    await expireStaleCheckouts(tx, input.workspace_service_npub, input.record_id);

    const refreshedCheckout = await getCheckoutById(tx, input.checkout_id);
    if (!refreshedCheckout) {
      throw new RecordCheckoutError('checkout_conflict', 409, 'checkout does not match this record', {
        record_id: input.record_id,
        record_family_hash: input.record_family_hash,
        workspace_service_npub: input.workspace_service_npub,
      });
    }

    if (refreshedCheckout.checked_out_by_user_npub !== input.user_npub) {
      throw new RecordCheckoutError('checkout_not_owner', 403, 'checkout is held by another user', {
        record_id: input.record_id,
        record_family_hash: input.record_family_hash,
        workspace_service_npub: input.workspace_service_npub,
        user_npub: input.user_npub,
        workspace_user_key_npub: input.workspace_user_key_npub ?? null,
        checkout: serializeCheckout(refreshedCheckout, refreshedCheckout.state === 'checked_out' ? 'checked_out' : 'checked_in'),
      });
    }

    if (refreshedCheckout.state !== 'checked_out') {
      return buildCheckoutResponse(input.record_id, input.record_family_hash, serializeCheckout(refreshedCheckout, 'checked_in'));
    }

    const [updated] = await tx<V4RecordCheckout[]>`
      UPDATE v4_record_checkouts
      SET state = 'checked_in',
          released_at = NOW()
      WHERE checkout_id = ${input.checkout_id}
      RETURNING *
    `;

    return buildCheckoutResponse(input.record_id, input.record_family_hash, serializeCheckout(updated, 'checked_in'));
  });
}

export async function renewRecordCheckout(input: RenewRecordCheckoutInput): Promise<RecordCheckoutResponse> {
  const sql = getDb();
  const leaseSeconds = normalizeLeaseSeconds(input.lease_seconds);

  return sql.begin(async (tx) => {
    const checkout = await getCheckoutById(tx, input.checkout_id);
    if (!checkout
      || checkout.workspace_service_npub !== input.workspace_service_npub
      || checkout.record_id !== input.record_id
      || checkout.record_family_hash !== input.record_family_hash) {
      throw new RecordCheckoutError('checkout_conflict', 409, 'checkout does not match this record', {
        record_id: input.record_id,
        record_family_hash: input.record_family_hash,
        workspace_service_npub: input.workspace_service_npub,
      });
    }

    await expireStaleCheckouts(tx, input.workspace_service_npub, input.record_id);

    const refreshedCheckout = await getCheckoutById(tx, input.checkout_id);
    if (!refreshedCheckout) {
      throw new RecordCheckoutError('checkout_conflict', 409, 'checkout does not match this record', {
        record_id: input.record_id,
        record_family_hash: input.record_family_hash,
        workspace_service_npub: input.workspace_service_npub,
      });
    }
    if (refreshedCheckout.checked_out_by_user_npub !== input.user_npub) {
      throw new RecordCheckoutError('checkout_not_owner', 403, 'checkout is held by another user', {
        record_id: input.record_id,
        record_family_hash: input.record_family_hash,
        workspace_service_npub: input.workspace_service_npub,
        user_npub: input.user_npub,
        workspace_user_key_npub: input.workspace_user_key_npub ?? null,
        checkout: serializeCheckout(refreshedCheckout, refreshedCheckout.state === 'checked_out' ? 'checked_out' : 'checked_in'),
      });
    }
    if (refreshedCheckout.state !== 'checked_out') {
      throw new RecordCheckoutError('checkout_conflict', 409, 'checkout is no longer active for this record', {
        record_id: input.record_id,
        record_family_hash: input.record_family_hash,
        workspace_service_npub: input.workspace_service_npub,
        checkout: serializeCheckout(refreshedCheckout, 'checked_in'),
      });
    }

    const [updated] = await tx<V4RecordCheckout[]>`
      UPDATE v4_record_checkouts
      SET lease_expires_at = NOW() + (${leaseSeconds} * INTERVAL '1 second')
      WHERE checkout_id = ${input.checkout_id}
      RETURNING *
    `;

    return buildCheckoutResponse(input.record_id, input.record_family_hash, serializeCheckout(updated));
  });
}

/**
 * Sync records with version-chain enforcement.
 * - New record (version=1, previous_version=0): insert if record_id doesn't exist
 * - Update (version=N, previous_version=N-1): insert only if latest version == previous_version
 * - Reject stale writes where previous_version doesn't match latest
 *
 * @param signerNpub - The NIP-98 signer (may be ws_key_npub or real npub)
 * @param userNpub - The resolved real user identity (same as signerNpub for direct auth)
 */
export async function syncRecords(
  workspaceServiceNpub: string,
  inputs: SyncRecordInput[],
  signerNpub: string,
  userNpub: string,
  authorizedWriteGroups: Set<string> = new Set(),
  workspaceUserKeyNpub?: string,
): Promise<SyncResult> {
  const sql = getDb();
  let created = 0;
  let updated = 0;
  const rejected: SyncRejectedRecord[] = [];
  const warnings: SyncResult['warnings'] = [];

  for (const rec of inputs) {
    const writeGroupId = String(rec.write_group_id || '').trim();
    const writeGroupNpub = String(rec.write_group_npub || '').trim();
    if (writeGroupNpub) {
      warnings.push({
        code: 'legacy_write_group_npub',
        record_id: rec.record_id,
        field: 'write_group_npub',
        write_group_id: writeGroupId || null,
        write_group_npub: writeGroupNpub,
        message: writeGroupId
          ? 'write_group_id is the canonical durable write reference; write_group_npub is legacy compatibility metadata and is ignored as the durable write reference'
          : 'write_group_npub is a legacy compatibility write reference; send write_group_id as the durable group reference',
      });
    }

    const effectiveWorkspaceUserKeyNpub = String(
      rec.workspace_user_key_npub || rec.ws_key_npub || workspaceUserKeyNpub || '',
    ).trim() || null;

    try {
      const mutation = await sql.begin(async (tx) => {
        if (rec.owner_npub !== workspaceServiceNpub) {
          throw new SyncRecordRejectionError(buildSyncRejection({
            error: 'owner_npub must match workspace_service_npub',
            code: 'checkout_conflict',
            status: 409,
            record_id: rec.record_id,
            record_family_hash: rec.record_family_hash,
            workspace_service_npub: workspaceServiceNpub,
            user_npub: userNpub,
            workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
          }));
        }

        if (rec.signature_npub !== signerNpub) {
          throw new SyncRecordRejectionError(buildSyncRejection({
            error: `signature_npub must match authenticated npub (record has ${rec.signature_npub}, signerNpub is ${signerNpub})`,
            code: 'checkout_conflict',
            status: 409,
            record_id: rec.record_id,
            record_family_hash: rec.record_family_hash,
            workspace_service_npub: workspaceServiceNpub,
            user_npub: userNpub,
            workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
          }));
        }

        const latest = await getLatestRecord(tx, rec.record_id);
        if (latest && latest.owner_npub !== workspaceServiceNpub) {
          throw new SyncRecordRejectionError(buildSyncRejection({
            error: 'record_id already exists under a different workspace_service_npub',
            code: 'checkout_conflict',
            status: 409,
            record_id: rec.record_id,
            record_family_hash: rec.record_family_hash,
            workspace_service_npub: workspaceServiceNpub,
            user_npub: userNpub,
            workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
          }));
        }

        if (latest && latest.record_family_hash !== rec.record_family_hash) {
          throw new SyncRecordRejectionError(buildSyncRejection({
            error: 'record_family_hash is immutable for an existing record_id',
            code: 'checkout_conflict',
            status: 409,
            record_id: rec.record_id,
            record_family_hash: rec.record_family_hash,
            workspace_service_npub: workspaceServiceNpub,
            user_npub: userNpub,
            workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
            reason: `record_family_hash mismatch: existing=${latest.record_family_hash}, requested=${rec.record_family_hash}`,
          }));
        }

        const effectiveRecordFamilyHash = latest?.record_family_hash ?? rec.record_family_hash;

        if (await isIdempotentDuplicate(tx, latest, rec)) {
          return {
            state: latest?.previous_version === 0 ? 'created' : 'updated',
            latest,
            row: latest,
            visibleGroupIds: new Set<string>(),
            emitted: false,
          } as const;
        }

        const currentVersion = latest?.version ?? 0;
        const isOwnerWrite = userNpub === workspaceServiceNpub;
        const checkoutPolicy = resolveRecordCheckoutPolicy(effectiveRecordFamilyHash);
        const forceWrite = rec.force_write === true;
        const checkoutId = String(rec.checkout?.checkout_id || '').trim();
        const checkoutRequiredForMutation = checkoutPolicy === 'checkout_required' && currentVersion > 0;
        const shouldValidateCheckout = !forceWrite
          && (checkoutRequiredForMutation || (checkoutPolicy === 'checkout_required' && Boolean(checkoutId)));

        if (shouldValidateCheckout) {
          if (!checkoutId) {
            throw new SyncRecordRejectionError(buildSyncRejection({
              error: 'checkout is required for checkout_required record families',
              code: 'checkout_missing',
              status: 400,
              record_id: rec.record_id,
              record_family_hash: rec.record_family_hash,
              workspace_service_npub: workspaceServiceNpub,
              user_npub: userNpub,
              workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
            }));
          }

          const checkout = await getCheckoutById(tx, checkoutId);
          if (!checkout
            || checkout.workspace_service_npub !== workspaceServiceNpub
            || checkout.record_id !== rec.record_id
            || checkout.record_family_hash !== effectiveRecordFamilyHash) {
            throw new SyncRecordRejectionError(buildSyncRejection({
              error: 'checkout does not match this record',
              code: 'checkout_conflict',
              status: 409,
              record_id: rec.record_id,
              record_family_hash: rec.record_family_hash,
              workspace_service_npub: workspaceServiceNpub,
              user_npub: userNpub,
              workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
            }));
          }

          await expireStaleCheckouts(tx, workspaceServiceNpub, rec.record_id);
          const refreshedCheckout = await getCheckoutById(tx, checkoutId);
          if (!refreshedCheckout || refreshedCheckout.state !== 'checked_out') {
            throw new SyncRecordRejectionError(buildSyncRejection({
              error: 'checkout is no longer active for this record',
              code: 'checkout_conflict',
              status: 409,
              record_id: rec.record_id,
              record_family_hash: rec.record_family_hash,
              workspace_service_npub: workspaceServiceNpub,
              user_npub: userNpub,
              workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
              checkout: refreshedCheckout ? serializeCheckout(refreshedCheckout, 'checked_in') : undefined,
            }));
          }
          if (refreshedCheckout.checked_out_by_user_npub !== userNpub) {
            throw new SyncRecordRejectionError(buildSyncRejection({
              error: 'checkout is held by another user',
              code: 'checkout_not_owner',
              status: 403,
              record_id: rec.record_id,
              record_family_hash: rec.record_family_hash,
              workspace_service_npub: workspaceServiceNpub,
              user_npub: userNpub,
              workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
              checkout: serializeCheckout(refreshedCheckout),
            }));
          }
        }

        if (rec.previous_version !== currentVersion || rec.version !== currentVersion + 1) {
          throw new SyncRecordRejectionError(buildSyncRejection({
            error: `version conflict: expected previous_version=${currentVersion}, got ${rec.previous_version}`,
            code: 'prior_version_mismatch',
            status: 409,
            record_id: rec.record_id,
            record_family_hash: rec.record_family_hash,
            workspace_service_npub: workspaceServiceNpub,
            user_npub: userNpub,
            workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
            tower_latest_version: currentVersion,
            required_previous_version: currentVersion,
            received_previous_version: rec.previous_version,
          }));
        }

        if (!isOwnerWrite) {
          const writeGroup = await resolveWriteGroup(tx, rec);
          if (!writeGroup?.group_id) {
            throw new SyncRecordRejectionError(buildSyncRejection({
              error: `write_group_id or current write_group_npub required for non-owner writes (signerNpub=${signerNpub}, userNpub=${userNpub}, write_group_id=${rec.write_group_id || ''}, write_group_npub=${rec.write_group_npub || ''})`,
              code: 'write_group_forbidden',
              status: 403,
              record_id: rec.record_id,
              record_family_hash: rec.record_family_hash,
              workspace_service_npub: workspaceServiceNpub,
              user_npub: userNpub,
              workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
            }));
          }
          if (!authorizedWriteGroups.has(writeGroup.group_id)) {
            throw new SyncRecordRejectionError(buildSyncRejection({
              error: `missing valid group write proof for ${writeGroup.group_id}`,
              code: 'write_group_forbidden',
              status: 403,
              record_id: rec.record_id,
              record_family_hash: rec.record_family_hash,
              workspace_service_npub: workspaceServiceNpub,
              user_npub: userNpub,
              workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
            }));
          }

          const [membership] = await tx<{ ok: number }[]>`
            SELECT 1 as ok
            FROM v4_group_members gm
            WHERE gm.group_id = ${writeGroup.group_id}
              AND gm.member_npub = ${userNpub}
            LIMIT 1
          `;
          if (!membership?.ok) {
            throw new SyncRecordRejectionError(buildSyncRejection({
              error: `authenticated userNpub ${userNpub} is not a current member of ${writeGroup.group_id}`,
              code: 'write_group_forbidden',
              status: 403,
              record_id: rec.record_id,
              record_family_hash: rec.record_family_hash,
              workspace_service_npub: workspaceServiceNpub,
              user_npub: userNpub,
              workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
            }));
          }

          if (currentVersion === 0) {
            const sharedToGroup = recordIncludesWritablePayloadForGroup(rec, writeGroup);
            if (!sharedToGroup) {
              throw new SyncRecordRejectionError(buildSyncRejection({
                error: `new shared record must include writable payload for ${writeGroup.group_id}`,
                code: 'write_group_forbidden',
                status: 403,
                record_id: rec.record_id,
                record_family_hash: rec.record_family_hash,
                workspace_service_npub: workspaceServiceNpub,
                user_npub: userNpub,
                workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
              }));
            }
          } else if (latest) {
            const [groupAccess] = await tx<{ ok: number }[]>`
              SELECT 1 as ok
              FROM v4_record_group_payloads
              WHERE record_row_id = ${latest.id}
                AND (
                  group_id = ${writeGroup.group_id}
                  OR group_npub = ${writeGroup.group_npub}
                )
                AND can_write = TRUE
              LIMIT 1
            `;
            if (!groupAccess?.ok) {
              const repairPayloadWritesToGroup = forceWrite && recordIncludesWritablePayloadForGroup(rec, writeGroup);
              if (repairPayloadWritesToGroup) {
                warnings.push({
                  code: 'force_write_prior_acl_repair',
                  record_id: rec.record_id,
                  field: 'force_write',
                  write_group_id: writeGroup.group_id,
                  message: 'force_write accepted a current-member write that repairs missing prior-version group write access',
                });
              } else {
                throw new SyncRecordRejectionError(buildSyncRejection({
                  error: `group ${writeGroup.group_id} does not have write access on prior version`,
                  code: 'write_group_forbidden',
                  status: 403,
                  record_id: rec.record_id,
                  record_family_hash: rec.record_family_hash,
                  workspace_service_npub: workspaceServiceNpub,
                  user_npub: userNpub,
                  workspace_user_key_npub: effectiveWorkspaceUserKeyNpub,
                }));
              }
            }
          }
        }

        const persisted = await persistRecordVersion(tx, rec);

        if (!forceWrite && checkoutPolicy === 'checkout_required' && checkoutId && rec.checkout?.consume_on_success !== false) {
          await consumeCheckout(tx, workspaceServiceNpub, rec.record_id, checkoutId);
        }

        return {
          state: currentVersion === 0 ? 'created' : 'updated',
          latest,
          row: persisted.row,
          visibleGroupIds: persisted.visibleGroupIds,
          emitted: true,
        } as const;
      });

      if (mutation.state === 'created') {
        created++;
      } else {
        updated++;
      }

      if (!mutation.emitted || !mutation.row) continue;

      const visibleToUserNpubs = new Set<string>([rec.owner_npub]);
      const visibleMemberNpubs = await listVisibleMemberNpubsForGroupIds(sql, mutation.visibleGroupIds);
      for (const memberNpub of visibleMemberNpubs) {
        visibleToUserNpubs.add(memberNpub);
      }

      // SSE is an advisory wake-up signal only; read visibility is still enforced on pull.
      sseHub.emit(rec.owner_npub, {
        event: 'record-changed',
        data: {
          family_hash: rec.record_family_hash,
          record_id: rec.record_id,
          version: rec.version,
          signature_npub: rec.signature_npub,
          updated_at: mutation.row.updated_at,
          record_state: 'active',
        },
      }, {
        visibleToUserNpubs,
      });
    } catch (error) {
      if (error instanceof SyncRecordRejectionError) {
        rejected.push(error.payload);
        continue;
      }
      throw error;
    }
  }

  return {
    synced: created + updated,
    created,
    updated,
    rejected,
    warnings,
  };
}

/**
 * Fetch the latest version of each record matching the filters.
 * Supports pagination via limit/offset.
 */
export async function fetchRecords(
  input: FetchRecordsInput
): Promise<PaginatedRecordsResult> {
  const sql = getDb();
  const ownerNpub = input.owner_npub;
  const viewerNpub = input.viewer_npub || ownerNpub;
  const recordFamilyHash = input.record_family_hash;
  const since = input.since;
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  const offset = Math.max(input.offset ?? 0, 0);

  let rows: V4Record[];
  let total: number;

  if (since) {
    // Count total visible records
    const [countRow] = await sql<{ count: string }[]>`
      WITH latest_records AS (
        SELECT DISTINCT ON (record_id) *
        FROM v4_records
        WHERE owner_npub = ${ownerNpub}
          AND record_family_hash = ${recordFamilyHash}
          AND updated_at > ${since}
        ORDER BY record_id, version DESC
      )
      SELECT COUNT(*)::text AS count
      FROM latest_records
      WHERE ${viewerNpub} = ${ownerNpub}
      OR EXISTS (
        SELECT 1
        FROM v4_record_group_payloads rgp
        JOIN v4_group_member_keys gmk
          ON gmk.group_id = rgp.group_id
         AND gmk.key_version = rgp.group_epoch
         AND gmk.member_npub = ${viewerNpub}
         AND gmk.revoked_at IS NULL
        WHERE rgp.record_row_id = latest_records.id
      )
    `;
    total = parseInt(countRow.count, 10);

    rows = await sql<V4Record[]>`
      WITH latest_records AS (
        SELECT DISTINCT ON (record_id) *
        FROM v4_records
        WHERE owner_npub = ${ownerNpub}
          AND record_family_hash = ${recordFamilyHash}
          AND updated_at > ${since}
        ORDER BY record_id, version DESC
      )
        SELECT latest_records.*
        FROM latest_records
        WHERE ${viewerNpub} = ${ownerNpub}
        OR EXISTS (
          SELECT 1
          FROM v4_record_group_payloads rgp
          JOIN v4_group_member_keys gmk
            ON gmk.group_id = rgp.group_id
           AND gmk.key_version = rgp.group_epoch
           AND gmk.member_npub = ${viewerNpub}
           AND gmk.revoked_at IS NULL
          WHERE rgp.record_row_id = latest_records.id
        )
      ORDER BY latest_records.updated_at ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    // Count total visible records
    const [countRow] = await sql<{ count: string }[]>`
      WITH latest_records AS (
        SELECT DISTINCT ON (record_id) *
        FROM v4_records
        WHERE owner_npub = ${ownerNpub}
          AND record_family_hash = ${recordFamilyHash}
        ORDER BY record_id, version DESC
      )
      SELECT COUNT(*)::text AS count
      FROM latest_records
      WHERE ${viewerNpub} = ${ownerNpub}
      OR EXISTS (
        SELECT 1
        FROM v4_record_group_payloads rgp
        JOIN v4_group_member_keys gmk
          ON gmk.group_id = rgp.group_id
         AND gmk.key_version = rgp.group_epoch
         AND gmk.member_npub = ${viewerNpub}
         AND gmk.revoked_at IS NULL
        WHERE rgp.record_row_id = latest_records.id
      )
    `;
    total = parseInt(countRow.count, 10);

    rows = await sql<V4Record[]>`
      WITH latest_records AS (
        SELECT DISTINCT ON (record_id) *
        FROM v4_records
        WHERE owner_npub = ${ownerNpub}
          AND record_family_hash = ${recordFamilyHash}
        ORDER BY record_id, version DESC
      )
        SELECT latest_records.*
        FROM latest_records
        WHERE ${viewerNpub} = ${ownerNpub}
        OR EXISTS (
          SELECT 1
          FROM v4_record_group_payloads rgp
          JOIN v4_group_member_keys gmk
            ON gmk.group_id = rgp.group_id
           AND gmk.key_version = rgp.group_epoch
           AND gmk.member_npub = ${viewerNpub}
           AND gmk.revoked_at IS NULL
          WHERE rgp.record_row_id = latest_records.id
        )
      ORDER BY latest_records.updated_at ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  // Batch-fetch group payloads (encrypted delivery blobs, one per group per version).
  const results: RecordResponse[] = [];
  if (rows.length > 0) {
    const rowIds = rows.map((r) => r.id);
    const allPayloads = await sql<V4RecordGroupPayload[]>`
      SELECT * FROM v4_record_group_payloads WHERE record_row_id IN ${sql(rowIds)}
    `;

    // Index group payloads by record_row_id for efficient assembly.
    const payloadsByRowId = new Map<string, V4RecordGroupPayload[]>();
    for (const p of allPayloads) {
      const existing = payloadsByRowId.get(p.record_row_id);
      if (existing) {
        existing.push(p);
      } else {
        payloadsByRowId.set(p.record_row_id, [p]);
      }
    }

    for (const row of rows) {
      const payloads = payloadsByRowId.get(row.id) || [];
      results.push({
        record_id: row.record_id,
        owner_npub: row.owner_npub,
        record_family_hash: row.record_family_hash,
        version: row.version,
        previous_version: row.previous_version,
        signature_npub: row.signature_npub,
        owner_payload: { ciphertext: row.owner_ciphertext },
        group_payloads: payloads.map((p) => ({
          group_id: p.group_id ?? undefined,
          group_epoch: p.group_epoch ?? undefined,
          group_npub: p.group_npub,
          ciphertext: p.ciphertext,
          write: p.can_write,
        })),
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      });
    }
  }

  return {
    records: results,
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  };
}

/**
 * Fetch all versions of a single record, ordered newest-first.
 * Access is granted if the viewer is the owner or has group access to at least one version.
 */
export async function fetchRecordHistory(
  recordId: string,
  ownerNpub: string,
  viewerNpub: string,
): Promise<RecordResponse[]> {
  const sql = getDb();

  // Fetch all versions of this record
  const rows = await sql<V4Record[]>`
    SELECT * FROM v4_records
    WHERE record_id = ${recordId}
      AND owner_npub = ${ownerNpub}
    ORDER BY version DESC
  `;

  if (rows.length === 0) return [];

  // Access check: viewer must be owner or have group access to at least one version
  if (viewerNpub !== ownerNpub) {
    const rowIds = rows.map((r) => r.id);
    const accessCheck = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::text AS cnt
      FROM v4_record_group_payloads rgp
      JOIN v4_group_member_keys gmk
        ON gmk.group_id = rgp.group_id
       AND gmk.key_version = rgp.group_epoch
       AND gmk.member_npub = ${viewerNpub}
       AND gmk.revoked_at IS NULL
      WHERE rgp.record_row_id IN ${sql(rowIds)}
    `;
    if (parseInt(accessCheck[0].cnt, 10) === 0) return [];
  }

  // Batch-fetch group payloads
  const rowIds = rows.map((r) => r.id);
  const allPayloads = await sql<V4RecordGroupPayload[]>`
    SELECT * FROM v4_record_group_payloads WHERE record_row_id IN ${sql(rowIds)}
  `;
  const payloadsByRowId = new Map<string, V4RecordGroupPayload[]>();
  for (const p of allPayloads) {
    const existing = payloadsByRowId.get(p.record_row_id);
    if (existing) existing.push(p);
    else payloadsByRowId.set(p.record_row_id, [p]);
  }

  return rows.map((row) => {
    const payloads = payloadsByRowId.get(row.id) || [];
    return {
      record_id: row.record_id,
      owner_npub: row.owner_npub,
      record_family_hash: row.record_family_hash,
      version: row.version,
      previous_version: row.previous_version,
      signature_npub: row.signature_npub,
      owner_payload: { ciphertext: row.owner_ciphertext },
      group_payloads: payloads.map((p) => ({
        group_id: p.group_id ?? undefined,
        group_epoch: p.group_epoch ?? undefined,
        group_npub: p.group_npub,
        ciphertext: p.ciphertext,
        write: p.can_write,
      })),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  });
}

/**
 * Fetch a per-family summary of latest visible records.
 */
export async function fetchRecordsSummary(
  input: FetchRecordsSummaryInput
): Promise<RecordFamilySummary[]> {
  const sql = getDb();
  const ownerNpub = input.owner_npub;
  const viewerNpub = input.viewer_npub || ownerNpub;
  const recordFamilyHash = input.record_family_hash;
  const since = input.since;

  // Build the base query: latest version per record_id, optionally filtered by family
  // Then apply visibility, then group by family
  interface SummaryRow {
    record_family_hash: string;
    latest_updated_at: Date;
    latest_record_count: string;
  }
  interface SummaryRowWithSince extends SummaryRow {
    count_since: string;
  }

  if (since) {
    const rows = recordFamilyHash
      ? await sql<SummaryRowWithSince[]>`
        WITH latest_records AS (
          SELECT DISTINCT ON (record_id) id, record_family_hash, updated_at
          FROM v4_records
          WHERE owner_npub = ${ownerNpub}
            AND record_family_hash = ${recordFamilyHash}
          ORDER BY record_id, version DESC
        ),
        visible_records AS (
          SELECT lr.*
          FROM latest_records lr
          WHERE ${viewerNpub} = ${ownerNpub}
          OR EXISTS (
            SELECT 1
            FROM v4_record_group_payloads rgp
            JOIN v4_group_member_keys gmk
              ON gmk.group_id = rgp.group_id
             AND gmk.key_version = rgp.group_epoch
             AND gmk.member_npub = ${viewerNpub}
             AND gmk.revoked_at IS NULL
            WHERE rgp.record_row_id = lr.id
          )
        )
        SELECT
          record_family_hash,
          MAX(updated_at) AS latest_updated_at,
          COUNT(*)::text AS latest_record_count,
          COUNT(*) FILTER (WHERE updated_at > ${since})::text AS count_since
        FROM visible_records
        GROUP BY record_family_hash
      `
      : await sql<SummaryRowWithSince[]>`
        WITH latest_records AS (
          SELECT DISTINCT ON (record_id) id, record_family_hash, updated_at
          FROM v4_records
          WHERE owner_npub = ${ownerNpub}
          ORDER BY record_id, version DESC
        ),
        visible_records AS (
          SELECT lr.*
          FROM latest_records lr
          WHERE ${viewerNpub} = ${ownerNpub}
          OR EXISTS (
            SELECT 1
            FROM v4_record_group_payloads rgp
            JOIN v4_group_member_keys gmk
              ON gmk.group_id = rgp.group_id
             AND gmk.key_version = rgp.group_epoch
             AND gmk.member_npub = ${viewerNpub}
             AND gmk.revoked_at IS NULL
            WHERE rgp.record_row_id = lr.id
          )
        )
        SELECT
          record_family_hash,
          MAX(updated_at) AS latest_updated_at,
          COUNT(*)::text AS latest_record_count,
          COUNT(*) FILTER (WHERE updated_at > ${since})::text AS count_since
        FROM visible_records
        GROUP BY record_family_hash
      `;

    return rows.map((r) => ({
      record_family_hash: r.record_family_hash,
      latest_updated_at: r.latest_updated_at instanceof Date ? r.latest_updated_at.toISOString() : String(r.latest_updated_at),
      latest_record_count: parseInt(r.latest_record_count, 10),
      count_since: parseInt(r.count_since, 10),
    }));
  }

  const rows = recordFamilyHash
    ? await sql<SummaryRow[]>`
      WITH latest_records AS (
        SELECT DISTINCT ON (record_id) id, record_family_hash, updated_at
        FROM v4_records
        WHERE owner_npub = ${ownerNpub}
          AND record_family_hash = ${recordFamilyHash}
        ORDER BY record_id, version DESC
      ),
      visible_records AS (
        SELECT lr.*
        FROM latest_records lr
        WHERE ${viewerNpub} = ${ownerNpub}
        OR EXISTS (
          SELECT 1
          FROM v4_record_group_payloads rgp
          JOIN v4_group_member_keys gmk
            ON gmk.group_id = rgp.group_id
           AND gmk.key_version = rgp.group_epoch
           AND gmk.member_npub = ${viewerNpub}
           AND gmk.revoked_at IS NULL
          WHERE rgp.record_row_id = lr.id
        )
      )
      SELECT
        record_family_hash,
        MAX(updated_at) AS latest_updated_at,
        COUNT(*)::text AS latest_record_count
      FROM visible_records
      GROUP BY record_family_hash
    `
    : await sql<SummaryRow[]>`
      WITH latest_records AS (
        SELECT DISTINCT ON (record_id) id, record_family_hash, updated_at
        FROM v4_records
        WHERE owner_npub = ${ownerNpub}
        ORDER BY record_id, version DESC
      ),
      visible_records AS (
        SELECT lr.*
        FROM latest_records lr
        WHERE ${viewerNpub} = ${ownerNpub}
        OR EXISTS (
          SELECT 1
          FROM v4_record_group_payloads rgp
          JOIN v4_group_member_keys gmk
            ON gmk.group_id = rgp.group_id
           AND gmk.key_version = rgp.group_epoch
           AND gmk.member_npub = ${viewerNpub}
           AND gmk.revoked_at IS NULL
          WHERE rgp.record_row_id = lr.id
        )
      )
      SELECT
        record_family_hash,
        MAX(updated_at) AS latest_updated_at,
        COUNT(*)::text AS latest_record_count
      FROM visible_records
      GROUP BY record_family_hash
    `;

  return rows.map((r) => ({
    record_family_hash: r.record_family_hash,
    latest_updated_at: r.latest_updated_at instanceof Date ? r.latest_updated_at.toISOString() : String(r.latest_updated_at),
    latest_record_count: parseInt(r.latest_record_count, 10),
    count_since: null,
  }));
}

/**
 * Lightweight heartbeat check: compare client family cursors against server state.
 * Returns only the families that have updates the client hasn't seen.
 */
export async function heartbeatCheck(
  ownerNpub: string,
  viewerNpub: string,
  familyCursors: Record<string, string | null>,
): Promise<HeartbeatCheckResult> {
  const families = await fetchRecordsSummary({
    owner_npub: ownerNpub,
    viewer_npub: viewerNpub,
  });

  const serverCursors: Record<string, string> = {};
  const staleFamilies: string[] = [];

  for (const family of families) {
    const serverTs = family.latest_updated_at;
    serverCursors[family.record_family_hash] = serverTs;

    const clientTs = familyCursors[family.record_family_hash];
    if (!clientTs || serverTs > clientTs) {
      staleFamilies.push(family.record_family_hash);
    }
  }

  return {
    stale_families: staleFamilies,
    server_cursors: serverCursors,
  };
}
