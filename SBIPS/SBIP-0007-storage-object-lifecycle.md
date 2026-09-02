# SBIP-0007: Storage Object Lifecycle

- Status: Draft
- Type: Standards Track
- Created: 2026-03-29
- Requires: SBIP-0001, SBIP-0002, SBIP-0003, SBIP-0004

## Abstract

This document defines metadata creation, upload, completion, and read access
for immutable storage objects in Superbased V4.

## Motivation

Records handle encrypted structured sync. Storage objects handle binary blobs
such as media or attachments. Their lifecycle and authorization model are
different from record writes and should be specified separately.

## Specification

### Object Model

A storage object has metadata stored in the server database and content stored in
the backing blob store.

The object lifecycle is:

1. `prepare`
2. upload content
3. `complete`
4. read metadata or content

### Prepare

A prepare request MUST include:

- `owner_npub`
- `content_type`

It MAY include:

- `owner_group_id`
- `access_group_ids`
- `is_public`
- `size_bytes`
- `file_name`

The server allocates the object row and storage path during prepare.

### Ownership Modes

There are two ownership modes:

- workspace-owned object: `owner_group_id = null`
- group-owned object: `owner_group_id` references a group

### Prepare Authorization

For workspace-owned objects, the current protocol requires:

- the authenticated actor MUST equal the workspace `creator_npub`

For group-owned objects, the current protocol requires:

- the group MUST belong to the workspace identified by `owner_npub`
- the authenticated actor MUST be a current member of that group

### Upload

After prepare, the object content is uploaded either:

- directly to the API with a `PUT` body containing `base64_data`, or
- to a presigned object-store URL when the server exposes one

Only the object's `created_by_npub` may upload content or mark completion in the
current protocol.

### Complete

Completion marks the object as finalized.

A complete request MAY provide:

- `sha256_hex`
- `size_bytes`

The server MUST NOT mark the object complete unless content exists in the
backing store.

### Read Access

Public objects:

- are readable without authentication

Non-public objects are readable by:

- `owner_npub`
- `created_by_npub`
- the workspace `creator_npub`
- any current member of any group listed in `access_group_ids`

The current protocol uses current membership for storage read access. It does
not preserve per-epoch historical read state the way records do.

### Content URLs

The API exposes:

- object metadata
- a stable API `content_url`
- an optional presigned `download_url`

If a deployment has no public object-store endpoint configured, the API
`content_url` remains the portable retrieval path.

### Immutability

This protocol treats storage objects as immutable after completion.

Write authorization therefore matters at creation time and upload time, not as a
long-lived mutable object permission model.

## Security Considerations

- Storage `access_group_ids` are current-membership based, not epoch based.
- Public objects MUST be used intentionally because they bypass auth.
- `created_by_npub` retains strong authority over upload and completion.

## Backward Compatibility Notes

This SBIP documents the current Tower behavior including direct API uploads via
base64 payloads.

## Reference Implementation Notes

Reference files:

- `src/routes/storage.ts`
- `src/services/storage.ts`
- `tests/storage.test.ts`
