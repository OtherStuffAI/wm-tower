# Task and document comment mentions

Comment creation accepts explicit `mentions` or `metadata.mentions` entries with
`type: "person" | "agent"`, a full `npub`, and an optional label. Top-level
`mentions` takes precedence when supplied. Tower preserves the explicit type,
resolves the actor identity to its canonical `actor_id` and `npub`, and checks
that the target actor can read the comment's task or document in its channel.
Invalid, unknown, or inaccessible targets fail before the comment is created.
Mentions never grant access.

Clients insert visible canonical Markdown and matching structured identities
from the same selection, for example:

```json
{
  "body": "Please review @[Reviewer](mention:agent:<npub>).",
  "mentions": [{ "type": "agent", "npub": "<npub>", "label": "Reviewer" }]
}
```

Visible body markup alone does not produce structured routing authority. Labels
are presentation, while resolved actor identities identify recipients. There is
no body scan, historical rewrite, additional signing protocol, or change to the
existing NIP-98 request authorization.

Task comment creation events retain all canonical person and agent entries in
`payload.mentions` and the serialized comment metadata. Task Direct consumers
select agent entries by type and route by the actual npub. Document comment
creation events also retain both types, but
`flightdeck_pg.document_comment_mention_added` contains only agent entries in
`added_mentions`. Person-only comments and replies emit no agent instruction
event. Document resolve/reopen status changes preserve the original mentions.

This additive correction applies only to comment create/reply paths. Chat and
task/document body mentions retain their existing legacy canonical wire shape.
It does not add comment body editing or task comment replies. Existing stored
comments are not rewritten; their canonical visible tags remain renderable.

Regression coverage: `tests/flightdeck-pg-comment-mentions.test.ts` validates
parsing and legacy compatibility. The isolated comment mention case in
`tests/flightdeck-pg-api.test.ts` exercises signed requests against a disposable
Postgres database, persisted readback, permission rejection and outbox payloads.
Source tests are separate from rebuilding the managed Tower runtime and its
subsequent live smoke check.
