import { Hono } from 'hono';
import { requireNip98AuthResolved } from '../auth';
import { getDb } from '../db';
import { RESEARCH_CORPUS, SEED_VERSION, boundedWalk, graphHash, graphIssues, mergeGraph, type ResearchGraph } from '../learning/research-graph';
import { readResearchGraph } from '../learning/research-storage';
import { ASSESSMENT_CORPUS, ASSESSMENT_VERSION, availableCard } from '../learning/assessment-cards';
import { readCurriculum } from '../learning/storage';
import { CORPUS as LEGACY_ASSESSMENT_CORPUS, VERSION as LEGACY_ASSESSMENT_VERSION } from '../learning/curriculum';
import { assessmentVersionReady } from '../learning/assessment-storage';

export const researchRouter = new Hono();
class ResearchError extends Error { constructor(public status: 400 | 403 | 404 | 409, public code: string, message: string, public issues?: string[]) { super(message); } }
const fail = (status: ResearchError['status'], code: string, message: string, issues?: string[]): never => { throw new ResearchError(status, code, message, issues); };
const curator = (actor: string) => { if (!new Set((process.env.LEARNING_CURATOR_NPUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)).has(actor)) fail(403, 'curator_forbidden', 'Explicit research curator authority required'); };
const validId = (id: unknown) => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 120;
const validVersion = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/.test(value);
const json = async (c: any) => { const value = await c.req.json().catch(() => null); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body', 'JSON object required'); return value as Record<string, any>; };
const route = (handler: (c: any, actor: string) => Promise<unknown>, status = 200) => async (c: any) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  try { return c.json(await handler(c, auth.userNpub), status); }
  catch (error) {
    if (error instanceof ResearchError) return c.json({ code: error.code, error: error.message, ...(error.issues ? { issues: error.issues } : {}) }, error.status);
    if (error instanceof Error && error.message === 'graph_version_not_found') return c.json({ code: 'graph_version_not_found', error: 'Published graph version not found' }, 404);
    if ((error as any)?.code === '23505') return c.json({ code: 'candidate_or_version_conflict', error: 'Candidate content or version already exists' }, 409);
    console.error('research graph route failed', error);
    return c.json({ code: 'learning_unavailable', error: 'Research graph unavailable' }, 503);
  }
};
const version = (c: any) => c.req.query('version') || undefined;
const published = (c: any) => readResearchGraph(getDb(), version(c));
const graphResult = (snapshot: Awaited<ReturnType<typeof readResearchGraph>>, extra: object) => ({ corpus: RESEARCH_CORPUS, version: snapshot.version, contentHash: snapshot.contentHash, reviewedAt: snapshot.reviewedAt, ...extra });

