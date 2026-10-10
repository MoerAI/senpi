import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Platform contract (omo#7691): a bash-tool command that starts node, which starts its own child (the
// npm/Firebase/Vitest shape), must not open a visible console window when senpi itself runs without a
// console. The bash tool already hides its direct shell child (src/core/tools/bash.ts windowsHide); this
// measures the processes that flag cannot reach, one launch shape per case.
const PROBE_PATH = fileURLToPath(new URL("./fixtures/windows-console/bash-grandchild-probe.ts", import.meta.url));
const BUN = process.versions.bun ? process.execPath : "bun";

type Attachment = { readonly attached: boolean; readonly windowVisible: boolean };
type ProbeResult = { readonly shape: string; readonly grandparent: Attachment; readonly grandchild: Attachment };

async function runProbe(shape: string): Promise<ProbeResult> {
	const probe = spawn(BUN, [PROBE_PATH, shape], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stdout = "";
	let stderr = "";
	probe.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	probe.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const [code] = (await once(probe, "close")) as [number | null];
	if (code !== 0) throw new Error(`probe ${shape} exited ${String(code)}: ${stderr.trim()}`);
	const result = JSON.parse(stdout.trim()) as ProbeResult;
	console.log(`console probe ${JSON.stringify(result)}`);
	return result;
}

describe.skipIf(process.platform !== "win32")("bash tool grandchild console windows (omo#7691)", () => {
	it.each(["inherit", "detached", "shell"])(
		"#given a console-less senpi #when a bash command's node starts a %s child #then no process opens a visible console",
		async (shape) => {
			// given / when
			const result = await runProbe(shape);

			// then
			expect({
				grandparentVisible: result.grandparent.windowVisible,
				grandchildVisible: result.grandchild.windowVisible,
			}).toEqual({ grandparentVisible: false, grandchildVisible: false });
		},
		90_000,
	);
});
