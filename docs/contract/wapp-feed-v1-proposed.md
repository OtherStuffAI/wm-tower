# WApp feed contract — proposed v1

Status: **proposed / unimplemented**. Contract ID: `wapp-feed-v1-proposed`,
revision `1`, 2026-10-01. This is the canonical shared contract, held in Tower
because Tower owns shared reader-state authority. WApps retain content authority.
No endpoint or schema below is a claim about current deployed capabilities.

T1 now has an [implemented Tower source profile](wapp-feed-t1-api.md). That
profile fixes actual routes, reader-only sync, portable PG connection binding,
CAS field patches, explicit unread and indefinite retained flags. Revision 1 here
is preserved as the shared proposal baseline; WApp/browser/FIPS proof and activation
remain outside T1. The profile also records the coordinated W1 same-reader graph-header
extension and its recent-history limitation; it grants no new authority. Do not read the historical open Tower decisions below as
overriding the implemented profile.

## Authority and review basis

Agreed product boundaries appear under “Fixed agreements”. Wire shapes and
policies under “Proposed normative profile” are candidate requirements for WP0
ratification: MUST/SHOULD apply to an implementation of this draft, not to the
current applications. Open decisions must be resolved before implementation.
Documentation approval alone does not authorize architecture changes or activation.

Companions pin this contract ID/revision and never independently redefine it:

- [Tower state](../design/wapp-feed-state-proposed.md)
- [Flight Deck reader](../../../flightdeck/docs/design/wapp-feed-reader-proposed.md)
- [Autopilot discovery/transport](../../../autopilot/docs/wapp-feed-transport-proposed.md)
- [Book of Sand editions](../../../../../wingmen/wingman21/mycode/book-of-sand-wapp/docs/wapp-feed-editions-proposed.md)

Repository-relative sibling links assume the documented suite checkout layout;
Book of Sand uses the agent repository layout. When repositories are cloned
separately, locate the named repository/path rather than treating a broken local
link as a new authority. Do not copy this document into another authority.
For a revision, update the canonical contract and all companion revision pins in
one coordinated review; verify links and examples in every repository. A mismatch
blocks implementation until reconciled. Breaking wire changes require a new
contract major version and an explicit compatibility/migration decision.

Basis: migration proposal `Wingman_Suite/wapp-feed-migration/v2`, including
WP0, T1, W1, F1, F2, conditional A1, M1, R1 and its risk register. Architecture:
registered local catalog creation ordering selects v6 (transport HTML addendum);
v7 is the latest available saved Excalidraw scene, saved 2026-09-25. Both were
read: Flight Deck coordinates, Autopilot executes, Tower manages shared state;
TowerSyncService materializes into Dexie/liveQuery; FIPS transport is pinned and
never supplies application authority. Hosted latest-version confirmation requires
an authorized reviewer: this worker's stable identity was denied catalog login.
Re-resolve the hosted latest catalog and scene before consequential implementation;
this draft makes no architecture change. Private artifact URLs and operational
identities are intentionally kept on the task, outside reusable product docs.

