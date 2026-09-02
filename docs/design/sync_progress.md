# Sync Progress Design

## Goal

Tower should let Flight Deck determine quickly whether a workspace is behind remote state, without forcing a full payload fetch first.

The backend should support two distinct needs:

1. a cheap freshness check
2. the existing full record fetch used for actual sync materialization

## Current gap

Today Tower exposes:

- `POST /api/v4/records/sync`
- `GET /api/v4/records`

`GET /api/v4/records` returns full visible records for a single family, optionally filtered by `since`.

That is enough for actual synchronization, but not enough for a cheap UI freshness check because Flight Deck has to fetch real records to learn whether anything changed.

## Tower target

Add a lightweight records summary endpoint that returns freshness metadata per family, not full record payloads.

Suggested route:

- `GET /api/v4/records/summary`

Suggested query params:

- `owner_npub`
- optional `viewer_npub`
- optional family filter
- optional family cursors from the client

Suggested response shape:

```json
{
  "families": [
    {
      "record_family_hash": "coworker:task",
      "latest_updated_at": "2026-03-20T08:15:00.000Z",
      "latest_record_count": 412,
      "count_since": 23
    }
  ]
}
```

## Why this matters

With this endpoint, Flight Deck can compare:

- local `sync_since:<family>`
- remote `latest_updated_at`

If remote is ahead, the UI can immediately show:

- amber avatar ring
- `Updates available`
- a sync progress panel when the user opens the avatar menu

This avoids blind full syncs just to discover whether anything changed.

## Tower changes

### 1. Add summary types

Introduce request and response types for records summary in `src/types.ts`.

Suggested fields:

- `record_family_hash`
- `latest_updated_at`
- `latest_record_count`
- optional `count_since`

### 2. Add route handler

Extend `src/routes/records.ts` with `GET /summary`.

The auth rules should mirror the existing fetch route:

- authenticated actor must match `viewer_npub` when provided
- visibility must still respect owner-or-group access rules

### 3. Add summary query service

Extend `src/services/records.ts` with a summary query that:

- groups by `record_family_hash`
- returns the latest visible `updated_at`
- optionally computes `count_since` per family relative to client cursors
- does not return ciphertext payloads

The visibility filter should stay consistent with `fetchRecords()` so Flight Deck does not get false stale signals for families the viewer cannot read.

### 4. Keep full fetch unchanged

`GET /api/v4/records` should remain the payload path used during actual synchronization.

The summary endpoint is an optimization and UI-enabling route, not a replacement for the sync fetch.

## Relevant files

- `src/routes/records.ts`
- `src/services/records.ts`
- `src/types.ts`
- `tests/records.test.ts`
- `src/openapi.ts`

## Expected Flight Deck use

Flight Deck will call the summary endpoint before or during background sync scheduling.

Expected behavior:

- no remote lag: keep green state
- remote lag: mark stale with amber state
- sync starts: switch to blue state and show phase/progress
- quarantine or sync error: switch to red state
