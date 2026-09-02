# Superbased Commercialisation Plan

## Context

Superbased is the public protocol/product name. Wingman Tower is the implementation that hosts Superbased workspaces. Tower needs a public surface where a user can sign in, create a workspace, generate app connection details, inspect the records/storage that exist in that workspace, and buy usage credits that keep the workspace online.

The useful existing pieces are:

- Tower already owns workspace bootstrap in `POST /api/v4/workspaces`, workspace listing in `GET /api/v4/workspaces`, encrypted record sync in `/api/v4/records`, object metadata in `v4_storage_objects`, and admin connection-token generation in `GET /api/v4/admin/workspaces/:workspaceId/connection-token`.
- Tower has a small admin web at `/table-viewer`, but public workspace onboarding and billing should not be admin-only.
- Tower currently has `user_profiles.credit_balance`, but the proposed billing unit is the workspace, not the user. Do not build on that column except as legacy/unrelated profile state.
- Ambulando in `~/code/tracker` already implements the payment shape: Mginx product lookup, order creation, local order mirroring, status polling, idempotent crediting, transactions, audit log, and hourly deduction.
- The Mginx/NWCLI code in `~/code/z_archive/nwcli` exposes the merchant backend Tower can call: `GET /api/products/:id`, `POST /api/orders`, and `GET /api/orders/:id/status`. Products carry `priceSats`; orders carry `invoice`, `amount_sats`, `status`, `expires_at`, and product metadata.

Mginx should stay payment-only. It sells credits at the configured sats-per-credit price and manages payment intent, invoices, and payment status. Tower owns workspace balances, metering, enforcement, grace periods, and any future retention/deletion policy.

## Product Model

Commercial billing should be workspace-scoped.

- A workspace has one credit balance.
- The workspace `creator_npub` is initially responsible for funding it.
- Credits are consumed by the workspace regardless of which member wrote records or storage objects.
- Multiple workspaces owned by the same human require separate balances.
- The UI should make the responsible workspace obvious before purchase.

The first credit definition should be simple and explicit:

- `1 credit = 1 MB-hour` of billable workspace usage.
- The product price is sats per credit, fetched from Mginx.
- Storage is sampled hourly and charged as `ceil(billable_mb)` credits for that hour.
- Initial workspace credit grants should be configurable with an env setting, expressed in credits/MB-hours.

I would avoid hard-coding "256 sats per hour" in Tower. The durable concept should be "credits", and Mginx product price should define sats per credit. Tower can display the current derived price as sats per MB-hour.

Possible future extension: user-owned balances. A user could buy credits into a personal account, own multiple workspaces, and let those workspaces draw down from the user's balance. That is not needed for v1 and should not complicate the first workspace billing implementation.

## Usage Classes

Start with one pooled billable size and keep enough schema room to split it later.

Billable v1:

- encrypted record storage: bytes held in `v4_records.owner_ciphertext` plus `v4_record_group_payloads.ciphertext`
- object storage: completed rows in `v4_storage_objects.size_bytes`

Future split:

- record MB-hours can price higher because Postgres storage, indexes, backups, and query load are more expensive than raw object storage
- object MB-hours can track S3/MinIO/Satellite CDN costs separately
- backup retention can become its own usage class

For v1, charge the same credit pool for both classes and record the measured components in each audit row so the split can happen later without losing history.

## Tower Data Model

Add billing tables to Tower Postgres rather than overloading `user_profiles`.

```sql
CREATE TABLE workspace_credit_accounts (
  workspace_owner_npub TEXT PRIMARY KEY REFERENCES v4_workspaces(workspace_owner_npub) ON DELETE CASCADE,
  balance_credits NUMERIC(20, 6) NOT NULL DEFAULT 0,
  low_balance_threshold_credits NUMERIC(20, 6) NOT NULL DEFAULT 24,
  billing_state TEXT NOT NULL DEFAULT 'active',
  depleted_at TIMESTAMPTZ,
  delete_eligible_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (billing_state IN ('active', 'low_balance', 'read_only_grace', 'delete_eligible', 'suspended'))
);

CREATE TABLE workspace_credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL REFERENCES v4_workspaces(workspace_owner_npub) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount_credits NUMERIC(20, 6) NOT NULL,
  balance_before_credits NUMERIC(20, 6) NOT NULL,
  balance_after_credits NUMERIC(20, 6) NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE workspace_credit_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL REFERENCES v4_workspaces(workspace_owner_npub) ON DELETE CASCADE,
  requested_by_npub TEXT NOT NULL,
  mginx_order_id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  quantity_credits NUMERIC(20, 6) NOT NULL,
  amount_sats INTEGER NOT NULL,
  bolt11 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  CHECK (status IN ('pending', 'paid', 'expired', 'cancelled'))
);

CREATE TABLE workspace_usage_hourly_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL REFERENCES v4_workspaces(workspace_owner_npub) ON DELETE CASCADE,
  hour_start TIMESTAMPTZ NOT NULL,
  record_bytes BIGINT NOT NULL DEFAULT 0,
  object_bytes BIGINT NOT NULL DEFAULT 0,
  billable_bytes BIGINT NOT NULL DEFAULT 0,
  billable_mb NUMERIC(20, 6) NOT NULL DEFAULT 0,
  credits_charged NUMERIC(20, 6) NOT NULL DEFAULT 0,
  balance_after_credits NUMERIC(20, 6) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_owner_npub, hour_start)
);
```

