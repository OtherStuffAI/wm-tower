import { config } from '../config';

export type RecordCheckoutPolicy = 'checkout_required' | 'optimistic_write';

export interface RecordCheckoutPolicyOverrides {
  recordFamilyHashes?: Record<string, RecordCheckoutPolicy>;
  familySuffixes?: Record<string, RecordCheckoutPolicy>;
}

const DEFAULT_CHECKOUT_REQUIRED_FAMILY_SUFFIXES = new Set(['document', 'directory']);

let testPolicyOverrides: RecordCheckoutPolicyOverrides | null = null;

function normalizeKey(value: string): string {
  return String(value || '').trim();
}

export function recordFamilySuffix(recordFamilyHash: string): string {
  const normalized = normalizeKey(recordFamilyHash);
  if (!normalized) return '';
  const lastColon = normalized.lastIndexOf(':');
  return lastColon >= 0 ? normalized.slice(lastColon + 1) : normalized;
}

function lookupPolicy(
  policies: Record<string, RecordCheckoutPolicy> | undefined,
  key: string,
): RecordCheckoutPolicy | null {
  const normalized = normalizeKey(key);
  if (!normalized || !policies) return null;
  return policies[normalized] ?? null;
}

function configCheckoutRequiredSet(values: string[]): Set<string> {
  return new Set(values.map(normalizeKey).filter(Boolean));
}

export function resolveRecordCheckoutPolicy(recordFamilyHash: string): RecordCheckoutPolicy {
  const normalizedRecordFamilyHash = normalizeKey(recordFamilyHash);
  const suffix = recordFamilySuffix(normalizedRecordFamilyHash);

  const exactOverride = lookupPolicy(testPolicyOverrides?.recordFamilyHashes, normalizedRecordFamilyHash);
  if (exactOverride) return exactOverride;

  const suffixOverride = lookupPolicy(testPolicyOverrides?.familySuffixes, suffix);
  if (suffixOverride) return suffixOverride;

  const configExactPolicies = configCheckoutRequiredSet(config.checkoutPolicies.checkoutRequiredRecordFamilyHashes);
  if (configExactPolicies.has(normalizedRecordFamilyHash)) return 'checkout_required';

  const configSuffixPolicies = configCheckoutRequiredSet(config.checkoutPolicies.checkoutRequiredFamilySuffixes);
  if (configSuffixPolicies.has(suffix)) return 'checkout_required';

  if (DEFAULT_CHECKOUT_REQUIRED_FAMILY_SUFFIXES.has(suffix)) return 'checkout_required';
  return 'optimistic_write';
}

export function isCheckoutRequiredRecordFamily(recordFamilyHash: string): boolean {
  return resolveRecordCheckoutPolicy(recordFamilyHash) === 'checkout_required';
}

export function setRecordCheckoutPolicyOverridesForTests(overrides: RecordCheckoutPolicyOverrides | null) {
  testPolicyOverrides = overrides;
}
