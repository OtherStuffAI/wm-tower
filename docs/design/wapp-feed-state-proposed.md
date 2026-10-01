# Tower WApp feed reader state — proposed

Status: **proposed / unimplemented**. Companion to canonical
[`wapp-feed-v1-proposed`, revision `1`](../contract/wapp-feed-v1-proposed.md).
The canonical contract controls shared field definitions and security requirements.
Do not amend this companion as an independent wire contract; coordinate revision
pins in all four projects. No typed feed-subscription/state endpoints are promised
as currently available.

## Ownership and T1 scope

Tower owns workspace + authenticated reader subscriptions and read/dismissed/saved
flags across devices. It does not fetch, normalize or ingest private WApp feed
bodies. Registry discovery belongs to Autopilot, list/feed projection and ACL to
WApps, source fetching/cache/UI to Flight Deck. Existing graph authorization and
WApp publication APIs are separate contracts and remain intact.

T1 follows WP0 ratification. Add typed PG subscription CRUD and item-state
upsert/list with migrations, OpenAPI/types and authorization tests. Resolve the
reader through Tower's real actor context. A supplied actor/npub is never an
identity override. Source uniqueness includes connected Autopilot logical ID,
installation ID and feed ID; a feed title or public hostname is insufficient.
Subscription updates retain identity. Public feeds use the canonical public URL
identity proposal, not an installation invented from a URL.

The canonical document supplies subscription/state response examples and proposed
mutation preconditions. T1 must expose row versions, idempotent mutation IDs,
reader-scoped events, pagination and initial/reconnect hydration so
TowerSyncService can materialize state into Dexie. No second Tower polling owner
may be added by the Feed UI. Never put source credentials, signing events, edition
bodies or private summaries into subscription/state rows or event payloads.

## Decisions requiring agreement

Proposed uniqueness is reader + workspace + stable source tuple. Repeated subscribe
returns the same subscription; retries do not create records or duplicate flags.
Proposed writes use compare-and-swap and field patches; replay cannot overwrite an
unrelated saved/dismissed flag. Mark-unread semantics, monotonic read policy and
conflict reconciliation need explicit product choice. Client wall-clock timestamps
must not decide authority accidentally.

Proposed unsubscribe creates a retained-state tombstone and clears local private
bodies; resubscribe restores the same subscription identity and flags. Retention,
forget/purge and saved-item UX remain open. Tombstones/events must outlive supported
offline replay or use an equivalent anti-resurrection mechanism. Revocation is
WApp/Tower permission loss, not unsubscribe; state retention never grants read
access. Resource-view state for tasks/docs/threads is not automatically the feed
state contract: item read/saved/dismissed flags need their own ratified shape.

## Acceptance and migration boundary

Specify two readers in two workspaces plus two clients of one reader. Check every
CRUD/state route and SSE/hydration page for isolation; forged reader IDs and cursor
reuse fail. Verify source deduplication, retry acknowledgements, stale row conflicts,
lost-event recovery, edits retaining item state and unsubscribe/reconnect without
resurrection. The source may be offline while Tower state still syncs.

M1 maps historical Book of Sand state only where old deterministic external ID,
reader and source association are trustworthy. Report unmappable rows; preserve old
Tower Feed records, avoid duplicate visible cards, and never automatically broaden
subscriptions. Disable only Book of Sand publication grants after acceptance, not
suite-wide APIs or grants. Rollback uses retained records and deterministic IDs.

See [Flight Deck companion](../../../flightdeck/docs/design/wapp-feed-reader-proposed.md),
[Autopilot companion](../../../autopilot/docs/wapp-feed-transport-proposed.md), and
[Book of Sand companion](../../../../../wingmen/wingman21/mycode/book-of-sand-wapp/docs/wapp-feed-editions-proposed.md).
R1 must supply future source commits, served Flight Deck build number, live
privacy/convergence evidence and rollback proof. This document does not activate T1.
