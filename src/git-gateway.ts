import { createForgejoGateway } from './forgejo/gateway';

const port = Number.parseInt(process.env.GIT_GATEWAY_PORT || '3180', 10);
const app = createForgejoGateway({ forgejoUrl: String(process.env.GIT_FORGEJO_BASE_URL || '').trim(), publicOrigin: process.env.GIT_GATEWAY_BROWSER_ORIGIN?.trim() || undefined });
Bun.serve({ port: Number.isSafeInteger(port) && port > 0 ? port : 3180, fetch: app.fetch });
console.log('Forgejo native reverse proxy started');
