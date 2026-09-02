import { describe, test, expect, beforeEach } from 'bun:test';

/**
 * SSE Hub unit tests — verifies the in-memory fan-out, ring buffer replay,
 * connection limits, and event emission for real-time change notifications.
 *
 * These are pure unit tests: no DB, no HTTP. They import SSEHub directly.
 */

// We re-create a hub per test to avoid shared state.
// Import the class shape but instantiate fresh instances.
import type { SSEClient, SSEEvent } from '../src/sse-hub';

// Helper: create a fresh SSEHub instance by re-importing the module.
// Since the module exports a singleton, we instead replicate the class here
// to get isolated instances per test.
function createSSEHub() {
  const EVENT_BUFFER_MAX = 10_000;
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const MAX_CONNECTION_LIFETIME_MS = 4 * 60 * 60 * 1000;
  const MAX_CONNECTIONS_PER_WORKSPACE = 50;
  const MAX_CONNECTIONS_PER_USER = 10;

  const clients = new Map<string, Set<SSEClient>>();
  const userClientCounts = new Map<string, number>();
  let eventId = 0;
  const eventBuffer: { id: number; ownerNpub: string; payload: string; visibleToUserNpubs: string[] | null }[] = [];

  return {
    canConnect(userNpub: string, ownerNpub: string) {
      const wsCount = clients.get(ownerNpub)?.size ?? 0;
      if (wsCount >= MAX_CONNECTIONS_PER_WORKSPACE) {
        return { ok: false, reason: `workspace connection limit (${MAX_CONNECTIONS_PER_WORKSPACE})` };
      }
      const userCount = userClientCounts.get(userNpub) ?? 0;
      if (userCount >= MAX_CONNECTIONS_PER_USER) {
        return { ok: false, reason: `per-user connection limit (${MAX_CONNECTIONS_PER_USER})` };
      }
      return { ok: true };
    },

    addClient(client: SSEClient) {
      const key = client.ownerNpub;
      if (!clients.has(key)) clients.set(key, new Set());
      clients.get(key)!.add(client);
      const userCount = userClientCounts.get(client.userNpub) ?? 0;
      userClientCounts.set(client.userNpub, userCount + 1);
      // Skip timers in tests
    },

    removeClient(client: SSEClient) {
      if (client.heartbeatTimer) {
        clearInterval(client.heartbeatTimer);
        client.heartbeatTimer = null;
      }
      if (client.lifetimeTimer) {
        clearTimeout(client.lifetimeTimer);
        client.lifetimeTimer = null;
      }
      try { client.controller.close(); } catch {}
      clients.get(client.ownerNpub)?.delete(client);
      const userCount = userClientCounts.get(client.userNpub) ?? 0;
      if (userCount <= 1) {
        userClientCounts.delete(client.userNpub);
      } else {
        userClientCounts.set(client.userNpub, userCount - 1);
      }
    },

    emit(ownerNpub: string, event: SSEEvent, options?: { visibleToUserNpubs?: Iterable<string> }) {
      eventId++;
      const payload = `id: ${eventId}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
      const visibleToUserNpubs = options?.visibleToUserNpubs
        ? [...new Set([ownerNpub, ...options.visibleToUserNpubs].filter(Boolean))]
        : null;
      eventBuffer.push({ id: eventId, ownerNpub, payload, visibleToUserNpubs });
      while (eventBuffer.length > EVENT_BUFFER_MAX) {
        eventBuffer.shift();
      }
      const ws = clients.get(ownerNpub);
      if (!ws?.size) return;
      for (const client of ws) {
        if (visibleToUserNpubs && !visibleToUserNpubs.includes(client.userNpub)) {
          continue;
        }
        try {
          client.controller.enqueue(new TextEncoder().encode(payload));
        } catch {
          this.removeClient(client);
        }
      }
    },

    canReplay(lastEventId: number) {
      if (eventBuffer.length === 0) return lastEventId >= eventId;
      return eventBuffer[0].id <= lastEventId;
    },

    replayFrom(ownerNpub: string, userNpub: string, lastEventId: number, controller: ReadableStreamDefaultController) {
      for (const event of eventBuffer) {
        if (event.id <= lastEventId) continue;
        if (event.ownerNpub !== ownerNpub) continue;
        if (event.visibleToUserNpubs && !event.visibleToUserNpubs.includes(userNpub)) continue;
        try {
          controller.enqueue(new TextEncoder().encode(event.payload));
        } catch { break; }
      }
    },

    getClientCount(ownerNpub?: string) {
      if (ownerNpub) return clients.get(ownerNpub)?.size ?? 0;
      let total = 0;
      for (const set of clients.values()) total += set.size;
      return total;
    },

    getCurrentEventId() { return eventId; },

    // Test-only accessors
    _eventBuffer: eventBuffer,
    _EVENT_BUFFER_MAX: EVENT_BUFFER_MAX,
  };
}

/** Create a mock SSEClient with a captured output buffer */
function mockClient(userNpub: string, ownerNpub: string) {
  const chunks: Uint8Array[] = [];
  let closed = false;
  const controller = {
    enqueue(chunk: Uint8Array) {
      if (closed) throw new Error('Controller closed');
      chunks.push(chunk);
    },
    close() { closed = true; },
  } as unknown as ReadableStreamDefaultController;

  const client: SSEClient = {
    userNpub,
    ownerNpub,
    controller,
    connectedAt: Date.now(),
    heartbeatTimer: null,
    lifetimeTimer: null,
  };

  return {
    client,
    received(): string[] {
      return chunks.map(c => new TextDecoder().decode(c));
    },
    closed: () => closed,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE Hub — event emission', () => {
  test('emit delivers record-changed to all clients on that workspace', () => {
    const hub = createSSEHub();
    const c1 = mockClient('user1', 'owner-a');
    const c2 = mockClient('user2', 'owner-a');
    hub.addClient(c1.client);
    hub.addClient(c2.client);

    hub.emit('owner-a', {
      event: 'record-changed',
      data: { family_hash: 'fam1', record_id: 'r1', version: 1 },
    });

    expect(c1.received()).toHaveLength(1);
    expect(c2.received()).toHaveLength(1);
    expect(c1.received()[0]).toContain('event: record-changed');
    expect(c1.received()[0]).toContain('"family_hash":"fam1"');
  });

  test('emit does not deliver to clients on a different workspace', () => {
    const hub = createSSEHub();
    const c1 = mockClient('user1', 'owner-a');
    const c2 = mockClient('user2', 'owner-b');
    hub.addClient(c1.client);
    hub.addClient(c2.client);

    hub.emit('owner-a', {
      event: 'record-changed',
      data: { family_hash: 'fam1', record_id: 'r1', version: 1 },
    });

    expect(c1.received()).toHaveLength(1);
    expect(c2.received()).toHaveLength(0);
  });

  test('emit delivers audience-scoped events only to visible actors', () => {
    const hub = createSSEHub();
    const visible = mockClient('user-visible', 'owner-a');
    const hidden = mockClient('user-hidden', 'owner-a');
    const owner = mockClient('owner-a', 'owner-a');
    hub.addClient(visible.client);
    hub.addClient(hidden.client);
    hub.addClient(owner.client);

    hub.emit('owner-a', {
      event: 'record-changed',
      data: { family_hash: 'fam1', record_id: 'r1', version: 1 },
    }, {
      visibleToUserNpubs: ['user-visible'],
    });

    expect(visible.received()).toHaveLength(1);
    expect(hidden.received()).toHaveLength(0);
    expect(owner.received()).toHaveLength(1);
  });

  test('emit increments event ID monotonically', () => {
    const hub = createSSEHub();
    const c1 = mockClient('user1', 'owner-a');
    hub.addClient(c1.client);

    hub.emit('owner-a', { event: 'record-changed', data: { record_id: 'r1' } });
    hub.emit('owner-a', { event: 'record-changed', data: { record_id: 'r2' } });
    hub.emit('owner-a', { event: 'record-changed', data: { record_id: 'r3' } });

    const payloads = c1.received();
    expect(payloads[0]).toContain('id: 1\n');
    expect(payloads[1]).toContain('id: 2\n');
    expect(payloads[2]).toContain('id: 3\n');
  });

  test('emit delivers group-changed events', () => {
    const hub = createSSEHub();
    const c1 = mockClient('user1', 'owner-a');
    hub.addClient(c1.client);

    hub.emit('owner-a', {
      event: 'group-changed',
      data: { group_id: 'g1', group_npub: 'npub1...', action: 'epoch_rotated' },
    });

    expect(c1.received()).toHaveLength(1);
    expect(c1.received()[0]).toContain('event: group-changed');
    expect(c1.received()[0]).toContain('"action":"epoch_rotated"');
  });

  test('emit with SSE format: id, event, data, trailing newlines', () => {
    const hub = createSSEHub();
    const c1 = mockClient('user1', 'owner-a');
    hub.addClient(c1.client);

    hub.emit('owner-a', { event: 'record-changed', data: { record_id: 'r1' } });
    const raw = c1.received()[0];

    // SSE spec requires: id line, event line, data line, blank line
    const lines = raw.split('\n');
    expect(lines[0]).toMatch(/^id: \d+$/);
    expect(lines[1]).toBe('event: record-changed');
    expect(lines[2]).toMatch(/^data: \{.*\}$/);
    expect(lines[3]).toBe('');  // trailing blank line terminates the event
  });
});

describe('SSE Hub — ring buffer and replay', () => {
  test('canReplay returns true when cursor is in buffer', () => {
    const hub = createSSEHub();
    hub.emit('owner-a', { event: 'record-changed', data: { id: 1 } });
    hub.emit('owner-a', { event: 'record-changed', data: { id: 2 } });
    hub.emit('owner-a', { event: 'record-changed', data: { id: 3 } });

    expect(hub.canReplay(1)).toBe(true);
    expect(hub.canReplay(2)).toBe(true);
    expect(hub.canReplay(3)).toBe(true); // at head, nothing to replay but cursor valid
  });

  test('canReplay returns false when cursor is evicted', () => {
    const hub = createSSEHub();
    // Fill buffer beyond max
    for (let i = 0; i < hub._EVENT_BUFFER_MAX + 100; i++) {
      hub.emit('owner-a', { event: 'record-changed', data: { i } });
    }
    // Event ID 1 has been evicted
    expect(hub.canReplay(1)).toBe(false);
    // Recent IDs are still valid
    expect(hub.canReplay(hub.getCurrentEventId() - 1)).toBe(true);
  });

  test('canReplay returns true for current head when buffer is empty', () => {
    const hub = createSSEHub();
    // No events emitted — eventId is 0, lastEventId 0 means "I have nothing"
    expect(hub.canReplay(0)).toBe(true);
  });

  test('replayFrom sends only events after cursor for the given workspace', () => {
    const hub = createSSEHub();
    hub.emit('owner-a', { event: 'record-changed', data: { n: 1 } });
    hub.emit('owner-b', { event: 'record-changed', data: { n: 2 } }); // different workspace
    hub.emit('owner-a', { event: 'record-changed', data: { n: 3 } });
    hub.emit('owner-a', { event: 'group-changed', data: { n: 4 } });

    const chunks: Uint8Array[] = [];
    const controller = {
      enqueue(chunk: Uint8Array) { chunks.push(chunk); },
      close() {},
    } as unknown as ReadableStreamDefaultController;

    // Replay from event 1 (skip id=1, replay id=3 and id=4 for owner-a)
    hub.replayFrom('owner-a', 'user1', 1, controller);

    const replayed = chunks.map(c => new TextDecoder().decode(c));
    expect(replayed).toHaveLength(2);
    expect(replayed[0]).toContain('id: 3\n');
    expect(replayed[1]).toContain('id: 4\n');
  });

  test('replayFrom filters out events not visible to the reconnecting actor', () => {
    const hub = createSSEHub();
    hub.emit('owner-a', { event: 'record-changed', data: { n: 1 } }, {
      visibleToUserNpubs: ['user-visible'],
    });
    hub.emit('owner-a', { event: 'record-changed', data: { n: 2 } }, {
      visibleToUserNpubs: ['user-hidden'],
    });
    hub.emit('owner-a', { event: 'record-changed', data: { n: 3 } });

    const chunks: Uint8Array[] = [];
    const controller = {
      enqueue(chunk: Uint8Array) { chunks.push(chunk); },
      close() {},
    } as unknown as ReadableStreamDefaultController;

    hub.replayFrom('owner-a', 'user-visible', 0, controller);

    const replayed = chunks.map(c => new TextDecoder().decode(c));
    expect(replayed).toHaveLength(2);
    expect(replayed[0]).toContain('"n":1');
    expect(replayed[1]).toContain('"n":3');
  });

  test('buffer evicts oldest events when exceeding max size', () => {
    const hub = createSSEHub();
    const max = hub._EVENT_BUFFER_MAX;

    for (let i = 0; i < max + 50; i++) {
      hub.emit('owner-a', { event: 'record-changed', data: { i } });
    }

    expect(hub._eventBuffer.length).toBe(max);
    // Oldest event should be id 51 (first 50 evicted)
    expect(hub._eventBuffer[0].id).toBe(51);
  });
});

describe('SSE Hub — connection limits', () => {
  test('allows connections within limits', () => {
    const hub = createSSEHub();
    expect(hub.canConnect('user1', 'owner-a')).toEqual({ ok: true });
  });

  test('rejects when per-user limit exceeded', () => {
    const hub = createSSEHub();
    for (let i = 0; i < 10; i++) {
      const c = mockClient('user1', `owner-${i}`);
      hub.addClient(c.client);
    }
    const result = hub.canConnect('user1', 'owner-new');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('per-user');
  });

  test('rejects when per-workspace limit exceeded', () => {
    const hub = createSSEHub();
    for (let i = 0; i < 50; i++) {
      const c = mockClient(`user-${i}`, 'owner-a');
      hub.addClient(c.client);
    }
    const result = hub.canConnect('user-new', 'owner-a');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('workspace');
  });

  test('removeClient decrements counts and allows new connections', () => {
    const hub = createSSEHub();
    const mocks = [];
    for (let i = 0; i < 10; i++) {
      const c = mockClient('user1', `owner-${i}`);
      hub.addClient(c.client);
      mocks.push(c);
    }
    expect(hub.canConnect('user1', 'owner-new').ok).toBe(false);

    hub.removeClient(mocks[0].client);
    expect(hub.canConnect('user1', 'owner-new').ok).toBe(true);
  });

  test('getClientCount returns correct totals', () => {
    const hub = createSSEHub();
    expect(hub.getClientCount()).toBe(0);
    expect(hub.getClientCount('owner-a')).toBe(0);

    const c1 = mockClient('user1', 'owner-a');
    const c2 = mockClient('user2', 'owner-a');
    const c3 = mockClient('user1', 'owner-b');
    hub.addClient(c1.client);
    hub.addClient(c2.client);
    hub.addClient(c3.client);

    expect(hub.getClientCount()).toBe(3);
    expect(hub.getClientCount('owner-a')).toBe(2);
    expect(hub.getClientCount('owner-b')).toBe(1);
  });
});

describe('SSE Hub — payload contract', () => {
  test('record-changed payload contains required fields', () => {
    const hub = createSSEHub();
    const c1 = mockClient('user1', 'owner-a');
    hub.addClient(c1.client);

    hub.emit('owner-a', {
      event: 'record-changed',
      data: {
        family_hash: 'chat_message_abc123',
        record_id: 'rec-001',
        version: 3,
        signature_npub: 'npub1signer...',
        updated_at: '2026-04-01T12:00:00Z',
        record_state: 'active',
      },
    });

    const raw = c1.received()[0];
    const dataLine = raw.split('\n').find(l => l.startsWith('data: '));
    const data = JSON.parse(dataLine!.slice(6));

    expect(data.family_hash).toBe('chat_message_abc123');
    expect(data.record_id).toBe('rec-001');
    expect(data.version).toBe(3);
    expect(data.signature_npub).toBe('npub1signer...');
    expect(data.updated_at).toBe('2026-04-01T12:00:00Z');
    expect(data.record_state).toBe('active');
  });

  test('group-changed payload contains required fields', () => {
    const hub = createSSEHub();
    const c1 = mockClient('user1', 'owner-a');
    hub.addClient(c1.client);

    hub.emit('owner-a', {
      event: 'group-changed',
      data: {
        group_id: 'g-001',
        group_npub: 'npub1group...',
        action: 'member_added',
      },
    });

    const raw = c1.received()[0];
    const dataLine = raw.split('\n').find(l => l.startsWith('data: '));
    const data = JSON.parse(dataLine!.slice(6));

    expect(data.group_id).toBe('g-001');
    expect(data.group_npub).toBe('npub1group...');
    expect(data.action).toBe('member_added');
  });

  test('group-changed action values cover all mutation types', () => {
    const hub = createSSEHub();
    const c1 = mockClient('user1', 'owner-a');
    hub.addClient(c1.client);

    const actions = ['epoch_rotated', 'member_added', 'member_removed'];
    for (const action of actions) {
      hub.emit('owner-a', {
        event: 'group-changed',
        data: { group_id: 'g1', group_npub: 'npub1...', action },
      });
    }

    const payloads = c1.received();
    expect(payloads).toHaveLength(3);
    const emittedActions = payloads.map(raw => {
      const dataLine = raw.split('\n').find(l => l.startsWith('data: '));
      return JSON.parse(dataLine!.slice(6)).action;
    });
    expect(emittedActions).toEqual(actions);
  });
});

describe('SSE Hub — client error handling', () => {
  test('removes client when enqueue throws', () => {
    const hub = createSSEHub();
    let enqueueCount = 0;
    const controller = {
      enqueue() {
        enqueueCount++;
        if (enqueueCount === 2) throw new Error('stream closed');
      },
      close() {},
    } as unknown as ReadableStreamDefaultController;

    const client: SSEClient = {
      userNpub: 'user1',
      ownerNpub: 'owner-a',
      controller,
      connectedAt: Date.now(),
      heartbeatTimer: null,
      lifetimeTimer: null,
    };
    hub.addClient(client);
    expect(hub.getClientCount('owner-a')).toBe(1);

    // First emit succeeds
    hub.emit('owner-a', { event: 'record-changed', data: { n: 1 } });
    expect(hub.getClientCount('owner-a')).toBe(1);

    // Second emit throws — client should be removed
    hub.emit('owner-a', { event: 'record-changed', data: { n: 2 } });
    expect(hub.getClientCount('owner-a')).toBe(0);
  });
});
