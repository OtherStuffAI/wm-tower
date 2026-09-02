# Delegated WApp creation, installation, assignment, and management

Status: proposed cross-repo contract, 2026-08-11
Audience: Tower, Flight Deck, and Autopilot implementers
This reusable design uses synthetic Operator, Agent, workspace, and installation examples.

## User-visible outcome

Operator can grant Agent a time-limited authority to create or select an Autopilot app, install it as a WApp, add its launcher to **Operator's** Flight Deck, and optionally publish WApp activity to explicitly selected Feed destinations. Before installation Operator sees the requested app, version, launch origin, publisher identity, destinations, and capabilities. Agent can complete and repair only those WApp operations covered by the grant. Operator can revoke the delegation or an individual installation immediately and can distinguish Operator, Agent, and the WApp publisher in the audit history.

Agent does **not** become workspace owner or workspace manager. He cannot manage people, groups, scopes, arbitrary channels, unrelated launchers, storage, billing, workspace keys, other WApps, or general records. A WApp installation does not acquire those powers either.

## 1. Responsibility boundary

| System | Owns | Must not own |
| --- | --- | --- |
| Autopilot | App template and app registry; source/root and build/version; process install/start/stop; alias and launch URL; stable installation ID; WApp publisher key held by the managed runtime; runtime assignment and health | Workspace authority, Flight Deck ACL decisions, Feed destination approval, or the canonical personal launcher/grant record |
| Tower | Workspace and owner identity; delegation grants and authorization; install intents and lifecycle projection; workspace app registration; canonical installation-to-workspace binding; personal-WApp launcher; Feed publishing grant/destinations/origins; audit and reconciliation facts | Building apps, managing processes, exporting publisher secrets, or inventing app-local records |
| Flight Deck | Owner/delegate management UI; install wizard and capability preview; status, repair/reconcile, revoke/uninstall requests, and audit presentation; Dexie materialization of Tower responses | Direct Autopilot database/process mutation, authorization decisions, or a second installation registry |

The architecture board's boundary remains intact: Flight Deck coordinates, Autopilot does the work, and Tower tracks and mediates shared state. Tower typed PG APIs plus SSE/outbox are the workspace contract; Dexie is a materialized view, not authority.

## 2. Canonical identifiers and lifecycle

### Identifiers

| Field | Authority and meaning |
| --- | --- |
| `app_id` | Autopilot registry ID for a concrete managed web app. It is not an installation. |
| `app_template_id` | Optional stable template/catalog ID. Required only when creating from a template; a template version resolves to an `app_id` after creation. Do not overload `app_id`. |
| `app_version` | Immutable Autopilot build/version reference (prefer digest or version ID, not a mutable label). Tower records requested and observed versions. |
| `wapp_installation_id` | Stable UUID generated once by Autopilot or supplied from the Tower intent; used across all three systems. Reinstall/upgrade retains it. A new independent install gets a new UUID. |
| `personal_wapp_id` | Tower UUID in existing `flightdeck_pg_personal_wapps`; the Operator-owned launcher. Add an explicit nullable `wapp_installation_id` column and a unique partial key `(workspace_id, owner_actor_id, wapp_installation_id)` rather than relying on JSON metadata. |
| `publisher_npub` | Per-installation WApp publishing identity derived inside Autopilot. It is bound in existing `flightdeck_pg_wapp_installations`; it is neither Operator nor Agent. Rotation uses the existing proof/rotation path. |
| `owner_npub` / `owner_actor_id` | Operator's workspace identity and membership actor. Never replace these with Agent on delegated operations. |
| `actor_npub` / `actor_id` | Agent when he initiates an allowed operation, Operator for direct owner actions, or the WApp publisher for Feed writes. |
| `signer_npub` | Cryptographic signer seen on the request. Preserve separately from effective owner and actor. |
| `delegation_id` | Tower UUID of the owner-signed grant used for the operation; nullable for direct owner actions. |
| `intent_id` | Tower UUID for one install/manage saga. Repeated requests use the same intent via idempotency key. |

### Capabilities and filters

- Feed publishing capability remains `activity.publish` in `flightdeck_pg_wapp_publishing_grants`.
- `destinations` remain explicit `(scope_id, channel_id)` rows in `flightdeck_pg_wapp_publishing_destinations`; Tower verifies the channel still belongs to the scope and is available.
- `registered_open_origins` remain exact HTTPS origins, not URL prefixes, wildcards, or caller-provided arbitrary strings. The activity item's `open_url` may contain a path/query but its parsed origin must match.
- The launcher `launch_url` is the observed Autopilot URL. Its origin must be included in the approved origin set when Feed deep links are requested.

