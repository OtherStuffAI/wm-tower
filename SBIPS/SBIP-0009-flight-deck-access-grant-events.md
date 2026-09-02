# SBIP-0009: Flight Deck Access-Grant Events

- Status: Draft
- Type: Standards Track
- Created: 2026-06-06
- Requires: SBIP-0001, SBIP-0002, SBIP-0003, SBIP-0008, SBIP-0090

## Abstract

This document defines the Nostr event used to announce that a recipient npub has
been added to a Wingman Flight Deck workspace or workspace group.

The event is a discovery and onboarding signal only. Tower remains authoritative
for workspace, group, record, and storage authorization.

## Motivation

Flight Deck, Yoke, and Autopilot need a shared way to discover new workspace
access without relying on copied links or manual Agent Connect import. When an
operator adds a human or agent npub to a workspace or group, clients should be
able to learn that a bootstrap package exists, verify the current grant through
Tower, and then sync the workspace normally.

## Specification

### Event Kind

The access-grant announcement uses Nostr kind `33357`.

Kind `33357` is in the Nostr addressable event range, so the event MUST include
a `d` tag and relays are expected to keep only the latest event for each
`kind + pubkey + d` coordinate. This is intentional: issuers can replace stale
bootstrap details, and clients can address a grant announcement without relying
on a mutable relay-specific event id.

### Event Publisher

The event MAY be signed by:

- the human or agent issuer that added the recipient, or
- the Tower service npub when Tower publishes as part of an authorized
  membership mutation.

The logical issuer MUST still be included in the encrypted payload and the
public `issuer` tag. Clients MUST NOT treat either the event publisher or the
logical issuer as sufficient proof of access. Current access MUST be verified
through Tower with NIP-98 as the recipient.

### Public Tags

The event MUST include these tags:

```json
[
  ["d", "<dedupe_key>"],
  ["p", "<recipient_pubkey_hex>", "", "recipient"],
  ["app", "wingman-flight-deck"],
  ["app_npub", "<app_npub>"],
  ["service_npub", "<tower_service_npub>"],
  ["workspace_service_npub", "<workspace_service_npub>"],
  ["workspace_owner_npub", "<workspace_owner_npub>"],
  ["recipient", "<recipient_npub>"],
  ["issuer", "<issuer_npub>"],
  ["grant", "<grant_id>"],
  ["alt", "Wingman Flight Deck access grant announcement"]
]
```

The event MAY include these tags:

```json
[
  ["p", "<issuer_pubkey_hex>", "", "issuer"],
  ["scope", "<scope_id>"],
  ["group", "<stable_group_id>"],
  ["relay", "<relay_url>"]
]
```

`recipient_pubkey_hex` is the hex form of `recipient_npub` and exists so relay
clients can query with `{"#p": ["<recipient_pubkey_hex>"]}`. The custom npub
tags exist for product-level validation and debugging.

Public tags leak that the recipient was announced for a Tower/workspace/app
tuple. Sensitive names, group membership details, wrapped keys, and connection
packages MUST remain in encrypted `content`.

### Stable Keys

`dedupe_key` MUST be deterministic for the logical grant target:

```text
wingman-access-grant:v1:<service_npub>:<workspace_service_npub>:<app_npub>:<recipient_npub>
```

`grant_id` MUST be stable across relay republishes and publisher retries. It
SHOULD be:

```text
sha256:<hex_sha256_of_dedupe_key>
```

If a future revision needs separate addressable events for multiple independent
grant scopes in the same workspace, it MUST version the `dedupe_key` format
rather than overloading `grant_id`.

### Encrypted Content

`content` MUST be a NIP-44 v2 encrypted JSON payload from the event publisher to
the recipient npub. A client MUST validate the event signature before decrypting.

The decrypted payload MUST have this shape:

