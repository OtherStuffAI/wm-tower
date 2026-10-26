-- Notification push delivery v1: installation/transport registry and the durable alert queue. Idempotent and additive.
-- Installations are actor-private. A transport is a push address (APNs token) with a lease; tokens are stored only as
-- an HMAC-free SHA-256 hash for uniqueness plus the raw value needed to address the provider.
CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_installations (
  id UUID PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  client_app_id TEXT NOT NULL CHECK (client_app_id ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  platform TEXT NOT NULL CHECK (platform IN ('web', 'ios', 'ipados', 'macos', 'android')),
  device_label TEXT,
  app_version TEXT,
  signer_npub TEXT,
  permission_state TEXT NOT NULL DEFAULT 'unknown' CHECK (permission_state IN ('granted', 'denied', 'unknown')),
  enrolled_workspace_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fd_notification_installations_actor ON flightdeck_pg_notification_installations (actor_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_transports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES flightdeck_pg_notification_installations(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('apns', 'webpush', 'fcm')),
  address TEXT NOT NULL,
  address_hash TEXT NOT NULL,
  environment TEXT CHECK (environment IN ('sandbox', 'production')),
  bundle_id TEXT,
  preview TEXT NOT NULL DEFAULT 'generic' CHECK (preview IN ('generic', 'full')),
  registered_origin TEXT,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'revoked')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One row per live address; a released (revoked/stale) row is rewritten in place by the next owner, never duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_notification_transports_address ON flightdeck_pg_notification_transports (kind, address_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_notification_transports_active ON flightdeck_pg_notification_transports (installation_id, kind) WHERE status = 'active';

-- One alert per (item, transport, generation). Rows are content-free: the payload is rebuilt from the item at send time.
CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  item_id UUID NOT NULL REFERENCES flightdeck_pg_notification_items(id) ON DELETE CASCADE,
  recipient_actor_id UUID NOT NULL,
  transport_id UUID NOT NULL REFERENCES flightdeck_pg_notification_transports(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'sent', 'suppressed', 'failed', 'dead')),
  reason TEXT,
  not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deadline_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  collapse_key TEXT,
  provider_status INTEGER,
  error_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  UNIQUE (item_id, transport_id, generation)
);
CREATE INDEX IF NOT EXISTS idx_fd_notification_alerts_due ON flightdeck_pg_notification_alerts (next_attempt_at) WHERE state IN ('pending', 'failed', 'leased');
CREATE INDEX IF NOT EXISTS idx_fd_notification_alerts_transport ON flightdeck_pg_notification_alerts (transport_id) WHERE state IN ('pending', 'failed', 'leased');

CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_alert_attempts (
  alert_id UUID NOT NULL REFERENCES flightdeck_pg_notification_alerts(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  outcome TEXT NOT NULL DEFAULT 'started',
  provider_status INTEGER,
  error_class TEXT,
  latency_ms INTEGER,
  PRIMARY KEY (alert_id, attempt_no)
);
