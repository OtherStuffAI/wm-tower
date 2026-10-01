import { createHash } from 'node:crypto';
import { getDb } from '../db';
import type { FlightDeckPgFeedSource, FlightDeckPgFeedSubscription, FlightDeckPgFeedItemState } from '../types';
type Db = ReturnType<typeof getDb>;
export type FeedReader = { workspaceId: string; actorId: string };
export class FeedReaderError extends Error {
  constructor(public status: 400 | 404 | 409, public code: string) { super(code); }
}
export const feedUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => { throw new FeedReaderError(400, 'invalid_request'); };
export function feedObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, any>;
}
export function feedKeys(value: Record<string, any>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
export function normalizeFeedSource(value: unknown): FlightDeckPgFeedSource {
  const s = feedObject(value);
  if (s.kind === 'wapp') {
    feedKeys(s, ['kind','autopilot_connection_id','installation_id','feed_id','endpoint','format']);
    if (!feedUuid.test(s.autopilot_connection_id) || !feedUuid.test(s.installation_id)
      || typeof s.feed_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s.feed_id) || s.feed_id === 'list'
      || s.endpoint !== `/feed/${s.feed_id}` || s.format !== 'jsonfeed-1.1') return invalid();
    return { kind: 'wapp', autopilot_connection_id: s.autopilot_connection_id.toLowerCase(),
      installation_id: s.installation_id.toLowerCase(), feed_id: s.feed_id, endpoint: s.endpoint, format: s.format };
  }
  if (s.kind === 'public') {
    feedKeys(s, ['kind','url','format']);
    if (typeof s.url !== 'string' || s.url.length > 4096 || !['jsonfeed-1.1','rss'].includes(s.format)) return invalid();
    let url: URL;
    try { url = new URL(s.url); } catch { return invalid(); }
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password) return invalid();
    url.hash = '';
    return {kind:'public',url:url.href,format:s.format};
  }
  return invalid();
}
function sourceKey(s: FlightDeckPgFeedSource) {
  return s.kind === 'wapp' ? ['wapp', s.autopilot_connection_id, s.installation_id, s.feed_id] : ['public', s.url];
}
function title(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 256) return invalid();
  return value;
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function publicSubscription(row: any): FlightDeckPgFeedSubscription {
  const { source_key, ...result } = row;
  return result;
}
async function connection(reader: FeedReader, source: FlightDeckPgFeedSource, sql: Db) {
  if (source.kind !== 'wapp') return;
  const [found] = await sql`SELECT id FROM flightdeck_pg_autopilot_connections WHERE workspace_id=${reader.workspaceId}
    AND id=${source.autopilot_connection_id} AND archived_at IS NULL`;
  if (!found) throw new FeedReaderError(400, 'invalid_connection');
}
export async function getFeedSubscription(reader: FeedReader, id: string, sql: Db = getDb()) {
  if (!feedUuid.test(id)) return invalid();
  const [row] = await sql`SELECT * FROM flightdeck_pg_feed_subscriptions WHERE workspace_id=${reader.workspaceId}
    AND reader_actor_id=${reader.actorId} AND id=${id}`;
  if (!row) throw new FeedReaderError(404, 'subscription_not_found');
  return publicSubscription(row);
}
export async function listFeedRows(reader: FeedReader, subscriptionId: string | null, cursor: string | undefined, limit = 50, sql: Db = getDb()) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return invalid();
  if (subscriptionId) await getFeedSubscription(reader, subscriptionId, sql);
  const route = subscriptionId ? `states:${subscriptionId.toLowerCase()}` : 'subscriptions';
  let after = '00000000-0000-0000-0000-000000000000';
  if (cursor) {
    if (!feedUuid.test(cursor)) throw new FeedReaderError(400,'invalid_cursor');
    const [saved] = await sql`SELECT after_id FROM flightdeck_pg_feed_cursors WHERE token=${cursor}
      AND workspace_id=${reader.workspaceId} AND reader_actor_id=${reader.actorId} AND route=${route}
      AND created_at>NOW()-INTERVAL '7 days'`;
    if (!saved) throw new FeedReaderError(400,'invalid_cursor');
    after = saved.after_id;
  }
  const rows = subscriptionId
    ? await sql`SELECT * FROM flightdeck_pg_feed_item_states WHERE workspace_id=${reader.workspaceId}
      AND reader_actor_id=${reader.actorId} AND subscription_id=${subscriptionId} AND id>${after} ORDER BY id LIMIT ${limit+1}`
    : await sql`SELECT * FROM flightdeck_pg_feed_subscriptions WHERE workspace_id=${reader.workspaceId}
      AND reader_actor_id=${reader.actorId} AND id>${after} ORDER BY id LIMIT ${limit+1}`;
  let next_cursor: string | null = null;
  const page = rows.slice(0,limit);
  if (rows.length>limit) {
    const [token] = await sql`INSERT INTO flightdeck_pg_feed_cursors(workspace_id,reader_actor_id,route,after_id)
      VALUES(${reader.workspaceId},${reader.actorId},${route},${page.at(-1)!.id}) RETURNING token`;
    next_cursor = token!.token;
  }
  return subscriptionId ? { item_states: page, next_cursor } : { subscriptions: page.map(publicSubscription), next_cursor };
}
export async function mutateFeed(reader: FeedReader, operation: 'subscribe'|'patch'|'unsubscribe'|'state', id: string | null, value: unknown, db: Db = getDb()) {
  const b = feedObject(value);
  feedKeys(b, operation === 'subscribe' ? ['mutation_id','expected_row_version','source','title']
    : operation === 'state' ? ['mutation_id','expected_row_version','item_id','patch']
    : operation === 'patch' ? ['mutation_id','expected_row_version','patch'] : ['mutation_id','expected_row_version']);
  if (!feedUuid.test(b.mutation_id) || !Number.isSafeInteger(b.expected_row_version) || b.expected_row_version<0
    || b.expected_row_version>2147483646 || (id !== null && !feedUuid.test(id))) return invalid();
  const source = operation === 'subscribe' ? normalizeFeedSource(b.source) : null;
  const patch = operation === 'state' || operation === 'patch' ? feedObject(b.patch) : {};
  if (operation === 'subscribe') title(b.title);
  if (operation === 'state') {
    feedKeys(patch,['read','dismissed','saved']);
    if (!Object.keys(patch).length || Object.values(patch).some(v=>typeof v!=='boolean')
      || typeof b.item_id!=='string' || !b.item_id.length || Buffer.byteLength(b.item_id)>2048 || b.item_id.includes('\0')) return invalid();
  }
  if (operation === 'patch') {
    feedKeys(patch,['status','title','endpoint']);
    if (!Object.keys(patch).length || (patch.status!==undefined && !['active','unsubscribed'].includes(patch.status))) return invalid();
    if ('title' in patch) title(patch.title);
  }
  // Semantic JSON ordering is irrelevant. Original acknowledgement is retained indefinitely.
  const hash = createHash('sha256').update(stable({operation,id:id?.toLowerCase()??null,body:{...b,...(source?{source}:{})}})).digest('hex');
  return db.begin(async tx => {
    const sql = tx as unknown as Db;
    // Serialize a reader's mutations before locking the journal clock; prevents duplicate source/state inserts and mutation races.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${reader.workspaceId}:${reader.actorId}:feed`},0))`;
    const [prior] = await sql`SELECT request_hash,acknowledgement FROM flightdeck_pg_feed_mutations
      WHERE workspace_id=${reader.workspaceId} AND reader_actor_id=${reader.actorId} AND mutation_id=${b.mutation_id}`;
    if (prior) {
      if (prior.request_hash!==hash) throw new FeedReaderError(409,'mutation_id_reused');
      return prior.acknowledgement;
    }
    let result: {subscription?: FlightDeckPgFeedSubscription; item_state?: FlightDeckPgFeedItemState};
    let entityId: string; let entityType: string; let changed = true;
    if (source) {
      if (b.expected_row_version!==0) throw new FeedReaderError(409,'state_conflict');
      const [existing] = await sql`SELECT * FROM flightdeck_pg_feed_subscriptions WHERE workspace_id=${reader.workspaceId}
        AND reader_actor_id=${reader.actorId} AND source_key=${sql.json(sourceKey(source))}`;
      if (existing) {
        if (existing.status!=='active') throw new FeedReaderError(409,'state_conflict');
        result={subscription:publicSubscription(existing)}; changed=false;
      } else {
        await connection(reader,source,sql);
        const [created] = await sql`INSERT INTO flightdeck_pg_feed_subscriptions(workspace_id,reader_actor_id,source,source_key,title)
          VALUES(${reader.workspaceId},${reader.actorId},${sql.json(source)},${sql.json(sourceKey(source))},${title(b.title)}) RETURNING *`;
        result={subscription:publicSubscription(created)};
      }
      entityId=result.subscription!.id; entityType='feed_subscription';
    } else {
      const sub = await getFeedSubscription(reader,id!,sql);
      if (operation==='state') {
        if (sub.status!=='active') throw new FeedReaderError(409,'subscription_inactive');
        const [state] = await sql`SELECT * FROM flightdeck_pg_feed_item_states WHERE workspace_id=${reader.workspaceId}
          AND reader_actor_id=${reader.actorId} AND subscription_id=${id} AND item_id=${b.item_id}`;
        if ((state?.row_version??0)!==b.expected_row_version) throw new FeedReaderError(409,'state_conflict');
        const [updated] = state ? await sql<FlightDeckPgFeedItemState[]>`UPDATE flightdeck_pg_feed_item_states SET
          read=${patch.read??state.read},dismissed=${patch.dismissed??state.dismissed},saved=${patch.saved??state.saved},
          row_version=row_version+1,updated_at=NOW() WHERE id=${state.id} RETURNING *`
          : await sql<FlightDeckPgFeedItemState[]>`INSERT INTO flightdeck_pg_feed_item_states(workspace_id,reader_actor_id,subscription_id,item_id,read,dismissed,saved)
            VALUES(${reader.workspaceId},${reader.actorId},${id},${b.item_id},${patch.read??false},${patch.dismissed??false},${patch.saved??false}) RETURNING *`;
        result={item_state:updated!}; entityType='feed_item_state'; entityId=updated!.id;
      } else {
        if (sub.row_version!==b.expected_row_version) throw new FeedReaderError(409,'state_conflict');
        const nextStatus=operation==='unsubscribe'?'unsubscribed':patch.status??sub.status;
        if (nextStatus==='active') await connection(reader,sub.source,sql);
        if (patch.endpoint!==undefined && (sub.source.kind!=='wapp' || patch.endpoint!==`/feed/${sub.source.feed_id}`)) return invalid();
        const [updated] = await sql`UPDATE flightdeck_pg_feed_subscriptions SET status=${nextStatus},
          title=${'title' in patch?title(patch.title):sub.title},row_version=row_version+1,updated_at=NOW()
          WHERE workspace_id=${reader.workspaceId} AND reader_actor_id=${reader.actorId} AND id=${id} RETURNING *`;
        result={subscription:publicSubscription(updated)};entityType='feed_subscription';entityId=id!;
      }
    }
    const row = result.subscription??result.item_state!;
    if (changed) await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,entity_id,operation,entity_row_version,payload)
      VALUES(${reader.workspaceId},${reader.actorId},${`flightdeck_pg.${entityType}.updated`},${entityType},${entityId},'updated',${row.row_version},${sql.json(JSON.parse(JSON.stringify(row)))})`;
    const acknowledgement=JSON.parse(JSON.stringify(result));
    await sql`INSERT INTO flightdeck_pg_feed_mutations(workspace_id,reader_actor_id,mutation_id,request_hash,acknowledgement)
      VALUES(${reader.workspaceId},${reader.actorId},${b.mutation_id},${hash},${sql.json(acknowledgement)})`;
    return acknowledgement;
  });
}
