# Nostr-authorized Git hosting and coordination

**Status:** provider decision updated 2026-08-31; bounded v1 implementation in progress

**Decision scope:** Wingman Tower, Autopilot, Flight Deck, and a new Git service

**Context:** Reusable design for a workspace-authorized Git service.

## Recommendation

**Provider decision (2026-08-31): Forgejo is selected, not Gitea or Walgit.**
The earlier draft treated provider choice as a proof-of-concept decision. The
implementation handoff supersedes that ambiguity. Forgejo remains an
enforcement replica; this choice does not transfer Tower's identity, grants,
policy, capability, or audit authority to provider organizations, teams,
collaborators, tokens, or administrators.

Run Git as a dedicated service, not inside the Tower process. Use a pinned, narrowly configured Forgejo release as the Git object/pack, repository, pull-request, review, and protected-branch data plane. Put a small `wingman-git` authentication gateway in front of it. Tower remains the canonical authority for Nostr identity, workspace membership, actor/group grants, Git policy, approval correlation, and the durable audit projection.

For Git-over-HTTPS, do not try to make stock Git sign each smart-HTTP request with NIP-98. Add a host-scoped `git-credential-wingman` helper. The helper uses the Autopilot session's agent signer to make one NIP-98-authenticated exchange with Tower and receives a repository-scoped opaque credential lasting about five minutes. Git presents that credential as an HTTP Basic password. The gateway validates it with Tower, maps it to an internal shadow Forgejo actor, replaces the upstream credential, and streams the Git request to Forgejo. Agents never receive a GitHub credential or a persistent Forgejo token.

Defer SSH until after HTTPS is proven. Stock SSH cannot carry NIP-98. A later SSH design should exchange NIP-98 authorization for a short-lived OpenSSH user certificate over an ephemeral key, then constrain the SSH endpoint to `git-upload-pack` and `git-receive-pack`. Do not derive an SSH key from a Nostr key or register permanent agent SSH keys in version one.

Standardize branch meanings as follows:

- `main` is the reviewed source-of-truth branch. Feature/work branches merge into `main` through pull requests.
- `staging` is a broker-managed pointer to the exact `main` commit currently selected for staging. Agents cannot push it directly.
- `deployed` is a broker-managed pointer to the exact commit successfully deployed to production. Agents cannot push it directly.

All three branches are protected. Approvals and checks bind to immutable commit IDs, not a moving branch name. Promotion and deploy operations use compare-and-swap against the previously observed ref, are serialized per repository, and re-check policy immediately before mutation.

This recommendation deliberately reuses mature Git protocol and forge behavior while keeping Tower out of pack parsing, repository filesystem mutation, and forge-specific operational failures. A standard `git-http-backend` gateway is the fallback if the proof of concept cannot safely preserve per-actor identity through Forgejo; it is not the preferred starting point because Tower would then need to build pull-request, review, protected-branch, and merge coordination that Forgejo already provides.

## Decision framing

This document uses the following labels:

- **Current fact:** behavior verified in the repositories at the revisions listed below.
- **Assumption:** a condition that must be checked during proof of concept or deployment planning.
- **Proposal:** new behavior; it does not exist merely because it is described here.

No runtime code, deployment configuration, service, branch, or process was changed as part of this investigation.

## Evidence inspected

The code snapshot used for this design was:

| Repository | Revision | Relevant evidence |
| --- | --- | --- |
| Tower | `4f2b5ddc542c8b88697ac7ca67094762fef0135e` | `src/auth.ts`, `src/types.ts`, `src/routes/flightdeck-pg.ts`, `src/services/flightdeck-pg-authorization.ts`, `src/schema/001_init.sql`, `tests/flightdeck-pg-api.test.ts` |
| Autopilot | `85c9876a1f8ac601e7ee338950960aaa9059f265` | `src/forgejo/`, `src/git/`, `src/agents/process-manager.ts`, `src/workrooms/integration-loop.ts`, `clis/workroom-integrator.ts`, `docs/workroom-chat-dispatch.md` |
| Flight Deck | `f8f06ef574934e7ba967e5b1e573d317b63c8e4c` | `src/workrooms.js`, `src/workroom-detail-manager.js`, `src/workroom-creation-manager.js`, `src/approval-helpers.js`, `src/pg-write-adapter.js` |
| Shared architecture | local working tree | `../README.md`, `../ARCHITECTURE.md`, `../design.md` |

The local Git client was `git version 2.50.1 (Apple Git-155)`. The design also checked the official NIP-98 specification, Git's smart-HTTP backend and credential-helper documentation, Forgejo authentication/protected-branch/webhook/backup documentation, and OpenSSH `AuthorizedKeysCommand` documentation. Links appear in [External references](#external-references).

## Current capabilities and gaps

### Tower today

**Current facts:**

- `src/auth.ts` verifies kind `27235` NIP-98 events and resolves a workspace session-key signer to a logical user. `ResolvedAuth` deliberately distinguishes `signerNpub` from `userNpub`.
- The current verifier accepts events within 300 seconds, compares URL origin and normalized pathname, and does not consume event IDs through a replay store. It does not require the query string to match. The proposed Git credential exchange must therefore not reuse these semantics unchanged.
- Typed Flight Deck authorization already resolves actors by npub, workspace membership, recursive effective groups, actor/group permission grants, and workspace/scope/channel resources in `src/services/flightdeck-pg-authorization.ts`.
- Stable Flight Deck PG actor and group UUIDs exist. Git ACLs should use those stable IDs. A rotating crypto `group_npub` is not a durable Git authorization principal.
- Native workrooms already store repository and branch configuration, participants, events, links, app targets, and approval policies. Event types already include `pr_opened`, `pr_ready`, review, approval, merge, and deployment milestones.
- Native typed approvals currently support a commit-bound `production_merge` check. The route rejects a non-approver, uses `row_version` for decision concurrency, and checks repository/target branch/commit metadata before allowing the production action.
- `flightdeck_pg_audit_events` is an append-style workspace audit table, while outbox events support client materialization. The current audit row is intentionally small and is not yet a sufficient Git protocol audit record.
- Tower has no repository registry, Git permissions, credential exchange/introspection, Git webhook ingestion, Git ref state, or Git transport today.

### Autopilot today

**Current facts:**

