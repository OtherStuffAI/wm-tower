import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { DOCUMENT_EDIT_PROTOCOL, type DocumentEditSessionRequest } from '../types';
import {
  resolveFlightDeckPgDocVersionIdentity, snapshotFlightDeckPgDocVersion, flightDeckPgCanonicalDocVersionId,
  createFlightDeckPgDocOutboxEvent, serializeFlightDeckPgEditLease,
  type FlightDeckPgEditLeaseRow, type FlightDeckPgSerializedEditLease,
} from './flightdeck-pg-api';

type DbClient = ReturnType<typeof getDb>;
export type DocumentEditAcquireInput = DocumentEditSessionRequest & {
  workspaceId: string; entityId: string; actorId: string; actorNpub: string; leaseSeconds?: number | null;
};
export type DocumentEditAcquireError = {
  ok: false;
  reason: 'lease_conflict' | 'document_edit_session_required' | 'document_edit_session_superseded' | 'edit_lease_changed' | 'doc_not_found';
  lease?: FlightDeckPgSerializedEditLease;
};

/** All document authority transitions and canonical writes lock this same row first, in one transaction. */
export async function lockDocumentEditAuthority(workspaceId: string, docId: string, sql: DbClient) {
  const rows = await sql`SELECT id FROM flightdeck_pg_docs WHERE workspace_id=${workspaceId} AND id=${docId} AND deleted_at IS NULL FOR UPDATE`;
  return rows.length > 0;
}

/** Renew/release call this inside their transaction before touching the lease row. */
export async function lockDocumentLeaseAuthority(workspaceId: string, leaseId: string, sql: DbClient) {
  const [row] = await sql`SELECT entity_type,entity_id FROM flightdeck_pg_edit_leases WHERE workspace_id=${workspaceId} AND id=${leaseId}`;
  if (row?.entity_type === 'document') await lockDocumentEditAuthority(workspaceId, row.entity_id, sql);
}

