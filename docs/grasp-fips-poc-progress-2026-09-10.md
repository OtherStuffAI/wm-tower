# GRASP PoC pickup: private local service, signing gate pending

The routing blocker is resolved with the manager's explicit CLI options. A
private GRASP container, loopback ingress and managed FIPS forwarder now run; native GRASP privacy
and push-authorization suites pass. **The six-package PoC is incomplete.**
The current session cannot obtain a GRASP repository-root credential: the
capability broker returns `NIP-98 origin is not allowed`. This repeated failure
is the authorised stopping point. No authenticated synthetic repository,
Flight Deck import, ngit operation or distinct-peer FIPS success is claimed.
The canonical FIPS URL passes discovery and anonymous denial from this host.

## Routing and custody

- Task: `3455c77b-7781-47f8-85a8-024c6f784f9e`, still `in_progress`.
- Workspace: `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`.
- Reporting channel/thread: `096d029e-0c3f-4ea5-a6bf-65ef6465bedb` /
  `2d00e97d-9a83-4d4e-8d4f-723c11d6f01f`. Manager reports to Pete.
- Worker: `2f5f80bf-0a4c-48ee-a7f9-ebccd6317e2f`.
- Dispatch: `dispatch_eb5f1abe-af4b-47b3-bd8d-395c52529b5b`.
- Callback manager: `d2f38696-b8cc-4bf9-9f57-b4e2562b3d3d`.
- Own session goal and `nextAction=reflect` verified. Goal remains unmet.
- Full execution brief: [handoff](grasp-fips-poc-handoff-2026-09-10.md).

Task show/comments, membership reads and milestone comments succeed with:

```sh
# Working directory: /Users/mini/code/wm/autopilot
bun clis/wingman.ts flightdeck task show 3455c77b-7781-47f8-85a8-024c6f784f9e --tower-url https://sb4.otherstuff.studio --app-npub npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5 --workspace 2e5caefd-dd65-45d2-b747-ee874e8e5fc9 --bot-crypto --json
```

Milestones posted: `d0a17571-5fb8-43ca-9cea-ff4cb016303a`,
`abe304aa-c4da-4aed-9495-1ec443aba64e`,
`70dc9926-2414-44b1-b31c-ef9f64a172f0`,
`a0646c84-a003-4a27-a8c8-f8199d92ae39`,
`8e830fdd-2f30-43a9-9db0-e12b3095188f`.

`poc/grasp/membership.json` binds the live eight-actor snapshot to Tower,
workspace owner/service and app identities. Rick's stable broker identity is
`npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr`.
It is the authorised publisher; workspace membership does not confer canonical
repository write authority. No private keys or another session's capability
were read, exported or copied.

Latest architecture remains v5, 161 active elements and no active images.
Read the full scene's text, geometry and bindings under
`/Users/mini/code/wingmanbefree/artifact-wapp/artifacts/Wingman_Suite/wingman-suite-arch/v5/excalidraw-scene.json`;
SHA-256 `ce52d8c31e7af169ae3a30f49e35db0e7b8ccafad1d237bd0b9178b30acf8e44`.
Its Tower authority, Autopilot execution and Flight Deck coordination boundaries
are preserved.

## Implemented state

- `docker-compose.grasp-poc.yml`: separate Compose project, persistent named
  volume, private mode, explicit members, Rick repository whitelist, no GRASP-06,
  no Sync+/public user-index relays and internal-only GRASP network.
- `poc/grasp/nginx.conf`: dedicated loopback ingress, HTTP bodies/methods,
  WebSocket upgrades and streaming. GRASP itself has no external route.
- `poc/grasp/refresh-membership.py`: brokered manual snapshot refresh, binding
  checks and incomplete-page rejection; no implicit service restart.
- `poc/grasp/broker-probe.ts`: reproducible scoped credential request with no
  credential output.
- `poc/grasp/anonymous-smoke.ts`, `local-smoke.json`: live local discovery and
  empty-401 Git/auth-required relay evidence with explicit limitations.
- `poc/grasp/versions.json`, `source-refs.json`, `membership.json`: version,
  source and membership evidence. `README.md` and `local.env.example` document
  reproducible start/stop/refresh and remaining restore acceptance.
- `poc/grasp/forwarder/`: native managed adapter; two passing transport tests.
- `poc/grasp/fips.json`, `fips-same-host-smoke.json`: allocated canonical address
  and same-host evidence. Two signing-policy drafts pass the current validator
  and are not applied.

All candidate upstream checkouts exist at `/Users/mini/code/ngit-poc/` with
unchanged origins and detached candidate pins. GRASP `b990d2189ba494944f8e6c875d52056421c061c2`
is version 3.0.1; ngit `c2cc591dcfae5d46dc178c0ea87e8bc1802f09b3`
is 3.0.0; GitWorkshop `dc36db64f6a2cca29d109829eabaf0a49d4bf4da`.
No compatibility patches or upstream commits were made. The initially mistaken
archived ngit-relay checkout is retained separately as
`ngit-relay-archived-intake`; it was never built or started. The canonical GRASP
origin is recorded from its upstream Dockerfile, not inferred from that archive.