- Autopilot already integrates with Forgejo. It can create repositories, provision a deterministic Forgejo account for an npub, create an API token with `scopes: ["all"]`, store the username/token in its user settings store, and inject that token into an agent process through a generated shell credential helper.
- The legacy `resolveGiteaCredentials` path falls back to the configured provider administrator token when a per-user credential is unavailable. That is incompatible with least privilege and must not survive into the Tower-authorized path.
- GitHub credentials are also injected through host-scoped credential configuration. The existing approach proves that Git credential helpers fit the agent runtime, but its persistent token-in-environment secret model is not the target design.
- Autopilot has MCP/API operations for Git status, branches, worktrees, push, and local merges. A push guard checks `.gitignore`, selected dangerous tracked paths, and files above 5 MiB. These are useful client-side guardrails, not authoritative server controls.
- Branch conventions have drifted. `src/mcp/tools/git-branch.ts` describes `main` as production and `staging` as pre-deploy, while the newer workroom integration loop defaults to `staging` as integration and `deployed` as production. The proposed model removes that ambiguity.
- `src/workrooms/integration-loop.ts` reads typed workroom state, observes GitHub pull requests/checks, merges passing PRs, checks a commit-specific Tower production approval, and advances a production branch. It is GitHub-specific and requires a GitHub token today.
- Autopilot can sign NIP-98 requests and already has bot/session identities. The new credential broker must sign as the actual agent actor used for the workspace action, not silently substitute the human owner or a machine-wide administrator.

### Flight Deck today

**Current facts:**

- Flight Deck has native workroom list/detail/creation UI, participant readiness, repository/branch display, PR/task/artifact/deployment links, event filtering, and typed production-approval decisions.
- Workroom events and approvals are visible workspace coordination objects, but Flight Deck has no first-class Tower Git repository, pull request, review, ref, or promotion model.
- Current repository values are flexible JSON configuration and links. They are not authoritative authorization or repository identity records.

### Consequence

The suite already has the coordination vocabulary and an experimental Forgejo/GitHub execution layer. Version one should replace broad provider credentials with Tower-mediated capabilities and make the forge integration auditable. It should not create a second workroom system or treat branch names and URLs in workroom JSON as authority.

## Proposed architecture

```text
Agent Git process
  |  asks for HTTPS credentials
  v
git-credential-wingman ---- loopback ----> Autopilot session credential broker
                                                |
                                                | NIP-98 as the agent actor
                                                v
                                      Tower identity/policy API
                                                |
                                  opaque, short-lived capability
                                                |
Agent Git -- HTTPS Basic(capability) --> Wingman Git gateway --> Forgejo
                                                |                 |
                                                |                 +-- bare repositories
                                                |                 +-- PRs/reviews/protection
                                                |                 +-- internal shadow actors
                                                |
                                                +-- Tower introspection
                                                +-- auth/decision telemetry

Forgejo -- signed webhooks --> Wingman Git gateway/outbox --> Tower Git audit/projection
                                                           |
                                                           +--> Flight Deck workrooms/tasks
                                                           +--> Autopilot integration/deploy flow
```

### Component ownership

#### Tower: canonical control plane

**Proposal:** Tower owns:

- logical repositories and their workspace/scope bindings;
- actor/group grants and policy revision numbers;
- branch classes and protection intent;
- credential exchange, introspection, revocation, and replay detection;
- pull-request/workroom/task/approval correlation;
- immutable action and policy-decision audit records;
- projected ref, PR, review, check, promotion, and deployment state received from the Git service;
- OpenAPI and shared contract types.

Tower does not store Git objects, parse packs, execute receive-pack, run repository hooks, or become the Forgejo database.

#### `wingman-git`: enforcement and translation boundary

**Proposal:** create a small service/repository whose responsibilities are:

- terminate the public Git HTTPS hostname or sit directly behind the TLS proxy;
- accept only canonical repository routes;
- validate Tower capabilities and fail closed on policy uncertainty;
- map a Tower actor UUID/npub to a disabled-login shadow Forgejo account;
- replace the client credential with the shadow account's internal Forgejo credential without exposing it to the client;
- proxy streaming smart-HTTP traffic without buffering pack bodies in application memory;
- reconcile Tower repo/team/protection policy into Forgejo;
- provide brokered PR/review/merge/promotion operations;
- verify, deduplicate, and forward signed Forgejo webhooks;
- expose health, readiness, metrics, and an operator reconciliation command.

Long-lived Forgejo administrator and shadow-account tokens are service secrets. They live only in the Git service's secret store, encrypted at rest, never in Tower workspace rows, agent environments, URLs, logs, or Flight Deck.

#### Forgejo: mature Git/forge data plane

**Proposal:** Forgejo owns:

- Git smart-HTTP protocol and bare repository storage;
- ref transaction enforcement and object reachability;
- pull requests, reviews, comments, mergeability, and status checks;
- internal branch protection and per-shadow-actor audit context;
- its internal operational database.

Forgejo policy is an enforcement replica, not the source of truth. Direct public access that bypasses the Wingman Git gateway is prohibited. Forgejo's documented reverse-proxy header authentication may be useful for human web SSO, but it is not assumed to solve Git smart-HTTP authentication. The proof of concept must verify HTTP credential replacement explicitly.

#### Autopilot: agent runtime and credential broker

**Proposal:** Autopilot owns:

- `git-credential-wingman` installation and host/path-scoped Git config;
- binding a credential request to the current session and agent bot identity;
- invoking the Tower exchange without revealing a long-lived forge secret;
- branch/worktree/push and PR CLI/MCP ergonomics;
- validation/check execution in an isolated agent workspace;
- integration and deployment orchestration after Tower/Git-service approval.

The existing Forgejo `scopes: ["all"]` user token injection and administrator fallback are removed from this path. A transition flag can preserve the legacy provider integration temporarily, but it must be visibly separate and disabled for Tower-hosted repositories.

#### Flight Deck: human coordination surface

**Proposal:** Flight Deck owns:

- repository and PR views materialized from typed Tower routes;
- workroom/task/branch/PR/check/review/approval/deployment linking;
- human review and exact-commit promotion/deployment approval UX;
- clear stale-head, conflict, policy-denied, and service-unavailable states.

Flight Deck does not talk to the Forgejo database or administer Forgejo directly.

## Authentication and credential exchange

### Why NIP-98 cannot be the Git wire credential

**Current standard fact:** a NIP-98 event binds a signature to an absolute URL, HTTP method, timestamp, and optionally a request payload hash. Git smart HTTP performs several requests (`info/refs`, `git-upload-pack`, or `git-receive-pack`), and push bodies are streamed pack/protocol data. Stock Git knows HTTP Basic/Bearer-style credentials through its credential subsystem; it does not ask a Nostr signer to build a fresh request-bound Authorization event for every Git HTTP request.

