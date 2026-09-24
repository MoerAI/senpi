/**
 * File-level primitives for the terminal lease. On a filesystem with hard links a lease file is
 * never visible half-written: it is written to a private temp file first and then published with
 * `link` (exclusive: fails with EEXIST when a lease exists) or `rename` (replace). Every removal of
 * a lease, by an acquire or by the GC, goes through `reclaimInspected`: under an exclusive
 * `<lease>.lock`, and only while the file still holds exactly the record that was judged stale, so
 * a fresh lease another process just published is never deleted. A lock is broken only when the
 * process that holds it is gone, never by age.
 */

import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";

export function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

export async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

export async function readLeaseText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

async function writeTemp(path: string, content: string): Promise<string> {
	const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	const file = await open(temp, "wx");
	try {
		await file.writeFile(content, "utf8");
	} finally {
		await file.close();
	}
	return temp;
}

/** Publish `content` at `path` only if nothing is there; throws EEXIST otherwise. Never half-written. */
export async function publishExclusive(path: string, content: string): Promise<void> {
	const temp = await writeTemp(path, content);
	try {
		await link(temp, path);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EPERM") throw error;
		// A filesystem without hard links: fall back to an exclusive create (briefly visible empty).
		const file = await open(path, "wx");
		try {
			await file.writeFile(content, "utf8");
		} finally {
			await file.close();
		}
	} finally {
		await unlinkIfPresent(temp);
	}
}

export async function publishReplace(path: string, content: string): Promise<void> {
	const temp = await writeTemp(path, content);
	try {
		await rename(temp, path);
	} catch (error) {
		await unlinkIfPresent(temp);
		throw error;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

/** True while the process that wrote this reclaim lock still runs; an unreadable lock counts as held. */
export async function reclaimLockHeld(lock: string, isAlive: (pid: number) => boolean = pidAlive): Promise<boolean> {
	const raw = await readLeaseText(lock);
	if (raw === undefined) return false;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && "pid" in parsed && typeof parsed.pid === "number") {
			return isAlive(parsed.pid);
		}
	} catch {}
	return true;
}

async function takeReclaimLock(lock: string, now: number, isAlive: (pid: number) => boolean): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await publishExclusive(lock, JSON.stringify({ pid: process.pid, atMs: now }));
			return true;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		if (await reclaimLockHeld(lock, isAlive)) return false;
		await unlinkIfPresent(lock);
	}
	return false;
}

/**
 * Remove the lease at `path` only if it still holds `inspected`: `removed`, `changed` (another
 * process replaced it meanwhile; left alone), or `busy` (another process is reclaiming right now).
 */
export async function reclaimInspected(
	path: string,
	inspected: string,
	now: number,
	isAlive: (pid: number) => boolean = pidAlive,
): Promise<"removed" | "changed" | "busy"> {
	const lock = `${path}.lock`;
	if (!(await takeReclaimLock(lock, now, isAlive))) return "busy";
	try {
		if ((await readLeaseText(path)) !== inspected) return "changed";
		await unlinkIfPresent(path);
		return "removed";
	} finally {
		await unlinkIfPresent(lock);
	}
}
