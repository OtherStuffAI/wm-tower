# Trusted WApp Origin Policy

Tower personal-WApp rows are the authority for embedded signer injection. A launcher is not trusted merely because its hostname matches a Wingman deployment domain.

## Trust boundary

The browser signs the policy lookup with NIP-98. Tower first resolves the signer (including an active delegated workspace/device key) to a workspace actor. The lookup considers only active personal WApps that actor may read through ownership or explicit Daily Scope agent access.

A WApp is trusted only when its `metadata.signer` profile is enabled and its normalized `allowed_origins` contains the embedded page's exact HTTP(S) origin. Tower requires an enabled profile to include the `launch_url` origin and NIP-98 event kind `27235`. Origins are scheme, hostname, and explicit port; paths are discarded and wildcards are not supported.

If no visible assignment matches, or more than one visible assignment matches, Tower returns a fail-closed decision without WApp identity or signer policy. This route authorizes bridge injection; it does not authorize a particular signing operation. The native signer must still enforce `capabilities`, `allowed_event_kinds`, and `allowed_nip98_target_origins` for every call and must never expose private key material.

## API

```http
GET /api/v4/flightdeck-pg/workspaces/:workspaceId/personal-wapps/origin-policy?origin=https%3A%2F%2Fexample-wapp.example.invalid
Authorization: Nostr <base64-kind-27235-event>
x-flightdeck-pg-app-npub: <workspace app npub>
```

Trusted response:

```json
{
  "identity": { "workspace_id": "...", "app_npub": "..." },
  "policy": {
    "trusted": true,
    "reason": "trusted",
    "origin": "https://example-wapp.example.invalid",
    "personal_wapp": {
      "id": "tower-row-id",
      "app_id": "autopilot-app-id",
      "wapp_id": "autopilot-assignment-id",
      "launch_url": "https://example-wapp.example.invalid/app"
    },
    "signer_profile": {
      "enabled": true,
      "allowed_origins": ["https://example-wapp.example.invalid"],
      "allowed_nip98_target_origins": ["https://tower.example.com"],
      "allowed_event_kinds": [27235],
      "capabilities": ["nip98"],
      "trust_version": 1
    }
  }
}
```

An untrusted lookup is still a successful policy evaluation (`200`) with `trusted: false`, reason `not_registered` or `ambiguous_origin`, and null `personal_wapp` and `signer_profile`. Malformed or non-HTTP(S) origins return `400`.
