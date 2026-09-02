import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const entrypoint = read('docker/entrypoint.sh');
const compose = read('docker-compose.prod.yml');
const apiEnv = read('caprover/tower-api.env.example');
const gatewayEnv = read('caprover/git-gateway.env.example');
const brokerEnv = read('caprover/git-issue-broker.env.example');
const identityEnv = read('caprover/git-identity-reconciler.env.example');
const orgEnv = read('caprover/git-org-reconciler.env.example');
const forgejoEnv = read('caprover/forgejo.env.example');

describe('CapRover deployment contract', () => {
  test('starts each Tower process from the shared image by explicit role', () => {
    expect(entrypoint).toContain('runtime_role=${TOWER_RUNTIME_ROLE:-api}');
    expect(entrypoint).toContain('git-gateway)');
    expect(entrypoint).toContain('exec bun run git:gateway');
    expect(entrypoint).toContain('git-issue-broker)');
    expect(entrypoint).toContain('exec bun run git:issues');
    expect(entrypoint).toContain('git-identity-reconciler)');
    expect(entrypoint).toContain('exec bun run git:reconcile-identities');
    expect(entrypoint).toContain('git-org-reconciler)');
    expect(entrypoint).toContain('exec bun run git:reconcile-organizations');
    expect(apiEnv).toContain('TOWER_RUNTIME_ROLE=api');
    expect(gatewayEnv).toContain('TOWER_RUNTIME_ROLE=git-gateway');
    expect(brokerEnv).toContain('TOWER_RUNTIME_ROLE=git-issue-broker');
    expect(identityEnv).toContain('TOWER_RUNTIME_ROLE=git-identity-reconciler');
    expect(orgEnv).toContain('TOWER_RUNTIME_ROLE=git-org-reconciler');
  });

  test('uses the stable public origins and CapRover private service names', () => {
    expect(apiEnv).toContain('SUPERBASED_DIRECT_HTTPS_URL=https://tower-stable-api.b.otherstuff.ai');
    expect(apiEnv).toContain('STORAGE_S3_ENDPOINT_PUBLIC=https://tower-stable-minio.b.otherstuff.ai');
    expect(apiEnv).toContain('GIT_OIDC_ISSUER=https://tower-stable-api.b.otherstuff.ai/api/v4/git/oidc');
    expect(apiEnv).toContain('GIT_OIDC_REDIRECT_URI=https://tower-stable-forgejo.b.otherstuff.ai/user/oauth2/tower/callback');
    expect(gatewayEnv).toContain('GIT_GATEWAY_BROWSER_ORIGIN=https://tower-stable-forgejo.b.otherstuff.ai');
    for (const env of [apiEnv, gatewayEnv, brokerEnv, identityEnv, orgEnv]) {
      expect(env).toContain('http://srv-captain--tower-stable-forgejo-provider:3000');
    }
    expect(orgEnv).toContain('GIT_GATEWAY_TOWER_URL=http://srv-captain--tower-stable-api:3100');
  });

  test('keeps Forgejo authentication fail-closed behind the gateway', () => {
    expect(forgejoEnv).toContain('FORGEJO__service__DISABLE_REGISTRATION=true');
    expect(forgejoEnv).toContain('FORGEJO__service__ENABLE_INTERNAL_SIGNIN=false');
    expect(forgejoEnv).toContain('FORGEJO__service__ENABLE_BASIC_AUTHENTICATION=false');
    expect(forgejoEnv).toContain('FORGEJO__service__ENABLE_REVERSE_PROXY_AUTO_REGISTRATION=false');
    expect(forgejoEnv).toContain('FORGEJO__actions__ENABLED=false');
  });

  test('passes the required Flight Deck identity into the production API', () => {
    expect(compose).toContain('FLIGHT_DECK_PG_APP_NPUB: ${FLIGHT_DECK_PG_APP_NPUB:?set FLIGHT_DECK_PG_APP_NPUB}');
    expect(apiEnv).toContain('FLIGHT_DECK_PG_APP_NPUB=REPLACE_WITH_FLIGHT_DECK_APP_NPUB');
  });
});
