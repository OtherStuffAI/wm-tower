# Headless Forgejo bootstrap recovery: final manager evidence

2026-09-05. Task `9ef4631d-3fc1-4249-b648-96cf6b05bcfb`. Implementation recovered and committed on main. No production push, deployment, restart, DB mutation, chat post, or local Autopilot restart was performed. Manager owns rollout and live Lara acceptance.

## Exact implementation commits

- Tower `/Users/mini/code/wm/tower`: `f54bab8d8b2d44f25b7a78ed6d12aed99eb2188c` — `feat(git): support headless Forgejo bootstrap with generation CAS`.
- Autopilot `/Users/mini/code/wm/autopilot`: `59943385c4633d8551081920e892b3a60f5fbc9b` — `feat(git): broker headless Forgejo bootstrap and safe helper errors`.
- Canonical skills `/Users/mini/code/wm/wm-skills`: `07aa54c4635f783ad79736ddd1b0d653a4a9a546` — `docs(forgejo): document supported headless bootstrap and skill rollout`.

All pre-existing nonignored edits inspected at recovery were part of this implementation and are preserved in those commits. Explicit paths were staged; no reset/rebase/force push. Working trees were clean after these commits. This evidence is recorded by a subsequent Tower documentation commit; the code commit above identifies the exact tested implementation.

## Blocking review fixed

