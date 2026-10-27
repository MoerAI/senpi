/**
 * senpi#4436 (S7): Claude sign-in runs through the bundled Claude Code CLI, so senpi ships no Anthropic OAuth
 * flow of its own: no PKCE login, no copy-code login, no loopback callback listener, no token refresh.
 */
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as loaderModule from "../src/auth/oauth/load.ts";
import { registerBunOAuthFlows } from "../src/bun-oauth.ts";
import * as oauthEntry from "../src/oauth.ts";

const registered = vi.hoisted(() => ({ loaders: undefined as Record<string, unknown> | undefined }));

vi.mock("../src/auth/oauth/load.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/auth/oauth/load.ts")>()),
	registerBundledOAuthFlowLoaders: (loaders: Record<string, unknown>) => {
		registered.loaders = loaders;
	},
}));

function sourceFile(relative: string): string {
	return fileURLToPath(new URL(relative, import.meta.url));
}

describe("senpi#4436 the bundled OAuth loaders expose no anthropic flow", () => {
	it("registers no anthropic loader in the standalone binary", () => {
		registerBunOAuthFlows();
		expect(registered.loaders).toBeDefined();
		expect(Object.keys(registered.loaders ?? {})).not.toContain("anthropic");
		expect(Object.keys(registered.loaders ?? {})).toContain("chatgptSubscription");
	});

	it("exports no anthropic loader from the loader module or the oauth entry point", () => {
		const anthropicExports = (module: object) => Object.keys(module).filter((name) => /anthropic/i.test(name));
		expect(anthropicExports(loaderModule)).toEqual([]);
		expect(anthropicExports(oauthEntry)).toEqual([]);
		expect(Object.keys(oauthEntry)).toContain("registerBundledOAuthFlowLoaders");
	});

	it("ships no Anthropic flow module and nothing that binds a callback port for Anthropic", () => {
		expect(readdirSync(sourceFile("../src/auth/oauth/")).filter((file) => file.startsWith("anthropic"))).toEqual([]);
		// The PKCE helper stays: other providers' logins still use it.
		expect(existsSync(sourceFile("../src/auth/oauth/pkce.ts"))).toBe(true);
	});
});
