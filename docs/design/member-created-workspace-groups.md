# Member-Created Workspace Groups

**Date:** 2026-05-19
**Status:** Implementation plan for review
**Scope:** Tower group creation authorization, with Flight Deck UI remaining more restrictive than Tower

## Problem

Flight Deck creates a new group before it can create a direct-message channel. The group is the stable access-control and encryption boundary for the channel's records.

Tower currently authorizes `POST /api/v4/groups` with `canManageWorkspace()`. That means only the workspace owner, creator, or admin-group members can create workspace-owned groups. A normal workspace member can have record write access through existing groups, but still cannot create the new group needed for a DM or other app-level collaboration surface.

The current failure shape is:

```text
403 POST /api/v4/groups
owner_npub must match authenticated npub or a managed workspace
```

## Design Direction

Tower should not need to know whether a group will be used as a DM, channel, scope, or future app-specific collaboration object. Tower should authorize generic access-control group creation.

Default rule:

```text
Any authenticated actor who is a member of a workspace may create a normal shared group in that workspace.
```

This should be implemented as a Tower-side authorization rule, not only as Flight Deck UI behavior. Flight Deck can expose a narrower UX, such as only selecting existing groups or creating pairwise DM groups, but direct API callers must still be held to the Tower security envelope.

## Privacy Boundary

Tower must not inspect app payload content or message semantics to make this decision.

Tower may validate only structural access-control facts it already owns:

- the target workspace exists
- the authenticated actor resolves through workspace-session-key auth to a real user npub
- the actor is already a member of the target workspace
- the new group is a normal user-created group, not a protected system group
- the actor is included in the submitted `member_keys`
- member key entries are unique and complete

Tower should continue treating app-specific record payloads as opaque.

## Proposed Tower Contract

Add a helper near the existing workspace authorization helpers:

```text
canCreateWorkspaceGroup(workspaceOwnerNpub, actorNpub)
```

Initial behavior:

- return true when `canManageWorkspace(workspaceOwnerNpub, actorNpub)` is true
- otherwise resolve workspace-session-key npubs to the real user npub, matching `canManageWorkspace()`
- return true when the resolved actor is a current member of any group whose `owner_npub` is the target workspace owner
- return false when the workspace does not exist or the actor is not a member

Then change `POST /api/v4/groups` to use `canCreateWorkspaceGroup()` instead of `canManageWorkspace()` for normal user-created groups.

Keep these existing protections:

- reject missing `owner_npub` or `workspace_service_npub`
- reject missing `name`
- reject missing `group_npub`
- reject missing or empty `member_keys`
- reject duplicate `member_keys.member_npub`
- reject protected/system group kinds from the public route

Protected group kinds remain:

- `workspace_shared`
- `workspace_admin`
- `private`

The route already rejects `group_kind` values other than `shared`. Keep that behavior.

## Member Inclusion Policy

For the first implementation, require the authenticated resolved actor to have a wrapped group key in `member_keys`.

Open policy decision for implementation review:

1. Strict member-only inclusion: every `member_keys.member_npub` must already be a member of some group in the workspace.
2. Permissive inclusion: the creator may include any npub, making group creation an implicit invite/access-grant mechanism.
3. Hybrid inclusion: humans must already be workspace members, while approved workspace app/agent principals may be included through an existing app/agent registration mechanism.

Recommended first implementation: strict member-only inclusion unless there is already a Tower-owned app/agent principal registry that can safely validate Lara-like bot identities. If the bot registry exists and is stable, use hybrid inclusion.

Reason: allowing arbitrary external npubs would make ordinary group creation an implicit workspace invite path. That can be added later as a deliberate product policy, but it should not be smuggled into this authorization change.

## Future Policy Hook

Do not build a full settings UI in this change, but keep the helper shaped so a later workspace policy can replace the default.

Future policy values:

```text
workspace_group_creation_policy:
  members
  admins_only
  disabled
```

Initial default is `members`.

## Flight Deck Behavior

No broad Flight Deck group-management UI is required for this Tower change.

Flight Deck may remain more restrictive than Tower:

- let users select existing groups
- let users create DM-style pair groups
- hide general-purpose group creation until the product needs it

The important contract is that Tower permits the underlying normal group creation when Flight Deck needs a new access boundary for a member-initiated DM.

## Implementation Steps

1. Add `canCreateWorkspaceGroup()` in `src/services/workspaces.ts`.
2. Reuse the existing workspace-session-key resolution behavior from `canManageWorkspace()`.
3. Add a workspace membership query that checks `v4_group_members` joined to `v4_groups` by `g.owner_npub = workspaceOwnerNpub`.
4. Update `src/routes/groups.ts` so `POST /api/v4/groups` uses the new helper for public `shared` group creation.
5. Keep `canManageWorkspace()` for rotate, add member, remove member, delete, rename, workspace admin/private/default groups, and any protected group mutation.
6. Add tests in `tests/workspaces.test.ts` or a focused groups route test:
   - workspace admin can still create a group
   - ordinary workspace member can create a normal shared group
   - non-member cannot create a group
   - creator must be included in `member_keys`
   - duplicate member keys are rejected
   - protected `group_kind` values remain rejected
   - workspace-session-key auth resolves to the real member identity
   - if strict member-only inclusion is chosen, external npubs are rejected
7. Update OpenAPI route description for `POST /api/v4/groups` to document the member-created group rule.
8. If Flight Deck needs no request-shape change, verify the existing DM flow no longer fails at group creation.

## Validation

Run:

```bash
set -a; . ./.env.example; set +a; bun test tests/workspaces.test.ts
set -a; . ./.env.example; set +a; bun test
```

If Flight Deck behavior is exercised manually, confirm:

- Collaborator can create a DM/channel group in the Example workspace.
- The group appears only to members who received wrapped keys.
- A direct API attempt from a non-member still receives 403.

## Review Questions

- Should initial member inclusion be strict member-only, or should Tower recognize approved app/agent principals now?
- Is group creation by any workspace member acceptable as the default policy for all Tower tenants?
- Should the route record `created_by_npub` for user-created groups before broader group-management features are added?
- Do we need a group owner/manager concept before allowing non-admin creators to later rename or mutate their own groups?
