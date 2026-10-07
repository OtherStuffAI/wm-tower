import { createHash } from "node:crypto";
import { getDb } from "../db";
import { authorizeFlightDeckPgOperation } from "./flightdeck-pg-authorization";
import { nip19 } from "nostr-tools";
export type OrgField = {
	key: string;
	label: string;
	type:
		| "text"
		| "number"
		| "boolean"
		| "date"
		| "record_ref"
		| "actor_ref"
		| "workspace_ref"
		| "nostr_ref";
	required?: boolean;
	target_type?: string;
};
export type OrgType = {
	id: string;
	workspace_id: string;
	key: string;
	label: string;
	fields: OrgField[];
	access: { read: "members" | "admins"; write: "members" | "admins" };
	revision: number;
	updated_at: string;
};
export type OrgRecord = {
	id: string;
	workspace_id: string;
	type_key: string;
	values: Record<string, unknown>;
	revision: number;
	updated_at: string;
};
export class OrgDataError extends Error {
	constructor(
		public status: 400 | 403 | 404 | 409,
		public code: string,
	) {
		super(code);
	}
}
const keyPattern = /^[a-z][a-z0-9_]{0,63}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateOrgType(body: any) {
	if (
		!body ||
		typeof body.key !== "string" ||
		!keyPattern.test(body.key) ||
		typeof body.label !== "string" ||
		!body.label.trim() ||
		body.label.length > 200 ||
		!Array.isArray(body.fields) ||
		body.fields.length > 64
	)
		throw new OrgDataError(400, "invalid_type");
	const keys = new Set();
	for (const f of body.fields) {
		if (
			!f ||
			typeof f.key !== "string" ||
			!keyPattern.test(f.key) ||
			keys.has(f.key) ||
			typeof f.label !== "string" ||
			!f.label.trim() ||
			f.label.length > 200 ||
			![
				"text",
				"number",
				"boolean",
				"date",
				"record_ref",
				"actor_ref",
				"workspace_ref",
				"nostr_ref",
			].includes(f.type) ||
			(f.required !== undefined && typeof f.required !== "boolean") ||
			(f.type === "record_ref" &&
				(typeof f.target_type !== "string" || !keyPattern.test(f.target_type)))
		)
			throw new OrgDataError(400, "invalid_field");
		keys.add(f.key);
	}
	if (
		!body.access ||
		!["members", "admins"].includes(body.access.read) ||
		!["members", "admins"].includes(body.access.write)
	)
		throw new OrgDataError(400, "invalid_access");
	return {
		key: body.key,
		label: body.label,
		fields: body.fields.map((f: OrgField) => ({
			key: f.key,
			label: f.label,
			type: f.type,
			required: f.required === true,
			...(f.type === "record_ref" ? { target_type: f.target_type } : {}),
		})),
		access: { read: body.access.read, write: body.access.write },
	};
}
export function validateOrgValues(type: OrgType, values: any) {
	if (
		!values ||
		typeof values !== "object" ||
		Array.isArray(values) ||
		JSON.stringify(values).length > 65536
	)
		throw new OrgDataError(400, "invalid_values");
	if (Object.keys(values).some((k) => !type.fields.some((f) => f.key === k)))
		throw new OrgDataError(400, "unknown_field");
	for (const f of type.fields) {
		const v = values[f.key];
		if (v === null || v === undefined || v === "") {
			if (f.required) throw new OrgDataError(400, "required_field");
			continue;
		}
		let valid = false;
		switch (f.type) {
			case "text":
				valid = typeof v === "string" && v.length <= 10000;
				break;
			case "number":
				valid = typeof v === "number" && Number.isFinite(v);
				break;
			case "boolean":
				valid = typeof v === "boolean";
				break;
			case "date":
				valid =
					typeof v === "string" &&
					/^\d{4}-\d{2}-\d{2}$/.test(v) &&
					!Number.isNaN(Date.parse(v)) &&
					new Date(v).toISOString().slice(0, 10) === v;
				break;
			case "nostr_ref":
				try {
					valid = typeof v === "string" && nip19.decode(v).type === "npub";
				} catch {}
				break;
			default:
				valid = typeof v === "string" && uuid.test(v);
		}
		if (!valid) throw new OrgDataError(400, "invalid_field_value");
	}
}
export type OrgContext = {
	workspaceId: string;
	actorId: string;
	actorNpub: string;
	appNpub: string;
	role: string;
	permissions?: Record<string, boolean>;
};
export const orgAdmin = (ctx: OrgContext) =>
	ctx.permissions?.["org_data.schema"] === true;