Keep the order table separate from transactions. Orders are payment intent and invoice state; transactions are the authoritative ledger of balance changes.

## Accounting Rules

The account service should be transaction-first and idempotent.

- Create a credit account automatically when a workspace is created.
- Credit purchases only after Mginx reports `paid`.
- Re-check the local order row inside the same DB transaction before crediting, so repeated status polling cannot double-credit.
- Hourly charging should use a unique `(workspace_owner_npub, hour_start)` row to prevent duplicate deductions.
- The transaction log is append-only. Balance is a cached total on `workspace_credit_accounts`.

Suggested transaction types:

- `purchase`
- `hourly_usage`
- `manual_adjustment`
- `refund`
- `migration_grant`

For credit-exhausted workspaces, start by blocking new writes and uploads while still allowing reads/export. Do not make data inaccessible as the first commercial enforcement mechanism.

## Billing Modes

Tower should support paid hosted mode and self-hosted/free mode through configuration.

Recommended config:

```env
SUPERBASED_BILLING_MODE=disabled|metered
SUPERBASED_BILLING_GRACE_DAYS=21
```

Default should be `disabled` for local/self-hosted deployments unless the hosted environment explicitly enables metering. This is simpler and cleaner than "infinite credits": enforcement and hourly deduction can no-op in disabled mode, while the paid path still exercises the real balance logic in hosted mode.

Behavior by mode:

- `disabled`: no hourly deductions, no insufficient-credit write blocking, billing APIs can return `{ "billing_mode": "disabled" }`.
- `metered`: create workspace credit accounts, run hourly audits, enforce read-only grace, and expose purchase/status APIs.

## Grace And Retention

When a workspace runs out of credits in hosted/metered mode:

1. Move the account to `read_only_grace`.
2. Set `depleted_at = now()`.
3. Set `delete_eligible_at = depleted_at + SUPERBASED_BILLING_GRACE_DAYS`.
4. Pause writes and uploads.
5. Continue allowing reads and exports during the grace period.

The default grace period should be 21 days. Hosted production can override it to 7 days later if needed.

Deletion does not need to be implemented in v1. The first implementation should only mark workspaces as `delete_eligible` after the grace period. A later retention worker can delete or archive data once the product and legal language are settled.

If the workspace receives enough credits during grace, reactivate writes and clear `delete_eligible_at`. The unresolved product decision is whether the workspace must catch up for the grace-period storage that Tower continued to hold. The implementation should keep enough audit data to support either policy:

- lenient restore: purchased credits only need to cover future usage
- catch-up restore: purchased credits first pay the unpaid retained MB-hours, then writes resume

My lean for v1 is lenient restore because it is easier to explain and avoids surprise invoices. Keep hourly usage audits running during grace so catch-up can be added later without schema churn.

## Measuring Usage

Add a Tower service that computes current usage for one workspace:

```sql
SELECT COALESCE(SUM(octet_length(owner_ciphertext)), 0) AS owner_record_bytes
FROM v4_records
WHERE owner_npub = $workspace_owner_npub;

SELECT COALESCE(SUM(octet_length(ciphertext)), 0) AS group_payload_bytes
FROM v4_record_group_payloads rgp
JOIN v4_records r ON r.id = rgp.record_row_id
WHERE r.owner_npub = $workspace_owner_npub;

SELECT COALESCE(SUM(size_bytes), 0) AS object_bytes
FROM v4_storage_objects
WHERE owner_npub = $workspace_owner_npub
  AND completed_at IS NOT NULL;
```

This is good enough for v1. Later we can replace it with rollups if usage grows.

Record history is billable immediately. Current Tower keeps all versions in `v4_records`, so stored bytes are billable, including history.

## Mginx Integration

Mirror Ambulando's approach, adapted to workspace scope:

- `src/services/mginx.ts`
  - env: `MGINX_URL`, `MGINX_API_KEY`, `SUPERBASED_CREDITS_PRODUCT_ID`
  - `getProduct()`
  - `createOrder(quantityCredits, metadata)`
  - `getOrderStatus(mginxOrderId)`
