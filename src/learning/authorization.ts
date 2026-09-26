export type Delegation = { learner_npub: string; grantee_npub: string; can_read: boolean; can_write: boolean; revoked_at: string | null };

export function selectLearner(actor: string, hasOwnProfile: boolean, grants: Delegation[], write: boolean): string | null | 'ambiguous' {
  if (hasOwnProfile) return actor;
  const learners = [...new Set(grants.filter(g => g.grantee_npub === actor && !g.revoked_at && g.can_read && (!write || g.can_write)).map(g => g.learner_npub))];
  if (learners.length > 1) return 'ambiguous';
  return learners[0] ?? null;
}

export function mayReviewEvidence(reviewerNpub: string, submittedByNpub: string): boolean {
  return reviewerNpub !== submittedByNpub;
}
