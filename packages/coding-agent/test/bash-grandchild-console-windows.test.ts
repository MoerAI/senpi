import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Platform contract (omo#7691): a bash-tool command that starts node, which starts its own child (the
// npm/Firebase/Vitest shape), must not open a visible console window when senpi itself runs without a
// console. The bash tool already hides its direct shell child (src/core/tools/bash.ts windowsHide); this
// measures the processes that flag cannot reach, one launch shape per case.
const PROBE_PATH = fileURLToPath(new URL("./fixtures/windows-console/bash-grandchild-probe.ts", import.meta.url));
const BUN = process.versions.bun ? process.execPath : "bun";

type Attachment = { readonly attached: boolean; readonly windowVisible: boolean };
type ProbeResult = {
	readonly shape: string;
	readonly control: boolean;
	readonly grandparent: Attachment;
	readonly grandchild: Attachment;
	readonly leaf: Attachment;
};
const RESULTS_FILE = process.env.SENPI_CONSOLE_PROBE_RESULTS;

async function runProbe(shape: string, mode: "bash-tool" | "control"): Promise<ProbeResult> {
	const probe = spawn(BUN, [PROBE_PATH, shape, ...(mode === "control" ? ["control"] : [])], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
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
	if (RESULTS_FILE) appendFileSync(RESULTS_FILE, `${JSON.stringify(result)}\n`);
	return result;
}

describe.skipIf(process.platform !== "win32")("bash tool grandchild console windows (omo#7691)", () => {
	it.each(["inherit", "detached", "shell", "firebase-java", "firebase-shell"])(
		"#given a console-less senpi #when a bash command's node starts a %s child #then no process opens a visible console",
		async (shape) => {
			// given / when
			const result = await runProbe(shape, "bash-tool");

			// then
			expect({
				shape,
				grandparent: result.grandparent,
				grandchild: result.grandchild,
				leaf: result.leaf,
			}).toMatchObject({
				grandparent: { windowVisible: false },
				grandchild: { windowVisible: false },
				leaf: { windowVisible: false },
			});
		},
		90_000,
	);

	it("#given the same chain spawned WITHOUT windowsHide #when probed #then the probe sees a visible console (control)", async () => {
		// given / when
		const result = await runProbe("inherit", "control");

		// then
		expect({ grandparent: result.grandparent }).toMatchObject({ grandparent: { windowVisible: true } });
	}, 90_000);
});
