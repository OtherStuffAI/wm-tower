import { describe, expect, test } from 'bun:test';
import {
  resolveRecordCheckoutPolicy,
  setRecordCheckoutPolicyOverridesForTests,
} from '../src/services/record-checkout-policy';

describe('record checkout policy', () => {
  test('reaction records use optimistic writes by default', () => {
    setRecordCheckoutPolicyOverridesForTests(null);
    expect(resolveRecordCheckoutPolicy('coworker:reaction')).toBe('optimistic_write');
  });
});
