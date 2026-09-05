import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { requireNip98AuthResolved, verifyStrictNip98Exchange, verifyStrictNip98Mutation } from '../auth';
import { config } from '../config';
import type {
  CreateGitRepositoryGrantRequest,
  CreateGitIssueCommentRequest,
  CreateGitIssueRequest,
  CreateGitRepositoryRequest,
  ClaimGitWorkspaceNamespaceRequest,
  GitCapabilityIntrospectionRequest,
  GitCredentialExchangeRequest,
  RevokeGitCapabilityRequest,
  UpdateGitActorUsernameRequest,
  UpdateGitRepositoryPolicyRequest,
} from '../types';
import {
  appendGitAuditEvent,
  authorizeGitIssueOperation,
  claimGitWorkspaceNamespace,
  consumeGitCredentialExchangeEvent,
  consumeGitNip98MutationEvent,
  createGitRepository,
  createGitRepositoryGrant,
  exchangeGitCredential,
  finishGitCredentialExchangeEvent,
  finishGitNip98MutationEvent,
  GitAuthorityError,
  introspectGitCapability,
  listGitAuditEvents,
  listGitRepositories,
  listGitRepositoryGrants,
  readGitRepository,
  readGitRepositoryPolicy,
  resolveGitRepositoryPath,
  revokeGitCapability,
  revokeGitRepositoryGrant,
  updateGitRepositoryPolicy,
  readGitSharing,
  updateGitSharing,
} from '../services/git-authority';
import {
  gitActorBootstrap,
  listPendingForgejoRepositories,
  acknowledgeForgejoActorAlias,
  acknowledgeForgejoOrganizationReconciliation,
  acknowledgeForgejoReconciliation,
  beginForgejoReconciliation,
  appliedForgejoActorUsername,
  ensureForgejoBinding,
  ingestForgejoWebhook,
  listPendingForgejoActorAliases,
  listPendingForgejoWorkspaceBindings,
  listForgejoActorBindings,
  syncForgejoActorBinding,
  readForgejoDesiredState,
  readForgejoOrganizationDesiredState,
  readGitActorUsername,
  requestGitActorUsername,
  resolveForgejoRepositoryPath,
  validateForgejoBrowserActor,
} from '../services/forgejo-authority';
import {
  createForgejoIssue,
  createForgejoIssueComment,
  listForgejoIssues,
  readForgejoIssue,
  type GitIssueBrokerRepository,
} from '../forgejo/issue-client';

export const gitRouter = new Hono();

gitRouter.get('/forgejo/sharing/:owner/:repository', async c => {
  c.header('cache-control', 'no-store');
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try { return c.json(await readGitSharing(c.req.param('owner'), c.req.param('repository'), auth.userNpub)); }
  catch (error) { return errorResponse(c, error); }
});

gitRouter.post('/forgejo/sharing/:owner/:repository', async c => {
  c.header('cache-control', 'no-store');
  const operation = 'git.sharing.update';
  const raw = await c.req.raw.clone().text();
  const proof = await verifyStrictNip98Mutation(c.req.header('authorization') || null, c.req.raw, raw);
  if (!proof.ok) return c.json({ error: 'Sharing signature invalid', code: proof.reasonCode }, 401);
  const consumed = await consumeGitNip98MutationEvent(operation, proof);
  // Do not return an old success after a later downgrade/revocation.
  if (consumed.state !== 'consumed') return c.json({ error: 'Sharing command already consumed; reload', code: 'git_mutation_replayed_event' }, 409);
  try {
    let input: import('../types').GitSharingMutation;
    try { input = JSON.parse(raw); } catch { throw new GitAuthorityError('git_sharing_invalid', 'Invalid sharing command', 400); }
    const result = await updateGitSharing(c.req.param('owner'), c.req.param('repository'), proof.userNpub, proof.signerNpub, input);
    await finishGitNip98MutationEvent({ eventId: proof.eventId, actorId: result.actor_id, workspaceId: result.workspace_id,
      repositoryId: result.repository_id, decision: 'allow', reasonCode: 'git_sharing_updated', result });
    return c.json(result, 202);
  } catch (error) {
    await finishGitNip98MutationEvent({ eventId: proof.eventId, decision: 'deny', reasonCode: error instanceof GitAuthorityError ? error.code : 'git_internal_error' });
    await recordPublicDenial(operation, proof, error);
    return errorResponse(c, error);
  }
});

