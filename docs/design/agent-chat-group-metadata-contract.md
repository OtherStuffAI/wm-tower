# Agent Chat Group Metadata Contract

Status: confirmed in Tower
Last updated: 2026-04-08

## Scope

This note closes Tower work package 22 for the agent-first Agent Chat redesign.

It defines the Tower metadata Wingmen can rely on to resolve readable message encryption groups without any Flight Deck trigger record.

## Result

- Tower already exposes sufficient chat-record and group metadata for agent-first runtime.
- No new Tower route or routing-policy surface is required.
- No Flight Deck trigger record is required in the normal runtime path.

## Message Metadata Contract

Visible chat records are pulled through the existing generic records routes:

- `GET /api/v4/records`
- `GET /api/v4/records/{record_id}/history`

For each visible message version, every returned `group_payloads[]` entry carries:

- `group_id`: stable group UUID for the logical group
- `group_epoch`: integer epoch used for encryption for that payload
- `group_npub`: rotating group pubkey for that epoch
- `ciphertext`
- `write`

Normative meaning:

- `group_id` is the durable identity Wingmen should use to correlate the same logical group across message versions and epoch rotations.
- `group_epoch` and `group_npub` identify the exact encryption key identity used for that payload version.
- Tower does not inspect decrypted chat semantics and does not choose candidate agents.

## Related Group Metadata Contract

Wingmen can combine message metadata with the existing generic group surfaces:

- `GET /api/v4/groups?npub=<actor-or-ws-key>`
- `GET /api/v4/groups/keys?member_npub=<actor-or-ws-key>`

`GET /api/v4/groups` returns, per visible group:

- `id`
- `group_npub`
- `current_epoch`
- `group_kind`
- `private_member_npub`
- `members`

`GET /api/v4/groups/keys` returns, per wrapped key row:

- `group_id`
- `group_npub`
- `epoch`
- `member_npub`
- `wrapped_group_nsec`
- `key_version`

Normative meaning:

- `group_kind` and `private_member_npub` describe what kind of group Wingmen is looking at, including private-member groups.
- `group_id` links wrapped-key rows to chat-record `group_payloads[]`.
- `epoch` and `group_npub` let Wingmen confirm decryptability for current and historical message payloads.

## Agent-First Runtime Guidance

Tower’s role is limited to actor-visible transport and metadata:

1. Wingmen receives SSE or bootstrap work for chat activity.
2. Wingmen pulls visible chat records through the generic records routes.
3. Wingmen derives candidate message groups from `group_payloads[]`.
4. Wingmen optionally joins that data with `GET /api/v4/groups` and `GET /api/v4/groups/keys` for local diagnostics and agent matching.

Tower does not provide:

- a trigger-dependent runtime switch
- a Tower-owned routing policy layer
- agent matching or arbitration

## Conclusion

- The existing Tower contract is sufficient for candidate agent-group resolution.
- WP22 requires contract clarification and tests only, not a new backend payload surface.
