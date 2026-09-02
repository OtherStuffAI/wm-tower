# SBIP-0003: Workspace Bootstrap And Authority

- Status: Draft
- Type: Standards Track
- Created: 2026-03-29
- Requires: SBIP-0001, SBIP-0002

## Abstract

This document defines workspace creation, recovery, listing, and management
authority for Superbased V4.

## Motivation

The workspace is the root sharing domain for the current protocol. The
bootstrap rules determine who can manage shared groups, records, and storage.

## Specification

### Workspace Creation

A workspace creation request MUST provide:

- `workspace_owner_npub`
- `name`
- `wrapped_workspace_nsec`
- `wrapped_by_npub`
- `default_group_npub`
- `private_group_npub`
- `default_group_member_keys`
- `private_group_member_keys`

The authenticated actor MUST equal `wrapped_by_npub`.

The server MUST create, in one logical operation:

1. the workspace row
2. a default shared group
3. a private group
4. epoch `1` for both groups
5. the initial wrapped member keys for both groups

The current implementation stores the default shared group in
`workspace.default_group_id`.

### Initial Group Requirements

Both initial member-key arrays:

- MUST be present
- MUST be non-empty
- MUST contain unique `member_npub` values
- MUST include the authenticated creator

The default group SHOULD use a `workspace_shared` kind.
The private group SHOULD use a `private` kind.

### Authority Model

The current protocol distinguishes:

- `workspace_owner_npub`: the stable workspace owner identity
- `creator_npub`: the actor that created the workspace on the server
- `service_npub`: the service identity of the hosting HTTPS server

A server implementing the current Tower semantics MUST consider a principal
authorized to manage the workspace if:

- the principal equals `workspace_owner_npub`, or
- the principal equals `creator_npub`

This is the current `canManageWorkspace` rule.

`service_npub` does not grant management authority by itself. It identifies the
service context in which the workspace is being served and is primarily used by
clients for trusted connection bootstrap and workspace disambiguation.

### Workspace Listing

An authenticated actor MAY list workspaces for their own `member_npub`.

The requested `member_npub` MUST match the authenticated `npub`.

A workspace is visible if the actor is a current member of any group owned by
that workspace owner.

### Wrapped Workspace Secret Visibility

In the current Tower implementation, `wrapped_workspace_nsec` and
`wrapped_by_npub` are returned only when the listing actor equals
`creator_npub`.

Servers SHOULD treat the wrapped workspace secret as sensitive and MUST NOT
return it broadly without an explicit rule.

### Workspace Recovery

Workspace recovery allows a member to create the workspace row after the group
structure already exists.

A recovery request MUST provide:

- `workspace_owner_npub`
- `name`
- `wrapped_workspace_nsec`
- `wrapped_by_npub`

Recovery MUST fail if:

- a workspace row for that `workspace_owner_npub` already exists
- the authenticated actor is not a current member of at least one group owned by
  that workspace owner

When recovering, the server SHOULD attach the earliest `workspace_shared` group
as `default_group_id` when one exists.

### Workspace Update

An authorized manager MAY update:

- `name`
- `description`
- `avatar_url`

At least one of those fields MUST be present.

An empty name MUST be rejected.

## Security Considerations

- Implementations SHOULD be explicit about whether creator authority is intended
  to be permanent or transitional.
- Recovery is powerful and MUST require authenticated membership evidence.
- Wrapped workspace secrets MUST be treated as encrypted confidential material.
- Clients SHOULD bind a recovered or listed workspace to the hosting
  `service_npub` when that identity is available.
- Clients MUST NOT use `direct_https_url` alone as proof that two workspace
  connections refer to the same hosting service.

## Backward Compatibility Notes

This SBIP matches current Tower behavior, including the creator-manager model.
Future revisions may separate bootstrap authority from ongoing administration.

## Reference Implementation Notes

Reference files:

- `src/routes/workspaces.ts`
- `src/services/workspaces.ts`
- `tests/workspaces.test.ts`
