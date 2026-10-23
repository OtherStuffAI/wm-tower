# NStack workspace console

`/ui` is the workspace-first browser console. Connect a NIP-07 signer, choose an
accessible workspace, or create an encrypted-record workspace through guided
name/review/setup steps. Setup generates workspace and group identities in the
browser, wraps their keys with the signer's NIP-44 encryption, and submits the
existing authenticated workspace contract. Prepared ciphertext is retained for
the review: retry first checks the generated workspace identity and reuses the
same payload. Personal keys are never requested or exported.

The active workspace stays explicit. Switching clears workspace data and closes
setup/review dialogs; generation checks discard stale reads. Workspace names and
descriptions can be edited only after the existing manager-only API succeeds.

App cards show registered namespaces and their enabled flags, never online
status. Registration starts with no declared capabilities. A review identifies
the target workspace and app public key before saving. Namespace disable/enable
requires confirmation and explicitly does not revoke independent browser
consent, device keys, membership or app grants. Connection instructions provide
the existing public connection token with a copy action; consent still happens
through the app's supported flow.

Both encrypted-record and typed app workspaces are discovered through their own
APIs. Typed entries use the authoritative UUID and declared app identity. They
remain distinct from legacy namespaces, including where the server supplies a
backing workspace mapping. Their usage uses the supported UUID category report;
generic namespace editing and object listing are not inferred from that mapping.
Typed files and integrations are managed in the owning app.

Storage offers paginated registered-object metadata, visibility/upload filters,
server-authorized access inspection and explicit downloads. It does not invent
publication, deletion or ACL editing. Encrypted downloads remain encrypted.
Legacy logical counters and typed category reports state their coverage;
unavailable values are never rendered as zero or physical disk totals.

The supplied white SVG master, Inter font and solid navy/purple/orange tokens
form the responsive shell. Native controls and modal dialogs support keyboard
navigation, visible focus, Escape and focus return. `/ui/advanced` preserves the
previous developer dashboard and billing. `/admin`, `/docs` and `/table-viewer`
keep their access rules.

Browser crypto is bundled from locked dependencies with `bun run console:build`.
The generated asset and its licences are committed for Docker runtime serving.
Run `bunx playwright install chromium` once, then `bun run console:test` for the
disposable browser fixture suite. It verifies real NIP-98 signatures and decrypts
setup ciphertext, exercises app confirmation and connection handoff, checks stale
responses and denied access, and covers desktop/mobile and keyboard behavior.
The fixture suite never contacts a real workspace. Live activation and database
validation follow the repository's Tower-only lifecycle rules.

The namespace inventory adds a read-only, independently authorized view of
`workspace_apps` and `workspace_app_db_namespaces`. It shows registered names,
enabled flags, shared app row/collection counts, allocated schema names and application table counts (excluding
migration bookkeeping), with source and coverage labels. No schema allocation is
interpreted as installation, online presence, row access or a byte measurement.
The endpoint uses the existing owner/creator/admin management policy through a
read-only lookup (no implicit legacy admin-group repair), a read-only
transaction, a three-second SQL budget and an explicit 500-registration cap.
A denied or failed read stays unavailable; an empty successful list means only
that no registrations were found for that address.

Typed PG identities come from `flightdeck_pg_workspaces.app_npub`. Their shared
`public.flightdeck_pg_*` tables partition data by workspace UUID. Owner/app
registrations, `workspace_app_rows` and optional allocated WApp schemas use an
owner-address/app pair instead; they may span multiple typed workspaces. The
console labels that scope and never adds these overlapping references into a
cross-workspace total. A backing `v4_workspace_id` is a mapping, not authorization.
Typed membership alone never authorizes owner-wide namespace inspection.

Ambulando Sol retains Flight Deck's app identity and record contracts; its brand
does not establish an independent database namespace. See the Sol repository's
`docs/design/ambulando-sol.md`, `src/app-identity.js` and `docs/ota-publishing.md`.
Generic app row contents, custom-schema row counts, schema bytes, graph, Git and external storage
remain explicitly outside the namespace metadata report. Existing typed UUID
usage and encrypted-record counters retain their separate coverage statements.

Inventory cards also show registration dates and same-owner current/previous
publisher references. A publisher is an installation identity and may differ
from an app's graph identity. Rotation retains historical publisher identities;
zero generic rows does not establish that a registration is unused.

“Archive from console” is a reversible inventory preference, stored separately
in `namespace_console_archives`. It does not unregister, uninstall, disable or
permanently delete anything. Registration flags, all data, manifests, schema
mappings, grants and runtime authority remain intact. Archived entries can be
shown and restored; a current publisher with active installation, grant or
launcher references always remains visible and is protected from new archive
operations. This console does not claim to detect every running external app.
Graph, custom-schema contents, legacy records, objects, Git and external stores
are explicitly unmeasured and retained. Permanent deletion requires broader
attribution and lifecycle/quiescence controls and has no endpoint here.

Preview and apply use the owner-address management policy independently of typed
membership. `POST /api/v4/workspaces/{owner}/namespace-inventory/{app}/preview`
accepts `action: archive|restore`; it performs no writes and returns the exact
owner/app pair, registration metadata, references, retained impact, short confirmation
phrase (uppercase action plus the last eight app-identity characters), blocked reason and opaque preview token. Apply uses the sibling
`/visibility` route with the same action, token and exact confirmation phrase.
Tokens expire after five minutes or a Tower process restart. Invalid, stale,
changed or blocked previews require another review; failed collectors never
imply empty data. No confirmation request changes app data or access.

Apply serializes on the exact registration row and matching same-owner current
installation rows while rechecking metadata and active publisher references.
No global table lock or cross-database transaction is used. Only archive metadata
and an operation receipt are written. Observed changed counts or identity
invalidate the preview. Later writes, new installations and grant/launcher
activation can proceed and all data remains intact; newly active publishers
always override the archive display filter. Registration upserts do not clear an
archive preference. Lock/statement timeouts fail closed.

Exact request receipts survive process restarts. Retrying a completed token with
the same actor, owner, app, action and phrase returns the original outcome with
`replayed: true`, even after a later restore/archive; it does not replay the
transition or assert the current visibility. Refresh inventory for current state.
Receipt metadata remains until an explicit future retention policy is introduced.
A restart invalidates unapplied previews, so request a new preview in that case.
