import { afterEach, describe, expect, it } from "vitest";
import { listAccounts, SENTINEL_OAUTH_FIELDS } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import { authContext } from "./support/anthropic-subscription-provider.ts";
import { cleanupFakeClaudeCliLogins, fakeClaudeCliLogin } from "./support/fake-claude-cli-login.ts";

afterEach(() => cleanupFakeClaudeCliLogins());

describe("claude-sdk-oauth oauth login config", () => {
	it("offers the existing anthropic credential as an import before a fresh login", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "y" });
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["imported-anthropic"]);
		expect(slots[0]?.source).toBe("import");
	});

	it("declining the import falls through to a fresh login without the import slot", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			claudeCli: fakeClaudeCliLogin(),
		});
		const prompts: string[] = [];
		const credential = await config.login({
			onPrompt: async (prompt) => {
				prompts.push(prompt.message);
				return prompts.length === 1 ? "n" : "work";
			},
		});
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
		expect(slots.every((slot) => slot.source !== "import")).toBe(true);
	});

	it("second login adds a prompted account name without dropping slots", async () => {
		const existing = await createOAuthConfig({
			readCurrent: async () => undefined,
			claudeCli: fakeClaudeCliLogin(),
		}).login({});
		const config = createOAuthConfig({
			readCurrent: async () => existing as never,
			claudeCli: fakeClaudeCliLogin(),
		});
		const credential = await config.login({ onPrompt: async () => "work" });
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(slots[1]?.store).toBe("claude-cli");
	});

	it("keeps sentinel top-level fields and sentinel getApiKey", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });
		const credential = await config.login({});
		expect((credential as { access: string }).access).toBe(SENTINEL_OAUTH_FIELDS.access);
		expect(config.getApiKey(credential)).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("an aborted login signal cancels the Claude CLI sign-in", async () => {
		const controller = new AbortController();
		controller.abort();
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });

		await expect(config.login({ signal: controller.signal })).rejects.toThrow("Login cancelled");
	});

	it("refreshToken is a preserving no-op", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });
		const credential = await config.login({});
		expect(await config.refreshToken(credential)).toBe(credential);
	});

	it("check accepts a concrete oauth slot projected by credential rotation", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });

		const check = await config.check({
			ctx: authContext(),
			credential: { type: "oauth", access: "slot-access", refresh: "slot-refresh", expires: Date.now() + 60_000 },
		});

		expect(check).toEqual({ source: "Anthropic Subscription", type: "oauth" });
	});

	it("check still rejects a projected sentinel that names no account", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });

		const check = await config.check({ ctx: authContext(), credential: { type: "oauth", ...SENTINEL_OAUTH_FIELDS } });

		expect(check).toBeUndefined();
	});
});
