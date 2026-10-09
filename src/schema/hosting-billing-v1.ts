// Exact tariff units: one USD = 144,000,000,000 units; one byte-hour = one unit.
export const hostingBillingV1Sql = `
CREATE TABLE IF NOT EXISTS hosting_accounts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_actor_id UUID NOT NULL UNIQUE REFERENCES flightdeck_pg_actors(id),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version=1), paid_units NUMERIC(40,0) NOT NULL DEFAULT 0,
 promo_units NUMERIC(40,0) NOT NULL DEFAULT 720000000000 CHECK(promo_units>=0),
 promo_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '30 days'),
 depleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hosting_workspace_accounts (
 workspace_id UUID PRIMARY KEY REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 account_id UUID NOT NULL REFERENCES hosting_accounts(id), enabled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hosting_ledger (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 workspace_id UUID, kind TEXT NOT NULL CHECK(kind IN ('welcome','usage','admin','stripe','promo_expiry')),
 amount_units NUMERIC(40,0) NOT NULL, paid_after_units NUMERIC(40,0) NOT NULL, promo_after_units NUMERIC(40,0) NOT NULL,
 idempotency_key TEXT NOT NULL, reason TEXT NOT NULL, actor_npub TEXT, metadata JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(account_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS hosting_usage_hours (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 hour TIMESTAMPTZ NOT NULL, account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 status TEXT NOT NULL CHECK(status IN ('charged','unavailable','missed','partial_hour')),
 bytes NUMERIC(40,0), debit_units NUMERIC(40,0) NOT NULL DEFAULT 0, evidence JSONB NOT NULL,
 collected_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,hour)
);
CREATE TABLE IF NOT EXISTS hosting_checkout_orders (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES hosting_accounts(id),
 idempotency_key TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents IN (500,1000,2500,5000,10000)),
 return_url TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('test','live')),
 session_id TEXT UNIQUE, payment_intent TEXT UNIQUE, fulfilled_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(account_id,idempotency_key)
);
`;
