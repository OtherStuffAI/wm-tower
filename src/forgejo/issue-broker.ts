import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { GitIssue, GitIssueAuthor, GitIssueComment, GitIssueLabel } from '../types';
import { secretEnv } from '../secret-env';

type IssueBrokerOptions = {
  forgejoUrl: string;
  brokerToken: string;
  fetchImpl?: typeof fetch;
};

type BrokerRepository = {
  forgejo_owner: string;
  forgejo_repository: string;
  actor_username: string;
  actor_display_name?: string | null;
};

class IssueBrokerError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

const ownerPattern = /^[a-z0-9][a-z0-9-]{0,38}$/;
const repositoryPattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const usernamePattern = /^[a-z0-9][a-z0-9-]{0,38}$/;

function safeInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new IssueBrokerError('git_issue_validation_error', `${field} is invalid`, 400);
  }
  return parsed;
}

function safeString(value: unknown, field: string, maximum: number, required = true): string {
  const normalized = String(value ?? '').trim();
  if ((required && !normalized) || normalized.length > maximum) {
    throw new IssueBrokerError('git_issue_validation_error', `${field} is invalid`, 400);
  }
  return normalized;
}

function repositoryInput(body: any): BrokerRepository {
  const forgejoOwner = safeString(body?.forgejo_owner, 'forgejo_owner', 39).toLowerCase();
  const forgejoRepository = safeString(body?.forgejo_repository, 'forgejo_repository', 63).toLowerCase();
  const actorUsername = safeString(body?.actor_username, 'actor_username', 39).toLowerCase();
  if (!ownerPattern.test(forgejoOwner) || !repositoryPattern.test(forgejoRepository) || !usernamePattern.test(actorUsername)) {
    throw new IssueBrokerError('git_issue_validation_error', 'Repository or actor identity is invalid', 400);
  }
  return {
    forgejo_owner: forgejoOwner,
    forgejo_repository: forgejoRepository,
    actor_username: actorUsername,
    actor_display_name: safeString(body?.actor_display_name, 'actor_display_name', 255, false) || null,
  };
}

function author(value: any): GitIssueAuthor {
  return {
    username: String(value?.login || value?.username || ''),
    display_name: String(value?.full_name || '').trim() || null,
  };
}

function label(value: any): GitIssueLabel {
  return {
    name: String(value?.name || ''),
    color: String(value?.color || '').trim() || null,
  };
}

function issue(value: any): GitIssue {
  return {
    issue_number: Number(value?.number || 0),
    title: String(value?.title || ''),
    body: String(value?.body || ''),
    state: value?.state === 'closed' ? 'closed' : 'open',
    url: String(value?.html_url || ''),
    author: author(value?.user),
    labels: Array.isArray(value?.labels) ? value.labels.map(label) : [],
    comment_count: Number(value?.comments || 0),
    created_at: String(value?.created_at || ''),
    updated_at: String(value?.updated_at || ''),
    closed_at: value?.closed_at ? String(value.closed_at) : null,
  };
}

function comment(value: any, issueNumber: number): GitIssueComment {
  return {
    comment_id: Number(value?.id || 0),
    issue_number: issueNumber,
    body: String(value?.body || ''),
    url: String(value?.html_url || ''),
    author: author(value?.user),
    created_at: String(value?.created_at || ''),
    updated_at: String(value?.updated_at || ''),
  };
}

function authenticate(c: Context, expected: string): Response | null {
  if (expected.length < 32) {
    return c.json({ error: 'Issue broker authentication is not configured', code: 'git_issue_broker_unconfigured' }, 503);
  }
  const provided = String(c.req.header('x-wingman-issue-broker-token') || '');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return c.json({ error: 'Issue broker authentication failed', code: 'git_issue_broker_auth_invalid' }, 401);
  }
  return null;
}

async function body(c: Context): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    throw new IssueBrokerError('git_issue_validation_error', 'Request body must be valid JSON', 400);
  }
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof IssueBrokerError) {
    return c.json({ error: error.message, code: error.code }, error.status as any);
  }
  console.error('Forgejo issue broker failed', error instanceof Error ? error.name : 'unknown_error');
  return c.json({ error: 'Forgejo issue broker failed', code: 'git_issue_broker_error' }, 500);
}

