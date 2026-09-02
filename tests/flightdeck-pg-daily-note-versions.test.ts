import { describe, expect, it } from 'bun:test';
import { dailyNoteVersionContentFingerprint } from '../src/services/flightdeck-pg-api';

describe('Flight Deck PG Daily Scope versions', () => {
  it('ignores checklist completion state when fingerprinting meaningful content', () => {
    const base = {
      title: 'Daily Scope',
      body: 'Narrative dump',
      focus: 'Ship focus',
      items: [
        { id: 'focus-1', text: 'Write invoice task', completed: false, source: 'manual' },
      ],
      status: 'active',
      metadata: { source: 'manual' },
    };

    expect(dailyNoteVersionContentFingerprint(base)).toBe(dailyNoteVersionContentFingerprint({
      ...base,
      items: [
        { id: 'focus-1', text: 'Write invoice task', completed: true, source: 'manual' },
      ],
    }));
    expect(dailyNoteVersionContentFingerprint(base)).not.toBe(dailyNoteVersionContentFingerprint({
      ...base,
      items: [
        { id: 'focus-1', text: 'Write updated invoice task', completed: false, source: 'manual' },
      ],
    }));
  });
});
