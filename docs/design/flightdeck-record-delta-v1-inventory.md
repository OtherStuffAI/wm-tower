# Tower record delta query and index inventory

Measured on an isolated local PostgreSQL 16 instance on macOS arm64; 30 warm samples per path. Full EXPLAIN ANALYZE/BUFFERS trees and storage sizes: `flightdeck-record-delta-v1-benchmark.json`. These timings exclude HTTP/NIP-98, browser materialisation, network latency and UI rendering. The full record-delta service measurement includes SQL authorization, bounded payload fetch, serialization and persisted progress cursor work.

| History | Old 50-row query median/p95 ms | Indexed 50-row query median/p95 ms | Record delta median/p95 ms | Delta bytes |
|---:|---:|---:|---:|---:|
| 1,000 | 0.357/0.462 | 0.196/0.523 | 1.285/1.950 | 1,259 |
| 10,000 | 2.029/2.946 | 0.195/0.519 | 1.218/1.923 | 1,260 |
| 100,000 | 9.816/10.187 | 0.165/0.180 | 0.651/0.735 | 1,261 |

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

10k-task board: 20 rows returned, PostgreSQL execution 0.023 ms. 10k-comment target: 20 rows returned, PostgreSQL execution 0.410 ms, including indexed actor lookup. SQL plans preserve the exact predicates and row counts.

## Write and storage cost

The counter serializes writers within each workspace until commit. It provides commit order, but increases contention and can require normal PostgreSQL deadlock/serialization retries for competing multi-record mutations. Large imports should use bounded batches. An exploratory single 90k-row transaction took 64.2 seconds; the final benchmark uses 1k-row transactions. It does not represent ordinary single-record writes. Initial schema backfill copies current rows without generating historical journal entries and holds source table locks while installing triggers.

- `flightdeck_pg_messages`: 57.41 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).
- `flightdeck_pg_record_current`: 108.79 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).
- `flightdeck_pg_record_journal`: 106.66 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).
- `idx_fd_message_timeline`: 13.39 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).
- `idx_fd_message_thread_timeline`: 0.01 MiB at 100k messages (includes relation indexes where reported by pg_total_relation_size).

Current records and canonical journal payloads deliberately duplicate data. The empty partial thread index avoids indexing null-thread messages. No journal pruning is implemented in v1; a future retention protocol must expire cursors and force reset before dropping replay history. Cursor rows themselves have bounded per-viewer retention.

Unmeasured acceptance: browser/mobile median/p95 and absolute product budgets; cold-cache and remote network behavior; large branched effective-transcript assembly still uses the legacy full-lineage helper. Separate directory, shared-personal, presence, invocation and WApp publishing APIs remain outside the negotiated record-family stream. No claim of whole-workspace or whole-UI boundedness is made.
