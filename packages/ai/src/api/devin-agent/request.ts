/**
 * Builds the Cascade `GetChatMessage` request from senpi's provider-neutral
 * context.
 *
 * Cascade has no system role: the system prompt travels in the top-level
 * `prompt` field, and history is a flat list of `ChatMessagePrompt` entries
 * whose `source` carries the role. Message ids are derived deterministically
 * from the conversation id and the entry index so a retried turn re-sends the
 * same ids instead of forking the server-side transcript.
 */

import { create } from "@bufbuild/protobuf";
import type { Context, Message, Model, Tool } from "../../types.ts";
import {
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatMessageRequestType,
	ChatMessageSource,
	ChatToolCallSchema,
	ChatToolDefinitionSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	type GetChatMessageRequest,
	GetChatMessageRequestSchema,
	PromptCacheOptionsSchema,
} from "./gen/cascade_pb.ts";
import { devinCliMetadata } from "./metadata.ts";

/** Cascade's own stop vocabulary; the server echoes these as STOP_PATTERN. */
export const DEVIN_DEFAULT_STOP_PATTERNS = [
	"<|user|>",
	"<|bot|>",
	"<|context_request|>",
	"<|endoftext|>",
	"<|end_of_turn|>",
] as const;

export interface DevinChatRequestInput {
	model: Model<"devin-agent">;
	context: Context;
	apiKey: string | undefined;
	cascadeId?: string;
	maxTokens?: number;
	temperature?: number;
}

export function buildDevinChatRequest(input: DevinChatRequestInput): GetChatMessageRequest {
	const cascadeId = input.cascadeId ?? "";
	return create(GetChatMessageRequestSchema, {
		metadata: devinCliMetadata(input.apiKey),
		prompt: input.context.systemPrompt ?? "",
		chatMessagePrompts: mapHistory(input.context.messages, cascadeId),
		requestType: ChatMessageRequestType.CASCADE,
		plannerMode: ConversationalPlannerMode.DEFAULT,
		chatModelUid: input.model.id,
		chatModelName: input.model.name ?? input.model.id,
		cascadeId,
		tools: (input.context.tools ?? []).map(toolDefinition),
		toolChoice: { choice: { case: "optionName", value: "auto" } },
		systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
		configuration: create(CompletionConfigurationSchema, {
			maxTokens: BigInt(input.maxTokens ?? input.model.maxTokens ?? 0),
			temperature: input.temperature ?? 0,
			stopPatterns: [...DEVIN_DEFAULT_STOP_PATTERNS],
		}),
	});
}

function toolDefinition(tool: Tool) {
	return create(ChatToolDefinitionSchema, {
		name: tool.name,
		description: tool.description,
		jsonSchemaString: JSON.stringify(tool.parameters ?? {}),
	});
}

function mapHistory(messages: readonly Message[], cascadeId: string): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];
	for (const [index, message] of messages.entries()) {
		const id = `${cascadeId}\u0000${index}\u0000${message.role}`;
		if (message.role === "user") prompts.push(userPrompt(message.content, id));
		else if (message.role === "assistant") prompts.push(assistantPrompt(message, id));
		else if (message.role === "toolResult") prompts.push(toolResultPrompt(message, id));
	}
	return prompts;
}

function userPrompt(content: Extract<Message, { role: "user" }>["content"], messageId: string): ChatMessagePrompt {
	const text = typeof content === "string" ? content : joinText(content);
	return create(ChatMessagePromptSchema, {
		messageId,
		source: ChatMessageSource.USER,
		prompt: text,
	});
}

function assistantPrompt(message: Extract<Message, { role: "assistant" }>, messageId: string): ChatMessagePrompt {
	const text: string[] = [];
	let thinking = "";
	let signature = "";
	const toolCalls = [];
	for (const block of message.content) {
		if (block.type === "text") text.push(block.text);
		else if (block.type === "thinking") {
			thinking += block.thinking;
			if (block.thinkingSignature) signature = block.thinkingSignature;
		} else if (block.type === "toolCall") {
			toolCalls.push(
				create(ChatToolCallSchema, {
					id: block.id,
					name: block.name,
					argumentsJson: JSON.stringify(block.arguments ?? {}),
				}),
			);
		}
	}
	return create(ChatMessagePromptSchema, {
		messageId,
		source: ChatMessageSource.SYSTEM,
		prompt: text.join("\n"),
		thinking,
		signature,
		toolCalls,
	});
}

function toolResultPrompt(message: Extract<Message, { role: "toolResult" }>, messageId: string): ChatMessagePrompt {
	return create(ChatMessagePromptSchema, {
		messageId,
		source: ChatMessageSource.TOOL,
		prompt: joinText(message.content),
		toolCallId: message.toolCallId,
		toolResultIsError: message.isError === true,
	});
}

function joinText(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}