researchRouter.get('/subjects', route(async c => {
  const snapshot = await published(c);
  const [seed, assessmentReady] = await Promise.all([readResearchGraph(getDb(), SEED_VERSION), assessmentVersionReady(getDb())]);
  const legacy = new Set((await readCurriculum(getDb())).map(node => node.id));
  const clusters = [...new Set(snapshot.graph.concepts.map(x => x.cluster))].sort().map(id => ({ id, conceptCount: snapshot.graph.concepts.filter(x => x.cluster === id).length }));
  const concepts = snapshot.graph.concepts.map(node => {
    const card = assessmentReady ? availableCard(node.id, snapshot.graph, seed.contentHash) : undefined;
    const assessable = Boolean(card || legacy.has(node.id) && snapshot.graph.supports.some(s => s.targetType === 'concept' && s.targetId === node.id));
    return { ...node, assessable, lessonAvailable: assessable,
      assessmentCorpus: card ? ASSESSMENT_CORPUS : assessable ? LEGACY_ASSESSMENT_CORPUS : null,
      assessmentVersion: card ? ASSESSMENT_VERSION : assessable ? LEGACY_ASSESSMENT_VERSION : null,
      assessmentGraphVersion: card ? card.graphVersion : null };
  });
  return graphResult(snapshot, { clusters, concepts });
}));
researchRouter.get('/concepts/:id/neighbourhood', route(async c => {
  const snapshot = await published(c), id = c.req.param('id');
  if (!snapshot.graph.concepts.some(x => x.id === id)) fail(404, 'concept_not_found', 'Published concept not found');
  const relationIds = snapshot.graph.relations.filter(r => r.from === id || r.to === id);
  const ids = new Set([id, ...relationIds.flatMap(r => [r.from, r.to])]);
  return graphResult(snapshot, { center: id, concepts: snapshot.graph.concepts.filter(x => ids.has(x.id)), relations: relationIds });
}));
researchRouter.get('/concepts/:id/walk', route(async c => {
  const snapshot = await published(c), depth = Number(c.req.query('depth') ?? 2), limit = Number(c.req.query('limit') ?? 50);
  try { return graphResult(snapshot, { start: c.req.param('id'), depth, limit, ...boundedWalk(snapshot.graph, c.req.param('id'), depth, limit) }); }
  catch (error) { if ((error as Error).message === 'concept_not_found') fail(404, 'concept_not_found', 'Published concept not found'); fail(400, 'invalid_bounds', 'depth must be 0–4 and limit 1–100'); }
}));
researchRouter.get('/concepts/:id/sources', route(async c => {
  const snapshot = await published(c), id = c.req.param('id');
  if (!snapshot.graph.concepts.some(x => x.id === id)) fail(404, 'concept_not_found', 'Published concept not found');
  const relationIds = new Set(snapshot.graph.relations.filter(r => r.from === id || r.to === id).map(r => r.id));
  const supports = snapshot.graph.supports.filter(s => s.targetType === 'concept' && s.targetId === id || s.targetType === 'relation' && relationIds.has(s.targetId));
  const sourceIds = new Set(supports.map(s => s.sourceId));
  return graphResult(snapshot, { concept: id, sources: snapshot.graph.sources.filter(s => sourceIds.has(s.id)), supports });
}));

