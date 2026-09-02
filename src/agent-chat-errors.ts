import type { Context } from 'hono';
import type { AgentChatErrorCode, AgentChatErrorResponse } from './types';

type AgentChatErrorExtras = Omit<AgentChatErrorResponse, 'error' | 'code' | 'status'>;

export function buildAgentChatError(
  status: number,
  code: AgentChatErrorCode,
  error: string,
  extras: AgentChatErrorExtras = {},
): AgentChatErrorResponse {
  return {
    error,
    code,
    status,
    ...extras,
  };
}

export function jsonAgentChatError(
  c: Context,
  status: number,
  code: AgentChatErrorCode,
  error: string,
  extras: AgentChatErrorExtras = {},
) {
  return c.json(buildAgentChatError(status, code, error, extras), status);
}
