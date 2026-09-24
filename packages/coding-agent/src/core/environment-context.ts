/**
 * Environment context (working directory + current date) delivered to the
 * model as an append-only, hidden user-role custom message instead of as
 * system prompt text (senpi#2093).
 *
 * A date or cwd line inside the system prompt rewrites the provider-visible
 * prefix every day and in every directory, so automatic prefix caches
 * (OpenAI, Anthropic, and the rest) miss the whole system prompt and
 * everything after it. Carrying the values in a message placed before the
 * next user turn keeps the system prompt byte-stable; a new message is
 * appended only when a value changes, and earlier ones are never rewritten.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CustomMessage } from "./messages.ts";

export const ENVIRONMENT_CONTEXT_MESSAGE_TYPE = "environment-context";

export interface EnvironmentContext {
	/** Working directory with `/` separators. */
	cwd: string;
	/** UTC calendar date, `YYYY-MM-DD`. */
	currentDate: string;
}

export function resolveEnvironmentContext(cwd: string, now: Date = new Date()): EnvironmentContext {
	return { cwd: cwd.replace(/\\/g, "/"), currentDate: now.toISOString().slice(0, 10) };
}

export function formatEnvironmentContext(context: EnvironmentContext): string {
	return [
		"<environment_context>",
		`  <cwd>${context.cwd}</cwd>`,
		`  <current_date>${context.currentDate}</current_date>`,
		"</environment_context>",
	].join("\n");
}

function isEnvironmentContext(value: unknown): value is EnvironmentContext {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.cwd === "string" && typeof candidate.currentDate === "string";
}

export function latestEnvironmentContext(messages: readonly AgentMessage[]): EnvironmentContext | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message.role === "custom" &&
			message.customType === ENVIRONMENT_CONTEXT_MESSAGE_TYPE &&
			isEnvironmentContext(message.details)
		) {
			return message.details;
		}
	}
	return undefined;
}

export function createEnvironmentContextMessage(
	context: EnvironmentContext,
	timestamp: number = Date.now(),
): CustomMessage<EnvironmentContext> {
	return {
		role: "custom",
		customType: ENVIRONMENT_CONTEXT_MESSAGE_TYPE,
		content: formatEnvironmentContext(context),
		display: false,
		details: { cwd: context.cwd, currentDate: context.currentDate },
		timestamp,
	};
}

/**
 * A new environment context message when `current` differs from the latest
 * one in `messages` (or none is visible, e.g. a fresh session or a compaction
 * that summarized it away); `undefined` when the model already sees it.
 */
export function environmentContextMessageIfChanged(
	messages: readonly AgentMessage[],
	current: EnvironmentContext,
): CustomMessage<EnvironmentContext> | undefined {
	const latest = latestEnvironmentContext(messages);
	if (latest?.cwd === current.cwd && latest.currentDate === current.currentDate) return undefined;
	return createEnvironmentContextMessage(current);
}
