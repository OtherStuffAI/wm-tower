/** OpenAPI fragments for org.wingman.nstack.notifications v1. Wire contract: docs/contract/notifications-v1.md */
const uuid = { type: 'string', format: 'uuid' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const err = { description: 'Error', content: { 'application/json': { schema: ref('ErrorResponse') } } };
const workspaceParam = { name: 'workspaceId', in: 'path', required: true, schema: uuid };
const json = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const clientApp = { name: 'client_app_id', in: 'query', description: 'Presentation filter: only items visible to this client app (audience + effective inbox rule). Never access authority.', schema: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{0,63}$' } };
const installationParam = { name: 'installationId', in: 'path', required: true, schema: uuid };
const transportKind = { name: 'kind', in: 'path', required: true, schema: { enum: ['apns'], description: 'webpush and fcm are rejected with 400 transport_not_implemented' } };
const tags = ['Notifications'];
const security = [{ nip98: [] }];
const op = (summary: string, extra: Record<string, unknown> = {}) => ({
  tags, security, summary, parameters: [workspaceParam, ...((extra.parameters as unknown[]) ?? [])],
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'parameters')),
});

const pushSchemas = {
  NotificationInstallationBody: {
    type: 'object', additionalProperties: false, required: ['client_app_id', 'platform'],
    properties: {
      client_app_id: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{0,63}$', description: 'Presentation label only; not an attestation' },
      platform: { enum: ['web', 'ios', 'ipados', 'macos', 'android'] }, app_version: { type: 'string', maxLength: 64 }, device_label: { type: 'string', maxLength: 64 },
      permission_state: { enum: ['granted', 'denied', 'unknown'] },
    },
  },
  NotificationApnsBody: {
    type: 'object', additionalProperties: false, required: ['device_token', 'environment', 'bundle_id'],
    properties: {
      device_token: { type: 'string', pattern: '^[0-9a-fA-F]{64,200}$', description: 'Never returned or logged' },
      environment: { enum: ['sandbox', 'production', 'development'], description: 'development is an alias of sandbox' },
      bundle_id: { type: 'string', description: 'Must be on the server allow-list once a provider is configured' },
      preview: { enum: ['generic', 'full'], default: 'generic' }, lease_seconds: { type: 'integer', minimum: 1, maximum: 2592000, default: 604800 },
      client_app_id: { type: 'string' }, platform: { enum: ['web', 'ios', 'ipados', 'macos', 'android'] }, app_version: { type: 'string' }, device_label: { type: 'string' }, permission_state: { enum: ['granted', 'denied', 'unknown'] },
    },
  },
  NotificationPushRegistration: {
    type: 'object', required: ['installation', 'device', 'delivery'],
    properties: {
      installation: { type: 'object', properties: { installation_id: uuid, client_app_id: { type: 'string' }, platform: { type: 'string' }, permission_state: { type: 'string' }, status: { enum: ['active', 'revoked'] }, enrolled_workspace_ids: { type: 'array', items: uuid } } },
      device: { type: 'object', properties: { installation_id: uuid, kind: { const: 'apns' }, environment: { enum: ['sandbox', 'production'] }, bundle_id: { type: 'string' }, preview: { enum: ['generic', 'full'] }, status: { enum: ['active', 'stale', 'revoked'] }, token_suffix: { type: 'string' }, lease_expires_at: { type: 'string', format: 'date-time' } } },
      delivery: { type: 'object', required: ['ready'], properties: { ready: { type: 'boolean' }, reason: { enum: ['provider_not_configured', 'provider_key_invalid', 'environment_not_enabled', 'bundle_not_allowed', 'permission_denied'] } } },
    },
  },
  NotificationPushRevocation: { type: 'object', required: ['revoked', 'remaining_workspace_ids'], properties: { revoked: { const: true }, remaining_workspace_ids: { type: 'array', items: uuid } } },
};

