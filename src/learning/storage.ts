import { createHash } from 'node:crypto';
import { CORPUS, REVIEWED_AT, VERSION, concepts, alternativeQuestions, type Concept } from './curriculum';

type Sql = any;

export async function seedCurriculum(sql: Sql): Promise<void> {
  const hash = createHash('sha256').update(JSON.stringify({ concepts, alternativeQuestions })).digest('hex');
  const existing = await sql`SELECT content_hash FROM learning_curriculum_versions WHERE corpus = ${CORPUS} AND version = ${VERSION}`;
  if (existing.length && existing[0].content_hash !== hash) throw new Error('Reviewed Space curriculum version changed; create a new version instead');
  await sql`INSERT INTO learning_curriculum_versions (corpus, version, content_hash, reviewed_at, review_status)
    VALUES (${CORPUS}, ${VERSION}, ${hash}, ${REVIEWED_AT}, 'reviewed') ON CONFLICT DO NOTHING`;
  for (const node of concepts) {
    await sql`INSERT INTO learning_curriculum_concepts
      (corpus, version, id, title, explanation, objective, source, prompt, alternate_prompt, recall_prompt, rubric)
      VALUES (${CORPUS}, ${VERSION}, ${node.id}, ${node.title}, ${node.explanation}, ${node.objective}, ${node.source}, ${node.prompt}, ${alternativeQuestions[node.id]}, ${node.recallPrompt}, ${sql.json(node.rubric)})
      ON CONFLICT DO NOTHING`;
  }
  for (const node of concepts) for (const prerequisite of node.prerequisites) {
    await sql`INSERT INTO learning_curriculum_prerequisites (corpus, version, prerequisite_id, concept_id)
      VALUES (${CORPUS}, ${VERSION}, ${prerequisite}, ${node.id}) ON CONFLICT DO NOTHING`;
  }
}

export async function readCurriculum(sql: Sql): Promise<Concept[]> {
  const nodes = await sql`SELECT id, title, explanation, objective, source, prompt, alternate_prompt, recall_prompt, rubric
    FROM learning_curriculum_concepts WHERE corpus = ${CORPUS} AND version = ${VERSION} ORDER BY id`;
  const edges = await sql`SELECT prerequisite_id, concept_id FROM learning_curriculum_prerequisites
    WHERE corpus = ${CORPUS} AND version = ${VERSION} ORDER BY concept_id, prerequisite_id`;
  return nodes.map((node: any) => ({
    id: node.id, title: node.title, explanation: node.explanation, objective: node.objective,
    source: node.source, prompt: node.prompt, altPrompt: node.alternate_prompt, recallPrompt: node.recall_prompt, rubric: node.rubric,
    prerequisites: edges.filter((edge: any) => edge.concept_id === node.id).map((edge: any) => edge.prerequisite_id),
  }));
}
