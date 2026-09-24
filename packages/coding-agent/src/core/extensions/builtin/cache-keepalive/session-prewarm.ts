import {
	type Context,
	isOpenAIResponsesPromptCacheModel,
	type Model,
	type Tool,
	type Usage,
	type WarmPromptCacheOptions,
	type WarmPromptCacheResult,
	type WarmPromptCacheUsage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { PROMPT_CACHE_PREWARM_ENTRY_TYPE, type PromptCachePrewarmEntryData } from "./prewarm-entry.ts";

export const PROMPT_CACHE_PREWARM_TIMEOUT_MS = 30_000;

export type WarmPromptCacheFn = (
	model: Model<any>,
	context: Context,
	options?: WarmPromptCacheOptions,
) => Promise<WarmPromptCacheResult>;

export interface SessionPrewarmDependencies {
	readonly warm: WarmPromptCacheFn;
	readonly isPrewarmModel?: ((model: Model<any>) => boolean) | undefined;
}

export interface SessionPrewarm {
	start(ctx: ExtensionContext): void;
	cancel(): void;
}

/**
 * One prompt-cache prewarm per session start for OpenAI GPT-5.6+ models (senpi#2096).
 * The request runs detached from the turn pipeline, so it can never delay or fail
 * the first user turn; its billed usage is recorded as a custom entry that session
 * stats count.
 */
export function createSessionPrewarm(pi: ExtensionAPI, dependencies: SessionPrewarmDependencies): SessionPrewarm {
	const isPrewarmModel = dependencies.isPrewarmModel ?? isOpenAIResponsesPromptCacheModel;
	let current: AbortController | undefined;

	function cancel(): void {
		current?.abort();
		current = undefined;
	}

	async function run(ctx: ExtensionContext, model: Model<any>, controller: AbortController): Promise<void> {
		const { signal } = controller;
		try {
			const preparation = await ctx.prepareProviderRequest?.([]);
			if (signal.aborted) return;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (signal.aborted) return;
			if (!auth.ok) throw new Error(auth.error);
			const authHeaders = auth.headers ?? {};
			const headers = preparation ? await preparation.transformHeaders(authHeaders) : authHeaders;
			if (signal.aborted) return;
			const tools = activeTools(pi);
			const reasoning = ctx.thinkingLevel;
			const serviceTier = ctx.effectiveServiceTier ?? ctx.serviceTier;
			const result = await dependencies.warm(
				model,
				{ systemPrompt: ctx.getSystemPrompt(), messages: [], ...(tools.length > 0 ? { tools } : {}) },
				{
					apiKey: auth.apiKey,
					headers,
					sessionId: ctx.sessionManager.getSessionId(),
					cacheRetention: model.cacheRetention,
					...(reasoning !== undefined && reasoning !== "off" ? { reasoning } : {}),
					...(serviceTier !== undefined ? { serviceTier } : {}),
					onPayload: preparation ? async (payload) => await preparation.transformPayload(payload) : undefined,
					signal,
					timeoutMs: PROMPT_CACHE_PREWARM_TIMEOUT_MS,
				},
			);
			if (signal.aborted || !result.supported) return;
			append({ phase: "warmed", provider: model.provider, model: model.id, usage: toUsage(model, result.usage) });
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			append({ phase: "failed", provider: model.provider, model: model.id, error: message });
		} finally {
			if (current === controller) current = undefined;
		}
	}

	function append(data: PromptCachePrewarmEntryData): void {
		pi.appendEntry(PROMPT_CACHE_PREWARM_ENTRY_TYPE, data);
	}

	return {
		start(ctx) {
			cancel();
			const model = ctx.model;
			if (model === undefined || model.cacheRetention === "none" || !isPrewarmModel(model)) return;
			const controller = new AbortController();
			current = controller;
			void run(ctx, model, controller);
		},
		cancel,
	};
}

function activeTools(pi: ExtensionAPI): Tool[] {
	const activeToolNames = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter((tool) => activeToolNames.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function toUsage(model: Model<any>, usage: WarmPromptCacheUsage): Usage {
	const cost = usage.cost ?? {
		input: (usage.input * model.cost.input) / 1_000_000,
		output: (usage.output * model.cost.output) / 1_000_000,
		cacheRead: (usage.cacheRead * model.cost.cacheRead) / 1_000_000,
		cacheWrite: (usage.cacheWrite * model.cost.cacheWrite) / 1_000_000,
		total: 0,
	};
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
	};
}
