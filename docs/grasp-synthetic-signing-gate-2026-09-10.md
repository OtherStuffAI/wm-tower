# Synthetic signing passes; stock private discovery remains blocked

Task `3455c77b-7781-47f8-85a8-024c6f784f9e`, fresh worker
`07295882-6dfb-4678-9e4e-f8f0e8262910`. This is a bounded diagnostic handoff,
not synthetic Git acceptance or completion of the GRASP/GitWorkshop PoC.

The actual broker signs canonical synthetic-root GET and kinds 22242, 30617,
30618. All 22 positive/negative checks pass with cryptographic verification and
request binding. The next stock private-init operation is blocked: native
`PrivateGitRelayList::to_event` self-encrypts successfully, then receives
`Nostr event kind is not allowed` for kind 10318. Reproduced twice with its
actual encrypted candidate. No relay Client is constructed by the diagnostic;
no signed fixture, announcement, state or encrypted list was published.

## Context and supported metadata

Own session metadata confirms Rick profile
`fd-npub1s46587g3k2axql224qz-2e5caefddd47ee874e8e5fc9-npub1hd37razr2rfxsw6dns5`
and workspace `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`, task binding, channel
`096d029e-0c3f-4ea5-a6bf-65ef6465bedb`, thread
`2d00e97d-9a83-4d4e-8d4f-723c11d6f01f`. Goal/reflect set through supported CLI.
Broker identity returns Rick, independently of workspace service membership.

CLI task show fails `NIP-98 origin is not allowed` both by default and with the
documented explicit Tower/app routing. Broker Flight Deck context, comments and
comment writes succeed; all comments were recovered with `has_more=false`.
That helper has no task-show action. Full task brief was recovered from the
provided handoff and local full execution document. Manager owns task state and
thread reports; this worker only posted task evidence.

Actual capability policy IDs/revisions and expiry are **unavailable**: supported
GET `/api/admin/signing-policies` signing is denied (`NIP-98 path is not allowed`);
the public identity route exposes no issuance metadata. No registry files,
other-session credentials, refresh/reissue, or inferred expiry used. Disk drafts
remain disabled historical copies; Pete enabled imported policies per the brief.
Admin must account for all matching issued snapshots and eventual disable/revoke;
this worker has neither changed grants nor revoked its own capability.

## Implemented diagnostic

- `poc/grasp/broker-gate.ts`: 4 allowed and 18 denied live requests. Rejects
  missing/duplicate d in both orders, wrong repository, extra/duplicate relay or
  clone values, wrong HTTP origin/path/repository/method. Signed fake-ref fixtures
  are discarded in memory and can never be published by this script.
- `broker-gate-result.json`: sanitized final live results, no tokens/signatures.
- `signed-response.ts` and tests: exact actor/kind/content/tag binding, signature
  verification, five-second broker timestamp window, error redaction.
- `signer-bridge.ts`: stdin/stdout subprocess adapter, no socket listener, shell,
  key storage or publication. Maps only the exact native synthetic-root GET
  candidate to NIP-98; ordinary Nostr kinds stay broker-constrained. Self-list
  encryption is limited to Rick and the sole canonical private relay.
- Isolated ngit patch adds explicit `NgitSigner::PocBroker` and native diagnostic
  example. It is **not wired into normal CLI login**. Stock binaries build, but
  stock init/clone/fetch/push have not run. Patch/pin recorded in `versions.json`.

Autopilot appends a signed `wm-session-capability` tag to HTTP events. The adapter
preserves it, allows exactly one correctly shaped trailing tag bound to this
session, and verifies the entire signature. It does not remove/re-sign tags or
use generic kind 27235 signing. The MAC is not independently authenticated by the
adapter; the broker's valid event signature and session binding are checked.
Autopilot owns `created_at`; every other candidate field is preserved. Ordering
nonce remains denied, and later replacement ordering is not accepted by this gate.

`NGIT_POC_PROBE_DISCOVERY=1` explicitly enables diagnostic submission of kind
10318 with empty public tags and bounded content to reproduce broker denial.
This predicate alone does not prove ciphertext contents. The reviewed native
caller constructs the self-encrypted sole-relay list. Unexpected signing success
aborts the example without publication. Default bridge use rejects 10318 locally.

## Validation and exact commands

From Tower:

```sh
bun poc/grasp/broker-gate.ts
bun test poc/grasp/signed-response.test.ts poc/grasp/signing-policy-candidates.test.ts
git diff --check
```

