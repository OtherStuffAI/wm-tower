# SBIP-0090: Coworker Agent Connect Profile

- Status: Draft
- Type: Standards Track
- Created: 2026-03-29
- Requires: SBIP-0008

## Abstract

This document defines the Coworker Agent Connect package profile layered on top
of the base Superbased connection token.

## Motivation

The base connection token is enough for low-level service discovery, but Wingman
and Coworker clients also exchange a richer package that identifies the package
kind, generation time, service details, workspace, application, and embedded
connection token.

This profile should remain separate from the base Superbased protocol because it
is product-oriented packaging, not a required transport primitive.

## Specification

### Package Encoding

The current profile is represented as a JSON object.

The current package fields are:

- `kind`
- `version`
- `generated_at`
- `service`
- `workspace`
- `app`
- `connection_token`

### Required Fields

The package MUST include:

- `kind = "coworker_agent_connect"`
- `version = 4`
- `generated_at`
- `service.direct_https_url`
- `service.service_npub`
- `workspace.owner_npub`
- optional `workspace.workspace_service_npub`
- `app.app_npub`
- `connection_token`

### Embedded Token

`connection_token` MUST be a valid SBIP-0008 token whose:

- `direct_https_url` matches `service.direct_https_url`
- `service_npub` matches `service.service_npub`
- `workspace_owner_npub` matches `workspace.owner_npub`
- if present, `workspace_service_npub` matches `workspace.owner_npub`
- `app_npub` matches `app.app_npub`

`workspace.owner_npub` is retained for package compatibility with existing
clients. New runtime API calls should treat it as the same identity as canonical
`workspace_service_npub`.

### Relay Hints

The package MAY include `service.relay_urls`.

These are advisory hints for clients that also use Nostr relays for related
flows.

### Human-Facing Tower Metadata

The package MAY include `service.name` and `service.description`.

These fields mirror the optional `tower_name` and `tower_description` carried
inside the embedded SBIP-0008 token. They are intended for UI display only and
do not affect validation or authority semantics.

### Intended Use

This package is intended for product bootstrapping flows such as:

- agent onboarding
- client import/export
- workspace connection handoff

It is not required for raw Superbased HTTP clients.

## Security Considerations

- The package is configuration data, not an authorization artifact.
- Consumers MUST validate consistency between the outer package and the inner
  connection token.
- Consumers MUST treat `service.direct_https_url` as a bootstrap locator and
  `service.service_npub` as the authoritative service identity.
- If stronger authenticity is required, a future SBIP should define signed
  packaging.

## Backward Compatibility Notes

This profile captures the current package emitted by the Tower admin tooling.
The package version is independent from the base connection token version.

## Reference Implementation Notes

Reference files:

- `src/admin-token.ts`
- `src/routes/admin.ts`
- `tests/admin-token.test.ts`
