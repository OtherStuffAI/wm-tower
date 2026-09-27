import { Hono } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { getDb } from '../db';
import { CORPUS, VERSION, REVIEWED_AT, walk, score } from '../learning/curriculum';
import { readCurriculum } from '../learning/storage';
import { deriveMastery } from '../learning/state';
import { mayReviewEvidence, selectLearner } from '../learning/authorization';
import { researchRouter } from './learning-research';
import { readResearchGraph } from '../learning/research-storage';
import { RESEARCH_CORPUS } from '../learning/research-graph';

export const learningRouter = new Hono();
learningRouter.route('/research', researchRouter);
type Sql = any;

class LearningError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message: string) { super(message); }
}
const fail = (status: LearningError['status'], code: string, message: string): never => { throw new LearningError(status, code, message); };
const concept = async (id: string) => (await readCurriculum(getDb())).find(c => c.id === id) ?? fail(404, 'concept_not_found', 'Reviewed concept not found');
const validNpub = (value: unknown) => typeof value === 'string' && /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value);

async function withActor<T>(actor: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  return getDb().begin(async tx => {
    const sql = tx as Sql;
    await sql`SET LOCAL ROLE tower_learning_rls_v1`;
    await sql`SELECT set_config('row_security', 'on', true)`;
    await sql`SELECT set_config('app.learning_actor_npub', ${actor}, true)`;
    await sql`SELECT set_config('app.learning_learner_npub', '', true)`;
    return fn(sql);
  }) as Promise<T>;
}

async function withLearner<T>(actor: string, write: boolean, fn: (sql: Sql, learner: string) => Promise<T>, grantId?: string): Promise<T> {
  return withActor(actor, async sql => {
    if (grantId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(grantId)) throw new LearningError(403, 'learner_forbidden', 'Delegation unavailable for this action');
      const grants = await sql`SELECT learner_npub, grantee_npub, can_read, can_write, revoked_at
        FROM learning_delegations WHERE id = ${grantId} AND grantee_npub = ${actor}`;
      const delegated = selectLearner(actor, false, grants, write);
      if (!delegated || delegated === 'ambiguous') throw new LearningError(403, 'learner_forbidden', 'Delegation unavailable for this action');
      await sql`SELECT set_config('app.learning_learner_npub', ${delegated}, true)`;
      return fn(sql, delegated);
    }
    const own = await sql`SELECT learner_npub FROM learning_profiles WHERE learner_npub = ${actor}`;
    const grants = own.length ? [] : await sql`
      SELECT learner_npub, grantee_npub, can_read, can_write, revoked_at
      FROM learning_delegations WHERE grantee_npub = ${actor} ORDER BY learner_npub
    `;
    const learner = selectLearner(actor, own.length > 0, grants, write);
    if (learner === 'ambiguous') throw new LearningError(409, 'ambiguous_learner', 'Multiple grants require a learner-bound session');
    if (!learner) throw new LearningError(403, 'learner_forbidden', 'No learner profile or active delegation');
    await sql`SELECT set_config('app.learning_learner_npub', ${learner}, true)`;
    return fn(sql, learner);
  });
}

function route(handler: (c: any, actor: string) => Promise<unknown>, status = 200) {
  return async (c: any) => {
    const auth = await requireNip98AuthResolved(c);
    if (auth instanceof Response) return auth;
    try { return c.json(await handler(c, auth.userNpub), status); }
    catch (error) {
      if (error instanceof LearningError) return c.json({ error: error.message, code: error.code }, error.status);
      console.error('learning route failed', error);
      return c.json({ error: 'Learning service unavailable', code: 'learning_unavailable' }, 503);
    }
  };
}

async function body(c: any, allowed: string[]) {
  const value = await c.req.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body', 'JSON object required');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(400, 'invalid_body', `Unexpected field: ${key}`);
  return value as Record<string, unknown>;
}
const requiredText = (value: unknown, name: string) => typeof value === 'string' && value.trim() && value.length <= 5000 ? value.trim() : fail(400, 'invalid_body', `${name} required`);
const grantId = (c: any) => c.req.header('x-learning-grant-id') || undefined;

