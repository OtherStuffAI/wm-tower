import { createHash } from 'crypto';
import { nip19, verifyEvent } from 'nostr-tools';
import type { Context } from 'hono';
import { resolveWsKeyNpub } from './services/user-workspace-keys';

const NIP98_KIND = 27235;
const MAX_EVENT_AGE_SECONDS = 300;
const STRICT_MUTATION_MAX_EVENT_AGE_SECONDS = 60;

function firstHeaderValue(value: string | null): string | null {
  if (!value) return null;
  return value.split(',')[0]?.trim() || null;
}

function parseCfVisitorScheme(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.scheme === 'string' ? parsed.scheme : null;
  } catch {
    return null;
  }
}

export function getEffectiveRequestUrl(request: Request): URL {
  const requestUrl = new URL(request.url);

  const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto'));
  const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'));

  if (forwardedProto && forwardedHost) {
    return new URL(`${forwardedProto}://${forwardedHost}${requestUrl.pathname}${requestUrl.search}`);
  }

  const host = firstHeaderValue(request.headers.get('host'));
  const cfVisitorScheme = parseCfVisitorScheme(firstHeaderValue(request.headers.get('cf-visitor')));
  const scheme = forwardedProto || cfVisitorScheme || requestUrl.protocol.replace(':', '');

  if (host) {
    return new URL(`${scheme}://${host}${requestUrl.pathname}${requestUrl.search}`);
  }

  return requestUrl;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

type Nip98VerificationInput = {
  authHeader: string | null;
  request: Request;
  rawBody?: string | null;
  overridePayloadHash?: string | null;
  excludedQueryParams?: readonly string[];
};

async function verifyNip98Token({
  authHeader,
  request,
  rawBody,
  overridePayloadHash = null,
  excludedQueryParams = [],
}: Nip98VerificationInput): Promise<string | null> {
  if (!authHeader?.startsWith('Nostr ')) return null;
  try {
    const token = authHeader.slice(6).trim();
    const event = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));

    if (!verifyEvent(event)) return null;
    if (event.kind !== NIP98_KIND) return null;

    const effectiveUrl = getEffectiveRequestUrl(request);
    for (const queryParam of excludedQueryParams) {
      effectiveUrl.searchParams.delete(queryParam);
    }

    const uTags = event.tags?.filter((tag: unknown) => Array.isArray(tag) && tag[0] === 'u') ?? [];
    if (uTags.length !== 1 || typeof uTags[0]?.[1] !== 'string' || !uTags[0][1].trim()) return null;

    const eventUrl = new URL(uTags[0][1]);
    if (eventUrl.toString() !== effectiveUrl.toString()) return null;

    const methodTags = event.tags?.filter((tag: unknown) => Array.isArray(tag) && tag[0] === 'method') ?? [];
    if (
      methodTags.length !== 1 ||
      typeof methodTags[0]?.[1] !== 'string' ||
      !methodTags[0][1].trim() ||
      methodTags[0][1].toUpperCase() !== request.method.toUpperCase()
    ) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(event.created_at)) > MAX_EVENT_AGE_SECONDS) {
      return null;
    }

    const needsPayloadHash = ['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase());
    const payloadTag = event.tags?.find((tag: string[]) => tag[0] === 'payload');
    if (needsPayloadHash) {
      const effectiveBody = overridePayloadHash
        ? null
        : (rawBody ?? await request.clone().text());
      const expectedHash = overridePayloadHash || sha256Hex(effectiveBody || '');
      if (!payloadTag?.[1] || expectedHash !== payloadTag[1]) {
        return null;
      }
    }

    return nip19.npubEncode(event.pubkey);
  } catch {
    return null;
  }
}

export async function verifyNip98Auth(request: Request): Promise<string | null> {
  return verifyNip98Token({
    authHeader: request.headers.get('authorization'),
    request,
  });
}

export async function verifyNip98AuthHeader(
  authHeader: string | null,
  request: Request,
  options: {
    rawBody?: string | null;
    overridePayloadHash?: string | null;
    excludedQueryParams?: readonly string[];
  } = {},
): Promise<string | null> {
  return verifyNip98Token({
    authHeader,
    request,
    rawBody: options.rawBody,
    overridePayloadHash: options.overridePayloadHash ?? null,
    excludedQueryParams: options.excludedQueryParams,
  });
}

export async function requireNip98Auth(c: Context): Promise<string | Response> {
  const npub = await verifyNip98Auth(c.req.raw);
  if (!npub) {
    return c.json({ error: 'nip98 auth required' }, 401);
  }
  return npub;
}

/**
 * Resolved auth identity. signerNpub is the NIP-98 event signer.
 * userNpub is the real user identity — same as signerNpub for direct auth,
 * or the resolved real npub when the signer is a workspace session key.
 */
export interface ResolvedAuth {
  signerNpub: string;
  userNpub: string;
}

export type StrictNip98ReasonCode =
  | 'nip98_auth_required'
  | 'nip98_invalid_encoding'
  | 'nip98_invalid_event'
  | 'nip98_wrong_kind'
  | 'nip98_url_mismatch'
  | 'nip98_method_mismatch'
  | 'nip98_stale_event'
  | 'nip98_payload_required'
  | 'nip98_payload_mismatch';