export const notificationSchemas = {
  NotificationItem: {
    type: 'object', required: ['schema', 'version', 'id', 'workspace_id', 'recipient_actor_id', 'change_seq', 'row_version', 'source', 'category', 'reasons', 'severity', 'status', 'subject', 'presentation', 'state', 'access'],
    properties: {
      schema: { const: 'org.wingman.notification.item' }, version: { const: 1 }, id: uuid, workspace_id: uuid, recipient_actor_id: uuid,
      change_seq: { type: 'integer' }, row_version: { type: 'integer', minimum: 1 },
      source: { type: 'object', required: ['app_id', 'label', 'kind'], properties: { app_id: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string' } } },
      category: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } },
      severity: { enum: ['low', 'normal', 'high', 'critical'] }, status: { enum: ['active', 'resolved'] }, origin: { enum: ['live', 'baseline'] },
      group: { type: 'object', properties: { key: { type: ['string', 'null'] }, event_count: { type: 'integer' } } },
      actor: { type: 'object', properties: { actor_id: { type: ['string', 'null'] }, display_name: { type: ['string', 'null'] }, kind: { type: ['string', 'null'] } } },
      subject: { type: 'object', properties: { kind: { type: 'string' }, activity_version: { type: ['integer', 'null'] } }, additionalProperties: true },
      presentation: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, icon: { type: 'string' }, push_preview: { type: 'string' } } },
      action: { type: ['object', 'null'], properties: { type: { const: 'open' }, target: { type: 'object', additionalProperties: true } } },
      audience: { type: 'object', properties: { client_apps: { type: 'array', items: { type: 'string' } } } },
      occurred_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' }, expires_at: { type: ['string', 'null'], format: 'date-time' },
      state: { type: 'object', required: ['read', 'dismissed', 'archived'], properties: {
        read: { type: 'boolean' }, read_at: { type: ['string', 'null'] }, read_reason: { enum: ['user', 'bulk', 'subject_viewed', 'already_viewed', 'resolved', null] },
        dismissed: { type: 'boolean' }, archived: { type: 'boolean' },
      } },
      access: { enum: ['ok', 'unavailable'] },
    },
  },
  NotificationTombstone: {
    type: 'object', required: ['schema', 'version', 'id', 'workspace_id', 'change_seq', 'change_type', 'removal_reason'],
    properties: {
      schema: { const: 'org.wingman.notification.tombstone' }, version: { const: 1 }, id: uuid, workspace_id: uuid, change_seq: { type: 'integer' },
      change_type: { const: 'remove' }, removal_reason: { enum: ['access_lost', 'subject_deleted', 'withdrawn', 'source_revoked', 'expired'] },
    },
  },
  NotificationPatch: {
    type: 'object', additionalProperties: false, required: ['mutation_id', 'expected_row_version', 'patch'],
    properties: {
      mutation_id: uuid, expected_row_version: { type: 'integer', minimum: 1 }, observed_change_seq: { type: 'integer', minimum: 0 },
      patch: { type: 'object', additionalProperties: false, minProperties: 1, properties: { read: { type: 'boolean' }, dismissed: { type: 'boolean' }, archived: { type: 'boolean' } } },
    },
  },
  NotificationBulk: {
    type: 'object', additionalProperties: false, required: ['mutation_id', 'op', 'selector'],
    properties: {
      mutation_id: uuid, op: { enum: ['mark_read', 'mark_unread', 'dismiss', 'archive', 'unarchive'] },
      selector: { type: 'object', additionalProperties: false, properties: {
        ids: { type: 'array', minItems: 1, maxItems: 200, items: uuid }, up_to_seq: { type: 'integer', minimum: 0 },
        view: { enum: ['inbox', 'unread', 'archived', 'dismissed', 'all'] }, category: { type: 'string' }, source_app_id: { type: 'string' }, client_app_id: { type: 'string', description: 'Only items visible to this client app are touched' },
      } },
    },
  },
  NotificationRule: {
    type: 'object', required: ['channel', 'mode'], additionalProperties: false,
    properties: {
      source_app_id: { type: 'string', default: '*' }, category: { type: 'string', default: '*' }, client_app_id: { type: 'string', default: '*' },
      channel: { enum: ['inbox', 'alert'] }, mode: { enum: ['on', 'off', 'default'], description: "'default' = inherit; kept as a versioned row, never deleted" },
      preview: { enum: ['generic', 'sender', 'full', null] },
    },
  },
  NotificationRuleRow: {
    type: 'object', required: ['source_app_id', 'category', 'client_app_id', 'channel', 'mode', 'row_version'],
    properties: {
      source_app_id: { type: 'string' }, category: { type: 'string' }, client_app_id: { type: 'string' }, channel: { enum: ['inbox', 'alert'] },
      mode: { enum: ['on', 'off', 'default'] }, preview: { enum: ['generic', 'sender', 'full', null] }, row_version: { type: 'integer', minimum: 1 },
    },
  },
  NotificationRulesState: {
    type: 'object', required: ['rules', 'rules_revision'],
    properties: { rules: { type: 'array', items: ref('NotificationRuleRow') }, rules_revision: { type: 'integer', minimum: 0 } },
  },
  NotificationRulesConflict: {
    type: 'object', required: ['code', 'conflicts', 'rules', 'rules_revision'],
    properties: {
      code: { const: 'rules_conflict' },
      conflicts: { type: 'array', items: { type: 'object', properties: {
        source_app_id: { type: 'string' }, category: { type: 'string' }, client_app_id: { type: 'string' }, channel: { enum: ['inbox', 'alert'] },
        expected_row_version: { type: 'integer' }, current: { oneOf: [ref('NotificationRuleRow'), { type: 'null' }] },
      } } },
      rules: { type: 'array', items: ref('NotificationRuleRow') }, rules_revision: { type: 'integer' },
    },
  },
  ResetRequired: {
    type: 'object', required: ['code', 'reason', 'head_seq', 'rules_revision'],
    properties: { code: { const: 'reset_required' }, reason: { enum: ['rules_changed', 'tombstone_floor', 'ahead'] }, head_seq: { type: 'integer' }, rules_revision: { type: 'integer' } },
  },
  NotificationEvent: {
    type: 'object', required: ['event_key', 'category'],
    properties: {
      schema: { const: 'org.wingman.notification.event' }, version: { const: 1 }, event_key: { type: 'string', pattern: '^[A-Za-z0-9:_.-]{1,128}$' },
      op: { enum: ['publish', 'resolve', 'withdraw'] }, category: { type: 'string' }, severity: { enum: ['low', 'normal', 'high'] },
      occurred_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' },
      subject: { type: 'object', properties: { kind: { enum: ['app_object', 'workspace'] }, app_id: { type: 'string' }, object_type: { type: 'string' }, object_id: { type: 'string' } } },
      recipients: { type: 'object', required: ['mode', 'actor_ids'], properties: { mode: { const: 'actors' }, actor_ids: { type: 'array', minItems: 1, maxItems: 500, items: uuid } } },
      audience: { type: 'object', properties: { client_apps: { type: 'array', items: { type: 'string' } } } },
      group_key: { type: 'string' }, target_event_key: { type: 'string' }, action: { type: 'object' },
    },
  },
  NotificationSource: {
    type: 'object', additionalProperties: false, required: ['kind', 'display_name', 'producer_signer_npub', 'allowed_categories'],
    properties: {
      kind: { enum: ['agent', 'app', 'wapp_installation'] }, display_name: { type: 'string' }, producer_signer_npub: { type: 'string' },
      allowed_categories: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['category', 'label'], properties: { category: { type: 'string' }, label: { type: 'string' }, default_severity: { enum: ['low', 'normal', 'high'] }, grouping: { enum: ['none', 'subject'] }, default_inbox: { enum: ['on', 'off'] }, default_alert: { enum: ['on', 'off'] } } } },
      allowed_recipient_mode: { enum: ['actor_list', 'owner_only'] }, allowed_recipient_actor_ids: { type: 'array', items: uuid },
      allowed_client_apps: { type: 'array', items: { type: 'string' } }, max_severity: { enum: ['low', 'normal', 'high'] }, rate_per_minute: { type: 'integer', minimum: 1, maximum: 6000 },
    },
  },
  ...pushSchemas,
};

