import { Hono } from 'hono';
import { jsonAgentChatError } from '../agent-chat-errors';
import {
  acquireRecordCheckout,
  fetchRecordHistory,
  fetchRecords,
  fetchRecordsSummary,
  heartbeatCheck,
  RecordCheckoutError,
  releaseRecordCheckout,
  renewRecordCheckout,
  syncRecords,
} from '../services/records';
import { diagnoseWorkspaceRuntimeAccess } from '../services/agent-chat-access';
import { getInsufficientCreditsBlock } from '../services/billing';
import { getCurrentGroupEpoch, getGroupByCurrentNpub } from '../services/groups';
import { requireNip98AuthResolved, verifyNip98AuthHeader } from '../auth';
import {
  identityNormalizationErrorBody,
  isIdentityNormalizationError,
  normalizeAliasedIdentityField,
  normalizeWorkspaceServiceNpub,
  normalizeWorkspaceUserKeyNpub,
} from '../identity-normalization';
import {
  isWorkspaceUserKeyDelegationError,
  requireWorkspaceUserKeyDelegation,
} from '../services/user-workspace-keys';
import type {
  AcquireRecordCheckoutInput,
  FetchRecordsInput,
  FetchRecordsSummaryInput,
  HeartbeatRequestBody,
  ReleaseRecordCheckoutInput,
  RenewRecordCheckoutInput,
  SyncRequestBody,
} from '../types';

export const recordsRouter = new Hono();

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildGroupWriteProofHash(body: Record<string, unknown>) {
  const { group_write_tokens: _groupWriteTokens, ...proofBody } = body;
  return JSON.stringify(proofBody);
}

function buildRecordsAudit(workspaceServiceNpub: string, signerNpub: string, userNpub: string) {
  const workspaceUserKeyNpub = signerNpub === userNpub ? null : signerNpub;
  return {
    workspace_owner_npub: workspaceServiceNpub,
    workspace_service_npub: workspaceServiceNpub,
    signer_npub: signerNpub,
    user_npub: userNpub,
    viewer_npub: userNpub,
    actor_npub: userNpub,
    ws_key_npub: workspaceUserKeyNpub,
    workspace_user_key_npub: workspaceUserKeyNpub,
  };
}

async function requireRecordRuntimeAccess(c: any, signerNpub: string, userNpub: string, workspaceServiceNpub: string) {
  const diagnosed = await diagnoseWorkspaceRuntimeAccess(signerNpub, userNpub, workspaceServiceNpub);
  if (!('code' in diagnosed)) return null;

  return jsonAgentChatError(
    c,
    403,
    'record_pull_forbidden',
    'record pull is forbidden for this actor',
    {
      reason_code: diagnosed.code,
      workspace_owner_npub: diagnosed.workspaceOwnerNpub,
      actor_npub: diagnosed.actorNpub,
      ws_key_npub: diagnosed.wsKeyNpub,
      details: diagnosed.details,
    },
  );
}

function hasNonEmptyField(input: Record<string, unknown>, field: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(input, field)) return false;
  const value = input[field];
  return value != null && String(value).trim().length > 0;
}

function hasCanonicalWorkspaceUserKeyField(input: Record<string, unknown>): boolean {
  return hasNonEmptyField(input, 'workspace_user_key_npub');
}

function readWorkspaceUserKeyFromRequestParts(
  inputs: Record<string, unknown>[],
): { workspaceUserKeyNpub?: string; canonicalFieldPresent: boolean } {
  const values: string[] = [];
  let canonicalFieldPresent = false;

  for (const input of inputs) {
    if (hasCanonicalWorkspaceUserKeyField(input)) canonicalFieldPresent = true;
    const normalized = normalizeWorkspaceUserKeyNpub(input);
    if (normalized) values.push(normalized);
  }

  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length > 1) {
    throw new Error('workspace_user_key_npub values must match when provided');
  }

  return {
    workspaceUserKeyNpub: uniqueValues[0],
    canonicalFieldPresent,
  };
}

