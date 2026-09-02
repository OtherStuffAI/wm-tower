import { getDb } from '../db';

const MB = 1024 * 1024;

type SqlLike = ReturnType<typeof getDb>;

export interface WorkspaceUsageSnapshot {
  workspace_owner_npub: string;
  record_bytes: number;
  object_bytes: number;
  billable_bytes: number;
  billable_mb: string;
  estimated_credits_per_hour: string;
}

function asNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatCredits(value: number): string {
  const normalized = Number.isFinite(value) ? value : 0;
  return normalized.toFixed(6);
}

export function roundedBillableMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / MB);
}

export async function measureWorkspaceUsage(
  workspaceOwnerNpub: string,
  sqlLike: SqlLike = getDb(),
): Promise<WorkspaceUsageSnapshot> {
  const [recordRow] = await sqlLike<{
    owner_record_bytes: string;
    group_payload_bytes: string;
  }[]>`
    SELECT
      COALESCE(SUM(octet_length(owner_ciphertext)), 0)::text AS owner_record_bytes,
      COALESCE((
        SELECT SUM(octet_length(rgp.ciphertext))
        FROM v4_record_group_payloads rgp
        JOIN v4_records r2 ON r2.id = rgp.record_row_id
        WHERE r2.owner_npub = ${workspaceOwnerNpub}
      ), 0)::text AS group_payload_bytes
    FROM v4_records
    WHERE owner_npub = ${workspaceOwnerNpub}
  `;

  const [objectRow] = await sqlLike<{ object_bytes: string }[]>`
    SELECT COALESCE(SUM(size_bytes), 0)::text AS object_bytes
    FROM v4_storage_objects
    WHERE owner_npub = ${workspaceOwnerNpub}
      AND completed_at IS NOT NULL
  `;

  const recordBytes = asNumber(recordRow?.owner_record_bytes) + asNumber(recordRow?.group_payload_bytes);
  const objectBytes = asNumber(objectRow?.object_bytes);
  const billableBytes = recordBytes + objectBytes;
  const mb = roundedBillableMb(billableBytes);

  return {
    workspace_owner_npub: workspaceOwnerNpub,
    record_bytes: recordBytes,
    object_bytes: objectBytes,
    billable_bytes: billableBytes,
    billable_mb: formatCredits(mb),
    estimated_credits_per_hour: formatCredits(mb),
  };
}
