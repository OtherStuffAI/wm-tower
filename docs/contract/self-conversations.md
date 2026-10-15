# Private self conversations

The typed Flight Deck channel creation route accepts `kind: "dm"` with the
authenticated actor as its single distinct `participant_npubs` entry. Repeated
self entries normalize to one. Ordinary two-person DMs retain their existing
membership rules.

Singleton creation takes a transaction-scoped advisory lock for workspace and
actor, then returns the earliest active matching channel, regardless of requested
scope or display name. Reopening returns the same channel with a null audit event;
renaming does not change its identity. Archived conversations are excluded.
Initial sharing grants and subsequent grant additions or replacements are refused.
Existing channel permissions remain the authority for messages and attachments.
If the requested label already exists in the scope, including an archived row,
Tower gives the new self channel a UUID-suffixed storage name. A label collision
never reuses another actor's channel or prevents creation. Clients present the
singleton as Note to self based on its participants, not its storage name.

Native and browser clients use the same message, thread, attachment and retry
contracts. A storage metadata `size_bytes` value can be a decimal JSON string
from PostgreSQL BIGINT; clients must accept that representation as well as a
JSON number. Do not change the shared response representation to repair one
client. Verify byte count, hash, completion and private status before sending.

`tests/flightdeck-pg-api.test.ts` exercises concurrent and cross-scope reuse,
rename/reopen, signed native-shaped messages, browser-shaped replies, retry
deduplication, signed HTTP image upload/completion/metadata/content reads, and
unauthorized reads, uploads and sharing. These use a synthetic database and
in-memory blob bytes; they do not prove real S3 upload or human device delivery.

After activating Tower, check public HTTPS and native FIPS health, compare the
running route/OpenAPI source hashes with the reviewed checkpoint, and use an
authorized agent signer for exact URL/method/body singleton create/reopen probes
in the designated workspace. Keep the agent conversation separate from the
human's notes. A health response without a commit stamp is insufficient version
evidence. Phone/browser acceptance additionally requires the human to configure
the same identity and workspace, then verify both directions, replies and images.