learningRouter.get('/curriculum', route(async () => {
  const nodes = await readCurriculum(getDb());
  return { corpus: CORPUS, version: VERSION, reviewedAt: REVIEWED_AT, reviewStatus: 'reviewed', concepts: nodes.map(({ rubric: _rubric, prompt: _prompt, altPrompt: _alt, recallPrompt: _recall, ...c }) => c), edges: nodes.flatMap(c => c.prerequisites.map(from => ({ from, to: c.id, type: 'prerequisite' }))) };
}));
learningRouter.get('/curriculum/traverse', route(async c => walk(requiredText(c.req.query('goal'), 'goal'), await readCurriculum(getDb()))));

learningRouter.post('/profile', route(async (_c, actor) => withActor(actor, async sql => {
  await sql`INSERT INTO learning_profiles (learner_npub) VALUES (${actor}) ON CONFLICT DO NOTHING`;
  return { learnerNpub: actor };
}), 201));

learningRouter.post('/delegations', route(async (c, actor) => {
  const input = await body(c, ['granteeNpub', 'role', 'canWrite']);
  if (!validNpub(input.granteeNpub) || !['guardian', 'agent', 'reviewer'].includes(String(input.role)) || typeof input.canWrite !== 'boolean') fail(400, 'invalid_body', 'Valid granteeNpub, role and canWrite required');
  return withActor(actor, async sql => {
    const own = await sql`SELECT 1 FROM learning_profiles WHERE learner_npub = ${actor}`;
    if (!own.length) fail(403, 'learner_forbidden', 'Only the learner can grant access');
    const rows = await sql`
      INSERT INTO learning_delegations (learner_npub, grantee_npub, role, can_write)
      VALUES (${actor}, ${input.granteeNpub}, ${input.role}, ${input.canWrite})
      ON CONFLICT (learner_npub, grantee_npub, role) DO UPDATE
      SET can_write = EXCLUDED.can_write, revoked_at = NULL
      RETURNING id, grantee_npub, role, can_read, can_write, created_at
    `;
    return { delegation: rows[0] };
  });
}, 201));

learningRouter.post('/delegations/:id/revoke', route(async (c, actor) => withActor(actor, async sql => {
  const rows = await sql`UPDATE learning_delegations SET revoked_at = now() WHERE id = ${c.req.param('id')} AND learner_npub = ${actor} AND revoked_at IS NULL RETURNING id`;
  if (!rows.length) fail(404, 'delegation_not_found', 'Delegation not found');
  return { revoked: true };
})));

learningRouter.post('/plans', route(async (c, actor) => {
  const input = await body(c, ['goal']); const goal = requiredText(input.goal, 'goal');
  const path = walk(goal, await readCurriculum(getDb()));
  if (!path.valid) fail(400, 'invalid_graph', 'Goal has missing or cyclic prerequisites');
  return withLearner(actor, true, async (sql, learner) => {
    const rows = await sql`INSERT INTO learning_plans (learner_npub, goal, corpus, curriculum_version, milestones)
      VALUES (${learner}, ${goal}, ${CORPUS}, ${VERSION}, ${sql.json(path.order)}) RETURNING *`;
    return { plan: rows[0] };
  }, grantId(c));
}, 201));

learningRouter.get('/plans/current', route(async (c, actor) => withLearner(actor, false, async (sql, learner) => {
  const rows = await sql`SELECT * FROM learning_plans WHERE learner_npub = ${learner} ORDER BY created_at DESC, id DESC LIMIT 1`;
  if (!rows.length) fail(404, 'plan_not_found', 'No plan yet');
  return { plan: rows[0] };
}, grantId(c))));