### State and versions

Add a Tower lifecycle projection to the existing installation row (or a one-to-one lifecycle table if altering the global installation row is unsafe):

`pending -> installing -> active -> failed | revoked -> uninstalled`

- `pending`: Tower accepted an owner/delegate-authorized intent.
- `installing`: Autopilot claimed the intent and supplied a request nonce.
- `active`: Autopilot attestation passed and Tower transactionally finalized the workspace binding, launcher, and optional Feed grant.
- `failed`: a step failed; retain intent, observed remote identifiers, error code, and repair action.
- `revoked`: Tower authority, launcher visibility, and Feed publishing are disabled immediately; runtime teardown may still be pending.
- `uninstalled`: Autopilot confirms process/assignment removal and Tower has archived the launcher and revoked the grant. Audit remains.

Use three independent monotonic versions: `intent_version` for lifecycle compare-and-set, existing launcher `row_version`, and existing publishing `grant_version`. Record `requested_app_version` and `observed_app_version`; reject activation or upgrade completion when they differ. Teardown never deletes audit/activity history. Existing Feed items remain readable with `source_status=revoked`, and open links follow the existing revoke/`disable_open_links` policy.

## 3. Narrow owner-signed delegation

Create a typed Tower workspace delegation resource signed by Operator and evaluated by Tower on every workspace mutation. Reuse a general delegation table if one exists by adding these scopes and filters; do not encode this in a personal-WApp metadata blob.

Proposed scopes:

- `wapp.intent.create`: request creation/install from an allowed template or app.
- `wapp.install.manage`: claim/status/retry/reconcile an installation created under this delegation.
- `personal_wapp.manage`: create/update/archive Operator's launcher only for allowed installation IDs.
- `wapp.publishing.manage`: create/replace/disable the Feed grant only for allowed installation IDs and destinations.
- `wapp.install.uninstall`: optional and preferably omitted initially; when present, it still requires step-up.

Required resource filters:

```json
{
  "workspace_id": "<workspace-id>",
  "owner_actor_id": "<Operator actor UUID>",
  "delegate_npub": "<Agent/automation-agent npub>",
  "autopilot_instance_origin": "https://agent.example.invalid",
  "app_template_ids": ["<approved templates, optional>"],
  "app_ids": ["<approved existing apps, optional>"],
  "installation_ids": ["<created/approved installs; Tower may append only as part of an approved intent>"],
  "destination_channel_ids": ["<explicit channels>"],
  "registered_open_origins": ["<exact HTTPS origins>"],
  "max_active_installations": 5,
  "allow_create_app_from_template": true,
  "allow_feed_publish": true
}
```

The grant has `not_before`, `expires_at`, `revoked_at`, `grant_version`, reason, owner signature payload hash, and optional operation count. Default expiry should be 24 hours for one-off work and no more than 30 days without renewal. Revocation takes effect at authorization time; an Autopilot claim or cached UI state cannot extend it.

Step-up owner approval is required for:

- any origin, destination, app/template, or installation outside the signed filters;
- adding a capability, increasing `max_active_installations`, or extending expiry;
- publisher substitution/rotation during install;
- installation from an untrusted template/source, a mutable/unpinned version, or a template that requests filesystem/environment/network powers beyond its manifest;
- destructive uninstall, deletion of app data, or changing an active install to a different `app_id`;
- making any launcher public or granting non-Feed Tower access.

Step-up creates a new owner-signed grant version or a one-operation approval bound to the normalized request hash; Agent cannot approve his own expansion.

Every audit event stores `owner_actor_id/owner_npub`, `actor_id/actor_npub`, `signer_npub`, `delegation_id`, `intent_id`, request hash, outcome, and before/after versions. Tower must never flatten a delegated request into “Operator acted.”

Explicit non-authorities: `workspace.manage`; membership/group/key management; scope/channel creation or ACL changes; arbitrary task/doc/message/storage/graph writes; billing/admin; Tower app registration unrelated to the intent; Autopilot admin or arbitrary app/process management; raw key export; changing Tower bindings; arbitrary origins/destinations; other owners' launchers; and creating channel messages as a side effect of Feed publication.

## 4. Tower API and data changes

### Routes

Under `/api/v4/flightdeck-pg/workspaces/{workspaceId}`:

- `POST /wapp-delegations` — Operator only; create an owner-signed grant.
- `GET /wapp-delegations` and `GET /wapp-delegations/{delegationId}` — Operator; delegate may read its own effective grant with secrets omitted.
- `POST /wapp-delegations/{delegationId}/revoke` — Operator only and immediately effective.
- `POST /wapp-install-intents` — Operator or authorized delegate; accepts desired app/template/version, launcher fields, destinations, origins, requested capabilities, Autopilot origin, and `client_request_id`.
- `GET /wapp-install-intents` and `GET /wapp-install-intents/{intentId}` — list/read authorized sagas, including repair hints.
- `POST /wapp-install-intents/{intentId}/claim` — Autopilot installation service identity; body contains one-time Tower challenge, stable installation ID, app ID/version, publisher npub, launch URL/origin, and attestation.
- `POST /wapp-install-intents/{intentId}/complete` — same claimed Autopilot identity; compare-and-set `intent_version`, revalidate delegation and attestation, then finalize.
- `POST /wapp-install-intents/{intentId}/fail` — record stable error and observed identifiers.
- `POST /wapp-installations/{installationId}/reconcile` — Operator/delegate in filter requests an asynchronous reconciliation; no caller-supplied state overwrite.
- `GET /wapp-installations` and `GET /wapp-installations/{installationId}` — joined lifecycle, launcher, publishing grant, and observed Autopilot health.
- `POST /wapp-installations/{installationId}/revoke` — immediately revoke Tower authority and archive/hide the launcher; enqueue runtime teardown.
- `POST /wapp-installations/{installationId}/uninstall` — step-up-protected teardown request.

Keep the existing personal-WApp and publishing-grant routes for direct management and compatibility. Route their authorization through the new delegation evaluator when `ownerActorId != actorId`; do not reuse broad `workspace.manage`. Existing publisher routes `/api/v4/wapp-activity/.../grants/me` and `/items` remain unchanged.

### Validation and atomicity

Tower canonicalizes the request before hashing. It validates workspace/owner/delegate membership, grant status/time/version, exact scopes and filters, app/version format, HTTPS origins, launch-origin membership, destination workspace/scope/channel consistency, active channel state, capability allowlist, publisher npub, installation uniqueness, and owner/app/publisher immutability.

`client_request_id` is unique per `(workspace_id, actor_id, operation)` and returns the existing intent when the canonical request hash matches; reuse with a different hash returns `409 idempotency_conflict`. Claim and complete require an intent nonce and compare-and-set version. NIP-98 event replay protection remains mandatory.

Tower cannot transact across Autopilot and Postgres. Use a saga:

1. Tower transaction creates intent, audit, and outbox event.
2. Autopilot installs locally using that immutable request and reports attested observations.
3. One Tower transaction locks the intent/installation and upserts the existing `flightdeck_pg_wapp_installations`, `flightdeck_pg_personal_wapps`, publishing grant/destinations, audit, and outbox rows.
4. If step 3 fails, the intent becomes repairable `failed`; Autopilot retains a quarantined/stopped install or tears it down according to the intent response. Reconciliation compares both sides and never silently broadens authority.

Do not create a second WApp registry. Add intent/delegation tables because they are authorization/workflow records, not another installation catalog. Add explicit foreign/reference columns to join the three existing concepts.

### Proposed schema additions

- `flightdeck_pg_wapp_delegations`: owner/delegate, scopes, filters JSONB with normalized indexed fields where queried, validity/revocation, signature/request hash, versions and audit attribution.
- `flightdeck_pg_wapp_install_intents`: desired/observed identifiers and versions, lifecycle state, nonce hash, idempotency/request hash, delegation/actor/signer/owner attribution, error/reconciliation fields.
- Extend `flightdeck_pg_wapp_installations` with lifecycle/Autopilot binding fields if safe: `autopilot_origin`, `requested_app_version`, `observed_app_version`, `status`, `last_reconciled_at`, `uninstalled_at`. If global installation identity can serve several workspaces, keep status in a one-to-one workspace binding keyed by `(workspace_id, installation_id)`.
- Extend `flightdeck_pg_personal_wapps` with nullable `wapp_installation_id UUID` referencing the existing internal installation UUID and a unique partial owner/workspace index.
- Extend publishing audit or general audit serialization with owner, actor, signer, delegation, and intent IDs.

Update `src/types.ts`, `src/openapi.ts`, bootstrap SQL, runtime schema checks, migrations, serializers, SSE/outbox family maps, and route/service tests together.

