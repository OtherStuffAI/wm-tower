/**
 * Live smoke for the shared notification inbox. Run by the supervising manager AFTER the local Tower was rebuilt:
 *
 *   SESSION_ID=<broker session> WINGMAN_CAPABILITY=<token> \
 *   bun scripts/notifications-smoke.ts --tower http://127.0.0.1:3100 --workspace <workspace-id> [--probe]
 *
 * All requests are NIP-98 signed through the Autopilot capability broker (--bot-crypto equivalent); no key material is
 * read, printed or stored. Default mode is read-only. `--probe` additionally needs the caller to hold effective workspace.manage:
 * it registers a temporary producer source bound to the caller's own signer, publishes one event to the caller, waits
 * for the server-side worker to project it (proves intake -> worker -> item end to end), exercises read/unread CAS and
 * resolve, then revokes the temporary source (content-free tombstone). It never touches other actors' inboxes.
 */
import { randomUUID } from 'node:crypto';

const autopilot = process.env.AUTOPILOT_DIR || new URL('../../autopilot', import.meta.url).pathname;
const { requestJsonBotCrypto } = await import(`${autopilot}/clis/lib/auth.ts`);

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const tower = (flag('tower') || process.env.TOWER_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const workspace = flag('workspace');
if (!workspace) throw new Error('--workspace is required');
const probe = args.includes('--probe');
const api = `/api/v4/flightdeck-pg/workspaces/${workspace}`;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};
const call = <T = any>(method: string, path: string, body?: unknown) => requestJsonBotCrypto<T>(tower, method, `${api}${path}`, body);
const expectError = async (method: string, path: string, body: unknown, status: string) => {
  try { await call(method, path, body); return false; } catch (e) { return String((e as Error).message).startsWith(status); }
};

// 1. Build identity + descriptor flag.
const health = await fetch(`${tower}/health`).then((r) => r.json()).catch(() => null);
console.log('health:', JSON.stringify(health));
const descriptor = await call('GET', '/descriptor');
check('descriptor advertises notifications_inbox_v1', descriptor.capabilities?.includes('notifications_inbox_v1'), descriptor.notifications);
check('descriptor.notifications.inbox_v1 true', descriptor.notifications?.inbox_v1 === true);
const nstack = await fetch(`${tower}/.well-known/nstack.json`).then((r) => r.json()).catch(() => null);
check('nstack discovery lists notifications.inbox.v1 (when public origin is configured)', !nstack || !nstack.services?.some((s: any) => s.id === 'tower') || nstack.services.find((s: any) => s.id === 'tower').capabilities.includes('notifications.inbox.v1'), nstack?.services?.map((s: any) => s.capabilities));

// 2. Consumer routes (read-only).
const counts = await call('GET', '/notifications/counts');
check('counts shape', typeof counts.unread_total === 'number' && typeof counts.head_seq === 'number' && !!counts.inbox_started_at, counts);
const page = await call('GET', '/notifications/items?limit=5');
check('items shape', Array.isArray(page.items) && typeof page.head_seq === 'number' && 'next_cursor' in page, Object.keys(page));
const changes = await call('GET', `/notifications/changes?after_seq=${page.head_seq}`);
check('changes caught up at head', changes.changes.length === 0 && changes.through_seq === page.head_seq && changes.has_more === false, changes);
check('changes ahead of head -> 410 reset_required', await expectError('GET', `/notifications/changes?after_seq=${page.head_seq + 1000}`, undefined, '410'));
const categories = await call('GET', '/notifications/categories');
check('categories include flightdeck.core', categories.sources?.[0]?.app_id === 'flightdeck.core');
const rules = await call('GET', '/notifications/rules');
check('rules list + rules_revision', Array.isArray(rules.rules) && Number.isInteger(rules.rules_revision), rules);
check('counts/items/changes carry rules_revision', counts.rules_revision === rules.rules_revision && page.rules_revision === rules.rules_revision && changes.rules_revision === rules.rules_revision, [counts.rules_revision, page.rules_revision, changes.rules_revision, rules.rules_revision]);
check('stale rules_revision -> 410 rules_changed', await expectError('GET', `/notifications/changes?after_seq=${page.head_seq}&rules_revision=${rules.rules_revision + 1}`, undefined, '410'));
check('client_app_id view accepted', Number.isInteger((await call('GET', '/notifications/counts?client_app_id=smoke-client')).unread_total));
check('unknown query rejected', await expectError('GET', '/notifications/items?bogus=1', undefined, '400'));
check('malformed cursor rejected', await expectError('GET', '/notifications/items?cursor=junk', undefined, '400'));
const queue = await call('GET', '/admin/notifications/queue').catch((e) => ({ error: String(e) }));
console.log('queue (workspace.manage only):', JSON.stringify(queue.queue ?? queue));
if (queue.queue) check('worker is running inside the server', queue.queue.worker?.running === true && queue.queue.worker?.enabled === true, queue.queue.worker);

