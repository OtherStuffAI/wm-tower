# Agent Direct Chat: Tower MVP Design

## Purpose

Agent Direct Chat lets a human converse with a Wingman agent in a normal Flight Deck channel thread. A canonical agent mention activates a direct Autopilot session; Autopilot answers by creating an ordinary Tower PG chat message signed by the agent. Later human messages in the activated thread continue the same Autopilot conversation without a pipeline.

Tower is the shared authority and transport boundary. It stores channel configuration and messages, validates actors and access, emits visible events, provides authoritative ordered thread reads, and makes agent reply creation idempotent. Tower does not run or resume Autopilot sessions.

## System Ownership

- Flight Deck owns mention selection, channel settings, and message rendering.
- Tower owns canonical workspace/channel/thread/message data, authorization, actor identity, visible events, and idempotent writes.
- Autopilot owns local agent configuration, routing, session lifecycle, prompts, response parsing, and publication calls.

There is no direct Flight Deck browser-to-Autopilot connection and no pipeline or invocation record for this MVP.

## MVP Tower Responsibilities

Tower must provide:

1. durable, validated Agent Direct Chat channel configuration;
2. canonical structured agent mentions on messages;
3. complete message-created visible events or an immediate authoritative recovery path;
4. stable ordered thread reads with author identity;
5. agent-authored typed message creation using NIP-98 identity;
6. idempotent message creation for safe Autopilot retries;
7. normal authorization and visibility enforcement for all of the above.

Tower must not own:

- local directories or project checkout paths;
- Autopilot session IDs as operational state;
- session create/resume/interrupt operations;
- prompt delivery cursors;
- output parsing;
- agent model selection.

Autopilot may include a session ID in message provenance, but Tower treats it as descriptive metadata.

## Channel Configuration Contract

For the MVP, use the existing channel metadata column with route-level validation:

```json
{
  "agent_chat": {
    "enabled": true,
    "context_prompt": "You are helping with the Wingman Be Free project.",
    "activation": "mention_then_continue"
  }
}
```

Validation rules:

- `agent_chat` must be an object when present;
- `enabled` must be boolean;
- `context_prompt` must be a string with an explicit reasonable size limit;
- `activation` must be `mention_then_continue` for the MVP;
- unknown keys may be rejected or preserved according to the established typed metadata policy, but behavior-bearing keys must be validated;
- only an actor authorized to edit the channel can change this configuration.

Channel reads must return the normalized configuration. Channel updates must merge it without dropping unrelated channel metadata.

If the live system already stores channel prompt information as `basePrompt` or `contextPrompt`, implement a deliberate compatibility read/migration. Define one canonical write location so Flight Deck and Autopilot cannot observe conflicting prompts.

Typed columns may replace metadata later, but that is not required for the MVP.

## Canonical Mention Contract

The message create request accepts structured mentions in metadata or a typed request property agreed with Flight Deck. The MVP normalized representation is:

```json
{
  "mentions": [
    {
      "type": "agent",
      "npub": "npub1f49ke5fkzqev4x7j46uajq92f4zan6kcpty5yvm5c3g6wf2dqanqn7qsy2",
      "label": "Agent"
    }
  ]
}
```

Tower must:

1. validate `type`, `npub`, and optional display label;
2. resolve the npub to a workspace actor;
3. confirm the mentioned agent is visible/permitted in the message channel;
4. store canonical identity, preferably including the resolved actor ID in normalized output;
5. return the normalized mentions in message reads and event payloads;
6. never infer a canonical mention only from visible `@Name` text.

Suggested normalized response form:

```json
{
  "type": "agent",
  "actor_id": "<uuid>",
  "npub": "npub1...",
  "label": "Agent"
}
```

The label is presentation data and is not identity.

## Message Creation and Authorship

Use the existing typed route family:

```text
POST /api/v4/flightdeck-pg/workspaces/:workspaceId/channels/:channelId/messages
```

The route must support normal human and agent NIP-98 signers subject to existing channel authorization.

Author rules:

- derive `created_by_actor_id` and actor npub from the authenticated signer/mapping;
- never accept caller-provided provenance as the authoritative author;
- require the agent to have workspace/channel access;
- attach the message to the supplied canonical thread only when that thread belongs to the same workspace/channel;
- preserve message metadata after validation;
- write the ordinary outbox/visible event used by Flight Deck and Autopilot.

An Autopilot reply is an ordinary chat message, not a task comment, invocation result, generic record, Nostr post, or special response record.

## Idempotent Message Writes

Extend message creation with an optional caller-scoped idempotency key:

```json
{
  "body": "Here is the answer.",
  "thread_id": "<thread-id>",
  "client_request_id": "agentdirect:<routing-key-hash>:<turn-id>",
  "metadata": {
    "source": "autopilot_session",
    "session_id": "<session-id>",
    "turn_id": "<turn-id>",
    "source_message_ids": ["<human-message-id>"]
  }
}
```