### Stable error codes

Use HTTP status plus machine-readable codes: `delegation_required` (403), `delegation_expired` (403), `delegation_revoked` (403), `delegation_scope_denied` (403), `resource_filter_denied` (403), `step_up_required` (403), `cross_workspace_install` (403), `publisher_identity_conflict` (409), `installation_identity_conflict` (409), `stale_intent_version` (409), `stale_app_version` (409), `idempotency_conflict` (409), `origin_not_allowed` (400/403), `destination_not_allowed` (403), `destination_scope_changed` (409), `channel_unavailable` (409), `autopilot_attestation_invalid` (403), `intent_not_claimable` (409), `partial_installation` (409), and `reconciliation_required` (409).

## 5. Flight Deck changes

Operator manages delegation under **Settings → People & agents → Agent → WApp authority**. Show scope chips, allowed app/templates, destination channels, exact origins, expiry, active-install limit, last use, and Revoke. Keep broad workspace-admin controls separate.

Add **WApps → Install WApp** as a wizard:

1. Choose an existing Autopilot web app or approved template and pinned version.
2. Choose Operator as launcher owner and enter title/description/icon.
3. Select scope/visibility and explicit Feed destinations; do not create a channel implicitly.
4. Preview identities and capabilities: Autopilot instance, app/template/version, installation ID (when allocated), publisher npub (when known), launch origin, allowed deep-link origins, Feed destinations, requested Tower capabilities, delegation/expiry, and any step-up reason.
5. Submit the Tower intent, show progress from Tower SSE/materialized state, and expose the final launcher.

Statuses are `Pending approval`, `Installing`, `Active`, `Failed`, `Revoked`, and `Uninstalled`. Failed rows show a safe error, last successful step, and one of Retry, Reconcile, Change request, or Ask Operator. Active rows offer Manage Feed, Disable, Reconcile, and step-up-protected Uninstall. Revoked rows never offer Launch or Feed publishing.

The audit view presents a timeline with Owner, Actor, Signer, Publisher, delegation, request/version, and outcome as separate labeled fields. Operator can filter by installation or Agent.

Implementation belongs near the current personal launcher code in `src/app.js`, API/write adapters, `wapp-command-support.js`, and `wapp-publishing-manager.js`; the brief's `src/wapps-manager.js` path does not exist in the current checkout. Continue to materialize typed Tower rows through the sync service/Dexie. Do not call Autopilot directly from browser code for privileged mutations; Flight Deck may discover catalog data through a Tower-mediated/owner-approved connection, while Tower intents drive changes.

Mobile: use a full-screen stepper or stacked sheet; one decision per screen, sticky Back/Continue, destination search rather than a wide grid, horizontally scrollable status timeline, copyable identity details, and no hover-only controls. The final capability summary must be readable before approval without horizontal scrolling.

## 6. Autopilot handshake and runtime identity

Autopilot adds delegated authorization to its WApp/app endpoints instead of granting Agent `AppsManage` globally. The effective grant must cover the exact Tower intent, app/template, instance, owner, workspace, and action. App creation from a template and WApp assignment are distinct audited steps.

Tower issues a short-lived single-use claim challenge bound to `intent_id`, `intent_version`, Autopilot service npub/origin, expected workspace/owner, request hash, and expiry. Autopilot returns:

- its service NIP-98 signature over the exact Tower claim/complete request;
- `wapp_installation_id`, `app_id`, immutable `app_version`, launch URL/origin;
- `publisher_npub` derived/generated inside the managed WApp boundary;
- an attestation hash covering the normalized manifest, requested capabilities/origins, and runtime assignment.

The publisher private key is generated/imported only into Autopilot's protected WApp key store and injected into the managed process as currently intended. `/api/wapps/{id}/nsec` remains `410 wapp-secret-not-exportable`. The WApp uses the capability broker or its managed identity to sign exact Tower Feed requests; Agent receives neither raw nsec nor general signing authority.

Tower registration remains owner/delegate authorized: Autopilot service identity proves what was installed, but cannot authorize workspace attachment. Tower must re-evaluate the still-live Operator delegation on completion. Replace the current assumption that an instance identity posting `/api/v4/workspaces/{ownerNpub}/apps` is enough; registration must carry `intent_id`/challenge and resolve to the owner/delegate authorization chain. Publisher rotation uses the current rotation proof plus Operator/authorized-delegate approval, with step-up if the original grant did not explicitly allow it.

