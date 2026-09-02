import { config } from '../config';
import type { GitIssue, GitIssueComment } from '../types';
import { GitAuthorityError } from '../services/git-authority';

export type GitIssueBrokerRepository = {
  forgejo_owner: string;
  forgejo_repository: string;
  actor_username: string;
  actor_display_name: string | null;
};

type BrokerOperation = 'list' | 'read' | 'create' | 'comment';

async function brokerRequest<T>(operation: BrokerOperation, body: Record<string, unknown>): Promise<T> {
  if (!config.git.issueBrokerUrl || config.git.issueBrokerToken.length < 32) {
    throw new GitAuthorityError('git_issue_broker_unconfigured', 'Git issue brokerage is not configured', 503);
  }
  let response: Response;
  try {
    response = await fetch(`${config.git.issueBrokerUrl}/v1/issues/${operation}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-wingman-issue-broker-token': config.git.issueBrokerToken,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GitAuthorityError('git_issue_broker_unavailable', 'Git issue brokerage is unavailable', 503);
  }
  if (response.ok) return await response.json() as T;
  if (response.status === 404) {
    throw new GitAuthorityError('git_issue_not_found', 'Issue not found', 404);
  }
  if (response.status === 403 || response.status === 409) {
    throw new GitAuthorityError('git_issue_provider_access_not_ready', 'Forgejo issue access is not reconciled', 409);
  }
  if (response.status === 400) {
    throw new GitAuthorityError('git_validation_error', 'Git issue request is invalid', 400);
  }
  throw new GitAuthorityError('git_issue_provider_error', 'Forgejo issue request failed', 502);
}

export async function listForgejoIssues(
  repository: GitIssueBrokerRepository,
  input: { state: 'open' | 'closed' | 'all'; page: number; limit: number },
): Promise<GitIssue[]> {
  const response = await brokerRequest<{ issues: GitIssue[] }>('list', { ...repository, ...input });
  return response.issues;
}

export async function readForgejoIssue(
  repository: GitIssueBrokerRepository,
  issueNumber: number,
): Promise<GitIssue> {
  const response = await brokerRequest<{ issue: GitIssue }>('read', { ...repository, issue_number: issueNumber });
  return response.issue;
}

export async function createForgejoIssue(
  repository: GitIssueBrokerRepository,
  input: { title: string; body: string },
): Promise<GitIssue> {
  const response = await brokerRequest<{ issue: GitIssue }>('create', { ...repository, ...input });
  return response.issue;
}

export async function createForgejoIssueComment(
  repository: GitIssueBrokerRepository,
  issueNumber: number,
  body: string,
): Promise<GitIssueComment> {
  const response = await brokerRequest<{ comment: GitIssueComment }>('comment', {
    ...repository,
    issue_number: issueNumber,
    body,
  });
  return response.comment;
}
