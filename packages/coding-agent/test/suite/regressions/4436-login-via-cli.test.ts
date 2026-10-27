/**
 * senpi#4436 (S5): `/login anthropic-subscription` signs in through `claude auth login --claudeai` into the
 * account's own config dir, stores a CLI-store slot with the profile `claude auth status` reports, keeps the
 * prompt titles clients match, and runs one pinned connection-test turn on the default profile's Claude model.
 */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AccountSlot,
	AnthropicSubscriptionCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { overrideAuthLaneBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { connectionTestModel } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-connection-test.ts";
import { takeClaudeCliLoginOutcome } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-login-outcome.ts";
import {
	createOAuthConfig,
	type OAuthLoginCallbacks,
} from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import type { Options, SdkQuery } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { overrideSdkBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { resetScriptedSdk, SCRIPTED_PROVIDER, sdkMessage } from "../../helpers/anthropic-subscription-scripted-sdk.ts";

const FIXTURE = join(import.meta.dirname, "..", "..", "fixtures", "claude-cli-auth", "fake-claude.mjs");
const DEFAULTS = { provider: "anthropic-subscription", model: "claude-sonnet-5-5" };
// Desktop machine values (omoLoginDialogs.ts), copied as literals so a rename here fails this test.
const DESKTOP_METHOD_TITLE = "Select Anthropic login method:";
const DESKTOP_METHOD_LABELS = ["Browser login (default)", "Copy code login (headless)"];
const DESKTOP_NAME_PREFIX = "Name for this account (";
const DESKTOP_PASTE_TITLE = "Paste the code Anthropic shows after you sign in:";

const roots: string[] = [];

afterEach(() => {
	resetScriptedSdk();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Recorded = { argv?: string[]; configDir?: string; stdin?: string };
type Turn = "ok" | "auth_error";

function cliSlot(name: string, dirId: string, extra: Record<string, unknown> = {}): AccountSlot {
	return { name, source: "login", store: "claude-cli", dirId, ...extra } as AccountSlot;
}

async function setup(options: {
	mode?: string;
	slots?: AccountSlot[];
	pinned?: string;
	order?: string[];
	turn?: Turn;
}) {
	const root = mkdtempSync(join(tmpdir(), "senpi-4436-login-via-cli-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sharedRoot = join(root, "shared-claude");
	mkdirSync(agentDir);
	mkdirSync(sharedRoot);
	const executable = join(root, "claude");
	copyFileSync(FIXTURE, executable);
	chmodSync(executable, 0o755);
	const recordPath = join(root, "record.jsonl");
	const store = new InMemoryCredentialStore();
	if (options.slots) {
		await store.modify(SCRIPTED_PROVIDER, async () => ({
			...options.slots!.reduce<AnthropicSubscriptionCredential>(addAccount, emptyCredential()),
			...(options.pinned === undefined ? {} : { pinned: options.pinned }),
			...(options.order === undefined ? {} : { order: options.order }),
		}));
	}
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({
			PATH: process.env.PATH ?? "/usr/bin",
			HOME: root,
			CLAUDE_CONFIG_DIR: sharedRoot,
			FAKE_CLAUDE_MODE: options.mode ?? "login-auto",
			FAKE_CLAUDE_STATUS_MODE: "status-claudeai",
			FAKE_CLAUDE_RECORD: recordPath,
		}),
		getAgentDir: () => agentDir,
	});
	const queries: Options[] = [];
	const query: SdkQuery = ({ options: queryOptions }) => {
		queries.push(queryOptions ?? {});
		const messages =
			options.turn === "auth_error"
				? [
						sdkMessage({
							type: "assistant",
							error: "authentication_failed",
							message: {
								id: "m",
								type: "message",
								role: "assistant",
								content: [{ type: "text", text: "Invalid" }],
							},
							parent_tool_use_id: null,
							uuid: "a",
							session_id: "s",
						}),
					]
				: [sdkMessage({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "s" })];
		const iterator = messages[Symbol.iterator]();
		return Object.assign(
			{
				[Symbol.asyncIterator]() {
					return this;
				},
				async next() {
					return iterator.next();
				},
				async interrupt() {
					return {};
				},
				close() {},
				async initializationResult() {
					return {
						account: {
							tokenSource: "none",
							apiProvider: "firstParty",
							email: "user@example.com",
							organization: "Fixture Org",
							subscriptionType: "max",
						},
					};
				},
			},
			{},
		) as unknown as ReturnType<SdkQuery>;
	};
	overrideSdkBoundary({ query });
	const loginFlow = { name: "pkce-spy", login: vi.fn(), refresh: vi.fn(), toAuth: vi.fn() };
	const config = createOAuthConfig({
		readCurrent: async () => (await store.read(SCRIPTED_PROVIDER)) as AnthropicSubscriptionCredential | undefined,
		loginFlow,
		claudeCli: { executable: () => executable, defaultModel: () => DEFAULTS, cwd: () => root },
	} as Parameters<typeof createOAuthConfig>[0]);
	const records = (): Recorded[] =>
		existsSync(recordPath)
			? readFileSync(recordPath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Recorded)
			: [];
	const slots = async () =>
		((await store.read(SCRIPTED_PROVIDER)) as AnthropicSubscriptionCredential | undefined)?.accounts ?? [];
	const accountDirs = () => {
		const parent = join(agentDir, "anthropic-subscription-claude");
		return existsSync(parent) ? readdirSync(parent) : [];
	};
	return { agentDir, config, loginFlow, records, slots, store, queries, accountDirs };
}

function heldOpen(prompt: { signal?: AbortSignal }): Promise<string> {
	return new Promise((_resolve, reject) =>
		prompt.signal?.addEventListener("abort", () => reject(new Error("released")), { once: true }),
	);
}

describe("senpi#4436 sign-in runs claude auth login, then the connection test", () => {
	it("T1 login never calls the hand-rolled flow", async () => {
		const lane = await setup({});
		await lane.config.login({ onPrompt: heldOpen });
		expect(lane.loginFlow.login).not.toHaveBeenCalled();
		const login = lane.records().find((record) => record.argv?.[1] === "login");
		expect(login?.argv).toEqual(["auth", "login", "--claudeai"]);
		expect(login?.configDir).toContain(join(lane.agentDir, "anthropic-subscription-claude"));
	});

	it("T2 the produced slot is store claude-cli with profile from auth status", async () => {
		const lane = await setup({});
		const signal = new AbortController().signal;
		const credential = (await lane.config.login({ onPrompt: heldOpen, signal })) as AnthropicSubscriptionCredential;
		const [slot] = credential.accounts ?? [];
		expect(slot).toMatchObject({
			name: "default",
			source: "login",
			store: "claude-cli",
			profile: { email: "user@example.com", orgName: "Fixture Org", subscriptionType: "max" },
		});
		expect(slot?.store === "claude-cli" && slot.dirId).toMatch(/^[0-9a-f]{32}$/);
		expect(slot?.store === "claude-cli" && typeof slot.signedInAt).toBe("number");
		expect(lane.records().find((record) => record.argv?.[1] === "login")?.configDir).toBe(
			join(lane.agentDir, "anthropic-subscription-claude", slot?.store === "claude-cli" ? slot.dirId : ""),
		);
		// The login commit adds the new account (and names it in the receipt), not the test-time write.
		expect(await lane.slots()).toEqual([]);
		expect(takeClaudeCliLoginOutcome(signal)).toMatchObject({
			account: { name: "default" },
			check: { outcome: "ok" },
		});
	});

	it("T3 Reconnect keeps name, pin and order and reuses the dirId", async () => {
		const dirId = "c".repeat(32);
		const lane = await setup({
			slots: [
				cliSlot("other", "d".repeat(32)),
				cliSlot("work", dirId, {
					displayName: "Work",
					signInRequired: "legacy_sign_in_retired",
					blockReason: "auth_error",
					blockedUntil: Date.now() + 60_000,
				}),
			],
			pinned: "work",
			order: ["other", "work"],
		});
		const credential = (await lane.config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith(DESKTOP_NAME_PREFIX) ? "work" : heldOpen(prompt)),
		})) as AnthropicSubscriptionCredential;
		expect(credential.pinned).toBe("work");
		expect(credential.order).toEqual(["other", "work"]);
		expect(credential.accounts?.map((slot) => slot.name)).toEqual(["other", "work"]);
		const work = credential.accounts?.find((slot) => slot.name === "work");
		expect(work).toMatchObject({ store: "claude-cli", dirId, displayName: "Work" });
		expect(work).not.toHaveProperty("signInRequired");
		expect(work).not.toHaveProperty("blockReason");
		expect(lane.records().find((record) => record.argv?.[1] === "login")?.configDir).toBe(
			join(lane.agentDir, "anthropic-subscription-claude", dirId),
		);
	});

	it("T4 the prompt titles stay the machine values the desktop matches", async () => {
		const lane = await setup({ mode: "login-paste", slots: [cliSlot("default", "e".repeat(32))] });
		const seen: { select?: { message: string; labels: string[] }; prompts: string[]; pastePlaceholder?: string } = {
			prompts: [],
		};
		const urls: string[] = [];
		const callbacks: OAuthLoginCallbacks = {
			onSelect: async (prompt) => {
				seen.select = { message: prompt.message, labels: prompt.options.map((option) => option.label) };
				return prompt.options.find((option) => option.label === DESKTOP_METHOD_LABELS[1])?.id;
			},
			onPrompt: async (prompt) => {
				seen.prompts.push(prompt.message);
				if (prompt.message.startsWith(DESKTOP_NAME_PREFIX)) return "second";
				seen.pastePlaceholder = prompt.placeholder;
				return "fixture-code#fixture-state";
			},
			onAuth: ({ url }) => {
				urls.push(url);
			},
		};
		await lane.config.login(callbacks);
		expect(seen.select).toEqual({ message: DESKTOP_METHOD_TITLE, labels: DESKTOP_METHOD_LABELS });
		expect(seen.prompts[0]?.startsWith(DESKTOP_NAME_PREFIX)).toBe(true);
		expect(seen.prompts[1]).toBe(DESKTOP_PASTE_TITLE);
		expect(seen.pastePlaceholder).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?.*platform\.claude\.com/);
		expect(urls).toEqual([seen.pastePlaceholder]);
		expect(lane.records().find((record) => record.stdin !== undefined)?.stdin).toBe("fixture-code#fixture-state");
	});

	it("T5 the connection test uses the default profile's Claude model with accountFallback false", async () => {
		const lane = await setup({});
		const credential = (await lane.config.login({ onPrompt: heldOpen })) as AnthropicSubscriptionCredential;
		expect(lane.queries.map((options) => options.model)).toEqual([connectionTestModel(DEFAULTS)]);
		expect(lane.queries[0]).toMatchObject({ maxTurns: 1, tools: [], settingSources: [], persistSession: false });
		expect(credential.accounts?.[0]).toMatchObject({
			check: { model: connectionTestModel(DEFAULTS), outcome: "ok" },
		});
	});

	it("T5 a failed test keeps the account with check.outcome failed", async () => {
		const lane = await setup({ slots: [cliSlot("other", "f".repeat(32))], turn: "auth_error" });
		const credential = (await lane.config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith(DESKTOP_NAME_PREFIX) ? "fresh" : heldOpen(prompt)),
		})) as AnthropicSubscriptionCredential;
		expect(lane.queries).toHaveLength(1);
		const fresh = credential.accounts?.find((slot) => slot.name === "fresh");
		expect(fresh).toMatchObject({ store: "claude-cli", check: { outcome: "failed" } });
		expect(fresh?.store === "claude-cli" ? fresh.check?.reason : undefined).toBeTruthy();
	});

	it("T6 a login cancelled during provider_login_start never spawns claude", async () => {
		const lane = await setup({});
		const controller = new AbortController();
		controller.abort();
		await expect(lane.config.login({ onPrompt: heldOpen, signal: controller.signal })).rejects.toThrow(/cancelled/i);
		expect(lane.records()).toEqual([]);
		expect(lane.accountDirs()).toEqual([]);
	});

	it("T6 a login cancelled mid-flow removes the new account dir", async () => {
		const lane = await setup({ mode: "login-hang" });
		const controller = new AbortController();
		const login = lane.config.login({
			onPrompt: heldOpen,
			onAuth: () => controller.abort(),
			signal: controller.signal,
		});
		await expect(login).rejects.toThrow(/cancelled/i);
		expect(lane.records().some((record) => record.argv?.[1] === "login")).toBe(true);
		expect(lane.accountDirs()).toEqual([]);
		expect(await lane.slots()).toEqual([]);
	});
});
