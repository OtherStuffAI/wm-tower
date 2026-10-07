# Flight Deck message activity

`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/message-activity?range=7d|30d|all`
returns complete message counts for channels the authenticated workspace member
can read. The required range accepts exactly these three values; omitted or
unsupported values return 400. NIP-98 and the existing workspace membership
path apply. An explicitly supplied app identity must match the workspace.

The response type is `FlightDeckPgMessageActivityResponse` in `src/types.ts`.
It contains `identity`, `workspace_id`, `range`, `from`, `to`, `as_of`,
`complete: true`, and `channels: [{channel_id, scope_id, count}]`. Labels are
resolved through the client's existing authorized channel/scope path.
No message content or credentials are returned. Responses use `Cache-Control: no-store`.

## Semantics

- One read-only repeatable-read transaction resolves membership, effective
  groups, channel ACLs, active scopes/channels and counts. Concurrent changes
  are visible on the next request, without mixing snapshots within a response.
- `as_of` is the server transaction start instant, truncated to milliseconds.
  `to` equals `as_of`. The interval is `[from, as_of)` using canonical
  `created_at`; 7d and 30d are exactly 168 and 720 hours. All-time has null `from`.
- Active `channel.read` actor or effective group grants determine inclusion.
  Workspace or scope grants alone do not confer channel access. A readable
  channel makes its containing scope visible under existing scope-list rules;
  no separate scope.read grant is required. Archived scopes/channels are omitted.
- Nondeleted canonical message rows are counted once by immutable primary key
  in their actual channel. Thread replies count; inherited branch transcripts
  are never joined. Deleted messages do not count. Thread archival alone does
  not delete canonical messages.
- Authorized zero-count channels are included. An empty channel list is a
  complete authorized result. Scope totals are sums of returned channels.
- There are no pagination limits or silent caps. Duplicate matching grants
  cannot multiply rows (`EXISTS`). Counts exceeding JSON safe integers fail.

The aggregation filters readable channels before per-channel indexed counts.
The existing partial `(workspace_id, channel_id, created_at)` index on live
messages supports the query. All-time remains supported; cost is proportional
to authorized live history, with no production-scale benchmark claimed.
Database timeouts/errors fail the request rather than returning partial success.

## Client ownership and activation

Read this contract through TowerSyncService and the existing endpoint-pinned
transport. Materialize the identity/workspace/range snapshot through Dexie;
render through liveQuery. The napplet receives IDs/counts through its read-only
host bridge, without its own Tower client or signer.

Source-backed tests create disposable databases using the established test
conventions. They require reachable PostgreSQL and a role allowed to create
and drop test databases; no real signing keys are needed.

```sh
set -a; . ./.env.example; set +a
DB_PASSWORD=postgres bun test ./tests/flightdeck-pg-authorization.test.ts
DB_PASSWORD=postgres bun test ./tests/flightdeck-pg-api.test.ts --test-name-pattern 'message activity'
```

Source tests do not activate the running service. The supervising manager must
review, run `./rebuild_deploy_docker.sh`, check
`curl http://127.0.0.1:3100/health`, then make broker-signed authenticated calls
for all ranges, invalid range and denied access. The implementation worker must
not restart Tower or Autopilot or deploy.
