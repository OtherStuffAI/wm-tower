import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db';

export type Sql = ReturnType<typeof getDb>;
type JsonParam = Parameters<Sql['json']>[0];
export const asJson = (value: unknown) => value as JsonParam;

export const CORE_SOURCE = 'flightdeck.core';
export const CORE_SOURCE_LABEL = 'Flight Deck';
/** Highest precedence first. One source event yields one item per recipient under the top reason. */
export const CATEGORY_PRECEDENCE = ['security', 'approval', 'dm', 'mention', 'task_assignment', 'comment_tag', 'chat_thread'] as const;
export const SEVERITIES = ['low', 'normal', 'high', 'critical'] as const;
export const MENTION_WINDOW_SECONDS = 600;
export const INBOX_COUNT_CAP = 999;
export const RECIPIENT_PAGE = 500;
export const MAX_INTAKE_ATTEMPTS = 8;

export type CategoryDef = {
  category: string;
  label: string;
  default_severity: string;
  default_inbox: 'on' | 'off';
  default_alert: 'on' | 'off';
  mandatory: boolean;
  grouping: string;
};

/** Built-in flightdeck.core registry (Tower rules). Mandatory categories are reserved to Tower and none are produced yet. */
export const CORE_CATEGORIES: CategoryDef[] = [
  { category: 'chat_thread', label: 'Thread activity', default_severity: 'low', default_inbox: 'on', default_alert: 'off', mandatory: false, grouping: 'subject' },
  { category: 'mention', label: 'Mentions', default_severity: 'normal', default_inbox: 'on', default_alert: 'on', mandatory: false, grouping: 'subject' },
  { category: 'dm', label: 'Direct messages', default_severity: 'normal', default_inbox: 'on', default_alert: 'on', mandatory: false, grouping: 'subject' },
  { category: 'comment_tag', label: 'Comment mentions', default_severity: 'normal', default_inbox: 'on', default_alert: 'on', mandatory: false, grouping: 'subject' },
  { category: 'task_assignment', label: 'Task assignments', default_severity: 'normal', default_inbox: 'on', default_alert: 'on', mandatory: false, grouping: 'subject' },
];
export const RESERVED_CATEGORIES = new Set(['security', 'approval', ...CORE_CATEGORIES.map((c) => c.category)]);

export class NotificationError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code);
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);

export function precedenceRank(category: string) {
  const index = CATEGORY_PRECEDENCE.indexOf(category as typeof CATEGORY_PRECEDENCE[number]);
  return index < 0 ? CATEGORY_PRECEDENCE.length : index;
}
export function topCategory(reasons: Iterable<string>) {
  return [...reasons].sort((a, b) => precedenceRank(a) - precedenceRank(b))[0]!;
}

/** Plain text only: strips controls and bidi overrides, bounds by code points. */
export function plainText(value: unknown, max: number) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  const points = [...text];
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().filter((k) => (value as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
export const hashOf = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

// --- Cursors: opaque, HMAC-bound to (workspace, actor, route, filter), 7-day expiry -------------------------------
let cachedSecret: Promise<string> | null = null;
export function cursorSecret(sql: Sql = getDb()) {
  cachedSecret ??= sql<{ cursor_secret: string }[]>`SELECT cursor_secret FROM flightdeck_pg_notification_system WHERE singleton`
    .then((rows) => rows[0]!.cursor_secret)
    .catch((error) => { cachedSecret = null; throw error; });
  return cachedSecret;
}
export function resetCursorSecretCache() { cachedSecret = null; }

export async function signCursor(binding: { w: string; a: string; r: string; f: string }, position: unknown, sql?: Sql) {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...binding, exp: Date.now() + 7 * 86400_000, p: position })).toString('base64url');
  const mac = createHmac('sha256', await cursorSecret(sql)).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}
export async function verifyCursor<T>(token: string, binding: { w: string; a: string; r: string; f: string }, sql?: Sql): Promise<T> {
  const fail = () => new NotificationError(400, 'invalid_cursor', 'Cursor is invalid for this request');
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) throw fail();
  const expected = createHmac('sha256', await cursorSecret(sql)).update(payload).digest();
  let given: Buffer;
  try { given = Buffer.from(mac, 'base64url'); } catch { throw fail(); }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw fail();
  let body: any;
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw fail(); }
  if (body?.v !== 1 || body.w !== binding.w || body.a !== binding.a || body.r !== binding.r || body.f !== binding.f || !(body.exp > Date.now())) throw fail();
  return body.p as T;
}

// --- Rules ----------------------------------------------------------------------------------------------------------
export type RuleMode = 'on' | 'off' | 'default';
export type RuleRow = { source_app_id: string; category: string; client_app_id: string; channel: 'inbox' | 'alert'; mode: RuleMode; preview: string | null; row_version: number };

/**
 * Item-projection rule resolution (shared item, so only client_app_id='*' rules apply; per-client rules are a view filter).
 * Most specific wins: (source,category) > (source,*) > (*,category) > (*,*) > registry default.
 * Mode 'default' rows are inherited (ignored here). `off` wins within a level.
 */
export function resolveRuleMode(rules: RuleRow[], channel: 'inbox' | 'alert', source: string, category: string, fallback: 'on' | 'off'): 'on' | 'off' {
  const levels: Array<[string, string]> = [[source, category], [source, '*'], ['*', category], ['*', '*']];
  for (const [s, c] of levels) {
    const hit = rules.filter((r) => r.channel === channel && r.mode !== 'default' && r.client_app_id === '*' && r.source_app_id === s && r.category === c);
    if (hit.length) return hit.some((r) => r.mode === 'off') ? 'off' : 'on';
  }
  return fallback;
}

export function categoryDef(category: string): CategoryDef | undefined {
  return CORE_CATEGORIES.find((c) => c.category === category);
}

/** NOTIF_PROJECTOR=off disables projection (intake rows keep accumulating and are processed when re-enabled). */
export function projectorEnabled() {
  return (Bun.env.NOTIF_PROJECTOR ?? 'on').toLowerCase() !== 'off';
}
/** NOTIF_INBOX_API=off hides the consumer/producer routes and the descriptor capability. */
export function inboxApiEnabled() {
  return (Bun.env.NOTIF_INBOX_API ?? 'on').toLowerCase() !== 'off';
}

/** Canonical audience set: de-duplicated, sorted; '*' (any client) absorbs everything else. */
export function canonicalAudience(clientApps: unknown): string[] {
  const list = Array.isArray(clientApps) ? clientApps.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
  if (!list.length || list.includes('*')) return ['*'];
  return [...new Set(list)].sort();
}

/** Takes the recipient cursor lock (canonical lock order: mutation lock -> recipient -> item rows -> next_seq). */
export async function lockRecipient(tx: Sql, workspaceId: string, actorId: string) {
  await tx`SELECT flightdeck_pg_notification_lock_recipient(${workspaceId}::uuid, ${actorId}::uuid)`;
}

/** Locks several recipients in ascending (workspace, actor) order, each once. */
export async function lockRecipients(tx: Sql, recipients: Array<{ workspaceId: string; actorId: string }>) {
  const seen = new Set<string>();
  const ordered = recipients
    .filter((r) => { const k = `${r.workspaceId}:${r.actorId}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0));
  for (const r of ordered) await lockRecipient(tx, r.workspaceId, r.actorId);
}
