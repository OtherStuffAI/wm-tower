const base = "/api/v4/flightdeck-pg/workspaces/{workspaceId}/org-data";
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const uuid = { type: "string", format: "uuid" };
const revision = { type: "integer", minimum: 1 };
export const orgDataSchemas = {
	OrgDataField: {
		type: "object",
		required: ["key", "label", "type"],
		properties: {
			key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
			label: { type: "string", maxLength: 200 },
			type: {
				enum: [
					"text",
					"number",
					"boolean",
					"date",
					"record_ref",
					"actor_ref",
					"nostr_ref",
					"workspace_ref",
				],
			},
			required: { type: "boolean" },
			target_type: { type: "string" },
		},
	},
	OrgDataType: {
		type: "object",
		required: ["key", "label", "fields", "access"],
		properties: {
			key: { type: "string" },
			label: { type: "string" },
			fields: { type: "array", maxItems: 64, items: ref("OrgDataField") },
			access: {
				type: "object",
				required: ["read", "write"],
				properties: {
					read: { enum: ["members", "admins"] },
					write: { enum: ["members", "admins"] },
				},
			},
			expected_revision: revision,
		},
	},
	OrgDataWrite: {
		type: "object",
		required: ["values"],
		properties: {
			values: {
				type: "object",
				additionalProperties: { type: ["string", "number", "boolean", "null"] },
			},
			expected_revision: revision,
		},
	},
	NappletBundle: {
		type: "object",
		required: [
			"key",
			"version",
			"title",
			"bridge_version",
			"capabilities",
			"html",
			"trusted_code_acknowledged",
		],
		properties: {
			trusted_code_acknowledged: { const: true },
			key: { type: "string" },
			version: revision,
			title: { type: "string", maxLength: 200 },
			bridge_version: { const: 1 },
			capabilities: {
				type: "array",
				uniqueItems: true,
				items: {
					enum: [
						"org_data.read",
						"org_data.write",
						"org_data.schema",
						"profile.open",
						"dm.open",
					],
				},
			},
			html: {
				type: "string",
				description:
					"Immutable UTF-8 static HTML, maximum 512 KiB. Trusted privileged code. Resource CSP does not prevent iframe self-navigation or data exfiltration. Serialized request maximum 3162112 bytes.",
			},
		},
	},
	NappletInstall: {
		type: "object",
		required: ["version", "expected_revision", "trusted_code_acknowledged"],
		properties: {
			trusted_code_acknowledged: { const: true },
			version: revision,
			expected_revision: { type: "integer", minimum: 0 },
		},
	},
};
function op(
	summary: string,
	permission: string,
	path: string,
	body?: string,
	page = false,
) {
	return {
		tags: ["Flight Deck PG"],
		summary,
		description: `Requires NIP-98, exact app identity, workspace membership, workspace.read and ${permission}. Schema/record revisions conflict with 409. References never grant membership.`,
		security: [{ nip98: [] }],
		parameters: [
			{ name: "workspaceId", in: "path", required: true, schema: uuid },
			...["typeKey", "recordId", "bundleKey"]
				.filter((k) => path.includes(`{${k}}`))
				.map((k) => ({
					name: k,
					in: "path",
					required: true,
					schema: k === "recordId" ? uuid : { type: "string" },
				})),
			...(page
				? [
						{
							name: "limit",
							in: "query",
							schema: {
								type: "integer",
								minimum: 1,
								maximum: 500,
								default: 100,
							},
						},
						{ name: "cursor", in: "query", schema: uuid },
					]
				: []),
		],
		...(body
			? {
					requestBody: {
						required: true,
						content: { "application/json": { schema: ref(body) } },
					},
				}
			: {}),
		responses: {
			200: {
				description:
					"Workspace-scoped typed response with identity, current revision; pages return next_cursor and has_more.",
			},
			400: { description: "Invalid schema, fields, references or body" },
			401: { description: "Invalid NIP-98" },
			403: { description: "Permission, app or reference visibility denied" },
			404: { description: "Resource unavailable" },
			409: {
				description:
					"Revision conflict, referenced deletion, destructive schema change or immutable bundle version already exists",
			},
		},
	};
}
const route = (
	suffix: string,
	methods: Record<string, [string, string, string?, boolean?]>,
) => [
	base + suffix,
	Object.fromEntries(
		Object.entries(methods).map(
			([method, [summary, permission, body, page]]) => [
				method,
				op(summary, permission, suffix, body, page),
			],
		),
	),
];
export const orgDataPaths = Object.fromEntries([
	route("/catalogue", {
		get: ["Read permitted definitions and installations", "org_data.read"],
	}),
	route("/snapshot", {
		get: ["Read complete bounded atomic authorised snapshot", "org_data.read"],
	}),
	route("/bootstrap", {
		post: ["Create missing people/team/holiday definitions", "org_data.schema"],
	}),
	route("/permissions", {
		get: [
			"Read direct org-data grants for workspace members",
			"workspace.manage",
		],
		post: [
			"Replace direct org-data grants with expected_permissions compare-and-set",
			"workspace.manage",
		],
	}),
	route("/history", {
		get: [
			"Paginate workspace org-data audit history",
			"org_data.schema",
			undefined,
			true,
		],
	}),
	route("/types", {
		post: ["Create a data type", "org_data.schema", "OrgDataType"],
	}),
	route("/types/{typeKey}", {
		patch: [
			"Validate and update a data type",
			"org_data.schema",
			"OrgDataType",
		],
	}),
	route("/types/{typeKey}/records", {
		get: ["Paginate permitted records", "org_data.read", undefined, true],
		post: ["Create a record", "org_data.write", "OrgDataWrite"],
	}),
	route("/types/{typeKey}/records/{recordId}", {
		patch: [
			"Replace record values with revision check",
			"org_data.write",
			"OrgDataWrite",
		],
		delete: [
			"Delete an unreferenced record with expected_revision",
			"org_data.write",
		],
	}),
	route("/napplets/bundles", {
		get: ["List published bundle metadata", "org_data.read"],
		post: [
			"Publish immutable static bundle version",
			"napplet.publish",
			"NappletBundle",
		],
	}),
	route("/napplets/installations/{bundleKey}", {
		post: [
			"Install/upgrade a published bundle",
			"napplet.install",
			"NappletInstall",
		],
	}),
]);
