# SBIP-0005: Record Sync And Visibility

- Status: Draft
- Type: Standards Track
- Created: 2026-03-29
- Requires: SBIP-0001, SBIP-0002, SBIP-0004

## Abstract

This document defines append-only record synchronization, latest-version fetch,
history fetch, visibility, family summaries, and heartbeat behavior for
Superbased V4.

## Motivation

Records are the primary encrypted sync unit. Their semantics need to be stable
across owner-only data, shared data, and delegated writes.

## Specification

### Record Chain Model

Each logical record is identified by `record_id`.

Each stored version MUST include:

- `record_id`
- `workspace_service_npub` at the request boundary
- `owner_npub` in current stored records and compatibility payloads
- `record_family_hash`
- `version`
- `previous_version`
- `signature_npub`
- `owner_payload.ciphertext`

A record version MAY include zero or more `group_payloads`.

### Append-Only Version Enforcement

For each submitted record:

- if no prior version exists, `previous_version` MUST be `0` and `version` MUST
  be `1`
- if a prior version exists, `previous_version` MUST equal the latest stored
  version and `version` MUST equal `previous_version + 1`

Stale writes MUST be rejected.

The authenticated signer MUST equal `signature_npub`.

Canonical clients SHOULD send `workspace_service_npub` as the workspace
authority identity. Current Tower compatibility APIs also accept `owner_npub` as
an alias. When both are present they MUST match. Each submitted record's
workspace identity MUST normalize to the same `workspace_service_npub` as the
request.

Canonical delegated-key clients MAY also send:

- `user_npub`
- `viewer_npub`
- `signer_npub`
- `workspace_user_key_npub`

When `workspace_user_key_npub` is present, Tower verifies that the authenticated
signer is that workspace user key and that the key is active for
`user_npub + workspace_service_npub`.

### Owner Payload

Every record version MUST include an owner payload ciphertext.

The current server stores owner ciphertext separately from group payloads. Owner
visibility is determined by `owner_npub`, not by group membership.

### Group Payloads

Each group payload contains:

- `group_npub`
- `ciphertext`
- `write`

It MAY also contain:

- `group_id`
- `group_epoch`

`group_id` is the canonical durable group reference. `group_npub` is crypto
epoch metadata identifying the group key used to encrypt that payload. When
`group_id` or `group_npub` can be resolved by the server, the server SHOULD
persist the resolved group linkage. When they cannot be resolved, the current
implementation still stores the supplied addressing material for compatibility.

### Visibility Rules

For latest-record fetch and family summary:

- the owner sees all latest records for that owner
- a non-owner sees only latest records for which at least one group payload is
  visible to them

For group payload visibility, the current implementation grants access if either
of the following is true:

1. the viewer has a non-revoked wrapped group key matching
   `group_id + group_epoch`
2. the payload has no `group_id` and the viewer is a current member of the
   group resolved by `group_npub`

Implementations SHOULD prefer rule 1 for durable historical behavior.

### Latest Record Fetch

`GET /records` returns the latest visible version per `record_id` for one
`workspace_service_npub` and one `record_family_hash`. `owner_npub` remains
accepted as a compatibility alias.

The endpoint supports:

- `since`
- `limit`
- `offset`

The response includes:

- `audit`
- `records`
- `total`
- `limit`
- `offset`
- `has_more`

### Record History

`GET /records/:record_id/history` returns all versions of a record ordered
newest-first.

The owner may always fetch history.

A non-owner may fetch history only if they have access to at least one version
of the record under the visibility rules above.

The current implementation returns all versions once that gate passes. This is
an important current behavior and SHOULD be treated as part of the draft
protocol unless changed explicitly in a future SBIP.

### Family Summary

`GET /records/summary` returns per-family latest visibility summaries.

Each summary entry contains:

- `record_family_hash`
- `latest_updated_at`
- `latest_record_count`
- `count_since`

If no `since` filter is supplied, `count_since` is `null`.

### Heartbeat

`POST /records/heartbeat` compares client family cursors against the server's
visible family summaries.

The client supplies a map:

- key: `record_family_hash`
- value: latest seen ISO timestamp or `null`

The response contains:

- `audit`
- `stale_families`
- `server_cursors`

A family is stale when:

- the client has no cursor for that family, or
- the server cursor is lexically greater than the client cursor

This relies on ISO timestamp ordering.

### Error And Warning Stability

Tower error responses include an `error` string and may include stable
machine-readable fields:

- `code`
- `status`
- `reason_code`
- `workspace_service_npub`
- `user_npub`
- `signer_npub`
- `workspace_user_key_npub`
- `details`

Current identity-related codes include:

- `identity_alias_mismatch`
- `workspace_key_missing`
- `workspace_key_invalid`
- `workspace_key_revoked`
- `legacy_write_group_npub_forbidden`

Sync responses include a `warnings` array. Compatibility use of
`write_group_npub` as a write reference returns a warning with
`code = "legacy_write_group_npub"`.

## Security Considerations

- The authenticated actor MUST be bound to `signature_npub`.
- Historical visibility is safest when payloads include `group_id + group_epoch`.
- Returning all record versions after one successful history visibility check is
  a deliberate capability and should be reviewed carefully by alternative
  implementations.

## Backward Compatibility Notes

`record_family_hash` remains opaque in the current protocol. This SBIP does not
define naming rules or publication rules for families.

## Reference Implementation Notes

Reference files:

- `src/routes/records.ts`
- `src/services/records.ts`
- `tests/records.test.ts`
