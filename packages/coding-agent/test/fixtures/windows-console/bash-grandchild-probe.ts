// Runs one grandparent.cjs shape through the bash tool's real shell operations from a CONSOLE-LESS parent
// (an IDE- or GUI-launched host), then reports whether the node grandparent and its child own a visible
// console window. argv: <inherit|detached|shell>. Prints one JSON line; the test owns the assertion.
import { dlopen, FFIType } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalBashOperations } from "../../../src/core/tools/bash.ts";

const PID_FILE_DEADLINE_MS = 30_000;
const shape = process.argv[2] ?? "";
if (!["inherit", "detached", "shell"].includes(shape)) throw new Error(`unknown shape ${shape}`);

const grandparentPath = fileURLToPath(new URL("./grandparent.cjs", import.meta.url)).replaceAll("\\", "/");
const attachmentProbePath = fileURLToPath(new URL("./attachment-probe.ts", import.meta.url));

function detachCurrentConsole(): void {
	const kernel32 = dlopen("kernel32.dll", { FreeConsole: { args: [], returns: FFIType.bool } });
	try {
		kernel32.symbols.FreeConsole();
	} finally {
		kernel32.close();
	}
}

function attachment(pid: number): unknown {
	const result = spawnSync(process.execPath, [attachmentProbePath, String(pid)], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`attachment probe failed for ${pid}: ${result.stderr.trim()}`);
	return JSON.parse(result.stdout.trim());
}

function killTree(pid: number): void {
	spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

async function waitForPidFile(path: string): Promise<{ grandparent: number; grandchild: number }> {
	const deadline = Date.now() + PID_FILE_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const text = readFileSync(path, "utf8").trim();
			if (text.length > 0) return JSON.parse(text) as { grandparent: number; grandchild: number };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`the bash-tool command never wrote ${path} within ${PID_FILE_DEADLINE_MS}ms`);
}

detachCurrentConsole();
const dir = mkdtempSync(join(tmpdir(), "senpi-console-probe-"));
const pidFile = join(dir, "pids.json").replaceAll("\\", "/");
const controller = new AbortController();
const run = createLocalBashOperations()
	.exec(`node '${grandparentPath}' ${shape} '${pidFile}'`, dir, {
		onData: () => {},
		signal: controller.signal,
		timeout: 60,
	})
	.catch(() => undefined);
let pids: { grandparent: number; grandchild: number } | undefined;
try {
	pids = await waitForPidFile(pidFile);
	process.stdout.write(
		`${JSON.stringify({ shape, grandparent: attachment(pids.grandparent), grandchild: attachment(pids.grandchild) })}\n`,
	);
} finally {
	controller.abort();
	if (pids) {
		killTree(pids.grandchild);
		killTree(pids.grandparent);
	}
	await run;
	rmSync(dir, { recursive: true, force: true });
}
