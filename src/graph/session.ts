import { getGraphDb, type GraphDb } from './db';

export type GraphIdentityContext = {
  signerNpub: string;
  userNpub: string;
  actorNpub: string;
  sourceAppNpub?: string | null;
  workspaceOwnerNpub?: string | null;
  groupIds?: string[];
};

export async function withGraphIdentity<T>(
  ctx: GraphIdentityContext,
  fn: (sql: GraphDb) => Promise<T>,
): Promise<T> {
  const sql = getGraphDb();

  return sql.begin(async (tx) => {
    const graphTx = tx as unknown as GraphDb;

    await graphTx`SELECT set_config('row_security', 'on', true)`;
    await graphTx`SELECT set_config('app.workspace_owner_npub', ${ctx.workspaceOwnerNpub || ''}, true)`;
    await graphTx`SELECT set_config('app.signer_npub', ${ctx.signerNpub}, true)`;
    await graphTx`SELECT set_config('app.user_npub', ${ctx.userNpub}, true)`;
    await graphTx`SELECT set_config('app.actor_npub', ${ctx.actorNpub}, true)`;
    await graphTx`SELECT set_config('app.source_app_npub', ${ctx.sourceAppNpub || ''}, true)`;
    await graphTx`SELECT set_config('app.group_ids', ${JSON.stringify(ctx.groupIds || [])}, true)`;

    return fn(graphTx);
  }) as Promise<T>;
}
