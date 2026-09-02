# SBIP-0004: Group Lifecycle And Epoch Rotation

- Status: Draft
- Type: Standards Track
- Created: 2026-03-29
- Requires: SBIP-0001, SBIP-0002, SBIP-0003

## Abstract

This document defines group creation, membership, wrapped keys, and epoch
rotation for Superbased V4.

## Motivation

Groups are the shared read/write boundary used by records and storage. The
protocol needs stable group IDs, rotating public identities, and explicit member
key versioning.

## Specification

### Group Identity

A group has:

- a stable UUID `group_id`
- a mutable public identity `group_npub`

The stable UUID is the canonical server-side identifier.
The mutable `group_npub` represents the active epoch identity.

### Group Creation

A create-group request MUST provide:

- `owner_npub`
- `name`
- `group_npub`
- `member_keys`

Each member key entry MUST provide:

- `member_npub`
- `wrapped_group_nsec`
- `wrapped_by_npub`

The member key set:

- MUST be non-empty
- MUST contain unique `member_npub` values
- MUST include a wrapped key for the group creator

For workspace-owned groups, the authenticated workspace manager is treated as
the required creator key holder in the current implementation.

### Initial Epoch

Group creation MUST create epoch `1` and MUST create initial wrapped member keys
with `key_version = 1`.

### Current Membership

`v4_group_members` represents the current active member set.

Adding a member:

- inserts or reuses the membership row
- stores a wrapped key at the current epoch number

Removing a member:

- removes the current membership row
- marks non-revoked wrapped keys for that member as revoked

### Wrapped Member Keys

Wrapped member keys are versioned by `key_version`.

In the current protocol:

- `key_version` aligns with the group epoch number
- multiple wrapped key rows for the same member across epochs are expected
- revoked historical keys are retained for audit and historical access modeling

### Epoch Rotation

Epoch rotation MUST:

1. determine `nextEpoch = currentMaxEpoch + 1`
2. mark the prior active epoch as superseded
3. create a new epoch row with a new `group_npub`
4. replace the current membership set with the supplied member set
5. insert wrapped member keys for the new epoch
6. update the group's current `group_npub`

The new member set is authoritative for current membership.

### Historical Access Semantics

Historical record access MUST be tied to `group_id + epoch`.

This enforces the following behavior:

- members removed via epoch rotation (excluded from `member_keys`) can still
  read records shared to an older epoch if they retain a non-revoked wrapped
  key for that older epoch
- members removed via explicit `removeGroupMember` have all wrapped keys
  revoked and lose access to all epochs
- newly added members receive a wrapped key at the current epoch only and
  MUST NOT automatically gain access to records encrypted to prior epochs
- to grant a new member access to historical content, the owner MUST reauthor
  the record with a new version carrying a `group_payload` at the current epoch
- they do not automatically gain access to records shared only to the new epoch

### Authorization

Only an actor authorized to manage the workspace MAY:

- create workspace-owned groups
- rotate a group epoch
- add or remove group members
- rename or delete a group

### Group Listing

An actor MAY list groups for their own `npub`.

The result SHOULD include:

- owned groups
- groups where the actor is a current member

## Security Considerations

- Implementations MUST distinguish current membership from historical epoch
  possession.
- Rotating a group without redistributing new wrapped keys to all retained
  members creates availability failures.
- A mutable `group_npub` MUST NOT be treated as the permanent identity of a
  group.

## Backward Compatibility Notes

The current protocol still accepts some record payloads addressed only by
`group_npub`. That form is less historically precise than UUID-plus-epoch
addressing.

## Reference Implementation Notes

Reference files:

- `src/routes/groups.ts`
- `src/services/groups.ts`
- `tests/groups.test.ts`
- `tests/records.test.ts`
- `tests/historical-epoch-access.test.ts`