learningRouter.post('/lessons', route(async (c, actor) => {
  const input = await body(c, ['concept', 'frame']);
  const node = await concept(requiredText(input.concept, 'concept'));
  const frame = input.frame === undefined ? null : requiredText(input.frame, 'frame').slice(0, 200);
  const content = `${node.title}. ${node.explanation} Try explaining this in your own words. ${frame ? `Example frame: ${frame}. ` : ''}Source: ${node.source}`;
  return withLearner(actor, true, async (sql, learner) => {
    const rows = await sql`INSERT INTO learning_lessons (learner_npub, concept, corpus, curriculum_version, frame, content)
      VALUES (${learner}, ${node.id}, ${CORPUS}, ${VERSION}, ${frame}, ${content}) RETURNING *`;
    return { lesson: rows[0] };
  }, grantId(c));
}, 201));

learningRouter.get('/lessons/:id', route(async (c, actor) => withLearner(actor, false, async (sql, learner) => {
  const rows = await sql`SELECT * FROM learning_lessons WHERE id = ${c.req.param('id')} AND learner_npub = ${learner}`;
  if (!rows.length) fail(404, 'lesson_not_found', 'Lesson not found');
  return { lesson: rows[0] };
}, grantId(c))));

async function evidenceRows(sql: Sql, learner: string) {
  return sql`SELECT e.concept, e.kind, e.passed, e.independent, COALESCE(r.approved, false) AS reviewed, e.created_at
    FROM learning_evidence e LEFT JOIN LATERAL (
      SELECT approved FROM learning_reviews WHERE evidence_id = e.id ORDER BY created_at DESC, id DESC LIMIT 1
    ) r ON true WHERE e.learner_npub = ${learner} ORDER BY e.created_at, e.id`;
}

