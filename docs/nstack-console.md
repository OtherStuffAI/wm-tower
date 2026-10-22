# NStack workspace console

`/ui` is the workspace-first browser console. Connect a NIP-07 signer, choose an
accessible workspace, or create an encrypted-record workspace through guided
name/review/setup steps. Setup generates workspace and group identities in the
browser, wraps their keys with the signer's NIP-44 encryption, and submits the
existing authenticated workspace contract. Prepared ciphertext is retained for
the review: retry first checks the generated workspace identity and reuses the
same payload. Personal keys are never requested or exported.

The active workspace stays explicit. Switching clears workspace data and closes
setup/review dialogs; generation checks discard stale reads. Workspace names and
descriptions can be edited only after the existing manager-only API succeeds.

App cards show registered namespaces and their enabled flags, never online
status. Registration starts with no declared capabilities. A review identifies
the target workspace and app public key before saving. Namespace disable/enable
requires confirmation and explicitly does not revoke independent browser
consent, device keys, membership or app grants. Connection instructions provide
the existing public connection token with a copy action; consent still happens
through the app's supported flow.

Both encrypted-record and typed app workspaces are discovered through their own
APIs. Typed entries use the authoritative UUID and declared app identity. They
remain distinct from legacy namespaces, including where the server supplies a
backing workspace mapping. Their usage uses the supported UUID category report;
generic namespace editing and object listing are not inferred from that mapping.
Typed files and integrations are managed in the owning app.

Storage offers paginated registered-object metadata, visibility/upload filters,
server-authorized access inspection and explicit downloads. It does not invent
publication, deletion or ACL editing. Encrypted downloads remain encrypted.
Legacy logical counters and typed category reports state their coverage;
unavailable values are never rendered as zero or physical disk totals.

The supplied white SVG master, Inter font and solid navy/purple/orange tokens
form the responsive shell. Native controls and modal dialogs support keyboard
navigation, visible focus, Escape and focus return. `/ui/advanced` preserves the
previous developer dashboard and billing. `/admin`, `/docs` and `/table-viewer`
keep their access rules.

Browser crypto is bundled from locked dependencies with `bun run console:build`.
The generated asset and its licences are committed for Docker runtime serving.
Run `bunx playwright install chromium` once, then `bun run console:test` for the
disposable browser fixture suite. It verifies real NIP-98 signatures and decrypts
setup ciphertext, exercises app confirmation and connection handoff, checks stale
responses and denied access, and covers desktop/mobile and keyboard behavior.
The fixture suite never contacts a real workspace. Live activation and database
validation follow the repository's Tower-only lifecycle rules.
