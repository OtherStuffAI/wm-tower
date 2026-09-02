import { config } from '../config';
import { getDb } from '../db';
import type {
  BillingState,
  WorkspaceCreditAccount,
  WorkspaceCreditOrder,
  WorkspaceCreditTransaction,
} from '../types';
import { createOrder, getOrderStatus, getProduct } from './mginx';
import { formatCredits, measureWorkspaceUsage, roundedBillableMb, type WorkspaceUsageSnapshot } from './usage';

type SqlLike = ReturnType<typeof getDb>;

const BLOCKING_STATES = new Set<BillingState>(['read_only_grace', 'delete_eligible', 'suspended']);

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function billingGraceDays() {
  const days = Number(config.billing.graceDays);
  return Number.isFinite(days) && days >= 0 ? days : 21;
}

function billingUrl(workspaceOwnerNpub: string) {
  return `${config.directHttpsUrl.replace(/\/+$/, '')}/ui/workspaces/${encodeURIComponent(workspaceOwnerNpub)}/billing`;
}

function stateForPositiveBalance(balance: number, lowBalanceThreshold: number): Exclude<BillingState, 'disabled'> {
  if (balance <= 0) return 'read_only_grace';
  if (balance <= lowBalanceThreshold) return 'low_balance';
  return 'active';
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function dateToIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function workspaceExists(workspaceOwnerNpub: string, sqlLike: SqlLike) {
  const [workspace] = await sqlLike<{ workspace_owner_npub: string }[]>`
    SELECT workspace_owner_npub
    FROM v4_workspaces
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
    LIMIT 1
  `;
  return Boolean(workspace);
}

export async function ensureWorkspaceCreditAccount(
  workspaceOwnerNpub: string,
  sqlLike: SqlLike = getDb(),
): Promise<WorkspaceCreditAccount | null> {
  if (!workspaceOwnerNpub) return null;
  if (!(await workspaceExists(workspaceOwnerNpub, sqlLike))) return null;

  const existing = await sqlLike<WorkspaceCreditAccount[]>`
    SELECT *
    FROM workspace_credit_accounts
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
    LIMIT 1
  `;
  if (existing[0]) return existing[0];

  const grantCredits = Math.max(0, finiteNumber(config.billing.initialGrantCredits));
  const lowBalanceThreshold = Math.max(0, finiteNumber(config.billing.lowBalanceThresholdCredits, 24));
  const now = new Date();
  const initialState = stateForPositiveBalance(grantCredits, lowBalanceThreshold);
  const depletedAt = grantCredits <= 0 ? now : null;
  const deleteEligibleAt = grantCredits <= 0 ? addDays(now, billingGraceDays()) : null;

  const [account] = await sqlLike<WorkspaceCreditAccount[]>`
    INSERT INTO workspace_credit_accounts (
      workspace_owner_npub,
      balance_credits,
      low_balance_threshold_credits,
      billing_state,
      depleted_at,
      delete_eligible_at
    )
    VALUES (
      ${workspaceOwnerNpub},
      ${formatCredits(grantCredits)},
      ${formatCredits(lowBalanceThreshold)},
      ${initialState},
      ${depletedAt},
      ${deleteEligibleAt}
    )
    ON CONFLICT (workspace_owner_npub) DO NOTHING
    RETURNING *
  `;

  if (!account) {
    const [afterConflict] = await sqlLike<WorkspaceCreditAccount[]>`
      SELECT *
      FROM workspace_credit_accounts
      WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      LIMIT 1
    `;
    return afterConflict || null;
  }

  if (grantCredits > 0) {
    await sqlLike`
      INSERT INTO workspace_credit_transactions (
        workspace_owner_npub,
        type,
        amount_credits,
        balance_before_credits,
        balance_after_credits,
        reference_type,
        reference_id,
        notes,
        metadata
      )
      VALUES (
        ${workspaceOwnerNpub},
        ${'migration_grant'},
        ${formatCredits(grantCredits)},
        ${formatCredits(0)},
        ${formatCredits(grantCredits)},
        ${'workspace'},
        ${workspaceOwnerNpub},
        ${'Initial workspace credit grant'},
        ${JSON.stringify({ source: 'SUPERBASED_INITIAL_WORKSPACE_CREDITS' })}::jsonb
      )
    `;
  }

  return account;
}

async function refreshAccountState(workspaceOwnerNpub: string, sqlLike: SqlLike = getDb()) {
  const account = await ensureWorkspaceCreditAccount(workspaceOwnerNpub, sqlLike);
  if (!account) return null;
  if (account.billing_state === 'read_only_grace' && account.delete_eligible_at) {
    const deleteEligibleAt = account.delete_eligible_at instanceof Date
      ? account.delete_eligible_at
      : new Date(account.delete_eligible_at);
    if (deleteEligibleAt.getTime() <= Date.now()) {
      const [updated] = await sqlLike<WorkspaceCreditAccount[]>`
        UPDATE workspace_credit_accounts
        SET billing_state = 'delete_eligible',
            updated_at = NOW()
        WHERE workspace_owner_npub = ${workspaceOwnerNpub}
          AND billing_state = 'read_only_grace'
        RETURNING *
      `;
      return updated || account;
    }
  }
  return account;
}

export function insufficientCreditsBody(account: WorkspaceCreditAccount, workspaceOwnerNpub = account.workspace_owner_npub) {
  return {
    error: 'workspace has run out of credits',
    code: 'insufficient_credits',
    status: 402,
    workspace_owner_npub: workspaceOwnerNpub,
    billing_state: account.billing_state,
    depleted_at: dateToIso(account.depleted_at),
    delete_eligible_at: dateToIso(account.delete_eligible_at),
    billing_url: billingUrl(workspaceOwnerNpub),
  };
}

export async function getInsufficientCreditsBlock(workspaceOwnerNpub: string) {
  if (config.billing.mode === 'disabled') return null;
  let account = await refreshAccountState(workspaceOwnerNpub);
  if (!account) return null;

  if (finiteNumber(account.balance_credits) <= 0 && !BLOCKING_STATES.has(account.billing_state)) {
    const now = new Date();
    const [updated] = await getDb()<WorkspaceCreditAccount[]>`
      UPDATE workspace_credit_accounts
      SET billing_state = 'read_only_grace',
          depleted_at = COALESCE(depleted_at, ${now}),
          delete_eligible_at = COALESCE(delete_eligible_at, ${addDays(now, billingGraceDays())}),
          updated_at = NOW()
      WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      RETURNING *
    `;
    account = updated || account;
  }

  return BLOCKING_STATES.has(account.billing_state)
    ? insufficientCreditsBody(account, workspaceOwnerNpub)
    : null;
}

export async function getWorkspaceBillingStatus(workspaceOwnerNpub: string) {
  const usage = await measureWorkspaceUsage(workspaceOwnerNpub);
  const [workspace] = await getDb()<{
    workspace_owner_npub: string;
    name: string;
  }[]>`
    SELECT workspace_owner_npub, name
    FROM v4_workspaces
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
    LIMIT 1
  `;
  if (!workspace) return null;

  if (config.billing.mode === 'disabled') {
    return {
      billing_mode: 'disabled',
      workspace_owner_npub: workspace.workspace_owner_npub,
      workspace_name: workspace.name,
      billing_state: 'disabled',
      balance_credits: formatCredits(0),
      usage,
      estimated_runout_at: null,
      depleted_at: null,
      delete_eligible_at: null,
      billing_url: billingUrl(workspaceOwnerNpub),
    };
  }

  const account = await refreshAccountState(workspaceOwnerNpub);
  if (!account) return null;
  const hourlyBurn = finiteNumber(usage.estimated_credits_per_hour);
  const balance = finiteNumber(account.balance_credits);
  const estimatedRunoutAt = hourlyBurn > 0 && balance > 0
    ? new Date(Date.now() + (balance / hourlyBurn) * 60 * 60 * 1000).toISOString()
    : null;

  return {
    billing_mode: 'metered',
    workspace_owner_npub: workspace.workspace_owner_npub,
    workspace_name: workspace.name,
    billing_state: account.billing_state,
    balance_credits: formatCredits(balance),
    usage,
    estimated_runout_at: estimatedRunoutAt,
    depleted_at: dateToIso(account.depleted_at),
    delete_eligible_at: dateToIso(account.delete_eligible_at),
    billing_url: billingUrl(workspaceOwnerNpub),
  };
}

export async function listWorkspaceBillingStatuses(workspaceOwnerNpubs: string[]) {
  const statuses = [];
  for (const workspaceOwnerNpub of workspaceOwnerNpubs) {
    const status = await getWorkspaceBillingStatus(workspaceOwnerNpub);
    if (status) statuses.push(status);
  }
  return statuses;
}

export async function getWorkspaceBillingDetails(workspaceOwnerNpub: string) {
  const status = await getWorkspaceBillingStatus(workspaceOwnerNpub);
  if (!status) return null;
  if (config.billing.mode === 'disabled') {
    return {
      ...status,
      product: null,
      pending_orders: [],
    };
  }

  const [productResult, pendingOrders] = await Promise.all([
    getProduct().catch(() => null),
    getDb()<WorkspaceCreditOrder[]>`
      SELECT *
      FROM workspace_credit_orders
      WHERE workspace_owner_npub = ${workspaceOwnerNpub}
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 20
    `,
  ]);

  return {
    ...status,
    product: productResult ? {
      id: productResult.id,
      price_sats: productResult.priceSats,
      unit: 'MB-hour',
    } : null,
    pending_orders: pendingOrders,
  };
}

export async function listWorkspaceCreditTransactions(workspaceOwnerNpub: string, limit = 100) {
  await ensureWorkspaceCreditAccount(workspaceOwnerNpub);
  return getDb()<WorkspaceCreditTransaction[]>`
    SELECT *
    FROM workspace_credit_transactions
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
    ORDER BY created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `;
}

export async function markDeleteEligibleWorkspaces(now = new Date()) {
  if (config.billing.mode === 'disabled') return [];
  return getDb()<WorkspaceCreditAccount[]>`
    UPDATE workspace_credit_accounts
    SET billing_state = 'delete_eligible',
        updated_at = NOW()
    WHERE billing_state = 'read_only_grace'
      AND delete_eligible_at IS NOT NULL
      AND delete_eligible_at <= ${now}
    RETURNING *
  `;
}

export async function getOperationalBillingOverview() {
  await markDeleteEligibleWorkspaces();
  const sql = getDb();
  const [counts] = await sql<{
    active: string;
    low_balance: string;
    read_only_grace: string;
    delete_eligible: string;
    suspended: string;
  }[]>`
    SELECT
      COUNT(*) FILTER (WHERE billing_state = 'active')::text AS active,
      COUNT(*) FILTER (WHERE billing_state = 'low_balance')::text AS low_balance,
      COUNT(*) FILTER (WHERE billing_state = 'read_only_grace')::text AS read_only_grace,
      COUNT(*) FILTER (WHERE billing_state = 'delete_eligible')::text AS delete_eligible,
      COUNT(*) FILTER (WHERE billing_state = 'suspended')::text AS suspended
    FROM workspace_credit_accounts
  `;

  const atRiskWorkspaces = await sql<{
    workspace_owner_npub: string;
    workspace_name: string;
    creator_npub: string;
    balance_credits: string;
    billing_state: string;
    depleted_at: Date | null;
    delete_eligible_at: Date | null;
    updated_at: Date;
  }[]>`
    SELECT
      a.workspace_owner_npub,
      w.name AS workspace_name,
      w.creator_npub,
      a.balance_credits::text,
      a.billing_state,
      a.depleted_at,
      a.delete_eligible_at,
      a.updated_at
    FROM workspace_credit_accounts a
    JOIN v4_workspaces w ON w.workspace_owner_npub = a.workspace_owner_npub
    WHERE a.billing_state IN ('low_balance', 'read_only_grace', 'delete_eligible', 'suspended')
    ORDER BY
      CASE a.billing_state
        WHEN 'delete_eligible' THEN 1
        WHEN 'suspended' THEN 2
        WHEN 'read_only_grace' THEN 3
        WHEN 'low_balance' THEN 4
        ELSE 5
      END,
      a.delete_eligible_at ASC NULLS LAST,
      a.balance_credits ASC
    LIMIT 100
  `;

  const unpaidOrders = await sql<WorkspaceCreditOrder[]>`
    SELECT *
    FROM workspace_credit_orders
    WHERE status = 'pending'
    ORDER BY created_at DESC
    LIMIT 100
  `;

  const recentAudits = await sql<{
    id: string;
    workspace_owner_npub: string;
    hour_start: Date;
    record_bytes: number;
    object_bytes: number;
    billable_bytes: number;
    billable_mb: string;
    credits_charged: string;
    balance_after_credits: string;
    created_at: Date;
  }[]>`
    SELECT
      id,
      workspace_owner_npub,
      hour_start,
      record_bytes,
      object_bytes,
      billable_bytes,
      billable_mb::text,
      credits_charged::text,
      balance_after_credits::text,
      created_at
    FROM workspace_usage_hourly_audits
    ORDER BY hour_start DESC, created_at DESC
    LIMIT 100
  `;

  return {
    billing_mode: config.billing.mode,
    counts: {
      active: Number.parseInt(counts?.active || '0', 10),
      low_balance: Number.parseInt(counts?.low_balance || '0', 10),
      read_only_grace: Number.parseInt(counts?.read_only_grace || '0', 10),
      delete_eligible: Number.parseInt(counts?.delete_eligible || '0', 10),
      suspended: Number.parseInt(counts?.suspended || '0', 10),
    },
    at_risk_workspaces: atRiskWorkspaces.map((row) => ({
      ...row,
      depleted_at: dateToIso(row.depleted_at),
      delete_eligible_at: dateToIso(row.delete_eligible_at),
      updated_at: dateToIso(row.updated_at),
    })),
    unpaid_orders: unpaidOrders,
    recent_audits: recentAudits.map((row) => ({
      ...row,
      hour_start: dateToIso(row.hour_start),
      created_at: dateToIso(row.created_at),
    })),
  };
}

export async function createWorkspaceCreditPurchase(
  workspaceOwnerNpub: string,
  requestedByNpub: string,
  quantityCredits: number,
) {
  if (config.billing.mode === 'disabled') {
    throw Object.assign(new Error('billing is disabled'), { code: 'BILLING_DISABLED' });
  }
  if (!Number.isFinite(quantityCredits) || quantityCredits <= 0) {
    throw Object.assign(new Error('quantity_credits must be greater than 0'), { code: 'BAD_QUANTITY' });
  }
  await ensureWorkspaceCreditAccount(workspaceOwnerNpub);
  const product = await getProduct();
  const mginxOrder = await createOrder(quantityCredits, {
    workspace_owner_npub: workspaceOwnerNpub,
    requested_by_npub: requestedByNpub,
    tower_service_npub: config.service.npub || null,
    product: 'superbased_workspace_credit_v1',
    unit: 'MB-hour',
  });

  const amountSats = mginxOrder.amount_sats || Math.ceil(product.priceSats * quantityCredits);
  const [order] = await getDb()<WorkspaceCreditOrder[]>`
    INSERT INTO workspace_credit_orders (
      workspace_owner_npub,
      requested_by_npub,
      mginx_order_id,
      product_id,
      quantity_credits,
      amount_sats,
      bolt11,
      status
    )
    VALUES (
      ${workspaceOwnerNpub},
      ${requestedByNpub},
      ${mginxOrder.id},
      ${product.id},
      ${formatCredits(quantityCredits)},
      ${amountSats},
      ${mginxOrder.invoice},
      ${mginxOrder.status === 'paid' ? 'paid' : 'pending'}
    )
    RETURNING *
  `;

  return {
    ...order,
    expires_at: mginxOrder.expires_at,
  };
}

function normalizeOrderStatus(status: string): WorkspaceCreditOrder['status'] {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'paid' || normalized === 'settled' || normalized === 'complete' || normalized === 'completed') return 'paid';
  if (normalized === 'expired') return 'expired';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  return 'pending';
}

