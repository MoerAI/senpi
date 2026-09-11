/**
 * Cascade delta bookkeeping.
 *
 * One Cascade response frame can carry a thinking delta, a text delta and a
 * finished tool call at once, and blocks are implicit: the server never opens
 * or closes them. This module owns the open-block state so the adapter emits
 * senpi's start/delta/end triples in the right order.
 */

import type { AssistantMessage, ToolCall } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { type GetChatMessageResponse, StopReason } from "./gen/cascade_pb.ts";

export interface DevinStreamState {
	textIndex: number | undefined;
	thinkingIndex: number | undefined;
	toolCalls: Map<string, { contentIndex: number }>;
}

export function applyDevinResponse(
	message: GetChatMessageResponse,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	state: DevinStreamState,
): void {
	if (message.messageId && !output.responseId) output.responseId = message.messageId;
	if (message.actualModelUid) output.responseModel = message.actualModelUid;

	if (message.deltaThinking) appendThinking(message, output, events, state);
	if (message.deltaText) appendText(message.deltaText, output, events, state);
	for (const call of message.deltaToolCalls) appendToolCall(call, output, events, state);
	if (message.usage) applyUsage(message, output);
	if (message.stopReason !== StopReason.UNSPECIFIED) output.stopReason = mapStopReason(message.stopReason);
}

function appendThinking(
	message: GetChatMessageResponse,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	state: DevinStreamState,
): void {
	// A thinking block interleaved after text starts a new block, matching the
	// order Cascade streamed it in.
	if (state.textIndex !== undefined) closeText(output, events, state);
	if (state.thinkingIndex === undefined) {
		output.content.push({ type: "thinking", thinking: "", ...(message.thinkingRedacted ? { redacted: true } : {}) });
		state.thinkingIndex = output.content.length - 1;
		events.push({ type: "thinking_start", contentIndex: state.thinkingIndex, partial: output });
	}
	const block = output.content[state.thinkingIndex];
	if (block?.type !== "thinking") return;
	block.thinking += message.deltaThinking;
	if (message.deltaSignature) block.thinkingSignature = message.deltaSignature;
	events.push({
		type: "thinking_delta",
		contentIndex: state.thinkingIndex,
		delta: message.deltaThinking,
		partial: output,
	});
}

function appendText(
	delta: string,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	state: DevinStreamState,
): void {
	if (state.thinkingIndex !== undefined) closeThinking(output, events, state);
	if (state.textIndex === undefined) {
		output.content.push({ type: "text", text: "" });
		state.textIndex = output.content.length - 1;
		events.push({ type: "text_start", contentIndex: state.textIndex, partial: output });
	}
	const block = output.content[state.textIndex];
	if (block?.type !== "text") return;
	block.text += delta;
	events.push({ type: "text_delta", contentIndex: state.textIndex, delta, partial: output });
}

function appendToolCall(
	call: { id: string; name: string; argumentsJson: string },
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	state: DevinStreamState,
): void {
	if (state.textIndex !== undefined) closeText(output, events, state);
	if (state.thinkingIndex !== undefined) closeThinking(output, events, state);
	const existing = state.toolCalls.get(call.id);
	if (existing !== undefined) {
		const open = output.content[existing.contentIndex];
		if (open?.type === "toolCall" && call.argumentsJson) {
			open.arguments = parseArguments(call.argumentsJson, open.arguments);
			events.push({
				type: "toolcall_delta",
				contentIndex: existing.contentIndex,
				delta: call.argumentsJson,
				partial: output,
			});
		}
		return;
	}
	const block: ToolCall = {
		type: "toolCall",
		id: call.id,
		name: call.name,
		arguments: parseArguments(call.argumentsJson, {}),
	};
	output.content.push(block);
	const contentIndex = output.content.length - 1;
	state.toolCalls.set(call.id, { contentIndex });
	events.push({ type: "toolcall_start", contentIndex, partial: output });
	if (call.argumentsJson) {
		events.push({ type: "toolcall_delta", contentIndex, delta: call.argumentsJson, partial: output });
	}
}

function closeText(output: AssistantMessage, events: AssistantMessageEventStream, state: DevinStreamState): void {
	const index = state.textIndex;
	if (index === undefined) return;
	const block = output.content[index];
	state.textIndex = undefined;
	if (block?.type === "text")
		events.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
}

function closeThinking(output: AssistantMessage, events: AssistantMessageEventStream, state: DevinStreamState): void {
	const index = state.thinkingIndex;
	if (index === undefined) return;
	const block = output.content[index];
	state.thinkingIndex = undefined;
	if (block?.type === "thinking")
		events.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
}

function applyUsage(message: GetChatMessageResponse, output: AssistantMessage): void {
	const usage = message.usage;
	if (!usage) return;
	output.usage.input = Number(usage.inputTokens);
	output.usage.output = Number(usage.outputTokens);
	output.usage.cacheRead = Number(usage.cacheReadTokens);
	output.usage.cacheWrite = Number(usage.cacheWriteTokens);
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

/** Cascade's stop vocabulary reduced to senpi's. */
function mapStopReason(reason: StopReason): AssistantMessage["stopReason"] {
	switch (reason) {
		case StopReason.FUNCTION_CALL:
			return "toolUse";
		case StopReason.MAX_TOKENS:
		case StopReason.MAX_NEWLINES:
			return "length";
		case StopReason.ERROR:
		case StopReason.CONTENT_FILTER:
			return "error";
		default:
			return "stop";
	}
}

function parseArguments(json: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!json) return fallback;
	try {
		const parsed = JSON.parse(json) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: fallback;
	} catch {
		return fallback;
	}
}