export function orgAllowed(
	ctx: OrgContext,
	type: OrgType,
	op: "read" | "write",
) {
	return (
		ctx.permissions?.[op === "read" ? "org_data.read" : "org_data.write"] ===
			true &&
		(type.access[op] === "members" || orgAdmin(ctx))
	);
}
export async function orgOperation(
	ctx: OrgContext,
	op: string,
	key?: string,
	id?: string,
	body: any = {},
) {
	const db = getDb();
	return db.begin(async (sql: any) => {
		// Workspace-wide lock serializes schema changes and cross-type reference/deletion checks.
		await sql`SELECT id FROM flightdeck_pg_workspaces WHERE id=${ctx.workspaceId} FOR UPDATE`;
		const permissions: Record<string, boolean> = {};
		for (const permission of [
			"workspace.manage",
			"workspace.read",
			"org_data.read",
			"org_data.write",
			"org_data.schema",
			"napplet.publish",
			"napplet.install",
		])
			permissions[permission] = (
				await authorizeFlightDeckPgOperation(
					{
						actorNpub: ctx.actorNpub,
						appNpub: ctx.appNpub,
						workspaceId: ctx.workspaceId,
						permission,
						resource: { type: "workspace" },
					},
					sql,
				)
			).allowed;
		ctx = { ...ctx, permissions };
		if (!permissions["workspace.read"] || !permissions["org_data.read"])
			throw new OrgDataError(403, "org_data_read_required");
		const types: OrgType[] =
			await sql`SELECT * FROM flightdeck_pg_org_data_types WHERE workspace_id=${ctx.workspaceId} ORDER BY key`;
		const audit = async (
			operation: string,
			target: string,
			before: any,
			after: any,
		) => {
			await sql`INSERT INTO flightdeck_pg_org_data_audit(workspace_id,actor_id,operation,target_id,before_value,after_value) VALUES(${ctx.workspaceId},${ctx.actorId},${operation},${target},${before ? sql.json(before) : null},${after ? sql.json(after) : null})`;
			await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,operation,payload) VALUES(${ctx.workspaceId},${ctx.actorId},'org_data.changed','org_data',${operation},'{}'::jsonb)`;
		};
		const installations =
			await sql`SELECT i.key,i.version,i.revision,b.title,b.bridge_version,b.capabilities,b.sha256,b.html FROM flightdeck_pg_napplet_installations i JOIN flightdeck_pg_napplet_bundles b USING(workspace_id,key,version) WHERE i.workspace_id=${ctx.workspaceId} ORDER BY i.key`;
		const catalogue = () => ({
			installations,
			types: types
				.filter((t) => orgAllowed(ctx, t, "read"))
				.map((t) => ({
					...t,
					capabilities: {
						read: true,
						write: orgAllowed(ctx, t, "write"),
						schema: orgAdmin(ctx),
					},
				})),
			capabilities: {
				read: true,
				write: permissions["org_data.write"],
				schema: orgAdmin(ctx),
				publish: permissions["napplet.publish"],
				install: permissions["napplet.install"],
			},
		});
		if (op === "permissions" || op === "grantPermissions")
			return orgPermissions(ctx, op, body, sql, audit);
		if (op.startsWith("napplet"))
			return nappletOperation(ctx, op, key, body, sql, audit);
		if (op === "catalogue")
			return {
				...catalogue(),
				installations:
					await sql`SELECT i.key,i.version,i.revision,b.title,b.bridge_version,b.capabilities,b.sha256,b.html FROM flightdeck_pg_napplet_installations i JOIN flightdeck_pg_napplet_bundles b USING(workspace_id,key,version) WHERE i.workspace_id=${ctx.workspaceId} ORDER BY i.key`,
			};
		if (op === "history") {
			if (!orgAdmin(ctx))
				throw new OrgDataError(403, "schema_permission_required");
			const page = parseOrgPage(body);
			const rows =
				await sql`SELECT * FROM flightdeck_pg_org_data_audit WHERE workspace_id=${ctx.workspaceId} AND id > ${page.cursor}::uuid ORDER BY id LIMIT ${page.limit + 1}`;
			return orgPage(rows, page.limit, "changes");
		}
		if (op === "snapshot") {
			const allowed = types
				.filter((t) => orgAllowed(ctx, t, "read"))
				.map((t) => t.key);
			const records = allowed.length
				? await sql`SELECT * FROM flightdeck_pg_org_data_records WHERE workspace_id=${ctx.workspaceId} AND type_key IN ${sql(allowed)} ORDER BY id LIMIT 10001`
				: [];
			if (records.length > 10000)
				throw new OrgDataError(409, "snapshot_limit_exceeded");
			const safe = [];
			for (const t of types.filter((t) => orgAllowed(ctx, t, "read")))
				safe.push(
					...(await redactReferences(
						ctx,
						t,
						records.filter((r: any) => r.type_key === t.key),
						types,
						sql,
					)),
				);
			const people = safe.filter((r: any) => r.type_key === "people");
			const actorIds = people.map((r: any) => r.values.actor).filter(Boolean);
			const members = actorIds.length
				? await sql`SELECT a.id,a.npub FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id WHERE m.workspace_id=${ctx.workspaceId} AND a.id IN ${sql(actorIds)}`
				: [];
			const identities = Object.fromEntries(
				members.map((a: any) => [a.id, a.npub]),
			);
			const changes = orgAdmin(ctx)
				? await sql`SELECT id,operation,target_id,created_at FROM flightdeck_pg_org_data_audit WHERE workspace_id=${ctx.workspaceId} ORDER BY created_at DESC,id DESC LIMIT 50`
				: [];
			return {
				...catalogue(),
				records: safe,
				identities,
				changes,
				complete: true,
			};
		}
		if (op === "bootstrap") {
			if (!orgAdmin(ctx))
				throw new OrgDataError(403, "schema_permission_required");
			const field = (
				key: string,
				type: OrgField["type"] = "text",
				target_type?: string,
			): OrgField => ({
				key,
				label:
					(
						{
							title: "Job title",
							start_date: "Start date",
							end_date: "End date",
							status: "Display status",
							nostr: "Nostr identity",
							actor: "Wingman actor",
						} as Record<string, string>
					)[key] ?? key.charAt(0).toUpperCase() + key.slice(1),
				type,
				...(target_type ? { target_type } : {}),
			});
			const seeds = [
				{
					key: "teams",
					label: "Teams",
					fields: [{ ...field("name"), required: true }],
				},
				{
					key: "people",
					label: "People",
					fields: [
						{ ...field("name"), required: true },
						field("title"),
						field("team", "record_ref", "teams"),
						field("manager", "record_ref", "people"),
						field("actor", "actor_ref"),
						field("nostr", "nostr_ref"),
					],
				},
				{
					key: "holidays",
					label: "Holidays",
					fields: [
						{ ...field("person", "record_ref", "people"), required: true },
						{ ...field("start_date", "date"), required: true },
						{ ...field("end_date", "date"), required: true },
						{ ...field("status"), required: true },
					],
				},
			];
			for (const seed of seeds) {
				if (types.some((t) => t.key === seed.key)) continue;
				const [t] =
					await sql`INSERT INTO flightdeck_pg_org_data_types(workspace_id,key,label,fields,access) VALUES(${ctx.workspaceId},${seed.key},${seed.label},${sql.json(seed.fields)},${sql.json({ read: "members", write: "members" })}) RETURNING *`;
				types.push(t);
				await audit("bootstrap", t.key, null, t);
			}
			return catalogue();
		}
		if (op === "createType" || op === "updateType") {
			if (!orgAdmin(ctx))
				throw new OrgDataError(403, "schema_permission_required");
			const definition = validateOrgType({ ...body, key: key ?? body.key });
			for (const f of definition.fields)
				if (
					f.type === "record_ref" &&
					f.target_type !== definition.key &&
					!types.some((t) => t.key === f.target_type)
				)
					throw new OrgDataError(400, "unknown_target_type");
			const old = types.find((t) => t.key === definition.key);
			if (op === "createType" && types.length >= 200)
				throw new OrgDataError(409, "catalogue_limit_exceeded");
			if (op === "createType" && old)
				throw new OrgDataError(409, "type_exists");
			if (op === "updateType") {
				if (!old) throw new OrgDataError(404, "type_not_found");
				if (body.expected_revision !== old.revision)
					throw new OrgDataError(409, "revision_conflict");
				// Existing records prohibit destructive field changes and permission broadening through implicit defaults.
				const records =
					await sql`SELECT values FROM flightdeck_pg_org_data_records WHERE workspace_id=${ctx.workspaceId} AND type_key=${key}`;
				for (const r of records)
					validateOrgValues({ ...old, ...definition } as OrgType, r.values);
				if (
					old.fields.some(
						(f) =>
							!definition.fields.some(
								(n: OrgField) =>
									n.key === f.key &&
									n.type === f.type &&
									n.target_type === f.target_type,
							),
					)
				)
					throw new OrgDataError(409, "destructive_schema_change");
				const [type] =
					await sql`UPDATE flightdeck_pg_org_data_types SET label=${definition.label},fields=${sql.json(definition.fields)},access=${sql.json(definition.access)},revision=revision+1,updated_at=now() WHERE workspace_id=${ctx.workspaceId} AND key=${key} RETURNING *`;
				await audit(op, key!, old, type);
				return { type };
			}
			const [type] =
				await sql`INSERT INTO flightdeck_pg_org_data_types(workspace_id,key,label,fields,access) VALUES(${ctx.workspaceId},${definition.key},${definition.label},${sql.json(definition.fields)},${sql.json(definition.access)}) RETURNING *`;
			await audit(op, type.key, null, type);
			return { type };
		}
		const type = types.find((t) => t.key === key);
		if (!type) throw new OrgDataError(404, "type_not_found");
		if (!orgAllowed(ctx, type, op === "list" ? "read" : "write"))
			throw new OrgDataError(403, "permission_denied");
		if (op === "list") {
			const page = parseOrgPage(body);
			const rows =
				await sql`SELECT * FROM flightdeck_pg_org_data_records WHERE workspace_id=${ctx.workspaceId} AND type_key=${key} AND id > ${page.cursor}::uuid ORDER BY id LIMIT ${page.limit + 1}`;
			return orgPage(
				await redactReferences(ctx, type, rows, types, sql),
				page.limit,
				"records",
			);
		}
		const [old] = id
			? await sql`SELECT * FROM flightdeck_pg_org_data_records WHERE workspace_id=${ctx.workspaceId} AND type_key=${key} AND id=${id}`
			: [];
		if (id && !old) throw new OrgDataError(404, "record_not_found");
		if (old && body.expected_revision !== old.revision)
			throw new OrgDataError(409, "revision_conflict");
		if (op === "delete") {
			const rows =
				await sql`SELECT type_key,values FROM flightdeck_pg_org_data_records WHERE workspace_id=${ctx.workspaceId}`;
			if (
				rows.some((r: any) =>
					types
						.find((t) => t.key === r.type_key)
						?.fields.some(
							(f) =>
								f.type === "record_ref" &&
								f.target_type === key &&
								r.values[f.key] === id,
						),
				)
			)
				throw new OrgDataError(409, "record_referenced");
			await sql`DELETE FROM flightdeck_pg_org_data_records WHERE id=${id} AND workspace_id=${ctx.workspaceId}`;
			await audit(op, id!, old, null);
			return { deleted: true };
		}
		validateOrgValues(type, body.values);
		if (key === "holidays" && body.values.start_date > body.values.end_date)
			throw new OrgDataError(400, "invalid_date_range");
		if (body.values.manager && body.values.manager === id)
			throw new OrgDataError(400, "manager_cycle");
		if (key === "people" && body.values.manager) {
			let next = body.values.manager;
			const seen = new Set([id]);
			while (next) {
				if (seen.has(next)) throw new OrgDataError(400, "manager_cycle");
				seen.add(next);
				const [r] =
					await sql`SELECT values FROM flightdeck_pg_org_data_records WHERE workspace_id=${ctx.workspaceId} AND type_key='people' AND id=${next}`;
				next = r?.values?.manager;
			}
		}
		for (const f of type.fields) {
			const v = body.values[f.key];
			if (!v) continue;
			let exists = true;
			if (f.type === "record_ref") {
				const target = types.find((t) => t.key === f.target_type);
				if (!target || !orgAllowed(ctx, target, "read"))
					throw new OrgDataError(403, "reference_permission_denied");
				const rows =
					await sql`SELECT id FROM flightdeck_pg_org_data_records WHERE workspace_id=${ctx.workspaceId} AND type_key=${f.target_type!} AND id=${v}`;
				exists = rows.length > 0;
			}
			if (f.type === "actor_ref") {
				const rows =
					await sql`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${ctx.workspaceId} AND actor_id=${v}`;
				exists = rows.length > 0;
			}
			if (f.type === "nostr_ref") {
				const rows =
					await sql`SELECT a.id FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id WHERE m.workspace_id=${ctx.workspaceId} AND a.npub=${v}`;
				exists = rows.length > 0;
			}
			if (f.type === "workspace_ref") exists = v === ctx.workspaceId;
			if (!exists) throw new OrgDataError(400, "invalid_reference");
		}
		if (body.values.actor && body.values.nostr) {
			const [actor] =
				await sql`SELECT npub FROM flightdeck_pg_actors WHERE id=${body.values.actor}`;
			if (actor?.npub !== body.values.nostr)
				throw new OrgDataError(400, "identity_mismatch");
		}
		const [record] = old
			? await sql`UPDATE flightdeck_pg_org_data_records SET values=${sql.json(body.values)},revision=revision+1,updated_at=now() WHERE id=${id} AND workspace_id=${ctx.workspaceId} RETURNING *`
			: await sql`INSERT INTO flightdeck_pg_org_data_records(workspace_id,type_key,values) VALUES(${ctx.workspaceId},${key!},${sql.json(body.values)}) RETURNING *`;
		await audit(op, record.id, old, record);
		return { record };
	});
}

export function parseOrgPage(body: any = {}) {
	const limit = body.limit === undefined ? 100 : Number(body.limit);
	const cursor = body.cursor ?? "00000000-0000-0000-0000-000000000000";
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 500 ||
		typeof cursor !== "string" ||
		!uuid.test(cursor)
	)
		throw new OrgDataError(400, "invalid_page");
	return { limit, cursor };
}
export function orgPage(rows: any[], limit: number, name: string) {
	const more = rows.length > limit;
	const page = rows.slice(0, limit);
	return {
		[name]: page,
		next_cursor: more ? page.at(-1).id : null,
		has_more: more,
	};
}
async function redactReferences(
	ctx: OrgContext,
	type: OrgType,
	rows: any[],
	types: OrgType[],
	sql: any,
) {
	const members =
		await sql`SELECT a.id,a.npub FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id WHERE m.workspace_id=${ctx.workspaceId}`;
	return rows.map((r) => ({
		...r,
		values: Object.fromEntries(
			Object.entries(r.values).map(([key, value]) => {
				const f = type.fields.find((f) => f.key === key);
				const visible =
					f?.type === "record_ref"
						? types.some(
								(t) => t.key === f.target_type && orgAllowed(ctx, t, "read"),
							)
						: f?.type === "actor_ref"
							? members.some((m: any) => m.id === value)
							: f?.type === "nostr_ref"
								? members.some((m: any) => m.npub === value)
								: f?.type === "workspace_ref"
									? value === ctx.workspaceId
									: true;
				return [key, visible ? value : null];
			}),
		),
	}));
}

export const nappletCapabilities = [
	"org_data.read",
	"org_data.write",
	"org_data.schema",
	"profile.open",
	"dm.open",
];
export function validateNappletBundle(body: any) {
	if (
		!body ||
		typeof body.key !== "string" ||
		!keyPattern.test(body.key) ||
		!Number.isSafeInteger(body.version) ||
		body.version < 1 ||
		body.bridge_version !== 1 ||
		typeof body.title !== "string" ||
		!body.title.trim() ||
		body.title.length > 200 ||
		typeof body.html !== "string" ||
		!body.html.trim() ||
		Buffer.byteLength(body.html) > 524288 ||
		!Array.isArray(body.capabilities) ||
		body.capabilities.length > nappletCapabilities.length ||
		new Set(body.capabilities).size !== body.capabilities.length ||
		body.capabilities.some((c: any) => !nappletCapabilities.includes(c))
	)
		throw new OrgDataError(400, "invalid_bundle");
	return {
		key: body.key,
		version: body.version,
		title: body.title,
		bridge_version: 1,
		capabilities: body.capabilities,
		html: body.html,
		sha256: createHash("sha256").update(body.html).digest("hex"),
	};
}
async function nappletOperation(
	ctx: OrgContext,
	op: string,
	key: string | undefined,
	body: any,
	sql: any,
	audit: any,
) {
	if (op === "nappletPublish") {
		if (!ctx.permissions?.["napplet.publish"])
			throw new OrgDataError(403, "napplet_publish_required");
		const b = validateNappletBundle(body);
		const [old] =
			await sql`SELECT sha256 FROM flightdeck_pg_napplet_bundles WHERE workspace_id=${ctx.workspaceId} AND key=${b.key} AND version=${b.version}`;
		if (old) throw new OrgDataError(409, "bundle_version_exists");
		await sql`INSERT INTO flightdeck_pg_napplet_bundles(workspace_id,key,version,title,bridge_version,capabilities,html,sha256,created_by_actor_id) VALUES(${ctx.workspaceId},${b.key},${b.version},${b.title},1,${sql.json(b.capabilities)},${b.html},${b.sha256},${ctx.actorId})`;
		const { html, ...bundle } = b;
		await audit(op, b.key, null, bundle);
		return { bundle };
	}
	if (op === "nappletList") {
		const rows =
			await sql`SELECT key,version,title,bridge_version,capabilities,sha256 FROM flightdeck_pg_napplet_bundles WHERE workspace_id=${ctx.workspaceId} ORDER BY key,version`;
		return { bundles: rows };
	}
	if (op === "nappletInstall") {
		if (!ctx.permissions?.["napplet.install"])
			throw new OrgDataError(403, "napplet_install_required");
		if (
			!key ||
			!keyPattern.test(key) ||
			!Number.isSafeInteger(body.version) ||
			!Number.isSafeInteger(body.expected_revision)
		)
			throw new OrgDataError(400, "invalid_installation");
		const [b] =
			await sql`SELECT * FROM flightdeck_pg_napplet_bundles WHERE workspace_id=${ctx.workspaceId} AND key=${key} AND version=${body.version}`;
		if (!b) throw new OrgDataError(404, "bundle_not_found");
		const [old] =
			await sql`SELECT * FROM flightdeck_pg_napplet_installations WHERE workspace_id=${ctx.workspaceId} AND key=${key}`;
		if ((old?.revision ?? 0) !== body.expected_revision)
			throw new OrgDataError(409, "revision_conflict");
		const [installation] =
			await sql`INSERT INTO flightdeck_pg_napplet_installations(workspace_id,key,version) VALUES(${ctx.workspaceId},${key},${body.version}) ON CONFLICT(workspace_id,key) DO UPDATE SET version=EXCLUDED.version,revision=flightdeck_pg_napplet_installations.revision+1,updated_at=now() RETURNING *`;
		await audit(op, key, old, installation);
		return { installation };
	}
	throw new OrgDataError(400, "unknown_operation");
}

const orgPermissionsList = [
	"org_data.read",
	"org_data.write",
	"org_data.schema",
	"napplet.publish",
	"napplet.install",
];
async function orgPermissions(
	ctx: OrgContext,
	op: string,
	body: any,
	sql: any,
	audit: any,
) {
	const [self] =
		await sql`SELECT kind FROM flightdeck_pg_actors WHERE id=${ctx.actorId}`;
	if (!ctx.permissions?.["workspace.manage"] || self?.kind !== "human")
		throw new OrgDataError(403, "human_workspace_manager_required");
	if (op === "permissions") {
		const members =
			await sql`SELECT a.id,a.display_name,a.npub,a.kind FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id WHERE m.workspace_id=${ctx.workspaceId} ORDER BY a.id`;
		for (const m of members) {
			m.permissions = (
				await sql`SELECT permission FROM flightdeck_pg_permission_grants WHERE workspace_id=${ctx.workspaceId} AND principal_type='actor' AND principal_actor_id=${m.id} AND resource_type='workspace' AND revoked_at IS NULL AND permission IN ${sql(orgPermissionsList)} ORDER BY permission`
			).map((g: any) => g.permission);
		}
		return { members };
	}
	if (
		!uuid.test(body.actor_id) ||
		!Array.isArray(body.permissions) ||
		!Array.isArray(body.expected_permissions) ||
		body.permissions.some((p: any) => !orgPermissionsList.includes(p)) ||
		new Set(body.permissions).size !== body.permissions.length
	)
		throw new OrgDataError(400, "invalid_permissions");
	const [member] =
		await sql`SELECT actor_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${ctx.workspaceId} AND actor_id=${body.actor_id}`;
	if (!member) throw new OrgDataError(400, "invalid_reference");
	const old = (
		await sql`SELECT permission FROM flightdeck_pg_permission_grants WHERE workspace_id=${ctx.workspaceId} AND principal_type='actor' AND principal_actor_id=${body.actor_id} AND resource_type='workspace' AND revoked_at IS NULL AND permission IN ${sql(orgPermissionsList)} ORDER BY permission`
	).map((g: any) => g.permission);
	if (
		JSON.stringify([...body.expected_permissions].sort()) !==
		JSON.stringify(old)
	)
		throw new OrgDataError(409, "permission_conflict");
	await sql`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${ctx.workspaceId} AND principal_type='actor' AND principal_actor_id=${body.actor_id} AND resource_type='workspace' AND revoked_at IS NULL AND permission IN ${sql(orgPermissionsList)}`;
	for (const p of body.permissions)
		await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission,created_by_actor_id) VALUES(${ctx.workspaceId},'actor',${body.actor_id},'workspace',${p},${ctx.actorId})`;
	await audit(
		op,
		body.actor_id,
		{ permissions: old },
		{ permissions: body.permissions },
	);
	await sql`INSERT INTO flightdeck_pg_outbox_events(workspace_id,actor_id,event_type,entity_type,operation,payload) VALUES(${ctx.workspaceId},${ctx.actorId},'org_data.permissions_changed','org_data','permissions',${sql.json({ target_actor_id: body.actor_id })})`;
	return { actor_id: body.actor_id, permissions: body.permissions };
}
