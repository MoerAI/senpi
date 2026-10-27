/**
 * Which sessions have an agent run in progress, from the host child's events. A run emits
 * `agent_start` on every loop iteration (a provider retry, a post-compaction continue, a follow-up)
 * but `agent_settled` once, so this tracks runs, not starts: a repeated start for a running session
 * changes nothing. A session that closes is dropped even if its settle never arrives (#2713). A settled run stays busy
 * until `agent_idle`, because its extension agent_settled handlers may still be running (omo#11419).
 */
export class SessionRunActivity {
	readonly #running = new Set<string>();

	/** Applies one host event line; true when it is a run or session event the idle decision must re-read. */
	observe(line: string): boolean {
		const event = parseHostEvent(line);
		if (event === undefined) return false;
		if (event.type === "agent_start") this.#running.add(event.sessionId);
		// agent_settled reaches clients before its extension handlers finish (omo#11419): the session is quiet only at
		// agent_idle, or when it closed (a seal's owed settle says so with reason session_closed).
		else if (event.type === "agent_settled" && event.reason !== "session_closed") return true;
		else if (event.type === "agent_settled" || event.type === "agent_idle" || event.type === "session_closed")
			this.#running.delete(event.sessionId);
		else return false;
		return true;
	}

	get busySessions(): number {
		return this.#running.size;
	}
}

function parseHostEvent(
	line: string,
): { readonly type: unknown; readonly sessionId: string; readonly reason: unknown } | undefined {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof event !== "object" || event === null) return undefined;
	const { type, sessionId, reason } = event as { type?: unknown; sessionId?: unknown; reason?: unknown };
	return typeof sessionId === "string" ? { type, sessionId, reason } : undefined;
}
