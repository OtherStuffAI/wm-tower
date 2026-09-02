import { Hono } from 'hono';
import {
  bulkUpsertGraphEdges,
  bulkUpsertGraphNodes,
  applyGraphRepositoryDelta,
  createGraphMemory,
  getNativeGraphNeighborhood,
  getNativeGraphBridgeNeighborhood,
  getGraphMemoryById,
  importNativeGraph,
  listNativeGraphEdges,
  listNativeGraphRepositoryCheckpoints,
  listGraphMemories,
  listNativeGraphNodes,
  resolveGraphRequestContext,
  searchNativeGraph,
  serializeGraphMemory,
  serializeNativeGraphEdge,
  serializeNativeGraphImportRun,
  serializeNativeGraphRepositoryCheckpoint,
  serializeNativeGraphNode,
  type GraphRouteFailure,
} from '../graph/service';
import type { CreateGraphMemoryInput, GraphBulkEdgesInput, GraphBulkImportInput, GraphBulkNodesInput, GraphRepositoryDeltaInput, SearchNativeGraphInput } from '../types';

export const graphRouter = new Hono();

function isFailure(value: unknown): value is GraphRouteFailure {
  return Boolean(value && typeof value === 'object' && 'status' in value && 'body' in value);
}

function maybeReturnFailure(c: any, value: unknown): Response | null {
  if (value instanceof Response) return value;
  if (isFailure(value)) return c.json(value.body, value.status);
  return null;
}

graphRouter.post('/memories', async (c) => {
  const body = await c.req.raw.clone().json().catch(() => null) as CreateGraphMemoryInput | null;
  if (!body) return c.json({ error: 'valid JSON body required' }, 400);

  const ctx = await resolveGraphRequestContext(c, body);
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await createGraphMemory(body, ctx as any);
  if (result.failure) return c.json(result.failure.body, result.failure.status);

  return c.json({ memory: serializeGraphMemory(result.memory!) }, 201);
});

graphRouter.get('/memories', async (c) => {
  const filters = {
    workspace_owner_npub: c.req.query('workspace_owner_npub') || undefined,
    visibility: c.req.query('visibility') as any,
    memory_type: c.req.query('memory_type') || undefined,
    owner_npub: c.req.query('owner_npub') || undefined,
    actor_npub: c.req.query('actor_npub') || c.req.query('agent_npub') || undefined,
    source_app_npub: c.req.query('source_app_npub') || undefined,
    group_id: c.req.query('group_id') || undefined,
    limit: Number.parseInt(String(c.req.query('limit') || ''), 10),
    offset: Number.parseInt(String(c.req.query('offset') || ''), 10),
  };

  const ctx = await resolveGraphRequestContext(c, {
    workspace_owner_npub: filters.workspace_owner_npub,
    source_app_npub: filters.source_app_npub,
  });
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await listGraphMemories(filters, ctx as any);
  return c.json({
    memories: result.memories.map(serializeGraphMemory),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    has_more: result.has_more,
  });
});

graphRouter.get('/memories/:memoryId', async (c) => {
  const memoryId = String(c.req.param('memoryId') || '').trim();
  const ctx = await resolveGraphRequestContext(c, {
    workspace_owner_npub: c.req.query('workspace_owner_npub') || undefined,
  });
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const memory = await getGraphMemoryById(memoryId, ctx as any);
  if (!memory) return c.json({ error: 'graph memory not found' }, 404);
  return c.json({ memory: serializeGraphMemory(memory) });
});

graphRouter.get('/search', async (c) => {
  const filters: SearchNativeGraphInput = {
    q: c.req.query('q') || '',
    workspace_owner_npub: c.req.query('workspace_owner_npub') || undefined,
    visibility: c.req.query('visibility') as any,
    owner_npub: c.req.query('owner_npub') || undefined,
    actor_npub: c.req.query('actor_npub') || c.req.query('agent_npub') || undefined,
    source_app_npub: c.req.query('source_app_npub') || undefined,
    group_id: c.req.query('group_id') || undefined,
    source: c.req.query('source') || undefined,
    label: c.req.query('label') || undefined,
    relationship_type: c.req.query('relationship_type') || undefined,
    limit: Number.parseInt(String(c.req.query('limit') || ''), 10),
  };

  const ctx = await resolveGraphRequestContext(c, {
    workspace_owner_npub: filters.workspace_owner_npub,
    actor_npub: filters.actor_npub,
    source_app_npub: filters.source_app_npub,
    group_id: filters.group_id,
  });
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await searchNativeGraph(filters, ctx as any);
  if (result.failure) return c.json(result.failure.body, result.failure.status);
  return c.json({
    query: result.query,
    results: result.results,
    total: result.total,
    limit: result.limit,
  });
});

