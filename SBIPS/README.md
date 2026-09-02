# Superbased Improvement Proposals

This directory contains the initial Superbased Improvement Proposal set for the
current Superbased V4 protocol surface implemented by `wingman-tower`.

The goal of these documents is to formalize the transport, data model, and
server behavior that are already present in the reference implementation so the
protocol can be discussed, extended, and implemented by other clients and
servers without depending on implicit Tower behavior.

## Status

These drafts are based on the current Tower implementation in `src/` and the
behavior enforced in `tests/`. They should be treated as "living drafts" until
the protocol is exercised by at least one non-Tower implementation.

## Proposal Index

- `SBIP-0000`: Process and document conventions
- `SBIP-0001`: Terminology and object model
- `SBIP-0002`: HTTP transport and NIP-98 authentication
- `SBIP-0003`: Workspace bootstrap and authority
- `SBIP-0004`: Group lifecycle and epoch rotation
- `SBIP-0005`: Record sync, visibility, history, and summary
- `SBIP-0006`: Delegated group writes
- `SBIP-0007`: Storage object lifecycle
- `SBIP-0008`: Connection tokens and service discovery
- `SBIP-0009`: Flight Deck access-grant events
- `SBIP-0090`: Coworker Agent Connect profile

## Current Source Of Truth

The following code is the reference implementation for these drafts:

- `src/auth.ts`
- `src/services/workspaces.ts`
- `src/services/groups.ts`
- `src/services/records.ts`
- `src/services/storage.ts`
- `src/routes/*.ts`
- `src/schema/001_init.sql`
- `tests/*.test.ts`

## Notes

- Core Superbased behavior is separated from the Coworker/Wingman packaging
  profile where possible.
- `record_family_hash` is currently treated as an opaque application-defined
  identifier. Its derivation and publication lifecycle are intentionally left
  out of the current draft set.
- Admin tooling such as `/table-viewer` is not part of the base protocol.