function workspaceUserKeyMismatchResponse(c: any, error: unknown) {
  if (isIdentityNormalizationError(error)) {
    return c.json(identityNormalizationErrorBody(error), 400);
  }
  if (error instanceof Error && error.message.includes('workspace_user_key_npub')) {
    return c.json({ error: error.message, code: 'identity_alias_mismatch' }, 400);
  }
  throw error;
}

function readWorkspaceUserKeyFromQuery(c: any) {
  return readWorkspaceUserKeyFromRequestParts([{
    ws_key_npub: c.req.query('ws_key_npub'),
    workspace_user_key_npub: c.req.query('workspace_user_key_npub'),
  }]);
}

function delegationErrorResponse(c: any, error: unknown) {
  if (!isWorkspaceUserKeyDelegationError(error)) throw error;
  return jsonAgentChatError(
    c,
    403,
    error.code,
    error.message,
    {
      reason_code: error.code,
      workspace_owner_npub: error.workspaceServiceNpub,
      workspace_service_npub: error.workspaceServiceNpub,
      user_npub: error.userNpub,
      signer_npub: error.signerNpub,
      actor_npub: error.userNpub,
      ws_key_npub: error.workspaceUserKeyNpub,
      workspace_user_key_npub: error.workspaceUserKeyNpub,
      details: {
        signer_npub: error.signerNpub,
        workspace_service_npub: error.workspaceServiceNpub,
        workspace_user_key_npub: error.workspaceUserKeyNpub,
        ...(error.details || {}),
      },
    },
  );
}

async function requireCanonicalDelegationIfPresent(
  c: any,
  {
    canonicalFieldPresent,
    workspaceUserKeyNpub,
    workspaceServiceNpub,
    signerNpub,
    userNpub,
  }: {
    canonicalFieldPresent: boolean;
    workspaceUserKeyNpub?: string;
    workspaceServiceNpub: string;
    signerNpub: string;
    userNpub: string;
  },
) {
  if (!canonicalFieldPresent) return null;
  try {
    await requireWorkspaceUserKeyDelegation({
      userNpub,
      workspaceServiceNpub,
      workspaceUserKeyNpub,
      signerNpub,
    });
    return null;
  } catch (error) {
    return delegationErrorResponse(c, error);
  }
}

function validateCanonicalIdentityHints(c: any, body: Record<string, unknown>, signerNpub: string, userNpub: string) {
  let requestUserNpub: string | undefined;
  try {
    requestUserNpub = normalizeAliasedIdentityField(body, ['user_npub', 'actor_npub', 'viewer_npub'], 'userNpub');
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }
  if (requestUserNpub && requestUserNpub !== userNpub) {
    return c.json({ error: 'user_npub, actor_npub, and viewer_npub must match resolved authenticated user_npub' }, 403);
  }

  const requestSignerNpub = typeof body.signer_npub === 'string' ? body.signer_npub.trim() : '';
  if (requestSignerNpub && requestSignerNpub !== signerNpub) {
    return c.json({ error: 'signer_npub must match authenticated signer_npub' }, 403);
  }

  return null;
}

function checkoutErrorResponse(c: any, error: unknown) {
  if (!(error instanceof RecordCheckoutError)) throw error;
  return c.json({
    error: error.message,
    code: error.code,
    status: error.status,
    ...error.payload,
  }, error.status);
}