/** Caller supplies a transaction. No actor-global identity can stand in for this editor's authority. */
export async function acquireDocumentEditSession(input: DocumentEditAcquireInput, sql: DbClient) {
  const head = await resolveFlightDeckPgDocVersionIdentity({ workspaceId: input.workspaceId, docId: input.entityId, lock: true }, sql);
  if (!head) return { ok: false, reason: 'doc_not_found' } as DocumentEditAcquireError;
  const session = input.editor_session_id || null;
  const protocol = input.document_edit_protocol === DOCUMENT_EDIT_PROTOCOL && Boolean(session);
  if (input.takeover && !protocol) return { ok: false, reason: 'document_edit_session_required' } as DocumentEditAcquireError;
  if (session) {
    const [superseded] = await sql`SELECT id FROM flightdeck_pg_edit_leases
      WHERE workspace_id=${input.workspaceId} AND entity_type='document' AND entity_id=${input.entityId}
        AND holder_actor_id=${input.actorId} AND editor_session_id=${session} AND superseded_at IS NOT NULL LIMIT 1`;
    if (superseded) return { ok: false, reason: 'document_edit_session_superseded' } as DocumentEditAcquireError;
  }
  const [active] = await sql<FlightDeckPgEditLeaseRow[]>`SELECT * FROM flightdeck_pg_edit_leases
    WHERE workspace_id=${input.workspaceId} AND entity_type='document' AND entity_id=${input.entityId}
      AND released_at IS NULL AND superseded_at IS NULL AND expires_at>NOW()
    ORDER BY created_at DESC,id DESC LIMIT 1`;
  if (input.takeover) {
    if (!active || active.id !== input.expected_lease_id) return {
      ok: false, reason: 'edit_lease_changed', ...(active ? { lease: serializeFlightDeckPgEditLease(active) } : {}),
    } as DocumentEditAcquireError;
    if (active.editor_session_id && active.editor_session_id === session) return {ok:false,reason:'edit_lease_changed',lease:serializeFlightDeckPgEditLease(active)} as DocumentEditAcquireError;
    if (active.holder_actor_id !== input.actorId) return {
      ok: false, reason: 'lease_conflict', lease: serializeFlightDeckPgEditLease(active),
    } as DocumentEditAcquireError;
    // A takeover is also a version barrier. Legacy clients can reacquire after expiry but their captured
    // pre-takeover base can only produce a typed recovery, even when the body's hash did not change.
    await sql`UPDATE flightdeck_pg_edit_leases SET released_at=COALESCE(released_at,NOW()),superseded_at=NOW(),updated_at=NOW()
      WHERE workspace_id=${input.workspaceId} AND entity_type='document' AND entity_id=${input.entityId}`;
    const [doc] = await sql`UPDATE flightdeck_pg_docs SET row_version=row_version+1,updated_at=NOW(),updated_by_actor_id=${input.actorId}
      WHERE workspace_id=${input.workspaceId} AND id=${input.entityId} RETURNING *`;
    head.doc = doc as typeof head.doc;
    head.identity = { ...head.identity, row_version: doc!.row_version, version_id: flightDeckPgCanonicalDocVersionId(input.entityId, doc!.row_version) };
    await snapshotFlightDeckPgDocVersion({ doc: head.doc, actorId: input.actorId, operation: 'updated' }, sql);
    await sql`INSERT INTO flightdeck_pg_audit_events(workspace_id,actor_id,action,resource_type,resource_id,metadata)
      VALUES(${input.workspaceId},${input.actorId},'doc.edit.takeover','doc',${input.entityId},
        ${sql.json({authority_barrier:true,prior_head_row_version:head.doc.row_version-1,new_head_row_version:head.doc.row_version,expected_lease_id:active.id})})`;
    await createFlightDeckPgDocOutboxEvent({ workspaceId: input.workspaceId,scopeId: head.doc.scope_id,channelId: head.doc.channel_id,
      actorId: input.actorId,eventType:'flightdeck_pg.doc.updated',entityId: input.entityId,operation:'updated',entityRowVersion:head.doc.row_version,
      payload:{doc_id:input.entityId,storage_object_id:head.doc.storage_object_id,authority_barrier:true,
        body_version:{storage_object_id:head.identity.storage_object_id,sha256_hex:head.identity.body_sha256_hex,size_bytes:head.identity.size_bytes},
        author:{actor_id:input.actorId,actor_npub:input.actorNpub}} },sql);
  } else if (active) {
    // This applies to legacy clients too. Same actor on another device is a distinct editor.
    return { ok: false, reason: 'lease_conflict', lease: serializeFlightDeckPgEditLease(active) } as DocumentEditAcquireError;
  }
  await sql`UPDATE flightdeck_pg_edit_leases SET released_at=NOW(),updated_at=NOW()
    WHERE workspace_id=${input.workspaceId} AND entity_type='document' AND entity_id=${input.entityId}
      AND released_at IS NULL AND expires_at<=NOW()`;
  const token = randomUUID(), ttl = Math.max(30, Math.min(600, Math.floor(input.leaseSeconds || 120)));
  const [lease] = await sql<FlightDeckPgEditLeaseRow[]>`INSERT INTO flightdeck_pg_edit_leases
    (workspace_id,entity_type,entity_id,lease_token_hash,holder_actor_id,holder_actor_npub,editor_session_id,expires_at)
    VALUES(${input.workspaceId},'document',${input.entityId},${createHash('sha256').update(token).digest('hex')},
      ${input.actorId},${input.actorNpub},${protocol ? session : null},NOW()+(${ttl}::integer*INTERVAL '1 second')) RETURNING *`;
  return { ok: true as const, lease: serializeFlightDeckPgEditLease(lease!, {leaseToken:token}),
    ...(protocol ? { document_edit_protocol: DOCUMENT_EDIT_PROTOCOL } : {}), doc: head.doc, canonical_version: head.identity, taken_over: input.takeover === true };
}
