# WApp feed v1 — implemented Tower source profile

Tower feed reader **source build 1**, exposed as OpenAPI `x-wapp-feed-reader-source-build`, accompanies Tower package version 0.1.0. This is the actual T1 wire profile for the canonical [proposed v1, revision 1](wapp-feed-v1-proposed.md). T1 source implementation does not activate the suite or claim WApp transport support. The proposal remains the review baseline for other packages. This additive profile selects the Tower routes and reader-state decisions; it does not change WApp list/feed fields. OpenAPI and `src/types.ts` define the machine-readable contract.

## Routes and mutations

All routes are under `/api/v4/flightdeck-pg/workspaces/{workspaceId}`. The verified NIP-98 signer resolves to an existing actor and workspace membership. No client actor/owner override is accepted. Unknown fields are rejected. Requests store no signing events, credentials, item bodies or private summaries. Responses use `Cache-Control: private, no-store` and mutation success is HTTP 200.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/feed-subscriptions` | `{subscriptions, next_cursor}` including tombstones |
| POST | `/feed-subscriptions` | `{subscription}`; source deduplication |
| GET | `/feed-subscriptions/{subscriptionId}` | `{subscription}` in the actual reader partition |
| PATCH | `/feed-subscriptions/{subscriptionId}` | `{subscription}`; CAS patch of `status`, `title`, `endpoint` |
| DELETE | `/feed-subscriptions/{subscriptionId}` | `{subscription}`; retained unsubscribe tombstone |
| GET | `/feed-subscriptions/{subscriptionId}/item-states` | `{item_states, next_cursor}` including retained flags |
| PUT | `/feed-subscriptions/{subscriptionId}/item-states` | `{item_state}`; CAS patch of explicit flags |

Every write requires `mutation_id` UUID and `expected_row_version` nonnegative integer. Creation uses 0. POST also requires `source` and allows optional plain `title` (256 characters). PATCH requires a nonempty `patch`. DELETE has no patch. PUT requires opaque `item_id` (1..2048 UTF-8 bytes, no NUL) and a nonempty patch containing only boolean `read`, `dismissed`, `saved`. Explicit false supports mark unread and clearing the other flags. Absent state means all false. State records additionally expose server UUID `id` for the existing record journal; the durable item key remains workspace + reader + subscription + item ID.

```json
{
  "mutation_id": "00000000-0000-4000-8000-000000000010",
  "expected_row_version": 2,
  "item_id": "edition:example",
  "patch": { "read": false }
}
```

Writes serialize per reader/workspace and commit the row, record journal, personal outbox event and acknowledgement atomically. Identical semantic JSON (object key ordering irrelevant) under the same mutation ID returns the original acknowledgement without another event or row change. Changed request, target or operation under that ID returns 409 `mutation_id_reused`. Failed mutations roll back and create no acknowledgement. Whole-row CAS conflict is 409 `state_conflict`; reload and reapply only intentional fields with a new mutation UUID. Never infer overwrite order from client timestamps. Retried old acknowledgements retain their original row versions: clients must ignore older versions and use record recovery to obtain the current row.

Repeated POST for an active source returns the same identity without changing its title or endpoint. Repeated POST after unsubscribe returns 409; explicit PATCH `{status:"active"}` with the current row version resubscribes. Stale POST/PATCH cannot resurrect an unsubscribe. DELETE increments the row version and retains identity and flags indefinitely in this initial implementation, with no expiry or forget endpoint. Explicit workspace deletion follows existing workspace lifecycle and cascades its feed metadata. State writes while unsubscribed return 409 `subscription_inactive`. Flight Deck must cancel source fetches and purge private bodies on unsubscribe; retained flags confer no content access.

## Source identity and portable connection binding

WApp source fields remain the proposed `kind`, `autopilot_connection_id`, `installation_id`, `feed_id`, `endpoint`, `format`. Tuple uniqueness uses a structured JSON array, never concatenated strings. Connection ID is the shared `flightdeck_pg_autopilot_connections.id` UUID in the same workspace. New subscriptions and activation patches reject missing/archived connections. Existing records preserve identity when URLs/transports change. UUIDs manufactured in a client or legacy Dexie fallback are not portable and are not accepted unless they resolve to a real shared PG record.

Proof in current code: Tower's connection service creates/reuses the PG record by workspace + logical installation ID; Flight Deck `autopilot-connection-refresh.js` persists verified connect-package fields and `db.js` materializes the shared records. Autopilot `wapps/wapp-store-schema.ts` persists installation IDs in `wapp_records.id`, distinct from reusable app IDs. The source installation ID must come from the authorized WApp registry. Tower validates its UUID shape but does not contact that registry or prove the WApp origin/ACL. The reader must validate registry origin and installation binding before signing/fetching; this remains an integration obligation, not an owner bypass or invented delegation protocol.

Feed IDs match `[a-z0-9][a-z0-9_-]{0,63}`, with `list` reserved. Endpoint is exactly `/feed/{feed_id}` and format is `jsonfeed-1.1`. Path-mounted feed bases and FIPS signing/graph forwarding are not established by T1. Public sources use standard serialized absolute HTTP(S) URL with fragment removed, no userinfo, query order preserved; deduplication ignores format. Redirects do not rekey. Tower does not fetch any URL or implement the excluded public adapter.

## Pagination and recovery

Metadata lists accept only `limit` (integer 1..200, default 50) and opaque `cursor`. Ordering is stable server UUID ascending. Tokens are bound to workspace, actor and route/subscription; malformed, expired (7 days) and mismatched tokens return 400 `invalid_cursor`. End of list is `next_cursor:null`. These are current keyset lists, not immutable snapshots: a newly inserted lower UUID may require a refresh. Use the existing `/records` protocol for hydration and lossless snapshot-to-delta handover, not ad hoc concatenation of list pages.

`/records` advertises `feed_subscription` and `feed_item_state`, backed by the same all-mutation journal triggers, byte/row bounds, reader authorization context and scoped cursor recovery as other families. Subscription tombstones remain upserts with `status:unsubscribed`. `/records` cursor misuse/expiry resets with the existing `reset_required` behavior. Clients materialize only newer versions and process complete partition markers using TowerSyncService → Dexie → liveQuery.

Existing `/events` and `/events/stream` expose feed events only when `payload.reader_actor_id` matches the actual reader, even with workspace-read permission. Managed-agent audience unions explicitly exclude these personal events; audience management is not feed delegation. Existing event cursor format remains compatible (a position hint, not authority); `/records` provides scoped recovery. The event payload is the subscription or item-state row, with no content. No second Tower network owner is introduced.

## Limits and preserved boundaries

Mutation bodies are limited to 16 KiB before parsing. Reader lists are bounded to 200 rows. Source endpoint/title/format changes never rekey source identity. No private fetch support, browser CORS proof, media grants, live activation or historical migration is claimed here. All legacy publisher routes, grants and data remain intact. Source tests run against a dedicated PostgreSQL instance; production runtime validation and release are separate, excluded work.


## Book of Sand actual-reader graph extension (W1 coordination)

The Book of Sand W1 source requires a per-installation adapter in Flight Deck,
without altering the shared `/feed/list` schema. Its `GET /api/feed/read-targets`
requires the actual reader's exact WApp NIP-98 signature plus app ACL and returns
`{graph_read_targets:{stories,history},source_build:1}`. Targets are configured
absolute Tower `/api/v4/graph/nodes` URLs for Story and Reference labels, with
limit 200 and offset 0. Before signing, the client must match them to its known
Tower endpoint, workspace, app/group/source scope, and allowlisted read query.
Never sign arbitrary targets offered by source content.

Each `/feed/list`, `/feed/editions` (or `/feed/`) request carries its own exact-URL
`Authorization`, plus `X-Tower-Stories-Authorization` and
`X-Tower-History-Authorization` for those separate exact graph GET URLs. All three
signatures must belong to the same actual reader. W1 source validates kind, ID,
signature, exact URL/method and ±60-second freshness for each page, forwards graph
events unchanged with redirects disabled, and has no app/bot/owner substitution.
Existing Tower graph registration, groups and RLS remain authoritative. These
headers are app-specific read transport, not delegated authority, and are never
stored in Tower or sent to item destinations.

This source pattern was checked in W1 `src/feed.ts`, its reuse of existing
reader-graph forwarding, and Tower's current graph boundary. It establishes no
live human browser, WMapp or FIPS support claim. FD must supply the real adapter
and prove same-reader graph binding and Authorization CORS before integration.
W1 projects only its bounded recent window of 200 visible Stories and 200 visible
References; full archive coverage is not claimed. Enlarging that window requires
a separate bounded graph/projection contract. Publishers and historical rows
remain untouched; hourly completion-builder invocation/cutover is excluded M1.
