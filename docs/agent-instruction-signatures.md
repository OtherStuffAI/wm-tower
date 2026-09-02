# Agent Instruction Signatures

Tower is the PG chat persistence boundary for messages that can trigger
Autopilot agents. New PG chat message writes must include `message_signature`,
and Tower validates it before inserting the row or emitting an outbox event.

The signature wrapper is stored in message metadata as
`metadata.agent_instruction_signature`:

- `version: 1`
- `protocol: "flightdeck_pg_message_instruction"`
- `kind: 33358`
- `signer_npub`
- `body_sha256`
- `nostr_event`

The nested Nostr event is kind `33358`. Its `content` must exactly equal the
message body. It must include `protocol`, `body_sha256`, `workspace_id`, and
`channel_id` tags; thread replies also include `thread_id`.

Tower validates:

1. the Nostr event signature;
2. exact body equality between event content and request body;
3. body hash equality;
4. signer npub equals the NIP-98 authenticated actor;
5. workspace, channel, and thread tags match the route context.

Autopilot must still reverify the stored metadata before executing. Tower's
validation prevents unsigned or tampered writes from entering the PG event
stream, and Autopilot's validation protects the final action boundary.
