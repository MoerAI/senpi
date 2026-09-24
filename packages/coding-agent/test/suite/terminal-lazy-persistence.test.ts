import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: { bash_id?: string; monitor_id?: string };
}

interface ToolLike {
	name: string;
	execute: (id: string, input: Record<string, unknown>) => Promise<ToolResultLike>;
}

interface Generation {
	readonly tools: Map<string, ToolLike>;
	readonly emit: (eventType: string, payload: Record<string, unknown>) => Promise<void>;
}

function createGeneration(cwd: string, sessionId: string, sessionDir: string): Generation {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolLike>();
	let activeTools: string[] = [];
	const pi = {
		registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
		on: (eventType: string, handler: Handler) => {
			handlers.set(eventType, [...(handlers.get(eventType) ?? []), handler]);
		},
		sendMessage: () => {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		mode: "tui",
		model: { id: "test-model", api: "openai-completions" },
		ui: { setStatus: () => {}, notify: () => {}, theme },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`),
			getSessionDir: () => sessionDir,
		},
	} as unknown as ExtensionContext;
	registerTerminalExtension(pi);
	return {
		tools,
		async emit(eventType, payload) {
			for (const handler of handlers.get(eventType) ?? []) await handler(payload, ctx);
		},
	};
}

function manifestOf(
	stateDir: string,
	sessionId: string,
): { monitors: Array<{ description: string; suspended: boolean }> } {
	return JSON.parse(readFileSync(join(stateDir, `${sessionId}.json`), "utf8"));
}

describe("terminal persistence is lazy and survives a reload", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let sessionDir: string;
	let stateDir: string;
	let sessionId: string;
	let counter = 0;
	let live: Generation[] = [];

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-lazy-persist-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		sessionDir = join(tmp, "sessions");
		stateDir = join(sessionDir, "extensions", "terminal");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		sessionId = `lazy-${Date.now().toString(36)}-${++counter}`;
		live = [];
	});

	afterEach(async () => {
		for (const generation of live) {
			await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	async function start(reason: string): Promise<Generation> {
		const generation = createGeneration(cwd, sessionId, sessionDir);
		live.push(generation);
		await generation.emit("session_start", { type: "session_start", reason });
		return generation;
	}

	async function createPersistent(generation: Generation, description: string): Promise<ToolResultLike> {
		const monitor = generation.tools.get("monitor");
		if (!monitor) throw new Error("monitor tool missing");
		return monitor.execute(`create-${description}`, { description, command: "cat", persistent: true });
	}

	it("a session that never registers anything leaves no terminal state files at all", async () => {
		const generation = await start("startup");
		expect(existsSync(stateDir)).toBe(false);
		await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		live = [];
		expect(existsSync(stateDir)).toBe(false);
	});

	it("the first persistent monitor creates the lease and the manifest together", async () => {
		const generation = await start("startup");
		expect(existsSync(stateDir)).toBe(false);
		const result = await createPersistent(generation, "first watch");
		expect(result.isError).not.toBe(true);
		expect(readdirSync(stateDir).sort()).toEqual([`${sessionId}.json`, `${sessionId}.lease`]);
		expect(manifestOf(stateDir, sessionId).monitors.map((entry) => entry.description)).toEqual(["first watch"]);
	});

	it("a reload keeps the pre-reload durable entries when the next transition writes", async () => {
		const first = await start("startup");
		await createPersistent(first, "before reload");
		await first.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		live = [];
		const second = await start("reload");
		await createPersistent(second, "after reload");
		const descriptions = manifestOf(stateDir, sessionId)
			.monitors.map((entry) => entry.description)
			.sort();
		expect(descriptions).toEqual(["after reload", "before reload"]);
	});
});