learningRouter.get('/mastery', route(async (c, actor) => withLearner(actor, false, async (sql, learner) => ({ mastery: deriveMastery(await evidenceRows(sql, learner)) }), grantId(c))));
learningRouter.post('/views', route(async (c, actor) => {
  const input = await body(c, ['id', 'concept', 'kind', 'lessonId']);
  const id = requiredText(input.id, 'id'), conceptId = requiredText(input.concept, 'concept');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !['lesson','revision'].includes(String(input.kind))) fail(400, 'invalid_body', 'UUID id and lesson or revision kind required');
  const graph = await readResearchGraph(getDb());
  if (!graph.graph.concepts.some(x => x.id === conceptId) && !(await readCurriculum(getDb())).some(x => x.id === conceptId)) fail(404, 'concept_not_found', 'Concept not found');
  return withLearner(actor, true, async (sql, learner) => {
    const lessonId = input.lessonId ?? null;
    if (lessonId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lessonId)) fail(400, 'invalid_body', 'Valid lessonId UUID required');
    if (input.kind === 'lesson' && !lessonId) fail(400, 'invalid_body', 'lessonId required for a lesson view');
    if (lessonId) {
      const lesson = await sql`SELECT id FROM learning_lessons WHERE id = ${lessonId} AND learner_npub = ${learner} AND concept = ${conceptId}`;
      if (!lesson.length) fail(404, 'lesson_not_found', 'Lesson not found for learner and concept');
    }
    const rows = await sql`INSERT INTO learning_views (id, learner_npub, concept, kind, lesson_id, viewed_by_npub)
      VALUES (${id}, ${learner}, ${conceptId}, ${input.kind}, ${lessonId}, ${actor}) ON CONFLICT (id) DO NOTHING RETURNING id, concept, kind, created_at`;
    if (rows.length) return { view: rows[0], idempotent: false };
    const prior = await sql`SELECT id, concept, kind, created_at FROM learning_views WHERE id = ${id} AND learner_npub = ${learner} AND concept = ${conceptId} AND kind = ${input.kind} AND lesson_id IS NOT DISTINCT FROM ${lessonId}::uuid AND viewed_by_npub = ${actor}`;
    if (!prior.length) fail(409, 'view_conflict', 'View ID used for another event');
    return { view: prior[0], idempotent: true };
  }, grantId(c));
}, 201));
learningRouter.get('/overlay', route(async (c, actor) => withLearner(actor, false, async (sql, learner) => {
  const graph = await readResearchGraph(getDb(), c.req.query('version') || undefined);
  const views = await sql`SELECT concept, kind, count(*)::int AS count, min(created_at) AS first_at, max(created_at) AS last_at
    FROM learning_views WHERE learner_npub = ${learner} GROUP BY concept, kind`;
  const evidence = await evidenceRows(sql, learner);
  const mastery = new Map(deriveMastery(evidence).map(x => [x.concept, x]));
  const concepts = graph.graph.concepts.map(node => {
    const v = views.filter((row: any) => row.concept === node.id);
    const lessonViews = Number(v.find((row: any) => row.kind === 'lesson')?.count ?? 0);
    const revisionViews = Number(v.find((row: any) => row.kind === 'revision')?.count ?? 0);
    const ev = evidence.filter((row: any) => row.concept === node.id);
    const assessments = ev.filter((row: any) => row.kind === 'assessment');
    const recalls = ev.filter((row: any) => row.kind === 'recall');
    const m = mastery.get(node.id);
    const state = m?.state === 'remembered' ? 'remembered' : m?.state === 'demonstrated' ? 'demonstrated' : assessments.length || recalls.length ? 'tested_provisional' : lessonViews + revisionViews > 1 ? 'seen_repeatedly' : lessonViews + revisionViews === 1 ? 'seen_once' : 'unseen';
    return { concept: node.id, state, lessonViews, revisionViews, assessmentCount: assessments.length, recallCount: recalls.length,
      firstViewedAt: v.length ? [...v].map((row: any) => row.first_at).sort((a: any,b: any) => +new Date(a) - +new Date(b))[0] : null,
      lastViewedAt: v.length ? [...v].map((row: any) => row.last_at).sort((a: any,b: any) => +new Date(a) - +new Date(b)).at(-1) : null,
      lastAssessmentAt: assessments.at(-1)?.created_at ?? null, lastRecallAt: recalls.at(-1)?.created_at ?? null,
      dueAt: m?.dueAt ?? null, due: m?.due ?? false };
  });
  return { corpus: RESEARCH_CORPUS, version: graph.version, concepts };
}, grantId(c))));
learningRouter.get('/evidence', route(async (c, actor) => withLearner(actor, false, async (sql, learner) => ({ evidence: await sql`SELECT * FROM learning_evidence WHERE learner_npub = ${learner} ORDER BY created_at, id` }), grantId(c))));
learningRouter.get('/recall/due', route(async (c, actor) => withLearner(actor, false, async (sql, learner) => ({ due: deriveMastery(await evidenceRows(sql, learner)).filter(x => x.due) }), grantId(c))));

async function issue(c: any, actor: string, kind: 'assessment' | 'recall') {
  const input = await body(c, ['concept']);
  const node = await concept(requiredText(input.concept, 'concept'));
  return withLearner(actor, true, async (sql, learner) => {
    const open = await sql`SELECT id FROM learning_attempts WHERE learner_npub = ${learner} AND concept = ${node.id} AND kind = ${kind} AND submitted_at IS NULL LIMIT 1`;
    if (open.length) fail(409, 'attempt_open', 'Submit or complete the existing attempt first');
    if (kind === 'recall') {
      const mastery = deriveMastery(await evidenceRows(sql, learner)).find(x => x.concept === node.id);
      if (!mastery?.due) fail(409, 'recall_not_due', 'Independent delayed recall is not due');
    }
    const count = await sql`SELECT count(*)::int AS n FROM learning_attempts WHERE learner_npub = ${learner} AND concept = ${node.id} AND kind = ${kind}`;
    const prompt = kind === 'recall' ? node.recallPrompt : Number(count[0]?.n ?? 0) % 2 === 0 ? node.prompt : node.altPrompt || node.prompt;
    const rows = await sql`INSERT INTO learning_attempts (learner_npub, concept, kind, corpus, curriculum_version, prompt)
      VALUES (${learner}, ${node.id}, ${kind}, ${CORPUS}, ${VERSION}, ${prompt})
      RETURNING id, concept, kind, corpus, curriculum_version, prompt, issued_at`;
    return { attempt: rows[0] };
  }, grantId(c));
}
learningRouter.post('/assessments', route((c, actor) => issue(c, actor, 'assessment'), 201));
learningRouter.post('/recall', route((c, actor) => issue(c, actor, 'recall'), 201));

