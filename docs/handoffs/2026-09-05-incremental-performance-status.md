# Tower incremental performance status

Focused integration pickup implemented on main after reviewed checkpoint `4371836`. Ready for manager inspection; task remains `in_progress`. Manager owns acceptance, final Pete thread reply and review transition. No shared service restart/deployment, raw key access or Flight Deck repository edits occurred.

## Contract-ready integration

- Contract: `docs/design/flightdeck-record-delta-v1.md` (visible actor supplement and effective transcript continuation).
- Canonical fixture: `tests/fixtures/flightdeck-record-delta-v1.json`, now with usable page actors and empty tombstone-only sidecars; no preseeded members needed.
- Types: `FlightDeckRecordActor` and optional `FlightDeckRecordPage.actors`; OpenAPI documents exact shape and bounds.
- Contract-ready task comment was persisted immediately during the pickup; final commit and validation are recorded in the manager callback/task comment.

New producer pages always emit `actors: [{actor_id,npub,display_name,kind}]` (or `[]`). Only typed top-level author/updater/deleter/owner/assignee/viewer references in visible returned upserts are resolved; IDs deduplicate per page. Hidden rows, tombstones and arbitrary metadata add no actors. Full response remains <=1 MiB; changes plus actors <=200. The next row and its new actors fit together or are deferred without cursor advancement. SQL checks actor-label byte sizes before fetching identities, including oversized-profile cases.

Authenticated channel-only, task-only and doc-only workspace members now render sender/assignee identity without `/members` (which still returns 403). Group and full membership directories retain independent authorization and can be skipped for canonical transcript/task/doc rendering. Identity sidecars do not imply roles, membership completeness or permission to operate group management/pickers. Architecture remains Tower -> TowerSyncService -> Dexie -> liveQuery -> Alpine. Old v1 consumers can ignore the optional field; consumers encountering old producers must not assume it exists.

A new 200-row expansion regression exposed an existing delta ordering defect: `ORDER BY position` selected the text wire-version alias. The query now explicitly sorts the underlying bigint journal position, preserving cursor order across decimal boundaries.

## Branch query continuation

Active route `GET .../channels/:channelId/messages?thread_id=...&effective_transcript=true` passes limit+1 to the service. It resolves at most 100 small lineage rows and fork anchors, builds ordered thread ranges, then uses timestamp/ID keysets and the remaining page limit. Nested inherited fork points truncate earlier ranges; tombstones remain valid anchors and are serialized read-only without deleted contents. Branch creation now validates its one requested anchor through the same ranges, including anchors beyond the first page. Neither active route loads full transcript histories. The pure array assembler remains as a unit/reference helper only.

Added `idx_fd_message_thread_effective_timeline` includes deleted rows, unlike the existing live-only thread index. It is inside the schema block consumed by both bootstrap and ensureRuntimeSchema. Shared index installation remains pending manager rollout; normal index creation can block writers. See inventory for a concurrent prebuild option outside migration transactions.

Evidence: 12,000 equal-timestamp messages, 50 nested branches, fixed 20-row page: exactly 20 decoded message payloads, 56,469 total driver bytes. Captured EXPLAIN uses the new index, 20 source rows, no full-history sort. Service median/p95 3.150/6.131 ms over 30 warm samples. One-row branch-point lookup decodes one payload. Tests cover inherited ancestor truncation, deleted anchors, invalid excluded anchors, following-page continuity and authenticated branch opening/creation.

## Exact isolated validation

Inspected the already-running disposable PostgreSQL 16 process at localhost:55439, data directory `/tmp/tower-record-delta-pg/data`, before reuse. Shared Docker Tower/DB were untouched. Test suites create their own databases and assemble the current source app in process; this is isolated authenticated validation, not a claim about shared live runtime.

Load only example configuration:

```bash
set -a
source .env.example
set +a
```

Focused:

```bash
RECORD_TEST_PORT=55439 bun test tests/flightdeck-record-delta.test.ts
```

19 passed, 0 failed, 176 assertions, 4.84 seconds. Includes all previous snapshot/delta/ACL/parent/cursor/driver bounds plus actor isolation, combined row/byte expansion, fixture actor completeness and deep branch regression.

