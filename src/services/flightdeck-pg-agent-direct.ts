import type { FlightDeckPgAgentChatConfig, FlightDeckPgAgentMention } from '../types';

export const AGENT_CHAT_CONTEXT_PROMPT_MAX_LENGTH = 8_000;
export const AGENT_MENTION_LABEL_MAX_LENGTH = 120;
export const MESSAGE_CLIENT_REQUEST_ID_MAX_LENGTH = 240;

export type AgentDirectFieldError = { path: string; code: string; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeFlightDeckPgChannelMetadata(metadata: Record<string, unknown> | null | undefined) {
  const source = isObject(metadata) ? metadata : {};
  const rawAgentChat = isObject(source.agent_chat) ? source.agent_chat : {};
  const legacyPrompt = typeof source.basePrompt === 'string'
    ? source.basePrompt
    : typeof source.contextPrompt === 'string'
      ? source.contextPrompt
      : '';
  const config: FlightDeckPgAgentChatConfig = {
    // Agent Direct Chat is a universal channel policy. Canonicalize legacy
    // absent and false values so every reader observes the same default-on
    // contract without requiring a database rewrite.
    enabled: true,
    context_prompt: typeof rawAgentChat.context_prompt === 'string'
      ? rawAgentChat.context_prompt
      : legacyPrompt,
    activation: 'mention_then_continue',
  };
  return { ...source, agent_chat: config };
}

export function validateFlightDeckPgChannelMetadata(
  metadata: Record<string, unknown>,
  path = 'metadata',
  migrateLegacy = false,
): { metadata: Record<string, unknown>; errors: AgentDirectFieldError[] } {
  const errors: AgentDirectFieldError[] = [];
  if (Object.prototype.hasOwnProperty.call(metadata, 'agent_chat')) {
    if (!isObject(metadata.agent_chat)) {
      errors.push({ path: `${path}.agent_chat`, code: 'invalid', message: `${path}.agent_chat must be an object` });
      return { metadata, errors };
    }
    const config = metadata.agent_chat;
    if (typeof config.enabled !== 'boolean') {
      errors.push({ path: `${path}.agent_chat.enabled`, code: 'invalid', message: `${path}.agent_chat.enabled must be boolean` });
    }
    if (typeof config.context_prompt !== 'string') {
      errors.push({ path: `${path}.agent_chat.context_prompt`, code: 'invalid', message: `${path}.agent_chat.context_prompt must be a string` });
    } else if (config.context_prompt.length > AGENT_CHAT_CONTEXT_PROMPT_MAX_LENGTH) {
      errors.push({ path: `${path}.agent_chat.context_prompt`, code: 'too_long', message: `${path}.agent_chat.context_prompt must be at most ${AGENT_CHAT_CONTEXT_PROMPT_MAX_LENGTH} characters` });
    }
    if (config.activation !== 'mention_then_continue') {
      errors.push({ path: `${path}.agent_chat.activation`, code: 'invalid', message: `${path}.agent_chat.activation must be mention_then_continue` });
    }
  }
  const normalized = normalizeFlightDeckPgChannelMetadata(metadata);
  if (migrateLegacy) {
    delete normalized.basePrompt;
    delete normalized.contextPrompt;
  }
  return { metadata: normalized, errors };
}

export function parseAgentMentionInputs(value: unknown, path: string): {
  mentions: Array<{ type: 'agent'; npub: string; label?: string }>;
  errors: AgentDirectFieldError[];
} {
  if (value === undefined) return { mentions: [], errors: [] };
  if (!Array.isArray(value)) {
    return { mentions: [], errors: [{ path, code: 'invalid', message: `${path} must be an array` }] };
  }
  const mentions: Array<{ type: 'agent'; npub: string; label?: string }> = [];
  const errors: AgentDirectFieldError[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${path}.${index}`;
    if (!isObject(item)) {
      errors.push({ path: itemPath, code: 'invalid', message: `${itemPath} must be an object` });
      return;
    }
    if (item.type !== 'agent' && item.type !== 'person') {
      errors.push({ path: `${itemPath}.type`, code: 'invalid', message: `${itemPath}.type must be agent or person` });
    }
    const npub = typeof item.npub === 'string' ? item.npub.trim() : '';
    if (!/^npub1[023456789acdefghjklmnpqrstuvwxyz]{50,}$/i.test(npub)) {
      errors.push({ path: `${itemPath}.npub`, code: 'invalid', message: `${itemPath}.npub must be a full valid npub` });
    }
    let label: string | undefined;
    if (item.label !== undefined) {
      if (typeof item.label !== 'string' || !item.label.trim()) {
        errors.push({ path: `${itemPath}.label`, code: 'invalid', message: `${itemPath}.label must be a non-empty string when provided` });
      } else if (item.label.trim().length > AGENT_MENTION_LABEL_MAX_LENGTH) {
        errors.push({ path: `${itemPath}.label`, code: 'too_long', message: `${itemPath}.label must be at most ${AGENT_MENTION_LABEL_MAX_LENGTH} characters` });
      } else label = item.label.trim();
    }
    if ((item.type === 'agent' || item.type === 'person') && npub && !seen.has(npub)) {
      seen.add(npub);
      // Keep the canonical stored shape as `agent` for wire compatibility.
      // Identity and dispatch decisions are made from actor_id/npub, not this label.
      mentions.push({ type: 'agent', npub, ...(label ? { label } : {}) });
    }
  });
  return { mentions, errors };
}

export function mentionsFromMetadata(metadata: Record<string, unknown> | null | undefined): FlightDeckPgAgentMention[] {
  if (!isObject(metadata) || !Array.isArray(metadata.mentions)) return [];
  return metadata.mentions.filter((mention): mention is FlightDeckPgAgentMention =>
    isObject(mention)
    && mention.type === 'agent'
    && typeof mention.actor_id === 'string'
    && typeof mention.npub === 'string');
}
