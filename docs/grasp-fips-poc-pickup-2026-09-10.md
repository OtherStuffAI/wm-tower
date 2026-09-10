# GRASP PoC implementation pickup after verified routing supplied

Prior worker completed only intake due missing auto-inherited Flight Deck routing. Manager verified these exact routing values from live flightdeck_context. Use supported CLI explicit options --tower-url https://sb4.otherstuff.studio --app-npub npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5 --workspace 2e5caefd-dd65-45d2-b747-ee874e8e5fc9 --bot-crypto on flightdeck commands. Equivalent nonsecret env FLIGHTDECK_TOWER_URL/FLIGHTDECK_APP_NPUB is fine. Broker identity lookup DID work for prior worker; do not require automatic MCP context if supported explicit CLI routing and broker succeed. Never export/read signing keys or copy any capability from another session. If host-side subscription transport is needed, report exact failure after explicit options.

Read full docs/grasp-fips-poc-handoff-2026-09-10.md and task 3455c77b-7781-47f8-85a8-024c6f784f9e and its comments using above flags. It is manager-routed work; latest manager comment does not mean skip. Implement all authorised gates sequentially. Architecture v5 reviewed; intake report docs/grasp-fips-poc-intake-blocker-2026-09-10.md contains prior evidence. No services or upstream clones were started. Autopilot worker is fixing inherited context separately; do not edit Autopilot yourself. Set own goal/reflect, preserve main concurrent state, commit tested state per main brief, no Autopilot restart. Post task milestones and return supervised callback; manager reports to Pete.

# Authorised GRASP over FIPS implementation

Pete instructed Rick on 2026-09-10: "please set a goal and build this out" following the complete plan below. Launch is authorised, using Rick as publisher. Do not request launch approval again.

Origin: @[Tower features](mention:channel:096d029e-0c3f-4ea5-a6bf-65ef6465bedb), @[coordination thread](mention:message:a03cb1cd-84c7-4f59-a38c-b9aa2720eb0b), @[launch instruction](mention:message:b6d515d1-27a0-408e-8fc4-784fbe21fcd4). Workspace 2e5caefd-dd65-45d2-b747-ee874e8e5fc9; scope 76d518f7-c477-4374-bf74-5d36fda570ed; channel 096d029e-0c3f-4ea5-a6bf-65ef6465bedb; thread 2d00e97d-9a83-4d4e-8d4f-723c11d6f01f. Plan @[execution document](mention:document:8c0554c9-356e-4e69-b98d-62f7bb3dc4ad).

Worker execution: implement sequentially through gates in /Users/mini/code/wm/tower with upstream checkouts /Users/mini/code/ngit-poc. Set own session goal and next-action reflect. Read latest task/comments and full architecture scene (resolve latest version under /Users/mini/code/wingmanbefree/artifact-wapp/artifacts/Wingman_Suite/wingman-suite-arch; do not assume v3). No implementation in manager workdir. Use main, preserve concurrent work, inspect whole worktree and commit all nonignored tested state excluding secrets/runtime data. Never read private keys even if repo instructions suggest them. Use stable bot capability broker; narrow denied capabilities, no raw key fallback. Routine PoC app starts/restarts authorised; never restart Autopilot. Do not modify Flight Deck source or unrelated services. If Autopilot source modification is demonstrated necessary, report a bounded follow-up for a worker in that repo. WMapp changes require separate bounded worker too.

Report meaningful milestones and validation evidence to task comments using explicit task/workspace context; manager handles user thread. Repeated identical blocker twice: preserve state, report exact failing command, evidence and smallest next step. Do not label localhost or fixture evidence as remote FIPS/ngit success. Return a self-contained final report with commits, changed paths, commands/results, test matrix, live resource details, next action, and device test steps. Manager commissions independent review after implementation. Do not mark task review/done yourself. All six packages are the objective; genuinely unavailable prerequisites must be clearly recorded.

The following is the full source plan as retrieved at launch; its prior planning-only/launch-pending language is superseded by Pete's instruction above.