Trying to place one NIP-98 header in `http.extraHeader` would be brittle and unsafe: the URL/method changes across requests, the event expires, a push payload cannot be signed before streaming without custom transport behavior, and Git may retry. The correct boundary is an explicit NIP-98-to-Git-capability exchange.

### HTTPS flow

**Proposal:**

1. The remote is canonical, for example `https://git.example.test/w/<workspace-slug>/<repo-slug>.git`. Tower/Git service resolves it to an immutable repository UUID; filesystem paths are never derived directly from unchecked slugs.
2. Git calls the host-scoped `git-credential-wingman get` helper. Set `credential.useHttpPath=true` for the Git hostname so a credential for one repository is not offered to another.
3. The helper sends the protocol, host, path, Autopilot session ID, and optional workroom/task context to the loopback Autopilot credential broker. It does not accept an arbitrary Tower URL from repository-controlled Git config.
4. Autopilot creates a NIP-98 POST as the session's agent actor to a fixed Tower route such as `POST /api/v4/git/credential-exchanges`. The body contains `repository_id`, `audience`, session/instance IDs, and optional `workroom_id`/`task_id`. It does not guess upload-pack versus receive-pack. The payload hash is mandatory.
5. The exchange route applies stricter verification than Tower's general current verifier:
   - exact scheme, host, path, and query match;
   - at most 60 seconds of clock skew/age;
   - event ID consumed once for credential exchange;
   - mandatory payload hash;
   - authenticated signer and logical actor both recorded;
   - explicit agent identity; no implicit owner delegation.
6. Tower resolves the actor's effective stable group IDs and repository grants and derives every currently authorized transport scope. It returns a random 256-bit opaque capability and expiry. Tower stores only a keyed hash of the capability plus its repository, actor, policy revision, scopes, ref constraints, context IDs, issue/expiry times, and revocation state. The gateway determines the actual smart-HTTP service and supplies its required scope to introspection.
7. The helper returns a fixed username (for example `nostr`) and the capability as Git's password. It ignores `store`; `erase` clears only any in-memory entry. It never writes the capability to disk or emits it in diagnostics.
8. Git sends HTTP Basic over TLS. The gateway hashes and introspects the capability, verifies audience/repository/path/expiry/policy revision, and maps the actor to an internal Forgejo shadow identity.
9. The gateway replaces Authorization with that shadow actor's internal credential and streams to Forgejo. Forgejo remains the final ref-transaction and branch-protection enforcer.
10. Gateway authentication and decision telemetry plus signed Forgejo webhooks produce the durable Tower audit projection.

The capability may be reused for the multiple HTTP requests in one Git operation, so it cannot be a globally single-use password. Replay risk is bounded with TLS, an approximately five-minute lifetime, repository/audience/action scope, no persistent storage, revocation, and per-token concurrency/rate limits. Administrative, merge, approval, and deployment operations are never included in a Git transport capability.

**Assumption to prove:** the chosen Git version and helper protocol propagate expiry usefully. Correctness must not depend on client-side expiry metadata; the gateway is authoritative.

### Capability scopes

Recommended transport scopes are deliberately coarse enough for smart HTTP and narrower than repository administration:

- `git.fetch`
- `git.push.unprotected`
- `git.push.branch_create`
- `git.push.branch_delete` only when explicitly granted

The gateway can authorize the service (`upload-pack` versus `receive-pack`) before streaming. The exact refs affected by receive-pack are authoritatively enforced by Forgejo branch rules and captured by the resulting push webhook. Direct transport credentials never grant `git.pr.merge`, `git.repo.admin`, `git.promote.staging`, or `git.deploy.production`.

### Human web and API authentication

**Proposal:** API/CLI coordination calls use ordinary request-bound NIP-98 directly because they are normal JSON requests. For human Forgejo web access, either:

- keep the Forgejo web UI internal and surface review/approval in Flight Deck; or
- add a separate browser SSO gateway that verifies a Tower/Nostr browser session and supplies Forgejo's trusted reverse-proxy user header.

If reverse-proxy authentication is enabled, Forgejo must be reachable only from the trusted proxy network, trusted-proxy ranges must be explicit, client-supplied identity headers must be stripped, and API CSRF protections must remain owned by the gateway as required by Forgejo's documentation. This web path does not replace the smart-HTTP capability flow.

### SSH flow (post-v1)

**Proposal, phase two:**

1. A Wingman helper generates an ephemeral Ed25519 SSH keypair for a session. It does not reuse or derive from the secp256k1 Nostr secret.
2. The agent signs a NIP-98 certificate request through Autopilot. Tower authorizes the actor/repository/session and records the request.
3. A Git-service SSH certificate authority issues a user certificate lasting roughly 5–15 minutes with an actor/session principal and restrictive critical options.
4. Git uses an explicit host entry plus ephemeral identity/certificate, preferably through an ssh-agent or protected temporary directory.
5. A dedicated SSH front end accepts only the `git` account, no PTY, no shell, no forwarding, no tunnelling, no agent forwarding, and no arbitrary subsystem. Its forced command parser permits only `git-upload-pack '<canonical repo>'` and `git-receive-pack '<canonical repo>'` after Tower/Gateway authorization.
6. The SSH certificate serial and fingerprint are included in every audit event. Expiry and Tower revocation deny later connections.

OpenSSH `AuthorizedKeysCommand` plus forced-command entries are a possible implementation, but short-lived certificates avoid syncing permanent authorized keys to every Git node. Forgejo's built-in SSH may be used only if the proof of concept shows equivalent Tower authorization, revocation, forced-command restriction, and actor attribution. SSH remains explicitly outside v1.

## Authorization model

### Principals and resources

**Proposal:** extend Tower's typed actor/group grant model with Git resources rather than overloading `channel.write` or flexible workroom participant metadata.

Principals:

- workspace actor UUID, whose canonical Nostr identity is an npub;
- stable Flight Deck PG group UUID;
- tightly limited Git service actor for reconciliation and webhook ingestion.

Resources:

- workspace Git namespace;
- repository UUID;
- branch class or exact branch rule;
- pull request UUID/provider ID;
- promotion/deployment target.

Suggested permissions:

| Permission | Meaning |
| --- | --- |
| `git.repo.read` | Clone/fetch and see repository/PR metadata |
| `git.repo.create` | Create a private repository in the workspace namespace |
| `git.repo.write` | Push ordinary work branches and update own PR head |
| `git.branch.create` | Create allowed work branches |
| `git.branch.delete` | Delete allowed merged/abandoned work branches |
| `git.pr.open` | Open/update/close a PR from an authorized head |
| `git.pr.review` | Submit a review; self-review does not satisfy required approval |
| `git.pr.merge` | Ask the broker to merge after policy re-evaluation |
| `git.promote.staging` | Move `staging` to an approved exact `main` commit |
| `git.deploy.approve` | Approve an exact commit/target deployment |
| `git.deploy.execute` | Invoke the deployment broker after approval |
| `git.repo.admin` | Manage repo metadata, grants, quotas, and protection intent |

`workspace.manage` may bootstrap or recover Git administration, but it should not automatically become a day-to-day direct-push bypass. Emergency override is a distinct, time-bound action with step-up authorization and a mandatory reason.

### Default role mapping

| Workspace/workroom role | Default Git capability |
| --- | --- |
| Observer/reader | `git.repo.read` |
| Contributor agent/person | Read, create/update permitted work branches, open/update own PRs |
| Reviewer group/workroom reviewer | Contributor rights plus review |
| Integration actor/group | Merge eligible PRs into `main`; promote to staging if separately granted |
| Human approver | Approve the exact production commit; no implied push or deploy execution |
| Deployment actor/group | Execute an already-approved deployment; no implied approval |
| Repository administrator | Repository policy/grant management; protected-branch bypass still disabled |

Workroom participant roles can propose a default grant, but an active repository grant is authoritative. Removing an actor from the workspace, revoking its group membership, or revoking the repository grant increments the policy revision and invalidates new/introspected credentials.

### Forgejo policy replication

**Proposal:** each Tower workspace maps to a Forgejo organization; Tower groups map to Forgejo teams only as an enforcement replica. Each Nostr actor maps to a non-password-login shadow user. The Git service reconciliation worker applies repository collaborators/teams, branch protections, required reviews/checks, and service-only merge/promotion authority.

Safety rules:

- a policy sync that would broaden access requires the Tower policy revision that authorized it;
- unknown or stale mapping fails closed at the gateway;
- drift detection reports extra Forgejo admins, collaborators, tokens, deploy keys, public repos, and weaker branch rules;
- reconciliation removes unauthorized state and emits an audit alert;
- no human or agent receives the internal shadow token.

## Repository and branch workflow

### Repository lifecycle

**Proposal:** repositories are private by default and created only through a Tower-authorized broker operation. The Tower record is created first in `provisioning`; the Git service creates the Forgejo repo and applies policy; Tower moves the record to `active` only after reconciliation succeeds. Partial creation remains visible and retryable. Deletion is a two-step archive/retention workflow, never an immediate API side effect.

A repository binds to exactly one Tower workspace. It may additionally bind to a scope, channel, workroom, and one or more tasks for discovery and audit correlation. Visibility never crosses the workspace simply because two repositories have similar names or remotes.

### Branch naming and ownership

Recommended work branches are `work/<actor-alias>/<task-or-workroom>-<slug>` or `feature/<slug>`. The authoritative linkage is the Tower-created branch/PR metadata, not parsing the name. Branch names remain useful for humans but cannot grant access.

- Contributors can create and push only unprotected work branches allowed by policy.
- A contributor can update another actor's branch only through an explicit shared-work grant.
- Force push is disabled by default, including work branches. If enabled for a work branch, it is explicit, audited, and automatically invalidates old approvals.
- Branch deletion is allowed only for unprotected work branches after merge/closure or explicit abandonment.
- Tags are protected separately; release-tag creation is brokered and out of v1 unless needed by the PoC.

### `main`, `staging`, and `deployed`

| Branch | Meaning | Mutation rule |
| --- | --- | --- |
| `main` | Canonical reviewed source | PR merge only; passing required checks; current head comparison; required independent review; no force push/delete |
| `staging` | Exact candidate currently selected for staging | Git service promotion only; target SHA must be reachable from `main`; compare-and-swap; staging checks recorded against that SHA |
| `deployed` | Exact commit successfully deployed in production | Deployment broker only after exact-commit human approval and successful deploy/smoke result; no direct push/delete |

This model intentionally treats `staging` and `deployed` as environment pointers, not places where agents integrate arbitrary commits. It conflicts with some current Autopilot wording and therefore requires a coordinated migration. Existing repos are inventoried rather than rewritten automatically.

Rollback should normally create a revert on `main`, promote it, deploy it, and advance `deployed`. An emergency redeploy of a previously known commit is permitted only through a separate rollback approval/action. If `deployed` must move backwards, the broker performs the non-fast-forward update with step-up authorization, a recorded reason, expected old SHA, and an audit alert; general force-push permission remains disabled.

### Pull requests, reviews, and merges

**Proposal:** Forgejo provides the operational PR, diff, review, and mergeability engine. Tower stores the stable repository/PR correlation and workspace projection. A PR opened through Autopilot or Flight Deck includes repository UUID, head/base refs, current head SHA, actor, optional workroom/task IDs, and validation evidence.

Rules:

- same-repository branch PRs only in v1; no forks;
- PR base is `main` for feature work;
- author cannot satisfy an independent-review requirement;
- approvals bind to the reviewed head SHA;
- new commits dismiss or make old approvals non-counting;
- unresolved change requests, merge conflicts, missing checks, stale base, or changed policy block merge;
- the merge API takes `expected_head_sha` and `expected_base_sha` and re-evaluates immediately before mutation;
- merge method is repository policy (recommend squash for small agent branches, or merge commits where history preservation is required);
- a successful Forgejo merge webhook is the ref-change fact; Tower records the decision and resulting SHA idempotently.

### Concurrency and conflict behavior

Git's receive-pack ref transaction rejects non-fast-forward races. The coordination layer adds:

- optimistic row/policy versions on Tower commands;
- compare-and-swap old/new SHAs on merge, promotion, deployment-pointer, and rollback operations;
- a per-repository/base-branch merge queue or advisory lock in the Git service;
- re-fetch and re-evaluation after lock acquisition;
- idempotency keys on create/merge/promote/deploy commands;
- no automatic conflict resolution by the service;
- conflict output returned to the agent and linked to its workroom/task;
- isolated Autopilot worktrees so concurrent agents never share an index or working tree.

If two PRs are mergeable against the same old `main`, the first merge wins. The second returns stale/conflicting state, refreshes checks against the new base, and requires an agent update or a new merge evaluation. An approval for head SHA A never approves rewritten head SHA B.

