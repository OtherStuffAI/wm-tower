import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
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
    return key.asymmetricKeyType === 'ec' ? key : null;
  } catch {
    return null;
  }
}

// --- Provider JWT (ES256), cached and bounded: APNs wants a token refreshed no more than every 20 min and at least hourly ---
const JWT_TTL_MS = 50 * 60_000;
let jwtCache: { fingerprint: string; token: string; issuedAt: number } | null = null;

export function resetApnsJwtCache() { jwtCache = null; }

export function providerToken(config: ApnsConfig, now = Date.now()): string {
  const fingerprint = `${config.keyId}:${config.teamId}`;
  if (jwtCache && jwtCache.fingerprint === fingerprint && now - jwtCache.issuedAt < JWT_TTL_MS) return jwtCache.token;
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${b64({ alg: 'ES256', kid: config.keyId })}.${b64({ iss: config.teamId, iat: Math.floor(now / 1000) })}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key: config.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwtCache = { fingerprint, token: `${signingInput}.${signature}`, issuedAt: now };
  return jwtCache.token;
}

// --- Payload ----------------------------------------------------------------------------------------------------------
export type AlertContent = {
  workspaceId: string; itemId: string; changeSeq: number; sourceAppId: string; category: string;
  groupKey: string | null; coreSource: boolean; ids: { channel_id?: string; thread_id?: string; task_id?: string; doc_id?: string };
  badge: number | null; origin: string;
  /** Only set when both the transport and the alert rule opted in to a full preview. */
  preview: { title: string; body: string } | null;
};

const GENERIC_TITLE = 'New activity';

/** Visible alert (never silent). Routing ids only unless an explicit full preview was allowed. */
export function buildApnsPayload(content: AlertContent) {
  const fd: Record<string, unknown> = {
    v: 1, origin: content.origin, workspace_id: content.workspaceId, category: content.category,
    ...content.ids, notification_id: content.itemId, change_seq: content.changeSeq, source_app_id: content.sourceAppId,
  };
  const aps: Record<string, unknown> = {
    alert: { title: content.preview?.title || GENERIC_TITLE, body: content.preview?.body || '' },
    sound: 'default',
    // Core group keys are made of category + record ids; producer-chosen keys may be private, so they never leave Tower.
    'thread-id': content.coreSource && content.groupKey ? content.groupKey : content.sourceAppId,
  };
  if (content.badge !== null) aps.badge = content.badge;
  return { aps, fd };
}

/** apns-collapse-id must be <= 64 bytes; a hash keeps it opaque and stable per item group. */
export function collapseIdFor(workspaceId: string, itemId: string, groupKey: string | null) {
  return `n-${createHash('sha256').update(`${workspaceId}\u0000${groupKey ?? itemId}`).digest('hex').slice(0, 40)}`;
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

/** Real HTTP/2 sender. Rejects on connection, timeout or stream errors (the worker treats those as transient). */
export const sendApns: ApnsSender = (config, input) => new Promise<ApnsResult>((resolve, reject) => {
  const timeoutMs = input.timeoutMs ?? 10_000;
  let settled = false;
  const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
  let req: http2.ClientHttp2Stream;
  try {
    req = sessionFor(config.hosts[input.environment]).request({
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
    return reject(error);
  }
  const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); finish(() => reject(new Error('apns_timeout'))); }, timeoutMs);
  let status = 0;
  let apnsId: string | null = null;
  let retryAfter: number | null = null;
  const chunks: Buffer[] = [];
  req.on('response', (headers) => {
    status = Number(headers[':status'] ?? 0);
    apnsId = (headers['apns-id'] as string | undefined) ?? null;
    const ra = Number(headers['retry-after']);
    retryAfter = Number.isFinite(ra) && ra > 0 ? ra * 1000 : null;
  });
  req.on('data', (chunk: Buffer) => { if (chunks.length < 8) chunks.push(chunk); });
  req.on('end', () => {
    clearTimeout(timer);
    let reason: string | null = null;
    try { reason = String(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').reason ?? '') || null; } catch { reason = null; }
    finish(() => resolve({ status, reason, apnsId, retryAfterMs: retryAfter }));
  });
  req.on('error', (error) => { clearTimeout(timer); finish(() => reject(error)); });
  req.end(input.body);
});

/** Classifies a provider result for the worker. Reason strings are Apple's documented identifiers, never payload text. */
export type ApnsOutcome = 'sent' | 'transient' | 'stale_token' | 'credential' | 'permanent';
export function classifyApnsResult(result: ApnsResult): ApnsOutcome {
  if (result.status === 200) return 'sent';
  const reason = result.reason ?? '';
  if (result.status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason)) return 'stale_token';
  if (result.status === 403 || result.status === 401 || ['InvalidProviderToken', 'ExpiredProviderToken'].includes(reason)) return 'credential';
  if (result.status === 429 || result.status >= 500 || ['TooManyProviderTokenUpdates', 'ServiceUnavailable', 'InternalServerError', 'Shutdown'].includes(reason)) return 'transient';
  return 'permanent';
}
