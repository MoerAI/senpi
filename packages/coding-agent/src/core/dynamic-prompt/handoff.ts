export function buildHandoffSection(): string {
	return `## Handoff

A handoff is the start of a turn, each todo phase change, a blocker or plan change, and the final message. Before writing one, weigh what the user originally asked for and what they would want to know right now; then state it in one short block:

> Ask: [the user's original request] - wanted: [the outcome they asked for]. For you: [what they need to know now - ledger N/M done, findings, blockers]. Now: [the todo task in progress]. Next: [the next open task].

Now and Next are the todo labels verbatim. The Next you name is executed in this same response with tool calls; a Next with nothing after it is a defect. Between handoffs, work without narration.`;
}
