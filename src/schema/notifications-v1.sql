-- Shared notification inbox v1 (org.wingman.nstack.notifications). Idempotent: safe on fresh and upgraded databases.
-- System singleton: activation time ("empty inbox from activation") and the cursor-signing secret.
CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_system (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cursor_secret TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
INSERT INTO flightdeck_pg_notification_system (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;

-- Registered external producers (flightdeck.core is built in and has no row).
CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_sources (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  source_app_id TEXT NOT NULL CHECK (source_app_id ~ '^[a-z][a-z0-9_.-]{0,63}$' AND source_app_id <> 'flightdeck.core'),
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'app', 'wapp_installation')),
  display_name TEXT NOT NULL,
  producer_signer_npub TEXT NOT NULL,
  grant_status TEXT NOT NULL DEFAULT 'active' CHECK (grant_status IN ('active', 'disabled', 'revoked')),
  grant_version INTEGER NOT NULL DEFAULT 1,
  allowed_recipient_mode TEXT NOT NULL DEFAULT 'actor_list' CHECK (allowed_recipient_mode IN ('actor_list', 'owner_only')),
  allowed_recipient_actor_ids UUID[] NOT NULL DEFAULT '{}',
  allowed_client_apps TEXT[] NOT NULL DEFAULT ARRAY['*'],
  max_severity TEXT NOT NULL DEFAULT 'normal' CHECK (max_severity IN ('low', 'normal', 'high')),
  rate_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (rate_per_minute BETWEEN 1 AND 6000),
  approved_by_actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, source_app_id)
);
-- One signer may serve one source per workspace; a source resolves from the signer alone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_notification_sources_signer
  ON flightdeck_pg_notification_sources (workspace_id, producer_signer_npub);

CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_categories (
  workspace_id UUID NOT NULL,
  source_app_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]{0,63}$'),
  label TEXT NOT NULL,
  default_severity TEXT NOT NULL DEFAULT 'normal' CHECK (default_severity IN ('low', 'normal', 'high')),
  default_inbox TEXT NOT NULL DEFAULT 'on' CHECK (default_inbox IN ('on', 'off')),
  default_alert TEXT NOT NULL DEFAULT 'on' CHECK (default_alert IN ('on', 'off')),
  grouping TEXT NOT NULL DEFAULT 'subject' CHECK (grouping IN ('none', 'subject')),
  PRIMARY KEY (workspace_id, source_app_id, category),
  FOREIGN KEY (workspace_id, source_app_id) REFERENCES flightdeck_pg_notification_sources (workspace_id, source_app_id) ON DELETE CASCADE
);

-- What happened, once. Rule events carry an immutable snapshot of the structured reasons.
CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  source_app_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  op TEXT NOT NULL DEFAULT 'publish' CHECK (op IN ('publish', 'resolve', 'withdraw')),
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'normal',
  subject JSONB NOT NULL DEFAULT '{}'::jsonb,
  recipients JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  audience JSONB NOT NULL DEFAULT '{"client_apps":["*"]}'::jsonb,
  action JSONB,
  group_key TEXT,
  target_event_key TEXT,
  payload_hash TEXT NOT NULL,
  producer_kind TEXT NOT NULL,
  producer_signer_npub TEXT,
  outbox_event_id UUID,
  trigger_actor_id UUID,
  subject_activity_version BIGINT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'projected', 'rejected')),
  recipient_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_app_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_fd_notification_events_created ON flightdeck_pg_notification_events (created_at);

-- Durable projection queue. Rows are created in the SAME transaction as the source write.
CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_intake (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('outbox', 'event')),
  outbox_event_id UUID,
  event_id UUID REFERENCES flightdeck_pg_notification_events(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  resume_after UUID,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at TIMESTAMPTZ,
  CHECK ((kind = 'outbox' AND outbox_event_id IS NOT NULL) OR (kind = 'event' AND event_id IS NOT NULL)),
  UNIQUE (kind, outbox_event_id),
  UNIQUE (kind, event_id)
);
CREATE INDEX IF NOT EXISTS idx_fd_notification_intake_due ON flightdeck_pg_notification_intake (next_attempt_at)
  WHERE state IN ('pending', 'leased');

-- Per-recipient commit-ordered sequence. The row lock serialises writers until commit.
CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_cursors (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  last_seq BIGINT NOT NULL DEFAULT 0,
  tombstone_floor_seq BIGINT NOT NULL DEFAULT 0,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rules_revision BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, actor_id)
);
-- Bumped in the transaction of every rules write (PUT rules and the legacy preference mirror).
ALTER TABLE flightdeck_pg_notification_cursors ADD COLUMN IF NOT EXISTS rules_revision BIGINT NOT NULL DEFAULT 0;