Protocol references: [JSON Feed 1.1](https://www.jsonfeed.org/version/1.1/),
[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md).

## Fixed agreements

| Owner | Responsibility |
| --- | --- |
| Flight Deck | Information/link reader, source discovery and fetch/normalization, reader-partitioned local content, reader UI |
| Tower | Typed PG reader subscriptions and read/dismissed/saved state across devices; workspace/actor authorization and sync events |
| Autopilot | Authorized installed-app discovery across connected instances; registered installation origins and transports; runtime lifecycle |
| WApp | Authenticated feed list and JSON Feed projection; signer-specific access; durable app data; any effect of opening an item URL |

One item action: an intentional click opens the WApp-provided URL. Flight Deck
MUST NOT prefetch that destination, run an action, or add a separate approval
protocol. Read/dismiss/save are reader state, independent of WApp effects. The
WApp rechecks destination access and owns repeat-open semantics.

Tower MUST NOT ingest private feed bodies as a new delivery surface. A subscription
is a preference, never an access grant. Existing Tower graph/storage permissions
remain authoritative; moving Feed delivery does not move the Book of Sand graph.

Discovery: Feed + → choose a connected Autopilot's authorized app → authenticated
`GET /feed/list` → choose feed → save reader subscription in Tower. WApps expose
`GET /feed/<id>` as JSON Feed 1.1; a single-feed WApp MAY alias `GET /feed/` to that
same feed. Public JSON/RSS URLs are also supported; podcasts use attachments.

## Proposed normative profile

### Identity and endpoint binding

WApp source identity is the tuple `(autopilot_connection_id, installation_id,
feed_id)`. Connection ID denotes a stable logical connected instance shared across
a reader's clients, not a device-local URL, display label, or physical FIPS handle.
WP0 must settle how existing connection records supply that portable identity.
Installation ID comes from the authorized registry. Feed ID is app-defined,
immutable within the installation and MUST NOT be reused for different content.
Titles, origins and transports may change without changing source identity; a
replacement installation is a different source unless explicitly migrated.

Encode tuple keys as structured fields (or an unambiguous length-prefixed encoding),
not delimiter-concatenated user strings. Item state key is `(workspace_id,
reader_actor_id, subscription_id, item_id)`. Item IDs are opaque nonempty strings,
unique for a feed over its lifetime. Edits retain IDs; new items never reuse them.
JSON `id` is required; never key state by headline, array position or fetch time.

Public-source identity is provisionally the submitted absolute HTTP(S) feed URL,
normalized by standard URL serialization, fragment removed; preserve query
parameters and their order. Redirects do not silently rekey a subscription. URL
alias deduplication/migration and public feed identity overrides remain WP0 choices.

The list endpoint and every feed endpoint MUST resolve against the registry's
verified installation origin/base path, not an origin supplied by feed content.
Draft v1 requires root-relative `/feed/<id>` endpoints, where IDs match
`[a-z0-9][a-z0-9_-]{0,63}` and `list` is reserved. Reject network-path `//`, userinfo,
fragments, encoded separators/traversal, backslashes and origin/base-path escape.
For path-mounted installations WP0 must define a registered feed base before use;
do not guess from launcher query strings. Resolve first, validate, then sign the
exact resulting URL including query. Never sign a pre-normalized different URL.

Pagination URLs for WApps MUST remain within that registered origin and the same
feed path, with only permitted cursor/limit query fields. Reject loops, origin
changes and auth-bearing URL query credentials. Public pagination may use other
public origins only after the same SSRF/URL checks, always without credentials.
Item links and attachment URLs are distinct from source endpoints. Draft profile
requires absolute HTTP(S) URLs without userinfo; reject executable/data/file
schemes. FIPS logical target support requires WP0's pinned resolver proof, not
an implicit scheme exception. Source-owned item URLs may point to another safe
origin; opening never forwards the feed Authorization header.

### Authenticated feed-list schema and example

`GET /feed/list` returns `application/json`. Every request verifies NIP-98 and
applies the signer's ACL. Required top-level keys: `contract_version` (integer 1),
`feeds` (array). Each entry requires unique `id` (feed ID), `title` (nonempty plain
string), `description` (plain string, may be empty), `endpoint` (restricted relative
path above), `format` (literal `jsonfeed-1.1`). No secrets or inaccessible-feed
metadata. An authorized signer with no permitted feeds receives an empty array;
an app-level forbidden signer receives 403. Cursor pagination is proposed:
`next_cursor` string or null, required in this draft. No total count that leaks
forbidden feeds. List request accepts `limit=1..100`, `cursor=<opaque>`; cursor is
bound to signer, installation, query and authorization context. Invalid/expired
cursors return 400 and restart discovery, never widen access.

```json
{
  "contract_version": 1,
  "feeds": [
    {
      "id": "editions",
      "title": "Book of Sand editions",
      "description": "One headline per completed edition",
      "endpoint": "/feed/editions",
      "format": "jsonfeed-1.1"
    }
  ],
  "next_cursor": null
}
```

### Feed profile and example

`GET /feed/editions` returns `application/feed+json` (accept `application/json`
for interoperable public feeds). Required JSON Feed fields: `version` literal
`https://jsonfeed.org/version/1.1`, `title` string, `items` array. This WApp profile
also requires `feed_url` to identify the first page, and per item `id`, `title`,
`url`, `date_published` (RFC 3339), plus at least one of `content_text` or
`content_html`. `summary` is plain text; `date_modified` is optional RFC 3339.
Public feeds may omit profile-only fields; normalize them without inventing dates
or IDs. Unknown JSON Feed fields/extensions are ignored, not rendered as HTML.

`attachments`, if present, is an array requiring absolute safe `url` and
`mime_type`; optional `title`, nonnegative `size_in_bytes`, and nonnegative
`duration_in_seconds`. RSS enclosures map to attachments. Attachment metadata
does not authorize auto-download or autoplay. Media loading/signing policy for
private attachments is unresolved; do not send feed credentials to media hosts.

```json
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "Book of Sand editions",
  "home_page_url": "https://book.example.invalid/",
  "feed_url": "https://book.example.invalid/feed/editions",
  "items": [
    {
      "id": "book-of-sand:feed:edition-2026-10-01-01",
      "title": "Example verified headline",
      "summary": "A completed edition with independently verified stories.",
      "content_text": "A completed edition with independently verified stories.",
      "url": "https://book.example.invalid/?story=example-headline",
      "date_published": "2026-10-01T01:00:00Z",
      "date_modified": "2026-10-01T01:05:00Z",
      "attachments": [
        {
          "url": "https://media.example.invalid/edition-01.mp3",
          "mime_type": "audio/mpeg",
          "title": "Optional edition audio",
          "size_in_bytes": 2048,
          "duration_in_seconds": 30
        }
      ]
    }
  ],
  "next_url": "https://book.example.invalid/feed/editions?cursor=older-page&limit=50"
}
```

Audio above is a format example, not a promise of Book of Sand audio production.
Items sort by publication time descending, stable item ID as tie-break. Draft
requests accept `limit=1..100` and opaque `cursor`; default 50. Feed pagination
uses JSON Feed `next_url`, omitted at end, never null. Cursor/snapshot consistency
is an unresolved producer choice: W1 must prove paging concurrent editions without
missing or duplicating items. Readers deduplicate by ID and bound pages/bytes/time;
missing items in a limited page are not deletion or revocation evidence.

### Proposed Tower subscription and state schemas

These are logical typed PG shapes, **not implemented routes or final DB tables**.
T1 owns exact route names, OpenAPI, migrations, actor resolution, write preconditions
and sync integration. UUIDs below are synthetic. Server derives workspace and
reader actor from authenticated Tower context; clients cannot pick another reader.
Do not treat an arbitrary `owner_npub`, `reader_npub` or actor parameter as authority.

Subscription required fields: UUID `id`, `workspace_id`, `reader_actor_id`;
`schema_version` integer 1; `source` discriminated object; `status` enum
`active|unsubscribed`; positive integer `row_version`; RFC 3339 `created_at`,
`updated_at`. WApp `source` requires `kind=wapp`, portable UUID connection ID,
UUID installation ID, feed ID, endpoint path and format. Public `source` requires
`kind=public`, absolute `url`, `format=jsonfeed-1.1|rss` (provisional detection
result). Optional display title is plain metadata, never authority. Transport
credentials, content, publisher grants and signing events MUST NOT be stored.

```json
{
  "schema_version": 1,
  "id": "00000000-0000-4000-8000-000000000001",
  "workspace_id": "00000000-0000-4000-8000-000000000002",
  "reader_actor_id": "00000000-0000-4000-8000-000000000003",
  "source": {
    "kind": "wapp",
    "autopilot_connection_id": "00000000-0000-4000-8000-000000000004",
    "installation_id": "00000000-0000-4000-8000-000000000005",
    "feed_id": "editions",
    "endpoint": "/feed/editions",
    "format": "jsonfeed-1.1"
  },
  "status": "active",
  "row_version": 1,
  "created_at": "2026-10-01T01:10:00Z",
  "updated_at": "2026-10-01T01:10:00Z"
}
```

State required fields: same schema version/workspace/reader context,
UUID `subscription_id`, opaque `item_id`, booleans `read`, `dismissed`, `saved`,
positive `row_version`, RFC 3339 `updated_at`. Missing state means all three false.
No item body/title/URL is needed in state. Saved means a reader flag, not a
permanent private-body archive or access override.

```json
{
  "schema_version": 1,
  "workspace_id": "00000000-0000-4000-8000-000000000002",
  "reader_actor_id": "00000000-0000-4000-8000-000000000003",
  "subscription_id": "00000000-0000-4000-8000-000000000001",
  "item_id": "book-of-sand:feed:edition-2026-10-01-01",
  "read": true,
  "dismissed": false,
  "saved": true,
  "row_version": 2,
  "updated_at": "2026-10-01T01:11:00Z"
}
```

Proposed mutations carry `mutation_id` UUID, `expected_row_version` nonnegative
integer (0 for creation), and a patch of explicitly changed fields. Tower MUST
isolate all reads/writes/events by workspace and authenticated reader, and impose
uniqueness on reader + source tuple. Repeated subscribe returns the existing
subscription identity. Repeated mutation ID with identical request returns prior
acknowledgement; changed body under that ID is rejected. Read-state replay MUST
be idempotent. Events and hydration MUST let a second client converge and recover
lost SSE/cursors. Pagination envelope provisionally uses `next_cursor` string/null,
limit 1..200, with server-defined stable order and no cross-reader leakage.

Proposed concurrency: optimistic row-version compare-and-swap with 409 conflict;
client reloads current row and reapplies only intentional field changes with a
new mutation ID. Do not overwrite saved state when replaying a stale read change.
Whether read is monotonic or supports mark-unread, and per-field merge versus
whole-row conflict, require product agreement. Do not invent last-writer-wins.

Proposed unsubscribe marks a tombstone, stops source fetch, clears local private
bodies, retains Tower item state and subscription identity for resubscription.
Retention duration, explicit forget/purge, saved-item UX and eventual garbage
collection remain decisions. Unsubscribe/forget MUST be separate from WApp access
revocation; retained flags never permit private fetch. Offline replay must not
resurrect a later unsubscribe or revocation.

### Authentication, errors and access loss

WApps independently verify kind 27235, valid event ID/signature, exact externally
resolved request URL (including query), HTTP method, and freshness, then apply
signer-specific deny-by-default list/feed ACL. For a body-bearing future route,
verify payload hash as required by NIP-98. Draft freshness window: ±60 seconds;
replay handling and clock-skew policy require WP0 ratification. Do not loosen
URL binding to accommodate a proxy. An arbitrary npub parameter cannot make a
bot the human owner. A verified signer and explicit scoped delegation are distinct
facts; delegated WApp reads/graph forwarding need an approved protocol or direct
reader signatures. No delegation protocol is defined by this draft.

Book of Sand must prove its projection contains only graph rows the actual reader
may access through Tower. Its broader app/bot credentials MUST NOT expand reader
visibility. Existing graph request signatures cannot simply be reused for a
WApp feed URL. Additional graph signatures or explicit delegation are an open WP0
transport/auth proof, with failure closed until resolved.

Proposed non-success response is `application/json`, with required `error.code`
(string), `error.message` (safe string), `error.retryable` boolean. Optional
`retry_after_seconds` nonnegative integer accompanies 429/503. No feed/body,
forbidden titles, credentials, internal database details or other reader IDs.

```json
{
  "error": {
    "code": "feed_forbidden",
    "message": "This signer cannot read this feed.",
    "retryable": false
  }
}
```

| HTTP | Proposed code | Reader behavior |
| --- | --- | --- |
| 400 | invalid_request / invalid_cursor | Contain invalid source; restart expired paging once |
| 401 | authentication_required / invalid_nip98 / stale_nip98 | Clear private source bodies; require fresh actual-reader auth |
| 403 | feed_forbidden | Clear private bodies; no owner/bot fallback; do not spin retries |
| 404 | feed_not_found | Mark unavailable; clear private bodies conservatively; no leak of hidden feed existence |
| 409 | state_conflict / mutation_id_reused | Reconcile state, never refetch destination |
| 413 | feed_too_large | Stop bounded fetch, report source error |
| 429 | rate_limited | Honor bounded Retry-After with jitter |
| 5xx | source_unavailable | Bounded backoff; other sources continue |

WApps may use 404 to conceal forbidden feed existence; retain the same cache-clearing
behavior. A registry removal or explicit revocation invalidates the source. Abort
in-flight work and reject late results so denial cannot be followed by stale
success that reintroduces content. Retain preference/flags only in the same reader
partition. A network outage alone is not a grant: any retained cache is labeled
stale and never reused across readers; offline private retention duration must be
ratified. Initially responses use `Cache-Control: private, no-store`; app-controlled
Dexie caching is separately governed here and is not permission to persist HTTP
responses indefinitely. No shared HTTP/service-worker private cache.

### Refresh, local cache and parsing

Subscriptions/state flow only through **TowerSyncService → Dexie → liveQuery →
Alpine**. TowerSyncService remains the sole Tower network/update owner. A separate
source-fetch service resolves subscriptions, fetches WApp/public feeds, normalizes
and transactionally writes Dexie content/status. Alpine owns UI intent and selection,
not polling or raw response collections. Heavy parsing/crypto stays off the main
thread. Proposed local partition key includes logical Tower backend, workspace,
reader actor, subscription/source tuple; credentials and signed events are ephemeral.

Dispose on identity/workspace change, logout, lock, or transport revocation; cancel
requests and invalidate generations; purge private cache for the departing context.
Never show one reader's rows in another context. Status retains last attempt,
last success, bounded error and stale flag per source; these are local observations,
not Tower feed-body records. Offline state intents may queue only for their original
reader/workspace and reconcile after reauthentication.

Proposed bounds for WP0: default poll 5 minutes with jitter, one in-flight request
per source, global concurrency 4, 10-second fetch timeout, 2 MiB decompressed bytes
per page, 5 pages/500 items per refresh, exponential failure backoff capped at
1 hour. Manual refresh coalesces; pagination cancels on disposal; track visited
page URLs. These numbers are suggested limits, not agreed production settings.
ETag/Last-Modified/304 are deferred for private feeds until validators are scoped
to reader and authorization; a 304 must never preserve data after revocation.
Edited items upsert under the same ID and retain flags; replay never creates a
second card. Source outage never stalls independent sources or Tower state sync.

RSS parser MUST disable DTDs, external entities, XInclude and network resolution;
bound depth, elements and expanded size, and reject malformed input. Stable RSS ID
uses nonempty GUID first, then stable absolute item link. If neither exists,
proposed deterministic content fingerprint is explicitly lower-confidence and
may change on edits; report that limitation, never silently claim reliable historical
state mapping. Handle duplicate IDs as a source error, not cross-source merging.
JSON parsing is size bounded and validates types. Render text as text; sanitize
HTML with a restrictive allowlist; strip scripts, handlers, forms, unsafe URLs and
active embeds. No automatic external resource loading from feed HTML; remote-media
privacy policy requires review. No destination preview, link health probe or prefetch
on ingestion, refresh, hover or state writes.

### CORS, redirects, FIPS and conditional public adapter

Private direct browser fetch needs exact allowed Flight Deck origins and
Authorization preflight (`OPTIONS` is routing/preflight only, no private metadata).
Allow GET and required headers; emit `Vary: Origin`; never wildcard a credentialed
origin. CORS is not ACL. Use explicit NIP-98 Authorization, not ambient cross-origin
cookies. Expose only needed pagination/validator headers. Test browser and WMapp.

Authenticated source fetch MUST disable automatic redirects: never forward an
Authorization event, cookie or signing capability to a new URL. An approved origin
move requires registry revalidation and a newly signed exact target; no token reuse.
Public requests use no upstream reader credentials on the initial URL or redirects.

Selected FIPS service uses the consented endpoint/peer-pinned `window.fipsTransport`
capability; connection identity is logical, signing binds the selected actual
endpoint proven in WP0. Transport never signs or grants feed access. Revocation,
unavailable nodes and missing platform support fail closed: no HTTPS/DNS/proxy
fallback. Direct `.fips` WApp navigation is a separate WMapp route. How exact WApp
URL signing and graph-reader forwarding work over FIPS remains a proof requirement,
not an assertion that feed support is implemented.

**A1 is conditional**: public feeds without CORS may need a bounded Autopilot
adapter only if WP0 finds no supported existing transport. Endpoint/request shape
is intentionally unresolved. It authenticates the Flight Deck caller locally but
fetches only public HTTP(S) content, never impersonates a WApp reader, publishes,
or stores feed bodies in Tower. It MUST reject userinfo, non-HTTP(S) schemes,
localhost/private/loopback/link-local/reserved destinations (IPv4/IPv6, including
mapped addresses and cloud metadata), validate DNS and all redirect targets, pin
validated connection IPs to prevent rebinding, and retain TLS hostname validation.
Set explicit hop/time/decompressed-byte/concurrency/rate limits; proposed maxima
3 redirects, 10 seconds total, 2 MiB total. No environment proxy bypass, cookies,
Authorization or upstream credentials. Bound content-type and decompression;
normalizer still hardens XML/HTML. An adapter outage affects that source only.
It is required for universal no-CORS public support if chosen, not private Book of
Sand first delivery. Never route a selected FIPS private source through it.

## Open decisions before implementation

WP0 must ratify field names/version negotiation and list/state pagination;
portable connected-instance identity; path-mounted app URLs; signer freshness/replay;
actual-reader signing and graph-read delegation; HTTPS/FIPS binding and CORS proof;
public adapter need/interface/limits; public URL alias identity and weak RSS IDs;
private media policy and cache retention. T1 must ratify concurrency/mark-unread,
unsubscribe retained-state duration/forget behavior and event/hydration contracts.
W1 must ratify durable edition/history representation and pagination consistency.
Unknown major list versions fail with unsupported-contract status; additive optional
fields are ignored. Changing source/item identities requires explicit migration.
None of these choices is supplied by existing publication grants.

## Work packages and acceptance gates

| Package | Owner / dependency | Acceptance evidence required later |
| --- | --- | --- |
| WP0 | Flight Deck + Book of Sand, Autopilot support; first | Ratified schemas/fixtures; actual-reader and forbidden-reader HTTPS/FIPS requests; CORS preflight; exact URL proof; open decisions closed |
| T1 | Tower; WP0 | Actor-isolated CRUD/state, idempotency, row conflicts, events, pagination and reconnect hydration; migrations/OpenAPI/tests |
| W1 | Book of Sand; WP0 | ACL list/feed, graph-preserving projection, durable history without publisher, stable IDs/headline routes; CORS/paging |
| F1 | Flight Deck; WP0/T1/W1 fixtures | Separate bounded fetcher, Tower state sync, Dexie partitions; revocation, replay, parsing/outage proof |
| F2 | Flight Deck; F1, fixture work possible earlier | Discovery across connections, subscribe/public URL/mobile/desktop UI; deliberate click only; liveQuery |
| A1 | Autopilot; WP0 decision, conditional | No-CORS podcast, DNS/redirect SSRF rejection, no upstream credentials, large/slow bounds |
| M1 | Book of Sand + Flight Deck + Tower; T1/W1/F1/F2 | Historical mapping, one-card cutover, verified edition with publisher off, retained legacy records and rollback |
| R1 | Integration manager; M1 and required transports | Authorized activation and served build evidence, two-reader/two-client/browser/WMapp/FIPS/public feed acceptance |

Required test matrix (specified here, **not executed or passed by documentation**):

1. Two readers with different app/graph rights: list and direct feed ACL independently;
   forged npub, wrong URL/query/method, stale/signature failures; workspace/actor
   isolation on state reads, writes, events and cursors; bot cannot claim owner.
2. Two clients for one reader: subscribe deduplication, state propagation, edited
   item stable ID, repeated mutations, offline replay, independent-field conflict,
   unsubscribe/reconnect without resurrection; second reader sees no private state.
3. Revoke access during an in-flight fetch, then switch account/workspace: private
   bodies disappear, late success is rejected, shared caches empty; graph narrowing
   cannot leak broader app credentials; 304 cannot bypass denial.
4. Outage of one Autopilot/feed/Tower, overlapping refresh, duplicate/malformed IDs,
   large pages and pagination loops; other sources continue; bounded recovery and
   visible freshness/error; no destination request until one intentional click.
5. Public JSON/RSS and podcast enclosure: CORS and no-CORS chosen transport; XML
   entity/script/unsafe-URL payloads, DNS rebinding, IPv6/private/metadata redirects,
   compressed bombs and timeout; zero reader credentials upstream; no autoplay.
6. Historical Book of Sand mapping and rollback: replay/edited headline retains
   reliable state; report unmappable entries; one visible card; durable history
   after scoped publishing disabled; rollback restores one card without new research.
7. R1 handoff identifies source commit hashes, Flight Deck absolute build number
   and served `version.json`, health/live tests and rollback evidence. Future UI
   changes must report Playwright performance baseline numbers. Required runtime
   activation/build tests belong to implementation jobs with separate authorization;
   this docs-only job changes no build number and restarts/deploys nothing.

Starter follow-up after W1: reusable exact-URL verifier, deny-by-default ACL hook,
feed fixtures and contract tests in WApp templates, as a separately scoped task.
