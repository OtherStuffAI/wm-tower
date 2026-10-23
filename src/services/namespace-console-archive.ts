import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db';
import { namespaceEntries } from './namespace-inventory';
import type { NamespaceInventory } from '../types';

type Action = 'archive' | 'restore';
type Entry = NamespaceInventory['apps'][number];
// Preview lifetime is deliberately one process lifetime; receipts survive restarts.
const previewKey = randomBytes(32);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const signature = (value: string) => createHmac('sha256', previewKey).update(value).digest();
const fingerprint = (entry: Entry) => hash(JSON.stringify(entry));
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });
export const archiveConfirmation = (action: Action, owner: string, app: string) => `${action.toUpperCase()} ${app.slice(-8)}`;
const protectedEntry = (entry: Entry) => entry.active_installations > 0 || entry.active_grants > 0 || entry.active_launchers > 0;
export const archiveImpact = 'Only console inventory visibility changes. Registration, enabled flag, every data store, schema, publisher history, grants and runtime access are retained. Graph, custom-schema contents, legacy records, storage, Git and external data are not fully measured. Permanent deletion is unavailable: complete data attribution and runtime quiescence have not been established.';

export async function previewNamespaceArchive(owner: string, app: string, actor: string, action: Action, db = getDb()) {
  if (action !== 'archive' && action !== 'restore') throw failure('action must be archive or restore', 400);
  return db.begin(async transaction => {
    const tx = transaction as unknown as typeof db;
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    await tx`SELECT set_config('statement_timeout', '3000', true)`;
    const [entry] = await namespaceEntries(owner, tx, app);
    if (!entry) throw failure('Registration not found', 404);
    const blocked = action === 'archive' && protectedEntry(entry);
    const reason = blocked ? 'Current publisher has an active installation, publishing grant or launcher. Archive is protected; manage the app lifecycle separately.' : null;
    const data = Buffer.from(JSON.stringify({ owner, app, actor, action, fingerprint: fingerprint(entry), expires: Date.now() + 5 * 60_000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
    return { workspace_owner_npub: owner, app_npub: app, action, entry, allowed: !blocked,
      blocked_reason: reason, impact: archiveImpact, confirmation: archiveConfirmation(action, owner, app),
      preview_token: blocked ? null : `${data}.${signature(data).toString('base64url')}`, expires_in_seconds: 300 };
  });
}

export async function applyNamespaceArchive(owner: string, app: string, actor: string, input: { action?: unknown; preview_token?: unknown; confirmation?: unknown }, db = getDb()) {
  const action = input.action;
  if (action !== 'archive' && action !== 'restore') throw failure('action must be archive or restore', 400);
  const token = typeof input.preview_token === 'string' ? input.preview_token : '';
  if (!token || token.length > 8192 || input.confirmation !== archiveConfirmation(action, owner, app)) throw failure('Exact confirmation and preview token required', 400);
  const tokenHash = hash(token);
  return db.begin(async transaction => {
    const tx = transaction as unknown as typeof db;
    await tx`SELECT set_config('lock_timeout', '3000', true), set_config('statement_timeout', '5000', true)`;
    // Serialize with registration/upserts and other archive operations on this pair.
    const [registration] = await tx`SELECT id FROM workspace_apps WHERE workspace_owner_npub=${owner} AND app_npub=${app} FOR UPDATE`;
    if (!registration) throw failure('Registration not found', 404);
    const [receipt] = await tx`SELECT * FROM namespace_console_archive_receipts WHERE token_hash=${tokenHash}`;
    if (receipt) {
      if (receipt.workspace_owner_npub !== owner || receipt.app_npub !== app || receipt.actor_npub !== actor || receipt.action !== action) throw failure('Preview target or actor mismatch', 400);
      return { ...receipt.result, replayed: true };
    }
    const [data, mac, extra] = token.split('.');
    const supplied = Buffer.from(mac || '', 'base64url');
    if (!data || extra || supplied.length !== 32 || !timingSafeEqual(signature(data), supplied)) throw failure('Invalid preview; request a new preview', 409);
    let preview: any;
    try { preview = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { throw failure('Invalid preview', 400); }
    if (preview.owner !== owner || preview.app !== app || preview.actor !== actor || preview.action !== action) throw failure('Preview target or actor mismatch', 400);
    if (preview.expires < Date.now()) throw failure('Preview expired; request a new preview');
    // Lock only matching installation rows, never tables or unrelated tenants.
    // A new installation/activation may commit later: inventory always shows
    // active publishers even when a previous archive preference exists.
    await tx`SELECT id FROM flightdeck_pg_wapp_installations
      WHERE owner_npub=${owner} AND publisher_npub=${app} FOR SHARE NOWAIT`;
    const [entry] = await namespaceEntries(owner, tx, app);
    if (!entry || fingerprint(entry) !== preview.fingerprint) throw failure('Preview changed; review a new preview');
    if (action === 'archive' && protectedEntry(entry)) throw failure('Active publisher is protected');
    const [state] = await tx`
      INSERT INTO namespace_console_archives (workspace_owner_npub,app_npub,archived,changed_by_npub)
      VALUES (${owner},${app},${action === 'archive'},${actor})
      ON CONFLICT (workspace_owner_npub,app_npub) DO UPDATE SET archived=EXCLUDED.archived,
        revision=namespace_console_archives.revision+1,changed_by_npub=EXCLUDED.changed_by_npub,changed_at=NOW()
      RETURNING archived,revision::text
    `;
    const result = { workspace_owner_npub: owner, app_npub: app, action, archived: state!.archived, archive_revision: state!.revision, replayed: false, impact: archiveImpact };
    await tx`INSERT INTO namespace_console_archive_receipts (token_hash,workspace_owner_npub,app_npub,actor_npub,action,result)
      VALUES (${tokenHash},${owner},${app},${actor},${action},${tx.json(result)})`;
    return result;
  });
}