Flight Deck source HEAD is `f7bc51c1d52dd5a6ff49bb75cf308f466a3df38b`.
The manifest records three local branches and four local tags; nothing was
copied. HEAD, clean worktree and `.git/config` checksum were unchanged at
handoff. HEAD has no submodule entries or LFS attribute; all-ref import/LFS
reconciliation remains pending. No remote branches are claimed imported.

## Validation matrix

| Check | Result and limit |
| --- | --- |
| Explicit task/comments/members and own metadata | Pass; live broker path |
| Compose config, nginx config, whitespace | Pass |
| Pinned upstream Docker release build | Pass; anonymous public-registry client config |
| GRASP native private_mode | 54 passed, zero failed/ignored with canonical TMPDIR |
| GRASP native push_authorization | 56 passed, zero failed/ignored with four Git identity variables unset |
| Local NIP-11 | Pass; GRASP-08, NIPs 42/98 advertised |
| Local anonymous Git | Pass; four paths return empty 401/Nostr challenge |
| Local anonymous relay REQ | Pass; auth-required CLOSED |
| Live authenticated/member/nonmember synthetic content | Pending broker grant; fixture results are not deployment proof |
| Broker GRASP-08 credential | Fail repeatedly: origin not allowed |
| ngit/private-GRASP/Git-push suites | Not run; ngit binary/adapter not built at unmet gate |
| GitWorkshop build/unit/e2e | Not run; later gate |
| Managed FIPS URL, same host | Discovery/Git/relay anonymous denial pass; public alias 403 |
| Forwarder transport tests | 2 pass: binary body/method/URL and upgrade initial bytes |
| Actual distinct-peer FIPS and WMapp | Not run |
| Membership removal, origin/expiry on live service | Pending; native private suite includes credential/identity negatives |
| Full recreation and isolated restore | Pending; no repository/issue/PR exists to reconcile |
| Flight Deck source preservation | Pass for HEAD, worktree and config at handoff |

Native commands, from the GRASP checkout:

```sh
cargo test --locked -p ngit-grasp --test private_mode --test push_authorization --no-run
TMPDIR=/Users/mini/code/ngit-poc/test-tmp cargo test --locked -p ngit-grasp --test private_mode --test push_authorization
env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL TMPDIR=/Users/mini/code/ngit-poc/test-tmp cargo test --locked -p ngit-grasp --test push_authorization
```

The first unmodified native run had three shared-helper failures because
`is_safe_path` compared canonical file paths against a noncanonical macOS temp
root. A canonical TMPDIR fixed them. The push suite then had ten deterministic
fixture failures; inherited `GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables changed
commit identity. Clearing those four variables fixed all ten. No upstream
patch was needed. Native Cargo 1.91.1 emitted three platform-specific dead-code
warnings; Docker used upstream Rust 1.96. These are local fixtures only.

## Live resources and limits

- Containers: `tower-grasp-poc-grasp-poc-1` (healthy),
  `tower-grasp-poc-grasp-ingress-1` (running).
- Loopback endpoint: `http://127.0.0.1:60546`, diagnostic only.
- Volume: `tower-grasp-poc-data`, `/data/git`, `/data/relay`, internal service
  identity in `/data`; no source import or collaboration objects.
- Service public hex key:
  `0c69a77488766473a18bff1603a20ae2f20871caf8553256884c27baac7e5b9e`.
- GRASP image ID:
  `sha256:0a47c3f873d4f483b418b5121b96c1177dc118ed089318fc709523bd0dc0a144`.
- Linux binary SHA-256:
  `ecb829b0c5453ebeb1e4dd1b363cbac1b9ea58d480c4a792ff86b350b420ca35`.
- nginx image is pinned by digest in Compose; other checksums in versions.json.
- Observed idle footprint: GRASP 5.7 MiB, ingress 3.8 MiB RAM; under 0.1% CPU.
- Autopilot is native on Darwin arm64. `bun clis/fips.ts status` reports ready,
  `fipsctl 0.5.0 (rev 80f8f965aa)`. Local node
  `npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74`,
  mesh `fd87:f2eb:de48:6212:be46:3c95:4494:49ec`; two connected peers observed.
  These descriptors do not prove a peer can access this PoC.
- Managed forwarder: `12c563d2-a95f-42ef-b510-6eaa74daf22a`, running on allocated
  port 41007. Canonical URL:
  `http://npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74.fips:41007/`.
  It forwards to 60546 and only accepts that canonical Host. The generated
  public alias `https://full-lap-mint.rick.runwingman.com/` returns 403.