researchRouter.get('/candidates/:id', route(async (c, actor) => {
  curator(actor);
  const rows = await getDb()`SELECT * FROM learning_research_candidates WHERE id = ${c.req.param('id')} AND corpus = ${RESEARCH_CORPUS}`;
  if (!rows.length) fail(404, 'candidate_not_found', 'Candidate not found');
  return { candidate: rows[0] };
}));
researchRouter.post('/candidates', route(async (c, actor) => {
  curator(actor);
  const input = await json(c);
  if (!validId(input.id) || !validVersion(input.baseVersion) || !input.addition || typeof input.addition !== 'object' || !['sources','concepts','relations','supports'].every(k => Array.isArray(input.addition[k]))) fail(400, 'invalid_body', 'id, baseVersion and addition arrays required');
  const addition = input.addition as ResearchGraph;
  if (!Object.values(addition).every(value => Array.isArray(value) && value.every(row => row && typeof row === 'object' && !Array.isArray(row)))) fail(400, 'invalid_body', 'Addition arrays must contain objects');
  if (JSON.stringify(addition).length > 200_000) fail(400, 'invalid_body', 'Candidate too large');
  const hash = graphHash(addition), snapshot = await readResearchGraph(getDb(), input.baseVersion);
  // Reject invalid additions before they acquire a durable candidate ID.
  let issues: string[];
  try { issues = graphIssues(mergeGraph(snapshot.graph, addition)); }
  catch (error) { issues = [(error as Error).message]; }
  if (issues.length) fail(409, 'invalid_graph', 'Candidate has provenance or graph errors', issues);
  const duplicate = await getDb()`SELECT id FROM learning_research_candidates WHERE corpus = ${RESEARCH_CORPUS} AND base_version = ${input.baseVersion} AND content_hash = ${hash} AND id <> ${input.id}`;
  if (duplicate.length) fail(409, 'candidate_duplicate', `Identical candidate already staged as ${duplicate[0].id}`);
  const rows = await getDb()`INSERT INTO learning_research_candidates (id, corpus, base_version, content_hash, addition, staged_by_npub)
    VALUES (${input.id}, ${RESEARCH_CORPUS}, ${input.baseVersion}, ${hash}, ${getDb().json(addition)}, ${actor})
    ON CONFLICT (id) DO NOTHING RETURNING *`;
  if (!rows.length) {
    const existing = await getDb()`SELECT * FROM learning_research_candidates WHERE id = ${input.id}`;
    if (existing[0]?.content_hash !== hash || existing[0]?.base_version !== input.baseVersion || existing[0]?.staged_by_npub !== actor) fail(409, 'candidate_conflict', 'Candidate ID already used for different content or curator');
    return { candidate: existing[0], issues, idempotent: true };
  }
  return { candidate: rows[0], issues, idempotent: false };
}, 201));
researchRouter.post('/candidates/:id/review', route(async (c, actor) => {
  curator(actor);
  return getDb().begin(async tx => {
    const sql = tx as any;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${RESEARCH_CORPUS}))`;
    const rows = await sql`SELECT * FROM learning_research_candidates WHERE id = ${c.req.param('id')} AND corpus = ${RESEARCH_CORPUS} FOR UPDATE`;
    const candidate = rows[0]; if (!candidate) fail(404, 'candidate_not_found', 'Candidate not found');
    if (candidate.staged_by_npub === actor) fail(403, 'self_review_denied', 'Staging curator cannot review own candidate');
    if (candidate.status !== 'staged') fail(409, 'candidate_already_reviewed', 'Candidate already reviewed');
    const latest = await readResearchGraph(sql);
    if (candidate.base_version !== latest.version) fail(409, 'stale_base_version', 'Stage against current published version');
    let merged: ResearchGraph;
    try { merged = mergeGraph(latest.graph, candidate.addition); }
    catch (error) { fail(409, 'identifier_conflict', (error as Error).message); }
    const issues = graphIssues(merged!);
    if (issues.length) fail(409, 'invalid_graph', 'Candidate has provenance or graph errors', issues);
    if (graphHash(merged!) === latest.contentHash) fail(409, 'empty_candidate', 'Candidate adds no published content');
    const updated = await sql`UPDATE learning_research_candidates SET status = 'reviewed', reviewed_by_npub = ${actor}, reviewed_at = now() WHERE id = ${candidate.id} RETURNING *`;
    return { candidate: updated[0], mergedContentHash: graphHash(merged!) };
  });
}));
researchRouter.post('/candidates/:id/publish', route(async (c, actor) => {
  curator(actor);
  const input = await json(c);
  if (!validVersion(input.version)) fail(400, 'invalid_body', 'Date sequence version required');
  return getDb().begin(async tx => {
    const sql = tx as any;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${RESEARCH_CORPUS}))`;
    const rows = await sql`SELECT * FROM learning_research_candidates WHERE id = ${c.req.param('id')} AND corpus = ${RESEARCH_CORPUS} FOR UPDATE`;
    const candidate = rows[0]; if (!candidate) fail(404, 'candidate_not_found', 'Candidate not found');
    if (candidate.status === 'published' && candidate.published_version === input.version) return { corpus: RESEARCH_CORPUS, version: input.version, idempotent: true };
    if (candidate.status !== 'reviewed') fail(409, 'candidate_not_reviewed', 'Independent review required before publication');
    const latest = await readResearchGraph(sql);
    if (candidate.base_version !== latest.version) fail(409, 'stale_base_version', 'Candidate base is no longer current');
    let merged: ResearchGraph;
    try { merged = mergeGraph(latest.graph, candidate.addition); }
    catch (error) { fail(409, 'identifier_conflict', (error as Error).message); }
    const issues = graphIssues(merged!);
    if (issues.length) fail(409, 'invalid_graph', 'Candidate has provenance or graph errors', issues);
    const existing = await sql`SELECT 1 FROM learning_research_versions WHERE corpus = ${RESEARCH_CORPUS} AND version = ${input.version}`;
    if (existing.length) fail(409, 'version_conflict', 'Version already exists');
    await sql`INSERT INTO learning_research_versions (corpus, version, parent_version, content_hash, graph, reviewed_by_npub, reviewed_at)
      VALUES (${RESEARCH_CORPUS}, ${input.version}, ${latest.version}, ${graphHash(merged!)}, ${sql.json(merged!)}, ${candidate.reviewed_by_npub}, ${candidate.reviewed_at})`;
    await sql`UPDATE learning_research_candidates SET status = 'published', published_version = ${input.version} WHERE id = ${candidate.id}`;
    return { corpus: RESEARCH_CORPUS, version: input.version, contentHash: graphHash(merged!), idempotent: false };
  });
}));
