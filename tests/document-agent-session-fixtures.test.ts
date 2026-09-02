import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const fixtureRoot = join(import.meta.dir, '..', 'fixtures', 'flightdeck-pg', 'document-agent-sessions');
const readFixture = (name: string) => JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'));

describe('document-bound agent session fixtures', () => {
  test('cover all triggers, replies, unchanged/re-add, self-authorship, replay, and movement', () => {
    const document = readFixture('document_mention_added.json');
    const comments = readFixture('document_comment_mention_added.json');
    const review = readFixture('full_document_review_requested.json');

    expect(document.event.event_type).toBe('flightdeck_pg.document_mention_added');
    expect(document.event).toMatchObject({ event_id: expect.any(String), cursor: expect.any(String), payload: { current_body_hash: expect.any(String), prior_body_hash: expect.any(String), added_mentions: [expect.objectContaining({ actor_id: expect.any(String), npub: expect.any(String) })] } });
    expect(document.transition_cases).toMatchObject({ unchanged_save: { emitted: false }, removed: { emitted: false }, readded: { emitted: true }, self_authorship: { dispatchable: true } });
    expect(comments.events[0].payload.parent_comment_id).toBeNull();
    expect(comments.events[1].payload.parent_comment_id).toBe(comments.events[0].payload.comment_id);
    expect(review.request.trigger).toBe('full_document_review_requested');
    expect(review.replay).toMatchObject({ http_status: 200, replayed: true, new_event_emitted: false });
    expect(review.movement.document_id_after).toBe(review.movement.document_id_before);
  });
});
