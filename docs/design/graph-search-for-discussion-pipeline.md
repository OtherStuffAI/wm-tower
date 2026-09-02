# Graph Search For Discussion Chat Pipeline

## Context

Wingman needs a Flight Deck chat response path for messages whose intent is discussion, planning, or design thinking. That path should not create a task. It should run as a short-lived pipeline for each incoming chat message, using Tower graph knowledge as the continuity layer between independent pipeline runs.

The discussion pipeline needs Tower graph support beyond the current native graph list and neighborhood endpoints:

1. Extract entities from the latest chat thread.
2. Search Tower graph for relevant context for those entities.
3. Let an agent decide whether the discussion learned durable knowledge.
4. Write conservative graph updates.
5. Generate the chat reply from latest thread plus refreshed graph context.

Tower already has authenticated graph routes for memories, native node/edge import, list, and neighborhood lookup. This change should add the graph search primitive needed by the pipeline.

## Goal

Add a first-class authenticated Tower graph search endpoint that returns compact, ranked graph context suitable for agent prompts.

The endpoint should support deterministic pipeline steps that ask questions like:

- What does the graph know about "discussion chat response pipeline"?
- What nodes/edges mention "Flight Deck", "intent", or "Tower graph"?
- What prior decisions or concepts are near a given entity key?

## Proposed API

Add:

```text
GET /api/v4/graph/search
```

Query parameters:

- `q`: required search text.
- `workspace_owner_npub`: optional workspace scope.
- `visibility`: optional `personal`, `agent`, or `group`.
- `owner_npub`: optional personal owner filter.
- `actor_npub` or `agent_npub`: optional agent actor filter.
- `group_id`: optional group filter.
- `source`: optional graph source filter.
- `label`: optional node label filter.
- `relationship_type`: optional edge relationship filter.
- `limit`: optional, default 20, max 100.

Response shape:

```json
{
  "query": "discussion pipeline",
  "results": [
    {
      "kind": "node",
      "score": 1.0,
      "id": "uuid",
      "external_id": "concept:discussion-chat-response-pipeline",
      "source": "wingman-discussion",
      "labels": ["Concept", "Pipeline"],
      "title": "Discussion chat response pipeline",
      "summary": "A Flight Deck chat response path...",
      "properties": {}
    },
    {
      "kind": "edge",
      "score": 0.72,
      "id": "uuid",
      "external_id": "thread:abc:mentions:concept:...",
      "source": "wingman-discussion",
      "relationship_type": "MENTIONS",
      "from_external_id": "thread:abc",
      "to_external_id": "concept:discussion-chat-response-pipeline",
      "summary": "thread:abc MENTIONS concept:discussion-chat-response-pipeline",
      "properties": {}
    }
  ],
  "total": 2,
  "limit": 20
}
```

## Search Semantics

This first pass does not need embeddings. It should be useful and reliable with Postgres text search primitives.

Search nodes across:

- `external_id`
- `node_type`
- `labels`
- selected text-like properties, especially `name`, `title`, `summary`, `description`, `status`
- a fallback JSON text representation of `properties`

Search edges across:

- `external_id`
- `relationship_type`
- selected text-like properties
- connected node `external_id`s

Optional memory search may include `graph_memories.title`, `graph_memories.summary`, and metadata text. Do not try to search encrypted `body_ciphertext`.

Ranking can be simple:

- exact external ID match first
- prefix/substring matches on external ID, title, name, labels, relationship type
- fallback property JSON matches last

The endpoint should return compact summaries. It must not dump large JSON blobs unless the caller asks for a specific node later through an existing endpoint.

## Security And Scope

Use the same `resolveGraphRequestContext` path as existing graph routes.

The search must:

- require NIP-98 auth;
- respect `GRAPH_ALLOWED_NPUBS`;
- respect workspace visibility checks;
- rely on existing RLS policies;
- never bypass graph identity session settings;
- support agent visibility when signed directly by the agent npub;
- support group visibility only for current group members.

## Implementation Notes

Suggested code shape:

- Add `searchNativeGraph(input, ctx)` in `src/graph/service.ts`.
- Add `graphRouter.get('/search', ...)` in `src/routes/graph.ts`.
- Add exported input/result types in `src/types.ts`.
- Add OpenAPI schemas and route docs in `src/openapi.ts`.
- Add integration coverage in `tests/graph.test.ts`.

Prefer parameterized SQL with the existing graph DB helpers and `withGraphIdentity`.

Do not alter existing import/list/neighborhood behavior except as needed for shared helpers.

## Tests

Add tests that prove:

1. Unauthenticated search returns `401`.
2. Non-allowlisted actor returns `403 graph_not_allowed`.
3. Agent-signed search can find an agent-visible node by query text.
4. Search respects `source` and `label` filters.
5. Edge search can return a relationship connected to matching node external IDs or relationship type.
6. Group-scoped search does not leak to non-members.

Use existing graph test setup and fixtures where practical.

## Acceptance Criteria

- `GET /api/v4/graph/search?q=...` works with signed automation-agent requests.
- Results are compact enough to pass directly into a pipeline agent prompt.
- Scope filters behave consistently with existing graph list/neighborhood endpoints.
- OpenAPI documents the endpoint.
- Focused graph tests pass.
- Existing graph import/list/neighborhood tests continue to pass.
