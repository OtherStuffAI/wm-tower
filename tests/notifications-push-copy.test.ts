import { describe, expect, test } from 'bun:test';
import { buildApnsPayload, genericAlertTitle, type AlertContent } from '../src/services/notification-apns';

// Pure payload-copy tests (no database): purpose-specific generic alert text per canonical category.
const UUID = '6f0c1c0e-7a43-4c37-9a52-0a1d3b6f0c11';
const content = (over: Partial<AlertContent> = {}): AlertContent => ({
  clientAppId: 'ambulando', workspaceId: UUID, itemId: UUID, changeSeq: 7, sourceAppId: 'flightdeck.core', category: 'mention', threadId: 't-0f3a', coreSource: true,
  ids: { channel_id: UUID, thread_id: UUID }, badge: 2, origin: 'https://tower.example', towerServiceNpub: 'npub1tower', preview: null, ...over,
});

describe('push alert copy', () => {
  test('each canonical core category has its own purpose text and an empty body', () => {
    const expected: Record<string, string> = {
      mention: 'You were mentioned', dm: 'New direct message', comment_tag: 'You were mentioned in a comment',
      task_assignment: 'A task was assigned to you', chat_thread: 'New thread activity',
    };
    for (const [category, title] of Object.entries(expected)) {
      const { aps, fd } = buildApnsPayload(content({ category }));
      expect(aps.alert).toEqual({ title, body: '' });
      expect(fd.category).toBe(category);
    }
    expect(new Set(Object.values(expected)).size).toBe(5);
  });

  test('unknown, producer and prototype-named categories fall back to the generic title', () => {
    for (const category of ['future_kind', '', 'constructor', 'toString', '__proto__']) {
      expect(buildApnsPayload(content({ category })).aps.alert).toEqual({ title: 'New activity', body: '' });
    }
    // a producer source can never borrow a canonical purpose, even with a reserved-looking category
    expect(genericAlertTitle('mention', false)).toBe('New activity');
    expect(buildApnsPayload(content({ coreSource: false, sourceAppId: 'blinkers', category: 'mention', ids: {} })).aps.alert.title).toBe('New activity');
  });

  test('default copy carries no private detail and keeps routing identifiers', () => {
    const payload = JSON.stringify(buildApnsPayload(content({ category: 'task_assignment', ids: { task_id: UUID } })));
    for (const secret of ['Alice', 'roadmap', 'secret']) expect(payload).not.toContain(secret);
    const { fd } = buildApnsPayload(content({ category: 'task_assignment', ids: { task_id: UUID } }));
    expect(fd).toMatchObject({ v: 1, origin: 'https://tower.example', tower_service_npub: 'npub1tower', workspace_id: UUID, task_id: UUID, notification_id: UUID, change_seq: 7, source_app_id: 'flightdeck.core' });
  });

  test('an explicit full preview replaces the purpose text, but an empty preview does not blank it', () => {
    expect(buildApnsPayload(content({ preview: { title: 'Alice mentioned you', body: 'Roadmap' } })).aps.alert).toEqual({ title: 'Alice mentioned you', body: 'Roadmap' });
    expect(buildApnsPayload(content({ category: 'dm', preview: { title: '', body: '' } })).aps.alert).toEqual({ title: 'New direct message', body: '' });
  });
});

describe('Ambulando push cache refresh', () => {
  test('visible alert requests a fetch while preserving copy, grouping, badge and fd routing', () => {
    const payload = buildApnsPayload(content());
    expect(payload.aps).toEqual({ alert: { title: 'You were mentioned', body: '' }, sound: 'default',
      'thread-id': 't-0f3a', badge: 2, 'content-available': 1 });
    expect(payload.fd).toMatchObject({ v: 1, workspace_id: UUID, channel_id: UUID, thread_id: UUID,
      notification_id: UUID, change_seq: 7 });
  });
  test('recipient app selects refresh, independently of producer and preview', () => {
    expect(buildApnsPayload(content({ sourceAppId: 'external', coreSource: false, ids: {}, badge: null })).aps)
      .toMatchObject({ 'content-available': 1, alert: { title: 'New activity', body: '' } });
    for (const clientAppId of ['other-app', undefined]) {
      expect(buildApnsPayload(content({ clientAppId })).aps['content-available']).toBeUndefined();
    }
  });
});
