#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_VERSION="1"
readonly MAIN_CONTAINER="${TOWER_BACKUP_MAIN_CONTAINER:-wingman-tower-postgres}"
readonly GRAPH_CONTAINER="${TOWER_BACKUP_GRAPH_CONTAINER:-wingman-tower-graph-postgres}"
readonly MINIO_CONTAINER="${TOWER_BACKUP_MINIO_CONTAINER:-wingman-tower-minio}"
readonly APP_CONTAINER="${TOWER_BACKUP_APP_CONTAINER:-wingman-tower-b3}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
state() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || printf 'missing'; }
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
size() { wc -c < "$1" | tr -d ' '; }

usage() {
  cat <<'EOF'
Encrypted Tower backup sets

  scripts/tower-backup.sh backup --output DIR --recipient AGE_RECIPIENT --quiesced
  scripts/tower-backup.sh verify --backup DIR --identity AGE_IDENTITY_FILE
  scripts/tower-backup.sh restore --backup DIR --identity AGE_IDENTITY_FILE \
    --target tower-restore-NAME --confirm tower-restore-NAME

backup requires the Tower API container to be stopped and an operator attestation
that all external writes (including outstanding presigned MinIO uploads) are
quiesced. It never writes an unencrypted dump.

restore only creates new disposable Docker containers and volumes whose names
start with tower-restore-. It refuses existing targets and known live names.
EOF
}

parse() {
  while (($#)); do
    case "$1" in
      --output) OUTPUT=${2:?}; shift 2 ;;
      --recipient) RECIPIENT=${2:?}; shift 2 ;;
      --quiesced) QUIESCED=1; shift ;;
      --backup) BACKUP=${2:?}; shift 2 ;;
      --identity) IDENTITY=${2:?}; shift 2 ;;
      --target) TARGET=${2:?}; shift 2 ;;
      --confirm) CONFIRM=${2:?}; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
}

decrypt_manifest() {
  age --decrypt --identity "$IDENTITY" "$BACKUP/manifest.json.age"
}

backup() {
  parse "$@"
  need age; need docker; need jq; need shasum
  [[ -n ${OUTPUT:-} && -n ${RECIPIENT:-} ]] || die "--output and --recipient are required"
  [[ ${QUIESCED:-0} == 1 ]] || die "--quiesced is required; see docs/backup-and-restore.md"
  [[ $(state "$APP_CONTAINER") != running ]] || die "$APP_CONTAINER is running; stop Tower and quiesce external writes first"
  [[ $(state "$MAIN_CONTAINER") == running ]] || die "$MAIN_CONTAINER is not running"
  [[ $(state "$GRAPH_CONTAINER") == running ]] || die "$GRAPH_CONTAINER is not running"
  [[ $(state "$MINIO_CONTAINER") == running ]] || die "$MINIO_CONTAINER is not running"
  [[ ! -e $OUTPUT ]] || die "output already exists: $OUTPUT"

  umask 077
  local parent staging created completed
  parent=$(dirname "$OUTPUT")
  mkdir -p "$parent"
  staging=$(mktemp -d "$parent/.tower-backup-staging.XXXXXXXX")
  completed=0
  trap 'if [[ $completed != 1 ]]; then rm -rf -- "$staging"; fi' EXIT

  created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  docker exec "$MAIN_CONTAINER" sh -ceu 'exec pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' \
    | age --encrypt --recipient "$RECIPIENT" --output "$staging/main-postgres.dump.age"
  docker exec "$GRAPH_CONTAINER" sh -ceu 'exec pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' \
    | age --encrypt --recipient "$RECIPIENT" --output "$staging/graph-postgres.dump.age"
  docker exec "$MINIO_CONTAINER" sh -ceu 'exec tar -C /data -cf - .' \
    | age --encrypt --recipient "$RECIPIENT" --output "$staging/minio-data.tar.age"

  local main_sha graph_sha minio_sha main_size graph_size minio_size
  main_sha=$(sha "$staging/main-postgres.dump.age"); main_size=$(size "$staging/main-postgres.dump.age")
  graph_sha=$(sha "$staging/graph-postgres.dump.age"); graph_size=$(size "$staging/graph-postgres.dump.age")
  minio_sha=$(sha "$staging/minio-data.tar.age"); minio_size=$(size "$staging/minio-data.tar.age")
  jq -n -c \
    --argjson version "$SCRIPT_VERSION" --arg created_at "$created" \
    --arg main_sha "$main_sha" --arg graph_sha "$graph_sha" --arg minio_sha "$minio_sha" \
    --argjson main_size "$main_size" --argjson graph_size "$graph_size" --argjson minio_size "$minio_size" \
    '{format:"wingman-tower-backup",version:$version,created_at:$created_at,consistency:"operator-quiesced",components:[
      {name:"main-postgres",file:"main-postgres.dump.age",sha256:$main_sha,encrypted_bytes:$main_size,format:"pg_dump-custom"},
      {name:"graph-postgres",file:"graph-postgres.dump.age",sha256:$graph_sha,encrypted_bytes:$graph_size,format:"pg_dump-custom"},
      {name:"minio",file:"minio-data.tar.age",sha256:$minio_sha,encrypted_bytes:$minio_size,format:"tar"}
    ]}' | age --encrypt --recipient "$RECIPIENT" --output "$staging/manifest.json.age"

  mv "$staging" "$OUTPUT"
  completed=1
  trap - EXIT
  printf 'Created encrypted backup set: %s\n' "$OUTPUT"
  printf 'Run verify before copying or pruning backups.\n'
}

