import { describe, expect, test } from 'bun:test';
import {
  assembleEffectiveFlightDeckPgThreadMessages,
  serializeFlightDeckPgEffectiveMessage,
  type FlightDeckPgMessageRow,
  type FlightDeckPgThreadRow,
} from '../src/services/flightdeck-pg-api';

const thread = (id: string, parent: string | null, branchPoint: string | null) => ({
  id,
  parent_thread_id: parent,
  branch_point_message_id: branchPoint,
}) as FlightDeckPgThreadRow;
const message = (id: string, threadId: string) => ({ id, thread_id: threadId }) as FlightDeckPgMessageRow;

describe('Flight Deck PG thread branching', () => {
  test('assembles nested lineage only through each selected fork point', () => {
    const lineage = [thread('root', null, null), thread('child', 'root', 'r2'), thread('nested', 'child', 'c1')];
    const messages = new Map<string, FlightDeckPgMessageRow[]>([
      ['root', [message('r1', 'root'), message('r2', 'root'), message('r3', 'root')]],
      ['child', [message('c1', 'child'), message('c2', 'child')]],
      ['nested', [message('n1', 'nested')]],
    ]);
    expect(assembleEffectiveFlightDeckPgThreadMessages(lineage, messages).map((row) => row.id))
      .toEqual(['r1', 'r2', 'c1', 'n1']);
  });

  test('allows a nested branch point inherited from an ancestor', () => {
    const lineage = [thread('root', null, null), thread('child', 'root', 'r2'), thread('nested', 'child', 'r1')];
    const messages = new Map<string, FlightDeckPgMessageRow[]>([
      ['root', [message('r1', 'root'), message('r2', 'root')]],
      ['child', [message('c1', 'child')]],
      ['nested', []],
    ]);
    expect(assembleEffectiveFlightDeckPgThreadMessages(lineage, messages).map((row) => row.id)).toEqual(['r1']);
  });

  test('rejects a branch point outside the parent effective transcript', () => {
    expect(() => assembleEffectiveFlightDeckPgThreadMessages(
      [thread('root', null, null), thread('child', 'root', 'missing')],
      new Map([['root', [message('r1', 'root')]]]),
    )).toThrow('thread_branch_point_missing');
  });

  test('serializes inherited tombstones without deleted content', () => {
    const deleted = {
      id: 'm1', workspace_id: 'w', scope_id: 's', channel_id: 'c', thread_id: 'root', body: 'secret',
      metadata: { attachments: [{ storage_object_id: 'file' }] }, deleted_at: new Date(), row_version: 2,
      created_by_actor_id: 'a', updated_by_actor_id: 'a', created_at: new Date(), updated_at: new Date(),
      client_request_id: null, client_request_hash: null, cursor_created_at: new Date().toISOString(),
      owning_thread_id: 'root', effective_thread_id: 'child', inherited: true,
    } as Parameters<typeof serializeFlightDeckPgEffectiveMessage>[0];
    expect(serializeFlightDeckPgEffectiveMessage(deleted)).toMatchObject({
      id: 'm1', body: '', metadata: {}, mentions: [], attachments: [], inherited: true, read_only: true,
    });
  });
});
