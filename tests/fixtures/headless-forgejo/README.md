# Headless Forgejo shipped-helper smoke

Requires Docker, Bun, Git, OpenSSL, and the sibling Autopilot checkout (or `AUTOPILOT_REPO`). Uses isolated PostgreSQL on 35432 and Forgejo on 33300, synthetic actors, ephemeral Tower/gateway/broker servers, and the actual compiled Autopilot credential helper. No running Autopilot restart, browser login, production credentials, or grant revoke/restore cycle.

```sh
docker compose --project-name tower-headless-bootstrap-fixture -f tests/fixtures/headless-forgejo/docker-compose.yml up -d
set -a
. ./.env.example
set +a
DB_PORT=35432 DB_PASSWORD=headless-fixture-only GIT_SERVICE_AUDIENCE=headless-fixture GIT_INTERNAL_SERVICE_TOKEN=fixture-internal-token-000000000000000000 GIT_CAPABILITY_HASH_KEY=fixture-capability-key-000000000000000000 bun tests/fixtures/headless-forgejo/smoke.ts
```

Wait for both fixture services to accept connections before invoking the smoke. The printed JSON must report `passed: true`. It covers fresh and concurrent bootstrap, repeat idempotence, clone/fetch, work-branch push, protected-branch denial, no-grant denial, and foreign-workspace denial. Generated database and temporary helper/key material are removed in `finally`; disposable Forgejo accounts remain in fixture volumes, with fresh names per run. Never point this fixture at production. The fixture intentionally publishes its private provider API only on loopback for synthetic test setup; production keeps it private.

The broker and session stores are instantiated with synthetic adapters. A real hosted Lara session, deployed capability issuance, deployed worker configuration, installed skill distribution, and production repository grants still require manager acceptance after rollout.
