# USD prepaid hosting v1

Tower owns hosting accounts, immutable financial entries, usage evidence and Stripe
fulfillment. Ambulando reads these APIs through TowerSyncService, persists a
workspace/viewer partition in Dexie and renders liveQuery results. Checkout is a
separate signed command; a success redirect grants no credit.

## Enrollment and migration

New site-attested hosted signup requires `hosted-usd-v1` terms. The signup and
canonical PG setup service run account creation, owner-actor linkage, workspace
creation and welcome ledger insertion in the same transaction. The platform-admin
UUID creation path also requests hosted enrollment for new workspaces. Customer
identity is the owner's stable actor UUID, never the workspace service npub. One
account funds all their linked workspace UUIDs. Joining as a collaborator neither
creates a customer nor grants promotional credit.

The canonical setup service only enrolls newly inserted workspaces when explicitly
called with `hostedBilling: true`. Dev fixture/setup calls remain unbilled. Existing
workspaces and old hosted-free signups are not enrolled, backcharged or granted
new promotions. Their status is `legacy_unlinked`. Legacy MB-hour audit skips any
service-npub namespace linked to USD billing. No credit conversion is performed.
Changing an existing customer's ownership is not a billing transfer API.

The welcome grant is $5 once, expiring 30 days after customer creation. Admin and
paid credits do not expire. Expiry has an immutable ledger entry on the next
account mutation/meter transaction; status excludes expired promo immediately.
No Stripe Customer is created on reads; Checkout's local order and PaymentIntent
provide the customer-account binding for this first pass.

## Exact tariff and evidence

One decimal GB is 1,000,000,000 bytes. One fixed month is 720 hours. $5 per GB per
month equals one exact integer tariff unit per byte-hour, with 144,000,000,000
units per USD. NUMERIC(40,0) and bigint retain every unit; decimal USD fields are
12-place display truncations, not the accounting source. API units are strings.
Promo funds are spent first, then paid credits. Negative paid balance records
unfunded storage charges rather than silently discarding debits.

Each full UTC hour uses one instantaneous, contemporaneous workspace storage
sample. This is hourly sample billing, not time-integrated occupancy. The initial
partial UTC hour is skipped, not charged as a full hour. Objects and database
categories must both be available: completed linked object metadata (deduplicated
by storage path within the workspace), plus UTF-8 serialized logical direct
Flight Deck PG rows. Logical rows include retained history and metadata. Objects
include retained versions and deleted references still retained in those tables.
Shared object paths referenced from two workspace UUIDs count once in **each**
workspace, including two workspaces on the same account: independent workspace
retention attribution, not provider physical deduplication. This policy is exposed
in the collector's coverage and this contract; owner/account totals sum workspace
charges. Graph, Git/Forgejo, GRASP, external/unlinked storage, indexes, TOAST, WAL,
backups and shared infrastructure are excluded. Never infer missing totals.

Failed required measurement records `unavailable` and skips the whole affected
workspace-hour debit. A missing category is not zero. Historical samples are
immutable; there is no retry that substitutes today's bytes for past usage.
Collector transactions are SQL READ ONLY, bounded by statement timeout and table
cap. Use the dedicated disposable PostgreSQL fixture for tests, never a live or
production data store.

## Runtime and exhaustion

Tower's API entrypoint starts a minute tick after schema startup. A session-level
Postgres advisory lock on a reserved connection chooses a singleton across Tower
replicas. Every charge separately locks the customer row and has a unique
workspace/hour key; simultaneous audits and customer grants cannot race balances.
Ledger and usage evidence commit atomically with balance updates.

On restart, every missed hour since enabled_at/latest persisted sample is recorded
as `missed`, with zero debit. At most 744 hours per workspace are processed per tick;
subsequent ticks resume. Only a sample collected in the current hour can debit.
A failed tick is retried next minute. No timer or shell job outside Tower is needed.