Required semantics:

- uniqueness is scoped at least by workspace, authenticated actor, and `client_request_id`;
- the first valid request creates the message and normal event;
- an exact retry returns the existing message and does not emit another created event;
- a retry using the same key with materially different channel, thread, or body returns `409 Conflict` rather than silently changing the original;
- response status/body must tell the caller whether the message was created or replayed;
- ordinary clients may omit the key.

Implementation options include a nullable `client_request_id` on `flightdeck_pg_messages` with a partial unique index, or a general request-deduplication table. Prefer the smallest design consistent with existing schema patterns.

This contract protects the crash window where Tower accepts the reply but Autopilot restarts before persisting Tower's response.

## Message Event Contract

The `message.created` visible/outbox event should include enough identity to route efficiently:

```json
{
  "event_type": "message.created",
  "workspace_id": "...",
  "scope_id": "...",
  "channel_id": "...",
  "thread_id": "...",
  "entity_type": "message",
  "entity_id": "...",
  "actor_id": "...",
  "actor_npub": "...",
  "created_at": "...",
  "mentions": [
    {
      "type": "agent",
      "actor_id": "...",
      "npub": "npub1..."
    }
  ]
}
```

The event cursor/order must remain monotonic under the existing workspace event API.

The event is still advisory. Autopilot must be able to recover the authoritative message and thread through typed reads using the IDs. Do not put full thread history in the event.

Self-authored agent replies produce the same ordinary event. Autopilot suppresses them by authenticated actor identity; Tower should not hide those events because Flight Deck and other authorized consumers need them.

## Authoritative Thread Read Contract

The existing channel messages/thread routes must support fetching a canonical thread with stable ordering. Each returned message needs:

```json
{
  "id": "...",
  "workspace_id": "...",
  "scope_id": "...",
  "channel_id": "...",
  "thread_id": "...",
  "body": "...",
  "created_by_actor_id": "...",
  "created_by_actor_npub": "...",
  "created_by_actor_label": "...",
  "mentions": [],
  "attachments": [],
  "metadata": {},
  "created_at": "...",
  "updated_at": "..."
}
```

Requirements:

- authorize the reader against the workspace/channel;
- verify the requested thread belongs to the specified channel;
- order deterministically, using `(created_at, id)` or an existing monotonic row/event field plus ID;
- provide pagination without losing or duplicating messages at boundaries;
- preserve attachment-only messages;
- return authenticated actor identity, not only metadata-provided sender fields;
- provide enough history for Autopilot to fetch the complete thread, even when one page is insufficient.

If the existing `GET .../channels/:channelId/messages?thread_id=...` contract already satisfies this, document and test it instead of adding a duplicate route.

## Optional Response Activity

Tower already has response-activity concepts. The MVP may reuse them to expose `waiting`, `running`, `failed`, or `idle` UI state, but this is optional.

If implemented:

- activity records are transient/descriptive, not the chat answer;
- they are keyed by workspace/channel/thread/agent;
- stale activity expires;
- failure to update activity must not prevent message delivery;
- Flight Deck continues to render the final answer from the ordinary message table.

## Single Implementation Work Package

Implement this MVP as one Tower work package named **Agent Direct Chat: typed chat contract and reliable delivery**. Assign the complete package to one worker/session in this repository. Do not split channel configuration, canonical mentions, events, thread reads, idempotent writes, migrations, OpenAPI, and tests into separate independently handed-off tasks: together they are one versioned backend contract consumed by Flight Deck and Autopilot.

### Package objective

Make Tower the complete authoritative transport for Agent Direct Chat while remaining unaware of Autopilot session lifecycle.

### Prerequisites

- The normalized request/response/event shapes in this document are accepted as the MVP cross-project contract.
- Existing Flight Deck PG authorization remains the basis for channel visibility and message creation.

### Included work

- validate and normalize `metadata.agent_chat` on channel reads/writes;
- accept, resolve, authorize, store, and return canonical agent mentions;
- expose required actor, mention, workspace, channel, thread, and cursor identity in visible events;
- guarantee deterministic, pageable authoritative thread reads;
- permit authorized agent NIP-98 signers to create ordinary thread messages;
- add caller-scoped message idempotency and conflict behavior;
- add safe schema migrations and compatibility behavior;
- update OpenAPI and contract fixtures;
- add route, service, authorization, event, migration, and idempotency tests.

### Explicit exclusions

- no Autopilot session or project configuration;
- no session create/resume endpoints in Tower;
- no pipeline or invocation record for chat;
- no response parsing;
- no requirement to implement optional response activity for MVP completion.

### Deliverables

- safe runtime/formal schema changes;
- typed route and service implementation for the complete contract;
- updated OpenAPI definitions and representative fixtures;
- automated coverage for every acceptance case below;
- an integration smoke path usable by Flight Deck and Autopilot workers;
- a handoff naming any compatibility aliases and their removal/migration expectations.

