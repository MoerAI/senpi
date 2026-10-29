import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

function native(failure?: string) {
	const getHandle = vi.fn(() => {
		if (failure === "handle conversion") throw new Error("conversion unavailable");
		return 123;
	});
	const setHandle = vi.fn(() => {
		if (failure === "handle information") throw new Error("handle information unavailable");
		return 1;
	});
	const ffi = {
		FFIType: { i32: 0, ptr: 1, u32: 2 },
		dlopen: vi.fn((library: string) => {
			if (failure === library) throw new Error("library unavailable");
			return {
				symbols: library === "ucrtbase.dll" ? { _get_osfhandle: getHandle } : { SetHandleInformation: setHandle },
			};
		}),
	};
	const originalBuiltin = process.getBuiltinModule;
	const builtin = vi.spyOn(process, "getBuiltinModule").mockImplementation((name: string) => {
		if (name !== "bun:ffi") return originalBuiltin(name);
		if (failure === "builtin") throw new Error("FFI unavailable");
		return ffi;
	});
	return { builtin, getHandle };
}

// #4859: protect the real receipt boundary without ever invoking the CRT on a closed descriptor.
describe("private descriptor inherit clearing", () => {
	it("an unopened descriptor returns false without resolving FFI", async () => {
		const runtime = native();
		const { clearPrivateFdInherit } = await import("../../src/utils/private-fd-inherit.ts");
		const cleared = clearPrivateFdInherit(0x3fffffff);
		expect({
			cleared,
			ffiCalls: runtime.builtin.mock.calls.length,
			handleCalls: runtime.getHandle.mock.calls.length,
		}).toEqual({
			cleared: false,
			ffiCalls: 0,
			handleCalls: 0,
		});
	});

	it("an unopened descriptor is rechecked after the native loader is cached", async () => {
		const runtime = native();
		const { clearPrivateFdInherit } = await import("../../src/utils/private-fd-inherit.ts");
		const fd = openSync(import.meta.filename, "r");
		try {
			expect(clearPrivateFdInherit(fd)).toBe(true);
			const cleared = clearPrivateFdInherit(0x3fffffff);
			expect({ cleared, handleCalls: runtime.getHandle.mock.calls.length }).toEqual({
				cleared: false,
				handleCalls: 1,
			});
		} finally {
			closeSync(fd);
		}
	});

	it.each(["builtin", "ucrtbase.dll", "kernel32.dll", "handle conversion", "handle information"])(
		"native %s failure returns false without throwing",
		async (failure) => {
			native(failure);
			const { clearPrivateFdInherit } = await import("../../src/utils/private-fd-inherit.ts");
			const fd = openSync(import.meta.filename, "r");
			let cleared: boolean | undefined;
			try {
				expect(() => {
					cleared = clearPrivateFdInherit(fd);
				}).not.toThrow();
				expect(cleared).toBe(false);
			} finally {
				closeSync(fd);
			}
		},
	);

	it("dlopen failure preserves startup import and refuses the entry", async () => {
		const child = spawn("bun", [join(import.meta.dirname, "../fixtures/private-fd-inherit-failure.ts")], {
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const closed = once(child, "close", { signal: AbortSignal.timeout(15_000) });
		let report = "";
		let errors = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			report += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		try {
			expect((await closed)[0], errors).toBe(0);
			expect(JSON.parse(report)).toEqual({ imported: true, declared: true, entry: null, dlopenCalls: 1 });
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}
	});
});
