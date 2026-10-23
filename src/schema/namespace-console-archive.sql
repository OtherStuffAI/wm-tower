-- Console presentation state only. Deliberately no FK cascade or runtime flag.
CREATE TABLE IF NOT EXISTS namespace_console_archives (
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  archived BOOLEAN NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  changed_by_npub TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_owner_npub, app_npub)
);
-- Durable exact-request receipts allow lost-response retries without repeating a change.
CREATE TABLE IF NOT EXISTS namespace_console_archive_receipts (
  token_hash TEXT PRIMARY KEY,
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  actor_npub TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('archive', 'restore')),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
