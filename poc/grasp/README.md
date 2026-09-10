# Private GRASP PoC operations

This is a partial, local deployment for task `3455c77b-7781-47f8-85a8-024c6f784f9e`.
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
WebSocket streaming. The native Autopilot adapter and canonical FIPS address
remain to be allocated and tested.

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
localhost HTTP. The manager should arrange an allocated canonical FIPS origin
and a narrow policy assignment/reissue through supported administration. Do not
broaden the baseline or change Tower authentication to get past this gate.

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
