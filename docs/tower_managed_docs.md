# Tower-Managed Repo Docs

## Purpose

Wingman agents work best when project context is physically present in the repo they are operating in. Local `README.md`, `AGENTS.md`, and `docs/` files are easy for agents and humans to read with normal shell tools, especially `rg`.

Tower should still remain the source of truth for graph memory, history, relationships, access control, and encrypted storage. This document defines a simple bridge:

- Tower graph and records are canonical.
- A repo opts in by adding `.wingman-tower.yml` at its root.
- Once opted in, the repo's `docs/` folder is Tower-managed.
- Local files in `docs/` are disposable working projections.
- Durable edits must be submitted through Tower/Yoke, not by hand-editing generated markdown.

This keeps local agent ergonomics without creating an unmanaged second wiki.

## Core Rule

If a repository contains `.wingman-tower.yml`, then `docs/` is owned by Tower.

Rules:

- Wingman local service may create, overwrite, delete, and reorder files under `docs/`.
- Local edits under `docs/` are ignored and may be thrown away on the next sync.
- `docs/` should be added to `.gitignore` for Tower-managed repos.
- All document history, graph relationships, ownership, and permissions live in Tower.
- Agents that want to make durable changes must call Tower/Yoke APIs or a Wingman skill.
- Existing hand-written docs should be imported into Tower or moved elsewhere before enabling this mode.

`AGENTS.md` should state this plainly in any repo using the convention:

```md
When `.wingman-tower.yml` exists, `docs/` is generated from Tower. Do not make durable edits directly in `docs/`; submit changes through Wingman/Tower.
```

## Marker File

Repo root:

```text
repo/
  .wingman-tower.yml
  .gitignore
  AGENTS.md
  docs/
```

Example `.wingman-tower.yml`:

```yaml
version: 1
type: development # development | agent | writing
tower_url: http://127.0.0.1:3100
workspace_owner_npub: npub...
project_key: wingman-tower
visibility: agent

managed_docs_dir: docs
mode: tower_managed

sync:
  pull:
    - designs
    - decisions
    - schemas
    - project_memory
    - related_projects
  local_edits: discard
```

Do not store `nsec`, group secrets, service tokens, or wrapped keys in `.wingman-tower.yml`.

## Folder Types

### `development`

For code repositories.

Typical generated docs:

```text
docs/
  architecture.md
  decisions/
  schemas/
  memory/
  related/
  .wingman-manifest.json
```

Pulls project architecture, design decisions, record schemas, runtime contracts, active project memory, and related repo links.

### `agent`

For agent homes, such as a local Wingman agent workspace.

Typical generated docs:

```text
docs/
  operating-notes.md
  skills/
  memory/
  sessions/
  .wingman-manifest.json
```

Pulls that agent's own memory, operating instructions, skill notes, session summaries, and relevant group memory.

### `writing`

For writing projects.

Typical generated docs:

```text
docs/
  outline.md
  drafts/
  references/
  style-memory.md
  .wingman-manifest.json
```

Pulls outlines, source notes, drafts, references, and style preferences.

## Local Service

A local Wingman service scans configured roots for `.wingman-tower.yml`. It should not blindly scan the entire machine.

For each linked folder, the service:

1. Reads `.wingman-tower.yml`.
2. Authenticates to Tower with a local npub/nsec controlled by the agent or operator.
3. Registers or updates a `ProjectSpace` in Tower graph.
4. Ensures the managed docs path is in `.gitignore`.
5. Pulls the current visible graph-backed docs for that project.
6. Rewrites `docs/` from Tower.
7. Writes a local `.wingman-manifest.json`.

First build should be pull-only. It should not attempt file-level conflict resolution.

## Sync Semantics

The managed docs folder is a cache.

Recommended sync algorithm:

1. Read previous `docs/.wingman-manifest.json`, if present.
2. Delete files previously written by Wingman.
3. Leave unknown files alone only if the implementation supports a safe allowlist; otherwise fail loudly.
4. Pull graph docs from Tower.
5. Render markdown.
6. Write files.
7. Write a new manifest.

Because local edits are disposable, the service does not need to diff edited markdown against Tower. Durable edits must be submitted through explicit commands or API calls.

