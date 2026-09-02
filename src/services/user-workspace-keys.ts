import { getDb } from '../db';
import type {
  UserProfile,
  UserWorkspaceKey,
  WorkspaceKeyEntry,
} from '../types';

type DbClient = ReturnType<typeof getDb>;

function asDbClient(sql: unknown): DbClient {
  return sql as DbClient;
}

export type WorkspaceUserKeyDelegationCode =
  | 'workspace_key_missing'
  | 'workspace_key_invalid'
  | 'workspace_key_revoked';

export interface WorkspaceUserKeyDelegationInput {
  userNpub: string;
  workspaceServiceNpub: string;
  workspaceUserKeyNpub: string | null | undefined;
  signerNpub: string;
}

export interface DeviceKeyMetadataInput {
  label?: string | null;
  platform?: string | null;
  policy?: Record<string, unknown> | null;
}

export class WorkspaceUserKeyDelegationError extends Error {
  readonly code: WorkspaceUserKeyDelegationCode;
  readonly userNpub: string;
  readonly workspaceServiceNpub: string;
  readonly workspaceUserKeyNpub: string | null;
  readonly signerNpub: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: WorkspaceUserKeyDelegationCode,
    message: string,
    input: WorkspaceUserKeyDelegationInput,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkspaceUserKeyDelegationError';
    this.code = code;
    this.userNpub = input.userNpub;
    this.workspaceServiceNpub = input.workspaceServiceNpub;
    this.workspaceUserKeyNpub = input.workspaceUserKeyNpub || null;
    this.signerNpub = input.signerNpub;
    this.details = details;
  }
}

export function isWorkspaceUserKeyDelegationError(error: unknown): error is WorkspaceUserKeyDelegationError {
  return error instanceof WorkspaceUserKeyDelegationError;
}

/**
 * Ensure a user_profiles row exists for the given npub.
 * Returns the existing or newly created profile.
 */
export async function ensureUserProfile(userNpub: string): Promise<UserProfile> {
  const sql = getDb();
  const [profile] = await sql<UserProfile[]>`
    INSERT INTO user_profiles (user_npub)
    VALUES (${userNpub})
    ON CONFLICT (user_npub) DO NOTHING
    RETURNING *
  `;
  if (profile) return profile;

  const [existing] = await sql<UserProfile[]>`
    SELECT * FROM user_profiles WHERE user_npub = ${userNpub}
  `;
  return existing;
}

/**
 * Register a workspace session key for a user.
 * Verifies the user has access to the workspace and the ws_key_npub is not
 * already registered to a different user.
 */
export async function registerWorkspaceKey(
  userNpub: string,
  workspaceOwnerNpub: string,
  wsKeyNpub: string,
  metadata: DeviceKeyMetadataInput = {},
): Promise<UserWorkspaceKey> {
  const sql = getDb();

  // Check ws_key_npub not already registered to a different user
  const [existing] = await sql<UserWorkspaceKey[]>`
    SELECT * FROM user_workspace_keys
    WHERE ws_key_npub = ${wsKeyNpub}
  `;
  if (existing && existing.user_npub !== userNpub) {
    throw Object.assign(
      new Error('ws_key_npub is already registered to a different user'),
      { code: 'KEY_CONFLICT' },
    );
  }
  if (existing && existing.user_npub === userNpub) {
    const [updated] = await sql<UserWorkspaceKey[]>`
      UPDATE user_workspace_keys
      SET device_label = COALESCE(${metadata.label ?? null}, device_label),
          device_platform = COALESCE(${metadata.platform ?? null}, device_platform),
          device_policy = COALESCE(${metadata.policy ? sql.json(metadata.policy as any) : null}, device_policy),
          last_seen_at = NOW()
      WHERE workspace_owner_npub = ${existing.workspace_owner_npub}
        AND ws_key_npub = ${existing.ws_key_npub}
      RETURNING *
    `;
    return updated ?? existing;
  }

  // Determine next epoch for this user+workspace
  const [maxEpoch] = await sql<{ max_epoch: number | null }[]>`
    SELECT MAX(ws_key_epoch) AS max_epoch
    FROM user_workspace_keys
    WHERE user_npub = ${userNpub}
      AND workspace_owner_npub = ${workspaceOwnerNpub}
  `;
  const nextEpoch = (maxEpoch?.max_epoch ?? 0) + 1;

  const [key] = await sql<UserWorkspaceKey[]>`
    INSERT INTO user_workspace_keys (
      user_npub,
      workspace_owner_npub,
      ws_key_npub,
      ws_key_epoch,
      active,
      device_label,
      device_platform,
      device_policy,
      last_seen_at
    ) VALUES (
      ${userNpub},
      ${workspaceOwnerNpub},
      ${wsKeyNpub},
      ${nextEpoch},
      true,
      ${metadata.label ?? null},
      ${metadata.platform ?? null},
      ${sql.json((metadata.policy ?? {}) as any)},
      NOW()
    )
    RETURNING *
  `;

  invalidateWsKeyCache(wsKeyNpub);
  return key;
}

