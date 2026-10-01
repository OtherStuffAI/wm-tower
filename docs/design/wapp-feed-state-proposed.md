# Tower WApp feed reader state — implemented source

T1 implements the [actual Tower wire profile](../contract/wapp-feed-t1-api.md),
with OpenAPI/types and migrations. The [canonical proposal v1, revision 1](../contract/wapp-feed-v1-proposed.md)
remains the shared baseline for other packages; this companion selects no independent
wire definitions. Source implementation is not live activation.

Tower owns subscriptions and read/unread, dismissed and saved flags by workspace
and authenticated actor. It stores no private bodies/summaries and fetches no source
URLs. Subscription preference is never a content grant. Existing publishing APIs,
grants and data remain intact.

The actual profile selects `/feed-subscriptions`, opaque metadata pagination,
UUID mutation acknowledgements, whole-row CAS and explicit field patches.
Unsubscribe retains the source identity and flags indefinitely, with no forget
endpoint. It rejects state writes while inactive and stale resubscription writes;
Flight Deck cancels fetches and purges local private bodies. Existing PG `/records`
hydrates both new families and performs scoped lossless recovery. Personal outbox
and SSE events are reader-only, excluded from managed-agent audience unions.

Portable source identity uses a real shared workspace PG Autopilot connection
UUID plus authorized registry WApp installation UUID and immutable feed ID.
Device-local legacy connection IDs are not portable. Tower validates the PG
connection but does not impersonate a reader or establish WApp origin/graph rights.
Flight Deck and WApp workers must prove those live-code boundaries before claiming
private transport support.

Acceptance evidence is in `tests/feed-reader.test.ts` (two actors/workspaces,
CRUD/state/event/SSE isolation, dedup/replay/CAS, cursor misuse, retained flags,
two-client recovery) and the existing schema/journal suites. Dedicated test DB
validation does not replace excluded live R1 smoke checks.

M1 historical mapping/publisher removal, A1 public adapter and R1 activation are
excluded. The remaining proposed companion contracts retain revision 1 pins;
consumers must reconcile against the linked actual T1 profile before handoff.
