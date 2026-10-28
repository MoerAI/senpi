import type { Credential, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { appendLoginSlot, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnthropicSubscriptionCredential,
	emptyCredential as emptyAnthropicCredential,
	listAccounts as listAnthropicAccounts,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { createOAuthConfig as createAnthropicOAuthConfig } from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import {
	type CursorCliOauthCredential,
	emptyCredential as emptyCursorCredential,
} from "../../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import { createCursorCliOauthConfig } from "../../../src/core/extensions/builtin/cursor-cli-oauth/oauth-login.ts";
import { cleanupFakeClaudeCliLogins, fakeClaudeCliLogin } from "../../support/fake-claude-cli-login.ts";

afterEach(() => cleanupFakeClaudeCliLogins());

// senpi#3619: a blank or headless login next to ONE healthy account must add a
// second account. Only an auth_error-blocked slot (or a slot the user names) is
// a recovery target. Every OAuth login path that stores accounts is swept here.
// A Claude login signs in through the Claude CLI (senpi#4436), so its new
// account is a CLI slot rather than the fake flow's tokens.

type Slot = { name: string; access: string; refresh: string; expires: number };

const EXPIRES = 4_000_000_000_000;
const healthy: Slot & { source: "login" } = {
	name: "default",
	access: "first-access",
	refresh: "first-refresh",
	expires: EXPIRES,
	source: "login",
};
const second = { access: "second-access", refresh: "second-refresh", expires: EXPIRES + 1 };

function fakeFlow(): OAuthAuth {
	return {
		name: "fake",
		async login(): Promise<OAuthCredential> {
			return { type: "oauth", ...second };
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

function slotsOf(credential: Credential): Slot[] {
	const accounts = (credential as PooledCredential).accounts;
	if (Array.isArray(accounts)) return accounts as Slot[];
	const flat = credential as OAuthCredential;
	return [{ name: "default", access: flat.access, refresh: flat.refresh, expires: flat.expires }];
}

type Row = {
	provider: string;
	mode: "blank" | "headless" | "named";
	login(): Promise<Credential>;
	/** What the new second account holds: the fake flow's tokens, or a Claude CLI slot. */
	added: Record<string, unknown>;
};

const cliSlot = { store: "claude-cli" };

/**
 * Persists a re-login the way Models.login does: merged onto what the store holds at commit time, which already
 * carries the CLI sign-in's in-place write (as in the omo#7084 regression).
 */
async function refreshedSlots(stored: AnthropicSubscriptionCredential, mode: "blank" | "headless" | "named") {
	const claudeCli = fakeClaudeCliLogin();
	const config = createAnthropicOAuthConfig({ readCurrent: async () => stored, claudeCli });
	const callbacks =
		mode === "blank" ? { onPrompt: async () => "" } : mode === "named" ? { onPrompt: async () => "default" } : {};
	const result = await config.login(callbacks);
	const atCommit = (await claudeCli.store?.().read("anthropic-subscription")) as AnthropicSubscriptionCredential;
	return listAnthropicAccounts(appendLoginSlot(atCommit, result as AnthropicSubscriptionCredential) as never);
}

const anthropicStored = (): AnthropicSubscriptionCredential => ({ ...emptyAnthropicCredential(), accounts: [healthy] });

async function anthropicLogin(mode: Row["mode"]): Promise<Credential> {
	const stored = anthropicStored();
	const config = createAnthropicOAuthConfig({ readCurrent: async () => stored, claudeCli: fakeClaudeCliLogin() });
	const callbacks =
		mode === "blank" ? { onPrompt: async () => "" } : mode === "named" ? { onPrompt: async () => "work" } : {};
	const result = await config.login(callbacks);
	return appendLoginSlot(stored, result as AnthropicSubscriptionCredential);
}

async function cursorLogin(): Promise<Credential> {
	const stored: CursorCliOauthCredential = { ...emptyCursorCredential(), accounts: [healthy] };
	const config = createCursorCliOauthConfig({
		readCurrent: async () => stored,
		readSettings: () => ({ enabled: true, executablePath: undefined }),
		resolveExecutable: () => "/usr/local/bin/cursor-agent",
		loadOAuth: async () => fakeFlow(),
	});
	const result = await config.login({
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onSelect: async () => undefined,
	});
	return appendLoginSlot(stored as PooledCredential, result as Credential);
}

async function pooledLogin(): Promise<Credential> {
	// Providers without their own account store (ChatGPT, Copilot, ...) persist a flat login.
	const stored: PooledCredential = {
		type: "oauth",
		access: healthy.access,
		refresh: healthy.refresh,
		expires: healthy.expires,
	};
	return appendLoginSlot(stored, { type: "oauth", ...second });
}

const rows: Row[] = [
	{ provider: "anthropic-subscription", mode: "blank", login: () => anthropicLogin("blank"), added: cliSlot },
	{ provider: "anthropic-subscription", mode: "headless", login: () => anthropicLogin("headless"), added: cliSlot },
	{
		provider: "anthropic-subscription",
		mode: "named",
		login: () => anthropicLogin("named"),
		added: { ...cliSlot, name: "work" },
	},
	{ provider: "cursor-cli-oauth", mode: "blank", login: cursorLogin, added: second },
	{ provider: "generic credential pool", mode: "headless", login: pooledLogin, added: second },
];

describe("a login next to one healthy account adds a second account (senpi#3619)", () => {
	it.each(rows)("$provider, $mode login: two accounts, the first unchanged", async ({ login, added }) => {
		const slots = slotsOf(await login());
		expect(slots).toHaveLength(2);
		expect(slots[0]).toMatchObject({
			name: "default",
			access: healthy.access,
			refresh: healthy.refresh,
			expires: healthy.expires,
		});
		expect(slots[1]).toMatchObject(added);
		expect(slots[1]?.name).not.toBe("default");
	});
});

describe("the omo#7084 recovery still refreshes a lone auth-blocked Claude account", () => {
	it.each(["blank", "headless"] as const)("%s login refreshes the blocked slot in place", async (mode) => {
		const blocked = { ...healthy, blockReason: "auth_error" as const, blockedUntil: Date.now() + 60_000 };
		const stored: AnthropicSubscriptionCredential = { ...emptyAnthropicCredential(), accounts: [blocked] };
		const slots = await refreshedSlots(stored, mode);
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
		expect(slots[0]).toMatchObject(cliSlot);
		expect(slots[0]?.blockReason).toBeUndefined();
	});

	it("typing the healthy slot's name still refreshes it in place", async () => {
		const slots = await refreshedSlots(anthropicStored(), "named");
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
		expect(slots[0]).toMatchObject(cliSlot);
	});
});
