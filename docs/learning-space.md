# Space learning API and privacy

Tower owns `/api/v4/learning`. The reviewed `learning.space.v1` curriculum is a compact ten-concept Moon phases path. It is seeded from curated source code into dedicated versioned Postgres concept and prerequisite tables, then served read-only. An immutable content hash prevents an existing version from changing silently. [NASA Moon Phases](https://science.nasa.gov/moon/moon-phases/) and [NASA Top Moon Questions](https://science.nasa.gov/moon/top-moon-questions/) are the source references; review date is 2026-09-26.

Private plans, lessons, attempts, answers, reviews and evidence use dedicated `learning_*` tables in Tower's primary Postgres database. They never enter native graph nodes, edges, memories, search or neighbourhood queries. All private routes require verified NIP-98. Tower resolves direct learner identity or an active narrow grant from the authenticated actor. A grant ID may select a specific already-authorized learner for a guardian with their own profile; a supplied learner npub is not accepted. A learner creates and revokes grants. `agent` grants permit specified read/write access; `guardian` grants provide full visibility and optionally write; `reviewer` grants allow independent evidence review when write is explicitly enabled. A submission actor cannot approve its own evidence.

Each private route begins a transaction and switches to `tower_learning_rls_v1` with `SET LOCAL ROLE`. This non-login role has only the learning-table privileges it needs, is not a superuser, and has no `BYPASSRLS`. The switch is local to the transaction, so the normal Tower connection role and other data paths remain unchanged. Postgres RLS scopes private rows by transaction-local `app.learning_actor_npub` and `app.learning_learner_npub`; `FORCE ROW LEVEL SECURITY` also covers a table owner that is not a superuser. The role and policy setup runs at Tower startup. A failed role switch fails the request closed. Evidence and reviews are append-only at the database layer. Every private read and write also filters by learner npub in SQL.

RLS is defense in depth against a missed row filter inside an authorized request. The application must authenticate the actor, verify an active grant and set the transaction context; a database client allowed to issue arbitrary SQL as the connection superuser could change that context or bypass RLS. Graph node/edge/memory search and neighbourhood routes retain their own graph RLS paths and cannot reach the dedicated tables.

Assessment prompts are reviewed and versioned. The deterministic keyword rubric is only a preliminary screen: contradiction patterns reject common false claims, and every score remains provisional until a different actor with an active reviewer or guardian grant reviews it. Derived `demonstrated` requires a reviewed independent pass. Derived `remembered` additionally requires a reviewed independent recall pass at least 24 hours later. Failed recall returns the concept to `developing`; evidence is preserved. This transparent review gate is necessary because keyword matches alone do not establish understanding.

Deployment checks: run Tower migration/startup through the approved managed lifecycle, verify `current_user = tower_learning_rls_v1` and `rolbypassrls = false` within a learning request transaction, then test two independent learner npubs and a granted bot with cross-access 403/404, revoke, reviewer separation, evidence append-only, and next-day recall. `LEARNING_RLS_TEST=1 bun test tests/learning-rls.test.ts` uses a disposable database on the selected PostgreSQL server to verify the limited role and direct SQL row denial. It never writes learner records in the serving database. This source/database test does not replace the live signed API checks after Tower activation.

## Versioned public research graph

`learning.space.research.v1` is a separate published graph. The first immutable snapshot, `2026-09-27.1`, has 70 concepts, 74 typed relations (27 prerequisites, 43 related, 3 explains, 1 supports), and 16 NASA Science source records across 16 clusters. Its source URLs, page titles, publisher, retrieval and review dates, section locators and short claim summaries are included in the snapshot. Every concept and relation has an explicit support record. Prerequisites describe a reviewed learning order; their summaries are editorial explanations anchored to the target source section, not claims that NASA prescribed the order. The existing `learning.space.v1` ten-concept lesson and assessment path, IDs and private rows remain intact.

The published snapshot has a SHA-256 content hash and is protected against UPDATE/DELETE by a database trigger. Startup seeds only the exact reviewed version and fails if source changes without a new version. Candidate additions are separate rows. They may be incomplete or unsourced while staged, but independent review and publication reject unsupported concepts or relations, duplicate or conflicting IDs, missing references and prerequisite cycles. Review and publish are distinct signed operations. A curator cannot review their own staged candidate. Only NIP-98 signers explicitly listed in `LEARNING_CURATOR_NPUBS` (comma-separated npubs, default empty) can stage, inspect candidates, review or publish; learner grants do not confer curator authority. Use at least two curator identities for staging and independent review. New versions append to the public graph and never rewrite an existing version.

All routes below require signed NIP-98. `?version=` pins a published snapshot; omission selects latest.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/v4/learning/research/subjects` | Cluster counts and concept catalog |
| GET | `/api/v4/learning/research/concepts/:id/neighbourhood` | One-hop concepts and typed relations |
| GET | `/api/v4/learning/research/concepts/:id/walk?depth=2&limit=50` | Bounded undirected walk; depth 0–4, at most 100 concepts |
| GET | `/api/v4/learning/research/concepts/:id/sources` | Source records and support for the concept and incident relations |
| POST | `/api/v4/learning/research/candidates` | Idempotent stage by stable candidate ID and identical payload |
| GET | `/api/v4/learning/research/candidates/:id` | Curator inspection |
| POST | `/api/v4/learning/research/candidates/:id/review` | Independent validation and review |
| POST | `/api/v4/learning/research/candidates/:id/publish` | Append an immutable version; body `{ "version": "2026-10-01.1" }` |
| POST | `/api/v4/learning/views` | Record an actual lesson or revision view for the signed learner |
| GET | `/api/v4/learning/overlay` | Private per-concept counts, evidence state and timestamps |

Candidate request example (source IDs already in the published snapshot can be reused):

```json
{
  "id": "candidate-coral-1",
  "baseVersion": "2026-09-27.1",
  "addition": {
    "sources": [],
    "concepts": [{ "id": "sample-topic", "cluster": "moon", "title": "Sample topic", "claim": "A short reviewed factual claim." }],
    "relations": [{ "id": "moon-to-sample-topic", "from": "moon-phases", "to": "sample-topic", "type": "related" }],
    "supports": [
      { "targetType": "concept", "targetId": "sample-topic", "sourceId": "moon", "locator": "Introduction", "summary": "Precise short summary of what the cited page supports." },
      { "targetType": "relation", "targetId": "moon-to-sample-topic", "sourceId": "moon", "locator": "Introduction", "summary": "Why the source supports this relationship." }
    ]
  }
}
```

The example illustrates the shape; a curator must verify its factual claim before review. `POST /candidates` returns `{ "candidate": { ... }, "issues": [], "idempotent": false }`. Repeating the exact ID, actor, base version and content returns `idempotent: true`. A changed payload under that ID returns `409 candidate_conflict`. Review returns `409 invalid_graph` with `issues` for missing provenance/references/cycles, `403 self_review_denied` for the staging actor, or `409 stale_base_version` if another snapshot was published first. Publish requires prior review and a new version; it returns `{ "corpus": "learning.space.research.v1", "version": "2026-10-01.1", "contentHash": "…", "idempotent": false }`. Read errors include `400 invalid_bounds`, `404 concept_not_found`, `404 graph_version_not_found`; curator denial is `403 curator_forbidden`.

An actual view is written with `POST /api/v4/learning/views` and a client-generated UUID for retry safety:

```json
{ "id": "502c2eb4-5b7c-4dbe-a858-19fb7f8f3af3", "concept": "moon-phases", "kind": "revision" }
```

For `kind: "lesson"`, `lessonId` is required and must belong to the authorized learner and concept; revision views may omit it. Identity comes from the signer or active `x-learning-grant-id`; neither the body nor query accepts a learner npub. `/overlay` returns each published concept with `lessonViews`, `revisionViews`, `assessmentCount`, `recallCount`, first/last view and assessment/recall timestamps, `dueAt`, `due`, and one state: `unseen`, `seen_once`, `seen_repeatedly`, `tested_provisional`, `demonstrated`, or `remembered`. These states come from recorded views and the existing independently reviewed evidence rules. The public research routes never include a learner's answers or overlay. The current assessment prompts exist only for the original ten Moon concepts; consumers can display and record revision of the wider graph now, while future reviewed assessment content needs its own versioned expansion.
