# Flight Deck message reference lookup

Tower provides a narrow authoritative read for a message reference missing from
Flight Deck's browser cache. It reads only the named message and its current
owning thread; it does not bootstrap the workspace or scan channel histories.

```text
GET /api/v4/flightdeck-pg/workspaces/:workspaceId/messages/:messageId
```

Requests use existing NIP-98 authentication. `messageId` must be a UUID. The
optional `x-flightdeck-pg-app-npub` header (or `app_npub` query parameter) must
match the workspace's app; omission uses the workspace app, like existing typed
reads. An active workspace membership and `channel.read` grant are required.
Existing group/inherited grants and revocation rules apply. Non-human actors
must also participate in the owning thread, preserving the thread-title read
restriction of thread GET.

A successful response contains:

| Field | Value |
| --- | --- |
| `identity` | Existing typed PG identity envelope |
| `channel_id` | Authoritative message channel UUID |
| `thread_id` | Current owning canonical thread UUID, or null |
| `message` | Existing serialized PG message, with creator npub/label and `thread_source_message_id` |
| `thread` | Existing serialized owning thread, or null for a threadless message |

Both source-message and reply IDs resolve the owning thread. A message inherited
by one or more branches still belongs to its original thread; a bare reference
cannot select an arbitrary branch. To show an inherited message in a particular
branch, use the existing canonical thread lookup and effective-transcript read.
A live child branch remains independently addressable when its parent is deleted;
a message owned by the deleted parent is unavailable. Archived threads remain
readable when the channel is accessible, matching existing thread GET.

Tower has no typed thread-merge/redirect contract. The saved message `thread_id`
is authoritative, including when records have been reassociated. Legacy browser
merge aliases are not authority and are not inferred from message metadata.
Existing `GET threads/:threadId` remains unchanged and accepts canonical thread
IDs only.

Missing, deleted, foreign-workspace, inaccessible-channel, wrong-app and
nonparticipating bot targets return the identical `404 message_not_found` error.
No target channel, thread, title, body or attachment data is returned on denial.
Existing authentication/workspace errors remain: 401 for failed NIP-98, 403 for
missing membership, and 404 for a missing workspace. Malformed message IDs return
400 validation error after workspace context is checked.

Flight Deck should perform this read through its existing TowerSyncService
loading path, materialize the returned message/thread, then load the canonical
thread transcript with the existing paginated API. A focused message read can
locate a reply beyond the first transcript page. Browser loading, cancellation,
error feedback and navigation remain Flight Deck responsibilities.

## Validation and activation

The API regression exercises current source through an in-process Hono app and
a disposable PostgreSQL test database, using generated test identities. It does
not prove the shared Docker Tower serves the new route. After manager approval
and before live validation, rebuild/restart local Tower with
`./rebuild_deploy_docker.sh`, check `http://127.0.0.1:3100/health`, then use
broker-signed typed requests to verify source/reply lookups and denied targets.
An authenticated browser check should click an uncached message reference and
confirm canonical thread navigation without workspace bootstrap.
