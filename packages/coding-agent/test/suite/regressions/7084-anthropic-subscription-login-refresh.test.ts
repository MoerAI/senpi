import { appendLoginSlot } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	emptyCredential,
	type LegacyAccountSlot,
	listAccounts,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import { cleanupFakeClaudeCliLogins, fakeClaudeCliLogin } from "../../support/fake-claude-cli-login.ts";

afterEach(() => cleanupFakeClaudeCliLogins());

function slot(overrides: Partial<LegacyAccountSlot> & { name: string }): LegacyAccountSlot {
	return {
		access: `${overrides.name}-access`,
		refresh: `${overrides.name}-refresh`,
		expires: Date.now() + 3_600_000,
		source: "login",
		...overrides,
	};
}

/** The sibling accounts these cases seed are token slots; a re-login must leave their tokens untouched. */
function legacyAccess(entry: AccountSlot | undefined): string | undefined {
	return entry?.store === undefined ? entry?.access : undefined;
}

function credentialWith(
	slots: AccountSlot[],
	extra?: Partial<AnthropicSubscriptionCredential>,
): AnthropicSubscriptionCredential {
	return { ...emptyCredential(), accounts: slots, ...extra };
}

const blockedDefault = slot({
	name: "default",
	blockReason: "auth_error",
	blockedUntil: Date.now() + 60_000,
	expires: Date.now() - 1_000,
});

describe("re-login refreshes the dead slot instead of appending (omo#7084)", () => {
	it("a single auth_error-blocked slot is refreshed in place and selectable again", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([blockedDefault]),
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default"]);
		expect(slots[0]?.store).toBe("claude-cli");
		expect(slots[0]?.blockReason).toBeUndefined();
		expect(slots[0]?.blockedUntil).toBeUndefined();
		expect(selectAccount(slots).name).toBe("default");
	});

	// senpi#2222 / oh-my-openagent#8673: the refresh must survive the store merge
	// Models.login persists through, not only the provider's return value.
	it("the refreshed slot survives appendLoginSlot, the persistence path Models.login uses", async () => {
		const stored = credentialWith([blockedDefault]);
		const claudeCli = fakeClaudeCliLogin();
		const config = createOAuthConfig({ readCurrent: async () => stored, claudeCli });
		const loginResult = await config.login({ onPrompt: async () => "" });
		// Models.login merges onto what the store holds under its lock at commit time, which already carries the
		// re-login's in-place write (a CLI slot has no newer `expires` for the merge to prefer).
		const atCommit = (await claudeCli.store?.().read("anthropic-subscription")) as AnthropicSubscriptionCredential;
		const persisted = appendLoginSlot(atCommit, loginResult as AnthropicSubscriptionCredential);
		const slots = listAccounts(persisted as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default"]);
		expect(slots[0]?.store).toBe("claude-cli");
		expect(slots[0]?.blockReason).toBeUndefined();
		expect(selectAccount(slots).name).toBe("default");
	});

	it("typing the existing name refreshes it instead of throwing 'already exists'", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([blockedDefault]),
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "default" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default"]);
		expect(slots[0]?.store).toBe("claude-cli");
		expect(slots[0]?.blockReason).toBeUndefined();
	});

	it("preserves the refreshed slot's displayName and leaves sibling slots untouched", async () => {
		const personal = slot({ name: "personal" });
		const dead = slot({ name: "default", blockReason: "auth_error", displayName: "Work" });
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([dead, personal]),
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "default" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default", "personal"]);
		expect(slots[0]?.displayName).toBe("Work");
		expect(slots[0]?.store).toBe("claude-cli");
		expect(slots[0]?.blockReason).toBeUndefined();
		expect(slots[1]).toEqual(personal);
	});

	it("a blank re-login in a multi-account pool targets the single auth_error-blocked slot", async () => {
		const personal = slot({ name: "personal" });
		const current = credentialWith([blockedDefault, personal], { pinned: "personal" });
		const config = createOAuthConfig({
			readCurrent: async () => current,
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default", "personal"]);
		expect(slots[0]?.store).toBe("claude-cli");
		expect(slots[0]?.blockReason).toBeUndefined();
		expect(slots[1]).toEqual(personal);
		expect((credential as AnthropicSubscriptionCredential).pinned).toBe("personal");
	});

	it("a blank re-login with no blocked slot appends instead of overwriting the newest slot", async () => {
		const work = slot({ name: "work" });
		const personal = slot({ name: "personal" });
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([work, personal]),
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["work", "personal", "account-3"]);
		expect(legacyAccess(slots[0])).toBe("work-access");
		expect(legacyAccess(slots[1])).toBe("personal-access");
	});

	it("an explicit new name still appends a separate account and keeps the sibling block", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([blockedDefault]),
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "work" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default", "work"]);
		expect(slots[0]?.blockReason).toBe("auth_error");
		expect(slots[1]?.store).toBe("claude-cli");
	});

	it("a headless re-login with a single slot refreshes it in place", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([blockedDefault]),
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({});
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default"]);
		expect(slots[0]?.store).toBe("claude-cli");
		expect(slots[0]?.blockReason).toBeUndefined();
	});

	it("a headless re-login with several working slots appends (no identity guessing)", async () => {
		const work = slot({ name: "work" });
		const personal = slot({ name: "personal" });
		const config = createOAuthConfig({
			readCurrent: async () => credentialWith([work, personal]),
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({});
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["work", "personal", "account-3"]);
		expect(legacyAccess(slots[0])).toBe("work-access");
		expect(legacyAccess(slots[1])).toBe("personal-access");
	});
});

