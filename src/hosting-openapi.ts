const amount = { type: 'string', pattern: '^-?[0-9]+$', description: 'Exact tariff units. 144000000000 units = 1 USD; 1 unit = 1 byte-hour.' };
const decimal = { type: 'string', description: 'USD display decimal; exact amount remains in units.' };
const uuid = { type: 'string', format: 'uuid' };
export const hostingSchemas = {
  HostingBillingStatus: { type: 'object', required: ['version','billing_mode','workspace_id','stripe'], properties: {
    can_top_up: { type: 'boolean' }, version: { const: 1 }, billing_mode: { enum: ['usd_prepaid','legacy_unlinked'] }, workspace_id: uuid, account_id: uuid, currency: { const: 'USD' },
    tariff: { type: 'object', properties: { usd_per_gb_month: { const: '5' }, gb_bytes: { const: 1000000000 }, month_hours: { const: 720 }, units_per_usd: { const: '144000000000' } } },
    balance_units: amount, balance_usd: decimal, promo_units: amount, promo_usd: decimal, paid_usd: decimal,
    promo_expires_at: { type: 'string', format: 'date-time' }, depleted_at: { type: ['string','null'], format: 'date-time' }, grace_ends_at: { type: ['string','null'], format: 'date-time' },
    billing_state: { enum: ['active','read_only_grace','measurement_pending'] }, hourly_burn_usd: { type: ['string','null'] }, estimated_runout_at: { type: ['string','null'], format: 'date-time' },
    coverage: { const: 'objects_and_logical_pg_rows' }, measurements: { type: 'array', items: { $ref: '#/components/schemas/HostingUsageHour' } },
    stripe: { type: 'object', properties: { configured: { type: 'boolean' }, mode: { enum: ['test','live'] }, live_rollout_blocked: { const: true } } },
  } },
  HostingUsageHour: { type: 'object', properties: { workspace_id: uuid, account_id: uuid, hour: { type: 'string', format: 'date-time' }, status: { enum: ['charged','unavailable','missed','partial_hour'] }, bytes: { type: ['string','null'] }, debit_units: amount, evidence: { type: 'object', description: 'Contemporaneous storage categories, attribution and exclusions; or missed-sample reason.' } } },
  HostingLedgerEntry: { type: 'object', properties: { id: uuid, account_id: uuid, workspace_id: { type: ['string','null'], format: 'uuid' }, kind: { enum: ['welcome','usage','admin','stripe','promo_expiry'] }, amount_units: amount, paid_after_units: amount, promo_after_units: amount, idempotency_key: { type: 'string' }, reason: { type: 'string' }, actor_npub: { type: ['string','null'] }, created_at: { type: 'string', format: 'date-time' } } },
  HostingCheckoutRequest: { type: 'object', additionalProperties: false, required: ['amount_cents','idempotency_key','return_url'], properties: { amount_cents: { enum: [500,1000,2500,5000,10000] }, idempotency_key: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' }, return_url: { type: 'string', format: 'uri', description: 'Exact server allowlist member.' } } },
  HostingAdminGrantRequest: { type: 'object', additionalProperties: false, required: ['amount_cents','idempotency_key','reason'], properties: { amount_cents: { type: 'integer', minimum: 1, maximum: 1000000 }, idempotency_key: { type: 'string', minLength: 1, maxLength: 100 }, reason: { type: 'string', minLength: 1, maxLength: 1000 } } },
};
const response = (schema: any) => ({ description: 'Authenticated billing result', content: { 'application/json': { schema } } });
const errors = { '400': { description: 'Invalid input or Stripe signature' }, '401': { description: 'NIP-98 authentication required' }, '403': { description: 'Owner/manager or platform-admin authority required' }, '404': { description: 'Workspace not found' }, '409': { description: 'Billing unlinked or idempotency conflict' }, '503': { description: 'Stripe unconfigured, wrong mode, or live rollout blocked' } };
export const hostingPaths: Record<string, any> = Object.fromEntries(['status','usage','ledger','checkout','grant'].map(op => {
  const write=['checkout','grant'].includes(op);
  const schema=op==='status'?{ $ref: '#/components/schemas/HostingBillingStatus' }:op==='usage'||op==='ledger'?{ type: 'object', properties: { workspace_id: uuid, account_id: uuid, entries: { type: 'array', items: { $ref: `#/components/schemas/${op==='usage'?'HostingUsageHour':'HostingLedgerEntry'}` } } } }:op==='checkout'?{type:'object',properties:{order_id:uuid,checkout_url:{type:['string','null'],format:'uri'},mode:{const:'test'},amount_cents:{type:'integer'}}}:{type:'object',properties:{entry:{$ref:'#/components/schemas/HostingLedgerEntry'}}};
  return [`/api/v4/hosting-billing/workspaces/{workspaceId}/${op}`, { [write?'post':'get']: {
    tags:['Billing'], summary:`USD hosting ${op}`, security:[{nip98:[]}],
    description: write?'Strict NIP-98 binds exact URL, method and body SHA256. Checkout requires customer owner; grant requires ADMIN_NPUB, never workspace admin. Stripe test-mode only.':'Account owner or workspace.manage access. Shared balance across owner workspaces; managers see their workspace ledger debits only.',
    parameters:[{name:'workspaceId',in:'path',required:true,schema:uuid},...(!write&&op!=='status'?[{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:200,default:50}}]:[])],
    ...(write?{requestBody:{required:true,content:{'application/json':{schema:{$ref:`#/components/schemas/${op==='checkout'?'HostingCheckoutRequest':'HostingAdminGrantRequest'}`}}}}}:{}),
    responses:{[op==='checkout'?'201':'200']:response(schema),...errors},
  } }];
}));
hostingPaths['/api/v4/hosting-billing/stripe/webhook']={post:{tags:['Billing'],summary:'Stripe raw-body verified fulfillment',description:'Stripe-Signature verification with SDK and server retrieval. Paid USD account-bound test checkout grants once per PaymentIntent. Success redirects and unpaid events never credit. Live mode blocked pending refunds/disputes.',requestBody:{required:true,content:{'application/json':{schema:{type:'object'}}}},parameters:[{name:'Stripe-Signature',in:'header',required:true,schema:{type:'string'}}],responses:{'200':{description:'Verified event acknowledged'},'400':{description:'Invalid signature or binding'},'503':{description:'Unconfigured or blocked'}}}};
