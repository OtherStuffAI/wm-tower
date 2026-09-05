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
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

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
  ('workspace.read', 'workspace', 'Read workspace metadata and current actor membership'),
  ('workspace.manage', 'workspace', 'Manage workspace settings and administrative access'),
  ('workspace.invite', 'workspace', 'Invite actors into a workspace'),
  ('event_subscription.manage', 'workspace', 'Manage a delegated multi-identity workspace event subscription'),
  ('scope.read', 'scope', 'Read accessible scopes'),
  ('scope.create', 'workspace', 'Create scopes inside a workspace'),
  ('scope.manage', 'scope', 'Manage scope metadata and access'),
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
  CHECK (entity_type IN ('task', 'document')),
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
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, activity_id),
  CONSTRAINT flightdeck_pg_agent_activities_state_check
    CHECK (state IN ('accepted', 'working', 'waiting', 'completed', 'failed', 'cancelled')),
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
CREATE INDEX IF NOT EXISTS idx_fd_pg_agent_activities_expiry
  ON flightdeck_pg_agent_activities(workspace_id, expires_at);

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

-- flightdeck_record_delta_v1
CREATE OR REPLACE FUNCTION flightdeck_pg_record_context(r JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('scope_id',r->'scope_id','channel_id',r->'channel_id',
 'owner_actor_id',r->'owner_actor_id','viewer_actor_id',r->'viewer_actor_id',
 'resource_type',r->'resource_type','resource_id',r->'resource_id',
 'task_id',r->'task_id','doc_id',r->'doc_id','thread_id',r->'thread_id')
$$;
CREATE TABLE IF NOT EXISTS flightdeck_pg_record_clock (
 workspace_id UUID PRIMARY KEY REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 position BIGINT NOT NULL DEFAULT 0, epoch UUID NOT NULL DEFAULT gen_random_uuid()
);
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
CREATE INDEX IF NOT EXISTS idx_fd_record_cursor_expiry ON flightdeck_pg_record_cursors(created_at,token);
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
LANGUAGE plpgsql AS $$ DECLARE r JSONB; oldr JSONB; w UUID; BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 w := (r->>'workspace_id')::uuid;
 IF TG_OP='UPDATE' THEN
 oldr:=to_jsonb(OLD);
 IF (oldr->>'channel_id') IS DISTINCT FROM (r->>'channel_id') OR (oldr->>'owner_actor_id') IS DISTINCT FROM (r->>'owner_actor_id') OR flightdeck_pg_record_identity(TG_ARGV[0],oldr) IS DISTINCT FROM flightdeck_pg_record_identity(TG_ARGV[0],r) THEN
 PERFORM flightdeck_pg_record_emit((oldr->>'workspace_id')::uuid,TG_ARGV[0],oldr,'delete');
 END IF; END IF;
 PERFORM flightdeck_pg_record_emit(w,TG_ARGV[0],r,CASE WHEN TG_OP='DELETE' OR r->>'deleted_at' IS NOT NULL THEN 'delete' ELSE 'upsert' END);
 IF TG_ARGV[0] IN ('task','doc','thread') AND (TG_OP='DELETE' OR r->>'deleted_at' IS NOT NULL) THEN
 UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid() WHERE workspace_id=w;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE OR REPLACE FUNCTION flightdeck_pg_record_reset() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ DECLARE r JSONB; w UUID; BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('flightdeck_pg_scopes','flightdeck_pg_channels')
 AND (to_jsonb(OLD)->'archived_at') IS NOT DISTINCT FROM (r->'archived_at')
 AND (to_jsonb(OLD)->'scope_id') IS NOT DISTINCT FROM (r->'scope_id')
 AND (to_jsonb(OLD)->'owner_actor_id') IS NOT DISTINCT FROM (r->'owner_actor_id')
 AND (to_jsonb(OLD)->'owner_group_id') IS NOT DISTINCT FROM (r->'owner_group_id')
 AND (to_jsonb(OLD)->'participant_npubs') IS NOT DISTINCT FROM (r->'participant_npubs')
 THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='flightdeck_pg_actors' AND TG_OP='UPDATE'
 AND (to_jsonb(OLD)->'npub') IS NOT DISTINCT FROM (r->'npub')
 AND (to_jsonb(OLD)->'kind') IS NOT DISTINCT FROM (r->'kind') THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='flightdeck_pg_workspaces' AND TG_OP='UPDATE'
 AND (to_jsonb(OLD)->'workspace_owner_npub') IS NOT DISTINCT FROM (r->'workspace_owner_npub')
 AND (to_jsonb(OLD)->'app_npub') IS NOT DISTINCT FROM (r->'app_npub')
 AND (to_jsonb(OLD)->'workspace_service_npub') IS NOT DISTINCT FROM (r->'workspace_service_npub')
 AND (to_jsonb(OLD)->'tower_service_npub') IS NOT DISTINCT FROM (r->'tower_service_npub') THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='flightdeck_pg_actors' THEN
 UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid() WHERE workspace_id IN
 (SELECT workspace_id FROM flightdeck_pg_workspace_memberships WHERE actor_id=(r->>'id')::uuid);
 ELSE
 w:=COALESCE(r->>'workspace_id',r->>'id')::uuid;
 IF NOT EXISTS (SELECT 1 FROM flightdeck_pg_workspaces WHERE id=w) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid() WHERE workspace_id=w;
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