export function createIssueBrokerApp(options: IssueBrokerOptions) {
  const app = new Hono();
  const forgejoUrl = options.forgejoUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  async function providerRequest(repository: BrokerRepository, path: string, init: RequestInit = {}, accepted = [200, 201]) {
    if (!forgejoUrl) throw new IssueBrokerError('git_issue_broker_unconfigured', 'Forgejo is not configured', 503);
    const response = await fetchImpl(`${forgejoUrl}/api/v1${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-webauth-user': repository.actor_username,
        ...(repository.actor_display_name ? { 'x-webauth-fullname': repository.actor_display_name } : {}),
        ...init.headers,
      },
    });
    if (!accepted.includes(response.status)) {
      if (response.status === 404) throw new IssueBrokerError('git_issue_not_found', 'Issue not found', 404);
      if (response.status === 401 || response.status === 403) {
        throw new IssueBrokerError('git_issue_provider_denied', 'Forgejo denied issue access', 403);
      }
      if (response.status === 409 || response.status === 412 || response.status === 423) {
        throw new IssueBrokerError('git_issue_provider_conflict', 'Forgejo rejected the issue mutation', 409);
      }
      if (response.status === 422) throw new IssueBrokerError('git_issue_validation_error', 'Forgejo rejected the issue input', 400);
      throw new IssueBrokerError('git_issue_provider_error', `Forgejo issue request failed with status ${response.status}`, 502);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.use('/v1/*', async (c, next) => authenticate(c, options.brokerToken) ?? await next());

  app.post('/v1/issues/list', async (c) => {
    try {
      const input = await body(c);
      const repository = repositoryInput(input);
      const state = ['open', 'closed', 'all'].includes(input?.state) ? input.state : 'open';
      const page = safeInteger(input?.page ?? 1, 'page', 1, 10_000);
      const limit = safeInteger(input?.limit ?? 30, 'limit', 1, 100);
      const base = `/repos/${encodeURIComponent(repository.forgejo_owner)}/${encodeURIComponent(repository.forgejo_repository)}/issues`;
      const values = await providerRequest(repository, `${base}?state=${state}&type=issues&page=${page}&limit=${limit}`);
      if (!Array.isArray(values)) throw new IssueBrokerError('git_issue_provider_error', 'Forgejo returned an invalid issue list', 502);
      return c.json({ issues: values.map(issue) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/v1/issues/read', async (c) => {
    try {
      const input = await body(c);
      const repository = repositoryInput(input);
      const issueNumber = safeInteger(input?.issue_number, 'issue_number', 1, Number.MAX_SAFE_INTEGER);
      const value = await providerRequest(repository, `/repos/${encodeURIComponent(repository.forgejo_owner)}/${encodeURIComponent(repository.forgejo_repository)}/issues/${issueNumber}`);
      return c.json({ issue: issue(value) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/v1/issues/create', async (c) => {
    try {
      const input = await body(c);
      const repository = repositoryInput(input);
      const title = safeString(input?.title, 'title', 255);
      const issueBody = safeString(input?.body, 'body', 100_000, false);
      const value = await providerRequest(
        repository,
        `/repos/${encodeURIComponent(repository.forgejo_owner)}/${encodeURIComponent(repository.forgejo_repository)}/issues`,
        { method: 'POST', body: JSON.stringify({ title, body: issueBody }) },
      );
      return c.json({ issue: issue(value) }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/v1/issues/comment', async (c) => {
    try {
      const input = await body(c);
      const repository = repositoryInput(input);
      const issueNumber = safeInteger(input?.issue_number, 'issue_number', 1, Number.MAX_SAFE_INTEGER);
      const commentBody = safeString(input?.body, 'body', 100_000);
      const value = await providerRequest(
        repository,
        `/repos/${encodeURIComponent(repository.forgejo_owner)}/${encodeURIComponent(repository.forgejo_repository)}/issues/${issueNumber}/comments`,
        { method: 'POST', body: JSON.stringify({ body: commentBody }) },
      );
      return c.json({ comment: comment(value, issueNumber) }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return app;
}

if (import.meta.main) {
  const port = Number.parseInt(process.env.GIT_ISSUE_BROKER_PORT || '3190', 10);
  const app = createIssueBrokerApp({
    forgejoUrl: String(process.env.GIT_FORGEJO_BASE_URL || '').trim(),
    brokerToken: secretEnv('GIT_ISSUE_BROKER_TOKEN'),
  });
  Bun.serve({ port, fetch: app.fetch });
  console.log(`Forgejo issue broker listening on ${port}`);
}
