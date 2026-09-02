# Fix admin-start failure for managed Tower-backed WApps

## Goal

Make an Autopilot app-card Start button work for an admin-owned, Tower-backed WApp after its publisher/app identity has been rotated through the managed WApp installation flow. The start must not require the workspace owner to export a key or perform a second browser signing step.

## Confirmed failure

- Autopilot app: managed example WApp
- Autopilot app id: `<app-id>`
- WApp installation id: `<installation-id>`
- Workspace owner npub: `<workspace-owner-npub>`
- Flight Deck PG workspace id: `<workspace-id>`
- Current publisher/app npub in the managed installation and Autopilot WApp record: `<current-publisher-npub>`
- Stale legacy namespace still in `workspace_apps`: `<legacy-publisher-npub>`
- Bound Autopilot npub on the completed install intent: `<autopilot-npub>`
- Current Start failure: `Not authorized to manage this workspace`

The completed managed installation is active and binds the installation, current publisher npub, owner, workspace, and Autopilot signer. The generic `POST /api/v4/workspaces/:workspaceOwnerNpub/apps` route still requires `canManageWorkspace`, so routine Autopilot reconciliation cannot register a missing/rotated namespace. New install completion also does not currently create/update `workspace_apps`, which allows this drift.

## Required fix

Implement the smallest durable Tower-side correction:

1. On successful `completeInstallIntent`, transactionally ensure the matching `workspace_apps` namespace exists and is enabled for the completed publisher npub. Use the immutable intent/installation data and capabilities appropriate for a Tower-backed WApp (`wapp`, `app-db`). Preserve unrelated namespaces; do not delete the previous publisher row.
2. Repair already-completed managed installations that are missing their current publisher namespace. Prefer a deterministic, idempotent runtime-schema backfill or another normal Tower migration path that runs on deployment. Do not hand-edit production rows as the implementation.
3. Add regression coverage proving install completion/backfill produces the current publisher namespace and remains idempotent.
4. Keep NIP-98 signer boundaries intact. Do not make the Autopilot instance a blanket workspace manager and do not weaken generic workspace app registration authorization.

If live code proves a narrower existing reconciliation seam is better, use it, but the outcome must cover both future completions and existing affected records.

## Architecture and constraints

- Latest architecture artifact is `Wingman_Suite/wingman-suite-arch/v4`; it places shared state and auth in Tower and explicitly models user access plus delegation to agents.
- The local managed-install record is the relevant authority binding; a route ignoring it is a platform defect, not a reason to request the workspace owner's raw key.
- Work directly on `main`.
- Preserve concurrent work; do not discard or overwrite unrelated changes.
- Follow repo semantics: when ready, commit all nonignored tested state unless there is a clear safety reason to pause. Use a Conventional Commit.
- Do not restart the shared Tower runtime. The manager will request/perform the required rebuild after reviewing your patch.

## Validation

- Run the narrowest new/affected tests using the repo's documented environment.
- Report exact test commands and results.
- Provide the commit hash and summarize files changed.
