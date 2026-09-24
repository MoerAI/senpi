/**
 * File-level primitives for the terminal lease. A lease file is never visible half-written: it is
 * written to a private temp file first and then published with `link` (exclusive: fails with
 * EEXIST when a lease exists) or `rename` (replace). Reclaiming a stale lease happens under an
 * exclusive `<lease>.lock`, and only removes the file when it still holds exactly the record that
 * was judged stale, so a fresh lease another process just published is never deleted.
 */

import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";

/** A reclaim holds the lock for a few file operations; a lock older than this was left by a crash. */
export const RECLAIM_LOCK_STALE_MS = 10_000;

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

async function takeReclaimLock(lock: string, now: number): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await publishExclusive(lock, JSON.stringify({ pid: process.pid, atMs: now }));
			return true;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		const held = await stat(lock).catch((error: unknown) => {
			if (errorCode(error) === "ENOENT") return undefined;
			throw error;
		});
		if (held !== undefined && now - held.mtimeMs < RECLAIM_LOCK_STALE_MS) return false;
		await unlinkIfPresent(lock);
	}
	return false;
}

/**
 * Remove the lease at `path` only if it still holds `inspected`. Returns false when another
 * process is reclaiming right now (the caller re-reads and decides again).
 */
export async function reclaimInspected(path: string, inspected: string, now: number): Promise<boolean> {
	const lock = `${path}.lock`;
	if (!(await takeReclaimLock(lock, now))) return false;
	try {
		if ((await readLeaseText(path)) === inspected) await unlinkIfPresent(path);
		return true;
	} finally {
		await unlinkIfPresent(lock);
	}
}
