# Notifications v1 — `org.wingman.nstack.notifications`

Tower is the authority. NStack advertises the capability (`notifications.inbox.v1`
in `GET /.well-known/nstack.json` and `notifications.inbox_v1` in the workspace
descriptor); it is not a separate service. A notification is a **durable,
actor-private, per-workspace inbox item** shared by every consuming application.
OS push is an optional transport and is **not part of this release** (see
"Implemented / not implemented").

Base: `/api/v4/flightdeck-pg/workspaces/{workspaceId}`. Every route needs NIP-98 and
active workspace membership. Responses are `Cache-Control: private, no-store`.
Bodies ≤ 16 KiB; unknown body fields are rejected (`400 validation_error`).
Errors use the Flight Deck PG shape
`{ "error": "<message>", "code": "<code>", "status": <n>, "identity": {...}, ... }`.
Actor identity comes only from NIP-98; there is no actor override. `app_npub`
is **not** an application discriminator. `source_app_id` (producer) and
`client_app_id` (consumer) are separate identifiers.

## Item — `org.wingman.notification.item` v1

```json
{
  "schema": "org.wingman.notification.item", "version": 1,
  "id": "uuid", "workspace_id": "uuid", "recipient_actor_id": "uuid",
  "change_seq": 12, "row_version": 3,
  "source": { "app_id": "flightdeck.core", "label": "Flight Deck", "kind": "tower_rule" },
  "category": "mention",
  "reasons": ["mention", "chat_thread"],
  "severity": "low|normal|high|critical",
  "status": "active|resolved",
  "origin": "live",
  "group": { "key": "mention:thread:<id>:w<window>", "event_count": 2 } ,
  "actor": { "actor_id": "uuid|null", "display_name": "Rick|null", "kind": "human|agent|app|service|null" },
  "subject": { "kind": "thread|channel|task|doc|app_object|workspace", "scope_id": null, "channel_id": null,
               "thread_id": null, "task_id": null, "doc_id": null, "message_id": null, "comment_id": null,
               "activity_version": null },
  "presentation": { "title": "Rick mentioned you", "body": "Thread title", "icon": "mention", "push_preview": "generic" },
  "action": { "type": "open", "target": { "kind": "thread", "channel_id": "…", "thread_id": "…", "message_id": "…" } },
  "audience": { "client_apps": ["*"] },
  "occurred_at": "ISO", "updated_at": "ISO", "expires_at": "ISO|null",
  "state": { "read": false, "read_at": null, "read_reason": null, "dismissed": false, "archived": false },
  "access": "ok"
}
```

* `reasons` lists every rule that selected the recipient. `category` is the highest
  precedence reason: `security > approval > dm > mention > task_assignment >
  comment_tag > chat_thread`. One source event yields **at most one item per recipient**.
* `read_reason`: `user | bulk | subject_viewed | already_viewed | resolved | null`.
* Unknown `subject.kind`/`target.kind`/future `version` ⇒ clients render a generic
  card and never crash. `action.target` is a typed target, never a path or URL.
* `access:"unavailable"` appears only on `GET items/{id}` (presentation replaced by
  `{"title":"Item no longer available","body":""}`, `action:null`); lists never contain
  inaccessible items. `icon` is a hint. Presentation text for `app_object` subjects is
  always a registry generic template (`title` = source label, `body` = category label).
* A **tombstone** (in `changes` only) is content-free:
  `{ "schema":"org.wingman.notification.tombstone","version":1,"id","workspace_id","change_seq","change_type":"remove","removal_reason":"access_lost|subject_deleted|withdrawn|source_revoked|expired" }`.

Core categories (`flightdeck.core`, built in): `chat_thread`, `mention`, `dm`,
`comment_tag`, `task_assignment`. Inbox defaults on for all; alert defaults
(stored for future delivery) on except `chat_thread`.

### Folding

A new event folds into the recipient's **open** item (unread, not dismissed or archived)
with the same `group.key`; otherwise a new item is created. Fold increments
`event_count`, sets `subject.activity_version = max(...)`, refreshes presentation, bumps
**`row_version` and `change_seq`**. Read/dismissed/archived items are never mutated by a
new event. Group keys: `chat_thread:thread:<id>` / `chat_thread:channel:<id>`;
`mention:thread:<id>:w<n>` where `n = floor(occurred_epoch/600)` (10-minute window);
`mention`/`comment_tag`/`task_assignment` on tasks/docs `:<kind>:<id>`; `dm:thread|channel:<id>`.

