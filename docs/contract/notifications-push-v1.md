# Notification push delivery v1 — wire contract

Extends `notifications-v1.md` (shared inbox). The inbox is the record of truth; push is a **prompt to sync**: a visible
APNs alert that carries routing ids only, never private content by default. Clients always re-fetch the item with their own
credentials and Tower re-checks access on every read.

All routes live under `/api/v4/flightdeck-pg`, are NIP-98 authenticated, require an active workspace membership, are
`Cache-Control: private, no-store`, and return `{ identity, ... }` on success or `{ error, code, status, identity }` on failure.
The owner of every row is the **verified NIP-98 actor** — never a body field. The public client label (`client_app_id`) is
presentation routing only and is not an attestation.

## 1. Registry routes

Workspace-scoped (canonical):

| Method / path | Purpose |
|---|---|
| `PUT /workspaces/:w/notifications/installations/:installationId` | Register/update an installation for the caller and **enroll workspace `w`**. |
| `DELETE /workspaces/:w/notifications/installations/:installationId` | Remove workspace `w` from the enrollment. When no workspace remains, the installation and all its transports are `revoked`. `404 installation_not_found` when the caller has no active row. |
| `PUT /workspaces/:w/notifications/installations/:installationId/transports/:kind` | Register/renew a transport (`kind` = `apns`). Requires `w` enrolled (PUT the installation first). |
| `DELETE /workspaces/:w/notifications/installations/:installationId/transports/:kind` | Revoke the transport (all workspaces: a push address is installation-wide). `404` when none active. |

Compatibility alias (the path shipped Apple clients call; installation is created implicitly):

| Method / path | Purpose |
|---|---|
| `PUT /workspaces/:w/notifications/apns-devices/:installationId` | Register/renew an APNs transport **and** enroll `w`. |
| `DELETE /workspaces/:w/notifications/apns-devices/:installationId` | Remove enrollment of `w`; revoke the transport once no workspace remains. 2xx or 404 both mean "nothing left to revoke". |

`:installationId` is a client-generated UUID persisted on the device. IDs are lowercased server-side.

### Installation body (`PUT .../installations/:id`)

```json
{ "client_app_id": "ambulando", "platform": "ios", "app_version": "1.0 (28)", "device_label": "iPhone", "permission_state": "granted" }
```

`client_app_id` slug `^[a-z][a-z0-9_.-]{0,63}$` (required); `platform` ∈ `web|ios|ipados|macos|android` (required);
`permission_state` ∈ `granted|denied|unknown` (default `unknown`; `denied` suppresses alerts); `app_version`, `device_label` optional ≤ 64 chars.
Unknown keys → `400 validation_error`.

### APNs transport body (`PUT .../transports/apns` and the alias)

```json
{ "device_token": "<64..200 hex chars>", "environment": "sandbox", "bundle_id": "studio.otherstuff.ambulando.native", "preview": "generic", "lease_seconds": 604800 }
```

* `device_token` lowercase hex 64–200 chars (stored hashed for uniqueness; never returned, never logged).
* `environment`: **`sandbox` | `production`** (the Apple client enum). `development` is accepted as an alias and normalised to `sandbox`
  (`aps-environment=development` ⇒ `sandbox`; TestFlight/App Store ⇒ `production`). Sandbox tokens go to `api.sandbox.push.apple.com`,
  production to `api.push.apple.com`; a token is never sent to the other host.
* `bundle_id` must be on the server allow-list (the configured `APNS_TOPIC`, optionally `APNS_EXTRA_TOPICS`). Otherwise `400 bundle_not_allowed`
  (enforced once a provider is configured; before that the format is only checked and the allow-list is enforced again at dispatch).
