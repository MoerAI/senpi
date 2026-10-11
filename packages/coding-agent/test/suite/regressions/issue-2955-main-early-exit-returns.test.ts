// Regression for #2955: an early-exit branch of main() runs nothing after its exit, even when process.exit returns.
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import type * as runtimeModule from "../../../src/core/agent-session-runtime.ts";
import { restoreStdout } from "../../../src/core/output-guard.ts";
import type * as timingsModule from "../../../src/core/timings.ts";
import { main } from "../../../src/main.ts";
import { HOST_EXIT_USAGE } from "../../../src/modes/rpc/host-outcome.ts";

const state = vi.hoisted(() => ({
	exits: [] as Array<string | number | null | undefined>,
	runtimes: [] as Array<{ dispose(): Promise<void> }>,
	mainCheckpoints: new Set([
		"parseArgs",
		"runMigrations",
		"firstTimeSetup",
		"createSessionManager",
		"createRuntime",
		"createAgentSessionRuntime",
		"extensionFlags",
		"helpFlagsCache",
		"readPipedStdin",
		"recordProcessLifetime",
		"prepareInitialMessage",
		"initTheme",
		"resolveModelScope",
		"createAgentSession",
		"interactiveMode.init",
	]),
}));

// Only main() records these checkpoints, so reaching one after an exit means main() kept starting up.
vi.mock("../../../src/core/timings.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof timingsModule>();
	return {
		...actual,
		time(label: string, namespace?: timingsModule.TimingLabel): void {
			if (state.exits.length > 0 && state.mainCheckpoints.has(label)) {
				throw new Error(
					`main() kept starting up after process.exit(${String(state.exits[0])}): reached "${label}"`,
				);
			}
			actual.time(label, namespace);
		},
	};
});

vi.mock("../../../src/core/agent-session-runtime.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof runtimeModule>();
	return {
		...actual,
		async createAgentSessionRuntime(...args: Parameters<typeof actual.createAgentSessionRuntime>) {
			const runtime = await actual.createAgentSessionRuntime(...args);
			state.runtimes.push(runtime);
			return runtime;
		},
	};
});

const fixture = resolve(__dirname, "../../fixtures/before-compaction.jsonl");
let root = "";
let originalCwd = "";
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-2955-")));
	mkdirSync(join(root, "agent"));
	mkdirSync(join(root, "project"));
	vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
	originalCwd = process.cwd();
	originalExitCode = process.exitCode;
	process.chdir(join(root, "project"));
	state.exits.length = 0;
	vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
		state.exits.push(code);
		return undefined as never;
	}) as typeof process.exit);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	restoreStdout();
	for (const runtime of state.runtimes.splice(0)) await runtime.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	rmSync(root, { recursive: true, force: true });
});

describe("main() early-exit branches (#2955)", () => {
	it.each([
		{ branch: "host", args: () => ["host", "no-such-command"], code: HOST_EXIT_USAGE },
		{ branch: "schedule", args: () => ["schedule", "help"], code: 0 },
		{ branch: "--version", args: () => ["--version"], code: 0 },
		{
			branch: "--export",
			args: () => {
				copyFileSync(fixture, join(root, "session.jsonl"));
				return ["--export", join(root, "session.jsonl"), join(root, "session.html")];
			},
			code: 0,
		},
		{ branch: "--export of a missing file", args: () => ["--export", join(root, "missing.jsonl")], code: 1 },
		{ branch: "--help", args: () => ["--help"], code: 0 },
		{ branch: "--list-tips", args: () => ["--list-tips"], code: 0 },
		{ branch: "--list-models", args: () => ["--list-models"], code: 0 },
		{ branch: "--help with --print", args: () => ["--print", "--help"], code: 0 },
	])(
		"$branch exits once and runs nothing after its exit",
		async ({ args, code }) => {
			await expect(main(args())).resolves.toBeUndefined();
			expect(state.exits).toEqual([code]);
		},
		120_000,
	);
});
