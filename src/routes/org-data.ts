import type { Hono, Context } from "hono";
import { requireNip98AuthResolved } from "../auth";
import {
	buildFlightDeckPgIdentity,
	resolveFlightDeckPgRequestContext,
} from "../services/flightdeck-pg-api";
import {
	orgOperation,
	OrgDataError,
	NAPPLET_REQUEST_BYTES,
} from "../services/org-data";
export function registerOrgDataRoutes(router: Hono) {
	const base = "/workspaces/:workspaceId/org-data";
	const handle = (operation: string) => async (c: Context) => {
		c.header("Cache-Control", "private, no-store");
		try {
			const auth = await requireNip98AuthResolved(c);
			if (auth instanceof Response) return auth;
			const ctx = await resolveFlightDeckPgRequestContext({
				workspaceId: c.req.param("workspaceId")!,
				actorNpub: auth.userNpub,
			});
			if (!ctx.workspace) throw new OrgDataError(404, "workspace_not_found");
			if (!ctx.actor || !ctx.membership)
				throw new OrgDataError(403, "workspace_membership_required");
			const app =
				c.req.header("x-flightdeck-pg-app-npub") ?? c.req.query("app_npub");
			if (app !== ctx.workspace.app_npub)
				throw new OrgDataError(403, "workspace_app_mismatch");
			const id = c.req.param("recordId");
			if (id && !/^[0-9a-f-]{36}$/i.test(id))
				throw new OrgDataError(400, "invalid_record_id");
			let body: any = { ...c.req.query() };
			delete body.app_npub;
			if (c.req.method !== "GET") {
				const raw = await c.req.text();
				if (
					Buffer.byteLength(raw) >
					(operation === "nappletPublish" ? NAPPLET_REQUEST_BYTES : 131072)
				)
					throw new OrgDataError(400, "request_too_large");
				if (raw)
					try {
						body = JSON.parse(raw);
					} catch {
						throw new OrgDataError(400, "invalid_json");
					}
			}
			const payload = await orgOperation(
				{
					workspaceId: ctx.workspace.id,
					actorId: ctx.actor.id,
					actorNpub: auth.userNpub,
					appNpub: ctx.workspace.app_npub,
					role: ctx.membership.role,
				},
				operation,
				c.req.param("typeKey") ?? c.req.param("bundleKey"),
				id,
				body,
			);
			return c.json({
				identity: buildFlightDeckPgIdentity(
					ctx.workspace,
					ctx.workspace.app_npub,
				),
				workspace_id: ctx.workspace.id,
				...payload,
			});
		} catch (e) {
			if (e instanceof OrgDataError)
				return c.json(
					{ error: { code: e.code, message: e.code, retryable: false } },
					e.status,
				);
			throw e;
		}
	};
	router.get(`${base}/catalogue`, handle("catalogue"));
	router.get(`${base}/snapshot`, handle("snapshot"));
	router.post(`${base}/bootstrap`, handle("bootstrap"));
	router.get(`${base}/permissions`, handle("permissions"));
	router.post(`${base}/permissions`, handle("grantPermissions"));
	router.get(`${base}/history`, handle("history"));
	router.get(`${base}/napplets/bundles`, handle("nappletList"));
	router.post(`${base}/napplets/bundles`, handle("nappletPublish"));
	router.post(
		`${base}/napplets/installations/:bundleKey`,
		handle("nappletInstall"),
	);
	router.post(`${base}/types`, handle("createType"));
	router.patch(`${base}/types/:typeKey`, handle("updateType"));
	router.get(`${base}/types/:typeKey/records`, handle("list"));
	router.post(`${base}/types/:typeKey/records`, handle("create"));
	router.patch(`${base}/types/:typeKey/records/:recordId`, handle("update"));
	router.delete(`${base}/types/:typeKey/records/:recordId`, handle("delete"));
}
