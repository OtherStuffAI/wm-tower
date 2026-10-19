#!/bin/bash
set -euo pipefail

relay_url=${NOSTR_RELAY_PUBLIC_ORIGIN:-}
publishers=${NOSTR_RELAY_PUBLISH_PUBKEYS:-}
config_path=${NOSTR_RELAY_CONFIG_PATH:-/tmp/nstack-relay.toml}

if [[ ! "$relay_url" =~ ^wss://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] &&
   [[ ! "$relay_url" =~ ^ws://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/?$ ]]; then
  echo "NOSTR_RELAY_PUBLIC_ORIGIN must be a root wss:// origin (or loopback ws:// for development)" >&2
  exit 1
fi

allowlist=""
IFS=',' read -r -a publisher_values <<< "$publishers"
for raw in "${publisher_values[@]}"; do
  pubkey=$(printf '%s' "$raw" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  if [[ ! "$pubkey" =~ ^[0-9a-f]{64}$ ]]; then
    echo "NOSTR_RELAY_PUBLISH_PUBKEYS must contain one or more comma-separated 64-character hex pubkeys" >&2
    exit 1
  fi
  if [[ -n "$allowlist" ]]; then allowlist+=", "; fi
  allowlist+="\"$pubkey\""
done

cat > "$config_path" <<EOF
[info]
relay_url = "$relay_url"
name = "Wingman Nstack Relay"
description = "Persistent NIP-01 relay for this Nstack. Publishing is restricted to configured Nostr authors."

[database]
engine = "sqlite"
data_directory = "/usr/src/app/db"
min_conn = 2
max_conn = 8

[network]
address = "0.0.0.0"
port = 8080
ping_interval = 120

[options]
reject_future_seconds = 900

[limits]
messages_per_sec = 5
subscriptions_per_min = 30
max_blocking_threads = 8
max_event_bytes = 65536
max_ws_message_bytes = 131072
max_ws_frame_bytes = 131072
broadcast_buffer = 2048
event_persist_buffer = 1024
limit_scrapers = true

[authorization]
pubkey_whitelist = [$allowlist]
nip42_auth = true
nip42_dms = true

[verified_users]
mode = "disabled"
verify_expiration = "1 week"
verify_update_frequency = "1 day"
max_consecutive_failures = 20
EOF

if [[ ${NOSTR_RELAY_VALIDATE_ONLY:-false} == true ]]; then exit 0; fi
exec /usr/src/app/nostr-rs-relay --db /usr/src/app/db --config "$config_path"
