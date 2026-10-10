// Minimal public repro for firebase-tools' Windows emulator launch (no senpi involved). Run it from a process that
// has no console of its own (an IDE, a GUI app, or a service) on Windows:
//   node upstream-minimal-repro.cjs           -> spawn options as in _runBinary today: the leaf gets a VISIBLE console
//   node upstream-minimal-repro.cjs hidden    -> the same options plus windowsHide: true: no visible console
// It prints the leaf's pid; check its console window with any window inspector (the CI job uses AttachConsole +
// GetConsoleWindow + IsWindowVisible).
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const hidden = process.argv[2] === "hidden";
const pidFile = process.argv[3] ?? join(__dirname, "repro-leaf.pid");
const leaf = join(__dirname, "leaf.cjs");
const child = spawn(`"${process.execPath}"`, [`"${leaf}"`, `"${pidFile}"`], {
	detached: true,
	stdio: ["inherit", "pipe", "pipe"],
	shell: true,
	...(hidden ? { windowsHide: true } : {}),
});
child.unref();
child.stdout.resume();
child.stderr.resume();
writeFileSync(`${pidFile}.launcher`, String(process.pid));
setTimeout(() => {}, 30000);
