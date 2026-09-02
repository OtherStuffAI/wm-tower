import { config } from '../config';

export interface MginxProduct {
  id: string;
  priceSats: number;
  metadata?: Record<string, unknown>;
}

export interface MginxOrder {
  id: string;
  invoice: string;
  amount_sats: number;
  status: string;
  expires_at: string | null;
  metadata?: Record<string, unknown>;
}

function requireMginxConfig() {
  if (!config.billing.mginxUrl) throw new Error('MGINX_URL required');
  if (!config.billing.creditsProductId) throw new Error('SUPERBASED_CREDITS_PRODUCT_ID required');
}

function headers(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    ...(config.billing.mginxApiKey ? { Authorization: `Bearer ${config.billing.mginxApiKey}` } : {}),
  };
}

function normalizeProduct(raw: any): MginxProduct {
  const product = raw?.product || raw;
  return {
    id: String(product?.id || config.billing.creditsProductId),
    priceSats: Number(product?.priceSats ?? product?.price_sats ?? product?.price_sats_per_credit ?? 0),
    metadata: product?.metadata || {},
  };
}

function normalizeOrder(raw: any): MginxOrder {
  const order = raw?.order || raw;
  return {
    id: String(order?.id || order?.order_id || order?.mginx_order_id || ''),
    invoice: String(order?.invoice || order?.bolt11 || ''),
    amount_sats: Number(order?.amount_sats ?? order?.amountSats ?? 0),
    status: String(order?.status || 'pending'),
    expires_at: order?.expires_at || order?.expiresAt || null,
    metadata: order?.metadata || {},
  };
}

async function checkedJson(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.error || body?.message || `Mginx request failed with HTTP ${res.status}`;
    throw new Error(String(message));
  }
  return body;
}

export async function getProduct(): Promise<MginxProduct> {
  requireMginxConfig();
  const res = await fetch(`${config.billing.mginxUrl}/api/products/${encodeURIComponent(config.billing.creditsProductId)}`, {
    headers: headers(),
  });
  return normalizeProduct(await checkedJson(res));
}

export async function createOrder(
  quantityCredits: number,
  metadata: Record<string, unknown>,
): Promise<MginxOrder> {
  requireMginxConfig();
  const res = await fetch(`${config.billing.mginxUrl}/api/orders`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      product_id: config.billing.creditsProductId,
      quantity: quantityCredits,
      metadata,
    }),
  });
  return normalizeOrder(await checkedJson(res));
}

export async function getOrderStatus(mginxOrderId: string): Promise<MginxOrder> {
  requireMginxConfig();
  const res = await fetch(`${config.billing.mginxUrl}/api/orders/${encodeURIComponent(mginxOrderId)}/status`, {
    headers: headers(),
  });
  return normalizeOrder(await checkedJson(res));
}
