import { expect, test } from 'bun:test';
import { alternativeQuestions, concepts, score, walk } from '../src/learning/curriculum';

test('reviewed Moon phases path is deterministic and complete', () => {
  const result = walk('moon-phases');
  expect(result.valid).toBe(true);
  expect(result.order).toHaveLength(10);
  expect(result.order.at(-1)?.id).toBe('moon-phases');
  expect(walk('moon-phases')).toEqual(result);
  expect(concepts.every(node => Boolean(alternativeQuestions[node.id]))).toBe(true);
});

test('walk reports cycles and missing prerequisites without looping', () => {
  const altered = concepts.map(c => ({ ...c, prerequisites: [...c.prerequisites] }));
  altered[0]!.prerequisites.push('moon-phases', 'unknown');
  const result = walk('moon-phases', altered);
  expect(result.valid).toBe(false);
  expect(result.cycles.length).toBeGreaterThan(0);
  expect(result.missing).toEqual(['unknown']);
});

test('rubric passes a real explanation and fails a one-word guess', () => {
  const rubric = concepts.at(-1)!.rubric;
  expect(score('Sunlight reaches half the Moon, and as it orbits Earth we see different lit parts.', rubric).passed).toBe(true);
  expect(score('sun', rubric).passed).toBe(false);
  expect(score('Sunlight and orbit around Earth matter, but the shadow of Earth causes Moon phases and the lit part changes.', rubric).passed).toBe(false);
});