A depleted customer is marked only by a valid complete metering transaction.
Unavailable measurement alone never marks depletion. Hosted PG/Drive/WApp mutations
are blocked at the shared UUID routing boundary with authenticated HTTP 402, and
legacy storage prepare honors linked service identity exhaustion. Read, export,
billing, Checkout and admin-credit APIs remain accessible. Customer funds restore
writes; retained storage may continue accruing hourly debits. The 21-day grace end
is informational; there is **no automatic deletion** or deletion worker. Billing
blocks do not redefine permission authority.

Account-wide hourly burn/runout require current-hour complete readings for every
linked workspace. Otherwise they are null. Runout incorporates promo expiry and
assumes current covered usage remains constant; unavailable stores stay excluded.

## Authenticated API

All paths are under `/api/v4/hosting-billing`:

| Method/path | Access/result |
| --- | --- |
| GET `/workspaces/:workspaceId/status` | Account owner or workspace.manage; shared balance, expiry, tariff, current measurements, burn/runout, Stripe availability |
| GET `/workspaces/:workspaceId/usage?limit=50` | Owner/manager; workspace-hour evidence, newest first, limit 1–200 |
| GET `/workspaces/:workspaceId/ledger?limit=50` | Owner gets shared financial ledger; manager gets workspace debits; newest first |
| POST `/workspaces/:workspaceId/checkout` | Account owner; amount_cents 500/1000/2500/5000/10000, idempotency_key, exact allowlisted return_url |
| POST `/workspaces/:workspaceId/grant` | Platform ADMIN_NPUB only; integer amount_cents 1–1000000, reason, idempotency_key; actor/reason audited |
| POST `/stripe/webhook` | Stripe raw-body signature, no NIP-98; server retrieves paid Checkout Session |

Both signed mutations use strict NIP-98 URL/method/body-SHA256 verification.
Idempotency key reuse with different content conflicts. Workspace admins cannot
mint money. Checkout creation does not persist account payment credentials in
browser state. Payment and grant amounts are nonexpiring USD credit.

## Stripe configuration and rollout gate

Configure server-only STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
HOSTING_STRIPE_MODE=test, and comma-separated HOSTING_STRIPE_RETURN_URLS (exact
URLs, not arbitrary client origins). No credentials or allowlist means HTTP 503
`stripe_unconfigured`. Never supply these keys to Vite/browser config. Stripe's
SDK verifies the unmodified request bytes asynchronously (required on Bun).

Checkout uses server-set USD line items, an immutable local order binding,
Stripe request idempotency, and metadata/client_reference_id. Only a verified,
server-retrieved **paid**, test-mode session with matching amount/currency/account
can grant credit. Order locks and unique PaymentIntent prevent duplicate credit
under concurrent/repeated/out-of-order events. Unpaid and unrelated events cannot
credit. Event failures return non-2xx so Stripe retries. The SDK's standard timestamp
tolerance rejects stale signatures. Browser redirect parameters have no authority.

**Live mode is blocked with `stripe_live_rollout_blocked`.** Refund/dispute ledger
reconciliation and real provider acceptance remain required before lifting that
block. This first pass neither claims refunds/disputes are handled nor silently
permits live payments. Synthetic signed fixtures prove code behavior only. Test
Checkout → verified provider webhook → observed account balance must be demonstrated
using authorized credentials before claiming payment readiness.

Official implementation references:
[Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted)
and [Stripe webhooks](https://docs.stripe.com/webhooks).

## Validation

Rebuild local Tower with `./rebuild_deploy_docker.sh` before source-backed tests.
Use `.env.example` and a dedicated disposable PostgreSQL port:

```sh
set -a
. ./.env.example
set +a
HOSTING_TEST_PORT=55434 bun test ./tests/hosting-billing.test.ts
DB_HOST=127.0.0.1 DB_PORT=55434 DB_USER=postgres DB_PASSWORD=postgres bun test ./tests/flightdeck-pg-hosted-signup.test.ts
USAGE_TEST_PORT=55434 bun test ./tests/workspace-storage-usage.test.ts
bun run privacy:check
```

The fixture databases are uniquely named where supported and contain synthetic
identities/data; no real account payment test or key search is performed.
