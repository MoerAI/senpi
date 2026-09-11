import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	GOAL_BLOCKED_MIN_GOAL_TURNS,
	goalTurnsSinceActivation,
} from "../../src/core/extensions/builtin/goal/blocked-audit.ts";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../src/core/messages.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { TestEventBus } from "./goal-monitor-test-harness.ts";

type AnyTool = ToolDefinition<any, any, any>;

const tempDirs: string[] = [];

function createHarness(): { tools: Map<string, AnyTool>; events: TestEventBus } {
	const tools = new Map<string, AnyTool>();
	const events = new TestEventBus();
	const pi = {
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		events,
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	return { tools, events };
}

async function makeCtx(threadId: string, branch: SessionEntry[]): Promise<ExtensionContext> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-blocked-"));
	tempDirs.push(dir);
	return {
		hasUI: false,
		cwd: dir,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: () => {}, select: async () => undefined, setStatus: () => {} },
		sessionManager: {
			getSessionFile: () => join(dir, "session.jsonl"),
			getSessionDir: () => dir,
			getSessionId: () => threadId,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
}

function storeRefFor(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function continuationEntry(timestamp = new Date().toISOString()): SessionEntry {
	return {
		type: "custom_message",
		customType: GOAL_CONTINUATION_MESSAGE_TYPE,
		content: "Continue working toward the active thread goal.",
		display: false,
		timestamp,
	} as unknown as SessionEntry;
}

function userEntry(timestamp = new Date().toISOString()): SessionEntry {
	return {
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "keep going" }] },
		timestamp,
	} as unknown as SessionEntry;
}

function goalFixture(overrides: Partial<Goal> = {}): Goal {
	const now = Math.trunc(Date.now() / 1000);
	return {
		id: "goal-fixture",
		threadId: "thread-fixture",
		objective: "Keep moving",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
		lastStartedAt: now,
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("goal blocked audit turn counting", () => {
	it("counts the calling turn plus continuations delivered since the goal became active", () => {
		// given
		const goal = goalFixture();
		const entries = [continuationEntry(), continuationEntry()];

		// then
		expect(goalTurnsSinceActivation([], goal)).toBe(1);
		expect(goalTurnsSinceActivation(entries, goal)).toBe(3);
	});

	it("restarts counting at the last real user message", () => {
		// given
		const goal = goalFixture();
		const entries = [continuationEntry(), continuationEntry(), userEntry()];

		// then
		expect(goalTurnsSinceActivation(entries, goal)).toBe(1);
	});

	it("ignores continuations delivered before this goal became active", () => {
		// given
		const activatedAt = Math.trunc(Date.now() / 1000);
		const goal = goalFixture({ lastStartedAt: activatedAt });
		const stale = new Date((activatedAt - 600) * 1000).toISOString();

		// then
		expect(goalTurnsSinceActivation([continuationEntry(stale), continuationEntry(stale)], goal)).toBe(1);
	});
});

describe("update_goal blocked guards", () => {
	it("refuses a model block while a resumption channel can still deliver", async () => {
		// given
		const { tools, events } = createHarness();
		const branch: SessionEntry[] = [continuationEntry(), continuationEntry()];
		const ctx = await makeCtx("thread-live-channel", branch);
		await tools.get("create_goal")?.execute("c1", { objective: "Ship the fix" }, undefined, undefined, ctx);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "senpi-task", activeCount: 1 });
		await events.flush();

		// when
		const blocked = tools
			.get("update_goal")
			?.execute("u1", { status: "blocked", reason: "waiting on the child" }, undefined, undefined, ctx);

		// then
		await expect(blocked).rejects.toThrow(/senpi-task/);
		await expect(blocked).rejects.toThrow(/wait, not an impasse/);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("active");
	});

	it("refuses a model block before the blocker survived the goal-turn floor", async () => {
		// given
		const { tools } = createHarness();
		const ctx = await makeCtx("thread-floor", []);
		await tools.get("create_goal")?.execute("c1", { objective: "Ship the fix" }, undefined, undefined, ctx);

		// when
		const blocked = tools
			.get("update_goal")
			?.execute("u1", { status: "blocked", reason: "cannot find the keys" }, undefined, undefined, ctx);

		// then
		await expect(blocked).rejects.toThrow(new RegExp(`goal turn 1 of ${GOAL_BLOCKED_MIN_GOAL_TURNS}`));
		await expect(blocked).rejects.toThrow(/no limit on how many times you may try/);
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("active");
	});

	it("accepts the block once the floor is met and no channel is live", async () => {
		// given
		const { tools } = createHarness();
		const branch: SessionEntry[] = [continuationEntry(), continuationEntry()];
		const ctx = await makeCtx("thread-floor-met", branch);
		await tools.get("create_goal")?.execute("c1", { objective: "Ship the fix" }, undefined, undefined, ctx);

		// when
		await tools
			.get("update_goal")
			?.execute("u1", { status: "blocked", reason: "the user must supply the token" }, undefined, undefined, ctx);

		// then
		const goal = await readGoal(storeRefFor(ctx));
		expect(goal?.status).toBe("blocked");
		expect(goal?.blockedReason).toBe("the user must supply the token");
	});

	it("restarts the floor after the user pushes the goal again", async () => {
		// given
		const { tools } = createHarness();
		const branch: SessionEntry[] = [continuationEntry(), continuationEntry(), userEntry()];
		const ctx = await makeCtx("thread-user-reset", branch);
		await tools.get("create_goal")?.execute("c1", { objective: "Ship the fix" }, undefined, undefined, ctx);

		// when
		const blocked = tools
			.get("update_goal")
			?.execute("u1", { status: "blocked", reason: "still stuck" }, undefined, undefined, ctx);

		// then
		await expect(blocked).rejects.toThrow(new RegExp(`goal turn 1 of ${GOAL_BLOCKED_MIN_GOAL_TURNS}`));
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("active");
	});

	it("leaves completion ungated by the blocked guards", async () => {
		// given
		const { tools, events } = createHarness();
		const ctx = await makeCtx("thread-complete", []);
		await tools.get("create_goal")?.execute("c1", { objective: "Ship the fix" }, undefined, undefined, ctx);
		events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 1 });
		await events.flush();

		// when
		await tools.get("update_goal")?.execute("u1", { status: "complete" }, undefined, undefined, ctx);

		// then
		expect((await readGoal(storeRefFor(ctx)))?.status).toBe("complete");
	});
});
