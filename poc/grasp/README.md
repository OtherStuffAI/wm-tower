# Private GRASP PoC operations

This is a partial, local deployment for task `3455c77b-7781-47f8-85a8-024c6f784f9e`.
Latest: [synthetic Git handoff](../../docs/grasp-synthetic-git-handoff-2026-09-10.md)
records 22 live broker checks, native push/clone/update/fetch through an explicit
private-only compatibility mode, and 8 populated same-host privacy checks.
Distinct-peer, member-role/removal/expiry and later PoC acceptance remain pending.
The older origin-denied/activation-pending notes below are historical evidence.
Read [the authorised brief](../../docs/grasp-fips-poc-handoff-2026-09-10.md) and
[the pickup evidence](../../docs/grasp-fips-poc-progress-2026-09-10.md).
The private synthetic-content and FIPS gates have **not** passed. Do not import
Flight Deck or publish repository announcements to public relays.

## Sources and boundaries

`versions.json` records three pinned upstream checkouts and the GRASP image/binary.
The Compose file builds the upstream Dockerfile unchanged. GRASP is on an
internal-only Docker network. A dedicated nginx ingress joins that network and
an ordinary bridge, publishing only `127.0.0.1:60546`. This extra container is
necessary because Docker Desktop did not publish ports on the internal-only
network. GRASP has no configured external peers, user-index relays or Sync+;
nginx forwards only to GRASP and disables request/response buffering for Git and
WebSocket streaming. The native Autopilot adapter and canonical FIPS address are recorded in
`fips.json`; same-host discovery/anonymous denial passes, distinct-peer
acceptance remains pending.

The service generates and stores its own identity inside `/data`. Never read or
export its key. NIP-11 exposes the public identity. Git is in `/data/git`, LMDB
in `/data/relay`. No real repository has been imported. Volume:
`tower-grasp-poc-data`. No other service shares it.

## Build, start and stop

Run from the Tower repository. `local.env` contains public routing/membership,
not signing material. It is ignored as machine-specific state.

```sh
# Only on a new setup; preserve an existing local.env.
cp -n poc/grasp/local.env.example poc/grasp/local.env
python3 poc/grasp/refresh-membership.py
docker compose --env-file poc/grasp/local.env -f docker-compose.grasp-poc.yml config --quiet
docker compose --env-file poc/grasp/local.env -f docker-compose.grasp-poc.yml build grasp-poc
docker compose --env-file poc/grasp/local.env -f docker-compose.grasp-poc.yml up -d --no-build grasp-poc grasp-ingress
bun poc/grasp/anonymous-smoke.ts
docker compose --env-file poc/grasp/local.env -f docker-compose.grasp-poc.yml stop grasp-ingress grasp-poc
```

The initial build stalled in `docker-credential-desktop`. An empty Docker client
configuration containing `{"auths":{},"cliPluginsExtraDirs":["/Users/mini/.docker/cli-plugins"]}`
was created at `/Users/mini/code/ngit-poc/docker-anonymous/config.json`. Public
image pulls/builds then succeeded with this prefix; no credential store was read
or modified:

```sh
DOCKER_CONFIG=/Users/mini/code/ngit-poc/docker-anonymous DOCKER_HOST=unix:///Users/mini/.docker/run/docker.sock docker compose --env-file poc/grasp/local.env -f docker-compose.grasp-poc.yml build grasp-poc
```

Do not use a stack-wide Tower command or remove the volume. When recreating
GRASP, recreate ingress afterward so nginx resolves GRASP's current address:

```sh
docker compose --env-file poc/grasp/local.env -f docker-compose.grasp-poc.yml up -d --no-build --no-deps --force-recreate grasp-poc
docker compose --env-file poc/grasp/local.env -f docker-compose.grasp-poc.yml up -d --no-build --no-deps --force-recreate grasp-ingress
bun poc/grasp/anonymous-smoke.ts
```

## Manual membership refresh

`python3 poc/grasp/refresh-membership.py` uses the supported Flight Deck CLI with
explicit Tower/app/workspace routing and this session's broker capability. It
rejects a changed workspace binding, invalid/empty members or an incomplete
page before replacing configuration. Review the `membership.json` diff, then
run the two-service recreation above. This ends existing connections and loads
the refreshed list. It does not revoke existing local copies or grant anyone
repository-maintainer authority. Removal behaviour still needs the authorised
negative test. Public keys from accepted private peer relays can extend upstream
membership; the PoC must continue to prohibit external announcement destinations
and peer configuration, and verify effective membership after any change.

