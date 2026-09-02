# Storage Spec — Current State + Required Changes

This document describes how storage works today across `wingman-tower` and `wingman-fd`, with inline corrections and required changes.

## Summary

Storage has five concepts:

- `owner_npub`: the **workspace npub** that owns the object (billing and path partition)
- `owner_group_id`: optional **`v4_groups(id)` UUID** — when set, the group owns the object (stable, never rotates)
- `created_by_npub`: the member who prepared/uploaded/completed the object
- `access_group_ids`: read ACL, referencing stable `v4_groups(id)` UUIDs (not epoch `group_npub`)
- `is_public`: flag indicating the object is publicly downloadable by anyone with the link

Ownership is **either** workspace-level (`owner_npub` only) **or** group-level (`owner_group_id` set). Group npubs are **never** stored as ownership identifiers — they rotate with epochs and are not stable.

The storage backend does not know app-specific semantics. It stores opaque bytes plus generic metadata.

**All storage objects behave the same way regardless of feature context:**

- `owner_npub` is always a workspace npub (for billing/path partitioning)
- `owner_group_id` is set when a group owns the object (uses stable UUID from `v4_groups.id`)
- Upload to workspace-owned (no `owner_group_id`) → only workspace owner can upload
- Upload to group-owned (`owner_group_id` set) → any member of that group can upload
- `access_group_ids` references one or more group UUIDs for read ACL
- `is_public` is set for objects that need unauthenticated download (e.g., group avatars, website resources)
- Workspace avatars, audio notes, pasted images — all follow the same ownership and access model

## Data Model

The storage table is `v4_storage_objects` in `wingman-tower`.

### Current schema (to be migrated):

