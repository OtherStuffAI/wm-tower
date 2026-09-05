# Native Forgejo authorization migration

This is the executable migration handoff for Task9ef4631d-3fc1-4249-b648-96cf6b05bcfb.
Source implementation and local tests are authorized; production operations,
pushes and deployments await manager review. The commands below are rollout
instructions, not evidence they have run. Do not restart local Autopilot.

Tower authenticates explicitly allowlisted Nostr identities only. Stock Forgejo
16.0.3 issues OAuth credentials and owns accounts, usernames, organizations,
teams, collaborators, repositories, branch protections, Git and every API
operation. This supersedes historical Git authority, rollout and skill guidance.
Keep the provider, data volumes, repository URLs, OIDC issuer, signing key,
client secret, source IDs and immutable user subjects unchanged.

## 1. Inventory and disable every old launcher

On the production Docker manager, identify exact service names and images
without dumping environment secrets:

```bash
docker service ls --format '{{.Name}} {{.Replicas}} {{.Image}}'
docker ps --format '{{.Names}} {{.Image}} {{.Command}}'
```

Expected retired CapRover apps are `tower-stable-git-org-reconciler`,
`tower-stable-git-identity-reconciler`, and `tower-stable-git-issue-broker`.
Also find one-shot `git-reconciler`, repository reconciliation, old boot jobs,
cron/systemd/launchd jobs, scheduled Autopilot pipelines and deployment hooks
that invoke `git:reconcile*`, `git:issues`, or the old bootstrap scripts.
Disable their triggers first. Record launcher IDs and the resulting disabled
state in protected manager evidence. Disabling API routes alone is insufficient.
Disable auto-deployment for retired CapRover apps so an old release cannot
restart them. The new entrypoint rejects retired roles, and Compose has removed
them entirely; neither change stops an already-running old image.

Create a private evidence directory on the production operator host:

```bash
umask 077
mkdir -p /secure/forgejo-native-migration
```

The shipped migration utility runs read-only by default. Supply *all* discovered
writers using their exact names; it refuses unrelated services. First inventory,
then after rollout authorization stop them:

```bash
python3 scripts/forgejo-native-migration.py writers --mode swarm \
  --writer srv-captain--tower-stable-git-org-reconciler \
  --writer srv-captain--tower-stable-git-identity-reconciler \
  --writer srv-captain--tower-stable-git-issue-broker \
  --output /secure/forgejo-native-migration/writers-before.json

python3 scripts/forgejo-native-migration.py writers --mode swarm --apply \
  --writer srv-captain--tower-stable-git-org-reconciler \
  --writer srv-captain--tower-stable-git-identity-reconciler \
  --writer srv-captain--tower-stable-git-issue-broker \
  --output /secure/forgejo-native-migration/writers-stopped.json
```

The utility scales only the named services to zero and waits for actual task
states to stop, recording replica and task evidence. It does not accept desired
replicas alone as proof. For a Compose host use `--mode compose` with exact
container names (for example `wingman-tower-git-org-reconciler`); it disables
restart and stops containers. Include already-exited one-shot containers in
operator inventory; absent services must be recorded explicitly rather than
silently ignored. For a multi-node swarm inspect processes/containers on every
node that ran these tasks and capture no remaining writer processes. Capture
launcher-disabled proof separately: the utility cannot discover arbitrary
external schedulers.

Remove old provider management tokens from runtime configs and revoke/delete
the old identity/control accounts' access tokens using native Forgejo account
administration after inventory. Remove their native org/team/collaborator
privileges or disable those service accounts once their ownership dependencies
are reviewed. Keep their numeric account rows and historical attribution. Never
hand their tokens to agents. Remove old provider webhooks pointing to
`/api/v4/git/forgejo/webhooks`; preserve unrelated native webhooks.

## 2. Snapshot identities, databases and native permissions

