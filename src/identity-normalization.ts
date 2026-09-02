export class IdentityNormalizationError extends Error {
  readonly code = 'identity_alias_mismatch';
  readonly canonicalName: string;
  readonly fields: string[];

  constructor(canonicalName: string, fields: string[]) {
    super(`${fields.join(' and ')} must match when provided`);
    this.name = 'IdentityNormalizationError';
    this.canonicalName = canonicalName;
    this.fields = fields;
  }
}

export function isIdentityNormalizationError(error: unknown): error is IdentityNormalizationError {
  return error instanceof IdentityNormalizationError;
}

function readNonEmptyString(input: Record<string, unknown>, field: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, field)) return undefined;
  const value = input[field];
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed || undefined;
}

export function normalizeAliasedIdentityField(
  input: Record<string, unknown>,
  fields: string[],
  canonicalName: string,
): string | undefined {
  const values = fields
    .map((field) => readNonEmptyString(input, field))
    .filter((value): value is string => value !== undefined);

  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length > 1) {
    throw new IdentityNormalizationError(canonicalName, fields);
  }

  return uniqueValues[0];
}

export function normalizeWorkspaceServiceNpub(
  input: Record<string, unknown>,
  fields: string[] = ['owner_npub', 'workspace_service_npub'],
): string | undefined {
  return normalizeAliasedIdentityField(input, fields, 'workspaceServiceNpub');
}

export function normalizeWorkspaceUserKeyNpub(
  input: Record<string, unknown>,
  fields: string[] = ['ws_key_npub', 'workspace_user_key_npub'],
): string | undefined {
  return normalizeAliasedIdentityField(input, fields, 'workspaceUserKeyNpub');
}

export function identityNormalizationErrorBody(error: IdentityNormalizationError) {
  return {
    error: error.message,
    code: error.code,
    canonical_name: error.canonicalName,
    fields: error.fields,
  };
}