- `id UUID PRIMARY KEY`
- `owner_npub TEXT NOT NULL`
- `created_by_npub TEXT NOT NULL`
- `access_group_npubs TEXT[] NOT NULL DEFAULT '{}'` ← **REMOVE: replace with `access_group_ids`**
- `file_name TEXT`
- `content_type TEXT NOT NULL`
- `size_bytes BIGINT NOT NULL DEFAULT 0`
- `sha256_hex TEXT`
- `storage_path TEXT NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `completed_at TIMESTAMPTZ`

### Required schema changes:

- **ADD** `owner_group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL` — nullable. When set, the group (by stable UUID) owns this object. When null, the workspace (`owner_npub`) owns it directly. **Never store a `group_npub` as ownership — it rotates with epochs.**
- **ADD** `access_group_ids UUID[] NOT NULL DEFAULT '{}'` — references `v4_groups(id)` UUIDs, same as records use `group_id`. This aligns storage ACL with the superbased v4 group model.
- **ADD** `is_public BOOLEAN NOT NULL DEFAULT false` — when true, the object is downloadable by anyone with the link (no auth required). Use case: group avatars, website resources, any publicly shared asset.
- **REMOVE** `access_group_npubs` — epoch-level `group_npub` strings should not be stored on storage objects. The stable `group_id` UUID is the correct reference.

Code references:

- `src/schema/001_init.sql`
- `src/types.ts`

Relevant lines:

- `src/schema/001_init.sql:105`
- `src/types.ts:136`

## Physical Storage

Objects are stored in S3-compatible storage through `Bun.S3Client`.

### Updated object key format:

- **Workspace-owned:** `v4/<owner_npub>/<object_id>-<sanitized_file_name>`
- **Group-owned:** `v4/<owner_npub>/<group_uuid>/<object_id>-<sanitized_file_name>`

`owner_npub` is always the workspace npub — keeps all workspace storage co-located for billing. When `owner_group_id` is set, the group UUID is inserted as a path segment, giving logical separation per group within the workspace's S3 prefix.

Code references:

- `src/services/storage.ts:5` (to be updated)
- `src/services/storage.ts:24` (to be updated)

## API Surface

The storage API is mounted at:

- `POST /api/v4/storage/prepare`
- `GET /api/v4/storage/:objectId`
- `PUT /api/v4/storage/:objectId`
- `POST /api/v4/storage/:objectId/complete`
- `GET /api/v4/storage/:objectId/download-url`
- `GET /api/v4/storage/:objectId/content`

Code reference:

- `src/routes/storage.ts:16`

## Prepare Flow

Prepare requires NIP-98 auth.

Request body includes:

- `owner_npub` — **must be a workspace npub**
- `content_type`
- optional `owner_group_id` — `v4_groups(id)` UUID. When set, the group owns the object.
- optional `size_bytes`
- optional `file_name`
- optional `access_group_ids` — array of `v4_groups(id)` UUIDs for read ACL
- optional `is_public` — boolean, marks object as publicly downloadable

On prepare:

1. Tower authenticates the caller as `authNpub`
2. **Tower verifies upload authorization** (see "Who Can Upload" below):
   - If no `owner_group_id` (workspace-owned): `authNpub` must be the workspace owner (`v4_workspaces.creator_npub`)
   - If `owner_group_id` is set (group-owned): `authNpub` must be a member of that group (checked via `v4_group_members` using the stable group UUID)
3. Tower inserts a row with:
   - `owner_npub = request.owner_npub` (workspace npub — always set for billing/path)
   - `owner_group_id = request.owner_group_id` (stable group UUID, or null)
   - `created_by_npub = authNpub`
   - `access_group_ids = request.access_group_ids`
   - `is_public = request.is_public`
4. Tower builds `storage_path` (keyed on `owner_npub`, i.e. workspace — consistent billing partition)
5. Tower returns object metadata plus an upload URL

**CHANGE from current:** Tower now requires `owner_npub` to resolve to a valid workspace. If `owner_group_id` is provided it must be a valid `v4_groups(id)` UUID belonging to that workspace. `authNpub` must be authorized to upload. Unauthorized uploads are rejected.

Code references:

- `src/routes/storage.ts:16`
- `src/services/storage.ts:29`

## Upload Flow

There are two upload paths:

1. Direct presigned upload to the public S3 endpoint
2. Backend-proxied fallback `PUT /api/v4/storage/:objectId`

The fallback backend upload only succeeds when `authNpub === created_by_npub`.

Code references:

- `wingman-fd/src/api.js:271`
- `src/routes/storage.ts:75`
- `src/services/storage.ts:127`

## Complete Flow

`POST /api/v4/storage/:objectId/complete` also requires NIP-98 auth.

Complete only succeeds when both are true:

- the row exists
- `authNpub === created_by_npub`

Then Tower checks that the physical blob exists at `storage_path` using the internal S3 client. If the blob is missing there, complete returns `null`, which the route currently surfaces as a generic `404`.

Complete does not check:

- `owner_npub`
- workspace membership
- group write proofs

Code references:

- `src/routes/storage.ts:97`
- `src/services/storage.ts:103`

## Who Owns A Stored Object

There are two ownership modes. Both use **stable identifiers only** — never epoch-rotating `group_npub` strings.

1. **Workspace-owned**: `owner_npub` is set, `owner_group_id` is null. The workspace owns the object directly.
2. **Group-owned**: `owner_npub` is set (workspace npub, for billing/path), AND `owner_group_id` is set to the `v4_groups(id)` UUID. The group owns the object.

`created_by_npub` is always audit metadata — who physically uploaded it.

### Workspace-owned objects

`owner_group_id` is null. Only the workspace owner (`v4_workspaces.creator_npub`) can upload.

Use case: workspace-level resources where only the owner should be able to create objects.

### Group-owned objects

`owner_group_id` is a `v4_groups(id)` UUID (stable, never rotates). Any member of that group can upload.

Use case: shared resources — group avatars, shared attachments, anything a team collaborates on.

**Why UUID and not group_npub?** `group_npub` rotates on every epoch/key rotation. The `v4_groups.id` UUID is the stable identity of the group. Storing a `group_npub` as an ownership reference would break when the group rotates keys. This is the same reason `access_group_ids` uses UUIDs and not npubs.

### What `created_by_npub` means

`created_by_npub` is the member who prepared the object. It is audit metadata.

It controls:

- backend-proxied upload permission
- complete permission

A member can finish an upload they started, even though the workspace/group owns the object.

### Billing model

All storage bills to the **workspace owner**. The rollup path:

- **Workspace-owned objects**: `owner_npub` → `v4_workspaces.creator_npub` pays
- **Group-owned objects**: `owner_group_id` → `v4_groups(id)` → `v4_groups.owner_npub` (= workspace owner npub) → `v4_workspaces.creator_npub` pays

Groups belong to workspaces via `v4_groups.owner_npub`. So anything uploaded to a group rolls up to the workspace owner for billing. `owner_npub` is always set on every storage object to keep the S3 path partition and billing rollup simple.

## Who Can Upload

Upload authorization has two rules based on ownership mode:

1. **Workspace-owned** (no `owner_group_id`): `authNpub` must match `v4_workspaces.creator_npub` for the workspace identified by `owner_npub`
2. **Group-owned** (`owner_group_id` set): `authNpub` must be a member of that group (checked via `v4_group_members` using `owner_group_id` as `group_id`)

No new permission flags needed. The existing data model already has:

- `v4_workspaces.creator_npub` — identifies workspace owner
- `v4_group_members(group_id, member_npub)` — identifies group membership

Tower resolves at prepare time:
1. Verify `owner_npub` matches a `v4_workspaces.workspace_owner_npub`
2. If `owner_group_id` is provided, verify it's a valid `v4_groups(id)` belonging to that workspace (`v4_groups.owner_npub` = workspace owner npub)
3. If no `owner_group_id`: verify `authNpub === v4_workspaces.creator_npub`
4. If `owner_group_id` set: verify `authNpub` is in `v4_group_members` for that `group_id`
5. Else reject

This replaces the current behavior where Tower does not verify workspace/group membership at all during prepare.

## Who Can Read A Stored Object

Read access is checked in `canAccessStorageObject`.

A caller can read when any of the following is true:

1. **Public object**: `is_public = true` — anyone with the link can download, no auth required
2. **Workspace owner**: `authNpub` is the workspace owner (`creator_npub` of the workspace, or the `owner_npub` itself)
3. **Uploader**: `authNpub === created_by_npub`
4. **Group member**: `authNpub` is a current member of any group whose `id` is listed in `access_group_ids`

### Group-based read check (updated)

- `access_group_ids` contains stable `v4_groups(id)` UUIDs
- Tower checks membership directly in `v4_group_members` by `group_id`
- No epoch resolution needed — the stable group UUID already points to the right group

This is simpler than the current implementation which stores epoch `group_npub` and has to resolve backwards through `v4_group_epochs`. Using `group_id` directly means group key rotation does not affect storage ACL — membership in the logical group is all that matters.

Code reference:

- `src/services/storage.ts:80` (to be updated)

## What Groups Mean For Storage

Storage ACL uses stable group UUIDs from `v4_groups(id)`:

- `access_group_ids: UUID[]` — same `group_id` used throughout superbased v4

This **aligns storage with records**. Records use `group_id` on `v4_record_group_payloads`. Storage now uses `group_id` on `access_group_ids`. The group model is consistent:

- Groups are the access primitive for both records and storage
- Group membership is checked against `v4_group_members.group_id`
- Epoch rotation does not break storage access — the stable UUID persists across rotations
- No epoch resolution indirection needed for storage reads

## What The Frontend Should Upload

**All uploads follow the same ownership rules:**

- `owner_npub` = workspace npub (always, for billing/path)
- `owner_group_id` = `v4_groups(id)` UUID when group-owned (stable, never a `group_npub`)
- `access_group_ids` = one or more group UUIDs for read ACL
- `is_public` = true only for objects that need unauthenticated download

### Workspace avatar

- `owner_npub = workspace npub`
- `owner_group_id = null` (workspace-owned, only owner uploads)
- `access_group_ids = [workspace default group UUID]`
- `is_public = true` (avatars are displayed publicly)

Code references (to be updated):

- `wingman-fd/src/app.js:2784`
- `wingman-fd/src/workspace-group-refs.js:28`

### Workspace settings record

The workspace settings record itself does not use storage ACLs. It uses record group refs for record encryption/write, which are handled separately from storage ACLs.

Code references:

- `wingman-fd/src/app.js:2854`
- `wingman-fd/src/app.js:2935`
- `wingman-fd/src/workspace-group-refs.js:20`

### Audio notes

Audio notes are encrypted client-side before upload, then stored as opaque bytes.

- `owner_npub = workspace npub`
- `owner_group_id = group UUID` (group-owned, any group member can upload)
- `access_group_ids = [that group's UUID]`
- `is_public = false`

Code reference (to be updated):

- `wingman-fd/src/app.js:4284`

### Inline pasted images

- `owner_npub = workspace npub`
- `owner_group_id = group UUID` (group-owned, any group member can upload)
- `access_group_ids = [that group's UUID]`
- `is_public = false` (unless explicitly shared publicly)

Code reference (to be updated):

- `wingman-fd/src/app.js:8459`

## Encryption

Storage itself is generic blob storage. The backend does not encrypt or decrypt object payloads.

Whether a stored object is encrypted depends on the client feature:

- audio notes are encrypted before upload
- workspace avatars are uploaded as plain image bytes
- pasted images are uploaded as plain image bytes unless the caller encrypts them first

So storage encryption is currently client-feature-dependent, not enforced by Tower.

## Download Behavior

Readable callers can fetch:

- metadata: `GET /api/v4/storage/:objectId`
- a presigned download URL: `GET /api/v4/storage/:objectId/download-url`
- bytes directly through Tower: `GET /api/v4/storage/:objectId/content`

`content` also requires:

- the object exists in physical storage
- `completed_at` is set

Code references:

- `src/routes/storage.ts:47`
- `src/routes/storage.ts:120`
- `src/routes/storage.ts:137`

## What Storage Does Not Have Today (and needs)

### Needed now:

- `owner_group_id UUID` for group ownership (stable `v4_groups(id)`, not `group_npub`)
- `is_public` flag and public download path (no auth check)
- `access_group_ids UUID[]` replacing `access_group_npubs TEXT[]`
- Upload authorization checking workspace ownership or group membership
- Migration from `access_group_npubs` → `access_group_ids` (resolve existing epoch npubs to their stable `group_id`)

### Still not present (future):

- a delete API
- an ACL update API
- server-enforced encryption requirements

## Alignment With Records

With these changes, storage and records converge on the same authorization model:

**Records:**

- workspace-owner scoped (`owner_npub` = workspace npub)
- group access via `group_id` UUIDs on `v4_record_group_payloads`
- shared writes through group membership + write proofs

**Storage (updated):**

- always workspace-scoped via `owner_npub` (for billing/path)
- optionally group-owned via `owner_group_id` (`v4_groups(id)` UUID — stable, never `group_npub`)
- group access via `access_group_ids` UUIDs (same `v4_groups(id)`)
- upload authorization: workspace owner for workspace-owned, group member for group-owned
- billing rolls up: `owner_group_id` → `v4_groups.owner_npub` → workspace → workspace owner pays
- `is_public` for unauthenticated download of public assets

The main remaining difference is that records have per-record write proofs (`can_write` on group payloads) while storage upload authorization is checked at prepare time against workspace ownership or group membership. This is appropriate — storage objects are immutable after upload, so write authorization only matters at creation time.

## Migration Notes

To migrate existing data:

1. Add `owner_group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL` column (nullable)
2. Add `access_group_ids UUID[] NOT NULL DEFAULT '{}'` and `is_public BOOLEAN NOT NULL DEFAULT false` columns
3. Backfill `access_group_ids` by resolving each `access_group_npubs` entry through `v4_group_epochs` to get the stable `group_id`
4. Drop `access_group_npubs` column
5. Update `canAccessStorageObject` to check `access_group_ids` directly against `v4_group_members.group_id` (no epoch join needed)
6. Update `prepareStorageObject` to accept `owner_group_id`, `access_group_ids`, and `is_public`
7. Add upload authorization to prepare flow: verify `owner_npub` is a valid workspace, optionally verify `owner_group_id` belongs to that workspace, then check `authNpub` accordingly
8. Add public download path: if `is_public = true`, skip auth on download-url and content endpoints
9. Update S3 path format: workspace-owned → `v4/<owner_npub>/<id>-<file>`, group-owned → `v4/<owner_npub>/<group_uuid>/<id>-<file>`

---

## As Built — 2026-03-21

All migration notes above have been implemented. This section documents what was actually built and where.

### Schema changes

**`src/schema/001_init.sql`** — `v4_storage_objects` table updated:

- Added `owner_group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL` — nullable, set when a group owns the object (stable UUID, never a rotating `group_npub`)
- Added `access_group_ids UUID[] NOT NULL DEFAULT '{}'` — read ACL using stable `v4_groups(id)` UUIDs
- Added `is_public BOOLEAN NOT NULL DEFAULT false` — public download without auth
- Added index `idx_v4_storage_group` on `owner_group_id`
- Old `access_group_npubs TEXT[]` column retained in DB for backward compat during migration; new code writes only to `access_group_ids`

**`src/schema/ensure-runtime-schema.ts`** — Runtime migration adds all three new columns idempotently via `ADD COLUMN IF NOT EXISTS`. Includes backfill query that resolves existing `access_group_npubs` entries through `v4_group_epochs` to populate `access_group_ids`.

### Types

**`src/types.ts`**:

- `V4StorageObject` — added `owner_group_id: string | null`, `access_group_ids: string[]`, `is_public: boolean`
- `PrepareStorageInput` — added `owner_group_id?: string | null`, `access_group_ids?: string[] | null`, `is_public?: boolean`

### Upload authorization

**`src/services/storage.ts`** — new `verifyUploadAuthorization()` function, called during prepare:

1. Resolves `owner_npub` → `v4_workspaces.workspace_owner_npub`. Rejects if no matching workspace.
2. If no `owner_group_id` (workspace-owned): requires `authNpub === v4_workspaces.creator_npub`
3. If `owner_group_id` set (group-owned): verifies group exists, belongs to workspace (`v4_groups.owner_npub === workspace.workspace_owner_npub`), and `authNpub` is in `v4_group_members` for that `group_id`

### Read access

**`src/services/storage.ts`** — `canAccessStorageObject()` rewritten:

1. If `is_public = true` → returns object immediately (no auth needed)
2. If `authNpub` matches `owner_npub` or `created_by_npub` → allowed
3. If `authNpub` matches `v4_workspaces.creator_npub` for the workspace → allowed (workspace owner can always read)
4. If `authNpub` is a member of any group in `access_group_ids` → allowed (direct `v4_group_members` check, no epoch resolution)

### S3 path format

**`src/services/storage.ts`** — `buildStorageKey()` updated:

- Workspace-owned: `v4/<owner_npub>/<object_id>-<filename>`
- Group-owned: `v4/<owner_npub>/<group_uuid>/<object_id>-<filename>`

Date prefix removed from path. Workspace npub always the top-level partition for billing consistency.

### Public access in routes

**`src/routes/storage.ts`** — three endpoints support unauthenticated access for public objects:

- `GET /:objectId` — returns metadata without auth if `is_public`
- `GET /:objectId/download-url` — returns download URL without auth if `is_public`
- `GET /:objectId/content` — returns bytes without auth if `is_public`, with `Cache-Control: public, max-age=3600`

Non-public objects still require NIP-98 auth on all endpoints.

### API response changes

Prepare, metadata, and complete responses now include:

- `owner_group_id` — group UUID or null
- `access_group_ids` — array of group UUIDs
- `is_public` — boolean

Old `access_group_npubs` field removed from responses.

### Error handling

Authorization failures during prepare return HTTP 403 with descriptive error messages:

- `"owner_npub does not match any workspace"` — invalid workspace
- `"only the workspace owner can upload workspace-owned objects"` — non-owner trying workspace upload
- `"group does not belong to this workspace"` — group/workspace mismatch
- `"authenticated npub is not a member of the specified group"` — non-member trying group upload

### Tests

**`tests/storage.test.ts`** — 9 tests, all passing:

1. Workspace owner prepare/upload/complete/fetch (workspace-owned)
2. Non-owner rejected for workspace-owned upload (403)
3. Group member can prepare/upload group-owned object
4. Non-group-member rejected for group-owned upload (403)
5. Group member can read via `access_group_ids`, outsider cannot
6. Public objects accessible without auth (metadata, content, download-url)
7. S3 path includes group UUID for group-owned objects
8. S3 path excludes group UUID for workspace-owned objects
9. Invalid `owner_npub` rejected (403)

### What was NOT changed

- `access_group_npubs` column not dropped from DB yet (kept for backward compat during migration window)
- No delete API added
- No ACL update API added
- Encryption remains client-side, not enforced by Tower
- `complete` and `PUT upload` still check `created_by_npub` only (no change to completion authorization)