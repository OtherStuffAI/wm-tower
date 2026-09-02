import { getDb } from '../db';
import type {
  V4Group,
  V4GroupEpoch,
  V4GroupMember,
  V4GroupMemberKey,
  CreateGroupInput,
  AddMemberInput,
  RotateGroupEpochInput,
  WrappedGroupKeyEntry,
} from '../types';

export async function createGroup(input: CreateGroupInput, approvedByNpub: string): Promise<{ group: V4Group; members: V4GroupMember[] }> {
  const sql = getDb();

  return sql.begin(async (tx) => {
    const [group] = await tx<V4Group[]>`
      INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind, private_member_npub)
      VALUES (
        ${input.owner_npub},
        ${input.name},
        ${input.group_npub},
        ${input.group_kind || 'shared'},
        ${input.private_member_npub ?? null}
      )
      RETURNING *
    `;

    await tx`
      INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub, created_at)
      VALUES (${group.id}, 1, ${group.group_npub}, ${approvedByNpub}, ${group.created_at})
    `;

    for (const mk of input.member_keys) {
      await tx`
        INSERT INTO v4_group_members (group_id, member_npub)
        VALUES (${group.id}, ${mk.member_npub})
        ON CONFLICT (group_id, member_npub) DO NOTHING
      `;

      await tx`
        INSERT INTO v4_group_member_keys (group_id, member_npub, wrapped_group_nsec, wrapped_by_npub, approved_by_npub, key_version)
        VALUES (${group.id}, ${mk.member_npub}, ${mk.wrapped_group_nsec}, ${mk.wrapped_by_npub}, ${approvedByNpub}, 1)
      `;
    }

    const members = await tx<V4GroupMember[]>`
      SELECT *
      FROM v4_group_members
      WHERE group_id = ${group.id}
      ORDER BY created_at ASC, member_npub ASC
    `;

    return { group, members };
  });
}

export async function addGroupMember(
  groupId: string,
  input: AddMemberInput,
  approvedByNpub: string
): Promise<{ member: V4GroupMember; key: V4GroupMemberKey }> {
  const sql = getDb();

  // Verify group exists
  const group = await getGroupById(groupId);
  if (!group) throw new Error('Group not found');

  // Insert or fetch membership row
  let [member] = await sql<V4GroupMember[]>`
    INSERT INTO v4_group_members (group_id, member_npub)
    VALUES (${groupId}, ${input.member_npub})
    ON CONFLICT (group_id, member_npub) DO NOTHING
    RETURNING *
  `;
  if (!member) {
    [member] = await sql<V4GroupMember[]>`
      SELECT * FROM v4_group_members WHERE group_id = ${groupId} AND member_npub = ${input.member_npub}
    `;
  }

  // New members receive the group's current key version rather than a member-local increment.
  const currentEpoch = await getCurrentGroupEpoch(groupId);
  const keyVersion = currentEpoch?.epoch ?? 1;

  const [key] = await sql<V4GroupMemberKey[]>`
    INSERT INTO v4_group_member_keys (group_id, member_npub, wrapped_group_nsec, wrapped_by_npub, approved_by_npub, key_version)
    VALUES (${groupId}, ${input.member_npub}, ${input.wrapped_group_nsec}, ${input.wrapped_by_npub}, ${approvedByNpub}, ${keyVersion})
    ON CONFLICT (group_id, member_npub, key_version) DO UPDATE
    SET wrapped_group_nsec = EXCLUDED.wrapped_group_nsec,
        wrapped_by_npub = EXCLUDED.wrapped_by_npub,
        approved_by_npub = EXCLUDED.approved_by_npub,
        revoked_at = NULL
    RETURNING *
  `;

  return { member, key };
}