graphRouter.post('/import-runs', async (c) => {
  const body = await c.req.raw.clone().json().catch(() => null) as GraphBulkImportInput | null;
  if (!body) return c.json({ error: 'valid JSON body required' }, 400);

  const ctx = await resolveGraphRequestContext(c, body);
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await importNativeGraph(body, ctx as any);
  if (result.failure) return c.json(result.failure.body, result.failure.status);

  return c.json({
    import_run: serializeNativeGraphImportRun(result.run!),
    nodes: result.nodes.map(serializeNativeGraphNode),
    edges: result.edges.map(serializeNativeGraphEdge),
  }, 201);
});

graphRouter.post('/repository-deltas', async (c) => {
  const body = await c.req.raw.clone().json().catch(() => null) as GraphRepositoryDeltaInput | null;
  if (!body) return c.json({ error: 'valid JSON body required' }, 400);

  const ctx = await resolveGraphRequestContext(c, body);
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await applyGraphRepositoryDelta(body, ctx as any);
  if (result.failure) return c.json(result.failure.body, result.failure.status);
  return c.json({ checkpoint: result.checkpoint, replayed: result.replayed, counts: result.counts });
});

graphRouter.get('/repository-checkpoints', async (c) => {
  const filters = {
    workspace_owner_npub: c.req.query('workspace_owner_npub') || undefined,
    visibility: c.req.query('visibility') as any,
    owner_npub: c.req.query('owner_npub') || undefined,
    actor_npub: c.req.query('actor_npub') || c.req.query('agent_npub') || undefined,
    source_app_npub: c.req.query('source_app_npub') || undefined,
    group_id: c.req.query('group_id') || undefined,
    source: c.req.query('source') || '',
    corpus_id: c.req.query('corpus_id') || undefined,
    repository_id: c.req.query('repository_id') || undefined,
    limit: Number.parseInt(String(c.req.query('limit') || ''), 10),
  };
  const ctx = await resolveGraphRequestContext(c, {
    workspace_owner_npub: filters.workspace_owner_npub,
    actor_npub: filters.actor_npub,
    source_app_npub: filters.source_app_npub,
    group_id: filters.group_id,
  });
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await listNativeGraphRepositoryCheckpoints(filters, ctx as any);
  if (result.failure) return c.json(result.failure.body, result.failure.status);
  return c.json({
    checkpoints: result.checkpoints.map(serializeNativeGraphRepositoryCheckpoint),
    count: result.checkpoints.length,
    limit: result.limit,
  });
});

graphRouter.post('/nodes/bulk-upsert', async (c) => {
  const body = await c.req.raw.clone().json().catch(() => null) as GraphBulkNodesInput | null;
  if (!body) return c.json({ error: 'valid JSON body required' }, 400);

  const ctx = await resolveGraphRequestContext(c, body);
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await bulkUpsertGraphNodes(body, ctx as any);
  if (result.failure) return c.json(result.failure.body, result.failure.status);
  return c.json({ nodes: result.nodes!.map(serializeNativeGraphNode), count: result.nodes!.length });
});

graphRouter.post('/edges/bulk-upsert', async (c) => {
  const body = await c.req.raw.clone().json().catch(() => null) as GraphBulkEdgesInput | null;
  if (!body) return c.json({ error: 'valid JSON body required' }, 400);

  const ctx = await resolveGraphRequestContext(c, body);
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await bulkUpsertGraphEdges(body, ctx as any);
  if (result.failure) return c.json(result.failure.body, result.failure.status);
  return c.json({ edges: result.edges!.map(serializeNativeGraphEdge), count: result.edges!.length });
});

graphRouter.get('/nodes', async (c) => {
  const filters = {
    workspace_owner_npub: c.req.query('workspace_owner_npub') || undefined,
    visibility: c.req.query('visibility') as any,
    owner_npub: c.req.query('owner_npub') || undefined,
    actor_npub: c.req.query('actor_npub') || c.req.query('agent_npub') || undefined,
    source_app_npub: c.req.query('source_app_npub') || undefined,
    group_id: c.req.query('group_id') || undefined,
    source: c.req.query('source') || undefined,
    run_id: c.req.query('run_id') || undefined,
    label: c.req.query('label') || undefined,
    limit: Number.parseInt(String(c.req.query('limit') || ''), 10),
    offset: Number.parseInt(String(c.req.query('offset') || ''), 10),
  };
  const ctx = await resolveGraphRequestContext(c, {
    workspace_owner_npub: filters.workspace_owner_npub,
    source_app_npub: filters.source_app_npub,
  });
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await listNativeGraphNodes(filters, ctx as any);
  return c.json({
    nodes: result.nodes.map(serializeNativeGraphNode),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    has_more: result.has_more,
  });
});

