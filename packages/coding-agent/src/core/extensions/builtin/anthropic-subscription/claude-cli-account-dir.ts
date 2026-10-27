import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { logoutClaudeCli } from "./claude-cli-auth-status.ts";

/**
 * Entries of a CLI-store account dir that point at the shared Claude root, so every account reads one
 * transcript tree (`projects`) and the user's own settings, memory, agents, commands, skills and output
 * styles. The credential store and everything else stay per account.
 */
export const CLAUDE_CLI_SHARED_LINKS = [
	"projects",
	"settings.json",
	"CLAUDE.md",
	"agents",
	"commands",
	"skills",
	"output-styles",
] as const;

const SHARED_FILES: ReadonlySet<string> = new Set(["settings.json", "CLAUDE.md"]);
const DIR_ID_PATTERN = /^[0-9a-f]{32}$/;

export function newAccountDirId(): string {
	return randomBytes(16).toString("hex");
}

/** `<agentDir>/anthropic-subscription-claude/<dirId>`; a stored id of any other shape is refused. */
export function accountDirFor(agentDir: string, dirId: string): string {
	if (!DIR_ID_PATTERN.test(dirId)) throw new Error("Invalid Claude account dir id");
	return join(agentDir, "anthropic-subscription-claude", dirId);
}

/** The root the accounts share: an inherited `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeCliSharedRoot(env: NodeJS.ProcessEnv): string {
	const inherited = env.CLAUDE_CONFIG_DIR;
	return inherited ? resolve(inherited) : join(homedir(), ".claude");
}

function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function linkEntry(entry: string, target: string, path: string): void {
	if (!SHARED_FILES.has(entry)) {
		mkdirSync(target, { recursive: true });
		symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
		return;
	}
	if (!exists(target)) return;
	try {
		symlinkSync(target, path, "file");
	} catch (error) {
		// Windows refuses file symlinks without Developer Mode; the account then keeps its own copy.
		if (process.platform !== "win32") throw error;
	}
}

export type EnsureAccountDirOptions = {
	readonly agentDir: string;
	readonly dirId: string;
	readonly sharedRoot: string;
};

/**
 * Creates the account dir (0700) and creates or repairs its links to the shared root. A link pointing
 * elsewhere is replaced; a real file or dir in a link's place is account data and is left alone.
 */
export function ensureAccountDir(options: EnsureAccountDirOptions): string {
	const accountDir = accountDirFor(options.agentDir, options.dirId);
	mkdirSync(accountDir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(accountDir, 0o700);
	for (const entry of CLAUDE_CLI_SHARED_LINKS) {
		const path = join(accountDir, entry);
		const target = join(options.sharedRoot, entry);
		if (isLink(path)) {
			if (resolve(accountDir, readlinkSync(path)) === resolve(target)) continue;
			unlinkSync(path);
		} else if (exists(path)) {
			continue;
		}
		linkEntry(entry, target, path);
	}
	return accountDir;
}

export type RemoveAccountDirOptions = {
	readonly agentDir: string;
	readonly dirId: string;
	readonly executable: string;
	readonly parentEnv?: NodeJS.ProcessEnv;
};

/**
 * Signs the account out (`claude auth logout` with `CLAUDE_CONFIG_DIR=<accountDir>`, which deletes that dir's
 * credential store entry), then unlinks the shared links WITHOUT following them and removes the dir. A failed
 * sign-out throws and leaves everything in place, so no credential store entry is orphaned.
 */
export async function removeAccountDir(options: RemoveAccountDirOptions): Promise<void> {
	const accountDir = accountDirFor(options.agentDir, options.dirId);
	if (!exists(accountDir)) return;
	if (!statSync(accountDir).isDirectory()) throw new Error("Claude account dir is not a directory");
	const signedOut = await logoutClaudeCli({
		executable: options.executable,
		configDir: accountDir,
		...(options.parentEnv === undefined ? {} : { parentEnv: options.parentEnv }),
	});
	if (!signedOut) throw new Error("Claude sign-out failed; the account was kept");
	for (const entry of CLAUDE_CLI_SHARED_LINKS) {
		const path = join(accountDir, entry);
		if (isLink(path)) unlinkSync(path);
	}
	rmSync(accountDir, { recursive: true, force: true });
}