async function submit(c: any, actor: string, kind: 'assessment' | 'recall') {
  const input = await body(c, ['answer']); const answer = requiredText(input.answer, 'answer');
  return withLearner(actor, true, async (sql, learner) => {
    const rows = await sql`UPDATE learning_attempts SET submitted_at = now()
      WHERE id = ${c.req.param('id')} AND learner_npub = ${learner} AND kind = ${kind} AND submitted_at IS NULL
      RETURNING *`;
    if (!rows.length) fail(404, 'attempt_not_found', 'Open attempt not found');
    const attempt = rows[0]!; const node = await concept(attempt.concept);
    const result = score(answer, node.rubric);
    const evidence = await sql`INSERT INTO learning_evidence (learner_npub, attempt_id, concept, kind, corpus, curriculum_version, answer, submitted_by_npub, independent, passed, score, rationale)
      VALUES (${learner}, ${attempt.id}, ${node.id}, ${kind}, ${CORPUS}, ${VERSION}, ${answer}, ${actor}, true, ${result.passed}, ${result.score}, ${sql.json({ matched: result.matched, contradictions: result.contradictions, rubricVersion: VERSION, provisional: true })})
      RETURNING id, concept, kind, independent, passed, score, rationale, created_at`;
    const mastery = deriveMastery(await evidenceRows(sql, learner)).find(x => x.concept === node.id);
    return { evidence: evidence[0], mastery };
  }, grantId(c));
}
learningRouter.post('/assessments/:id/submissions', route((c, actor) => submit(c, actor, 'assessment'), 201));
learningRouter.post('/recall/:id/submissions', route((c, actor) => submit(c, actor, 'recall'), 201));

learningRouter.post('/evidence/:id/reviews', route(async (c, actor) => {
  const input = await body(c, ['approved', 'rationale']);
  if (typeof input.approved !== 'boolean') fail(400, 'invalid_body', 'approved boolean required');
  const rationale = requiredText(input.rationale, 'rationale');
  const id = grantId(c);
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) fail(403, 'review_forbidden', 'Reviewer grant required');
  return withActor(actor, async sql => {
    const grants = await sql`SELECT learner_npub FROM learning_delegations
      WHERE id = ${id} AND grantee_npub = ${actor} AND role IN ('reviewer','guardian')
        AND can_read = true AND can_write = true AND revoked_at IS NULL`;
    const learner = grants[0]?.learner_npub;
    if (!learner) fail(403, 'review_forbidden', 'Reviewer grant required');
    await sql`SELECT set_config('app.learning_learner_npub', ${learner}, true)`;
    const evidence = await sql`SELECT id, submitted_by_npub FROM learning_evidence WHERE id = ${c.req.param('id')} AND learner_npub = ${learner}`;
    if (!evidence.length) fail(404, 'evidence_not_found', 'Evidence not found');
    if (!mayReviewEvidence(actor, evidence[0].submitted_by_npub)) fail(403, 'self_review_denied', 'Submission actor cannot review its own evidence');
    const reviews = await sql`INSERT INTO learning_reviews (learner_npub, evidence_id, reviewer_npub, approved, rationale)
      VALUES (${learner}, ${c.req.param('id')}, ${actor}, ${input.approved}, ${rationale})
      ON CONFLICT (evidence_id, reviewer_npub) DO NOTHING RETURNING *`;
    if (!reviews.length) fail(409, 'review_already_exists', 'Reviewer already reviewed this evidence');
    return { review: reviews[0] };
  });
}, 201));
