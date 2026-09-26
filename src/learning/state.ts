export type EvidenceRow = { concept: string; kind: 'assessment' | 'recall'; passed: boolean; independent: boolean; reviewed: boolean; created_at: Date | string };
const DAY = 86_400_000;

export function deriveMastery(rows: EvidenceRow[], now = new Date()) {
  const byConcept = new Map<string, EvidenceRow[]>();
  for (const row of rows) byConcept.set(row.concept, [...(byConcept.get(row.concept) ?? []), row]);
  return [...byConcept].map(([concept, evidence]) => {
    evidence.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
    const latestAssessment = evidence.filter(e => e.kind === 'assessment' && e.independent).at(-1);
    const pass = latestAssessment?.passed && latestAssessment.reviewed ? latestAssessment : undefined;
    const recalls = evidence.filter(e => e.kind === 'recall' && e.independent && (e.reviewed || !e.passed) && pass && +new Date(e.created_at) >= +new Date(pass.created_at) + DAY);
    const latestRecall = recalls.at(-1);
    const state = latestRecall?.passed ? 'remembered' : latestRecall ? 'developing' : pass ? 'demonstrated' : 'developing';
    const dueAt = pass ? new Date(+new Date(latestRecall?.created_at ?? pass.created_at) + (latestRecall?.passed ? 7 : 1) * DAY).toISOString() : null;
    return { concept, state, dueAt, due: dueAt ? +new Date(dueAt) <= +now : false, evidenceCount: evidence.length };
  }).sort((a, b) => a.concept.localeCompare(b.concept));
}
