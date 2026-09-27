import { RESEARCH_CORPUS, REVIEW_DATE, SEED_VERSION, graphHash, graphIssues, seedGraph, type ResearchGraph } from './research-graph';
type Sql = any;

export async function seedResearchGraph(sql: Sql) {
  const issues = graphIssues(seedGraph);
  if (issues.length) throw new Error(`Invalid Space research seed: ${issues.join(', ')}`);
  const hash = graphHash(seedGraph);
  const existing = await sql`SELECT content_hash FROM learning_research_versions WHERE corpus = ${RESEARCH_CORPUS} AND version = ${SEED_VERSION}`;
  if (existing.length && existing[0].content_hash !== hash) throw new Error('Published Space research seed changed; create a new version');
  await sql`INSERT INTO learning_research_versions (corpus, version, content_hash, graph, reviewed_by_npub, reviewed_at)
    VALUES (${RESEARCH_CORPUS}, ${SEED_VERSION}, ${hash}, ${sql.json(seedGraph)}, ${'NASA Science editorial seed'}, ${REVIEW_DATE}) ON CONFLICT DO NOTHING`;
}

export async function readResearchGraph(sql: Sql, version?: string): Promise<{ version: string; contentHash: string; graph: ResearchGraph; reviewedAt: string }> {
  const rows = version
    ? await sql`SELECT version, content_hash, graph, reviewed_at FROM learning_research_versions WHERE corpus = ${RESEARCH_CORPUS} AND version = ${version}`
    : await sql`SELECT version, content_hash, graph, reviewed_at FROM learning_research_versions WHERE corpus = ${RESEARCH_CORPUS} ORDER BY published_at DESC, version DESC LIMIT 1`;
  if (!rows.length) throw new Error('graph_version_not_found');
  return { version: rows[0].version, contentHash: rows[0].content_hash, graph: rows[0].graph, reviewedAt: rows[0].reviewed_at };
}
