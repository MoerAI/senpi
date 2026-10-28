import type { CredentialSlot, PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "./auth-storage.ts";
import { credentialPoolRepository, getCredentialAccounts } from "./credential-accounts.ts";
import type { CredentialSlotRepository, CredentialSlotState } from "./credential-pool/state-store.ts";
import { emitProviderAccountsChanged } from "./extensions/builtin/anthropic-subscription/account-events.ts";

/** Block fields a provider lane may keep on a stored account in auth.json. */
type StoredBlockFields = { blockReason?: unknown; blockedUntil?: unknown; blockedAt?: unknown };

function liftableReason(reason: string | undefined): boolean {
	// Only a timed usage or rate-limit block is the user's to lift: a rejected credential
	// (`auth_error`) and a disabled account are cleared by a login or the re-probe, never here.
	return reason !== "auth_error" && reason !== "account_disabled";
}

function withoutAccountBlock(state: CredentialSlotState): Omit<CredentialSlotState, "stateVersion"> {
	// Everything that is not the account-level block survives: per-model usage limits
	// (senpi#2555) bind a model the user did not ask about, and a half-open lease belongs to
	// whichever turn is probing right now.
	const {
		stateVersion: _version,
		blockedUntil: _until,
		blockReason: _reason,
		failureCount: _failures,
		...rest
	} = state;
	return rest;
}

function storedSlotWithoutBlock(slot: CredentialSlot & StoredBlockFields): CredentialSlot {
	const { blockedUntil: _until, blockReason: _reason, blockedAt: _at, ...rest } = slot;
	return rest;
}

/**
 * Lifts the account-level usage or rate-limit block the user knows is gone (senpi#4600), the
 * pooled-credential counterpart of `unblockProviderAccount`. Both health sources are covered -
 * the pool sidecar and a block a provider lane stored on the account itself - and each decision
 * is taken inside that source's own locked write, so a block another session records between the
 * listing and the write is never erased. Model-scoped blocks and the slot's lease are left alone.
 * Returns whether a block was lifted.
 */
export async function unblockPooledAccount(
	storage: AuthStorage,
	provider: string,
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	repository?: CredentialSlotRepository,
): Promise<boolean> {
	const repo = repository ?? credentialPoolRepository(storage);
	const accounts = await getCredentialAccounts(storage, provider, env, repo);
	const account = accounts.find((candidate) => candidate.name === name);
	if (!account) throw new Error(`Provider account not found: ${name}`);

	let lifted = false;
	await repo.mutateSlotState(provider, account.source === "env" ? "env" : "stored", name, (current) => {
		if (current === undefined) return current;
		if (current.blockedUntil === undefined || !liftableReason(current.blockReason)) {
			const { stateVersion: _version, ...unchanged } = current;
			return unchanged;
		}
		lifted = true;
		return withoutAccountBlock(current);
	});

	if (storage.get(provider) !== undefined) {
		await storage.modify(provider, async (current) => {
			if (current === undefined) return current;
			const pooled = current as PooledCredential;
			const slots = pooled.accounts;
			if (!Array.isArray(slots)) return current;
			let changed = false;
			const next = slots.map((slot) => {
				const stored = slot as CredentialSlot & StoredBlockFields;
				if (stored.name !== name) return slot;
				if (typeof stored.blockedUntil !== "number" || !liftableReason(stored.blockReason as string | undefined)) {
					return slot;
				}
				changed = true;
				return storedSlotWithoutBlock(stored);
			});
			if (!changed) return current;
			lifted = true;
			return { ...pooled, accounts: next };
		});
	}

	if (lifted) emitProviderAccountsChanged(provider);
	return lifted;
}
