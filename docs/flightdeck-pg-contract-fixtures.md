# Flight Deck PG Contract Fixtures

PH1-2 adds static, contract-first fixtures for the first Tower-hosted Flight Deck PG API surface. These files are intentionally not route implementations.

Fixture manifest:

- `fixtures/flightdeck-pg/manifest.json`
- `fixtures/flightdeck-pg/service-metadata.json`
- `fixtures/flightdeck-pg/workspace-descriptor.json`
- `fixtures/flightdeck-pg/me.json`
- `fixtures/flightdeck-pg/scopes-list.json`
- `fixtures/flightdeck-pg/scopes-create.json`
- `fixtures/flightdeck-pg/channels-list.json`
- `fixtures/flightdeck-pg/channels-create.json`
- `fixtures/flightdeck-pg/channel-threads-list.json`
- `fixtures/flightdeck-pg/channel-threads-create.json`
- `fixtures/flightdeck-pg/channel-messages-list.json`
- `fixtures/flightdeck-pg/channel-messages-create.json`
- `fixtures/flightdeck-pg/channel-grants-list.json`
- `fixtures/flightdeck-pg/channel-grants-create.json`
- `fixtures/flightdeck-pg/auth-error.json`
- `fixtures/flightdeck-pg/permission-denied.json`
- `fixtures/flightdeck-pg/validation-error.json`

The source-of-truth TypeScript fixture registry lives in `src/types.ts` as `flightDeckPgContractNames` and `flightDeckPgContractFixturePaths`. The OpenAPI document exposes the same registry through `x-flightdeck-pg-contract-fixtures` and marks each planned contract path with `x-flightdeck-pg-contract-fixture`.

Every fixture carries:

- `route`
- `method`
- `required_nip98_actor`
- `required_app_npub`
- `required_permissions`
- `stable_identity_fields`
- `request_shape`
- `response_shape`
- `example.request`
- `example.response`

Identity-bearing responses use `tower_service_npub`, `workspace_service_npub`, `workspace_owner_npub`, `workspace_id`, and `app_npub` under a shared `identity` object. Service metadata keeps workspace fields as `null` because the service route is public and not bound to one workspace.

The manifest also records the PH1-1 scope/channel/thread derivation rule for downstream tickets: `scope_id` is the authorization anchor, `channel_id` is the primary work surface, and `thread_id` is normalized for chat roots/replies while remaining nullable for records not attached to a thread.
