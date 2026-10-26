/**
 * Live probe for push delivery. Run by the supervising manager AFTER the local Tower was rebuilt/restarted:
 *
 *   SESSION_ID=<broker session> WINGMAN_CAPABILITY=<token> \
 *   bun scripts/notifications-push-probe.ts --tower http://127.0.0.1:3100 --workspace <workspace-id> [--register-fake] \
 *       [--send-real --device-token <hex> --environment sandbox|production --bundle-id <id>]
 *
 * Default is read-only: reports whether the APNs provider is configured and how the alert queue looks. All requests are NIP-98
 * signed through the Autopilot capability broker; no key material is read, printed or stored.
 *
 *  --register-fake   round-trips the compatibility route with a generated token (register, renew, descriptor, revoke, second revoke
 *                    = 404). Verifies the response never echoes the token. Proves nothing about Apple; no push is sent.
 *  --send-real       registers the DEVICE TOKEN YOU PASS (a human copies it from the phone/app log; never read from disk), publishes ONE
 *                    ephemeral self-addressed probe event through a temporary producer source and waits for the alert worker to report
 *                    the outcome. Requires effective workspace.manage and a configured provider. The visible text is the generic
 *                    "New activity". A human must confirm physical receipt on the device; the script reports only Tower's side
 *                    (alert state, provider status). It never claims a physical receipt.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const autopilot = process.env.AUTOPILOT_DIR || new URL('../../autopilot', import.meta.url).pathname;
const { requestJsonBotCrypto } = await import(`${autopilot}/clis/lib/auth.ts`);

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const tower = (flag('tower') || process.env.TOWER_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const workspace = flag('workspace');
if (!workspace) throw new Error('--workspace is required');
const api = `/api/v4/flightdeck-pg/workspaces/${workspace}`;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};
const call = <T = any>(method: string, path: string, body?: unknown) => requestJsonBotCrypto<T>(tower, method, `${api}${path}`, body);
const status = async (method: string, path: string, body?: unknown) => { try { await call(method, path, body); return 200; } catch (e) { return Number(String((e as Error).message).match(/\d{3}/)?.[0] ?? 0); } };

const descriptor = await call('GET', '/descriptor');
const advert = descriptor.notifications ?? {};
console.log('descriptor.notifications:', JSON.stringify({ transports: advert.transports, alerts: advert.alerts, transport_status: advert.transport_status }));
check('descriptor advertises apns without advertising unimplemented kinds', Array.isArray(advert.transports) && advert.transports.includes('apns') && !advert.transports.includes('fcm') && !advert.transports.includes('webpush'), advert.transports);
const providerReady = advert.transport_status?.apns?.ready === true;
console.log(providerReady ? 'APNs provider: READY' : `APNs provider: NOT READY (${advert.transport_status?.apns?.reason ?? 'unknown'}) — set APNS_KEY_ID, APNS_TEAM_ID, APNS_AUTH_KEY_FILE, APNS_TOPIC and restart Tower`);
const queue = await call('GET', '/admin/notifications/queue').catch((e) => ({ error: String(e) }));
console.log('alert queue (workspace.manage only):', JSON.stringify(queue.queue?.alerts ?? queue));

if (args.includes('--register-fake')) {
  const installation = randomUUID();
  const token = randomBytes(32).toString('hex');
  const bundle = flag('bundle-id') || 'studio.otherstuff.ambulando.native';
  const put = (lease: number) => call('PUT', `/notifications/apns-devices/${installation}`, { device_token: token, environment: 'sandbox', bundle_id: bundle, preview: 'generic', lease_seconds: lease });
  try {
    const first = await put(3600);
    check('register returns lease_expires_at', !Number.isNaN(Date.parse(first.device?.lease_expires_at)), first.device);
    check('response never echoes the token', !JSON.stringify(first).toLowerCase().includes(token));
    check('delivery readiness is truthful', first.delivery?.ready === providerReady, first.delivery);
    const renewed = await put(7200);
    check('renewal extends the lease', Date.parse(renewed.device.lease_expires_at) > Date.parse(first.device.lease_expires_at));
  } finally {
    const del = await call('DELETE', `/notifications/apns-devices/${installation}`).catch((e) => ({ error: String(e) }));
    check('revoke succeeds', del.revoked === true, del);
    check('second revoke is 404 (nothing left)', (await status('DELETE', `/notifications/apns-devices/${installation}`)) === 404);
  }
}

if (args.includes('--send-real')) {
  const deviceToken = flag('device-token');
  const environment = flag('environment') || 'sandbox';
  const bundle = flag('bundle-id');
  if (!deviceToken || !bundle) throw new Error('--send-real needs --device-token and --bundle-id');
  if (!providerReady) throw new Error('provider is not configured on this Tower; nothing to send');
  const me = await call('GET', '/me');
  const installation = flag('installation') || randomUUID();
  const reg = await call('PUT', `/notifications/apns-devices/${installation}`, { device_token: deviceToken, environment, bundle_id: bundle, preview: 'generic', lease_seconds: 3600, permission_state: 'granted' });
  check('real token registered', reg.device?.status === 'active' && reg.delivery?.ready === true, reg.delivery);
  const fixtureKey = generateSecretKey(); // in memory only
  const sourceId = `push-probe-${Date.now().toString(36)}`;
  const category = 'push_probe';
  try {
    await call('PUT', `/notification-sources/${sourceId}`, {
      kind: 'app', display_name: 'Push probe', producer_signer_npub: nip19.npubEncode(getPublicKey(fixtureKey)), allowed_recipient_mode: 'actor_list',
      allowed_recipient_actor_ids: [me.actor.actor_id], max_severity: 'normal', rate_per_minute: 6, allowed_categories: [{ category, label: 'Push probe', default_alert: 'on' }], allowed_client_apps: ['*'],
    });
    const rawBody = JSON.stringify({
      schema: 'org.wingman.notification.event', version: 1, event_key: `probe:${randomUUID()}`, category, severity: 'normal',
      subject: { kind: 'app_object', app_id: sourceId, object_type: 'probe', object_id: randomUUID() },
      audience: { client_apps: ['*'] }, recipients: { mode: 'actors', actor_ids: [me.actor.actor_id] },
    });
    const url = new URL(`${api}/notification-events`, `${tower}/`).toString();
    const authorization = 'Nostr ' + Buffer.from(JSON.stringify(finalizeEvent({
      kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
      tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(rawBody).digest('hex')]],
    }, fixtureKey))).toString('base64');
    const response = await fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: rawBody });
    check('probe event accepted', response.ok, await response.text().catch(() => ''));
    const baseline = (await call('GET', '/admin/notifications/queue')).queue?.alerts?.by_state?.sent ?? 0;
    let state: any;
    for (let i = 0; i < 40; i += 1) {
      await Bun.sleep(1000);
      const alerts = (await call('GET', '/admin/notifications/queue')).queue?.alerts?.by_state ?? {};
      state = alerts;
      if ((alerts.sent ?? 0) > baseline || alerts.dead > 0) break;
    }
    console.log('alert states after probe:', JSON.stringify(state));
    check('Tower reports the alert as sent to APNs (physical receipt must be confirmed on the device by a human)', (state?.sent ?? 0) > baseline, state);
  } finally {
    await call('POST', `/notification-sources/${sourceId}/revoke`, {}).catch(() => {});
    if (!flag('keep-registration')) await call('DELETE', `/notifications/apns-devices/${installation}`).catch(() => {});
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll push probe checks passed');
process.exit(failures ? 1 : 0);
