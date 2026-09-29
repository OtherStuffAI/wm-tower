import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';

const port = Number(process.env.RECORD_TEST_PORT);

describe.skipIf(!port || port === 5432)('Flight Deck Agent Space disposable-Postgres integration', () => {
  const database = `tower_agent_space_${process.pid}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const managerSecret = new Uint8Array(32).fill(71);
  const readerSecret = new Uint8Array(32).fill(72);
  const deniedSecret = new Uint8Array(32).fill(73);
  const managerNpub = nip19.npubEncode(getPublicKey(managerSecret));
  const readerNpub = nip19.npubEncode(getPublicKey(readerSecret));
  const deniedNpub = nip19.npubEncode(getPublicKey(deniedSecret));
  const agentNpub = nip19.npubEncode(createHash('sha256').update('agent-space-agent').digest('hex'));
  const transportNpub = nip19.npubEncode(createHash('sha256').update('agent-space-transport').digest('hex'));
  const otherTransportNpub = nip19.npubEncode(createHash('sha256').update('agent-space-other-transport').digest('hex'));
  const appNpub = nip19.npubEncode(createHash('sha256').update('agent-space-app').digest('hex'));
  let sql: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createApp>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let managerId: string;
  let readerId: string;

  function authHeader(path: string, method: string, secret: Uint8Array, body?: unknown) {
    const tags = [['u', `http://localhost${path}`], ['method', method.toUpperCase()]];
    if (body !== undefined) tags.push(['payload', createHash('sha256').update(JSON.stringify(body)).digest('hex')]);
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, secret);
    return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
  }

  async function request(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', secret: Uint8Array, body?: unknown) {
    const response = await app.request(path, {
      method,
      headers: { Authorization: authHeader(path, method, secret, body), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, json: await response.json() as any };
  }

  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.end();
    sql = postgres({ ...connection, database });
    setDb(sql);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) {
      await sql.unsafe(statement);
    }
    const actors = await sql<{ id: string; npub: string }[]>`
      INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES
        (${managerNpub},'human','Manager'),(${readerNpub},'human','Reader'),(${deniedNpub},'human','Denied') RETURNING id,npub
    `;
    managerId = actors.find((actor) => actor.npub === managerNpub)!.id;
    readerId = actors.find((actor) => actor.npub === readerNpub)!.id;
    const deniedId = actors.find((actor) => actor.npub === deniedNpub)!.id;
    const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('tower-agent-space','workspace-agent-space',${managerNpub},${appNpub},'Agent Space',${managerId}) RETURNING id
    `;
    workspaceId = workspace.id;
    for (const actorId of [managerId, readerId, deniedId]) {
      await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role,created_by_actor_id) VALUES(${workspaceId},${actorId},'member',${managerId})`;
    }
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission,created_by_actor_id) VALUES
      (${workspaceId},'actor',${managerId},'workspace','workspace.read',${managerId}),
      (${workspaceId},'actor',${managerId},'workspace','workspace.manage',${managerId}),
      (${workspaceId},'actor',${readerId},'workspace','workspace.read',${managerId})`;
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('tower-other','workspace-other',${managerNpub},${appNpub},'Other',${managerId}) RETURNING id
    `;
    otherWorkspaceId = other.id;
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role,created_by_actor_id) VALUES(${otherWorkspaceId},${managerId},'owner',${managerId})`;
    app = createApp();
  });

  afterAll(async () => { await closeDb(); });

  test('enforces workspace.read and workspace.manage at the route boundary', async () => {
    const listPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/autopilot-connections`;
    expect((await request(listPath, 'GET', readerSecret)).response.status).toBe(200);
    const deniedRead = await request(listPath, 'GET', deniedSecret);
    expect(deniedRead.response.status).toBe(403);
    expect(deniedRead.json.required_permission).toBe('workspace.read');
    const deniedCreate = await request(listPath, 'POST', readerSecret, connectionBody());
    expect(deniedCreate.response.status).toBe(403);
    expect(deniedCreate.json.required_permission).toBe('workspace.manage');
  });

  function connectionBody(overrides: Record<string, unknown> = {}) {
    return { installation_id: '  Install-Primary  ', display_name: 'Primary', fips_endpoint: 'fips://autopilot.example', https_endpoint: 'https://autopilot.example', api_version: '1', capabilities: ['agents.read'], metadata: { region: 'au' }, ...overrides };
  }

  test('persists normalized connections, agents, audit actors, optimistic updates and propagated events', async () => {
    const connectionsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/autopilot-connections`;
    const created = await request(connectionsPath, 'POST', managerSecret, connectionBody());
    expect(created.response.status).toBe(201);
    expect(created.json.autopilot_connection.installation_id).toBe('install-primary');
    expect(created.json.autopilot_connection.created_by_actor_id).toBe(managerId);
    expect(created.json.outbox).toBeTruthy();
    const connectionId = created.json.autopilot_connection.id as string;

    const duplicate = await request(connectionsPath, 'POST', managerSecret, connectionBody({ installation_id: 'INSTALL-PRIMARY' }));
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.json.normalized_duplicate).toBe(true);
    expect(duplicate.json.autopilot_connection.id).toBe(connectionId);

    const agentsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/workspace-agents`;
    const first = await request(agentsPath, 'POST', managerSecret, { connection_id: connectionId, agent_id: 'agent-a', agent_npub: agentNpub, display_name: 'Agent A', sort_order: 2, capabilities: ['chat'], metadata: {} });
    const second = await request(agentsPath, 'POST', managerSecret, { connection_id: connectionId, agent_id: 'agent-b', agent_npub: agentNpub, display_name: 'Agent B', sort_order: 1, capabilities: [], metadata: {} });
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);
    expect(first.json.workspace_agent.connection_id).toBe(connectionId);
    expect(first.json.workspace_agent.created_by_actor_id).toBe(managerId);

    const duplicateAgent = await request(agentsPath, 'POST', managerSecret, { connection_id: connectionId, agent_id: 'agent-a', agent_npub: agentNpub, display_name: 'Again' });
    expect(duplicateAgent.response.status).toBe(409);
    expect(duplicateAgent.json.code).toBe('workspace_agent_exists');

    const foreign = await sql<{ id: string }[]>`INSERT INTO flightdeck_pg_autopilot_connections(workspace_id,installation_id,display_name,fips_endpoint,created_by_actor_id,updated_by_actor_id) VALUES(${otherWorkspaceId},'foreign','Foreign','fips://foreign.example',${managerId},${managerId}) RETURNING id`;
    const crossWorkspace = await request(agentsPath, 'POST', managerSecret, { connection_id: foreign[0]!.id, agent_id: 'agent-x', agent_npub: agentNpub, display_name: 'Cross' });
    expect(crossWorkspace.response.status).toBe(400);
    expect(crossWorkspace.json.details.fields).toContainEqual(expect.objectContaining({ path: 'connection_id', code: 'invalid_reference' }));

    const agentId = first.json.workspace_agent.id as string;
    const stale = await request(`${agentsPath}/${agentId}`, 'PATCH', managerSecret, { row_version: 99, display_name: 'Stale' });
    expect(stale.response.status).toBe(409);
    const updated = await request(`${agentsPath}/${agentId}`, 'PATCH', managerSecret, { row_version: 1, display_name: 'Agent A+', is_visible: false });
    expect(updated.response.status).toBe(200);
    expect(updated.json.workspace_agent.row_version).toBe(2);
    expect(updated.json.workspace_agent.updated_by_actor_id).toBe(managerId);
    expect(updated.json.outbox).toBeTruthy();

    const protectedArchive = await request(`${connectionsPath}/${connectionId}`, 'DELETE', managerSecret);
    expect(protectedArchive.response.status).toBe(409);
    expect(protectedArchive.json.code).toBe('connection_has_active_agents');
    for (const id of [agentId, second.json.workspace_agent.id]) {
      const archived = await request(`${agentsPath}/${id}`, 'DELETE', managerSecret);
      expect(archived.response.status).toBe(200);
      expect(archived.json.workspace_agent.archived_by_actor_id).toBe(managerId);
      expect(archived.json.outbox).toBeTruthy();
    }
    const archivedConnection = await request(`${connectionsPath}/${connectionId}`, 'DELETE', managerSecret);
    expect(archivedConnection.response.status).toBe(200);
    expect(archivedConnection.json.autopilot_connection.archived_by_actor_id).toBe(managerId);

    const archivedAgentReference = await request(agentsPath, 'POST', managerSecret, { connection_id: connectionId, agent_id: 'agent-c', agent_npub: agentNpub, display_name: 'Archived ref' });
    expect(archivedAgentReference.response.status).toBe(400);
    const events = await sql<{ entity_type: string; operation: string }[]>`SELECT entity_type,operation FROM flightdeck_pg_outbox_events WHERE workspace_id=${workspaceId} AND entity_type IN ('autopilot_connection','workspace_agent')`;
    expect(events).toEqual(expect.arrayContaining([
      { entity_type: 'autopilot_connection', operation: 'created' },
      { entity_type: 'workspace_agent', operation: 'updated' },
      { entity_type: 'workspace_agent', operation: 'archived' },
      { entity_type: 'autopilot_connection', operation: 'archived' },
    ]));
  });

  test('rejects secret-shaped fields and non-public endpoints through routes', async () => {
    const path = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/autopilot-connections`;
    for (const body of [
      connectionBody({ installation_id: 'secret-a', bearer_token: 'do-not-store' }),
      connectionBody({ installation_id: 'secret-b', metadata: { bunker_uri: 'bunker://secret' } }),
      connectionBody({ installation_id: 'endpoint-a', fips_endpoint: 'http://localhost:9000' }),
      connectionBody({ installation_id: 'endpoint-b', https_endpoint: 'https://' + 'user:pass@example.com' }),
      connectionBody({ installation_id: 'endpoint-c', fips_endpoint: 'http://example.com:3601' }),
      connectionBody({ installation_id: 'endpoint-d', fips_endpoint: `http://${transportNpub}.fips:3601?redirect=https://example.com`, fips_transport_npub: transportNpub }),
      connectionBody({ installation_id: 'endpoint-e', fips_endpoint: `http://${transportNpub}.fips:3601`, fips_transport_npub: otherTransportNpub }),
    ]) expect((await request(path, 'POST', managerSecret, body)).response.status).toBe(400);
  });

  test('retains exact v2 signed FIPS origins and rejects mismatched updates', async () => {
    const path = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/autopilot-connections`;
    const endpoint = `http://${transportNpub}.fips:3601`;
    const created = await request(path, 'POST', managerSecret, connectionBody({
      installation_id: 'v2-install', fips_endpoint: endpoint, fips_transport_npub: transportNpub,
    }));
    expect(created.response.status).toBe(201);
    expect(created.json.autopilot_connection).toMatchObject({ fips_endpoint: endpoint, fips_transport_npub: transportNpub });

    const connectionId = created.json.autopilot_connection.id as string;
    const mismatch = await request(`${path}/${connectionId}`, 'PATCH', managerSecret, { fips_transport_npub: otherTransportNpub });
    expect(mismatch.response.status).toBe(400);
    expect(mismatch.json.details.fields).toContainEqual(expect.objectContaining({ code: 'identity_mismatch' }));

    const stored = await sql<{ fips_endpoint: string; fips_transport_npub: string }[]>`
      SELECT fips_endpoint,fips_transport_npub FROM flightdeck_pg_autopilot_connections WHERE id=${connectionId}
    `;
    expect(stored[0]).toEqual({ fips_endpoint: endpoint, fips_transport_npub: transportNpub });
  });

  test('bundled sync and canonical deltas expose both families and archive tombstones', async () => {
    const connectionsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/autopilot-connections`;
    const connection = await request(connectionsPath, 'POST', managerSecret, connectionBody({ installation_id: 'sync-install' }));
    const connectionId = connection.json.autopilot_connection.id as string;
    const agentsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/workspace-agents`;
    const agent = await request(agentsPath, 'POST', managerSecret, { connection_id: connectionId, agent_id: 'sync-agent', agent_npub: agentNpub, display_name: 'Sync Agent' });
    const syncPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/sync`;
    const snapshot = await request(syncPath, 'GET', readerSecret);
    expect(snapshot.response.status).toBe(200);
    expect(snapshot.json.autopilot_connections.some((row: any) => row.id === connectionId)).toBe(true);
    expect(snapshot.json.autopilot_connections.find((row: any) => row.id === connectionId).fips_transport_npub).toBeNull();
    expect(snapshot.json.workspace_agents.some((row: any) => row.id === agent.json.workspace_agent.id)).toBe(true);

    let page = await readFlightDeckRecordPage({ workspaceId, actorId: readerId }, sql);
    const changes: any[] = [];
    while (true) { changes.push(...page.changes); if (!page.has_more) break; page = await readFlightDeckRecordPage({ workspaceId, actorId: readerId, cursor: page.next_cursor }, sql); }
    expect(changes.some((change) => change.family === 'autopilot_connection' && change.id === connectionId && change.operation === 'upsert')).toBe(true);
    expect(changes.some((change) => change.family === 'workspace_agent' && change.id === agent.json.workspace_agent.id && change.operation === 'upsert')).toBe(true);
    const cursor = page.next_cursor;

    await request(`${agentsPath}/${agent.json.workspace_agent.id}`, 'DELETE', managerSecret);
    await request(`${connectionsPath}/${connectionId}`, 'DELETE', managerSecret);
    const delta = await readFlightDeckRecordPage({ workspaceId, actorId: readerId, cursor }, sql);
    expect(delta.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'workspace_agent', id: agent.json.workspace_agent.id, operation: 'delete', row: null }),
      expect.objectContaining({ family: 'autopilot_connection', id: connectionId, operation: 'delete', row: null }),
    ]));
  });
});