- `src/services/billing.ts`
  - account status
  - purchase creation
  - payment status refresh
  - idempotent crediting
  - hourly usage deduction
- `src/routes/billing.ts`
  - public authenticated billing APIs

Mginx product metadata should identify the product as `superbased_workspace_credit_v1` and describe the unit as `MB-hour`. Tower should send order metadata including `workspace_owner_npub`, `requested_by_npub`, and Tower service identity so Mginx-side reports can be reconciled.

## Tower API

Add authenticated, workspace-scoped routes:

- `GET /api/v4/billing/workspaces`
  - dashboard summary for every workspace the authenticated user can manage
  - returns balance, billing state, current usage, estimated credits/hour, and estimated runout time per workspace
- `GET /api/v4/workspaces/:workspaceOwnerNpub/billing/status`
  - standard lightweight status API for both the Superbased dashboard and downstream apps such as Flight Deck
  - returns the same status shape used inside the dashboard for one workspace
- `GET /api/v4/workspaces/:workspaceOwnerNpub/billing`
  - detailed billing view for one workspace: account balance, billing state, latest usage, current product price, pending orders
- `GET /api/v4/workspaces/:workspaceOwnerNpub/billing/transactions`
  - ledger history
- `POST /api/v4/workspaces/:workspaceOwnerNpub/billing/purchase`
  - body: `{ "quantity_credits": 1000 }`
  - returns local order id, Mginx order id, sats amount, invoice, expiry
- `GET /api/v4/workspaces/:workspaceOwnerNpub/billing/orders/:orderId/status`
  - refreshes Mginx status and credits account if paid
- `GET /api/v4/workspaces/:workspaceOwnerNpub/usage`
  - current record bytes, object bytes, billable MB, estimated credits/hour
- public connection-token generation for manageable workspaces
  - must reject token generation when the workspace is in `read_only_grace`, `delete_eligible`, or `suspended`

Authorization should use `canManageWorkspace()` for purchases and billing history. Ordinary members can see a minimal "workspace billing unavailable/low/read-only" status if needed, but invoices and transaction history should be admin-only.

The status response should be stable and shared by the Superbased UI and consuming apps:

```json
{
  "billing_mode": "metered",
  "workspace_owner_npub": "npub...",
  "workspace_name": "Acme Workspace",
  "billing_state": "low_balance",
  "balance_credits": "120.000000",
  "usage": {
    "record_bytes": 1048576,
    "object_bytes": 2097152,
    "billable_bytes": 3145728,
    "billable_mb": "3.000000",
    "estimated_credits_per_hour": "3.000000"
  },
  "estimated_runout_at": "2026-05-01T16:00:00.000Z",
  "depleted_at": null,
  "delete_eligible_at": null,
  "billing_url": "https://..."
}
```

For `SUPERBASED_BILLING_MODE=disabled`, the same endpoint should return `billing_mode: "disabled"`, `billing_state: "disabled"`, no runout time, and no write-blocking risk.

Billing errors should be machine-readable so downstream Superbased apps can show useful recovery UI:

```json
{
  "error": "workspace has run out of credits",
  "code": "insufficient_credits",
  "status": 402,
  "workspace_owner_npub": "npub...",
  "billing_state": "read_only_grace",
  "depleted_at": "2026-04-29T00:00:00.000Z",
  "delete_eligible_at": "2026-05-20T00:00:00.000Z",
  "billing_url": "https://..."
}
```

Use this response for write paths that are blocked by billing. HTTP `402 Payment Required` is appropriate for hosted mode. Clients should branch on `code === "insufficient_credits"` rather than parsing the message.

## Enforcement Points

Do not enforce in the UI only. Tower should check billing state before accepting new billable writes.

Initial enforcement:

- `POST /api/v4/records/sync`: reject new writes when the workspace is `read_only_grace`, `delete_eligible`, or `suspended`
- `POST /api/v4/storage/prepare`: reject new uploads when the workspace is `read_only_grace`, `delete_eligible`, or `suspended`
- public connection-token generation: reject new tokens when the workspace is `read_only_grace`, `delete_eligible`, or `suspended`

Reads should continue:

- `GET /api/v4/records`
- `GET /api/v4/records/summary`
- `GET /api/v4/records/:record_id/history`
- storage download routes

This gives users a clean recovery path: buy credits, then writes resume.

## Public Onboarding UI

This belongs in the Tower-specific UI, with Flight Deck integration where appropriate. A user should be able to go to a Tower-hosted UI such as `sb4.tower.example.invalid/ui`, sign in, and register a new workspace on that Tower infrastructure without first going through Flight Deck.

Required flow:

1. Sign in with Nostr.
2. Create a Superbased workspace.
3. Generate a workspace service identity and app namespace.
4. Show connection details for Flight Deck/Yoke/app clients.
5. Let the user inspect workspace records and storage metadata.
6. Show billing status and buy workspace credits.

