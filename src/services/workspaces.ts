import { getDb } from '../db';
import { config } from '../config';
import { generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';
import { resolveWsKeyNpub } from './user-workspace-keys';
import { ensureWorkspaceCreditAccount } from './billing';
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  V4Group,
  V4GroupMember,
  V4Workspace,
  WorkspaceListEntry,
} from '../types';

type ServiceSigner = {
  secret: Uint8Array;
  npub: string;
};

let cachedServiceSigner: ServiceSigner | null = null;

function slugifyWorkspaceName(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'workspace';
}

function normalizeWorkspaceSlug(slug: string | undefined, name: string) {
  if (slug === undefined) return undefined;
  const trimmed = String(slug || '').trim();
  return trimmed ? slugifyWorkspaceName(trimmed) : slugifyWorkspaceName(name);
}

function decodeNsec(value: string) {
  const decoded = nip19.decode(String(value || '').trim());
  if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
    throw new Error('Invalid service nsec');
  }
  return decoded.data;
}

function decodeNpub(value: string) {
  const decoded = nip19.decode(String(value || '').trim());
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    throw new Error(`Invalid npub: ${value}`);
  }
  return decoded.data;
}

function getServiceSigner(): ServiceSigner {
  if (cachedServiceSigner) return cachedServiceSigner;

  const configuredNsec = String(config.service.nsec || '').trim();
  const secret = configuredNsec ? decodeNsec(configuredNsec) : generateSecretKey();
  const pubkeyHex = String(config.service.pubkeyHex || '').trim() || getPublicKey(secret);
  const npub = String(config.service.npub || '').trim() || nip19.npubEncode(pubkeyHex);

  cachedServiceSigner = { secret, npub };
  return cachedServiceSigner;
}

function createGroupIdentity() {
  const secret = generateSecretKey();
  const pubkeyHex = getPublicKey(secret);
  return {
    secret,
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(pubkeyHex),
  };
}

function wrapForRecipient(senderSecret: Uint8Array, recipientNpub: string, plaintext: string) {
  return nip44.encrypt(plaintext, nip44.getConversationKey(senderSecret, decodeNpub(recipientNpub)));
}

