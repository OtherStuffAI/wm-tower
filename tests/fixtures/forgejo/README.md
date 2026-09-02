# Isolated Forgejo smart-HTTP fixture

This fixture pins `codeberg.org/forgejo/forgejo:16.0.3-rootless`. It is not the
shared Tower or Forgejo runtime. Use a unique Compose project name and a
loopback-only host port:

```bash
FORGEJO_FIXTURE_PORT=3300 docker compose \
  --project-name tower-forgejo-v1-fixture \
  -f tests/fixtures/forgejo/docker-compose.yml up -d
```

The loopback mapping exists only so the host-side automated gateway fixture can
reach the disposable container. Production Forgejo must have no host/public
port and must share only a private network with the gateway and reconciler.
`REQUIRE_SIGNIN_VIEW=true`, private repositories, and disabled internal/basic
login mean a direct anonymous smart-HTTP request still fails in this fixture.

Bootstrap a non-admin control user inside the disposable container, issue its
token with the Forgejo admin CLI, and pass that token only to the reconciler/E2E
test process. Never put it in argv, a committed env file, Tower, or the gateway.

The remaining activation smoke must prove, through stock Git and the gateway:

- read capability clone/fetch with no provider credential returned;
- write capability push to `work/*`, attributed by a signed webhook to the
  deterministic shadow actor;
- direct and force pushes rejected by replicated Forgejo branch rules;
- wrong repository/audience/service/scope, expired, revoked, stale-policy, and
  unauthorized capabilities fail closed;
- spoofed upstream identity/authorization headers are stripped;
- anonymous direct Forgejo smart HTTP fails;
- invalid and duplicate webhook deliveries do not double-mutate Tower.

Destroy only the explicitly named disposable project afterward:

```bash
docker compose --project-name tower-forgejo-v1-fixture \
  -f tests/fixtures/forgejo/docker-compose.yml down -v
```

No shared runtime restart is part of this fixture.
