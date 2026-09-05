import { getDb } from '../db';
import { readFileSync } from 'node:fs';

type DbClient = ReturnType<typeof getDb>;

function wappActivityPublishingV1Sql(): string {
  const migration = readFileSync(new URL('./001_init.sql', import.meta.url), 'utf8');
  const startMarker = '-- wapp_activity_publishing_v1';
  const endMarker = '-- end_wapp_activity_publishing_v1';
  const start = migration.indexOf(startMarker);
  const end = migration.indexOf(endMarker);
  if (start < 0 || end <= start) throw new Error('wapp_activity_publishing_v1 schema block is missing');
  return migration.slice(start + startMarker.length, end);
}

function gitAuthorityV1Sql(): string {
  const migration = readFileSync(new URL('./001_init.sql', import.meta.url), 'utf8');
  const startMarker = '-- git_authority_v1';
  const endMarker = '-- end_git_authority_v1';
  const start = migration.indexOf(startMarker);
  const end = migration.indexOf(endMarker);
  if (start < 0 || end <= start) throw new Error('git_authority_v1 schema block is missing');
  return migration.slice(start + startMarker.length, end);
}

export async function ensureRuntimeSchema(sql: DbClient = getDb()) {

  await sql.unsafe(`
    ALTER TABLE v4_groups
    ADD COLUMN IF NOT EXISTS group_npub TEXT
  `);

  await sql.unsafe(`
    ALTER TABLE v4_groups
    ADD COLUMN IF NOT EXISTS group_kind TEXT NOT NULL DEFAULT 'shared'
  `);

  await sql.unsafe(`
    ALTER TABLE v4_groups
    ADD COLUMN IF NOT EXISTS private_member_npub TEXT
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_groups_private_member
    ON v4_groups(private_member_npub)
  `);

  await sql.unsafe(`
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await sql.unsafe(`
    ALTER TABLE v4_workspaces
    ADD COLUMN IF NOT EXISTS avatar_url TEXT
  `);

  await sql.unsafe(`
    ALTER TABLE v4_workspaces
    ADD COLUMN IF NOT EXISTS slug TEXT NOT NULL DEFAULT ''
  `);

  await sql.unsafe(`
    ALTER TABLE v4_workspaces
    ADD COLUMN IF NOT EXISTS admin_group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_workspaces_creator
    ON v4_workspaces(creator_npub)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_credit_transactions_workspace_created
    ON workspace_credit_transactions(workspace_owner_npub, created_at DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_credit_orders_workspace_created
    ON workspace_credit_orders(workspace_owner_npub, created_at DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_usage_hourly_audits_workspace_hour
    ON workspace_usage_hourly_audits(workspace_owner_npub, hour_start DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  // App database namespaces are shared by legacy v4 workspaces and PG-native
  // Flight Deck workspaces. Authorization resolves the workspace owner before
  // registration, so workspace_apps must not be constrained to v4_workspaces.
  await sql.unsafe(`
    ALTER TABLE workspace_apps
    DROP CONSTRAINT IF EXISTS workspace_apps_workspace_owner_npub_fkey
  `);

  await sql.unsafe(`
    ALTER TABLE workspace_apps
    ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true
  `);

  await sql.unsafe(`
    ALTER TABLE workspace_apps
    ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb
  `);

  await sql.unsafe(`
    ALTER TABLE workspace_apps
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_apps_workspace
    ON workspace_apps(workspace_owner_npub, created_at DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_app_schema_manifests_workspace
    ON workspace_app_schema_manifests(workspace_owner_npub, app_npub, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_app_schema_group_payloads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      manifest_id UUID NOT NULL REFERENCES workspace_app_schema_manifests(id) ON DELETE CASCADE,
      group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL,
      group_epoch INTEGER,
      group_npub TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      can_write BOOLEAN NOT NULL DEFAULT false
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_app_schema_payloads_manifest
    ON workspace_app_schema_group_payloads(manifest_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_app_schema_payloads_group
    ON workspace_app_schema_group_payloads(group_id, group_epoch)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_app_rows_scope
    ON workspace_app_rows(workspace_owner_npub, app_npub, collection, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_app_rows_owner
    ON workspace_app_rows(workspace_owner_npub, app_npub, owner_npub)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_app_rows_group
    ON workspace_app_rows(group_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_app_rows_data
    ON workspace_app_rows USING GIN (data)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_workspace_app_db_namespaces_workspace
    ON workspace_app_db_namespaces(workspace_owner_npub, created_at DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_gmk_group ON v4_group_member_keys(group_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_gmk_member ON v4_group_member_keys(member_npub)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS v4_group_epochs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES v4_groups(id) ON DELETE CASCADE,
      epoch INTEGER NOT NULL,
      group_npub TEXT NOT NULL UNIQUE,
      created_by_npub TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      superseded_at TIMESTAMPTZ,
      UNIQUE(group_id, epoch)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_group_epochs_group
    ON v4_group_epochs(group_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_group_epochs_npub
    ON v4_group_epochs(group_npub)
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v4_groups_group_npub
    ON v4_groups(group_npub)
    WHERE group_npub IS NOT NULL
  `);

  await sql.unsafe(`
    INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub, created_at)
    SELECT g.id, 1, g.group_npub, g.owner_npub, g.created_at
    FROM v4_groups g
    WHERE g.group_npub IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM v4_group_epochs ge
        WHERE ge.group_id = g.id
          AND ge.epoch = 1
      )
  `);

  await sql.unsafe(`
    ALTER TABLE v4_record_group_payloads
    ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL
  `);

  await sql.unsafe(`
    ALTER TABLE v4_record_group_payloads
    ADD COLUMN IF NOT EXISTS group_epoch INTEGER
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_rgp_group_id_epoch
    ON v4_record_group_payloads(group_id, group_epoch)
  `);

  await sql.unsafe(`
    UPDATE v4_record_group_payloads rgp
    SET group_id = g.id,
        group_epoch = COALESCE(rgp.group_epoch, 1)
    FROM v4_groups g
    WHERE rgp.group_id IS NULL
      AND rgp.group_npub = g.group_npub
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE v4_record_checkouts
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_record_checkouts_record
    ON v4_record_checkouts(workspace_service_npub, record_id, checked_out_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_record_checkouts_holder
    ON v4_record_checkouts(checked_out_by_user_npub, checked_out_at DESC)
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v4_record_checkouts_idempotency
    ON v4_record_checkouts(workspace_service_npub, record_id, checked_out_by_user_npub, idempotency_key)
    WHERE state = 'checked_out' AND idempotency_key IS NOT NULL
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v4_record_checkouts_active
    ON v4_record_checkouts(workspace_service_npub, record_id)
    WHERE state = 'checked_out'
  `);

  await sql.unsafe(`
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_storage_owner ON v4_storage_objects(owner_npub)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_storage_creator ON v4_storage_objects(created_by_npub)
  `);

  // Migration: add new storage columns for existing tables
  await sql.unsafe(`
    ALTER TABLE v4_storage_objects
    ADD COLUMN IF NOT EXISTS owner_group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL
  `);

  await sql.unsafe(`
    ALTER TABLE v4_storage_objects
    ADD COLUMN IF NOT EXISTS access_group_ids UUID[] NOT NULL DEFAULT '{}'
  `);

  await sql.unsafe(`
    ALTER TABLE v4_storage_objects
    ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_v4_storage_group ON v4_storage_objects(owner_group_id)
  `);

  const legacyStorageAccessColumns = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'v4_storage_objects'
        AND column_name = 'access_group_npubs'
    ) AS exists
  `;

  // Backfill: resolve access_group_npubs -> access_group_ids via v4_group_epochs.
  if (legacyStorageAccessColumns[0]?.exists) {
    await sql.unsafe(`
      UPDATE v4_storage_objects so
      SET access_group_ids = COALESCE((
        SELECT array_agg(DISTINCT ge.group_id)
        FROM unnest(so.access_group_npubs) AS npub
        JOIN v4_group_epochs ge ON ge.group_npub = npub
      ), '{}')
      WHERE so.access_group_ids = '{}'
        AND so.access_group_npubs != '{}'
    `);
  }

  // User profiles table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_npub        TEXT PRIMARY KEY,
      display_name     TEXT,
      avatar_url       TEXT,
      credit_balance   INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // User workspace keys table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS user_workspace_keys (
      user_npub            TEXT NOT NULL REFERENCES user_profiles(user_npub),
      workspace_owner_npub TEXT NOT NULL,
      ws_key_npub          TEXT NOT NULL,
      ws_key_epoch         INTEGER NOT NULL DEFAULT 1,
      active               BOOLEAN NOT NULL DEFAULT true,
      registered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (workspace_owner_npub, ws_key_npub)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_uwk_user ON user_workspace_keys(user_npub)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_uwk_wskey ON user_workspace_keys(ws_key_npub)
  `);

  await sql.unsafe(`
    ALTER TABLE user_workspace_keys
    ADD COLUMN IF NOT EXISTS device_label TEXT
  `);

  await sql.unsafe(`
    ALTER TABLE user_workspace_keys
    ADD COLUMN IF NOT EXISTS device_platform TEXT
  `);

  await sql.unsafe(`
    ALTER TABLE user_workspace_keys
    ADD COLUMN IF NOT EXISTS device_policy JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await sql.unsafe(`
    ALTER TABLE user_workspace_keys
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ
  `);

  await sql.unsafe(`
    ALTER TABLE user_workspace_keys
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS flightdeck_pg_actors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      npub TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (kind IN ('human', 'agent', 'app', 'service'))
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS flightdeck_pg_actor_identity_history (
      actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
      npub TEXT NOT NULL,
      valid_from TIMESTAMPTZ NOT NULL,
      valid_until TIMESTAMPTZ NOT NULL,
      rotation_id TEXT NOT NULL,
      proof_event_id TEXT NOT NULL,
      PRIMARY KEY (actor_id, npub),
      UNIQUE (rotation_id),
      UNIQUE (proof_event_id),
      CHECK (char_length(rotation_id) BETWEEN 1 AND 128),
      CHECK (valid_until >= valid_from)
    )
  `);

  // Safe, idempotent name backfill. Actor rows are canonical. A non-empty
  // legacy user profile may replace only a missing/setup placeholder actor
  // name; trustworthy actor names then mirror to an existing user profile.
  await sql.unsafe(`
    UPDATE flightdeck_pg_actors a
    SET display_name = trim(p.display_name), updated_at = NOW()
    FROM user_profiles p
    WHERE p.user_npub = a.npub
      AND NULLIF(trim(p.display_name), '') IS NOT NULL
      AND trim(p.display_name) NOT IN ('Flight Deck PG Creator', 'Flight Deck PG Workspace Owner', 'Flight Deck PG Smoke Viewer', 'Flight Deck PG Collaborator')
      AND (a.display_name IS NULL OR trim(a.display_name) IN ('Flight Deck PG Creator', 'Flight Deck PG Workspace Owner', 'Flight Deck PG Smoke Viewer', 'Flight Deck PG Collaborator'))
  `);
  await sql.unsafe(`
    UPDATE user_profiles p
    SET display_name = trim(a.display_name)
    FROM flightdeck_pg_actors a
    WHERE p.user_npub = a.npub
      AND NULLIF(trim(a.display_name), '') IS NOT NULL
      AND trim(a.display_name) NOT IN ('Flight Deck PG Creator', 'Flight Deck PG Workspace Owner', 'Flight Deck PG Smoke Viewer', 'Flight Deck PG Collaborator')
      AND p.display_name IS DISTINCT FROM trim(a.display_name)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS flightdeck_pg_actor_identity_rotations (
      rotation_id TEXT PRIMARY KEY,
      actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE RESTRICT,
      context_workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE RESTRICT,
      old_npub TEXT NOT NULL,
      new_npub TEXT NOT NULL,
      requester_npub TEXT NOT NULL,
      proof_event_id TEXT NOT NULL UNIQUE,
      proof_created_at TIMESTAMPTZ NOT NULL,
      proof_expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      result TEXT NOT NULL DEFAULT 'completed',
      migration_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
      CHECK (result = 'completed'), CHECK (old_npub <> new_npub),
      CHECK (char_length(rotation_id) BETWEEN 1 AND 128),
      CHECK (jsonb_typeof(migration_counts) = 'object'), CHECK (jsonb_typeof(warnings) = 'array')
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_workspaces
    ADD COLUMN IF NOT EXISTS slug TEXT NOT NULL DEFAULT ''
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_workspaces
    ADD COLUMN IF NOT EXISTS avatar_url TEXT
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workspaces_service
    ON flightdeck_pg_workspaces(workspace_service_npub)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workspaces_owner
    ON flightdeck_pg_workspaces(workspace_owner_npub)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workspaces_v4
    ON flightdeck_pg_workspaces(v4_workspace_id)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS flightdeck_pg_workspace_memberships (
      workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
      actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (workspace_id, actor_id),
      CHECK (role IN ('owner', 'admin', 'member', 'guest', 'agent', 'app'))
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workspace_memberships_actor
    ON flightdeck_pg_workspace_memberships(actor_id)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_workspaces
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'flightdeck_pg_group_memberships_workspace_actor_membership_fkey'
          AND conrelid = 'flightdeck_pg_group_memberships'::regclass
      ) THEN
        ALTER TABLE flightdeck_pg_group_memberships
          ADD CONSTRAINT flightdeck_pg_group_memberships_workspace_actor_membership_fkey
          FOREIGN KEY (workspace_id, actor_id)
          REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
          ON DELETE CASCADE;
      END IF;
    END
    $$;
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_group_memberships_actor
    ON flightdeck_pg_group_memberships(actor_id)
  `);

  await sql.unsafe(`
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
  `);

  await sql.unsafe(`
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
  `);

  await sql.unsafe(`
    DROP TRIGGER IF EXISTS trg_flightdeck_pg_default_groups ON flightdeck_pg_workspaces;
    CREATE TRIGGER trg_flightdeck_pg_default_groups
    AFTER INSERT ON flightdeck_pg_workspaces
    FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_ensure_default_groups();
  `);

  await sql.unsafe(`
    DROP TRIGGER IF EXISTS trg_flightdeck_pg_workspace_group_membership ON flightdeck_pg_workspace_memberships;
    CREATE TRIGGER trg_flightdeck_pg_workspace_group_membership
    AFTER INSERT OR UPDATE OF actor_id ON flightdeck_pg_workspace_memberships
    FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_ensure_workspace_group_membership();
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
    SELECT w.id, group_name, 'system', w.created_by_actor_id
    FROM flightdeck_pg_workspaces w
    CROSS JOIN (VALUES ('Admins'), ('Agents'), ('People'), ('Workspace')) AS default_groups(group_name)
    ON CONFLICT (workspace_id, name) DO NOTHING
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    SELECT m.workspace_id, g.id, m.actor_id, m.created_by_actor_id
    FROM flightdeck_pg_workspace_memberships m
    JOIN flightdeck_pg_groups g
      ON g.workspace_id = m.workspace_id
     AND g.name = 'Workspace'
    ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_group_edges_child
    ON flightdeck_pg_group_edges(workspace_id, child_group_id)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS flightdeck_pg_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL,
      scope_id UUID NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      kind TEXT NOT NULL DEFAULT 'channel',
      position INTEGER,
      created_by_actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ,
      UNIQUE (scope_id, name),
      UNIQUE (workspace_id, id),
      UNIQUE (workspace_id, scope_id, id),
      CHECK (kind IN ('channel', 'dm', 'system')),
      FOREIGN KEY (workspace_id, scope_id)
        REFERENCES flightdeck_pg_scopes(workspace_id, id)
        ON DELETE CASCADE
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_channels
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_channels
    ADD COLUMN IF NOT EXISTS position INTEGER
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'flightdeck_pg_channels_position_check'
          AND conrelid = 'flightdeck_pg_channels'::regclass
      ) THEN
        ALTER TABLE flightdeck_pg_channels
          ADD CONSTRAINT flightdeck_pg_channels_position_check
          CHECK (position IS NULL OR position >= 1);
      END IF;
    END
    $$;
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'flightdeck_pg_channels_workspace_id_scope_id_id_key'
          AND conrelid = 'flightdeck_pg_channels'::regclass
      ) THEN
        ALTER TABLE flightdeck_pg_channels
          ADD CONSTRAINT flightdeck_pg_channels_workspace_id_scope_id_id_key
          UNIQUE (workspace_id, scope_id, id);
      END IF;
    END
    $$;
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_channels_scope_position
    ON flightdeck_pg_channels(workspace_id, scope_id, position ASC NULLS LAST, created_at ASC, id ASC)
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_channels_workspace_scope_id_unique
    ON flightdeck_pg_channels(workspace_id, scope_id, id)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS flightdeck_pg_permission_definitions (
      permission TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fdpg_perm_defs_permission_resource_type_key UNIQUE (permission, resource_type),
      CHECK (resource_type IN ('workspace', 'scope', 'channel', 'thread', 'task', 'doc', 'file', 'daily_note', 'approval', 'app'))
    )
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      ALTER TABLE flightdeck_pg_permission_definitions
        DROP CONSTRAINT IF EXISTS flightdeck_pg_permission_definitions_resource_type_check;
      ALTER TABLE flightdeck_pg_permission_definitions
        ADD CONSTRAINT flightdeck_pg_permission_definitions_resource_type_check
        CHECK (resource_type IN ('workspace', 'scope', 'channel', 'thread', 'task', 'doc', 'file', 'daily_note', 'approval', 'app'));
    END
    $$;
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fdpg_perm_defs_permission_resource_type_key'
          AND conrelid = 'flightdeck_pg_permission_definitions'::regclass
      ) THEN
        ALTER TABLE flightdeck_pg_permission_definitions
          ADD CONSTRAINT fdpg_perm_defs_permission_resource_type_key
          UNIQUE (permission, resource_type);
      END IF;
    END
    $$;
  `);

  await sql.unsafe(`
    DELETE FROM flightdeck_pg_permission_grants
    WHERE resource_type <> 'workspace'
      AND permission IN ('daily_note.read', 'daily_note.write')
  `);

  await sql.unsafe(`
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
      description = EXCLUDED.description
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_permission_grants
    DROP CONSTRAINT IF EXISTS flightdeck_pg_permission_grants_permission_fkey
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'flightdeck_pg_permission_grants_workspace_actor_membership_fkey'
          AND conrelid = 'flightdeck_pg_permission_grants'::regclass
      ) THEN
        ALTER TABLE flightdeck_pg_permission_grants
          ADD CONSTRAINT flightdeck_pg_permission_grants_workspace_actor_membership_fkey
          FOREIGN KEY (workspace_id, principal_actor_id)
          REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
          ON DELETE CASCADE;
      END IF;
    END
    $$;
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'flightdeck_pg_permission_grants_permission_resource_type_fkey'
          AND conrelid = 'flightdeck_pg_permission_grants'::regclass
      ) THEN
        ALTER TABLE flightdeck_pg_permission_grants
          ADD CONSTRAINT flightdeck_pg_permission_grants_permission_resource_type_fkey
          FOREIGN KEY (permission, resource_type)
          REFERENCES flightdeck_pg_permission_definitions(permission, resource_type)
          ON DELETE RESTRICT;
      END IF;
    END
    $$;
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_permission_grants_actor
    ON flightdeck_pg_permission_grants(workspace_id, principal_actor_id)
    WHERE principal_actor_id IS NOT NULL AND revoked_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_permission_grants_group
    ON flightdeck_pg_permission_grants(workspace_id, principal_group_id)
    WHERE principal_group_id IS NOT NULL AND revoked_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_permission_grants_scope
    ON flightdeck_pg_permission_grants(workspace_id, resource_scope_id)
    WHERE resource_scope_id IS NOT NULL AND revoked_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_permission_grants_channel
    ON flightdeck_pg_permission_grants(workspace_id, resource_channel_id)
    WHERE resource_channel_id IS NOT NULL AND revoked_at IS NULL
  `);

  await sql.unsafe(`
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
    WHERE revoked_at IS NULL
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
    SELECT w.id, groups.name, 'system', w.created_by_actor_id
    FROM flightdeck_pg_workspaces w
    CROSS JOIN (
      VALUES
        ('Admins'),
        ('Agents'),
        ('People'),
        ('Workspace')
    ) AS groups(name)
    ON CONFLICT (workspace_id, name) DO NOTHING
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    SELECT m.workspace_id, g.id, m.actor_id, COALESCE(w.created_by_actor_id, m.created_by_actor_id, m.actor_id)
    FROM flightdeck_pg_workspace_memberships m
    JOIN flightdeck_pg_workspaces w ON w.id = m.workspace_id
    JOIN flightdeck_pg_groups g
      ON g.workspace_id = m.workspace_id
      AND g.name = 'Workspace'
    ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    SELECT m.workspace_id, g.id, m.actor_id, COALESCE(w.created_by_actor_id, m.created_by_actor_id, m.actor_id)
    FROM flightdeck_pg_workspace_memberships m
    JOIN flightdeck_pg_workspaces w ON w.id = m.workspace_id
    JOIN flightdeck_pg_groups g
      ON g.workspace_id = m.workspace_id
      AND g.name = 'Admins'
    WHERE m.role IN ('owner', 'admin')
    ON CONFLICT (workspace_id, group_id, actor_id) DO NOTHING
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_scopes (workspace_id, name, description, kind, created_by_actor_id)
    SELECT w.id, 'DMs', 'Direct message conversations', 'dm', w.created_by_actor_id
    FROM flightdeck_pg_workspaces w
    ON CONFLICT (workspace_id, name) DO NOTHING
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_channels
    ADD COLUMN IF NOT EXISTS participant_npubs TEXT[]
  `);

  await sql.unsafe(`
    UPDATE flightdeck_pg_channels c
    SET participant_npubs = participants.npubs
    FROM (
      SELECT
        g.resource_channel_id AS channel_id,
        array_agg(DISTINCT a.npub) AS npubs
      FROM flightdeck_pg_permission_grants g
      JOIN flightdeck_pg_actors a ON a.id = g.principal_actor_id
      WHERE g.principal_type = 'actor'
        AND g.resource_type = 'channel'
        AND g.permission = 'channel.manage'
        AND g.revoked_at IS NULL
      GROUP BY g.resource_channel_id
    ) participants
    WHERE c.id = participants.channel_id
      AND c.kind = 'dm'
      AND c.participant_npubs IS NULL
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_group_id,
      resource_type,
      resource_scope_id,
      permission,
      created_by_actor_id
    )
    SELECT
      s.workspace_id,
      'group',
      g.id,
      'scope',
      s.id,
      'channel.create',
      COALESCE(w.created_by_actor_id, s.created_by_actor_id)
    FROM flightdeck_pg_scopes s
    JOIN flightdeck_pg_workspaces w ON w.id = s.workspace_id
    JOIN flightdeck_pg_groups g
      ON g.workspace_id = s.workspace_id
      AND g.name = 'Admins'
    ON CONFLICT (
      workspace_id,
      principal_type,
      COALESCE(principal_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
      resource_type,
      COALESCE(resource_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(resource_channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
      permission
    )
    WHERE revoked_at IS NULL
    DO NOTHING
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_group_id,
      resource_type,
      permission,
      created_by_actor_id
    )
    SELECT
      g.workspace_id,
      'group',
      g.id,
      'workspace',
      perms.permission,
      COALESCE(w.created_by_actor_id, g.created_by_actor_id)
    FROM flightdeck_pg_groups g
    JOIN flightdeck_pg_workspaces w ON w.id = g.workspace_id
    CROSS JOIN LATERAL (
      VALUES
        ('Admins', 'workspace.read'),
        ('Admins', 'workspace.manage'),
        ('Admins', 'workspace.invite'),
        ('Admins', 'event_subscription.manage'),
        ('Admins', 'scope.create'),
        ('Agents', 'workspace.read'),
        ('People', 'workspace.read'),
        ('Workspace', 'workspace.read')
    ) AS perms(group_name, permission)
    WHERE g.name = perms.group_name
    ON CONFLICT (
      workspace_id,
      principal_type,
      COALESCE(principal_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
      resource_type,
      COALESCE(resource_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(resource_channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
      permission
    )
    WHERE revoked_at IS NULL
    DO NOTHING
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_group_id,
      resource_type,
      resource_scope_id,
      permission,
      created_by_actor_id
    )
    SELECT
      s.workspace_id,
      'group',
      g.id,
      'scope',
      s.id,
      'scope.read',
      COALESCE(w.created_by_actor_id, s.created_by_actor_id)
    FROM flightdeck_pg_scopes s
    JOIN flightdeck_pg_workspaces w ON w.id = s.workspace_id
    JOIN flightdeck_pg_groups g
      ON g.workspace_id = s.workspace_id
      AND g.name = 'Workspace'
    WHERE s.kind = 'dm'
      AND s.name = 'DMs'
    ON CONFLICT (
      workspace_id,
      principal_type,
      COALESCE(principal_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
      resource_type,
      COALESCE(resource_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(resource_channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
      permission
    )
    WHERE revoked_at IS NULL
    DO NOTHING
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_actor_id,
      resource_type,
      resource_channel_id,
      permission,
      created_by_actor_id
    )
    SELECT
      participants.workspace_id,
      'actor',
      participants.actor_id,
      'channel',
      participants.channel_id,
      perms.permission,
      participants.created_by_actor_id
    FROM (
      SELECT DISTINCT c.workspace_id, c.id AS channel_id, c.created_by_actor_id AS actor_id, c.created_by_actor_id
      FROM flightdeck_pg_channels c
      JOIN flightdeck_pg_workspace_memberships wm
        ON wm.workspace_id = c.workspace_id
        AND wm.actor_id = c.created_by_actor_id
      WHERE c.kind = 'dm'
        AND c.created_by_actor_id IS NOT NULL
        AND c.archived_at IS NULL
      UNION
      SELECT DISTINCT c.workspace_id, c.id AS channel_id, pg.principal_actor_id AS actor_id, COALESCE(c.created_by_actor_id, pg.created_by_actor_id, pg.principal_actor_id)
      FROM flightdeck_pg_channels c
      JOIN flightdeck_pg_permission_grants pg
        ON pg.workspace_id = c.workspace_id
        AND pg.resource_type = 'channel'
        AND pg.resource_channel_id = c.id
        AND pg.principal_type = 'actor'
        AND pg.principal_actor_id IS NOT NULL
        AND pg.revoked_at IS NULL
      JOIN flightdeck_pg_workspace_memberships wm
        ON wm.workspace_id = c.workspace_id
        AND wm.actor_id = pg.principal_actor_id
      WHERE c.kind = 'dm'
        AND c.archived_at IS NULL
    ) AS participants
    CROSS JOIN (
      VALUES
        ('channel.read'),
        ('task.read'),
        ('doc.read'),
        ('file.read'),
        ('audio_note.read'),
        ('channel.write'),
        ('task.create'),
        ('task.update'),
        ('task.comment'),
        ('comment.create'),
        ('doc.write'),
        ('file.write'),
        ('audio_note.write'),
        ('channel.manage'),
        ('channel.grants.read'),
        ('channel.grants.manage')
    ) AS perms(permission)
    ON CONFLICT (
      workspace_id,
      principal_type,
      COALESCE(principal_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
      resource_type,
      COALESCE(resource_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(resource_channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
      permission
    )
    WHERE revoked_at IS NULL
    DO NOTHING
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_actor_id,
      resource_type,
      resource_channel_id,
      permission,
      created_by_actor_id
    )
    SELECT
      c.workspace_id,
      'actor',
      c.created_by_actor_id,
      'channel',
      c.id,
      perms.permission,
      c.created_by_actor_id
    FROM flightdeck_pg_channels c
    JOIN flightdeck_pg_workspace_memberships wm
      ON wm.workspace_id = c.workspace_id
      AND wm.actor_id = c.created_by_actor_id
    CROSS JOIN (
      VALUES
        ('channel.read'),
        ('channel.write'),
        ('channel.manage'),
        ('channel.grant'),
        ('channel.grants.read'),
        ('channel.grants.manage'),
        ('task.read'),
        ('task.create'),
        ('task.update'),
        ('task.comment'),
        ('comment.create'),
        ('doc.read'),
        ('doc.write'),
        ('file.read'),
        ('file.write'),
        ('audio_note.read'),
        ('audio_note.write')
    ) AS perms(permission)
    WHERE c.created_by_actor_id IS NOT NULL
    ON CONFLICT (
      workspace_id,
      principal_type,
      COALESCE(principal_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
      resource_type,
      COALESCE(resource_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(resource_channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
      permission
    )
    WHERE revoked_at IS NULL
    DO NOTHING
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS flightdeck_pg_audit_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
      actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id UUID,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_audit_events_workspace_created
    ON flightdeck_pg_audit_events(workspace_id, created_at DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_storage_links
      DROP CONSTRAINT IF EXISTS flightdeck_pg_storage_links_entity_type_check,
      ADD CONSTRAINT flightdeck_pg_storage_links_entity_type_check
        CHECK (entity_type IN ('doc', 'file', 'audio_note', 'message'))
  `);

  await sql.unsafe(`
    WITH ranked_active_links AS (
      SELECT
        id,
        row_number() OVER (
          PARTITION BY workspace_id, storage_object_id
          ORDER BY created_at DESC, id DESC
        ) AS duplicate_rank
      FROM flightdeck_pg_storage_links
      WHERE deleted_at IS NULL
    )
    UPDATE flightdeck_pg_storage_links AS link
    SET deleted_at = NOW()
    FROM ranked_active_links
    WHERE link.id = ranked_active_links.id
      AND ranked_active_links.duplicate_rank > 1
      AND link.deleted_at IS NULL
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_storage_links
    DROP CONSTRAINT IF EXISTS flightdeck_pg_storage_links_workspace_id_entity_type_entity_id_storage_object_id_key
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_storage_links_active_object_unique
    ON flightdeck_pg_storage_links(workspace_id, storage_object_id)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_storage_links_channel
    ON flightdeck_pg_storage_links(workspace_id, channel_id, entity_type, created_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      CHECK (length(trim(title)) > 0),
      CHECK (row_version >= 1),
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
    )
  `);

  await sql`ALTER TABLE flightdeck_pg_docs ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`;

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_docs_active_storage_object
    ON flightdeck_pg_docs(workspace_id, storage_object_id)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_docs_channel_updated
    ON flightdeck_pg_docs(workspace_id, channel_id, updated_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_docs
    ADD COLUMN IF NOT EXISTS activity_version BIGINT NOT NULL DEFAULT 0
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_docs_activity
    ON flightdeck_pg_docs(workspace_id, channel_id, activity_version DESC)
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_versions_doc
    ON flightdeck_pg_doc_versions(workspace_id, doc_id, row_version DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_recoveries_doc_state
    ON flightdeck_pg_doc_recovery_versions(workspace_id, doc_id, resolution_state, created_at DESC, id DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_recoveries_storage
    ON flightdeck_pg_doc_recovery_versions(workspace_id, storage_object_id)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_file_folders_channel_parent
    ON flightdeck_pg_file_folders(workspace_id, channel_id, parent_folder_id, title)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_file_folders
    ADD COLUMN IF NOT EXISTS deleted_by_actor_id UUID
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'flightdeck_pg_file_folders_deleted_by_membership_fkey'
      ) THEN
        ALTER TABLE flightdeck_pg_file_folders
        ADD CONSTRAINT flightdeck_pg_file_folders_deleted_by_membership_fkey
        FOREIGN KEY (workspace_id, deleted_by_actor_id)
        REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
        ON DELETE RESTRICT;
      END IF;
    END
    $$;
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS flightdeck_pg_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
      scope_id UUID NOT NULL,
      channel_id UUID NOT NULL,
      folder_id UUID,
      storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE RESTRICT,
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
    )
  `);
  await sql`ALTER TABLE flightdeck_pg_files ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_files_channel_archived ON flightdeck_pg_files(workspace_id, channel_id, archived_at, updated_at DESC) WHERE deleted_at IS NULL`;

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_files
    ADD COLUMN IF NOT EXISTS folder_id UUID
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_files
    ADD COLUMN IF NOT EXISTS deleted_by_actor_id UUID
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'flightdeck_pg_files_deleted_by_membership_fkey'
      ) THEN
        ALTER TABLE flightdeck_pg_files
        ADD CONSTRAINT flightdeck_pg_files_deleted_by_membership_fkey
        FOREIGN KEY (workspace_id, deleted_by_actor_id)
        REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
        ON DELETE RESTRICT;
      END IF;
    END
    $$;
  `);

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'flightdeck_pg_files_folder_fkey'
      ) THEN
        ALTER TABLE flightdeck_pg_files
        ADD CONSTRAINT flightdeck_pg_files_folder_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id, folder_id)
        REFERENCES flightdeck_pg_file_folders(workspace_id, scope_id, channel_id, id)
        ON DELETE SET NULL (folder_id);
      END IF;
    END
    $$;
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_files_active_storage_object
    ON flightdeck_pg_files(workspace_id, storage_object_id)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_files_channel_updated
    ON flightdeck_pg_files(workspace_id, channel_id, updated_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_files
    ADD COLUMN IF NOT EXISTS current_version_id UUID
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_file_versions_file
    ON flightdeck_pg_file_versions(workspace_id, file_id, version_number DESC)
  `);

  await sql.unsafe(`
    INSERT INTO flightdeck_pg_file_versions (
      workspace_id,
      file_id,
      version_number,
      storage_object_id,
      base_version_id,
      operation,
      created_by_actor_id,
      created_at
    )
    SELECT
      f.workspace_id,
      f.id,
      1,
      f.storage_object_id,
      NULL,
      'created',
      f.created_by_actor_id,
      f.created_at
    FROM flightdeck_pg_files f
    WHERE f.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM flightdeck_pg_file_versions v
        WHERE v.workspace_id = f.workspace_id
          AND v.file_id = f.id
      )
  `);

  await sql.unsafe(`
    UPDATE flightdeck_pg_files f
    SET current_version_id = (
      SELECT v.id
      FROM flightdeck_pg_file_versions v
      WHERE v.workspace_id = f.workspace_id
        AND v.file_id = f.id
      ORDER BY v.version_number DESC, v.created_at DESC, v.id DESC
      LIMIT 1
    )
    WHERE f.current_version_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM flightdeck_pg_file_versions v
        WHERE v.workspace_id = f.workspace_id
          AND v.file_id = f.id
      )
  `);

  await sql.unsafe(`
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
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ADD COLUMN IF NOT EXISTS thread_id UUID
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ADD COLUMN IF NOT EXISTS media_encryption JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ADD COLUMN IF NOT EXISTS waveform_preview JSONB NOT NULL DEFAULT '[]'::jsonb
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ADD COLUMN IF NOT EXISTS transcript_preview TEXT
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ADD COLUMN IF NOT EXISTS transcript TEXT
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ADD COLUMN IF NOT EXISTS record_state TEXT NOT NULL DEFAULT 'active'
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ALTER COLUMN size_bytes SET DEFAULT 0
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ALTER COLUMN media_encryption SET DEFAULT '{}'::jsonb
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ALTER COLUMN waveform_preview SET DEFAULT '[]'::jsonb
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ALTER COLUMN record_state SET DEFAULT 'active'
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_audio_notes
    ALTER COLUMN transcript_status SET DEFAULT 'not_requested'
  `);

  await sql.unsafe(`
    DO $$
    DECLARE
      target_type_attnum smallint;
      target_type_constraint record;
    BEGIN
      SELECT attnum
      INTO target_type_attnum
      FROM pg_attribute
      WHERE attrelid = 'flightdeck_pg_audio_notes'::regclass
        AND attname = 'target_type'
        AND NOT attisdropped;

      FOR target_type_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'flightdeck_pg_audio_notes'::regclass
          AND contype = 'c'
          AND conkey = ARRAY[target_type_attnum]::smallint[]
      LOOP
        EXECUTE format('ALTER TABLE flightdeck_pg_audio_notes DROP CONSTRAINT %I', target_type_constraint.conname);
      END LOOP;

      ALTER TABLE flightdeck_pg_audio_notes
        ADD CONSTRAINT flightdeck_pg_audio_notes_target_type_check
        CHECK (target_type IS NULL OR target_type IN ('message', 'task_comment', 'task', 'doc', 'file', 'audio_note'));
    END
    $$;
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_audio_notes_active_storage_object
    ON flightdeck_pg_audio_notes(workspace_id, storage_object_id)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_audio_notes_channel_updated
    ON flightdeck_pg_audio_notes(workspace_id, channel_id, updated_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_audio_notes_target
    ON flightdeck_pg_audio_notes(workspace_id, target_type, target_id, created_at ASC)
    WHERE target_type IS NOT NULL AND target_id IS NOT NULL AND deleted_at IS NULL
  `);

  await sql.unsafe(`
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
      UNIQUE (workspace_id, id),
      UNIQUE (workspace_id, scope_id, channel_id, id)
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_threads
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS activity_version BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS parent_thread_id UUID,
    ADD COLUMN IF NOT EXISTS branch_point_message_id UUID,
    ADD COLUMN IF NOT EXISTS client_request_id TEXT,
    ADD COLUMN IF NOT EXISTS client_request_hash TEXT
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_channel_updated
    ON flightdeck_pg_threads(workspace_id, channel_id, updated_at DESC)
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_channel_archived
    ON flightdeck_pg_threads(workspace_id, channel_id, updated_at DESC)
    WHERE deleted_at IS NULL AND archived_at IS NOT NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_source_message
    ON flightdeck_pg_threads(workspace_id, source_message_id)
    WHERE source_message_id IS NOT NULL AND deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_activity
    ON flightdeck_pg_threads(workspace_id, channel_id, activity_version DESC)
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_parent
    ON flightdeck_pg_threads(workspace_id, parent_thread_id)
    WHERE parent_thread_id IS NOT NULL
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_threads_branch_idempotency
    ON flightdeck_pg_threads(workspace_id, created_by_actor_id, client_request_id)
    WHERE client_request_id IS NOT NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_messages
      ADD COLUMN IF NOT EXISTS client_request_id TEXT,
      ADD COLUMN IF NOT EXISTS client_request_hash TEXT
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_messages
      DROP CONSTRAINT IF EXISTS flightdeck_pg_messages_body_check,
      DROP CONSTRAINT IF EXISTS flightdeck_pg_messages_body_or_attachments_check,
      ADD CONSTRAINT flightdeck_pg_messages_body_or_attachments_check CHECK (
        length(trim(body)) > 0
        OR COALESCE(jsonb_typeof(metadata->'attachments') = 'array' AND jsonb_array_length(metadata->'attachments') > 0, false)
      )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_messages_channel_created
    ON flightdeck_pg_messages(workspace_id, channel_id, created_at ASC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_messages_thread_created
    ON flightdeck_pg_messages(workspace_id, thread_id, created_at ASC)
    WHERE thread_id IS NOT NULL AND deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_messages_idempotency
    ON flightdeck_pg_messages(workspace_id, created_by_actor_id, client_request_id)
    WHERE client_request_id IS NOT NULL
  `);

  await sql.unsafe(`
    DO $$ BEGIN
      ALTER TABLE flightdeck_pg_threads
        ADD CONSTRAINT flightdeck_pg_threads_parent_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id, parent_thread_id)
        REFERENCES flightdeck_pg_threads(workspace_id, scope_id, channel_id, id)
        ON DELETE RESTRICT;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);

  await sql.unsafe(`
    DO $$ BEGIN
      ALTER TABLE flightdeck_pg_threads
        ADD CONSTRAINT flightdeck_pg_threads_branch_point_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id, branch_point_message_id)
        REFERENCES flightdeck_pg_messages(workspace_id, scope_id, channel_id, id)
        ON DELETE RESTRICT;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);

  await sql.unsafe(`
    DO $$ BEGIN
      ALTER TABLE flightdeck_pg_threads
        ADD CONSTRAINT flightdeck_pg_threads_branch_pair_check
        CHECK ((parent_thread_id IS NULL) = (branch_point_message_id IS NULL));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);

  await sql.unsafe(`
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      CHECK (length(trim(title)) > 0),
      CHECK (state IN ('new', 'ready', 'in_progress', 'review', 'done', 'archive', 'backlog', 'blocked', 'archived')),
      CHECK (priority IN ('rock', 'pebble', 'sand', 'low', 'normal', 'high', 'urgent')),
      CHECK (row_version >= 1),
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
    )
  `);

  await sql.unsafe(`
    DO $$
    DECLARE
      task_constraint RECORD;
    BEGIN
      FOR task_constraint IN
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'flightdeck_pg_tasks'::regclass
          AND contype = 'c'
      LOOP
        IF task_constraint.definition LIKE '%state%' OR task_constraint.definition LIKE '%priority%' THEN
          EXECUTE format('ALTER TABLE flightdeck_pg_tasks DROP CONSTRAINT %I', task_constraint.conname);
        END IF;
      END LOOP;

      ALTER TABLE flightdeck_pg_tasks
        ADD CONSTRAINT flightdeck_pg_tasks_state_check
        CHECK (state IN ('new', 'ready', 'in_progress', 'review', 'done', 'archive', 'backlog', 'blocked', 'archived'));

      ALTER TABLE flightdeck_pg_tasks
        ADD CONSTRAINT flightdeck_pg_tasks_priority_check
        CHECK (priority IN ('rock', 'pebble', 'sand', 'low', 'normal', 'high', 'urgent'));

      ALTER TABLE flightdeck_pg_tasks ALTER COLUMN state SET DEFAULT 'new';
      ALTER TABLE flightdeck_pg_tasks ALTER COLUMN priority SET DEFAULT 'sand';
    END $$;
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_tasks_channel_state
    ON flightdeck_pg_tasks(workspace_id, channel_id, state, updated_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_tasks_scope_updated
    ON flightdeck_pg_tasks(workspace_id, scope_id, updated_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_tasks
    ADD COLUMN IF NOT EXISTS activity_version BIGINT NOT NULL DEFAULT 0
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_tasks_activity
    ON flightdeck_pg_tasks(workspace_id, channel_id, activity_version DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_resource_view_states_viewer
    ON flightdeck_pg_resource_view_states(workspace_id, viewer_actor_id, resource_type, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS flightdeck_pg_resource_view_state_rollouts (
      workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
      viewer_actor_id UUID NOT NULL,
      baselined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (workspace_id, viewer_actor_id),
      CONSTRAINT flightdeck_pg_resource_view_state_rollouts_viewer_fkey
        FOREIGN KEY (workspace_id, viewer_actor_id)
        REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
    )
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_daily_notes
      ADD COLUMN IF NOT EXISTS scope_id UUID,
      ADD COLUMN IF NOT EXISTS channel_id UUID
  `);

  await sql.unsafe(`
    DROP INDEX IF EXISTS idx_flightdeck_pg_daily_notes_owner_date_active
  `);

  await sql.unsafe(`
    DROP INDEX IF EXISTS idx_flightdeck_pg_daily_notes_owner_date_context_active
  `);

  await sql.unsafe(`
    DROP INDEX IF EXISTS idx_flightdeck_pg_daily_notes_date_context_active
  `);

  await sql.unsafe(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY
            workspace_id,
            owner_actor_id,
            note_date
          ORDER BY updated_at DESC, created_at DESC, id ASC
        ) AS rn
      FROM flightdeck_pg_daily_notes
      WHERE deleted_at IS NULL
    )
    UPDATE flightdeck_pg_daily_notes n
    SET
      deleted_at = NOW(),
      status = 'archived',
      row_version = n.row_version + 1,
      updated_at = NOW()
    FROM ranked
    WHERE n.id = ranked.id
      AND ranked.rn > 1
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_daily_notes_owner_date_active
    ON flightdeck_pg_daily_notes(
      workspace_id,
      owner_actor_id,
      note_date
    )
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_daily_notes_workspace_updated
    ON flightdeck_pg_daily_notes(workspace_id, updated_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_daily_note_versions_note
    ON flightdeck_pg_daily_note_versions(workspace_id, daily_note_id, row_version DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_daily_scope_access_agent
    ON flightdeck_pg_daily_scope_agent_access(workspace_id, agent_actor_id)
    WHERE revoked_at IS NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_personal_wapps
      ADD COLUMN IF NOT EXISTS scope_id UUID,
      ADD COLUMN IF NOT EXISTS channel_id UUID,
      ADD COLUMN IF NOT EXISTS icon_url TEXT,
      ADD COLUMN IF NOT EXISTS app_id TEXT,
      ADD COLUMN IF NOT EXISTS wapp_id TEXT,
      ADD COLUMN IF NOT EXISTS source_wingman_url TEXT,
      ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_personal_wapps_owner_order
    ON flightdeck_pg_personal_wapps(workspace_id, owner_actor_id, sort_order ASC, updated_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_edit_leases_active_entity
    ON flightdeck_pg_edit_leases(workspace_id, entity_type, entity_id, field_path, expires_at DESC)
    WHERE released_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_edit_leases_holder
    ON flightdeck_pg_edit_leases(workspace_id, holder_actor_id, updated_at DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_task_comments_task_created
    ON flightdeck_pg_task_comments(workspace_id, task_id, created_at)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_task_comments_channel_created
    ON flightdeck_pg_task_comments(workspace_id, channel_id, created_at)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_comments_doc_created
    ON flightdeck_pg_doc_comments(workspace_id, doc_id, created_at)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_doc_comments_parent_created
    ON flightdeck_pg_doc_comments(workspace_id, parent_comment_id, created_at)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_task_assignments_actor
    ON flightdeck_pg_task_assignments(workspace_id, actor_id)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_task_watchers_actor
    ON flightdeck_pg_task_watchers(workspace_id, actor_id)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_reactions
    ADD COLUMN IF NOT EXISTS thread_id UUID
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_reactions
    ADD COLUMN IF NOT EXISTS emoji_shortcode TEXT
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_reactions
    ADD COLUMN IF NOT EXISTS reactor_actor_id UUID
  `);

  await sql.unsafe(`
    DO $$
    DECLARE
      target_type_attnum smallint;
      emoji_attnum smallint;
      emoji_shortcode_attnum smallint;
      target_type_constraint record;
      emoji_constraint record;
      emoji_shortcode_constraint record;
    BEGIN
      SELECT attnum
      INTO target_type_attnum
      FROM pg_attribute
      WHERE attrelid = 'flightdeck_pg_reactions'::regclass
        AND attname = 'target_type'
        AND NOT attisdropped;

      SELECT attnum
      INTO emoji_attnum
      FROM pg_attribute
      WHERE attrelid = 'flightdeck_pg_reactions'::regclass
        AND attname = 'emoji'
        AND NOT attisdropped;

      SELECT attnum
      INTO emoji_shortcode_attnum
      FROM pg_attribute
      WHERE attrelid = 'flightdeck_pg_reactions'::regclass
        AND attname = 'emoji_shortcode'
        AND NOT attisdropped;

      FOR target_type_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'flightdeck_pg_reactions'::regclass
          AND contype = 'c'
          AND conkey = ARRAY[target_type_attnum]::smallint[]
      LOOP
        EXECUTE format('ALTER TABLE flightdeck_pg_reactions DROP CONSTRAINT %I', target_type_constraint.conname);
      END LOOP;

      FOR emoji_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'flightdeck_pg_reactions'::regclass
          AND contype = 'c'
          AND conkey = ARRAY[emoji_attnum]::smallint[]
      LOOP
        EXECUTE format('ALTER TABLE flightdeck_pg_reactions DROP CONSTRAINT %I', emoji_constraint.conname);
      END LOOP;

      FOR emoji_shortcode_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'flightdeck_pg_reactions'::regclass
          AND contype = 'c'
          AND conkey = ARRAY[emoji_shortcode_attnum]::smallint[]
      LOOP
        EXECUTE format('ALTER TABLE flightdeck_pg_reactions DROP CONSTRAINT %I', emoji_shortcode_constraint.conname);
      END LOOP;

      ALTER TABLE flightdeck_pg_reactions
        ADD CONSTRAINT flightdeck_pg_reactions_target_type_check
        CHECK (target_type IN ('message', 'task_comment', 'task', 'doc', 'file', 'audio_note'));

      ALTER TABLE flightdeck_pg_reactions
        ADD CONSTRAINT flightdeck_pg_reactions_emoji_check
        CHECK (emoji IN ('thumbs_up', 'smile', 'heart', 'eyes', 'party', 'white_check_mark'));

      ALTER TABLE flightdeck_pg_reactions
        ADD CONSTRAINT flightdeck_pg_reactions_emoji_shortcode_check
        CHECK (emoji_shortcode IN (':thumbs_up:', ':smile:', ':heart:', ':eyes:', ':party:', ':white_check_mark:'));
    END
    $$;
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_reactions_active_target_actor_unique
    ON flightdeck_pg_reactions(workspace_id, target_type, target_id, emoji, reactor_actor_id)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_reactions_target_created
    ON flightdeck_pg_reactions(workspace_id, target_type, target_id, created_at ASC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_reactions_channel_created
    ON flightdeck_pg_reactions(workspace_id, channel_id, created_at ASC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
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
      CONSTRAINT flightdeck_pg_response_activities_row_version_check
        CHECK (row_version >= 1),
      CONSTRAINT flightdeck_pg_response_activities_channel_scope_check
        CHECK (channel_id IS NULL OR scope_id IS NOT NULL),
      CONSTRAINT flightdeck_pg_response_activities_scope_fkey
        FOREIGN KEY (workspace_id, scope_id)
        REFERENCES flightdeck_pg_scopes(workspace_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_response_activities_channel_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id)
        REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
        ON DELETE CASCADE
    )
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_pg_resp_act_active_target_actor
    ON flightdeck_pg_response_activities(workspace_id, target_type, target_id, actor_id, activity_type)
    WHERE cleared_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_fd_pg_resp_act_target
    ON flightdeck_pg_response_activities(workspace_id, target_type, target_id, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_fd_pg_resp_act_channel
    ON flightdeck_pg_response_activities(workspace_id, channel_id, updated_at DESC)
    WHERE cleared_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_fd_pg_resp_act_expires
    ON flightdeck_pg_response_activities(workspace_id, expires_at)
    WHERE cleared_at IS NULL
  `);

  await sql.unsafe(`
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
      CONSTRAINT flightdeck_pg_agent_activities_scope_fkey
        FOREIGN KEY (workspace_id, scope_id)
        REFERENCES flightdeck_pg_scopes(workspace_id, id) ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_agent_activities_channel_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id)
        REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id) ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_agent_activities_thread_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id, thread_id)
        REFERENCES flightdeck_pg_threads(workspace_id, scope_id, channel_id, id) ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_agent_activities_trigger_message_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id, trigger_message_id)
        REFERENCES flightdeck_pg_messages(workspace_id, scope_id, channel_id, id) ON DELETE CASCADE
    )
  `);

  // Existing activity rows predate durable Agent Direct turn correlation. Keep
  // the column nullable for hydration compatibility; every new write requires
  // turn_id and may fill a legacy NULL exactly once.
  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_agent_activities
    ADD COLUMN IF NOT EXISTS turn_id TEXT
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_fd_pg_agent_activities_hydrate
    ON flightdeck_pg_agent_activities(workspace_id, channel_id, thread_id, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_fd_pg_agent_activities_expiry
    ON flightdeck_pg_agent_activities(workspace_id, expires_at)
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_fd_pg_agent_activity_commentary_hydrate
    ON flightdeck_pg_agent_activity_commentary(workspace_id, agent_activity_id, turn_id, sequence ASC)
  `);

  await sql.unsafe(`
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
      CONSTRAINT flightdeck_pg_invocations_scope_fkey
        FOREIGN KEY (workspace_id, scope_id)
        REFERENCES flightdeck_pg_scopes(workspace_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_invocations_channel_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id)
        REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_invocations_created_by_membership_fkey
        FOREIGN KEY (workspace_id, created_by_actor_id)
        REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
        ON DELETE RESTRICT
    )
  `);

  for (const column of [
    "recipients JSONB NOT NULL DEFAULT '[]'::jsonb",
    "targets JSONB NOT NULL DEFAULT '[]'::jsonb",
    "status TEXT NOT NULL DEFAULT 'open'",
    "metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    "row_version INTEGER NOT NULL DEFAULT 1",
    'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    'closed_at TIMESTAMPTZ',
  ]) {
    await sql.unsafe(`
      ALTER TABLE flightdeck_pg_invocations
      ADD COLUMN IF NOT EXISTS ${column}
    `);
  }

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_channel_updated
    ON flightdeck_pg_invocations(workspace_id, channel_id, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_status_updated
    ON flightdeck_pg_invocations(workspace_id, status, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_recipients_gin
    ON flightdeck_pg_invocations USING GIN (recipients)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_targets_gin
    ON flightdeck_pg_invocations USING GIN (targets)
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_invocations_client_request
    ON flightdeck_pg_invocations(workspace_id, (metadata->>'client_request_id'))
    WHERE metadata ? 'client_request_id'
  `);

  await sql.unsafe(`
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
      CONSTRAINT flightdeck_pg_workrooms_title_check
        CHECK (length(trim(title)) > 0),
      CONSTRAINT flightdeck_pg_workrooms_goal_check
        CHECK (length(trim(goal)) > 0),
      CONSTRAINT flightdeck_pg_workrooms_status_check
        CHECK (status IN ('draft', 'active', 'waiting_review', 'waiting_approval', 'integrating', 'deploying', 'blocked', 'complete', 'archived')),
      CONSTRAINT flightdeck_pg_workrooms_repo_object_check
        CHECK (jsonb_typeof(repo) = 'object'),
      CONSTRAINT flightdeck_pg_workrooms_branches_object_check
        CHECK (jsonb_typeof(branches) = 'object'),
      CONSTRAINT flightdeck_pg_workrooms_app_targets_object_check
        CHECK (jsonb_typeof(app_targets) = 'object'),
      CONSTRAINT flightdeck_pg_workrooms_approval_policy_object_check
        CHECK (jsonb_typeof(approval_policy) = 'object'),
      CONSTRAINT flightdeck_pg_workrooms_archive_policy_object_check
        CHECK (jsonb_typeof(archive_policy) = 'object'),
      CONSTRAINT flightdeck_pg_workrooms_metadata_object_check
        CHECK (jsonb_typeof(metadata) = 'object'),
      CONSTRAINT flightdeck_pg_workrooms_row_version_check
        CHECK (row_version >= 1),
      CONSTRAINT flightdeck_pg_workrooms_scope_fkey
        FOREIGN KEY (workspace_id, scope_id)
        REFERENCES flightdeck_pg_scopes(workspace_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_workrooms_channel_fkey
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
    )
  `);

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_workrooms
    ADD COLUMN IF NOT EXISTS thread_id UUID
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_thread
    ON flightdeck_pg_workrooms(workspace_id, channel_id, thread_id)
    WHERE thread_id IS NOT NULL AND deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_channel_status
    ON flightdeck_pg_workrooms(workspace_id, channel_id, status, updated_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_scope_updated
    ON flightdeck_pg_workrooms(workspace_id, scope_id, updated_at DESC)
    WHERE deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_integration_autopilot
    ON flightdeck_pg_workrooms(workspace_id, integration_autopilot_npub, updated_at DESC)
    WHERE integration_autopilot_npub IS NOT NULL AND deleted_at IS NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_repo_gin
    ON flightdeck_pg_workrooms USING GIN (repo)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workrooms_app_targets_gin
    ON flightdeck_pg_workrooms USING GIN (app_targets)
  `);

  await sql.unsafe(`
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
      CONSTRAINT flightdeck_pg_workroom_participants_actor_npub_check
        CHECK (length(trim(actor_npub)) > 0),
      CONSTRAINT flightdeck_pg_workroom_participants_kind_check
        CHECK (kind IN ('human', 'agent', 'autopilot', 'app', 'service')),
      CONSTRAINT flightdeck_pg_workroom_participants_role_check
        CHECK (role IN ('integration', 'contributor', 'reviewer', 'human_approver', 'observer')),
      CONSTRAINT flightdeck_pg_workroom_participants_status_check
        CHECK (status IN ('invited', 'active', 'inactive', 'removed')),
      CONSTRAINT flightdeck_pg_workroom_participants_access_status_check
        CHECK (access_status IN ('pending', 'granted', 'failed', 'not_required')),
      CONSTRAINT flightdeck_pg_workroom_participants_metadata_object_check
        CHECK (jsonb_typeof(metadata) = 'object'),
      CONSTRAINT flightdeck_pg_workroom_participants_workroom_fkey
        FOREIGN KEY (workspace_id, workroom_id)
        REFERENCES flightdeck_pg_workrooms(workspace_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_workroom_participants_actor_membership_fkey
        FOREIGN KEY (workspace_id, actor_id)
        REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
        ON DELETE SET NULL (actor_id),
      UNIQUE (workroom_id, actor_npub)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_participants_workroom
    ON flightdeck_pg_workroom_participants(workspace_id, workroom_id, role, status)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_participants_actor
    ON flightdeck_pg_workroom_participants(workspace_id, actor_npub, updated_at DESC)
  `);

  await sql.unsafe(`
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
      CONSTRAINT flightdeck_pg_workroom_events_event_type_check
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
      CONSTRAINT flightdeck_pg_workroom_events_visibility_check
        CHECK (visibility IN ('room', 'workspace', 'private')),
      CONSTRAINT flightdeck_pg_workroom_events_payload_object_check
        CHECK (jsonb_typeof(payload) = 'object'),
      CONSTRAINT flightdeck_pg_workroom_events_workroom_fkey
        FOREIGN KEY (workspace_id, workroom_id)
        REFERENCES flightdeck_pg_workrooms(workspace_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_workroom_events_channel_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id)
        REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_workroom_events_actor_membership_fkey
        FOREIGN KEY (workspace_id, actor_id)
        REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
        ON DELETE SET NULL (actor_id)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_events_workroom_created
    ON flightdeck_pg_workroom_events(workspace_id, workroom_id, created_at ASC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_events_channel_created
    ON flightdeck_pg_workroom_events(workspace_id, channel_id, created_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_events_target
    ON flightdeck_pg_workroom_events(workspace_id, target_type, target_ref, created_at DESC)
    WHERE target_type IS NOT NULL
  `);

  await sql.unsafe(`
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
      CONSTRAINT flightdeck_pg_approvals_target_type_check
        CHECK (length(trim(target_type)) > 0),
      CONSTRAINT flightdeck_pg_approvals_action_check
        CHECK (length(trim(action)) > 0),
      CONSTRAINT flightdeck_pg_approvals_status_check
        CHECK (status IN ('requested', 'in_review', 'approved', 'rejected', 'superseded', 'cancelled')),
      CONSTRAINT flightdeck_pg_approvals_requested_by_npub_check
        CHECK (length(trim(requested_by_npub)) > 0),
      CONSTRAINT flightdeck_pg_approvals_reviewer_npub_check
        CHECK (reviewer_npub IS NULL OR length(trim(reviewer_npub)) > 0),
      CONSTRAINT flightdeck_pg_approvals_approver_npub_check
        CHECK (approver_npub IS NULL OR length(trim(approver_npub)) > 0),
      CONSTRAINT flightdeck_pg_approvals_metadata_object_check
        CHECK (jsonb_typeof(metadata) = 'object'),
      CONSTRAINT flightdeck_pg_approvals_row_version_check
        CHECK (row_version >= 1),
      CONSTRAINT flightdeck_pg_approvals_approved_at_check
        CHECK (approved_at IS NULL OR status IN ('approved', 'superseded')),
      CONSTRAINT flightdeck_pg_approvals_rejected_at_check
        CHECK (rejected_at IS NULL OR status = 'rejected'),
      CONSTRAINT flightdeck_pg_approvals_superseded_at_check
        CHECK (superseded_at IS NULL OR status = 'superseded'),
      CONSTRAINT flightdeck_pg_approvals_cancelled_at_check
        CHECK (cancelled_at IS NULL OR status = 'cancelled'),
      CONSTRAINT flightdeck_pg_approvals_scope_fkey
        FOREIGN KEY (workspace_id, scope_id)
        REFERENCES flightdeck_pg_scopes(workspace_id, id)
        ON DELETE SET NULL (scope_id),
      CONSTRAINT flightdeck_pg_approvals_channel_fkey
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_approvals_target_action
    ON flightdeck_pg_approvals(workspace_id, target_type, target_id, action, status, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_approvals_channel_status
    ON flightdeck_pg_approvals(workspace_id, channel_id, status, updated_at DESC)
    WHERE channel_id IS NOT NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_approvals_metadata_gin
    ON flightdeck_pg_approvals USING GIN (metadata)
  `);

  await sql.unsafe(`
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
      CONSTRAINT flightdeck_pg_workroom_links_link_type_check
        CHECK (link_type IN ('pull_request', 'file', 'doc', 'task', 'artifact', 'app_target', 'preview_url', 'production_url', 'approval', 'deployment', 'thread', 'message', 'external_url')),
      CONSTRAINT flightdeck_pg_workroom_links_target_type_check
        CHECK (length(trim(target_type)) > 0),
      CONSTRAINT flightdeck_pg_workroom_links_target_check
        CHECK (target_id IS NOT NULL OR external_url IS NOT NULL),
      CONSTRAINT flightdeck_pg_workroom_links_external_url_check
        CHECK (external_url IS NULL OR external_url ~* '^https?://'),
      CONSTRAINT flightdeck_pg_workroom_links_metadata_object_check
        CHECK (jsonb_typeof(metadata) = 'object'),
      CONSTRAINT flightdeck_pg_workroom_links_workroom_fkey
        FOREIGN KEY (workspace_id, workroom_id)
        REFERENCES flightdeck_pg_workrooms(workspace_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_workroom_links_channel_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id)
        REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_workroom_links_created_by_membership_fkey
        FOREIGN KEY (workspace_id, created_by_actor_id)
        REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)
        ON DELETE SET NULL (created_by_actor_id)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_links_workroom_type
    ON flightdeck_pg_workroom_links(workspace_id, workroom_id, link_type, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_links_target
    ON flightdeck_pg_workroom_links(workspace_id, target_type, target_id)
    WHERE target_id IS NOT NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_workroom_links_metadata_gin
    ON flightdeck_pg_workroom_links USING GIN (metadata)
  `);

  await sql.unsafe(`
    CREATE SEQUENCE IF NOT EXISTS flightdeck_pg_outbox_events_row_version_seq AS INTEGER
  `);

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_event_subscription_agents_agent
    ON flightdeck_pg_event_subscription_agents(workspace_id, agent_actor_id)
  `);

  // Existing event-subscription managers were already trusted to aggregate a
  // bounded audience. Preserve that authority explicitly when upgrading from
  // the legacy workspace.read-only contract. New managers must receive the
  // permission through an owner/admin grant.
  await sql.unsafe(`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_actor_id,
      resource_type,
      permission,
      created_by_actor_id
    )
    SELECT DISTINCT
      authz.workspace_id,
      'actor',
      authz.manager_actor_id,
      'workspace',
      'event_subscription.manage',
      authz.authorized_by_actor_id
    FROM flightdeck_pg_event_subscription_agents authz
    ON CONFLICT (
      workspace_id,
      principal_type,
      COALESCE(principal_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(principal_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
      resource_type,
      COALESCE(resource_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(resource_channel_id, '00000000-0000-0000-0000-000000000000'::uuid),
      permission
    )
    WHERE revoked_at IS NULL
    DO NOTHING
  `);

  await sql.unsafe(`
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
      CONSTRAINT flightdeck_pg_outbox_events_row_version_check
        CHECK (row_version >= 1),
      CONSTRAINT flightdeck_pg_outbox_events_channel_scope_check
        CHECK (channel_id IS NULL OR scope_id IS NOT NULL),
      CONSTRAINT flightdeck_pg_outbox_events_scope_fkey
        FOREIGN KEY (workspace_id, scope_id)
        REFERENCES flightdeck_pg_scopes(workspace_id, id)
        ON DELETE CASCADE,
      CONSTRAINT flightdeck_pg_outbox_events_channel_fkey
        FOREIGN KEY (workspace_id, scope_id, channel_id)
        REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id)
        ON DELETE CASCADE
    )
  `);

  for (const column of [
    'scope_id UUID',
    'channel_id UUID',
    'actor_id UUID REFERENCES flightdeck_pg_actors(id) ON DELETE SET NULL',
    "entity_type TEXT NOT NULL DEFAULT 'unknown'",
    'entity_id UUID',
    "operation TEXT NOT NULL DEFAULT 'unknown'",
    'entity_row_version BIGINT',
    "row_version INTEGER NOT NULL DEFAULT nextval('flightdeck_pg_outbox_events_row_version_seq')",
    'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  ]) {
    await sql.unsafe(`
      ALTER TABLE flightdeck_pg_outbox_events
      ADD COLUMN IF NOT EXISTS ${column}
    `);
  }

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_outbox_events
      ALTER COLUMN entity_row_version TYPE BIGINT,
      ALTER COLUMN row_version TYPE INTEGER,
      ALTER COLUMN row_version SET DEFAULT nextval('flightdeck_pg_outbox_events_row_version_seq')
  `);

  // Outbox row versions are externally persisted protocol cursors. Never
  // renumber existing values here, including when the table contains gaps.
  // Legacy invalid or duplicate values must be repaired explicitly so startup
  // cannot silently invalidate a cursor already stored by a consumer.
  await sql.unsafe(`
    WITH outbox AS (
      SELECT COALESCE(MAX(row_version), 0)::bigint AS max_row_version
      FROM flightdeck_pg_outbox_events
    )
    SELECT setval(
      'flightdeck_pg_outbox_events_row_version_seq',
      GREATEST(sequence_state.last_value, outbox.max_row_version),
      true
    )
    FROM flightdeck_pg_outbox_events_row_version_seq AS sequence_state
    CROSS JOIN outbox
    WHERE outbox.max_row_version > sequence_state.last_value
      OR (
        outbox.max_row_version = sequence_state.last_value
        AND outbox.max_row_version > 0
        AND NOT sequence_state.is_called
      )
  `);

  for (const constraint of [
    {
      name: 'flightdeck_pg_outbox_events_row_version_check',
      sql: 'CHECK (row_version >= 1)',
    },
    {
      name: 'flightdeck_pg_outbox_events_channel_scope_check',
      sql: 'CHECK (channel_id IS NULL OR scope_id IS NOT NULL)',
    },
    {
      name: 'flightdeck_pg_outbox_events_scope_fkey',
      sql: 'FOREIGN KEY (workspace_id, scope_id) REFERENCES flightdeck_pg_scopes(workspace_id, id) ON DELETE CASCADE',
    },
    {
      name: 'flightdeck_pg_outbox_events_channel_fkey',
      sql: 'FOREIGN KEY (workspace_id, scope_id, channel_id) REFERENCES flightdeck_pg_channels(workspace_id, scope_id, id) ON DELETE CASCADE',
    },
  ]) {
    await sql.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = '${constraint.name}'
            AND conrelid = 'flightdeck_pg_outbox_events'::regclass
        ) THEN
          ALTER TABLE flightdeck_pg_outbox_events
            ADD CONSTRAINT ${constraint.name} ${constraint.sql};
        END IF;
      END
      $$;
    `);
  }

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_outbox_events_pending
    ON flightdeck_pg_outbox_events(status, created_at)
    WHERE status IN ('pending', 'failed')
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_outbox_events_workspace_entity
    ON flightdeck_pg_outbox_events(workspace_id, entity_type, entity_id, created_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_outbox_events_workspace_cursor
    ON flightdeck_pg_outbox_events(workspace_id, row_version ASC, created_at ASC)
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_flightdeck_pg_outbox_events_row_version
    ON flightdeck_pg_outbox_events(row_version)
  `);

  await sql.unsafe(`
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
    )
  `);

  for (const column of [
    'device_label TEXT',
    'platform TEXT',
    'user_agent TEXT',
    'app_version TEXT',
    'last_seen_workspace_id UUID REFERENCES flightdeck_pg_workspaces(id) ON DELETE SET NULL',
    "status TEXT NOT NULL DEFAULT 'active'",
    'failure_count INTEGER NOT NULL DEFAULT 0',
    'last_success_at TIMESTAMPTZ',
    'last_failure_at TIMESTAMPTZ',
    'revoked_at TIMESTAMPTZ',
    'stale_at TIMESTAMPTZ',
    'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  ]) {
    await sql.unsafe(`ALTER TABLE flightdeck_pg_push_subscriptions ADD COLUMN IF NOT EXISTS ${column}`);
  }

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_push_subscriptions_actor
    ON flightdeck_pg_push_subscriptions(actor_id, status, updated_at DESC)
  `);

  await sql.unsafe(`
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
    )
  `);

  for (const column of [
    'chat_threads_enabled BOOLEAN NOT NULL DEFAULT true',
    'mentions_enabled BOOLEAN NOT NULL DEFAULT true',
    'dms_enabled BOOLEAN NOT NULL DEFAULT true',
    'comment_tags_enabled BOOLEAN NOT NULL DEFAULT true',
    'task_assignments_enabled BOOLEAN NOT NULL DEFAULT true',
    'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  ]) {
    await sql.unsafe(`ALTER TABLE flightdeck_pg_notification_preferences ADD COLUMN IF NOT EXISTS ${column}`);
  }

  await sql.unsafe(`
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
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_notification_deliveries_workspace
    ON flightdeck_pg_notification_deliveries(workspace_id, created_at DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_notification_deliveries_recipient
    ON flightdeck_pg_notification_deliveries(recipient_actor_id, created_at DESC)
  `);

  await sql.unsafe(`
    DELETE FROM flightdeck_pg_notification_deliveries d
    USING flightdeck_pg_notification_deliveries keep
    WHERE d.dedupe_key = keep.dedupe_key
      AND COALESCE(d.subscription_id, '00000000-0000-0000-0000-000000000000'::uuid) =
        COALESCE(keep.subscription_id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND (
        keep.created_at > d.created_at
        OR (keep.created_at = d.created_at AND keep.id > d.id)
      )
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_pg_notification_deliveries_dedupe_subscription
    ON flightdeck_pg_notification_deliveries(dedupe_key, COALESCE(subscription_id, '00000000-0000-0000-0000-000000000000'::uuid))
  `);

  // Identity rotation originally left denormalized DM participant npubs
  // behind. Canonicalize them from actor history while preferring a current
  // actor if an old npub has since been reclaimed. Preserve first-seen order,
  // deduplicate replacements, and touch updated_at so snapshot clients refresh.
  await sql.unsafe(`
    WITH canonicalized AS (
      SELECT channel.id, (
        SELECT array_agg(mapped_npub ORDER BY first_ordinality)
        FROM (
          SELECT mapped_npub, MIN(ordinality) AS first_ordinality
          FROM (
            SELECT participant.ordinality, COALESCE(
              current_actor.npub,
              historical_actor.current_npub,
              participant.npub
            ) AS mapped_npub
            FROM unnest(channel.participant_npubs) WITH ORDINALITY AS participant(npub, ordinality)
            LEFT JOIN LATERAL (
              SELECT actor.npub
              FROM flightdeck_pg_actors actor
              WHERE actor.npub = participant.npub
              LIMIT 1
            ) current_actor ON TRUE
            LEFT JOIN LATERAL (
              SELECT actor.npub AS current_npub
              FROM flightdeck_pg_actor_identity_history history
              JOIN flightdeck_pg_actors actor ON actor.id = history.actor_id
              WHERE history.npub = participant.npub
              ORDER BY history.valid_until DESC, actor.id ASC
              LIMIT 1
            ) historical_actor ON current_actor.npub IS NULL
          ) resolved
          GROUP BY mapped_npub
        ) deduplicated
      ) AS participant_npubs
      FROM flightdeck_pg_channels channel
      WHERE channel.participant_npubs IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM unnest(channel.participant_npubs) participant(npub)
          JOIN flightdeck_pg_actor_identity_history history ON history.npub = participant.npub
          WHERE NOT EXISTS (
            SELECT 1 FROM flightdeck_pg_actors current_actor WHERE current_actor.npub = participant.npub
          )
        )
    )
    UPDATE flightdeck_pg_channels channel
    SET participant_npubs = canonicalized.participant_npubs,
        updated_at = NOW()
    FROM canonicalized
    WHERE channel.id = canonicalized.id
      AND channel.participant_npubs IS DISTINCT FROM canonicalized.participant_npubs
  `);

  // Keep the runtime migration byte-for-byte aligned with the bootstrap schema.
  // This block is additive in v1 and can safely run on every startup.
  await sql.unsafe(wappActivityPublishingV1Sql());

  const recordDeltaSchema = readFileSync(new URL('./001_init.sql', import.meta.url), 'utf8');
  await sql.unsafe(recordDeltaSchema.split('-- flightdeck_record_delta_v1')[1]!.split('-- end_flightdeck_record_delta_v1')[0]!);

  // Git authority v1 is additive and schema-owned here so existing Tower
  // databases receive the same constraints as fresh bootstrap databases.
  await sql.unsafe(gitAuthorityV1Sql());
  // Repository-derived capabilities are intentionally not bound to a service;
  // the gateway supplies the actual smart-HTTP service at introspection time.
  await sql.unsafe(`ALTER TABLE git_capabilities ALTER COLUMN git_service DROP NOT NULL`);
  await sql.unsafe(`
    ALTER TABLE git_forgejo_actor_aliases
    ADD COLUMN IF NOT EXISTS forgejo_user_id BIGINT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_git_forgejo_actor_aliases_provider_user
      ON git_forgejo_actor_aliases(forgejo_user_id) WHERE forgejo_user_id IS NOT NULL;
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS tower_metadata (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      tower_name TEXT,
      tower_description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
