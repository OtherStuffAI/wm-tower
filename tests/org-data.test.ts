import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { setDb, closeDb } from "../src/db";
import { splitSqlStatements } from "../src/schema/sql-statements";
import { ensureRuntimeSchema } from "../src/schema/ensure-runtime-schema";
import {
	orgOperation as operate,
	validateOrgType,
	validateOrgValues,
	validateNappletBundle,
	parseOrgPage,
	type OrgContext,
} from "../src/services/org-data";
import { createApp } from "../src/server";
import { listVisibleFlightDeckPgEvents } from "../src/services/flightdeck-pg-api";
// Dynamic operation fixtures assert each response shape below.
const orgOperation: (...args: Parameters<typeof operate>) => Promise<any> =
	operate;
const definition = {
	key: "samples",
	label: "Samples",
	fields: [{ key: "name", label: "Name", type: "text", required: true }],
	access: { read: "members", write: "members" },
};
test("typed definitions, dates, values, pagination and bundle manifests fail closed", () => {
	expect(() =>
		validateOrgType({
			...definition,
			fields: [...definition.fields, ...definition.fields],
		}),
	).toThrow("invalid_field");
	expect(() => validateOrgType({ ...definition, key: "../sql" })).toThrow(
		"invalid_type",
	);
	expect(() =>
		validateOrgValues(definition as any, { name: "x", sql: "select *" }),
	).toThrow("unknown_field");
	expect(() =>
		validateOrgValues(
			{ ...definition, fields: [{ key: "day", type: "date" }] } as any,
			{ day: "2026-02-30" },
		),
	).toThrow("invalid_field_value");
	expect(() => parseOrgPage({ limit: 501 })).toThrow("invalid_page");
	expect(() =>
		validateNappletBundle({
			key: "app",
			title: "App",
			version: 1,
			bridge_version: 1,
			html: "hello",
			capabilities: ["sql"],
		}),
	).toThrow("invalid_bundle");
});
const port = Number(process.env.ORG_DATA_TEST_PORT);
describe.skipIf(!port || port === 5432)(
	"organisation data disposable PostgreSQL",
	() => {
		const conn = {
			host: "127.0.0.1",
			port,
			username: "postgres",
			password: "postgres",
			onnotice: () => {},
		};
		const database = `tower_org_data_${process.pid}_${Date.now()}`;
		let db: ReturnType<typeof postgres>,
			manager: OrgContext,
			editor: OrgContext,
			viewer: OrgContext,
			agent: OrgContext,
			outsider: OrgContext;
		let initialized = false;
		let person: any, team: any, holiday: any;
		const keys = [71, 72, 73, 74, 75].map((n) => new Uint8Array(32).fill(n));
		const npub = (i: number) => nip19.npubEncode(getPublicKey(keys[i]!));
		const app = createApp();
		const grant = async (ctx: OrgContext, permission: string) =>
			db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission) VALUES(${ctx.workspaceId},'actor',${ctx.actorId},'workspace',${permission}) ON CONFLICT DO NOTHING`;
		beforeAll(async () => {
			const admin = postgres({ ...conn, database: "postgres" });
			await admin.unsafe(`CREATE DATABASE ${database}`);
			await admin.end();
			db = postgres({ ...conn, database });
			setDb(db);
			initialized = true;
			for (const stmt of splitSqlStatements(
				readFileSync(
					new URL("../src/schema/001_init.sql", import.meta.url),
					"utf8",
				),
			))
				await db.unsafe(stmt);
			await ensureRuntimeSchema();
			const [w] =
				await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-org','service-org',${npub(0)},'org-app','Org Test') RETURNING id`;
			const contexts = [];
			for (let i = 0; i < 5; i++) {
				const [a] =
					await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub(i)},${i === 3 ? "agent" : "human"}) RETURNING id`;
				await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w!.id},${a!.id},${i === 0 ? "owner" : i === 3 ? "agent" : "member"})`;
				contexts.push({
					workspaceId: w!.id,
					actorId: a!.id,
					actorNpub: npub(i),
					appNpub: "org-app",
					role: i === 0 ? "owner" : "member",
				});
			}
			[manager, editor, viewer, agent, outsider] = contexts as OrgContext[];
			for (const ctx of contexts.slice(0, 4))
				for (const permission of ["workspace.read", "org_data.read"])
					await grant(ctx, permission);
			for (const ctx of [manager, editor, agent])
				await grant(ctx, "org_data.write");
			for (const permission of [
				"org_data.schema",
				"napplet.publish",
				"napplet.install",
				"workspace.manage",
			])
				await grant(manager, permission);
		});
		afterAll(async () => {
			if (initialized) await closeDb();
			const admin = postgres({ ...conn, database: "postgres" });
			await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
			await admin.end();
		});
		test("membership/owner role alone gives no authority and agents cannot self-escalate", async () => {
			await expect(orgOperation(outsider, "catalogue")).rejects.toMatchObject({
				status: 403,
			});
			await expect(orgOperation(agent, "bootstrap")).rejects.toMatchObject({
				status: 403,
				code: "schema_permission_required",
			});
			await expect(
				orgOperation(agent, "nappletPublish", undefined, undefined, {
					key: "test",
				}),
			).rejects.toMatchObject({ status: 403 });
			const result = await orgOperation(manager, "bootstrap");
			expect(result.types).toHaveLength(3);
		});
		test("editor and agent edit shared people, team relationships and holiday values persisted across reads", async () => {
			team = (
				await orgOperation(editor, "create", "teams", undefined, {
					values: { name: "Engineering" },
				})
			).record;
			person = (
				await orgOperation(agent, "create", "people", undefined, {
					values: {
						name: "Alex",
						title: "Engineer",
						team: team.id,
						actor: viewer.actorId,
						nostr: viewer.actorNpub,
					},
				})
			).record;
			holiday = (
				await orgOperation(editor, "create", "holidays", undefined, {
					values: {
						person: person.id,
						start_date: "2026-12-01",
						end_date: "2026-12-03",
						status: "Away",
					},
				})
			).record;
			person = (
				await orgOperation(agent, "update", "people", person.id, {
					expected_revision: 1,
					values: { ...person.values, title: "Lead" },
				})
			).record;
			const snapshot = await orgOperation(viewer, "snapshot");
			expect(
				snapshot.records.find((r: any) => r.id === person.id).values.title,
			).toBe("Lead");
			expect(
				snapshot.records.find((r: any) => r.id === holiday.id).values.person,
			).toBe(person.id);
			expect(snapshot.identities[viewer.actorId]).toBe(viewer.actorNpub);
			const reloaded = await orgOperation(viewer, "list", "people");
			expect(reloaded.records[0].revision).toBe(2);
			await expect(
				orgOperation(viewer, "update", "people", person.id, {
					expected_revision: 2,
					values: person.values,
				}),
			).rejects.toMatchObject({ status: 403 });
		});
		test("CAS and schema validation fail without losing canonical data; racing writes yield one winner", async () => {
			await expect(
				orgOperation(editor, "update", "people", person.id, {
					expected_revision: 1,
					values: person.values,
				}),
			).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
			const t = (await orgOperation(manager, "catalogue")).types.find(
				(t: any) => t.key === "people",
			);
			await expect(
				orgOperation(manager, "updateType", "people", undefined, {
					...t,
					expected_revision: t.revision,
					fields: [
						...t.fields,
						{ key: "must", label: "Must", type: "text", required: true },
					],
				}),
			).rejects.toMatchObject({ code: "required_field" });
			const race = await Promise.allSettled([
				orgOperation(editor, "update", "people", person.id, {
					expected_revision: 2,
					values: { ...person.values, title: "A" },
				}),
				orgOperation(agent, "update", "people", person.id, {
					expected_revision: 2,
					values: { ...person.values, title: "B" },
				}),
			]);
			expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			expect(race.filter((r) => r.status === "rejected")).toHaveLength(1);
			person = (await orgOperation(viewer, "list", "people")).records[0];
			expect(person.revision).toBe(3);
		});
		test("cross-workspace/missing identity references, inverted dates, cycles and referenced deletion are denied", async () => {
			for (const [field, value] of [
				["team", randomUUID()],
				["actor", randomUUID()],
				["nostr", npub(4).replace(/.$/, "x")],
			])
				await expect(
					orgOperation(editor, "create", "people", undefined, {
						values: { name: "Invalid", [field]: value },
					}),
				).rejects.toMatchObject({ status: 400 });
			await expect(
				orgOperation(editor, "update", "people", person.id, {
					expected_revision: person.revision,
					values: { ...person.values, manager: person.id },
				}),
			).rejects.toMatchObject({ code: "manager_cycle" });
			await expect(
				orgOperation(editor, "create", "holidays", undefined, {
					values: {
						person: person.id,
						start_date: "2026-12-03",
						end_date: "2026-12-01",
						status: "Away",
					},
				}),
			).rejects.toMatchObject({ code: "invalid_date_range" });
			await expect(
				orgOperation(editor, "delete", "people", person.id, {
					expected_revision: person.revision,
				}),
			).rejects.toMatchObject({ code: "record_referenced" });
			await expect(
				orgOperation(editor, "delete", "teams", team.id, {
					expected_revision: 1,
				}),
			).rejects.toMatchObject({ code: "record_referenced" });
			await expect(
				orgOperation(editor, "update", "people", person.id, {
					expected_revision: person.revision,
					values: { ...person.values, nostr: manager.actorNpub },
				}),
			).rejects.toMatchObject({ code: "identity_mismatch" });
		});
		test("restricted target types and revoked member identities are neutral in read projections", async () => {
			const t = (await orgOperation(manager, "catalogue")).types.find(
				(t: any) => t.key === "teams",
			);
			await orgOperation(manager, "updateType", "teams", undefined, {
				...t,
				expected_revision: t.revision,
				access: { read: "admins", write: "admins" },
			});
			const s = await orgOperation(viewer, "snapshot");
			expect(
				s.records.find((r: any) => r.id === person.id).values.team,
			).toBeNull();
			expect(s.types.some((t: any) => t.key === "teams")).toBe(false);
			await expect(
				orgOperation(editor, "create", "people", undefined, {
					values: { name: "Bad", team: team.id },
				}),
			).rejects.toMatchObject({ status: 403 });
		});
		test("records paginate without omissions and audit is admin-only; event invalidations reveal no values", async () => {
			for (let i = 0; i < 4; i++)
				await orgOperation(editor, "create", "people", undefined, {
					values: { name: "Person " + i },
				});
			const ids = [];
			let cursor: any;
			do {
				const p = await orgOperation(viewer, "list", "people", undefined, {
					limit: 2,
					...(cursor ? { cursor } : {}),
				});
				ids.push(...p.records.map((r: any) => r.id));
				cursor = p.next_cursor;
			} while (cursor);
			expect(ids).toHaveLength(5);
			expect(new Set(ids).size).toBe(5);
			await expect(orgOperation(viewer, "history")).rejects.toMatchObject({
				status: 403,
			});
			expect(
				(await orgOperation(manager, "history")).changes.length,
			).toBeGreaterThan(5);
			const events = await listVisibleFlightDeckPgEvents({
				workspaceId: viewer.workspaceId,
				actorId: viewer.actorId,
				groupIds: [],
				afterRowVersion: 0,
				limit: 100,
			});
			expect(events.some((e) => e.entity_type === "org_data")).toBe(true);
			expect(
				events
					.filter((e) => e.entity_type === "org_data")
					.every((e) => Object.keys(e.payload).length === 0),
			).toBe(true);
		});
		test("immutable static bundle publish/install stores version, digest, capabilities and CAS", async () => {
			const b = {
				trusted_code_acknowledged: true,
				key: "demo",
				title: "Demo",
				version: 1,
				bridge_version: 1,
				capabilities: ["org_data.read"],
				html: '<h1>Demo</h1><script>parent.postMessage({version:1,session:window.nappletSession,type:"ready"},"*")</script>',
			};
			const published = await orgOperation(
				manager,
				"nappletPublish",
				undefined,
				undefined,
				b,
			);
			expect(published.bundle.sha256).toBe(
				createHash("sha256").update(b.html).digest("hex"),
			);
			await expect(
				orgOperation(manager, "nappletPublish", undefined, undefined, b),
			).rejects.toMatchObject({ code: "bundle_version_exists" });
			await orgOperation(manager, "nappletInstall", "demo", undefined, {
				version: 1,
				expected_revision: 0,
				trusted_code_acknowledged: true,
			});
			await expect(
				orgOperation(manager, "nappletInstall", "demo", undefined, {
					version: 1,
					expected_revision: 0,
					trusted_code_acknowledged: true,
				}),
			).rejects.toMatchObject({ code: "revision_conflict" });
			const snapshot = await orgOperation(viewer, "snapshot");
			expect(snapshot.installations[0].html).toBe(b.html);
			expect(snapshot.installations[0].revision).toBe(1);
		});

		test("workspace managers grant editor/viewer capabilities with CAS; agents cannot self-escalate", async () => {
			await expect(
				orgOperation(agent, "grantPermissions", undefined, undefined, {
					actor_id: agent.actorId,
					permissions: ["org_data.schema"],
					expected_permissions: [],
				}),
			).rejects.toMatchObject({ code: "workspace_manager_required" });
			const members = await orgOperation(manager, "permissions");
			const target = members.members.find(
				(m: any) => m.id === outsider.actorId,
			);
			await orgOperation(manager, "grantPermissions", undefined, undefined, {
				actor_id: outsider.actorId,
				permissions: ["org_data.read"],
				expected_permissions: target.permissions,
			});
			await grant(outsider, "workspace.read");
			expect(
				(await orgOperation(outsider, "catalogue")).capabilities.write,
			).toBe(false);
			await expect(
				orgOperation(manager, "grantPermissions", undefined, undefined, {
					actor_id: outsider.actorId,
					permissions: ["org_data.write"],
					expected_permissions: [],
				}),
			).rejects.toMatchObject({ code: "permission_conflict" });
			await orgOperation(manager, "grantPermissions", undefined, undefined, {
				actor_id: outsider.actorId,
				permissions: [],
				expected_permissions: ["org_data.read"],
			});
			await ensureRuntimeSchema();
			await expect(orgOperation(outsider, "catalogue")).rejects.toMatchObject({
				status: 403,
			});
			const events = await listVisibleFlightDeckPgEvents({
				workspaceId: outsider.workspaceId,
				actorId: outsider.actorId,
				groupIds: [],
				afterRowVersion: 0,
				limit: 100,
			});
			expect(
				events.some((e: any) => e.payload.target_actor_id === outsider.actorId),
			).toBe(true);
		});
		test("existing foreign-workspace records and identities cannot be linked; workspace links grant no access", async () => {
			const [w] =
				await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('foreign-tower','foreign-service',${outsider.actorNpub},'foreign-app','Foreign') RETURNING id`;
			await db`INSERT INTO flightdeck_pg_org_data_types(workspace_id,key,label,fields,access) VALUES(${w!.id},'teams','Foreign teams','[]'::jsonb,'{"read":"members","write":"members"}'::jsonb)`;
			const [r] =
				await db`INSERT INTO flightdeck_pg_org_data_records(workspace_id,type_key,values) VALUES(${w!.id},'teams','{"name":"Foreign secret"}'::jsonb) RETURNING id`;
			await orgOperation(manager, "createType", undefined, undefined, {
				key: "links",
				label: "Links",
				fields: [
					{
						key: "team",
						label: "Team",
						type: "record_ref",
						target_type: "teams",
					},
					{ key: "workspace", label: "Workspace", type: "workspace_ref" },
				],
				access: { read: "members", write: "members" },
			});
			await expect(
				orgOperation(manager, "create", "links", undefined, {
					values: { team: r!.id },
				}),
			).rejects.toMatchObject({ code: "invalid_reference" });
			await expect(
				orgOperation(editor, "create", "links", undefined, {
					values: { workspace: w!.id },
				}),
			).rejects.toMatchObject({ code: "invalid_reference" });
			const own = await orgOperation(editor, "create", "links", undefined, {
				values: { workspace: editor.workspaceId },
			});
			expect(own.record.values.workspace).toBe(editor.workspaceId);
			const foreignNpub = nip19.npubEncode(
				getPublicKey(new Uint8Array(32).fill(76)),
			);
			const [a] =
				await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${foreignNpub},'human') RETURNING id`;
			await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w!.id},${a!.id},'member')`;
			await expect(
				orgOperation(editor, "create", "people", undefined, {
					values: { name: "Invalid", actor: a!.id },
				}),
			).rejects.toMatchObject({ code: "invalid_reference" });
			await expect(
				orgOperation(editor, "create", "people", undefined, {
					values: { name: "Invalid", nostr: foreignNpub },
				}),
			).rejects.toMatchObject({ code: "invalid_reference" });
		});
		test("ordinary custom text fields named manager, actor and nostr create/update without identity rules", async () => {
			await orgOperation(manager, "createType", undefined, undefined, {
				key: "custom_text",
				label: "Custom",
				fields: ["manager", "actor", "nostr"].map((key) => ({
					key,
					label: key,
					type: "text",
				})),
				access: { read: "members", write: "members" },
			});
			const record = (
				await orgOperation(editor, "create", "custom_text", undefined, {
					values: { manager: "ordinary", actor: "not-a-uuid", nostr: "text" },
				})
			).record;
			const updated = (
				await orgOperation(editor, "update", "custom_text", record.id, {
					expected_revision: 1,
					values: {
						manager: record.id,
						actor: "another text",
						nostr: "ordinary text",
					},
				})
			).record;
			expect(updated.revision).toBe(2);
			expect(updated.values.manager).toBe(record.id);
		});
		test("explicit delegated agent workspace manager grants/revokes; ordinary agent cannot grant", async () => {
			await expect(
				orgOperation(agent, "grantPermissions", undefined, undefined, {
					actor_id: agent.actorId,
					permissions: ["org_data.schema"],
					expected_permissions: [],
				}),
			).rejects.toMatchObject({ status: 403 });
			await grant(agent, "workspace.manage");
			const own = (await orgOperation(agent, "permissions")).members.find(
				(m: any) => m.id === agent.actorId,
			).permissions;
			for (const missing of [
				"org_data.schema",
				"napplet.publish",
				"napplet.install",
			]) {
				await expect(
					orgOperation(agent, "grantPermissions", undefined, undefined, {
						actor_id: agent.actorId,
						permissions: [...own, missing],
						expected_permissions: own,
					}),
				).rejects.toMatchObject({
					status: 403,
					code: "self_permission_escalation",
				});
			}
			// A delegated manager may reduce its own grants without elevating itself.
			await orgOperation(agent, "grantPermissions", undefined, undefined, {
				actor_id: agent.actorId,
				permissions: ["org_data.read"],
				expected_permissions: own,
			});
			expect((await orgOperation(agent, "catalogue")).capabilities.write).toBe(
				false,
			);
			await orgOperation(manager, "grantPermissions", undefined, undefined, {
				actor_id: agent.actorId,
				permissions: own,
				expected_permissions: ["org_data.read"],
			});

			const before = (await orgOperation(agent, "permissions")).members.find(
				(m: any) => m.id === viewer.actorId,
			).permissions;
			await orgOperation(agent, "grantPermissions", undefined, undefined, {
				actor_id: viewer.actorId,
				permissions: [...before, "org_data.write"],
				expected_permissions: before,
			});
			expect((await orgOperation(viewer, "catalogue")).capabilities.write).toBe(
				true,
			);
			await orgOperation(agent, "grantPermissions", undefined, undefined, {
				actor_id: viewer.actorId,
				permissions: before,
				expected_permissions: [...before, "org_data.write"],
			});
			expect((await orgOperation(viewer, "catalogue")).capabilities.write).toBe(
				false,
			);
			await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${agent.workspaceId} AND principal_actor_id=${agent.actorId} AND permission='workspace.manage'`;
		});
		test("signed publication accepts escaped HTML boundary and rejects overflow/absent trust", async () => {
			const publish = async (body: any, suffix = "") => {
				const url = `http://tower.test/api/v4/flightdeck-pg/workspaces/${manager.workspaceId}/org-data/napplets/bundles`;
				const raw = JSON.stringify(body) + suffix;
				const event = finalizeEvent(
					{
						kind: 27235,
						created_at: Math.floor(Date.now() / 1000),
						tags: [
							["u", url],
							["method", "POST"],
							["payload", createHash("sha256").update(raw).digest("hex")],
						],
						content: "",
					},
					keys[0]!,
				);
				return app.request(url, {
					method: "POST",
					headers: {
						Authorization:
							"Nostr " + Buffer.from(JSON.stringify(event)).toString("base64"),
						"x-flightdeck-pg-app-npub": "org-app",
						"content-type": "application/json",
					},
					body: raw,
				});
			};
			const body = {
				key: "escaped",
				version: 1,
				title: "Escaped",
				bridge_version: 1,
				capabilities: ["org_data.read"],
				trusted_code_acknowledged: true,
				html: "<p>" + "\u0001".repeat(524279) + '"\n</p>',
			};
			expect(Buffer.byteLength(body.html)).toBe(524288);
			expect((await publish(body)).status).toBe(200);
			expect(
				(await publish({ ...body, key: "too_big", html: body.html + "x" }))
					.status,
			).toBe(400);
			const capped = await publish({ ...body, key: "cap" }, " ".repeat(20000));
			expect(capped.status).toBe(400);
			expect((await capped.json()).error.code).toBe("request_too_large");
			const untrusted = await publish({
				...body,
				key: "untrusted",
				trusted_code_acknowledged: false,
			});
			expect(untrusted.status).toBe(400);
			expect((await untrusted.json()).error.code).toBe(
				"trusted_code_acknowledgement_required",
			);
			await expect(
				orgOperation(manager, "nappletInstall", "escaped", undefined, {
					version: 1,
					expected_revision: 0,
				}),
			).rejects.toMatchObject({
				code: "trusted_code_acknowledgement_required",
			});
		});

		test("signed typed HTTP routes enforce app, workspace and membership scopes", async () => {
			const request = async (
				index: number,
				workspaceId: string,
				appNpub = "org-app",
			) => {
				const path = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/org-data/snapshot`,
					url = "http://tower.test" + path;
				const event = finalizeEvent(
					{
						kind: 27235,
						created_at: Math.floor(Date.now() / 1000),
						tags: [
							["u", url],
							["method", "GET"],
						],
						content: "",
					},
					keys[index]!,
				);
				return app.request(url, {
					headers: {
						Authorization:
							"Nostr " + Buffer.from(JSON.stringify(event)).toString("base64"),
						"x-flightdeck-pg-app-npub": appNpub,
					},
				});
			};
			expect((await request(2, viewer.workspaceId)).status).toBe(200);
			expect((await request(2, viewer.workspaceId, "foreign-app")).status).toBe(
				403,
			);
			expect((await request(4, viewer.workspaceId)).status).toBe(403);
			expect((await request(2, randomUUID())).status).toBe(404);
		});
	},
);
