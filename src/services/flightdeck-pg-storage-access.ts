import { getDb } from '../db';
import type {
  FlightDeckPgPermission,
  FlightDeckPgStorageEntityType,
  FlightDeckPgStorageLink,
  V4StorageObject,
} from '../types';
import { authorizeFlightDeckPgOperation, type FlightDeckPgAuthorizationDecision, resolveFlightDeckPgWorkspace } from './flightdeck-pg-authorization';
import { resolveFlightDeckPgChannel } from './flightdeck-pg-api';
import { canAccessStorageObject } from './storage';

type DbClient = ReturnType<typeof getDb>;
type DbJsonValue = Parameters<DbClient['json']>[0];

function asDbJson(value: Record<string, unknown>): DbJsonValue {
  return value as DbJsonValue;
}

const entityPermissions: Record<FlightDeckPgStorageEntityType, { read: FlightDeckPgPermission; write: FlightDeckPgPermission }> = {
  doc: { read: 'doc.read', write: 'doc.write' },
  file: { read: 'file.read', write: 'file.write' },
  audio_note: { read: 'audio_note.read', write: 'audio_note.write' },
  message: { read: 'channel.read', write: 'channel.write' },
};

export type FlightDeckPgStorageAccessResult =
  | {
      allowed: true;
      permission: FlightDeckPgPermission;
      decision: Extract<FlightDeckPgAuthorizationDecision, { allowed: true }>;
    }
  | {
      allowed: false;
      permissions: FlightDeckPgPermission[];
      decision: Extract<FlightDeckPgAuthorizationDecision, { allowed: false }>;
    };

export type FlightDeckPgStorageObjectReadResult =
  | {
      ok: true;
      access: Extract<FlightDeckPgStorageAccessResult, { allowed: true }>;
      link: FlightDeckPgStorageLink;
      storageObject: V4StorageObject;
    }
  | {
      ok: false;
      reason: 'storage-link-not-found' | 'storage-object-not-found' | 'storage-object-workspace-mismatch' | 'permission-denied';
      access?: Extract<FlightDeckPgStorageAccessResult, { allowed: false }>;
      link?: FlightDeckPgStorageLink;
    };

async function authorizeWithAnyChannelPermission(
  input: {
    actorNpub: string;
    appNpub: string;
    workspaceId: string;
    channelId: string;
    permissions: FlightDeckPgPermission[];
  },
  sql: DbClient,
): Promise<FlightDeckPgStorageAccessResult> {
  let lastDenied: Extract<FlightDeckPgAuthorizationDecision, { allowed: false }> | null = null;

  for (const permission of input.permissions) {
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: input.actorNpub,
        appNpub: input.appNpub,
        workspaceId: input.workspaceId,
        permission,
        resource: { type: 'channel', channelId: input.channelId },
      },
      sql,
    );
    if (decision.allowed) return { allowed: true, permission, decision };
    lastDenied = decision;
  }

  return {
    allowed: false,
    permissions: input.permissions,
    decision: lastDenied ?? {
      allowed: false,
      reason: 'permission-grant-required',
      category: 'permission-denied',
    },
  };
}