**Folding identity** is `(source, group_key, canonical audience set)`: an event never folds
into an open item whose `audience.client_apps` differs (a different audience yields a separate
item). Otherwise a client-app-filtered change feed could keep a previously visible item stale
when the audience changes without a tombstone. An open `task_assignment` item for a task
absorbs further assignment events for that task (explicit assign route and task metadata both
announce one assignment) without incrementing `event_count`.

## Multi-app view (`client_app_id`, v1.1)

`client_app_id=<slug>` is a **presentation filter, never access authority**. It is accepted
on `GET items`, `GET counts`, `GET changes` and as `selector.client_app_id` on `POST bulk`
(slug `^[a-z][a-z0-9_.-]{0,63}$`; `*` is not a client). Omitted ⇒ no app filtering.

An item is *visible to client C* iff `'*' ∈ audience.client_apps` **or** `C ∈ audience.client_apps`,
**and** the effective `inbox` rule for `(source, category, C)` is not `off`. Effective rule: most
specific key wins, level order `(src,cat) > (src,*) > (*,cat) > (*,*)`; within a level a rule with
`client_app_id=C` beats `client_app_id='*'`; `mode:"default"` rows are ignored (inherit). The
same SQL predicate drives list, counts, badge, changes and bulk, so list == count.

Item projection (creation) honours only `client_app_id='*'` rules because the item is shared. A rule with
`client_app_id=C, channel=inbox, mode=off` hides the item from C's views only; it never deletes, reads or
tombstones the shared item, other apps still see it, and read state stays shared (one `row_version`).
`badge` = visible-to-C, unread, severity ≥ normal (with no `client_app_id`: shared-audience items).

### Convergence: `rules_revision`
Every recipient has a `rules_revision` (integer, starts 0) bumped in the transaction of **every** rules
write (`PUT rules` and the legacy preference mirror). It is returned by `GET rules`, `GET items`, `GET counts`
and `GET changes`. A client keeps the value current at snapshot time and sends
`changes?after_seq=N&rules_revision=R`. If `R` ≠ current ⇒ `410 {"code":"reset_required","reason":"rules_changed","head_seq","rules_revision"}`:
redo snapshot-then-replay with the new value and re-fetch rules. Clients that do not send it must re-snapshot
whenever the `rules_revision` of any response changes.

## Consumer routes

### `GET /notifications/items`
Query: `view=inbox|unread|archived|dismissed|all` (default `inbox`), `category`,
`source_app_id`, `client_app_id`, `limit` (1–100, default 50), `cursor`. Unknown query ⇒ 400.
Newest-first (`occurred_at DESC, id DESC`).
```json
{ "identity": {…}, "items": [Item], "next_cursor": "opaque|null",
  "head_seq": 4815, "rules_revision": 3, "counts": { "unread_total": 7, "capped_at": 999 },
  "inbox_started_at": "ISO" }
```
`head_seq`, `rules_revision`, the page and `counts` are read in one snapshot. Cursor is opaque, HMAC-bound to
`(workspace, actor, route, filters)`, 7-day expiry; malformed/mismatched ⇒ `400 invalid_cursor`.
`view=inbox` = not removed/dismissed/archived. `unread` = inbox ∧ active ∧ unread.

### `GET /notifications/items/{id}`
`{ "identity", "item": Item }`. Another actor's / workspace's id ⇒ `404 notification_not_found`.
Tombstoned ⇒ `{ "item": <tombstone> }` with status 200.

### `GET /notifications/changes?after_seq=N&limit=200&client_app_id=&rules_revision=`
Ascending per-recipient `change_seq`, limit ≤ 200 (default 200).
```json
{ "identity": {…}, "changes": [Item | Tombstone], "through_seq": 4820, "head_seq": 4830, "rules_revision": 3, "has_more": true }
```
`through_seq` is the last returned row's `change_seq` when `has_more`, otherwise `head_seq`
(floor, head, `rules_revision` and rows are read in one `REPEATABLE READ` snapshot), so a page whose rows
were all filtered out by `client_app_id` still advances. With `client_app_id`, live items not visible to
that client are omitted; tombstones (content-free) are always included. `changes` returns **every** transition (any
partition) including dismissed/archived state flags; items entering a non-hydrated
partition may be ignored by clients (advance `local_seq` regardless). Each entry carries the
item's latest state; an item changed twice appears once (at its latest `change_seq`).
Items that became inaccessible between sweeps are tombstoned **before** the response is built.
`410 reset_required` (`code:"reset_required"`, `reason: "rules_changed" | "tombstone_floor" | "ahead"`,
plus `head_seq`, `rules_revision`) when `rules_revision` is supplied and stale, `after_seq` is below the
recipient's `tombstone_floor_seq`, or `after_seq` is above `head_seq`: redo cold start.

