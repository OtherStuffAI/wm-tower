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

The manifest cursor supplies the captured record head, epoch, access revision and empty filter set. Tower rejects filtered, expired, foreign or altered cursors. `request_id` makes a lost start response resumable. The client must still be on the supplied checkpoint revision and may have no checkpoint or an incomplete snapshot checkpoint; an already-complete delta client is not regressed.

Tower returns `status:"inventory_required"`, an `adoption_id`, rotating opaque `cursor`, captured authority values, and at most 200 canonical challenge entries. Each challenge entry is a manifest `family`, `id`, `version` and `state`. A page can contain an empty challenge with `has_more:true` when the bounded canonical scan crossed only rows hidden from the viewer.

## Inventory and repair

Submit every challenged identity exactly once and in challenge order:

```json
{"cursor":"<uuid>","inventory":[
  {"family":"message","id":"<id>","state":"active","version":"123"},
  {"family":"task","id":"<id>","state":"missing"}
]}
```

Omitted, extra, reordered or forged identities fail closed. Exact state/version matches advance without a body transfer. Mismatches return `status:"repair_required"` plus only their compact canonical identities. Fetch those identities through existing `POST P/repair`, atomically commit its upserts or explicit tombstones, then submit exact committed receipts:

```json
{"cursor":"<uuid>","repaired":[
  {"family":"task","id":"<id>","state":"active","version":"456"}
]}
```

Tower rechecks current canonical state and authorization. Partial, stale or unavailable receipts do not advance. Current authorization changes invalidate the session so a fresh manifest cannot be confused with the old proof. Cache rows absent from a challenge or no longer authorized remain retained; absence is never deletion. Pending local edits are not inventory receipts and remain outside server retirement semantics.

## Atomic adoption

After the final exact inventory or repair receipt, Tower atomically replaces the same client registration's incomplete initial/snapshot position with one durable delta checkpoint whose `after` is the captured head. Only this transaction invalidates the old initial handle and temporary snapshot pages. Any earlier failure leaves them recoverable.

The terminal response has `status:"adopted"` and the normal v2 `checkpoint`. A lost response can retry the last identical payload. The next v2 page uses `checkpoint_cursor`, starts in delta mode, and cannot register or resume another full snapshot. Writes after the captured head remain in the ordinary delta journal.

## Bounds and recovery

Inventory and repair receipt arrays are limited to 200 entries; requests and responses are limited to 1 MiB. At most 32 unfinished sessions exist per actor/workspace. Sessions and continuations expire after seven idle days. Cursors bind workspace, viewer, app, client, manifest head, epoch, access revision, phase and checkpoint revision.

Errors name the exact `adoption_*` reason and return `strategy:"restart_cache_adoption"`, `full_snapshot_required:false`, `preserve_pending:true`, and `preserve_downloaded:true`. Epoch/access drift, checkpoint races, cursor replay with altered bytes, incomplete inventory and incomplete repairs never establish completeness.

