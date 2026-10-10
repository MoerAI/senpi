// Runs upstream-minimal-repro.cjs directly (no bash tool, no senpi) from a CONSOLE-LESS parent and reports whether
// the leaf it launches owns a visible console. argv: [hidden]. Prints one JSON line; the test owns the assertion.
import { dlopen, FFIType } from "bun:ffi";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_DEADLINE_MS = 30_000;
const hidden = process.argv[2] === "hidden";
const reproPath = fileURLToPath(new URL("./upstream-minimal-repro.cjs", import.meta.url));
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

async function waitForPid(path: string): Promise<number> {
	const deadline = Date.now() + FILE_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
			if (Number.isSafeInteger(pid) && pid > 0) return pid;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`${path} was not written within ${FILE_DEADLINE_MS}ms`);
}

detachCurrentConsole();
const dir = mkdtempSync(join(tmpdir(), "senpi-upstream-probe-"));
const pidFile = join(dir, "leaf.pid");
const launcher = spawn("node", [reproPath, hidden ? "hidden" : "today", pidFile], {
	stdio: "ignore",
	windowsHide: true,
});
let leafPid: number | undefined;
try {
	leafPid = await waitForPid(pidFile);
	process.stdout.write(`${JSON.stringify({ hidden, leaf: attachment(leafPid) })}\n`);
} finally {
	if (leafPid !== undefined) killTree(leafPid);
	if (launcher.pid !== undefined) killTree(launcher.pid);
	rmSync(dir, { recursive: true, force: true });
}
