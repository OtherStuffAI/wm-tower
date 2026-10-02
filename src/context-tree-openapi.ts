import { flightDeckPgContractFixturePaths, type FlightDeckPgContractName } from './types';
const uuid = { type: 'string', format: 'uuid' };
const integer = { type: 'integer', minimum: 0, maximum: 2147483646 };
const expected = { ...integer, minimum: 1 };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const timestamps = { created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' }, deleted_at: { type: ['string', 'null'], format: 'date-time' } };
const recordTarget = { type: 'object', additionalProperties: false, required: ['record_id'], properties: { record_id: uuid } };
const artifactTarget = { type: 'object', additionalProperties: false, required: ['origin', 'project', 'artifact', 'page', 'version_policy'], properties: {
  origin: { type: 'string', format: 'uri', description: 'HTTP(S) origin only; no credentials, path, query or fragment. External WApp enforces access.' },
  project: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' }, artifact: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' }, page: { const: 'index.html' }, version_policy: { const: 'latest' },
} };
export const contextTreeSchemas = {
  ContextComponent: { type: 'object', required: ['id', 'workspace_id', 'scope_id', 'title', 'parent_id', 'sort_order', 'row_version', 'created_at', 'updated_at', 'deleted_at'], properties: {
    id: uuid, workspace_id: uuid, scope_id: uuid, title: { type: 'string', minLength: 1, maxLength: 256 }, parent_id: { type: ['string', 'null'], format: 'uuid' }, sort_order: integer, row_version: expected, ...timestamps,
  } },
  ContextReference: { type: 'object', required: ['id', 'workspace_id', 'scope_id', 'component_id', 'target_type', 'target', 'sort_order', 'row_version', 'created_at', 'updated_at', 'deleted_at'], properties: {
    id: uuid, workspace_id: uuid, scope_id: uuid, component_id: uuid, target_type: { enum: ['doc', 'file', 'task', 'artifact'] }, target: { oneOf: [recordTarget, artifactTarget] }, sort_order: integer, row_version: expected, ...timestamps,
    resolution: { oneOf: [
      { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { const: 'unavailable' } } },
      { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { const: 'external' } } },
      { type: 'object', required: ['status', 'record_id', 'title'], properties: { status: { const: 'available' }, record_id: uuid, title: { type: ['string', 'null'] } } },
    ] },
  } },
  ContextCreate: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 256 }, parent_id: { type: ['string', 'null'], format: 'uuid' }, sort_order: integer } },
  ContextPatch: { type: 'object', additionalProperties: false, required: ['expected_row_version'], minProperties: 2, properties: { expected_row_version: expected, title: { type: 'string', minLength: 1, maxLength: 256 }, parent_id: { type: ['string', 'null'], format: 'uuid' }, sort_order: integer } },
  ContextAttach: { oneOf: [
    { type: 'object', additionalProperties: false, required: ['target_type', 'target'], properties: { target_type: { enum: ['doc', 'file', 'task'] }, target: recordTarget, sort_order: integer } },
    { type: 'object', additionalProperties: false, required: ['target_type', 'target'], properties: { target_type: { const: 'artifact' }, target: artifactTarget, sort_order: integer } },
  ] },
  ContextUnlink: { type: 'object', additionalProperties: false, required: ['expected_row_version'], properties: { expected_row_version: expected } },
  ContextDelete: { type: 'object', additionalProperties: false, required: ['confirmation_token'], properties: { confirmation_token: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Hash of exact persisted subtree + active links from preview. Not an authorization token.' } } },
  ContextDeletePreview: { type: 'object', required: ['component_id', 'component_count', 'descendant_count', 'reference_count', 'confirmation_token'], properties: { component_id: uuid, component_count: integer, descendant_count: integer, reference_count: integer, confirmation_token: { type: 'string' } } },
  ContextCapabilities: { type: 'object', required: ['read', 'manage'], properties: { read: { type: 'boolean' }, manage: { type: 'boolean', description: 'Compatibility alias for edit, not scope administration' }, edit: { type: 'boolean' }, scope_manage: { type: 'boolean' } } },
};
const base = '/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}/context/components';
function operation(summary: string, response: object, body?: string, item = false, link = false, list = false, create = false) {
  return { tags: ['Flight Deck PG'], summary, security: [{ nip98: [] }],
    description: 'Context Tree v1. Scope visibility for reads; context.edit or scope.manage + visibility for edits and delete preview. Existing identity/error envelopes. Same-scope moves only; stale versions, circular parenting, duplicate reference and changed preview return 409. Archived/unreadable scope unavailable. Targets retain separate ACLs.',
    parameters: ['workspaceId', 'scopeId', ...(item ? ['componentId'] : []), ...(link ? ['referenceId'] : [])].map(name => ({ name, in: 'path', required: true, schema: uuid })).concat(list ? [
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque route-bound keyset cursor. Current view, not a snapshot.' },
    ] as any : []),
    ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(body) } } } } : {}),
    responses: { [create ? '201' : '200']: { description: 'Identity + context payload', content: { 'application/json': { schema: { type: 'object', required: ['identity', 'capabilities'], properties: { identity: { type: 'object', required: ['tower_service_npub','workspace_service_npub','workspace_owner_npub','workspace_id','app_npub'], properties: { tower_service_npub: {type:['string','null']}, workspace_service_npub: {type:['string','null']}, workspace_owner_npub: {type:['string','null']}, workspace_id: {type:['string','null'],format:'uuid'}, app_npub: {type:'string'} } }, capabilities: ref('ContextCapabilities'), ...response, ...(body ? { audit: { type: 'object', required: ['event_id','operation','actor_npub'], properties: { event_id: uuid, operation: {type:'string'}, actor_npub: {type:'string'} } }, outbox: {type:'array',items:{type:'object',required:['id','row_version'],properties:{id:uuid,row_version:{type:'integer'}}}}, mutation_id: uuid } : {}) } } } } },
      ...Object.fromEntries([400, 401, 403, 404, 409].map(status => [status, { description: ({ 400: 'Validation error', 401: 'NIP-98 auth failed', 403: 'Permission denied / target unavailable', 404: 'Context unavailable', 409: 'Concurrent edit or invalid hierarchy' } as any)[status] }])) },
  };
}
const page = (key: string, type: string) => ({ [key]: { type: 'array', items: ref(type) }, next_cursor: { type: ['string', 'null'] } });
export const contextTreePaths = {
  [base]: { get: operation('List active scope context components', page('components', 'ContextComponent'), undefined, false, false, true), post: operation('Create context component', { component: ref('ContextComponent') }, 'ContextCreate', false, false, false, true) },
  [base + '/{componentId}']: { patch: operation('Rename, reparent or reorder component with CAS', { component: ref('ContextComponent') }, 'ContextPatch', true) },
  [base + '/{componentId}/references']: { get: operation('List direct references with independent target visibility', page('references', 'ContextReference'), undefined, true, false, true), post: operation('Attach typed target; no access grant', { reference: ref('ContextReference') }, 'ContextAttach', true, false, false, true) },
  [base + '/{componentId}/references/{referenceId}']: { delete: operation('Unlink reference with CAS; preserve content', { reference: ref('ContextReference') }, 'ContextUnlink', true, true) },
  [base + '/{componentId}/delete-preview']: { get: operation('Preview exact active subtree and link deletion', { preview: ref('ContextDeletePreview') }, undefined, true) },
  [base + '/{componentId}/delete']: { post: operation('Confirm atomic subtree tombstones; preserve targets', { deleted: { type: 'object', properties: { component_id: uuid, component_count: integer, reference_count: integer } } }, 'ContextDelete', true) },
};

const contextContracts: Array<[string, string, FlightDeckPgContractName]> = [
  [base, 'get', 'flightdeck_pg.context.components.list'], [base, 'post', 'flightdeck_pg.context.components.create'],
  [base + '/{componentId}', 'patch', 'flightdeck_pg.context.components.update'],
  [base + '/{componentId}/references', 'get', 'flightdeck_pg.context.references.list'],
  [base + '/{componentId}/references', 'post', 'flightdeck_pg.context.references.attach'],
  [base + '/{componentId}/references/{referenceId}', 'delete', 'flightdeck_pg.context.references.unlink'],
  [base + '/{componentId}/delete-preview', 'get', 'flightdeck_pg.context.delete.preview'],
  [base + '/{componentId}/delete', 'post', 'flightdeck_pg.context.delete.confirm'],
];
for (const [path, method, contract] of contextContracts) Object.assign((contextTreePaths as any)[path][method], {
  'x-flightdeck-pg-contract': contract, 'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths[contract],
});
