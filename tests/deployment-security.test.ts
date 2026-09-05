import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const compose = readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8');
const runtimeConfig = readFileSync(join(root, 'src/config.ts'), 'utf8');

function composeService(name: string, nextName: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  const end = compose.indexOf(`\n  ${nextName}:\n`, start + 1);
  return compose.slice(start, end);
}

describe('production deployment security contract', () => {
  test('requires database and object-storage credentials', () => {
    for (const name of [
      'DB_USER',
      'DB_PASSWORD',
      'GRAPH_DB_ADMIN_USER',
      'GRAPH_DB_ADMIN_PASSWORD',
      'GRAPH_DB_APP_USER',
      'GRAPH_DB_APP_PASSWORD',
      'STORAGE_S3_ACCESS_KEY',
      'STORAGE_S3_SECRET_KEY',
    ]) {
      expect(compose).toContain(`\${${name}:?set ${name}}`);
    }

    expect(runtimeConfig).toContain("user: requiredEnv('DB_USER')");
    expect(runtimeConfig).toContain("password: requiredEnv('DB_PASSWORD')");
    expect(runtimeConfig).toContain("adminPassword: requiredEnv('GRAPH_DB_ADMIN_PASSWORD')");
    expect(runtimeConfig).toContain("appPassword: requiredEnv('GRAPH_DB_APP_PASSWORD')");
  });

  test('binds host-published Tower and MinIO ports to loopback by default', () => {
    expect(compose).toContain('${TOWER_HOST_BIND_ADDRESS:-127.0.0.1}:${TOWER_HOST_PORT:-3100}:3100');
    expect(compose).toContain('${MINIO_HOST_BIND_ADDRESS:-127.0.0.1}:${MINIO_API_HOST_PORT:-9000}:9000');
    expect(compose).toContain('${MINIO_HOST_BIND_ADDRESS:-127.0.0.1}:${MINIO_CONSOLE_HOST_PORT:-9001}:9001');
    expect(compose).toContain('STORAGE_S3_ENDPOINT: ${STORAGE_S3_ENDPOINT:-http://minio:9000}');
  });

  test('keeps stock Forgejo private behind a plain proxy without header impersonation', () => {
    const forgejoService = composeService('forgejo', 'git-gateway');
    expect(compose).toContain('image: codeberg.org/forgejo/forgejo:16.0.3-rootless');
    expect(compose).not.toContain('FORGEJO__security__REVERSE_PROXY_TRUSTED_PROXIES:');
    expect(compose).toContain('FORGEJO__service__DISABLE_REGISTRATION: "false"');
    expect(compose).toContain('FORGEJO__actions__ENABLED: "false"');
    expect(compose).toContain('FORGEJO__security__DISABLE_GIT_HOOKS: "true"');
    expect(compose).toContain('FORGEJO__service__ENABLE_INTERNAL_SIGNIN: "false"');
    expect(compose).toContain('FORGEJO__service__ENABLE_BASIC_AUTHENTICATION: "true"');
    expect(compose).toContain('FORGEJO__service__ENABLE_REVERSE_PROXY_AUTHENTICATION_API: "false"');
    expect(compose).toContain('FORGEJO__service__ENABLE_REVERSE_PROXY_AUTO_REGISTRATION: "false"');
    expect(compose).toContain('FORGEJO__oauth2_client__ENABLE_AUTO_REGISTRATION: "true"');
    expect(compose).toContain('FORGEJO__oauth2_client__ACCOUNT_LINKING: ${GIT_FORGEJO_OIDC_ACCOUNT_LINKING:-disabled}');
    expect(compose).toContain('FORGEJO__server__ROOT_URL: ${GIT_GATEWAY_BROWSER_ORIGIN:-https://forgejo.otherstuff.studio}/');
    expect(compose).toContain('GIT_GATEWAY_BROWSER_ORIGIN: ${GIT_GATEWAY_BROWSER_ORIGIN:?set GIT_GATEWAY_BROWSER_ORIGIN}');
    expect(compose).toContain('git-private:\n    internal: true');
    expect(compose).toContain('${GIT_GATEWAY_HOST_BIND_ADDRESS:-127.0.0.1}:${GIT_GATEWAY_HOST_PORT:-3180}:3180');
    expect(forgejoService).not.toContain('ports:');
    expect(forgejoService).toContain('oidc-egress:');
  });

  test('mounts only OIDC secrets and cannot start permission writers', () => {
    expect(runtimeConfig).toContain("secretEnv('GIT_OIDC_CLIENT_SECRET')");
    expect(runtimeConfig).toContain("secretEnv('GIT_OIDC_SIGNING_KEY')");
    expect(compose).toContain('GIT_OIDC_ALLOWED_NPUBS: ${GIT_OIDC_ALLOWED_NPUBS:-}');
    const towerService = composeService('tower', 'forgejo');
    const gatewayService = compose.slice(compose.indexOf('\n  git-gateway:\n'), compose.indexOf('\nnetworks:'));
    expect(towerService).toContain('git-oidc-client-secret:/run/tower-git-secrets/git-oidc-client-secret:ro');
    expect(towerService).toContain('git-oidc-signing-key.pem:/run/tower-git-secrets/git-oidc-signing-key.pem:ro');
    expect(gatewayService).not.toContain('tower:');
    expect(gatewayService).not.toContain('TOKEN');
    for (const retired of ['git-issue-broker', 'git-reconciler', 'git-identity-reconciler', 'git-org-reconciler']) {
      expect(compose).not.toContain(`\n  ${retired}:\n`);
    }
    for (const secret of ['forgejo-control-token', 'forgejo-identity-token', 'git-internal-service-token', 'git-capability-hash-key', 'git-issue-broker-token']) {
      expect(compose).not.toContain(secret);
    }
  });
});
