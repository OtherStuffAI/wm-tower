# FIPS Drive v1

Drive shares explicitly selected desktop folders, read-only, with the owner or
members of one Tower workspace. Tower stores discovery and authorization records;
it receives no host root paths, directory indexes, file bytes or download copies.
An administrator has no override for another person's private share. A separate
bot identity has no implicit private delegation. Links carry references only.

## Components and operation

WM App's **Drive → Share folder** uses the current Tower/workspace selected in
Setup. Enter a share name, a source label and either **Only I can read** or
**Anyone in the workspace**, then choose the root with the OS folder picker.
Click a share to edit its name/audience or re-enable its stable ID. Moving a share
to a different workspace requires a separate explicit registration. Stop sharing
invalidates local authorization immediately, even if Tower cannot be reached;
retry registration publishes the stopped state when Tower returns. The absolute
root is shown locally and never included in registration.

The desktop app hosts its own selected roots on the local FIPS mesh address,
port 7345. Always-on machines use this same WM App host with explicitly selected
output/log folders. No Autopilot server, scanning, mirroring or blanket log access
is added. Only one hosting WM App instance can bind that node/port.

Flight Deck's Drive panel separates same-named shares by source name and share
ID. Share metadata is loaded through the workspace TowerSyncService registration,
materialized in Dexie and observed by liveQuery. The existing sync owner's
fallback cycle refreshes metadata while Drive is open. The UI never polls Tower
independently. Listing and transfer commands use a separate native FIPS client.
Opening a source requests native consent for its exact mesh identity/port.
Presence metadata is not proof of reachability. A status request checks a selected
source even when its visited listing is fresh. Offline, consent denied, access
denied, missing transport, missing/changed file and empty directory are distinct.

## Tower HTTP contract

All routes are NIP-98 authenticated, under
`/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/shares`:

- `GET /`: enabled shares visible to the requesting workspace member, including
  private shares only for their stable owner actor. Delegated workspace keys must
  be active and bound to the target workspace; cached identity resolution does
  not authorize a revoked or cross-workspace key. Returns `{shares: [...]}`.
- `PUT /{shareId}`: direct owner signature plus the host service's co-signature;
  creates at `previous_revision: 0`, updates by exact revision comparison.
  Owner/workspace cannot be replaced. Administrators cannot mutate other owners'
  shares. Disable uses this same typed update.
- `GET /{shareId}/policy`: registered host signer only. Returns one consistent
  snapshot of share policy and allowed current identities, a content revision,
  server verification time, and `max_age_seconds: 900`. Owner membership removal
  disables access; identity rotation changes allowed keys on refresh.

Registration fields: `name`, `host_name` (1–120 characters), `host_npub`,
`endpoint` (exact `http://<node-npub>.fips:<port>`, port 1024–65535),
`audience` (`private` or `workspace`), `enabled`, `previous_revision`, `host_proof`.
Unknown fields are rejected. Discovery returns at most 1,000 shares.

The host service key is generated locally and stored in OS secure storage. It is
separate from both the requesting person's identity and the FIPS mesh node key.
The owner authorizes the endpoint/service-key binding; the host proves possession
of its service key by signing kind 27235, empty content, within 60 seconds, with
these ordered tags:

```
["protocol", "fips-drive-register-v1"]
["u", exact registration URL]
["owner", owner npub]
["payload", SHA256(canonical registration JSON)]
```

Canonical registration JSON contains the fields above in the listed order,
excluding `host_proof`, with trimmed names. The proof is consumed transactionally
with the revision update. A co-signature attests the endpoint binding; Tower does
not claim to have probed the host or verified possession of the mesh node key.
Actual FIPS dialing pins the node-derived mesh address without public DNS fallback.

## Host request contract

Authenticated GET operations:
`/drive/v1/{shareId}/list?path=<relative path>[&offset=N&revision=R]`,
`/drive/v1/{shareId}/read?path=<relative path>&revision=R`, and
`/drive/v1/{shareId}/status?path=`. Lists contain at most 100 entries with name,
kind, size and revision, plus directory revision and next offset. Listing scans
are capped at 10,000 entries and never recurse. File reads require the revision
from a listing; replacement/modification gives 409, absent or unsafe paths 404,
invalid/replayed signatures 401, denied/expired policy 403. Interruptions after
headers cause an incomplete transfer, never a successful truncated save.

Every request uses a fresh signed kind 27235 event, empty content, timestamp
within 60 seconds, with ordered tags:

```
["u", exact URL including query]
["method", "GET"]
["workspace", workspace UUID]
["share", share UUID]
["nonce", fresh random value of at least 32 characters]
```

The host verifies the user's Schnorr signature independently of the mesh peer,
then checks its workspace policy. Replays are consumed before serving data, with
a bounded serialized persisted replay journal surviving restart. Unauthorized
identities do not reserve replay entries.
Transport grants do not authorize signatures or file access.