// 3. Optional end-to-end probe through the real worker.
if (probe) {
  const me = await call('GET', '/me');
  const sourceId = `smoke-probe-${Date.now().toString(36)}`;
  const source = {
    kind: 'app', display_name: 'Notification smoke probe', producer_signer_npub: me.actor.npub, allowed_recipient_mode: 'actor_list',
    allowed_recipient_actor_ids: [me.actor.actor_id], max_severity: 'normal', rate_per_minute: 30,
    allowed_categories: [{ category: 'smoke_probe', label: 'Smoke probe' }],
  };
  let ackReplay: { itemId: string; body: unknown } | undefined;
  try {
    const registered = await call('PUT', `/notification-sources/${sourceId}`, source);
    check('source registered', registered.source?.source_app_id === sourceId);
    const eventKey = `smoke:${randomUUID()}`;
    const published = await call('POST', '/notification-events', {
      schema: 'org.wingman.notification.event', version: 1, event_key: eventKey, category: 'smoke_probe', severity: 'normal',
      subject: { kind: 'app_object', app_id: sourceId, object_type: 'probe', object_id: 'p1' }, group_key: 'smoke:p1',
      recipients: { mode: 'actors', actor_ids: [me.actor.actor_id] },
    });
    check('event accepted', published.event?.state === 'accepted' && published.replayed === false);
    const replayed = await call('POST', '/notification-events', {
      schema: 'org.wingman.notification.event', version: 1, event_key: eventKey, category: 'smoke_probe', severity: 'normal',
      subject: { kind: 'app_object', app_id: sourceId, object_type: 'probe', object_id: 'p1' }, group_key: 'smoke:p1',
      recipients: { mode: 'actors', actor_ids: [me.actor.actor_id] },
    });
    check('replayed event is idempotent', replayed.replayed === true && replayed.event.id === published.event.id);
    let item: any;
    for (let i = 0; i < 30 && !item; i += 1) {
      item = (await call('GET', `/notifications/items?source_app_id=${sourceId}`)).items[0];
      if (!item) await Bun.sleep(500);
    }
    check('worker projected the event into the inbox within 15s', !!item, null);
    if (item) {
      check('metadata-only presentation', item.presentation.title === 'Notification smoke probe' && item.presentation.body === 'Smoke probe', item.presentation);
      const mutationId = randomUUID();
      const read = await call('PATCH', `/notifications/items/${item.id}`, { mutation_id: mutationId, expected_row_version: item.row_version, patch: { read: true } });
      check('mark read (CAS)', read.item.state.read === true && read.item.row_version === item.row_version + 1);
      check('stale CAS conflicts', await expectError('PATCH', `/notifications/items/${item.id}`, { mutation_id: randomUUID(), expected_row_version: item.row_version, patch: { read: false } }, '409'));
      const after = await call('GET', `/notifications/changes?after_seq=${page.head_seq}`);
      check('changes carries the item', after.changes.some((c: any) => c.id === item.id));
      ackReplay = { itemId: item.id, body: { mutation_id: mutationId, expected_row_version: item.row_version, patch: { read: true } } };
      const replay = await call('PATCH', `/notifications/items/${item.id}`, ackReplay.body);
      check('exact mutation replay returns the stored acknowledgement', replay.item.row_version === read.item.row_version);
      // Rules CAS + per-app view: an app-scoped "off" rule hides the item from that app only.
      const appRule = { source_app_id: sourceId, category: 'smoke_probe', client_app_id: 'smoke-client', channel: 'inbox' };
      const put = await call('PUT', '/notifications/rules', { mutation_id: randomUUID(), rules: [{ ...appRule, mode: 'off', preview: false, expected_row_version: 0 }] });
      const stored = put.rules.find((r: any) => r.source_app_id === sourceId && r.client_app_id === 'smoke-client');
      check('rules PUT bumps rules_revision', put.rules_revision > rules.rules_revision && !!stored, put.rules_revision);
      check('stale rules CAS -> 409', await expectError('PUT', '/notifications/rules', { mutation_id: randomUUID(), rules: [{ ...appRule, mode: 'on', preview: false, expected_row_version: 0 }] }, '409'));
      check('app view hides the item', (await call('GET', `/notifications/items?source_app_id=${sourceId}&client_app_id=smoke-client`)).items.length === 0);
      check('other views still see the shared item', (await call('GET', `/notifications/items?source_app_id=${sourceId}`)).items.length === 1);
      await call('PUT', '/notifications/rules', { mutation_id: randomUUID(), rules: [{ ...appRule, mode: 'default', preview: false, expected_row_version: stored.row_version }] });
    }
  } finally {
    const revoked = await call('POST', `/notification-sources/${sourceId}/revoke`, {}).catch((e) => ({ error: String(e) }));
    check('temporary source revoked and its items tombstoned', !!revoked.source && revoked.source.grant_status === 'revoked', revoked);
    if (ackReplay) check('replaying a prior acknowledgement after revoke -> 404, no content', await expectError('PATCH', `/notifications/items/${ackReplay.itemId}`, ackReplay.body, '404'));
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll notification smoke checks passed');
process.exit(failures ? 1 : 0);
