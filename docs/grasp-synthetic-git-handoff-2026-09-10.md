# Synthetic publisher Git works over same-host FIPS

Task `3455c77b-7781-47f8-85a8-024c6f784f9e`; worker
`07295882-6dfb-4678-9e4e-f8f0e8262910`. The fresh broker gate passes, and the
isolated patched ngit/git-remote-nostr now pushes, clones and fetches real
synthetic commits through the canonical FIPS endpoint. Populated member reads
and anonymous/nonmember read denials pass. **Different-peer acceptance and the
complete synthetic privacy matrix remain pending. No real Flight Deck import
or GitWorkshop-ready claim is made.**

This supersedes the stopping recommendation in the earlier
[signing diagnostic checkpoint](grasp-synthetic-signing-gate-2026-09-10.md).
The latest manager task comment `0b26dacd-1d46-4750-81e3-16256c226657` requested
assessment/implementation of a bounded private-service-only path. Work continued
under the existing grants, without adding kind10318 or public destinations.

## Identity, authority and reporting

Supported session metadata confirms the routed task, Rick profile and workspace
`2e5caefd-dd65-45d2-b747-ee874e8e5fc9`; broker identity independently confirms
Rick's stable signer. Own goal/reflect is set. Manager owns task state and thread
reporting. Task context/comments and evidence writes use the broker-aware helper;
CLI task show remains origin-denied, and the full brief was recovered from the
provided/local handoff. Latest task comments were read before handoff.

Policy IDs/revisions and issuance expiry remain unavailable from supported public
metadata: identity returns actor/owner only, and the policy-admin signing request
is path-denied. Disk drafts are historical disabled copies, not the enabled
imported policy metadata. No registry files or other-session credentials were
used; no capability reissue, grant mutation, raw key export or Autopilot restart.

## Actual content and endpoints

- Root: `b2ea16d05f0e8216f15aafed0722148742e61668`, README with two synthetic lines.
- Final main: `7ebaba9536f086314c407318859078e0998257d7`, adds `second.txt`.
- Source: `/Users/mini/code/wm/tower/.runtime/grasp-synthetic/source`.
- Fresh clone: `/Users/mini/code/wm/tower/.runtime/grasp-synthetic/clone`.
- Separate caches: `.runtime/grasp-synthetic/cache` and `clone-cache`.
- Source and clone both resolve to final main; second-file content was checked.
- Canonical Git URL:
  `http://npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74.fips:41007/npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr/synthetic.git`.
- Relay:
  `ws://npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74.fips:41007/`.
- Nostr remote:
  `nostr://npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr/ws%3A%2F%2Fnpub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74.fips%3A41007%2F/synthetic`.

Only actual-content repository announcement/state events were published, solely
to the private relay. Fake-ref signing fixtures and encrypted discovery probes
were never published. GRASP service keys remain unread in `tower-grasp-poc-data`.
Two existing PoC containers, nginx60546 and managed forwarder
`12c563d2-a95f-42ef-b510-6eaa74daf22a`/41007 remain in place; no restart performed.

## Compatibility changes and reproduced failures

Stock ngit3.0.0 only supports local keys or Bunker. The diagnostic patch
`2f03694ec4b7c7e4c41b5f3cf96ceae0c2c91999` adds a subprocess broker signer.
It maps exact synthetic-root HTTP GET to the NIP-98 broker, validates signed
responses and the broker's HTTP custody tag, redacts errors and retains no keys.
The native discovery conversion self-encrypts successfully but kind10318 signing
is denied twice. Stock private init remains incompatible with the grants.

The explicit private-service patch is ngit
`c2a7a35e1b8752ae23a6a8c0577d295138b4e346`, on isolated branch
`poc/grasp-broker-diagnostic` above upstream `c2cc591dcfae5d46dc178c0ea87e8bc1802f09b3`:

1. `NGIT_POC_PRIVATE_SERVICE=1` explicitly acquires Rick through the broker and
   supplies only the canonical private relay. It avoids credential-store and
   public profile discovery. Normal CLI use does not enable this mode.
2. All Client relay-add paths reject other destinations. Defaults/indexers/blasters
   are replaced or removed, and the signer is attached before private relay reads.
3. `require_repo` permits only private synthetic metadata, sole Rick maintainer,
   exact clone/relay, empty web and no extra role/publication metadata. Only after
   that validation does this mode omit the account discovery-list publication.
4. Git credential preparation **and actual list/fetch/push transport entrypoints**
   reject other URLs. Fetch/push HTTP redirects are disabled in this mode.
5. Stock init inserted a default GitWorkshop web URL; first attempts stopped
   before publication. The mode now defaults web to empty; explicitly supplied
   web metadata still fails validation.
6. First publication succeeded, but initial Git transfer failed with
   `ERR authorisation failed: No state events in purgatory`. Stock detection
   extracted the FIPS hostname npub instead of the repository path npub, so it
   skipped GRASP state prepublication. Classifier/extraction now use the path.
7. The next push could not publish state because normalization truncated the
   hostname at its first `npub1`, deriving relay `http`. Normalization now removes
   a repository namespace only within the path, preserving FIPS host/port.
   Mode-only rendering preserves the canonical relay's required trailing slash.
8. Recovery via ordinary `git push -u origin main` then published accepted state
   and transferred objects successfully. Fresh clone, second push and fetch pass.

