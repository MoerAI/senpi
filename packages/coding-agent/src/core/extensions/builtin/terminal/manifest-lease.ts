import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ownProcessStartedAtMs, processBootAtMs, sameBoot, sameProcessStart } from "./process-identity.ts";
import { readProcessStartMs as defaultReadProcessStartMs } from "./process-start-probe.ts";

export const LEASE_RECORD_VERSION = 2;

export interface LeaseSelfIdentity {
	readonly pid: number;
	readonly bootAtMs: number;
	readonly processStartedAtMs: number;
}

/**
 * `startedAtMs` duplicates `acquiredAtMs` on purpose: a senpi build that still runs the v1 lease
 * reader parses `{pid, startedAtMs}` and must not see this file as unparseable (which it reclaims).
 */
export interface LeaseRecord {
	readonly v?: number;
	readonly token?: string;
	readonly pid: number;
	readonly startedAtMs: number;
	readonly bootAtMs?: number;
	readonly processStartedAtMs?: number;
	readonly acquiredAtMs?: number;
}

export interface LeaseHolder {
	readonly pid: number;
	readonly startedAtMs: number;
	readonly bootAtMs?: number;
}

export type AcquireTerminalLeaseOptions = {
	dir: string;
	encodedSessionId: string;
	pid?: number;
	now?: () => number;
	self?: LeaseSelfIdentity;
	isProcessAlive?: (pid: number) => boolean;
	readProcessStartMs?: (pid: number) => Promise<number | undefined>;
};

export type AcquireTerminalLeaseResult =
	| { acquired: true; path: string; pid: number; token: string }
	| { acquired: false; holder: LeaseHolder };

export type LeaseClassification = "self" | "dead" | "reused" | "live-foreign";

const generationTokens = new Map<string, string>();
/**
 * Tokens held by generations of THIS process that are still running. A same-pid lease is a live
 * holder only when its token is here (a sibling session generation, or a racing waiter that won);
 * a token that is not here was minted by a generation that has shut down, even one whose
 * shutdown never reached the release (the 10 s shutdown cap), so it is ours to re-enter.
 */
const liveTokens = new Set<string>();

export function currentLeaseToken(encodedSessionId: string): string | undefined {
	return generationTokens.get(encodedSessionId);
}

export function forgetLeaseToken(encodedSessionId: string, token: string): void {
	liveTokens.delete(token);
	if (generationTokens.get(encodedSessionId) === token) generationTokens.delete(encodedSessionId);
}

/** Mark a generation's token dead the moment its shutdown starts, before any slow flush. */
export function retireLeaseToken(token: string): void {
	liveTokens.delete(token);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

function probeAlive(pid: number, probe?: (pid: number) => boolean): boolean {
	try {
		if (probe) return probe(pid);
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "EPERM") return true;
		if (code === "ESRCH") return false;
		throw error;
	}
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function readLeaseRecord(raw: string): LeaseRecord | "unparseable" {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return "unparseable";
		const candidate = parsed as Record<string, unknown>;
		if (!isFiniteNumber(candidate.pid) || !isFiniteNumber(candidate.startedAtMs)) return "unparseable";
		return {
			pid: candidate.pid,
			startedAtMs: candidate.startedAtMs,
			...(isFiniteNumber(candidate.v) ? { v: candidate.v } : {}),
			...(typeof candidate.token === "string" ? { token: candidate.token } : {}),
			...(isFiniteNumber(candidate.bootAtMs) ? { bootAtMs: candidate.bootAtMs } : {}),
			...(isFiniteNumber(candidate.processStartedAtMs) ? { processStartedAtMs: candidate.processStartedAtMs } : {}),
			...(isFiniteNumber(candidate.acquiredAtMs) ? { acquiredAtMs: candidate.acquiredAtMs } : {}),
		};
	} catch {
		return "unparseable";
	}
}

async function readLeaseFile(path: string): Promise<LeaseRecord | "missing" | "unparseable"> {
	try {
		return readLeaseRecord(await readFile(path, "utf8"));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "missing";
		throw error;
	}
}

/**
 * Decide what an existing lease is. A pid alone is never trusted: the holder is alive only when
 * its pid answers AND its recorded start instant matches the process now wearing that pid
 * (probed on this cold path only). A boot mismatch alone never reclaims an alive pid. Our own
 * pid is "self" only when the file carries the token this process minted for the session (or a
 * legacy record without one): a multi-session host holds many sessions under one pid, and a
 * lease another live generation in this process owns is a live holder, not a re-entry.
 */
