import { expect, test } from 'bun:test';
import { mayReviewEvidence, selectLearner } from '../src/learning/authorization';
import { deriveMastery } from '../src/learning/state';

test('two independent learners and a narrow bot delegation stay separate', () => {
  const grant = { learner_npub: 'npub1learnerA', grantee_npub: 'npub1bot', can_read: true, can_write: true, revoked_at: null };
  expect(selectLearner('npub1learnerA', true, [], true)).toBe('npub1learnerA');
  expect(selectLearner('npub1learnerB', true, [], true)).toBe('npub1learnerB');
  expect(selectLearner('npub1bot', false, [grant], true)).toBe('npub1learnerA');
  expect(selectLearner('npub1other', false, [grant], false)).toBeNull();
  expect(selectLearner('npub1bot', false, [{ ...grant, can_write: false }], true)).toBeNull();
  expect(selectLearner('npub1bot', false, [{ ...grant, revoked_at: '2026-09-26' }], false)).toBeNull();
});

test('reviewer is separate from the submission actor', () => {
  expect(mayReviewEvidence('npub1reviewer', 'npub1submitter')).toBe(true);
  expect(mayReviewEvidence('npub1submitter', 'npub1submitter')).toBe(false);
});

test('remembered requires delayed independent recall and failed recall returns to review', () => {
  const base = { concept: 'moon-phases', independent: true, reviewed: true } as const;
  const assessment = { ...base, kind: 'assessment' as const, passed: true, created_at: '2026-09-24T00:00:00Z' };
  expect(deriveMastery([assessment], new Date('2026-09-26')).at(0)?.state).toBe('demonstrated');
  expect(deriveMastery([{ ...assessment, reviewed: false }], new Date('2026-09-26')).at(0)?.state).toBe('developing');
  const early = { ...base, kind: 'recall' as const, passed: true, created_at: '2026-09-24T02:00:00Z' };
  expect(deriveMastery([assessment, early], new Date('2026-09-26')).at(0)?.state).toBe('demonstrated');
  const delayed = { ...early, created_at: '2026-09-25T01:00:00Z' };
  expect(deriveMastery([assessment, delayed], new Date('2026-09-26')).at(0)?.state).toBe('remembered');
  const failed = { ...delayed, passed: false, created_at: '2026-09-26T01:00:00Z' };
  expect(deriveMastery([assessment, delayed, failed], new Date('2026-09-26T02:00:00Z')).at(0)?.state).toBe('developing');
  expect(deriveMastery([assessment, delayed, { ...failed, reviewed: false }], new Date('2026-09-26T02:00:00Z')).at(0)?.state).toBe('developing');
  const failedAssessment = { ...assessment, passed: false, created_at: '2026-09-27T01:00:00Z' };
  expect(deriveMastery([assessment, delayed, failedAssessment], new Date('2026-09-28')).at(0)?.state).toBe('developing');
});
