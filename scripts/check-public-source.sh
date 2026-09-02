#!/bin/sh
set -eu

tracked_files=$(git ls-files | while IFS= read -r file; do
  test -f "$file" && printf '%s\n' "$file"
done)
test -n "$tracked_files" || exit 0

nostr_secret='nsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}'
private_key_header='BEGIN ([A-Z ]+ )?PRIVATE KEY'
credential_url='https?://[^/@[:space:]]+:[^/@[:space:]]+@'
mac_user_path='/'"Users/"'[^/[:space:]]+'
linux_user_path='/'"home/"'[^/[:space:]]+'
forbidden_pattern="$nostr_secret|$private_key_header|$credential_url|$mac_user_path|$linux_user_path"
if printf '%s\n' "$tracked_files" | xargs grep -ElI "$forbidden_pattern"; then
  echo 'public-source check failed: secret material or a personal absolute path is tracked' >&2
  exit 1
fi

# Catch committed personal email addresses while allowing documentation/test
# domains and GitHub's non-personal noreply form. Only filenames are printed.
email_pattern='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}'
email_files=$(printf '%s\n' "$tracked_files" | xargs grep -ElI "$email_pattern" || true)
for file in $email_files; do
  if grep -EoI "$email_pattern" "$file" \
    | grep -Eiv '@(example[.](com|org|net|invalid)|example[.]test|users[.]noreply[.]github[.]com)$' \
    >/dev/null; then
    printf '%s\n' "$file"
    echo 'public-source check failed: a non-placeholder email address is tracked' >&2
    exit 1
  fi
done

# Operators can keep local names, domains, public identities, or customer
# markers in an ignored line-delimited denylist without committing the values.
denylist=${PUBLIC_SOURCE_DENYLIST:-.public-source-denylist}
if test -f "$denylist"; then
  while IFS= read -r marker; do
    test -n "$marker" || continue
    case "$marker" in \#*) continue ;; esac
    if printf '%s\n' "$tracked_files" | xargs grep -FIl -- "$marker"; then
      echo 'public-source check failed: a local denylist marker is tracked' >&2
      exit 1
    fi
  done < "$denylist"
fi

if git ls-files | grep -E '(^|/)([.]mcp[.]json|ecosystem[.]config[.](cjs|js)|.*[.]pm2[.]json)$' | while IFS= read -r file; do test -e "$file" && echo "$file"; done | grep -q .; then
  echo 'public-source check failed: generated process/MCP state is tracked' >&2
  exit 1
fi

if command -v gitleaks >/dev/null 2>&1; then
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    gitleaks git --redact=100 --no-banner --log-level error .
  fi
  if ! git diff --cached --quiet; then
    gitleaks git --staged --redact=100 --no-banner --log-level error .
  fi
fi

# Keep deployment credential and host-binding safety part of the public-source
# release gate without rendering the operator's resolved Compose environment.
bun test tests/deployment-security.test.ts >/dev/null

echo 'public-source check passed'
