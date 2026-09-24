import {
	type Context,
	fauxAssistantMessage,
	type WarmPromptCacheOptions,
	type WarmPromptCacheResult,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCacheKeepAliveExtension } from "../../../src/core/extensions/builtin/cache-keepalive/index.ts";
import { PROMPT_CACHE_PREWARM_ENTRY_TYPE } from "../../../src/core/extensions/builtin/cache-keepalive/prewarm-entry.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, getAssistantTexts, type Harness, type HarnessOptions } from "../harness.ts";

const SIGNAL_TIMEOUT_MS = 2_000;
const harnesses: Harness[] = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), SIGNAL_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

interface WarmCall {
	readonly context: Context;
	readonly options: WarmPromptCacheOptions | undefined;
}

type StreamFunction = Harness["agent"]["streamFunction"];

interface TurnRequest {
	readonly context: Parameters<StreamFunction>[1];
	readonly options: Parameters<StreamFunction>[2];
}

function toolShapes(tools: Context["tools"]) {
	return tools?.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

async function createPrewarmHarness(
	warm: (call: WarmCall) => Promise<WarmPromptCacheResult>,
	options: { extensionFactories?: ExtensionFactory[]; models?: HarnessOptions["models"] } = {},
) {
	const warmCalled = deferred<WarmCall>();
	const harness = await createHarness({
		...(options.models ? { models: options.models } : {}),
		extensionFactories: [
			createCacheKeepAliveExtension({
				warmPromptCache: async (_model, context, options) => {
					const call = { context, options };
					warmCalled.resolve(call);
					return warm(call);
				},
				isPromptCachePrewarmModel: () => true,
			}),
			...(options.extensionFactories ?? []),
		],
	});
	harnesses.push(harness);
	// createAgentSession gives the agent the session id; the bare harness Agent has none.
	harness.agent.sessionId = harness.sessionManager.getSessionId();
	const entryAppended = deferred<{ customType: string; data: unknown }>();
	const appendCustomEntry = harness.sessionManager.appendCustomEntry.bind(harness.sessionManager);
	vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementation((customType, data) => {
		const id = appendCustomEntry(customType, data);
		if (customType === PROMPT_CACHE_PREWARM_ENTRY_TYPE) entryAppended.resolve({ customType, data });
		return id;
	});
	return { harness, warmCalled: warmCalled.promise, entryAppended: entryAppended.promise };
}

// senpi#2096: the session-start prompt-cache prewarm is fire-and-forget.
describe("session-start OpenAI prompt-cache prewarm (#2096)", () => {
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	it("runs the first turn while the prewarm is still in flight and records its cost afterwards", async () => {
		const pendingWarm = deferred<WarmPromptCacheResult>();
		const { harness, warmCalled, entryAppended } = await createPrewarmHarness(() => pendingWarm.promise);
		harness.setResponses([fauxAssistantMessage("first answer")]);

		await harness.session.bindExtensions({});
		const call = await within(warmCalled, "the prewarm request");
		expect(call.context.messages).toEqual([]);
		expect(call.context.systemPrompt).toBe(harness.session.systemPrompt);
		expect(call.options?.sessionId).toBe(harness.sessionManager.getSessionId());
		expect(call.options?.signal).toBeInstanceOf(AbortSignal);

		await within(harness.session.prompt("hello"), "the first turn");
		expect(getAssistantTexts(harness)).toEqual(["first answer"]);
		const statsBeforeWarm = harness.session.getSessionStats();

		pendingWarm.resolve({
			supported: true,
			usage: {
				input: 1,
				output: 0,
				cacheRead: 0,
				cacheWrite: 5169,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.25, total: 0.25 },
			},
			usageRaw: {},
		});
		const entry = await within(entryAppended, "the prewarm entry");
		expect(entry.data).toMatchObject({ phase: "warmed", usage: { cacheWrite: 5169, cost: { total: 0.25 } } });
		const stats = harness.session.getSessionStats();
		expect(stats.tokens.cacheWrite - statsBeforeWarm.tokens.cacheWrite).toBe(5169);
		expect(stats.cost - statsBeforeWarm.cost).toBeCloseTo(0.25, 12);
	});

	it("prewarms the system prompt, tools, and reasoning the first turn sends", async () => {
		const lateSessionStart = deferred<void>();
		const previews: boolean[] = [];
		const composer: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "lookup",
				label: "Lookup",
				description: "Look something up",
				parameters: Type.Object({ query: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
			// Finishes after cache-keepalive's session_start has already started the prewarm.
			pi.on("session_start", async () => {
				await lateSessionStart.promise;
				pi.setActiveTools(["lookup"]);
			});
			pi.on("before_agent_start", (event) => {
				previews.push(event.preview === true);
				return { systemPrompt: `${event.systemPrompt}\n\nComposed per turn by before_agent_start.` };
			});
		};
		const { harness, warmCalled } = await createPrewarmHarness(async () => ({ supported: false }), {
			extensionFactories: [composer],
			models: [{ id: "faux-reasoner", reasoning: true }],
		});
		harness.session.setThinkingLevel("high");
		const turnRequests: TurnRequest[] = [];
		const stream = harness.agent.streamFunction;
		harness.agent.streamFunction = (model, context, options) => {
			turnRequests.push({ context, options });
			return stream(model, context, options);
		};
		harness.setResponses([fauxAssistantMessage("first answer")]);

		const binding = harness.session.bindExtensions({});
		lateSessionStart.resolve();
		await within(binding, "extension binding");
		const warm = await within(warmCalled, "the prewarm request");
		await within(harness.session.prompt("hello"), "the first turn");

		const [turn] = turnRequests;
		expect(warm.context.messages).toEqual([]);
		expect(warm.context.systemPrompt).toContain("Composed per turn by before_agent_start.");
		expect(warm.context.systemPrompt).toBe(turn?.context.systemPrompt);
		expect(warm.context.tools?.map((tool) => tool.name)).toEqual(["lookup"]);
		expect(toolShapes(warm.context.tools)).toEqual(toolShapes(turn?.context.tools));
		expect(warm.options?.reasoning).toBe("high");
		expect(warm.options?.reasoning).toBe(turn?.options?.reasoning);
		expect(warm.options?.sessionId).toBe(turn?.options?.sessionId);
		expect(previews).toEqual([true, false]);
	});

	it("keeps the first turn working when the prewarm request fails", async () => {
		const { harness, warmCalled, entryAppended } = await createPrewarmHarness(async () => {
			throw new Error("prewarm rejected");
		});
		harness.setResponses([fauxAssistantMessage("still answered")]);

		await harness.session.bindExtensions({});
		await within(warmCalled, "the prewarm request");
		const entry = await within(entryAppended, "the failed prewarm entry");
		expect(entry.data).toMatchObject({ phase: "failed", error: "prewarm rejected" });

		await within(harness.session.prompt("hello"), "the first turn");
		expect(getAssistantTexts(harness)).toEqual(["still answered"]);
		expect(harness.session.getSessionStats().tokens.cacheWrite).toBe(0);
	});
});