export async function removeGroupMember(groupId: string, memberNpub: string): Promise<boolean> {
  const sql = getDb();

  return sql.begin(async (tx) => {
    const [{ deleted }] = await tx<{ deleted: string | null }[]>`
      DELETE FROM v4_group_members
      WHERE group_id = ${groupId} AND member_npub = ${memberNpub}
      RETURNING id AS deleted
    `;

    if (!deleted) {
      return false;
    }

    await tx`
      UPDATE v4_group_member_keys
      SET revoked_at = NOW()
      WHERE group_id = ${groupId}
        AND member_npub = ${memberNpub}
        AND revoked_at IS NULL
    `;

    return true;
  });
}

export async function rotateGroupEpoch(
  groupId: string,
  input: RotateGroupEpochInput,
  approvedByNpub: string,
): Promise<{ group: V4Group; epoch: V4GroupEpoch; members: V4GroupMember[] }> {
  const sql = getDb();
  const group = await getGroupById(groupId);
  if (!group) throw new Error('Group not found');
  if (!input.group_npub) throw new Error('group_npub required');
  if (!Array.isArray(input.member_keys) || input.member_keys.length === 0) {
    throw new Error('member_keys array required and must not be empty');
  }

  return sql.begin(async (tx) => {
    const [maxEpochRow] = await tx<{ max: number | null }[]>`
      SELECT MAX(epoch) AS max
      FROM v4_group_epochs
      WHERE group_id = ${groupId}
    `;
    const nextEpoch = (maxEpochRow?.max ?? 0) + 1;

    await tx`
      UPDATE v4_group_epochs
      SET superseded_at = NOW()
      WHERE group_id = ${groupId}
        AND epoch = ${nextEpoch - 1}
        AND superseded_at IS NULL
    `;

    const [epoch] = await tx<V4GroupEpoch[]>`
      INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub)
      VALUES (${groupId}, ${nextEpoch}, ${input.group_npub}, ${approvedByNpub})
      RETURNING *
    `;

    const memberNpubs = [...new Set(input.member_keys.map((entry) => entry.member_npub))];
    await tx`
      DELETE FROM v4_group_members
      WHERE group_id = ${groupId}
        AND NOT (member_npub = ANY(${memberNpubs}))
    `;

    for (const memberNpub of memberNpubs) {
      await tx`
        INSERT INTO v4_group_members (group_id, member_npub)
        VALUES (${groupId}, ${memberNpub})
        ON CONFLICT (group_id, member_npub) DO NOTHING
      `;
    }

    for (const mk of input.member_keys) {
      await tx`
        INSERT INTO v4_group_member_keys (group_id, member_npub, wrapped_group_nsec, wrapped_by_npub, approved_by_npub, key_version)
        VALUES (${groupId}, ${mk.member_npub}, ${mk.wrapped_group_nsec}, ${mk.wrapped_by_npub}, ${approvedByNpub}, ${nextEpoch})
      `;
    }

    const [updatedGroup] = await tx<V4Group[]>`
      UPDATE v4_groups
      SET name = ${input.name?.trim() ? input.name.trim() : group.name},
          group_npub = ${input.group_npub}
      WHERE id = ${groupId}
      RETURNING *
    `;

    const members = await tx<V4GroupMember[]>`
      SELECT *
      FROM v4_group_members
      WHERE group_id = ${groupId}
      ORDER BY created_at ASC, member_npub ASC
    `;

    return {
      group: updatedGroup,
      epoch,
      members,
    };
  });
}

export async function getGroupById(groupId: string): Promise<V4Group | null> {
  const sql = getDb();
  const [group] = await sql<V4Group[]>`
    SELECT * FROM v4_groups WHERE id = ${groupId}
  `;
  return group ?? null;
}

export async function getCurrentGroupEpoch(groupId: string): Promise<V4GroupEpoch | null> {
  const sql = getDb();
  const [epoch] = await sql<V4GroupEpoch[]>`
    SELECT *
    FROM v4_group_epochs
    WHERE group_id = ${groupId}
    ORDER BY epoch DESC
    LIMIT 1
  `;
  return epoch ?? null;
}