**Cold start (snapshot-then-replay):** page `items?view=inbox` until `next_cursor:null`
keeping `S = head_seq` of the **first** page; then `changes?after_seq=S` until
`has_more:false`, applying idempotently by `(id, change_seq)`. Set `local_seq` to the
last applied `through_seq`. Steady state: SSE hint → `changes?after_seq=local_seq`.

### `GET /notifications/counts?installation_id=&client_app_id=`
```json
{ "identity", "unread_total": 7, "by_category": {"mention":2}, "by_source_app": {"flightdeck.core":7},
  "badge": 3, "capped_at": 999, "head_seq": 4820, "rules_revision": 3, "inbox_started_at": "ISO" }
```
Same visibility predicate as `items` (list == count under revocation and under `client_app_id`).
`unread_total`, `by_category`, `by_source_app` count active, unread, not dismissed/archived/removed
items visible to the client app. `badge` = those with severity ≥ normal (see Multi-app view).
`installation_id` is accepted and ignored (installation registry is not implemented). Counts cap at 999.

### `PATCH /notifications/items/{id}`
```json
{ "mutation_id": "uuid", "expected_row_version": 3, "patch": { "read": true, "dismissed": false, "archived": false } }
```
`patch` has ≥1 of `read|dismissed|archived` (booleans). `dismissed:true` and `archived:true`
also set read (`read_reason` kept if already read else `user`). `read:false` clears `read_at`.
Optional `observed_change_seq`: if present and `< item.change_seq` ⇒ 409 `state_conflict`.
`200 { "item": Item }` with new `row_version`/`change_seq`.
`409 state_conflict { "item": Item }` (stale `expected_row_version`; reload and re-apply
the intent with a **new** `mutation_id`). `409 mutation_id_reused` when the same
`mutation_id` is sent with a different request; an identical retry returns the
original acknowledgement (replay-safe). `404 notification_not_found`. A no-op
patch (state already as requested) succeeds without bumping versions.

### `POST /notifications/bulk`
```json
{ "mutation_id":"uuid", "op":"mark_read|mark_unread|dismiss|archive|unarchive",
  "selector": { "ids":["uuid", …≤200] } }
{ "mutation_id":"uuid", "op":"mark_read", "selector": { "up_to_seq": 4815, "view":"inbox|unread|…", "category":"mention", "source_app_id":"…", "client_app_id":"…" } }
```
With `selector.client_app_id` only items visible to that client are touched.
`up_to_seq` applies only to items with `change_seq <= up_to_seq` at execution; newer
(concurrently folded/created) items stay untouched. Capped at 5000 rows. Response
`{ "identity", "affected": n, "through_seq": head_after, "mutation_id" }`; same-`mutation_id`
retry returns the stored response.

### `GET /notifications/categories`
`{ "identity", "sources":[{ "app_id","label","kind", "categories":[{ "category","label","default_severity","default_inbox","default_alert","mandatory","grouping" }] }] }`
Includes `flightdeck.core` plus active workspace sources.

### `GET /notifications/rules`, `PUT /notifications/rules`
Preference rules for the caller in this workspace. Rule key
`(source_app_id, category, client_app_id, channel)`; `*` is a wildcard for the first three;
`channel` is `inbox|alert`; `mode` is `on|off|default`; `preview` (`generic|sender|full`, alert only).
```json
GET → { "identity", "rules":[{ "source_app_id":"flightdeck.core","category":"mention","client_app_id":"*","channel":"inbox","mode":"off","preview":null,"row_version":2 }], "rules_revision": 3 }
PUT { "mutation_id":"uuid", "rules":[ {…key, "mode":"off|on|default", "preview":null, "expected_row_version": 2} , …≤50 ] }
  → 200 { "identity", "rules":[…all…], "rules_revision": 4 }
```
**Per-key compare-and-swap, all or nothing (no last-writer-wins).** `expected_row_version` is required per
rule: the `row_version` of the same key in the last `GET` (`0` if the key was absent). A key may appear once per request.
`mode:"default"` means *inherit*: Tower keeps a **versioned row** (its `row_version` still increments, it is never
physically deleted) that resolves exactly like an absent rule, so a stale `expected_row_version: 0` can never
resurrect an overridden value. `default` needs an existing rule (`expected_row_version ≥ 1`, else `400`).