/**
 * List all workspace keys for a user.
 */
export async function listWorkspaceKeys(userNpub: string): Promise<WorkspaceKeyEntry[]> {
  const sql = getDb();
  const keys = await sql<WorkspaceKeyEntry[]>`
    SELECT
      user_npub,
      workspace_owner_npub,
      ws_key_npub,
      ws_key_epoch,
      active,
      device_label,
      device_platform,
      device_policy,
      last_seen_at,
      revoked_at,
      registered_at
    FROM user_workspace_keys
    WHERE user_npub = ${userNpub}
    ORDER BY workspace_owner_npub, ws_key_epoch DESC
  `;
  return keys;
}

export async function touchWorkspaceKeyLastSeen(
  userNpub: string,
  workspaceOwnerNpub: string,
  wsKeyNpub: string,
): Promise<UserWorkspaceKey | null> {
  const sql = getDb();
  const [key] = await sql<UserWorkspaceKey[]>`
    UPDATE user_workspace_keys
    SET last_seen_at = NOW()
    WHERE user_npub = ${userNpub}
      AND workspace_owner_npub = ${workspaceOwnerNpub}
      AND ws_key_npub = ${wsKeyNpub}
    RETURNING *
  `;
  return key ?? null;
}

export async function revokeWorkspaceKey(
  userNpub: string,
  wsKeyNpub: string,
): Promise<UserWorkspaceKey | null> {
  const sql = getDb();
  const [key] = await sql<UserWorkspaceKey[]>`
    UPDATE user_workspace_keys
    SET active = false,
        revoked_at = COALESCE(revoked_at, NOW())
    WHERE user_npub = ${userNpub}
      AND ws_key_npub = ${wsKeyNpub}
    RETURNING *
  `;
  if (key) invalidateWsKeyCache(wsKeyNpub);
  return key ?? null;
}

/**
 * Rotate a workspace key: register new key, deactivate old key.
 */
export async function rotateWorkspaceKey(
  userNpub: string,
  workspaceOwnerNpub: string,
  newWsKeyNpub: string,
  oldWsKeyNpub: string,
): Promise<UserWorkspaceKey> {
  const sql = getDb();

  return sql.begin(async (tx) => {
    const transaction = asDbClient(tx);

    // Verify old key belongs to this user + workspace
    const [oldKey] = await transaction<UserWorkspaceKey[]>`
      SELECT * FROM user_workspace_keys
      WHERE ws_key_npub = ${oldWsKeyNpub}
        AND user_npub = ${userNpub}
        AND workspace_owner_npub = ${workspaceOwnerNpub}
    `;
    if (!oldKey) {
      throw Object.assign(
        new Error('old_ws_key_npub not found for this user and workspace'),
        { code: 'NOT_FOUND' },
      );
    }

    // Deactivate old key
    await transaction`
      UPDATE user_workspace_keys
      SET active = false
      WHERE ws_key_npub = ${oldWsKeyNpub}
        AND user_npub = ${userNpub}
        AND workspace_owner_npub = ${workspaceOwnerNpub}
    `;

    // Check new key not already registered to someone else
    const [conflict] = await transaction<UserWorkspaceKey[]>`
      SELECT * FROM user_workspace_keys
      WHERE ws_key_npub = ${newWsKeyNpub}
    `;
    if (conflict && conflict.user_npub !== userNpub) {
      throw Object.assign(
        new Error('new_ws_key_npub is already registered to a different user'),
        { code: 'KEY_CONFLICT' },
      );
    }

    const nextEpoch = oldKey.ws_key_epoch + 1;

    const [newKey] = await transaction<UserWorkspaceKey[]>`
      INSERT INTO user_workspace_keys (
        user_npub, workspace_owner_npub, ws_key_npub, ws_key_epoch, active
      ) VALUES (
        ${userNpub}, ${workspaceOwnerNpub}, ${newWsKeyNpub}, ${nextEpoch}, true
      )
      ON CONFLICT (workspace_owner_npub, ws_key_npub) DO UPDATE
      SET ws_key_epoch = EXCLUDED.ws_key_epoch,
          active = true
      RETURNING *
    `;

    invalidateWsKeyCache(oldWsKeyNpub);
    invalidateWsKeyCache(newWsKeyNpub);
    return newKey;
  });
}

// In-memory LRU cache for ws_key_npub → user_npub resolution.
// Workspace key mappings rarely change, so a short TTL avoids a DB round trip
// on every authenticated request. Negative lookups (direct-auth users) are also
// cached to avoid querying for npubs that will never be workspace keys.
const WS_KEY_CACHE_MAX = 200;
const WS_KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

const wsKeyCache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null | undefined {
  const entry = wsKeyCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    wsKeyCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: string | null): void {
  // Evict oldest entries if at capacity
  if (wsKeyCache.size >= WS_KEY_CACHE_MAX) {
    const firstKey = wsKeyCache.keys().next().value;
    if (firstKey !== undefined) wsKeyCache.delete(firstKey);
  }
  wsKeyCache.set(key, { value, expiresAt: Date.now() + WS_KEY_CACHE_TTL_MS });
}

