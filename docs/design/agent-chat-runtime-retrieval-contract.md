# Agent Chat Runtime Retrieval Contract

Status: confirmed in Tower
Last updated: 2026-04-08

## Scope

This note closes Tower work package 10 for phase 3 Agent Chat runtime retrieval.

## Result

- Tower does not need a chat-specific retrieval route for phase 3.
- The existing records, history, summary, and heartbeat routes are sufficient for the current Yoke and Wingmen runtime patterns.
- The only Tower-side fix shipped here is contract hardening: `GET /api/v4/records` pagination is now explicitly documented in OpenAPI.

## Supported Runtime Retrieval Patterns

### Recent Thread Bootstrap

- Freshness can be checked with:
  - `GET /api/v4/records/summary?owner_npub=<workspace_owner_npub>&record_family_hash=<app-family>:chat_message`
  - or `POST /api/v4/records/heartbeat`
- Payload bootstrap stays on the generic family fetch path:
  - `GET /api/v4/records?owner_npub=<workspace_owner_npub>&record_family_hash=<app-family>:chat_message&limit=<n>&offset=<m>`
- Tower returns:
  - `records`
  - `total`
  - `limit`
  - `offset`
  - `has_more`
- Records are returned oldest-first within the page by `updated_at`. A client that wants the most recent page can compute `offset = max(total - limit, 0)` after the first paged response.

### Older Thread History Pull

- Older visible message records can be paged through the same family fetch path by increasing `offset`.
- If the caller already knows a specific `record_id` from SSE metadata or local state, version-chain lookup uses:
  - `GET /api/v4/records/{record_id}/history?owner_npub=<workspace_owner_npub>`
- History returns all visible versions newest-first for that one record.

### Related-Message Lookup

- Tower is sufficient when the lookup is based on:
  - the current chat family scope, or
  - a known `record_id`
- Tower does not provide decrypted thread indexes, semantic relatedness, or cross-thread ranking. Those remain Yoke or local-runtime responsibilities.
- No downstream phase should add a private Tower retrieval path for that work.

## Phase 3 Call Mapping

- Wingmen live intercept:
  - SSE advisory update
  - `GET /api/v4/records/{record_id}/history` for the changed record when needed
- Yoke or bootstrap sync refresh:
  - `GET /api/v4/records/summary` or `POST /api/v4/records/heartbeat` for freshness
  - `GET /api/v4/records` for visible family payload pages

## Phase 4 Assumptions

- This work package does not define revocation or stale-key error taxonomy.
- WP14 still needs to make these failure states explicit and classifiable:
  - workspace access revoked
  - group membership revoked
  - group epoch rotated beyond held keys
  - stale or revoked `ws_key_npub`

## Conclusion

- Phase 3 runtime retrieval is unblocked on Tower.
- No new backend retrieval route is required before WP14.