export async function getGroupByCurrentNpub(groupNpub: string): Promise<V4Group | null> {
  const sql = getDb();
  const [group] = await sql<V4Group[]>`
    SELECT *
    FROM v4_groups
    WHERE group_npub = ${groupNpub}
    LIMIT 1
  `;
  return group ?? null;
}

export async function getGroupEpochByNpub(groupNpub: string): Promise<V4GroupEpoch | null> {
  const sql = getDb();
  const [epoch] = await sql<V4GroupEpoch[]>`
    SELECT *
    FROM v4_group_epochs
    WHERE group_npub = ${groupNpub}
    LIMIT 1
  `;
  return epoch ?? null;
}

export async function listGroupsForNpub(npub: string): Promise<(V4Group & { members: string[]; current_epoch: number })[]> {
  const sql = getDb();

  // Groups owned by this npub OR where this npub is a member
  const groups = await sql<V4Group[]>`
    SELECT DISTINCT g.* FROM v4_groups g
    LEFT JOIN v4_group_members gm ON gm.group_id = g.id
    WHERE g.owner_npub = ${npub} OR gm.member_npub = ${npub}
    ORDER BY g.created_at DESC
  `;

  const result: (V4Group & { members: string[]; current_epoch: number })[] = [];
  for (const g of groups) {
    const members = await sql<{ member_npub: string }[]>`
      SELECT member_npub FROM v4_group_members WHERE group_id = ${g.id}
    `;
    const currentEpoch = await getCurrentGroupEpoch(g.id);
    result.push({ ...g, members: members.map((m) => m.member_npub), current_epoch: currentEpoch?.epoch ?? 1 });
  }

  return result;
}

/**
 * Return the group_ids that {memberNpub} is a current member of.
 * Used by the wrapped-key fetch route to detect "member but no wrapped key"
 * states which must surface as a diagnostic failure rather than a silent
 * empty response.
 */
export async function listGroupMembershipsForMember(memberNpub: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql<{ group_id: string }[]>`
    SELECT group_id
    FROM v4_group_members
    WHERE member_npub = ${memberNpub}
  `;
  return rows.map((r) => r.group_id);
}

export async function listGroupMemberNpubs(groupId: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql<{ member_npub: string }[]>`
    SELECT member_npub
    FROM v4_group_members
    WHERE group_id = ${groupId}
  `;
  return rows.map((row) => row.member_npub);
}

export async function getWrappedKeysForMember(memberNpub: string): Promise<WrappedGroupKeyEntry[]> {
  const sql = getDb();

  const rows = await sql<WrappedGroupKeyEntry[]>`
    SELECT
      gmk.group_id,
      ge.group_npub,
      ge.epoch,
      g.name,
      gmk.member_npub,
      gmk.wrapped_group_nsec,
      gmk.wrapped_by_npub,
      gmk.approved_by_npub,
      gmk.key_version
    FROM v4_group_member_keys gmk
    JOIN v4_groups g ON g.id = gmk.group_id
    LEFT JOIN v4_group_epochs ge
      ON ge.group_id = gmk.group_id
     AND ge.epoch = gmk.key_version
    WHERE gmk.member_npub = ${memberNpub}
      AND gmk.revoked_at IS NULL
    ORDER BY gmk.created_at DESC, gmk.key_version DESC
  `;

  return rows;
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  const sql = getDb();
  const result = await sql<{ id: string }[]>`
    DELETE FROM v4_groups
    WHERE id = ${groupId}
    RETURNING id
  `;
  return result.length > 0;
}

export async function updateGroupName(groupId: string, name: string): Promise<V4Group | null> {
  const sql = getDb();
  const [group] = await sql<V4Group[]>`
    UPDATE v4_groups
    SET name = ${name}
    WHERE id = ${groupId}
    RETURNING *
  `;
  return group ?? null;
}
