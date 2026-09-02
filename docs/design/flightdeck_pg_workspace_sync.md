# Flight Deck PG Workspace Sync

Flight Deck PG uses one workspace-level cursor instead of crawling scopes,
channels, and record-family list routes from the browser.

## Contract

`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/sync`

- Without `cursor`, Tower starts an access-filtered snapshot at the current
  outbox high-water mark and returns one bounded page.
- While `has_more` is true in snapshot mode, `next_cursor` is an opaque
  versioned snapshot cursor. It freezes the high-water mark and carries the
  server-owned channel/message keyset. Clients must persist and replay it; they
  must not derive offsets.
- The terminal snapshot page sets `snapshot_complete: true` and returns the
  normal outbox event cursor in `next_cursor`.
- With `cursor`, Tower reads visible outbox events after that cursor, bundles
  the affected channel collections, returns typed tombstones, and advances the
  cursor.
- `has_more` tells the client to request another bounded delta page.

The response includes canonical Tower transport rows. Flight Deck remains
responsible for translating those rows into its Dexie materialized view.

## Client acknowledgement

Flight Deck stores the cursor per workspace and viewer. It updates materialized
rows, a persisted snapshot seen-manifest, and the cursor in one Dexie
transaction. Snapshot pages upsert incrementally. Only the terminal page may
reconcile locally omitted authoritative rows, after which the seen-manifest is
removed. A failed request or transaction therefore resumes or replays safely.

Snapshot channel queries are sequential, and message pages are capped by the
requested `limit` (maximum 2,000). This prevents all-channel, all-message query
fan-out. Other channel collections are sent once on the first page for that
channel; later message pages contain only messages.

SSE is advisory: visible events wake Flight Deck, which coalesces the burst and
calls the workspace sync endpoint. Manual and fallback polling use the same
path. Navigation list endpoints are not a synchronization protocol.
