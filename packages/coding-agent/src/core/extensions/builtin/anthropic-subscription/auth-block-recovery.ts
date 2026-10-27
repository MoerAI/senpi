import type { CredentialStore } from "@earendil-works/pi-ai";
import { AUTH_BLOCK_REPROBE_MS } from "../../../credential-pool/auth-reprobe.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	authGrantDigest,
	type ClaudeCliAccountSlot,
	type LegacyAccountSlot,
	type SlotRefresher,
} from "./accounts.ts";

export type AuthBlockRecoveryInput = {
	readonly store: CredentialStore;
	readonly providerId: string;
	readonly accounts: readonly AccountSlot[];
	readonly refresher: SlotRefresher;
	readonly signal: AbortSignal;
	/** True when the token endpoint rejected the grant itself, not when it was throttled or unavailable. */
	readonly isGrantRejected: (error: unknown) => boolean;
	readonly reload: () => Promise<AccountSlot[]>;
	/** Whether an account can serve this request now; when none can, every recoverable account is recovered. */
	readonly isUsable: (account: AccountSlot) => boolean;
	readonly now: number;
	/**
	 * The request error for a refresh that failed for a reason other than a rejected grant (throttled,
	 * unavailable, a busy store): the slot stays blocked and the next request tries it again.
	 */
	readonly transientError: (error: unknown) => Error;
	/**
	 * Whether `claude auth status` reports a login for a `claude-cli` account (senpi#4436). Such an account
	 * holds no grant to redeem: at its re-probe time a login clears the block, anything else keeps it.
	 */
	readonly claudeCliSignedIn?: (slot: ClaudeCliAccountSlot) => Promise<boolean>;
};

/**
 * An auth-blocked slot with saved refresh material gets one recovery per grant: the grant is
 * redeemed once, and a rejected grant, or the grant a recovery produced, is never redeemed again
 * until new material arrives through a refresh rotation or a re-login (senpi#2926).
 */
export function isAuthBlockRecoverable(slot: AccountSlot): slot is LegacyAccountSlot {
	return (
		slot.store === undefined &&
		slot.blockReason === "auth_error" &&
		slot.source !== "env" &&
		slot.refresh !== "" &&
		slot.authRecoveryGrant !== authGrantDigest(slot.refresh)
	);
}

function recovered(slot: LegacyAccountSlot, refreshed: Awaited<ReturnType<SlotRefresher>>): AccountSlot {
	const { blockReason: _blockReason, blockedUntil: _blockedUntil, ...unblocked } = slot;
	return {
		...unblocked,
		access: refreshed.access,
		refresh: refreshed.refresh,
		expires: refreshed.expires,
		authRecoveryGrant: authGrantDigest(refreshed.refresh),
	};
}

async function recoverSlot(input: AuthBlockRecoveryInput, name: string): Promise<void> {
	await input.store.modify(input.providerId, async (current) => {
		if (current?.type !== "oauth") return current;
		const credential = current as AnthropicSubscriptionCredential;
		const stored = credential.accounts?.find((slot) => slot.name === name);
		if (!stored || !isAuthBlockRecoverable(stored)) return current;
		let next: AccountSlot;
		try {
			next = recovered(stored, await input.refresher(stored.refresh, input.signal));
		} catch (error) {
			input.signal.throwIfAborted();
			if (!input.isGrantRejected(error)) throw error;
			next = { ...stored, authRecoveryGrant: authGrantDigest(stored.refresh) };
		}
		return {
			...credential,
			accounts: (credential.accounts ?? []).map((slot) => (slot.name === name ? next : slot)),
		};
	});
}

/** The re-probe time passed (or the block predates re-probe times): the next request probes this account. */
function isProbeDue(slot: AccountSlot, now: number): boolean {
	return slot.blockedUntil === undefined || slot.blockedUntil <= now;
}

function isClaudeCliProbeDue(slot: AccountSlot, now: number): slot is ClaudeCliAccountSlot {
	return (
		slot.store === "claude-cli" &&
		slot.blockReason === "auth_error" &&
		slot.signInRequired === undefined &&
		isProbeDue(slot, now)
	);
}

async function probeClaudeCliSlot(
	input: AuthBlockRecoveryInput,
	slot: ClaudeCliAccountSlot,
	signedIn: (slot: ClaudeCliAccountSlot) => Promise<boolean>,
): Promise<void> {
	const loggedIn = await signedIn(slot);
	input.signal.throwIfAborted();
	await input.store.modify(input.providerId, async (current) => {
		if (current?.type !== "oauth") return current;
		const credential = current as AnthropicSubscriptionCredential;
		const stored = credential.accounts?.find((candidate) => candidate.name === slot.name);
		if (!stored || !isClaudeCliProbeDue(stored, input.now)) return current;
		const { blockReason: _reason, blockedUntil: _until, blockedAt: _at, ...unblocked } = stored;
		const next: AccountSlot = loggedIn
			? unblocked
			: {
					...stored,
					blockReason: "auth_error",
					blockedUntil: input.now + AUTH_BLOCK_REPROBE_MS,
					blockedAt: input.now,
				};
		return {
			...credential,
			accounts: (credential.accounts ?? []).map((candidate) => (candidate.name === slot.name ? next : candidate)),
		};
	});
}

/**
 * Recovers before anything probes a rejected token: an account whose auth block
 * is due for its re-probe (senpi#3264) is refreshed first, so the probe sends
 * fresh material; when no account can serve, every recoverable account is.
 */
export async function recoverAuthBlockedSlots(input: AuthBlockRecoveryInput): Promise<AccountSlot[]> {
	const recoverable = input.accounts.filter(isAuthBlockRecoverable);
	const candidates = input.accounts.some(input.isUsable)
		? recoverable.filter((slot) => isProbeDue(slot, input.now))
		: recoverable;
	const signedIn = input.claudeCliSignedIn;
	const probes = signedIn === undefined ? [] : input.accounts.filter((slot) => isClaudeCliProbeDue(slot, input.now));
	if (candidates.length === 0 && probes.length === 0) return [...input.accounts];
	let transientFailure: unknown;
	for (const candidate of candidates) {
		try {
			await recoverSlot(input, candidate.name);
		} catch (error) {
			input.signal.throwIfAborted();
			transientFailure = error;
		}
	}
	for (const probe of probes) {
		if (signedIn === undefined) break;
		try {
			await probeClaudeCliSlot(input, probe, signedIn);
		} catch (error) {
			input.signal.throwIfAborted();
			transientFailure = error;
		}
	}
	const accounts = await input.reload();
	if (transientFailure !== undefined && !accounts.some(input.isUsable)) {
		throw input.transientError(transientFailure);
	}
	return accounts;
}
