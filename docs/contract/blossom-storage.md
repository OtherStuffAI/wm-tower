# Blossom links for Tower storage

All completed Tower objects, regardless of MIME type, can expose an additive
`blossom_url` and `blossom_auth` through existing storage metadata, completion
and download-URL APIs. S3 remains the byte store. Existing `content_url`, upload,
ownership and deletion contracts remain intact. Files containing client-encrypted
bytes address that ciphertext; the link does not decrypt it.

Public storage stays explicitly opt-in (`is_public`). Private links require a
BUD-11 `get` token (kind 24242, signed, unexpired, matching action and any server/hash
scopes), or existing Tower NIP-98 HTTP authorization. Authentication never grants
access by itself: Tower storage ACLs and active Flight Deck PG resource permissions
apply. Anonymous negative responses use 401 for both absent and private hashes to
avoid an existence oracle. Metadata is available only through existing authorized
APIs. No workspace is made public by hashing it.

## Supported protocol

Reviewed primary drafts on 2026-10-06:
[BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md),
[BUD-11](https://github.com/hzrd149/blossom/blob/master/buds/11.md), and
[BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md).

This is a retrieval server: root `GET /<sha256>` and `HEAD /<sha256>`, optional
extension, correct MIME type and byte length, ETag, single byte ranges and If-Range,
and cross-origin OPTIONS/headers. HEAD ignores Range and returns full metadata.
Unsupported or unsatisfiable ranges return 416. HTML/SVG responses are sandboxed
and all responses avoid caching to preserve revocation and deletion visibility.
BUD-02 upload and BUD-12 list/delete interoperability are not advertised or exposed;
Tower's existing authenticated upload and management APIs remain authoritative.
No relay announcements, mirroring or public metadata enumeration are added.

## Verification and race handling

Completion streams stored bytes into SHA-256 and derives actual size. A supplied
mismatching hash returns 409. Historical client hashes are never treated as verified:
`sha256_verified_etag` is null until bytes are checked. Completion is idempotent;
Tower no longer accepts writes to a completed object. Previously issued presigned
PUTs may remain valid until expiry, so metadata/retrieval check S3's ETag and reverify
changed objects. Conditional S3 GET (`If-Match`) then streams the verified version,
including ranges, without buffering the whole file. Hashing checks object state
before and after reading; interrupted/changing/missing objects get no usable link.
S3-compatible stores must support stat ETag and conditional GET; MinIO validation
covers the deployed store.

Duplicate content retains separate storage/ownership rows and S3 keys. Authorization
is checked against each candidate; deletion of one reference never removes another's
bytes. Retained versions of live files/documents keep links and current resource ACLs.
Objects with only deleted PG references expose no link. Unattached completed
storage remains available to its existing authorized owners. Existing management
remains responsible for removing metadata; this feature never deletes S3 bytes.

## Historical backfill

Run within Tower's configured environment (no signing keys required):

```sh
bun src/scripts/backfill-storage-hashes.ts [after-uuid] [limit] [byte-budget]
```

Defaults: 20 candidates (hard cap 100) and 256 MiB per invocation. One object streams
at a time. JSON reports each candidate (`verified`, `missing`, `budget_exceeded`,
`failed`, `deleted_reference`), bytes budget used and the last UUID as `next_cursor`. Continue from that
cursor until it is null. A fresh pass without a cursor retries missing/failed/skipped
rows; increase the explicit budget for files larger than the default. Verified rows
are skipped on later passes. All historical completed rows, including those with
untrusted existing client hashes, are eligible. Deleted-reference rows remain
unpublished. Metadata lookup also verifies an eligible object on demand.

No new environment variables or public-all-files switch are required. Runtime schema
adds the verification marker and hash lookup index on startup. Deploy with the
repository's Tower rebuild procedure, then run bounded backfill passes. For example,
`https://tower.example/<64-lowercase-hex>` is stable while accessible; adding `.pdf`
does not change content type or authorization. Use the returned `blossom_url`, rather
than constructing URLs from an unverified legacy `sha256_hex` value.

## Explicit file publication

`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/files/:fileId/blossom`
returns retained versions with `available`, `published_by_you`, `publication_count`,
`public`, verified `sha256_hex`, and a public `blossom_url` when accessible. It
requires workspace membership and `file.read` or `channel.read`. `can_publish`
reports current `file.write` or `channel.write` permission.

`PUT /api/v4/flightdeck-pg/workspaces/:workspaceId/files/:fileId/versions/:versionId/blossom`
explicitly publishes that selected version. `DELETE` at the same route removes
only the caller's publication reference. Both require workspace membership and
`file.write` or `channel.write`; read access, knowledge of a hash, and uploader
identity alone do not confer publishing authority. Delegated keys resolve through
existing Tower identity rules. The storage object must belong to the workspace
owner. Publication changes are audited and idempotent (`changed: false` on repeat).

Publication references are keyed by workspace, version and resolved actor. They
pin the storage object and verified SHA-256; S3 bytes stay in place and `is_public`
is never changed. A new file version is private until separately published.
Deleting the file makes its publication references ineligible. Missing/deleted
file or version returns 404; incomplete upload, absent/unverifiable bytes or a
changed immutable publication hash returns 409. Invalid UUIDs return 400; absent
or invalid authentication returns 401; insufficient permissions returns 403.
Unpublishing remains possible when stored bytes are missing.

Anonymous Blossom retrieval can use any active publication of that exact hash.
Independent publications (including another actor's reference to the same version)
and existing `is_public` objects survive one caller's unpublish. Unpublishing is
not a promise of global revocation or recall of downloaded copies. Anonymous
responses use a hash filename and never enumerate records, versions or private
metadata. Normal private storage/download APIs continue enforcing existing ACLs.
This slice adds no replication, remote destinations or Blossom upload endpoint.

## Direct chat attachment publication

GET/PUT/DELETE `/api/v4/flightdeck-pg/workspaces/:workspaceId/messages/:messageId/attachments/:storageObjectId/blossom`
operate on the existing message attachment. Status requires channel.read;
mutation also requires channel.write, membership and, for agents, owning-thread
participation. The source must be a live message and its exact active storage
link with consistent channel/scope and workspace-owned storage. This does not
create a File, copy/upload bytes, change storage ACLs or mutate the source link.

PUT requires explicit `{public:true, expected_link_id, expected_sha256}` observed
from GET. Status contains `message_id`, `can_publish`, `changed` and `attachment`
with `storage_object_id`, `link_id`, verified `sha256_hex`, `available`, `public`,
`published_by_you`, `publication_count`, `blossom_url`. It contains no message
body, filename or attachment metadata. Public hash responses also hide names.
The separate publication table pins each actor reference to a storage-link
lifetime. Repeats return changed=false; DELETE removes only the calling actor's
reference. File-version and duplicate-byte publications stay independent.

Removing a source link, deleting the source message/thread, or losing source
write permission makes that attachment reference ineligible for anonymous
retrieval. A new link never revives old consent. Incomplete/unavailable bytes
return 409; stale link/hash consent and changed previously published immutable
bytes also return 409. Unpublish does not require bytes to remain readable.
Storage-link uniqueness remains unchanged and is still the attachment lifecycle
invariant. Existing file-version publishing retains its API and behavior.

Publication responses use Tower's configured `SUPERBASED_DIRECT_HTTPS_URL`
public origin, including requests arriving through an internal proxy or `.fips`
endpoint. Local fixtures retain HTTP. `BLOSSOM_PUBLIC_ORIGIN` can optionally
specify a distinct public HTTPS origin.
It does not change authentication/transport routing or enable network fallback.