## Validation and signing prerequisite

```sh
bun poc/grasp/broker-probe.ts
bun poc/grasp/anonymous-smoke.ts
cd /Users/mini/code/ngit-poc/ngit-grasp
env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL TMPDIR=/Users/mini/code/ngit-poc/test-tmp cargo test --locked -p ngit-grasp --test private_mode --test push_authorization
```

Create the test-tmp directory first if absent. Its path must be canonical on
macOS. Clearing only the four Git identity variables lets fixtures use their
own deterministic identity. Never substitute Pete or Rick keys into fixtures.
These native suites are localhost fixture evidence, not broker or FIPS evidence.

The broker probe currently fails with `NIP-98 origin is not allowed`. It signs
only the GRASP-08 repository-root GET profile and prints no token. Generic kind
27235 signing is deliberately not a fallback. The current custom policy
validator accepts HTTPS or a valid HTTP `npub.fips` origin, not arbitrary
localhost HTTP. The exact canonical origin is now allocated in `fips.json`. Both
The corrected disabled policy drafts and activation order are documented in
[the policy correction review](#disabled-policy-correction-review).
Do not broaden the baseline or change Tower authentication to get past this gate.

## Snapshot/restore acceptance still pending

Before a consistent snapshot: stop these two PoC services, archive the complete
named volume using a read-only helper mount into protected ignored runtime
storage, then restart them. The archive contains the service identity and must
never be printed, committed or uploaded. Restore into a **different** named
volume and isolated test instance; never allow two writers on one volume.
Compare public identity, refs and authenticated issue/PR events, then destroy
only the isolated test resources. No snapshot or restore has been performed;
the final procedure must record exact filenames, volume IDs and results after
synthetic/import gates pass.

## Managed FIPS forwarding app

App `12c563d2-a95f-42ef-b510-6eaa74daf22a` is running with allocated port 41007.
It forwards to the Docker ingress on 60546, preserving HTTP and upgrades, and
rejects noncanonical Host headers (including the automatically assigned public
alias, tested 403). Native source is `forwarder/server.mjs`; two transport tests
cover binary request/response bodies and upgrade initial bytes:

```sh
node --test poc/grasp/forwarder/server.test.mjs
bun poc/grasp/anonymous-smoke.ts http://npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74.fips:41007
```

Manage only this app, from the Autopilot checkout:

```sh
bun clis/appctl.ts stop 12c563d2-a95f-42ef-b510-6eaa74daf22a --owner npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy --bot-crypto
bun clis/appctl.ts start 12c563d2-a95f-42ef-b510-6eaa74daf22a --owner npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy --bot-crypto
```

The self-space registration route returned 403; the explicit authorised owner
route succeeded. This is not an outstanding registration blocker. There is no
frontend yet. `fips-same-host-smoke.json` is same-host mesh evidence only.
See the disabled policy correction review below for the actual assignment scope
and pending human/admin actions. No policy or capability changes were performed.

## Disabled policy correction review

Both corrected files live here: [HTTP draft](signing-policy-http.draft.json) and
[Nostr draft](signing-policy-nostr.draft.json). Both are `enabled=false` and require
Rick profile `fd-npub1s46587g3k2axql224qz-2e5caefddd47ee874e8e5fc9-npub1hd37razr2rfxsw6dns5`
**AND** workspace `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`. Assignment covers **all
future sessions matching both**, not one worker. No session selector exists.

Prerequisite: independently source-approved Autopilot commit
`8143790efd69e18d8782511ede18dc06b36c8791`. Its runtime has **not** been restarted;
older code can silently drop `exactTags`. Source validation does not establish
runtime enforcement. HTTP remains only canonical synthetic repository-root GET.
Nostr requires exactly one full `d=synthetic` for 30617/30618 and exactly one full
canonical `clone`/`relays` for 30617, or `relay` for 22242. Relay strings end in `/`;
clone ends in `synthetic.git` without `/`. There is no broker URL normalization.

The source-derived candidate in [signing-policy-candidates.ts](signing-policy-candidates.ts)
uses ngit `c2cc591dcfae5d46dc178c0ea87e8bc1802f09b3`:

- `src/lib/repo_ref.rs:940-1089`: identifier/name `synthetic`, private=true,
  maintainers=[Rick signer], no lead, moderators, role history, upstream, blossoms,
  hashtags, extra tags or prior events. This implicit sole-author case emits no
  `maintainers`, `M`, `m`, or `o`. Those names are denied, as are `u`, `blossoms`,
  `t`, and `!`; this correction removes unused permissions from the earlier draft.
- It always emits `alt`, bound to exactly `git repository: synthetic`, and `web`,
  bound to exactly the name-only `["web"]` from an empty web list. The actual
  private marker is exactly `["private","true"]`, now required. Name is also
  bound to `synthetic`; description and root `r` remain metadata under existing
  byte/count limits. Private marker alone is not a service access-control proof.
- `clone` is an unchanged String; relays use `RelayUrl::to_string()`. Supply the
  slash explicitly in the template/relay configuration and inspect the actual
  unsigned signer candidate before signing. Do not assume a no-slash input is
  canonicalized into the allowed form. No alternate destinations or web links.
- `src/lib/repo_state.rs:54-75,88-99`: initial state contains only main and its
  inferred HEAD. Allowed tags are `d`, `HEAD`, `refs/heads/main`; HEAD is exactly
  `ref: refs/heads/main`. No tag refs, other branches, or extra state metadata.
- `src/lib/event_ordering.rs:175-195`: initial reference=None adds no nonce;
  later same-timestamp replacements can emit `nonce` for tie-breaking. This is
  denied and requires a separately reviewed follow-up if encountered.

**Additional stock-private-init requirement remains unresolved:**
`src/bin/ngit/sub_commands/init.rs:1981-1982` unconditionally calls
`publish_private_git_relay_list` for private repos. `src/lib/login/user.rs:164-185`
self-encrypts `[ ["g", canonical-relay] ]` using NIP-44 and signs kind **10318**
with encrypted content and no public tags (`src/lib/git_events.rs:157`).
`user.rs:624-696` merges existing entries, publishes to user write/discovery
relays, and falls back to default relays when none are configured. These drafts
add neither 10318 nor encryption/publication permissions. Before stock private
init can be accepted, separately review its existing effective capabilities and
restrict its discovery/write/default relay configuration to the private service;
no public fallback is acceptable. Do not bypass this by silently granting new
kinds or presenting hand-built events as full stock-ngit success.

Validation (source only, no keys, broker requests, or service interaction):

```sh
bun test poc/grasp/signing-policy-candidates.test.ts
```

The test imports updated Autopilot normalization, file-store/registry, and the
broker's exact-tag matcher. Disposable local stores save/reload **disabled**
drafts and history without losing exact arrays or assignments. Other candidate
predicates mirror the broker's content/count/byte/name/pair checks; this is not
an HTTP broker test. Unsigned source expectations pass; missing/wrong/duplicate
exact tags, duplicate d in both orders, extra destinations/values, slash changes,
role/publication metadata, and extra state refs fail. These are synthetic event
shapes, not captured ngit output, Git objects, or authenticated/populated success.

Required activation order, performed by the human/admin:

1. Obtain explicit user approval and restart Autopilot **from outside active
   sessions**, loading source 8143790 (or its verified descendant).
2. Verify live runtime exact-tag enforcement using an admin-controlled isolated
   test path, including duplicate d and extra destination rejection.
3. Save these **disabled** policies through supported administration. Verify
   persisted/compiled full arrays, limits, HTTP target, profile binding and trusted
   workspace conjunction. Manager's admin policy endpoint is broker-denied;
   manager cannot perform this step.
4. Admin enables only the reviewed grants, then reissues/newly issues the intended
   worker with trusted workspace context. Explicitly account for all matching
   Rick-profile/workspace sessions issued during this window.
5. Run positive/negative broker checks with the actual issued capability, including
   wrong repository, missing/duplicate d, extra destinations and noncanonical URL.
   Verify actual returned `expiresAt`; do not calculate a deadline from a presumed
   two-hour lifetime or reuse an earlier worker's expiry.
6. Resume the original PoC gates, retaining the stock private-init discovery-list
   gate above. Authenticated synthetic, distinct-peer FIPS, ngit Git operations,
   import, issue/PR, WMapp and recovery gates remain pending.

At completion disable **both** policies and revoke **every affected issued
snapshot**, including other matching sessions issued during the window. Edits or
disablement do not change existing snapshots. There is **no automatic policy
expiry**. Record each actual issuance expiry and revocation; reissue baseline
capabilities only if approved. No grant, admin, capability, app or runtime mutation
was performed for this correction; task remains in progress.
