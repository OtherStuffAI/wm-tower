# Document editor sessions and explicit device takeover

An open document can checkpoint through the existing canonical body PATCH. It does not need a new shared-draft family. Tower remains the editing authority, while each client retains durable local drafts and existing typed recovery versions. This protocol is additive: ordinary Save from older native, Android, web and agent clients continues to work.

## Wire contract

`POST /api/v4/flightdeck-pg/workspaces/:workspaceId/edit-leases/acquire` accepts the existing entity/TTL fields. Documents optionally add `document_edit_protocol: "document_edit_session_v1"` and a random UUID `editor_session_id` for that open editor. The pair is required together. Task and scope leases keep their previous semantics. Document field leases are unsupported: the authority covers the entire document.

Every active document lease conflicts with an ordinary acquire, including one held by the same actor on another device. Conflict responses retain top-level holder/expiry and add `lease`, `lease_id` and the same values under `details`, without exposing a token or editor session. A session holding its token renews it; an acquire never silently rotates its authority.

A user may explicitly take over their own editing session by sending the protocol/session pair, `takeover: true` and the last inspected `expected_lease_id`. Use a fresh editor session UUID for the takeover. The request fails if the lease changed or belongs to another actor. It never grants a cross-actor override.

A successful takeover, in one transaction:

1. Locks the same document row that canonical body, metadata and recovery-promotion mutations lock.
2. Checks that the observed active lease still matches.
3. Marks **all** prior document lease rows released and superseded. Their tokens can neither renew nor commit canonical edits. A session-aware superseded editor cannot reacquire, including after the successor expires.
4. Advances document `row_version`, keeps its content, title, metadata and storage identity, and snapshots the unchanged content at that new version. This is an authority barrier, not a user body edit. History's existing `updated` operation is retained; a `doc.edit.takeover` audit and `doc.updated` outbox event explicitly identify `authority_barrier: true`.
5. Issues a new token and returns the coherent post-barrier `doc` and `canonical_version`, `taken_over: true` and the protocol echo. No typing by the new device is required for the barrier to protect the document.

GET lease inspection advertises the protocol without acquiring or renewing. Document renewal distinguishes intact expiry (`lease_expired`) from durable supersession (`document_edit_session_superseded`), while unknown/released tokens return `lease_invalid`. New session-aware acquire and renewal responses echo the protocol and their own session ID; inspection never exposes any session ID or token. New clients must require the protocol echo before treating takeover as available. Old servers may ignore unknown request fields, so a successful ordinary acquire alone is not proof of takeover safety.

Canonical document metadata PATCH requires an expected `row_version`; archive-only PATCH keeps its lease exemption but still requires the version. Archive combined with mentions or other metadata requires a lease. Recovery-only body submissions with `base_available: false` retain the supported no-canonical-lease path and cannot change the head. Body/title recovery remains atomic.

## Legacy compatibility and its boundary

A legacy client whose revoked lease expires may later acquire a new lease, since it has no editor-session identity. Its captured pre-takeover base is now stale even when the body hash is unchanged: a body save becomes the existing typed recovery, and a title-only stale-version save is rejected. Existing native/web clients retain captured base identity while their drafts are dirty. This protection does not claim to fence arbitrary clients that intentionally reload a new base and label divergent old content as edits to it. Such reconciliation must remain a deliberate user action; session-aware clients additionally keep durable supersession identity and stop automatic authority acquisition after loss.

A lost acquire/takeover response cannot recover a raw token stored only as a hash. Retrying cannot silently rotate the current lease: inspect again and resolve through a deliberate new takeover or wait for expiry. Keep the local draft throughout this uncertainty.

## Client obligations

Preserve local divergent content before takeover using local durability and, where desired, the existing non-head recovery API. After takeover, fetch and verify the returned latest remote body and apply content, title and base identity together before enabling editing. Do not silently rebase divergent content or reuse a superseded editor session. Ignore late renew/save/release responses belonging to an older editor generation. Release and renewal use the exact token and cannot resurrect or revoke a successor.

Remote autosave must serialize saves, skip unchanged bodies, retain fresh typing during an in-flight save, and retry recoverable offline failure without deleting local drafts or the last successful cloud checkpoint. A one-minute active-editor guarantee does not imply background execution on suspended iOS.

## Validation and activation

`tests/document-edit-session.test.ts` requires an explicit disposable PostgreSQL port in `DOCUMENT_EDIT_TEST_PORT` and refuses port 5432. It exercises legacy Save, same-actor conflicts, explicit takeover, coherent barrier snapshots, old-token rejection, persistent supersession, unchanged old-base recovery after successor expiry, cross-actor denial, concurrent acquisition, document-lock ordering and rollback of authority/head/history/audit as one transaction. It uses synthetic identities/documents only.

Source tests do not activate the managed Tower. Build/restart and authenticated live smoke checks belong to the authorized runtime owner. Do not advertise live takeover until the serving Tower echoes this protocol and the clients are installed/serving.