Quiesce mutations for the backup/cutover window. Back up the Tower DB using the
existing protected backup procedure (`docs/backup-and-restore.md`) or an encrypted
`pg_dump --format=custom` from the exact production Postgres container. Retain
all legacy `git_*` records read-only for audit; do not drop tables or import them
into native permissions. The source migration removes projection triggers before
other upgrades, detaches outward foreign keys so workspace/actor deletion cannot
erase historical rows, and retains immutable audit triggers/internal history
relationships. It seeds `forgejo_login_identities` with existing actor UUID
subjects using insert-only conflict handling. Existing mappings survive actor
deletion and later Flight Deck registration; no permissions are imported. Capture the configured OIDC issuer and source ID and a
read-only export of provider `user` IDs, login names, `login_source` and
`login_name`, and the OIDC external-account link table from the database backup.
Never edit provider SQL. Verify the previous Rick/Pete/Lara subjects still map
to the same native account IDs. Lara is native ID **8**, username **lara**;
her Tower actor subject is **ff030c74-33c8-4666-9d15-dbac39dbeb53**.

Use the deployment's normal consistent Forgejo backup, or cold-copy the exact
provider data/config volumes after stopping the provider. Resolve mounts and
current replica count first:

```bash
docker service inspect srv-captain--tower-stable-forgejo-provider \
  --format '{{json .Spec.TaskTemplate.ContainerSpec.Mounts}}'
docker service inspect srv-captain--tower-stable-forgejo-provider \
  --format '{{.Spec.Mode.Replicated.Replicas}}'
```

For each resolved **named volume**, run the following on its storage node after
scaling the provider to zero and verifying all provider tasks have stopped.
Use the exact inspected volume name in `FORGEJO_BACKUP_VOLUME`; repeat for any
separate config volume. For a bind mount use the corresponding reviewed
read-only bind mount. Configure `BACKUP_AGE_RECIPIENT` with the operator's public
backup encryption recipient; no private key is required for encryption.

```bash
set -o pipefail
docker service scale srv-captain--tower-stable-forgejo-provider=0
docker service ps --no-trunc srv-captain--tower-stable-forgejo-provider
# Continue only after every provider task is stopped, on the correct storage node.
docker run --rm --network none --entrypoint sh \
  --mount "type=volume,src=$FORGEJO_BACKUP_VOLUME,dst=/backup,readonly" \
  codeberg.org/forgejo/forgejo:16.0.3-rootless \
  -c 'tar -C /backup -cf - .' \
  | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" \
    --output /secure/forgejo-native-migration/forgejo-volume.tar.age
shasum -a 256 /secure/forgejo-native-migration/forgejo-volume.tar.age
```

Record the image digest, mounts, checksum and backup restore verification.
Restore a copy to isolated volumes and verify the SQLite/database and Git
repositories open before releasing the backup gate. Do not claim a live SQLite
file copy is a consistent backup. Keep provider data/config encrypted because
it contains secrets. Resume the same provider with the reviewed native settings
and original replica count; never replace its persistent volumes.

After the plain native proxy is available, snapshot supported native API state
with a separate short-lived operator management credential stored at mode 0600:

```bash
python3 scripts/forgejo-native-migration.py native-snapshot \
  --forgejo-origin https://tower-stable-forgejo.b.otherstuff.ai \
  --management-token-file /secure/forgejo-operator-token \
  --output /secure/forgejo-native-migration/native-before.json
```

If snapshotting before proxy cutover, run this against a reviewed direct HTTPS
provider endpoint on the operator network; do not republish a management port.
The utility refuses HTTP, credentialed URLs and redirects and does not print
credentials. It snapshots repositories, collaborators, all team memberships,
branch protections and Lara's effective access. The DB/data backup preserves the
full pre-cutover state when the old public gateway blocks native APIs.

## 3. Apply the tested authentication-only configuration

After manager review deploy the committed Tower API and plain proxy from the
same tested release. Update the existing provider configuration; keep pinned
stock 16.0.3, the same app/volume and public URL. No Forgejo fork is required.

- Tower: configure `GIT_OIDC_ALLOWED_NPUBS` with the reviewed Nostr login list.
  Preserve issuer, signing key, client ID/secret and callback URI exactly.
- Provider: `ENABLE_REVERSE_PROXY_AUTHENTICATION=false` and
  `ENABLE_REVERSE_PROXY_AUTHENTICATION_API=false`. Enable native Basic/OAuth Git,
  `DISABLE_REGISTRATION=false`, `ALLOW_ONLY_EXTERNAL_REGISTRATION=true`,
  `ENABLE_AUTO_REGISTRATION=true`, and `ACCOUNT_LINKING=disabled` under the
  relevant `[service]`/`[oauth2_client]` sections. Existing links persist; do not
  auto-link by a mutable username/email or re-run identity bootstrap.
