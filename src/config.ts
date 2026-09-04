import { secretEnv } from './secret-env';

function csvValues(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function requiredNpubEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value.startsWith('npub1')) {
    throw new Error(`${name} must be set to the Flight Deck app npub`);
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[name] || fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: parseInt(process.env.PORT || '3100', 10),
  directHttpsUrl: requiredEnv('SUPERBASED_DIRECT_HTTPS_URL'),
  adminNpub: requiredNpubEnv('ADMIN_NPUB'),
  storage: {
    s3Endpoint: (process.env.STORAGE_S3_ENDPOINT || 'http://127.0.0.1:9000').trim(),
    s3PublicEndpoint: requiredEnv('STORAGE_S3_ENDPOINT_PUBLIC'),
    s3Region: (process.env.STORAGE_S3_REGION || 'us-east-1').trim(),
    s3AccessKey: requiredEnv('STORAGE_S3_ACCESS_KEY'),
    s3SecretKey: requiredEnv('STORAGE_S3_SECRET_KEY'),
    s3Bucket: (process.env.STORAGE_S3_BUCKET || 'superbased-storage').trim(),
    s3ForcePathStyle: !/^(false|0|no)$/i.test((process.env.STORAGE_S3_FORCE_PATH_STYLE || 'true').trim()),
    presignUploadTtlSeconds: parseInt(process.env.STORAGE_PRESIGN_UPLOAD_TTL_SECONDS || '900', 10),
    presignDownloadTtlSeconds: parseInt(process.env.STORAGE_PRESIGN_DOWNLOAD_TTL_SECONDS || '900', 10),
  },
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'coworker_v4',
    user: requiredEnv('DB_USER'),
    password: requiredEnv('DB_PASSWORD'),
    max: parseInt(process.env.DB_MAX_CONNECTIONS || '10', 10),
  },
  graph: {
    enabled: /^(1|true|yes)$/i.test((process.env.GRAPH_ENABLED || '').trim()),
    ageGraphName: (process.env.GRAPH_AGE_GRAPH_NAME || 'tower_memory').trim(),
    db: {
      host: process.env.GRAPH_DB_HOST || '127.0.0.1',
      port: parseInt(process.env.GRAPH_DB_PORT || '5432', 10),
      database: process.env.GRAPH_DB_NAME || 'tower_graph',
      adminUser: requiredEnv('GRAPH_DB_ADMIN_USER'),
      adminPassword: requiredEnv('GRAPH_DB_ADMIN_PASSWORD'),
      appUser: requiredEnv('GRAPH_DB_APP_USER'),
      appPassword: requiredEnv('GRAPH_DB_APP_PASSWORD'),
      max: parseInt(process.env.GRAPH_DB_MAX_CONNECTIONS || '10', 10),
    },
    allowedNpubs: csvValues(process.env.GRAPH_ALLOWED_NPUBS),
  },
  service: {
    nsec: process.env.SUPERBASED_SERVICE_NSEC || '',
    pubkeyHex: process.env.SUPERBASED_SERVICE_PUBKEY_HEX || '',
    npub: process.env.SUPERBASED_SERVICE_NPUB || '',
  },
  flightDeck: {
    appNpub: requiredNpubEnv('FLIGHT_DECK_PG_APP_NPUB'),
  },
  wappActivity: {
    installationRequestsPerMinute: positiveIntEnv('WAPP_ACTIVITY_INSTALLATION_REQUESTS_PER_MINUTE', 60),
    installationBurstRequests: positiveIntEnv('WAPP_ACTIVITY_INSTALLATION_BURST_REQUESTS', 10),
    installationBurstWindowSeconds: positiveIntEnv('WAPP_ACTIVITY_INSTALLATION_BURST_WINDOW_SECONDS', 10),
    destinationRequestsPerMinute: positiveIntEnv('WAPP_ACTIVITY_DESTINATION_REQUESTS_PER_MINUTE', 30),
    resolvedHistoryDays: positiveIntEnv('WAPP_ACTIVITY_RESOLVED_HISTORY_DAYS', 30),
    projectionRetentionDays: positiveIntEnv('WAPP_ACTIVITY_PROJECTION_RETENTION_DAYS', 90),
    auditRetentionDays: positiveIntEnv('WAPP_ACTIVITY_AUDIT_RETENTION_DAYS', 365),
    activeMaxAgeDays: positiveIntEnv('WAPP_ACTIVITY_ACTIVE_MAX_AGE_DAYS', 365),
  },
  git: {
    // Git authority remains disabled/fail-closed until all three operator-owned
    // values are configured. Secrets are never defaulted in source.
    capabilityHashKey: secretEnv('GIT_CAPABILITY_HASH_KEY'),
    internalServiceToken: secretEnv('GIT_INTERNAL_SERVICE_TOKEN'),
    audience: String(process.env.GIT_SERVICE_AUDIENCE || '').trim(),
    gatewayOrigins: csvValues(process.env.GIT_GATEWAY_ORIGINS),
    capabilityTtlSeconds: Math.max(60, Math.min(600, positiveIntEnv('GIT_CAPABILITY_TTL_SECONDS', 300))),
    forgejoBaseUrl: String(process.env.GIT_FORGEJO_BASE_URL || '').trim().replace(/\/+$/, ''),
    forgejoControlToken: secretEnv('GIT_FORGEJO_CONTROL_TOKEN'),
    forgejoWebhookSecret: secretEnv('GIT_FORGEJO_WEBHOOK_SECRET'),
    forgejoWebhookUrl: String(process.env.GIT_FORGEJO_WEBHOOK_URL || '').trim(),
    issueBrokerUrl: String(process.env.GIT_ISSUE_BROKER_URL || '').trim().replace(/\/+$/, ''),
    issueBrokerToken: secretEnv('GIT_ISSUE_BROKER_TOKEN'),
    issueBrokerPort: positiveIntEnv('GIT_ISSUE_BROKER_PORT', 3190),
    gatewayTowerUrl: String(process.env.GIT_GATEWAY_TOWER_URL || '').trim().replace(/\/+$/, ''),
    gatewayFixedUsername: String(process.env.GIT_GATEWAY_FIXED_USERNAME || 'nostr').trim(),
    gatewayPort: positiveIntEnv('GIT_GATEWAY_PORT', 3180),
    oidcIssuer: String(process.env.GIT_OIDC_ISSUER || '').trim().replace(/\/+$/, ''),
    oidcClientId: String(process.env.GIT_OIDC_CLIENT_ID || 'forgejo').trim(),
    oidcClientSecret: secretEnv('GIT_OIDC_CLIENT_SECRET'),
    oidcSigningKey: secretEnv('GIT_OIDC_SIGNING_KEY'),
    oidcRedirectUri: String(process.env.GIT_OIDC_REDIRECT_URI || '').trim(),
  },
  tower: {
    name: String(process.env.SUPERBASED_TOWER_NAME || '').trim() || null,
    description: String(process.env.SUPERBASED_TOWER_DESCRIPTION || '').trim() || null,
  },
  billing: {
    mode: /^(metered)$/i.test((process.env.SUPERBASED_BILLING_MODE || '').trim()) ? 'metered' : 'disabled',
    graceDays: parseInt(process.env.SUPERBASED_BILLING_GRACE_DAYS || '21', 10),
    initialGrantCredits: Number(process.env.SUPERBASED_INITIAL_WORKSPACE_CREDITS || '0'),
    lowBalanceThresholdCredits: Number(process.env.SUPERBASED_LOW_BALANCE_THRESHOLD_CREDITS || '24'),
    mginxUrl: String(process.env.MGINX_URL || '').trim().replace(/\/+$/, ''),
    mginxApiKey: String(process.env.MGINX_API_KEY || '').trim(),
    creditsProductId: String(process.env.SUPERBASED_CREDITS_PRODUCT_ID || '').trim(),
  },
  checkoutPolicies: {
    checkoutRequiredRecordFamilyHashes: csvValues(process.env.SUPERBASED_CHECKOUT_REQUIRED_RECORD_FAMILY_HASHES),
    checkoutRequiredFamilySuffixes: csvValues(process.env.SUPERBASED_CHECKOUT_REQUIRED_FAMILY_SUFFIXES),
  },
};