Autopilot must expose read-only reconciliation facts keyed by installation ID and intent: app/version, process state, alias/launch URL, publisher npub, manifest hash, and last transition. It must not return secrets.

## 7. Sample WApp Feed behavior

A sample installation is the acceptance fixture. Its Feed grant uses the Agent's managed publisher identity, the Operator as owner, and only an explicitly approved destination. The approved origin is `https://wapp.agent.example.invalid`.

Each story publication uses a deterministic external ID such as `sample-wapp:feed:<report_run>`, monotonic item version, concise title/summary, and a direct View URL:

`https://wapp.agent.example.invalid/?item=<canonical-item-id>`

Tower validates the URL's parsed origin against the grant and stores it on the WApp activity item. Flight Deck opens the direct story route when allowed and may fall back to the installation launcher only under existing safe-link rules.

The canonical Story import remains the app data path; the Feed item is a projection/notification, not a second story store. Publishing uses only `/api/v4/wapp-activity/workspaces/{workspaceId}/items`. It must not call a Flight Deck `/messages` route, create a thread, post a quiet-cycle message, or otherwise produce a channel-message side effect. Add a route-spy regression proving no message endpoint is invoked.

## 8. Threat model and required negative tests

| Threat | Required control and test |
| --- | --- |
| Confused deputy | Bind intent, challenge, signer, instance origin, owner, workspace, app/version, and request hash; prove an Autopilot valid for intent A cannot complete B. |
| Cross-workspace install | Workspace ID and owner actor are immutable in grant/intent; reject a valid installation claimed against another workspace. |
| Arbitrary origin | Exact normalized HTTPS origin allowlist, no wildcard/userinfo/path-as-origin; reject evil/sibling/subdomain and scheme/port changes. |
| Destination escalation | Revalidate grant filter and live channel/scope relationship at create and complete; reject extra/moved/archived destinations. |
| Publisher substitution | Immutable installation/publisher binding; reject claim/complete mismatch and require proven rotation plus approval. |
| Replay | NIP-98 replay cache, single-use challenge, idempotency hash, nonce expiry, and compare-and-set intent version; replay returns the same result only for safe idempotency. |
| Stale version | Require immutable requested version and observed match; reject mutable/stale completion and stale intent/grant/launcher versions. |
| Partial creation | Fault-inject after Autopilot install and before Tower finalize; state is failed/repairable, no active launcher/grant, and retry is idempotent. Fault-inject within Tower finalization and prove rollback. |
| Revoked delegate | Revoke after intent creation and after claim; both completion and repair mutation fail, while Operator can reconcile/revoke. |
| Uninstall leftovers | After uninstall, process/assignment absent, launcher archived, grant revoked, self-grant denied, open links disabled per policy, no usable signing capability, audit retained. |
| Audit ambiguity | Delegated create/update/revoke tests assert distinct owner, actor, signer, publisher and delegation fields; UI labels them correctly. |

Also retain existing negative publishing tests for wrong signer, wrong destination, stale item version, withdrawn tombstone, payload limit, rate limit, and unsafe URL.

## 9. Migration and compatibility

1. Add nullable joins and new workflow tables without changing existing response fields.
2. Backfill `personal_wapps.wapp_installation_id` from `metadata.wapp_installation_id` or `metadata.autopilot_wapp.wapp_installation_id` only when exactly one existing `flightdeck_pg_wapp_installations` row matches. Record ambiguous/unmatched rows for reconciliation; do not guess by title.
3. Existing Autopilot `wapps.sqlite` rows remain runtime authority. Reconciliation matches stable `wappInstallationId`, then validates `appId`, publisher, owner, launch origin, and version before linking.
4. Existing `flightdeck_pg_wapp_installations` and grants remain canonical for publisher/Feed. Add lifecycle defaults: a row with an active grant is `active`; disabled/revoked grants map accordingly, while installs without enough evidence become `reconciliation_required`, not silently active.
5. Existing personal launchers without an installation continue as manual launchers and use current APIs/UI. They cannot receive delegated install/grant management until explicitly linked.
6. Continue reading compatibility metadata for one release while writing both explicit columns and legacy metadata; then stop writing duplicated identity metadata after all supported Flight Deck versions read the column.
7. Do not merge Autopilot app templates, runtime installs, launchers, and publishing grants into one table: they have different authorities and lifecycles. The stable installation ID is their join key.

## 10. Sequenced implementation plan and acceptance

### Phase 1 — Tower contract

