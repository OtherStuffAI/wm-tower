# Private GRASP PoC

This directory contains the synthetic-only PoC adapters and validation tools.
It does not authorize importing a real repository, publishing publicly, changing
signing grants, or claiming a distinct-device test. Read the current authorized
Flight Deck task and ignored handoff before operating an existing instance.
Run-specific addresses, membership, results, screenshots and backups belong in
Git-ignored `tmp/docs/handoffs/`, never in tracked documentation.

## Existing instance

Preserve the existing `local.env`, repository, cache and volume. Do not repeat
`synthetic-ngit.ts init`, `resume-init`, `clone` or `update` on an initialized
instance. `versions.json` and the patches record the compatible software pins.
The synthetic runner and signing candidate constraints are deliberately narrow;
changing them requires review of the original signing/publication boundaries.

The private service has its own identity in `/data`; inspect only the public
NIP-11 identity. Never read or print its key. GRASP runs on an internal Docker
network configured without external peers or fallback relays; ingress publishes loopback
only. Keep Sync+, GRASP-06 and external relay discovery disabled.

## Membership refresh

`refresh-membership.py` reads the explicitly bound workspace using the current
broker-aware CLI. It rejects a changed identity binding, incomplete pagination,
invalid members or an absent owner before updating `local.env`. Review the
captured public membership in ignored handoff storage. Configuration changes do
not take effect until the two PoC containers are recreated:

```sh
docker compose --env-file poc/grasp/local.env -f docker-compose.grasp-poc.yml up -d --no-build --no-deps --force-recreate grasp-poc
docker compose --env-file poc/grasp/local.env -f docker-compose.grasp-poc.yml up -d --no-build --no-deps --force-recreate grasp-ingress
```

Recreating ingress refreshes its upstream DNS. This procedure closes existing
sessions; it is not selective hot revocation. Removed members lose future
access, but downloaded copies remain. Workspace read membership does not confer
canonical repository maintainership. Recreate only within current authorization.

## Access and recovery gate

`access-recovery-gate.ts` requires a private ignored JSON configuration with:

- `root`, `relay`, `frontend`: canonical synthetic URLs.
- `main`, `rootOid`: actual existing synthetic commits, never invented hashes.
- `live`, `ingress`, `volume`: existing PoC container/volume names.
- `composeFile`, `envFile`: the authorized PoC Compose files.
- `evidence`: a new ignored directory; created with mode 0700.
- `isolatedName`, `isolatedVolume`: unique disposable restore names.

```sh
bun poc/grasp/access-recovery-gate.ts tmp/docs/handoffs/run/config.json > tmp/docs/handoffs/run/run.log 2>&1
```

The runner verifies the live baseline, tests nonmember receive-pack and rejected
relay authentication, and obtains a fresh broker credential. It stops only the
PoC pair, requires a clean writer exit, and archives the complete read-only
volume into a private mode-0600 tar. It recreates the live pair in `finally` and
compares public identity, all Git refs, and signed synthetic announcement/state
IDs and hashes. A failure remains recorded; absence of later results is pending.

It restores into a new volume using the same image and canonical configuration,
adds one in-memory fixture member, and starts with `--network none` and no ports.
HTTP and WebSocket probes travel through `docker exec` standard streams. No
restored address is registered or published. It compares data, runs `git fsck`,
and compares reachable objects, then tests auth age/signature/challenge/relay,
canonical state and actual receive-pack ref denial, and member removal by
configuration replacement plus recreation. Rick retains broker signing; fixture
signing is never evidence of Rick's publisher operations. The isolated container
is stopped in `finally`; volumes and archives remain private for review.

`resume: true` reuses a recorded snapshot only after verifying its hash and the
unchanged live baseline. Supply a fresh isolated name/volume for every retry.
It does not repeat the live snapshot/recreation. Historical failed attempts stay
in the result array; reviewers must distinguish harness failures from gates.

The underlying snapshot/restore operations are:

```sh
# With the writer cleanly stopped; use exact reviewed names and an existing image.
docker run --rm --network none --entrypoint tar -v "$source_volume:/source:ro" -v "$private_backup:/backup" "$image" -C /source -cpf /backup/volume.tar .
chmod 600 "$private_backup/volume.tar"
shasum -a 256 "$private_backup/volume.tar"
docker volume create "$restore_volume"
docker run --rm --network none --entrypoint tar -v "$restore_volume:/restore" -v "$private_backup:/backup:ro" "$image" -C /restore -xpf /backup/volume.tar
```

Never extract or display the archive to inspect identity. It contains private
service state. Never attach a restored instance to a live network or publish it.
Synthetic recovery covers the actual synthetic data only; issue/PR recovery and
real repository import remain outside this gate.

## Unavailable transport and validation

On macOS, `unavailable-gate.ts` uses a process-local sandbox to deny outbound TCP
to the canonical relay port while a fresh native ngit cache attempts discovery.
Add `ngitBin` to the private configuration. This preserves the host FIPS bridge
and live services. Run it alongside the existing native destination-spy test,
which checks alternative relay/Git targets are rejected before dialing. A fresh
browser context should independently record all attempted destinations while
simulating a failed private relay, then verify normal list-to-code access.
These are same-host controls, not a distinct FIPS peer or Pete's WMapp test.

```sh
bun poc/grasp/unavailable-gate.ts tmp/docs/handoffs/run/config.json
bun test poc/grasp/signed-response.test.ts poc/grasp/signing-policy-candidates.test.ts poc/grasp/destination-spy.test.ts
node --test poc/grasp/forwarder/server.test.mjs
```

In the pinned ngit-grasp checkout, run its native `private_mode` and
`push_authorization` integration suites with a canonical temporary directory
and inherited Git author/committer variables cleared. Source-only checks cannot
replace live PoC validation. Tower backend source/schema changes additionally
require Tower's own rebuild and tests; the PoC gate tools do not change that API.
