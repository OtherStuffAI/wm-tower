# Personal attention v1

Tower separates general resource activity from personal attention. Chat/thread
unread behavior is unchanged. All task and document activity remains syncable.
Files carry no personal attention; Flight Deck owns attachment Deck filtering.

Task and document rows expose additive, server-owned `attention` JSON:

- `policy_version: 1`
- `last_activity_actor_id`: canonical author of the latest activity
- `body_activity_version`, `body_actor_id`: document body activity position and author
- `mention_activity_versions`: highest surviving comment mention position per canonical actor UUID
- `comment_activity_versions`: exact event position per surviving comment UUID, used to recompute mentions

Positions use the existing `activity_version` sequence. Task attention qualifies
when assigned to the viewer, including structured `metadata.assigned_to_npub`,
or when a surviving comment mentions the viewer. Assignment transitions advance
activity, including metadata changes through agent helpers and the typed
assignment endpoints. Repeating an unchanged assignment does not advance it.
Task-body mentions alone do not qualify.

Document attention qualifies on body edits while the body mentions the viewer,
or on a comment mentioning the viewer. Unrelated comments, moves and title edits
do not advance the body position. New body mentions and recovery promotion are
body activity. Structured actor IDs take precedence over historical structured
npubs. Visible tags alone have no routing authority. Mention type must be a
person/agent identity, and the identity must belong to the workspace. Own-authored
activity follows the existing policy: the author's viewed position advances.

Editing/removing structured comment mentions or deleting a comment recomputes
attention from surviving comments. A later unrelated update preserves an unread
mention's original position and cannot revive it after it was read. Removing a
body mention cancels that body's eligibility without erasing independent comment
mentions.

Resource view-state responses add `attention_policy_version: 1`,
`attention_activity_version` and `attention_unread`. Legacy `unread` remains
`activity_version > viewed_activity_version`. Opening a resource still uses the
existing explicit per-user viewed API. Read state is scoped to actor/workspace;
new activity can rearm attention. Derived attention refreshes do not change the
viewed watermark, its row version or read timestamp.

The canonical record-delta projection stores those derived fields and
`activity_version` on view-state rows. Parent changes refresh existing viewer
projections through Tower triggers. V1 and device-checkpoint v2 serialize stored
rows, including immutable historical journal payloads; they do not query mutable
live attention to rewrite a delivered historical row. Delivery and checkpoint
acknowledgements never mark a resource read. No new sync network owner is added:
Tower → TowerSyncService → Dexie → liveQuery → UI remains the boundary.

Consumers should prefer canonical task/doc `attention` when available and use
personalized view fields as a fallback. Removing a mention can change attention
without changing general activity, so equal activity versions alone do not prove
that an older cached view projection is newer than a parent row.

The idempotent bootstrap/runtime migration initializes existing rows from exact
structured outbox event positions joined to surviving comments and workspace
membership. Historical document body activity uses evidence of a body-version
change or a newly added body mention. Missing history remains neutral; no latest
unrelated timestamp is substituted. Backfilled parent/view rows are captured by
record-delta triggers, so existing caches receive additive fields through normal
deltas. Existing viewed watermarks, legacy cursors, epochs and device checkpoints
are preserved. The established first-use legacy view baseline is unchanged;
record sync never introduces a read baseline.

Validation uses an explicitly disposable database port:

```bash
set -a
. ./.env.example
set +a
RECORD_TEST_PORT=<disposable-port> bun test ./tests/flightdeck-personal-attention.test.ts ./tests/flightdeck-record-delta.test.ts ./tests/flightdeck-record-checkpoints.test.ts
```

Source tests do not activate a running Tower. The supervising manager must
rebuild/restart the local Tower with `./rebuild_deploy_docker.sh`, verify
`curl http://127.0.0.1:3100/health`, then run authenticated assignment/mention/read
and v1/v2 smoke checks against the activated workspace backend before review.
Confirm the running backend's source/deployment mapping and identity when
checking its HTTPS endpoint; a health response alone does not prove new code.