* `preview`: `generic` (default) | `full`. `full` only takes effect together with an explicit alert rule `preview:"full"` (see §4).
* `lease_seconds`: 1…2 592 000 (default 604 800 = 7 d). **Delivery stops at lease expiry** unless renewed by another PUT.
* Alias only: optional extra keys `client_app_id`, `platform`, `app_version`, `permission_state`, `device_label` (same rules as above).
  Defaults when absent: `client_app_id` = the server's bundle mapping (`ambulando` for the primary topic), `platform` = `ios`, `permission_state` = `unknown`.
  The alias does **not** change `permission_state` of an existing installation unless it is sent.

### Response (transport PUT and alias PUT)

```json
{
  "identity": { "...": "..." },
  "installation": { "installation_id": "…", "client_app_id": "ambulando", "platform": "ios", "permission_state": "granted", "status": "active", "enrolled_workspace_ids": ["…"] },
  "device": {
    "installation_id": "…", "kind": "apns", "environment": "sandbox", "bundle_id": "…", "preview": "generic",
    "status": "active", "token_suffix": "a1b2c3", "lease_expires_at": "2026-11-03T12:00:00.000Z"
  },
  "delivery": { "ready": false, "reason": "provider_not_configured" }
}
```

* `device.lease_expires_at` is ISO-8601 with milliseconds (`ISO8601DateFormatter` + fractional seconds). The full token never appears anywhere in a response.
* `delivery.ready=false` + `reason` is the **truthful** state: the registry works without a provider, but no alert is queued while it is false.
  Reasons: `provider_not_configured`, `environment_not_enabled`, `permission_denied`. Clients should show this state rather than "notifications on".
* `DELETE` returns `{ identity, revoked: true, remaining_workspace_ids: [...] }` (installation route) or the same shape (alias).

### Ownership and errors

| Situation | Result |
|---|---|
| installation id already owned by another actor | `409 installation_owned` |
| device token already registered to another actor whose row is `active` and un-expired | `409 transport_owned` (no steal; audited). A `revoked`/`stale`/lease-expired row is released and the token may be claimed. |
| same actor registers a token already held by another of its installations | token is moved to this installation; the old one is superseded |
| `kind` other than `apns` (`webpush`, `fcm`) | `400 transport_not_implemented` |
| actor not an active member of `w` | `403 workspace_membership_required` |
| transport PUT before installation enrolled `w` | `409 workspace_not_enrolled` |
| bad body | `400 validation_error` |

One active transport per installation: registering a new token supersedes the previous one (`status:'revoked'`).
A registration never changes another actor's row. A stale/revoked/expired transport **never delivers**.

## 2. Descriptor

`notifications` in the workspace descriptor gains:

```json
{ "transports": ["apns"], "alerts": true,
  "transport_status": { "apns": { "ready": true, "environments": ["sandbox","production"] } },
  "push_envelope_v": 1,
  "links": { "installations": ".../notifications/installations", "apns_devices": ".../notifications/apns-devices" } }
```

`transports` lists only kinds that are **implemented**; FCM and Web Push are not advertised (legacy Web Push keeps working through its existing
subscription routes and is not in this registry). `alerts` and `transport_status.apns.ready` are true only when the APNs provider is fully configured.

## 3. Push envelope (APNs, `apns-push-type: alert`)

Headers: `apns-push-type: alert`, `apns-priority: 10`, `apns-topic: <bundle_id>`, `apns-collapse-id` (≤ 64 bytes, derived from the item group),
`apns-expiration: <unix deadline>`, `authorization: bearer <ES256 JWT>`.

```json
{
  "aps": { "alert": { "title": "New activity", "body": "" }, "sound": "default", "thread-id": "<group key or source>", "badge": 3 },
  "fd": {
    "v": 1,
    "origin": "https://tower.example",
    "workspace_id": "<uuid>",
    "category": "mention",
    "channel_id": "<uuid>", "thread_id": "<uuid>", "task_id": "<uuid>", "doc_id": "<uuid>",
    "notification_id": "<item uuid>",
    "change_seq": 4812,
    "source_app_id": "flightdeck.core"
  }
}
```