## Audit and Flight Deck coordination

### Authoritative audit record

**Proposal:** introduce a Git-specific append-only event model rather than placing all details in the current small `flightdeck_pg_audit_events.metadata` field. Each event should include, where applicable:

- event UUID, source, source delivery ID, source timestamp, received timestamp;
- workspace, repository, scope/channel, workroom, task, approval, and PR IDs;
- actor UUID/npub, authenticated signer npub, actor kind;
- Autopilot instance npub, session ID, agent definition/profile ID, and initiating human if explicitly delegated;
- operation and policy decision (`allow`/`deny`, permission, matched grant, policy revision);
- transport, token ID hash prefix or SSH certificate serial/fingerprint, remote IP, user agent, correlation ID;
- ref name, old SHA, new SHA, create/delete/force flags, and bytes where available;
- PR base/head and exact reviewed/merged SHA;
- check names/results and merge method;
- promotion/deployment target, approval ID, deployment run/version, health result;
- normalized outcome/error category, without secrets or raw Authorization headers.

The raw signed webhook envelope may be retained in restricted operational storage for a bounded period. The workspace-visible projection contains normalized non-secret fields.

### Event flow and trust

1. Gateway records authentication and Tower policy decisions with a correlation ID.
2. Forgejo applies the actual Git operation and emits an HMAC-signed webhook.
3. The Git service verifies the HMAC, delivery ID, event type, repository mapping, size, and timestamp; it deduplicates durably.
4. Tower appends the normalized Git event and updates its projection transactionally with an outbox event.
5. Flight Deck materializes the event into repository/PR views and the linked workroom timeline.

Client-provided `task_id`, `workroom_id`, or `approval_id` is never trusted on its own. Tower verifies that each object is visible in the same workspace and authorized context. Branch-name conventions and commit trailers may help recovery, but they are not authorization or audit identity.

Recommended workroom events include branch created/pushed, PR opened/updated/ready, review requested/decided, merge queued/started/completed/failed, staging promoted, deploy approval requested/decided/superseded, deploy started/completed/failed, rollback requested/completed, and policy drift detected.

## Threat model and controls

### Protected assets

- private Git objects and history, including unreachable-but-not-yet-pruned objects;
- branch/ref integrity and protected environment pointers;
- Tower actor/group policy and human approvals;
- Nostr agent/user secrets;
- short-lived Git capabilities;
- internal Forgejo administrator/shadow tokens and webhook secrets;
- audit completeness and actor attribution;
- availability of Tower, Git service, repositories, and backups.

### Principal threats and mitigations

| Threat | Required controls |
| --- | --- |
| Stolen/replayed NIP-98 exchange | Exact URL including query, mandatory payload hash, 60-second window, one-time event ID, clock monitoring, signer/actor recording |
| Stolen Git capability | TLS only, random opaque value, ~5-minute expiry, repo/audience/action scope, hashed storage, no disk/env/log persistence, revocation and rate/concurrency limits |
| Confused deputy/cross-repo use | Immutable repo UUID in token, canonical path resolution, `credential.useHttpPath=true`, gateway audience/path check, no unchecked filesystem joins |
| Agent impersonates human/owner | Agent bot npub is the actor; explicit delegation only; record signer, actor, session, and initiating human separately |
| Broad internal token compromise | Tokens only inside Git service secret storage; per-shadow-user token; least Forgejo permissions; rotation; no admin fallback; alert on use outside gateway |
| Gateway/header bypass | Forgejo on private network, firewall/allowlist gateway only, strip client identity headers, mutual service auth where practical |
| Direct protected-ref change | Forgejo protected branches/tags, service-only merge/promotion identity, no admin bypass, drift reconciliation, webhook verification |
| Approval race or stale review | Approval bound to exact head/target SHA; stale approvals dismissed; expected old SHA; policy version; serialized re-check immediately before mutation |
| Malicious repository path/ref | Canonical UUID lookup, Git ref-format validation, argv arrays only, no shell interpolation, fixed service commands |
| Server-side code execution | Disable user Git hooks, Actions/runners, external renderers, arbitrary webhooks, and custom merge drivers in v1; run Forgejo/gateway unprivileged with read-only image/root FS where possible |
| Malicious checked-out code | Never run tests/builds on the Git host; Autopilot executes in a separately constrained workspace with explicit secret and network policy |
| Pack/object denial of service | Per-workspace/repo quotas, max request/body/object/ref counts, streaming backpressure, timeouts, process/cgroup limits, concurrent-operation limits, `git fsck`, disk/inode alerts, rate limits |
| Repository data leak | Private by default, anonymous Git disabled, disable dumb HTTP/getanyfile, gateway authorization for fetch and push, workspace isolation tests |
| Webhook spoof/replay | HMAC secret, delivery ID dedupe, timestamp/size/type checks, repository mapping, restricted endpoint |
| Audit loss | Durable gateway delivery outbox, idempotent Tower ingest, lag alerts, reconciliation against Forgejo refs/PR API |
| Backup corruption/ransomware | Encrypted off-host immutable copies, checksums, retention, tested restore, least-privilege backup identity |

Forgejo's required internal hooks implement protection and bookkeeping. The prohibition is on user-supplied/custom executable hooks. Hook directories and repository storage are not writable by agents or repository content. Git protocol subprocesses receive a minimal environment and resource limits.

Commit signatures may be useful evidence but do not replace transport actor attribution: Git author/committer fields are self-asserted and a valid commit signature does not prove who pushed or approved it. Requiring signed commits is a later policy decision.

## Deployment and operations

### Version-one topology

**Proposal:** one Git plane per Tower deployment, potentially co-located on the same machine in development but separated into services and persistent volumes:

- TLS edge/reverse proxy;
- `wingman-git` HTTP gateway and reconciliation/webhook worker;
- pinned Forgejo container with public ingress disabled except through the gateway;
- dedicated Forgejo PostgreSQL database/schema and repository/LFS data volumes;
- Tower reached over authenticated internal HTTPS APIs, not by sharing its database credentials;
- optional Redis only if later required for rate limits/queues; avoid it in the smallest v1.

Forgejo and `wingman-git` are not added to Tower's process or failure domain. Tower must remain usable for chat/tasks/docs when Git is unavailable. A single Forgejo instance with one organization per workspace is acceptable for the initial trusted-small-scale deployment, subject to isolation tests and quotas. Highly sensitive or high-volume tenants may later require a separate Git plane.

### Failure boundaries