async function requireCheckoutRequestAuthorization(
  c: any,
  body: Record<string, unknown>,
  auth: { signerNpub: string; userNpub: string },
) {
  let workspaceServiceNpub: string | undefined;
  let workspaceUserKeyNpub: string | undefined;

  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body);
    const workspaceUserKey = readWorkspaceUserKeyFromRequestParts([body]);
    workspaceUserKeyNpub = workspaceUserKey.workspaceUserKeyNpub;
    if (!hasNonEmptyField(body, 'workspace_service_npub')) {
      return {
        response: c.json({
          error: 'workspace_service_npub required for checkout endpoints',
          code: 'identity_alias_mismatch',
          status: 400,
        }, 400),
      };
    }
    if (!hasNonEmptyField(body, 'user_npub')) {
      return {
        response: c.json({
          error: 'user_npub required for checkout endpoints',
          code: 'identity_alias_mismatch',
          status: 400,
        }, 400),
      };
    }
    if (!workspaceUserKey.canonicalFieldPresent || !workspaceUserKeyNpub) {
      return {
        response: c.json({
          error: 'workspace_user_key_npub required for checkout endpoints',
          code: 'workspace_key_missing',
          status: 400,
        }, 400),
      };
    }
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return { response: c.json(identityNormalizationErrorBody(error), 400) };
    }
    return { response: workspaceUserKeyMismatchResponse(c, error) };
  }

  if (!workspaceServiceNpub) {
    return { response: c.json({ error: 'owner_npub or workspace_service_npub required' }, 400) };
  }

  const identityHintError = validateCanonicalIdentityHints(c, body, auth.signerNpub, auth.userNpub);
  if (identityHintError) return { response: identityHintError };

  const delegationError = await requireCanonicalDelegationIfPresent(c, {
    canonicalFieldPresent: true,
    workspaceUserKeyNpub,
    workspaceServiceNpub,
    signerNpub: auth.signerNpub,
    userNpub: auth.userNpub,
  });
  if (delegationError) return { response: delegationError };

  const accessError = await requireRecordRuntimeAccess(c, auth.signerNpub, auth.userNpub, workspaceServiceNpub);
  if (accessError) return { response: accessError };

  return {
    workspaceServiceNpub,
    workspaceUserKeyNpub,
  };
}

function readWorkspaceServiceNpubFromQuery(c: any): string | undefined {
  return normalizeWorkspaceServiceNpub({
    owner_npub: c.req.query('owner_npub'),
    workspace_service_npub: c.req.query('workspace_service_npub'),
  });
}

function isTruthyStrictValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'strict', 'group_id'].includes(value.trim().toLowerCase());
}

function readStrictGroupIdWriteMode(c: any, body: Record<string, unknown>): boolean {
  if (isTruthyStrictValue(body.strict_group_id_writes)) return true;
  if (isTruthyStrictValue(c.req.header('x-superbased-strict-group-id-writes'))) return true;

  const identityStrict = String(c.req.header('x-superbased-identity-strict') || '').toLowerCase();
  return identityStrict.split(',').map((part) => part.trim()).some((part) =>
    part === 'group_id'
    || part === 'write_group_id'
    || part === 'strict_group_id_writes'
  );
}

function strictGroupIdWriteModeError(c: any, body: SyncRequestBody & Record<string, unknown>) {
  if (!readStrictGroupIdWriteMode(c, body)) return null;

  const records = Array.isArray(body.records) ? body.records : [];
  const offenders = records
    .filter((record) => hasNonEmptyField(record as unknown as Record<string, unknown>, 'write_group_npub'))
    .map((record) => ({
      record_id: record.record_id,
      write_group_id: record.write_group_id || null,
      write_group_npub: record.write_group_npub,
    }));

  if (offenders.length === 0) return null;

  return c.json({
    error: 'write_group_npub is not allowed in strict_group_id_writes mode; use write_group_id as the durable write reference and keep group_payloads[].group_npub only as crypto epoch metadata',
    code: 'legacy_write_group_npub_forbidden',
    status: 400,
    details: {
      strict_group_id_writes: true,
      records: offenders,
    },
  }, 400);
}

