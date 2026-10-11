-- V4 Coworker MVP schema

-- forgejo_native_retirement_v1
-- Run before any upgrade/backfill can fire an installed legacy projection trigger.
-- Catalog lookup also works for a fresh database where these tables do not exist.
DO $$
DECLARE retired RECORD;
BEGIN
  FOR retired IN
    SELECT trigger_row.tgname, namespace.nspname, relation.relname
    FROM pg_trigger trigger_row
    JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname IN (
        'trg_git_ensure_workspace_forgejo_binding',
        'trg_git_group_membership_reconciliation_stale',
        'trg_git_workspace_organization_reconciliation_stale',
        'trg_git_actor_organizations_reconciliation_stale',
        'trg_git_group_edge_reconciliation_stale')
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %I.%I', retired.tgname, retired.nspname, retired.relname);
  END LOOP;
END;
$$;
DROP FUNCTION IF EXISTS git_ensure_workspace_forgejo_binding();
DROP FUNCTION IF EXISTS git_ensure_workspace_forgejo_binding_for(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS git_mark_group_membership_reconciliation_stale();
DROP FUNCTION IF EXISTS git_mark_workspace_organization_reconciliation_stale();
DROP FUNCTION IF EXISTS git_mark_actor_organizations_reconciliation_stale();
DROP FUNCTION IF EXISTS git_mark_group_edge_reconciliation_stale();
-- Archived Git records must survive normal Tower workspace/actor/group deletion.
-- Remove only outward foreign keys; retain relationships between historical git_ tables.
DO $$
DECLARE retired_fk RECORD;
BEGIN
  FOR retired_fk IN
    SELECT constraint_row.conname, namespace.nspname, relation.relname
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_class referenced ON referenced.oid = constraint_row.confrelid
    WHERE constraint_row.contype = 'f' AND namespace.nspname = current_schema()
      AND left(relation.relname, 4) = 'git_'
      AND NOT (referenced.relnamespace = relation.relnamespace AND left(referenced.relname, 4) = 'git_')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', retired_fk.nspname, retired_fk.relname, retired_fk.conname);
  END LOOP;
END;
$$;
-- end_forgejo_native_retirement_v1

CREATE TABLE IF NOT EXISTS v4_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_npub TEXT NOT NULL,
  name TEXT NOT NULL,
  group_npub TEXT NOT NULL UNIQUE,
  group_kind TEXT NOT NULL DEFAULT 'shared',
  private_member_npub TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v4_groups_owner ON v4_groups(owner_npub);
CREATE INDEX IF NOT EXISTS idx_v4_groups_private_member ON v4_groups(private_member_npub);

CREATE TABLE IF NOT EXISTS v4_group_epochs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES v4_groups(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  group_npub TEXT NOT NULL UNIQUE,
  created_by_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at TIMESTAMPTZ,
  UNIQUE(group_id, epoch)
);

CREATE INDEX IF NOT EXISTS idx_v4_group_epochs_group ON v4_group_epochs(group_id);
CREATE INDEX IF NOT EXISTS idx_v4_group_epochs_npub ON v4_group_epochs(group_npub);

CREATE TABLE IF NOT EXISTS v4_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL UNIQUE,
  creator_npub TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  wrapped_workspace_nsec TEXT NOT NULL,
  wrapped_by_npub TEXT NOT NULL,
  default_group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL,
  admin_group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v4_workspaces_creator ON v4_workspaces(creator_npub);

CREATE TABLE IF NOT EXISTS workspace_credit_accounts (
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

CREATE TABLE IF NOT EXISTS workspace_credit_transactions (
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

CREATE INDEX IF NOT EXISTS idx_workspace_credit_transactions_workspace_created
  ON workspace_credit_transactions(workspace_owner_npub, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_credit_orders (
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

CREATE INDEX IF NOT EXISTS idx_workspace_credit_orders_workspace_created
  ON workspace_credit_orders(workspace_owner_npub, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_usage_hourly_audits (
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

CREATE INDEX IF NOT EXISTS idx_workspace_usage_hourly_audits_workspace_hour
  ON workspace_usage_hourly_audits(workspace_owner_npub, hour_start DESC);

CREATE TABLE IF NOT EXISTS workspace_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  app_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_npub TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_owner_npub, app_npub)
);

-- PG-native Flight Deck workspaces also own WApp database namespaces. The
-- registration route authorizes their owner independently of v4_workspaces.
ALTER TABLE workspace_apps
  DROP CONSTRAINT IF EXISTS workspace_apps_workspace_owner_npub_fkey;

CREATE INDEX IF NOT EXISTS idx_workspace_apps_workspace
  ON workspace_apps(workspace_owner_npub, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_app_schema_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  record_families JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_ciphertext TEXT NOT NULL,
  created_by_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_owner_npub, app_npub, schema_hash),
  FOREIGN KEY (workspace_owner_npub, app_npub)
    REFERENCES workspace_apps(workspace_owner_npub, app_npub)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_app_schema_manifests_workspace
  ON workspace_app_schema_manifests(workspace_owner_npub, app_npub, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_app_schema_group_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id UUID NOT NULL REFERENCES workspace_app_schema_manifests(id) ON DELETE CASCADE,
  group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL,
  group_epoch INTEGER,
  group_npub TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  can_write BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_workspace_app_schema_payloads_manifest
  ON workspace_app_schema_group_payloads(manifest_id);

CREATE INDEX IF NOT EXISTS idx_workspace_app_schema_payloads_group
  ON workspace_app_schema_group_payloads(group_id, group_epoch);

CREATE TABLE IF NOT EXISTS workspace_app_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  collection TEXT NOT NULL,
  row_id TEXT NOT NULL,
  owner_npub TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_npub TEXT NOT NULL,
  updated_by_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (visibility IN ('private', 'group', 'workspace')),
  UNIQUE (workspace_owner_npub, app_npub, collection, row_id),
  FOREIGN KEY (workspace_owner_npub, app_npub)
    REFERENCES workspace_apps(workspace_owner_npub, app_npub)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_app_rows_scope
  ON workspace_app_rows(workspace_owner_npub, app_npub, collection, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_app_rows_owner
  ON workspace_app_rows(workspace_owner_npub, app_npub, owner_npub);
CREATE INDEX IF NOT EXISTS idx_workspace_app_rows_group
  ON workspace_app_rows(group_id);
CREATE INDEX IF NOT EXISTS idx_workspace_app_rows_data
  ON workspace_app_rows USING GIN (data);

CREATE TABLE IF NOT EXISTS workspace_app_db_namespaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  schema_name TEXT NOT NULL UNIQUE,
  app_slug TEXT NOT NULL,
  provisioned_by_npub TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_owner_npub, app_npub),
  FOREIGN KEY (workspace_owner_npub, app_npub)
    REFERENCES workspace_apps(workspace_owner_npub, app_npub)
    ON DELETE CASCADE,
  CHECK (schema_name ~ '^wapp_[a-z][a-z0-9_]*_[a-f0-9]{12}$')
);

CREATE INDEX IF NOT EXISTS idx_workspace_app_db_namespaces_workspace
  ON workspace_app_db_namespaces(workspace_owner_npub, created_at DESC);

CREATE TABLE IF NOT EXISTS v4_group_member_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES v4_groups(id) ON DELETE CASCADE,
  member_npub TEXT NOT NULL,
  wrapped_group_nsec TEXT NOT NULL,
  wrapped_by_npub TEXT NOT NULL,
  approved_by_npub TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE(group_id, member_npub, key_version)
);

CREATE INDEX IF NOT EXISTS idx_v4_gmk_group ON v4_group_member_keys(group_id);
CREATE INDEX IF NOT EXISTS idx_v4_gmk_member ON v4_group_member_keys(member_npub);

CREATE TABLE IF NOT EXISTS v4_group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES v4_groups(id) ON DELETE CASCADE,
  member_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(group_id, member_npub)
);

CREATE INDEX IF NOT EXISTS idx_v4_group_members_group ON v4_group_members(group_id);

CREATE TABLE IF NOT EXISTS v4_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id TEXT NOT NULL,
  owner_npub TEXT NOT NULL,
  record_family_hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  previous_version INTEGER NOT NULL DEFAULT 0,
  signature_npub TEXT NOT NULL,
  owner_ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(record_id, version)
);

CREATE INDEX IF NOT EXISTS idx_v4_records_owner ON v4_records(owner_npub);
CREATE INDEX IF NOT EXISTS idx_v4_records_family ON v4_records(owner_npub, record_family_hash);
CREATE INDEX IF NOT EXISTS idx_v4_records_record_id ON v4_records(record_id);
CREATE INDEX IF NOT EXISTS idx_v4_records_updated ON v4_records(updated_at);

CREATE TABLE IF NOT EXISTS v4_record_group_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_row_id UUID NOT NULL REFERENCES v4_records(id) ON DELETE CASCADE,
  group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL,
  group_epoch INTEGER,
  group_npub TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  can_write BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_v4_rgp_row ON v4_record_group_payloads(record_row_id);
CREATE INDEX IF NOT EXISTS idx_v4_rgp_group_id_epoch ON v4_record_group_payloads(group_id, group_epoch);
CREATE INDEX IF NOT EXISTS idx_v4_rgp_group ON v4_record_group_payloads(group_npub);

CREATE TABLE IF NOT EXISTS v4_record_checkouts (
  checkout_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_service_npub TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_family_hash TEXT NOT NULL,
  idempotency_key TEXT,
  checked_out_by_user_npub TEXT NOT NULL,
  checked_out_by_workspace_user_key_npub TEXT,
  checked_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'checked_out',
  released_at TIMESTAMPTZ,
  CHECK (state IN ('checked_in', 'checked_out', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_v4_record_checkouts_record
  ON v4_record_checkouts(workspace_service_npub, record_id, checked_out_at DESC);
CREATE INDEX IF NOT EXISTS idx_v4_record_checkouts_holder
  ON v4_record_checkouts(checked_out_by_user_npub, checked_out_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v4_record_checkouts_idempotency
  ON v4_record_checkouts(workspace_service_npub, record_id, checked_out_by_user_npub, idempotency_key)
  WHERE state = 'checked_out' AND idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_v4_record_checkouts_active
  ON v4_record_checkouts(workspace_service_npub, record_id)
  WHERE state = 'checked_out';

CREATE TABLE IF NOT EXISTS v4_storage_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_npub TEXT NOT NULL,
  owner_group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL,
  created_by_npub TEXT NOT NULL,
  access_group_ids UUID[] NOT NULL DEFAULT '{}',
  is_public BOOLEAN NOT NULL DEFAULT false,
  file_name TEXT,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256_hex TEXT,
  sha256_verified_etag TEXT,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_v4_storage_hash ON v4_storage_objects(sha256_hex) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_v4_storage_owner ON v4_storage_objects(owner_npub);
CREATE INDEX IF NOT EXISTS idx_v4_storage_creator ON v4_storage_objects(created_by_npub);
CREATE INDEX IF NOT EXISTS idx_v4_storage_group ON v4_storage_objects(owner_group_id);

-- User profiles: durable user entity for billing, display, and key registration
CREATE TABLE IF NOT EXISTS user_profiles (
  user_npub        TEXT PRIMARY KEY,
  display_name     TEXT,
  avatar_url       TEXT,
  credit_balance   INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Workspace session keys: maps ws_key_npub to real user identity per workspace
CREATE TABLE IF NOT EXISTS user_workspace_keys (
  user_npub            TEXT NOT NULL REFERENCES user_profiles(user_npub),
  workspace_owner_npub TEXT NOT NULL,
  ws_key_npub          TEXT NOT NULL,
  ws_key_epoch         INTEGER NOT NULL DEFAULT 1,
  active               BOOLEAN NOT NULL DEFAULT true,
  device_label         TEXT,
  device_platform      TEXT,
  device_policy        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at         TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  registered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_owner_npub, ws_key_npub)
);

CREATE INDEX IF NOT EXISTS idx_uwk_user ON user_workspace_keys(user_npub);
CREATE INDEX IF NOT EXISTS idx_uwk_wskey ON user_workspace_keys(ws_key_npub);

CREATE TABLE IF NOT EXISTS flightdeck_pg_actors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  npub TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind IN ('human', 'agent', 'app', 'service'))
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_actor_identity_history (
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  npub TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  rotation_id TEXT NOT NULL,
  proof_event_id TEXT NOT NULL,
  PRIMARY KEY (actor_id, npub), UNIQUE (rotation_id), UNIQUE (proof_event_id),
  CHECK (char_length(rotation_id) BETWEEN 1 AND 128), CHECK (valid_until >= valid_from)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tower_service_npub TEXT NOT NULL,
  workspace_service_npub TEXT NOT NULL,
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL DEFAULT '',
  description TEXT,
  avatar_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  v4_workspace_id UUID REFERENCES v4_workspaces(id) ON DELETE SET NULL,
  created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tower_service_npub, workspace_service_npub, app_npub),
  UNIQUE (id, workspace_service_npub, app_npub)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_actor_identity_rotations (
  rotation_id TEXT PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  context_workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE RESTRICT,
  old_npub TEXT NOT NULL, new_npub TEXT NOT NULL, requester_npub TEXT NOT NULL,
  proof_event_id TEXT NOT NULL UNIQUE, proof_created_at TIMESTAMPTZ NOT NULL,
  proof_expires_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ NOT NULL,
  result TEXT NOT NULL DEFAULT 'completed', migration_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  CHECK (result = 'completed'), CHECK (old_npub <> new_npub),
  CHECK (char_length(rotation_id) BETWEEN 1 AND 128),
  CHECK (jsonb_typeof(migration_counts) = 'object'), CHECK (jsonb_typeof(warnings) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workspaces_service
  ON flightdeck_pg_workspaces(workspace_service_npub);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workspaces_owner
  ON flightdeck_pg_workspaces(workspace_owner_npub);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workspaces_v4
  ON flightdeck_pg_workspaces(v4_workspace_id);

CREATE TABLE IF NOT EXISTS flightdeck_pg_hosted_signups (
  idempotency_key UUID NOT NULL,
  owner_npub TEXT NOT NULL,
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  workspace_name_key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  user_event_id TEXT NOT NULL UNIQUE,
  site_event_id TEXT NOT NULL UNIQUE,
  site_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_npub, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_hosted_signups_owner_created
  ON flightdeck_pg_hosted_signups(owner_npub, created_at DESC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_workspace_memberships (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, actor_id),
  CHECK (role IN ('owner', 'admin', 'member', 'guest', 'agent', 'app'))
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workspace_memberships_actor
  ON flightdeck_pg_workspace_memberships(actor_id);

CREATE TABLE IF NOT EXISTS flightdeck_pg_personal_agent_settings (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  autopilot_agents JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, actor_id),
  CONSTRAINT flightdeck_pg_personal_agent_settings_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE,
  CHECK (jsonb_typeof(autopilot_agents) = 'array'),
  CHECK (row_version >= 1)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_event_subscription_agents (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  manager_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  agent_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  authorized_by_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, manager_actor_id, agent_actor_id),
  FOREIGN KEY (workspace_id, manager_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_event_subscription_agents_agent
  ON flightdeck_pg_event_subscription_agents(workspace_id, agent_actor_id);

CREATE TABLE IF NOT EXISTS flightdeck_pg_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, id),
  CHECK (kind IN ('system', 'workspace', 'scope', 'channel', 'dm', 'agent', 'app', 'custom'))
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_group_memberships (
  workspace_id UUID NOT NULL,
  group_id UUID NOT NULL,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, group_id, actor_id),
  FOREIGN KEY (workspace_id, group_id)
    REFERENCES flightdeck_pg_groups(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_group_memberships_workspace_actor_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_group_memberships_actor
  ON flightdeck_pg_group_memberships(actor_id);

CREATE OR REPLACE FUNCTION flightdeck_pg_ensure_default_groups()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
  VALUES
    (NEW.id, 'Admins', 'system', NEW.created_by_actor_id),
    (NEW.id, 'Agents', 'system', NEW.created_by_actor_id),
    (NEW.id, 'People', 'system', NEW.created_by_actor_id),
    (NEW.id, 'Workspace', 'system', NEW.created_by_actor_id)
  ON CONFLICT (workspace_id, name) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION flightdeck_pg_ensure_workspace_group_membership()
RETURNS TRIGGER AS $$
DECLARE
  workspace_group_id UUID;
BEGIN
  SELECT id INTO workspace_group_id
  FROM flightdeck_pg_groups
  WHERE workspace_id = NEW.workspace_id
    AND name = 'Workspace'
  LIMIT 1;

  IF workspace_group_id IS NOT NULL THEN
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    VALUES (NEW.workspace_id, workspace_group_id, NEW.actor_id, NEW.created_by_actor_id)
    ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_flightdeck_pg_default_groups ON flightdeck_pg_workspaces;
CREATE TRIGGER trg_flightdeck_pg_default_groups
AFTER INSERT ON flightdeck_pg_workspaces
FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_ensure_default_groups();

DROP TRIGGER IF EXISTS trg_flightdeck_pg_workspace_group_membership ON flightdeck_pg_workspace_memberships;
CREATE TRIGGER trg_flightdeck_pg_workspace_group_membership
AFTER INSERT OR UPDATE OF actor_id ON flightdeck_pg_workspace_memberships
FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_ensure_workspace_group_membership();

INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
SELECT w.id, group_name, 'system', w.created_by_actor_id
FROM flightdeck_pg_workspaces w
CROSS JOIN (VALUES ('Admins'), ('Agents'), ('People'), ('Workspace')) AS default_groups(group_name)
ON CONFLICT (workspace_id, name) DO NOTHING;

INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
SELECT m.workspace_id, g.id, m.actor_id, m.created_by_actor_id
FROM flightdeck_pg_workspace_memberships m
JOIN flightdeck_pg_groups g
  ON g.workspace_id = m.workspace_id
 AND g.name = 'Workspace'
ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS flightdeck_pg_group_edges (
  workspace_id UUID NOT NULL,
  parent_group_id UUID NOT NULL,
  child_group_id UUID NOT NULL,
  created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, parent_group_id, child_group_id),
  CHECK (parent_group_id <> child_group_id),
  FOREIGN KEY (workspace_id, parent_group_id)
    REFERENCES flightdeck_pg_groups(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, child_group_id)
    REFERENCES flightdeck_pg_groups(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_group_edges_child
  ON flightdeck_pg_group_edges(workspace_id, child_group_id);

CREATE TABLE IF NOT EXISTS flightdeck_pg_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL,
  created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  owner_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  owner_group_id UUID,
  default_channel_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, id),
  CHECK (kind IN ('business_unit', 'department', 'project', 'customer', 'dm', 'temporary', 'custom')),
  FOREIGN KEY (workspace_id, owner_group_id)
    REFERENCES flightdeck_pg_groups(workspace_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  scope_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  kind TEXT NOT NULL DEFAULT 'channel',
  position INTEGER,
  participant_npubs TEXT[],
  created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (scope_id, name),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scope_id, id),
  CHECK (kind IN ('channel', 'dm', 'system')),
  CHECK (position IS NULL OR position >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_channels_scope_position
  ON flightdeck_pg_channels(workspace_id, scope_id, position ASC NULLS LAST, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_permission_definitions (
  permission TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fdpg_perm_defs_permission_resource_type_key UNIQUE (permission, resource_type),
  CHECK (resource_type IN ('workspace', 'scope', 'channel', 'thread', 'task', 'doc', 'file', 'daily_note', 'approval', 'app'))
);

INSERT INTO flightdeck_pg_permission_definitions (permission, resource_type, description)
VALUES
  ('org_data.read', 'workspace', 'org_data.read workspace capability'),
  ('org_data.write', 'workspace', 'org_data.write workspace capability'),
  ('org_data.schema', 'workspace', 'org_data.schema workspace capability'),
  ('napplet.publish', 'workspace', 'napplet.publish workspace capability'),
  ('napplet.install', 'workspace', 'napplet.install workspace capability'),
  ('workspace.read', 'workspace', 'Read workspace metadata and current actor membership'),
  ('workspace.manage', 'workspace', 'Manage workspace settings and administrative access'),
  ('workspace.invite', 'workspace', 'Invite actors into a workspace'),
  ('event_subscription.manage', 'workspace', 'Manage a delegated multi-identity workspace event subscription'),
  ('scope.read', 'scope', 'Read accessible scopes'),
  ('scope.create', 'workspace', 'Create scopes inside a workspace'),
  ('scope.manage', 'scope', 'Manage scope metadata and access'),
      ('context.edit', 'scope', 'Edit this scope context structure; no administration or target access'),
  ('channel.read', 'channel', 'Read accessible channels'),
  ('channel.create', 'scope', 'Create channels inside a scope'),
  ('channel.write', 'channel', 'Write messages or records in a channel'),
  ('channel.manage', 'channel', 'Manage channel metadata and membership'),
  ('channel.grant', 'channel', 'Create or revoke channel grants'),
  ('channel.grants.read', 'channel', 'Read effective channel grants'),
  ('channel.grants.manage', 'channel', 'Create or revoke channel grants'),
  ('task.read', 'channel', 'Read tasks anchored to a channel'),
  ('task.create', 'channel', 'Create tasks anchored to a channel'),
  ('task.update', 'channel', 'Update tasks anchored to a channel'),
  ('task.comment', 'channel', 'Comment on tasks anchored to a channel'),
  ('comment.create', 'channel', 'Create channel or task comments'),
  ('doc.read', 'channel', 'Read documents anchored to a channel'),
  ('doc.write', 'channel', 'Create or update documents anchored to a channel'),
  ('file.read', 'channel', 'Read files anchored to a channel'),
  ('file.write', 'channel', 'Attach files anchored to a channel'),
  ('audio_note.read', 'channel', 'Read audio notes anchored to a channel'),
  ('audio_note.write', 'channel', 'Create audio notes anchored to a channel'),
  ('daily_note.read', 'workspace', 'Read personal Daily Scopes owned by self or explicitly shared by a human owner'),
  ('daily_note.write', 'workspace', 'Create or update personal Daily Scopes owned by self or explicitly shared by a human owner')
ON CONFLICT (permission) DO UPDATE SET
  resource_type = EXCLUDED.resource_type,
  description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS flightdeck_pg_permission_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL,
  principal_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  principal_group_id UUID,
  resource_type TEXT NOT NULL,
  resource_scope_id UUID,
  resource_channel_id UUID,
  permission TEXT NOT NULL,
  created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CHECK (principal_type IN ('actor', 'group')),
  CHECK (
    (principal_type = 'actor' AND principal_actor_id IS NOT NULL AND principal_group_id IS NULL)
    OR (principal_type = 'group' AND principal_group_id IS NOT NULL AND principal_actor_id IS NULL)
  ),
  CHECK (resource_type IN ('workspace', 'scope', 'channel')),
  CHECK (
    (resource_type = 'workspace' AND resource_scope_id IS NULL AND resource_channel_id IS NULL)
    OR (resource_type = 'scope' AND resource_scope_id IS NOT NULL AND resource_channel_id IS NULL)
    OR (resource_type = 'channel' AND resource_channel_id IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, principal_group_id)
    REFERENCES flightdeck_pg_groups(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_permission_grants_workspace_actor_membership_fkey
    FOREIGN KEY (workspace_id, principal_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, resource_scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, resource_channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_permission_grants_permission_resource_type_fkey
    FOREIGN KEY (permission, resource_type)
    REFERENCES flightdeck_pg_permission_definitions(permission, resource_type)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_permission_grants_actor
  ON flightdeck_pg_permission_grants(workspace_id, principal_actor_id)
  WHERE principal_actor_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_permission_grants_group
  ON flightdeck_pg_permission_grants(workspace_id, principal_group_id)
  WHERE principal_group_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_permission_grants_scope
  ON flightdeck_pg_permission_grants(workspace_id, resource_scope_id)
  WHERE resource_scope_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_permission_grants_channel
  ON flightdeck_pg_permission_grants(workspace_id, resource_channel_id)
  WHERE resource_channel_id IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_permission_grants_active_unique
  ON flightdeck_pg_permission_grants(
    workspace_id,
    principal_type,
    COALESCE(principal_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
    resource_type,
    COALESCE(resource_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(resource_channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
    permission
  )
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_audit_events_workspace_created
  ON flightdeck_pg_audit_events(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_storage_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT flightdeck_pg_storage_links_entity_type_check
    CHECK (entity_type IN ('doc', 'file', 'audio_note', 'message')),
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_storage_links_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_storage_links_active_object_unique
  ON flightdeck_pg_storage_links(workspace_id, storage_object_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_storage_links_channel
  ON flightdeck_pg_storage_links(workspace_id, channel_id, entity_type, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  activity_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  CHECK (length(trim(title)) > 0),
  CHECK (row_version >= 1),
  CHECK (activity_version >= 0),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_docs_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_docs_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scope_id, channel_id, id)
);

ALTER TABLE flightdeck_pg_docs
  ADD COLUMN IF NOT EXISTS activity_version BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_docs_active_storage_object
  ON flightdeck_pg_docs(workspace_id, storage_object_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_docs_channel_updated
  ON flightdeck_pg_docs(workspace_id, channel_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_docs_activity
  ON flightdeck_pg_docs(workspace_id, channel_id, activity_version DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_doc_versions (
  workspace_id UUID NOT NULL,
  doc_id UUID NOT NULL,
  row_version INTEGER NOT NULL,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  operation TEXT NOT NULL DEFAULT 'updated',
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, doc_id, row_version),
  FOREIGN KEY (workspace_id, doc_id)
    REFERENCES flightdeck_pg_docs(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CHECK (row_version >= 1),
  CHECK (operation IN ('created', 'updated', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_versions_doc
  ON flightdeck_pg_doc_versions(workspace_id, doc_id, row_version DESC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_doc_recovery_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  doc_id UUID NOT NULL,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL,
  base_row_version INTEGER,
  base_version_id TEXT,
  base_body_sha256_hex TEXT,
  head_row_version INTEGER NOT NULL,
  head_version_id TEXT NOT NULL,
  head_storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
  head_body_sha256_hex TEXT,
  submitted_body_sha256_hex TEXT NOT NULL,
  submitted_patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  resolution_state TEXT NOT NULL DEFAULT 'open',
  created_by_actor_id UUID NOT NULL,
  created_by_signer_npub TEXT NOT NULL,
  resolved_by_actor_id UUID,
  resolved_by_signer_npub TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_head_row_version INTEGER,
  resolution_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, doc_id)
    REFERENCES flightdeck_pg_docs(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_doc_recoveries_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_doc_recoveries_resolved_by_membership_fkey
    FOREIGN KEY (workspace_id, resolved_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CHECK (reason_code IN ('base_unavailable', 'stale_base', 'base_version_mismatch', 'base_body_mismatch', 'head_body_unverifiable')),
  CHECK (resolution_state IN ('open', 'promoted', 'discarded')),
  CHECK (base_row_version IS NULL OR base_row_version >= 1),
  CHECK (head_row_version >= 1),
  CHECK (resolution_head_row_version IS NULL OR resolution_head_row_version >= 1),
  CHECK (base_body_sha256_hex IS NULL OR base_body_sha256_hex ~ '^[0-9a-f]{64}$'),
  CHECK (head_body_sha256_hex IS NULL OR head_body_sha256_hex ~ '^[0-9a-f]{64}$'),
  CHECK (submitted_body_sha256_hex ~ '^[0-9a-f]{64}$'),
  CHECK (reason_code = 'base_unavailable' OR (base_row_version IS NOT NULL AND base_body_sha256_hex IS NOT NULL)),
  CHECK (
    (resolution_state = 'open' AND resolved_at IS NULL AND resolved_by_actor_id IS NULL)
    OR (resolution_state <> 'open' AND resolved_at IS NOT NULL AND resolved_by_actor_id IS NOT NULL)
  ),
  UNIQUE (workspace_id, doc_id, idempotency_key),
  UNIQUE (workspace_id, doc_id, id)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_recoveries_doc_state
  ON flightdeck_pg_doc_recovery_versions(workspace_id, doc_id, resolution_state, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_recoveries_storage
  ON flightdeck_pg_doc_recovery_versions(workspace_id, storage_object_id);

CREATE TABLE IF NOT EXISTS flightdeck_pg_file_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  parent_folder_id UUID,
  title TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  deleted_by_actor_id UUID,
  CHECK (length(trim(title)) > 0),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id, parent_folder_id)
    REFERENCES flightdeck_pg_file_folders(workspace_id, scope_id, channel_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_file_folders_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_file_folders_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_file_folders_deleted_by_membership_fkey
    FOREIGN KEY (workspace_id, deleted_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scope_id, channel_id, id)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_file_folders_channel_parent
  ON flightdeck_pg_file_folders(workspace_id, channel_id, parent_folder_id, title)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  folder_id UUID,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
  current_version_id UUID,
  display_name TEXT,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deleted_by_actor_id UUID,
  CHECK (display_name IS NULL OR length(trim(display_name)) > 0),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id, folder_id)
    REFERENCES flightdeck_pg_file_folders(workspace_id, scope_id, channel_id, id)
    ON DELETE SET NULL (folder_id),
  CONSTRAINT flightdeck_pg_files_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_files_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_files_deleted_by_membership_fkey
    FOREIGN KEY (workspace_id, deleted_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scope_id, channel_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_files_active_storage_object
  ON flightdeck_pg_files(workspace_id, storage_object_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_files_channel_archived
  ON flightdeck_pg_files(workspace_id, channel_id, archived_at, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_files_channel_updated
  ON flightdeck_pg_files(workspace_id, channel_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_file_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  file_id UUID NOT NULL,
  version_number INTEGER NOT NULL,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
  base_version_id UUID,
  operation TEXT NOT NULL DEFAULT 'created',
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (version_number >= 1),
  CHECK (operation IN ('created', 'replaced', 'deleted', 'restored')),
  FOREIGN KEY (workspace_id, file_id)
    REFERENCES flightdeck_pg_files(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, base_version_id)
    REFERENCES flightdeck_pg_file_versions(workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_file_versions_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, file_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_file_versions_file
  ON flightdeck_pg_file_versions(workspace_id, file_id, version_number DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'flightdeck_pg_files_current_version_fkey'
  ) THEN
    ALTER TABLE flightdeck_pg_files
      ADD CONSTRAINT flightdeck_pg_files_current_version_fkey
      FOREIGN KEY (workspace_id, current_version_id)
      REFERENCES flightdeck_pg_file_versions(workspace_id, id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS flightdeck_pg_audio_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  thread_id UUID,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
  target_type TEXT,
  target_id UUID,
  title TEXT,
  mime_type TEXT NOT NULL,
  duration_seconds NUMERIC,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  media_encryption JSONB NOT NULL DEFAULT '{}'::jsonb,
  waveform_preview JSONB NOT NULL DEFAULT '[]'::jsonb,
  transcript_status TEXT NOT NULL DEFAULT 'not_requested',
  transcript_preview TEXT,
  transcript TEXT,
  summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  record_state TEXT NOT NULL DEFAULT 'active',
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (title IS NULL OR length(trim(title)) > 0),
  CONSTRAINT flightdeck_pg_audio_notes_target_type_check
    CHECK (target_type IS NULL OR target_type IN ('message', 'task_comment', 'task', 'doc', 'file', 'audio_note')),
  CONSTRAINT flightdeck_pg_audio_notes_target_pair_check
    CHECK ((target_type IS NULL AND target_id IS NULL) OR (target_type IS NOT NULL AND target_id IS NOT NULL)),
  CHECK (length(trim(mime_type)) > 0),
  CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  CHECK (size_bytes >= 0),
  CHECK (jsonb_typeof(media_encryption) = 'object'),
  CHECK (jsonb_typeof(waveform_preview) = 'array'),
  CHECK (record_state IN ('active', 'archived')),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_audio_notes_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_audio_notes_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scope_id, channel_id, id)
);

ALTER TABLE flightdeck_pg_audio_notes
  ADD COLUMN IF NOT EXISTS thread_id UUID;

ALTER TABLE flightdeck_pg_audio_notes
  ADD COLUMN IF NOT EXISTS media_encryption JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE flightdeck_pg_audio_notes
  ADD COLUMN IF NOT EXISTS waveform_preview JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE flightdeck_pg_audio_notes
  ADD COLUMN IF NOT EXISTS transcript_preview TEXT;

ALTER TABLE flightdeck_pg_audio_notes
  ADD COLUMN IF NOT EXISTS transcript TEXT;

ALTER TABLE flightdeck_pg_audio_notes
  ADD COLUMN IF NOT EXISTS record_state TEXT NOT NULL DEFAULT 'active';

ALTER TABLE flightdeck_pg_audio_notes
  ALTER COLUMN size_bytes SET DEFAULT 0;

ALTER TABLE flightdeck_pg_audio_notes
  ALTER COLUMN media_encryption SET DEFAULT '{}'::jsonb;

ALTER TABLE flightdeck_pg_audio_notes
  ALTER COLUMN waveform_preview SET DEFAULT '[]'::jsonb;

ALTER TABLE flightdeck_pg_audio_notes
  ALTER COLUMN record_state SET DEFAULT 'active';

ALTER TABLE flightdeck_pg_audio_notes
  ALTER COLUMN transcript_status SET DEFAULT 'not_requested';

ALTER TABLE flightdeck_pg_audio_notes
  DROP CONSTRAINT IF EXISTS flightdeck_pg_audio_notes_target_type_check;

ALTER TABLE flightdeck_pg_audio_notes
  ADD CONSTRAINT flightdeck_pg_audio_notes_target_type_check
  CHECK (target_type IS NULL OR target_type IN ('message', 'task_comment', 'task', 'doc', 'file', 'audio_note'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_audio_notes_active_storage_object
  ON flightdeck_pg_audio_notes(workspace_id, storage_object_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_audio_notes_channel_updated
  ON flightdeck_pg_audio_notes(workspace_id, channel_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_audio_notes_target
  ON flightdeck_pg_audio_notes(workspace_id, target_type, target_id, created_at ASC)
  WHERE target_type IS NOT NULL AND target_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_daily_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  owner_actor_id UUID NOT NULL,
  scope_id UUID,
  channel_id UUID,
  note_date DATE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT,
  focus TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (status IN ('active', 'archived')),
  CHECK (row_version >= 1),
  CONSTRAINT flightdeck_pg_daily_notes_owner_membership_fkey
    FOREIGN KEY (workspace_id, owner_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_daily_notes_scope_fkey
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE SET NULL,
  CONSTRAINT flightdeck_pg_daily_notes_channel_fkey
    FOREIGN KEY (workspace_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, id)
    ON DELETE SET NULL,
  CONSTRAINT flightdeck_pg_daily_notes_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_daily_notes_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_daily_notes_owner_date_active
  ON flightdeck_pg_daily_notes(
    workspace_id,
    owner_actor_id,
    note_date
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_daily_notes_workspace_updated
  ON flightdeck_pg_daily_notes(workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_daily_note_versions (
  workspace_id UUID NOT NULL,
  daily_note_id UUID NOT NULL,
  row_version INTEGER NOT NULL,
  owner_actor_id UUID NOT NULL,
  scope_id UUID,
  channel_id UUID,
  note_date DATE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT,
  focus TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'updated',
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, daily_note_id, row_version),
  FOREIGN KEY (workspace_id, daily_note_id)
    REFERENCES flightdeck_pg_daily_notes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CHECK (row_version >= 1),
  CHECK (status IN ('active', 'archived')),
  CHECK (operation IN ('created', 'updated', 'restored'))
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_daily_note_versions_note
  ON flightdeck_pg_daily_note_versions(workspace_id, daily_note_id, row_version DESC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_daily_scope_agent_access (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  owner_actor_id UUID NOT NULL,
  agent_actor_id UUID NOT NULL,
  can_read BOOLEAN NOT NULL DEFAULT true,
  can_write BOOLEAN NOT NULL DEFAULT true,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, owner_actor_id, agent_actor_id),
  CHECK (owner_actor_id <> agent_actor_id),
  CONSTRAINT flightdeck_pg_daily_scope_access_owner_fkey
    FOREIGN KEY (workspace_id, owner_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_daily_scope_access_agent_fkey
    FOREIGN KEY (workspace_id, agent_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_daily_scope_access_created_by_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_daily_scope_access_updated_by_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_daily_scope_access_agent
  ON flightdeck_pg_daily_scope_agent_access(workspace_id, agent_actor_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_personal_wapps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  owner_actor_id UUID NOT NULL,
  scope_id UUID,
  channel_id UUID,
  title TEXT NOT NULL,
  description TEXT,
  launch_url TEXT NOT NULL,
  icon_url TEXT,
  app_id TEXT,
  wapp_id TEXT,
  source_wingman_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (status IN ('active', 'archived')),
  CHECK (row_version >= 1),
  CHECK (sort_order >= 0),
  CHECK (launch_url ~* '^https?://'),
  CONSTRAINT flightdeck_pg_personal_wapps_owner_membership_fkey
    FOREIGN KEY (workspace_id, owner_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_personal_wapps_scope_fkey
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE SET NULL,
  CONSTRAINT flightdeck_pg_personal_wapps_channel_fkey
    FOREIGN KEY (workspace_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, id)
    ON DELETE SET NULL,
  CONSTRAINT flightdeck_pg_personal_wapps_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_personal_wapps_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_personal_wapps_owner_order
  ON flightdeck_pg_personal_wapps(workspace_id, owner_actor_id, sort_order ASC, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  source_message_id UUID,
  parent_thread_id UUID,
  branch_point_message_id UUID,
  client_request_id TEXT,
  client_request_hash TEXT,
  title TEXT NOT NULL DEFAULT '',
  latest TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (length(trim(title)) > 0),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_threads_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_threads_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_threads_parent_fkey
    FOREIGN KEY (workspace_id, scope_id, channel_id, parent_thread_id)
    REFERENCES flightdeck_pg_threads(workspace_id, scope_id, channel_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_threads_branch_pair_check
    CHECK ((parent_thread_id IS NULL) = (branch_point_message_id IS NULL)),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scope_id, channel_id, id)
);

ALTER TABLE flightdeck_pg_threads
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activity_version BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_channel_updated
  ON flightdeck_pg_threads(workspace_id, channel_id, updated_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_channel_archived
  ON flightdeck_pg_threads(workspace_id, channel_id, updated_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_source_message
  ON flightdeck_pg_threads(workspace_id, source_message_id)
  WHERE source_message_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_activity
  ON flightdeck_pg_threads(workspace_id, channel_id, activity_version DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_parent
  ON flightdeck_pg_threads(workspace_id, parent_thread_id)
  WHERE parent_thread_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_branch_idempotency
  ON flightdeck_pg_threads(workspace_id, created_by_actor_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  thread_id UUID,
  body TEXT NOT NULL,
  client_request_id TEXT,
  client_request_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT flightdeck_pg_messages_body_or_attachments_check CHECK (
    length(trim(body)) > 0
    OR COALESCE(jsonb_typeof(metadata->'attachments') = 'array' AND jsonb_array_length(metadata->'attachments') > 0, false)
  ),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id, thread_id)
    REFERENCES flightdeck_pg_threads(workspace_id, scope_id, channel_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_messages_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_messages_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scope_id, channel_id, id)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_messages_channel_created
  ON flightdeck_pg_messages(workspace_id, channel_id, created_at ASC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_messages_thread_created
  ON flightdeck_pg_messages(workspace_id, thread_id, created_at ASC)
  WHERE thread_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_messages_idempotency
  ON flightdeck_pg_messages(workspace_id, created_by_actor_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE flightdeck_pg_threads
    ADD CONSTRAINT flightdeck_pg_threads_branch_point_fkey
    FOREIGN KEY (workspace_id, scope_id, channel_id, branch_point_message_id)
    REFERENCES flightdeck_pg_messages(workspace_id, scope_id, channel_id, id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS flightdeck_pg_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  thread_id UUID,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'sand',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  activity_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (length(trim(title)) > 0),
  CHECK (state IN ('new', 'ready', 'in_progress', 'review', 'done', 'archive', 'backlog', 'blocked', 'archived')),
  CHECK (priority IN ('rock', 'pebble', 'sand', 'low', 'normal', 'high', 'urgent')),
  CHECK (row_version >= 1),
  CHECK (activity_version >= 0),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_tasks_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_tasks_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scope_id, channel_id, id)
);

ALTER TABLE flightdeck_pg_tasks
  ADD COLUMN IF NOT EXISTS activity_version BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_tasks_channel_state
  ON flightdeck_pg_tasks(workspace_id, channel_id, state, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_tasks_scope_updated
  ON flightdeck_pg_tasks(workspace_id, scope_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_tasks_activity
  ON flightdeck_pg_tasks(workspace_id, channel_id, activity_version DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_resource_view_states (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  viewer_actor_id UUID NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  viewed_activity_version BIGINT NOT NULL DEFAULT 0,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, viewer_actor_id, resource_type, resource_id),
  CONSTRAINT flightdeck_pg_resource_view_states_viewer_fkey
    FOREIGN KEY (workspace_id, viewer_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_resource_view_states_scope_fkey
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_resource_view_states_channel_fkey
    FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id) ON DELETE CASCADE,
  CHECK (resource_type IN ('thread', 'task', 'document')),
  CHECK (viewed_activity_version >= 0),
  CHECK (row_version >= 1)
);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_resource_view_states_viewer
  ON flightdeck_pg_resource_view_states(workspace_id, viewer_actor_id, resource_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_resource_view_state_rollouts (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  viewer_actor_id UUID NOT NULL,
  baselined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, viewer_actor_id),
  CONSTRAINT flightdeck_pg_resource_view_state_rollouts_viewer_fkey
    FOREIGN KEY (workspace_id, viewer_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_edit_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  field_path TEXT,
  lease_token_hash TEXT NOT NULL,
  holder_actor_id UUID NOT NULL,
  holder_actor_npub TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT flightdeck_pg_edit_leases_entity_type_check CHECK (entity_type IN ('task', 'document', 'scope')),
  CHECK (length(trim(lease_token_hash)) > 0),
  CHECK (length(trim(holder_actor_npub)) > 0),
  CONSTRAINT flightdeck_pg_edit_leases_holder_membership_fkey
    FOREIGN KEY (workspace_id, holder_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_edit_leases_active_entity
  ON flightdeck_pg_edit_leases(workspace_id, entity_type, entity_id, field_path, expires_at DESC)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_edit_leases_holder
  ON flightdeck_pg_edit_leases(workspace_id, holder_actor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  task_id UUID NOT NULL,
  thread_id UUID,
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (length(trim(body)) > 0),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id, channel_id, task_id)
    REFERENCES flightdeck_pg_tasks(workspace_id, scope_id, channel_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_task_comments_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_task_comments_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_task_comments_task_created
  ON flightdeck_pg_task_comments(workspace_id, task_id, created_at)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_task_comments_channel_created
  ON flightdeck_pg_task_comments(workspace_id, channel_id, created_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_doc_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  doc_id UUID NOT NULL,
  parent_comment_id UUID,
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (length(trim(body)) > 0),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id, channel_id, doc_id)
    REFERENCES flightdeck_pg_docs(workspace_id, scope_id, channel_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_doc_comments_parent_fkey
    FOREIGN KEY (parent_comment_id)
    REFERENCES flightdeck_pg_doc_comments(id)
    ON DELETE SET NULL,
  CONSTRAINT flightdeck_pg_doc_comments_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_doc_comments_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_comments_doc_created
  ON flightdeck_pg_doc_comments(workspace_id, doc_id, created_at)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_comments_parent_created
  ON flightdeck_pg_doc_comments(workspace_id, parent_comment_id, created_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_task_assignments (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  task_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, actor_id),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id, channel_id, task_id)
    REFERENCES flightdeck_pg_tasks(workspace_id, scope_id, channel_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_task_assignments_actor_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_task_assignments_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_task_assignments_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_task_assignments_actor
  ON flightdeck_pg_task_assignments(workspace_id, actor_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_task_watchers (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  task_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, actor_id),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id, channel_id, task_id)
    REFERENCES flightdeck_pg_tasks(workspace_id, scope_id, channel_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_task_watchers_actor_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_task_watchers_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_task_watchers_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_task_watchers_actor
  ON flightdeck_pg_task_watchers(workspace_id, actor_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  thread_id UUID,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  emoji TEXT NOT NULL,
  emoji_shortcode TEXT NOT NULL,
  reactor_actor_id UUID NOT NULL,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT flightdeck_pg_reactions_target_type_check
    CHECK (target_type IN ('message', 'task_comment', 'task', 'doc', 'file', 'audio_note')),
  CHECK (emoji IN ('thumbs_up', 'smile', 'heart', 'eyes', 'party', 'white_check_mark')),
  CHECK (emoji_shortcode IN (':thumbs_up:', ':smile:', ':heart:', ':eyes:', ':party:', ':white_check_mark:')),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_reactions_reactor_membership_fkey
    FOREIGN KEY (workspace_id, reactor_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_reactions_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_reactions_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);

ALTER TABLE flightdeck_pg_reactions
  DROP CONSTRAINT IF EXISTS flightdeck_pg_reactions_target_type_check;

ALTER TABLE flightdeck_pg_reactions
  DROP CONSTRAINT IF EXISTS flightdeck_pg_reactions_emoji_check;

ALTER TABLE flightdeck_pg_reactions
  DROP CONSTRAINT IF EXISTS flightdeck_pg_reactions_emoji_shortcode_check;

ALTER TABLE flightdeck_pg_reactions
  ADD CONSTRAINT flightdeck_pg_reactions_target_type_check
  CHECK (target_type IN ('message', 'task_comment', 'task', 'doc', 'file', 'audio_note'));

ALTER TABLE flightdeck_pg_reactions
  ADD CONSTRAINT flightdeck_pg_reactions_emoji_check
  CHECK (emoji IN ('thumbs_up', 'smile', 'heart', 'eyes', 'party', 'white_check_mark'));

ALTER TABLE flightdeck_pg_reactions
  ADD CONSTRAINT flightdeck_pg_reactions_emoji_shortcode_check
  CHECK (emoji_shortcode IN (':thumbs_up:', ':smile:', ':heart:', ':eyes:', ':party:', ':white_check_mark:'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_reactions_active_target_actor_unique
  ON flightdeck_pg_reactions(workspace_id, target_type, target_id, emoji, reactor_actor_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_reactions_target_created
  ON flightdeck_pg_reactions(workspace_id, target_type, target_id, created_at ASC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_reactions_channel_created
  ON flightdeck_pg_reactions(workspace_id, channel_id, created_at ASC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_response_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID,
  channel_id UUID,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  thread_id UUID,
  task_id UUID,
  doc_id UUID,
  parent_comment_id UUID,
  actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  actor_npub TEXT,
  activity_type TEXT NOT NULL DEFAULT 'agent_response',
  status TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  label TEXT,
  message TEXT,
  pipeline_run_id TEXT,
  source_message_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_version INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at TIMESTAMPTZ,
  CONSTRAINT flightdeck_pg_response_activities_target_type_check
    CHECK (target_type IN ('chat_thread', 'task_comment', 'doc_comment')),
  CONSTRAINT flightdeck_pg_response_activities_status_check
    CHECK (status IN ('queued', 'thinking', 'drafting', 'publishing', 'failed', 'cleared')),
  CONSTRAINT flightdeck_pg_response_activities_severity_check
    CHECK (severity IN ('info', 'warning', 'error')),
  CHECK (row_version >= 1),
  CHECK (channel_id IS NULL OR scope_id IS NOT NULL),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_pg_resp_act_active_target_actor
  ON flightdeck_pg_response_activities(workspace_id, target_type, target_id, actor_id, activity_type)
  WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_pg_resp_act_target
  ON flightdeck_pg_response_activities(workspace_id, target_type, target_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fd_pg_resp_act_channel
  ON flightdeck_pg_response_activities(workspace_id, channel_id, updated_at DESC)
  WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_pg_resp_act_expires
  ON flightdeck_pg_response_activities(workspace_id, expires_at)
  WHERE cleared_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  trigger_message_id UUID NOT NULL,
  turn_id TEXT,
  session_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  agent_npub TEXT NOT NULL,
  publisher_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  label TEXT,
  summary TEXT,
  body TEXT,
  visibility TEXT NOT NULL DEFAULT 'user_visible',
  sequence BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  blocked_by_turn_id TEXT,
  queue_position INTEGER CHECK (queue_position IS NULL OR queue_position >= 1),
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, activity_id),
  CONSTRAINT flightdeck_pg_agent_activities_state_check
    CHECK (state IN ('accepted', 'queued', 'working', 'waiting', 'completed', 'failed', 'cancelled')),
  CONSTRAINT flightdeck_pg_agent_activities_visibility_check CHECK (visibility = 'user_visible'),
  CONSTRAINT flightdeck_pg_agent_activities_sequence_check CHECK (sequence >= 0),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id, thread_id)
    REFERENCES flightdeck_pg_threads(workspace_id, scope_id, channel_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id, trigger_message_id)
    REFERENCES flightdeck_pg_messages(workspace_id, scope_id, channel_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fd_pg_agent_activities_hydrate
  ON flightdeck_pg_agent_activities(workspace_id, channel_id, thread_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fd_pg_agent_activities_history_page
  ON flightdeck_pg_agent_activities(workspace_id, channel_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_fd_pg_agent_activities_expiry
  ON flightdeck_pg_agent_activities(workspace_id, lease_expires_at);

CREATE TABLE IF NOT EXISTS flightdeck_pg_agent_activity_commentary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  agent_activity_id UUID NOT NULL REFERENCES flightdeck_pg_agent_activities(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  state TEXT NOT NULL,
  label TEXT,
  summary TEXT,
  body TEXT,
  visibility TEXT NOT NULL DEFAULT 'user_visible',
  sequence BIGINT NOT NULL,
  delivery_cursor BIGINT GENERATED BY DEFAULT AS IDENTITY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fd_pg_agent_commentary_turn_sequence_key UNIQUE (workspace_id, turn_id, sequence),
  CONSTRAINT flightdeck_pg_agent_activity_commentary_state_check CHECK (state = 'working'),
  CONSTRAINT flightdeck_pg_agent_activity_commentary_visibility_check CHECK (visibility = 'user_visible'),
  CONSTRAINT flightdeck_pg_agent_activity_commentary_sequence_check CHECK (sequence >= 0),
  CONSTRAINT flightdeck_pg_agent_activity_commentary_content_check
    CHECK (length(trim(COALESCE(summary, ''))) > 0 OR length(trim(COALESCE(body, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS idx_fd_pg_agent_activity_commentary_hydrate
  ON flightdeck_pg_agent_activity_commentary(workspace_id, agent_activity_id, turn_id, sequence ASC);

CREATE INDEX IF NOT EXISTS idx_fd_pg_agent_commentary_delivery
  ON flightdeck_pg_agent_activity_commentary(workspace_id, agent_activity_id, delivery_cursor);

CREATE TABLE IF NOT EXISTS flightdeck_pg_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  created_by_actor_id UUID NOT NULL,
  prompt TEXT NOT NULL,
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  CHECK (length(trim(prompt)) > 0),
  CHECK (jsonb_typeof(recipients) = 'array'),
  CHECK (jsonb_typeof(targets) = 'array'),
  CHECK (status IN ('open', 'closed')),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_invocations_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_channel_updated
  ON flightdeck_pg_invocations(workspace_id, channel_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_status_updated
  ON flightdeck_pg_invocations(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_recipients_gin
  ON flightdeck_pg_invocations USING GIN (recipients);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_targets_gin
  ON flightdeck_pg_invocations USING GIN (targets);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_client_request
  ON flightdeck_pg_invocations(workspace_id, (metadata->>'client_request_id'))
  WHERE metadata ? 'client_request_id';

CREATE TABLE IF NOT EXISTS flightdeck_pg_workrooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  thread_id UUID,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  integration_autopilot_npub TEXT,
  repo JSONB NOT NULL DEFAULT '{}'::jsonb,
  branches JSONB NOT NULL DEFAULT '{}'::jsonb,
  app_targets JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  archive_policy JSONB NOT NULL DEFAULT '{"retention":"keep"}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  CHECK (length(trim(title)) > 0),
  CHECK (length(trim(goal)) > 0),
  CHECK (status IN ('draft', 'active', 'waiting_review', 'waiting_approval', 'integrating', 'deploying', 'blocked', 'complete', 'archived')),
  CHECK (jsonb_typeof(repo) = 'object'),
  CHECK (jsonb_typeof(branches) = 'object'),
  CHECK (jsonb_typeof(app_targets) = 'object'),
  CHECK (jsonb_typeof(approval_policy) = 'object'),
  CHECK (jsonb_typeof(archive_policy) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (row_version >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_workrooms_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_workrooms_updated_by_membership_fkey
    FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scope_id, channel_id, id)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_thread
  ON flightdeck_pg_workrooms(workspace_id, channel_id, thread_id)
  WHERE thread_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_channel_status
  ON flightdeck_pg_workrooms(workspace_id, channel_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_scope_updated
  ON flightdeck_pg_workrooms(workspace_id, scope_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_integration_autopilot
  ON flightdeck_pg_workrooms(workspace_id, integration_autopilot_npub, updated_at DESC)
  WHERE integration_autopilot_npub IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_repo_gin
  ON flightdeck_pg_workrooms USING GIN (repo);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_app_targets_gin
  ON flightdeck_pg_workrooms USING GIN (app_targets);

CREATE TABLE IF NOT EXISTS flightdeck_pg_workroom_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  workroom_id UUID NOT NULL,
  actor_npub TEXT NOT NULL,
  actor_id UUID,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  access_status TEXT NOT NULL DEFAULT 'pending',
  access_issue TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(trim(actor_npub)) > 0),
  CHECK (kind IN ('human', 'agent', 'autopilot', 'app', 'service')),
  CHECK (role IN ('integration', 'contributor', 'reviewer', 'human_approver', 'observer')),
  CHECK (status IN ('invited', 'active', 'inactive', 'removed')),
  CHECK (access_status IN ('pending', 'granted', 'failed', 'not_required')),
  CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (workspace_id, workroom_id)
    REFERENCES flightdeck_pg_workrooms(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_workroom_participants_actor_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE SET NULL (actor_id),
  UNIQUE (workroom_id, actor_npub)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_participants_workroom
  ON flightdeck_pg_workroom_participants(workspace_id, workroom_id, role, status);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_participants_actor
  ON flightdeck_pg_workroom_participants(workspace_id, actor_npub, updated_at DESC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_workroom_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  workroom_id UUID NOT NULL,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  actor_npub TEXT,
  actor_id UUID,
  target_type TEXT,
  target_ref TEXT,
  title TEXT,
  body TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  visibility TEXT NOT NULL DEFAULT 'room',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (event_type IN (
    'created',
    'started',
    'status_changed',
    'participant_invited',
    'access_grant_failed',
    'artifact_added',
    'link_added',
    'pr_opened',
    'pr_ready',
    'review_requested',
    'review_complete',
    'approval_requested',
    'approval_decided',
    'merge_started',
    'merge_complete',
    'deploy_started',
    'deploy_complete',
    'blocker_added',
    'blocker_cleared',
    'completed',
    'archived',
    'note'
  )),
  CHECK (visibility IN ('room', 'workspace', 'private')),
  CHECK (jsonb_typeof(payload) = 'object'),
  FOREIGN KEY (workspace_id, workroom_id)
    REFERENCES flightdeck_pg_workrooms(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_workroom_events_actor_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE SET NULL (actor_id)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_events_workroom_created
  ON flightdeck_pg_workroom_events(workspace_id, workroom_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_events_channel_created
  ON flightdeck_pg_workroom_events(workspace_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_events_target
  ON flightdeck_pg_workroom_events(workspace_id, target_type, target_ref, created_at DESC)
  WHERE target_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID,
  channel_id UUID,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  title TEXT,
  summary TEXT,
  requested_by_actor_id UUID NOT NULL,
  requested_by_npub TEXT NOT NULL,
  reviewer_actor_id UUID,
  reviewer_npub TEXT,
  approver_actor_id UUID,
  approver_npub TEXT,
  decision_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_version INTEGER NOT NULL DEFAULT 1,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(trim(target_type)) > 0),
  CHECK (length(trim(action)) > 0),
  CHECK (status IN ('requested', 'in_review', 'approved', 'rejected', 'superseded', 'cancelled')),
  CHECK (length(trim(requested_by_npub)) > 0),
  CHECK (reviewer_npub IS NULL OR length(trim(reviewer_npub)) > 0),
  CHECK (approver_npub IS NULL OR length(trim(approver_npub)) > 0),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (row_version >= 1),
  CHECK (approved_at IS NULL OR status IN ('approved', 'superseded')),
  CHECK (rejected_at IS NULL OR status = 'rejected'),
  CHECK (superseded_at IS NULL OR status = 'superseded'),
  CHECK (cancelled_at IS NULL OR status = 'cancelled'),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE SET NULL (scope_id),
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE SET NULL (scope_id, channel_id),
  CONSTRAINT flightdeck_pg_approvals_requested_by_membership_fkey
    FOREIGN KEY (workspace_id, requested_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT flightdeck_pg_approvals_reviewer_membership_fkey
    FOREIGN KEY (workspace_id, reviewer_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE SET NULL (reviewer_actor_id),
  CONSTRAINT flightdeck_pg_approvals_approver_membership_fkey
    FOREIGN KEY (workspace_id, approver_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE SET NULL (approver_actor_id),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_approvals_target_action
  ON flightdeck_pg_approvals(workspace_id, target_type, target_id, action, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_approvals_channel_status
  ON flightdeck_pg_approvals(workspace_id, channel_id, status, updated_at DESC)
  WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_approvals_metadata_gin
  ON flightdeck_pg_approvals USING GIN (metadata);

CREATE TABLE IF NOT EXISTS flightdeck_pg_workroom_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  workroom_id UUID NOT NULL,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  link_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  external_url TEXT,
  label TEXT,
  status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (link_type IN ('pull_request', 'file', 'doc', 'task', 'artifact', 'app_target', 'preview_url', 'production_url', 'approval', 'deployment', 'thread', 'message', 'external_url')),
  CHECK (length(trim(target_type)) > 0),
  CHECK (target_id IS NOT NULL OR external_url IS NOT NULL),
  CHECK (external_url IS NULL OR external_url ~* '^https?://'),
  CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (workspace_id, workroom_id)
    REFERENCES flightdeck_pg_workrooms(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE,
  CONSTRAINT flightdeck_pg_workroom_links_created_by_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE SET NULL (created_by_actor_id)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_links_workroom_type
  ON flightdeck_pg_workroom_links(workspace_id, workroom_id, link_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_links_target
  ON flightdeck_pg_workroom_links(workspace_id, target_type, target_id)
  WHERE target_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_links_metadata_gin
  ON flightdeck_pg_workroom_links USING GIN (metadata);

-- wapp_activity_publishing_v1
-- Stable WApp installation identity, workspace publishing grants, activity
-- projections, per-user state, abuse accounting, and security audit history.
CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wapp_installation_id TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL,
  publisher_npub TEXT NOT NULL UNIQUE,
  previous_publisher_npubs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  owner_npub TEXT NOT NULL,
  display_name TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(trim(wapp_installation_id)) BETWEEN 1 AND 128),
  CHECK (length(trim(app_id)) BETWEEN 1 AND 128),
  CHECK (length(trim(publisher_npub)) > 0),
  CHECK (length(trim(owner_npub)) > 0),
  CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  CHECK (key_version >= 1)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_publishing_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES flightdeck_pg_wapp_installations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active',
  capabilities TEXT[] NOT NULL DEFAULT ARRAY['activity.publish']::TEXT[],
  registered_open_origins TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  disable_open_links BOOLEAN NOT NULL DEFAULT false,
  grant_version INTEGER NOT NULL DEFAULT 1,
  approved_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  approved_by_npub TEXT NOT NULL,
  last_published_at TIMESTAMPTZ,
  last_rejected_at TIMESTAMPTZ,
  last_rejection_code TEXT,
  disabled_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, installation_id),
  CHECK (status IN ('active', 'disabled', 'revoked')),
  CHECK (grant_version >= 1),
  CHECK (cardinality(capabilities) > 0)
);

CREATE INDEX IF NOT EXISTS idx_fd_pg_wapp_grants_installation
  ON flightdeck_pg_wapp_publishing_grants(installation_id, workspace_id);

-- delegated_wapp_management_v1. `wapp_management` is the stable UI role;
-- `wapp.manage` is the canonical API capability. These are authority/saga
-- records and deliberately do not replace the installation registry above.
CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  owner_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  delegate_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  permission TEXT NOT NULL DEFAULT 'wapp.manage',
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  grant_version INTEGER NOT NULL DEFAULT 1,
  request_hash TEXT NOT NULL,
  owner_signature TEXT,
  created_by_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (permission = 'wapp.manage'),
  CHECK (owner_actor_id <> delegate_actor_id),
  CHECK (expires_at > valid_from),
  CHECK (grant_version >= 1)
);
CREATE INDEX IF NOT EXISTS idx_fd_pg_wapp_delegations_effective
  ON flightdeck_pg_wapp_delegations(workspace_id, delegate_actor_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_install_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  owner_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
  signer_npub TEXT NOT NULL,
  delegation_id UUID REFERENCES flightdeck_pg_wapp_delegations(id) ON DELETE RESTRICT,
  client_request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  intent_version INTEGER NOT NULL DEFAULT 1,
  claim_nonce_hash TEXT NOT NULL,
  claim_expires_at TIMESTAMPTZ NOT NULL,
  claimed_by_npub TEXT,
  claimed_at TIMESTAMPTZ,
  observed JSONB NOT NULL DEFAULT '{}'::jsonb,
  installation_id UUID REFERENCES flightdeck_pg_wapp_installations(id) ON DELETE SET NULL,
  personal_wapp_id UUID REFERENCES flightdeck_pg_personal_wapps(id) ON DELETE SET NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, actor_id, client_request_id),
  CHECK (status IN ('pending','claimed','active','failed','revoked','uninstalled','reconciliation_required')),
  CHECK (intent_version >= 1)
);
CREATE INDEX IF NOT EXISTS idx_fd_pg_wapp_intents_workspace_status
  ON flightdeck_pg_wapp_install_intents(workspace_id, status, updated_at DESC);

ALTER TABLE flightdeck_pg_wapp_installations
  ADD COLUMN IF NOT EXISTS autopilot_origin TEXT,
  ADD COLUMN IF NOT EXISTS requested_app_version TEXT,
  ADD COLUMN IF NOT EXISTS observed_app_version TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS uninstalled_at TIMESTAMPTZ;

ALTER TABLE flightdeck_pg_personal_wapps
  ADD COLUMN IF NOT EXISTS wapp_installation_id UUID REFERENCES flightdeck_pg_wapp_installations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_pg_personal_wapps_installation_owner
  ON flightdeck_pg_personal_wapps(workspace_id, owner_actor_id, wapp_installation_id)
  WHERE wapp_installation_id IS NOT NULL;

-- Compatibility backfill is deliberately exact. Ambiguous/unmatched metadata
-- remains NULL and is surfaced as reconciliation_required rather than guessed.
UPDATE flightdeck_pg_personal_wapps w
SET wapp_installation_id = i.id
FROM flightdeck_pg_wapp_installations i
WHERE w.wapp_installation_id IS NULL
  AND i.wapp_installation_id = COALESCE(
    NULLIF(w.metadata->>'wapp_installation_id',''),
    NULLIF(w.metadata->'autopilot_wapp'->>'wapp_installation_id','')
  )
  AND 1 = (
    SELECT COUNT(*) FROM flightdeck_pg_wapp_installations matches
    WHERE matches.wapp_installation_id = COALESCE(
      NULLIF(w.metadata->>'wapp_installation_id',''),
      NULLIF(w.metadata->'autopilot_wapp'->>'wapp_installation_id','')
    )
  );

-- Completed managed installations are sufficient authority for their current
-- publisher namespace. Keep legacy publisher rows and merge only the required
-- Tower-backed WApp capabilities into an existing current namespace.
INSERT INTO workspace_apps (
  workspace_owner_npub,
  app_npub,
  app_name,
  enabled,
  capabilities,
  created_by_npub
)
SELECT DISTINCT ON (installation.owner_npub, installation.publisher_npub)
  installation.owner_npub,
  installation.publisher_npub,
  installation.display_name,
  true,
  '["wapp", "app-db"]'::jsonb,
  intent.signer_npub
FROM flightdeck_pg_wapp_installations installation
JOIN flightdeck_pg_wapp_install_intents intent
  ON intent.installation_id = installation.id
JOIN flightdeck_pg_workspaces workspace
  ON workspace.id = intent.workspace_id
 AND workspace.workspace_owner_npub = installation.owner_npub
WHERE intent.status = 'active'
  AND installation.lifecycle_status = 'active'
ORDER BY
  installation.owner_npub,
  installation.publisher_npub,
  intent.completed_at ASC NULLS LAST,
  intent.created_at ASC,
  intent.id ASC
ON CONFLICT (workspace_owner_npub, app_npub)
DO UPDATE SET
  app_name = EXCLUDED.app_name,
  enabled = true,
  capabilities = (
    SELECT jsonb_agg(required_capability.capability ORDER BY required_capability.capability)
    FROM (
      SELECT DISTINCT jsonb_array_elements_text(
        workspace_apps.capabilities || EXCLUDED.capabilities
      ) AS capability
    ) required_capability
  ),
  updated_at = NOW()
WHERE workspace_apps.app_name IS DISTINCT FROM EXCLUDED.app_name
   OR workspace_apps.enabled IS DISTINCT FROM true
   OR NOT workspace_apps.capabilities @> EXCLUDED.capabilities;

CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_publishing_destinations (
  grant_id UUID NOT NULL REFERENCES flightdeck_pg_wapp_publishing_grants(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (grant_id, channel_id),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fd_pg_wapp_destinations_channel
  ON flightdeck_pg_wapp_publishing_destinations(workspace_id, channel_id, grant_id);

CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_activity_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES flightdeck_pg_wapp_installations(id) ON DELETE RESTRICT,
  grant_id UUID NOT NULL REFERENCES flightdeck_pg_wapp_publishing_grants(id) ON DELETE RESTRICT,
  workspace_id UUID NOT NULL,
  scope_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  external_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  state TEXT NOT NULL DEFAULT 'active',
  open_url TEXT,
  publisher_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  UNIQUE (installation_id, workspace_id, channel_id, external_id),
  UNIQUE (workspace_id, id),
  CHECK (length(external_id) BETWEEN 1 AND 128),
  CHECK (version >= 1),
  CHECK (length(category) BETWEEN 1 AND 128),
  CHECK (length(title) BETWEEN 1 AND 160),
  CHECK (length(summary) <= 1200),
  CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CHECK (state IN ('active', 'resolved', 'withdrawn')),
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fd_pg_wapp_activity_feed
  ON flightdeck_pg_wapp_activity_items(workspace_id, channel_id, state, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_activity_versions (
  item_id UUID NOT NULL REFERENCES flightdeck_pg_wapp_activity_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  publisher_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, version),
  CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_activity_user_state (
  workspace_id UUID NOT NULL,
  item_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  read_version INTEGER,
  read_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, actor_id),
  FOREIGN KEY (workspace_id, item_id)
    REFERENCES flightdeck_pg_wapp_activity_items(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fd_pg_wapp_activity_state_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE,
  CHECK (read_version IS NULL OR read_version >= 1)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_activity_mutes (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL,
  target_type TEXT NOT NULL,
  target_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, actor_id, target_type, target_value),
  CONSTRAINT fd_pg_wapp_activity_mutes_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE,
  CHECK (target_type IN ('installation', 'category')),
  CHECK (length(target_value) BETWEEN 1 AND 128)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_publication_buckets (
  bucket_type TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bucket_type, bucket_key, window_started_at),
  CHECK (bucket_type IN ('installation_minute', 'installation_burst', 'destination_minute')),
  CHECK (request_count >= 0)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_wapp_publishing_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES flightdeck_pg_workspaces(id) ON DELETE SET NULL,
  installation_id UUID REFERENCES flightdeck_pg_wapp_installations(id) ON DELETE SET NULL,
  grant_id UUID REFERENCES flightdeck_pg_wapp_publishing_grants(id) ON DELETE SET NULL,
  item_id UUID,
  actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  signer_npub TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  payload_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (outcome IN ('accepted', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_fd_pg_wapp_audit_workspace_created
  ON flightdeck_pg_wapp_publishing_audit(workspace_id, created_at DESC);

-- end_wapp_activity_publishing_v1

CREATE SEQUENCE IF NOT EXISTS flightdeck_pg_outbox_events_row_version_seq AS INTEGER;

CREATE TABLE IF NOT EXISTS flightdeck_pg_outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID,
  channel_id UUID,
  actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'unknown',
  entity_id UUID,
  operation TEXT NOT NULL DEFAULT 'unknown',
  entity_row_version BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  row_version INTEGER NOT NULL DEFAULT nextval('flightdeck_pg_outbox_events_row_version_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  CHECK (row_version >= 1),
  CHECK (channel_id IS NULL OR scope_id IS NOT NULL),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, channel_id)
    REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_outbox_events_pending
  ON flightdeck_pg_outbox_events(status, created_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_outbox_events_workspace_entity
  ON flightdeck_pg_outbox_events(workspace_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_outbox_events_workspace_cursor
  ON flightdeck_pg_outbox_events(workspace_id, row_version ASC, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_outbox_events_row_version
  ON flightdeck_pg_outbox_events(row_version);

CREATE TABLE IF NOT EXISTS flightdeck_pg_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT,
  platform TEXT,
  user_agent TEXT,
  app_version TEXT,
  last_seen_workspace_id UUID REFERENCES flightdeck_pg_workspaces(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  stale_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('active', 'revoked', 'stale', 'failed')),
  CHECK (length(trim(endpoint)) > 0),
  CHECK (length(trim(p256dh)) > 0),
  CHECK (length(trim(auth)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_push_subscriptions_actor
  ON flightdeck_pg_push_subscriptions(actor_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_preferences (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  chat_threads_enabled BOOLEAN NOT NULL DEFAULT true,
  mentions_enabled BOOLEAN NOT NULL DEFAULT true,
  dms_enabled BOOLEAN NOT NULL DEFAULT true,
  comment_tags_enabled BOOLEAN NOT NULL DEFAULT true,
  task_assignments_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, actor_id),
  CONSTRAINT flightdeck_pg_notification_preferences_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  outbox_event_id UUID NOT NULL REFERENCES flightdeck_pg_outbox_events(id) ON DELETE CASCADE,
  recipient_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES flightdeck_pg_push_subscriptions(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  source_entity_type TEXT NOT NULL,
  source_entity_id UUID,
  dedupe_key TEXT NOT NULL,
  decision TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_status INTEGER,
  provider_response TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  CHECK (category IN ('chat_thread', 'mention', 'dm', 'comment_tag', 'task_assignment')),
  CHECK (decision IN ('queued', 'sent', 'skipped', 'failed')),
  UNIQUE (dedupe_key, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_notification_deliveries_workspace
  ON flightdeck_pg_notification_deliveries(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_notification_deliveries_recipient
  ON flightdeck_pg_notification_deliveries(recipient_actor_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_pg_notification_deliveries_dedupe_subscription
  ON flightdeck_pg_notification_deliveries(dedupe_key, COALESCE(subscription_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- git_authority_v1
-- Tower-owned control-plane state for private Git repositories. Capability
-- plaintext is deliberately absent: only an HMAC-SHA256 representation is
-- persisted after the one issuance response is formed.
CREATE TABLE IF NOT EXISTS git_workspace_namespaces (
  workspace_id UUID PRIMARY KEY REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (namespace ~ '^[a-z0-9][a-z0-9-]{0,38}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_workspace_namespaces_lower
  ON git_workspace_namespaces(lower(namespace));

CREATE TABLE IF NOT EXISTS git_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE RESTRICT,
  scope_id UUID,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  default_branch TEXT NOT NULL DEFAULT 'main',
  state TEXT NOT NULL DEFAULT 'registered',
  policy_revision INTEGER NOT NULL DEFAULT 1,
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (workspace_id, slug),
  UNIQUE (workspace_id, id),
  CHECK (slug ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  CHECK (visibility = 'private'),
  CHECK (default_branch = 'main'),
  CHECK (state IN ('registered', 'provisioning', 'active', 'archived')),
  CHECK (policy_revision >= 1),
  FOREIGN KEY (workspace_id, scope_id)
    REFERENCES flightdeck_pg_scopes(workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT git_repositories_creator_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_git_repositories_workspace_state
  ON git_repositories(workspace_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS git_branch_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  repository_id UUID NOT NULL,
  ref_name TEXT NOT NULL,
  branch_class TEXT NOT NULL,
  protected BOOLEAN NOT NULL DEFAULT true,
  service_managed BOOLEAN NOT NULL DEFAULT true,
  allow_direct_push BOOLEAN NOT NULL DEFAULT false,
  allow_force_push BOOLEAN NOT NULL DEFAULT false,
  allow_delete BOOLEAN NOT NULL DEFAULT false,
  required_approvals INTEGER NOT NULL DEFAULT 0,
  required_checks TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  merge_methods TEXT[] NOT NULL DEFAULT ARRAY['squash']::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repository_id, ref_name),
  CHECK (ref_name ~ '^refs/heads/[A-Za-z0-9._/-]+$'),
  CHECK (branch_class IN ('main', 'staging', 'deployed', 'work')),
  CHECK (required_approvals >= 0 AND required_approvals <= 20),
  CHECK (jsonb_array_length(to_jsonb(required_checks)) <= 100),
  CHECK (cardinality(merge_methods) BETWEEN 1 AND 3),
  CHECK (merge_methods <@ ARRAY['squash', 'merge', 'rebase']::TEXT[]),
  CHECK (
    branch_class = 'work'
    OR (protected AND service_managed AND NOT allow_direct_push AND NOT allow_force_push AND NOT allow_delete)
  ),
  FOREIGN KEY (workspace_id, repository_id)
    REFERENCES git_repositories(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_git_branch_policies_repository
  ON git_branch_policies(repository_id, branch_class, ref_name);

CREATE TABLE IF NOT EXISTS git_repository_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  repository_id UUID NOT NULL,
  principal_type TEXT NOT NULL,
  principal_actor_id UUID,
  principal_group_id UUID,
  permission TEXT NOT NULL,
  ref_constraints JSONB NOT NULL DEFAULT '{"prefixes":[]}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by_actor_id UUID,
  revoked_at TIMESTAMPTZ,
  CHECK (principal_type IN ('actor', 'group')),
  CHECK (
    (principal_type = 'actor' AND principal_actor_id IS NOT NULL AND principal_group_id IS NULL)
    OR (principal_type = 'group' AND principal_group_id IS NOT NULL AND principal_actor_id IS NULL)
  ),
  CHECK (permission IN ('git.repo.read', 'git.repo.write', 'git.branch.create', 'git.repo.admin')),
  CHECK (jsonb_typeof(ref_constraints) = 'object'),
  FOREIGN KEY (workspace_id, repository_id)
    REFERENCES git_repositories(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT git_repository_grants_actor_membership_fkey
    FOREIGN KEY (workspace_id, principal_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE CASCADE,
  CONSTRAINT git_repository_grants_group_fkey
    FOREIGN KEY (workspace_id, principal_group_id)
    REFERENCES flightdeck_pg_groups(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT git_repository_grants_creator_membership_fkey
    FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT,
  CONSTRAINT git_repository_grants_revoker_membership_fkey
    FOREIGN KEY (workspace_id, revoked_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_repository_grants_active_actor
  ON git_repository_grants(repository_id, principal_actor_id, permission)
  WHERE revoked_at IS NULL AND principal_type = 'actor';
CREATE UNIQUE INDEX IF NOT EXISTS idx_git_repository_grants_active_group
  ON git_repository_grants(repository_id, principal_group_id, permission)
  WHERE revoked_at IS NULL AND principal_type = 'group';
CREATE INDEX IF NOT EXISTS idx_git_repository_grants_repository_active
  ON git_repository_grants(repository_id, permission)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS git_credential_exchange_events (
  event_id TEXT PRIMARY KEY,
  body_sha256 TEXT NOT NULL,
  signer_npub TEXT NOT NULL,
  actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES flightdeck_pg_workspaces(id) ON DELETE SET NULL,
  repository_id UUID REFERENCES git_repositories(id) ON DELETE SET NULL,
  event_created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decision TEXT,
  reason_code TEXT,
  CHECK (event_id ~ '^[a-f0-9]{64}$'),
  CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (decision IS NULL OR decision IN ('allow', 'deny'))
);

CREATE INDEX IF NOT EXISTS idx_git_credential_exchange_events_consumed
  ON git_credential_exchange_events(consumed_at DESC);

CREATE TABLE IF NOT EXISTS git_nip98_mutation_events (
  event_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  signer_npub TEXT NOT NULL,
  actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES flightdeck_pg_workspaces(id) ON DELETE SET NULL,
  repository_id UUID REFERENCES git_repositories(id) ON DELETE SET NULL,
  event_created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decision TEXT,
  reason_code TEXT,
  result JSONB,
  CHECK (event_id ~ '^[a-f0-9]{64}$'),
  CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (length(trim(operation)) > 0),
  CHECK (decision IS NULL OR decision IN ('allow', 'deny'))
);

CREATE INDEX IF NOT EXISTS idx_git_nip98_mutation_events_consumed
  ON git_nip98_mutation_events(consumed_at DESC);

CREATE TABLE IF NOT EXISTS git_capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_hash TEXT NOT NULL UNIQUE,
  capability_hash_prefix TEXT NOT NULL,
  workspace_id UUID NOT NULL,
  repository_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  signer_npub TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  audience TEXT NOT NULL,
  git_service TEXT,
  policy_revision INTEGER NOT NULL,
  ref_constraints JSONB NOT NULL DEFAULT '{"prefixes":[]}'::jsonb,
  autopilot_instance_npub TEXT,
  session_id TEXT,
  task_id UUID,
  workroom_id UUID,
  correlation_id TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_service TEXT,
  revocation_reason TEXT,
  CHECK (capability_hash ~ '^[a-f0-9]{64}$'),
  CHECK (capability_hash_prefix ~ '^[a-f0-9]{12}$'),
  CHECK (cardinality(scopes) > 0),
  CHECK (scopes <@ ARRAY['git.fetch', 'git.push.unprotected', 'git.push.branch_create']::TEXT[]),
  CHECK (git_service IN ('upload-pack', 'receive-pack')),
  CHECK (policy_revision >= 1),
  CHECK (expires_at > issued_at),
  FOREIGN KEY (workspace_id, repository_id)
    REFERENCES git_repositories(workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT git_capabilities_actor_membership_fkey
    FOREIGN KEY (workspace_id, actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_git_capabilities_repository_expiry
  ON git_capabilities(repository_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_git_capabilities_actor_expiry
  ON git_capabilities(actor_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS git_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'tower',
  workspace_id UUID REFERENCES flightdeck_pg_workspaces(id) ON DELETE RESTRICT,
  repository_id UUID REFERENCES git_repositories(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
  actor_npub TEXT,
  signer_npub TEXT,
  operation TEXT NOT NULL,
  requested_scope TEXT,
  git_service TEXT,
  decision TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  policy_revision INTEGER,
  capability_hash_prefix TEXT,
  autopilot_instance_npub TEXT,
  session_id TEXT,
  task_id UUID,
  workroom_id UUID,
  correlation_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source IN ('tower', 'wingman-git', 'forgejo')),
  CHECK (decision IN ('allow', 'deny')),
  CHECK (policy_revision IS NULL OR policy_revision >= 1),
  CHECK (capability_hash_prefix IS NULL OR capability_hash_prefix ~ '^[a-f0-9]{12}$')
);

CREATE INDEX IF NOT EXISTS idx_git_audit_events_repository_time
  ON git_audit_events(repository_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_git_audit_events_workspace_time
  ON git_audit_events(workspace_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION git_prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'git_audit_events are immutable';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_git_audit_events_immutable'
  ) THEN
    CREATE TRIGGER trg_git_audit_events_immutable
    BEFORE UPDATE OR DELETE ON git_audit_events
    FOR EACH ROW EXECUTE FUNCTION git_prevent_audit_mutation();
  END IF;
END;
$$;

-- Historical Forgejo projection tables retained for audit and initial OIDC
-- identity continuity only. No running code writes provider state from them.
CREATE TABLE IF NOT EXISTS git_forgejo_actor_aliases (
  actor_id UUID PRIMARY KEY REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  desired_username TEXT NOT NULL,
  applied_username TEXT,
  forgejo_user_id BIGINT,
  state TEXT NOT NULL DEFAULT 'pending',
  last_error_code TEXT,
  reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (desired_username ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  CHECK (applied_username IS NULL OR applied_username ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  CHECK (state IN ('pending', 'ready', 'error'))
);

ALTER TABLE git_forgejo_actor_aliases
  ADD COLUMN IF NOT EXISTS forgejo_user_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_forgejo_actor_aliases_desired_lower
  ON git_forgejo_actor_aliases(lower(desired_username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_git_forgejo_actor_aliases_applied_lower
  ON git_forgejo_actor_aliases(lower(applied_username)) WHERE applied_username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_git_forgejo_actor_aliases_provider_user
  ON git_forgejo_actor_aliases(forgejo_user_id) WHERE forgejo_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS git_forgejo_repository_bindings (
  repository_id UUID PRIMARY KEY REFERENCES git_repositories(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE RESTRICT,
  forgejo_owner TEXT NOT NULL,
  forgejo_repository TEXT NOT NULL,
  desired_policy_revision INTEGER NOT NULL,
  applied_policy_revision INTEGER,
  state TEXT NOT NULL DEFAULT 'pending',
  last_error_code TEXT,
  reconciled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (forgejo_owner, forgejo_repository),
  CHECK (state IN ('pending', 'ready', 'error')),
  CHECK (desired_policy_revision >= 1),
  CHECK (applied_policy_revision IS NULL OR applied_policy_revision >= 1)
);

-- Stock Forgejo has no fencing API: do not allow overlapping repository projections.
-- A lost worker leaves access pending until its attempt is recovered, never auto-expired.
ALTER TABLE git_forgejo_repository_bindings ADD COLUMN IF NOT EXISTS reconciliation_token UUID;

-- Historical workspace organization projection. Native Forgejo now owns
-- organizations and permissions independently of Tower workspace lifecycle.
CREATE TABLE IF NOT EXISTS git_forgejo_workspace_bindings (
  workspace_id UUID PRIMARY KEY REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  forgejo_owner TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending',
  last_error_code TEXT,
  reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (forgejo_owner ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  CHECK (state IN ('pending', 'ready', 'error'))
);

-- Also applied on existing databases by ensureRuntimeSchema's Git block.
ALTER TABLE git_forgejo_workspace_bindings
  ADD COLUMN IF NOT EXISTS desired_generation INTEGER NOT NULL DEFAULT 1;

-- Native Forgejo retirement: retain historical bindings without generating new
-- organizations from Tower workspaces, including during repeated runtime migration.
DROP TRIGGER IF EXISTS trg_git_ensure_workspace_forgejo_binding ON flightdeck_pg_workspaces;
DROP FUNCTION IF EXISTS git_ensure_workspace_forgejo_binding();
DROP FUNCTION IF EXISTS git_ensure_workspace_forgejo_binding_for(UUID, TEXT, TEXT);

DO $$
DECLARE constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'git_forgejo_repository_bindings'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (forgejo_repository)';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE git_forgejo_repository_bindings DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS git_forgejo_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  repository_id UUID REFERENCES git_repositories(id) ON DELETE RESTRICT,
  body_sha256 TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (delivery_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  CHECK (body_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS git_forgejo_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id TEXT NOT NULL UNIQUE REFERENCES git_forgejo_webhook_deliveries(delivery_id) ON DELETE RESTRICT,
  repository_id UUID NOT NULL REFERENCES git_repositories(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_shadow_username TEXT,
  ref_name TEXT,
  old_sha TEXT,
  new_sha TEXT,
  forced BOOLEAN NOT NULL DEFAULT FALSE,
  created BOOLEAN NOT NULL DEFAULT FALSE,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ref_name IS NULL OR ref_name ~ '^refs/[A-Za-z0-9._/-]+$'),
  CHECK (old_sha IS NULL OR old_sha ~ '^[a-f0-9]{40,64}$'),
  CHECK (new_sha IS NULL OR new_sha ~ '^[a-f0-9]{40,64}$')
);

CREATE OR REPLACE FUNCTION git_prevent_forgejo_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'git_forgejo_events are immutable';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_git_forgejo_events_immutable') THEN
    CREATE TRIGGER trg_git_forgejo_events_immutable
    BEFORE UPDATE OR DELETE ON git_forgejo_events
    FOR EACH ROW EXECUTE FUNCTION git_prevent_forgejo_event_mutation();
  END IF;
END;
$$;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'git_audit_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%source IN%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE git_audit_events DROP CONSTRAINT %I', constraint_name);
  END IF;
  ALTER TABLE git_audit_events
    ADD CONSTRAINT git_audit_events_source_check CHECK (source IN ('tower', 'wingman-git', 'forgejo'));
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

-- Native Forgejo owns all permissions. Remove operational projection triggers
-- from upgraded databases; keep existing git_* rows as historical audit data.
-- The immutable audit/event triggers above intentionally remain in place.
DROP TRIGGER IF EXISTS trg_git_group_membership_reconciliation_stale ON flightdeck_pg_group_memberships;
DROP TRIGGER IF EXISTS trg_git_workspace_organization_reconciliation_stale ON flightdeck_pg_workspace_memberships;
DROP TRIGGER IF EXISTS trg_git_actor_organizations_reconciliation_stale ON git_forgejo_actor_aliases;
DROP TRIGGER IF EXISTS trg_git_group_edge_reconciliation_stale ON flightdeck_pg_group_edges;
DROP FUNCTION IF EXISTS git_mark_group_membership_reconciliation_stale();
DROP FUNCTION IF EXISTS git_mark_workspace_organization_reconciliation_stale();
DROP FUNCTION IF EXISTS git_mark_actor_organizations_reconciliation_stale();
DROP FUNCTION IF EXISTS git_mark_group_edge_reconciliation_stale();
-- Archived Git records must survive normal Tower workspace/actor/group deletion.
-- Remove only outward foreign keys; retain relationships between historical git_ tables.
DO $$
DECLARE retired_fk RECORD;
BEGIN
  FOR retired_fk IN
    SELECT constraint_row.conname, namespace.nspname, relation.relname
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_class referenced ON referenced.oid = constraint_row.confrelid
    WHERE constraint_row.contype = 'f' AND namespace.nspname = current_schema()
      AND left(relation.relname, 4) = 'git_'
      AND NOT (referenced.relnamespace = relation.relnamespace AND left(referenced.relname, 4) = 'git_')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', retired_fk.nspname, retired_fk.relname, retired_fk.conname);
  END LOOP;
END;
$$;
-- end_git_authority_v1

CREATE TABLE IF NOT EXISTS tower_metadata (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  tower_name TEXT,
  tower_description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- flightdeck_autopilot_connections_v1
CREATE TABLE IF NOT EXISTS flightdeck_pg_autopilot_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  fips_endpoint TEXT NOT NULL,
  fips_transport_npub TEXT,
  https_endpoint TEXT,
  api_version TEXT NOT NULL DEFAULT '1',
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  archived_by_actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CHECK (installation_id = lower(trim(installation_id)) AND length(installation_id) > 0),
  CHECK (length(trim(display_name)) > 0 AND length(trim(fips_endpoint)) > 0 AND length(trim(api_version)) > 0),
  CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_typeof(metadata) = 'object' AND row_version >= 1),
  CONSTRAINT fd_pg_autopilot_connections_created_by_fkey FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT,
  CONSTRAINT fd_pg_autopilot_connections_updated_by_fkey FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT,
  CONSTRAINT fd_pg_autopilot_connections_archived_by_fkey FOREIGN KEY (workspace_id, archived_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_pg_autopilot_connections_installation
  ON flightdeck_pg_autopilot_connections(workspace_id, installation_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS flightdeck_pg_workspace_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  agent_npub TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  archived_by_actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CHECK (length(trim(agent_id)) > 0 AND length(trim(agent_npub)) > 0 AND length(trim(display_name)) > 0),
  CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_typeof(metadata) = 'object' AND row_version >= 1),
  CONSTRAINT fd_pg_workspace_agents_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES flightdeck_pg_autopilot_connections(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT fd_pg_workspace_agents_created_by_fkey FOREIGN KEY (workspace_id, created_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT,
  CONSTRAINT fd_pg_workspace_agents_updated_by_fkey FOREIGN KEY (workspace_id, updated_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT,
  CONSTRAINT fd_pg_workspace_agents_archived_by_fkey FOREIGN KEY (workspace_id, archived_by_actor_id)
    REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_pg_workspace_agents_identity
  ON flightdeck_pg_workspace_agents(workspace_id, connection_id, agent_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_pg_workspace_agents_order
  ON flightdeck_pg_workspace_agents(workspace_id, sort_order, id) WHERE archived_at IS NULL;
-- end_flightdeck_autopilot_connections_v1

-- flightdeck_record_delta_v1
CREATE OR REPLACE FUNCTION flightdeck_pg_record_context(r JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('scope_id',r->'scope_id','channel_id',r->'channel_id',
 'actor_id',r->'actor_id','owner_actor_id',r->'owner_actor_id','viewer_actor_id',r->'viewer_actor_id','reader_actor_id',r->'reader_actor_id',
 'resource_type',r->'resource_type','resource_id',r->'resource_id',
 'task_id',r->'task_id','doc_id',r->'doc_id','thread_id',r->'thread_id')
$$;
CREATE TABLE IF NOT EXISTS flightdeck_pg_record_clock (
 workspace_id UUID PRIMARY KEY REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 position BIGINT NOT NULL DEFAULT 0, epoch UUID NOT NULL DEFAULT gen_random_uuid()
);
ALTER TABLE flightdeck_pg_record_clock ADD COLUMN IF NOT EXISTS access_revision BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS flightdeck_pg_record_current (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 family TEXT NOT NULL, id TEXT NOT NULL, row JSONB NOT NULL,
 bytes INTEGER GENERATED ALWAYS AS (octet_length(row::text)) STORED,
 context JSONB GENERATED ALWAYS AS (flightdeck_pg_record_context(row)) STORED,
 PRIMARY KEY(workspace_id, family, id)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_record_journal (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 position BIGINT NOT NULL, family TEXT NOT NULL, id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')), row JSONB NOT NULL,
 bytes INTEGER GENERATED ALWAYS AS (octet_length(row::text)) STORED,
 context JSONB GENERATED ALWAYS AS (flightdeck_pg_record_context(row)) STORED,
 PRIMARY KEY(workspace_id, position)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_record_cursors (
 token UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
 epoch UUID NOT NULL, state JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fd_record_cursor_workspace ON flightdeck_pg_record_cursors(workspace_id,actor_id,created_at DESC,token);
-- Existing rows retain issuance-based expiry until their first valid use. Adding
-- a nullable column without a default first avoids renewing old/expired tokens.
ALTER TABLE flightdeck_pg_record_cursors ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE flightdeck_pg_record_cursors ALTER COLUMN last_used_at SET DEFAULT now();
DROP INDEX IF EXISTS idx_fd_record_cursor_expiry;
CREATE INDEX IF NOT EXISTS idx_fd_record_cursor_last_used ON flightdeck_pg_record_cursors(COALESCE(last_used_at,created_at),token);
CREATE OR REPLACE FUNCTION flightdeck_pg_record_identity(f TEXT, r JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE f
 WHEN 'task_assignment' THEN r->>'task_id' || ':' || (r->>'actor_id')
 WHEN 'resource_view_state' THEN r->>'viewer_actor_id' || ':' || (r->>'resource_type') || ':' || (r->>'resource_id')
 ELSE r->>'id' END $$;
CREATE OR REPLACE FUNCTION flightdeck_pg_record_emit(w UUID, f TEXT, r JSONB, op TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$ DECLARE p BIGINT; ident TEXT; BEGIN
 IF NOT EXISTS (SELECT 1 FROM flightdeck_pg_workspaces WHERE id=w) THEN RETURN; END IF;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 UPDATE flightdeck_pg_record_clock SET position=position+1 WHERE workspace_id=w RETURNING position INTO p;
 ident := flightdeck_pg_record_identity(f,r);
 INSERT INTO flightdeck_pg_record_journal(workspace_id,position,family,id,operation,row) VALUES(w,p,f,ident,op,r);
 IF op='delete' THEN DELETE FROM flightdeck_pg_record_current WHERE workspace_id=w AND family=f AND id=ident;
 ELSE INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) VALUES(w,f,ident,r)
 ON CONFLICT(workspace_id,family,id) DO UPDATE SET row=EXCLUDED.row; END IF;
END $$;
CREATE OR REPLACE FUNCTION flightdeck_pg_record_capture() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ DECLARE r JSONB; oldr JSONB; w UUID; child RECORD; table_name TEXT; kind TEXT; BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 w := (r->>'workspace_id')::uuid;
 IF TG_OP='UPDATE' THEN
 oldr:=to_jsonb(OLD);
 IF (oldr->>'channel_id') IS DISTINCT FROM (r->>'channel_id') OR (oldr->>'owner_actor_id') IS DISTINCT FROM (r->>'owner_actor_id') OR flightdeck_pg_record_identity(TG_ARGV[0],oldr) IS DISTINCT FROM flightdeck_pg_record_identity(TG_ARGV[0],r) THEN
 PERFORM flightdeck_pg_record_emit((oldr->>'workspace_id')::uuid,TG_ARGV[0],oldr,'delete');
 END IF; END IF;
 PERFORM flightdeck_pg_record_emit(w,TG_ARGV[0],r,CASE WHEN TG_OP='DELETE' OR r->>'deleted_at' IS NOT NULL OR r->>'archived_at' IS NOT NULL THEN 'delete' ELSE 'upsert' END);
 IF TG_ARGV[0] IN ('task','doc','thread') AND (TG_OP='DELETE' OR r->>'deleted_at' IS NOT NULL) THEN
 -- Real content deletion emits explicit dependent tombstones. Permission
 -- filtering never invokes this path and never manufactures deletion records.
 FOR child IN SELECT family,row FROM flightdeck_pg_record_current c WHERE c.workspace_id=w AND (
   (TG_ARGV[0]='task' AND c.family IN('task_comment','task_assignment') AND c.context->>'task_id'=r->>'id') OR
   (TG_ARGV[0]='doc' AND c.family='doc_comment' AND c.context->>'doc_id'=r->>'id') OR
   (TG_ARGV[0]='thread' AND c.family='message' AND c.context->>'thread_id'=r->>'id') OR
   (c.family='resource_view_state' AND c.context->>'resource_id'=r->>'id'
     AND c.context->>'resource_type'=CASE TG_ARGV[0] WHEN 'doc' THEN 'document' ELSE TG_ARGV[0] END))
 ORDER BY family,id LOOP
   PERFORM flightdeck_pg_record_emit(w,child.family,child.row,'delete');
 END LOOP;
 END IF;
 -- A genuine parent restoration must also restore its surviving dependents.
 IF TG_OP='UPDATE' AND TG_ARGV[0] IN('task','doc','thread') AND oldr->>'deleted_at' IS NOT NULL AND r->>'deleted_at' IS NULL THEN
   FOR kind,table_name IN SELECT * FROM (VALUES
     ('task_comment','flightdeck_pg_task_comments'),('task_assignment','flightdeck_pg_task_assignments'),
     ('doc_comment','flightdeck_pg_doc_comments'),('message','flightdeck_pg_messages'),
     ('resource_view_state','flightdeck_pg_resource_view_states')) AS families(f,t)
   WHERE (TG_ARGV[0]='task' AND f IN('task_comment','task_assignment')) OR (TG_ARGV[0]='doc' AND f='doc_comment')
     OR (TG_ARGV[0]='thread' AND f='message') OR f='resource_view_state'
   LOOP
     IF kind='resource_view_state' THEN
       FOR child IN EXECUTE format('SELECT to_jsonb(t) AS row FROM %I t WHERE workspace_id=$1 AND resource_id=$2::uuid AND resource_type=$3',table_name)
         USING w,r->>'id',CASE TG_ARGV[0] WHEN 'doc' THEN 'document' ELSE TG_ARGV[0] END LOOP
         PERFORM flightdeck_pg_record_emit(w,kind,child.row,'upsert');
       END LOOP;
     ELSE
       FOR child IN EXECUTE format('SELECT to_jsonb(t) AS row FROM %I t WHERE workspace_id=$1 AND %I=$2::uuid AND to_jsonb(t)->>''deleted_at'' IS NULL',
         table_name,CASE TG_ARGV[0] WHEN 'task' THEN 'task_id' WHEN 'doc' THEN 'doc_id' ELSE 'thread_id' END) USING w,r->>'id' LOOP
         PERFORM flightdeck_pg_record_emit(w,kind,child.row,'upsert');
       END LOOP;
     END IF;
   END LOOP;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE OR REPLACE FUNCTION flightdeck_pg_record_reset() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ DECLARE r JSONB; w UUID; BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN RETURN NEW; END IF;
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='flightdeck_pg_actors' THEN
   IF TG_OP='UPDATE' AND OLD.npub=NEW.npub AND OLD.kind=NEW.kind THEN RETURN NEW; END IF;
   -- Identity rebinding is a genuine boundary, never a permission transition.
   UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid(),access_revision=access_revision+1 WHERE workspace_id IN
     (SELECT workspace_id FROM flightdeck_pg_workspace_memberships WHERE actor_id=(r->>'id')::uuid);
 ELSE
   w:=COALESCE(r->>'workspace_id',r->>'id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM flightdeck_pg_workspaces WHERE id=w) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
   INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
   IF TG_TABLE_NAME='flightdeck_pg_workspaces' AND TG_OP='UPDATE' AND
     (to_jsonb(OLD)->'workspace_owner_npub',to_jsonb(OLD)->'app_npub',to_jsonb(OLD)->'workspace_service_npub',to_jsonb(OLD)->'tower_service_npub')
       IS DISTINCT FROM (r->'workspace_owner_npub',r->'app_npub',r->'workspace_service_npub',r->'tower_service_npub') THEN
     UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid(),access_revision=access_revision+1 WHERE workspace_id=w;
   ELSE UPDATE flightdeck_pg_record_clock SET access_revision=access_revision+1 WHERE workspace_id=w; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_scope') THEN
 LOCK TABLE flightdeck_pg_scopes IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_scopes ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'scope', flightdeck_pg_record_identity('scope',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_scopes r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_scope AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_scopes FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('scope');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_channel') THEN
 LOCK TABLE flightdeck_pg_channels IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_channels ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'channel', flightdeck_pg_record_identity('channel',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_channels r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_channel AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_channels FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('channel');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_thread') THEN
 LOCK TABLE flightdeck_pg_threads IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_threads ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'thread', flightdeck_pg_record_identity('thread',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_threads r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_thread AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_threads FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('thread');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_message') THEN
 LOCK TABLE flightdeck_pg_messages IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_messages ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'message', flightdeck_pg_record_identity('message',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_messages r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_message AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_messages FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('message');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_task') THEN
 LOCK TABLE flightdeck_pg_tasks IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_tasks ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'task', flightdeck_pg_record_identity('task',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_tasks r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_task AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_tasks FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('task');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_task_comment') THEN
 LOCK TABLE flightdeck_pg_task_comments IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_task_comments ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'task_comment', flightdeck_pg_record_identity('task_comment',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_task_comments r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_task_comment AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_task_comments FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('task_comment');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_task_assignment') THEN
 LOCK TABLE flightdeck_pg_task_assignments IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_task_assignments ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'task_assignment', flightdeck_pg_record_identity('task_assignment',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_task_assignments r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_task_assignment AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_task_assignments FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('task_assignment');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_doc') THEN
 LOCK TABLE flightdeck_pg_docs IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_docs ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'doc', flightdeck_pg_record_identity('doc',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_docs r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_doc AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_docs FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('doc');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_doc_comment') THEN
 LOCK TABLE flightdeck_pg_doc_comments IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_doc_comments ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'doc_comment', flightdeck_pg_record_identity('doc_comment',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_doc_comments r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_doc_comment AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_doc_comments FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('doc_comment');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_file') THEN
 LOCK TABLE flightdeck_pg_files IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_files ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'file', flightdeck_pg_record_identity('file',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_files r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_file AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_files FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('file');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_file_folder') THEN
 LOCK TABLE flightdeck_pg_file_folders IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_file_folders ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'file_folder', flightdeck_pg_record_identity('file_folder',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_file_folders r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_file_folder AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_file_folders FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('file_folder');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_audio_note') THEN
 LOCK TABLE flightdeck_pg_audio_notes IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_audio_notes ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'audio_note', flightdeck_pg_record_identity('audio_note',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_audio_notes r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_audio_note AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_audio_notes FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('audio_note');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_daily_note') THEN
 LOCK TABLE flightdeck_pg_daily_notes IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_daily_notes ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'daily_note', flightdeck_pg_record_identity('daily_note',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_daily_notes r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_daily_note AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_daily_notes FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('daily_note');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_personal_wapp') THEN
 LOCK TABLE flightdeck_pg_personal_wapps IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_personal_wapps ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'personal_wapp', flightdeck_pg_record_identity('personal_wapp',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_personal_wapps r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_personal_wapp AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_personal_wapps FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('personal_wapp');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_resource_view_state') THEN
 LOCK TABLE flightdeck_pg_resource_view_states IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_resource_view_states ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'resource_view_state', flightdeck_pg_record_identity('resource_view_state',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_resource_view_states r WHERE to_jsonb(r)->>'deleted_at' IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_resource_view_state AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_resource_view_states FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('resource_view_state');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_autopilot_connection') THEN
 LOCK TABLE flightdeck_pg_autopilot_connections IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_autopilot_connections ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'autopilot_connection', flightdeck_pg_record_identity('autopilot_connection',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_autopilot_connections r WHERE archived_at IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_autopilot_connection AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_autopilot_connections FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('autopilot_connection');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_workspace_agent') THEN
 LOCK TABLE flightdeck_pg_workspace_agents IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_workspace_agents ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'workspace_agent', flightdeck_pg_record_identity('workspace_agent',to_jsonb(r)), to_jsonb(r) FROM flightdeck_pg_workspace_agents r WHERE archived_at IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_workspace_agent AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_workspace_agents FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('workspace_agent');
 END IF;
END $$;
DROP TRIGGER IF EXISTS fd_record_reset ON flightdeck_pg_permission_grants;
CREATE TRIGGER fd_record_reset AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_permission_grants FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_reset();
DROP TRIGGER IF EXISTS fd_record_reset ON flightdeck_pg_group_memberships;
CREATE TRIGGER fd_record_reset AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_group_memberships FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_reset();
DROP TRIGGER IF EXISTS fd_record_reset ON flightdeck_pg_group_edges;
CREATE TRIGGER fd_record_reset AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_group_edges FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_reset();
DROP TRIGGER IF EXISTS fd_record_reset ON flightdeck_pg_workspace_memberships;
CREATE TRIGGER fd_record_reset AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_workspace_memberships FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_reset();
DROP TRIGGER IF EXISTS fd_record_reset ON flightdeck_pg_actors;
CREATE TRIGGER fd_record_reset AFTER UPDATE ON flightdeck_pg_actors FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_reset();
DROP TRIGGER IF EXISTS fd_record_reset ON flightdeck_pg_scopes;
CREATE TRIGGER fd_record_reset AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_scopes FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_reset();
DROP TRIGGER IF EXISTS fd_record_reset ON flightdeck_pg_channels;
CREATE TRIGGER fd_record_reset AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_channels FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_reset();
DROP TRIGGER IF EXISTS fd_record_reset ON flightdeck_pg_workspaces;
CREATE TRIGGER fd_record_reset AFTER UPDATE ON flightdeck_pg_workspaces FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_reset();
CREATE INDEX IF NOT EXISTS idx_fd_message_timeline ON flightdeck_pg_messages(workspace_id,channel_id,(date_trunc('milliseconds',created_at AT TIME ZONE 'UTC')),id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_message_thread_timeline ON flightdeck_pg_messages(workspace_id,channel_id,thread_id,(date_trunc('milliseconds',created_at AT TIME ZONE 'UTC')),id) WHERE thread_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_task_board ON flightdeck_pg_tasks(workspace_id,channel_id,state,(-extract(epoch FROM updated_at AT TIME ZONE 'UTC')),id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_task_comment_timeline ON flightdeck_pg_task_comments(workspace_id,task_id,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_doc_comment_timeline ON flightdeck_pg_doc_comments(workspace_id,doc_id,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_task_channel_window ON flightdeck_pg_tasks(workspace_id,channel_id,(-extract(epoch FROM updated_at AT TIME ZONE 'UTC')),id) WHERE deleted_at IS NULL;
-- Effective transcripts retain tombstones as fork anchors and read-only rows.
CREATE INDEX IF NOT EXISTS idx_fd_message_thread_effective_timeline
  ON flightdeck_pg_messages(workspace_id,channel_id,thread_id,(date_trunc('milliseconds',created_at AT TIME ZONE 'UTC')),id)
  WHERE thread_id IS NOT NULL;

-- end_flightdeck_record_delta_v1
-- flightdeck_record_checkpoints_v2
-- Separate durable device state from legacy cursors and disposable page tokens.
CREATE TABLE IF NOT EXISTS flightdeck_pg_record_clients (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
 client_id UUID NOT NULL, epoch UUID NOT NULL,
 initial_cursor UUID NOT NULL DEFAULT gen_random_uuid(), initial_state JSONB NOT NULL,
 checkpoint_cursor UUID, checkpoint_state JSONB,
 revision BIGINT NOT NULL DEFAULT 0 CHECK(revision >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,actor_id,client_id),
 CHECK((checkpoint_cursor IS NULL AND checkpoint_state IS NULL AND revision=0)
   OR (checkpoint_cursor IS NOT NULL AND checkpoint_state IS NOT NULL AND revision>0))
);
CREATE INDEX IF NOT EXISTS idx_fd_record_client_activity ON flightdeck_pg_record_clients(last_active_at);
CREATE TABLE IF NOT EXISTS flightdeck_pg_record_page_tokens (
 token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL, actor_id UUID NOT NULL, client_id UUID NOT NULL,
 epoch UUID NOT NULL, state JSONB NOT NULL, base_revision BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,actor_id,client_id)
   REFERENCES flightdeck_pg_record_clients(workspace_id,actor_id,client_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fd_record_page_client ON flightdeck_pg_record_page_tokens(workspace_id,actor_id,client_id,created_at DESC,token);
CREATE INDEX IF NOT EXISTS idx_fd_record_page_activity ON flightdeck_pg_record_page_tokens(last_used_at,token);
-- Future prefix-pruning must advance this floor under the workspace clock lock.
ALTER TABLE flightdeck_pg_record_clock ADD COLUMN IF NOT EXISTS journal_floor BIGINT NOT NULL DEFAULT 0;
-- end_flightdeck_record_checkpoints_v2


-- Authentication identity only; legacy git_* data remains for audit.
CREATE TABLE IF NOT EXISTS forgejo_login_identities (
  npub TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  initial_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Identity continuity migration only; no Forgejo permission or account mutation.
INSERT INTO forgejo_login_identities (npub, subject, initial_username)
SELECT actor.npub, actor.id::text,
  COALESCE(alias.applied_username, alias.desired_username,
    'nostr-' || substr(md5(actor.npub), 1, 24))
FROM flightdeck_pg_actors actor
LEFT JOIN git_forgejo_actor_aliases alias ON alias.actor_id = actor.id
ON CONFLICT (npub) DO NOTHING;

-- FIPS Drive metadata v1

CREATE TABLE IF NOT EXISTS flightdeck_pg_drive_shares (
 id UUID PRIMARY KEY,
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 owner_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 host_npub TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
 host_name TEXT NOT NULL CHECK (char_length(host_name) BETWEEN 1 AND 120),
 audience TEXT NOT NULL CHECK (audience IN ('private','workspace')),
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 revision BIGINT NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS drive_workspace ON flightdeck_pg_drive_shares(workspace_id);
CREATE TABLE IF NOT EXISTS flightdeck_pg_drive_proofs (
 event_id TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL
);

-- feed_reader_v1
-- Include reader authority in the bounded journal authorization projection.
CREATE OR REPLACE FUNCTION flightdeck_pg_record_context(r JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('scope_id',r->'scope_id','channel_id',r->'channel_id',
 'actor_id',r->'actor_id','owner_actor_id',r->'owner_actor_id','viewer_actor_id',r->'viewer_actor_id','reader_actor_id',r->'reader_actor_id',
 'resource_type',r->'resource_type','resource_id',r->'resource_id',
 'task_id',r->'task_id','doc_id',r->'doc_id','thread_id',r->'thread_id')
$$;
-- Personal reader metadata only; publishing tables and grants are untouched.
CREATE TABLE IF NOT EXISTS flightdeck_pg_feed_subscriptions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 reader_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 source JSONB NOT NULL CHECK(source->>'kind' IN ('wapp','public')),
 source_key JSONB NOT NULL,
 title TEXT CHECK(title IS NULL OR length(title)<=256),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','unsubscribed')),
 row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(workspace_id,reader_actor_id,source_key), UNIQUE(workspace_id,reader_actor_id,id)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_feed_item_states (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
 workspace_id UUID NOT NULL, reader_actor_id UUID NOT NULL, subscription_id UUID NOT NULL,
 item_id TEXT NOT NULL CHECK(length(item_id)>0 AND octet_length(item_id)<=2048),
 read BOOLEAN NOT NULL DEFAULT FALSE, dismissed BOOLEAN NOT NULL DEFAULT FALSE, saved BOOLEAN NOT NULL DEFAULT FALSE,
 row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(workspace_id,reader_actor_id,subscription_id) REFERENCES flightdeck_pg_feed_subscriptions(workspace_id,reader_actor_id,id) ON DELETE CASCADE,
 UNIQUE(workspace_id,reader_actor_id,subscription_id,item_id)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_feed_mutations (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE, reader_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 mutation_id UUID NOT NULL, request_hash TEXT NOT NULL, acknowledgement JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(workspace_id,reader_actor_id,mutation_id)
);
-- Cursors store scoped positions, never feed contents. Preferences and flags do not expire.
CREATE TABLE IF NOT EXISTS flightdeck_pg_feed_cursors (
 token UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 reader_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id), route TEXT NOT NULL, after_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feed_subscription_reader ON flightdeck_pg_feed_subscriptions(workspace_id,reader_actor_id,id);
CREATE INDEX IF NOT EXISTS idx_feed_state_reader ON flightdeck_pg_feed_item_states(workspace_id,reader_actor_id,subscription_id,id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_feed_subscription') THEN
 CREATE TRIGGER fd_record_feed_subscription AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_feed_subscriptions
 FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('feed_subscription');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_feed_item_state') THEN
 CREATE TRIGGER fd_record_feed_item_state AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_feed_item_states
 FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('feed_item_state');
 END IF;
END $$;
-- Refresh stored generated context only if upgrading rows written before this projection.
UPDATE flightdeck_pg_record_current SET row=row WHERE family IN ('feed_subscription','feed_item_state') AND NOT context ? 'reader_actor_id';
UPDATE flightdeck_pg_record_journal SET row=row WHERE family IN ('feed_subscription','feed_item_state') AND NOT context ? 'reader_actor_id';
-- end_feed_reader_v1

-- context_tree_v1
-- Context structure belongs to one scope; target content has no cascade/FK here.
CREATE TABLE IF NOT EXISTS flightdeck_pg_context_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 256),
  parent_id UUID,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (workspace_id, scope_id, id),
  FOREIGN KEY (workspace_id, scope_id) REFERENCES flightdeck_pg_scopes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, parent_id)
    REFERENCES flightdeck_pg_context_components(workspace_id, scope_id, id) ON DELETE RESTRICT,
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX IF NOT EXISTS idx_fd_context_components_active
  ON flightdeck_pg_context_components(workspace_id, scope_id, parent_id, sort_order, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_context_components_page
  ON flightdeck_pg_context_components(workspace_id, scope_id, sort_order, id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS flightdeck_pg_context_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  component_id UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('doc', 'file', 'task', 'artifact')),
  target JSONB NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  FOREIGN KEY (workspace_id, scope_id, component_id)
    REFERENCES flightdeck_pg_context_components(workspace_id, scope_id, id) ON DELETE CASCADE,
  CHECK (
    (target_type IN ('doc','file','task')
      AND target = jsonb_build_object('record_id', target->>'record_id')
      AND COALESCE(target->>'record_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR (target_type = 'artifact' AND COALESCE(
      target = jsonb_build_object('origin',target->>'origin','project',target->>'project',
        'artifact',target->>'artifact','page','index.html','version_policy','latest')
      AND target->>'origin' ~ '^https?://[^/@?#[:space:]]+$'
      AND target->>'project' ~ '^[A-Za-z0-9_-]{1,128}$'
      AND target->>'artifact' ~ '^[A-Za-z0-9_-]{1,128}$', FALSE))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_context_reference_target_active
  ON flightdeck_pg_context_references(workspace_id, component_id, target_type, target) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_context_references_active
  ON flightdeck_pg_context_references(workspace_id, scope_id, component_id, sort_order, id) WHERE deleted_at IS NULL;

-- end_context_tree_v1

-- context_tree_sync_v1
-- Context Tree record recovery v1. No target resolution is stored in this journal.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_context_component') THEN
 LOCK TABLE flightdeck_pg_context_components IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_context_components ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'context_component', id::text, to_jsonb(r) FROM flightdeck_pg_context_components r WHERE deleted_at IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_context_component AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_context_components FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('context_component');
 -- Existing clients must negotiate a replacement snapshot for newly registered families.
 UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_context_reference') THEN
 LOCK TABLE flightdeck_pg_context_references IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_context_references ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'context_reference', id::text, to_jsonb(r) FROM flightdeck_pg_context_references r WHERE deleted_at IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_context_reference AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_context_references FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('context_reference');
 -- Existing clients must negotiate a replacement snapshot for newly registered families.
 UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid();
 END IF;
END $$;
-- end_context_tree_sync_v1

-- personal_attention_v1
ALTER TABLE flightdeck_pg_tasks ADD COLUMN IF NOT EXISTS attention JSONB;
ALTER TABLE flightdeck_pg_docs ADD COLUMN IF NOT EXISTS attention JSONB;

-- Event positions are kept per surviving comment, not per latest unrelated update.
-- Historical positions come only from an exact structured outbox event. Missing
-- history stays neutral rather than inventing an unread event at today's version.
UPDATE flightdeck_pg_tasks r SET attention = jsonb_build_object(
  'policy_version',1,'body_activity_version',0,
  'last_activity_actor_id',r.updated_by_actor_id,
  'comment_activity_versions',COALESCE((SELECT jsonb_object_agg(comment_id,version) FROM (
    SELECT c.id::text AS comment_id, MAX((e.payload->>'activity_version')::bigint) AS version
    FROM flightdeck_pg_task_comments c JOIN flightdeck_pg_outbox_events e
      ON e.workspace_id=c.workspace_id AND e.entity_id=c.id AND e.event_type='flightdeck_pg.task_comment.created'
    WHERE c.workspace_id=r.workspace_id AND c.task_id=r.id AND c.deleted_at IS NULL
      AND e.payload->>'activity_version' ~ '^[0-9]+$' GROUP BY c.id
  ) positions),'{}'::jsonb),'mention_activity_versions','{}'::jsonb
) WHERE attention IS NULL;
UPDATE flightdeck_pg_docs r SET attention = jsonb_build_object(
  'policy_version',1,'last_activity_actor_id',r.updated_by_actor_id,
  'body_activity_version',COALESCE((SELECT (e.payload->>'activity_version')::bigint
    FROM flightdeck_pg_outbox_events e WHERE e.workspace_id=r.workspace_id AND e.entity_id=r.id
      AND e.event_type IN ('flightdeck_pg.doc.created','flightdeck_pg.doc.updated')
      AND (e.event_type='flightdeck_pg.doc.created' OR (e.payload->'body_version' IS DISTINCT FROM e.payload->'prior_body_version' OR jsonb_array_length(CASE WHEN jsonb_typeof(e.payload->'newly_added_mentions')='array' THEN e.payload->'newly_added_mentions' ELSE '[]'::jsonb END)>0))
      AND e.payload->>'activity_version' ~ '^[0-9]+$'
    ORDER BY (e.payload->>'activity_version')::bigint DESC LIMIT 1),0),
  'body_actor_id',(SELECT e.actor_id FROM flightdeck_pg_outbox_events e
    WHERE e.workspace_id=r.workspace_id AND e.entity_id=r.id
      AND e.event_type IN ('flightdeck_pg.doc.created','flightdeck_pg.doc.updated')
      AND (e.event_type='flightdeck_pg.doc.created' OR (e.payload->'body_version' IS DISTINCT FROM e.payload->'prior_body_version' OR jsonb_array_length(CASE WHEN jsonb_typeof(e.payload->'newly_added_mentions')='array' THEN e.payload->'newly_added_mentions' ELSE '[]'::jsonb END)>0))
      AND e.payload->>'activity_version' ~ '^[0-9]+$'
    ORDER BY (e.payload->>'activity_version')::bigint DESC LIMIT 1),
  'comment_activity_versions',COALESCE((SELECT jsonb_object_agg(comment_id,version) FROM (
    SELECT c.id::text AS comment_id, MAX((e.payload->>'activity_version')::bigint) AS version
    FROM flightdeck_pg_doc_comments c JOIN flightdeck_pg_outbox_events e
      ON e.workspace_id=c.workspace_id AND e.entity_id=c.id AND e.event_type='flightdeck_pg.doc_comment.created'
    WHERE c.workspace_id=r.workspace_id AND c.doc_id=r.id AND c.deleted_at IS NULL
      AND e.payload->>'activity_version' ~ '^[0-9]+$' GROUP BY c.id
  ) positions),'{}'::jsonb),'mention_activity_versions','{}'::jsonb
) WHERE attention IS NULL;
ALTER TABLE flightdeck_pg_tasks ALTER COLUMN attention SET DEFAULT '{"policy_version":1,"body_activity_version":0,"mention_activity_versions":{},"comment_activity_versions":{}}'::jsonb;
ALTER TABLE flightdeck_pg_docs ALTER COLUMN attention SET DEFAULT '{"policy_version":1,"body_activity_version":0,"mention_activity_versions":{},"comment_activity_versions":{}}'::jsonb;
ALTER TABLE flightdeck_pg_tasks ALTER COLUMN attention SET NOT NULL;
ALTER TABLE flightdeck_pg_docs ALTER COLUMN attention SET NOT NULL;

CREATE OR REPLACE FUNCTION flightdeck_pg_refresh_comment_attention(w UUID, kind TEXT, target UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE positions JSONB; mentions JSONB; previous JSONB;
BEGIN
  IF kind='task' THEN
    SELECT attention INTO previous FROM flightdeck_pg_tasks WHERE workspace_id=w AND id=target FOR UPDATE;
  ELSIF kind='document' THEN
    SELECT attention INTO previous FROM flightdeck_pg_docs WHERE workspace_id=w AND id=target FOR UPDATE;
  ELSE RETURN;
  END IF;
  IF previous IS NULL THEN RETURN; END IF;
  SELECT COALESCE(jsonb_object_agg(c.id::text,previous->'comment_activity_versions'->c.id::text),'{}'::jsonb)
    INTO positions FROM (
      SELECT id FROM flightdeck_pg_task_comments WHERE kind='task' AND workspace_id=w AND task_id=target AND deleted_at IS NULL
      UNION ALL SELECT id FROM flightdeck_pg_doc_comments WHERE kind='document' AND workspace_id=w AND doc_id=target AND deleted_at IS NULL
    ) c WHERE previous->'comment_activity_versions' ? c.id::text;
  SELECT COALESCE(jsonb_object_agg(actor_id,version),'{}'::jsonb) INTO mentions FROM (
    SELECT a.id::text AS actor_id, MAX((positions->>c.id::text)::bigint) AS version
    FROM (
      SELECT id,metadata,created_by_actor_id FROM flightdeck_pg_task_comments WHERE kind='task' AND workspace_id=w AND task_id=target AND deleted_at IS NULL
      UNION ALL SELECT id,metadata,created_by_actor_id FROM flightdeck_pg_doc_comments WHERE kind='document' AND workspace_id=w AND doc_id=target AND deleted_at IS NULL
    ) c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.metadata->'mentions')='array' THEN c.metadata->'mentions' ELSE '[]'::jsonb END) m
    JOIN flightdeck_pg_actors a ON (m->>'actor_id'=a.id::text OR (m->>'actor_id' IS NULL AND m->>'npub'=a.npub))
    JOIN flightdeck_pg_workspace_memberships wm ON wm.workspace_id=w AND wm.actor_id=a.id
    WHERE m->>'type' IN ('person','agent','human') AND a.id<>c.created_by_actor_id AND positions ? c.id::text
    GROUP BY a.id
  ) relevant;
  IF kind='task' THEN
    UPDATE flightdeck_pg_tasks SET attention=previous || jsonb_build_object('comment_activity_versions',positions,'mention_activity_versions',mentions)
      WHERE workspace_id=w AND id=target AND attention IS DISTINCT FROM previous || jsonb_build_object('comment_activity_versions',positions,'mention_activity_versions',mentions);
  ELSE
    UPDATE flightdeck_pg_docs SET attention=previous || jsonb_build_object('comment_activity_versions',positions,'mention_activity_versions',mentions)
      WHERE workspace_id=w AND id=target AND attention IS DISTINCT FROM previous || jsonb_build_object('comment_activity_versions',positions,'mention_activity_versions',mentions);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION flightdeck_pg_comment_attention_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r JSONB;
BEGIN
  r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  PERFORM flightdeck_pg_refresh_comment_attention((r->>'workspace_id')::uuid,TG_ARGV[0],
    (CASE WHEN TG_ARGV[0]='task' THEN r->>'task_id' ELSE r->>'doc_id' END)::uuid);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fd_task_comment_attention ON flightdeck_pg_task_comments;
CREATE TRIGGER fd_task_comment_attention AFTER UPDATE OR DELETE ON flightdeck_pg_task_comments
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_comment_attention_changed('task');
DROP TRIGGER IF EXISTS fd_doc_comment_attention ON flightdeck_pg_doc_comments;
CREATE TRIGGER fd_doc_comment_attention AFTER UPDATE OR DELETE ON flightdeck_pg_doc_comments
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_comment_attention_changed('document');

CREATE OR REPLACE FUNCTION flightdeck_pg_initial_attention() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.attention:=jsonb_build_object('policy_version',1,'last_activity_actor_id',NEW.created_by_actor_id,
    'body_actor_id',NEW.created_by_actor_id,'body_activity_version',CASE WHEN TG_TABLE_NAME='flightdeck_pg_docs' THEN NEW.activity_version ELSE 0 END,
    'comment_activity_versions','{}'::jsonb,'mention_activity_versions','{}'::jsonb);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fd_task_initial_attention ON flightdeck_pg_tasks;
CREATE TRIGGER fd_task_initial_attention BEFORE INSERT ON flightdeck_pg_tasks FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_initial_attention();
DROP TRIGGER IF EXISTS fd_doc_initial_attention ON flightdeck_pg_docs;
CREATE TRIGGER fd_doc_initial_attention BEFORE INSERT ON flightdeck_pg_docs FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_initial_attention();

-- One projection for legacy view APIs and both record-delta protocols.
CREATE OR REPLACE FUNCTION flightdeck_pg_attention_version(w UUID, kind TEXT, target UUID, viewer UUID)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(MAX(version),0) FROM (
    SELECT t.activity_version AS version FROM flightdeck_pg_threads t
      WHERE kind='thread' AND t.workspace_id=w AND t.id=target AND t.deleted_at IS NULL AND t.archived_at IS NULL
    UNION ALL
    SELECT GREATEST(COALESCE((t.attention->'mention_activity_versions'->>viewer::text)::bigint,0),
      CASE WHEN t.attention->>'last_activity_actor_id' IS DISTINCT FROM viewer::text AND
        (CASE WHEN t.metadata ? 'assigned_to_npub' THEN
          t.metadata->>'assigned_to_npub'=(SELECT npub FROM flightdeck_pg_actors WHERE id=viewer)
         ELSE EXISTS(SELECT 1 FROM flightdeck_pg_task_assignments a WHERE a.workspace_id=w AND a.task_id=t.id AND a.actor_id=viewer AND a.deleted_at IS NULL) END)
        THEN t.activity_version ELSE 0 END)
      FROM flightdeck_pg_tasks t WHERE kind='task' AND t.workspace_id=w AND t.id=target AND t.deleted_at IS NULL
    UNION ALL
    SELECT GREATEST(COALESCE((d.attention->'mention_activity_versions'->>viewer::text)::bigint,0),
      CASE WHEN d.attention->>'body_actor_id' IS DISTINCT FROM viewer::text AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.metadata->'mentions')='array' THEN d.metadata->'mentions' ELSE '[]'::jsonb END) m
        WHERE m->>'type' IN ('person','agent','human') AND (m->>'actor_id'=viewer::text
          OR (m->>'actor_id' IS NULL AND m->>'npub'=(SELECT npub FROM flightdeck_pg_actors WHERE id=viewer))))
        THEN COALESCE((d.attention->>'body_activity_version')::bigint,0) ELSE 0 END)
      FROM flightdeck_pg_docs d WHERE kind='document' AND d.workspace_id=w AND d.id=target AND d.deleted_at IS NULL AND d.archived_at IS NULL
  ) events WHERE EXISTS(SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=w AND actor_id=viewer)
$$;
-- Persist personalized projections so record journal rows remain immutable.
-- Derived refreshes do not change viewed_activity_version, read time or row_version.
ALTER TABLE flightdeck_pg_resource_view_states ADD COLUMN IF NOT EXISTS activity_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE flightdeck_pg_resource_view_states ADD COLUMN IF NOT EXISTS attention_policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE flightdeck_pg_resource_view_states ADD COLUMN IF NOT EXISTS attention_activity_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE flightdeck_pg_resource_view_states ADD COLUMN IF NOT EXISTS attention_unread BOOLEAN NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION flightdeck_pg_project_view_attention() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resource_type='thread' THEN
    SELECT activity_version INTO NEW.activity_version FROM flightdeck_pg_threads WHERE workspace_id=NEW.workspace_id AND id=NEW.resource_id;
  ELSIF NEW.resource_type='task' THEN
    SELECT activity_version INTO NEW.activity_version FROM flightdeck_pg_tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.resource_id;
  ELSE
    SELECT activity_version INTO NEW.activity_version FROM flightdeck_pg_docs WHERE workspace_id=NEW.workspace_id AND id=NEW.resource_id;
  END IF;
  NEW.activity_version:=COALESCE(NEW.activity_version,0);
  NEW.attention_policy_version:=1;
  NEW.attention_activity_version:=flightdeck_pg_attention_version(NEW.workspace_id,NEW.resource_type,NEW.resource_id,NEW.viewer_actor_id);
  NEW.attention_unread:=NEW.attention_activity_version>NEW.viewed_activity_version;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fd_project_view_attention ON flightdeck_pg_resource_view_states;
CREATE TRIGGER fd_project_view_attention BEFORE INSERT OR UPDATE ON flightdeck_pg_resource_view_states FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_project_view_attention();
CREATE OR REPLACE FUNCTION flightdeck_pg_refresh_view_attention() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE flightdeck_pg_resource_view_states s SET activity_version=NEW.activity_version
    WHERE s.workspace_id=NEW.workspace_id AND s.resource_type=TG_ARGV[0] AND s.resource_id=NEW.id
      AND (s.activity_version IS DISTINCT FROM NEW.activity_version
        OR s.attention_activity_version IS DISTINCT FROM flightdeck_pg_attention_version(NEW.workspace_id,TG_ARGV[0],NEW.id,s.viewer_actor_id));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fd_refresh_task_view_attention ON flightdeck_pg_tasks;
CREATE TRIGGER fd_refresh_task_view_attention AFTER UPDATE ON flightdeck_pg_tasks FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_refresh_view_attention('task');
DROP TRIGGER IF EXISTS fd_refresh_doc_view_attention ON flightdeck_pg_docs;
CREATE TRIGGER fd_refresh_doc_view_attention AFTER UPDATE ON flightdeck_pg_docs FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_refresh_view_attention('document');
DROP TRIGGER IF EXISTS fd_refresh_thread_view_attention ON flightdeck_pg_threads;
CREATE TRIGGER fd_refresh_thread_view_attention AFTER UPDATE ON flightdeck_pg_threads FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_refresh_view_attention('thread');
-- Install derived fields on existing rows; equality capture guards skip repeat startup.
UPDATE flightdeck_pg_resource_view_states SET activity_version=activity_version;
-- Recompute once from exact surviving history. Equality guards avoid no-op
-- journals on startup and never touch read watermarks or checkpoint records.
SELECT flightdeck_pg_refresh_comment_attention(workspace_id,'task',id) FROM flightdeck_pg_tasks WHERE attention->'comment_activity_versions'<>'{}'::jsonb AND attention->'mention_activity_versions'='{}'::jsonb;
SELECT flightdeck_pg_refresh_comment_attention(workspace_id,'document',id) FROM flightdeck_pg_docs WHERE attention->'comment_activity_versions'<>'{}'::jsonb AND attention->'mention_activity_versions'='{}'::jsonb;
-- end_personal_attention_v1

-- task_single_assignee_v1
-- Read-only unresolved evidence remains available; startup never invents an
-- owner or fails because an unrelated historical task needs human resolution.
CREATE OR REPLACE VIEW flightdeck_pg_task_assignment_ambiguities AS
 SELECT t.workspace_id,t.id AS task_id,t.metadata->>'assigned_to_npub' AS primary_npub,
   ARRAY(SELECT a.actor_id FROM flightdeck_pg_task_assignments a WHERE a.task_id=t.id AND a.deleted_at IS NULL ORDER BY a.actor_id) AS active_actor_ids
 FROM flightdeck_pg_tasks t
 WHERE (NULLIF(btrim(t.metadata->>'assigned_to_npub'),'') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id
    WHERE m.workspace_id=t.workspace_id AND a.npub=btrim(t.metadata->>'assigned_to_npub')))
    OR (NOT (t.metadata ? 'assigned_to_npub') AND (SELECT count(*) FROM flightdeck_pg_task_assignments a
      WHERE a.workspace_id=t.workspace_id AND a.task_id=t.id AND a.deleted_at IS NULL)>1);
DO $$
BEGIN
  LOCK TABLE flightdeck_pg_tasks, flightdeck_pg_task_assignments IN SHARE ROW EXCLUSIVE MODE;
  -- Missing primary plus exactly one relation row is unambiguous. Explicit null
  -- is unassigned. Invalid primaries/ambiguous rows remain intact for resolution.
  UPDATE flightdeck_pg_tasks t SET metadata=(t.metadata-'assigned_to_npubs') || jsonb_build_object('assigned_to_npub',
    CASE WHEN t.metadata ? 'assigned_to_npub' THEN NULLIF(btrim(t.metadata->>'assigned_to_npub'),'')
      ELSE (SELECT actor.npub FROM flightdeck_pg_task_assignments a JOIN flightdeck_pg_actors actor ON actor.id=a.actor_id
        WHERE a.workspace_id=t.workspace_id AND a.task_id=t.id AND a.deleted_at IS NULL) END)
    WHERE NOT EXISTS(SELECT 1 FROM flightdeck_pg_task_assignment_ambiguities u WHERE u.task_id=t.id)
      AND (NOT (t.metadata ? 'assigned_to_npub') OR t.metadata ? 'assigned_to_npubs'
      OR t.metadata->>'assigned_to_npub' IS DISTINCT FROM NULLIF(btrim(t.metadata->>'assigned_to_npub'),''));
  UPDATE flightdeck_pg_task_assignments a SET deleted_at=now(),row_version=a.row_version+1,
    updated_at=now(),updated_by_actor_id=t.updated_by_actor_id
    FROM flightdeck_pg_tasks t, flightdeck_pg_actors actor
    WHERE t.id=a.task_id AND t.workspace_id=a.workspace_id AND actor.id=a.actor_id AND a.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM flightdeck_pg_task_assignment_ambiguities u WHERE u.task_id=t.id)
      AND actor.npub IS DISTINCT FROM t.metadata->>'assigned_to_npub';
  INSERT INTO flightdeck_pg_task_assignments(workspace_id,scope_id,channel_id,task_id,actor_id,created_by_actor_id,updated_by_actor_id)
    SELECT t.workspace_id,t.scope_id,t.channel_id,t.id,actor.id,t.created_by_actor_id,t.updated_by_actor_id
    FROM flightdeck_pg_tasks t JOIN flightdeck_pg_actors actor ON actor.npub=t.metadata->>'assigned_to_npub'
    WHERE NOT EXISTS(SELECT 1 FROM flightdeck_pg_task_assignment_ambiguities u WHERE u.task_id=t.id)
    ON CONFLICT(task_id,actor_id) DO UPDATE SET deleted_at=NULL,row_version=flightdeck_pg_task_assignments.row_version+1,
      updated_at=now(),updated_by_actor_id=EXCLUDED.updated_by_actor_id
      WHERE flightdeck_pg_task_assignments.deleted_at IS NOT NULL;
  -- Install the stronger index when historical ambiguity does not prevent it.
  -- The row-locking guard below applies on every deployment regardless.
  IF NOT EXISTS(SELECT 1 FROM flightdeck_pg_task_assignments WHERE deleted_at IS NULL GROUP BY task_id HAVING count(*)>1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_task_single_assignee ON flightdeck_pg_task_assignments(task_id) WHERE deleted_at IS NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION flightdeck_pg_guard_single_assignment() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NULL THEN
    IF NOT EXISTS(SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=NEW.workspace_id AND actor_id=NEW.actor_id) THEN
      RAISE EXCEPTION 'Task assignee must be a workspace actor' USING ERRCODE='23503';
    END IF;
    PERFORM 1 FROM flightdeck_pg_tasks WHERE id=NEW.task_id AND workspace_id=NEW.workspace_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM flightdeck_pg_task_assignments WHERE task_id=NEW.task_id AND deleted_at IS NULL AND actor_id<>NEW.actor_id) THEN
      RAISE EXCEPTION 'Tasks accept zero or one assignee';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fd_guard_single_assignment ON flightdeck_pg_task_assignments;
CREATE TRIGGER fd_guard_single_assignment BEFORE INSERT OR UPDATE ON flightdeck_pg_task_assignments
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_guard_single_assignment();

CREATE OR REPLACE FUNCTION flightdeck_pg_normalize_task_primary() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.metadata := (NEW.metadata-'assigned_to_npubs') || jsonb_build_object('assigned_to_npub',NULLIF(btrim(NEW.metadata->>'assigned_to_npub'),''));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fd_normalize_task_primary ON flightdeck_pg_tasks;
CREATE TRIGGER fd_normalize_task_primary BEFORE INSERT OR UPDATE OF metadata ON flightdeck_pg_tasks
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_normalize_task_primary();

CREATE OR REPLACE FUNCTION flightdeck_pg_sync_task_primary_assignment() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE primary_actor UUID;
BEGIN
  IF NULLIF(btrim(NEW.metadata->>'assigned_to_npub'),'') IS NOT NULL THEN
    SELECT a.id INTO primary_actor FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id
      WHERE m.workspace_id=NEW.workspace_id AND a.npub=NEW.metadata->>'assigned_to_npub';
    IF primary_actor IS NULL THEN RAISE EXCEPTION 'Task assignee must be a workspace actor'; END IF;
  END IF;
  UPDATE flightdeck_pg_task_assignments SET deleted_at=now(),row_version=row_version+1,updated_at=now(),updated_by_actor_id=NEW.updated_by_actor_id
    WHERE task_id=NEW.id AND workspace_id=NEW.workspace_id AND deleted_at IS NULL AND actor_id IS DISTINCT FROM primary_actor;
  IF primary_actor IS NOT NULL THEN
    INSERT INTO flightdeck_pg_task_assignments(workspace_id,scope_id,channel_id,task_id,actor_id,created_by_actor_id,updated_by_actor_id)
      VALUES(NEW.workspace_id,NEW.scope_id,NEW.channel_id,NEW.id,primary_actor,NEW.updated_by_actor_id,NEW.updated_by_actor_id)
      ON CONFLICT(task_id,actor_id) DO UPDATE SET deleted_at=NULL,row_version=flightdeck_pg_task_assignments.row_version+1,
        updated_at=now(),updated_by_actor_id=EXCLUDED.updated_by_actor_id
        WHERE flightdeck_pg_task_assignments.deleted_at IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fd_sync_task_primary_assignment ON flightdeck_pg_tasks;
CREATE TRIGGER fd_sync_task_primary_assignment AFTER INSERT OR UPDATE OF metadata ON flightdeck_pg_tasks
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_sync_task_primary_assignment();

-- Refresh only derived attention. Never modify activity, viewed watermarks,
-- task versions, leases, or checkpoint cursors during repair.
UPDATE flightdeck_pg_resource_view_states s SET activity_version=s.activity_version
  WHERE resource_type='task' AND attention_activity_version IS DISTINCT FROM
    flightdeck_pg_attention_version(s.workspace_id,s.resource_type,s.resource_id,s.viewer_actor_id);
-- end_task_single_assignee_v1

CREATE TABLE IF NOT EXISTS flightdeck_pg_blossom_publications (
  workspace_id UUID NOT NULL,
  file_id UUID NOT NULL,
  version_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE CASCADE,
  sha256_hex TEXT NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, version_id, actor_id),
  FOREIGN KEY (workspace_id, file_id) REFERENCES flightdeck_pg_files(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, version_id) REFERENCES flightdeck_pg_file_versions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_blossom_publications_object
  ON flightdeck_pg_blossom_publications(storage_object_id, sha256_hex) WHERE revoked_at IS NULL;

-- Public byte consent is pinned to one attachment-link lifetime, never a new storage link.
CREATE TABLE IF NOT EXISTS flightdeck_pg_blossom_message_publications (
  workspace_id UUID NOT NULL,
  message_id UUID NOT NULL,
  link_id UUID NOT NULL REFERENCES flightdeck_pg_storage_links(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE CASCADE,
  sha256_hex TEXT NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, link_id, actor_id),
  FOREIGN KEY (workspace_id, message_id) REFERENCES flightdeck_pg_messages(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_blossom_message_publications_object
  ON flightdeck_pg_blossom_message_publications(storage_object_id, sha256_hex) WHERE revoked_at IS NULL;

-- Shared org-data / static napplet v1 (also ensured by org-data-v1.sql).
CREATE TABLE IF NOT EXISTS flightdeck_pg_org_data_types (
 workspace_id uuid NOT NULL REFERENCES flightdeck_pg_workspaces(id), key text NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(), label text NOT NULL, fields jsonb NOT NULL,
 access jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,key)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_org_data_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, type_key text NOT NULL,
 values jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,type_key) REFERENCES flightdeck_pg_org_data_types(workspace_id,key)
);
CREATE INDEX IF NOT EXISTS org_data_record_type ON flightdeck_pg_org_data_records(workspace_id,type_key);
CREATE TABLE IF NOT EXISTS flightdeck_pg_org_data_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES flightdeck_pg_workspaces(id),
 actor_id uuid NOT NULL REFERENCES flightdeck_pg_actors(id), operation text NOT NULL, target_id text NOT NULL,
 before_value jsonb, after_value jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_napplet_bundles (
 workspace_id uuid NOT NULL REFERENCES flightdeck_pg_workspaces(id),
 key text NOT NULL, version integer NOT NULL CHECK(version>0), title text NOT NULL,
 bridge_version integer NOT NULL CHECK(bridge_version=1), capabilities jsonb NOT NULL,
 html text NOT NULL, sha256 text NOT NULL, created_by_actor_id uuid NOT NULL REFERENCES flightdeck_pg_actors(id),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,key,version)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_napplet_installations (
 workspace_id uuid NOT NULL, key text NOT NULL, version integer NOT NULL,
 revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,key), FOREIGN KEY(workspace_id,key,version)
 REFERENCES flightdeck_pg_napplet_bundles(workspace_id,key,version)
);
CREATE INDEX IF NOT EXISTS org_data_audit_workspace ON flightdeck_pg_org_data_audit(workspace_id,id);

-- Add default capabilities once. A revoked grant is never silently re-created.
INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,permission,created_by_actor_id)
SELECT g.workspace_id,'group',g.id,'workspace',p.permission,w.created_by_actor_id
FROM flightdeck_pg_groups g JOIN flightdeck_pg_workspaces w ON w.id=g.workspace_id
CROSS JOIN (VALUES ('Admins','org_data.read'),('Admins','org_data.write'),('Admins','org_data.schema'),('Admins','napplet.publish'),('Admins','napplet.install'),('People','org_data.read')) p(group_name,permission)
WHERE g.name=p.group_name AND NOT EXISTS (SELECT 1 FROM flightdeck_pg_permission_grants old WHERE old.workspace_id=g.workspace_id AND old.principal_group_id=g.id AND old.resource_type='workspace' AND old.permission=p.permission)
ON CONFLICT DO NOTHING;

-- Personal navigation preferences; no shared scope position or authority epoch.
CREATE TABLE IF NOT EXISTS flightdeck_pg_scope_orders (
 workspace_id UUID NOT NULL, actor_id UUID NOT NULL, scope_ids UUID[] NOT NULL DEFAULT '{}',
 row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id,actor_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_scope_order_mutations (
 workspace_id UUID NOT NULL, actor_id UUID NOT NULL, mutation_id UUID NOT NULL,
 request_hash TEXT NOT NULL, acknowledgement JSONB NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,mutation_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id,actor_id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION flightdeck_pg_scope_order_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r JSONB; BEGIN
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 r := r || jsonb_build_object('id',r->>'actor_id');
 PERFORM flightdeck_pg_record_emit((r->>'workspace_id')::uuid,'scope_order',r,CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END);
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS fd_record_scope_order ON flightdeck_pg_scope_orders;
CREATE TRIGGER fd_record_scope_order AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_scope_orders FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_scope_order_capture();

-- hosting_billing_v1

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

-- end_hosting_billing_v1

-- additive_record_access_v1
-- Authority observation is independent of the ordinary journal and epoch.
ALTER TABLE flightdeck_pg_record_clock ADD COLUMN IF NOT EXISTS access_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE flightdeck_pg_record_current ADD COLUMN IF NOT EXISTS position BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_fd_record_current_channel_partition ON flightdeck_pg_record_current
  (workspace_id,family,(COALESCE(context->>'channel_id',CASE WHEN family='channel' THEN id END)),id) INCLUDE(position);
CREATE INDEX IF NOT EXISTS idx_fd_record_current_scope_partition ON flightdeck_pg_record_current
  (workspace_id,family,(COALESCE(context->>'scope_id',CASE WHEN family='scope' THEN id END)),id) INCLUDE(position);


-- Effective read partitions mirror record delivery. These are catchup candidates,
-- never authorization proofs: the delivery path still checks every entry.
CREATE OR REPLACE FUNCTION flightdeck_pg_record_access(w UUID, a UUID) RETURNS JSONB
LANGUAGE sql STABLE AS $$
 WITH RECURSIVE groups(id) AS (
   SELECT group_id FROM flightdeck_pg_group_memberships WHERE workspace_id=w AND actor_id=a
   UNION SELECT e.parent_group_id FROM flightdeck_pg_group_edges e JOIN groups g ON g.id=e.child_group_id WHERE e.workspace_id=w
 ), grants AS (
   SELECT g.* FROM flightdeck_pg_permission_grants g
   WHERE g.workspace_id=w AND g.revoked_at IS NULL
   AND EXISTS(SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=w AND actor_id=a)
   AND ((g.principal_type='actor' AND g.principal_actor_id=a) OR (g.principal_type='group' AND g.principal_group_id IN(SELECT id FROM groups)))
 ), channels AS (
   SELECT DISTINCT c.id,c.scope_id,g.permission FROM grants g
   JOIN flightdeck_pg_channels c ON c.workspace_id=w AND c.id=g.resource_channel_id AND c.archived_at IS NULL
   JOIN flightdeck_pg_scopes s ON s.workspace_id=w AND s.id=c.scope_id AND s.archived_at IS NULL
   WHERE g.resource_type='channel'
 ), scopes AS (
   SELECT s.id FROM grants g JOIN flightdeck_pg_scopes s ON s.workspace_id=w AND s.id=g.resource_scope_id AND s.archived_at IS NULL
   WHERE g.resource_type='scope' AND g.permission IN('scope.read','scope.manage','context.edit')
   UNION SELECT scope_id FROM channels WHERE permission='channel.read'
 ), keys AS (
   SELECT 'channel:'||id::text||':'||f AS key FROM channels
   CROSS JOIN LATERAL unnest(CASE permission
     WHEN 'channel.read' THEN ARRAY['channel','thread','message','doc','doc_comment','file','file_folder','audio_note','resource_view_state/thread','resource_view_state/document']
     WHEN 'task.read' THEN ARRAY['task','task_comment','task_assignment','resource_view_state/task']
     WHEN 'doc.read' THEN ARRAY['doc','doc_comment','resource_view_state/document']
     WHEN 'file.read' THEN ARRAY['file']
     WHEN 'audio_note.read' THEN ARRAY['audio_note'] ELSE ARRAY[]::text[] END) f
   UNION SELECT 'scope:'||id::text||':'||f FROM scopes CROSS JOIN unnest(ARRAY['scope','context_component','context_reference']) f
   UNION SELECT 'workspace:'||w::text||':'||f FROM grants CROSS JOIN unnest(ARRAY['autopilot_connection','workspace_agent']) f
     WHERE resource_type='workspace' AND permission='workspace.read'
 ) SELECT COALESCE(jsonb_agg(key ORDER BY key),'[]'::jsonb) FROM keys
$$;

-- Existing record writers now retain the canonical row's journal position.
CREATE OR REPLACE FUNCTION flightdeck_pg_record_emit(w UUID, f TEXT, r JSONB, op TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$ DECLARE p BIGINT; ident TEXT; BEGIN
 IF NOT EXISTS(SELECT 1 FROM flightdeck_pg_workspaces WHERE id=w) THEN RETURN; END IF;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 UPDATE flightdeck_pg_record_clock SET position=position+1 WHERE workspace_id=w RETURNING position INTO p;
 ident:=flightdeck_pg_record_identity(f,r);
 INSERT INTO flightdeck_pg_record_journal(workspace_id,position,family,id,operation,row) VALUES(w,p,f,ident,op,r);
 IF op='delete' THEN DELETE FROM flightdeck_pg_record_current WHERE workspace_id=w AND family=f AND id=ident;
 ELSE INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row,position) VALUES(w,f,ident,r,p)
 ON CONFLICT(workspace_id,family,id) DO UPDATE SET row=EXCLUDED.row,position=EXCLUDED.position; END IF;
END $$;

CREATE OR REPLACE FUNCTION flightdeck_pg_record_capture() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ DECLARE r JSONB; oldr JSONB; w UUID; child RECORD; table_name TEXT; kind TEXT; BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 w := (r->>'workspace_id')::uuid;
 IF TG_OP='UPDATE' THEN
 oldr:=to_jsonb(OLD);
 IF (oldr->>'channel_id') IS DISTINCT FROM (r->>'channel_id') OR (oldr->>'owner_actor_id') IS DISTINCT FROM (r->>'owner_actor_id') OR flightdeck_pg_record_identity(TG_ARGV[0],oldr) IS DISTINCT FROM flightdeck_pg_record_identity(TG_ARGV[0],r) THEN
 PERFORM flightdeck_pg_record_emit((oldr->>'workspace_id')::uuid,TG_ARGV[0],oldr,'delete');
 END IF; END IF;
 PERFORM flightdeck_pg_record_emit(w,TG_ARGV[0],r,CASE WHEN TG_OP='DELETE' OR r->>'deleted_at' IS NOT NULL OR r->>'archived_at' IS NOT NULL THEN 'delete' ELSE 'upsert' END);
 IF TG_ARGV[0] IN ('task','doc','thread') AND (TG_OP='DELETE' OR r->>'deleted_at' IS NOT NULL) THEN
 -- Real content deletion emits explicit dependent tombstones. Permission
 -- filtering never invokes this path and never manufactures deletion records.
 FOR child IN SELECT family,row FROM flightdeck_pg_record_current c WHERE c.workspace_id=w AND (
   (TG_ARGV[0]='task' AND c.family IN('task_comment','task_assignment') AND c.context->>'task_id'=r->>'id') OR
   (TG_ARGV[0]='doc' AND c.family='doc_comment' AND c.context->>'doc_id'=r->>'id') OR
   (TG_ARGV[0]='thread' AND c.family='message' AND c.context->>'thread_id'=r->>'id') OR
   (c.family='resource_view_state' AND c.context->>'resource_id'=r->>'id'
     AND c.context->>'resource_type'=CASE TG_ARGV[0] WHEN 'doc' THEN 'document' ELSE TG_ARGV[0] END))
 ORDER BY family,id LOOP
   PERFORM flightdeck_pg_record_emit(w,child.family,child.row,'delete');
 END LOOP;
 END IF;
 -- A genuine parent restoration must also restore its surviving dependents.
 IF TG_OP='UPDATE' AND TG_ARGV[0] IN('task','doc','thread') AND oldr->>'deleted_at' IS NOT NULL AND r->>'deleted_at' IS NULL THEN
   FOR kind,table_name IN SELECT * FROM (VALUES
     ('task_comment','flightdeck_pg_task_comments'),('task_assignment','flightdeck_pg_task_assignments'),
     ('doc_comment','flightdeck_pg_doc_comments'),('message','flightdeck_pg_messages'),
     ('resource_view_state','flightdeck_pg_resource_view_states')) AS families(f,t)
   WHERE (TG_ARGV[0]='task' AND f IN('task_comment','task_assignment')) OR (TG_ARGV[0]='doc' AND f='doc_comment')
     OR (TG_ARGV[0]='thread' AND f='message') OR f='resource_view_state'
   LOOP
     IF kind='resource_view_state' THEN
       FOR child IN EXECUTE format('SELECT to_jsonb(t) AS row FROM %I t WHERE workspace_id=$1 AND resource_id=$2::uuid AND resource_type=$3',table_name)
         USING w,r->>'id',CASE TG_ARGV[0] WHEN 'doc' THEN 'document' ELSE TG_ARGV[0] END LOOP
         PERFORM flightdeck_pg_record_emit(w,kind,child.row,'upsert');
       END LOOP;
     ELSE
       FOR child IN EXECUTE format('SELECT to_jsonb(t) AS row FROM %I t WHERE workspace_id=$1 AND %I=$2::uuid AND to_jsonb(t)->>''deleted_at'' IS NULL',
         table_name,CASE TG_ARGV[0] WHEN 'task' THEN 'task_id' WHEN 'doc' THEN 'doc_id' ELSE 'thread_id' END) USING w,r->>'id' LOOP
         PERFORM flightdeck_pg_record_emit(w,kind,child.row,'upsert');
       END LOOP;
     END IF;
   END LOOP;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

-- Replaces the installed function used by ALL authority triggers, including grants.
-- Clock updates force stale repeatable-read delivery to retry; no authority reset.
CREATE OR REPLACE FUNCTION flightdeck_pg_record_reset() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ DECLARE r JSONB; w UUID; BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN RETURN NEW; END IF;
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='flightdeck_pg_actors' THEN
   IF TG_OP='UPDATE' AND OLD.npub=NEW.npub AND OLD.kind=NEW.kind THEN RETURN NEW; END IF;
   -- Identity rebinding is a genuine boundary, never a permission transition.
   UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid(),access_revision=access_revision+1 WHERE workspace_id IN
     (SELECT workspace_id FROM flightdeck_pg_workspace_memberships WHERE actor_id=(r->>'id')::uuid);
 ELSE
   w:=COALESCE(r->>'workspace_id',r->>'id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM flightdeck_pg_workspaces WHERE id=w) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
   INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
   IF TG_TABLE_NAME='flightdeck_pg_workspaces' AND TG_OP='UPDATE' AND
     (to_jsonb(OLD)->'workspace_owner_npub',to_jsonb(OLD)->'app_npub',to_jsonb(OLD)->'workspace_service_npub',to_jsonb(OLD)->'tower_service_npub')
       IS DISTINCT FROM (r->'workspace_owner_npub',r->'app_npub',r->'workspace_service_npub',r->'tower_service_npub') THEN
     UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid(),access_revision=access_revision+1 WHERE workspace_id=w;
   ELSE UPDATE flightdeck_pg_record_clock SET access_revision=access_revision+1 WHERE workspace_id=w; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

-- Seed pre-extension continuations exactly once. Lock authority AND clock tables
-- before baselining, so a concurrent grant cannot fall between old/new contracts.
DO $$ BEGIN
 LOCK TABLE flightdeck_pg_permission_grants,flightdeck_pg_group_memberships,flightdeck_pg_group_edges,
   flightdeck_pg_workspace_memberships,flightdeck_pg_actors,flightdeck_pg_scopes,flightdeck_pg_channels,
   flightdeck_pg_workspaces IN SHARE ROW EXCLUSIVE MODE;
 LOCK TABLE flightdeck_pg_record_clock IN SHARE ROW EXCLUSIVE MODE;
 UPDATE flightdeck_pg_record_current c SET position=COALESCE((
   SELECT max(j.position) FROM flightdeck_pg_record_journal j
   WHERE j.workspace_id=c.workspace_id AND j.family=c.family AND j.id=c.id
 ),0) WHERE c.position=0;
 UPDATE flightdeck_pg_record_cursors c SET state=state||jsonb_build_object(
   'access',flightdeck_pg_record_access(c.workspace_id,c.actor_id),'accessRevision',k.access_revision::text,'progress','0')
 FROM flightdeck_pg_record_clock k WHERE k.workspace_id=c.workspace_id AND NOT c.state ? 'access';
 IF to_regclass('flightdeck_pg_record_clients') IS NOT NULL THEN
 UPDATE flightdeck_pg_record_clients c SET initial_state=initial_state||jsonb_build_object(
   'access',flightdeck_pg_record_access(c.workspace_id,c.actor_id),'accessRevision',k.access_revision::text,'progress','0'),
   checkpoint_state=CASE WHEN checkpoint_state IS NULL THEN NULL ELSE checkpoint_state||jsonb_build_object(
     'access',flightdeck_pg_record_access(c.workspace_id,c.actor_id),'accessRevision',k.access_revision::text,'progress','0') END
 FROM flightdeck_pg_record_clock k WHERE k.workspace_id=c.workspace_id AND NOT c.initial_state ? 'access';
 END IF;
 IF to_regclass('flightdeck_pg_record_page_tokens') IS NOT NULL THEN
 UPDATE flightdeck_pg_record_page_tokens c SET state=state||jsonb_build_object(
   'access',flightdeck_pg_record_access(c.workspace_id,c.actor_id),'accessRevision',k.access_revision::text,'progress','0')
 FROM flightdeck_pg_record_clock k WHERE k.workspace_id=c.workspace_id AND NOT c.state ? 'access';
 END IF;
END $$;

-- end_additive_record_access_v1