| Failure | Behavior |
| --- | --- |
| Tower unavailable | Deny new credentials and all admin/merge/promotion/deploy actions. Existing capabilities expire within minutes. Prefer fail-closed pushes; an explicitly documented cached-read grace period may be considered later. |
| Gateway unavailable | Git transport and brokered forge operations stop; Tower and Flight Deck non-Git work continue. |
| Forgejo unavailable | Git/PR operations stop; Tower retains coordination and last projected state, visibly marked stale. |
| Webhook delivery unavailable | Forgejo operation may succeed; durable retry plus reconciliation repairs Tower projection. Never claim merge/deploy completion from intent alone. |
| Policy reconciliation stale | Deny capability use or mutations that could broaden access; reads may follow a bounded last-known-good policy only if explicitly designed and measured. |
| Autopilot unavailable | Direct authorized Git clients may still operate; agent CLI, validation, and deploy orchestration stop. |
| Flight Deck unavailable | API/CLI operations continue; human approvals requiring Flight Deck can be performed only through another explicitly authorized NIP-98 client. |

### Persistence, backup, and restore

Forgejo state spans its database, repository directories, configuration/secrets, attachments, and optional LFS. Tower separately stores policy, correlation, approval, and audit projections. Backup must treat these as related but independently recoverable systems.

**Proposal:**

- PostgreSQL point-in-time recovery plus encrypted snapshots/backups for Forgejo and Tower;
- filesystem or volume snapshots for repositories, coordinated with the Forgejo database;
- periodic `git fsck --strict` sampling and object/ref inventory manifests;
- encrypted off-host immutable retention with documented RPO/RTO;
- no LFS in v1, reducing the first restore surface;
- quarterly restore drill into an isolated network: restore Forgejo DB/repos/config, regenerate Forgejo internal hooks if paths changed, reconcile Tower policy, verify refs/PRs/protections, synthetic clone, rejected unauthorized push, accepted authorized push, and audit delivery;
- Tower projection rebuild from Forgejo plus retained gateway deliveries where possible; approvals/audit in Tower remain separately backed up and are not reconstructed solely from mutable forge data.

Forgejo's official documentation notes that a fully consistent `forgejo dump` requires downtime and that restore is a manual procedure; native database tools or coordinated storage snapshots may be preferable. The operational runbook must choose and test one method rather than assuming a copied repository directory is a complete backup.

### Upgrades and rollback

- Pin exact Forgejo and gateway image digests.
- Review upstream security advisories and release notes; rehearse upgrades against a restored copy.
- Back up database, repositories, configuration, and secrets before upgrade.
- Run contract, auth, branch-protection, PR, webhook, clone/push, and restore smoke tests.
- Use a maintenance/read-only window for schema-changing upgrades.
- Roll forward by default. Forgejo documentation warns that database migrations may make binary downgrade unsafe; rollback means restoring the pre-upgrade database and repository/config snapshot as a unit.
- Deploy gateway revisions independently with backward-compatible Tower/Forgejo contracts and a fast image rollback.
- Tower contract changes land before consumers and preserve compatibility during the rollout window.

### Observability

At minimum collect:

- gateway request counts/latency/status by service and repo UUID (not token or repo content);
- credential exchange allow/deny/expiry/replay counts;
- Tower introspection latency/error/cache state;
- active smart-HTTP operations, bytes, duration, cancellations, rate/size/quota rejections;
- Forgejo health, DB pool, Git subprocess duration/failure, repository volume bytes/inodes;
- webhook accepted/rejected/retried/dead-letter counts and oldest delivery lag;
- policy reconciliation drift and age;
- PR merge queue depth/wait/failure;
- backup age/result, restore-drill age, `fsck` failures;
- synthetic private clone and protected-push probes.

Structured logs use correlation IDs and actor/repo UUIDs but redact Authorization, cookies, internal tokens, Nostr events where signatures or full content are unnecessary, remote URLs containing credentials, and repository content. Alerts cover disk/inodes, repeated auth denials/replays, drift, webhook lag, backup failure, and protected-ref anomalies.

## Smallest safe version one

### In scope

- One private, single-node Forgejo Git plane behind `wingman-git`.
- Git-over-HTTPS clone/fetch/push only.
- Tower repository registry and explicit actor/group Git grants.
- NIP-98 credential exchange, opaque ~5-minute capability, introspection/revocation, and host/path-scoped Autopilot credential helper.
- Existing Nostr agent actor identity preserved into a shadow Forgejo actor.
- Same-repository work branches and PRs into protected `main`.
- Required review/check policy sufficient for a pilot repository.
- Service-only `staging` promotion and `deployed` update bound to exact SHAs and Tower approval.
- Workroom/task/approval correlation and normalized push/PR/review/merge/promotion/deployment audit.
- Quotas, rate/concurrency limits, user hooks/Actions disabled, backup and one successful restore drill.
- One pilot repository with no production deployment authority until the acceptance suite passes.

### Explicit non-goals

- Implementing Git pack/object/wire protocols in Tower or `wingman-git`.
- SSH transport, permanent agent SSH keys, or Nostr-key-to-SSH derivation.
- Public/anonymous repositories.
- Fork-based contribution and cross-workspace pull requests.
- Git LFS, packages, releases, wikis, Pages, Actions/hosted CI runners, arbitrary hooks, or repository-supplied server execution.
- NIP-34/NGit relay-native repository coordination or decentralized forge federation.
- GitHub credential brokering, bidirectional GitHub mirroring, or replacing external upstreams.
- Commit-signature enforcement as identity proof.
- Multi-node Forgejo HA or active-active repository storage.
- Automatic semantic conflict resolution or automatic production approval.
- Giving agents Forgejo administrator/API tokens or direct database/filesystem access.

## Data and API outline

Names are illustrative and should be finalized in a Tower contract ADR.

### Tower records

- `git_repositories`: UUID, workspace/scope binding, slug, default branch, state, provider mapping, quotas, policy revision.
- `git_repository_grants`: actor/group principal, permission, optional branch rule, creator/revocation timestamps.
- `git_branch_policies`: protected pattern/class, direct/force/delete rules, required approvals/checks, merge methods, service-only actor.
- `git_credential_exchanges`: hashed token ID, actor/signer, repo, scopes, context, issued/expiry/revoked/last-seen fields. Short retention.
- `git_pull_requests`: stable Tower UUID, Forgejo ID/number, base/head, head/base/merge SHAs, state, author, workroom/task correlation, projection version.
- `git_reviews` and `git_check_runs`: normalized projection tied to exact head SHA.
- `git_promotions` and `git_deployments`: expected old SHA, target SHA, approval, actor, outcome.
- `git_audit_events` and `git_webhook_deliveries`: immutable normalized events and durable idempotency/delivery state.

