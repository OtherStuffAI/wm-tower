# Startup record position repair

The additive record access migration repairs canonical rows whose position is zero
from the maximum retained journal position for the same `(workspace_id, family, id)`.
It aggregates the journal once and joins current rows, instead of running a
correlated full journal scan for each current row. The journal's primary key is
`(workspace_id, position)`; it does not support efficient per-record lookups.
No additional permanent index or journal write overhead is required.

Rows without retained journal history, or with a maximum journal position of zero,
remain at zero and are not rewritten. Existing nonzero current positions are left
intact. A journal entry added later still repairs a zero-position row on the next
migration. The migration does not alter journal entries, canonical payloads,
clocks, epochs, grants, cursors or checkpoint state through position repair.

## Repeated startup work

On an existing record schema, the Docker entrypoint runs `db:init`, which executes
`ensureRuntimeSchema` and then the full bootstrap SQL. The API process executes
`ensureRuntimeSchema` again before listening. Each runtime ensure applies additive
record access before authority repairs and again with record/checkpoint installation.
Together these paths execute the position repair five times per container start.
The bootstrap and runtime additive SQL copies must remain identical.

The legacy record delta block reinstalls functions and authority triggers. It does
not reset canonical positions or replay the entire journal. Family initial-current
backfills run only when their capture trigger is absent. Context Tree recovery
changes epochs only when registering previously absent family triggers. Additive
cursor, client and page-token baselines are guarded by missing `access` state.
Rows legitimately lacking journal history may remain at zero indefinitely; this is
why position repair must be efficient and repeatable rather than gated by a global
one-time completion flag. Other startup schema/repair work remains unchanged.

## Validation

Use a dedicated disposable PostgreSQL endpoint, never the live Tower database:

```bash
RECORD_TEST_PORT=<dedicated-port> bun test ./tests/record-position-backfill.test.ts
set -a; . ./.env.example; set +a
RECORD_TEST_PORT=<dedicated-port> bun test ./tests/flightdeck-additive-record-access.test.ts --test-name-pattern 'runtime migration'
```

The position test covers multiple histories, namespace isolation, absent/zero
journal entries, nonzero-position preservation, later repair and repeat execution
without tuple rewrites. Its large fixture has 26,000 current rows and 62,000 journal
entries, with 6,000 rows lacking journal matches, and applies a five-second database
statement timeout. The existing full-runtime regression covers legacy function
replacement and cursor/checkpoint/epoch continuity across repeated migration calls.

After coordinated activation, measure container `StartedAt` to first successful
local health response, separately from image build time. Verify public health and
an authorized signed grants GET as well. Repeated live service restarts are not
needed to test migration repeatability; use the disposable database.