```json
{
  "kind": "wingman_flightdeck_access_grant",
  "version": 1,
  "status": "active",
  "grant_id": "sha256:<hex>",
  "dedupe_key": "wingman-access-grant:v1:<service_npub>:<workspace_service_npub>:<app_npub>:<recipient_npub>",
  "issued_at": "2026-06-06T00:00:00.000Z",
  "expires_at": null,
  "reason": "workspace_member_added",
  "issuer": {
    "npub": "<issuer_npub>",
    "display_name": null
  },
  "recipient": {
    "npub": "<recipient_npub>"
  },
  "service": {
    "direct_https_url": "https://tower.example",
    "service_npub": "<tower_service_npub>",
    "name": null,
    "description": null,
    "relay_urls": ["wss://relay.example"]
  },
  "workspace": {
    "owner_npub": "<workspace_owner_npub>",
    "workspace_service_npub": "<workspace_service_npub>",
    "workspace_id": null,
    "name": null,
    "description": null
  },
  "app": {
    "app_npub": "<app_npub>",
    "namespace": "wingman-flight-deck"
  },
  "agent_connect_package": {
    "kind": "coworker_agent_connect",
    "version": 4
  },
  "hints": {
    "groups": [
      {
        "group_id": "<stable_group_uuid>",
        "group_npub": "<current_group_npub>",
        "name": null,
        "role": null
      }
    ],
    "scopes": [
      {
        "scope_id": "<scope_record_id>",
        "name": null
      }
    ],
    "channels": [
      {
        "channel_id": "<channel_record_id>",
        "scope_id": "<scope_record_id>",
        "name": null
      }
    ]
  },
  "verification": {
    "required": true,
    "method": "tower_nip98_current_membership"
  }
}
```

`status` MUST be one of:

- `active`
- `revoked`
- `superseded`

`agent_connect_package` SHOULD be a full SBIP-0090 package when the publisher
has enough context to build it. It MUST NOT include raw database credentials,
bearer tokens, private keys, or unwrapped workspace/group secrets.

`reason` SHOULD be one of:

- `workspace_member_added`
- `group_member_added`
- `grant_refreshed`
- `grant_revoked`

The payload fields and public tags that describe `recipient`, `service`,
`workspace`, `app`, `grant_id`, and `dedupe_key` MUST match. Clients MUST reject
events with mismatched outer tags and decrypted content.

### Authorization Semantics

The event authorizes nothing by itself.

Publishing or receiving kind `33357` MUST NOT grant:

- workspace listing access,
- group membership,
- record visibility,
- storage visibility,
- write permission,
- graph visibility, or
- access to wrapped workspace or group secrets.

Tower remains authoritative. A recipient only has access when Tower currently
recognizes that recipient, or a Tower-recognized workspace session key for that
recipient, as a current member of the relevant workspace/group.

### Client Validation Flow

Human Flight Deck clients SHOULD:

1. On login and periodically while signed in, query configured relays for
   `{"kinds":[33357],"#p":["<recipient_pubkey_hex>"]}`.
2. Verify the event signature, kind, required tags, and `d` tag format.
3. Decrypt `content` with NIP-44 as the signed-in recipient.
4. Check that public tags match decrypted payload fields.
5. Validate the embedded Agent Connect package using SBIP-0090 rules.
6. Treat `direct_https_url` as a locator and verify the Tower service identity
   against `service.service_npub`.
7. Use NIP-98 as the recipient to verify current access through Tower.
8. Only after Tower verification, show or import the workspace.

Autopilot and Yoke agents SHOULD use the same validation steps. After Tower
verification they MAY idempotently import the workspace package, sync group
memberships, fetch visible records, and materialize scopes/channels needed for
agent context.

Current Tower APIs can verify the minimum access rule by listing workspaces as
the recipient and then syncing/fetching records normally. A future Tower
`POST /api/v4/access-grants/verify` endpoint SHOULD accept the event or decoded
descriptor and return current membership, service identity, and issuer/audit
status without returning credentials.

### Idempotency And Replay

Clients MUST dedupe by `grant_id` and the canonical workspace connection tuple:

```text
service_npub + workspace_owner_npub + app_npub + recipient_npub
```

Clients SHOULD keep the newest verified event for each `dedupe_key`. Replayed
older relay events MUST NOT create duplicate workspace rows, duplicate agent
imports, or duplicate notification prompts.

Relay event ids are not stable grant identities. They are delivery artifacts.

### Revocation And Stale Events

Revocation is a Tower membership change, not a relay event delete.