describe("anthropic import moves the grant instead of forking it (omo#7084)", () => {
	it("accepting the import removes the anthropic provider credential", async () => {
		let removed = 0;
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			removeAnthropicCredential: async () => {
				removed++;
			},
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "y" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["imported-anthropic"]);
		expect(slots[0]?.source).toBe("import");
		expect(removed).toBe(1);
	});

	it("declining the import keeps the anthropic credential in place", async () => {
		let removed = 0;
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			removeAnthropicCredential: async () => {
				removed++;
			},
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "n" });
		const slots = listAccounts(credential as never);
		expect(slots.map((entry) => entry.name)).toEqual(["default"]);
		expect(removed).toBe(0);
	});
});

describe("AllAccountsBlockedError names the dominant block reason (omo#8383)", () => {
	it("carries auth_error when every slot is auth-blocked", () => {
		let caught: unknown;
		try {
			selectAccount([blockedDefault]);
		} catch (error) {
			caught = error;
		}
		expect((caught as { name?: string }).name).toBe("AllAccountsBlockedError");
		expect((caught as { blockReason?: string }).blockReason).toBe("auth_error");
	});

	it("carries no auth reason when another slot only waits on a deadline (senpi#2081)", () => {
		const rateLimited = slot({ name: "rl", blockedUntil: Date.now() + 60_000, blockReason: "rate_limit" });
		let caught: unknown;
		try {
			selectAccount([blockedDefault, rateLimited]);
		} catch (error) {
			caught = error;
		}
		expect((caught as { name?: string }).name).toBe("AllAccountsBlockedError");
		expect((caught as { blockReason?: string }).blockReason).toBeUndefined();
	});

	it("carries no auth reason for purely timed blocks", () => {
		const rateLimited = slot({ name: "rl", blockedUntil: Date.now() + 60_000, blockReason: "rate_limit" });
		let caught: unknown;
		try {
			selectAccount([rateLimited]);
		} catch (error) {
			caught = error;
		}
		expect((caught as { name?: string }).name).toBe("AllAccountsBlockedError");
		expect((caught as { blockReason?: string }).blockReason).toBeUndefined();
	});
});
