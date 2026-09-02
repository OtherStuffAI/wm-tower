# SBIP-0008: Connection Tokens And Service Discovery

- Status: Draft
- Type: Standards Track
- Created: 2026-03-29
- Requires: SBIP-0001, SBIP-0002, SBIP-0003

## Abstract

This document defines the base Superbased connection token used for workspace
service discovery and client bootstrap.

## Motivation

Clients need a compact format that tells them which HTTPS service to use, which
workspace owner to bind to, and which application namespace they are acting
under.

## Specification

### Token Encoding

A connection token is a base64-encoded UTF-8 JSON object.

The current token payload uses:

- `type`
- `version`
- `direct_https_url`
- `workspace_owner_npub`
- optional `workspace_service_npub`
- `app_npub`
- `service_npub`
- optional `tower_name`
- optional `tower_description`
- optional `relay` or `relays`

### Required Fields

The token MUST include:

- `type = "superbased_connection"`
- `version = 2`
- `direct_https_url`
- `workspace_owner_npub`
- `app_npub`
- `service_npub`

Token version 2 keeps `workspace_owner_npub` for compatibility. New canonical
runtime APIs refer to the same workspace authority identity as
`workspace_service_npub`. When a token includes both fields, they MUST match.

### Optional Fields

The token MAY include:

- `tower_name`
- `tower_description`
- `relay`
- `relays`

If one relay URL is present, the current reference implementation emits
`relay`.

If multiple relay URLs are present, it emits `relays`.

### Semantics

`direct_https_url` is the base HTTPS origin clients should initially use for the
API. It is a transport locator, not a durable authority identifier.

`workspace_service_npub` identifies the workspace authority domain the client
will operate within. In token version 2, `workspace_owner_npub` is the required
compatibility field for that same identity.

`app_npub` identifies the application namespace or app authority the client is
binding to.

`service_npub` identifies the server's Nostr service identity.

`tower_name` and `tower_description` are human-facing discovery hints that help
clients explain what the target Tower is before or during workspace selection.
They are descriptive only and do not participate in authority validation.

The durable identity of a workspace connection is the ordered pair:

- `service_npub`
- `workspace_owner_npub`

Clients MUST use that pair, not URL alone, when caching workspace connections,
selecting a current workspace, or deciding whether two discovered workspaces are
the same logical connection.

Relay hints are advisory discovery information. They are not currently required
for HTTP operation.

### Validation

Clients decoding a token SHOULD verify:

- `type` is recognized
- `version` is supported
- `direct_https_url` is a usable HTTPS base URL
- `workspace_owner_npub` is present
- if present, `workspace_service_npub` matches `workspace_owner_npub`
- `app_npub` is present
- `service_npub` is present

Clients SHOULD resolve the target service and verify that the discovered service
identity matches the token `service_npub`.

Clients MUST reject or warn on unsupported token versions.

## Security Considerations

- The current token format is not signed by itself. It must therefore be
  obtained over a trusted channel or bundled inside a trusted higher-level
  package.
- Clients MUST treat `direct_https_url` as untrusted routing input until the
  hosting service identity is checked against `service_npub`.
- The token remains configuration data, not cryptographic proof of authority.
  A future SBIP may define signed service attestation or signed connection
  packaging for stronger anti-spoof guarantees.

## Backward Compatibility Notes

This SBIP only covers the base token format. Higher-level packaging such as
Agent Connect profiles are specified separately.

## Reference Implementation Notes

Reference files:

- `src/admin-token.ts`
- `src/routes/admin.ts`
- `tests/admin-token.test.ts`
