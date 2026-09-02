import { createForgejoGateway } from './forgejo/gateway';
import { secretEnv } from './secret-env';

const port = Number.parseInt(process.env.GIT_GATEWAY_PORT || '3180', 10);
const towerUrl = String(process.env.GIT_GATEWAY_TOWER_URL || '').trim();
const forgejoUrl = String(process.env.GIT_FORGEJO_BASE_URL || '').trim();
const audience = String(process.env.GIT_SERVICE_AUDIENCE || '').trim();
const browserOrigin = String(process.env.GIT_GATEWAY_BROWSER_ORIGIN || '').trim();
const fixedUsername = String(process.env.GIT_GATEWAY_FIXED_USERNAME || 'nostr').trim();
const internalServiceToken = secretEnv('GIT_INTERNAL_SERVICE_TOKEN');

const app = createForgejoGateway({
  towerUrl,
  forgejoUrl,
  internalServiceToken,
  audience,
  browserOrigin,
  fixedUsername,
});

Bun.serve({ port: Number.isSafeInteger(port) && port > 0 ? port : 3180, fetch: app.fetch });
console.log(`Tower Git gateway listening on ${Number.isSafeInteger(port) && port > 0 ? port : 3180}`);
