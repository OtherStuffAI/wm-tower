# SBIP-0006: Delegated Group Writes

- Status: Draft
- Type: Standards Track
- Created: 2026-03-29
- Requires: SBIP-0002, SBIP-0004, SBIP-0005

## Abstract

This document defines how a non-owner actor may write a record on behalf of a
workspace owner using group-scoped write authority.

## Motivation

Shared records need a way for non-owner participants to create or update data
without directly possessing the owner's private identity. The current protocol
uses a second NIP-98 proof signed by the current group identity.

## Specification

### Overview

A delegated write involves two authenticated statements:

1. the top-level request authenticated by the submitting actor
2. a group write proof authenticated by the current write-group identity

The submitting actor and the proof signer are different principals with
different meanings.

### Request Requirements

For a non-owner write:

- the authenticated actor MUST equal `record.signature_npub`
- the actor MUST NOT be the same as `workspace_service_npub`
- the record SHOULD specify canonical `write_group_id`
- current compatibility mode still accepts legacy `write_group_npub` when it
  resolves to the current group identity
- the request MUST include a matching entry in `group_write_tokens`

`workspace_service_npub` is the canonical workspace authority identity.
`owner_npub` remains a compatibility alias at Tower transport boundaries.

### Write-Proof Payload

The current protocol defines the write-proof payload hash over the sync request
body after removing `group_write_tokens`.

Canonical clients SHOULD build that proof body with canonical fields:

```json
{
  "workspace_service_npub": "<workspaceServiceNpub>",
  "records": [ ... ]
}
```

The `group_write_tokens` field is intentionally excluded from that hashed
payload.

During the compatibility window, Tower signs and verifies the exact sync payload
shape sent by the client after excluding `group_write_tokens`. Clients MUST
regenerate proofs whenever the request body changes, including when adding or
removing compatibility aliases.

Servers implementing this protocol MUST NOT include `group_write_tokens` in the
proof hash.

### Group Write Token Map

`group_write_tokens` is a map where:

- key: canonical stable `group_id`, or legacy current `group_npub`
- value: a NIP-98 authorization token

For each token, the server resolves the target group as follows:

1. if the map key looks like a UUID, resolve it as a group ID and use the
   current epoch
2. otherwise resolve it as the group's current `group_npub`

If the proof verifies and the proof signer matches the target group's current
`group_npub`, that group becomes an authorized write group for the request.

### Additional Delegated Write Checks

After proof verification, a non-owner write MUST satisfy all of the following:

- the authenticated actor is a current member of the write group
- the write group has valid proof in `group_write_tokens`

For new records:

- the record MUST include at least one group payload addressed to that group
- that payload MUST have `write = true`

For updates to an existing record:

- the prior version MUST already include a writable group payload for that group

### Scope Of Delegation

Delegated write authority is per request and per group proof.

The current implementation does not define:

- long-lived server-side group write sessions
- reusable server-issued write grants
- delegation beyond the current active group identity

### Failure Cases

A delegated write MUST be rejected if:

- the write group cannot be resolved
- no valid proof exists for the write group
- the authenticated actor is not a current member of the write group
- a new record is not shared back to the write group with `write = true`
- an updated record was not writable by that group on the prior version

### Strict GroupId Mode

Tower supports opt-in strict groupId mode for coordinated SDK and Flight Deck
migration validation. Strict mode can be requested with:

- body field `strict_group_id_writes = true`
- header `x-superbased-strict-group-id-writes: true`
- header `x-superbased-identity-strict` containing `group_id`,
  `write_group_id`, or `strict_group_id_writes`

In strict mode, `write_group_npub` is rejected as a durable write reference with
`code = "legacy_write_group_npub_forbidden"`. `group_payloads[].group_npub`
remains valid crypto epoch metadata when paired with durable `group_id`.

Strict mode currently does not globally reject records that omit
`write_group_id`; existing non-owner write authorization still rejects missing
write authority, while owner/admin/recovery compatibility paths remain
available.

## Security Considerations

- The proof signer is the current group identity, not an individual member.
- Because proofs bind to `{ owner_npub, records }`, clients MUST regenerate the
  proof if the record batch changes.
- Delegated writes depend on current membership for the submitting actor, even
  if the record payload references historical group epochs.

## Backward Compatibility Notes

This SBIP documents the current Tower delegated-write behavior exactly, notably
the canonical proof hash and the use of current `group_npub` as the proof
signer.

`write_group_npub` remains accepted in compatibility mode and returns a sync
warning with `code = "legacy_write_group_npub"`. It MUST NOT be used by new SDK
or app code as a durable write reference.

## Reference Implementation Notes

Reference files:

- `src/routes/records.ts`
- `src/services/records.ts`
- `tests/records.test.ts`
