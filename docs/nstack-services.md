# Nstack relay, Blossom and service discovery

Tower is the discovery boundary for the supported Nstack bundle. The canonical
public descriptor is `GET /.well-known/nstack.json`.

The response schema is `org.wingman.nstack.services`, version `1`. It is public
service metadata, not an authority grant. It contains the public Tower service
identity when configured, service origins, component/protocol versions,
enabled NIPs/BUDs/capabilities and a bounded availability observation. It never
contains workspace or user inventory, credentials, bearer tokens, signed
events, internal health URLs or Docker names. Workspace discovery remains an
authenticated Tower operation and Nostr Browser consent remains a separate
browser boundary.

Responses use `Cache-Control: public, max-age=30, stale-if-error=60` by default.
The TTL is configurable with `NSTACK_DESCRIPTOR_CACHE_TTL_SECONDS`. Tower is
`available` when it serves the descriptor. A configured sidecar is `available`
or `unavailable` according to its internal protocol probe; when no valid probe
URL is configured its status is `unknown`. A disabled service or one with a
missing/malformed public origin is omitted. A temporarily unhealthy configured
service remains present with `unavailable`, so consumers can distinguish an
outage from an unsupported service.

Tower, the relay and Blossom start independently. Tower does not use Compose
startup dependencies for the sidecars: their loss must degrade the descriptor
deterministically, not prevent authority and workspace APIs from starting.

## Service boundaries

The stack deliberately has two non-overlapping Blossom roles:

- Tower retains its existing `GET|HEAD /<sha256>` compatibility route for
  verified Tower objects. Private reads require BUD-11 or Tower NIP-98 plus the
  existing object/Flight Deck ACL. Anonymous access exists only through an
  explicit Flight Deck publication or existing public object state.
- The separate Blossom origin is the general-purpose protocol server. It owns
  objects uploaded through `/upload`, `/media` or `/mirror`, their BUD-11 owner
  rows, list/delete behavior, retention and reports. Those objects do not become
  Tower storage objects or private Flight Deck files.

Do not point Tower's legacy `BLOSSOM_PUBLIC_ORIGIN` at the sidecar unless an
operator has separately arranged byte replication/proxying. In the supported
bundle it is unset (so Tower publishes its own origin). The full server is
advertised with the separate `NSTACK_BLOSSOM_PUBLIC_ORIGIN`.

The relay is likewise transport, not Tower authority. It persists ordinary
signed NIP-01 events and supports publish/query/subscription. Publishing is
restricted to the explicit `NOSTR_RELAY_PUBLISH_PUBKEYS` allowlist, NIP-42 is
enabled, and event/subscription/frame/buffer limits are set in the generated
configuration. Reads remain public relay reads.

## Pinned components and protocol surface

The supported Compose bundle pins multi-architecture image manifests:

- `scsibug/nostr-rs-relay:0.10.0` at
  `sha256:48d54c2d2781577cf3ed2951112f0953dc2c5e7c9d2ea20c64e8c0fa37d16e4d`
- `ghcr.io/hzrd149/blossom-server:6.4.1` at
  `sha256:446fa6c4b0ca529a1fbceabf5ea75839b5b76dfb0d0e1d150f3bae5f9a52b3b8`

The Blossom configuration enables BUD-01 retrieval, BUD-02 upload, BUD-04
mirror, BUD-05 media optimisation, BUD-06 preflight, BUD-08 NIP-94 metadata,
BUD-09 signed reports, BUD-11 authorization, and BUD-12 owner list/delete.
These identifiers were checked against `hzrd149/blossom` commit
`b5bd2801d1763aa635fc8fea7a76597e0eb18990`. Upload, preflight, mirror, media,
list and delete require scoped BUD-11 events; delete is owner-only. Reporting
accepts signed NIP-56 kind-1984 events as BUD-09 defines.

The server verifies body hashes, requires upload lengths, caps upload/media
inputs at 100 MiB, and requires the authenticated publisher pubkey to match
the explicit `BLOSSOM_PUBLISH_PUBKEY` storage-rule allowlist for upload,
mirror and media operations. It applies a MIME allowlist with finite retention,
prunes ownerless data, strips image EXIF during optimisation, and uses
upstream's redirect-aware DNS/IP SSRF checks for mirroring. Mirror connect/body
timeouts are 10/120 seconds. The service has CPU, memory, process and
temporary-space limits. Its BUD-01 middleware applies wildcard read CORS plus
explicit `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS` preflight handling;
mutation safety comes from BUD-11 signatures rather than browser-origin trust.
The upstream component does not implement a per-pubkey byte quota;
operators must monitor/cap the persistent volume at the host/storage layer.
Finite retention and the publisher/auth gates are the safe default, not a
promise of unlimited durable storage.

## Production routing

Configure separate root origins and route them without path prefixes:

```dotenv
SUPERBASED_DIRECT_HTTPS_URL=https://tower.example.com
NOSTR_RELAY_PUBLIC_ORIGIN=wss://relay.example.com
NOSTR_RELAY_PUBLISH_PUBKEYS=<hex-pubkey>[,<hex-pubkey>...]
NSTACK_BLOSSOM_PUBLIC_ORIGIN=https://blossom.example.com
BLOSSOM_PUBLIC_DOMAIN=blossom.example.com
BLOSSOM_PUBLISH_PUBKEY=<hex-pubkey>
```

The default host listeners are loopback-only: Tower `3100`, relay `7777`, and
Blossom `3002`. Terminate TLS at the existing reverse proxy. Preserve WebSocket
upgrade headers for the relay. Blossom and relay must remain at their domain
root because their protocols define root paths. Do not route either over
Tower's root path.

For a host-running Cloudflare Tunnel, target `ws://127.0.0.1:7777` for the
relay and `http://127.0.0.1:3002` for Blossom. Ports `8080` and `3000` are
container-internal and are not the host tunnel targets.

This service does not automatically push local uploads to a third-party
Blossom server. Cross-server replication must be initiated by a client with a
publisher-authorized BUD-11 signature (for example, a dual-publish or remote
mirror workflow). Never place a user's private Nostr key in Tower merely to
replicate blobs.

Validate interpolation without printing resolved secrets:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml config --quiet
```

## Activation and live smoke

Source validation does not activate the managed stack. After explicit restart
approval, the manager must run:

```bash
./rebuild_deploy_docker.sh
curl -fsS http://127.0.0.1:3100/health
curl -fsS http://127.0.0.1:3100/.well-known/nstack.json | jq .
```

Then use a disposable publisher identity whose hex pubkey is in
`NOSTR_RELAY_PUBLISH_PUBKEYS`. Keep its nsec outside tracked files:

```bash
NSTACK_SMOKE_NSEC='<disposable-nsec>' \
NSTACK_SMOKE_TOWER_ORIGIN='http://127.0.0.1:3100' \
NSTACK_SMOKE_RELAY_ORIGIN='ws://127.0.0.1:7777' \
NSTACK_SMOKE_BLOSSOM_ORIGIN='http://127.0.0.1:3002' \
NSTACK_SMOKE_EXPECTED_TOWER_ENDPOINT='https://tower.example.com' \
NSTACK_SMOKE_EXPECTED_RELAY_ENDPOINT='wss://relay.example.com' \
NSTACK_SMOKE_EXPECTED_BLOSSOM_ENDPOINT='https://blossom.example.com' \
bun run nstack:smoke
```

The smoke authenticates to the relay, publishes a signed event, queries it from
persistent storage, uploads hash-scoped bytes to Blossom, verifies GET/HEAD,
deletes as the owner, and validates the enabled three-service descriptor.
