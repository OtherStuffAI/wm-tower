# Agent Chat Failure Signals Contract

Status: confirmed in Tower
Last updated: 2026-04-08

## Scope

This note closes Tower work package 14 for phase 4 Agent Chat failure semantics.

## Transport Shape

Tower uses this JSON error envelope for Agent Chat-relevant failures:

```json
{
  "error": "record pull is forbidden for this actor",
  "code": "record_pull_forbidden",
  "status": 403,
  "reason_code": "workspace_key_revoked",
  "workspace_owner_npub": "npub1...",
  "actor_npub": "npub1...",
  "ws_key_npub": "npub1...",
  "details": {}
}
```

Rules:

- `code` is the transport-level failure code for the attempted operation.
- `reason_code` is included when the operation-level failure needs a more specific root cause.
- `workspace_owner_npub`, `actor_npub`, and `ws_key_npub` stay explicit so Wingmen can diagnose bot actor, workspace tenant, and session key separately.

## Shared Codes Implemented In Tower

- `workspace_access_denied`
- `workspace_key_missing`
- `workspace_key_revoked`
- `workspace_key_invalid`
- `group_membership_revoked`
- `group_key_missing`
- `group_key_epoch_stale`
- `record_pull_forbidden`
- `record_pull_not_found`
- `sse_stream_forbidden`

## Route Mapping

- `POST /api/v4/user/workspace-keys`
  - `403 workspace_access_denied`
- `GET /api/v4/groups/keys`
  - `403 workspace_key_revoked`
  - `403 workspace_key_invalid`
  - `403 group_membership_revoked`
  - `409 group_key_missing`
  - `409 group_key_epoch_stale`
- `GET /api/v4/records`
- `GET /api/v4/records/summary`
- `POST /api/v4/records/heartbeat`
- `GET /api/v4/records/{record_id}/history`
  - `403 record_pull_forbidden` with `reason_code`:
    - `workspace_key_revoked`
    - `workspace_key_invalid`
    - `group_membership_revoked`
  - `404 record_pull_not_found` on targeted history lookup
- `GET /api/v4/workspaces/{ownerNpub}/stream`
  - `403 sse_stream_forbidden` with `reason_code`:
    - `workspace_key_missing`
    - `workspace_key_invalid`
    - `workspace_key_revoked`
    - `group_membership_revoked`

## Phase 4 Conclusion

- Revoked workspace keys are now classifiable.
- Membership loss is now classifiable on SSE, record pulls, and group-key refresh.
- Current-epoch wrapped-key drift is now classifiable through `GET /api/v4/groups/keys`.