1. Add delegation, intent/lifecycle, explicit joins, indexes, migrations/runtime checks, types, serializers, OpenAPI, audit fields, and SSE/outbox events.
2. Implement the delegation evaluator and intent/list/read/claim/complete/fail/reconcile/revoke/uninstall routes.
3. Refactor personal-WApp and publishing-grant authorization to accept only matching scoped delegation; keep direct owner/current admin behavior compatible.
4. Add transaction, idempotency, state-machine, migration, threat-model, and Sample WApp Feed tests.

Acceptance: Agent's exact signed grant can create an intent and finalize one filtered installation; every negative case in section 8 fails with the specified code; finalization creates one existing installation row, one Operator-owned launcher, and at most one existing workspace publishing grant in one transaction; OpenAPI validates.

Impact: Tower source/schema change requires `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build`, health check, then `set -a; . ./.env.example; set +a; bun test`. Production deployment requires schema/runtime migration and Tower restart before clients use the routes.

### Phase 2 — Autopilot handshake and delegated app operations

1. Add intent-aware authorization to app template creation/selection, `/api/wapps` create/update, registration, reconcile and teardown without broad `AppsManage`.
2. Add Tower claim/complete/fail client, immutable version/manifest attestation, quarantine/cleanup behavior, and read-only reconciliation facts.
3. Keep keys non-exportable and migrate Tower registration from owner-path trust to intent challenge authorization.
4. Add positive/negative delegation, replay, crash/partial-failure, publisher substitution, and uninstall tests.

Acceptance: a valid intent installs and attests without exposing a key; absent/expired/revoked/out-of-filter delegation is denied; crash/retry converges to one installation; Autopilot reports exact version and publisher; uninstall leaves no managed process/assignment or usable capability.

Impact: Autopilot process restart is required to activate server/API changes. Do not restart or deploy a managed instance without Operator's explicit operational approval. Tower Phase 1 must be deployed first; support a feature flag during rollout.

### Phase 3 — Flight Deck management UI

1. Materialize delegation, intent, installation, audit and reconciliation families via Tower sync/Dexie.
2. Add Operator's authority editor, create/install wizard, capability preview, status cards, repair/reconcile actions, revoke/uninstall confirmation and audit timeline.
3. Integrate with the existing personal launcher and Feed grant editors; remove metadata-only matching where explicit installation ID is available.
4. Add responsive/mobile interaction tests, accessibility checks, stale-state/conflict UI tests, and end-to-end Sample WApp coverage.

Acceptance: Operator can grant/revoke Agent, Agent can complete only the filtered Sample WApp install/Feed assignment, both see accurate pending/active/failed/revoked states after reload, direct story View opens, no message is created, and the audit view distinguishes owner/delegate/signer/publisher.

Impact: Flight Deck requires `bun run build` and a new Autopilot-managed app version. Deploy only after Tower and Autopilot compatibility is live; no ad hoc preview or managed-process restart is part of this design task.

### Rollout order

Tower additive schema/routes → Autopilot feature-flagged handshake → Flight Deck read/status UI → enable delegated writes for Operator/Agent → Sample WApp acceptance → general release → compatibility metadata cleanup. Rollback disables new intents; it does not delete installations, launchers, grants, Feed items, or audit history.

## Unresolved decisions

1. Whether Tower already has a sufficiently general owner-signed delegation table to extend, or needs `flightdeck_pg_wapp_delegations`. Reuse is preferred if it preserves the proposed filters and attribution.
2. Whether `flightdeck_pg_wapp_installations` is globally one-to-one with a workspace. Current grants permit workspace-specific attachment; if multi-workspace installation is intended, lifecycle belongs in a workspace-binding table rather than the global row.
3. The canonical source and format of immutable `app_version` (Autopilot version ID, Git commit, image digest, or a tuple). Activation must not depend on a mutable alias.
4. Whether trusted-template creation may be fully delegated or always requires Operator's one-operation step-up for v1. Existing-app assignment is the safer initial release.
5. Exact uninstall semantics for app-local data and retained publisher keys. Recommended v1: stop/remove assignment and revoke signing capability, retain recoverable data/key material for a documented retention period, and require separate owner approval for permanent erasure.
6. Whether an active intent may finish after its delegation expires. Recommended answer: no; completion rechecks authority, while Operator can adopt/re-authorize the intent without reinstalling.
7. Whether launch origin changes on routine Autopilot version rollout can be pre-authorized. Recommended answer: only if the exact new origin is already in the signed filter; otherwise step-up.