If any key is stale ⇒ `409 { "code":"rules_conflict", "conflicts":[{ source_app_id, category, client_app_id, channel,
expected_row_version, "current": Rule|null }], "rules":[all current], "rules_revision" }` and **nothing is written**; the
client rebases its intent on `rules` and retries with a **new** `mutation_id`. An identical retry of a successful PUT
(hash includes expected versions) returns the stored 200; the same `mutation_id` with a different body ⇒
`409 mutation_id_reused` (a semantic rejection, not a retry).

`inbox:off` with `client_app_id:"*"` stops item creation for that recipient (and hides existing matching items from
every client view); `client_app_id:"<app>"` hides only that app's view (see Multi-app view). **Mandatory** categories ignore
`off`. The `alert` channel is stored and returned but there is no alert sender yet. Legacy booleans
(`chat_threads_enabled`…) are mirrored as `alert` rules for `flightdeck.core` in both directions; a PUT of `default`
on a core alert rule restores that category's registry default. `PATCH /notifications/preferences` writes the legacy
booleans, the mirrored alert rules (bumping their `row_version`) and `rules_revision` in **one transaction**, so a
client holding a stale `row_version` gets `rules_conflict` and refetches.

## Core event sources (Tower rules)

Captured transactionally from the outbox: `message.created/revised` (structured `mentions` /
`newly_added_mentions`), `task_comment.created`, `doc_comment.created` (carries its own `mentions`),
`task_assignment.assigned`, **`task.created`** (metadata `assigned_to_npub` ⇒ `task_assignment`; canonical
`mentions` ⇒ `mention`), **`task.updated`** (assignee only when `assignment.previous_npub ≠ current_npub`, an
emitter field added with this contract; mentions only `current − previous`) and **`document_mention_added`**
(document *body* mentions ⇒ `mention`, family `doc`). `document_comment_mention_added` is deliberately **not**
captured (it duplicates `doc_comment.created`). Recipients come only from structured payloads; ACL is rechecked live;
a text-only edit with no newly added mention yields no item. Tombstones also scrub `trigger_actor_id`,
`group_key`, `reasons`, `resource_id` and ACL columns. `withdraw` tombstones a whole folded item (v1 limit).

## Realtime hint

For each item change Tower writes an actor-private event on the existing
`events/stream`: `event_type:"flightdeck_pg.notification_item.changed"`,
`entity_type:"notification_item"`, `entity_id:<item id>`,
`payload:{ "recipient_actor_id", "change_seq", "operation":"created|updated|state|removed" }`.
**No title/body.** Treat as "call `changes?after_seq=local_seq` now". It is a hint
(cursor/ordering are not authoritative); managed/delegated audiences never receive it.

## Resource view bridge

* Inbox state **never** writes resource view state (read/dismiss/archive of an item does not mark the resource viewed).
* A resource-view write that advances `viewed_activity_version` to **W** (observed value the client
  rendered, not the head) marks read (`read_reason:"subject_viewed"`) every active unread item whose
  subject resolves to that resource and `subject.activity_version <= W`. Newer activity stays unread.
* Events whose `subject.activity_version <= viewed` at projection time are created already read
  (`read_reason:"already_viewed"`). The watermark is read **after** taking the recipient lock that the bridge
  also takes, so a view commit concurrent with projection can neither leave the new item unread when it was
  already viewed nor mark it read when the viewed version is lower.
* Feed item state and wapp activity are independent of inbox state.

## Producer routes (external apps)

Producer identity is the NIP-98 signer bound to a workspace-registered source. `source_app_id`
is **derived** from the binding; a body `source_app_id` must equal it (else `403 source_mismatch`).
`flightdeck.core` and `mandatory` categories are refused (`403 reserved_source`).