function errorResponse(c: Context, error: unknown) {
  if (error instanceof GitAuthorityError) {
    return c.json({ error: error.message, code: error.code }, error.status as any);
  }
  // Never log request bodies, Authorization material, or bearer capabilities.
  console.error('Git authority request failed', error instanceof Error ? error.name : 'unknown_error');
  return c.json({ error: 'Git authority request failed', code: 'git_internal_error' }, 500);
}

async function publicAuth(c: Context) {
  const auth = await requireNip98AuthResolved(c);
  return auth;
}

function internalServiceAuth(c: Context): Response | null {
  const configured = config.git.internalServiceToken;
  if (!configured || configured.length < 32) {
    return c.json({ error: 'Git internal service authentication is not configured', code: 'git_internal_auth_unconfigured' }, 503);
  }
  const provided = String(c.req.header('x-wingman-git-service-token') || '');
  const expectedBuffer = Buffer.from(configured, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return c.json({ error: 'Git internal service authentication failed', code: 'git_internal_auth_invalid' }, 401);
  }
  return null;
}

async function readBody<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new GitAuthorityError('git_validation_error', 'Request body must be valid JSON', 400);
  }
}

async function recordPublicDenial(operation: string, auth: { signerNpub: string; userNpub: string }, error: unknown) {
  if (!(error instanceof GitAuthorityError)) return;
  try {
    await appendGitAuditEvent({
      actorNpub: auth.userNpub,
      signerNpub: auth.signerNpub,
      operation,
      decision: 'deny',
      reasonCode: error.code,
    });
  } catch {
    // The API denial remains authoritative even if audit persistence itself is
    // unavailable; callers never receive hidden repository detail.
  }
}

function normalizedIssueString(value: unknown, field: string, maximum: number, required = true): string {
  const normalized = String(value ?? '').trim();
  if ((required && !normalized) || normalized.length > maximum) {
    throw new GitAuthorityError('git_validation_error', `${field} is invalid`, 400);
  }
  return normalized;
}

function issueNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new GitAuthorityError('git_validation_error', 'issue_number is invalid', 400);
  }
  return parsed;
}

async function issueBrokerRepository(
  workspaceId: string,
  repositoryId: string,
  actorNpub: string,
  access: 'read' | 'write',
): Promise<{
  broker: GitIssueBrokerRepository;
  actorId: string;
  actorNpub: string;
  policyRevision: number;
}> {
  const authorized = await authorizeGitIssueOperation(workspaceId, repositoryId, actorNpub, access);
  const binding = await ensureForgejoBinding(repositoryId);
  if (
    authorized.repository.state !== 'active'
    || binding.state !== 'ready'
    || binding.applied_policy_revision !== authorized.repository.policy_revision
  ) {
    throw new GitAuthorityError('git_issue_provider_access_not_ready', 'Forgejo issue access is not reconciled', 409);
  }
  return {
    broker: {
      forgejo_owner: binding.forgejo_owner,
      forgejo_repository: binding.forgejo_repository,
      actor_username: await appliedForgejoActorUsername(authorized.actorId),
      actor_display_name: authorized.actorDisplayName,
    },
    actorId: authorized.actorId,
    actorNpub: authorized.actorNpub,
    policyRevision: authorized.repository.policy_revision,
  };
}

gitRouter.put('/workspaces/:workspaceId/namespace', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const body = await readBody<ClaimGitWorkspaceNamespaceRequest>(c);
    const namespace = await claimGitWorkspaceNamespace(
      c.req.param('workspaceId'), auth.userNpub, auth.signerNpub, body.namespace,
    );
    return c.json({ namespace });
  } catch (error) {
    await recordPublicDenial('git.namespace.claim', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.on(['GET', 'POST'], '/workspaces/:workspaceId/actor-bootstrap', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const result = await gitActorBootstrap(c.req.param('workspaceId'), auth.userNpub, auth.signerNpub, c.req.method === 'POST');
    return c.json({ bootstrap: result }, c.req.method === 'POST' ? 202 : 200);
  } catch (error) { return errorResponse(c, error); }
});

