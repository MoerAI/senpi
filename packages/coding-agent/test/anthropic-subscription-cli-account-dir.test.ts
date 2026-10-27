import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	accountDirFor,
	CLAUDE_CLI_SHARED_LINKS,
	ensureAccountDir,
	newAccountDirId,
	removeAccountDir,
} from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "claude-cli-auth", "fake-claude.mjs");
const DIR_ID = "0123456789abcdef0123456789abcdef";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(mode = "logout-ok") {
	const root = mkdtempSync(join(tmpdir(), "senpi-claude-cli-account-dir-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sharedRoot = join(root, "shared-claude");
	mkdirSync(agentDir);
	for (const entry of ["projects", "agents", "commands", "skills", "output-styles"]) {
		mkdirSync(join(sharedRoot, entry), { recursive: true });
	}
	writeFileSync(join(sharedRoot, "projects", "x.jsonl"), "{}\n");
	writeFileSync(join(sharedRoot, "settings.json"), "{}\n");
	writeFileSync(join(sharedRoot, "CLAUDE.md"), "# shared\n");
	const executable = join(root, "claude");
	copyFileSync(FIXTURE, executable);
	chmodSync(executable, 0o755);
	const recordPath = join(root, "record.jsonl");
	const parentEnv: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: root,
		FAKE_CLAUDE_MODE: mode,
		FAKE_CLAUDE_RECORD: recordPath,
	};
	const records = () =>
		readFileSync(recordPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { argv: string[]; configDir: string });
	return { agentDir, sharedRoot, executable, parentEnv, records };
}

describe("claude CLI account dir", () => {
	it("names the dir under the agent dir by its fixed id, and refuses any other id shape", () => {
		expect(accountDirFor("/agent", DIR_ID)).toBe(join("/agent", "anthropic-subscription-claude", DIR_ID));
		expect(newAccountDirId()).toMatch(/^[0-9a-f]{32}$/);
		expect(() => accountDirFor("/agent", "../escape")).toThrow();
	});

	it("the link set equals CLAUDE_CLI_SHARED_LINKS", () => {
		const { agentDir, sharedRoot } = setup();

		const accountDir = ensureAccountDir({ agentDir, dirId: DIR_ID, sharedRoot });

		const links = readdirSync(accountDir).filter((entry) => lstatSync(join(accountDir, entry)).isSymbolicLink());
		expect(links.sort()).toEqual([...CLAUDE_CLI_SHARED_LINKS].sort());
		for (const entry of CLAUDE_CLI_SHARED_LINKS) {
			expect(readlinkSync(join(accountDir, entry))).toBe(join(sharedRoot, entry));
		}
		if (process.platform !== "win32") expect(lstatSync(accountDir).mode & 0o777).toBe(0o700);
	});

	it("links are created and repaired", () => {
		const { agentDir, sharedRoot } = setup();
		const accountDir = ensureAccountDir({ agentDir, dirId: DIR_ID, sharedRoot });
		unlinkSync(join(accountDir, "projects"));

		ensureAccountDir({ agentDir, dirId: DIR_ID, sharedRoot });

		expect(lstatSync(join(accountDir, "projects")).isSymbolicLink()).toBe(true);
		expect(existsSync(join(accountDir, "projects", "x.jsonl"))).toBe(true);
	});

	it("removal leaves the shared transcript root intact", async () => {
		const { agentDir, sharedRoot, executable, parentEnv } = setup();
		const accountDir = ensureAccountDir({ agentDir, dirId: DIR_ID, sharedRoot });

		await removeAccountDir({ agentDir, dirId: DIR_ID, executable, parentEnv });

		expect(existsSync(accountDir)).toBe(false);
		expect(readFileSync(join(sharedRoot, "projects", "x.jsonl"), "utf8")).toBe("{}\n");
		expect(existsSync(join(sharedRoot, "settings.json"))).toBe(true);
		expect(existsSync(join(sharedRoot, "CLAUDE.md"))).toBe(true);
	});

	it("removal runs claude auth logout with CLAUDE_CONFIG_DIR=<accountDir>", async () => {
		const { agentDir, sharedRoot, executable, parentEnv, records } = setup();
		const accountDir = ensureAccountDir({ agentDir, dirId: DIR_ID, sharedRoot });

		await removeAccountDir({ agentDir, dirId: DIR_ID, executable, parentEnv });

		expect(records()).toEqual([expect.objectContaining({ argv: ["auth", "logout"], configDir: accountDir })]);
	});

	it("a failed sign-out keeps the dir and its links", async () => {
		const { agentDir, sharedRoot, executable, parentEnv } = setup("logout-fail");
		const accountDir = ensureAccountDir({ agentDir, dirId: DIR_ID, sharedRoot });

		await expect(removeAccountDir({ agentDir, dirId: DIR_ID, executable, parentEnv })).rejects.toThrow(
			/sign-out failed/,
		);

		expect(lstatSync(join(accountDir, "projects")).isSymbolicLink()).toBe(true);
	});
});
