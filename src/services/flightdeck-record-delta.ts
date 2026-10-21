import { accessPartition, observeRecordAccess, drainAccessChanges } from './flightdeck-record-access';
import { requireRecordClient, requireRecordHistory, validateRecordClientId } from './flightdeck-record-checkpoints';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { recordVisibility, type RecordEntry } from './flightdeck-record-visibility';
import { issueLargeRecordManifest } from './flightdeck-record-large';
import { recordFamilies } from './flightdeck-record-families';
import type { FlightDeckRecordActor, FlightDeckRecordChange, FlightDeckRecordPage, FlightDeckRecordPageV2 } from '../types';

type Db = ReturnType<typeof getDb>;
import { RecordSyncError, type RecordSyncState } from './flightdeck-record-sync-state';
export { RecordSyncError, type RecordSyncState } from './flightdeck-record-sync-state';
type Entry = RecordEntry;
export const RECORD_MAX_ROWS = 200;
export const RECORD_MAX_BYTES = 1_048_576;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PageInput = { workspaceId: string; actorId: string; cursor?: string | null; limit?: number };
type DevicePageInput = PageInput & { protocolVersion: 2; clientId: string; extension?: string; largeRecords?: string };
export function readFlightDeckRecordPage(input: DevicePageInput, db?: Db): Promise<FlightDeckRecordPageV2>;
export function readFlightDeckRecordPage(input: PageInput & { protocolVersion?: 1 }, db?: Db): Promise<FlightDeckRecordPage>;
/** Legacy scans use repeatable read. Negotiated scans fence workspace commits for a bounded page. */
export async function readFlightDeckRecordPage(input: PageInput & { protocolVersion?: number; clientId?: string; extension?: string; largeRecords?: string }, db: Db = getDb()): Promise<FlightDeckRecordPage | FlightDeckRecordPageV2> {
  if (input.protocolVersion !== undefined && ![1,2].includes(input.protocolVersion)) throw new RecordSyncError(400, 'unsupported_protocol_version');
  const device = input.protocolVersion === 2;
  if (input.extension !== undefined && (!device || input.extension !== 'bounded_snapshot_v1')) throw new RecordSyncError(400, 'unsupported_extension');
  if (input.largeRecords !== undefined && (input.extension !== 'bounded_snapshot_v1' || input.largeRecords !== 'chunked_v1')) throw new RecordSyncError(400, 'unsupported_extension');
  const bounded = input.extension === 'bounded_snapshot_v1';
  const chunked = input.largeRecords === 'chunked_v1';
  if (device) {
    validateRecordClientId(input.clientId);
    if (!input.cursor) throw new RecordSyncError(400, 'cursor_required');
  }
  const clientInput = { workspaceId: input.workspaceId, actorId: input.actorId, clientId: input.clientId! };
  if (input.cursor && !uuid.test(input.cursor)) throw new RecordSyncError(400, 'invalid_cursor');
  const limit = input.limit ?? RECORD_MAX_ROWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > RECORD_MAX_ROWS) throw new RecordSyncError(400, 'invalid_limit');
  const run = () => db.begin(bounded ? 'isolation level read committed' : 'isolation level repeatable read', async transaction => {
    const sql = transaction as unknown as Db;
    // Read committed can wait for an active writer and then lock its committed
    // clock. Every workspace record/authority mutation takes this same lock
    // before committing, so payload and authority stay stable for this page.
    let clock = bounded ? (await sql`SELECT position::text,epoch,journal_floor::text,access_revision::text
      FROM flightdeck_pg_record_clock WHERE workspace_id=${input.workspaceId} FOR SHARE`)[0] : undefined;
    const [viewer] = await sql`
      SELECT a.npub, w.app_npub FROM flightdeck_pg_workspace_memberships m
      JOIN flightdeck_pg_actors a ON a.id=m.actor_id
      JOIN flightdeck_pg_workspaces w ON w.id=m.workspace_id
      WHERE m.workspace_id=${input.workspaceId} AND m.actor_id=${input.actorId}
    `;
    if (!viewer) throw new RecordSyncError(403, 'workspace_membership_required');
    if (!clock) [clock] = await sql`SELECT position::text, epoch, journal_floor::text, access_revision::text FROM flightdeck_pg_record_clock WHERE workspace_id=${input.workspaceId}`;
    if (!clock) {
      [clock] = await sql`INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(${input.workspaceId}) RETURNING position::text,epoch,journal_floor::text,access_revision::text`;
    }
    let state: RecordSyncState;
    let client: Awaited<ReturnType<typeof requireRecordClient>> | undefined;
    if (device) {
      client = await requireRecordClient(clientInput, clock!.epoch, sql);
      if (input.cursor === client.initial_cursor) state = client.initial_state as RecordSyncState;
      else if (input.cursor === client.checkpoint_cursor) state = client.checkpoint_state as RecordSyncState;
      else {
        const [saved] = await sql`SELECT epoch,state FROM flightdeck_pg_record_page_tokens WHERE token=${input.cursor!}
          AND workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId!}
          AND last_used_at>statement_timestamp()-interval '7 days'`;
        if (!saved || saved.epoch !== clock!.epoch) throw new RecordSyncError(409, 'page_token_invalid');
        state = saved.state as RecordSyncState;
      }
    } else if (input.cursor) {
      const [saved] = await sql`SELECT epoch,state FROM flightdeck_pg_record_cursors WHERE token=${input.cursor} AND workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND COALESCE(last_used_at,created_at)>statement_timestamp()-interval '7 days'`;
      if (!saved || saved.epoch !== clock!.epoch) throw new RecordSyncError(409, 'reset_required');
      state = saved.state as RecordSyncState;
    } else {
      state = { mode: 'snapshot', boundary: clock!.position, after: clock!.position, family: '', id: '', snapshotId: randomUUID() };
    }
    if (state.largeRecords?.length && input.cursor !== client?.checkpoint_cursor) throw new RecordSyncError(409, 'large_record_ack_required');
    if ((state.bounded && !bounded) || (state.chunked && !chunked)) throw new RecordSyncError(400, 'extension_required');
    await requireRecordHistory(input.workspaceId, state, clock, sql);
    const next = await observeRecordAccess(state, clock!.access_revision, input.workspaceId, input.actorId, sql);
    if (bounded) next.bounded = true;
    if (chunked) next.chunked = true;
    // Manifest metadata belongs to its issuance page, never to a later page.
    if (chunked) next.largeRecords = [];
    if (bounded && state.mode === 'delta' && (!next.target || next.targetComplete)) {
      next.target = clock!.position; next.targetComplete = false;
    }
    // A newly readable partition can contain a row updated beyond the pinned
    // target after its earlier version was filtered. Its current historic scan
    // excludes that row, so extend only for an authority gain and repair it via
    // the journal. Ordinary content writes never change the active target.
    if (bounded && state.mode === 'delta' && state.access && next.access?.some(key => !state.access!.includes(key))
      && BigInt(clock!.position) > BigInt(next.target!)) next.target = clock!.position;
    const accessChanges = drainAccessChanges(next, limit);
    const scanLimit = limit - accessChanges.length;
    const catchup = next.catchups?.[0];
    const partition = catchup ? accessPartition(catchup.key) : null;
    const partitionFilter = !partition || partition.resource_type === 'workspace' ? sql`TRUE`
      : partition.resource_type === 'channel'
        ? sql`COALESCE(context->>'channel_id',CASE WHEN family='channel' THEN id END)=${partition.resource_id}`
        : sql`COALESCE(context->>'scope_id',CASE WHEN family='scope' THEN id END)=${partition.resource_id}`;
    // Catchup is a separate keyset with its own cutoff. It never rewinds after.
    // Both paths bound scanned rows before current authorization filtering.
    const entries: Entry[] = catchup
      ? await sql<Entry[]>`SELECT family,id,'upsert'::text AS operation,position::text,bytes,context AS row
        FROM flightdeck_pg_record_current WHERE workspace_id=${input.workspaceId}
        AND family=${partition!.family} AND id>${catchup.id} AND position<=${catchup.cutoff}::bigint
        AND ${partitionFilter}
        AND (${partition!.resource_kind ?? null}::text IS NULL OR context->>'resource_type'=${partition!.resource_kind ?? null})
        ORDER BY id LIMIT ${scanLimit + 1}`
      : state.mode === 'snapshot'
        ? await sql<Entry[]>`SELECT family,id,'upsert'::text AS operation,${state.boundary}::text AS position,bytes,context AS row
          FROM flightdeck_pg_record_current
          WHERE workspace_id=${input.workspaceId} AND (family,id)>(${state.family},${state.id})
          AND (${bounded ? state.boundary : null}::bigint IS NULL OR position<=${bounded ? state.boundary : null}::bigint)
          ORDER BY family,id LIMIT ${scanLimit + 1}`
        : await sql<Entry[]>`SELECT family,id,operation,position::text,bytes,context AS row
          FROM flightdeck_pg_record_journal
          WHERE workspace_id=${input.workspaceId} AND position>${state.after}::bigint
          AND (${bounded ? next.target! : null}::bigint IS NULL OR position<=${bounded ? next.target! : null}::bigint)
          ORDER BY flightdeck_pg_record_journal.position LIMIT ${scanLimit + 1}`;
    const visible = recordVisibility(input.workspaceId, input.actorId, {npub:viewer!.npub,app_npub:viewer!.app_npub}, sql);
    const nextToken = randomUUID();
    const response: FlightDeckRecordPage | FlightDeckRecordPageV2 = {
      ...(device ? { protocol_version: 2 as const, client_id: input.clientId!, checkpoint_revision: client!.revision }
        : { protocol_version: 1 as const }), families: Object.keys(recordFamilies), mode: state.mode, changes: [], actors: [],
      access_revision: clock!.access_revision, access_changes: accessChanges, catchup: partition,
      retention_policy: 'retain_downloaded',
      next_cursor: nextToken, has_more: entries.length > scanLimit, snapshot_id: state.snapshotId,
      personal_pin_order_version: 1,
      snapshot_complete: false, partitions_complete: [], bounds: { max_rows: RECORD_MAX_ROWS, max_bytes: RECORD_MAX_BYTES },
    };
    if (bounded) (response as FlightDeckRecordPageV2).handover = { target_position: next.target ?? null, through_position: next.after, complete: false, authority_epoch: clock!.epoch, access_revision: clock!.access_revision };
    if (chunked) (response as FlightDeckRecordPageV2).large_records = [];
    // Reserve final completeness metadata and maximum revision/position widths.
    const budget = (changes: FlightDeckRecordChange[]) => Buffer.byteLength(JSON.stringify({ ...response, changes, partitions_complete: Object.keys(recordFamilies),
      ...(bounded ? { handover: { target_position: '9'.repeat(19), through_position: '9'.repeat(19), complete: false, authority_epoch: clock!.epoch, access_revision: '9'.repeat(19) }, checkpoint_revision: '9'.repeat(19) } : {}) }));
    const actors = new Map<string, FlightDeckRecordActor>();
    let processed = 0;
    async function oversized(entry: Entry, change: FlightDeckRecordChange) {
      if (response.changes.length || accessChanges.length) { response.has_more = true; return; }
      if (!chunked) throw new RecordSyncError(413, 'record_too_large');
      const manifest = await issueLargeRecordManifest({ workspaceId: input.workspaceId, entry, change: {...change,row:null},
        source: catchup || state.mode === 'snapshot' ? 'current' : 'journal' }, sql);
      next.largeRecords!.push(manifest);
      (response as FlightDeckRecordPageV2).large_records!.push(manifest.public);
      processed++;
      if (catchup) catchup.id = entry.id;
      else if (state.mode === 'snapshot') { next.family = entry.family; next.id = entry.id; }
      else next.after = entry.position;
      response.has_more = entries.length > processed;
    }
    for (const entry of entries.slice(0, scanLimit)) {
      if (await visible(entry)) {
        const change: FlightDeckRecordChange = { family: entry.family, id: entry.id, operation: entry.operation,
          version: entry.position, workspace_id: input.workspaceId, scope_id: entry.family === 'scope' ? entry.id : entry.row.scope_id ?? null,
          channel_id: entry.family === 'channel' ? entry.id : entry.row.channel_id ?? null,
          row: null };
        // Decide using stored byte size and authorization metadata BEFORE fetching canonical JSON.
        const envelopeBytes = budget([...response.changes, change]);
        if (entry.operation === 'upsert' && envelopeBytes + entry.bytes > RECORD_MAX_BYTES) {
          await oversized(entry,change); break;
        }
        if (entry.operation === 'upsert') {
          const [payload] = catchup || state.mode === 'snapshot'
            ? await sql`SELECT row FROM flightdeck_pg_record_current WHERE workspace_id=${input.workspaceId} AND family=${entry.family} AND id=${entry.id}`
            : await sql`SELECT row FROM flightdeck_pg_record_journal WHERE workspace_id=${input.workspaceId} AND position=${entry.position}::bigint`;
          change.row = payload!.row;
        }
        // Only typed top-level references from the authorized payload, never metadata or hidden rows.
        const actorIds = [...new Set(['created_by_actor_id', 'updated_by_actor_id', 'deleted_by_actor_id', 'archived_by_actor_id',
          'owner_actor_id', 'actor_id', 'viewer_actor_id', 'reader_actor_id'].map(key => change.row?.[key])
          .filter((id): id is string => typeof id === 'string' && uuid.test(id) && !actors.has(id)))];
        const baseBytes = budget([...response.changes, change]);
        const remaining = RECORD_MAX_BYTES - baseBytes;
        // Profiles have unbounded labels. Size them in SQL before decoding any new identity payload.
        const sizes = actorIds.length ? await sql`SELECT id, octet_length(jsonb_build_object(
          'actor_id',id,'npub',npub,'display_name',display_name,'kind',kind)::text) AS bytes
          FROM flightdeck_pg_actors WHERE id IN ${sql(actorIds)}` : [];
        if (sizes.reduce((sum, actor) => sum + Number(actor.bytes) + 1, 0) > remaining
          || response.changes.length + 1 + actors.size + sizes.length + accessChanges.length > RECORD_MAX_ROWS) {
          await oversized(entry,change); break;
        }
        const additions = sizes.length ? await sql<FlightDeckRecordActor[]>`
          WITH profiles AS MATERIALIZED (
            SELECT id AS actor_id,npub,display_name,kind,octet_length(jsonb_build_object(
              'actor_id',id,'npub',npub,'display_name',display_name,'kind',kind)::text)+1 AS bytes
            FROM flightdeck_pg_actors WHERE id IN ${sql(sizes.map(actor => actor.id))}
          ) SELECT actor_id,npub,display_name,kind FROM profiles
          WHERE (SELECT COALESCE(sum(bytes),0) FROM profiles)<=${remaining} ORDER BY actor_id` : [];
        // Harmless profile edits do not take the workspace clock. Recheck total
        // profile bytes in the very statement that decodes them, before driver IO.
        if (additions.length !== sizes.length) { await oversized(entry,change); break; }
        for (const actor of additions) actors.set(actor.actor_id, actor);
        response.actors = [...actors.values()];
        response.changes.push(change);
      }
      processed++;
      if (catchup) catchup.id = entry.id;
      else if (state.mode === 'snapshot') { next.family = entry.family; next.id = entry.id; }
      else next.after = entry.position;
    }
    if (catchup && processed === entries.length) next.catchups!.shift();
    if (!catchup && processed === entries.length && state.mode === 'snapshot') {
      response.snapshot_complete = true;
      response.partitions_complete = Object.keys(recordFamilies);
      // Always request the delta handover, including when snapshot scan was empty.
      response.has_more = true;
      next.mode = 'delta'; next.snapshotId = null; next.after = state.boundary;
      if (bounded) { next.target = clock!.position; next.targetComplete = false; }
    }
    response.has_more ||= !!next.catchups?.length || !!next.accessChanges?.length || !!catchup;
    if (bounded) {
      if (state.mode === 'delta' && !catchup && processed === entries.length) next.after = next.target!;
      next.targetComplete = next.mode === 'delta' && !response.snapshot_complete && next.after === next.target
        && !next.catchups?.length && !next.accessChanges?.length && !response.has_more;
      (response as FlightDeckRecordPageV2).handover = { target_position: next.target ?? null, through_position: next.after, complete: !!next.targetComplete, authority_epoch: clock!.epoch, access_revision: clock!.access_revision };
    }
    next.progress = String(BigInt(state.progress ?? '0') + 1n);
    // Legacy readers lock after their scan. A reset/write since their snapshot raises
    // 40001 and retries with fresh authority. Negotiated readers already hold the
    // clock fence; later writers/resets wait for this page commit.
    // Always take clock before cursor locks, matching record writer lock order.
    await sql`SELECT epoch,access_revision FROM flightdeck_pg_record_clock WHERE workspace_id=${input.workspaceId} FOR SHARE`;
    if (device) {
      client = await requireRecordClient(clientInput, clock!.epoch, sql, true);
      // Revalidate the temporary input after waiting for the client row lock.
      if (input.cursor !== client.initial_cursor && input.cursor !== client.checkpoint_cursor) {
        const renewed = await sql`UPDATE flightdeck_pg_record_page_tokens SET last_used_at=clock_timestamp()
          WHERE token=${input.cursor!} AND workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId!}
          AND epoch=${clock!.epoch} AND last_used_at>clock_timestamp()-interval '7 days' RETURNING token`;
        if (!renewed.length) throw new RecordSyncError(409, 'page_token_invalid');
      }
      await sql`UPDATE flightdeck_pg_record_clients SET last_active_at=clock_timestamp()
        WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId!}`;
      (response as FlightDeckRecordPageV2).checkpoint_revision = client.revision;
    } else if (input.cursor) {
      const renewed = await sql`UPDATE flightdeck_pg_record_cursors SET last_used_at=clock_timestamp()
        WHERE token=${input.cursor} AND workspace_id=${input.workspaceId} AND actor_id=${input.actorId}
          AND epoch=${clock!.epoch} AND COALESCE(last_used_at,created_at)>clock_timestamp()-interval '7 days'
        RETURNING token`;
      if (!renewed.length) throw new RecordSyncError(409, 'reset_required');
    }
    if (Buffer.byteLength(JSON.stringify(response)) > RECORD_MAX_BYTES) throw new RecordSyncError(413, 'record_too_large');
    if (!bounded && state.mode === 'delta' && entries.length === 0 && input.cursor && !catchup
      && !accessChanges.length && !next.catchups?.length && !next.accessChanges?.length) {
      response.next_cursor = input.cursor;
      return response;
    }
    if (device) {
      await sql`INSERT INTO flightdeck_pg_record_page_tokens(token,workspace_id,actor_id,client_id,epoch,state,base_revision)
        VALUES(${nextToken},${input.workspaceId},${input.actorId},${input.clientId!},${clock!.epoch},${sql.json(next)},${client!.revision})`;
      // Serialized per client, bounded by 512 even when pages race. Checkpoints
      // and bootstrap cursors are in the durable table and cannot be evicted.
      await sql`DELETE FROM flightdeck_pg_record_page_tokens WHERE token IN (
        SELECT token FROM flightdeck_pg_record_page_tokens WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId!}
        ORDER BY created_at DESC,token OFFSET 512
      )`;
      await sql`DELETE FROM flightdeck_pg_record_page_tokens WHERE token IN (
        SELECT token FROM flightdeck_pg_record_page_tokens WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId} AND client_id=${input.clientId!}
        AND last_used_at<=statement_timestamp()-interval '7 days' ORDER BY last_used_at,token LIMIT 64
      ) AND last_used_at<=clock_timestamp()-interval '7 days'`;
    } else await sql`INSERT INTO flightdeck_pg_record_cursors(token,workspace_id,actor_id,epoch,state)
      VALUES(${nextToken},${input.workspaceId},${input.actorId},${clock!.epoch},${sql.json(next)})`;
    return response;
  }) as unknown as Promise<FlightDeckRecordPage | FlightDeckRecordPageV2>;
  let response: FlightDeckRecordPage | FlightDeckRecordPageV2;
  for (let attempt=0; ; attempt++) {
    try { response = await run(); break; }
    catch (error) {
      if (attempt >= 2 || !['40001','40P01'].includes(String((error as {code?:string}).code))) throw error;
    }
  }
  if (!device && response.next_cursor !== input.cursor) {
    // The page and its cursor have committed. Maintenance needs a fresh read-committed
    // snapshot: concurrent DELETEs in the page's repeatable-read snapshot cause 40001.
    // Serialize only this viewer's short cleanup, not the record scan or other viewers.
    try {
      await db.begin(async transaction => {
        const sql = transaction as unknown as Db;
        await sql`SELECT pg_advisory_xact_lock(hashtext(${input.workspaceId}),hashtext(${input.actorId}))`;
        await sql`DELETE FROM flightdeck_pg_record_cursors WHERE token IN (
          SELECT token FROM flightdeck_pg_record_cursors WHERE workspace_id=${input.workspaceId} AND actor_id=${input.actorId}
          ORDER BY created_at DESC,token OFFSET 512 LIMIT 64
        )`;
        await sql`DELETE FROM flightdeck_pg_record_cursors WHERE token IN (
          SELECT token FROM flightdeck_pg_record_cursors WHERE COALESCE(last_used_at,created_at)<=statement_timestamp()-interval '7 days' ORDER BY COALESCE(last_used_at,created_at),token LIMIT 64
        ) AND COALESCE(last_used_at,created_at)<=clock_timestamp()-interval '7 days'`;
      });
    } catch (error) {
      // A later progress page can reclaim these rows. Never fail a committed cursor.
      console.warn('record-sync cursor cleanup failed', error);
    }
  }
  return response;
}
