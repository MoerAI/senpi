export interface HandoffSectionOptions {
	/**
	 * The caller's core already states a text-only turn-end rule ("check your last paragraph"),
	 * so the block drops its own "a Next with nothing after it is a defect" clause instead of
	 * stating that rule twice.
	 */
	turnEndRuleStatedElsewhere?: boolean;
}

export function buildHandoffSection(options: HandoffSectionOptions = {}): string {
	const nextRule = options.turnEndRuleStatedElsewhere
		? "The Next you name is executed in this same response with tool calls."
		: "The Next you name is executed in this same response with tool calls; a Next with nothing after it is a defect.";
	return `## Handoff

A handoff is the first message after the todo list exists, each todo phase change, a blocker or plan change, and the final message; the routing line is not one. Before writing one, weigh what the user originally asked for and what they would want to know right now; then state it in one short block:

> Ask: [the user's original request] - wanted: [the outcome they asked for]. For you: [what they need to know now - ledger N/M done, findings, blockers]. Now: [the todo task in progress]. Next: [the next open task].

Now and Next are the todo labels verbatim. ${nextRule} Between handoffs, work without narration.`;
}