Organization bindings now persist `desired_generation` (additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in bootstrap SQL, also replayed by `ensureRuntimeSchema`'s shared Git schema block). Identity linking/applied-name changes, workspace membership changes, group membership changes, and namespace claims advance the generation. The desired response includes it. Both successful and failed organization worker ACKs echo it. One conditional SQL UPDATE compares workspace UUID, owner name, and generation; missing/stale generation returns 409 and cannot overwrite pending state.

Regression in `tests/git-authority.test.ts` reads desired state omitting a no-repository-grant member, binds that member while racing two provider-ID writers, rejects stale success and failure ACKs, verifies pending bootstrap and a newer generation including the member, then accepts a fresh ACK and verifies ready with zero grants. Immutable provider ID CAS and newer-alias ACK tests remain. Test signer now uses fresh nonces, retaining explicit replay tests that reuse the captured authorization.

Recovered implementation includes actor-bootstrap GET/POST and observable account/organization state; isolated external account creation with trusted OIDC source ID + immutable actor UUID; pagination; collisions, lost-create-response recovery, numeric binding CAS, supported `new_username` rename; automatic pending repository retry; scoped Autopilot bootstrap/name/list CLI; safe helper stage/status/code errors; fresh nonce on exact URL/method/payload-hash signing. Membership does not add repository grants.

## Validation performed

Local rebuild first attempted the documented Compose command. Docker stalled retrieving `oven/bun:1.2.23` metadata; that build client was cancelled. Rebuilt successfully with the already-cached local Bun 1.2.23 base, using the existing supported build argument:

```sh
TOWER_BUN_IMAGE=wingman-tower-bun-base:1.2.23 docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
curl -fsS http://127.0.0.1:3100/health
curl -fsS http://127.0.0.1:3180/ready
```

Tower and local gateway returned ok/ready. API, gateway, issue broker, identity worker and organization worker were rebuilt and recreated locally. Running API source was checked to contain the generation migration. Cached base digest: `sha256:2e9ca96f21855d19f7b8933e37409fa170e8c0fe55c31b72ee965e6d94b1209b`; API image built as `sha256:5fc19f84c1969cd1bfdf6be2f3681ff4085bceb9d4f94c219d55b164c336d5fa`. Health reports Bun 1.2.23, configured Git authority; build Git metadata is null, so do not use it as proof of a commit.

Tower focused tests: **36 pass / 0 fail**, six files:

```sh
set -a
. ./.env.example
set +a
DB_PORT=35432 DB_PASSWORD=headless-fixture-only GIT_SERVICE_AUDIENCE=headless-fixture GIT_INTERNAL_SERVICE_TOKEN=fixture-internal-token-000000000000000000 GIT_CAPABILITY_HASH_KEY=fixture-capability-key-000000000000000000 bun test tests/git-authority.test.ts tests/forgejo-identity-reconciler.test.ts tests/forgejo-org-reconciler.test.ts tests/forgejo-adapter.test.ts tests/forgejo-gateway.test.ts tests/forgejo-issue-broker.test.ts
bun test tests/git-oidc.test.ts
```

OIDC separately: **3 pass / 0 fail**. Initial combined run had two OIDC 503s because another file initialized shared config before OIDC setup; initial revocation assertion received replay 409 from a repeated synthetic proof, fixed with nonce and rerun passing.

Autopilot focused command: **39 pass / 0 fail**, 108 assertions:

```sh
bun test src/forgejo/cli.test.ts src/git/tower-git-credential-broker.test.ts src/git/wingman-credential-helper.test.ts src/signing/git-credential-capability.test.ts src/signing/tower-forgejo-capability.test.ts
```

Covers exact origin/method/body hash, workspace scope, signing policy restrictions, safe errors, CLI operations, and distinct signed events for consecutive helper exchanges within one second.

### Actual shipped helper acceptance

Run instructions are committed in `tests/fixtures/headless-forgejo/README.md`; invoked `bun tests/fixtures/headless-forgejo/smoke.ts` with the same synthetic DB/Git environment above. Passed against real stock Forgejo 16.0.3, fresh ephemeral Tower/gateway servers, actual Autopilot CapabilityBroker and TowerGitCredentialBroker, and **compiled production `src/git/git-credential-wingman.ts`** invoked by ordinary Git.

Result in `headless-forgejo-evidence/smoke.json`: five broker credential calls; clone, consecutive fetch, work-branch push passed; protected main push denied; no-grant clone denied with repository-resolution HTTP 404/code; foreign workspace denied; concurrent and repeated bootstrap yielded one provider account. No browser cookies/login, manual grant cycle, raw shared identity, or custom helper. Smoke creates a fresh session capability for synthetic actors. Database and temporary secrets/helper files are cleaned in `finally`; disposable Forgejo accounts/volumes remain in the loopback fixture. No provider credentials were printed.

The smoke instantiates session/key-store adapters synthetically; it does not prove a deployed Lara session has refreshed its subscription, capability, helper binary, skills, or worker configuration. It clones an initially empty real provider repo, then pushes a real commit to a work branch.

### Broader check limits

- Exact mandated `.env.example; bun test`: 125 pass / 26 fail. The template has placeholder PostgreSQL password and empty required Git secrets; OIDC setup also suffers shared-config initialization order.
- Full suite using disposable PostgreSQL and synthetic Git settings: 474 pass / 4 skip / 7 fail. Two OIDC tests lacked initialized signing config; five admin setup/API tests reported `tower service npub is required` and consequently JSON parse errors. A final fully configured synthetic run is recorded below.
- `bunx tsc --noEmit`: Tower fails on 49 rootDir/include diagnostics (tests outside src). `--rootDir .` exposes 286 repository-wide diagnostics. The touched organization worker nullable-desired diagnostic was fixed; the final expanded check had no matches in changed Tower source, changed tests, or the new smoke fixture. Autopilot has 415 repository-wide diagnostics, including existing mock-fetch/Bun type and npub assertion issues. No clean repository-wide typecheck is claimed. Local logs retained under `/tmp/{tower,autopilot}-headless-typecheck*.log`.
- `git diff --check` passed for all three repos.

### Final full Tower suite: passing

With missing fixture identity/OIDC configuration supplied before module loading: **481 pass / 4 skip / 0 fail**, 4,661 assertions across 48 files (26.46s). The four skips are storage upload/access tests requiring storage fixture setup. Exact command, after sourcing `.env.example` as above:

```sh
bun -e 'import { generateKeyPairSync } from "node:crypto"; import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools"; const env = { ...process.env, DB_PORT: "35432", DB_PASSWORD: "headless-fixture-only", GIT_SERVICE_AUDIENCE: "headless-fixture", GIT_INTERNAL_SERVICE_TOKEN: "fixture-internal-token-000000000000000000", GIT_CAPABILITY_HASH_KEY: "fixture-capability-key-000000000000000000", SUPERBASED_SERVICE_NPUB: nip19.npubEncode(getPublicKey(generateSecretKey())), GIT_OIDC_CLIENT_SECRET: "fixture-oidc-secret-000000000000000000000", GIT_OIDC_SIGNING_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({type:"pkcs8",format:"pem"}).toString() }; const child = Bun.spawn(["bun", "test"], {env, stdout:"inherit", stderr:"inherit"}); process.exit(await child.exited);'
```

This uses fresh synthetic public identity and RSA material generated in memory, not shared signing keys. Summary retained in `headless-forgejo-evidence/full-tower-tests.txt`; verbose local log `/tmp/tower-headless-full-configured-tests.log`. All code committed in the implementation commit above was final before this run.

## Skills and distribution

Canonical `wm-skills/forgejo-tower` now describes supported broker commands, source/subject identity, readiness versus grants, worker configuration, and actual helper usage. Added repeatable `--skill` selection to canonical sync utility. Temporary-destination checks passed for sync/check, invalid-name rejection before mutations, and preserving an unrelated directory. Ran sync and check against `/Users/mini/.codex/skills` and `/Users/mini/.claude/skills`; both report `exact forgejo-tower`. No remote skills installation performed.

## Production prerequisites and manager rollout

1. Manager reviews commits and performs only fast-forward branch rollout. Deploy Tower first, then Lara Autopilot. No worker has pushed anything.
2. Run the additive Tower migration and deploy matched Tower API **and organization worker** together: older workers omit `desired_generation` and will receive 409 until updated. Pending state stays fail-closed.
3. Deploy the isolated identity worker from the same Tower release, command `bun run src/forgejo/reconcile-identities.ts`. Set `GIT_FORGEJO_OIDC_SOURCE_ID` to the actual trusted Tower source ID from `forgejo admin auth list`, not an assumed 1. Identity worker needs private Tower/provider origins, internal service token, and its dedicated provider admin token (`GIT_FORGEJO_IDENTITY_TOKEN_FILE`); never mount that admin token into API/gateway/agent.
4. Organization worker command `bun run src/forgejo/reconcile-organizations.ts`, matching image, internal token, non-site-admin control token, private origins, webhook URL and webhook secret. It now retries pending repositories automatically. API-only rollout is insufficient. Update matched gateway/issue-broker images as required by the manager's Tower deployment; keep private Forgejo and broker ports unpublished.
5. Lara Autopilot must build/install the shipped helper and load new broker/CLI code; create a fresh agent session to receive current workspace capability and advertised gateway Git config (`credential.useHttpPath=true`). No local Autopilot restart was performed here.
6. Roll out canonical skills separately on Lara's runtime user directories, then verify:

```sh
python3 scripts/sync-skills.py sync --skill forgejo-tower --codex-dir "$HOME/.codex/skills" --claude-dir "$HOME/.claude/skills"
python3 scripts/sync-skills.py check --skill forgejo-tower --codex-dir "$HOME/.codex/skills" --claude-dir "$HOME/.claude/skills"
```

An Autopilot image rebuild does not automatically fetch portable skills. Keep stable group/actor repository grants unchanged; investigate an empty list through Tower authority.

## Precise Lara acceptance (manager after rollout)

In a fresh Lara agent session bound to Other Stuff (`6b39f051-3833-46e6-8a59-be9b4eb57639`), from the active Autopilot checkout:

```sh
bun clis/wingman.ts forgejo username set --username lara
bun clis/wingman.ts forgejo bootstrap request
bun clis/wingman.ts forgejo bootstrap status
bun clis/wingman.ts forgejo repositories list
git-credential-wingman --version
```

Poll status boundedly until `bootstrap.state=ready`, checking account and organization sub-states/errors. Repeat request/status and verify the same actor/provider ID; do not create another account. If active Tower discovery is ambiguous, append `--tower-url https://tower-stable-api.b.otherstuff.ai`. Optional `--workspace` asserts the current workspace only.

Confirm Tower discovery still advertises the handoff's gateway and repository grants include Lara. Then, in an unused local acceptance directory:

```sh
git clone https://tower-stable-forgejo.b.otherstuff.ai/other-stuff/wapp-kindling.git
git -C wapp-kindling fetch origin
git clone https://tower-stable-forgejo.b.otherstuff.ai/other-stuff/kindlingapi.git
git -C kindlingapi fetch origin
```

Record actual versions, account ID, org membership, desired/applied repo revisions, both clone/fetch outcomes, and helper errors if any. If denied, report exact stage/status/code and effective grant; do not bypass helper or revoke/restore grants. The disposable smoke proves protected/no-grant denial; any live mutation acceptance remains manager-owned. Production/Lara acceptance has **not** been run.

## Coordination limitation

Read the original recovery handoff fully. Tried supported task show/comments CLI; dispatch environment lacks Tower URL. Retried task show with the supplied stable Tower URL; then failed for missing Flight Deck app npub. Did not use raw identity files, guess an app identity, post to another channel, or alter task/thread. Manager must reread latest task/comments before rollout. Commentary milestones and this final report are the supervisor handoff; no stop-self action was invoked.
