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

// 3. Optional end-to-end probe through the real worker (no manual drain: proves the boot worker). Rick-only temporary source.
if (probe) {
  const me = await call('GET', '/me');
  const sourceId = `smoke-probe-${Date.now().toString(36)}`;
  const category = 'smoke_probe';
  const source = {
    kind: 'app', display_name: 'Notification smoke probe', producer_signer_npub: me.actor.npub, allowed_recipient_mode: 'actor_list',
    allowed_recipient_actor_ids: [me.actor.actor_id], max_severity: 'normal', rate_per_minute: 60,
    allowed_categories: [{ category, label: 'Smoke probe' }], allowed_client_apps: ['*'],
  };
  const publish = (key: string, apps: string[]) => call('POST', '/notification-events', {
    schema: 'org.wingman.notification.event', version: 1, event_key: key, category, severity: 'normal',
    subject: { kind: 'app_object', app_id: sourceId, object_type: 'probe', object_id: key }, group_key: `smoke:${key}`,
    audience: { client_apps: apps }, recipients: { mode: 'actors', actor_ids: [me.actor.actor_id] },
  });
  const items = async (query = '') => (await call('GET', `/notifications/items?source_app_id=${sourceId}${query}`)).items as any[];
  const waitFor = async (n: number, query = '') => { let r: any[] = []; for (let i = 0; i < 30 && r.length < n; i += 1) { r = await items(query); if (r.length < n) await Bun.sleep(500); } return r; };
  const unreadCount = async (clientApp?: string) => {
    const c = await call('GET', `/notifications/counts${clientApp ? `?client_app_id=${clientApp}` : ''}`);
    return { total: c.unread_total as number, source: (c.by_source_app?.[sourceId] ?? 0) as number };
  };
  // list == count: the unread list and the counts endpoint use one predicate.
  const parity = async (clientApp?: string) => (await items(`&view=unread${clientApp ? `&client_app_id=${clientApp}` : ''}`)).length === (await unreadCount(clientApp)).source;
  let ack: { itemId: string; body: unknown } | undefined;
  const head0 = page.head_seq;
  try {
    check('source registered', (await call('PUT', `/notification-sources/${sourceId}`, source)).source?.source_app_id === sourceId);
    const keyA = `a:${randomUUID()}`; const keyB = `b:${randomUUID()}`;
    const published = await publish(keyA, ['smoke-a']);
    check('event accepted', published.event?.state === 'accepted' && published.replayed === false);
    check('replayed event is idempotent', (await publish(keyA, ['smoke-a'])).replayed === true);
    await publish(keyB, ['smoke-b']);
    const all = await waitFor(2);
    check('boot worker projected both events within 15s', all.length === 2, all.length);
    const forA = await items('&client_app_id=smoke-a'); const forB = await items('&client_app_id=smoke-b');
    const itemA = all.find((i: any) => i.subject?.object_id === keyA); const itemB = all.find((i: any) => i.subject?.object_id === keyB);
    check('app audience: each client sees only its item, shared view sees both', forA.length === 1 && forA[0].id === itemA?.id && forB.length === 1 && forB[0].id === itemB?.id);
    check('metadata-only presentation', itemA?.presentation?.title === 'Notification smoke probe' && itemA?.presentation?.body === 'Smoke probe', itemA?.presentation);
    check('list == count (shared and per app)', (await unreadCount()).source === 2 && await parity() && await parity('smoke-a') && await parity('smoke-b'));

    // CAS read + identical replay.
    const mutationId = randomUUID();
    const body = { mutation_id: mutationId, expected_row_version: itemA.row_version, patch: { read: true } };
    const read = await call('PATCH', `/notifications/items/${itemA.id}`, body);
    check('mark read (CAS)', read.item.state.read === true && read.item.row_version === itemA.row_version + 1);
    const replay = await call('PATCH', `/notifications/items/${itemA.id}`, body);
    check('identical replay returns the stored acknowledgement', replay.item.row_version === read.item.row_version);
    check('stale CAS conflicts', await expectError('PATCH', `/notifications/items/${itemA.id}`, { mutation_id: randomUUID(), expected_row_version: itemA.row_version, patch: { read: false } }, '409'));
    check('mutation_id reuse with another body -> 409', await expectError('PATCH', `/notifications/items/${itemA.id}`, { ...body, patch: { read: false } }, '409'));
    ack = { itemId: itemA.id, body };
    check('list == count after read', (await unreadCount()).source === 1 && (await unreadCount('smoke-a')).source === 0 && await parity() && await parity('smoke-a') && await parity('smoke-b'));

    // Rules CAS: app-scoped off hides B from smoke-b only; revision change forces reset; default is durable.
    const before = await call('GET', '/notifications/rules');
    const key = { source_app_id: sourceId, category, client_app_id: 'smoke-b', channel: 'inbox' };
    const rulesPut = (mode: string, expected: number) => call('PUT', '/notifications/rules', { mutation_id: randomUUID(), rules: [{ ...key, mode, preview: false, expected_row_version: expected }] });
    const mid = await call('GET', `/notifications/counts`);
    const off = await rulesPut('off', 0);
    const offRule = off.rules.find((r: any) => r.source_app_id === sourceId && r.client_app_id === 'smoke-b');
    check('rules PUT bumps rules_revision', off.rules_revision > before.rules_revision && !!offRule, [before.rules_revision, off.rules_revision]);
    check('stale rules CAS -> 409', await expectError('PUT', '/notifications/rules', { mutation_id: randomUUID(), rules: [{ ...key, mode: 'on', preview: false, expected_row_version: 0 }] }, '409'));
    check('old rules_revision on changes -> 410 rules_changed', await expectError('GET', `/notifications/changes?after_seq=${mid.head_seq}&rules_revision=${mid.rules_revision}`, undefined, '410'));
    check('off rule hides the item from smoke-b only', (await items('&client_app_id=smoke-b')).length === 0 && (await items()).length === 2 && (await items('&client_app_id=smoke-a')).length === 1);
    check('list == count with rule applied', (await unreadCount('smoke-b')).source === 0 && (await unreadCount()).source === 1 && await parity('smoke-b') && await parity());
    const dflt = await rulesPut('default', offRule.row_version);
    const dfltRule = dflt.rules.find((r: any) => r.source_app_id === sourceId && r.client_app_id === 'smoke-b');
    check('default is durable (row kept, version bumped, mode default)', dfltRule?.mode === 'default' && dfltRule.row_version > offRule.row_version, dfltRule);
    check('expected_row_version 0 cannot resurrect after default', await expectError('PUT', '/notifications/rules', { mutation_id: randomUUID(), rules: [{ ...key, mode: 'off', preview: false, expected_row_version: 0 }] }, '409'));
    check('item visible to smoke-b again after default', (await items('&client_app_id=smoke-b')).length === 1);
  } finally {
    const head = head0;
    const revoked = await call('POST', `/notification-sources/${sourceId}/revoke`, {}).catch((e) => ({ error: String(e) }));
    check('temporary source revoked', revoked.source?.grant_status === 'revoked', revoked);
    if (ack) check('replay of a prior acknowledgement after revoke -> 404 (no receipt content)', await expectError('PATCH', `/notifications/items/${ack.itemId}`, ack.body, '404'));
    const delta = (await call('GET', `/notifications/changes?after_seq=${head}&limit=200`).catch(() => ({ changes: [] }))).changes as any[];
    const tombs = delta.filter((c: any) => c.removal_reason === 'source_revoked');
    check('tombstones are content-free', tombs.length >= 1 && tombs.every((t: any) => Object.keys(t).sort().join() === ['change_seq', 'change_type', 'id', 'removal_reason', 'schema', 'version', 'workspace_id'].sort().join()), tombs[0]);
    if (ack) check('item read returns a tombstone, not content', (await call('GET', `/notifications/items/${ack.itemId}`).catch(() => ({}))).item?.change_type === 'remove');
    check('revoked source leaves no items and no count', (await items()).length === 0 && (await call('GET', '/notifications/counts')).by_source_app?.[sourceId] === undefined);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll notification smoke checks passed');
process.exit(failures ? 1 : 0);
