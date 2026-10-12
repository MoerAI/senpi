import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	BOOT_INSTANT_TOLERANCE_MS,
	ownProcessStartedAtMs,
	processBootAtMs,
	sameBoot,
} from "../../src/core/extensions/builtin/terminal/process-identity.ts";

describe("terminal process identity", () => {
	it("derives a whole-second boot instant from the clock and os.uptime", () => {
		expect(
			processBootAtMs(
				() => 1_790_000_000_400,
				() => 86_400,
			),
		).toBe(1_789_913_600_000);
		expect(
			processBootAtMs(
				() => 1_790_000_000_600,
				() => 86_400,
			),
		).toBe(1_789_913_601_000);
	});

	it("keeps two reads across an os.uptime tick on the same boot", () => {
		// os.uptime() is integral, so the clock minus uptime is a sawtooth: a read just before a tick
		// and one just after it land on adjacent whole seconds (senpi#3152).
		const before = processBootAtMs(
			() => 1_790_000_000_990,
			() => 86_400,
		);
		const after = processBootAtMs(
			() => 1_790_000_001_010,
			() => 86_401,
		);
		expect(before - after).toBe(1000);
		expect(sameBoot(before, after)).toBe(true);
	});

	it.runIf(process.platform === "darwin")("matches the kernel boot time on darwin within the tolerance", () => {
		const raw = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
		const seconds = Number(/sec = (\d+)/.exec(raw)?.[1]);
		expect(Number.isFinite(seconds)).toBe(true);
		expect(Math.abs(processBootAtMs() - seconds * 1000)).toBeLessThanOrEqual(BOOT_INSTANT_TOLERANCE_MS);
	});

	it("reports the own process start within a few seconds of now for a fresh process", () => {
		const started = ownProcessStartedAtMs();
		expect(started % 1000).toBe(0);
		expect(started).toBeLessThanOrEqual(Date.now());
		expect(Date.now() - started).toBeLessThan(15 * 60_000);
	});

	it("floors the own start to the second like ps does, so it never lands after now", () => {
		const uptimeMs = process.uptime() * 1000;
		const now = 1_790_000_000_600 + uptimeMs;
		expect(ownProcessStartedAtMs(() => now)).toBe(1_790_000_000_000);
	});

	it("treats two boot instants as the same boot only inside the tolerance", () => {
		const boot = 1_700_000_000_000;
		expect(sameBoot(boot, boot + BOOT_INSTANT_TOLERANCE_MS)).toBe(true);
		expect(sameBoot(boot, boot - BOOT_INSTANT_TOLERANCE_MS)).toBe(true);
		expect(sameBoot(boot, boot + BOOT_INSTANT_TOLERANCE_MS + 1)).toBe(false);
		expect(sameBoot(boot, undefined)).toBe(false);
	});
});
