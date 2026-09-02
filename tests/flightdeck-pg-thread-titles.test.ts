import { describe, expect, test } from 'bun:test';
import {
  deriveFlightDeckPgThreadTitle,
  effectiveFlightDeckPgThreadTitle,
  normalizeFlightDeckPgThreadTitle,
  validateFlightDeckPgThreadTitle,
} from '../src/services/flightdeck-pg-thread-titles';

describe('Flight Deck PG thread titles', () => {
  test('excludes a leading mention before taking exactly ten normal words', () => {
    expect(deriveFlightDeckPgThreadTitle(
      '@[Agent](mention:agent:npub1pu8mngjy45c6x60wq2m6h7amp0arsy4e5w0djv6x6q7k04qj69mszac3f7) please implement editable thread titles across Tower and Flight Deck today',
    )).toBe('please implement editable thread titles across Tower and Flight Deck');
  });

  test('excludes record pills between normal words, including labels with escaped brackets', () => {
    expect(deriveFlightDeckPgThreadTitle(
      'Please review @[Fix \\[mobile\\] menu](mention:task:task-1) before the release today',
    )).toBe('Please review before the release today');
  });

  test('excludes consecutive prefixed and non-prefixed pills', () => {
    expect(deriveFlightDeckPgThreadTitle(
      'Open @[Spec](mention:document:doc-1) [Features](mention:channel:channel-1) @[Approval](mention:approval:approval-1) now',
    )).toBe('Open now');
  });

  test('uses the stable fallback when the message contains only mentions and record pills', () => {
    expect(deriveFlightDeckPgThreadTitle(
      '@[Operator](mention:person:npub1vtq2q3k6en5xmhgrg0rd8378ns3q3wsdnjw0yjndq3kjr5sljrmsma6t3d) @[Agent](mention:agent:npub1pu8mngjy45c6x60wq2m6h7amp0arsy4e5w0djv6x6q7k04qj69mszac3f7) [File](mention:file:file-1)',
    )).toBe('Untitled thread');
  });

  test('excludes every supported mention and record-pill kind', () => {
    const kinds = ['person', 'agent', 'task', 'document', 'doc', 'channel', 'message', 'approval', 'flow', 'file', 'scope', 'workroom'];
    const pills = kinds.map((kind, index) => `${index % 2 ? '' : '@'}[${kind}](mention:${kind}:record-${index})`).join(' ');
    expect(deriveFlightDeckPgThreadTitle(`${pills} Keep these normal words`)).toBe('Keep these normal words');
  });

  test('normalizes whitespace and falls back when no visible words remain', () => {
    expect(deriveFlightDeckPgThreadTitle('  one\n two\t three  ')).toBe('one two three');
    expect(deriveFlightDeckPgThreadTitle(' \n\t ')).toBe('Untitled thread');
  });

  test('validates normalized user and bot updates against the shared limit', () => {
    expect(validateFlightDeckPgThreadTitle('  Renamed\n thread ')).toEqual({ title: 'Renamed thread', error: null });
    expect(validateFlightDeckPgThreadTitle('Talk to @[Agent](mention:agent:npub1pu8mngjy45c6x60wq2m6h7amp0arsy4e5w0djv6x6q7k04qj69mszac3f7) about **release**')).toEqual({
      title: 'Talk to Agent about release',
      error: null,
    });
    expect(validateFlightDeckPgThreadTitle('x'.repeat(121)).error).toContain('120');
  });

  test('normalizes composer and Markdown syntax to readable plain text', () => {
    expect(normalizeFlightDeckPgThreadTitle(
      '## Review [the spec](https://example.invalid/spec) with [Features](mention:channel:channel-1) <em>today</em>',
    )).toBe('Review the spec with Features today');
  });

  test('preserves valid stored titles and safely replaces malformed legacy mention fragments', () => {
    expect(effectiveFlightDeckPgThreadTitle('User edited title', 'Ignored source')).toBe('User edited title');
    expect(effectiveFlightDeckPgThreadTitle('Ask @[Agent](mention:agent:npub1pu8mngjy45c6x60wq2m6h7amp0arsy4e5w0djv6x6q7k04qj69mszac3f7) now', 'Ignored source')).toBe('Ask Agent now');
    expect(effectiveFlightDeckPgThreadTitle('@[Agent](mention:agent:npub1broken', '@[Agent](mention:agent:npub1pu8mngjy45c6x60wq2m6h7amp0arsy4e5w0djv6x6q7k04qj69mszac3f7) Fix the title')).toBe('Fix the title');
  });
});
