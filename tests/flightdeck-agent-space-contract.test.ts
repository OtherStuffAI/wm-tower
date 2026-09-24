import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalizeAutopilotAgentId, normalizeAutopilotInstallationId } from '../src/services/flightdeck-pg-autopilot-connections';
import { serializeFlightDeckPgTask, serializeFlightDeckPgTaskComment, serializeFlightDeckPgTypedApproval } from '../src/services/flightdeck-pg-api';
import { recordFamilies } from '../src/services/flightdeck-record-families';

describe('Flight Deck agent authority contract', () => {
  test('task and comment actor evidence comes from joined actor columns, never spoofable metadata', () => {
    const now = new Date();
    const task = serializeFlightDeckPgTask({
      id: crypto.randomUUID(), workspace_id: crypto.randomUUID(), scope_id: crypto.randomUUID(), channel_id: crypto.randomUUID(), thread_id: null,
      title: 'Dispatch', description: null, state: 'new', priority: 'high', metadata: { author: 'npub1spoof', sender_npub: 'npub1spoof' },
      row_version: 1, activity_version: 0, created_by_actor_id: crypto.randomUUID(), updated_by_actor_id: crypto.randomUUID(), deleted_at: null,
      created_at: now, updated_at: now, created_by_actor_npub: 'npub1authoritative', assignments: [],
    } as any);
    expect(task.created_by_actor_npub).toBe('npub1authoritative');
    expect(task.sender_npub).toBe('npub1authoritative');

    const comment = serializeFlightDeckPgTaskComment({
      id: crypto.randomUUID(), workspace_id: crypto.randomUUID(), scope_id: crypto.randomUUID(), channel_id: crypto.randomUUID(), task_id: crypto.randomUUID(), thread_id: null,
      body: 'Run it', metadata: { author: 'npub1spoof' }, row_version: 1, created_by_actor_id: crypto.randomUUID(), updated_by_actor_id: crypto.randomUUID(), deleted_at: null,
      created_at: now, updated_at: now, created_by_actor_npub: 'npub1authoritative',
    } as any);
    expect(comment.sender_npub).toBe('npub1authoritative');
  });

  test('approval actor fields remain typed top-level authority evidence', () => {
    const approval = serializeFlightDeckPgTypedApproval({ requested_by_npub: 'npub1requester', approver_npub: 'npub1approver', metadata: { requested_by_npub: 'npub1spoof' } } as any);
    expect(approval.requested_by_npub).toBe('npub1requester');
    expect(approval.approver_npub).toBe('npub1approver');
  });
});

describe('Autopilot connection materialization contract', () => {
  test('normalizes installation identity deterministically without changing sovereign agent IDs', () => {
    expect(normalizeAutopilotInstallationId('  INSTANCE-ABC  ')).toBe('instance-abc');
    expect(normalizeAutopilotAgentId('  Agent-Case-Sensitive  ')).toBe('Agent-Case-Sensitive');
  });

  test('registers both canonical sync families and additive runtime migration blocks', () => {
    expect(recordFamilies.autopilot_connection).toBe('autopilot_connections');
    expect(recordFamilies.workspace_agent).toBe('workspace_agents');
    const schema = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8');
    expect(schema).toContain('flightdeck_pg_autopilot_connections');
    expect(schema).toContain('fips_transport_npub TEXT');
    expect(schema).toContain('flightdeck_pg_workspace_agents');
    expect(schema).toContain("flightdeck_pg_record_capture('autopilot_connection')");
    expect(schema).toContain("flightdeck_pg_record_capture('workspace_agent')");
  });

  test('documents and rejects secret-shaped connection payload fields at the route boundary', () => {
    const route = readFileSync(new URL('../src/routes/flightdeck-pg.ts', import.meta.url), 'utf8');
    expect(route).toContain('secret_material_forbidden');
    expect(route).toContain('bunker_uri');
    expect(route).toContain("permission: 'workspace.manage'");
    expect(route).toContain("permission: 'workspace.read'");
  });
});
