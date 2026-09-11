import { createServer, type Server } from "node:http";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { fetchDevinModels } from "../src/api/devin-agent/discovery.ts";
import { GetCliModelConfigsResponseSchema } from "../src/api/devin-agent/gen/cascade_pb.ts";
import { getBuiltinApiProvider } from "../src/api-registry.ts";
import { createModels } from "../src/models.ts";
import { devinProvider } from "../src/providers/devin.ts";
import "../src/compat.ts";

let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	const closing = server;
	server = undefined;
	await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function serve(
	handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<string> {
	server = createServer(handler);
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
	const address = server?.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}`;
}

function unaryFrame(configs: Parameters<typeof create<typeof GetCliModelConfigsResponseSchema>>[1]): Buffer {
	const payload = toBinary(GetCliModelConfigsResponseSchema, create(GetCliModelConfigsResponseSchema, configs));
	const out = Buffer.alloc(5 + payload.byteLength);
	out.writeUInt32BE(payload.byteLength, 1);
	out.set(payload, 5);
	return out;
}

describe.sequential("devin provider", () => {
	it("registers the devin-agent api in the builtin registry", () => {
		expect(getBuiltinApiProvider("devin-agent")).toBeDefined();
	});

	it("ships the SWE seed and binds Devin OAuth", () => {
		const provider = devinProvider();
		expect(provider.id).toBe("devin");
		expect(provider.auth.oauth?.loginLabel).toBe("Sign in with Devin");
		const seeded = provider.getModels();
		const ids = seeded.map((model) => model.id);
		expect(ids).toContain("swe-1-6");
		expect(ids).toContain("swe-2");
		for (const model of seeded) {
			expect(model.api).toBe("devin-agent");
			expect(model.provider).toBe("devin");
		}
	});

	it("resolves a stored Devin OAuth credential as the session token", async () => {
		const models = createModels({ credentials: undefined });
		models.setProvider(devinProvider());
		expect(models.getProvider("devin")?.auth.oauth).toBeDefined();
	});

	it("normalizes the CLI model configs into catalog models", async () => {
		const baseUrl = await serve((req, res) => {
			expect(req.url).toBe("/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.end(
				unaryFrame({
					clientModelConfigs: [
						{ modelUid: "swe-2-high", label: "SWE-2 (high)", maxTokens: 128_000, supportsImages: false },
						{ modelUid: "swe-1-6", label: "SWE-1.6", maxTokens: 64_000, supportsImages: false },
						{ modelUid: "disabled-one", label: "Disabled", disabled: true },
						{ label: "No uid" },
					],
				}),
			);
		});

		const models = await fetchDevinModels({ apiKey: "abc", baseUrl });
		expect(models?.map((model) => model.id)).toEqual(["swe-2-high", "swe-1-6"]);
		expect(models?.[0]).toMatchObject({
			name: "SWE-2 (high)",
			api: "devin-agent",
			provider: "devin",
			maxTokens: 128_000,
		});
	});

	it("keeps the static seed when discovery fails or returns nothing", async () => {
		const errorUrl = await serve((_req, res) => {
			res.writeHead(500);
			res.end("nope");
		});
		expect(await fetchDevinModels({ apiKey: "abc", baseUrl: errorUrl })).toBeUndefined();

		const closing = server;
		server = undefined;
		await new Promise<void>((resolve) => closing?.close(() => resolve()));

		const emptyUrl = await serve((_req, res) => {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.end(unaryFrame({ clientModelConfigs: [] }));
		});
		expect(await fetchDevinModels({ apiKey: "abc", baseUrl: emptyUrl })).toBeUndefined();
	});
});