### Validation and definition of done

Run focused Flight Deck PG route/service tests, schema migration checks, contract fixture tests, and the repository's full relevant test suite. The package is done only when every Tower acceptance test below passes, existing message clients remain compatible, duplicate publication is proven safe, authorship cannot be spoofed, and compatible Flight Deck and Autopilot builds complete the integrated vertical slice.

## Schema and Migration Directions

1. Add storage/validation for normalized structured mentions if message metadata is not sufficiently queryable or validated today.
2. Add `client_request_id` support and its uniqueness constraint or a deduplication table.
3. Add any required event payload fields without breaking existing event consumers.
4. Normalize channel `metadata.agent_chat` in the typed PG route layer.
5. Backfill is not required for old messages; they simply lack canonical mentions.
6. Existing channel prompt data should be compatibly read and migrated on update if necessary.
7. All migrations must be safe for existing workspaces and nullable/disabled by default.

Likely implementation areas include:

- `src/schema/ensure-runtime-schema.ts` and formal migrations if used by this repo;
- `src/routes/flightdeck-pg.ts` request validation and response shaping;
- `src/services/flightdeck-pg-api.ts` channel/message storage and thread reads;
- `src/services/flightdeck-pg-authorization.ts` only if existing channel checks are insufficient;
- `src/openapi.ts` for the public contract;
- PG route/service tests and contract fixtures.

The implementer must inspect the live schema and reuse existing normalization/authorization helpers rather than adding parallel rules.

## API Documentation Directions

Update OpenAPI definitions for:

- channel `agent_chat` configuration;
- structured mention input/output;
- `client_request_id` input;
- created versus replayed message response behavior;
- message event mention and actor fields;
- deterministic thread pagination/order.

Document that Autopilot replies are normal agent-authored messages and that metadata provenance is non-authoritative.

## Acceptance Tests

1. An authorized channel editor can enable Agent Direct Chat and save a context prompt.
2. An unauthorized actor cannot change Agent Direct Chat configuration.
3. A valid agent mention resolves to the canonical workspace actor and round-trips through reads/events.
4. Unknown, inaccessible, or malformed actor mentions are rejected; actor kind is not a dispatch decision.
5. Literal `@Agent` text without structured mention input is stored as text but not normalized as a mention.
6. A human message emits one visible `message.created` event with workspace/channel/thread/actor/mention identity.
7. An authorized agent NIP-98 signer can create a normal message in the thread.
8. An agent without channel access receives an authorization failure.
9. Caller metadata cannot impersonate another author.
10. Repeating the same `client_request_id` and payload returns the original message and emits no duplicate event.
11. Reusing an idempotency key with a different body or target returns `409`.
12. A full thread read is deterministic and includes author npubs, mentions, attachments, metadata, and stable IDs.
13. A thread from another channel cannot be used as the reply target.
14. Existing message clients that omit mentions and `client_request_id` continue to work.

## Cross-Project Delivery Contract

The Tower portion is complete only when the integrated vertical slice succeeds:

```text
Flight Deck writes a canonical Agent mention
→ Tower stores it and emits one visible event
→ Autopilot fetches authoritative channel/thread state
→ Autopilot creates or resumes Agent's normal session
→ Autopilot writes the parsed reply with an idempotency key
→ Tower attributes it to Agent and emits one visible event
→ Flight Deck renders exactly one ordinary Agent-authored message
```

See the corresponding `docs/agentdirect.md` documents in Flight Deck and Autopilot for their portions of the design.

## Canonical Actor Display Names

`flightdeck_pg_actors.display_name` is the canonical workspace identity label used by membership lists, message authors, and mention rendering. `user_profiles.display_name` is a compatibility mirror only when a matching profile row already exists.

Name precedence is:

1. an explicit self-service or workspace-manager profile update;
2. a non-empty name supplied by member, invite, or connect/upsert flows;
3. an existing trustworthy actor name;
4. a setup placeholder only when no trustworthy name is known.

The setup labels `Flight Deck PG Creator`, `Flight Deck PG Workspace Owner`, `Flight Deck PG Smoke Viewer`, and the legacy `Flight Deck PG Collaborator` are placeholders, not durable user choices. Runtime migration may replace a missing/placeholder actor name from a non-empty, non-placeholder legacy user profile. It never invents a name from an npub. A trustworthy actor name is then mirrored to an existing user profile.

Actors update themselves with `PATCH /api/v4/flightdeck-pg/workspaces/{workspaceId}/me`. The equivalent member route is `PATCH /api/v4/flightdeck-pg/workspaces/{workspaceId}/members/{actorId}/profile`; self-targets are allowed and other targets require `workspace.manage`. Both emit an audit record and an `actor.profile.updated` outbox event so SSE clients refetch the workspace member directory.