The Superbased dashboard is required for hosted users. On login it should show all workspaces the user can manage, remaining credits for each workspace, current MB-hour burn rate, and estimated runout time. The per-workspace billing page should reuse the same status API that downstream apps call, so Flight Deck and other clients display the same balance and risk state as the dashboard.

The existing admin token route can be the model, but the public version must be scoped to workspaces the signed-in user can manage. It should not require `ADMIN_NPUB`.

The "app namespace" should be explicit in the UI. At minimum, store/show:

- app name
- app npub
- workspace owner/service npub
- direct Tower URL
- connection token/package

App namespaces are persisted server-side in v1. Tower stores the list of apps that have been created for a workspace so the Tower UI can show "apps available inside this workspace" and let users regenerate connection details later. Add a table such as `workspace_apps` instead of treating `app_npub` as an ephemeral query string:

```sql
CREATE TABLE workspace_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL REFERENCES v4_workspaces(workspace_owner_npub) ON DELETE CASCADE,
  app_npub TEXT NOT NULL,
  app_name TEXT NOT NULL,
  created_by_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_owner_npub, app_npub)
);
```

## Record/Storage Inspection

Because most payloads are encrypted, the inspection UI should be honest:

- show record family hash, record id, latest version, ciphertext sizes, timestamps, signer, and group payload count
- show storage object filename, content type, size, public flag, completed state, creator, and access groups
- do not imply Tower can decrypt record bodies
- provide filters by record family, object type, public/private, and date

This can start as a polished version of `/table-viewer` scoped to the current workspace.

## Implementation Sequence

1. Add billing schema migration and TypeScript types.
2. Add `billing` and `mginx` services with tests for idempotent purchase crediting and hourly deductions.
3. Add billing routes and wire them into `src/server.ts`.
4. Add usage measurement endpoint and tests against records plus storage objects.
5. Add `SUPERBASED_BILLING_MODE` and `SUPERBASED_BILLING_GRACE_DAYS` config.
6. Add configurable initial workspace credit grants.
7. Add shared billing status APIs for all managed workspaces and one workspace.
8. Add hourly billing runner. In production, run it under the same supervisor strategy used for Tower deploys; locally, expose a script command.
9. Add write and connection-token enforcement with `insufficient_credits` responses.
10. Add grace-period state transitions and mark-only `delete_eligible` handling.
11. Add public workspace onboarding and billing UI.
12. Add app namespace persistence.
13. Add operational dashboards: low-balance workspaces, read-only grace workspaces, delete-eligible workspaces, recent usage audits, unpaid orders.

## Validation

Minimum automated coverage:

- workspace creation creates a credit account
- purchase order creation stores the local order and returns the Mginx invoice fields
- paid order status credits exactly once when polled multiple times
- hourly audit charges each workspace at most once per hour
- hourly audit rounds billable usage up to the next MB
- disabled billing mode does not deduct credits or block writes
- initial workspace credit grant follows env configuration
- billing status API returns the same status shape used by the dashboard and downstream apps
- all-workspaces billing summary only includes workspaces the user can manage
- record bytes and storage bytes are measured correctly
- record history bytes are included in billable usage
- read-only grace workspace cannot sync records or prepare uploads
- read-only grace workspace cannot generate new connection tokens
- read-only grace workspace can still read/export records and storage metadata
- blocked writes return `code: "insufficient_credits"` and useful grace/deletion dates
- non-admin workspace member cannot buy credits or see billing ledger
- workspace admin can buy credits and see billing ledger

## Settled Decisions

- Public protocol/product name is Superbased.
- Wingman Tower is the implementation.
- Onboarding is Tower-specific: `sb4.tower.example.invalid/ui` should let users register a new workspace on Tower infrastructure directly.
- V1 charges by rounding billable usage up to the next MB on each hourly audit.
- Initial workspace credit grant is configurable by env setting, expressed in credits/MB-hours.
- Record version history is billable immediately.
- Grace-period restore is lenient for now; purchased credits only need to cover future usage.
- Read-only grace blocks writes, uploads, and connection-token generation.
- App namespaces are server-persisted in v1 so Tower can list workspace apps and regenerate connection details.

## Open Decisions

- Exact env variable name and default amount for initial workspace credit grants.
- Whether public connection-token generation is its own route or a non-admin mode of the current admin token builder.

## Recommendation

Ship the smallest coherent paid loop first: workspace-scoped credit accounts, Mginx purchases, hourly MB-hour audits, configurable self-hosted billing-disabled mode, write blocking during read-only grace, and a public workspace billing panel. Keep record and object storage under one price for v1, but record usage components separately from day one so the pricing model can split cleanly later.
