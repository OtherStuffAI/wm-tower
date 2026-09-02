# Flight Deck PG Backend Smoke

This smoke fixture covers the Phase 2 task-board story:

- Tower has workspace `Example`.
- Scope `Marketing` exists.
- Channels `Website` and `Blogs` exist.
- Operator can access both channels.
- Collaborator is granted `Website` only.
- Operator creates a `Website` task.
- Collaborator can read, update, state-change, and comment on the `Website` task.
- Collaborator cannot list `Blogs` tasks.
- Collaborator's `Marketing` scope task rollup includes the `Website` task and excludes the `Blogs` task.

Run it from `wingman-tower`:

```bash
bun run flightdeck-pg:smoke
```

The script runs `DB_USER=postgres DB_PASSWORD=postgres bun test tests/flightdeck-pg-smoke.test.ts`. The test creates and drops an isolated database named `coworker_v4_test_flightdeck_pg_smoke` unless `TEST_DB_NAME` is set.

For orchestrator review, a pass means the typed `/api/v4/flightdeck-pg` route stack admitted Operator to `Website` and `Blogs`, admitted Collaborator only to `Website`, allowed Collaborator's Website task update/state/comment actions, denied Collaborator's `Blogs` task list with `permission_denied`, and filtered Collaborator's scope rollup and event poll away from the Blogs task.

For manual operator verification against a running Tower, use the equivalent `flightdeck-cli` flow after preparing a descriptor and authorized signing keys:

```bash
node ../flightdeck-cli/src/cli.js scopes list --descriptor ./fixtures/flightdeck-pg/workspace-descriptor.json --key "$OPERATOR_NSEC"
node ../flightdeck-cli/src/cli.js channels list --descriptor ./fixtures/flightdeck-pg/workspace-descriptor.json --scope "$MARKETING_SCOPE_ID" --key "$COLLABORATOR_NSEC"
node ../flightdeck-cli/src/cli.js tasks list --descriptor ./fixtures/flightdeck-pg/workspace-descriptor.json --channel "$WEBSITE_CHANNEL_ID" --key "$COLLABORATOR_NSEC"
node ../flightdeck-cli/src/cli.js tasks state "$TASK_ID" --descriptor ./fixtures/flightdeck-pg/workspace-descriptor.json --state in_progress --row-version "$ROW_VERSION" --key "$COLLABORATOR_NSEC"
node ../flightdeck-cli/src/cli.js tasks comment "$TASK_ID" --descriptor ./fixtures/flightdeck-pg/workspace-descriptor.json --body "Smoke comment" --key "$COLLABORATOR_NSEC"
node ../flightdeck-cli/src/cli.js events poll --descriptor ./fixtures/flightdeck-pg/workspace-descriptor.json --cursor "$OPAQUE_NEXT_CURSOR" --key "$COLLABORATOR_NSEC"
```

The automated fixture owns the backend access assertions. Manual CLI verification should confirm behavior and JSON shape, including a denied `Blogs` task list for Collaborator and opaque event cursor handling.