verify() {
  parse "$@"
  need age; need docker; need jq; need shasum
  [[ -d ${BACKUP:-} && -f ${IDENTITY:-} ]] || die "--backup DIR and --identity FILE are required"
  local manifest format version
  manifest=$(decrypt_manifest) || die "manifest decryption failed"
  format=$(jq -er '.format' <<<"$manifest")
  version=$(jq -er '.version' <<<"$manifest")
  [[ $format == wingman-tower-backup && $version == "$SCRIPT_VERSION" ]] || die "unsupported backup format/version"

  local file expected actual
  while IFS=$'\t' read -r file expected; do
    [[ $file =~ ^[a-z0-9.-]+\.age$ && -f $BACKUP/$file ]] || die "missing or unsafe component filename: $file"
    actual=$(sha "$BACKUP/$file")
    [[ $actual == "$expected" ]] || die "checksum mismatch: $file"
  done < <(jq -r '.components[] | [.file,.sha256] | @tsv' <<<"$manifest")

  age --decrypt --identity "$IDENTITY" "$BACKUP/main-postgres.dump.age" \
    | docker run --rm -i postgres:16-alpine pg_restore --list >/dev/null
  age --decrypt --identity "$IDENTITY" "$BACKUP/graph-postgres.dump.age" \
    | docker run --rm -i postgres:16-alpine pg_restore --list >/dev/null
  age --decrypt --identity "$IDENTITY" "$BACKUP/minio-data.tar.age" | tar -tf - >/dev/null
  printf 'Verified backup set: %s (%s)\n' "$BACKUP" "$(jq -r '.created_at' <<<"$manifest")"
}

restore() {
  parse "$@"
  need age; need docker; need jq
  [[ -d ${BACKUP:-} && -f ${IDENTITY:-} ]] || die "--backup DIR and --identity FILE are required"
  [[ ${TARGET:-} =~ ^tower-restore-[a-z0-9][a-z0-9-]{2,40}$ ]] || die "--target must match tower-restore-[a-z0-9][a-z0-9-]{2,40}"
  [[ ${CONFIRM:-} == "$TARGET" ]] || die "--confirm must exactly match --target"
  case "$TARGET" in wingman-tower*|*postgres-data|*graph-postgres-data|*minio-data) die "target resembles a live Tower resource";; esac

  verify --backup "$BACKUP" --identity "$IDENTITY"
  local main_volume="${TARGET}-main-data" graph_volume="${TARGET}-graph-data" minio_volume="${TARGET}-minio-data"
  local main_container="${TARGET}-main" graph_container="${TARGET}-graph"
  local name
  for name in "$main_volume" "$graph_volume" "$minio_volume"; do
    ! docker volume inspect "$name" >/dev/null 2>&1 || die "target volume already exists: $name"
  done
  for name in "$main_container" "$graph_container"; do
    ! docker container inspect "$name" >/dev/null 2>&1 || die "target container already exists: $name"
  done

  docker volume create "$main_volume" >/dev/null
  docker volume create "$graph_volume" >/dev/null
  docker volume create "$minio_volume" >/dev/null
  docker run -d --name "$main_container" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=restore_main \
    -v "$main_volume:/var/lib/postgresql/data" postgres:16-alpine >/dev/null
  docker run -d --name "$graph_container" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=restore_graph \
    -v "$graph_volume:/var/lib/postgresql/data" apache/age:release_PG16_1.6.0 >/dev/null
  local tries
  for name in "$main_container" "$graph_container"; do
    for tries in {1..60}; do docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
    docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 || die "restore target did not become ready: $name"
  done
  age --decrypt --identity "$IDENTITY" "$BACKUP/main-postgres.dump.age" \
    | docker exec -i "$main_container" pg_restore --exit-on-error --no-owner --no-acl -U postgres -d restore_main
  age --decrypt --identity "$IDENTITY" "$BACKUP/graph-postgres.dump.age" \
    | docker exec -i "$graph_container" pg_restore --exit-on-error --no-owner --no-acl -U postgres -d restore_graph
  age --decrypt --identity "$IDENTITY" "$BACKUP/minio-data.tar.age" \
    | docker run --rm -i -v "$minio_volume:/restore" alpine:3.20 tar -C /restore -xf -
  printf 'Restored into disposable targets only:\n  %s\n  %s\n  %s\n' "$main_container" "$graph_container" "$minio_volume"
  printf 'No ports are published. Inspect, test, then explicitly remove these targets when finished.\n'
}

command_name=${1:-}
shift || true
case "$command_name" in
  backup) backup "$@" ;;
  verify) verify "$@" ;;
  restore) restore "$@" ;;
  help|-h|--help|'') usage ;;
  *) die "unknown command: $command_name" ;;
esac