* `fd` is the Apple `PushPayload` v1: `v`, `origin` (https), `workspace_id` required; id keys are UUIDs or **absent** (never null, never malformed);
  `category` string. `notification_id`, `change_seq`, `source_app_id` are additive. Only the ids relevant to the item are present.
* Not a silent push: no `content-available`; `aps.alert` + `sound` always present.
* `badge` is the recipient's badge count for the installation's `client_app_id` in this workspace (`getCounts().badge`), only when the installation is
  enrolled in exactly one workspace; otherwise omitted (no cross-workspace aggregation).
* Default visible text is generic (`"New activity"`, empty body). No actor names, titles, message text or producer group keys leave Tower unless §4 allows.

## 4. Preferences and previews

* Per-app alert preference reuses `PUT /notifications/rules` with `channel:"alert"`. A rule with `client_app_id:"<app>"` beats `"*"` (most specific
  wins; `off` wins within a level). Defaults come from the category registry (`default_alert`).
* Content preview: the alert shows item text only when the transport has `preview:"full"` **and** the resolved alert rule has `preview:"full"`. Body is bounded
  to 120 characters. `sender` is treated as `generic` for APNs in v1.

## 5. Delivery semantics

* One alert per `(item, transport, generation)`. A folded item re-alerts under a new generation (same `apns-collapse-id`, so the OS replaces it).
* Alerts are created in the same transaction as the item write, only for transports that are active, lease-valid, enrolled in the item's workspace, whose installation
  belongs to the recipient, whose `client_app_id` is in the item audience, whose permission is not `denied`, with the alert rule on, **and** whose APNs environment is enabled.
* The worker re-checks, after claim and before every provider call: transport/installation/lease/enrollment/membership, item exists, unread, not removed/expired,
  record access (`flightdeck_pg_record_access`), source grant, audience and alert rules. Any failure → alert `suppressed` with a reason; nothing is sent.
* Write-ahead attempt row before the HTTP/2 call. At-least-once, never exactly-once; a crash between send and ack may duplicate (same collapse id).
* Retry (30 s, 2 m, 10 m, 1 h, 6 h, ±20 %), max 6 attempts or `deadline_at` (min(item expiry, created + 24 h)). `410`/`BadDeviceToken`/`Unregistered`/`DeviceTokenNotForTopic`
  mark the transport `stale` and the alert `dead`. `403 InvalidProviderToken`/`ExpiredProviderToken` open a circuit breaker (credential problem) and the alert is retried later.
* Reading/archiving/dismissing an item **withdraws pending** alerts (`suppressed: read_before_send`); an alert already delivered to the device is not recalled.
* Provider credentials: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_AUTH_KEY` (or `APNS_AUTH_KEY_FILE`, read via `secretEnv`), `APNS_TOPIC`. Missing any ⇒ APNs is **not ready**,
  alerts are not queued and `delivery.ready=false`.

## 6. Fixtures

```http
PUT /api/v4/flightdeck-pg/workspaces/6f0c1c0e-7a43-4c37-9a52-0a1d3b6f0c11/notifications/apns-devices/0b8c3c5e-52a1-4e2b-8d6f-1a2b3c4d5e6f
{"bundle_id":"studio.otherstuff.ambulando.native","device_token":"<64 hex>","environment":"sandbox","lease_seconds":604800,"preview":"generic"}
```
→ `200` as in §1; repeat PUT = renewal (same row, new `lease_expires_at`). Other actor same token → `409 {"code":"transport_owned"}`.
`DELETE` same path → `200 {"revoked":true,...}`; a second `DELETE` → `404 installation_not_found`.

APNs request body for a mention (generic): `{"aps":{"alert":{"title":"New activity","body":""},"sound":"default","thread-id":"mention:thread:…"},"fd":{"v":1,"origin":"https://tower.example","workspace_id":"6f0c1c0e-…","category":"mention","thread_id":"…","notification_id":"…","change_seq":12,"source_app_id":"flightdeck.core"}}`.