Results: 22/22 live checks; 10 source tests, 143 assertions; whitespace pass.
The initial HTTP metadata-only probe was strengthened after independent review;
the retained final gate checks the actual signed event and its custody tag.

From `/Users/mini/code/ngit-poc/ngit`:

```sh
PATH=/Users/mini/.rustup/toolchains/1.98.0-aarch64-apple-darwin/bin:$PATH cargo build --locked --bins --example poc_broker_gate
PATH=/Users/mini/.rustup/toolchains/1.98.0-aarch64-apple-darwin/bin:$PATH cargo test --locked --lib signer::
NGIT_POC_PROBE_DISCOVERY=1 NGIT_POC_BROKER_BRIDGE=/Users/mini/code/wm/tower/poc/grasp/signer-bridge.ts target/debug/examples/poc_broker_gate
```

Build passes; signer suite 8/8 passes, including response mutation, signature,
timestamp and custody negatives. Native diagnostic exits 1 twice:

```text
native ngit broker HTTP signer: pass (signature discarded)
Error: failed to sign event
Caused by:
    PoC broker: Nostr event kind is not allowed
```

Stock `cargo build --locked --bins` also passed using default Rust 1.91.1.
Examples/tests need serial_test 4.0.1 (Rust >=1.93.1); used already-installed 1.98
without changing dependency locks. `cargo clippy --locked --lib --example
poc_broker_gate` remains unavailable through the installed older Clippy driver,
which reports Rust 1.91.1 despite selecting the newer compiler for build/tests.
No dependency downgrade or toolchain install performed. Formatting ran; stable
rustfmt warns about upstream nightly-only formatting settings.

Independent reviewer `/root/review_adapter` accepted the final bounded
nonpublishing diagnostic after binding/error-redaction/custody tests were fixed.
This is not review acceptance of actual Git/private-init or deployment changes.

## Live evidence and remaining matrix

| Gate | Actual result |
| --- | --- |
| Fresh identity/workspace/profile | Confirmed through supported identity/context/session metadata |
| Positive/negative broker signing | 22/22 pass |
| Same-host canonical relay AUTH | Rick challenge signed; relay `OK`, accepted=true |
| Same-host authenticated Git | Root credential used on upload-pack discovery; 404, 31 bytes, no auth challenge; repository does not yet exist |
| Native ngit HTTP signer adapter | Pass; token discarded |
| Stock private-list conversion | Self-encryption succeeds; kind10318 signing denied twice |
| Stock private init | Not invoked; mandatory discovery step gated before any relay connection |
| Populated synthetic clone/fetch/push and privacy negatives | Pending |
| Distinct-peer FIPS, membership removal, read-only writer rejection | Pending |
| Flight Deck import, issues/PR, GitWorkshop/WMapp, persistence/restore | Pending later gates |

Live one-off relay/Git checks use the canonical host, not loopback/public alias.
They do not prove different-peer transport or confidentiality of populated content.
Prior 54 private-mode, 56 push-auth and 2 forwarder fixtures were not rerun or
relabelled as new live evidence. No Tower source/schema changed, so no Tower
runtime rebuild was needed. No service or Autopilot was restarted.

Resources remain the existing two GRASP PoC containers, volume
`tower-grasp-poc-data` (service secret unread), loopback nginx 60546 and managed
forwarder `12c563d2-a95f-42ef-b510-6eaa74daf22a` on canonical FIPS port 41007.
No frontend or populated repo was created. Unrelated Tower
`src/routes/wapp-management.ts` and `src/services/wapp-scope-access.ts` remain
untouched and outside these commits; original Flight Deck source/remotes/releases
and Autopilot code were not modified.

## Smallest next scoped work

Pinned init.rs:1981–1982 unconditionally calls `publish_private_git_relay_list`;
login/user.rs:624–696 uses account discovery/write relays with default fallback.
`--repo-relay-only` does not skip that account update. A generic signer adapter
cannot satisfy this step under current signing grants.

Manager should commission a focused decision/implementation for either an
explicit synthetic-only private-init mode that omits account discovery and
enforces private destinations, or separately reviewed discovery-list authority
with private-only discovery/write configuration. Do not silently skip the step,
grant10318, enable public defaults or call a hand-built announcement stock-init
success. The current work stops at the repeated broker denial as instructed.
CLI signer acquisition and private URL handling still need implementation and
native integration testing after that choice. No final-repo/collaboration policy
expansion is proposed before synthetic and different-peer gates pass.
