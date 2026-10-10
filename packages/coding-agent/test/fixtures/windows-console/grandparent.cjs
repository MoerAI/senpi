// The npm/Firebase/Vitest shape behind omo#7691: a bash-tool command runs node, and that node spawns its own
// child. argv: <shape> <pid file>. The shapes are the three ways a tool commonly launches a child on Windows.
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const [shape, pidFile] = process.argv.slice(2);
const sleeper = "setTimeout(() => {}, 30000)";
const child =
	shape === "shell"
		? spawn(`"${process.execPath}" -e "${sleeper}"`, { stdio: "ignore", shell: true })
		: spawn(process.execPath, ["-e", sleeper], { stdio: "ignore", detached: shape === "detached" });
child.unref();
writeFileSync(pidFile, JSON.stringify({ grandparent: process.pid, grandchild: child.pid }));
setTimeout(() => {}, 30000);
