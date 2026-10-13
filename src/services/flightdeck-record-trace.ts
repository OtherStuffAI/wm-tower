import type { FlightDeckRecordPage, FlightDeckRecordPageV2 } from '../types';

/** Opt-in response evidence. Never log payloads, credentials or cursor tokens. */
export function traceFlightDeckRecordPage(input: {
  requestUrl: string; signerNpub: string; actorNpub: string; actorId: string;
  workspaceId: string; page: FlightDeckRecordPage | FlightDeckRecordPageV2;
}, emit: (line: string) => void = console.info) {
  const selected = process.env.TOWER_PG_SYNC_TRACE_NPUB?.trim();
  if (!selected || selected !== input.actorNpub) return;
  const url = new URL(input.requestUrl);
  const families: Record<string, number> = {};
  const scopes = new Set<string>(), channels = new Set<string>();
  for (const change of input.page.changes) {
    families[change.family] = (families[change.family] ?? 0) + 1;
    if (change.scope_id) scopes.add(change.scope_id);
    if (change.channel_id) channels.add(change.channel_id);
  }
  emit(JSON.stringify({ event: 'tower.pg.record_sync.response', at: new Date().toISOString(),
    origin: url.origin, path: url.pathname, signer_npub: input.signerNpub,
    actor_npub: input.actorNpub, actor_id: input.actorId, workspace_id: input.workspaceId,
    protocol_version: input.page.protocol_version, mode: input.page.mode,
    changes: input.page.changes.length, families, scope_ids: [...scopes].sort(), channel_ids: [...channels].sort(),
    has_more: input.page.has_more, snapshot_complete: input.page.snapshot_complete,
    retention_policy: input.page.retention_policy }));
}
