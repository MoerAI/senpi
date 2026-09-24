import type { Agent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelsSimpleStreamOptions, ProviderHeaders } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../cli/args.ts";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type { BuildSystemPromptOptions, PromptCachePrefixRequest, ServiceTier } from "./extensions/types.ts";
import type { ModelRuntime } from "./model-runtime.ts";

export interface PromptCachePrefixSources {
	readonly agent: Agent;
	readonly runner: ExtensionRunner;
	readonly modelRuntime: ModelRuntime;
	getServiceTier(): ServiceTier | undefined;
	getBaseSystemPrompt(): string;
	getBaseSystemPromptOptions(): BuildSystemPromptOptions;
}

// A handler may await work that rebuilds the base prompt (an MCP attach registering tools);
// one more pass composes from the rebuilt base, the one the first turn will start from.
const MAX_COMPOSITION_PASSES = 2;

/**
 * Build the provider request prefix of the next user turn (senpi#2096). Each input comes
 * from the source the turn itself reads, so the prewarmed prefix is the turn's prefix:
 * - system prompt: the base prompt through a `before_agent_start` preview pass, which is
 *   what `AgentSession.prompt()` installs as `agent.state.systemPrompt`;
 * - tools: `agent.state.tools`, the list and order the agent loop sends;
 * - reasoning, thinking selection/budgets, session id, and `onPayload`: the fields
 *   `Agent.createLoopConfig()` passes to the stream function;
 * - service tier: the session's effective tier, which the SDK stream function applies to
 *   the active model;
 * - auth, headers, `extraBody`, env, and the upstream model id: `ModelRuntime` resolves
 *   them exactly as it does before `streamSimple`.
 */
export async function buildPromptCachePrefixRequest(
	sources: PromptCachePrefixSources,
): Promise<PromptCachePrefixRequest | undefined> {
	const systemPrompt = await composeTurnSystemPrompt(sources);
	const { agent, runner } = sources;
	const state = agent.state;
	const model = state.model;
	if (model === undefined) return undefined;
	const options: ModelsSimpleStreamOptions = {};
	const reasoning = loopReasoning(state.reasoningBaseline, state.thinkingLevel);
	if (reasoning !== undefined) options.reasoning = reasoning;
	if (state.thinkingSelection !== undefined) options.thinkingSelection = state.thinkingSelection;
	if (agent.thinkingBudgets !== undefined) options.thinkingBudgets = agent.thinkingBudgets;
	if (agent.sessionId !== undefined) options.sessionId = agent.sessionId;
	const serviceTier = sources.getServiceTier();
	if (serviceTier !== undefined) options.serviceTier = serviceTier;
	if (agent.onPayload !== undefined) options.onPayload = agent.onPayload;
	if (runner.hasHandlers("before_provider_headers")) {
		options.transformHeaders = async (headers: ProviderHeaders) => await runner.emitBeforeProviderHeaders(headers);
	}
	const prepared = await sources.modelRuntime.prepareSimpleRequest(model, options);
	return {
		model: prepared.model,
		context: { systemPrompt, messages: [], tools: state.tools.slice() },
		options: prepared.options,
	};
}

async function composeTurnSystemPrompt(sources: PromptCachePrefixSources): Promise<string> {
	let systemPrompt = sources.getBaseSystemPrompt();
	for (let pass = 0; pass < MAX_COMPOSITION_PASSES; pass += 1) {
		const base = sources.getBaseSystemPrompt();
		const result = await sources.runner.emitBeforeAgentStart(
			"",
			undefined,
			base,
			sources.getBaseSystemPromptOptions(),
			{ preview: true },
		);
		systemPrompt = result?.systemPrompt ?? base;
		if (sources.getBaseSystemPrompt() === base) break;
	}
	return systemPrompt;
}

// Mirrors Agent.createLoopConfig(): the configuration-update baseline wins over the level.
function loopReasoning(baseline: string | undefined, thinkingLevel: ThinkingLevel): ThinkingLevel | undefined {
	const level = baseline !== undefined && isValidThinkingLevel(baseline) ? baseline : thinkingLevel;
	return level === "off" ? undefined : level;
}