export async function refreshWorkspaceCreditOrderStatus(workspaceOwnerNpub: string, orderId: string) {
  const [localOrder] = await getDb()<WorkspaceCreditOrder[]>`
    SELECT *
    FROM workspace_credit_orders
    WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      AND id = ${orderId}
    LIMIT 1
  `;
  if (!localOrder) return null;

  if (localOrder.status === 'paid') return localOrder;

  const remote = await getOrderStatus(localOrder.mginx_order_id);
  const nextStatus = normalizeOrderStatus(remote.status);
  const sql = getDb();

  return sql.begin(async (tx) => {
    const [lockedOrder] = await tx<WorkspaceCreditOrder[]>`
      SELECT *
      FROM workspace_credit_orders
      WHERE id = ${localOrder.id}
      FOR UPDATE
    `;
    if (!lockedOrder) return null;
    if (lockedOrder.status === 'paid') return lockedOrder;

    if (nextStatus !== 'paid') {
      const [updated] = await tx<WorkspaceCreditOrder[]>`
        UPDATE workspace_credit_orders
        SET status = ${nextStatus},
            updated_at = NOW()
        WHERE id = ${lockedOrder.id}
        RETURNING *
      `;
      return updated;
    }

    let account = await ensureWorkspaceCreditAccount(workspaceOwnerNpub, tx);
    if (!account) throw new Error('workspace credit account not found');
    const balanceBefore = finiteNumber(account.balance_credits);
    const quantity = finiteNumber(lockedOrder.quantity_credits);
    const balanceAfter = balanceBefore + quantity;
    const threshold = finiteNumber(account.low_balance_threshold_credits, 24);
    const nextAccountState = stateForPositiveBalance(balanceAfter, threshold);

    const [updatedAccount] = await tx<WorkspaceCreditAccount[]>`
      UPDATE workspace_credit_accounts
      SET balance_credits = ${formatCredits(balanceAfter)},
          billing_state = ${nextAccountState},
          depleted_at = NULL,
          delete_eligible_at = NULL,
          updated_at = NOW()
      WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      RETURNING *
    `;
    account = updatedAccount || account;

    await tx`
      INSERT INTO workspace_credit_transactions (
        workspace_owner_npub,
        type,
        amount_credits,
        balance_before_credits,
        balance_after_credits,
        reference_type,
        reference_id,
        notes,
        metadata
      )
      VALUES (
        ${workspaceOwnerNpub},
        ${'purchase'},
        ${formatCredits(quantity)},
        ${formatCredits(balanceBefore)},
        ${formatCredits(balanceAfter)},
        ${'workspace_credit_order'},
        ${lockedOrder.id},
        ${'Mginx order paid'},
        ${JSON.stringify({ mginx_order_id: lockedOrder.mginx_order_id, amount_sats: lockedOrder.amount_sats })}::jsonb
      )
    `;

    const [updatedOrder] = await tx<WorkspaceCreditOrder[]>`
      UPDATE workspace_credit_orders
      SET status = 'paid',
          paid_at = COALESCE(paid_at, NOW()),
          updated_at = NOW()
      WHERE id = ${lockedOrder.id}
      RETURNING *
    `;

    return updatedOrder || lockedOrder;
  });
}

