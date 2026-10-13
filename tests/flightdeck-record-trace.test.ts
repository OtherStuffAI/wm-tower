import { expect, test } from 'bun:test';
import { traceFlightDeckRecordPage } from '../src/services/flightdeck-record-trace';

test('opt-in sync evidence binds signer and actor without credentials, cursors or content', () => {
  const previous = process.env.TOWER_PG_SYNC_TRACE_NPUB;
  try {
    const lines: string[] = [];
    const input: any = {requestUrl:'https://tower.example/record-sync?cursor=private-cursor',signerNpub:'session-signer',actorNpub:'member',actorId:'actor',workspaceId:'workspace',
      page:{protocol_version:2,mode:'snapshot',changes:[{family:'message',scope_id:'scope',channel_id:'channel',row:{body:'private-content'}}],next_cursor:'private-next',has_more:false,snapshot_complete:true,retention_policy:'retain_downloaded'}};
    delete process.env.TOWER_PG_SYNC_TRACE_NPUB;
    traceFlightDeckRecordPage(input,line=>lines.push(line));
    process.env.TOWER_PG_SYNC_TRACE_NPUB='someone-else';
    traceFlightDeckRecordPage(input,line=>lines.push(line));
    expect(lines).toEqual([]);
    process.env.TOWER_PG_SYNC_TRACE_NPUB='member';
    traceFlightDeckRecordPage(input,line=>lines.push(line));
    expect(JSON.parse(lines[0])).toMatchObject({origin:'https://tower.example',signer_npub:'session-signer',actor_npub:'member',changes:1,scope_ids:['scope'],channel_ids:['channel'],families:{message:1}});
    expect(lines[0]).not.toContain('private-');
    expect(lines[0]).not.toContain('row');
  } finally {if(previous===undefined)delete process.env.TOWER_PG_SYNC_TRACE_NPUB;else process.env.TOWER_PG_SYNC_TRACE_NPUB=previous;}
});
