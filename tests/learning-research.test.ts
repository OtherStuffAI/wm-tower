import { expect, test } from 'bun:test';
import { boundedWalk, graphHash, graphIssues, mergeGraph, seedGraph, type ResearchGraph } from '../src/learning/research-graph';

const empty = (): ResearchGraph => ({ sources: [], concepts: [], relations: [], supports: [] });

test('reviewed NASA seed is broad, connected, and fully sourced', () => {
  expect(seedGraph.concepts.length).toBeGreaterThanOrEqual(60);
  expect(new Set(seedGraph.concepts.map(c => c.cluster)).size).toBeGreaterThanOrEqual(8);
  expect(graphIssues(seedGraph)).toEqual([]);
  expect(seedGraph.concepts.some(c => c.id === 'moon-phases')).toBe(true);
  expect(seedGraph.sources.every(s => s.publisher === 'NASA Science' && s.url.startsWith('https://science.nasa.gov/'))).toBe(true);
});

test('unsupported or dangling research cannot pass publication validation', () => {
  const addition = empty();
  addition.concepts.push({ id: 'unsourced-claim', cluster: 'moon', title: 'Unsourced claim', claim: 'No source supports this.' });
  expect(graphIssues(mergeGraph(seedGraph, addition))).toContain('unsupported_concept:unsourced-claim');
  addition.relations.push({ id: 'missing-to-claim', from: 'missing', to: 'unsourced-claim', type: 'supports' });
  expect(graphIssues(mergeGraph(seedGraph, addition))).toContain('invalid_relation:missing-to-claim');
});

test('candidate merge is idempotent and protects stable identifiers', () => {
  const addition = empty();
  addition.concepts.push({ id: 'new-topic', cluster: 'moon', title: 'New topic', claim: 'A reviewed claim.' });
  addition.supports.push({ targetType: 'concept', targetId: 'new-topic', sourceId: 'moon', locator: 'Introduction', summary: 'A reviewed claim.' });
  const first = mergeGraph(seedGraph, addition);
  expect(graphIssues(first)).toEqual([]);
  expect(graphHash(mergeGraph(first, addition))).toBe(graphHash(first));
  addition.concepts[0]!.claim = 'A different claim.';
  expect(() => mergeGraph(first, addition)).toThrow('identifier_conflict');
});

test('prerequisite cycles are rejected and graph walks are bounded', () => {
  const addition = empty();
  addition.relations.push({ id: 'moon-phases-to-sun-star', from: 'moon-phases', to: 'sun-star', type: 'prerequisite' });
  addition.supports.push({ targetType: 'relation', targetId: 'moon-phases-to-sun-star', sourceId: 'moon', locator: 'Introduction', summary: 'Deliberately invalid learning order.' });
  expect(graphIssues(mergeGraph(seedGraph, addition)).some(x => x.startsWith('prerequisite_cycle:'))).toBe(true);
  const walk = boundedWalk(seedGraph, 'moon-phases', 4, 5);
  expect(walk.concepts.length).toBeLessThanOrEqual(5);
  expect(walk.relations.every(r => walk.concepts.some(c => c.id === r.from) && walk.concepts.some(c => c.id === r.to))).toBe(true);
  expect(() => boundedWalk(seedGraph, 'moon-phases', 5, 5)).toThrow('invalid_bounds');
});
