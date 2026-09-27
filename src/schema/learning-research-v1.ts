export const learningResearchV1Sql = `
CREATE TABLE IF NOT EXISTS learning_research_versions (
  corpus TEXT NOT NULL,
  version TEXT NOT NULL,
  parent_version TEXT,
  content_hash TEXT NOT NULL,
  graph JSONB NOT NULL,
  reviewed_by_npub TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (corpus, version),
  UNIQUE (corpus, content_hash)
);
CREATE TABLE IF NOT EXISTS learning_research_candidates (
  id TEXT PRIMARY KEY,
  corpus TEXT NOT NULL,
  base_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  addition JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','reviewed','published')),
  staged_by_npub TEXT NOT NULL,
  staged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by_npub TEXT,
  reviewed_at TIMESTAMPTZ,
  published_version TEXT
);
CREATE INDEX IF NOT EXISTS learning_research_candidates_status ON learning_research_candidates(status, staged_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS learning_research_candidates_dedupe ON learning_research_candidates(corpus, base_version, content_hash);
CREATE OR REPLACE FUNCTION learning_research_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'published research versions are immutable'; END $$;
DROP TRIGGER IF EXISTS learning_research_no_mutation ON learning_research_versions;
CREATE TRIGGER learning_research_no_mutation BEFORE UPDATE OR DELETE ON learning_research_versions
FOR EACH ROW EXECUTE FUNCTION learning_research_version_immutable();
`;
