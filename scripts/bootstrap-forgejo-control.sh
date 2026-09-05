#!/bin/sh
set -eu
echo "Retired: Tower authenticates only. Do not bootstrap permission/identity workers; see docs/forgejo-native-auth-migration.md." >&2
exit 1