recordsRouter.post('/:record_id/checkout/acquire', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json<AcquireRecordCheckoutInput & Record<string, unknown>>();
  const authorized = await requireCheckoutRequestAuthorization(c, body, auth);
  if ('response' in authorized) return authorized.response;

  const recordId = c.req.param('record_id');
  const recordFamilyHash = String(body.record_family_hash || '').trim();
  const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
  if (!recordFamilyHash) {
    return c.json({ error: 'record_family_hash required', code: 'checkout_conflict', status: 400 }, 400);
  }
  if (idempotencyKey && !looksLikeUuid(idempotencyKey)) {
    return c.json({ error: 'idempotency_key must be a UUID when provided', code: 'checkout_conflict', status: 400 }, 400);
  }

  try {
    const result = await acquireRecordCheckout({
      workspace_service_npub: authorized.workspaceServiceNpub,
      user_npub: auth.userNpub,
      workspace_user_key_npub: authorized.workspaceUserKeyNpub,
      record_id: recordId,
      record_family_hash: recordFamilyHash,
      lease_seconds: Number.isFinite(Number(body.lease_seconds)) ? Number(body.lease_seconds) : undefined,
      idempotency_key: idempotencyKey || undefined,
    });
    return c.json(result);
  } catch (error) {
    return checkoutErrorResponse(c, error);
  }
});

recordsRouter.post('/:record_id/checkout/release', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json<ReleaseRecordCheckoutInput & Record<string, unknown>>();
  const authorized = await requireCheckoutRequestAuthorization(c, body, auth);
  if ('response' in authorized) return authorized.response;

  const recordId = c.req.param('record_id');
  const recordFamilyHash = String(body.record_family_hash || '').trim();
  const checkoutId = String(body.checkout_id || '').trim();
  if (!recordFamilyHash || !checkoutId) {
    return c.json({ error: 'record_family_hash and checkout_id required', code: 'checkout_conflict', status: 400 }, 400);
  }

  try {
    const result = await releaseRecordCheckout({
      workspace_service_npub: authorized.workspaceServiceNpub,
      user_npub: auth.userNpub,
      workspace_user_key_npub: authorized.workspaceUserKeyNpub,
      record_id: recordId,
      record_family_hash: recordFamilyHash,
      checkout_id: checkoutId,
    });
    return c.json(result);
  } catch (error) {
    return checkoutErrorResponse(c, error);
  }
});

recordsRouter.post('/:record_id/checkout/renew', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json<RenewRecordCheckoutInput & Record<string, unknown>>();
  const authorized = await requireCheckoutRequestAuthorization(c, body, auth);
  if ('response' in authorized) return authorized.response;

  const recordId = c.req.param('record_id');
  const recordFamilyHash = String(body.record_family_hash || '').trim();
  const checkoutId = String(body.checkout_id || '').trim();
  if (!recordFamilyHash || !checkoutId) {
    return c.json({ error: 'record_family_hash and checkout_id required', code: 'checkout_conflict', status: 400 }, 400);
  }

  try {
    const result = await renewRecordCheckout({
      workspace_service_npub: authorized.workspaceServiceNpub,
      user_npub: auth.userNpub,
      workspace_user_key_npub: authorized.workspaceUserKeyNpub,
      record_id: recordId,
      record_family_hash: recordFamilyHash,
      checkout_id: checkoutId,
      lease_seconds: Number.isFinite(Number(body.lease_seconds)) ? Number(body.lease_seconds) : undefined,
    });
    return c.json(result);
  } catch (error) {
    return checkoutErrorResponse(c, error);
  }
});

