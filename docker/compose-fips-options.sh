#!/usr/bin/env bash

# Append the explicitly enabled local FIPS settings to the caller's COMPOSE array.
append_tower_fips_options() {
  local fips_env_file="${FIPS_ENV_FILE:-.env.fips}"
  local fips_compose_file="${FIPS_COMPOSE_FILE:-docker-compose.fips.yml}"
  local enabled

  if [[ ! -f "$fips_env_file" ]]; then
    if [[ -n "${FIPS_ENV_FILE:-}" ]]; then
      echo "ERROR: requested FIPS env file '$fips_env_file' not found" >&2
      return 1
    fi
    return 0
  fi

  enabled="$(awk -F= '$1 == "TOWER_FIPS_ENABLED" { print $2 }' "$fips_env_file" | tr -d '\r')"
  case "$enabled" in
    false) return 0 ;;
    true) ;;
    *)
      echo "ERROR: '$fips_env_file' must declare TOWER_FIPS_ENABLED=true or false" >&2
      return 1
      ;;
  esac
  if [[ ! -f "$fips_compose_file" ]]; then
    echo "ERROR: enabled FIPS compose file '$fips_compose_file' not found" >&2
    return 1
  fi
  COMPOSE+=(--env-file "$fips_env_file" -f "$fips_compose_file")
}