`window.fipsTransport.connectDrive({endpoint})` creates up to eight independently
consented Drive endpoint grants per top-level document. Existing `connect`, Git
fetch and WebSocket behavior remain. Drive grants accept only read-only Drive
URLs. `disconnect()` revokes all document transports. Navigation, identity change,
lock, tab close and browser-data clearing revoke transports and pending work.
Native channel metadata enforces top-frame/exact origin, including the app-owned
bundled origin `http://127.0.0.1:47831`; other plaintext page origins are excluded.

`fipsTransport.save(response,{name,signal,onProgress,open})` writes pull-driven
64 KiB chunks to a native partial file, reports byte progress, checks the advertised
length, and renames only when complete. Cancellation remains active during
finalization, removes partial output and rolls back an existing destination if
replacement was interrupted before the terminal commit. After the final
cancellation check, the save is committed; later cancellation during backup
cleanup reports the completed local save rather than claiming rollback. Desktop
uses an OS save picker; supported phones write a unique local document and offer
OS export/open. “Saved locally” does not claim that another app completed an
export. The panel distinguishes iOS export completion/dismissal and Android chooser
presentation from a completed local save.
File contents never pass through Tower or a browser Blob download.

## Policy lifetime versus listing TTL

**15 minutes is an implementation choice, not a product-owner-approved timeout.** It is the
maximum age since a successful host policy refresh. Hosts refresh every 30 seconds
while active. Network failure never moves the verified timestamp forward. Unknown
identities fail closed; explicit Tower denial or a successful policy response with
an incompatible share/host/endpoint binding discards cached authority. HTTP 5xx,
429 and connection failure retain the original timestamp within the finite window. Reconnect
replaces the policy and member set before further authorized reads. Each transfer
chunk checks current policy and local enablement. Local disable always wins.

Visited directory listings have a separate **30-minute TTL**, with manual refresh.
Manual refresh can contact the host during a Tower outage while discovery authority
is still within the 15-minute window. Reference links survive route normalization
and locate a file’s containing listing page without loading an unbounded index.
The cache key contains Tower URL, workspace, viewer identity, host, share, directory
and page. Listing timestamps change only on successful listing reads. Metadata
removal/revision changes purge associated listings; workspace/account changes hide
old rows immediately and cancel work. Cached discovery is hidden after 15 minutes
without successful Tower verification. Previously downloaded copies cannot be
recalled. There is no promise of immediate remote revocation during a Tower outage.

## Filesystem and platform limits

The bundled Rust `wmapp-drive-fs` helper opens every root and relative component
through pinned directory descriptors with `O_NOFOLLOW`, and skips symlinks and
special files. It never uses a canonicalize-then-open authorization check. Each
read is at most 64 KiB, verifies descriptor metadata before/after, and returns no
bytes when changed. Directory pagination detects directory changes. Eight active
host requests, 32 native transport resources, four native saves, and bounded
listing/protocol messages limit concurrent resource use.

Desktop hosts: macOS and Linux with active FIPS routing and the built helper.
macOS stores security-scoped bookmarks; stale OS grants require folder selection
again. Linux persists the selected path under the app's OS user permissions.
Windows hosting and phone hosting are not implemented. Clients: supported WM App
macOS, iOS and Android WebViews, using their existing FIPS route and native channel.
An ordinary browser can show permitted cached metadata but cannot promise FIPS
connectivity. Linux's desktop host does not add a Linux WebView implementation.

Hosting requires the running, unlocked application. Sleep/network loss makes it
offline; exit stops hosting. Restart restores enabled shares and their OS grants,
then reconciles Tower policy. Phone background hosting is not promised. Resuming
transfers, remote writes/deletes, public links, replication, channel audiences,
and media seeking are outside v1.

## Reusable validation

WM App: `cargo test -p wmapp-drive-fs`,
`node --test tools/grasp_bridge/bridge.test.mjs`, then inside `app/`:
`flutter test`, `flutter analyze --no-pub`, `flutter build macos --debug`.
The native helper is packaged by `tools/build_drive_fs.sh`. For isolated host
fixtures set `WMAPP_DRIVE_FS` to the helper built in that checkout. Linux builds
also package it under the bundle's `lib/` directory.

Tower: use a dedicated local Postgres container; never staging. Set normal test
configuration from `.env.example`, then set `DRIVE_TEST_DATABASE_URL` to its
`drive_test` database and run `bun test tests/drive.test.ts tests/drive-routes.test.ts`.
The route test creates a separate fixture database on that server. Run
`tests/flightdeck-pg-schema.test.ts` with `DB_HOST`, `DB_PORT`, `DB_PASSWORD` and
`TEST_DB_NAME` directed only at that isolated server.

Flight Deck: provide the public test app npub, run `bun run test`,
`bun run check:public-source`, `bun run build`, `bun run verify:dist`.
A source suite does not prove a real device path. Separately exercise OS folder
selection/bookmark restart, two real mesh hosts, owner phone private access,
workspace-member reads, administrator/nonmember denials, account switching,
sleep/offline and policy expiry/reconnect, and cancellation during a large native
save/export. Confirm the local stop action blocks both listing and reading.
