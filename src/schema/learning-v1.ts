export const learningV1Sql = `
CREATE TABLE IF NOT EXISTS learning_curriculum_versions (
  corpus TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  reviewed_at DATE NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status = 'reviewed'),
  PRIMARY KEY (corpus, version)
);
CREATE TABLE IF NOT EXISTS learning_curriculum_concepts (
  corpus TEXT NOT NULL,
  version TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  objective TEXT NOT NULL,
  source TEXT NOT NULL,
  prompt TEXT NOT NULL,
  alternate_prompt TEXT NOT NULL,
  recall_prompt TEXT NOT NULL,
  rubric JSONB NOT NULL,
  PRIMARY KEY (corpus, version, id),
  FOREIGN KEY (corpus, version) REFERENCES learning_curriculum_versions(corpus, version)
);
ALTER TABLE learning_curriculum_concepts ADD COLUMN IF NOT EXISTS alternate_prompt TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS learning_curriculum_prerequisites (
  corpus TEXT NOT NULL,
  version TEXT NOT NULL,
  prerequisite_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  PRIMARY KEY (corpus, version, prerequisite_id, concept_id),
  FOREIGN KEY (corpus, version, prerequisite_id) REFERENCES learning_curriculum_concepts(corpus, version, id),
  FOREIGN KEY (corpus, version, concept_id) REFERENCES learning_curriculum_concepts(corpus, version, id)
);
CREATE TABLE IF NOT EXISTS learning_profiles (
  learner_npub TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learning_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_npub TEXT NOT NULL REFERENCES learning_profiles(learner_npub),
  grantee_npub TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('guardian','agent','reviewer')),
  can_read BOOLEAN NOT NULL DEFAULT true,
  can_write BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (learner_npub, grantee_npub, role)
);
CREATE INDEX IF NOT EXISTS learning_delegations_grantee ON learning_delegations(grantee_npub) WHERE revoked_at IS NULL;
ALTER TABLE learning_delegations DROP CONSTRAINT IF EXISTS learning_delegations_role_check;
ALTER TABLE learning_delegations ADD CONSTRAINT learning_delegations_role_check CHECK (role IN ('guardian','agent','reviewer'));
CREATE TABLE IF NOT EXISTS learning_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_npub TEXT NOT NULL REFERENCES learning_profiles(learner_npub),
  goal TEXT NOT NULL,
  corpus TEXT NOT NULL,
  curriculum_version TEXT NOT NULL,
  milestones JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learning_plans_latest ON learning_plans(learner_npub, created_at DESC);
CREATE TABLE IF NOT EXISTS learning_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_npub TEXT NOT NULL REFERENCES learning_profiles(learner_npub),
  concept TEXT NOT NULL,
  corpus TEXT NOT NULL,
  curriculum_version TEXT NOT NULL,
  frame TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learning_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_npub TEXT NOT NULL REFERENCES learning_profiles(learner_npub),
  concept TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assessment','recall')),
  corpus TEXT NOT NULL,
  curriculum_version TEXT NOT NULL,
  prompt TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS learning_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_npub TEXT NOT NULL REFERENCES learning_profiles(learner_npub),
  attempt_id UUID NOT NULL UNIQUE REFERENCES learning_attempts(id),
  concept TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assessment','recall')),
  corpus TEXT NOT NULL,
  curriculum_version TEXT NOT NULL,
  answer TEXT NOT NULL,
  submitted_by_npub TEXT NOT NULL,
  independent BOOLEAN NOT NULL,
  passed BOOLEAN NOT NULL,
  score NUMERIC NOT NULL,
  rationale JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learning_evidence_learner_concept ON learning_evidence(learner_npub, concept, created_at DESC);
ALTER TABLE learning_evidence ADD COLUMN IF NOT EXISTS submitted_by_npub TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS learning_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_npub TEXT NOT NULL REFERENCES learning_profiles(learner_npub),
  evidence_id UUID NOT NULL REFERENCES learning_evidence(id),
  reviewer_npub TEXT NOT NULL,
  approved BOOLEAN NOT NULL,
  rationale TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (evidence_id, reviewer_npub)
);
CREATE OR REPLACE FUNCTION learning_evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'learning evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS learning_evidence_no_mutation ON learning_evidence;
CREATE TRIGGER learning_evidence_no_mutation BEFORE UPDATE OR DELETE ON learning_evidence
FOR EACH ROW EXECUTE FUNCTION learning_evidence_append_only();
DROP TRIGGER IF EXISTS learning_reviews_no_mutation ON learning_reviews;
CREATE TRIGGER learning_reviews_no_mutation BEFORE UPDATE OR DELETE ON learning_reviews
FOR EACH ROW EXECUTE FUNCTION learning_evidence_append_only();
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['learning_profiles','learning_delegations','learning_plans','learning_lessons','learning_attempts','learning_evidence','learning_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS learning_profiles_scope ON learning_profiles;
CREATE POLICY learning_profiles_scope ON learning_profiles USING (
  learner_npub = current_setting('app.learning_actor_npub', true)
  OR learner_npub = current_setting('app.learning_learner_npub', true)
) WITH CHECK (learner_npub = current_setting('app.learning_actor_npub', true));
DROP POLICY IF EXISTS learning_delegations_scope ON learning_delegations;
CREATE POLICY learning_delegations_scope ON learning_delegations USING (
  learner_npub = current_setting('app.learning_actor_npub', true)
  OR grantee_npub = current_setting('app.learning_actor_npub', true)
) WITH CHECK (learner_npub = current_setting('app.learning_actor_npub', true));
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['learning_plans','learning_lessons','learning_attempts','learning_evidence','learning_reviews'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS learning_learner_scope ON %I', t);
    EXECUTE format('CREATE POLICY learning_learner_scope ON %I USING (learner_npub = current_setting(''app.learning_learner_npub'', true)) WITH CHECK (learner_npub = current_setting(''app.learning_learner_npub'', true))', t);
  END LOOP;
END $$;
`;
