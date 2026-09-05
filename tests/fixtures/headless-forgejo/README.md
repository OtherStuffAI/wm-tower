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

## Forgejo browser sharing bridge

The same isolated fixture can exercise the gateway's real collaboration page in
Chromium, then use the compiled shipped helper to clone/fetch/push. The Nostr
signer and broker/session stores use synthetic fixture identities; this is not a
production browser login or a Lara session.

Install Playwright outside the repository and use an installed Chrome binary
(or omit `CHROME_EXECUTABLE` after installing Playwright's Chromium):

```sh
mkdir -p /tmp/forgejo-bridge-browser
bun add --cwd /tmp/forgejo-bridge-browser playwright@1.55.0

docker compose --project-name tower-headless-bootstrap-fixture \
  -f tests/fixtures/headless-forgejo/docker-compose.yml up -d
set -a
. ./.env.example
set +a
DB_PORT=35432 DB_PASSWORD=headless-fixture-only \
GIT_SERVICE_AUDIENCE=headless-fixture \
GIT_INTERNAL_SERVICE_TOKEN=fixture-internal-token-000000000000000000 \
GIT_CAPABILITY_HASH_KEY=fixture-capability-key-000000000000000000 \
FORGEJO_SHARING_SMOKE=1 \
PLAYWRIGHT_MODULE=/tmp/forgejo-bridge-browser/node_modules/playwright/index.mjs \
CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
bun tests/fixtures/headless-forgejo/smoke.ts
```

Expected output includes `sharing: passed` and `passed: true`. The screenshot is
saved to `/tmp/forgejo-sharing-smoke.png` (override with `SHARING_SCREENSHOT`).
Coverage includes direct Write addition, Read downgrade, old-capability denial,
work push and protected push policy, group inheritance, final revocation,
provider-only `tower-members` repository cleanup, immutable identity mismatches,
foreign actors/groups, unauthorized administrators, payload tampering, replay,
last-admin protection (including empty groups and populated nested groups),
competing revision-checked edits, exclusive reconciliation, stopped-writer
abandonment recovery, and stale acknowledgement/readiness. Gateway unit tests
also cover duplicate-slash paths that stock Forgejo normalizes before routing. No blanket grant or provider-state import
is used to obtain the passing result.
