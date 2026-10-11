/** Complete server-owned continuation, including convergent snapshot handover. */
export type RecordSyncState = {
  mode: 'snapshot' | 'delta'; boundary: string; after: string;
  family: string; id: string; snapshotId: string | null;
  /** Readable partition baseline, separate from ordinary journal position. */
  access?: string[]; accessRevision?: string; progress?: string;
  accessChanges?: { key: string; status: 'granted' | 'lost' }[];
  catchups?: { key: string; cutoff: string; id: string }[];
};
export class RecordSyncError extends Error {
  constructor(public status: 400 | 403 | 409 | 413, public code: string) { super(code); }
}