export async function runHourlyUsageAudit(hourStart = new Date()) {
  if (config.billing.mode === 'disabled') return [];
  await markDeleteEligibleWorkspaces();
  const normalizedHour = new Date(hourStart);
  normalizedHour.setUTCMinutes(0, 0, 0);

  const workspaces = await getDb()<{
    workspace_owner_npub: string;
  }[]>`
    SELECT workspace_owner_npub
    FROM v4_workspaces
    ORDER BY created_at ASC
  `;

  const audited = [];
  for (const workspace of workspaces) {
    const row = await runHourlyUsageAuditForWorkspace(workspace.workspace_owner_npub, normalizedHour);
    if (row) audited.push(row);
  }
  await markDeleteEligibleWorkspaces();
  return audited;
}

export async function runHourlyUsageAuditForWorkspace(workspaceOwnerNpub: string, hourStart: Date) {
  if (config.billing.mode === 'disabled') return null;
  const normalizedHour = new Date(hourStart);
  normalizedHour.setUTCMinutes(0, 0, 0);

  const sql = getDb();
  return sql.begin(async (tx) => {
    let account = await ensureWorkspaceCreditAccount(workspaceOwnerNpub, tx);
    if (!account) return null;

    const [lockedAccount] = await tx<WorkspaceCreditAccount[]>`
      SELECT *
      FROM workspace_credit_accounts
      WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      FOR UPDATE
    `;
    account = lockedAccount || account;

    const usage: WorkspaceUsageSnapshot = await measureWorkspaceUsage(workspaceOwnerNpub, tx);
    const charge = roundedBillableMb(usage.billable_bytes);
    const balanceBefore = finiteNumber(account.balance_credits);
    const balanceAfter = balanceBefore - charge;

    const [audit] = await tx<{
      id: string;
      workspace_owner_npub: string;
      hour_start: Date;
      record_bytes: number;
      object_bytes: number;
      billable_bytes: number;
      billable_mb: string;
      credits_charged: string;
      balance_after_credits: string;
      metadata: Record<string, unknown>;
      created_at: Date;
    }[]>`
      INSERT INTO workspace_usage_hourly_audits (
        workspace_owner_npub,
        hour_start,
        record_bytes,
        object_bytes,
        billable_bytes,
        billable_mb,
        credits_charged,
        balance_after_credits,
        metadata
      )
      VALUES (
        ${workspaceOwnerNpub},
        ${normalizedHour},
        ${usage.record_bytes},
        ${usage.object_bytes},
        ${usage.billable_bytes},
        ${formatCredits(charge)},
        ${formatCredits(charge)},
        ${formatCredits(balanceAfter)},
        ${JSON.stringify({ billing_unit: 'MB-hour' })}::jsonb
      )
      ON CONFLICT (workspace_owner_npub, hour_start) DO NOTHING
      RETURNING *
    `;
    if (!audit) return null;

    const threshold = finiteNumber(account.low_balance_threshold_credits, 24);
    const now = new Date();
    const nextState = stateForPositiveBalance(balanceAfter, threshold);
    const nextDepletedAt = balanceAfter <= 0 ? (account.depleted_at || now) : null;
    const nextDeleteEligibleAt = balanceAfter <= 0
      ? (account.delete_eligible_at || addDays(nextDepletedAt, billingGraceDays()))
      : null;

    const [updatedAccount] = await tx<WorkspaceCreditAccount[]>`
      UPDATE workspace_credit_accounts
      SET balance_credits = ${formatCredits(balanceAfter)},
          billing_state = ${nextState},
          depleted_at = ${nextDepletedAt},
          delete_eligible_at = ${nextDeleteEligibleAt},
          updated_at = NOW()
      WHERE workspace_owner_npub = ${workspaceOwnerNpub}
      RETURNING *
    `;

    await tx`
      INSERT INTO workspace_credit_transactions (
        workspace_owner_npub,
        type,
        amount_credits,
        balance_before_credits,
        balance_after_credits,
        reference_type,
        reference_id,
        notes,
        metadata
      )
      VALUES (
        ${workspaceOwnerNpub},
        ${'hourly_usage'},
        ${formatCredits(-charge)},
        ${formatCredits(balanceBefore)},
        ${formatCredits(balanceAfter)},
        ${'workspace_usage_hourly_audit'},
        ${audit.id},
        ${'Hourly billable MB-hour usage'},
        ${JSON.stringify({ record_bytes: usage.record_bytes, object_bytes: usage.object_bytes })}::jsonb
      )
    `;

    return {
      ...audit,
      balance_after_credits: formatCredits(finiteNumber(updatedAccount?.balance_credits, balanceAfter)),
    };
  });
}
