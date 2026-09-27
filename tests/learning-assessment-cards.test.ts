import { expect, test } from 'bun:test';
import { ASSESSMENT_GRAPH_HASH, ASSESSMENT_VERSION, assessmentCards, availableCard } from '../src/learning/assessment-cards';
import { graphHash, seedGraph, SEED_VERSION } from '../src/learning/research-graph';
import { concepts, score } from '../src/learning/curriculum';
import { deriveMastery } from '../src/learning/state';
import { learningSchemas } from '../src/learning/openapi';

test('one curated, independently assessable card exists for each sourced cluster', () => {
  expect(ASSESSMENT_GRAPH_HASH).toBe(graphHash(seedGraph));
  expect(assessmentCards).toHaveLength(16);
  expect(new Set(assessmentCards.map(c => c.cluster))).toEqual(new Set(seedGraph.concepts.map(c => c.cluster)));
  expect(assessmentCards.every(c => c.graphVersion === SEED_VERSION && c.cardVersion === ASSESSMENT_VERSION)).toBe(true);
  for (const card of assessmentCards) {
    const support = seedGraph.supports.find(s => s.targetType === 'concept' && s.targetId === card.id && s.sourceId === card.sourceId && s.locator === card.locator);
    const source = seedGraph.sources.find(s => s.id === card.sourceId && s.url === card.source);
    expect(support).toBeDefined();
    expect(source?.publisher).toBe('NASA Science');
    expect(card.objective.length).toBeGreaterThan(20);
    expect(card.explanation.length).toBeGreaterThan(40);
    expect(card.prompt).not.toBe(card.recallPrompt);
    expect(card.prompt).not.toBe(card.altPrompt);
    expect(card.rubric.length).toBeGreaterThanOrEqual(3);
    expect(availableCard(card.id, seedGraph, ASSESSMENT_GRAPH_HASH)?.id).toBe(card.id);
  }
  expect(concepts).toHaveLength(10);
  expect(concepts.some(c => c.id === 'moon-phases')).toBe(true);
});

test('unreviewed, changed-source and unpublished subjects fail closed', () => {
  expect(availableCard('unreviewed-candidate', seedGraph, ASSESSMENT_GRAPH_HASH)).toBeUndefined();
  expect(availableCard('jupiter', seedGraph, 'wrong-hash')).toBeUndefined();
  const noSupport = structuredClone(seedGraph);
  noSupport.supports = noSupport.supports.filter(s => !(s.targetType === 'concept' && s.targetId === 'jupiter'));
  expect(availableCard('jupiter', noSupport, ASSESSMENT_GRAPH_HASH)).toBeUndefined();
  const changed = structuredClone(seedGraph);
  changed.concepts.find(c => c.id === 'jupiter')!.claim = 'Unsourced changed claim';
  expect(availableCard('jupiter', changed, ASSESSMENT_GRAPH_HASH)).toBeUndefined();
  const added = structuredClone(seedGraph);
  added.concepts.push({ id: 'new-candidate', cluster: 'jupiter', title: 'New candidate', claim: 'A newly published claim' });
  added.supports.push({ targetType: 'concept', targetId: 'new-candidate', sourceId: 'jupiter', locator: 'Introduction', summary: 'A published claim' });
  expect(availableCard('new-candidate', added, ASSESSMENT_GRAPH_HASH)).toBeUndefined();
});

test('keyword result stays provisional until independent review and 24-hour recall', () => {
  const card = assessmentCards.find(c => c.id === 'jupiter')!;
  expect(score('Jupiter is the fifth planet and Ganymede is the largest moon.', card.rubric).passed).toBe(true);
  const at = new Date('2026-09-27T00:00:00Z');
  const assessment = { concept: card.id, kind: 'assessment' as const, passed: true, independent: true, reviewed: false, created_at: at };
  expect(deriveMastery([assessment], new Date(+at + 2 * 86_400_000))[0]?.state).toBe('developing');
  const reviewed = { ...assessment, reviewed: true };
  expect(deriveMastery([reviewed], new Date(+at + 23 * 3_600_000))[0]?.due).toBe(false);
  expect(deriveMastery([reviewed], new Date(+at + 24 * 3_600_000))[0]?.due).toBe(true);
  const recall = { concept: card.id, kind: 'recall' as const, passed: true, independent: true, reviewed: true, created_at: new Date(+at + 25 * 3_600_000) };
  expect(deriveMastery([reviewed, recall], new Date(+at + 25 * 3_600_000))[0]?.state).toBe('remembered');
  expect((learningSchemas.ResearchClusters as any).properties.concepts.items.$ref).toBe('#/components/schemas/ResearchSubject');
});
