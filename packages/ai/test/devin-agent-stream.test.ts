import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { GetChatMessageResponseSchema, StopReason } from "../src/api/devin-agent/gen/cascade_pb.ts";
import { stream as devinStream } from "../src/api/devin-agent.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";

const MODEL = {
	id: "swe-1-6",
	name: "SWE-1.6",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 128_000,
} as unknown as Model<"devin-agent">;

const CONTEXT: Context = { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 0 }] } as Context;

let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	const closing = server;
	server = undefined;
	await new Promise<void>((resolve) => closing.close(() => resolve()));
});

function frame(value: Parameters<typeof create<typeof GetChatMessageResponseSchema>>[1], gzip = false): Buffer {
	const payload = toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, value));
	const body = gzip ? gzipSync(payload) : Buffer.from(payload);
	const out = Buffer.alloc(5 + body.byteLength);
	out[0] = gzip ? 0x01 : 0x00;
	out.writeUInt32BE(body.byteLength, 1);
	out.set(body, 5);
	return out;
}

function trailer(): Buffer {
	const body = Buffer.from('{"metadata":{}}', "utf8");
	const out = Buffer.alloc(5 + body.byteLength);
	out[0] = 0x02;
	out.writeUInt32BE(body.byteLength, 1);
	out.set(body, 5);
	return out;
}

async function serve(
	handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<string> {
	server = createServer(handler);
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
	const address = server?.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}`;
}

async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

describe.sequential("devin-agent stream", () => {
	it("maps streamed Cascade frames onto senpi assistant events", async () => {
		let seen: { path?: string; auth?: string; contentType?: string; encoding?: string } = {};
		const baseUrl = await serve((req, res) => {
			seen = {
				path: req.url,
				auth: req.headers.authorization,
				contentType: req.headers["content-type"],
				encoding: req.headers["connect-content-encoding"] as string,
			};
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.write(frame({ messageId: "m1", deltaThinking: "weighing" }));
			res.write(frame({ messageId: "m1", deltaText: "Hel" }));
			res.write(frame({ messageId: "m1", deltaText: "lo" }, true));
			res.write(
				frame({
					messageId: "m1",
					deltaToolCalls: [{ id: "call-1", name: "read", argumentsJson: '{"path":"a.ts"}' }],
					stopReason: StopReason.FUNCTION_CALL,
					usage: { inputTokens: 11n, outputTokens: 7n, cacheReadTokens: 3n, cacheWriteTokens: 2n },
				}),
			);
			res.write(trailer());
			res.end();
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);

		expect(events[0]?.type).toBe("start");
		expect(events.filter((e) => e.type === "thinking_delta").map((e) => (e as { delta: string }).delta)).toEqual([
			"weighing",
		]);
		expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta)).toEqual([
			"Hel",
			"lo",
		]);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.reason).toBe("toolUse");
		expect(done.message.content.find((c) => c.type === "toolCall")).toMatchObject({
			id: "call-1",
			name: "read",
			arguments: { path: "a.ts" },
		});
		expect(done.message.content.find((c) => c.type === "thinking")).toMatchObject({ thinking: "weighing" });
		expect(done.message.usage).toMatchObject({ input: 11, output: 7, cacheRead: 3, cacheWrite: 2 });
		expect(done.message.responseId).toBe("m1");

		expect(seen.path).toBe("/exa.api_server_pb.ApiServerService/GetChatMessage");
		expect(seen.auth).toBe("Bearer devin-session-token$session-abc");
		expect(seen.contentType).toBe("application/connect+proto");
		expect(seen.encoding).toBe("gzip");
	});

	it("maps Cascade stop reasons that carry no tool call", async () => {
		const baseUrl = await serve((_req, res) => {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.write(frame({ messageId: "m2", deltaText: "cut" }));
			res.write(frame({ messageId: "m2", stopReason: StopReason.MAX_TOKENS }));
			res.write(trailer());
			res.end();
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.reason).toBe("length");
	});

	it("keeps toolUse from the Cascade stop reason even when no tool call block arrived", async () => {
		const baseUrl = await serve((_req, res) => {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.write(frame({ messageId: "m3", deltaText: "calling" }));
			res.write(frame({ messageId: "m3", stopReason: StopReason.FUNCTION_CALL }));
			res.write(trailer());
			res.end();
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.reason).toBe("toolUse");
	});

	it("keeps a truncated turn as length even when a tool call block arrived", async () => {
		const baseUrl = await serve((_req, res) => {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.write(
				frame({
					messageId: "m4",
					deltaToolCalls: [{ id: "tc-9", name: "read", argumentsJson: '{"path":"a.ts"' }],
					stopReason: StopReason.MAX_TOKENS,
				}),
			);
			res.write(trailer());
			res.end();
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.reason).toBe("length");
	});

	it("reports an HTTP failure as a typed error message instead of throwing", async () => {
		const baseUrl = await serve((_req, res) => {
			res.writeHead(403, { "content-type": "application/json" });
			res.end('{"code":"permission_denied","message":"seat required"}');
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const last = events.at(-1);

		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("expected error");
		expect(last.reason).toBe("error");
		expect(last.error.errorMessage).toMatch(/403|seat required/);
	});

	it("ends as aborted when the caller aborts mid-stream", async () => {
		const controller = new AbortController();
		const baseUrl = await serve((_req, res) => {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.write(frame({ messageId: "m1", deltaText: "partial" }));
			setTimeout(() => controller.abort(), 10);
		});

		const events = await collect(
			devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc", signal: controller.signal } as never),
		);
		const last = events.at(-1);

		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("expected error");
		expect(last.reason).toBe("aborted");
	});
});
