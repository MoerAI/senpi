import { createHash } from "node:crypto";
import type { Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { withoutOrderedAccount } from "@earendil-works/pi-ai/auth/pool/select";
import type { ModelBlocks } from "../../../credential-pool/model-scope.ts";

type SlotBlockState = {
	blockedUntil?: number;
	blockReason?: string;
	/** When the current block was stored, so a turn that started earlier never clears it (senpi#3462). */
	blockedAt?: number;
	/** Rate limits that bind one model family on this account, not the account (senpi#2555). */
	modelBlocks?: ModelBlocks;
};

/** A token-holding slot: an env token, or a grant from the retired senpi-owned login (removed with it, senpi#4436). */
export type LegacyAccountSlot = SlotBlockState & {
	/** Immutable operational identity, including SDK session bindings. */
	name: string;
	displayName?: string;
	store?: undefined;
	refresh: string;
	access: string;
	expires: number;
	source: "login" | "import" | "env";
	/**
	 * Digest of the grant an auth-block recovery must not redeem again: the grant the token endpoint
	 * rejected, or the grant a recovery produced, so one auth block gets at most one recovery (senpi#2926).
	 */
	authRecoveryGrant?: string;
	/** Digest of the `anthropic` OAuth grant this account was copied from (senpi#3259), so the copy runs once. */
	importedFrom?: string;
};

/** The local-only profile `claude auth status` reported; never logged or sent to telemetry. */
export type ClaudeCliAccountProfile = {
	email?: string;
	orgName?: string;
	subscriptionType?: string;
	checkedAt: number;
};

/** The sign-in connection test's last result. */
export type ClaudeCliAccountCheck = {
	model: string;
	outcome: "ok" | "failed";
	reason?: string;
	at: number;
};

/**
 * An account signed in through the bundled `claude` CLI (senpi#4436). It holds no token: the CLI keeps the
 * login in its own credential store, keyed on the account dir `accountDirFor(agentDir, dirId)`.
 */
export type ClaudeCliAccountSlot = SlotBlockState & {
	name: string;
	displayName?: string;
	source: "login";
	store: "claude-cli";
	/** 32 hex chars, fixed at creation. */
	dirId: string;
	signedInAt?: number;
	profile?: ClaudeCliAccountProfile;
	check?: ClaudeCliAccountCheck;
	signInRequired?: "legacy_sign_in_retired";
};

export type AccountSlot = LegacyAccountSlot | ClaudeCliAccountSlot;

export type SlotState = Record<
	string,
	{ blockedUntil?: number; blockReason?: string; blockedAt?: number; modelBlocks?: ModelBlocks }
>;

export type AnthropicSubscriptionCredential = OAuthCredential & {
	accounts?: AccountSlot[];
	pinned?: string;
	order?: string[];
	slotState?: SlotState;
};

export const SENTINEL_OAUTH_FIELDS = {
	access: "claude-sdk-oauth-managed",
	refresh: "claude-sdk-oauth-managed",
	expires: 4102444800000,
} as const;

export function emptyCredential(): AnthropicSubscriptionCredential {
	return { type: "oauth", ...SENTINEL_OAUTH_FIELDS, accounts: [] };
}

function storedSlots(credential: AnthropicSubscriptionCredential): AccountSlot[] {
	return credential.accounts ?? [];
}

/**
 * A stored account whose material is the managed sentinel holds no token at
 * all: it was written by a build that stored this credential's own flat
 * projection as a generated `login-N` slot. Selecting it fails the provider's
 * auth check and dead-ends the request, so it is never listed as an account.
 */
export function isSentinelSlot(slot: AccountSlot): boolean {
	return (
		slot.store === undefined &&
		slot.access === SENTINEL_OAUTH_FIELDS.access &&
		slot.refresh === SENTINEL_OAUTH_FIELDS.refresh
	);
}

/** A stable, non-reversible name for a refresh token, safe to persist next to it. */
export function authGrantDigest(refresh: string): string {
	return createHash("sha256").update(refresh).digest("hex").slice(0, 32);
}

export function listAccounts(
	credential: AnthropicSubscriptionCredential,
	env?: (name: string) => string | undefined,
): AccountSlot[] {
	const slots = storedSlots(credential).filter((slot) => !isSentinelSlot(slot));
	if (env) {
		const state = credential.slotState ?? {};
		for (const slot of envSlots(env)) {
			const persisted = state[slot.name];
			slots.push(persisted ? { ...slot, ...persisted } : slot);
		}
	}
	return slots;
}

const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidAccountName(name: string): void {
	if (!ACCOUNT_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid account name '${name}': use letters, digits, '-' or '_', starting with a letter or digit`,
		);
	}
}

export function addAccount(
	credential: AnthropicSubscriptionCredential,
	slot: AccountSlot,
): AnthropicSubscriptionCredential {
	assertValidAccountName(slot.name);
	if (storedSlots(credential).some((existing) => existing.name === slot.name)) {
		throw new Error(`Account '${slot.name}' already exists`);
	}
	return { ...credential, accounts: [...storedSlots(credential), slot] };
}

/**
 * Re-login recovery (omo#7084): a same-name slot is replaced in place — fresh
 * token material and source, block stamps cleared, displayName preserved — so
 * a successful login lifts the slot's `auth_error` lock. Unknown names append.
 */
export function upsertAccount(
	credential: AnthropicSubscriptionCredential,
	slot: LegacyAccountSlot,
): AnthropicSubscriptionCredential {
	assertValidAccountName(slot.name);
	const existing = storedSlots(credential).find((candidate) => candidate.name === slot.name);
	if (!existing) return { ...credential, accounts: [...storedSlots(credential), slot] };
	if (existing.store !== undefined) {
		const replaced: AccountSlot =
			existing.displayName === undefined ? slot : { ...slot, displayName: existing.displayName };
		return {
			...credential,
			accounts: storedSlots(credential).map((candidate) => (candidate.name === slot.name ? replaced : candidate)),
		};
	}
	const {
		blockedUntil: _blockedUntil,
		blockReason: _blockReason,
		blockedAt: _blockedAt,
		modelBlocks: _modelBlocks,
		authRecoveryGrant: _authRecoveryGrant,
		...identity
	} = existing;
	const refreshed: AccountSlot = {
		...identity,
		access: slot.access,
		refresh: slot.refresh,
		expires: slot.expires,
		source: slot.source,
	};
	return {
		...credential,
		accounts: storedSlots(credential).map((candidate) => (candidate.name === slot.name ? refreshed : candidate)),
	};
}

export function removeAccount(
	credential: AnthropicSubscriptionCredential,
	name: string,
): AnthropicSubscriptionCredential {
	const accounts = storedSlots(credential).filter((slot) => slot.name !== name);
	const next: AnthropicSubscriptionCredential = { ...credential, accounts };
	if (credential.pinned === name) delete next.pinned;
	return withoutOrderedAccount(next, name);
}

export function pinAccount(credential: AnthropicSubscriptionCredential, name: string): AnthropicSubscriptionCredential {
	return { ...credential, pinned: name };
}

export function assertSentinelInvariant(credential: AnthropicSubscriptionCredential): void {
	if (
		credential.access !== SENTINEL_OAUTH_FIELDS.access ||
		credential.refresh !== SENTINEL_OAUTH_FIELDS.refresh ||
		credential.expires !== SENTINEL_OAUTH_FIELDS.expires
	) {
		throw new Error("top-level OAuth fields must remain sentinel values");
	}
}

export function envSlots(env: (name: string) => string | undefined): LegacyAccountSlot[] {
	const slots: LegacyAccountSlot[] = [];
	const read = (suffix: string | undefined) =>
		env(suffix === undefined ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${suffix}`);
	const names: Array<{ suffix?: string; slot: string }> = [{ slot: "env" }];
	for (let index = 2; index <= 16; index++) names.push({ suffix: String(index), slot: `env-${index}` });
	for (const { suffix, slot } of names) {
		const token = read(suffix);
		if (token) {
			slots.push({ name: slot, refresh: "", access: "", expires: 0, source: "env" });
		}
	}
	return slots;
}

export function envSlotToken(env: (name: string) => string | undefined, slotName: string): string | undefined {
	const match = /^env(?:-(\d+))?$/.exec(slotName);
	if (!match) return undefined;
	const suffix = match[1];
	return env(suffix === undefined ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${suffix}`);
}

export type SlotRefresher = (
	refreshToken: string,
	signal: AbortSignal,
) => Promise<{ refresh: string; access: string; expires: number }>;
export type SlotExpirationCheck = (expires: number) => boolean;

export async function refreshSlot(
	store: CredentialStore,
	providerId: string,
	slotName: string,
	refresher: SlotRefresher,
	signal: AbortSignal,
	isExpiring: SlotExpirationCheck = (expires) => Date.now() >= expires,
): Promise<Credential | undefined> {
	return store.modify(providerId, async (current) => {
		if (current?.type !== "oauth") return undefined;
		const credential = current as AnthropicSubscriptionCredential;
		const slot = storedSlots(credential).find((candidate) => candidate.name === slotName);
		if (!slot || slot.store !== undefined) return current;
		if (!isExpiring(slot.expires)) return current;
		const refreshed = await refresher(slot.refresh, signal);
		const accounts = storedSlots(credential).map((candidate) =>
			candidate.name === slotName
				? { ...candidate, refresh: refreshed.refresh, access: refreshed.access, expires: refreshed.expires }
				: candidate,
		);
		return { ...credential, accounts };
	});
}
