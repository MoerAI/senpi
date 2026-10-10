// Answers "does this pid own a console, and is that console's window visible?" (ported from
// oh-my-openagent's RPC console probe). It runs as a throwaway child on purpose: AttachConsole binds the
// calling process to the other process's console, so asking from the long-lived probe would attach the
// probe to the very console it measures.
import { dlopen, FFIType } from "bun:ffi";

const pid = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isSafeInteger(pid) || pid <= 0) {
	throw new Error(`usage: attachment-probe.ts <pid> (got ${String(process.argv[2])})`);
}

const kernel32 = dlopen("kernel32.dll", {
	FreeConsole: { args: [], returns: FFIType.bool },
	AttachConsole: { args: [FFIType.u32], returns: FFIType.bool },
	GetConsoleWindow: { args: [], returns: FFIType.ptr },
	GetLastError: { args: [], returns: FFIType.u32 },
});
const user32 = dlopen("user32.dll", {
	IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
});

try {
	kernel32.symbols.FreeConsole();
	const attached = Boolean(kernel32.symbols.AttachConsole(pid));
	const errorCode = Number(kernel32.symbols.GetLastError());
	const windowHandle = kernel32.symbols.GetConsoleWindow();
	const windowHandleValue = windowHandle === null ? 0 : Number(windowHandle);
	const windowVisible = windowHandleValue !== 0 && Boolean(user32.symbols.IsWindowVisible(windowHandle));
	if (attached) kernel32.symbols.FreeConsole();
	process.stdout.write(JSON.stringify({ attached, errorCode, windowHandle: windowHandleValue, windowVisible }));
} finally {
	user32.close();
	kernel32.close();
}
