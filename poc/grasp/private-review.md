# Private review import

`private-review.ts` operates a separately authorized review coordinate on an
existing private FIPS GRASP service. It does not change signing policies,
membership, service configuration, synthetic repositories or public relays.
It uses the session's stable broker identity, direct NIP-34 publication and
GRASP-08 Smart HTTP; no ngit login, raw keys or anonymous contributor endpoint.

Put the reviewed `ReviewPlan` JSON and runtime evidence under Git-ignored,
untracked `tmp/docs/handoffs/`. The plan includes exact unsigned announcement,
two-ref state and kind-1618 PR templates, source path and selected destinations.
Pass the independently reviewed SHA256 of that JSON as a required argument:

```sh
bun poc/grasp/private-review.ts plan CONFIG SHA256
bun poc/grasp/private-review.ts check-signing CONFIG SHA256
bun poc/grasp/private-review.ts publish CONFIG SHA256
```

`plan` is offline, validates topology, prepares an isolated bare repository with
only the two pinned refs and reports the exact diff files. The
signing check obtains the exact publication signatures and HTTP credential
without publication; it stops on the first denial. Run it only when the operator
has supplied the requested permission. `publish` repeats those checks, then
requires anonymous denial and real NIP-42 authentication. It creates an isolated
bare staging repository, imports only the two pinned refs from local source,
publishes signed announcement/state, pushes those explicit refs and publishes
the PR. It verifies relay acknowledgements, authenticated PR-list/event readback,
fresh Git fetch, commits, full diff and object integrity. No mirror/all-ref push,
public discovery or remote fallback is used. Signed HTTP headers stay in the
short-lived Git child environment; broker credentials never enter Git children.
Commands stop within the service's 60-second credential window. Large imports
that exceed it require a reviewed transport improvement, not weaker grants.

Live operation records stay in the ignored config directory, including exact
signed publication events (never authentication tokens). A previous publication
attempt prevents automatic reruns. Inspect partial ACKs and existing refs before
designing a resume; do not delete the evidence and blindly publish again.
Positive `purgatory:` ACKs are pending until authenticated readback succeeds.

Policy drafts must be validated against the live Autopilot schema. Its current
resolver rejects overlapping custom-kind rules, even when exact tags differ.
An operator must arrange non-overlapping assignments or a temporary policy
switch, then enable and reissue the session through supported admin controls.
The runner cannot approve or perform that switch. Content length constraints
are not content hashes or one-shot grants; the reviewed config hash binds the
runner's content and an operator should revoke temporary authority afterwards.

The returned URL is a hosted PR route only after successful readback. Native UI
acceptance remains separate: a real member must approve the service/authentication
in a current host and verify the PR list, detail, files and diff. Do not inject a
fake reviewer identity or claim an unperformed device test.

Validation: `bun test poc/grasp/private-review-plan.test.ts` plus an offline plan
against the exact prepared upstream commit. These PoC tools change no Tower
backend source/schema and require no Tower or Autopilot restart.
