import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server';
import {
  FlightDeckPgCanvasConflictError,
  assertCompleteFlightDeckPgCanvasOrder,
  deniedFlightDeckPgCanvasNaplet,
  flightDeckPgCanvasDigestMatches,
  flightDeckPgCanvasCanManage,
  flightDeckPgCanvasIsVisible,
  normalizeFlightDeckPgCanvasLayout,
  normalizeFlightDeckPgCanvasElementLayout,
  normalizeFlightDeckPgCanvasViewport,
  requireFlightDeckPgCanvasMutation,
  serializeAuthorizedFlightDeckPgCanvasNaplet,
  serializeFlightDeckPgCanvas,
} from '../src/services/flightdeck-pg-canvases';
import { HTML_ARTIFACT_MANIFEST_ID, HTML_ARTIFACT_MAX_ASSETS, htmlArtifactDigestMatches, parseHtmlArtifactManifest } from '../src/services/flightdeck-pg-html-artifacts';

const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

describe('Flight Deck PG Canvas source contract', () => {
  test('keeps visibility and management separate with actor/group and agent/user parity', () => {
    const creator = uuid('1');
    const directViewer = uuid('2');
    const groupViewer = uuid('3');
    const group = uuid('9');
    const base = { mode: 'restricted' as const, creatorActorId: creator, actorIds: [directViewer], visibleGroupIds: [group], canManageWorkspace: false };

    expect(flightDeckPgCanvasIsVisible({ ...base, actorId: directViewer, groupIds: [] })).toBe(true);
    expect(flightDeckPgCanvasIsVisible({ ...base, actorId: groupViewer, groupIds: [group] })).toBe(true);
    expect(flightDeckPgCanvasIsVisible({ ...base, actorId: uuid('4'), groupIds: [] })).toBe(false);
    expect(flightDeckPgCanvasIsVisible({ ...base, actorId: creator, groupIds: [] })).toBe(true);
    expect(flightDeckPgCanvasCanManage({ actorId: directViewer, creatorActorId: creator, canManageWorkspace: false })).toBe(false);
    expect(flightDeckPgCanvasCanManage({ actorId: creator, creatorActorId: creator, canManageWorkspace: false })).toBe(true);
    expect(flightDeckPgCanvasCanManage({ actorId: uuid('5'), creatorActorId: creator, canManageWorkspace: true })).toBe(true);

    // Actor kind is deliberately absent from the policy input: agents and
    // humans are evaluated through exactly the same actor/group rule.
    expect(Object.keys(base)).not.toContain('actorKind');
  });

  test('normalizes presentation state and serializes the complete definition contract', () => {
    expect(normalizeFlightDeckPgCanvasViewport({ x: 1.8, y: -2.2, scale: 99 })).toEqual({ x: 2, y: -2, scale: 3 });
    expect(normalizeFlightDeckPgCanvasLayout({ x: 1.8, y: -2.2, width: 1, height: 9000, z: 0 })).toEqual({ x: 2, y: -2, width: 220, height: 1000, z: 1 });
    expect(normalizeFlightDeckPgCanvasElementLayout({ width: 1, height: 9000 })).toEqual({ x: 0, y: 0, width: 8, height: 4000, z: 1 });
    const serialized = serializeFlightDeckPgCanvas({
      id: uuid('10'), workspace_id: uuid('11'), title: 'Plan', position: 2, visibility_mode: 'restricted',
      viewport: { x: 1, y: 2, scale: 1.2 }, actor_ids: [uuid('2')], group_ids: [uuid('9')], can_manage: true,
      created_by_actor_id: uuid('1'), updated_by_actor_id: uuid('1'), row_version: 4,
      created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-02T00:00:00Z'), deleted_at: null,
    });
    expect(serialized).toMatchObject({ id: uuid('10'), title: 'Plan', position: 2, can_manage: true, row_version: 4, visibility: { mode: 'restricted', actor_ids: [uuid('2')], group_ids: [uuid('9')] } });
  });

  test('requires an exact complete viewer-visible set for ordering', () => {
    expect(() => assertCompleteFlightDeckPgCanvasOrder(['a', 'b'], ['b', 'a'])).not.toThrow();
    for (const stale of [['a'], ['a', 'b', 'c'], ['a', 'a']]) {
      expect(() => assertCompleteFlightDeckPgCanvasOrder(['a', 'b'], stale)).toThrow(FlightDeckPgCanvasConflictError);
    }
    const source = readFileSync(new URL('../src/services/flightdeck-pg-canvases.ts', import.meta.url), 'utf8');
    expect(source.match(/lockFlightDeckPgCanvasVisibilitySet\(input\.workspaceId, sql\)/g)?.length).toBe(3);
  });

  test('surfaces stale individual Canvas and naplet row versions as conflicts', () => {
    expect(requireFlightDeckPgCanvasMutation({ row_version: 2 })).toEqual({ row_version: 2 });
    expect(() => requireFlightDeckPgCanvasMutation(null)).toThrow(FlightDeckPgCanvasConflictError);
    expect(() => requireFlightDeckPgCanvasMutation(undefined, 'Canvas naplet row_version is stale')).toThrow('Canvas naplet row_version is stale');
  });

  test('redacts forbidden and not-found sources to the identical four-field shape', () => {
    const base = { id: uuid('20'), layout: { x: 1, y: 2, width: 360, height: 280, z: 3 }, row_version: 7 };
    const forbidden = deniedFlightDeckPgCanvasNaplet({ ...base, source_type: 'document', source_id: uuid('21'), display_title: 'Secret' } as any);
    const missing = deniedFlightDeckPgCanvasNaplet({ ...base, source_type: 'html', source_id: uuid('22'), display_title: 'Missing package' } as any);
    expect(forbidden).toEqual(missing);
    expect(Object.keys(forbidden).sort()).toEqual(['access', 'id', 'layout', 'row_version']);
    expect(JSON.stringify(forbidden)).not.toMatch(/document|html|Secret|Missing|source/);
  });

  test('projects every source type when authorized and redacts access revoked after placement', async () => {
    const types = ['document', 'task_list', 'task_tree', 'chat_thread', 'html', 'excalidraw', 'canvas'] as const;
    for (const [index, sourceType] of types.entries()) {
      const naplet = {
        id: uuid(String(30 + index)), workspace_id: uuid('11'), canvas_id: uuid('10'), source_type: sourceType,
        source_id: uuid(String(40 + index)), display_title: null, layout: { x: 0, y: 0, width: 360, height: 280, z: index + 1 },
        created_by_actor_id: uuid('1'), updated_by_actor_id: uuid('1'), row_version: 1,
        created_at: new Date(), updated_at: new Date(), deleted_at: null,
      };
      const ready = await serializeAuthorizedFlightDeckPgCanvasNaplet(
        { workspaceId: uuid('11'), appNpub: 'app', actorNpub: `viewer-${index}`, naplet },
        {} as any,
        async input => ({ title: `${input.sourceType} title`, content: input.sourceType === 'html' ? { html: '<main>safe</main>', version: '1', digest: 'a'.repeat(64) } : { kind: input.sourceType } }),
      );
      expect(ready).toMatchObject({ access: 'ready', source: { type: sourceType, id: naplet.source_id }, title: `${sourceType} title` });

      const revoked = await serializeAuthorizedFlightDeckPgCanvasNaplet(
        { workspaceId: uuid('11'), appNpub: 'app', actorNpub: `viewer-${index}`, naplet }, {} as any, async () => null,
      );
      const missing = await serializeAuthorizedFlightDeckPgCanvasNaplet(
        { workspaceId: uuid('11'), appNpub: 'app', actorNpub: `viewer-${index}`, naplet }, {} as any, async () => { throw new Error('not found'); },
      );
      expect(revoked).toEqual(missing);
      expect(Object.keys(revoked).sort()).toEqual(['access', 'id', 'layout', 'row_version']);
    }
  });

  test('publishes all exact routes, row-version conflicts and the five source types', async () => {
    const spec = await (await createApp().request('/openapi.json')).json() as any;
    const root = '/api/v4/flightdeck-pg/workspaces/{workspaceId}/canvases';
    expect(spec.paths[root].get).toBeDefined();
    expect(spec.paths[root].post).toBeDefined();
    expect(spec.paths[`${root}/order`].put).toBeDefined();
    expect(spec.paths[`${root}/{canvasId}`].get).toBeDefined();
    expect(spec.paths[`${root}/{canvasId}`].patch.responses['409']).toBeDefined();
    expect(spec.paths[`${root}/{canvasId}/snapshot`].get.description).toMatch(/Forbidden.*missing/i);
    expect(spec.paths[`${root}/{canvasId}/naplets`].post).toBeDefined();
    expect(spec.paths[`${root}/{canvasId}/naplets/{napletId}`].patch.responses['409']).toBeDefined();
    expect(spec.paths[`${root}/{canvasId}/naplets/{napletId}`].delete.responses['409']).toBeDefined();
    expect(spec.paths[`${root}/{canvasId}/elements`].post).toBeDefined();
    expect(spec.paths[`${root}/{canvasId}/elements/{elementId}`].patch.responses['409']).toBeDefined();
    expect(spec.paths[`${root}/{canvasId}/elements/{elementId}`].delete.responses['409']).toBeDefined();
    expect(spec.paths[`${root}/{canvasId}/comments`]).toBeUndefined();
    expect(spec.paths[`${root}/{canvasId}/comments/{commentId}`]).toBeUndefined();
    expect(spec.components.schemas.FlightDeckPgCanvasNapletReady.properties.source.properties.type.enum).toEqual(['document', 'task_list', 'task_tree', 'chat_thread', 'html', 'excalidraw', 'canvas']);
    expect(spec.components.schemas.FlightDeckPgCanvasNapletDenied.additionalProperties).toBe(false);
    expect(spec.components.schemas.FlightDeckPgCanvasElement.properties.kind.enum).toContain('text');
  });

  test('registers the complete signed Canvas interaction surface', () => {
    const routes = readFileSync(new URL('../src/routes/flightdeck-pg.ts', import.meta.url), 'utf8');
    const expected = [
      ['get', '/workspaces/:workspaceId/canvases'],
      ['post', '/workspaces/:workspaceId/canvases'],
      ['put', '/workspaces/:workspaceId/canvases/order'],
      ['get', '/workspaces/:workspaceId/canvases/:canvasId'],
      ['patch', '/workspaces/:workspaceId/canvases/:canvasId'],
      ['get', '/workspaces/:workspaceId/canvases/:canvasId/snapshot'],
      ['post', '/workspaces/:workspaceId/canvases/:canvasId/naplets'],
      ['patch', '/workspaces/:workspaceId/canvases/:canvasId/naplets/:napletId'],
      ['delete', '/workspaces/:workspaceId/canvases/:canvasId/naplets/:napletId'],
      ['get', '/workspaces/:workspaceId/canvases/:canvasId/naplets/:napletId/html'],
      ['post', '/workspaces/:workspaceId/canvases/:canvasId/elements'],
      ['patch', '/workspaces/:workspaceId/canvases/:canvasId/elements/:elementId'],
      ['delete', '/workspaces/:workspaceId/canvases/:canvasId/elements/:elementId'],
    ];
    for (const [method, path] of expected) {
      expect(routes).toContain(`flightDeckPgRouter.${method}('${path}'`);
    }
    expect(routes.match(/flightDeckPgRouter\.(?:get|post|put|patch|delete)\('\/workspaces\/:workspaceId\/canvases/g)?.length).toBe(13);
  });

  test('bootstraps and runtime-migrates dedicated Canvas authority tables', () => {
    const bootstrap = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8');
    const runtime = readFileSync(new URL('../src/schema/ensure-runtime-schema.ts', import.meta.url), 'utf8');
    for (const table of ['flightdeck_pg_canvases', 'flightdeck_pg_canvas_visibility_principals', 'flightdeck_pg_canvas_orders', 'flightdeck_pg_canvas_naplets', 'flightdeck_pg_canvas_elements']) {
      expect(bootstrap).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(bootstrap).toContain("CHECK (source_type IN ('document', 'task_list', 'task_tree', 'chat_thread', 'html', 'excalidraw', 'canvas'))");
    expect(bootstrap).toContain("CHECK (source_version_id IS NULL OR source_type = 'html')");
    expect(bootstrap).toContain('REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id)');
    expect(bootstrap).toContain('REFERENCES flightdeck_pg_groups(workspace_id, id)');
    expect(runtime).toContain("split('-- flightdeck_pg_canvas_v1')");
  });

  test('source resolver independently applies every canonical family permission and immutable HTML version boundary', () => {
    const source = readFileSync(new URL('../src/services/flightdeck-pg-canvases.ts', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../src/services/flightdeck-pg-html-artifacts.ts', import.meta.url), 'utf8');
    expect(source).toContain("permission: 'doc.read'");
    expect(source).toContain("permission: 'task.read'");
    expect(source).toContain("permission: 'channel.read'");
    expect(source).toContain('resolveFlightDeckPgHtmlArtifact');
    expect(html).toContain("permission: 'file.read'");
    expect(html).toContain('resolveFlightDeckPgFileVersion');
    const bytes = new TextEncoder().encode('<main>safe</main>');
    expect(flightDeckPgCanvasDigestMatches(bytes, 'cca4aacf89195582f9ad39d3e635b268ae56b01281f51a64b2337148464e8b72')).toBe(true);
    expect(flightDeckPgCanvasDigestMatches(bytes, 'a'.repeat(64))).toBe(false);
    expect(flightDeckPgCanvasDigestMatches(bytes, 'not-a-digest')).toBe(false);
    expect(htmlArtifactDigestMatches(bytes, 'cca4aacf89195582f9ad39d3e635b268ae56b01281f51a64b2337148464e8b72')).toBe(true);
    expect(htmlArtifactDigestMatches(bytes, 'a'.repeat(64))).toBe(false);
    expect(html).toContain('htmlArtifactDigestMatches(stored.bytes, digest)');
    // Authorization precedes the version relation and byte read.
    expect(html.indexOf('canReadFileChannel({ ...input, channelId: file.channel_id }')).toBeLessThan(html.indexOf('const targetVersionId'));
    for (const text of [source, html]) {
      expect(text).not.toContain('signed_url');
      expect(text).not.toContain('download_url');
      expect(text).not.toContain('signer_npub');
    }
  });

  test('parses only an exact, bounded HTML asset manifest', () => {
    const id = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
    const entry = { name: 'hero.png', file_id: id('1'), version_id: id('2'), sha256: 'b'.repeat(64) };
    const wrap = (value: unknown) => `<p>x</p><script type="application/json" id="${HTML_ARTIFACT_MANIFEST_ID}">${typeof value === 'string' ? value : JSON.stringify(value)}</script>`;
    expect(parseHtmlArtifactManifest('<p>no manifest</p>')).toEqual({ entries: [], error: null });
    expect(parseHtmlArtifactManifest(wrap({ version: 1, assets: [entry] }))).toEqual({ entries: [entry], error: null });
    expect(parseHtmlArtifactManifest(wrap({ version: 1, assets: [{ ...entry, file_id: id('1').toUpperCase() }] })).entries[0]!.file_id).toBe(id('1'));
    for (const bad of [
      '{not json',
      { version: 2, assets: [] },
      { version: 1, assets: [entry, entry] },
      { version: 1, assets: [{ ...entry, name: '../escape.png' }] },
      { version: 1, assets: [{ ...entry, sha256: 'xyz' }] },
      { version: 1, assets: [{ ...entry, version_id: 'nope' }] },
      { version: 1, assets: Array.from({ length: HTML_ARTIFACT_MAX_ASSETS + 1 }, (_, i) => ({ ...entry, name: `a${i}.png` })) },
    ]) {
      const parsed = parseHtmlArtifactManifest(wrap(bad));
      expect(parsed.entries).toEqual([]);
      expect(parsed.error).toBeTruthy();
    }
    expect(parseHtmlArtifactManifest(wrap({ version: 1, assets: [] }) + wrap({ version: 1, assets: [] })).error).toBe('multiple asset manifests');
  });

  test('publishes the HTML version policy, browse route and typed immutable version byte route', async () => {
    const spec = await (await createApp().request('/openapi.json')).json() as any;
    const root = '/api/v4/flightdeck-pg/workspaces/{workspaceId}';
    expect(spec.paths[`${root}/canvases/{canvasId}/naplets/{napletId}/html`].get.description).toMatch(/file\.read/);
    expect(spec.paths[`${root}/files/{fileId}/versions/{versionId}/object`].get.description).toMatch(/file\.read.*sha256/s);
    expect(spec.paths[`${root}/canvases/{canvasId}/naplets/{napletId}`].patch.requestBody.content['application/json'].schema.properties.source_version_id).toBeDefined();
    expect(spec.components.schemas.FlightDeckPgCanvasNapletReady.properties.source.properties.version_id).toBeDefined();
    expect(spec.components.schemas.FlightDeckPgHtmlArtifactAsset.properties.status.enum).toEqual(['ready', 'unavailable']);
    const bootstrap = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8');
    const block = bootstrap.split('-- flightdeck_pg_canvas_v1')[1]!.split('-- end_flightdeck_pg_canvas_v1')[0]!;
    expect(block).toContain('ALTER TABLE flightdeck_pg_canvas_naplets ADD COLUMN IF NOT EXISTS source_version_id UUID;');
  });

  test('filters Canvas outbox events before the generic workspace SSE branch', () => {
    const api = readFileSync(new URL('../src/services/flightdeck-pg-api.ts', import.meta.url), 'utf8');
    expect(api).toContain("e.entity_type = 'canvas_order'");
    expect(api).toContain("e.payload->>'viewer_actor_id'");
    expect(api).toContain("e.entity_type IN ('canvas', 'canvas_naplet', 'canvas_element')");
    expect(api).toContain('flightdeck_pg_canvas_visibility_principals');
    expect(api).toContain("e.entity_type NOT IN ('canvas', 'canvas_naplet', 'canvas_element', 'canvas_order', 'canvas_comment')");
    expect(api.indexOf("e.entity_type IN ('canvas', 'canvas_naplet', 'canvas_element')"))
      .toBeLessThan(api.indexOf("e.entity_type NOT IN ('canvas', 'canvas_naplet', 'canvas_element', 'canvas_order', 'canvas_comment')"));
  });
});
