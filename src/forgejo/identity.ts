import { createHash } from 'node:crypto';

export function forgejoShadowUsername(actorId: string): string {
  return `wm-${createHash('sha256').update(actorId.toLowerCase(), 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * Reverse-proxy identity metadata travels in an HTTP header. Keep it to a
 * conservative printable subset so a malformed profile can never break Git
 * access or inject another upstream header.
 */
export function forgejoDisplayName(value: string | null | undefined): string | undefined {
  const normalized = String(value || '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 120) : undefined;
}