Secret material is not stored in these workspace-facing tables.

### Tower routes

- repository CRUD/archive/grants/policy under `/api/v4/git/workspaces/:workspaceId/...`;
- NIP-98 `POST /api/v4/git/credential-exchanges`;
- internal authenticated capability introspection/revoke endpoints;
- PR read/open/review/merge commands;
- staging promotion, production approval, deployment result, and rollback commands;
- signed webhook/delivery ingestion restricted to the Git service;
- audit/event list filtered by repository and workspace visibility.

Every public route requires types in `src/types.ts`, OpenAPI in `src/openapi.ts`, and contract/authorization tests. Git permissions require extending the current permission/resource model; do not squeeze repository authority into channel grants.

## Sequenced work packages

### WP0 — Architecture decision and isolated proof of concept

**Owner:** new Git service lead with Tower review

**Repositories:** design/PoC only, no production wiring

- Pin a candidate Forgejo version and document its license/support/security policy.
- Prove streaming Basic credential replacement to a per-actor Forgejo shadow account for clone and push.
- Prove private Forgejo network reachability only through the gateway.
- Prove protected branches, required review/checks, webhook signatures/deduplication, and actor attribution.
- Measure pack/request limits and restore a sample repo/PR database.
- Decision gate: use Forgejo gateway if all security invariants pass; otherwise test `git-http-backend` and explicitly cost the missing PR/review layer before proceeding.

### WP1 — Tower Git authority contract

**Owner:** Tower

- Add Git permission/resource types, repository/policy/grant schema, runtime migrations, services, routes, types, OpenAPI, audit/outbox, and tests.
- Add strict one-time NIP-98 exchange verification and opaque capability lifecycle.
- Add internal service authentication for introspection and webhook ingestion.
- Add workroom/task/approval correlation with exact-SHA supersession rules.
- Keep current workspace/session-key signer versus actor semantics explicit.

### WP2 — Dedicated `wingman-git` service and Forgejo hardening

**Owner:** new service

- Implement gateway, capability introspection, streaming proxy, shadow identity/token vault, canonical route mapping, rate/quota controls, webhook outbox, and reconciliation.
- Configure private Forgejo ingress, org/repo/team creation, branch/tag protection, user hooks/Actions/unused units disabled, unprivileged execution, persistent DB/repo volumes, secrets, health/metrics.
- Implement brokered PR/review/merge and service-only staging/deployed mutations.
- Write backup, restore, rotation, reconciliation, incident, and upgrade runbooks.

### WP3 — Autopilot agent access

**Owner:** Autopilot

- Replace Tower-hosted-repo Forgejo/GitHub token injection with `git-credential-wingman` and a session-bound agent signer broker.
- Ensure tokens are host/path scoped, memory-only, redacted, non-interactive, and refreshed safely.
- Add repository/branch/PR/review/merge/status commands backed by Tower/Git service rather than provider-specific GitHub code.
- Carry workspace/repo/workroom/task/session/agent context explicitly.
- Align branch tooling and documentation to `main`/`staging`/`deployed` meanings.
- Preserve local worktree concurrency and client push guard as defense in depth.

### WP4 — Flight Deck coordination UI

**Owner:** Flight Deck

- Materialize typed repositories, grants, PRs, reviews, checks, refs, audit events, promotions, and deployments.
- Add workroom/task links and exact commit/check evidence.
- Add review, approval, stale-head/conflict, merge queue, promotion, deploy, rollback, and service-health states.
- Make policy/permission denials explainable without exposing secrets or hidden repository data.
- Retire flexible provider JSON as authority while retaining migration/display compatibility.

### WP5 — Promotion and deployment integration

**Owner:** Autopilot with Tower and Git service

- Replace GitHub-specific workroom integration with a provider-neutral Tower/Git-service client.
- Promote exact `main` SHA to `staging`, run/record validation, request exact-commit production approval, deploy, smoke test, then update `deployed`.
- Add idempotency, locks, stale-approval supersession, failure recovery, and explicit emergency rollback.

### WP6 — Operational readiness and pilot

**Owner:** platform operations; all repositories participate

- Complete threat-model review, load/DoS tests, secret rotation, backup/restore drill, upgrade rehearsal, alerts, dashboards, and incident runbook.
- Migrate one non-critical private repository without changing its external origin automatically.
- Run acceptance tests, observe a pilot period, and require explicit production-readiness approval before adding production deployment authority.

Dependencies are ordered: WP0 gate, Tower contract, Git enforcement plane, agent/UI clients, deploy integration, then pilot. Tower schema/API changes lead cross-repository consumers.

## Acceptance tests

### Identity and credential tests

- A workspace agent with `git.repo.read` can clone through stock Git without a GitHub/Forgejo credential.
- The Forgejo/internal token never appears in the agent environment, helper output, process arguments, logs, or Tower rows.
- A NIP-98 exchange with wrong method, exact URL/query, payload hash, signer, stale timestamp, or replayed event ID is rejected.
- A capability used for the wrong host, repo path, service, or after expiry/revocation is rejected.
- Removing actor/group access invalidates new credentials immediately and existing credentials no later than the stated bound.
- A workspace session key records signer and resolved logical actor correctly; an agent is never silently attributed to a human owner.
- Two repositories on the same host do not share credentials through Git's credential matching.

### Repository isolation and authorization tests

- Actors from workspace A cannot discover, fetch, push, open PRs, or infer existence/size/ref names in workspace B.
- Reader, contributor, reviewer, integrator, approver, deployer, and admin permission matrices allow only documented operations.
- Forgejo drift that adds a collaborator/admin or weakens protection is detected; gateway use fails closed until reconciled where access could broaden.
- Anonymous smart HTTP, dumb HTTP, direct Forgejo ingress, and unused service endpoints are unavailable.

### Git/ref/PR tests

- Authorized work-branch create/push succeeds and records actor, old/new SHA, context, and bytes/outcome.
- Non-fast-forward, force, deletion, invalid ref, oversized object/pack, quota, and forbidden protected-ref pushes fail with safe actionable errors.
- Direct pushes to `main`, `staging`, and `deployed` fail for agents, humans, and Forgejo administrators through public paths.
- A PR cannot merge when draft, conflicting, behind policy, missing checks, rejected, unreviewed, self-approved only, or changed after approval.
- A merge with stale expected head/base SHA loses the race safely and does not mutate the ref.
- Two simultaneous eligible merges serialize; the second re-evaluates against the new base.
- Successful merge/promotion/deploy events arrive once in Tower despite duplicate/out-of-order webhook delivery.