async function insertGroup(
  tx: ReturnType<typeof getDb>,
  {
    ownerNpub,
    name,
    groupNpub,
    groupKind,
    privateMemberNpub = null,
    memberKeys,
    approvedByNpub,
  }: {
    ownerNpub: string;
    name: string;
    groupNpub: string;
    groupKind: string;
    privateMemberNpub?: string | null;
    memberKeys: CreateWorkspaceInput['default_group_member_keys'];
    approvedByNpub: string;
  },
): Promise<{ group: V4Group; members: V4GroupMember[] }> {
  const [group] = await tx<V4Group[]>`
    INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind, private_member_npub)
    VALUES (${ownerNpub}, ${name}, ${groupNpub}, ${groupKind}, ${privateMemberNpub})
    RETURNING *
  `;

  await tx`
    INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub, created_at)
    VALUES (${group.id}, 1, ${group.group_npub}, ${approvedByNpub}, ${group.created_at})
  `;

  for (const mk of memberKeys) {
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
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
  creatorNpub: string,
): Promise<{
  workspace: V4Workspace;
  defaultGroup: V4Group;
  defaultGroupMembers: V4GroupMember[];
  adminGroup: V4Group;
  adminGroupMembers: V4GroupMember[];
  privateGroup: V4Group;
  privateGroupMembers: V4GroupMember[];
}> {
  const sql = getDb();

  return sql.begin(async (tx) => {
    const [workspace] = await tx<V4Workspace[]>`
      INSERT INTO v4_workspaces (
        workspace_owner_npub,
        creator_npub,
        name,
        slug,
        description,
        avatar_url,
        wrapped_workspace_nsec,
        wrapped_by_npub
      )
      VALUES (
        ${input.workspace_owner_npub},
        ${creatorNpub},
        ${input.name},
        ${slugifyWorkspaceName(input.name)},
        ${input.description || ''},
        ${null},
        ${input.wrapped_workspace_nsec},
        ${input.wrapped_by_npub}
      )
      RETURNING *
    `;

    const { group: defaultGroup, members: defaultGroupMembers } = await insertGroup(tx, {
      ownerNpub: input.workspace_owner_npub,
      name: input.default_group_name || `${input.name} Shared`,
      groupNpub: input.default_group_npub,
      groupKind: 'workspace_shared',
      memberKeys: input.default_group_member_keys,
      approvedByNpub: creatorNpub,
    });

    const { group: adminGroup, members: adminGroupMembers } = await insertGroup(tx, {
      ownerNpub: input.workspace_owner_npub,
      name: input.admin_group_name || 'Workspace Admins',
      groupNpub: input.admin_group_npub,
      groupKind: 'workspace_admin',
      memberKeys: input.admin_group_member_keys,
      approvedByNpub: creatorNpub,
    });

    const ownerPrivateMember =
      input.private_group_member_keys.find((entry) => entry.member_npub === creatorNpub)?.member_npub
      || creatorNpub;

    const { group: privateGroup, members: privateGroupMembers } = await insertGroup(tx, {
      ownerNpub: input.workspace_owner_npub,
      name: input.private_group_name || 'Private',
      groupNpub: input.private_group_npub,
      groupKind: 'private',
      privateMemberNpub: ownerPrivateMember,
      memberKeys: input.private_group_member_keys,
      approvedByNpub: creatorNpub,
    });

    const [updatedWorkspace] = await tx<V4Workspace[]>`
      UPDATE v4_workspaces
      SET default_group_id = ${defaultGroup.id},
          admin_group_id = ${adminGroup.id},
          updated_at = NOW()
      WHERE id = ${workspace.id}
      RETURNING *
    `;

    await ensureWorkspaceCreditAccount(updatedWorkspace.workspace_owner_npub, tx);

    return {
      workspace: updatedWorkspace,
      defaultGroup,
      defaultGroupMembers,
      adminGroup,
      adminGroupMembers,
      privateGroup,
      privateGroupMembers,
    };
  });
}

async function ensureWorkspaceAdminGroupWithTx(
  tx: ReturnType<typeof getDb>,
  workspace: V4Workspace,
): Promise<V4Workspace> {
  if (workspace.admin_group_id) return workspace;

  const [existingAdminGroup] = await tx<V4Group[]>`
    SELECT *
    FROM v4_groups
    WHERE owner_npub = ${workspace.workspace_owner_npub}
      AND group_kind = 'workspace_admin'
    ORDER BY created_at ASC
    LIMIT 1
  `;

  if (existingAdminGroup) {
    const [updatedWorkspace] = await tx<V4Workspace[]>`
      UPDATE v4_workspaces
      SET admin_group_id = ${existingAdminGroup.id},
          updated_at = NOW()
      WHERE id = ${workspace.id}
      RETURNING *
    `;
    return updatedWorkspace ?? workspace;
  }

  const serviceSigner = getServiceSigner();
  const adminGroupIdentity = createGroupIdentity();
  const adminMemberKeys = [{
    member_npub: workspace.creator_npub,
    wrapped_group_nsec: wrapForRecipient(
      serviceSigner.secret,
      workspace.creator_npub,
      adminGroupIdentity.nsec,
    ),
    wrapped_by_npub: serviceSigner.npub,
  }];

  const { group: adminGroup } = await insertGroup(tx, {
    ownerNpub: workspace.workspace_owner_npub,
    name: 'Workspace Admins',
    groupNpub: adminGroupIdentity.npub,
    groupKind: 'workspace_admin',
    memberKeys: adminMemberKeys,
    approvedByNpub: workspace.creator_npub,
  });

  const [updatedWorkspace] = await tx<V4Workspace[]>`
    UPDATE v4_workspaces
    SET admin_group_id = ${adminGroup.id},
        updated_at = NOW()
    WHERE id = ${workspace.id}
    RETURNING *
  `;

  return updatedWorkspace ?? workspace;
}

export async function ensureWorkspaceAdminGroup(workspaceOwnerNpub: string): Promise<V4Workspace | null> {
  if (!workspaceOwnerNpub) return null;
  const sql = getDb();

  return sql.begin(async (tx) => {
    const [workspace] = await tx<V4Workspace[]>`
      SELECT *
      FROM v4_workspaces
      WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      LIMIT 1
    `;
    if (!workspace) return null;
    return ensureWorkspaceAdminGroupWithTx(tx, workspace);
  });
}

async function ensureWorkspaceSlug(workspaceOwnerNpub: string): Promise<V4Workspace | null> {
  if (!workspaceOwnerNpub) return null;
  const sql = getDb();

  const [workspace] = await sql<V4Workspace[]>`
    SELECT *
    FROM v4_workspaces
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
  `;
  if (!workspace) return null;

  if (String(workspace.slug || '').trim()) return workspace;

  const [updatedWorkspace] = await sql<V4Workspace[]>`
    UPDATE v4_workspaces
    SET slug = ${slugifyWorkspaceName(workspace.name)},
        updated_at = NOW()
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
    RETURNING *
  `;
  return updatedWorkspace ?? workspace;
}

export async function getWorkspaceCreator(workspaceOwnerNpub: string): Promise<string | null> {
  const sql = getDb();
  const [workspace] = await sql<Pick<V4Workspace, 'creator_npub'>[]>`
    SELECT creator_npub
    FROM v4_workspaces
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
  `;
  return workspace?.creator_npub ?? null;
}

export async function canManageWorkspace(workspaceOwnerNpub: string, actorNpub: string): Promise<boolean> {
  if (!workspaceOwnerNpub || !actorNpub) return false;
  // Resolve ws_key_npub → real user_npub if applicable
  const resolvedNpub = await resolveWsKeyNpub(actorNpub) ?? actorNpub;
  if (workspaceOwnerNpub === resolvedNpub) return true;

  const ensuredWorkspace = await ensureWorkspaceAdminGroup(workspaceOwnerNpub);
  if (!ensuredWorkspace) return false;
  if (ensuredWorkspace.creator_npub === resolvedNpub) return true;
  if (!ensuredWorkspace.admin_group_id) return false;

  const sql = getDb();
  const [membership] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM v4_group_members
    WHERE group_id = ${ensuredWorkspace.admin_group_id}
      AND member_npub = ${resolvedNpub}
    LIMIT 1
  `;
  return membership?.ok === 1;
}

export async function canCreateWorkspaceGroup(workspaceOwnerNpub: string, actorNpub: string): Promise<boolean> {
  if (!workspaceOwnerNpub || !actorNpub) return false;
  if (await canManageWorkspace(workspaceOwnerNpub, actorNpub)) return true;

  const resolvedNpub = await resolveWsKeyNpub(actorNpub) ?? actorNpub;
  const sql = getDb();
  const [membership] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM v4_workspaces w
    JOIN v4_groups g
      ON g.owner_npub = w.workspace_owner_npub
    JOIN v4_group_members gm
      ON gm.group_id = g.id
    WHERE w.workspace_owner_npub = ${workspaceOwnerNpub}
      AND gm.member_npub = ${resolvedNpub}
    LIMIT 1
  `;
  return membership?.ok === 1;
}

export async function areWorkspaceGroupMembers(workspaceOwnerNpub: string, memberNpubs: string[]): Promise<boolean> {
  const uniqueMemberNpubs = [...new Set(memberNpubs.filter(Boolean))];
  if (!workspaceOwnerNpub || uniqueMemberNpubs.length === 0) return false;

  const sql = getDb();
  const rows = await sql<{ member_npub: string }[]>`
    SELECT DISTINCT gm.member_npub
    FROM v4_workspaces w
    JOIN v4_groups g
      ON g.owner_npub = w.workspace_owner_npub
    JOIN v4_group_members gm
      ON gm.group_id = g.id
    WHERE w.workspace_owner_npub = ${workspaceOwnerNpub}
      AND gm.member_npub IN ${sql(uniqueMemberNpubs)}
  `;
  return rows.length === uniqueMemberNpubs.length;
}

export async function updateWorkspace(
  workspaceOwnerNpub: string,
  input: UpdateWorkspaceInput,
): Promise<V4Workspace | null> {
  const sql = getDb();
  const [current] = await sql<V4Workspace[]>`
    SELECT *
    FROM v4_workspaces
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
  `;
  if (!current) return null;

  const nextName = input.name ?? current.name;
  const nextSlug = input.slug === undefined
    ? (current.slug || slugifyWorkspaceName(nextName))
    : normalizeWorkspaceSlug(input.slug, nextName);
  const nextDescription = input.description ?? current.description;
  const nextAvatarUrl = input.avatar_url === undefined ? current.avatar_url : input.avatar_url;

  const [updated] = await sql<V4Workspace[]>`
    UPDATE v4_workspaces
    SET name = ${nextName},
        slug = ${nextSlug},
        description = ${nextDescription},
        avatar_url = ${nextAvatarUrl},
        updated_at = NOW()
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
    RETURNING *
  `;

  return updated ?? null;
}

export async function recoverWorkspace(
  workspaceOwnerNpub: string,
  creatorNpub: string,
  name: string,
  wrappedWorkspaceNsec: string,
  wrappedByNpub: string,
): Promise<V4Workspace> {
  const sql = getDb();

  const existing = await sql<V4Workspace[]>`
    SELECT * FROM v4_workspaces WHERE workspace_owner_npub = ${workspaceOwnerNpub}
  `;
  if (existing.length > 0) {
    throw Object.assign(new Error('workspace already exists'), { code: 'ALREADY_EXISTS' });
  }

  const isMember = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM v4_group_members gm
    JOIN v4_groups g ON g.id = gm.group_id
    WHERE g.owner_npub = ${workspaceOwnerNpub}
      AND gm.member_npub = ${creatorNpub}
  `;
  if (!isMember.length || Number(isMember[0].count) === 0) {
    throw Object.assign(new Error('not a member of any group for this workspace owner'), { code: 'NOT_MEMBER' });
  }

  const sharedGroups = await sql<V4Group[]>`
    SELECT * FROM v4_groups
    WHERE owner_npub = ${workspaceOwnerNpub}
      AND group_kind = 'workspace_shared'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  const defaultGroupId = sharedGroups.length > 0 ? sharedGroups[0].id : null;

  const [workspace] = await sql<V4Workspace[]>`
    INSERT INTO v4_workspaces (
      workspace_owner_npub, creator_npub, name, description,
      slug, wrapped_workspace_nsec, wrapped_by_npub, default_group_id
    ) VALUES (
      ${workspaceOwnerNpub}, ${creatorNpub}, ${name}, '',
      ${slugifyWorkspaceName(name)},
      ${wrappedWorkspaceNsec}, ${wrappedByNpub}, ${defaultGroupId}
    )
    RETURNING *
  `;

  await ensureWorkspaceCreditAccount(workspace.workspace_owner_npub);

  return (await ensureWorkspaceAdminGroup(workspaceOwnerNpub)) ?? workspace;
}

export async function listWorkspacesForMember(memberNpub: string, resolveKey = false): Promise<WorkspaceListEntry[]> {
  const sql = getDb();
  // If the caller might be using a ws_key_npub, resolve to real identity
  const effectiveNpub = resolveKey ? (await resolveWsKeyNpub(memberNpub) ?? memberNpub) : memberNpub;

  const queryWorkspaces = () => sql<WorkspaceListEntry[]>`
    SELECT DISTINCT
      w.id AS workspace_id,
      w.workspace_owner_npub,
      w.creator_npub,
      w.name,
      w.slug,
      w.description,
      w.avatar_url,
      w.default_group_id,
      dg.group_npub AS default_group_npub,
      w.admin_group_id,
      ag.group_npub AS admin_group_npub,
      pg.id AS private_group_id,
      pg.group_npub AS private_group_npub,
      CASE WHEN w.creator_npub = ${effectiveNpub} THEN w.wrapped_workspace_nsec ELSE NULL END AS wrapped_workspace_nsec,
      CASE WHEN w.creator_npub = ${effectiveNpub} THEN w.wrapped_by_npub ELSE NULL END AS wrapped_by_npub,
      w.created_at,
      w.updated_at
    FROM v4_workspaces w
    LEFT JOIN v4_groups dg
      ON dg.id = w.default_group_id
    LEFT JOIN v4_groups ag
      ON ag.id = w.admin_group_id
    LEFT JOIN v4_groups pg
      ON pg.owner_npub = w.workspace_owner_npub
     AND pg.group_kind = 'private'
     AND pg.private_member_npub = ${effectiveNpub}
    LEFT JOIN v4_groups g
      ON g.owner_npub = w.workspace_owner_npub
    LEFT JOIN v4_group_members gm
      ON gm.group_id = g.id
    WHERE w.creator_npub = ${effectiveNpub}
       OR gm.member_npub = ${effectiveNpub}
    ORDER BY w.updated_at DESC, w.created_at DESC
  `;

  let workspaces = await queryWorkspaces();
  const missingAdminOwners = [...new Set(
    workspaces
      .filter((workspace) => !workspace.admin_group_id)
      .map((workspace) => workspace.workspace_owner_npub),
  )];
  for (const workspaceOwnerNpub of missingAdminOwners) {
    await ensureWorkspaceAdminGroup(workspaceOwnerNpub);
  }

  const missingSlugOwners = [...new Set(
    workspaces
      .filter((workspace) => !String(workspace.slug || '').trim())
      .map((workspace) => workspace.workspace_owner_npub),
  )];
  for (const workspaceOwnerNpub of missingSlugOwners) {
    await ensureWorkspaceSlug(workspaceOwnerNpub);
  }

  if (missingAdminOwners.length === 0 && missingSlugOwners.length === 0) return workspaces;

  workspaces = await queryWorkspaces();
  return workspaces;
}
