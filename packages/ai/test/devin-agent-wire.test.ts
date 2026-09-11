import { create, type DescMessage, fromBinary, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { GetChatMessageRequestSchema, GetChatMessageResponseSchema } from "../src/api/devin-agent/gen/cascade_pb.ts";
import {
	buildDevinChatRequest,
	DEVIN_CHAT_MESSAGE_PATH,
	decodeDevinFrames,
	devinCliMetadata,
	encodeDevinRequestFrame,
	normalizeDevinSessionToken,
} from "../src/api/devin-agent/wire.ts";
import type { Context, Model } from "../src/types.ts";

const MODEL: Model<"devin-agent"> = {
	id: "swe-1-6",
	name: "SWE-1.6",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 128_000,
} as unknown as Model<"devin-agent">;

function context(): Context {
	return {
		systemPrompt: "You are senpi.\n\nBe precise.",
		messages: [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "considering", thinkingSignature: "sig-1" },
					{ type: "text", text: "hi" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
			},
		],
		tools: [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		],
	} as unknown as Context;
}

describe("devin-agent wire", () => {
	it("pins the Cascade RPC path the released CLI calls", () => {
		expect(DEVIN_CHAT_MESSAGE_PATH).toBe("/exa.api_server_pb.ApiServerService/GetChatMessage");
	});

	it("prefixes the session token exactly once", () => {
		expect(normalizeDevinSessionToken("abc")).toBe("devin-session-token$abc");
		expect(normalizeDevinSessionToken("devin-session-token$abc")).toBe("devin-session-token$abc");
		expect(normalizeDevinSessionToken(undefined)).toBe("");
	});

	it("carries the CLI identity and the prefixed token in Metadata", () => {
		const metadata = devinCliMetadata("abc");
		expect(metadata.apiKey).toBe("devin-session-token$abc");
		expect(metadata.extensionName).toBe("chisel");
		expect(metadata.ideName.length).toBeGreaterThan(0);
	});

	it("flattens the system prompt and orders history with Cascade roles", () => {
		const request = buildDevinChatRequest({ model: MODEL, context: context(), apiKey: "abc", cascadeId: "conv-1" });
		const decoded = fromBinary(GetChatMessageRequestSchema, toBinary(GetChatMessageRequestSchema, request));

		expect(decoded.prompt).toBe("You are senpi.\n\nBe precise.");
		expect(decoded.chatModelUid).toBe("swe-1-6");
		expect(decoded.cascadeId).toBe("conv-1");
		expect(decoded.metadata?.apiKey).toBe("devin-session-token$abc");
		expect(decoded.chatMessagePrompts.map((p) => p.source)).toEqual([1, 2, 4]);
		expect(decoded.chatMessagePrompts[0]?.prompt).toBe("hello");
		expect(decoded.chatMessagePrompts[1]?.thinking).toBe("considering");
		expect(decoded.chatMessagePrompts[1]?.signature).toBe("sig-1");
		expect(decoded.chatMessagePrompts[1]?.toolCalls[0]).toMatchObject({
			id: "call-1",
			name: "read",
			argumentsJson: JSON.stringify({ path: "a.ts" }),
		});
		expect(decoded.chatMessagePrompts[2]).toMatchObject({
			toolCallId: "call-1",
			prompt: "file body",
			toolResultIsError: false,
		});
		expect(decoded.tools[0]).toMatchObject({ name: "read", description: "Read a file" });
		expect(JSON.parse(decoded.tools[0]?.jsonSchemaString ?? "{}")).toMatchObject({ type: "object" });
		expect(decoded.systemPromptCacheOptions?.type).toBe(1);
	});

	it("frames a request as one gzipped Connect frame", async () => {
		const request = buildDevinChatRequest({ model: MODEL, context: context(), apiKey: "abc" });
		const frame = encodeDevinRequestFrame(GetChatMessageRequestSchema, request);

		expect(frame[0]).toBe(0x01);
		const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
		expect(length).toBe(frame.byteLength - 5);

		const decoded = await collect(decodeDevinFrames(oneShot(frame), GetChatMessageRequestSchema));
		expect(decoded[0]?.message?.prompt).toBe("You are senpi.\n\nBe precise.");
	});

	it("decodes a streamed response and surfaces the end-of-stream trailer", async () => {
		const first = frameOf(GetChatMessageResponseSchema, { messageId: "m1", deltaText: "he" });
		const second = frameOf(GetChatMessageResponseSchema, { messageId: "m1", deltaText: "llo", stopReason: 10 });
		const trailer = trailerFrame('{"metadata":{}}');

		const decoded = await collect(
			decodeDevinFrames(oneShot(concat(first, second, trailer)), GetChatMessageResponseSchema),
		);
		expect(decoded.map((entry) => entry.message?.deltaText)).toEqual(["he", "llo", undefined]);
		expect(decoded.at(-1)?.trailer).toBe('{"metadata":{}}');
	});

	it("rejects a frame whose length prefix exceeds the payload cap", async () => {
		const bogus = new Uint8Array(5);
		new DataView(bogus.buffer).setUint32(1, 0xffffffff, false);
		await expect(collect(decodeDevinFrames(oneShot(bogus), GetChatMessageResponseSchema))).rejects.toThrow(
			/cap|exceeds/i,
		);
	});
});

function oneShot(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function frameOf<TSchema extends DescMessage>(schema: TSchema, value: MessageInitShape<TSchema>): Uint8Array {
	const payload = toBinary(schema, create(schema, value));
	const frame = new Uint8Array(5 + payload.byteLength);
	new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
	frame.set(payload, 5);
	return frame;
}

function trailerFrame(json: string): Uint8Array {
	const payload = new TextEncoder().encode(json);
	const frame = new Uint8Array(5 + payload.byteLength);
	frame[0] = 0x02;
	new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
	frame.set(payload, 5);
	return frame;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}