graphRouter.get('/edges', async (c) => {
  const filters = {
    workspace_owner_npub: c.req.query('workspace_owner_npub') || undefined,
    visibility: c.req.query('visibility') as any,
    owner_npub: c.req.query('owner_npub') || undefined,
    actor_npub: c.req.query('actor_npub') || c.req.query('agent_npub') || undefined,
    source_app_npub: c.req.query('source_app_npub') || undefined,
    group_id: c.req.query('group_id') || undefined,
    source: c.req.query('source') || undefined,
    run_id: c.req.query('run_id') || undefined,
    relationship_type: c.req.query('relationship_type') || undefined,
    limit: Number.parseInt(String(c.req.query('limit') || ''), 10),
    offset: Number.parseInt(String(c.req.query('offset') || ''), 10),
  };
  const ctx = await resolveGraphRequestContext(c, {
    workspace_owner_npub: filters.workspace_owner_npub,
    source_app_npub: filters.source_app_npub,
  });
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  const result = await listNativeGraphEdges(filters, ctx as any);
  return c.json({
    edges: result.edges.map(serializeNativeGraphEdge),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    has_more: result.has_more,
  });
});

graphRouter.get('/neighborhood', async (c) => {
  const filters = {
    node_id: c.req.query('node_id') || undefined,
    external_id: c.req.query('external_id') || undefined,
    source: c.req.query('source') || undefined,
    direction: c.req.query('direction') || undefined,
    workspace_owner_npub: c.req.query('workspace_owner_npub') || undefined,
    visibility: c.req.query('visibility') as any,
    owner_npub: c.req.query('owner_npub') || undefined,
    actor_npub: c.req.query('actor_npub') || c.req.query('agent_npub') || undefined,
    group_id: c.req.query('group_id') || undefined,
    limit: Number.parseInt(String(c.req.query('limit') || ''), 10),
  };
  const ctx = await resolveGraphRequestContext(c, {
    workspace_owner_npub: filters.workspace_owner_npub,
  });
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;

  try {
    const result = await getNativeGraphNeighborhood(filters, ctx as any);
    if (!result.center) return c.json({ error: 'graph node not found' }, 404);
    return c.json({
      center: serializeNativeGraphNode(result.center),
      nodes: result.nodes.map(serializeNativeGraphNode),
      edges: result.edges.map(serializeNativeGraphEdge),
    });
  } catch (error) {
    const status = (error as any)?.status || 500;
    return c.json({ error: error instanceof Error ? error.message : 'failed to fetch graph neighborhood' }, status);
  }
});

graphRouter.get('/bridge-neighborhood', async (c) => {
  const filters = {
    node_id: c.req.query('node_id') || undefined,
    external_id: c.req.query('external_id') || undefined,
    source: c.req.query('source') || undefined,
    workspace_owner_npub: c.req.query('workspace_owner_npub') || undefined,
    source_app_npub: c.req.query('source_app_npub') || undefined,
    group_id: c.req.query('group_id') || undefined,
    relationship_types: String(c.req.query('relationship_types') || '').split(',').filter(Boolean),
    bridge_labels: String(c.req.query('bridge_labels') || '').split(',').filter(Boolean),
    limit: Number.parseInt(String(c.req.query('limit') || ''), 10),
  };
  const ctx = await resolveGraphRequestContext(c, filters);
  const failure = maybeReturnFailure(c, ctx);
  if (failure) return failure;
  try {
    const result = await getNativeGraphBridgeNeighborhood(filters, ctx as any);
    if (!result.center) return c.json({ error: 'graph node not found' }, 404);
    return c.json({
      center: serializeNativeGraphNode(result.center),
      bridges: result.bridges.map(serializeNativeGraphNode),
      stories: result.stories.map(serializeNativeGraphNode),
      edges: result.edges.map(serializeNativeGraphEdge),
    });
  } catch (error) {
    const status = (error as any)?.status || 500;
    return c.json({ error: error instanceof Error ? error.message : 'failed to fetch graph bridge neighborhood' }, status);
  }
});
