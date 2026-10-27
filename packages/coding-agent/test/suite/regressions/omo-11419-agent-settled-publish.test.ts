// oh-my-openagent#11419 regression: a turn ended, its reply was on screen, but clients kept showing it as running.
// The engine published agent_settled to session subscribers (RPC clients, the TUI) only after every extension
// agent_settled handler returned, so one slow or hung handler held the settle edge for up to the 20 min hard cap.
// agent_settled is notification-only: the settle must publish at once, and a stalled handler must stay visible
// in diagnostics instead of being hidden behind a stuck "Starting session..." indicator.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionHandlerStall } from "../../../src/core/extensions/handler-budget.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import type { Settings } from "../../../src/core/settings-manager.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

function withinRealTime<T>(work: Promise<T>, what: string, ms = 10_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setRealTimeout(() => reject(new Error(`still waiting for ${what} after ${ms} ms`)), ms);
		work.then(
			(value) => {
				clearRealTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearRealTimeout(timer);
				reject(error);
			},
		);
	});
}

function stallStage(harness: Harness, stage: ExtensionHandlerStall["stage"]): Promise<ExtensionHandlerStall> {
	const runner = harness.getExtensionRunner();
	const forward = Reflect.get(runner, "handlerStallListener") as ((stall: ExtensionHandlerStall) => void) | undefined;
	return new Promise((resolve) => {
		Reflect.set(runner, "handlerStallListener", (stall: ExtensionHandlerStall) => {
			forward?.(stall);
			if (stall.stage === stage) resolve(stall);
		});
	});
}

function sessionLogEvents(harness: Harness): Array<Record<string, unknown>> {
	const path = join(harness.tempDir, "agent", "logs", "session.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("oh-my-openagent#11419 agent_settled publishes without waiting on extension handlers", () => {
	let harness: Harness | undefined;
	let release: (() => void) | undefined;

	afterEach(() => {
		release?.();
		release = undefined;
		harness?.cleanup();
		harness = undefined;
	});

	async function startWithHeldSettledHandler(settings: Partial<Settings>) {
		const handlerEntered = Promise.withResolvers<void>();
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let holding = false;
		const created = await createHarness({
			settings,
			extensionFactories: [
				(pi: ExtensionAPI) => {
					// Holds the first settle only, the way one slow memory pass holds one turn end.
					pi.on("agent_settled", async () => {
						if (holding) return;
						holding = true;
						handlerEntered.resolve();
						await held;
					});
				},
			],
		});
		harness = created;
		const settled = Promise.withResolvers<void>();
		created.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.resolve();
		});
		return { created, settled: settled.promise, handlerEntered: handlerEntered.promise };
	}

	it("publishes agent_settled to subscribers while an agent_settled handler never returns", async () => {
		// given an extension whose agent_settled handler never returns and no host cap that would stop waiting on it
		const { created, settled, handlerEntered } = await startWithHeldSettledHandler({
			extensionEventHandlerWarnMs: 0,
			extensionEventHandlerTimeoutMs: 0,
		});
		created.setResponses([fauxAssistantMessage([fauxText("the reply")])]);

		// when a turn ends
		void created.session.prompt("go");
		await withinRealTime(handlerEntered, "the agent_settled handler to start");

		// then subscribers hear the settle while the handler is still running, and the reply is persisted
		await withinRealTime(settled, "agent_settled to reach subscribers");
		expect(getAssistantTexts(created)).toEqual(["the reply"]);
		expect(created.session.isStreaming).toBe(false);
	}, 30_000);

	it("still reports the stalled handler in session.log after the settle published", async () => {
		// given an agent_settled handler that outlives the warning budget
		const { created, settled } = await startWithHeldSettledHandler({
			extensionEventHandlerWarnMs: 50,
			extensionEventHandlerTimeoutMs: 0,
		});
		const warned = stallStage(created, "warn");
		created.setResponses([fauxAssistantMessage([fauxText("the reply")])]);

		// when a turn ends and the handler keeps running past the warning
		void created.session.prompt("go");
		await withinRealTime(settled, "agent_settled to reach subscribers");
		await withinRealTime(warned, "the stall warning");

		// then session.log names the held handler's event, so the slow extension stays diagnosable
		expect(sessionLogEvents(created)).toContainEqual(
			expect.objectContaining({ event: "extension_handler_stalled", handlerEvent: "agent_settled", stage: "warn" }),
		);
	}, 30_000);

	it("runs the next prompt to its reply while the previous agent_settled handler is still held", async () => {
		// given a settled turn whose agent_settled handler never returns
		const { created, settled } = await startWithHeldSettledHandler({
			extensionEventHandlerWarnMs: 0,
			extensionEventHandlerTimeoutMs: 0,
		});
		created.setResponses([fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("second")])]);
		void created.session.prompt("one");
		await withinRealTime(settled, "the first settle");

		// when the person sends the next message
		await withinRealTime(created.session.prompt("two"), "the next prompt to finish");

		// then the next turn ran, its reply was persisted, and session.log says the held handler was released
		expect(getAssistantTexts(created)).toEqual(["first", "second"]);
		expect(sessionLogEvents(created)).toContainEqual(
			expect.objectContaining({
				event: "extension_handler_stalled",
				handlerEvent: "agent_settled",
				stage: "released",
			}),
		);
	}, 30_000);
});
