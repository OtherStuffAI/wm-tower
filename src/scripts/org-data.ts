#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
/** Broker-backed typed API client. It never accepts or reads a private key. */
export async function requestOrgData(
	input: {
		tower: string;
		workspace: string;
		appNpub: string;
		path: string;
		method?: string;
		body?: unknown;
	},
	env: Record<string, string | undefined> = process.env,
	fetchImpl: typeof fetch = fetch,
) {
	const base = new URL(input.tower);
	if (
		base.username ||
		base.password ||
		!["http:", "https:"].includes(base.protocol)
	)
		throw new Error("Invalid Tower URL");
	if (!/^[0-9a-f-]{36}$/i.test(input.workspace))
		throw new Error("Workspace UUID required");
	const method = input.method || "GET";
	if (
		!["GET", "POST", "PATCH", "DELETE"].includes(method) ||
		!/^(permissions|catalogue|snapshot|history|bootstrap|types(?:\/[a-z][a-z0-9_]{0,63}(?:\/records(?:\/[0-9a-f-]{36})?)?)?|napplets\/(?:bundles|installations\/[a-z][a-z0-9_]{0,63}))(?:\?(?:limit=\d+|cursor=[0-9a-f-]{36})(?:&(?:limit=\d+|cursor=[0-9a-f-]{36}))?)?$/.test(
			input.path,
		)
	)
		throw new Error("Unsupported typed org-data operation");
	if (
		method === "POST" &&
		/^napplets\/(bundles|installations\/)/.test(input.path) &&
		(input.body as any)?.trusted_code_acknowledged !== true
	)
		throw new Error(
			"Trusted code acknowledgement required: review declared data/capabilities and iframe self-navigation exfiltration risk, then set trusted_code_acknowledged: true",
		);
	const broker = env.WINGMAN_BROKER_URL || env.WINGMAN_URL;
	if (!broker || !env.SESSION_ID || !env.WINGMAN_CAPABILITY)
		throw new Error(
			"A scoped session capability is required; private keys are not supported",
		);
	const url = `${base.origin}/api/v4/flightdeck-pg/workspaces/${input.workspace}/org-data/${input.path}`;
	const body =
		input.body === undefined ? undefined : JSON.stringify(input.body);
	if (
		body &&
		Buffer.byteLength(body) >
			(input.path === "napplets/bundles" ? 6 * 524288 + 16384 : 131072)
	)
		throw new Error("Body too large");
	const signed = await fetchImpl(
		`${broker.replace(/\/$/, "")}/api/mcp/capabilities/nip98`,
		{
			method: "POST",
			redirect: "error",
			headers: {
				authorization: `Bearer ${env.WINGMAN_CAPABILITY}`,
				"content-type": "application/json",
				"x-wingman-capability-nonce": randomUUID(),
			},
			body: JSON.stringify({
				sessionId: env.SESSION_ID,
				url,
				method,
				...(body
					? { bodyHash: createHash("sha256").update(body).digest("hex") }
					: {}),
			}),
		},
	);
	if (!signed.ok)
		throw new Error(
			`Capability broker rejected the operation (${signed.status}); request a scoped capability from the manager`,
		);
	const { token } = (await signed.json()) as { token: string };
	if (typeof token !== "string" || !token.startsWith("Nostr "))
		throw new Error("Invalid broker authorization");
	const response = await fetchImpl(url, {
		method,
		redirect: "error",
		headers: {
			Authorization: token,
			"x-flightdeck-pg-app-npub": input.appNpub,
			...(body ? { "content-type": "application/json" } : {}),
		},
		body,
	});
	const payload = await response.json().catch(() => ({
		code: "non_json_response",
		content_type: response.headers.get("content-type"),
	}));
	if (!response.ok)
		throw Object.assign(
			new Error(`Tower rejected org-data operation (${response.status})`),
			{ status: response.status, payload },
		);
	return payload;
}
if (import.meta.main) {
	const args = Bun.argv.slice(2),
		options: Record<string, string> = {};
	for (let i = 0; i < args.length; i += 2) {
		const name = args[i];
		if (
			!name ||
			![
				"--tower",
				"--workspace",
				"--app-npub",
				"--path",
				"--method",
				"--body-file",
			].includes(name) ||
			!args[i + 1]
		)
			throw new Error(
				"Usage: bun src/scripts/org-data.ts --tower URL --workspace UUID --app-npub NPUB --path snapshot [--method POST --body-file FILE]",
			);
		options[name.slice(2)] = args[i + 1]!;
	}
	try {
		console.log(
			JSON.stringify(
				await requestOrgData({
					tower: options.tower!,
					workspace: options.workspace!,
					appNpub: options["app-npub"]!,
					path: options.path!,
					method: options.method,
					body: options["body-file"]
						? JSON.parse(readFileSync(options["body-file"], "utf8"))
						: undefined,
				}),
				null,
				2,
			),
		);
	} catch (error: any) {
		console.error(error.message);
		if (error.payload) console.error(JSON.stringify(error.payload));
		process.exitCode = 1;
	}
}
