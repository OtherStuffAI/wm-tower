# Flight Deck PG Storage Access

Flight Deck PG uses typed metadata links as the access authority for docs, files, audio notes, and message attachments. The linked bytes still live in the existing `v4_storage_objects` table and the existing S3-compatible bucket; clients never receive MinIO credentials or direct Postgres access.

## Model

```text
flightdeck_pg_storage_links
  -> workspace_id / scope_id / channel_id
  -> entity_type: doc | file | audio_note | message
  -> storage_object_id: v4_storage_objects.id
  -> Tower NIP-98 actor auth
  -> Flight Deck PG channel/entity permission check
  -> Tower-mediated storage metadata/content response
```

The chosen model is Tower-mediated typed metadata over the existing object lifecycle:

- `v4_storage_objects` remains the opaque byte store for prepare/upload/complete/content metadata.
- `flightdeck_pg_storage_links` anchors a storage object to one PG workspace, scope, channel, and future doc/file/audio metadata row.
- Read access is granted by entity-specific read permission (`doc.read`, `file.read`, `audio_note.read`) or the existing `channel.read` grant on the linked channel.
- Attach/upload intent is granted by entity-specific write permission (`doc.write`, `file.write`, `audio_note.write`) or the existing `channel.write` grant on the linked channel.
- The linked storage object must belong to the PG workspace owner (`v4_storage_objects.owner_npub = flightdeck_pg_workspaces.workspace_owner_npub`).
- Message create/edit validates every attachment UUID against the authenticated actor and workspace, then reconciles `message` links inside the same database transaction as the message write.
- Generic private storage metadata/content URLs may use an active `message` link only after the normal owner/uploader/group ACL fails, and only while the linked message is active and the actor currently has `channel.read`.
- Unassociated private objects remain owner/uploader/group-readable only. A prepared upload that is never attached does not gain channel visibility.
- PG prepare ignores browser-supplied `owner_group_id` and `access_group_ids`; channel grants and their stable Tower group UUIDs are evaluated from Tower-owned rows at read time.

## Legacy Message Repair

After the runtime schema has been applied, a message author/uploader with `channel.write` can idempotently repair missing links from the message's existing canonical metadata:

```http
POST /api/v4/flightdeck-pg/workspaces/:workspaceId/messages/:messageId/attachments/repair
Authorization: Nostr <NIP-98 event>
Content-Type: application/json

{}
```

Tower revalidates the actor, workspace, message channel, attachment UUIDs, storage ownership, and current permissions. It returns created/retained/tombstoned counts plus an audit event. It never changes `is_public`, `owner_group_id`, or `access_group_ids`.

## Helpers

Shared service helpers live in `src/services/flightdeck-pg-storage-access.ts`:

- `authorizeFlightDeckPgStorageRead`
- `authorizeFlightDeckPgStorageAttach`
- `createFlightDeckPgStorageLink`
- `resolveFlightDeckPgStorageLink`
- `resolveReadableFlightDeckPgStorageObject`
- `validateFlightDeckPgMessageAttachmentObjects`
- `syncFlightDeckPgMessageAttachmentLinks`
- `resolveReadableFlightDeckPgMessageAttachment`

Later docs/files/audio routes should call these helpers instead of reimplementing grant checks.

## Route Contract For Later Tickets

Future typed docs/files/audio routes should keep the established Flight Deck PG envelope convention:

- docs: `{ docs: [...] }`
- files: `{ files: [...] }`
- audio notes: `{ audio_notes: [...] }`

Storage content routes should remain Tower-authenticated, authorize through the linked PG metadata row, and stream or redirect from Tower-owned storage without exposing storage provider credentials.
