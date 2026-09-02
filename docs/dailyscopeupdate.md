# Daily Scope Update - Tower Tickets

## Product Decision

Daily Scope is a personal, workspace-anchored planning surface.

Canonical identity:

- one active Daily Scope per `workspace_id + owner_actor_id + note_date`
- `owner_actor_id` is the human whose day is being planned
- agents may read or edit a human's Daily Scope only when explicitly allowed
- scope and channel context may be retained as optional metadata, but must not determine identity, visibility, or uniqueness

Daily Scope content has two first-class parts:

- `items`: checklist of up to five focus items for the day
- `body` / narrative: free-form summary, plan, progress, blockers, or agent-produced morning-brief text

Yoke is not part of this implementation path. Autopilot agents should use direct Flight Deck PG APIs.

## Ticket TOWER-DS-1: Re-key Daily Notes To Person-Date

### Goal

Make Tower store and upsert Daily Scope by person/date rather than channel/scope/date.

### Current State

`flightdeck_pg_daily_notes` has `owner_actor_id`, but the active unique index is currently based on:

- `workspace_id`
- `note_date`
- `scope_id`
- `channel_id`

The POST route requires `channel_id` and authorizes `daily_note.write` against the channel.

### Required Changes

- Change the active unique key to `workspace_id + owner_actor_id + note_date`.
- Keep `scope_id` and `channel_id` nullable as context metadata only, or move future context entirely into `metadata`.
- Update `upsertFlightDeckPgDailyNote` conflict target to use owner/date.
- Update runtime schema in `src/schema/ensure-runtime-schema.ts`.
- Update bootstrap schema in `src/schema/001_init.sql`.
- Add migration/backfill behavior:
  - find existing active duplicates by `workspace_id + owner_actor_id + note_date`
  - keep the newest `updated_at`, then `created_at`, then stable `id`
  - archive older duplicates with `deleted_at`, `status = archived`, and row version bump
  - preserve old scope/channel values in `metadata.previous_contexts` or equivalent if useful

### Acceptance Criteria

- A user can have only one active Daily Scope per date in a workspace.
- Creating or updating a Daily Scope does not require `channel_id`.
- Existing scoped daily notes do not block schema migration.
- Tests cover duplicate migration and owner/date upsert conflict behavior.

## Ticket TOWER-DS-2: Daily Scope Access Model

### Goal

Authorize Daily Scope through explicit owner plus selected agent access, not channel membership.

### Required Changes

- Treat `daily_note.read` and `daily_note.write` as workspace/person-level operations rather than channel operations.
- Preserve self-access:
  - the owner can read/write their own Daily Scope
- Add explicit agent access:
  - an agent can read/write a human's Daily Scope only when that human has enabled Daily Scope access for that agent
- Prefer reusing Tower group/grant primitives if this fits cleanly:
  - suggested group label: `Daily Scope Agents`
  - the group is personal to the human, not a workspace-wide agent pool
  - membership should be explicit per agent
- If a group is used, add enough metadata to distinguish this from normal workspace groups.
- Do not grant all `Agents` group members access by default.

### Open Design Point

Choose one durable model before implementation:

1. Personal group model:
   - create one hidden/system-ish group per human, e.g. `Daily Scope Agents`
   - Daily Scope read/write checks allow owner or member of the owner's group
2. Direct collaborator table:
   - table stores `workspace_id`, `owner_actor_id`, `agent_actor_id`, `can_read`, `can_write`
   - simpler auth query, less reuse of group UX

Recommended starting point: personal group model if current group membership APIs can support per-human hidden groups without leaking confusing UI. Otherwise use a direct collaborator table and expose it through settings-specific routes.

### Acceptance Criteria

- Workspace agents do not get Daily Scope access merely because they are agents.
- Owner can explicitly grant and revoke Daily Scope access per agent.
- Revoked agents lose read/write access without changing unrelated channel permissions.
- Audit events record the actor who edited the note and the human owner whose note changed.

## Ticket TOWER-DS-3: Daily Scope API Contract

### Goal

Expose APIs that Flight Deck and Autopilot tools can use for "my Daily Scope" and "my human's Daily Scope".

### Required Route Behavior

- `GET /api/v4/flightdeck-pg/workspaces/:workspaceId/daily-notes`
  - default: list visible personal Daily Scopes, latest first
  - filters:
    - `note_date`
    - `owner_actor_id` or `owner_npub`
    - `limit`
  - no channel/scope filter needed for the new UX
- `POST /api/v4/flightdeck-pg/workspaces/:workspaceId/daily-notes`
  - default owner: authenticated actor
  - optional owner: target human owner when caller is an authorized agent
  - body supports:
    - `note_date`
    - `title`
    - `body`
    - `focus`
    - `items` with max length 5
    - `status`
    - `metadata`
- `GET /api/v4/flightdeck-pg/workspaces/:workspaceId/daily-notes/:dailyNoteId`
  - authorize by owner/self or explicit Daily Scope agent access

### Payload Requirements

- Include `owner_actor_id`.
- Include `owner_actor_npub` when practical for client display and local indexing.
- Include `created_by_actor_id` and `updated_by_actor_id`.
- Validate `items` as an array of checklist items:
  - max 5 items
  - item text required when item exists
  - completed state boolean
  - stable item id if supplied by client, generated or preserved server-side if needed

### SSE / Outbox

- Emit Daily Scope events without requiring channel id.
- Payload should include:
  - `daily_note_id`
  - `owner_actor_id`
  - `note_date`
  - `updated_by_actor_id`
- Event visibility should follow the same owner/authorized-agent rule.

### Acceptance Criteria

- Flight Deck can load the current user's Daily Scope for today without a selected channel.
- Autopilot can read/write an authorized human's Daily Scope by owner/date.
- SSE refresh does not depend on the user's currently selected scope or channel.

## Ticket TOWER-DS-4: Tests And Contract Docs

### Required Tests

- owner creates daily note with no channel id
- owner updates same date and receives same note id with incremented row version
- second note same owner/date upserts, not duplicates
- different owner same date creates separate note
- unauthorized agent cannot read or write human note
- authorized Daily Scope agent can read/write human note
- revoked Daily Scope agent is denied
- `items` max of five is enforced
- SSE visibility follows Daily Scope access

### Docs

- Update `docs/permission.md` or Tower equivalent if the source of truth is in Tower.
- Update OpenAPI entries for Daily Scope filters, request body, and response shape.
- Note explicitly that Yoke is not part of this path.

