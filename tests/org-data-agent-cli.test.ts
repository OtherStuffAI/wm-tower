import { expect, test } from "bun:test";
import { requestOrgData } from "../src/scripts/org-data";
import { createHash } from "node:crypto";
test("agent CLI uses session broker and exact typed request/body hash, without key access", async () => {
	const calls: any[] = [];
	const body = { values: { name: "Alex" } };
	const fetchImpl = async (url: any, opts: any) => {
		calls.push({ url, opts });
		return new Response(
			JSON.stringify(
				calls.length === 1
					? { token: "Nostr scoped-token" }
					: { record: { id: "example" } },
			),
			{ status: 200 },
		);
	};
	await requestOrgData(
		{
			tower: "https://tower.example",
			workspace: "11111111-1111-4111-8111-111111111111",
			appNpub: "app",
			path: "types/people/records",
			method: "POST",
			body,
		},
		{
			WINGMAN_BROKER_URL: "http://localhost:3600",
			SESSION_ID: "s",
			WINGMAN_CAPABILITY: "session-token",
		},
		fetchImpl as any,
	);
	expect(calls[0].url).toBe("http://localhost:3600/api/mcp/capabilities/nip98");
	expect(JSON.parse(calls[0].opts.body).bodyHash).toBe(
		createHash("sha256").update(JSON.stringify(body)).digest("hex"),
	);
	expect(calls[1].opts.headers.Authorization).toBe("Nostr scoped-token");
	expect(calls[1].opts.redirect).toBe("error");
	expect(calls[1].opts.body).toBe(JSON.stringify(body));
	await expect(
		requestOrgData(
			{
				tower: "https://tower.example",
				workspace: "11111111-1111-4111-8111-111111111111",
				appNpub: "app",
				path: "../admin",
			},
			{},
			fetchImpl as any,
		),
	).rejects.toThrow("Unsupported");
});
