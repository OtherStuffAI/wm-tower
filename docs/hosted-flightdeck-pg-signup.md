# Hosted Flight Deck PG signup v1

Tower owns this contract. The site's protected server component obtains site signing through its authorized custody facility; the site private key never reaches Tower or browser code. The user signs with their browser Nostr signer. See [USD prepaid hosting v1](contract/hosting-billing-usd-v1.md) for the current billing contract.

## Request

`POST {towerPublicBaseUrl}/api/v4/flightdeck-pg/hosted/workspaces` with no query string. Both signers use this exact absolute URL, including scheme and host, as seen by Tower after its trusted proxy headers. The body is UTF-8 JSON with exactly these keys (key order and whitespace may vary, but signatures bind the actual bytes):

```json
{"workspace_name":"My workspace","idempotency_key":"6c5e818f-bf8a-4df8-9ffc-ed5753ce5891","terms_version":"hosted-usd-v1"}
```

`workspace_name` must be trimmed, 1–80 characters. `idempotency_key` is a fresh UUID for one create intent. The client cannot send owner or app identity. Tower derives the owner from the direct user signer and uses its configured Flight Deck app npub.

The browser creates a standard NIP-98 kind `27235` event, with exactly one each of `u` (the full URL), `method` (`POST`), and `payload` (lowercase hex SHA-256 of the exact UTF-8 body bytes). Set event `content` to a fresh random UUID to make each retry a new signed event, even within one second. Send base64 of the UTF-8 event JSON in `Authorization: Nostr <base64>`.

Flight Deck's protected server component validates the user event and signs a second kind `27235` event with the same `u`, `method`, and `payload` tags, plus exactly one `user_event_id` tag containing the **verified** user event's lowercase hex `id`. Set its `content` to a fresh random UUID too. Send base64 of that event JSON in `x-flightdeck-site-attestation`. Tower verifies both signatures, the event ID binding, and the allowlisted site npub. An Origin or Referer header grants nothing. Both events must be within 60 seconds of Tower time, including future skew. The site should sign immediately before forwarding the unchanged body and user authorization.

Configure comma-separated public site identities with `FLIGHT_DECK_HOSTED_SIGNUP_SITE_NPUBS`. An empty list denies signup. During rotation, list both old and new npubs; remove the old one after in-flight events expire. No site secret is configured in Tower.

## Result and limits

`201` returns `{workspace_id, descriptor, replayed:false, policy}`. `descriptor` is credential-free. The policy is `plan: hosted_free`, `allowance_bytes: 1000000000` (decimal 1 GB), `terms_version: hosted-usd-v1`, `billing_state: usd_prepaid`, `billing_version: 1`, `welcome_credit_usd: "5"`, `promo_expiry_days: 30`, `payment_required: false`. Tower creates or links the owner's customer account and inserts the once-only $5 welcome ledger entry in the same transaction as the workspace. Multiple workspaces owned by the same stable actor share that account; collaborators receive no new credit. The welcome credit expires 30 days after account creation. Signup does not collect a payment. Existing unlinked workspaces are not enrolled or backcharged. Tower also stores the policy in workspace metadata and writes a workspace audit event with public signer IDs and terms version.

The embedded billing runner measures eligible workspace usage under the [USD billing contract](contract/hosting-billing-usd-v1.md). Stripe remains test-only; signup success does not prove payment-provider readiness. Draft legal pages remain subject to their separate review.

One owner may create at most three hosted workspaces, at most two per rolling hour by default. These limits are configurable; retries do not consume another slot. A name is unique case-insensitively among that owner's Flight Deck PG workspaces, including admin-created ones. A different owner may use the same name.

For a retry, reuse the same body bytes and idempotency key, but obtain **fresh user and site events**. Tower returns `200` with the same workspace ID and `replayed:true`. Reuse of either signed event ID returns `409 signature_replayed`, even after a successful create. Reusing an idempotency key with a different body returns `409 idempotency_conflict`. The database serializes signup decisions per owner and creates workspace, groups, owner membership, policy, signup record, and audit event in one transaction.

## Stable failure codes

Failures return `{error: code, code}`. `400`: `invalid_json`, `invalid_body`, `invalid_workspace_name`, `invalid_idempotency_key`, `terms_version_required`. `401`: strict `nip98_*` user proof codes. `403`: `direct_user_signature_required`, `site_attestation_required`, `site_attestation_invalid`, `site_not_allowed`, `site_attestation_expired`, `site_attestation_mismatch`, `hosted_workspace_limit`. `409`: `signature_replayed`, `idempotency_conflict`, `workspace_name_taken`. `429`: `signup_rate_limited`.

The existing admin creation route and signed `GET /api/v4/flightdeck-pg/workspaces` remain separate. After creation, list and descriptor access use the normal owner membership authorization.

## Deployment diagnosis and activation

The signup route is registered unconditionally. An empty `FLIGHT_DECK_HOSTED_SIGNUP_SITE_NPUBS` list rejects a valid signed request with `403 site_not_allowed`; it does not remove the route. Missing site proof returns `403 site_attestation_required` before signup or billing writes. Keep that verification boundary intact when diagnosing a public `404`.

Check the exact intended public origin's `/health`, `/version`, and `/openapi.json`. The OpenAPI must expose this POST and `/api/v4/hosting-billing` paths; health exposes `hosting_billing.version: 1`, the embedded runner and Stripe test-mode status. A plain-text `404 Not Found` on a correctly broker-signed request without site proof means the expected handler was not reached. Compare the confirmed proxy upstream and deployed revision/configuration before deciding whether the cause is a release or routing mismatch. An unset build commit is insufficient evidence to identify a revision.

Confirm the hosting app, repository, source/deployment remotes and watched branch from the intended infrastructure before pushing a release. Fast-forward its deployed branch from validated source, preserve branch protections and existing data, and record the live build identity. Configure only a reviewed public site identity through the supported nonsecret environment mechanism. Neither an Origin header nor a broad signer allowlist substitutes for proof. Require the expected typed no-proof rejection after activation before testing one labeled real signup and a fresh-proof idempotent retry.
