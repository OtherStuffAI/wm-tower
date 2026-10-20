# Existing-cache adoption v1

Tower can promote a usable existing cache to a durable v2 delta checkpoint without retransmitting canonical bodies that already match. Adoption extends the repair-manifest, selective-repair and v2 checkpoint contracts; it is not a separate sync engine.

Let `P = /api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync`. Every call requires NIP-98 for the exact URL and method, and every POST requires the exact payload hash. Register the v2 `clientId` before adoption.

## Captured head and start

Read an unfiltered `GET P/repair-manifest?limit=200` page and retain its `next_cursor`. Begin with:

```http
POST P/clients/{clientId}/adoption?protocol_version=2
```

```json
{"request_id":"<uuid>","manifest_cursor":"<uuid>","expected_checkpoint_revision":"0"}
```

The manifest cursor supplies the captured record head, epoch, access revision and empty filter set. Tower rejects filtered, expired, foreign or altered cursors. `request_id` makes a lost start response resumable. The client must still be on the supplied checkpoint revision. It may have no checkpoint, an incomplete snapshot checkpoint, or a delta checkpoint: the same device cache can lose its local position and re-adopt under its existing `clientId` (discovery `readopt_checkpointed_client:true`). The final commit still compares-and-swaps that revision.

Tower returns `status:"inventory_required"`, an `adoption_id`, rotating opaque `cursor`, captured authority values, and at most 200 canonical challenge entries. Each challenge entry is a manifest `family`, `id`, `version` and `state`. A page can contain an empty challenge with `has_more:true` when the bounded canonical scan crossed only rows hidden from the viewer.

## Inventory and repair

Submit every challenged identity exactly once and in challenge order:

```json
{"cursor":"<uuid>","inventory":[
  {"family":"message","id":"<id>","state":"active","version":"123"},
  {"family":"task","id":"<id>","state":"missing"}
]}
```

Omitted, extra, reordered or forged identities fail closed. An entry matches when its state equals the challenge state and its version is at least the challenge version (discovery `version_match:"at_least_authoritative"`). Snapshot pages label rows with their snapshot boundary rather than their own journal position; a label is never older than the content it accompanies, so an equal or higher version with the same state is that content or a later one delivered by the adopted delta. Matches advance without a body transfer. Mismatches return `status:"repair_required"` plus only their compact canonical identities. Fetch those identities through existing `POST P/repair`, atomically commit its upserts or explicit tombstones, then submit exact committed receipts:

```json
{"cursor":"<uuid>","repaired":[
  {"family":"task","id":"<id>","state":"active","version":"456"}
]}
```

Tower rechecks current canonical state and authorization. A receipt is confirmed when its state matches the current head and its version is at least the head position. A head that advanced beyond the captured head is settled by the adopted delta. Every other mismatch — omitted, stale or unavailable receipts — is returned as `deferred` (at most 200 `family`/`id`/`version`/`state` entries) on the response that follows that repair step, and `deferred_total` counts them for the session (discovery `deferred_repairs:true`). Deferred keys never fail the session: the client keeps its retained row and repairs those identities lazily through `POST P/repair` after adoption. Current authorization changes invalidate the session so a fresh manifest cannot be confused with the old proof. Cache rows absent from a challenge or no longer authorized remain retained; absence is never deletion. Pending local edits are not inventory receipts and remain outside server retirement semantics.

## Atomic adoption

After the final inventory or repair step, Tower atomically replaces the same client registration's incomplete initial/snapshot position with one durable delta checkpoint whose `after` is the captured head. Only this transaction invalidates the old initial handle and temporary snapshot pages. Any earlier failure leaves them recoverable.

The terminal response has `status:"adopted"` and the normal v2 `checkpoint`. A lost response can retry the last identical payload. The next v2 page uses `checkpoint_cursor`, starts in delta mode, and cannot register or resume another full snapshot. Writes after the captured head remain in the ordinary delta journal.

## Bounds and recovery

Inventory and repair receipt arrays are limited to 200 entries; requests and responses are limited to 1 MiB. At most 32 unfinished sessions exist per actor/workspace. Sessions and continuations expire after seven idle days. Cursors bind workspace, viewer, app, client, manifest head, epoch, access revision, phase and checkpoint revision.

Errors name the exact `adoption_*` reason and return `strategy:"restart_cache_adoption"`, `full_snapshot_required:false`, `preserve_pending:true`, and `preserve_downloaded:true`. Epoch/access drift, checkpoint races, cursor replay with altered bytes and incomplete inventory never establish completeness. On any `adoption_*` error the client restarts with a fresh manifest cursor and `request_id`; it never mints a new `clientId` or requests a full snapshot because adoption failed.

## Same-client re-registration

Registering an existing `clientId` whose checkpoint is idle-expired or behind the retained journal restarts that registration in place (revision `0`, fresh initial snapshot handle, its page tokens and adoption sessions discarded) so the device can adopt its retained rows under the same identity. An authority-epoch change remains an identity boundary and still returns `reset_required`.