```
GET  /notification-producers/grants/me
POST /notification-events                       201 accepted | 200 replayed
GET  /notification-events/{eventId}             producer-visible status (own events)
POST /notification-events/{eventId}/withdraw
```
Event body (`org.wingman.notification.event` v1):
```json
{ "schema":"org.wingman.notification.event","version":1,
  "event_key":"<1-128 [A-Za-z0-9:_.-]>", "op":"publish|resolve|withdraw",
  "category":"capture_delivery_failed", "severity":"low|normal|high",
  "occurred_at":"ISO", "subject":{"kind":"app_object","app_id":"blinkers","object_type":"capture","object_id":"…"},
  "recipients":{"mode":"actors","actor_ids":["uuid"]},
  "audience":{"client_apps":["*"]}, "group_key":"capture:7c1e", "target_event_key":"<for withdraw>",
  "action":{"type":"open","target":{"kind":"app_object","app_id":"blinkers","object_type":"capture","object_id":"…"}},
  "expires_at":"ISO" }
```
Only `app_object` (and `workspace`) subjects are accepted from external producers in v1.
Presentation is always the registry generic template (extra producer text is dropped; response has
`presentation_downgraded:true` if `presentation`/`title`/`body` were supplied). Recipients must be
active workspace members **and** inside the grant's `allowed_recipient_mode`
(`actor_list` ⊆ `allowed_recipient_actor_ids`, or `owner_only`). Same `event_key`+same canonical hash ⇒
`200 replayed`; different hash ⇒ `409 event_key_reused`. `resolve` marks the source's open items with the
same `group_key` resolved+read (no alert); `withdraw` (`target_event_key`) tombstones items created from that
event. Errors: `403 category_not_granted | recipient_not_allowed | source_mismatch | reserved_source |
source_not_active`, `413 payload_too_large`, `429 rate_limited` (Retry-After).
Response: `{ "event": { "id","state":"accepted","event_key" }, "replayed": false, "recipient_count"? }` —
never per-recipient detail. Producers cannot read any inbox.

Source lifecycle (effective `workspace.manage` only, via `authorizeFlightDeckPgOperation`; direct/group/role
grants count, a bare owner/admin role does not; denial is the Flight Deck PG `403 permission_denied` with
`required_permission:"workspace.manage"`; there is no owner/admin fallback):
```
GET  /notification-sources                     PUT /notification-sources/{sourceAppId}
POST /notification-sources/{id}/disable        POST /notification-sources/{id}/revoke
GET  /admin/notifications/queue                (workspace.manage: depth, oldest age, dead count)
```
`PUT` body: `{ "kind":"agent|app|wapp_installation", "display_name", "producer_signer_npub", "allowed_categories":[{"category","label","default_severity","grouping"}], "allowed_recipient_mode":"actor_list|owner_only", "allowed_recipient_actor_ids":[…], "max_severity", "rate_per_minute", "allowed_client_apps":["*"] }`.
`allowed_recipient_actor_ids` must all be workspace members (`400 recipient_not_member`).
`revoke` stops new events immediately and tombstones the source's existing items (`source_revoked`).

## Legacy compatibility

`/notifications/{config,settings,preferences,subscriptions,deliveries}` and the
Web Push sender are unchanged in shape. Hardening: `POST …/evaluate` now rejects event ids from
another workspace (`404 event_not_found`) and requires effective `workspace.manage`; push
subscription upsert refuses to re-bind an endpoint owned by another actor (`409 transport_owned`).

## Implemented / not implemented in this release

Implemented: everything above. **Not implemented (404/absent, deliberately):** alert worker and
transports (Web Push migration, APNs, FCM), installation/transport registry
(`/me/notifications/installations…`), quiet hours (`/me/notifications/quiet-hours`),
subject mutes, entitlement leases (`acl_mode` is always `metadata_only`), silent baseline
import (inbox starts empty at activation; `inbox_started_at` reports when), record-subject
external events, scoped WApp inbox grants, delegated agent inbox read. Clients must treat
these as `backend-not-supported` and keep in-app notifications fully functional.

## Retention (defaults applied by the maintenance worker)

Read/dismissed/resolved items purged 90 days after last update; unread low/normal expire
after 180 days (tombstoned `expired`); high/critical after 365; archived after 2 years; tombstones
kept 30 days then `tombstone_floor_seq` advances (older cursors get `410 reset_required`); events 180
days; intake `done` rows 14 days.

## Delivery guarantees

At-least-once projection with idempotent receipts `(event, recipient)`; no exactly-once
promise for any transport. `change_seq` is allocated under a per-recipient row lock, so sequence
order equals commit order for that recipient. Canonical lock order for every writer of a recipient's inbox:
mutation advisory lock → recipient cursor lock (`flightdeck_pg_notification_lock_recipient`) → item rows (by id) →
`next_seq`; multi-recipient writers (resolve, withdraw, source revoke, maintenance, projection pages) lock
recipients ascending, so item PATCH/bulk/view-bridge/projection/tombstone cannot deadlock.
