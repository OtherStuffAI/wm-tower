# SBIP-0000: SBIP Process

- Status: Draft
- Type: Process
- Created: 2026-03-29

## Abstract

This document defines the purpose, status model, and required structure for
Superbased Improvement Proposals.

## Motivation

Superbased now has a sufficiently distinct server contract that implementation
details should be separated from protocol requirements. A lightweight process is
needed so protocol changes can be proposed and reviewed without treating the
current Tower codebase as the only specification.

## Status Model

SBIPs SHOULD use one of the following statuses:

- `Draft`: actively being written or revised
- `Review`: proposed for wider protocol review
- `Accepted`: agreed as the intended protocol
- `Implemented`: accepted and shipped in the reference implementation
- `Obsolete`: retained for history but no longer current
- `Superseded`: replaced by one or more newer SBIPs

## Requirements Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, and
`MAY` in SBIPs are to be interpreted as described by RFC 2119.

## Required Sections

Each Standards Track SBIP SHOULD contain:

- Header metadata
- Abstract
- Motivation
- Specification
- Security considerations
- Backward compatibility notes
- Reference implementation notes

It MAY also include:

- Rationale
- Examples
- Migration guidance
- Open questions

## Proposal Scope

An SBIP SHOULD define one coherent protocol unit. Good proposal boundaries are:

- an object model
- an auth mechanism
- a synchronization contract
- a packaging format
- a profile layered on top of the base protocol

An SBIP SHOULD NOT mix unrelated transport, storage, and application-profile
rules unless they are inseparable at the protocol level.

## Conformance

When possible, each accepted SBIP SHOULD identify:

- the reference implementation files
- the test files that currently exercise the behavior
- any intentionally unspecified areas

## Document Naming

SBIPs in this repository SHOULD use:

- `SBIP-0000-process.md`
- `SBIP-0001-short-name.md`

The four-digit number is authoritative. The slug is descriptive only.

## Reference Implementation Notes

The current reference implementation is `wingman-tower`.
