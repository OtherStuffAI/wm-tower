import { describe, expect, test } from 'bun:test';
import { getPublicKey, nip19 } from 'nostr-tools';
import { parseActorMentionInputs, parseAgentMentionInputs } from '../src/services/flightdeck-pg-agent-direct';

const personNpub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(61)));
const agentNpub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(62)));

describe('comment actor mention inputs', () => {
  test('retains explicit person and agent identities and deduplicates by npub', () => {
    expect(parseActorMentionInputs([
      { type: 'person', npub: personNpub, label: ' Person ' },
      { type: 'agent', npub: agentNpub, label: 'Agent' },
      { type: 'person', npub: personNpub, label: 'Duplicate' },
    ], 'mentions')).toEqual({ mentions: [
      { type: 'person', npub: personNpub, label: 'Person' },
      { type: 'agent', npub: agentNpub, label: 'Agent' },
    ], errors: [] });
  });

  test('keeps legacy chat and record-body agent wire compatibility', () => {
    expect(parseAgentMentionInputs([{ type: 'person', npub: personNpub }], 'mentions'))
      .toEqual({ mentions: [{ type: 'agent', npub: personNpub }], errors: [] });
  });

  test('never treats visible body text or record links as routing identities', () => {
    expect(parseActorMentionInputs(undefined, 'mentions')).toEqual({ mentions: [], errors: [] });
    expect(parseActorMentionInputs(`@[Agent](mention:agent:${agentNpub})`, 'mentions').errors)
      .toEqual([expect.objectContaining({ path: 'mentions', code: 'invalid' })]);
    expect(parseActorMentionInputs([{ type: 'task', npub: agentNpub }], 'metadata.mentions').errors)
      .toContainEqual(expect.objectContaining({ path: 'metadata.mentions.0.type', code: 'invalid' }));
  });

  test('rejects malformed identities and labels before authorization', () => {
    const result = parseActorMentionInputs([{ type: 'agent', npub: 'Rick', label: '' }, null], 'mentions');
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'mentions.0.npub', code: 'invalid' }),
      expect.objectContaining({ path: 'mentions.0.label', code: 'invalid' }),
      expect.objectContaining({ path: 'mentions.1', code: 'invalid' }),
    ]));
  });
});
