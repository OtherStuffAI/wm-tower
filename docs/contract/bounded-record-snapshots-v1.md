# Negotiated bounded record snapshots v1

Tower adds two opt-in supplements to `/api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync` (P). They reuse v2 registration, server-owned opaque cursors, transactional record clock, cache-specific checkpoints and acknowledgement. Protocol versions remain `[1,2]`; v1, unextended v2 and legacy `/sync` retain their wire semantics.

Discover `record_sync.extensions` on authenticated `GET /api/v4/flightdeck-pg/service`. Select `extension=bounded_snapshot_v1` on every v2 page. A dependent extended cursor cannot downgrade (`400 extension_required`). Unknown extensions or extensions on v1 return `400 unsupported_extension`. Registration and acknowledgement keep `protocol_version=2` and the existing NIP-98 exact URL/body signatures.

## Finite convergence

An extended page adds:

```json
{"handover":{"target_position":"123","through_position":"120","complete":false,"authority_epoch":"<uuid>","access_revision":"4"}}
```

Positions are decimal integer strings; compare as BigInt. The target is null until snapshot traversal finishes. Bootstrap boundary B comes from the committed workspace clock at registration. Extended snapshot scans use the existing `(family,id)` keyset and only current rows with `position <= B`. A later insert, update, move or deletion is repaired by journal replay after B. This excludes continually arriving rows from the finite snapshot scan without truncating or silently skipping them.

At snapshot completion, Tower pins target T to the committed clock visible in that page transaction. Delta metadata scans use `B < position <= T` (then the ordinary continuation position). Writers increment the workspace clock transactionally while holding its row lock until commit; a late transaction cannot publish a smaller position after T is certified. Ordinary content writes never increase T during its round. A newly observed authority gain extends T to that page’s committed clock when necessary: a historic row updated beyond the old T would otherwise be excluded by both the current-row catchup cutoff and the bounded journal. Clients accept this repair target when `access_revision` changes; loss alone does not extend it. After scanning the finite prefix, `through_position` advances to T, including sparse/hidden prefixes. Subsequent writes remain available for the next round.

`complete=true` and `has_more=false` require snapshot traversal plus the journal prefix through T and drained current-authority access notifications/historic catchups. Snapshot completion alone always requires delta handover. Empty pages with `has_more=true` are progress. The next request after a complete round pins a new target. Persist and acknowledge each page before using its continuation.

This certifies a convergent committed journal prefix, **not a frozen historical export**. Authority is current on every page. Historic catchups retain their independent cutoff/keyset; they never rewind the ordinary position. Permission loss cancels pending catchups and denies future forbidden reads. Continuous content writes do not extend a round; new authority gains may extend its repair target, and continuous authority churn may prevent certification. A certificate never makes retained downloads currently authorized evidence.

Negotiated pages acquire the workspace clock share lock first under read committed, waiting for any active writer and then reading its committed position. All record/authority mutations take that clock lock before commit, so workspace payloads and authority remain stable for the bounded page. Writers may begin mutations but cannot commit them during this fence. This avoids an endless sequence of repeatable-read scan aborts under continuous content writes. Ordinary v1/v2 retain their repeatable-read scans and short end-of-page fence. Chunk reads use the same negotiated fence; profile labels remain independent, so the chunk slice and pinned digest are checked in one SQL statement. Deadlock/serialization failures still retry up to three attempts; failed transactions mint no cursor. The cost is write-commit contention for the duration of one bounded page/chunk, measured separately from query latency.

## Complete page bounds and coverage

The 1,048,576-byte UTF-8 limit applies to the **entire serialized JSON page**, including actors, access notifications, manifests and handover/checkpoint metadata. Maximum total entries are 200: canonical changes + distinct actor sidecars + access changes + manifests. Caller limit limits scanned canonical/access entries; it does not enlarge either ceiling. Metadata scans precede canonical payload reads and SQL profile sizing precedes actor decoding. The profile fetch statement also enforces the aggregate byte budget atomically, so a concurrent harmless label expansion cannot cause an oversized driver decode; it defers the change or issues a negotiated manifest. There is a final serialized-byte check inside the cursor transaction; overflow is 413 with no advancement.

Coverage is exactly the advertised `families`: scope_order, scope, channel, thread, message, task, task_comment, task_assignment, doc, doc_comment, file, file_folder, audio_note, daily_note, personal_wapp, resource_view_state, autopilot_connection, workspace_agent, feed_subscription, feed_item_state, context_component and context_reference. Each registry family has a canonical mutation trigger; existing fixtures check all table columns. Directory, approvals, graph, WApp activity and other unadvertised subsystems require their separately authorized APIs. Omission from a page never means deletion. Explicit newer tombstones are the deletion signal.

## Individually oversized rows or actor sidecars

Schema/write inventory permits canonical message bodies and actor display names above the page limit. Isolated fixtures demonstrate a 1.2 MB UTF-8 message and a 1.1 MB actor label; even a small canonical row can require this extension. No production payloads or keys are exported for this inventory.

Without explicit chunk negotiation the existing behavior remains `413 record_too_large`, with no cursor/checkpoint advancement. Clients must report incomplete coverage. Never truncate or skip the offending record.

Select `large_records=chunked_v1` along with `extension=bounded_snapshot_v1` on every dependent page. For an individually oversized authorized change plus its sidecars, a standalone page has empty `changes` and `actors` and one `large_records` descriptor:

```json
{"manifest_id":"<uuid>","family":"message","id":"<record-id>","version":"123","sha256":"<64 lowercase hex>","total_bytes":1201000,"chunk_bytes":262144,"chunk_count":5}
```

This manifest replaces exactly one change at its normal cursor position. `large_records: []` appears on other chunk-negotiated pages. `handover.complete` is usable only after every manifest is verified and materialized along with that page; receipt of descriptor metadata alone is not complete delivery.

Read zero-based chunks with authenticated exact-URL signatures:

```text
GET P/clients/{clientId}/pages/{page.next_cursor}/large-records/{manifest_id}/chunks/{index}?protocol_version=2
```

Responses are `application/octet-stream`, `Cache-Control: no-store`, at most **262144 raw bytes**. Concatenation yields one UTF-8 JSON envelope `{"change":<full canonical change>,"actors":[<typed referenced identities>]}`. UTF-8 characters may cross chunk boundaries: assemble bytes before decoding. Verify exact total length and SHA256 before parsing and atomically materializing the canonical change, sidecars and cursor. Version comparison/deletion rules are unchanged.

The server constructs and hashes the complete envelope in SQL. The driver receives only size/digest/manifest metadata or one byte slice. No duplicated large payload is stored: the opaque page token contains small source/version/authority context and digest metadata referring to the existing canonical projection or immutable journal payload. Current snapshot/catchup source position is separate from its wire version. Journal payloads remain pinned to their original version.

Membership, partition read authority, client/token expiry, epoch and source/profile digest are rechecked for every chunk and first acknowledgement. A current-row version change or profile change invalidates unfinished assembly; immutable retained journal versions can still be read while replaying newer versions. Source disappearance/pruning also invalidates assembly. Discard it and request from the prior durable cursor. Never advance from a failed chunk/ack.

Acknowledgement adds:

```json
{"cursor":"<page.next_cursor>","expected_revision":"<page.checkpoint_revision>","large_record_receipts":[{"manifest_id":"<uuid>","sha256":"<digest>"}]}
```

Receipts attest client digest verification and local atomic commit; the server cannot inspect a client's local database. Missing/wrong receipts return `409 large_record_receipt_required`. Fetching past an unacknowledged manifest page returns `409 large_record_ack_required`, preventing acknowledgement of a later page from bypassing assembly. Already-successful acknowledgements retry idempotently with the matching receipts, even if the disposable token/source has since changed/expired. Membership/epoch/history checks still apply on retry; partition revocation does not undo a committed acknowledgement or purge downloads, consistent with existing v2 policy.

Errors include `400 invalid_chunk`, `400 invalid_large_record_receipts`, `403 record_access_required`, `409 page_token_invalid`, `409 large_record_changed`, and existing v2 errors. Errors never advance checkpoints. Client IDs must be canonical lowercase nonzero UUIDs.

Lifetime/quota reuse the existing 512 temporary tokens/cache, 32 active caches/actor/workspace, seven-day token idle expiry and 90-day client idle expiry. Valid chunks renew token use, not checkpoint progress. Server current/journal/profile storage and PostgreSQL JSON/text datum limits remain the existing total-record bound; this extension imposes no new write-size limit. A combined envelope that hits PostgreSQL program-size limits still fails closed with 413 before minting a cursor. Chunk support is not a guarantee for every arbitrarily large combination of legal profiles and rows. Database serialization/hash CPU and memory are proportional to one record and repeated per chunk; the extension bounds driver/network bytes, not that database work. Very large PostgreSQL-legal payloads require separate operational benchmarking; no universal p95 guarantee is claimed.

## Validation and activation

`tests/flightdeck-bounded-snapshots.test.ts` uses its own database on an explicitly selected isolated Postgres port (never 5432). `tests/fixtures/bounded-record-snapshots-v1.json` provides portable frames and a deterministic envelope recipe. `tests/fixtures/bounded-record-snapshots-v1.ts` generates deterministic manifest/chunk/ack/empty-progress/error wire fixtures without a database. `tests/fixtures/bounded-snapshot-workload.ts` is reusable by sibling repositories: it supplements real 100k-message/2095-comment histories with >10k real rows in every domain table, exercising foreign keys and canonical mutation triggers. Real scopes/channels deliberately lack grants, and other actors’ scope orders are private, proving empty-progress traversal and independent authorized counts without manufacturing projection identities. This does not benchmark >10k independently granted partitions. Domain lifecycle, all-family trigger/column parity, late commits, moves/deletes, authority and expiry are covered by the existing isolated suites.

Operational EXPLAIN/byte/latency logs belong in ignored `tmp/docs/handoffs/`, not this reusable contract. HTTPS/FIPS slow-link consumer tests and client cache/crash tests belong to their respective repositories. No transport fallback is introduced.

After managerial acceptance, rebuild/restart **local Tower** before live validation:

```sh
./rebuild_deploy_docker.sh
curl --fail http://127.0.0.1:3100/health
```

Then use broker-signed discovery, register a fresh disposable cache identity, page with both extensions, verify full page bytes and a complete handover, test a pinned chunk fixture in an isolated workspace, acknowledge after materialization and retry that ack; retire the test client. Do not mutate existing staging/production test data. Run the native package checks with `.env.example` and the explicit isolated port. Workers must not restart shared Tower or Autopilot. Source validation does not claim live activation.