### Branch promotion and deployment tests

- `staging` advances only to a commit reachable from `main` and only with expected-old-SHA comparison.
- Production approval is bound to repository, target, exact SHA, policy version, and approver; a new candidate supersedes it.
- `deployed` updates only after successful deploy and smoke result; failed deploy leaves the prior pointer and records failure.
- Emergency rollback requires the dedicated approval/action and records the backward ref move and reason.

### Security and availability tests

- User-controlled hooks, Actions/runners, shell/PTY/forwarding, arbitrary Git service commands, and path traversal cannot execute.
- Malformed protocol and slow/large/concurrent requests remain within configured CPU/memory/time/disk limits.
- Tower, gateway, Forgejo, webhook, and Autopilot failures produce the documented fail-closed/stale states without corrupting refs.
- Logs and traces pass an automated secret/redaction scan.
- Backup restore recreates repositories, refs, PR/review metadata, protections, Tower mappings, and audit flow; synthetic clone/push/protected-push tests pass.
- Upgrade rehearsal can either complete or restore the entire pre-upgrade state within the agreed RTO.

### User workflow tests

- An agent creates a task-linked branch, pushes, opens a PR, reports checks, receives review feedback, updates the same PR, and merges without provider credentials.
- Flight Deck shows the correct agent identity, task/workroom link, exact head SHA, reviews/checks, merge result, staging promotion, approval, deployment, and final `deployed` SHA.
- A human can distinguish requested intent, policy approval, actual Git mutation, and actual deployment completion.

## Proof-of-concept plan

The PoC is isolated and non-production. It does not modify current Tower, Autopilot, Flight Deck, deployed branches, or running services.

1. **Data plane:** start a disposable pinned Forgejo and PostgreSQL with private networking, Actions/LFS/packages/user hooks disabled, two orgs, two repos, three shadow users, and protected `main`/`staging`/`deployed`.
2. **Gateway spike:** implement streaming smart-HTTP reverse proxying that accepts a fake opaque capability, validates repo/action, replaces Basic auth with a per-shadow-user token, and strips untrusted identity headers.
3. **Credential helper spike:** implement a temporary host/path-scoped helper that obtains a five-minute credential from a mock exchange. Exercise stock `git clone`, `fetch`, branch push, retry, expiry, erase, and parallel operations.
4. **Policy tests:** prove cross-org isolation, direct protected-ref rejection, review/check/stale-head rules, admin-bypass disabled, and drift detection.
5. **Coordination tests:** create/update/review/merge a PR through Forgejo APIs; send HMAC webhooks through a durable dedupe receiver; correlate to mock workroom/task/approval IDs and exact SHAs.
6. **Adversarial tests:** wrong-repo token, replay/expiry, header spoof, path/ref injection, malformed/oversized/slow pack request, quota, concurrency, and gateway/Tower/Forgejo interruption.
7. **Operations:** take the selected consistent backup, destroy the disposable instance, restore it, regenerate internal hooks if required, reconcile policy, and repeat clone/push/PR/protection/audit checks.
8. **Decision report:** record Forgejo version/config, protocol traces with secrets removed, resource measurements, security invariants, failures, restore timing, known gaps, and whether to proceed to WP1.

Go criteria:

- client sees no persistent forge secret;
- Forgejo attributes push/PR activity to the correct shadow actor;
- protected refs cannot be changed outside the brokered path;
- private ingress cannot bypass the gateway;
- streaming proxy stays bounded under the test limits;
- webhook/audit reconciliation is complete and idempotent;
- backup/restore succeeds;
- no Forgejo patch is required unless it is small, maintainable, and explicitly accepted.

If actor-preserving credential replacement or protected-branch control fails, stop. The fallback investigation uses `git-http-backend` for transport and estimates the cost of building Tower-native PR/review/merge coordination before any implementation commitment.

## Open decisions

1. Pin an exact supported Forgejo image digest after the isolated fixture validates the target release. Forgejo itself is already the provider decision.
2. Confirm the five-minute capability and 60-second exchange windows against large-clone/push behavior and clock conditions.
3. Decide whether v1 human diff/review uses a tightly proxied Forgejo web UI or a Flight Deck-native view. The authorization source remains Tower either way.
4. Approve the proposed branch meanings and a per-repository migration plan for current conflicting conventions.
5. Set repository/object/pack/ref/concurrency quotas and retention/pruning policy.
6. Set production RPO/RTO, backup tooling, immutable retention, and restore-drill frequency.
7. Choose the service-to-service authentication mechanism and internal token vault/rotation implementation.
8. Decide required review/check defaults, merge method, and whether signed commits become an optional later rule.
9. Decide whether the first pilot needs a read-only external GitHub mirror. Bidirectional mirroring remains out of scope.
10. Define emergency-access custodians and step-up Nostr signing/approval requirements.

None of these decisions changes the principal recommendation: keep the Git data plane separate, use a mature forge, and translate Nostr identity into short-lived, scoped transport authority at a narrow gateway.

## External references

- [NIP-98 HTTP Auth](https://github.com/nostr-protocol/nips/blob/master/98.md) defines request-bound kind `27235` authorization events and recommends a short timestamp window.
- [Git credential documentation](https://git-scm.com/docs/gitcredentials.html) documents host/path credential contexts and custom credential-generating helpers.
- [`git-http-backend`](https://git-scm.com/docs/git-http-backend) is Git's standard smart-HTTP server implementation and documents authenticated `receive-pack`, repository export controls, protocol buffering, and CGI boundaries.
- [Forgejo reverse proxy](https://forgejo.org/docs/latest/admin/setup/reverse-proxy/) documents trusted reverse-proxy header authentication and the required private/trusted proxy boundary.
- [Forgejo configuration](https://forgejo.org/docs/latest/admin/config-cheat-sheet/) documents internal/basic login controls, reverse-proxy trust, private repositories, hooks, and smart-HTTP-related settings.
- [Forgejo user documentation](https://forgejo.org/docs/latest/user/) links the provider's current branch protection, pull request, webhook, API, and repository guidance.
- [OpenSSH `sshd_config`](https://man.openbsd.org/sshd_config) documents `AuthorizedKeysCommand` and its ownership/dedicated-user requirements.
