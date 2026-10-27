import type { AccountSlot } from "./accounts.ts";

/** The one prompt every surface shows for accounts from the retired sign-in (senpi#4436): notice, turn error, docs. */
export function signInAgainMessage(names: readonly string[]): string {
	return `Claude sign-in changed. Sign in again with Claude to keep using: ${names.join(", ")}. Run /login anthropic-subscription.`;
}

export function signInRequiredNames(accounts: readonly AccountSlot[]): string[] {
	return accounts.filter((slot) => slot.store === "claude-cli" && slot.signInRequired).map((slot) => slot.name);
}

/** A turn found only accounts that must sign in again; the message is the prompt, prefixed so it classifies as auth. */
export class ClaudeSignInRequiredError extends Error {
	readonly accountNames: readonly string[];

	constructor(accountNames: readonly string[]) {
		super(`authentication_failed: ${signInAgainMessage(accountNames)}`);
		this.name = "ClaudeSignInRequiredError";
		this.accountNames = accountNames;
	}
}
