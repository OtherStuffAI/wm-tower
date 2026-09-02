# Agent Chat Trigger Contract

Status: legacy compatibility only
Last updated: 2026-04-08

## Scope

This note preserves the older trigger-record storage contract from Tower phase 2 work package 06.

It is not the normative runtime contract for the current agent-first Agent Chat model. For the active runtime path, see `docs/design/agent-chat-group-metadata-contract.md`.

## Current Position

- Tower still does not need a trigger-specific route for `agent_chat_trigger_v1`.
- If a legacy client persists a trigger rule, it still uses the generic records sync and fetch paths.
- Tower treats the trigger family like any other app-namespaced `record_family_hash`.
- Tower does not require any trigger record for normal Agent Chat runtime, candidate agent selection, or message-group resolution.

## Legacy Record Shape

- `record_family_hash` stays app-namespaced.
- The inner decrypted payload shape remains Flight Deck-owned.
- Tower stores the owner payload and any group payloads opaquely. It does not inspect trigger fields.

## Legacy Read Path

- Legacy trigger fetch remains:
  - `GET /api/v4/records?owner_npub=<workspace_owner_npub>&record_family_hash=<app-family>:agent_chat_trigger`
- Visibility remains the normal records contract:
  - workspace owner can read owner-visible records
  - non-owner actors can read only if they have a readable group payload for a current or historical epoch they still hold

## Auditability

Generic record-read responses include a top-level `audit` block:

```json
{
  "audit": {
    "workspace_owner_npub": "npub1...",
    "actor_npub": "npub1...",
    "ws_key_npub": "npub1... or null"
  }
}
```

Meaning:

- `workspace_owner_npub`: workspace authority and record owner namespace
- `actor_npub`: resolved real actor after `ws_key_npub` mapping
- `ws_key_npub`: signer session key when the request was made through a registered workspace key, otherwise `null`

## Conclusion

- Trigger records are still readable and writable through generic record routes for compatibility.
- Trigger records are no longer a required Tower-side dependency for Agent Chat runtime.
