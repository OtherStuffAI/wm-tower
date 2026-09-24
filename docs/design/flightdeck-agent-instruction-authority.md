# Flight Deck agent instruction authority

Tower proves who initiated a Flight Deck PG action; Autopilot decides whether that
npub may instruct the selected agent. Workspace membership, assignment, labels,
quoted text and caller-supplied metadata are never instruction grants.

## Trusted actor evidence

| Dispatch family | Authoritative actor source | Consumer evidence |
| --- | --- | --- |
| Agent Direct chat message | The exact message body is signed by the Nostr key whose npub equals the strict NIP-98 authenticated actor. Tower verifies the signature, body hash, protocol/kind, workspace, channel and thread (plus message ID/revision for edits) before persistence. | `created_by_actor_id`, server-resolved `created_by_actor_npub`/`sender_npub`, and `metadata.agent_instruction_signature`. Missing, invalid, cross-actor, cross-workspace, cross-channel, cross-thread and stale-revision signatures are rejected. |
| Task creation | Strict NIP-98 signer resolved by Tower to the workspace actor used for `created_by_actor_id`; request `author` metadata is not read as identity. | Task `created_by_actor_id` and server-resolved `created_by_actor_npub`/`sender_npub`; the creation outbox payload also contains server-derived `author.actor_id`, `author.actor_npub` and transport `author.signer_npub`. |
| Task comment | Same strict NIP-98-to-workspace-actor binding as task creation. | Comment `created_by_actor_id`, server-resolved `created_by_actor_npub`/`sender_npub`, and the creation outbox's server-derived `author` object. |
| Approval request | `requested_by_actor_id` and `requested_by_npub` are populated from the authenticated request context, never from descriptive metadata. | Typed approval request actor fields. |
| Approval decision | `reviewer_*` and (for approval) `approver_*` are populated from the authenticated request context after the workroom approver and channel authorization checks. | Typed approval decision actor fields and status timestamps. |

The NIP-98 `signer_npub` in an outbox author object is transport/audit evidence.
The canonical initiating identity for `canInstruct(agentId, actorNpub)` is the
server-resolved actor npub. A workspace key or delegated signer may authenticate a
request on behalf of that actor, so consumers must not substitute the transport
signer for the actor without applying Tower's identity resolution rules.

## Consumer rule

Autopilot must accept actor evidence only from authenticated Tower typed routes,
record-sync rows plus their actor directory, or access-filtered Tower outbox/SSE
events. It must still call its own `canInstruct` decision for every newly actionable
record. Older thread content is context, not a new instruction.

Tower stores public Autopilot connection and selected-agent references only. It
does not proxy execution and rejects connection payloads containing credential,
token, private-key, password, bearer or bunker-URI shaped fields.
