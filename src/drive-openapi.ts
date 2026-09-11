const workspace = {
  name: 'workspaceId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const share = {
  name: 'shareId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const responses = {
  '200': { description: 'Authorized typed metadata only; no filesystem content' },
  '403': { description: 'Owner, host or workspace authority denied' },
  '409': { description: 'Revision conflict or replayed proof' },
};
export const drivePaths = {
  '/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/shares': {
    get: {
      tags: ['Drive'],
      summary: 'Discover enabled private-owner and workspace shares',
      parameters: [workspace],
      responses,
    },
  },
  '/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/shares/{shareId}': {
    put: {
      tags: ['Drive'],
      summary: 'Owner CAS registration/update with host co-signature',
      parameters: [workspace, share],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [
                'name',
                'host_name',
                'host_npub',
                'endpoint',
                'audience',
                'enabled',
                'previous_revision',
                'host_proof',
              ],
              properties: {
                name: { type: 'string', maxLength: 120 },
                host_name: { type: 'string', maxLength: 120 },
                host_npub: { type: 'string' },
                endpoint: { type: 'string', description: 'Exact FIPS HTTP origin including port' },
                audience: { type: 'string', enum: ['private', 'workspace'] },
                enabled: { type: 'boolean' },
                previous_revision: { type: 'integer', minimum: 0 },
                host_proof: {
                  type: 'object',
                  description:
                    'Nostr kind 27235 registration co-signature; see docs/fips-drive-v1.md',
                },
              },
            },
          },
        },
      },
      responses,
    },
  },
  '/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/shares/{shareId}/policy': {
    get: {
      tags: ['Drive'],
      summary: 'Registered host policy/membership snapshot, 900 second maximum stale age',
      parameters: [workspace, share],
      responses,
    },
  },
};
