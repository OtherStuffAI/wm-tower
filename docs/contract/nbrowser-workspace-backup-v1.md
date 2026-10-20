# NBrowser workspace backup v1

## Decision

NBrowser settings backup is a two-part, workspace-scoped contract:

- encrypted snapshot bytes use the existing private Flight Deck PG workspace storage route;
- the current snapshot pointer and status use a private row in a registered NBrowser application namespace.

The client selects one Flight Deck workspace UUID. Tower derives the corresponding `workspace_owner_npub`; the browser does not supply or infer it for either data-plane operation. Tower stores ciphertext, storage identity/metadata, and the private recovery pointer/status. It never receives plaintext settings or a reusable signing credential.

The workspace-UUID app-row routes are generic for installed workspace apps. They reuse `workspace_app_rows`; no NBrowser table or separate database is added.

## Namespace registration

`NBROWSER_APP_NPUB` is a stable, public application namespace identifier assigned by the NBrowser release and kept constant across devices and Tower installations. It is not the unlocked human identity, a workspace identity, or a secret. Tower does not mint it and this contract does not require NBrowser to possess or embed its private key.

Registration is currently owner-managed. Before backups can be enabled in a workspace, a workspace manager signs this exact request with their human identity:

```http
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps
Authorization: Nostr <fresh exact-URL/method/body NIP-98 event>
Content-Type: application/json

{
  "app_npub": "<NBROWSER_APP_NPUB>",
  "app_name": "NBrowser",
  "enabled": true,
  "capabilities": ["storage.private", "app_rows.private_only"]
}
```

This control-plane limitation is intentional: an ordinary member cannot silently install or re-enable an application namespace. `app_rows.private_only` makes Tower reject any attempt to create or promote a row in this namespace with `group` or `workspace` visibility, including through the older owner-addressed app-row routes. WMAPP must ship one release-assigned `NBROWSER_APP_NPUB`; it must not generate one per device, reuse the human identity, or manufacture a private key. If the namespace is absent or disabled, the data-plane row routes return `404 app_not_found` and the client must tell the user that a workspace manager must enable NBrowser backup.

## Consumer flow

Every Tower API call below uses a newly created NIP-98 event for the exact URL, HTTP method, and serialized body, signed by NBrowser's currently unlocked human identity.

1. Let the user select one workspace from authenticated NStack workspace discovery. Retain its opaque `workspace_id` and returned `workspace_owner_npub` only as a consistency check; never substitute the first discovered workspace.
2. Prepare ciphertext storage:

   ```http
   POST /api/v4/flightdeck-pg/workspaces/{workspaceId}/storage/prepare

   {
     "content_type": "application/vnd.wingman.nbrowser-settings+json",
     "size_bytes": 1234,
     "file_name": "nbrowser-settings.nip44",
     "is_public": false,
     "metadata": {
       "purpose": "nbrowser/settings-backup",
       "schema_version": 1
     }
   }
   ```

   Do not send `owner_npub`, `owner_group_id`, or `access_group_ids`. Tower derives the selected workspace owner and forces the object to private, unassociated storage. Even if those fields are sent, the workspace route ignores them.
3. Upload through the authenticated Tower fallback `PUT /api/v4/storage/{objectId}` with `{ "base64_data": "..." }`, then complete with `POST /api/v4/storage/{objectId}/complete` and `{ "sha256_hex": "...", "size_bytes": 1234 }`. Completion re-hashes stored bytes and only the creator may complete. A hash mismatch is `409`.
4. Create or update the pointer at:

   ```text
   /api/v4/flightdeck-pg/workspaces/{workspaceId}/apps/{NBROWSER_APP_NPUB}/db/settings-backups/rows/current-v1
   ```

   Create uses `POST` on the parent `/rows` collection:

   ```json
   {
     "row_id": "current-v1",
     "visibility": "private",
     "data": {
       "schema_version": 1,
       "workspace_id": "<selected workspace UUID>",
       "object_id": "<completed storage object UUID>",
       "sha256_hex": "<verified lowercase SHA-256>",
       "status": "complete",
       "updated_at": "<RFC 3339 timestamp>"
     }
   }
   ```

   A first create returns `201`; `409 row_conflict` means the caller should read the existing private row and `PATCH` it. The authenticated human is always the row owner. Supplying another `owner_npub` fails with `403 owner_forbidden`.
5. Recovery reads that exact row, verifies `workspace_id` equals the selected workspace, fetches `/api/v4/storage/{objectId}` and `/content`, verifies the completed hash, then decrypts locally. Any mismatch, missing membership, missing/disabled namespace, invisible row, unavailable object, or wrong hash fails closed.

The response envelope includes both `workspace_id` and Tower-derived `workspace_owner_npub`. WMAPP must compare these with the selected discovery descriptor and stop on disagreement.

## Privacy and authorization

- Flight Deck PG membership is checked from the selected workspace UUID before app-row or storage preparation work.
- The generic app-row service also requires current legacy workspace membership and a registered, enabled namespace. This deliberately fails closed while the two workspace registries coexist.
- `visibility: private` rows are visible and writable only by their authenticated `owner_npub`. Other ordinary workspace members receive an empty list or `404` for the row.
- Private storage preserves existing Tower ACLs: the uploader and workspace creator can read ciphertext; ordinary members cannot unless a separate authoritative record association grants access. NBrowser never stores plaintext in Tower, so a workspace administrator who can inspect ciphertext still cannot decrypt it without the user's key.
- Removing Flight Deck membership immediately denies the workspace-UUID routes. Disabling the namespace immediately denies row access. Stored rows and objects are retained for normal workspace lifecycle/recovery policy; denial does not silently re-scope them.

## Why not physical WApp DB tables

Routes under `/db/tables/{table}` require a request signed by the registered app npub so the app can provision schemas and run migrations. A native browser acting for a human cannot safely satisfy that requirement without embedding an app private key or introducing a reusable credential. `workspace_app_rows` is the intended fit: it is schema-light, registered-app scoped, human-signed, workspace-bound, and already implements private per-user visibility.

## Legacy failure

`POST /api/v4/storage/prepare` treats `owner_npub` as a legacy workspace owner identity. Sending the unlocked human identity therefore returns `403` unless that identity is also the creator of a matching legacy workspace. NBrowser must not use that route for workspace backup. The selected-workspace prepare route authority-writes the correct workspace owner instead.
