# Validating scoped sync authorization

Workspace membership and automatic system Workspace group enrollment allow login.
They do not grant access to every scope or channel. Content sharing is explicit;
revoked scope/channel grants must remain revoked through bootstrap and restart.
Keep other explicit actor/group grants unchanged when repairing a sharing group.

A cached view or passing authorization helper is insufficient evidence of a fresh
sync boundary. Verify the running origin and source hashes, the NIP-98 signer and
resolved actor, and the actual serialized HTTP responses. Use an authorized
ordinary-member test identity with allowed and denied resources, plus owner and
manager controls. Never borrow a user's credential or impersonate their signer.
A temporary identity mirroring another member's grants is useful server evidence,
but must be labeled as a test identity rather than device verification.

Traverse every snapshot page, then write/update fixtures in both allowed and
denied channels and traverse the delta. Check scopes, channels, records and
identity sidecars. Verify direct record reads, private file metadata/content and
authenticated hash downloads. Check contributor writes in the allowed channel and
denial elsewhere. Check management across all intended scopes/channels separately.
Do not infer permission from the number of rows scanned: pages scan candidate rows
before filtering, so a reader can traverse many pages with few returned records.

Exercise SSE over an actual HTTP socket. Keep the connection open, remove only
its test member's sharing-group membership, and publish both newly denied and
still allowed events. The denied event must disappear while the direct grant
continues to work. Workspace membership loss closes the stream. If workspace.read
was granted when the stream opened, loss of that grant also closes it; a scoped
subscriber without workspace.read can continue receiving authorized channel events.
All polls resolve current effective groups and current workspace-event permission.

For a specific reader, temporarily set `TOWER_PG_SYNC_TRACE_NPUB` to its public
npub in the Tower runtime environment. Each successful record-sync response then
logs `tower.pg.record_sync.response` with the effective origin, signer, resolved
actor, protocol, mode, returned family counts, scope/channel identifiers and
completion flags. This evidence omits authorization headers, private keys, cursor
tokens and payload content. Disable the setting after collecting evidence. Keep
run-specific logs and personal identifiers in ignored operational storage.

Previously authorized downloads remain local under `retain_downloaded`. Do not
clear them to test a grant repair. Use a separate empty browser/test context when
fresh materialization is required. Check which storage types a browser's reset
actually clears: cookies, HTTP cache and localStorage are distinct from IndexedDB.
A reset that leaves IndexedDB does not prove an empty local database. Inspect
actual response evidence before attributing a displayed row to retained data.
