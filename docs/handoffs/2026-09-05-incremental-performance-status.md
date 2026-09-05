# Tower incremental performance status

Implementation ready for managerial review on main. Task remains in_progress; no reply was sent to Pete's thread and no shared service was rebuilt, restarted or deployed.

## Contract and milestones

- Contract-ready milestone and fixtures published to task comments during implementation.
- Integration contract: `docs/design/flightdeck-record-delta-v1.md`.
- Canonical stored-column fixtures: `tests/fixtures/flightdeck-record-delta-v1.json`.
- Query/index inventory: `docs/design/flightdeck-record-delta-v1-inventory.md`.
- Reproducible measurements and full SQL plans: `docs/design/flightdeck-record-delta-v1-benchmark.json` and `src/scripts/benchmark-flightdeck-record-delta.ts`.
- Implementation commit: recorded in the final task callback; this handoff travels with the implementation.

## Implemented

Negotiated GET record-sync?protocol_version=1, separate viewer/workspace cursors, 15 explicitly named record families, canonical upserts and explicit tombstones, transactional per-workspace commit-order counter, trigger-backed current projection and journal covering inserts/updates/deletes, convergent keyset snapshots and delta handover. Grants, membership, identity and relevant visibility changes reset generations. Parent task/document/thread deletion resets cached dependents with bounded work and parent visibility checks prevent orphan snapshots. Ordinary profile labels and scope/channel metadata edits do not force reset.

Stored ownership context and byte sizes allow authorization/budget checks before fetching payloads. Pages return at most 200 changes and 1 MiB JSON; metadata lookahead is one row. Oversized canonical rows fail explicitly without cursor advancement. Empty polls reuse their cursor; progress cursors retain latest 512 per viewer, seven-day TTL and bounded expiry cleanup. SQL serialization/deadlock conflicts on cursor maintenance retry the read transaction up to three attempts.

Message indexes preserve UTC millisecond + ID ordering. Task lists and task/doc comments now expose bounded keyset cursors; task indexes match mixed updated-descending/ID-ascending order with optional state. Old workspace sync and outbox cursor contracts are unchanged. Directory, shared personal, presence, invocation and WApp publishing APIs remain separate; clients must not treat this family stream as full workspace replacement. Flight Deck files were not edited.

## Validation

Disposable PostgreSQL 16 on port 55439 only. Configuration used `.env.example`, with DB_HOST=127.0.0.1, DB_PORT=55439, DB_USER/DB_PASSWORD=postgres and a public test service identity. No nsec file or production key was read.

- `RECORD_TEST_PORT=55439 bun test tests/flightdeck-record-delta.test.ts`: 16 passed, 0 failed, 106 assertions, 3.38 seconds.
- `bun test tests/flightdeck-pg-api.test.ts tests/flightdeck-pg-authorization.test.ts tests/flightdeck-pg-schema.test.ts tests/flightdeck-pg-outbox-cursors.test.ts tests/flightdeck-pg-thread-branching.test.ts tests/flightdeck-pg-daily-note-versions.test.ts`: 75 passed, 0 failed, including authenticated record-sync pages and hidden-channel checks (1859 assertions).
- `bun build src/index.ts --target=bun --outdir /tmp/tower-record-delta-build`: passed, 167 modules, 2.84 MB.
- `git diff --check`: passed.
- Plain `bunx tsc --noEmit` is blocked by existing rootDir/include configuration. `bunx tsc --noEmit --rootDir .` reports 286 diagnostics on both archived HEAD baseline and changed tree; normalized comparison found no additional diagnostic. This is not a clean repository typecheck.
- `bun run privacy:check` remains blocked by an existing tracked Forgejo handoff (`docs/handoffs/2026-09-05-headless-forgejo-bootstrap-final.md`); that concurrent file was preserved.

At 100k messages, indexed 50-row query median/p95 is 0.165/0.180 ms versus 9.816/10.187 ms before; one-message delta is 0.651/0.735 ms, 1,261 bytes and one journal row. The legacy message-only collection reaches 5,448,895 bytes. Large board/comment plans each return 20 rows. The 200 × 900KB regression verifies decoded driver data below 1.15MB for a visible page and 150KB hidden, with one/zero large payload fetches respectively.

## Remaining acceptance and rollout work

Manager must inspect the commit and accept the task before review-state transition or final thread reply. Shared Docker rebuild/restart, live authenticated smoke, Flight Deck integration/browser tests, same desktop/mobile median/p95 and agreed absolute budgets remain unperformed. The user explicitly withheld restart/deploy authority.

Unmet broader acceptance: the legacy branched effective-transcript helper still assembles full lineage; complete UI summary/subscription and shared-personal/directory behavior remains with the separate Flight Deck/manager work. This implementation advertises only its specified families and owner-only personal partition. It is not a claim that every existing API or UI page is bounded.

Operational tradeoffs: canonical current/journal storage duplicates payloads; journal retention is not yet implemented. Workspace counter locking serializes writers, and huge atomic imports are expensive (64.2 seconds for an exploratory 90k-row transaction). Use bounded import batches; concurrent mutation deadlocks roll back and require caller retry. Initial migration needs source table locks and a backfill. A >1MiB canonical row causes explicit 413 and needs the legacy path/operator resolution rather than silent truncation. No live completion is claimed.