gitRouter.get('/internal/forgejo/repositories/pending', async (c) => {
  const failure = internalServiceAuth(c); if (failure) return failure;
  try { return c.json({ repositories: await listPendingForgejoRepositories() }); }
  catch (error) { return errorResponse(c, error); }
});

gitRouter.get('/workspaces/:workspaceId/actor-username', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    return c.json({ actor_username: await readGitActorUsername(c.req.param('workspaceId'), auth.userNpub) });
  } catch (error) {
    await recordPublicDenial('git.actor_username.read', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.put('/workspaces/:workspaceId/actor-username', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const body = await readBody<UpdateGitActorUsernameRequest>(c);
    return c.json({
      actor_username: await requestGitActorUsername(
        c.req.param('workspaceId'), auth.userNpub, auth.signerNpub, body.username,
      ),
    }, 202);
  } catch (error) {
    await recordPublicDenial('git.actor_username.request', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.post('/workspaces/:workspaceId/repositories', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const repository = await createGitRepository(c.req.param('workspaceId'), auth.userNpub, auth.signerNpub, await readBody<CreateGitRepositoryRequest>(c));
    await ensureForgejoBinding(repository.repository_id);
    return c.json({ repository }, 201);
  } catch (error) {
    await recordPublicDenial('git.repository.create', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.get('/workspaces/:workspaceId/repositories', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const repositories = await listGitRepositories(c.req.param('workspaceId'), auth.userNpub);
    return c.json({ repositories });
  } catch (error) {
    await recordPublicDenial('git.repository.list', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.get('/workspaces/:workspaceId/repositories/resolve', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    return c.json(await resolveGitRepositoryPath(
      c.req.param('workspaceId'), c.req.query('path') || '', auth.userNpub,
    ));
  } catch (error) {
    await recordPublicDenial('git.repository.resolve', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.get('/workspaces/:workspaceId/repositories/:repositoryId', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const repository = await readGitRepository(c.req.param('workspaceId'), c.req.param('repositoryId'), auth.userNpub);
    return c.json({ repository });
  } catch (error) {
    await recordPublicDenial('git.repository.read', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.post('/workspaces/:workspaceId/repositories/:repositoryId/grants', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const result = await createGitRepositoryGrant(
      c.req.param('workspaceId'),
      c.req.param('repositoryId'),
      auth.userNpub,
      auth.signerNpub,
      await readBody<CreateGitRepositoryGrantRequest>(c),
    );
    await ensureForgejoBinding(c.req.param('repositoryId'));
    return c.json({ grant: result.grant, policy_revision: result.policyRevision }, 201);
  } catch (error) {
    await recordPublicDenial('git.grant.create', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.get('/workspaces/:workspaceId/repositories/:repositoryId/grants', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const grants = await listGitRepositoryGrants(c.req.param('workspaceId'), c.req.param('repositoryId'), auth.userNpub);
    return c.json({ grants });
  } catch (error) {
    await recordPublicDenial('git.grant.list', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.delete('/workspaces/:workspaceId/repositories/:repositoryId/grants/:grantId', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const result = await revokeGitRepositoryGrant(
      c.req.param('workspaceId'),
      c.req.param('repositoryId'),
      c.req.param('grantId'),
      auth.userNpub,
      auth.signerNpub,
    );
    await ensureForgejoBinding(c.req.param('repositoryId'));
    return c.json({ grant: result.grant, policy_revision: result.policyRevision });
  } catch (error) {
    await recordPublicDenial('git.grant.revoke', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.get('/workspaces/:workspaceId/repositories/:repositoryId/policy', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const policy = await readGitRepositoryPolicy(c.req.param('workspaceId'), c.req.param('repositoryId'), auth.userNpub);
    return c.json({ policy });
  } catch (error) {
    await recordPublicDenial('git.policy.read', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.patch('/workspaces/:workspaceId/repositories/:repositoryId/policy', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const policy = await updateGitRepositoryPolicy(
      c.req.param('workspaceId'),
      c.req.param('repositoryId'),
      auth.userNpub,
      auth.signerNpub,
      await readBody<UpdateGitRepositoryPolicyRequest>(c),
    );
    await ensureForgejoBinding(c.req.param('repositoryId'));
    return c.json({ policy });
  } catch (error) {
    await recordPublicDenial('git.policy.update', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.get('/workspaces/:workspaceId/repositories/:repositoryId/issues', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const stateValue = String(c.req.query('state') || 'open');
    if (!['open', 'closed', 'all'].includes(stateValue)) {
      throw new GitAuthorityError('git_validation_error', 'state is invalid', 400);
    }
    const page = Number.parseInt(c.req.query('page') || '1', 10);
    const limit = Number.parseInt(c.req.query('limit') || '30', 10);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new GitAuthorityError('git_validation_error', 'Issue pagination is invalid', 400);
    }
    const context = await issueBrokerRepository(
      c.req.param('workspaceId'), c.req.param('repositoryId'), auth.userNpub, 'read',
    );
    const issues = await listForgejoIssues(context.broker, {
      state: stateValue as 'open' | 'closed' | 'all', page, limit,
    });
    return c.json({ issues });
  } catch (error) {
    await recordPublicDenial('git.issue.list', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.get('/workspaces/:workspaceId/repositories/:repositoryId/issues/:issueNumber', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const context = await issueBrokerRepository(
      c.req.param('workspaceId'), c.req.param('repositoryId'), auth.userNpub, 'read',
    );
    return c.json({ issue: await readForgejoIssue(context.broker, issueNumber(c.req.param('issueNumber'))) });
  } catch (error) {
    await recordPublicDenial('git.issue.read', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.post('/workspaces/:workspaceId/repositories/:repositoryId/issues', async (c) => {
  const operation = 'git.issue.create';
  const rawBody = await c.req.raw.clone().text();
  const verification = await verifyStrictNip98Mutation(c.req.header('authorization') || null, c.req.raw, rawBody);
  if (!verification.ok) {
    try {
      await appendGitAuditEvent({
        signerNpub: verification.signerNpub ?? null,
        operation,
        decision: 'deny',
        reasonCode: verification.reasonCode,
      });
    } catch {}
    return c.json({ error: 'Strict NIP-98 issue mutation verification failed', code: verification.reasonCode }, 401);
  }
  const consumption = await consumeGitNip98MutationEvent(operation, verification);
  if (consumption.state === 'cached') return c.json(consumption.result as any, 200);
  if (consumption.state === 'replayed') {
    await appendGitAuditEvent({
      actorNpub: verification.userNpub,
      signerNpub: verification.signerNpub,
      operation,
      decision: 'deny',
      reasonCode: 'git_mutation_replayed_event',
    });
    return c.json({ error: 'NIP-98 mutation event was already consumed', code: 'git_mutation_replayed_event' }, 409);
  }
  let context: Awaited<ReturnType<typeof issueBrokerRepository>> | null = null;
  try {
    let input: CreateGitIssueRequest;
    try {
      input = JSON.parse(rawBody) as CreateGitIssueRequest;
    } catch {
      throw new GitAuthorityError('git_validation_error', 'Request body must be valid JSON', 400);
    }
    const title = normalizedIssueString(input.title, 'title', 255);
    const body = normalizedIssueString(input.body, 'body', 100_000, false);
    const correlationId = input.correlation_id
      ? normalizedIssueString(input.correlation_id, 'correlation_id', 128)
      : randomUUID();
    context = await issueBrokerRepository(
      c.req.param('workspaceId'), c.req.param('repositoryId'), verification.userNpub, 'write',
    );
    const result = { issue: await createForgejoIssue(context.broker, { title, body }) };
    await finishGitNip98MutationEvent({
      eventId: verification.eventId,
      actorId: context.actorId,
      workspaceId: c.req.param('workspaceId'),
      repositoryId: c.req.param('repositoryId'),
      decision: 'allow',
      reasonCode: 'git_issue_created',
      result,
    });
    await appendGitAuditEvent({
      workspaceId: c.req.param('workspaceId'), repositoryId: c.req.param('repositoryId'),
      actorId: context.actorId, actorNpub: context.actorNpub, signerNpub: verification.signerNpub,
      operation, requestedScope: 'git.issue.write', decision: 'allow',
      reasonCode: 'git_issue_created', policyRevision: context.policyRevision, correlationId,
    });
    return c.json(result, 201);
  } catch (error) {
    const reasonCode = error instanceof GitAuthorityError ? error.code : 'git_internal_error';
    await finishGitNip98MutationEvent({
      eventId: verification.eventId,
      actorId: context?.actorId,
      workspaceId: context ? c.req.param('workspaceId') : null,
      repositoryId: context ? c.req.param('repositoryId') : null,
      decision: 'deny',
      reasonCode,
    });
    try {
      await appendGitAuditEvent({
        ...(context ? {
          workspaceId: c.req.param('workspaceId'), repositoryId: c.req.param('repositoryId'),
        } : {}),
        actorId: context?.actorId, actorNpub: verification.userNpub, signerNpub: verification.signerNpub,
        operation, requestedScope: 'git.issue.write', decision: 'deny', reasonCode,
        policyRevision: context?.policyRevision,
      });
    } catch {}
    return errorResponse(c, error);
  }
});

gitRouter.post('/workspaces/:workspaceId/repositories/:repositoryId/issues/:issueNumber/comments', async (c) => {
  const operation = 'git.issue.comment';
  const rawBody = await c.req.raw.clone().text();
  const verification = await verifyStrictNip98Mutation(c.req.header('authorization') || null, c.req.raw, rawBody);
  if (!verification.ok) {
    try {
      await appendGitAuditEvent({
        signerNpub: verification.signerNpub ?? null,
        operation,
        decision: 'deny',
        reasonCode: verification.reasonCode,
      });
    } catch {}
    return c.json({ error: 'Strict NIP-98 issue mutation verification failed', code: verification.reasonCode }, 401);
  }
  const consumption = await consumeGitNip98MutationEvent(operation, verification);
  if (consumption.state === 'cached') return c.json(consumption.result as any, 200);
  if (consumption.state === 'replayed') {
    await appendGitAuditEvent({
      actorNpub: verification.userNpub,
      signerNpub: verification.signerNpub,
      operation,
      decision: 'deny',
      reasonCode: 'git_mutation_replayed_event',
    });
    return c.json({ error: 'NIP-98 mutation event was already consumed', code: 'git_mutation_replayed_event' }, 409);
  }
  let context: Awaited<ReturnType<typeof issueBrokerRepository>> | null = null;
  try {
    let input: CreateGitIssueCommentRequest;
    try {
      input = JSON.parse(rawBody) as CreateGitIssueCommentRequest;
    } catch {
      throw new GitAuthorityError('git_validation_error', 'Request body must be valid JSON', 400);
    }
    const body = normalizedIssueString(input.body, 'body', 100_000);
    const correlationId = input.correlation_id
      ? normalizedIssueString(input.correlation_id, 'correlation_id', 128)
      : randomUUID();
    const number = issueNumber(c.req.param('issueNumber'));
    context = await issueBrokerRepository(
      c.req.param('workspaceId'), c.req.param('repositoryId'), verification.userNpub, 'write',
    );
    const result = { comment: await createForgejoIssueComment(context.broker, number, body) };
    await finishGitNip98MutationEvent({
      eventId: verification.eventId,
      actorId: context.actorId,
      workspaceId: c.req.param('workspaceId'),
      repositoryId: c.req.param('repositoryId'),
      decision: 'allow',
      reasonCode: 'git_issue_comment_created',
      result,
    });
    await appendGitAuditEvent({
      workspaceId: c.req.param('workspaceId'), repositoryId: c.req.param('repositoryId'),
      actorId: context.actorId, actorNpub: context.actorNpub, signerNpub: verification.signerNpub,
      operation, requestedScope: 'git.issue.write', decision: 'allow',
      reasonCode: 'git_issue_comment_created', policyRevision: context.policyRevision, correlationId,
    });
    return c.json(result, 201);
  } catch (error) {
    const reasonCode = error instanceof GitAuthorityError ? error.code : 'git_internal_error';
    await finishGitNip98MutationEvent({
      eventId: verification.eventId,
      actorId: context?.actorId,
      workspaceId: context ? c.req.param('workspaceId') : null,
      repositoryId: context ? c.req.param('repositoryId') : null,
      decision: 'deny',
      reasonCode,
    });
    try {
      await appendGitAuditEvent({
        ...(context ? {
          workspaceId: c.req.param('workspaceId'), repositoryId: c.req.param('repositoryId'),
        } : {}),
        actorId: context?.actorId, actorNpub: verification.userNpub, signerNpub: verification.signerNpub,
        operation, requestedScope: 'git.issue.write', decision: 'deny', reasonCode,
        policyRevision: context?.policyRevision,
      });
    } catch {}
    return errorResponse(c, error);
  }
});

gitRouter.get('/workspaces/:workspaceId/repositories/:repositoryId/audit-events', async (c) => {
  const auth = await publicAuth(c);
  if (auth instanceof Response) return auth;
  try {
    const limit = Number.parseInt(c.req.query('limit') || '100', 10);
    const events = await listGitAuditEvents(c.req.param('workspaceId'), c.req.param('repositoryId'), auth.userNpub, limit);
    return c.json({ events });
  } catch (error) {
    await recordPublicDenial('git.audit.list', auth, error);
    return errorResponse(c, error);
  }
});

gitRouter.post('/credential-exchanges', async (c) => {
  const rawBody = await c.req.raw.clone().text();
  const verification = await verifyStrictNip98Exchange(c.req.header('authorization') || null, c.req.raw, rawBody);
  if (!verification.ok) {
    try {
      await appendGitAuditEvent({
        signerNpub: verification.signerNpub ?? null,
        operation: 'git.credential.exchange',
        decision: 'deny',
        reasonCode: verification.reasonCode,
      });
    } catch {}
    return c.json({ error: 'Strict NIP-98 credential exchange verification failed', code: verification.reasonCode }, 401);
  }
  const consumed = await consumeGitCredentialExchangeEvent(verification);
  if (!consumed) {
    await appendGitAuditEvent({
      actorNpub: verification.userNpub,
      signerNpub: verification.signerNpub,
      operation: 'git.credential.exchange',
      decision: 'deny',
      reasonCode: 'git_exchange_replayed_event',
    });
    return c.json({ error: 'Credential exchange event was already consumed', code: 'git_exchange_replayed_event' }, 409);
  }
  try {
    let body: GitCredentialExchangeRequest;
    try {
      body = JSON.parse(rawBody) as GitCredentialExchangeRequest;
    } catch {
      throw new GitAuthorityError('git_validation_error', 'Request body must be valid JSON', 400);
    }
    const response = await exchangeGitCredential(body, verification);
    return c.json(response, 201);
  } catch (error) {
    const reasonCode = error instanceof GitAuthorityError ? error.code : 'git_internal_error';
    await finishGitCredentialExchangeEvent({
      eventId: verification.eventId,
      decision: 'deny',
      reasonCode,
    });
    try {
      await appendGitAuditEvent({
        actorNpub: verification.userNpub,
        signerNpub: verification.signerNpub,
        operation: 'git.credential.exchange',
        decision: 'deny',
        reasonCode,
      });
    } catch {}
    return errorResponse(c, error);
  }
});

gitRouter.post('/internal/capabilities/introspect', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try {
    return c.json(await introspectGitCapability(await readBody<GitCapabilityIntrospectionRequest>(c)));
  } catch (error) {
    return errorResponse(c, error);
  }
});

gitRouter.post('/internal/capabilities/revoke', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try {
    return c.json(await revokeGitCapability(await readBody<RevokeGitCapabilityRequest>(c)));
  } catch (error) {
    return errorResponse(c, error);
  }
});

gitRouter.get('/internal/forgejo/resolve', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try {
    return c.json(await resolveForgejoRepositoryPath(c.req.query('owner') || '', c.req.query('repository') || ''));
  } catch (error) { return errorResponse(c, error); }
});

gitRouter.post('/internal/forgejo/browser/validate', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try {
    const body = await readBody<{ signer_npub: string; expected_actor_id?: string | null }>(c);
    return c.json(await validateForgejoBrowserActor({
      signerNpub: body.signer_npub,
      expectedActorId: body.expected_actor_id,
    }));
  } catch (error) { return errorResponse(c, error); }
});

gitRouter.get('/internal/forgejo/repositories/:repositoryId/desired-state', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try { return c.json(await readForgejoDesiredState(c.req.param('repositoryId'))); }
  catch (error) { return errorResponse(c, error); }
});

gitRouter.get('/internal/forgejo/organizations/pending', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try { return c.json({ organizations: await listPendingForgejoWorkspaceBindings() }); }
  catch (error) { return errorResponse(c, error); }
});

gitRouter.get('/internal/forgejo/organizations/:workspaceId/desired-state', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try { return c.json(await readForgejoOrganizationDesiredState(c.req.param('workspaceId'))); }
  catch (error) { return errorResponse(c, error); }
});

gitRouter.post('/internal/forgejo/organizations/:workspaceId/ack', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try {
    const body = await readBody<{ forgejo_owner: string; desired_generation: number; ok: boolean; error_code?: string }>(c);
    return c.json(await acknowledgeForgejoOrganizationReconciliation({
      workspaceId: c.req.param('workspaceId'), forgejoOwner: body.forgejo_owner, desiredGeneration: body.desired_generation,
      ok: body.ok === true, errorCode: body.error_code,
    }));
  } catch (error) { return errorResponse(c, error); }
});

gitRouter.get('/internal/forgejo/actor-usernames/pending', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try { return c.json({ actor_usernames: await listPendingForgejoActorAliases() }); }
  catch (error) { return errorResponse(c, error); }
});

gitRouter.get('/internal/forgejo/actor-bindings', async (c) => {
  const authFailure = internalServiceAuth(c); if (authFailure) return authFailure;
  try { return c.json({ actor_bindings: await listForgejoActorBindings() }); }
  catch (error) { return errorResponse(c, error); }
});

gitRouter.post('/internal/forgejo/actor-bindings/:actorId', async (c) => {
  const authFailure = internalServiceAuth(c); if (authFailure) return authFailure;
  try {
    const body = await readBody<{ forgejo_user_id: number; username: string; desired_username?: string }>(c);
    return c.json({ actor_username: await syncForgejoActorBinding({ actorId: c.req.param('actorId'), forgejoUserId: body.forgejo_user_id, username: body.username, desiredUsername: body.desired_username }) });
  } catch (error) { return errorResponse(c, error); }
});

gitRouter.post('/internal/forgejo/actor-usernames/:actorId/ack', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try {
    const body = await readBody<{ desired_username: string; ok: boolean; error_code?: string }>(c);
    return c.json({ actor_username: await acknowledgeForgejoActorAlias({
      actorId: c.req.param('actorId'), desiredUsername: body.desired_username,
      ok: body.ok === true, errorCode: body.error_code,
    }) });
  } catch (error) { return errorResponse(c, error); }
});

gitRouter.post('/internal/forgejo/repositories/:repositoryId/begin', async c => {
  const failure = internalServiceAuth(c); if (failure) return failure;
  try {
    const body = await readBody<{ reconciliation_token: string }>(c);
    return c.json(await beginForgejoReconciliation(c.req.param('repositoryId'), body.reconciliation_token));
  } catch (error) { return errorResponse(c, error); }
});

gitRouter.post('/internal/forgejo/repositories/:repositoryId/ack', async (c) => {
  const authFailure = internalServiceAuth(c);
  if (authFailure) return authFailure;
  try {
    const body = await readBody<{ applied_policy_revision: number; reconciliation_token: string; ok: boolean; error_code?: string }>(c);
    return c.json(await acknowledgeForgejoReconciliation({
      repositoryId: c.req.param('repositoryId'),
      appliedPolicyRevision: body.applied_policy_revision,
      reconciliationToken: body.reconciliation_token,
      ok: body.ok === true,
      errorCode: body.error_code,
    }));
  } catch (error) { return errorResponse(c, error); }
});

gitRouter.post('/forgejo/webhooks', async (c) => {
  try {
    const result = await ingestForgejoWebhook({
      rawBody: await c.req.text(),
      signature: c.req.header('x-forgejo-signature') || c.req.header('x-gitea-signature') || '',
      deliveryId: c.req.header('x-forgejo-delivery') || c.req.header('x-gitea-delivery') || '',
      eventType: c.req.header('x-forgejo-event') || c.req.header('x-gitea-event') || 'unknown',
    });
    return c.json(result, result.duplicate ? 200 : 202);
  } catch (error) { return errorResponse(c, error); }
});