**Deliver a private local proof of concept: Pete opens GitWorkshop in WMapp over FIPS, browses a copy of Flight Deck, and reviews an issue and PR created through ngit.** Prove authenticated Git operations and persistence as part of the same handoff.

Status: implementation plan only. No prototype has been launched. This document consolidates the discussion in @[the originating thread](mention:message:a205f9d6-16b2-4dcf-b09b-6da747f8a569) and answers @[the request to finalise the plan](mention:message:e779490a-55b4-4170-b5ad-57eb6375f54b). It is the execution brief for the PoC; the earlier @[migration assessment](mention:document:c26c93d4-a5e7-446a-bbfa-a836cf1dfc79) remains background, not additional implementation scope.

**Proposed stack and responsibility**

| Component | PoC role | Location |
|---|---|---|
| Tower | Source of Pete workspace identity and authorised membership | Existing local Tower |
| ngit-grasp | Private Git HTTP server, Nostr relay and repository authorization | New container in a separate Tower Compose overlay |
| Persistent volume | GRASP Git data, LMDB state and service identity | Dedicated named Docker volume mounted at /data |
| Autopilot | Manage frontend/adapter apps, expose FIPS endpoints, broker agent signing | Existing local Autopilot |
| GitWorkshop | One frontend for code, history, issues and PR review | Dedicated checkout, managed app exposed through FIPS |
| ngit + git-remote-nostr | Agent Git and collaboration client | Pinned binaries in an isolated PoC tool directory |
| WMapp | Pete’s browser, signer and FIPS connectivity | Existing installation; actual device validation required |

Connection path: WMapp → GitWorkshop FIPS endpoint → GRASP FIPS endpoint → local GRASP container → persistent volume. A terminal/worker reaches GRASP over its own working FIPS network path.

Use separate managed ports for frontend and GRASP forwarding initially. Ports and npub-based URLs are allocated and recorded at setup, never guessed. Private Git/relay membership remains enforced behind FIPS. A FIPS node’s identity is not the application user’s identity.

**Scope and fixed decisions**

- One private GRASP instance associated with the Pete workspace on the Tower backend of this thread. Resolve the workspace by routing identity, not by display name alone.
- Import a copy of committed Flight Deck history into flightdeck-prototype. No changes to the source checkout’s remotes, branches or deployment configuration.
- One GitWorkshop frontend; there is no frontend per workspace.
- FIPS is the required remote access path. A localhost diagnostic success does not count as FIPS success.
- Workspace inheritance is an explicit membership snapshot plus a manual refresh command/procedure. It is not continuous synchronisation.
- Only explicitly assigned repository maintainers can write canonical state. Read access does not confer maintainer status.
- Use stock upstream clients first. Any patches must address reproduced compatibility failures and remain reviewable.
- No public repository/event publication, public mirrors, production migration, S3 backup automation, CapRover/GitHub integration, or retired-container cleanup in this PoC.
- Keep a local consistent snapshot and prove restore, despite S3 automation being deferred.

The proposed repository publisher is Rick’s stable bot npub. Pete retains his own identity and receives workspace read access. This namespace choice was proposed earlier but has not been explicitly confirmed; include it in launch confirmation. Do not infer permission to sign repository events as Pete.

**Repository ownership and starting versions**

Tower implementation work belongs in /Users/mini/code/wm/tower. Autopilot integration changes, only if demonstrated necessary, belong in /Users/mini/code/wm/autopilot. WMapp changes are a separate bounded follow-up if device testing proves one is required.

Create durable upstream checkouts under /Users/mini/code/ngit-poc/ for ngit-grasp, ngit and GitWorkshop. Temporary research checkouts are evidence, not deployment sources. Keep upstream remotes; record local compatibility patches separately.

Starting review revisions:
- ngit-grasp: b990d2189ba494944f8e6c875d52056421c061c2, package 3.0.1.
- ngit: c2cc591dcfae5d46dc178c0ea87e8bc1802f09b3, package 3.0.0.
- GitWorkshop: dc36db64f6a2cca29d109829eabaf0a49d4bf4da.