const base = '/api/v4/flightdeck-pg/workspaces/{workspaceId}';
export const notificationPaths = {
  [`${base}/notifications/items`]: {
    get: op('List the caller\'s notification items (newest first, keyset paged, HMAC-bound cursor)', {
      parameters: [
        { name: 'view', in: 'query', schema: { enum: ['inbox', 'unread', 'archived', 'dismissed', 'all'] } },
        { name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'source_app_id', in: 'query', schema: { type: 'string' } }, clientApp,
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } },
      ],
      responses: { '200': json({ type: 'object', required: ['items', 'next_cursor', 'head_seq', 'rules_revision', 'counts'], properties: { items: { type: 'array', items: ref('NotificationItem') }, next_cursor: { type: ['string', 'null'] }, head_seq: { type: 'integer' }, rules_revision: { type: 'integer', description: 'Per-recipient rules revision at snapshot time; send it back on changes' }, counts: { type: 'object' }, inbox_started_at: { type: 'string' } } }), '400': err, '401': err, '403': err, '404': err },
    }),
  },
  [`${base}/notifications/items/{itemId}`]: {
    get: op('Read one item (or its content-free tombstone)', {
      parameters: [{ name: 'itemId', in: 'path', required: true, schema: uuid }],
      responses: { '200': json({ type: 'object', properties: { item: { oneOf: [ref('NotificationItem'), ref('NotificationTombstone')] } } }), '401': err, '403': err, '404': err },
    }),
    patch: op('Compare-and-set read/dismissed/archived state', {
      parameters: [{ name: 'itemId', in: 'path', required: true, schema: uuid }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('NotificationPatch') } } },
      responses: { '200': json({ type: 'object', properties: { item: ref('NotificationItem') } }), '400': err, '404': err, '409': json({ type: 'object', properties: { code: { enum: ['state_conflict', 'mutation_id_reused'] }, item: ref('NotificationItem') } }, 'state_conflict (current item included) or mutation_id_reused') },
    }),
  },
  [`${base}/notifications/changes`]: {
    get: op('Authoritative ascending change feed for recovery and sync', {
      parameters: [{ name: 'after_seq', in: 'query', schema: { type: 'integer', minimum: 0 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }, clientApp,
        { name: 'rules_revision', in: 'query', description: 'rules_revision from the snapshot; a different current value answers 410 reset_required (reason rules_changed)', schema: { type: 'integer', minimum: 0 } }],
      responses: { '200': json({ type: 'object', required: ['changes', 'through_seq', 'head_seq', 'rules_revision', 'has_more'], properties: { changes: { type: 'array', items: { oneOf: [ref('NotificationItem'), ref('NotificationTombstone')] } }, through_seq: { type: 'integer', description: 'Last returned row when has_more, else head_seq from the same snapshot (a fully filtered page still advances)' }, head_seq: { type: 'integer' }, rules_revision: { type: 'integer' }, has_more: { type: 'boolean' } } }), '410': json(ref('ResetRequired'), 'reset_required'), '400': err },
    }),
  },
  [`${base}/notifications/counts`]: {
    get: op('Unread counters under the same visibility predicate as the list', {
      parameters: [{ name: 'installation_id', in: 'query', schema: uuid }, clientApp],
      responses: { '200': json({ type: 'object', properties: { unread_total: { type: 'integer' }, by_category: { type: 'object' }, by_source_app: { type: 'object' }, badge: { type: 'integer', description: 'visible to the client app, unread, severity >= normal' }, capped_at: { type: 'integer' }, head_seq: { type: 'integer' }, rules_revision: { type: 'integer' }, inbox_started_at: { type: 'string' } } }) },
    }),
  },
  [`${base}/notifications/bulk`]: {
    post: op('Bulk state change bounded to an observed sequence or explicit ids', {
      requestBody: { required: true, content: { 'application/json': { schema: ref('NotificationBulk') } } },
      responses: { '200': json({ type: 'object', properties: { affected: { type: 'integer' }, through_seq: { type: 'integer' }, mutation_id: uuid } }), '400': err, '409': err },
    }),
  },
  [`${base}/notifications/categories`]: { get: op('Source and category registry visible to the caller', { responses: { '200': json({ type: 'object', properties: { sources: { type: 'array', items: { type: 'object' } } } }) } }) },
  [`${base}/notifications/rules`]: {
    get: op('Read the caller\'s preference rules (with row_version per key) and rules_revision', { responses: { '200': json(ref('NotificationRulesState')) } }),
    put: op('Per-key compare-and-swap of preference rules, all or nothing; replay-safe by mutation_id', {
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['mutation_id', 'rules'], properties: { mutation_id: uuid, rules: { type: 'array', minItems: 1, maxItems: 50, items: { allOf: [ref('NotificationRule'), { type: 'object', required: ['expected_row_version'], properties: { expected_row_version: { type: 'integer', minimum: 0, description: 'row_version of this key in the last GET; 0 when absent; >= 1 for mode default' } } }] } } } } } } },
      responses: { '200': json(ref('NotificationRulesState')), '400': err, '409': json({ oneOf: [ref('NotificationRulesConflict'), ref('ErrorResponse')] }, 'rules_conflict (nothing written) or mutation_id_reused') },
    }),
  },
  [`${base}/notifications/installations/{installationId}`]: {
    put: op('Register/update the caller\'s installation and enroll this workspace (actor-private; 409 installation_owned for another actor)', {
      parameters: [installationParam], requestBody: { required: true, content: { 'application/json': { schema: ref('NotificationInstallationBody') } } },
      responses: { '200': json({ type: 'object' }), '400': err, '403': err, '409': err },
    }),
    delete: op('Remove this workspace from the installation; revokes the installation and its transports when none remain', {
      parameters: [installationParam], responses: { '200': json(ref('NotificationPushRevocation')), '404': err },
    }),
  },
  [`${base}/notifications/installations/{installationId}/transports/{kind}`]: {
    put: op('Register/renew a push transport (apns) with a bounded lease', {
      parameters: [installationParam, transportKind], requestBody: { required: true, content: { 'application/json': { schema: ref('NotificationApnsBody') } } },
      responses: { '200': json(ref('NotificationPushRegistration')), '400': err, '403': err, '404': err, '409': json(ref('ErrorResponse'), 'transport_owned | installation_owned | workspace_not_enrolled') },
    }),
    delete: op('Revoke the transport (pending alerts are withdrawn)', { parameters: [installationParam, transportKind], responses: { '200': json(ref('NotificationPushRevocation')), '404': err } }),
  },
  [`${base}/notifications/apns-devices/{installationId}`]: {
    put: op('Compatibility alias for shipped Apple clients: registers an APNs token and implicitly creates the installation and enrollment', {
      parameters: [installationParam], requestBody: { required: true, content: { 'application/json': { schema: ref('NotificationApnsBody') } } },
      responses: { '200': json(ref('NotificationPushRegistration')), '400': err, '403': err, '409': err },
    }),
    delete: op('Compatibility alias: remove this workspace enrollment, revoking the token once none remains (404 = nothing to revoke)', { parameters: [installationParam], responses: { '200': json(ref('NotificationPushRevocation')), '404': err } }),
  },
  [`${base}/notification-producers/grants/me`]: { get: op('Grant summary for the NIP-98 producer signer', { responses: { '200': json({ type: 'object' }), '403': err } }) },
  [`${base}/notification-events`]: {
    post: op('Publish, resolve or withdraw a producer event', {
      requestBody: { required: true, content: { 'application/json': { schema: ref('NotificationEvent') } } },
      responses: { '201': json({ type: 'object' }, 'accepted'), '200': json({ type: 'object' }, 'replayed'), '400': err, '403': err, '409': err, '413': err, '429': err },
    }),
  },
  [`${base}/notification-events/{eventId}`]: { get: op('Producer-visible status of an own event', { parameters: [{ name: 'eventId', in: 'path', required: true, schema: uuid }], responses: { '200': json({ type: 'object' }), '404': err } }) },
  [`${base}/notification-events/{eventId}/withdraw`]: { post: op('Withdraw an own event (tombstones its items)', { parameters: [{ name: 'eventId', in: 'path', required: true, schema: uuid }], responses: { '201': json({ type: 'object' }), '404': err } }) },
  [`${base}/notification-sources`]: { get: op('List registered producer sources (effective workspace.manage)', { responses: { '200': json({ type: 'object' }), '403': err } }) },
  [`${base}/notification-sources/{sourceAppId}`]: {
    put: op('Register or update a producer source and its categories (effective workspace.manage)', {
      parameters: [{ name: 'sourceAppId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('NotificationSource') } } },
      responses: { '200': json({ type: 'object' }), '400': err, '403': err, '409': err },
    }),
  },
  [`${base}/notification-sources/{sourceAppId}/disable`]: { post: op('Disable a source (new events refused)', { parameters: [{ name: 'sourceAppId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': json({ type: 'object' }), '403': err, '404': err } }) },
  [`${base}/notification-sources/{sourceAppId}/revoke`]: { post: op('Revoke a source: refuse new events and tombstone its items', { parameters: [{ name: 'sourceAppId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': json({ type: 'object' }), '403': err, '404': err } }) },
  [`${base}/admin/notifications/queue`]: { get: op('Projection queue depth, oldest age, dead letters and worker status (effective workspace.manage)', { responses: { '200': json({ type: 'object' }), '403': err } }) },
};
