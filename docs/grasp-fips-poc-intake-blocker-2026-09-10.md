# GRASP FIPS PoC: gate 1 intake blocker

Launch is authorised with Rick as publisher. This is an incomplete implementation handoff, not a launch-approval request.

Task: `3455c77b-7781-47f8-85a8-024c6f784f9e`; explicit workspace: `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`.
Execution contract: [full launch brief](grasp-fips-poc-handoff-2026-09-10.md).
Worker: `626307d9-4e8a-476a-b631-b1987b0dd825`.
Supervised dispatch: `dispatch_04b134ae-e981-43b5-857a-dfd64745969f`.
Manager callback session: `d2f38696-b8cc-4bf9-9f57-b4e2562b3d3d`.
Reporting channel: `096d029e-0c3f-4ea5-a6bf-65ef6465bedb`; thread: `2d00e97d-9a83-4d4e-8d4f-723c11d6f01f`.

## Verified intake

- Tower checkout is on `main`, initial HEAD `7ba83369c36d2a0934304aaf7e823fd71f4f6d00`.
- Session goal was set through `bun clis/sessions.ts metadata-update --goal 'Deliver task 3455c77b-7781-47f8-85a8-024c6f784f9e private GRASP ngit GitWorkshop FIPS PoC through six gates' --next-action reflect` (exit 0).
- Stable broker identity lookup succeeds: `npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr`.
- Dispatch status confirms the worker, manager callback and explicit workspace/channel/thread above.
- Architecture versions v1–v5 exist. Latest v5 scene was inspected, including active text, geometry, connections and bindings: `.../artifact-wapp/artifacts/Wingman_Suite/wingman-suite-arch/v5/excalidraw-scene.json`. It contains 161 active elements and no active images. Updated `2026-09-09T09:07:17.180Z`, parent v4, SHA-256 `ce52d8c31e7af169ae3a30f49e35db0e7b8ccafad1d237bd0b9178b30acf8e44`.
- Scene assigns shared authority to Tower, execution to Autopilot and coordination to Flight Deck. Its adjacent UI diagram assigns workspace network updates to TowerSyncService → Dexie → liveQuery → Alpine; signer availability remains a separate concern.
- `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'` succeeds. Local Tower publishes loopback port 3100. No GRASP PoC container was present.
- `curl --max-time 5 -s http://127.0.0.1:3100/health` returns `status: ok`, service npub `npub1vf3h0rmlrr0x6pjc68jcrk5p2zsfzl3f9zwcppcdn8386npdlxgqmam99v`. This is only local health, not verified workspace binding or FIPS evidence.
- `/Users/mini/code/ngit-poc` does not yet exist. Candidate upstream hashes remain unverified; no binaries, image IDs or compatibility patches exist from this turn.

## Repeated failing operation

Run from `/Users/mini/code/wm/autopilot`:

```sh
bun clis/wingman.ts flightdeck task show 3455c77b-7781-47f8-85a8-024c6f784f9e --workspace 2e5caefd-dd65-45d2-b747-ee874e8e5fc9 --tower-url http://127.0.0.1:3100 --json
bun clis/wingman.ts flightdeck task comments 3455c77b-7781-47f8-85a8-024c6f784f9e --workspace 2e5caefd-dd65-45d2-b747-ee874e8e5fc9 --tower-url http://127.0.0.1:3100 --json
```

Both exit 1:

```text
Missing Flight Deck app npub. Pass --app-npub or set FLIGHTDECK_APP_NPUB from the active Flight Deck PG dispatch context; do not use the bot npub.
```

Without `--tower-url`, both commands previously failed with `Missing Flight Deck PG Tower URL`. The explicit local URL above was a diagnostic against the observed container, not an assertion that it is the routed workspace backend.

Both MCP and CLI context lookups return `hasRunContext: false`, null workspace/backend/app/subscription fields and `bot.available: false`. This contradicts the successful standalone stable-identity lookup: the missing item is Flight Deck context, not demonstrated absence of the broker identity. Environment presence checks (values not dumped) confirm session/capability/bot fields exist, while Tower URL and Flight Deck app npub fields are absent.

The explicit-workspace `flightdeck task comment` attempt also exited 1 with the same missing-app error. No progress comment was posted; task/comment contents could not be read. No task state was changed.

Relevant read-only source inspection: Autopilot `src/flightdeck-pg/cli.ts` obtains live context through the broker and supports explicit `--tower-url` and `--app-npub`; `src/flightdeck-pg/client.ts` requires the app npub separately from the stable bot npub. Do not substitute an instance, bot or human npub.

## Smallest next step

Manager should supply the verified routed Tower base URL and Flight Deck source app npub from its working context, or restore this worker's subscription-backed Flight Deck context through the supported dispatch/session mechanism. Retry explicit-workspace task show/comments with that context and the existing broker. If broker policy then denies a request, report and narrow that exact capability; never use raw keys. No source modification or Autopilot restart has been demonstrated necessary.

## Acceptance matrix and device handoff

| Package | Status |
| --- | --- |
| 1: execution contract, workspace/membership, refs and network | Partial intake; blocked before authenticated task/workspace verification |
| 2: private GRASP and negative synthetic tests | Not started; gate 1 unmet |
| 3: remote FIPS discovery/authentication | Not started; no allocated canonical URLs |
| 4: ngit broker operations and Flight Deck import | Not started; no copied refs or issue/PR |
| 5: GitWorkshop and actual WMapp signer | Not started; no frontend or device evidence |
| 6: removal, origin/expiry, persistence/restore, review | Not started; manager review still required |

There are no PoC live resources, ports, volumes, stop/restore commands or working FIPS links to hand off yet. No private keys were read. No service was restarted, no upstream publication was made and no Flight Deck checkout was altered. Native implementation suites were not run because no implementation source changed; localhost health is not acceptance evidence.

After the earlier gates pass and actual links exist, Pete's device procedure remains: connect WMapp to FIPS; open the recorded GitWorkshop URL in a fresh session; select Pete's signer; browse source, file contents and history; inspect the test issue and PR's actual diff; post a signed test reply; repeat uncached Git/relay reads and test FIPS disconnection. This procedure is pending and is not presently executable without the missing deployment.

## Concurrent work preservation

Initial unrelated changes were inspected: modified `src/routes/wapp-management.ts` and untracked `src/services/wapp-scope-access.ts`. They implement an installation scope-access endpoint and were preserved without edits. They are not tested by this documentation-only intake and must not be included as a claimed tested PoC implementation. The pre-existing launch handoff is committed with this report. No Tower source/schema rebuild was performed for this documentation change.