-- What one recipient sees.
CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  recipient_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
  source_app_id TEXT NOT NULL,
  category TEXT NOT NULL,
  reasons TEXT[] NOT NULL,
  severity TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'baseline')),
  group_key TEXT,
  event_count INTEGER NOT NULL DEFAULT 1,
  first_event_id UUID NOT NULL,
  last_event_id UUID NOT NULL,
  trigger_actor_id UUID,
  subject JSONB NOT NULL,
  acl_family TEXT,
  acl_channel_id UUID,
  resource_type TEXT,
  resource_id UUID,
  subject_activity_version BIGINT,
  presentation JSONB NOT NULL,
  action JSONB,
  audience_client_apps TEXT[] NOT NULL DEFAULT ARRAY['*'],
  occurred_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  read_reason TEXT,
  dismissed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  change_seq BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  removal_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_notification_items_seq
  ON flightdeck_pg_notification_items (workspace_id, recipient_actor_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_fd_notification_items_inbox
  ON flightdeck_pg_notification_items (workspace_id, recipient_actor_id, occurred_at DESC, id DESC)
  WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_notification_items_unread
  ON flightdeck_pg_notification_items (workspace_id, recipient_actor_id, category)
  WHERE removed_at IS NULL AND read_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_fd_notification_items_resource
  ON flightdeck_pg_notification_items (workspace_id, recipient_actor_id, resource_type, resource_id)
  WHERE removed_at IS NULL AND read_at IS NULL;
-- Group identity = source + group_key (category/subject/window) + canonical audience, so an item is never folded
-- into one with a different audience set (app-filtered change feeds would otherwise keep a stale visible row).
DROP INDEX IF EXISTS idx_fd_notification_items_open_group;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_notification_items_open_group_aud
  ON flightdeck_pg_notification_items (workspace_id, recipient_actor_id, source_app_id, group_key, audience_client_apps)
  WHERE group_key IS NOT NULL AND removed_at IS NULL AND read_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL;

-- Per-recipient dedupe + replay safety, independent of folding.
CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_item_events (
  event_id UUID NOT NULL REFERENCES flightdeck_pg_notification_events(id) ON DELETE CASCADE,
  recipient_actor_id UUID NOT NULL,
  item_id UUID NOT NULL REFERENCES flightdeck_pg_notification_items(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, recipient_actor_id)
);
CREATE INDEX IF NOT EXISTS idx_fd_notification_item_events_item ON flightdeck_pg_notification_item_events (item_id);

CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_mutations (
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL,
  mutation_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, actor_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_rules (
  workspace_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  source_app_id TEXT NOT NULL DEFAULT '*',
  category TEXT NOT NULL DEFAULT '*',
  client_app_id TEXT NOT NULL DEFAULT '*',
  channel TEXT NOT NULL CHECK (channel IN ('inbox', 'alert')),
  mode TEXT NOT NULL CHECK (mode IN ('on', 'off', 'default')),
  preview TEXT CHECK (preview IN ('generic', 'sender', 'full')),
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, actor_id, source_app_id, category, client_app_id, channel),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);
-- mode 'default' = "inherit": a versioned row that resolves like an absent rule. Rows are never deleted so a stale
-- expected_row_version 0 cannot resurrect an override.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flightdeck_pg_notification_rules_mode_check'
             AND conrelid = 'flightdeck_pg_notification_rules'::regclass AND pg_get_constraintdef(oid) NOT LIKE '%default%') THEN
    ALTER TABLE flightdeck_pg_notification_rules DROP CONSTRAINT flightdeck_pg_notification_rules_mode_check;
    ALTER TABLE flightdeck_pg_notification_rules ADD CONSTRAINT flightdeck_pg_notification_rules_mode_check CHECK (mode IN ('on', 'off', 'default'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS flightdeck_pg_notification_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID,
  source_app_id TEXT,
  signer_npub TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  payload_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fd_notification_audit_created ON flightdeck_pg_notification_audit (created_at);

-- Allocates the next per-recipient change sequence. Call inside the writing transaction.
CREATE OR REPLACE FUNCTION flightdeck_pg_notification_next_seq(w UUID, a UUID) RETURNS BIGINT
LANGUAGE sql AS $$
  INSERT INTO flightdeck_pg_notification_cursors (workspace_id, actor_id, last_seq) VALUES (w, a, 1)
  ON CONFLICT (workspace_id, actor_id) DO UPDATE SET last_seq = flightdeck_pg_notification_cursors.last_seq + 1
  RETURNING last_seq
$$;

-- Canonical lock order for every writer of one recipient's inbox:
--   mutation advisory lock -> this recipient cursor lock -> item rows -> next_seq.
-- Creates the cursor row when absent and takes its row lock until commit. Multi-recipient writers call it in
-- ascending (workspace, actor) order.
CREATE OR REPLACE FUNCTION flightdeck_pg_notification_lock_recipient(w UUID, a UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO flightdeck_pg_notification_cursors (workspace_id, actor_id, last_seq) VALUES (w, a, 0) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM flightdeck_pg_notification_cursors WHERE workspace_id = w AND actor_id = a FOR UPDATE;
END $$;

-- Client-app view predicate (presentation filter, never access authority). NULL client = no app filtering.
-- Visible to C iff audience has '*' or C and the most specific inbox rule for (source, category, C) is not 'off':
-- level (src,cat) > (src,*) > (*,cat) > (*,*); within a level client_app_id=C beats '*'. Mode 'default' is inherited.
CREATE OR REPLACE FUNCTION flightdeck_pg_notification_item_visible(w UUID, a UUID, src TEXT, cat TEXT, aud TEXT[], c TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT c IS NULL OR (
    ('*' = ANY(aud) OR c = ANY(aud)) AND COALESCE((
      SELECT r.mode <> 'off' FROM flightdeck_pg_notification_rules r
      WHERE r.workspace_id = w AND r.actor_id = a AND r.channel = 'inbox' AND r.mode IN ('on', 'off')
        AND r.source_app_id IN (src, '*') AND r.category IN (cat, '*') AND r.client_app_id IN (c, '*')
      ORDER BY (CASE WHEN r.source_app_id = src THEN 0 ELSE 2 END) + (CASE WHEN r.category = cat THEN 0 ELSE 1 END),
               (CASE WHEN r.client_app_id = c THEN 0 ELSE 1 END), (CASE WHEN r.mode = 'off' THEN 0 ELSE 1 END)
      LIMIT 1
    ), TRUE)
  )
$$;

-- Content-free, actor-private hint for events/stream. Never carries title/body.
CREATE OR REPLACE FUNCTION flightdeck_pg_notification_emit_hint(w UUID, a UUID, item UUID, seq BIGINT, op TEXT) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO flightdeck_pg_outbox_events (workspace_id, event_type, entity_type, entity_id, operation, payload)
  VALUES (w, 'flightdeck_pg.notification_item.changed', 'notification_item', item, 'changed',
    jsonb_build_object('recipient_actor_id', a, 'change_seq', seq, 'operation', op))
$$;

-- Transactional intake for Tower-internal rules. Only structured event types are captured.
CREATE OR REPLACE FUNCTION flightdeck_pg_notification_intake_capture() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type IN (
    'flightdeck_pg.message.created', 'flightdeck_pg.message.revised', 'flightdeck_pg.task_comment.created',
    'flightdeck_pg.doc_comment.created', 'flightdeck_pg.task_assignment.assigned',
    'flightdeck_pg.task.created', 'flightdeck_pg.task.updated', 'flightdeck_pg.document_mention_added'
  ) THEN
    INSERT INTO flightdeck_pg_notification_intake (workspace_id, kind, outbox_event_id)
    VALUES (NEW.workspace_id, 'outbox', NEW.id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fd_notification_intake_capture ON flightdeck_pg_outbox_events;
CREATE TRIGGER fd_notification_intake_capture AFTER INSERT ON flightdeck_pg_outbox_events
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_notification_intake_capture();

-- Resource viewed -> derived read. Uses the OBSERVED watermark written by the viewer, never the head.
CREATE OR REPLACE FUNCTION flightdeck_pg_notification_view_bridge() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD; s BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.viewed_activity_version <= OLD.viewed_activity_version THEN RETURN NEW; END IF;
  -- Recipient lock first: serialises with projection (born-read decision) and every other inbox writer.
  PERFORM flightdeck_pg_notification_lock_recipient(NEW.workspace_id, NEW.viewer_actor_id);
  FOR r IN
    SELECT id FROM flightdeck_pg_notification_items
    WHERE workspace_id = NEW.workspace_id AND recipient_actor_id = NEW.viewer_actor_id
      AND resource_type = NEW.resource_type AND resource_id = NEW.resource_id
      AND removed_at IS NULL AND status = 'active' AND read_at IS NULL
      AND subject_activity_version IS NOT NULL AND subject_activity_version <= NEW.viewed_activity_version
    ORDER BY id FOR UPDATE
  LOOP
    s := flightdeck_pg_notification_next_seq(NEW.workspace_id, NEW.viewer_actor_id);
    UPDATE flightdeck_pg_notification_items
    SET read_at = NOW(), read_reason = 'subject_viewed', row_version = row_version + 1, change_seq = s, updated_at = NOW()
    WHERE id = r.id;
    PERFORM flightdeck_pg_notification_emit_hint(NEW.workspace_id, NEW.viewer_actor_id, r.id, s, 'state');
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fd_notification_view_bridge ON flightdeck_pg_resource_view_states;
CREATE TRIGGER fd_notification_view_bridge AFTER INSERT OR UPDATE OF viewed_activity_version ON flightdeck_pg_resource_view_states
  FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_notification_view_bridge();