Authenticated API and related regression:

```bash
DB_HOST=127.0.0.1 DB_PORT=55439 DB_USER=postgres DB_PASSWORD=postgres \
SUPERBASED_SERVICE_NPUB=npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul \
bun test tests/flightdeck-pg-api.test.ts tests/flightdeck-pg-authorization.test.ts \
  tests/flightdeck-pg-schema.test.ts tests/flightdeck-pg-outbox-cursors.test.ts \
  tests/flightdeck-pg-thread-branching.test.ts tests/flightdeck-pg-daily-note-versions.test.ts
```

77 passed, 0 failed, 1906 assertions, 12.27 seconds. Signing identities are test-generated; service identity above is public test configuration.

`bun build src/index.ts --target=bun --outdir /tmp/tower-record-integration-build`: passed, 167 modules / 2.85 MB. `git diff --check`: passed after removing an extra terminal blank line.

Typecheck remains pre-existing blocked: `bunx tsc --noEmit --rootDir .` reports 286 diagnostics, normalized comparison with the archived baseline finds zero added/removed diagnostics. Plain typecheck still has the documented rootDir/include issue. `bun run privacy:check` still fails only on the pre-existing tracked `docs/handoffs/2026-09-05-headless-forgejo-bootstrap-final.md`; it was preserved, with no unrelated fixes.

## Updated measurements

Because actor sidecars and numeric ordering affect delta work, reran the 1k/10k/100k benchmark against a fresh disposable seed. Full plans and measurements: `docs/design/flightdeck-record-delta-v1-benchmark.json`; inventory: `docs/design/flightdeck-record-delta-v1-inventory.md`. At 100k: indexed 50-row read 0.147/0.183 ms median/p95 versus legacy 10.550/18.458 ms; one-message delta including actor 0.720/0.892 ms, 1,393 bytes, one journal row. Historical pre-sidecar 1,261-byte measurements are superseded. Legacy message-only collection remains 5,448,895 bytes.

Reproduction after loading example configuration:

```bash
RECORD_TEST_PORT=55439 bun test tests/flightdeck-record-delta.test.ts -t 'every advertised'
# Use the resulting fresh tower_record_delta_<pid> database; this pass used 26854.
RECORD_TEST_PORT=55439 RECORD_TEST_DATABASE=tower_record_delta_26854 \
  bun src/scripts/benchmark-flightdeck-record-delta.ts
# Branch benchmark uses a full focused-suite database; this pass used 26797.
RECORD_TEST_PORT=55439 RECORD_TEST_DATABASE=tower_record_delta_26797 \
  bun src/scripts/benchmark-flightdeck-branches.ts
```

Branch plans/measurements: `docs/design/flightdeck-branches-benchmark.json`. Local warm SQL/service timings exclude HTTP, network, browser, desktop/mobile rendering and absolute product budgets.

## Actual remaining limits and manager work

- Manager must review the commit, coordinate Flight Deck fixture/browser integration, perform the required shared rebuild/restart and authenticated smoke after authorization, then decide task acceptance. No independent Pete thread post was made.
- Branch round trips scale with lineage depth (hard cap 100). Legacy message endpoints limit rows, not bytes; very large individual message payloads remain possible. Existing lineage concatenation and timestamp/ID scroll semantics are retained; imported backdated child rows retain the prior chronological-scroll anomaly. Changing that would require a separately versioned segment-aware cursor/order contract.
- Profile-only label changes do not emit deltas; labels refresh when referenced again or through an independently authorized directory refresh. Identity/ACL rotations still reset generations. Sidecar omission never authorizes identity deletion.
- Shared personal/directory/presence/invocation/WApp publishing families remain outside record-sync. No claim of every UI/API path being bounded is made.
- Journal retention remains unimplemented; canonical current/journal duplicate payload storage. Workspace counter locking serializes writers; huge atomic imports are expensive and mutation deadlocks require retries. Initial projection migration holds source table locks and backfills current records. A single oversized row plus actors explicitly returns 413 without cursor advancement.
