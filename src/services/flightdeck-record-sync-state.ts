/** Complete server-owned continuation, including convergent snapshot handover. */
export type RecordSyncState = {
  mode: 'snapshot' | 'delta'; boundary: string; after: string;
  family: string; id: string; snapshotId: string | null;
};
export class RecordSyncError extends Error {
  constructor(public status: 400 | 403 | 409 | 413, public code: string) { super(code); }
}