These are candidate pins, not a proven compatible release set. Verify them together before importing Flight Deck. Record binaries, checksums, image IDs and every patch commit.

Flight Deck currently points to 0f7dccb2ef3042bd026fb1e5061b22e594faed96. Capture the source revision again at execution; the live repository continues to change. Import all intended local branches and tags from an isolated copy and record their mapping. Do not claim unavailable remote branches were copied. Account separately for submodules and LFS if present. Do not import working-tree files or local credential/config files.

**Work package 1 — Freeze the execution contract and connectivity assumptions**

Manager creates one tracking task in this channel/scope before dispatch. Task description contains this complete brief and originating thread link. Put a repo-local handoff under Tower docs with the task reference and exact reporting destination.

Worker reads repository instructions and the latest architecture board scene before cross-component work. Verify whether the existing Autopilot is native or containerised, its FIPS availability, client platform, available managed-app ports, and how a local adapter can reach the new Docker service.

Deliver: pinned version manifest, workspace binding, effective membership snapshot, source-ref manifest, chosen network path, and acceptance checklist.

Gate: no ambiguous workspace, no assumption that Docker loopback equals Autopilot loopback, and no human-key workaround.

**Work package 2 — Private GRASP and persistence**

Add a dedicated Compose overlay, dedicated named volume, private mode, explicit members and narrowly bound host/network ports. Start only the new services; do not run a stack-wide recreation.

Use GRASP’s service identity for its own infrastructure. Protect it in its volume/credential handling; do not export identity secrets to workers or logs.

Begin with a synthetic repository. Confirm anonymous and nonmember requests cannot read its Git objects or collaboration events. Review effective membership including any admission of private peer-relay operators; do not configure public peers or automatic external mirroring for the PoC.

Deliver: reproducible start/stop commands, health/discovery output, storage paths and denial-test results.

Gate: private behaviour is verified before any real Flight Deck content is imported.

**Work package 3 — FIPS transport and canonical addresses**

Register a small managed forwarding app using Autopilot’s existing FIPS ingress. Prefer a localhost-facing adapter to the container’s narrowly published port; preserve HTTP methods, bodies, WebSocket upgrades and streaming. Keep the current ingress manager unchanged if this is sufficient.

Configure advertised Git/relay addresses and GRASP private authentication origin to agree on the externally used FIPS scheme, host, port and path. Test NIP-11 discovery, NIP-42 relay authentication and GRASP-08 Git authentication over that address.

Stock ngit supports explicit HTTP/WS options, but discovery has HTTPS/WSS assumptions. Reproduce failures before patching. No global disabling of TLS validation or browser security. Serving the frontend over HTTP/FIPS can avoid mixed-content blocking but does not make the browser origin a secure context; Web Crypto, workers and signer functionality still require verification.

Deliver: remote FIPS reachability evidence and exact compatibility patch, if any.

Gate: a different FIPS peer can reach the synthetic private repository, and an unauthorised application identity still cannot read it. Local loopback or a listener descriptor alone is insufficient.

**Work package 4 — Broker signing and Flight Deck import**

Integrate ngit with the existing stable-bot capability broker. Prefer a supported signer adapter; use a narrow upstream patch if required. No exported nsec, shared human credential, browser fallback for agents, or blanket signing grant.

Capabilities must cover the specific repository operations required by the PoC. GRASP-08’s repository-root GET credential is a distinct profile from Tower’s exact-request NIP-98 authentication. Do not weaken Tower’s request validation to accommodate it.

After synthetic authenticated fetch/push tests pass, import flightdeck-prototype privately. Use explicit private service addresses and check resulting announcements and publication destinations. Compare imported commits, intended branches and annotated tags against the source manifest.

Create a harmless test branch, test issue and proposal in the copy. Record the proposal head and expected diff. Agent tests must use ngit/git-remote-nostr and the broker path, not only hand-written HTTP requests.

