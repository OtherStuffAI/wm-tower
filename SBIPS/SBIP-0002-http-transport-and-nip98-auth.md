# SBIP-0002: HTTP Transport And NIP-98 Authentication

- Status: Draft
- Type: Standards Track
- Created: 2026-03-29
- Requires: SBIP-0000, SBIP-0001

## Abstract

This document defines the HTTP transport expectations and NIP-98-based request
authentication used by Superbased V4.

## Motivation

The current Tower API is HTTP-based and uses NIP-98 signed events for request
authentication. The verification rules include proxy-aware URL normalization and
strict payload hashing for mutating requests.

## Specification

### Transport

Superbased servers expose an HTTPS API. Clients authenticate requests using an
`Authorization` header with a NIP-98 event encoded as base64 JSON.

The header format is:

```text
Authorization: Nostr <base64-json-event>
```

### Required Event Properties

The event:

- MUST be a valid Nostr event
- MUST have kind `27235`
- MUST include exactly one non-empty `u` tag containing the target URL
- MUST include exactly one non-empty `method` tag containing the HTTP method
- MUST have `created_at` within the server freshness window

### Freshness Window

The current reference implementation enforces a maximum event age skew of
300 seconds.

Servers SHOULD reject stale or future-skewed events outside that window.

### URL Matching

The server MUST compare the signed URL against the effective request URL.

The effective URL is determined using:

1. `x-forwarded-proto` and `x-forwarded-host` when both are present
2. otherwise `host` plus either `x-forwarded-proto`, `cf-visitor.scheme`, or
   the request scheme
3. otherwise the raw request URL

The server MUST parse and serialize both the signed and effective URLs with the
platform URL implementation, then compare those complete canonical strings.
The comparison includes the origin, exact pathname, query parameters, and query
parameter order. Consequently, changed, missing, additional, or reordered query
parameters fail verification, as does a trailing-slash mismatch.

Browser `EventSource` clients cannot set an `Authorization` header. An SSE route
MAY therefore define a transport-only `token` query parameter containing the
base64 NIP-98 event. Such a route MUST require exactly one non-empty `token`
parameter and MUST remove every `token` entry from the effective URL before URL
comparison. Every other query parameter remains semantic and MUST be signed in
its transmitted order. This exception applies only when query-token transport
is selected; header-authenticated SSE requests sign the complete URL without
excluded query fields.

### Method Matching

The `method` tag value MUST case-insensitively match the request method.

### Payload Hashing

For `POST`, `PUT`, and `PATCH` requests, the event MUST include a `payload` tag
containing the lowercase hex SHA-256 of the request body.

For `GET` requests, a payload hash is not required.

### Derived Authenticated Identity

If verification succeeds, the authenticated principal is the event pubkey
encoded as `npub`.

Servers SHOULD expose authorization decisions in terms of that derived `npub`.

### Override Payload Hash

Some protocol features need a proof over a canonical subset of the request
payload rather than the full body. A server MAY verify an alternate
payload-hash input when the endpoint explicitly defines such behavior.

In the current protocol, delegated group write proofs use this mechanism. See
SBIP-0006.

## Errors

A request that fails NIP-98 verification SHOULD be rejected as unauthorized.

The current reference implementation returns:

- `401` with `{"error":"nip98 auth required"}` when top-level auth fails

Endpoint-specific authorization checks MAY return `403` after authentication
succeeds.

## Security Considerations

- Deployments behind proxies MUST preserve enough forwarding metadata for
  correct effective-URL reconstruction.
- Clients MUST sign the externally reachable URL, not an internal container URL.
- Clients MUST sign the complete URL, including the exact query parameter order.
- Query-carried NIP-98 events are limited to explicitly documented EventSource
  routes; only the transport `token` itself is excluded from the signed URL.
- Implementations MUST hash the exact request body bytes or a clearly specified
  canonical substitute.

## Backward Compatibility Notes

This SBIP documents the current verification behavior, including the proxy-aware
effective URL logic used in the Tower reference implementation.

## Reference Implementation Notes

Reference files:

- `src/auth.ts`
- route handlers using `requireNip98Auth`
