# Private scalar preferences v1

`GET/PUT /api/v4/flightdeck-pg/workspaces/:workspaceId/me/preferences/:preferenceKey`
are additive, authenticated, membership-required, actor-bound endpoints. Responses
are `Cache-Control: private, no-store` and contain `identity` and `preference`
(null on an absent GET). The row has id, workspace_id, actor_id, preference_key,
value, row_version and updated_at. No actor override is accepted.

Keys match `^[a-z][a-z0-9_.-]{0,95}$`. Values are UTF-8 strings of at most 2048
bytes without ASCII controls. The server has no app-specific URL semantics.
PUT accepts only value, expected_row_version (0 for creation), mutation_id (UUID)
and optional import_only. Writes use compare-and-swap; a stale revision returns
409 preference_conflict. Exact retries return their original acknowledgement,
even after later writes; changed reuse returns 409 mutation_id_reused. Import
requires expected version zero and returns the existing row if present. Explicit
resets remain durable values, preventing stale-device import from resurrecting
an older choice. Membership removal hides rather than deletes actor preferences;
rejoining the same actor preserves authority over stale devices.

`private_preference.updated` outbox events contain only actor_id, never the
setting value. Direct event subscriptions deliver these only to the same actor;
workspace-wide fallback audiences and managed/delegated audiences cannot see them.
The dedicated GET is the recovery checkpoint: clients re-read through their
existing sync owner after a private event and on fallback/reconnect. This small
extension does not add a record-journal family, alter cursor schemas or require
old clients to recognize a new record family. Existing routes remain compatible.

Bootstrap and idempotent runtime migration create two private tables: current
scalar values and immutable mutation receipts. Identity rotation remains stable
because actor UUID is the authority key. Consumer: Ambulando, key
`ambulando.nostr-viewer`; validation and link transformation belong to its client.