Deliver: fresh-worker clone/fetch/push and issue/PR evidence, actor identity, and imported-ref reconciliation.

Gate: all repository events stay within the private service and every reported successful operation has durable evidence.

**Work package 5 — GitWorkshop and WMapp**

Build the pinned GitWorkshop checkout and serve it as a managed frontend over FIPS. Configure its private-service discovery and repository link. Keep compatibility modifications minimal and isolated.

Open the actual frontend in WMapp. Verify Pete’s own signer is available and that authentication grants his account access. Verify repository discovery, source tree, file contents, history, test issue, PR and its actual diff. Also create or reply to a test issue as Pete to prove signed browser writes. Any repository-maintainer role for Pete requires the normal explicit invitation/acceptance flow.

Exercise both HTTP Git retrieval and authenticated relay subscriptions; cached content alone is not proof. Repeat from a fresh browser session/cache state.

If Pete’s signing action cannot be exercised without his interaction, mark it clearly as awaiting Pete’s device test and provide exact steps. Never simulate his identity and call it a pass.

Deliver: exact frontend/GRASP FIPS URLs, repository coordinates, screenshots or browser evidence, signer origin, device/build versions and remaining manual steps.

**Work package 6 — Failure, recovery and independent review**

| Test | Required result |
|---|---|
| Anonymous/nonmember Git fetch and relay query | Denied before repository content is exposed |
| Workspace read-only member attempts canonical-state write | Denied unless separately granted maintainer role |
| Member removed through documented snapshot refresh | New reads fail; existing authenticated sessions close as supported; old local copies are not claimed revoked |
| Changed hostname/port or expired auth credential | Denied; valid canonical-origin credentials succeed |
| FIPS unavailable on test client | Fresh uncached Git/relay requests fail; no public fallback |
| Recreate only the GRASP container with same volume | Service identity, Git refs, issue and PR persist |
| Consistent snapshot restored into isolated test instance | Identity and content match; no simultaneous writers on the same volume |
| Original Flight Deck repository comparison | No PoC changes to source files, remotes or release configuration |

Run affected repositories’ native checks. Relevant upstream integration suites include GRASP private-mode/push-authorization tests and ngit private-GRASP/Git-push tests; choose exact invocations from the pinned checkout and document prerequisites. Skipped tests are not passes.

Independent reviewer examines authentication, publication destinations, patches, live network exposure, source preservation and acceptance evidence. Fix review findings before handoff. Do not commission a broad migration/security redesign.

**Delivery, authority and stopping points**

Implementation uses supervised Autopilot sessions, with manager updates in this thread at meaningful milestones. Work sequentially through the gates; separate review follows implementation. No pipelines are required. In Wingman repositories default to main, preserve concurrent changes, inspect the entire worktree and commit all nonignored tested state under the existing policy; exclude sensitive runtime credentials and generated data.

Creating/building/starting the PoC services and routine restarts of those PoC apps are part of the proposed launch scope. Restarting the Autopilot process requires Pete’s explicit approval for that step. Prepare any required change and validation first so the requested approval is concrete.

On a repeated blocker, return the exact failing operation, evidence and smallest next step. Do not quietly replace FIPS with a public endpoint or replace broker signing with raw keys to achieve a demonstration.

Final handoff: task in review, code/patch commits, pinned manifest, exact source-copy hashes, service identities, working FIPS links, issue/PR references, test matrix with pass/fail/pending, resource footprint, and stop/restore instructions. PoC is complete only when actual WMapp browsing, signed interaction, agent Git operations, negative access tests and persistence checks have passed.

Planning estimate: 4–7 engineering days plus Pete’s device test, assuming targeted URL/signing compatibility changes. Re-estimate after the synthetic FIPS/signing gate if native-client or WMapp work expands. This is smaller than a Forgejo migration and makes no commitment to retire Forgejo.

**Launch decision**

Approve this bounded PoC and confirm Rick as the prototype repository publisher. Implementation task creation and supervised dispatch follow launch approval. No production release or broader migration approval is implied.