export async function classifyLease(
	existing: LeaseRecord,
	self: LeaseSelfIdentity,
	probes: {
		readonly isProcessAlive?: (pid: number) => boolean;
		readonly readProcessStartMs: (pid: number) => Promise<number | undefined>;
		readonly liveTokens?: ReadonlySet<string>;
	},
): Promise<LeaseClassification> {
	if (existing.pid === self.pid) {
		if (existing.token !== undefined && (probes.liveTokens ?? liveTokens).has(existing.token)) return "live-foreign";
		return "self";
	}
	if (!probeAlive(existing.pid, probes.isProcessAlive)) return "dead";
	const recordedStart = existing.processStartedAtMs ?? existing.startedAtMs;
	let observedStart: number | undefined;
	try {
		observedStart = await probes.readProcessStartMs(existing.pid);
	} catch {
		observedStart = undefined;
	}
	if (observedStart === undefined) return "live-foreign";
	return sameProcessStart(recordedStart, observedStart) ? "live-foreign" : "reused";
}

function holderOf(record: LeaseRecord): LeaseHolder {
	return {
		pid: record.pid,
		startedAtMs: record.startedAtMs,
		...(record.bootAtMs !== undefined ? { bootAtMs: record.bootAtMs } : {}),
	};
}

async function writeRecord(path: string, record: LeaseRecord, exclusive: boolean): Promise<void> {
	if (exclusive) {
		const file = await open(path, "wx");
		try {
			await file.writeFile(JSON.stringify(record), "utf8");
		} finally {
			await file.close();
		}
		return;
	}
	const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	const file = await open(temp, "wx");
	try {
		await file.writeFile(JSON.stringify(record), "utf8");
	} finally {
		await file.close();
	}
	await rename(temp, path);
}

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

export async function acquireTerminalLease(options: AcquireTerminalLeaseOptions): Promise<AcquireTerminalLeaseResult> {
	const now = (options.now ?? Date.now)();
	const self: LeaseSelfIdentity = options.self ?? {
		pid: options.pid ?? process.pid,
		bootAtMs: processBootAtMs(),
		processStartedAtMs: ownProcessStartedAtMs(),
	};
	const pid = options.pid ?? self.pid;
	const path = join(options.dir, `${options.encodedSessionId}.lease`);
	await mkdir(options.dir, { recursive: true });
	const token = randomUUID();
	const record: LeaseRecord = {
		v: LEASE_RECORD_VERSION,
		token,
		pid,
		startedAtMs: now,
		bootAtMs: self.bootAtMs,
		processStartedAtMs: self.processStartedAtMs,
		acquiredAtMs: now,
	};
	const acquired = (): AcquireTerminalLeaseResult => {
		generationTokens.set(options.encodedSessionId, token);
		liveTokens.add(token);
		return { acquired: true, path, pid, token };
	};
	const probes = {
		isProcessAlive: options.isProcessAlive,
		readProcessStartMs: options.readProcessStartMs ?? defaultReadProcessStartMs,
	};
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await writeRecord(path, record, true);
			return acquired();
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		const existing = await readLeaseFile(path);
		if (existing === "missing" || existing === "unparseable") {
			await unlinkIfPresent(path);
			continue;
		}
		const verdict = await classifyLease({ ...existing, pid: existing.pid }, { ...self, pid }, probes);
		if (verdict === "self") {
			await writeRecord(path, record, false);
			return acquired();
		}
		if (verdict === "live-foreign") return { acquired: false, holder: holderOf(existing) };
		await unlinkIfPresent(path);
	}
	const existing = await readLeaseFile(path);
	if (existing === "missing" || existing === "unparseable") {
		await writeRecord(path, record, true);
		return acquired();
	}
	return { acquired: false, holder: holderOf(existing) };
}

/** Release only the generation that acquired: a stale release from an earlier generation is a no-op. */
export async function releaseTerminalLease(handle: { path: string; pid: number; token?: string }): Promise<void> {
	const existing = await readLeaseFile(handle.path);
	if (existing === "missing" || existing === "unparseable") return;
	if (existing.pid !== handle.pid) return;
	if (handle.token !== undefined && existing.token !== undefined && existing.token !== handle.token) return;
	await unlinkIfPresent(handle.path);
	if (existing.token !== undefined) {
		liveTokens.delete(existing.token);
		for (const [sessionId, token] of generationTokens)
			if (token === existing.token) generationTokens.delete(sessionId);
	}
}

export { sameBoot };