// POST /api/v4/records/sync
recordsRouter.post('/sync', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { signerNpub, userNpub } = auth;

  const rawBody = await c.req.raw.clone().text();
  const body = await c.req.json<SyncRequestBody & Record<string, unknown>>();

  let workspaceServiceNpub: string | undefined;
  let normalizedRecords: SyncRequestBody['records'];
  let workspaceUserKeyNpub: string | undefined;
  let canonicalWorkspaceUserKeyPresent = false;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body);
    if (Array.isArray(body.records)) {
      normalizedRecords = body.records.map((record) => {
        const recordWorkspaceServiceNpub = normalizeWorkspaceServiceNpub(record as unknown as Record<string, unknown>)
          || workspaceServiceNpub;
        return {
          ...record,
          owner_npub: recordWorkspaceServiceNpub || record.owner_npub,
        };
      });
    }

    const workspaceUserKey = readWorkspaceUserKeyFromRequestParts([
      body,
      ...(Array.isArray(body.records) ? body.records as unknown as Record<string, unknown>[] : []),
    ]);
    workspaceUserKeyNpub = workspaceUserKey.workspaceUserKeyNpub;
    canonicalWorkspaceUserKeyPresent = workspaceUserKey.canonicalFieldPresent;
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    return workspaceUserKeyMismatchResponse(c, error);
  }

  if (!workspaceServiceNpub) {
    return c.json({ error: 'owner_npub or workspace_service_npub required' }, 400);
  }
  if (!body.records || !Array.isArray(body.records)) {
    return c.json({ error: 'records array required' }, 400);
  }

  const billingBlock = await getInsufficientCreditsBlock(workspaceServiceNpub);
  if (billingBlock) return c.json(billingBlock, 402);

  const strictGroupIdError = strictGroupIdWriteModeError(c, body);
  if (strictGroupIdError) return strictGroupIdError;

  if (canonicalWorkspaceUserKeyPresent) {
    const identityHintError = validateCanonicalIdentityHints(c, body, signerNpub, userNpub);
    if (identityHintError) return identityHintError;

    const delegationError = await requireCanonicalDelegationIfPresent(c, {
      canonicalFieldPresent: canonicalWorkspaceUserKeyPresent,
      workspaceUserKeyNpub,
      workspaceServiceNpub,
      signerNpub,
      userNpub,
    });
    if (delegationError) return delegationError;
  }

  try {
    const groupWriteProofPayload = buildGroupWriteProofHash(body);
    const overridePayloadHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(groupWriteProofPayload),
    ).then((digest) => Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join(''));

    const authorizedWriteGroups = new Set<string>();
    for (const [groupRef, token] of Object.entries(body.group_write_tokens || {})) {
      let targetGroupId = '';
      let targetGroupNpub = '';

      const currentEpoch = looksLikeUuid(groupRef) ? await getCurrentGroupEpoch(groupRef) : null;
      if (currentEpoch) {
        targetGroupId = currentEpoch.group_id;
        targetGroupNpub = currentEpoch.group_npub;
      } else {
        const group = await getGroupByCurrentNpub(groupRef);
        if (!group) continue;
        targetGroupId = group.id;
        targetGroupNpub = group.group_npub;
      }

      const proofNpub = await verifyNip98AuthHeader(token, c.req.raw, {
        rawBody,
        overridePayloadHash,
      });
      if (proofNpub && proofNpub === targetGroupNpub) {
        authorizedWriteGroups.add(targetGroupId);
      }
    }

    const result = await syncRecords(
      workspaceServiceNpub,
      normalizedRecords || [],
      signerNpub,
      userNpub,
      authorizedWriteGroups,
      workspaceUserKeyNpub,
    );
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to sync records' }, 500);
  }
});

