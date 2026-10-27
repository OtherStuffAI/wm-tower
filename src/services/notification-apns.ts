import { createHash, createHmac, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import http2 from 'node:http2';
import { secretEnv } from '../secret-env';

export type ApnsEnvironment = 'sandbox' | 'production';

export type ApnsConfig = {
  keyId: string;
  teamId: string;
  key: KeyObject;
  topic: string;
  /** bundle id -> client_app_id for every topic this Tower may address. */
  topics: Map<string, string>;
  environments: Set<ApnsEnvironment>;
  hosts: Record<ApnsEnvironment, string>;
  publicOrigin: string | null;
};

export type ApnsReadiness = { ready: true; config: ApnsConfig } | { ready: false; reason: string };

const DEFAULT_HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

export function normalizeApnsEnvironment(value: unknown): ApnsEnvironment | null {
  if (value === 'sandbox' || value === 'development') return 'sandbox';
  if (value === 'production') return 'production';
  return null;
}

/**
 * Provider configuration from the existing secret-env custody (`NAME` or `NAME_FILE`). Anything missing or unreadable means the
 * adapter is NOT ready: the caller must not queue alerts. Key material is parsed once into a KeyObject and never logged.
 */
export function loadApnsConfig(): ApnsReadiness {
  let keyPem: string;
  try {
    keyPem = secretEnv('APNS_AUTH_KEY');
  } catch {
    return { ready: false, reason: 'provider_not_configured' };
  }
  const keyId = String(process.env.APNS_KEY_ID || '').trim();
  const teamId = String(process.env.APNS_TEAM_ID || '').trim();
  const topic = String(process.env.APNS_TOPIC || '').trim();
  if (!keyPem || !keyId || !teamId || !topic) return { ready: false, reason: 'provider_not_configured' };
  const key = parseKey(keyPem);
  if (!key) return { ready: false, reason: 'provider_key_invalid' };

  const clientApp = String(process.env.APNS_CLIENT_APP_ID || 'ambulando').trim();
  const topics = new Map<string, string>([[topic, clientApp]]);
  // APNS_EXTRA_TOPICS="bundle.id=client_app,other.bundle=other_app"
  for (const part of String(process.env.APNS_EXTRA_TOPICS || '').split(',')) {
    const [bundle, app] = part.split('=').map((v) => v.trim());
    if (bundle && app) topics.set(bundle, app);
  }
  const wanted = String(process.env.APNS_ENVIRONMENTS || 'sandbox,production').split(',')
    .map((v) => normalizeApnsEnvironment(v.trim())).filter((v): v is ApnsEnvironment => v !== null);
  const environments = new Set<ApnsEnvironment>(wanted);
  if (!environments.size) return { ready: false, reason: 'environment_not_enabled' };
  const origin = String(process.env.NOTIF_PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
  return {
    ready: true,
    config: {
      keyId, teamId, key, topic, topics, environments,
      hosts: {
        sandbox: String(process.env.APNS_HOST_SANDBOX || DEFAULT_HOSTS.sandbox),
        production: String(process.env.APNS_HOST_PRODUCTION || DEFAULT_HOSTS.production),
      },
      publicOrigin: /^https:\/\/[^/]+$/.test(origin) ? origin : null,
    },
  };
}

function parseKey(pem: string): KeyObject | null {
  try {
    const key = createPrivateKey(pem);
    // ES256 requires P-256 (prime256v1 / secp256r1); any other curve would sign tokens Apple rejects.
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

// --- Provider JWT (ES256), cached and bounded: APNs wants a token refreshed no more than every 20 min and at least hourly ---
const JWT_TTL_MS = 50 * 60_000;
let jwtCache: { fingerprint: string; token: string; issuedAt: number } | null = null;

export function resetApnsJwtCache() { jwtCache = null; }

export function providerToken(config: ApnsConfig, now = Date.now()): string {
  // Public key fingerprint (SPKI DER hash, never private material) so rotated key material under the same ids cannot reuse a token.
  const publicHash = createHash('sha256').update(createPublicKey(config.key).export({ type: 'spki', format: 'der' })).digest('hex');
  const fingerprint = `${config.keyId}:${config.teamId}:${publicHash}`;
  if (jwtCache && jwtCache.fingerprint === fingerprint && now - jwtCache.issuedAt < JWT_TTL_MS) return jwtCache.token;
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${b64({ alg: 'ES256', kid: config.keyId })}.${b64({ iss: config.teamId, iat: Math.floor(now / 1000) })}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key: config.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwtCache = { fingerprint, token: `${signingInput}.${signature}`, issuedAt: now };
  return jwtCache.token;
}

// --- Payload ----------------------------------------------------------------------------------------------------------
export type AlertContent = {
  /** Recipient app, distinct from the notification producer. Only Ambulando requests cache refresh. */
  clientAppId?: string;
  workspaceId: string; itemId: string; changeSeq: number; sourceAppId: string; category: string;
  /** Opaque HMAC of the group (see opaqueIds); the raw group key never leaves Tower. */
  threadId: string; coreSource: boolean; ids: { channel_id?: string; thread_id?: string; task_id?: string; doc_id?: string };
  badge: number | null; origin: string;
  /** Stable service identity so a client can match the alert to a stored connection when the https origin differs (FIPS-pinned). */
  towerServiceNpub: string | null;
  /** Only set when both the transport and the alert rule opted in to a full preview. */
  preview: { title: string; body: string } | null;
};

const GENERIC_TITLE = 'New activity';

/**
 * Purpose-only copy per canonical flightdeck.core category, matching the bell's wording but with no actor, title or message text.
 * Only the fixed Tower-owned categories get a purpose; producer categories and anything unknown fall back to GENERIC_TITLE, because
 * producer-supplied labels are never trusted into a lock screen.
 */
const PURPOSE_TITLES: Record<string, string> = {
  mention: 'You were mentioned',
  dm: 'New direct message',
  comment_tag: 'You were mentioned in a comment',
  task_assignment: 'A task was assigned to you',
  chat_thread: 'New thread activity',
};

export function genericAlertTitle(category: string, coreSource: boolean) {
  return (coreSource && Object.hasOwn(PURPOSE_TITLES, category) ? PURPOSE_TITLES[category] : undefined) ?? GENERIC_TITLE;
}

/** Visible alert (never silent). Routing ids only unless an explicit full preview was allowed. */
export function buildApnsPayload(content: AlertContent) {
  const fd: Record<string, unknown> = {
    v: 1, origin: content.origin, workspace_id: content.workspaceId, category: content.category,
    ...(content.towerServiceNpub ? { tower_service_npub: content.towerServiceNpub } : {}),
    ...content.ids, notification_id: content.itemId, change_seq: content.changeSeq, source_app_id: content.sourceAppId,
  };
  const aps: Record<string, unknown> = {
    alert: { title: content.preview?.title || genericAlertTitle(content.category, content.coreSource), body: content.preview?.body || '' },
    sound: 'default',
    'thread-id': content.threadId,
    ...(content.clientAppId === 'ambulando' ? { 'content-available': 1 } : {}),
  };
  if (content.badge !== null) aps.badge = content.badge;
  return { aps, fd };
}

/**
 * Opaque, stable per item group: HMAC-SHA256 under a Tower-held secret, so neither the OS, Apple nor a device can recover or
 * correlate the raw group key (which for external producers may be private). collapse-id is <= 64 bytes.
 */
export function opaqueIds(secret: string, workspaceId: string, itemId: string, groupKey: string | null) {
  const mac = (purpose: string) => createHmac('sha256', secret).update(`${purpose}\u0000${workspaceId}\u0000${groupKey ?? itemId}`).digest('hex');
  return { threadId: `t-${mac('thread').slice(0, 32)}`, collapseId: `n-${mac('collapse').slice(0, 40)}` };
}

// --- Transport --------------------------------------------------------------------------------------------------------
export type ApnsSendInput = {
  environment: ApnsEnvironment; deviceToken: string; topic: string; collapseId: string; expiration: number; body: string; timeoutMs?: number;
};
export type ApnsResult = { status: number; reason: string | null; apnsId: string | null; retryAfterMs: number | null };
export type ApnsSender = (config: ApnsConfig, input: ApnsSendInput) => Promise<ApnsResult>;

const sessions = new Map<string, http2.ClientHttp2Session>();

function sessionFor(host: string): http2.ClientHttp2Session {
  const existing = sessions.get(host);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const session = http2.connect(host);
  sessions.set(host, session);
  const drop = () => { if (sessions.get(host) === session) sessions.delete(host); };
  session.on('close', drop);
  session.on('error', drop);
  session.on('goaway', drop);
  session.unref?.();
  return session;
}

/** Raised when a stream ends without a complete HTTP response (reset, dropped connection, runtime fault). Always transient. */
export const APNS_NO_RESPONSE = 'apns_no_response';

/**
 * Evicts exactly the session a request used. A concurrent request may already have replaced it in the map, so a newer session is never
 * touched; close() is graceful, so streams other requests still have in flight on the old session finish normally.
 */
function evictSession(host: string, session: http2.ClientHttp2Session) {
  if (sessions.get(host) === session) sessions.delete(host);
  try { session.close(); } catch { /* already gone */ }
}

const MAX_BODY_BYTES = 16 * 1024;

function sendOnce(config: ApnsConfig, input: ApnsSendInput): Promise<ApnsResult> {
  return new Promise<ApnsResult>((resolve, reject) => {
    const timeoutMs = input.timeoutMs ?? 10_000;
    const host = config.hosts[input.environment];
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    let session: http2.ClientHttp2Session | null = null;
    let req: http2.ClientHttp2Stream;
    try {
      session = sessionFor(host);
      req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${input.deviceToken}`,
        authorization: `bearer ${providerToken(config)}`,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-topic': input.topic,
        'apns-collapse-id': input.collapseId,
        'apns-expiration': String(input.expiration),
        'content-type': 'application/json',
      });
    } catch (error) {
      if (session) evictSession(host, session);
      return reject(error);
    }
    const fail = (error: Error, evict: boolean) => {
      clearTimeout(timer);
      if (evict && session) evictSession(host, session);
      finish(() => reject(error));
    };
    const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); fail(new Error('apns_timeout'), false); }, timeoutMs);
    let status = 0;
    let ended = false;
    let apnsId: string | null = null;
    let retryAfter: number | null = null;
    let declaredLength: number | null = null;
    let received = 0;
    const chunks: Buffer[] = [];
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
      apnsId = (headers['apns-id'] as string | undefined) ?? null;
      const ra = Number(headers['retry-after']);
      retryAfter = Number.isFinite(ra) && ra > 0 ? ra * 1000 : null;
      const cl = headers['content-length'];
      declaredLength = cl === undefined ? null : Number(cl);
    });
    req.on('data', (chunk: Buffer) => { received += chunk.length; if (received <= MAX_BODY_BYTES) chunks.push(chunk); });
    req.on('end', () => { ended = true; });
    // 'close' is the single completion point. Bun 1.2.x can end a stream without ever emitting 'response', and a stream can be reset after
    // headers but before the body completes: only a valid status, a fully received body (end) and a clean close (NO_ERROR) is a result.
    // Some runtimes report a mid-body RST_STREAM as end + NO_ERROR, so the body must also match content-length and parse when non-empty.
    req.on('close', () => {
      const clean = ended && req.rstCode === http2.constants.NGHTTP2_NO_ERROR;
      if (!clean || !Number.isInteger(status) || status <= 0) return fail(new Error(APNS_NO_RESPONSE), true);
      if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength !== received) return fail(new Error(APNS_NO_RESPONSE), true);
      const text = Buffer.concat(chunks).toString('utf8');
      let reason: string | null = null;
      if (text) {
        try { reason = String(JSON.parse(text).reason ?? '') || null; } catch { return fail(new Error(APNS_NO_RESPONSE), true); }
      }
      clearTimeout(timer);
      finish(() => resolve({ status, reason, apnsId, retryAfterMs: retryAfter }));
    });
    req.on('error', (error) => fail(error, true));
    req.end(input.body);
  });
}

/**
 * Real HTTP/2 sender. Rejects on connection, timeout or stream errors and on a stream that does not complete with a valid response (the
 * worker treats all of those as transient). There is deliberately no retry here: the worker's write-ahead attempt, lease and backoff are
 * the single durable retry path, so one alert never hides extra provider sends.
 */
export const sendApns: ApnsSender = (config, input) => sendOnce(config, input);

/** Classifies a provider result for the worker. Reason strings are Apple's documented identifiers, never payload text. */
export type ApnsOutcome = 'sent' | 'transient' | 'stale_token' | 'credential' | 'permanent';
export function classifyApnsResult(result: ApnsResult): ApnsOutcome {
  if (result.status === 200) return 'sent';
  const reason = result.reason ?? '';
  if (result.status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason)) return 'stale_token';
  if (result.status === 403 || result.status === 401 || ['InvalidProviderToken', 'ExpiredProviderToken'].includes(reason)) return 'credential';
  // status 0 = no HTTP response was observed; Apple never answered, so the alert was not judged and must be retried.
  if (result.status === 0 || result.status === 429 || result.status >= 500 || ['TooManyProviderTokenUpdates', 'ServiceUnavailable', 'InternalServerError', 'Shutdown'].includes(reason)) return 'transient';
  return 'permanent';
}