Example commands:

```sh
wingman tower docs sync
wingman tower docs pull
wingman tower docs propose --title "Graph Memory Design" --body ./draft.md
wingman tower docs update graphdoc_abc --body ./draft.md
```

An agent skill can wrap these commands so coding agents can propose or update docs without hand-editing generated files.

## Generated Markdown

Every generated file should contain frontmatter and a visible warning.

Example:

```md
---
wingman_tower_id: graphdoc_abc
project_key: wingman-tower
source: tower_projection
managed_by: wingman_tower
local_edits: discarded
visibility: agent
owner_npub: npub...
actor_npub: npub...
workspace_owner_npub: npub...
body_hash: sha256...
last_synced_at: 2026-05-08T10:00:00Z
related:
  - graphdoc_def
  - project_wingman_yoke
---

<!--
Generated from Tower. Local edits are disposable.
Submit durable changes through Wingman/Tower.
-->

# Graph Memory Design
```

The frontmatter is for local agents and debugging. Tower remains authoritative.

## Tower Graph Model

Managed docs should map to graph-backed artifacts rather than loose files.

Useful nodes:

- `ProjectSpace`
- `GraphDoc`
- `DesignDoc`
- `Decision`
- `RecordFamilySchema`
- `SessionSummary`
- `Memory`
- `Entity`
- `AppNamespace`
- `Repository`

Useful relationships:

- `HAS_DOC`
- `HAS_DECISION`
- `USES_SCHEMA`
- `RELATED_TO`
- `DERIVED_FROM`
- `SUPERSEDES`
- `MENTIONS`
- `VISIBLE_TO_GROUP`
- `PROJECTS_TO_FILE`

Tower should store stable IDs, visibility, owner npubs, group IDs, content hashes, versions, and graph relationships. The local markdown path is a projection target, not identity.

## Access And Privacy

Local markdown is plaintext once written to disk. Tower must only materialize documents that the local signing principal is allowed to read.

Rules:

- Agent-private docs are materialized only for that agent npub.
- Group docs are materialized only when the signer has current group access.
- Workspace/admin count visibility does not grant access to document content.
- Revocation stops future sync, but cannot erase plaintext already written locally.
- Generated docs must never include `nsec`, raw group keys, wrapped keys, access tokens, or secrets.

For group memory, Tower should continue to enforce stable `group_id` access and group epoch rules. The local service is only a projection client.

## Relationship To Repo Docs

This convention intentionally treats `docs/` as generated when `.wingman-tower.yml` exists.

If a repo needs hand-written, Git-tracked docs, choose one of these approaches before enabling Tower-managed docs:

- import those docs into Tower first;
- move hand-written docs to another path, such as `manual-docs/`;
- configure a future implementation with a smaller managed path, such as `docs/wingman/`.

The first build should prefer the simple rule: `.wingman-tower.yml` means Tower owns `docs/`.

## Implementation Notes

Tower responsibilities:

- expose graph-backed doc list/read APIs;
- expose explicit doc create/update/propose APIs;
- store document versions and relationships;
- enforce NIP-98 auth, npub ownership, group access, and RLS;
- provide enough metadata for local projection.

Local Wingman service responsibilities:

- discover opted-in folders;
- sync generated docs from Tower;
- keep `docs/` ignored by git;
- write manifests and frontmatter;
- avoid storing secrets;
- provide explicit commands for proposing durable doc changes.

Yoke/agent skill responsibilities:

- give agents an explicit way to submit durable doc changes;
- avoid treating direct edits in generated docs as durable;
- query Tower graph for cross-repo context.

## First Milestone

Build the smallest useful version:

1. Add `.wingman-tower.yml` support to the local Wingman service.
2. Register a `development` project space in Tower.
3. Add a pull-only docs sync command.
4. Generate `docs/` from Tower graph docs.
5. Add `docs/` to `.gitignore`.
6. Add generated frontmatter and warning comments.
7. Add a Yoke/skill command to propose durable doc updates.

This gives local agents the repo-near markdown they expect while keeping corporate/team memory, history, permissions, and relationships inside Tower.
