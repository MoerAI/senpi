import { mkdirSync } from "node:fs";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import mcpExtension from "../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import type { BuildSystemPromptOptions, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";

const LATER_BLOCK = "<later-extension-block>volatile</later-extension-block>";

const cleanupTasks: Array<() => Promise<void>> = [];
const harnesses: Harness[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalStartupTimeout = process.env[MCP_STARTUP_TIMEOUT_ENV];

beforeEach(() => {
	resetMcpServiceForTests();
	process.env[MCP_STARTUP_TIMEOUT_ENV] = "0";
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	restoreEnv(ENV_AGENT_DIR, originalAgentDir);
	restoreEnv(MCP_STARTUP_TIMEOUT_ENV, originalStartupTimeout);
	await cleanupRoots(cleanupTasks);
});

/** An extension loaded after the MCP builtin that appends its own block, like a memory extension. */
const laterExtension: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${LATER_BLOCK}` }), {
		previewSafe: true,
	});
};

describe("MCP instructions are the last system-prompt block (senpi#4448)", () => {
	it("puts <mcp_instructions> after an addition from an extension that loads later, on a real turn", async () => {
		// Given: an MCP server with instructions, and an extension after the MCP builtin that appends a block.
		const harness = await startHarness();

		// When: a turn goes out after the attach settled.
		let systemPrompt = "";
		harness.setResponses([
			(context) => {
				systemPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("capture prompt");

		// Then: the later extension's block comes first and the MCP instructions close the prompt.
		expect(systemPrompt.indexOf(LATER_BLOCK)).toBeGreaterThan(-1);
		expect(systemPrompt.indexOf(LATER_BLOCK)).toBeLessThan(systemPrompt.indexOf('<mcp_instructions server="fx">'));
		expect(systemPrompt.endsWith("</mcp_instructions>")).toBe(true);
	});

	it("uses the same order in a preview composition (prompt-cache prewarm)", async () => {
		// Given: the same extensions.
		const harness = await startHarness();

		// When: the host composes a preview.
		const result = await harness
			.getExtensionRunner()
			.emitBeforeAgentStart("", undefined, "BASE", { cwd: process.cwd() } as BuildSystemPromptOptions, {
				preview: true,
			});

		// Then: MCP instructions are the tail there too.
		const systemPrompt = result?.systemPrompt ?? "";
		expect(systemPrompt.startsWith(`BASE\n\n${LATER_BLOCK}`)).toBe(true);
		expect(systemPrompt.endsWith("</mcp_instructions>")).toBe(true);
	});
});

async function startHarness(): Promise<Harness> {
	const root = makeRoot("mcp-instructions-last", cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	mkdirSync(root.agentDir, { recursive: true });
	setConfig(root, { fx: stdioServer(["--tools", "1", "--instructions", "server instructions"]) });
	const harness = await createHarness({
		extensionFactories: [mcpExtension as ExtensionFactory, laterExtension],
	});
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	await getMcpService().whenAttachSettled();
	// One settled turn publishes the server's instructions to the service for the turns after it.
	harness.setResponses([fauxAssistantMessage("warm")]);
	await harness.session.prompt("warm");
	return harness;
}

function restoreEnv(name: string, original: string | undefined): void {
	if (original === undefined) delete process.env[name];
	else process.env[name] = original;
}