- No frontend, issue, PR, imported ref or WMapp device/build result exists yet.

## Exact blocker and next step

From Tower: `bun poc/grasp/broker-probe.ts` exits 1 with
`NIP-98 origin is not allowed`. It calls supported
`/api/mcp/capabilities/nip98` with method `GET` and URL
`http://npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74.fips:41007/npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr/synthetic.git`.
Two calls reproduced denial at this allocated FIPS origin; earlier localhost
diagnostic requests also failed.
Generic kind 27235 was also denied, correctly; it is not a substitute path.

Manager follow-up `e3dd885f-cb5d-4e96-bea0-eb12448c06c2` required the
concrete address before handoff. Self-space app registration returned
`403 admin-or-execution-delegation-required`; retry through the explicit
owner-space API succeeded and allocated the address above. Registration and
start used `bun clis/appctl.ts register grasp-fips-poc-forwarder --directory
/Users/mini/code/wm/tower/poc/grasp/forwarder --web-app --owner
npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy --bot-crypto`.
Only this new app was started/restarted. GRASP now uses the FIPS canonical
origin, and its public service identity survived those configuration recreations.
This is identity-only evidence, not content-persistence acceptance.

The old enabled/pair-only drafts at dd5fcfe failed independent review. They are
superseded by the corrected **disabled** files at
`poc/grasp/signing-policy-http.draft.json` and
`poc/grasp/signing-policy-nostr.draft.json`. Follow the reviewed activation order
in [the operations README](../poc/grasp/README.md#disabled-policy-correction-review).
Manager cannot apply these: the admin policy endpoint is broker-denied. Human/admin
action is required after the explicitly approved Autopilot restart and runtime checks.

| Work package | Status |
| --- | --- |
| 1 contract/connectivity | Routing, membership, source and version inventory done; pins not proven together |
| 2 private GRASP | Live local service and denial/fixture evidence; populated synthetic acceptance blocked |
| 3 canonical FIPS | Managed address/forwarder and same-host anonymous checks done; distinct-peer/authentication pending |
| 4 broker/ngit/import | Pending; no import or issue/PR |
| 5 GitWorkshop/WMapp | Pending, including actual Pete signing action |
| 6 recovery/review | Pending live matrix and manager-commissioned independent review |

Once actual FIPS links exist, Pete's device steps are: connect WMapp to FIPS;
open the recorded GitWorkshop URL in a fresh session; use Pete's signer;
browse source, files and history; inspect the actual issue and PR diff; post a
signed issue reply; repeat uncached Git/relay reads; disconnect FIPS and verify
fresh reads fail with no public fallback. Record device/build, signer origin and
screenshots. These steps are pending and cannot yet be executed against a frontend.

## Concurrent state

Tower remains on main. Pre-existing `src/routes/wapp-management.ts` and
`src/services/wapp-scope-access.ts` were inspected and preserved without edits.
They are unrelated, untested concurrent work and are excluded from the tested
PoC commit. No Tower backend source/schema was changed; its rebuild/test suite
was not invoked. Autopilot and Flight Deck were neither edited nor restarted.
Initial PoC commit: `20cc0e2255807f3afaba0c4778cd19cb709b73f4`.
The managed adapter follow-up is committed separately.
All tested nonignored PoC files and the supplied pickup brief are committed;
machine config, test/build data and private identity remain outside the commit.

## Final disabled draft correction (2026-09-10)

Source prerequisite is Autopilot `8143790`, independently approved but **not
restarted**. Both drafts now require profile AND workspace and remain disabled.
Exact singleton d/clone/relays/relay values survive source normalization and
local temporary-store persistence. Announcement additionally requires exact
synthetic name/alt, private=true and empty web; unused role/publication tags are
removed. Initial state is limited to main/HEAD. Unsigned candidates and negative
checks are in `poc/grasp/signing-policy-candidates{,.test}.ts`.
Validation: `bun test poc/grasp/signing-policy-candidates.test.ts` — 5 pass,
0 fail, 125 assertions. `git diff --check` passes. No Tower source/schema
changed, so no runtime rebuild or live suite was invoked.

Stock ngit's additional kind 10318 self-encrypted private discovery-list update
and later ordering nonce are evidence-backed compatibility gates, not newly
allowed permissions. See the [full reviewed constraints and activation/cleanup
order](../poc/grasp/README.md#disabled-policy-correction-review). The grant applies
to all future matching Rick-profile + workspace sessions, not just one worker.
Human/admin must save/verify disabled constraints after explicitly user-approved
external Autopilot restart and runtime verification, then enable and issue with
trusted workspace context before positive/negative broker checks and original
PoC gates. Manager admin access is broker-denied. Use actual issuance expiresAt;
no policy auto-expiry exists. Disable both policies and revoke every affected
issued snapshot at completion. No new authenticated/populated GRASP success,
restart, capability change, application implementation or push in this correction.
