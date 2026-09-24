/**
 * Bounded GC of stale leases and empty manifests in the shared per-cwd terminal state dir.
 */

import { readdir as defaultReaddir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { classifyLease, type LeaseSelfIdentity, readLeaseRecord } from "./manifest-lease.ts";
import { readProcessStartMs as defaultReadProcessStartMs } from "./process-start-probe.ts";

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

export async function sweepTerminalStateDir(
	dir: string,
	options: {
		self: LeaseSelfIdentity;
		keep: ReadonlySet<string>;
		limit?: number;
		isProcessAlive?: (pid: number) => boolean;
		readProcessStartMs?: (pid: number) => Promise<number | undefined>;
		readdir?: (dir: string) => Promise<string[]>;
	},
): Promise<{ examined: number; removedLeases: number; removedManifests: number }> {
	const listed = options.readdir ? await options.readdir(dir) : await defaultReaddir(dir);
	const names = listed.slice(0, options.limit ?? 500);
	const probes = {
		isProcessAlive: options.isProcessAlive,
		readProcessStartMs: options.readProcessStartMs ?? defaultReadProcessStartMs,
	};
	let removedLeases = 0;
	let removedManifests = 0;
	for (const name of names) {
		if (options.keep.has(name)) continue;
		const path = join(dir, name);
		try {
			if (name.endsWith(".lease")) {
				const record = readLeaseRecord(await readFile(path, "utf8"));
				if (record === "unparseable") {
					await unlinkIfPresent(path);
					removedLeases += 1;
					continue;
				}
				const verdict = await classifyLease(record, options.self, probes);
				if (verdict === "dead" || verdict === "reused") {
					await unlinkIfPresent(path);
					removedLeases += 1;
				}
			} else if (name.endsWith(".json")) {
				const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
				if (typeof parsed !== "object" || parsed === null) continue;
				if (!("monitors" in parsed) || !("backgroundSessions" in parsed)) continue;
				const monitors = parsed.monitors;
				const backgroundSessions = parsed.backgroundSessions;
				if (!Array.isArray(monitors) || !Array.isArray(backgroundSessions)) continue;
				if (monitors.length === 0 && backgroundSessions.length === 0) {
					await unlinkIfPresent(path);
					removedManifests += 1;
				}
			}
		} catch {}
	}
	return { examined: names.length, removedLeases, removedManifests };
}
