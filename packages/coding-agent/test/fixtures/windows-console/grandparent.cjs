// The npm/Firebase/Vitest shape behind omo#7691: a bash-tool command runs node, and that node spawns its own
// child. argv: <shape> <pid file>. The shapes are the three ways a tool commonly launches a child on Windows.
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const [shape, pidFile] = process.argv.slice(2);
const sleeper = "setTimeout(() => {}, 30000)";
// firebase-java / firebase-shell mirror firebase-tools 15.33.0 lib/emulator/downloadableEmulators.js _runBinary:
// detached, stdin inherited, stdout/stderr piped, no windowsHide (the shell variant is its Pub/Sub launch).
const firebaseOptions = { detached: true, stdio: ["inherit", "pipe", "pipe"] };
const child =
	shape === "shell"
		? spawn(`"${process.execPath}" -e "${sleeper}"`, { stdio: "ignore", shell: true })
		: shape === "firebase-java"
			? spawn(process.execPath, ["-e", sleeper], firebaseOptions)
			: shape === "firebase-shell"
				? spawn(`"${process.execPath}"`, ["-e", `"${sleeper}"`], { ...firebaseOptions, shell: true })
				: spawn(process.execPath, ["-e", sleeper], { stdio: "ignore", detached: shape === "detached" });
child.unref();
writeFileSync(pidFile, JSON.stringify({ grandparent: process.pid, grandchild: child.pid }));
setTimeout(() => {}, 30000);
