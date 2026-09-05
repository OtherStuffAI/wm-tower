# Tower record delta query and index inventory

Measured on an isolated local PostgreSQL 16 instance on macOS arm64; 30 warm samples per path. Full EXPLAIN ANALYZE/BUFFERS trees and storage sizes: `flightdeck-record-delta-v1-benchmark.json`. These timings exclude HTTP/NIP-98, browser materialisation, network latency and UI rendering. The full record-delta service measurement includes SQL authorization, bounded payload fetch, serialization and persisted progress cursor work.

| History | Old 50-row query median/p95 ms | Indexed 50-row query median/p95 ms | Record delta median/p95 ms | Delta bytes |
|---:|---:|---:|---:|---:|
| 1,000 | 0.344/0.453 | 0.156/0.248 | 1.172/1.856 | 1,391 |
| 10,000 | 1.631/1.819 | 0.153/0.174 | 0.946/1.267 | 1,392 |
| 100,000 | 10.550/18.458 | 0.147/0.183 | 0.720/0.892 | 1,393 |

The indexed message query examines 50 source rows at all three sizes; the delta journal query examines one row. The old timestamp expression causes sequential scanning (parallel at 100k), examining approximately the whole channel. The legacy message-only bundle is capped at 10k rows, measures 5,448,895 bytes at 10k/100k and still cannot prove snapshot completeness. These bundle numbers exclude the other collections that old sync reloads.

| Path | Filter and order | Matching index / read bound |
|---|---|---|
| record delta | workspace + position > cursor; position ascending | journal primary key; limit metadata entries + one lookahead, then point payload fetch |
| record snapshot | workspace + (family,id) > keyset | current primary key; limit metadata entries + one lookahead |
| channel messages | workspace/channel, live rows, UTC millisecond creation bucket + ID ascending | idx_fd_message_timeline; 50 measured rows |
| thread messages | same plus exact thread | idx_fd_message_thread_timeline, partial non-null thread and live rows |
| task board | workspace/channel, optional state; updated descending + ID ascending | negative UTC epoch + ID keyset, state-filtered and unfiltered indexes |
| task comments | workspace/task, live rows; full timestamp + ID | idx_fd_task_comment_timeline |
| doc comments | workspace/doc, live rows; full timestamp + ID | idx_fd_doc_comment_timeline |
| permissions | workspace/principal/resource; active grants | existing grant actor/group indexes, per-page decision cache |
| cursor retention | workspace/viewer, newest timestamp/token | cursor viewer index; latest 512 retained, expiry index and bounded deletion batches |

10k-task board: 20 rows returned, PostgreSQL execution 0.029 ms. 10k-comment target: 20 rows returned, PostgreSQL execution 0.028 ms, including indexed actor lookup. SQL plans preserve the exact predicates and row counts.

## Write and storage cost

The counter serializes writers within each workspace until commit. It provides commit order, but increases contention and can require normal PostgreSQL deadlock/serialization retries for competing multi-record mutations. Large imports should use bounded batches. An exploratory single 90k-row transaction took 64.2 seconds; the final benchmark uses 1k-row transactions. It does not represent ordinary single-record writes. Initial schema backfill copies current rows without generating historical journal entries and holds source table locks while installing triggers.

- `flightdeck_pg_messages`: 51.66 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).
- `flightdeck_pg_record_current`: 108.53 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).
- `flightdeck_pg_record_journal`: 101.61 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).
- `idx_fd_message_timeline`: 7.39 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).
- `idx_fd_message_thread_timeline`: 0.01 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).

Current records and canonical journal payloads deliberately duplicate data. The empty partial thread index avoids indexing null-thread messages. No journal pruning is implemented in v1; a future retention protocol must expire cursors and force reset before dropping replay history. Cursor rows themselves have bounded per-viewer retention.

Unmeasured acceptance: browser/mobile median/p95 and absolute product budgets; cold-cache and remote network behavior. Separate directory, shared-personal, presence, invocation and WApp publishing APIs remain outside the negotiated record-family stream. No claim of whole-workspace or whole-UI boundedness is made.

## Integration pickup measurements

The table and benchmark JSON above were rerun after adding the actor sidecar and correcting delta SQL ordering to the underlying bigint position (not its selected text alias). A one-message delta at 100k now includes one identity, 1,393 bytes; previous 1,261-byte numbers are historical pre-sidecar evidence.

The active `GET .../channels/:channelId/messages?thread_id=...&effective_transcript=true` path now calls the bounded range reader with `limit+1`; branch creation uses the same reader with exact `messageId` and limit 1. Resolve at most 100 small lineage records and fork anchors by primary key, truncate ordered thread ranges at inherited anchors, then use remaining-limit keysets per range. No full message history is assembled by either route. Tombstones remain anchors and returned read-only rows. The pure array assembler remains only for unit/reference behavior.

New index: `idx_fd_message_thread_effective_timeline`, `(workspace_id,channel_id,thread_id,date_trunc('milliseconds',created_at AT TIME ZONE 'UTC'),id) WHERE thread_id IS NOT NULL`. Unlike the ordinary thread index it includes tombstones. DDL lives inside the record-delta schema block, so both bootstrap and ensureRuntimeSchema install it. Ordinary CREATE INDEX can block writers during initial construction; manager must plan rollout, or prebuild the equivalent index concurrently outside the migration transaction before runtime migration. No shared migration was run here.

`flightdeck-branches-benchmark.json` records the exact captured service range query and EXPLAIN ANALYZE/BUFFERS. At 12,000 equal-timestamp messages and 50 nested branches, a 20-row page decodes exactly 20 message payloads / 56,469 total driver bytes. The range query uses the new index and examines 20 source rows, with no full-history sort. Total service median/p95 is 3.150/6.131 ms across 30 warm samples, including lineage/anchor round trips. Index size is 1,179,648 bytes on that fixture. The regression also tests inherited ancestor truncation, a deleted fork anchor, invalid anchors outside the effective prefix, following-page continuity and one-row branch-point validation.

Remaining branch limits: round trips scale with lineage depth (hard cap 100), and legacy message endpoints bound row count rather than serialized bytes; individually large message bodies/metadata can still create large pages. Existing chronological cursor and lineage concatenation semantics are retained, including their assumption that normal child messages follow inherited messages in time. Backdated imported child rows can retain the existing scroll anomaly; this patch does not redefine cursor order or fork semantics.