Issuers SHOULD publish a replacement kind `33357` event with the same `d` tag
and payload `status = "revoked"` when they intentionally announce removal.
Clients MUST still verify with Tower, because relay deletion and replacement are
best-effort and stale `active` events can be replayed.

If Tower verification fails, the client MUST treat the announcement as stale or
unauthorized even when the encrypted payload says `active`.

Deleting the Tower workspace or removing the recipient's current Tower
membership invalidates every earlier `active` announcement for that workspace,
even if no relay accepts or retains a replacement `revoked` event. A client MUST
stop syncing and MUST NOT restore a local workspace connection from a cached or
replayed announcement after that verification failure.

A `revoked` announcement is a fail-closed discovery signal. It MAY cause a
client to stop or hide a locally imported connection, but it does not replace
the Tower membership mutation and does not prove that shared membership was
revoked.

`expires_at` is an announcement freshness hint. It does not revoke Tower access.

### Local Disconnect And Forgetting

A recipient MAY disconnect or forget an imported workspace connection on one
client without changing Tower membership. This is local client state, not a
shared membership revocation. The client MUST NOT publish `status = "revoked"`
solely because its user disconnected locally, unless the same operation also
performed an authorized Tower membership removal.

Clients that offer local disconnect MUST persist a suppression marker keyed by
the canonical workspace connection tuple and `dedupe_key`. While that marker is
active, replay of the same or an older kind `33357` event MUST NOT recreate the
connection or produce another onboarding prompt. Local disconnect does not
change access for other clients and does not prevent the recipient from using
Tower directly while its membership remains active.

A client MAY clear local suppression after an explicit reconnect action by the
recipient. It MAY also surface a strictly newer replacement as a new discovery
after Tower verifies that membership is currently active. An event at or below
the suppression watermark MUST remain ignored. The newer event is still only a
discovery signal: current Tower verification, rather than the relay event,
authorizes the connection.

### Scope, Group, And Channel Discovery

The event MAY include encrypted hints for the group, scope, and channel that
motivated the grant. These hints are for display and prioritization only.

After accepting the announcement, clients MUST discover current context through
Tower:

- group membership and current group epoch through group/workspace APIs,
- visible scopes and channels through record sync/fetch,
- graph or memory context through the separately authorized graph APIs.

Clients MUST NOT infer durable group membership, scope visibility, or channel
visibility solely from event hints.

## Security Considerations

- The public tags reveal recipient and workspace/service identifiers to relays.
  Publishers should use relays appropriate for the workspace's privacy posture.
- NIP-44 does not provide forward secrecy. Long-lived relay retention increases
  exposure if a recipient key is later compromised.
- Clients must verify the signed event before decryption and must verify Tower
  service identity before trusting the HTTPS locator.
- Embedded connection tokens and Agent Connect packages are configuration data,
  not authorization artifacts.
- Stale relay events are expected. Tower membership is the only current access
  check.

## Backward Compatibility Notes

This SBIP does not change existing Tower authorization, workspace creation,
group membership, record sync, storage, or Agent Connect package semantics.
Existing manual Agent Connect import remains valid.

## Implementation Follow-On Tasks

- Tower: add an access-grant publisher or publishing hook for authorized
  workspace/group membership mutations, and add
  `POST /api/v4/access-grants/verify` if existing workspace/group APIs are not
  sufficient for issuer/audit validation.
- Flight Deck: publish kind `33357` when adding a recipient npub to a workspace
  or group; discover kind `33357` on login; verify through Tower before showing
  or importing a discovered workspace.
- Autopilot: watch configured relays for kind `33357` addressed to agent npubs;
  validate, import, and sync idempotently after Tower verification.
- Yoke: add CLI/library support for discovering and importing verified kind
  `33357` grants, sharing parsing and validation fixtures with Flight Deck where
  practical.

## Reference Implementation Notes

Relevant current files:

- `src/routes/workspaces.ts`
- `src/services/workspaces.ts`
- `src/routes/groups.ts`
- `src/services/groups.ts`
- `SBIPS/SBIP-0008-connection-tokens-and-service-discovery.md`
- `SBIPS/SBIP-0090-coworker-agent-connect-profile.md`

No runtime reference implementation exists yet for kind `33357`.