/**
 * Invalidate a specific ws_key_npub from the resolution cache.
 * Called after registration or rotation to ensure stale mappings are cleared.
 */
export function invalidateWsKeyCache(wsKeyNpub: string): void {
  wsKeyCache.delete(wsKeyNpub);
}

/**
 * Test helper: clear the entire ws_key resolution cache. Production code
 * should not need this — call invalidateWsKeyCache for targeted eviction.
 * Multi-database test runs share the module-level cache, so test files that
 * spin up isolated postgres databases must flush this in their teardown.
 */
export function clearWsKeyCacheForTests(): void {
  wsKeyCache.clear();
}

/**
 * List all active workspace key → user_npub mappings for a workspace.
 * Used by clients to resolve ws_key_npubs to display identities.
 */
export async function getWorkspaceKeyMappings(
  workspaceOwnerNpub: string,
): Promise<{ workspace_owner_npub: string; ws_key_npub: string; user_npub: string }[]> {
  const sql = getDb();
  return sql<{ workspace_owner_npub: string; ws_key_npub: string; user_npub: string }[]>`
    SELECT workspace_owner_npub, ws_key_npub, user_npub
    FROM user_workspace_keys
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      AND active = true
    ORDER BY registered_at DESC
  `;
}

export async function listWorkspaceKeyBindings(wsKeyNpub: string): Promise<UserWorkspaceKey[]> {
  const sql = getDb();
  return sql<UserWorkspaceKey[]>`
    SELECT *
    FROM user_workspace_keys
    WHERE ws_key_npub = ${wsKeyNpub}
    ORDER BY active DESC, ws_key_epoch DESC, registered_at DESC
  `;
}

export async function getWorkspaceKeyBinding(
  wsKeyNpub: string,
  workspaceOwnerNpub: string,
): Promise<UserWorkspaceKey | null> {
  const sql = getDb();
  const [row] = await sql<UserWorkspaceKey[]>`
    SELECT *
    FROM user_workspace_keys
    WHERE ws_key_npub = ${wsKeyNpub}
      AND workspace_owner_npub = ${workspaceOwnerNpub}
    ORDER BY active DESC, ws_key_epoch DESC, registered_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * Verify the canonical delegated-key relationship for normal app requests.
 *
 * In canonical identity terms, workspace_owner_npub in the current table is the
 * workspaceServiceNpub, and ws_key_npub is the workspaceUserKeyNpub.
 */
export async function requireWorkspaceUserKeyDelegation(
  input: WorkspaceUserKeyDelegationInput,
): Promise<UserWorkspaceKey> {
  const workspaceUserKeyNpub = String(input.workspaceUserKeyNpub || '').trim();
  if (!workspaceUserKeyNpub) {
    throw new WorkspaceUserKeyDelegationError(
      'workspace_key_missing',
      'workspace_user_key_npub required for delegated workspace key authorization',
      input,
    );
  }

  if (input.signerNpub !== workspaceUserKeyNpub) {
    throw new WorkspaceUserKeyDelegationError(
      'workspace_key_invalid',
      'signer_npub must match workspace_user_key_npub',
      input,
      {
        signer_npub: input.signerNpub,
        workspace_user_key_npub: workspaceUserKeyNpub,
      },
    );
  }

  const binding = await getWorkspaceKeyBinding(workspaceUserKeyNpub, input.workspaceServiceNpub);
  if (!binding) {
    throw new WorkspaceUserKeyDelegationError(
      'workspace_key_invalid',
      'workspace_user_key_npub is not registered for this workspace',
      input,
    );
  }

  if (binding.user_npub !== input.userNpub) {
    throw new WorkspaceUserKeyDelegationError(
      'workspace_key_invalid',
      'workspace_user_key_npub is not delegated to this user_npub',
      input,
      {
        delegated_user_npub: binding.user_npub,
      },
    );
  }

  if (!binding.active) {
    throw new WorkspaceUserKeyDelegationError(
      'workspace_key_revoked',
      'workspace_user_key_npub is inactive for this workspace',
      input,
    );
  }

  return binding;
}

/**
 * Resolve a ws_key_npub to the real user_npub.
 * Returns null if not found (meaning the npub is not a workspace session key).
 * Uses an in-memory cache to avoid a DB lookup on every request.
 */
export async function resolveWsKeyNpub(wsKeyNpub: string): Promise<string | null> {
  const cached = cacheGet(wsKeyNpub);
  if (cached !== undefined) return cached;

  const sql = getDb();
  const [row] = await sql<{ user_npub: string }[]>`
    SELECT user_npub
    FROM user_workspace_keys
    WHERE ws_key_npub = ${wsKeyNpub}
    ORDER BY active DESC, ws_key_epoch DESC, registered_at DESC
    LIMIT 1
  `;
  const result = row?.user_npub ?? null;
  cacheSet(wsKeyNpub, result);
  return result;
}