export async function authorizeFlightDeckPgStorageRead(
  input: {
    actorNpub: string;
    appNpub: string;
    workspaceId: string;
    entityType: FlightDeckPgStorageEntityType;
    channelId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgStorageAccessResult> {
  return authorizeWithAnyChannelPermission(
    {
      actorNpub: input.actorNpub,
      appNpub: input.appNpub,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      permissions: [entityPermissions[input.entityType].read, 'channel.read'],
    },
    sql,
  );
}

export async function authorizeFlightDeckPgStorageAttach(
  input: {
    actorNpub: string;
    appNpub: string;
    workspaceId: string;
    entityType: FlightDeckPgStorageEntityType;
    channelId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgStorageAccessResult> {
  return authorizeWithAnyChannelPermission(
    {
      actorNpub: input.actorNpub,
      appNpub: input.appNpub,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      permissions: [entityPermissions[input.entityType].write, 'channel.write'],
    },
    sql,
  );
}

export async function resolveFlightDeckPgStorageLink(
  input: { workspaceId: string; storageObjectId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgStorageLink | null> {
  const [link] = await sql<FlightDeckPgStorageLink[]>`
    SELECT *
    FROM flightdeck_pg_storage_links
    WHERE workspace_id = ${input.workspaceId}
      AND storage_object_id = ${input.storageObjectId}
      AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  return link ?? null;
}

export async function createFlightDeckPgStorageLink(
  input: {
    workspaceId: string;
    channelId: string;
    entityType: FlightDeckPgStorageEntityType;
    storageObjectId: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    createdByActorId?: string | null;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgStorageLink> {
  const workspace = await resolveFlightDeckPgWorkspace(input.workspaceId, sql);
  if (!workspace) throw new Error('flightdeck pg workspace not found');

  const channel = await resolveFlightDeckPgChannel(input.workspaceId, input.channelId, sql);
  if (!channel) throw new Error('flightdeck pg channel not found');

  const [storageObject] = await sql<V4StorageObject[]>`
    SELECT * FROM v4_storage_objects
    WHERE id = ${input.storageObjectId}
    LIMIT 1
  `;
  if (!storageObject) throw new Error('storage object not found');
  if (storageObject.owner_npub !== workspace.workspace_owner_npub) {
    throw new Error('storage object does not belong to this Flight Deck PG workspace owner');
  }

  const [link] = await sql<FlightDeckPgStorageLink[]>`
    INSERT INTO flightdeck_pg_storage_links (
      workspace_id,
      scope_id,
      channel_id,
      entity_type,
      entity_id,
      storage_object_id,
      metadata,
      created_by_actor_id
    )
    VALUES (
      ${input.workspaceId},
      ${channel.scope_id},
      ${channel.id},
      ${input.entityType},
      ${input.entityId ?? null},
      ${input.storageObjectId},
      ${sql.json(asDbJson(input.metadata ?? {}))},
      ${input.createdByActorId ?? null}
    )
    RETURNING *
  `;
  return link;
}

export type FlightDeckPgMessageAttachmentSyncResult = {
  links: FlightDeckPgStorageLink[];
  created: number;
  retained: number;
  tombstoned: number;
};

export async function validateFlightDeckPgMessageAttachmentObjects(
  input: {
    actorNpub: string;
    workspaceId: string;
    storageObjectIds: string[];
    messageId?: string;
  },
  sql: DbClient = getDb(),
): Promise<{ ok: true } | { ok: false; storageObjectId: string; reason: 'not-found-or-not-attachable' | 'workspace-mismatch' | 'already-attached' }> {
  const workspace = await resolveFlightDeckPgWorkspace(input.workspaceId, sql);
  if (!workspace) {
    return { ok: false, storageObjectId: input.storageObjectIds[0] ?? '', reason: 'workspace-mismatch' };
  }

  for (const storageObjectId of input.storageObjectIds) {
    const storageObject = await canAccessStorageObject(storageObjectId, input.actorNpub);
    if (!storageObject) return { ok: false, storageObjectId, reason: 'not-found-or-not-attachable' };
    if (storageObject.owner_npub !== workspace.workspace_owner_npub) {
      return { ok: false, storageObjectId, reason: 'workspace-mismatch' };
    }
    const [activeLink] = await sql<FlightDeckPgStorageLink[]>`
      SELECT * FROM flightdeck_pg_storage_links
      WHERE workspace_id = ${input.workspaceId}
        AND storage_object_id = ${storageObjectId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (activeLink && input.messageId && !(activeLink.entity_type === 'message' && activeLink.entity_id === input.messageId)) {
      return { ok: false, storageObjectId, reason: 'already-attached' };
    }
  }

  return { ok: true };
}

export async function syncFlightDeckPgMessageAttachmentLinks(
  input: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    storageObjectIds: string[];
    createdByActorId: string;
  },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgMessageAttachmentSyncResult> {
  const desiredIds = [...new Set(input.storageObjectIds)];
  const existing = await sql<FlightDeckPgStorageLink[]>`
    SELECT *
    FROM flightdeck_pg_storage_links
    WHERE workspace_id = ${input.workspaceId}
      AND entity_type = 'message'
      AND entity_id = ${input.messageId}
      AND deleted_at IS NULL
    ORDER BY created_at, id
  `;
  const desiredSet = new Set(desiredIds);
  const retained = existing.filter((link) => desiredSet.has(link.storage_object_id));
  const obsolete = existing.filter((link) => !desiredSet.has(link.storage_object_id));

  if (obsolete.length) {
    await sql`
      UPDATE flightdeck_pg_storage_links
      SET deleted_at = NOW()
      WHERE id = ANY(${obsolete.map((link) => link.id)}::uuid[])
        AND deleted_at IS NULL
    `;
  }

  const retainedIds = new Set(retained.map((link) => link.storage_object_id));
  const created: FlightDeckPgStorageLink[] = [];
  for (const storageObjectId of desiredIds) {
    if (retainedIds.has(storageObjectId)) continue;
    const [conflicting] = await sql<FlightDeckPgStorageLink[]>`
      SELECT *
      FROM flightdeck_pg_storage_links
      WHERE workspace_id = ${input.workspaceId}
        AND storage_object_id = ${storageObjectId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (conflicting) throw new Error('storage object is already attached to another active Flight Deck PG entity');
    created.push(await createFlightDeckPgStorageLink({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      entityType: 'message',
      entityId: input.messageId,
      storageObjectId,
      metadata: { attachment_context: 'channel_message' },
      createdByActorId: input.createdByActorId,
    }, sql));
  }

  return {
    links: [...retained, ...created],
    created: created.length,
    retained: retained.length,
    tombstoned: obsolete.length,
  };
}

export async function tombstoneFlightDeckPgStorageLinksForEntity(
  input: { workspaceId: string; entityType: FlightDeckPgStorageEntityType; entityId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgStorageLink[]> {
  return sql<FlightDeckPgStorageLink[]>`
    UPDATE flightdeck_pg_storage_links
    SET deleted_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND entity_type = ${input.entityType}
      AND entity_id = ${input.entityId}
      AND deleted_at IS NULL
    RETURNING *
  `;
}

export async function resolveReadableFlightDeckPgStorageObject(
  input: { actorNpub: string; appNpub: string; workspaceId: string; storageObjectId: string },
  sql: DbClient = getDb(),
): Promise<FlightDeckPgStorageObjectReadResult> {
  const link = await resolveFlightDeckPgStorageLink(
    { workspaceId: input.workspaceId, storageObjectId: input.storageObjectId },
    sql,
  );
  if (!link) return { ok: false, reason: 'storage-link-not-found' };

  const access = await authorizeFlightDeckPgStorageRead(
    {
      actorNpub: input.actorNpub,
      appNpub: input.appNpub,
      workspaceId: input.workspaceId,
      entityType: link.entity_type,
      channelId: link.channel_id,
    },
    sql,
  );
  if (!access.allowed) return { ok: false, reason: 'permission-denied', access, link };

  const workspace = await resolveFlightDeckPgWorkspace(input.workspaceId, sql);
  const [storageObject] = await sql<V4StorageObject[]>`
    SELECT * FROM v4_storage_objects
    WHERE id = ${input.storageObjectId}
    LIMIT 1
  `;
  if (!storageObject) return { ok: false, reason: 'storage-object-not-found', link };
  if (!workspace || storageObject.owner_npub !== workspace.workspace_owner_npub) {
    return { ok: false, reason: 'storage-object-workspace-mismatch', link };
  }

  return { ok: true, access, link, storageObject };
}

export async function resolveReadableFlightDeckPgMessageAttachment(
  input: { actorNpub: string; storageObjectId: string },
  sql: DbClient = getDb(),
): Promise<V4StorageObject | null> {
  const [linked] = await sql<(FlightDeckPgStorageLink & { app_npub: string; workspace_owner_npub: string })[]>`
    SELECT link.*, workspace.app_npub, workspace.workspace_owner_npub
    FROM flightdeck_pg_storage_links link
    JOIN flightdeck_pg_workspaces workspace ON workspace.id = link.workspace_id
    JOIN flightdeck_pg_messages message
      ON message.workspace_id = link.workspace_id
      AND message.id = link.entity_id
      AND message.scope_id = link.scope_id
      AND message.channel_id = link.channel_id
      AND message.deleted_at IS NULL
    WHERE link.storage_object_id = ${input.storageObjectId}
      AND link.entity_type = 'message'
      AND link.deleted_at IS NULL
    LIMIT 1
  `;
  if (!linked) return null;

  const access = await authorizeFlightDeckPgStorageRead({
    actorNpub: input.actorNpub,
    appNpub: linked.app_npub,
    workspaceId: linked.workspace_id,
    entityType: 'message',
    channelId: linked.channel_id,
  }, sql);
  if (!access.allowed) return null;

  const [storageObject] = await sql<V4StorageObject[]>`
    SELECT * FROM v4_storage_objects
    WHERE id = ${input.storageObjectId}
      AND owner_npub = ${linked.workspace_owner_npub}
    LIMIT 1
  `;
  return storageObject ?? null;
}
