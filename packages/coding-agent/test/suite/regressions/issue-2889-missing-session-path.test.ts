// Regression for #2889: a --session, --fork or --rebind path that names no file is reported, never opened as a new session.
import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSessionManager } from "../../../src/main.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../../src/experimental/source-resolver.ts")).href;
const fixture = resolve(__dirname, "../../fixtures/before-compaction.jsonl");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	// realpath: on macOS tmpdir() is a symlink, and the spawned CLI resolves paths physically.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-2889-")));
	tempDirs.push(dir);
	return dir;
}

function listFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

async function runCli(args: string[], cwd: string, agentDir: string): Promise<{ code: number | null; stderr: string }> {
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
			cwd,
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});
	return { code, stderr };
}

describe("missing session path (#2889)", () => {
	it.each([
		["--session in print mode", (path: string) => ["--session", path, "-p", "hi"]],
		["--session in RPC mode", (path: string) => ["--session", path, "--mode", "rpc"]],
		["--fork", (path: string) => ["--fork", path, "-p", "hi"]],
		["--rebind", (path: string) => ["--rebind", path, "-p", "hi"]],
	] as const)(
		"reports a path that names no file and starts no session: %s",
		async (_label, argsFor) => {
			const root = createTempDir();
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			const missing = join(root, "sessions", "typo-does-not-exist.jsonl");

			const result = await runCli(argsFor(missing), projectDir, agentDir);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`No session file at ${missing}`);
			expect(existsSync(missing)).toBe(false);
			expect(listFiles(join(root, "sessions"))).toEqual([]);
			expect(listFiles(join(agentDir, "sessions"))).toEqual([]);
		},
		60_000,
	);

	it("still opens an existing session file given by path", async () => {
		const root = createTempDir();
		const projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });
		const sessionFile = join(root, "existing.jsonl");
		copyFileSync(fixture, sessionFile);
		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]) as { id: string };

		const manager = await createSessionManager(
			parseArgs(["--session", sessionFile]),
			projectDir,
			undefined,
			SettingsManager.inMemory(),
			"print",
		);

		expect(manager.getSessionFile()).toBe(sessionFile);
		expect(manager.getSessionId()).toBe(header.id);
	});
});