// POST /api/v4/records/heartbeat
recordsRouter.post('/heartbeat', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { signerNpub, userNpub } = auth;

  const body = await c.req.json<HeartbeatRequestBody & Record<string, unknown>>();
  let workspaceServiceNpub: string | undefined;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }
  if (!workspaceServiceNpub) {
    return c.json({ error: 'owner_npub or workspace_service_npub required' }, 400);
  }
  const requestedViewerNpub = body.viewer_npub;
  const viewerNpub = userNpub;
  // Preserve compatibility by accepting viewer_npub as either signer or real user.
  if (requestedViewerNpub && requestedViewerNpub !== signerNpub && requestedViewerNpub !== userNpub) {
    return c.json({ error: 'viewer_npub must match authenticated npub' }, 403);
  }
  let workspaceUserKey: { workspaceUserKeyNpub?: string; canonicalFieldPresent: boolean };
  try {
    workspaceUserKey = readWorkspaceUserKeyFromRequestParts([body]);
  } catch (error) {
    return workspaceUserKeyMismatchResponse(c, error);
  }
  const delegationError = await requireCanonicalDelegationIfPresent(c, {
    canonicalFieldPresent: workspaceUserKey.canonicalFieldPresent,
    workspaceUserKeyNpub: workspaceUserKey.workspaceUserKeyNpub,
    workspaceServiceNpub,
    signerNpub,
    userNpub,
  });
  if (delegationError) return delegationError;

  const accessError = await requireRecordRuntimeAccess(c, signerNpub, userNpub, workspaceServiceNpub);
  if (accessError) return accessError;

  try {
    const result = await heartbeatCheck(
      workspaceServiceNpub,
      viewerNpub,
      body.family_cursors || {},
    );
    return c.json({
      audit: buildRecordsAudit(workspaceServiceNpub, signerNpub, userNpub),
      ...result,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Heartbeat failed' }, 500);
  }
});

