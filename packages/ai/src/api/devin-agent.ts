/**
 * Devin (Cognition/Codeium Cascade) agent API.
 *
 * One `GetChatMessage` server-streaming Connect call per assistant turn. The
 * request is a single gzipped frame; the response is a frame sequence of
 * deltas, closed by a JSON trailer frame. Cascade reports text, thinking and
 * tool calls as separate delta fields on the same message, so this adapter owns
 * the block bookkeeping senpi's event protocol expects.
 */

import type { AssistantMessage, Context, Model, StreamFunction, ToolCall } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { GetChatMessageRequestSchema, GetChatMessageResponseSchema } from "./devin-agent/gen/cascade_pb.ts";
import { applyDevinResponse, type DevinStreamState } from "./devin-agent/stream-state.ts";
import type { DevinAgentOptions } from "./devin-agent/types.ts";
import {
	buildDevinChatRequest,
	DEVIN_CHAT_MESSAGE_PATH,
	DEVIN_DEFAULT_BASE_URL,
	decodeDevinFrames,
	encodeDevinRequestFrame,
	normalizeDevinSessionToken,
} from "./devin-agent/wire.ts";

export const stream: StreamFunction<"devin-agent", DevinAgentOptions> = (
	model: Model<"devin-agent">,
	context: Context,
	options?: DevinAgentOptions,
) => {
	const events = new AssistantMessageEventStream();
	void run(model, context, events, options);
	return events;
};

export const streamSimple: StreamFunction<"devin-agent", DevinAgentOptions> = stream;

async function run(
	model: Model<"devin-agent">,
	context: Context,
	events: AssistantMessageEventStream,
	options: DevinAgentOptions | undefined,
): Promise<void> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "devin-agent",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const state: DevinStreamState = { textIndex: undefined, thinkingIndex: undefined, toolCalls: new Map() };
	const signal = options?.signal;

	try {
		events.push({ type: "start", partial: output });
		const request = buildDevinChatRequest({
			model,
			context,
			apiKey: options?.apiKey,
			cascadeId: options?.cascadeId,
			maxTokens: options?.maxTokens,
			temperature: options?.temperature,
		});
		const baseUrl = model.baseUrl || DEVIN_DEFAULT_BASE_URL;
		const response = await fetch(baseUrl + DEVIN_CHAT_MESSAGE_PATH, {
			method: "POST",
			headers: {
				"content-type": "application/connect+proto",
				"connect-protocol-version": "1",
				"connect-content-encoding": "gzip",
				"connect-accept-encoding": "gzip",
				authorization: `Bearer ${normalizeDevinSessionToken(options?.apiKey)}`,
			},
			body: encodeDevinRequestFrame(GetChatMessageRequestSchema, request),
			signal,
		});
		await options?.onResponse?.({ status: response.status, headers: {} }, model);

		if (!response.ok || !response.body) {
			throw new Error(`Devin request failed (HTTP ${response.status})${await detail(response)}`);
		}

		for await (const frame of decodeDevinFrames(response.body, GetChatMessageResponseSchema)) {
			if (frame.message) applyDevinResponse(frame.message, output, events, state);
		}

		finalizeBlocks(output, events, state);
		output.stopReason = state.toolCalls.size > 0 || output.content.some(isToolCall) ? "toolUse" : output.stopReason;
		events.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		events.end();
	} catch (error) {
		finalizeBlocks(output, events, state);
		const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
		output.stopReason = aborted ? "aborted" : "error";
		output.errorMessage = aborted ? "Request was aborted" : messageOf(error);
		events.push({ type: "error", reason: output.stopReason, error: output });
		events.end();
	}
}

function isToolCall(content: AssistantMessage["content"][number]): content is ToolCall {
	return content.type === "toolCall";
}

function finalizeBlocks(output: AssistantMessage, events: AssistantMessageEventStream, state: DevinStreamState): void {
	if (state.thinkingIndex !== undefined) {
		const block = output.content[state.thinkingIndex];
		if (block?.type === "thinking") {
			events.push({
				type: "thinking_end",
				contentIndex: state.thinkingIndex,
				content: block.thinking,
				partial: output,
			});
		}
		state.thinkingIndex = undefined;
	}
	if (state.textIndex !== undefined) {
		const block = output.content[state.textIndex];
		if (block?.type === "text") {
			events.push({ type: "text_end", contentIndex: state.textIndex, content: block.text, partial: output });
		}
		state.textIndex = undefined;
	}
	for (const [, entry] of state.toolCalls) {
		const block = output.content[entry.contentIndex];
		if (block?.type === "toolCall") {
			events.push({ type: "toolcall_end", contentIndex: entry.contentIndex, toolCall: block, partial: output });
		}
	}
	state.toolCalls.clear();
}

async function detail(response: Response): Promise<string> {
	try {
		const body = await response.text();
		return body ? `: ${body.slice(0, 500)}` : "";
	} catch {
		return "";
	}
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