export type StrictNip98Verification =
  | {
      ok: true;
      eventId: string;
      eventCreatedAt: number;
      payloadHash: string;
      signerNpub: string;
      userNpub: string;
    }
  | {
      ok: false;
      reasonCode: StrictNip98ReasonCode;
      eventId?: string;
      eventCreatedAt?: number;
      payloadHash?: string;
      signerNpub?: string;
    };

/**
 * Route-specific strict NIP-98 verification for replay-sensitive mutations.
 *
 * Ordinary Tower routes retain their normal age and payload behavior. This
 * verifier additionally requires a unique payload tag for every request,
 * returns the signed event ID for durable one-time consumption, and applies a
 * short mutation-only age/skew window.
 */
export async function verifyStrictNip98Mutation(
  authHeader: string | null,
  request: Request,
  rawBody: string,
  options: { maxEventAgeSeconds?: number } = {},
): Promise<StrictNip98Verification> {
  if (!authHeader?.startsWith('Nostr ')) {
    return { ok: false, reasonCode: 'nip98_auth_required' };
  }

  let event: any;
  try {
    const token = authHeader.slice(6).trim();
    event = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return { ok: false, reasonCode: 'nip98_invalid_encoding' };
  }

  let validEvent = false;
  try {
    validEvent = verifyEvent(event);
  } catch {
    validEvent = false;
  }
  if (!validEvent) {
    return { ok: false, reasonCode: 'nip98_invalid_event' };
  }

  const signerNpub = nip19.npubEncode(event.pubkey);
  const eventContext = {
    eventId: String(event.id),
    eventCreatedAt: Number(event.created_at),
    signerNpub,
  };
  if (event.kind !== NIP98_KIND) {
    return { ok: false, reasonCode: 'nip98_wrong_kind', ...eventContext };
  }

  const uTags = event.tags?.filter((tag: unknown) => Array.isArray(tag) && tag[0] === 'u') ?? [];
  if (uTags.length !== 1 || typeof uTags[0]?.[1] !== 'string' || !uTags[0][1].trim()) {
    return { ok: false, reasonCode: 'nip98_url_mismatch', ...eventContext };
  }
  try {
    if (new URL(uTags[0][1]).toString() !== getEffectiveRequestUrl(request).toString()) {
      return { ok: false, reasonCode: 'nip98_url_mismatch', ...eventContext };
    }
  } catch {
    return { ok: false, reasonCode: 'nip98_url_mismatch', ...eventContext };
  }

  const methodTags = event.tags?.filter((tag: unknown) => Array.isArray(tag) && tag[0] === 'method') ?? [];
  if (
    methodTags.length !== 1
    || typeof methodTags[0]?.[1] !== 'string'
    || !methodTags[0][1].trim()
    || methodTags[0][1].toUpperCase() !== request.method.toUpperCase()
  ) {
    return { ok: false, reasonCode: 'nip98_method_mismatch', ...eventContext };
  }

  const maxEventAgeSeconds = options.maxEventAgeSeconds ?? STRICT_MUTATION_MAX_EVENT_AGE_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(eventContext.eventCreatedAt) || Math.abs(now - eventContext.eventCreatedAt) > maxEventAgeSeconds) {
    return { ok: false, reasonCode: 'nip98_stale_event', ...eventContext };
  }

  const payloadTags = event.tags?.filter((tag: unknown) => Array.isArray(tag) && tag[0] === 'payload') ?? [];
  if (payloadTags.length !== 1 || typeof payloadTags[0]?.[1] !== 'string' || !payloadTags[0][1].trim()) {
    return { ok: false, reasonCode: 'nip98_payload_required', ...eventContext };
  }
  const payloadHash = String(payloadTags[0][1]).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(payloadHash) || payloadHash !== sha256Hex(rawBody)) {
    return { ok: false, reasonCode: 'nip98_payload_mismatch', payloadHash, ...eventContext };
  }

  const resolvedUserNpub = await resolveWsKeyNpub(signerNpub);
  return {
    ok: true,
    ...eventContext,
    payloadHash,
    userNpub: resolvedUserNpub ?? signerNpub,
  };
}

// Compatibility name retained for the original Git credential-exchange route.
export const verifyStrictNip98Exchange = verifyStrictNip98Mutation;

async function resolveNip98Signer(signerNpub: string): Promise<ResolvedAuth> {
  const resolvedUserNpub = await resolveWsKeyNpub(signerNpub);
  return {
    signerNpub,
    userNpub: resolvedUserNpub ?? signerNpub,
  };
}

export async function resolveNip98AuthHeader(
  authHeader: string | null,
  request: Request,
  options: {
    rawBody?: string | null;
    overridePayloadHash?: string | null;
    excludedQueryParams?: readonly string[];
  } = {},
): Promise<ResolvedAuth | null> {
  const signerNpub = await verifyNip98AuthHeader(authHeader, request, options);
  return signerNpub ? resolveNip98Signer(signerNpub) : null;
}

/**
 * NIP-98 auth with workspace session key resolution.
 *
 * 1. Verify NIP-98 signature → signerNpub
 * 2. Check: is signerNpub a registered ws_key_npub? → resolve to real userNpub
 * 3. Otherwise: signerNpub === userNpub (backward compat)
 */
export async function requireNip98AuthResolved(c: Context): Promise<ResolvedAuth | Response> {
  const signerNpub = await verifyNip98Auth(c.req.raw);
  if (!signerNpub) {
    return c.json({ error: 'nip98 auth required' }, 401);
  }

  return resolveNip98Signer(signerNpub);
}