No server-side authentication change, grant expansion, hand-built repository
event substitution, or private-key workaround was used. ngit's log labels its
HTTP protocol `unauthenticated`; that means no ordinary Git credentials. The
private NIP-98 header is installed, and independent HTTP checks prove anonymous
requests are denied while member credentials retrieve the actual main ref.

Patch files and checksums are in `poc/grasp/versions.json`. Apply the two recorded
zero-context implementation patches and the separate spy-test patch in order with
`git apply --unidiff-zero`, or use the commits. Spy commit:
`bc1b89164308ef63590956252799781172f04d29`.
Original upstream remotes are unchanged. Original Flight Deck and Autopilot code,
remotes and releases were not modified. Concurrent Tower wapp files remain outside
all PoC commits; no Tower backend source/schema changed or runtime rebuild needed.

## Commands and validation

From Tower, the actual sequence was:

```sh
bun poc/grasp/broker-gate.ts
bun poc/grasp/synthetic-ngit.ts init
# Inspected prepublication refusal; then explicit retry after web fix:
bun poc/grasp/synthetic-ngit.ts resume-init
# After the native FIPS URL fixes, recovery succeeded:
bun poc/grasp/synthetic-ngit.ts push
bun poc/grasp/synthetic-ngit.ts clone
bun poc/grasp/synthetic-ngit.ts update
bun poc/grasp/synthetic-ngit.ts fetch
bun poc/grasp/privacy-gate.ts 7ebaba9536f086314c407318859078e0998257d7
bun test poc/grasp/signed-response.test.ts poc/grasp/signing-policy-candidates.test.ts poc/grasp/destination-spy.test.ts
```

The fixed runner removes inherited GIT_/NGIT_ variables, uses no system/global
Git config, checks fresh source/cache before initial init, verifies real main-only
refs/no remotes, disables Tor probing and prevents accidental repeated clone or
second-commit generation. `resume-init` was for inspected prepublication failures;
do not rerun it against the now-announced repository. Recovery uses `push`.

Native commands, from the isolated ngit checkout, with installed Rust1.98 bin
directory prepended to PATH:

```sh
cargo build --locked --bins --example poc_destination_probe
cargo test --locked --lib repo_ref::
cargo test --locked --lib poc_private::
cargo test --locked --lib signer::
```

Results: build passes; 197 repository-reference/URL tests, 3 private-mode tests,
8 signer tests pass. Tower tests:11 pass,146 assertions. Formatting and diff
whitespace checks pass. Clippy remains unavailable via the installed older driver
as recorded in the earlier checkpoint; no dependency downgrade/toolchain install.

Independent reviewer `/root/review_adapter` accepted the final scoped same-host
publisher Git/privacy path, including actual source/clone commit equality. It did
not accept arbitrary commands, distinct-peer access, member-role/removal/expiry or
full PoC completion.

The additional network-spy test clears broker capability/session environment,
injects malicious fallback lists and a malicious private relay hint into the
native client, then exercises connect, relay query, relay send, Git list, fetch
and push against a loopback TCP trap. Each must return the exact destination
guard denial, and the trap observes zero connections. This proves pre-network
destination rejection for these six entrypoints, not remote authorization or
the still-pending member-role tests. The native test fixture event is ephemeral
and never published.

## Gate matrix and next supervised continuation

| Gate | Result |
| --- | --- |
| Fresh broker allow/deny | 22/22 pass; signed fields/signatures checked |
| Actual private announcement/main state | Accepted on canonical private relay |
| Native initial push, fresh clone, second push, fetch | Pass with matching actual commits |
| Populated member Git/read | 200, expected main advertised |
| Anonymous/nonmember/wrong-repo/invalid-token Git read | 401, zero response body |
| Anonymous relay subscription | Explicit auth-required CLOSED |
| Nonmember relay AUTH | Explicit rejection, no repository events |
| Member relay subscription | Verified announcement and final main state |
| Distinct-peer FIPS | **Pending; current worker executes on service host** |
| Nonmember Git push; post-denial nonmember relay REQ | Pending |
| Read-only member writes; member removal; expiry; FIPS unavailable | Pending |
| Import/final-repo policy/collaboration/frontend/recovery | Pending, not authorized by passing this partial matrix |

`privacy-gate-result.json` records8/8 checks. The nonmember uses a fresh in-memory
fixture key solely for rejection tests; it is never exported, saved or used as a
publisher. Prior54/56 GRASP fixture and2 forwarder tests remain prior evidence.

The concrete external dependency is a distinct FIPS peer with its **own** supported
signer/capability execution context. Local `fipsctl --help` exposes node/probe
operations, not remote command execution; a local probe is not a peer-originated
Git/relay test. No other-session credentials or SSH keys were sought. Manager must
route a peer worker/device test and the remaining role/revocation tests, preserving
the exact synthetic grants. Peer test: fresh cache, canonical discovery, member
Git read/clone at the recorded final main, authenticated relay query, anonymous
denial, then uncached failure with FIPS unavailable. Record peer identity/device,
time and actual outputs. Do not copy this worker's capability to that peer.

No final-repo or issue/PR grant expansion is proposed until synthetic negatives
and distinct-peer acceptance pass. Policies have no automatic expiry; manager/admin
still owns accurate issuance metadata and eventual disable/revoke of every affected
snapshot. Task state and next supervised continuation remain manager-owned.
