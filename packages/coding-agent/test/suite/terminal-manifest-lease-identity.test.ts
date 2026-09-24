import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireTerminalLease,
	currentLeaseToken,
	LEASE_RECORD_VERSION,
	readLeaseRecord,
	releaseTerminalLease,
} from "../../src/core/extensions/builtin/terminal/manifest-lease.ts";
import { BOOT_INSTANT_TOLERANCE_MS } from "../../src/core/extensions/builtin/terminal/process-identity.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-terminal-lease-id-"));
	createdDirs.push(dir);
	return dir;
}

const BOOT = 1_790_000_000_000;
const NOW = BOOT + 3_600_000;
const HOLDER_START = NOW - 600_000;
const alive = () => true;

function v2Record(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		v: LEASE_RECORD_VERSION,
		token: "holder-token",
		pid: 424_242,
		startedAtMs: HOLDER_START,
		bootAtMs: BOOT,
		processStartedAtMs: HOLDER_START,
		acquiredAtMs: HOLDER_START,
		...overrides,
	};
}

function selfIdentity(pid = process.pid) {
	return { pid, bootAtMs: BOOT, processStartedAtMs: NOW - 5_000 };
}

describe("terminal lease identity (v2)", () => {
	it("writes a v2 record that the legacy v1 reader still parses", async () => {
		const dir = await tempDir();
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
		});
		expect(result.acquired).toBe(true);
		const raw: unknown = JSON.parse(await readFile(join(dir, "s.lease"), "utf8"));
		expect(raw).toMatchObject({
			v: LEASE_RECORD_VERSION,
			pid: process.pid,
			startedAtMs: NOW,
			acquiredAtMs: NOW,
			bootAtMs: BOOT,
			processStartedAtMs: NOW - 5_000,
		});
		const legacyView = raw as { pid: unknown; startedAtMs: unknown; token: unknown };
		expect(typeof legacyView.pid).toBe("number");
		expect(typeof legacyView.startedAtMs).toBe("number");
		expect(typeof legacyView.token).toBe("string");
		expect(currentLeaseToken("s")).toBe(legacyView.token);
	});

	it("reclaims a live-looking pid whose start time does not match (pid reuse)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "s.lease"), JSON.stringify(v2Record()), "utf8");
		const readProcessStartMs = vi.fn(async () => HOLDER_START + 10_000);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs,
		});
		expect(result.acquired).toBe(true);
		expect(readProcessStartMs).toHaveBeenCalledWith(424_242);
		expect(readLeaseRecord(await readFile(join(dir, "s.lease"), "utf8"))).toMatchObject({ pid: process.pid });
	});

	it("reclaims a pre-boot lease with a dead pid without consulting the start-time probe", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "s.lease"),
			JSON.stringify(v2Record({ bootAtMs: BOOT - BOOT_INSTANT_TOLERANCE_MS - 3_600_000 })),
			"utf8",
		);
		const readProcessStartMs = vi.fn(async () => HOLDER_START);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: () => false,
			readProcessStartMs,
		});
		expect(result.acquired).toBe(true);
		expect(readProcessStartMs).not.toHaveBeenCalled();
	});

	it("keeps a pre-boot lease whose pid is alive and whose start time is confirmed", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "s.lease"),
			JSON.stringify(v2Record({ bootAtMs: BOOT - BOOT_INSTANT_TOLERANCE_MS - 3_600_000 })),
			"utf8",
		);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => HOLDER_START + 1_000,
		});
		expect(result).toMatchObject({ acquired: false, holder: { pid: 424_242, startedAtMs: HOLDER_START } });
	});

	it("re-enters its own lease with a fresh token and ignores a stale release", async () => {
		const dir = await tempDir();
		const path = join(dir, "s.lease");
		const previous = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW - 60_000,
			self: selfIdentity(),
		});
		expect(previous.acquired).toBe(true);
		if (!previous.acquired) return;
		const staleToken = previous.token;
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => {
				throw new Error("self re-entry must not probe");
			},
		});
		expect(result.acquired).toBe(true);
		const record = readLeaseRecord(await readFile(path, "utf8"));
		expect(record).not.toBe("unparseable");
		if (record === "unparseable") return;
		expect(record.token).not.toBe(staleToken);
		await releaseTerminalLease({ path, pid: process.pid, token: staleToken });
		expect(existsSync(path)).toBe(true);
		await releaseTerminalLease({ path, pid: process.pid, token: record.token });
		expect(existsSync(path)).toBe(false);
	});

	it("treats another generation of this very process as a live holder, not a re-entry", async () => {
		const dir = await tempDir();
		await writeFile(
			join(dir, "s.lease"),
			JSON.stringify(v2Record({ pid: process.pid, token: "sibling-session-generation" })),
			"utf8",
		);
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => {
				throw new Error("same-pid classification must not probe");
			},
		});
		expect(result).toMatchObject({ acquired: false, holder: { pid: process.pid } });
	});

	it("reports a confirmed live foreign holder as attached elsewhere", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "s.lease"), JSON.stringify(v2Record()), "utf8");
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => HOLDER_START + 2_000,
		});
		expect(result).toEqual({
			acquired: false,
			holder: { pid: 424_242, startedAtMs: HOLDER_START, bootAtMs: BOOT },
		});
	});

	it("treats a legacy v1 record by liveness plus start-time confirmation", async () => {
		const dir = await tempDir();
		const path = join(dir, "s.lease");
		await writeFile(path, JSON.stringify({ pid: 424_242, startedAtMs: HOLDER_START }), "utf8");
		const dead = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: () => false,
		});
		expect(dead.acquired).toBe(true);

		await writeFile(path, JSON.stringify({ pid: 424_242, startedAtMs: HOLDER_START }), "utf8");
		const reused = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => HOLDER_START + 60_000,
		});
		expect(reused.acquired).toBe(true);

		await writeFile(path, JSON.stringify({ pid: 424_242, startedAtMs: HOLDER_START }), "utf8");
		const confirmed = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => HOLDER_START,
		});
		expect(confirmed).toEqual({ acquired: false, holder: { pid: 424_242, startedAtMs: HOLDER_START } });
	});

	it("treats an unconfirmable start time (probe returns undefined) as a live holder", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "s.lease"), JSON.stringify(v2Record()), "utf8");
		const result = await acquireTerminalLease({
			dir,
			encodedSessionId: "s",
			now: () => NOW,
			self: selfIdentity(),
			isProcessAlive: alive,
			readProcessStartMs: async () => undefined,
		});
		expect(result.acquired).toBe(false);
	});
});
