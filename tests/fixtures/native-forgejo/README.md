# Native Forgejo integration fixture

This runs the real stock Forgejo 16.0.3 image with the shipped Tower OIDC routes,
Autopilot capability broker and compiled `git-credential-wingman` helper. No
permission gateway, proxy identity headers, Tower Git grants, reconciler, browser
automation or administrator runtime credential is used. A synthetic fixture admin
PAT configures native repositories and permissions only.

The isolated Compose project uses ports 33310 (HTTPS Forgejo), 35442 (Postgres)
and the test process uses 33110 (HTTPS Tower). It does not restart shared Tower or
Autopilot. `dev.otherstuff.studio` must resolve to 127.0.0.1 on the host (already
configured on the development machine); Docker maps it to its host gateway.
Certificates and private keys below are **disposable fixture credentials only**.

```sh
mkdir -p /tmp/tower-native-forgejo
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/tower-native-forgejo/key.pem \
  -out /tmp/tower-native-forgejo/cert.pem -days 2 \
  -subj /CN=dev.otherstuff.studio \
  -addext subjectAltName=DNS:dev.otherstuff.studio \
  -addext basicConstraints=critical,CA:TRUE
chmod 644 /tmp/tower-native-forgejo/key.pem
docker compose -p tower-native-auth-fixture \
  -f tests/fixtures/native-forgejo/docker-compose.yml up -d
set -a
. ./.env.example
set +a
NODE_EXTRA_CA_CERTS=/tmp/tower-native-forgejo/cert.pem \
SSL_CERT_FILE=/tmp/tower-native-forgejo/cert.pem \
  bun tests/fixtures/native-forgejo/smoke.ts
```

The permission checks cover both direct collaborators and an independent native
organization/team repository. With the identical already-issued OAuth token,
adding team membership enables clone/push, changing team Write to Read preserves
fetch but denies push, and removing membership denies clone/fetch/API reads.
Assertions require unchanged credentials and no additional Tower sign-in.

The fixture intentionally gives native access tokens a 15 second lifetime to
prove actual expiration and repeat Nostr login. Each run uses new npubs, a fresh
Tower database and new native usernames/repos. The test drops its Tower database;
native users/repos remain only in the disposable named volumes. Remove the entire
isolated fixture after collecting evidence:

```sh
docker compose -p tower-native-auth-fixture \
  -f tests/fixtures/native-forgejo/docker-compose.yml down -v
rm -rf /tmp/tower-native-forgejo
```

Do not apply the short token lifetime, fixture keys, synthetic identities or test
admin credentials to a deployed service. For source/schema verification, rebuild
an isolated Tower image from the same source before the broader Tower suite.
