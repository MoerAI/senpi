import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../messages.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import type { Goal } from "./types.ts";

/**
 * Goal turns the same blocking condition must survive before `blocked` describes
 * an impasse rather than one failed approach. Mirrors codex `ext/goal`
 * (`templates/goals/continuation.md`): "at least three consecutive goal turns,
 * counting the original/user-triggered turn and any automatic continuations".
 */
export const GOAL_BLOCKED_MIN_GOAL_TURNS = 3;

/**
 * Goal turns spent on the current blocker: the turn calling `update_goal` plus
 * every continuation delivered since the goal last became active. A real user
 * message restarts it the way a resume does. Counting delivered continuation
 * entries keeps the number derived from the branch, never from model narration.
 */
export function goalTurnsSinceActivation(entries: readonly SessionEntry[], goal: Goal): number {
	const activatedAtMs = (goal.lastStartedAt ?? goal.createdAt) * 1000;
	let continuations = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === undefined) continue;
		const entryMs = entryTimestampMs(entry);
		if (entryMs !== undefined && entryMs < activatedAtMs) break;
		if (entry.type === "message" && entry.message.role === "user") break;
		if (entry.type === "custom_message" && entry.customType === GOAL_CONTINUATION_MESSAGE_TYPE) continuations += 1;
	}
	return continuations + 1;
}

export function liveResumptionChannelBlockError(sources: readonly string[]): string {
	return (
		`cannot mark the goal blocked while these resumption channels can still deliver: ${sources.join(", ")}. ` +
		"A pending delivery is a wait, not an impasse: end the turn and let the channel wake the goal, " +
		"or inspect it now and stop it if it can no longer deliver what the objective is waiting on."
	);
}

export function goalTurnFloorBlockError(goalTurns: number): string {
	return (
		`cannot mark the goal blocked on goal turn ${goalTurns} of ${GOAL_BLOCKED_MIN_GOAL_TURNS}: ` +
		"one failing approach is not an impasse, and there is no limit on how many times you may try. " +
		"Take a materially different attempt now - a different source, namespace, tool, or assumption, " +
		"never the same lookup that already came back empty - or ask the user through the question tool " +
		"when only they can supply the missing decision. The goal stays active either way."
	);
}

function entryTimestampMs(entry: SessionEntry): number | undefined {
	const timestamp = (entry as { timestamp?: unknown }).timestamp;
	if (typeof timestamp !== "string") return undefined;
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}
