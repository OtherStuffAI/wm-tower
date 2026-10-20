# Priority record sync and manifest repair v1

Tower supplements the authoritative v2 device-checkpoint completeness stream with independent, read-only lanes for fast working-set refresh and cache repair. These endpoints never acknowledge or advance a completeness cursor. A missing record on any priority, context, or manifest page is never a deletion instruction; clients retain downloaded content until they receive a newer explicit canonical delete.

All routes require NIP-98 for the exact URL and method. POST repair also requires the exact payload hash. Tower resolves the viewer and workspace app from authentication and binds every auxiliary continuation to the workspace, actor, app, authority epoch, captured head, operation, and normalized filters.

Let `P = /api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync`.

## Newest-first priority feed

`GET P/priority[?family=message&family=task][&scope_id=...][&channel_id=...][&thread_id=...][&task_id=...][&document_id=...][&limit=200][&cursor=...]`

The first request captures the committed record-clock head. Tower scans the compact current-head index by `(position DESC,family DESC,id DESC)`, applies the requested selectors, rechecks current row authorization, and returns full canonical changes newest-first. Later writes are outside that continuation. If a selected current row changes after the captured head, it may be omitted from that partial round and will appear in the next priority round; omission still has no deletion meaning.

The response includes `captured_head`, `changes`, an opaque `next_cursor`, `has_more`, scanned/returned/byte progress, the 200-row/1 MiB bounds, `coverage:"partial"`, and `retention_policy:"retain_downloaded"`. Versions are the same decimal canonical record positions used by completeness pages. Clients apply a row only when its version is newer than their retained family/id version, so a later-arriving older completeness page cannot regress a row applied from priority sync.

Select `large_records=chunked_v1` to receive the existing manifest shape for an individually oversized current row. The descriptor replaces that row on a standalone priority page. Read and concatenate raw chunks from:

`GET P/priority/pages/{page.next_cursor}/large-records/{manifest_id}/chunks/{index}`

Each chunk is at most 262144 bytes. Verify the advertised SHA-256 and total length, then parse the same `{change,actors}` UTF-8 envelope used by bounded v2 snapshots. The viewer, app, epoch, current access, source version, and digest are rechecked on every chunk. Priority chunks have no acknowledgement semantics and do not affect the v2 checkpoint.

## Context closure

`GET P/context?resource_type=channel|thread|task|document&resource_id={uuid}`

This returns the requested canonical row plus its minimal authorized scope/channel parents in parent-first order. Every row is authorized independently. An inaccessible or missing target returns an empty closure, so the route does not reveal hidden record or dependency identifiers. The closure is naturally bounded to at most three canonical rows; an individually oversized closure fails with `record_too_large` rather than truncating data.

## Compact repair manifest

`GET P/repair-manifest[?family=...][&context selectors...][&limit=200][&cursor=...]`

The manifest is a stable family/id keyset scan of the latest canonical state at `captured_head`. Each authorized entry contains `family`, `id`, decimal `version`, `state:"active"|"deleted"`, and only the relationship identifiers already needed to select dependencies. It reuses record positions instead of hashing every body. The journal index `(workspace_id,family,id,position DESC)` makes the as-of lookup bounded and stable while retaining explicit tombstones.

Compare the manifest with the retained cache. Do not delete for absence. Send only missing or differing identities to:

`POST P/repair`

```json
{"records":[{"family":"message","id":"<uuid>","version":"123"}]}
```

Tower returns the latest currently authorized full canonical upsert or explicit delete. Unknown and inaccessible identities share `reason:"not_available"`; hidden existence and relationship IDs are not disclosed. A request accepts at most 200 identities and the complete response stays within 1 MiB.

## Recovery and retention

`reset_required`, `history_pruned`, `client_expired`, `client_not_registered`, `page_token_invalid`, and `auxiliary_cursor_invalid` responses include a machine-readable `recovery` object naming the reason and `strategy:"repair_manifest"`. This means preserve downloaded rows and pending commands, compare an authorized manifest, selectively repair mismatches, and create a replacement v2 registration/continuation if needed. It does not mean a full snapshot is immediately required. A full snapshot remains the final fallback when selective repair cannot reconstruct a usable authoritative generation.

Auxiliary cursors expire after seven idle days and are capped at 512 per actor/workspace. Each query scans at most 200 indexed headers per page even when filters or authorization return fewer rows. The compact `flightdeck_pg_record_heads` projection contains only identity, operation, canonical position, byte count, and authorization context; canonical business bodies remain in the existing current/journal stores.

Service discovery advertises `priority_feed`, `context_closure`, `repair_manifest`, `selective_repair`, continuation limits, and the `retain_downloaded` omission policy inside `record_sync`. Existing v1/v2, bounded snapshots, additive access, storage, and client checkpoint contracts are unchanged.

The unfiltered manifest continuation also anchors [existing-cache adoption v1](record-cache-adoption-v1.md). Adoption challenges every authorized identity at that captured head, uses this selective repair route for mismatches, and only then promotes the registered client to a durable v2 delta checkpoint. Filtered manifests remain repair-only and cannot establish completeness.
