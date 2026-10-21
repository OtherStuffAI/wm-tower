# Flight Deck PG Canvas authority

Tower owns the shared Canvas definition, visibility, viewer order, naplet
references, native elements, threaded comments, and presentation state. Ambulando owns the spatial rendering and its
viewer-partitioned Dexie projection. A Canvas is workspace-wide; it is not
anchored to a scope or channel.

## Routes and identity

The NIP-98 surface is:

- `GET/POST /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases`
- `PUT /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/order`
- `GET/PATCH /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId`
- `GET /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId/snapshot`
- `POST /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId/naplets`
- `PATCH /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId/naplets/:napletId`
- `DELETE /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId/naplets/:napletId`
- `POST /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId/elements`
- `PATCH/DELETE /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId/elements/:elementId`
- `GET/POST /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId/comments`
- `PATCH /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId/comments/:commentId`

Every route uses the normal resolved NIP-98 actor. Human and agent actors follow
the same membership, stable-group and record permission path. List and snapshot
responses are complete and carry the standard Tower/workspace/app identity
tuple so a local client can reject a foreign or partial projection.

## Visibility, management and ordering

Canvas visibility is either workspace-wide or restricted to validated workspace
actor IDs and stable group UUIDs. Workspace managers and the creator can manage
a Canvas; visibility by itself does not confer management. The creator and
workspace managers retain visibility so a restricted Canvas cannot become
unmanageable.

Ordering is stored per workspace viewer. Reorder accepts the complete set of
Canvases visible to the current actor and fails on a visibility-set race. This
lets two actors order different restricted projections without turning a
channel into the Canvas owner.

Canvas, naplet, element and comment mutations require `expected_row_version`
where they update or delete an existing row and use an
atomic row-version predicate. Audit and outbox rows are written in the same
transaction. Canvas outbox events receive an additional visibility filter;
restricted Canvas IDs and naplet IDs do not become generic workspace events.

Native elements are Canvas-owned rows with a validated kind, bounded layout,
JSON data, actor attribution, soft deletion, and monotonic row version.
Comments are Canvas-owned root/reply rows anchored either to coordinates or a
naplet. A reply inherits its root anchor. Any viewer may comment; resolving or
reopening is limited to the comment author or a Canvas manager and uses CAS.
Comment snapshots include authors and timestamps for browser and agent callers
through the same signed API.

## Canonical source mapping

Naplets store only `source_type`, `source_id`, optional display title and layout:

| Source type | Canonical `source_id` | Snapshot authorization |
| --- | --- | --- |
| `document` | Flight Deck PG document UUID | `doc.read` on the document channel |
| `task_list` | Flight Deck PG channel UUID | `task.read` on that channel |
| `chat_thread` | Flight Deck PG thread UUID | `channel.read` on the thread channel |
| `html` | Immutable Flight Deck PG file-version UUID | `file.read` on the owning file channel |

Placement validates that the source exists and is currently readable. Snapshot
reads repeat that check. Revocation, deletion, missing storage bytes and
not-found records all become the same response:

```json
{
  "id": "naplet-uuid",
  "access": "denied",
  "layout": { "x": 0, "y": 0, "width": 360, "height": 280, "z": 1 },
  "row_version": 1
}
```

No source type, source ID, title, author, timestamps, counts, filename or content
is included in this state. The explanatory sentence shown to a person remains a
client concern.

A naplet-anchored comment follows the same independent source boundary. If the
viewer cannot read that naplet source, serialization degrades the anchor to its
stored canvas coordinates and does not expose the naplet ID or protected source
metadata.

## HTML boundary

HTML is never represented by an arbitrary URL. `source_id` selects an immutable
file version whose completed storage object must be UTF-8 HTML, no larger than
the configured first-pass package limit, and have a valid SHA-256 digest. Tower
returns only the authorized package bytes, immutable version number and digest.
It does not return a signed URL, signer capability, credential, arbitrary fetch
authority or broader storage access.

Ambulando renders those bytes in its documented opaque-origin sandbox. Tower's
package admission and authorization are the authority boundary; the browser
sandbox is defense in depth, not a substitute for source review and digest
verification.

## Activation

Schema exists in bootstrap SQL and the additive runtime schema path. Source and
contract tests do not activate a running Tower. After an authorized rebuild and
restart, validation must include signed two-actor tests for visible, restricted,
revoked and missing sources plus immutable HTML retrieval.

## Canvas Link source

`source.type = "canvas"` names another visible canvas UUID in this same workspace.
Creation rejects self-links and version pins. The existing optional `title` is a
display label; the source projection is exactly `{ title: <destination title> }`.
The resolver uses the same membership, app namespace, workspace management,
creator, actor and effective-group visibility checks as direct canvas reads.
Missing, deleted and denied destinations collapse to the existing four-field
redacted naplet envelope, including the label. No source canvas visibility grants
access to a target. Destination snapshots/naplets are never loaded or traversed;
cycles are ordinary references. There is no screenshot/preview storage contract.

Bootstrap and `ensureRuntimeSchema` replay the Canvas SQL block, widening the
named source-type CHECK to admit `canvas`; the HTML-only version-pin constraint
is retained. Existing source payloads and generic record-family schemas are
unchanged. Activate Tower before the matching Ambulando picker and perform a
signed allowed/denied/revoked/deleted smoke pass after restart.
