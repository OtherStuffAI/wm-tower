import { ASSESSMENT_CONTENT_HASH, ASSESSMENT_CORPUS, ASSESSMENT_GRAPH_HASH, ASSESSMENT_REVIEWED_AT, ASSESSMENT_VERSION, assessmentCards, availableCard } from './assessment-cards';
import { readResearchGraph } from './research-storage';
import { SEED_VERSION } from './research-graph';

type Sql = any;

export async function seedAssessmentCards(sql: Sql) {
  const seed = await readResearchGraph(sql, SEED_VERSION);
  if (seed.contentHash !== ASSESSMENT_GRAPH_HASH || assessmentCards.some(card => !availableCard(card.id, seed.graph, seed.contentHash))) {
    throw new Error('Reviewed Space assessment cards require the published NASA research seed');
  }
  const rows = await sql`SELECT content_hash FROM learning_curriculum_versions WHERE corpus = ${ASSESSMENT_CORPUS} AND version = ${ASSESSMENT_VERSION}`;
  if (rows.length && rows[0].content_hash !== ASSESSMENT_CONTENT_HASH) {
    throw new Error('Reviewed Space assessment cards changed; create a new version');
  }
  await sql`INSERT INTO learning_curriculum_versions (corpus, version, content_hash, reviewed_at, review_status)
    VALUES (${ASSESSMENT_CORPUS}, ${ASSESSMENT_VERSION}, ${ASSESSMENT_CONTENT_HASH}, ${ASSESSMENT_REVIEWED_AT}, 'reviewed') ON CONFLICT DO NOTHING`;
  for (const card of assessmentCards) {
    await sql`INSERT INTO learning_curriculum_concepts
      (corpus, version, id, title, explanation, objective, source, prompt, alternate_prompt, recall_prompt, rubric)
      VALUES (${ASSESSMENT_CORPUS}, ${ASSESSMENT_VERSION}, ${card.id}, ${card.title}, ${card.explanation}, ${card.objective}, ${card.source}, ${card.prompt}, ${card.altPrompt}, ${card.recallPrompt}, ${sql.json(card.rubric)})
      ON CONFLICT DO NOTHING`;
  }
}

export async function assessmentVersionReady(sql: Sql): Promise<boolean> {
  const rows = await sql`SELECT v.content_hash, count(c.id)::int AS card_count FROM learning_curriculum_versions v
    LEFT JOIN learning_curriculum_concepts c ON c.corpus = v.corpus AND c.version = v.version
    WHERE v.corpus = ${ASSESSMENT_CORPUS} AND v.version = ${ASSESSMENT_VERSION}
    GROUP BY v.content_hash`;
  return rows[0]?.content_hash === ASSESSMENT_CONTENT_HASH && rows[0]?.card_count === assessmentCards.length;
}
