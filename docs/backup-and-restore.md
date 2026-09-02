# Tower backup and restore

Tower needs one backup set containing the main PostgreSQL database, graph
PostgreSQL database, and MinIO data. A repository copy is not a data backup.

`scripts/tower-backup.sh` streams every component directly through `age`.
Plaintext dumps are never written to disk. The encrypted manifest records the
format version, UTC creation time, consistency mode, component formats, sizes,
and SHA-256 checksums of the encrypted payloads.

## Prerequisites

- Docker, `age`, `jq`, `shasum`, and `tar`.
- An age recipient whose identity is held somewhere other than the Tower host.
- Enough encrypted backup storage for both databases and all MinIO data.

Generate and securely escrow an identity once (do not put it in this repo):

```sh
age-keygen -o /secure/off-host/tower-backup.agekey
age-keygen -y /secure/off-host/tower-backup.agekey
```

## Create a coherent backup

The three stores have no shared transaction manager. A coherent set therefore
requires a write-quiescence window. Stop the Tower API at the ingress and wait
at least the configured presigned-upload TTL so an already issued upload cannot
change MinIO. Stop the Tower API container, but leave both databases and MinIO
running. Confirm no other writer has database or MinIO credentials.

The script checks that the local Tower API container is not running. The
`--quiesced` flag is an operator attestation for the external conditions that a
local script cannot prove.

```sh
RECIPIENT='age1...'
scripts/tower-backup.sh backup \
  --output "/secure/backups/tower-$(date -u +%Y%m%dT%H%M%SZ)" \
  --recipient "$RECIPIENT" \
  --quiesced
```

Restarting Tower is a separate operator action. The backup command never stops,
starts, restarts, or modifies a running service or volume.

## Verify without restoring

Verification checks the encrypted manifest, every ciphertext checksum, both
PostgreSQL archive catalogs, and the MinIO tar catalog. It does not create a
database or write to a volume.

```sh
scripts/tower-backup.sh verify \
  --backup /secure/backups/tower-YYYYMMDDTHHMMSSZ \
  --identity /secure/off-host/tower-backup.agekey
```

Run verification immediately after creation and again after copying off-host.

## Restore rehearsal into disposable targets

Restore refuses arbitrary or existing names. The target must start with
`tower-restore-`, and the exact name must be repeated in `--confirm`. It creates
new Docker volumes and two unexposed database containers; it never attaches to
the Compose volumes or live containers.

```sh
scripts/tower-backup.sh restore \
  --backup /secure/backups/tower-YYYYMMDDTHHMMSSZ \
  --identity /secure/off-host/tower-backup.agekey \
  --target tower-restore-quarterly-test \
  --confirm tower-restore-quarterly-test
```

The restored databases have no published ports. MinIO data is restored into
`tower-restore-quarterly-test-minio-data`; start an isolated, unexposed MinIO
container against it only if application-level object tests are required.
Cleanup is deliberately manual so a failed rehearsal remains inspectable.

## Operations policy

- Suggested RPO: daily for ordinary use; hourly if losing a working day is not
  acceptable. The quiescence window determines which schedule is practical.
- Keep 7 daily, 5 weekly, and 12 monthly sets as a starting retention policy.
- Keep at least one encrypted copy off-host and one offline or immutable copy.
- Store the age identity separately from all backup copies and test recovery by
  two authorized operators.
- Verify every set automatically and perform a disposable restore rehearsal at
  least quarterly and before a storage/schema migration.
- Alert on missed schedules, failed verification, unexpected size collapse,
  and insufficient destination capacity.
- Never publish, commit, or place decrypted dumps in support bundles.

For a near-zero-downtime deployment, use infrastructure snapshots that provide
a coordinated storage freeze across both PostgreSQL volumes and MinIO. Do not
label three independent online copies coherent merely because they share a
timestamp.