// GET /api/v4/records/:record_id/history?owner_npub=<npub>&viewer_npub=<npub>
recordsRouter.get('/:record_id/history', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { signerNpub, userNpub } = auth;

  const recordId = c.req.param('record_id');
  let workspaceServiceNpub: string | undefined;
  try {
    workspaceServiceNpub = readWorkspaceServiceNpubFromQuery(c);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }
  const requestedViewerNpub = c.req.query('viewer_npub');
  const viewerNpub = userNpub;

  if (!workspaceServiceNpub) {
    return c.json({ error: 'owner_npub or workspace_service_npub query param required' }, 400);
  }
  if (requestedViewerNpub && requestedViewerNpub !== signerNpub && requestedViewerNpub !== userNpub) {
    return c.json({ error: 'viewer_npub must match authenticated npub' }, 403);
  }
  let workspaceUserKey: { workspaceUserKeyNpub?: string; canonicalFieldPresent: boolean };
  try {
    workspaceUserKey = readWorkspaceUserKeyFromQuery(c);
  } catch (error) {
    return workspaceUserKeyMismatchResponse(c, error);
  }
  const delegationError = await requireCanonicalDelegationIfPresent(c, {
    canonicalFieldPresent: workspaceUserKey.canonicalFieldPresent,
    workspaceUserKeyNpub: workspaceUserKey.workspaceUserKeyNpub,
    workspaceServiceNpub,
    signerNpub,
    userNpub,
  });
  if (delegationError) return delegationError;

  const accessError = await requireRecordRuntimeAccess(c, signerNpub, userNpub, workspaceServiceNpub);
  if (accessError) return accessError;

  try {
    const versions = await fetchRecordHistory(recordId, workspaceServiceNpub, viewerNpub);
    if (versions.length === 0) {
      return jsonAgentChatError(
        c,
        404,
        'record_pull_not_found',
        'record history not found for this actor',
        {
          workspace_owner_npub: workspaceServiceNpub,
          actor_npub: userNpub,
          ws_key_npub: signerNpub === userNpub ? null : signerNpub,
        },
      );
    }
    return c.json({
      audit: buildRecordsAudit(workspaceServiceNpub, signerNpub, userNpub),
      versions,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to fetch record history' }, 500);
  }
});

// GET /api/v4/records/summary?owner_npub=<npub>&record_family_hash=<hash>&since=<iso>
recordsRouter.get('/summary', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { signerNpub, userNpub } = auth;

  let workspaceServiceNpub: string | undefined;
  try {
    workspaceServiceNpub = readWorkspaceServiceNpubFromQuery(c);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }
  const requestedViewerNpub = c.req.query('viewer_npub');
  const viewerNpub = userNpub;
  const recordFamilyHash = c.req.query('record_family_hash');
  const since = c.req.query('since');

  if (!workspaceServiceNpub) {
    return c.json({ error: 'owner_npub or workspace_service_npub query param required' }, 400);
  }
  if (requestedViewerNpub && requestedViewerNpub !== signerNpub && requestedViewerNpub !== userNpub) {
    return c.json({ error: 'viewer_npub must match authenticated npub' }, 403);
  }
  let workspaceUserKey: { workspaceUserKeyNpub?: string; canonicalFieldPresent: boolean };
  try {
    workspaceUserKey = readWorkspaceUserKeyFromQuery(c);
  } catch (error) {
    return workspaceUserKeyMismatchResponse(c, error);
  }
  const delegationError = await requireCanonicalDelegationIfPresent(c, {
    canonicalFieldPresent: workspaceUserKey.canonicalFieldPresent,
    workspaceUserKeyNpub: workspaceUserKey.workspaceUserKeyNpub,
    workspaceServiceNpub,
    signerNpub,
    userNpub,
  });
  if (delegationError) return delegationError;

  const accessError = await requireRecordRuntimeAccess(c, signerNpub, userNpub, workspaceServiceNpub);
  if (accessError) return accessError;

  try {
    const families = await fetchRecordsSummary({
      owner_npub: workspaceServiceNpub,
      viewer_npub: viewerNpub,
      record_family_hash: recordFamilyHash || undefined,
      since: since || undefined,
    } satisfies FetchRecordsSummaryInput);
    return c.json({
      audit: buildRecordsAudit(workspaceServiceNpub, signerNpub, userNpub),
      families,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to fetch records summary' }, 500);
  }
});

// GET /api/v4/records?owner_npub=<npub>&record_family_hash=<hash>&since=<iso>
recordsRouter.get('/', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { signerNpub, userNpub } = auth;

  let workspaceServiceNpub: string | undefined;
  try {
    workspaceServiceNpub = readWorkspaceServiceNpubFromQuery(c);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }
  const requestedViewerNpub = c.req.query('viewer_npub');
  const viewerNpub = userNpub;
  const recordFamilyHash = c.req.query('record_family_hash');
  const since = c.req.query('since');

  if (!workspaceServiceNpub) {
    return c.json({ error: 'owner_npub or workspace_service_npub query param required' }, 400);
  }
  if (!recordFamilyHash) {
    return c.json({ error: 'record_family_hash query param required' }, 400);
  }
  if (requestedViewerNpub && requestedViewerNpub !== signerNpub && requestedViewerNpub !== userNpub) {
    return c.json({ error: 'viewer_npub must match authenticated npub' }, 403);
  }
  let workspaceUserKey: { workspaceUserKeyNpub?: string; canonicalFieldPresent: boolean };
  try {
    workspaceUserKey = readWorkspaceUserKeyFromQuery(c);
  } catch (error) {
    return workspaceUserKeyMismatchResponse(c, error);
  }
  const delegationError = await requireCanonicalDelegationIfPresent(c, {
    canonicalFieldPresent: workspaceUserKey.canonicalFieldPresent,
    workspaceUserKeyNpub: workspaceUserKey.workspaceUserKeyNpub,
    workspaceServiceNpub,
    signerNpub,
    userNpub,
  });
  if (delegationError) return delegationError;

  const accessError = await requireRecordRuntimeAccess(c, signerNpub, userNpub, workspaceServiceNpub);
  if (accessError) return accessError;

  const limitParam = c.req.query('limit');
  const offsetParam = c.req.query('offset');
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  const offset = offsetParam ? parseInt(offsetParam, 10) : undefined;

  try {
    const result = await fetchRecords({
      owner_npub: workspaceServiceNpub,
      viewer_npub: viewerNpub,
      record_family_hash: recordFamilyHash,
      since: since || undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    } satisfies FetchRecordsInput);
    return c.json({
      audit: buildRecordsAudit(workspaceServiceNpub, signerNpub, userNpub),
      ...result,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to fetch records' }, 500);
  }
});