- Proxy: only provider origin/public origin/port; no Tower service token,
  permission API, sharing interceptor, native API blocker or proxy identity.
- Autopilot: release the tested native helper/broker/CLI after review and set
  server-side `WINGMAN_FORGEJO_SERVERS` bindings, for example:
  `[{"origin":"https://tower-stable-forgejo.b.otherstuff.ai","towerIssuer":"https://tower-stable-api.b.otherstuff.ai/api/v4/git/oidc","sourceName":"tower","clientId":"a4792ccc-144e-407e-86c9-5e7d8d9c3269","redirectUri":"http://127.0.0.1/"}]`.
  The shipped helper version is **3**. Existing sessions using version 2 need
  the reviewed runtime/session rollout; updating skill text alone is insufficient.
- Publish the tested canonical `wm-skills` only after review; use its selective
  sync for other installations. Lara's automated skill pull happens after the
  canonical publication, not from Rick's local installed copy.

The builtin OAuth client is public and does not grant administrative scope.
Forgejo's own account permissions govern the account token; provider OAuth
scopes are not implemented. On expiry the broker discards the credential and
repeats native PKCE/Tower sign-in; there is no custom refresh authority.

## 4. One-time Lara native Write recovery

The old reconciler removed Lara's intended native Write on
`other-stuff/wapp-kindling` and `other-stuff/kindlingapi`. Restore this explicitly
once through stock Forgejo's supported collaborator API, after writer shutdown
and backup evidence. Do not restore Tower grants or set up ongoing sync.

The utility checks live writer/task state immediately before mutation, verifies
native username `lara`, ID 8 and no unexpected site-admin privilege, records a
before snapshot, issues exactly two native collaborator PUTs with
`{"permission":"write"}`, then verifies effective Write and unchanged branch
protections. It rechecks writers after the operation. Preview without `--apply`:

```bash
python3 scripts/forgejo-native-migration.py restore-lara --mode swarm \
  --writer srv-captain--tower-stable-git-org-reconciler \
  --writer srv-captain--tower-stable-git-identity-reconciler \
  --writer srv-captain--tower-stable-git-issue-broker \
  --forgejo-origin https://tower-stable-forgejo.b.otherstuff.ai \
  --management-token-file /secure/forgejo-operator-token \
  --output /secure/forgejo-native-migration/lara-preview.json
```

After reviewing the preview run that command with `--apply` and a new output
path `lara-restored.json`. The independent `.before.json` survives partial
failure. PUT is idempotent; review evidence before retrying. Revoke the operator
management token when the operation and read-back are complete. This management
credential must never become Lara's runtime credential.

## 5. Prove rollout, including Lara's actual runtime

Run the shipped broker/helper in Lara's fresh managed session. Verify helper
version 3, native `/api/v1/user` ID 8, clone/fetch and a permitted disposable
branch push in both repositories, and a direct issue/PR API write where
appropriate. Keep tokens and signer material out of evidence. Remove disposable
branches/issues only through reviewed native controls. Record command, result,
account ID, branch and native object URLs. Until that runtime test runs, report
**Lara live remediation unverified**.

Use a disposable private fixture/repository for destructive acceptance checks:
change native collaborator/team Write to Read and prove push denial with the
same issued OAuth token; remove all effective read and prove clone/fetch denial;
confirm branch protection, foreign/invalid token rejection and unlisted Tower
login denial. Expire the native credential and prove one real native re-login;
a native permission denial must not cause endless retries. With a still-valid
native token, stop only fixture Tower and prove direct native Git/API still
works. Removing a Tower allowlist entry blocks new sign-in only: native access
must be disabled/revoked separately when immediate revocation is intended.

## Rollback and later cleanup

Keep all retired writers and their launchers disabled throughout rollback.
Never return to the old gateway/permission replica to repair access. If the new
helper/login fails, retain native Forgejo state and pause new sign-ins while
fixing forward or selecting a reviewed authentication-only release. Snapshot
restoration is a separate explicit recovery decision, into isolated validation
volumes first; do not overwrite current data or reassign account IDs. Old Tower
Git records remain read-only audit history. Drop them only in a later reviewed
retention migration after backup and dependency review.
