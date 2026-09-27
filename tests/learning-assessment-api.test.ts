import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import postgres from 'postgres';
import { learningRouter } from '../src/routes/learning';
import { learningV1Sql } from '../src/schema/learning-v1';
import { learningResearchV1Sql } from '../src/schema/learning-research-v1';
import { seedCurriculum } from '../src/learning/storage';
import { seedResearchGraph } from '../src/learning/research-storage';
import { seedAssessmentCards } from '../src/learning/assessment-storage';
import { closeDb, setDb } from '../src/db';

// Opt in only against a local PostgreSQL server. Every row lives in a database
// created for this test and dropped in finally; the serving database is untouched.
test.skipIf(process.env.LEARNING_ASSESSMENT_API_TEST !== '1')('signed non-Moon lesson, assessment, review and delayed recall stay learner-private', async () => {
  const dbName = `tower_assessment_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const options = { host: process.env.LEARNING_RLS_TEST_DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD, max: 3 };
  const admin = postgres({ ...options, database: 'postgres' });
  let sql: ReturnType<typeof postgres> | undefined;
  const app = new Hono().route('/api/v4/learning', learningRouter);
  const secret = (n: number) => new Uint8Array(32).fill(n);
  const learnerKey = secret(41), otherKey = secret(42), reviewerKey = secret(43);
  const learner = nip19.npubEncode(getPublicKey(learnerKey));
  const reviewer = nip19.npubEncode(getPublicKey(reviewerKey));
  const request = async (key: Uint8Array, path: string, input?: object, grant?: string) => {
    const url = `https://tower.test/api/v4/learning${path}`;
    const method = input === undefined ? 'GET' : 'POST';
    const body = input === undefined ? undefined : JSON.stringify(input);
    const tags = [['u', url], ['method', method], ...(body === undefined ? [] : [['payload', createHash('sha256').update(body).digest('hex')]])];
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, key);
    const response = await app.request(url, { method, headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(grant ? { 'x-learning-grant-id': grant } : {}) }, body });
    return { status: response.status, data: await response.json() as any };
  };
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    sql = postgres({ ...options, database: dbName });
    setDb(sql);
    await sql`CREATE TABLE user_workspace_keys (ws_key_npub text PRIMARY KEY, user_npub text NOT NULL, active boolean NOT NULL DEFAULT true, ws_key_epoch integer NOT NULL DEFAULT 1, registered_at timestamptz NOT NULL DEFAULT now())`;
    await sql.unsafe(learningV1Sql);
    await sql.unsafe(learningResearchV1Sql);
    await seedCurriculum(sql);
    await seedResearchGraph(sql);
    await seedAssessmentCards(sql);

    const subjects = await request(learnerKey, '/research/subjects');
    expect(subjects.status).toBe(200);
    expect(subjects.data.concepts.find((c: any) => c.id === 'jupiter')).toMatchObject({ assessable: true, lessonAvailable: true, assessmentVersion: '2026-09-27.1', assessmentGraphVersion: '2026-09-27.1' });
    expect(subjects.data.concepts.find((c: any) => c.id === 'comet-nucleus')).toMatchObject({ assessable: false, lessonAvailable: false, assessmentVersion: null });
    expect((await request(learnerKey, '/profile', {})).status).toBe(201);
    expect((await request(otherKey, '/profile', {})).status).toBe(201);
    expect((await request(learnerKey, '/lessons', { concept: 'comet-nucleus' })).data.code).toBe('assessment_unavailable');
    expect((await request(learnerKey, '/assessments', { concept: 'comet-nucleus' })).data.code).toBe('assessment_unavailable');
    const lesson = await request(learnerKey, '/lessons', { concept: 'jupiter' });
    expect(lesson.status).toBe(201);
    expect(lesson.data.lesson.corpus).toBe('learning.space.assessment.v1');
    expect(lesson.data.lesson.content).toContain('science.nasa.gov/jupiter/');
    expect((await request(otherKey, `/lessons/${lesson.data.lesson.id}`)).status).toBe(404);
    const view = await request(learnerKey, '/views', { id: crypto.randomUUID(), concept: 'jupiter', kind: 'lesson', lessonId: lesson.data.lesson.id });
    expect(view.status).toBe(201);
    const attempt = await request(learnerKey, '/assessments', { concept: 'jupiter' });
    expect(attempt.status).toBe(201);
    expect(attempt.data.attempt.curriculum_version).toBe('2026-09-27.1');
    expect((await request(otherKey, `/assessments/${attempt.data.attempt.id}/submissions`, { answer: 'Jupiter is fifth.' })).status).toBe(404);
    const submitted = await request(learnerKey, `/assessments/${attempt.data.attempt.id}/submissions`, { answer: 'Jupiter occupies position 5 from the Sun, and Ganymede is the largest moon.' });
    expect(submitted.status).toBe(201);
    expect(submitted.data.evidence.rationale.provisional).toBe(true);
    expect(submitted.data.evidence.rationale.graphVersion).toBe('2026-09-27.1');
    expect(submitted.data.evidence.rationale.rubric.length).toBeGreaterThanOrEqual(3);
    expect(submitted.data.evidence.passed).toBe(false); // phrase matcher missed position 5
    expect((await request(learnerKey, '/mastery')).data.mastery.find((m: any) => m.concept === 'jupiter').state).toBe('developing');
    const grant = await request(learnerKey, '/delegations', { granteeNpub: reviewer, role: 'reviewer', canWrite: true });
    expect(grant.status).toBe(201);
    expect((await request(learnerKey, `/evidence/${submitted.data.evidence.id}/reviews`, { approved: true, rationale: 'Self review' }, grant.data.delegation.id)).data.code).toBe('review_forbidden');
    const review = await request(reviewerKey, `/evidence/${submitted.data.evidence.id}/reviews`, { approved: true, rationale: 'Position 5 and Ganymede meet the rubric despite the keyword miss.' }, grant.data.delegation.id);
    expect(review.status).toBe(201);
    expect((await request(learnerKey, '/mastery')).data.mastery.find((m: any) => m.concept === 'jupiter').state).toBe('demonstrated');
    expect((await request(learnerKey, '/recall', { concept: 'jupiter' })).data.code).toBe('recall_not_due');
    // Simulate elapsed wall time only in this disposable database; production
    // evidence remains append-only and no serving rows are changed.
    await sql.unsafe('ALTER TABLE learning_evidence DISABLE TRIGGER learning_evidence_no_mutation');
    await sql`UPDATE learning_evidence SET created_at = now() - interval '25 hours' WHERE id = ${submitted.data.evidence.id}`;
    await sql.unsafe('ALTER TABLE learning_evidence ENABLE TRIGGER learning_evidence_no_mutation');
    expect((await request(learnerKey, '/recall/due')).data.due.some((m: any) => m.concept === 'jupiter')).toBe(true);
    const recall = await request(learnerKey, '/recall', { concept: 'jupiter' });
    expect(recall.status).toBe(201);
    const recalled = await request(learnerKey, `/recall/${recall.data.attempt.id}/submissions`, { answer: 'Jupiter is fifth from the Sun and Ganymede is the largest moon.' });
    expect(recalled.status).toBe(201);
    expect((await request(reviewerKey, `/evidence/${recalled.data.evidence.id}/reviews`, { approved: true, rationale: 'Independent delayed answer meets rubric.' }, grant.data.delegation.id)).status).toBe(201);
    expect((await request(learnerKey, '/mastery')).data.mastery.find((m: any) => m.concept === 'jupiter').state).toBe('remembered');
    expect((await request(otherKey, '/evidence')).data.evidence).toHaveLength(0);
    expect((await request(otherKey, '/overlay')).data.concepts.find((c: any) => c.concept === 'jupiter').state).toBe('unseen');
    await sql`UPDATE learning_curriculum_versions SET content_hash = 'invalid-card-version' WHERE corpus = 'learning.space.assessment.v1'`;
    expect((await request(learnerKey, '/research/subjects')).data.concepts.find((c: any) => c.id === 'jupiter').assessable).toBe(false);
    expect((await request(learnerKey, '/assessments', { concept: 'jupiter' })).data.code).toBe('assessment_unavailable');
  } finally {
    await closeDb();
    if (sql) await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  }
});
