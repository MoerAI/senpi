import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { registerTodoCommand } from "./commands.ts";
import { phasesFromCursorTodos } from "./native-todo-mirror.ts";
import { TASK_MANAGEMENT_SECTION } from "./prompt.ts";
import {
	clonePhases,
	getLatestTodoStateFromBranchEntries,
	type TodoAsk,
	type TodoCompletionTransition,
	type TodoPhase,
	type TodoState,
} from "./state.ts";
import { TODO_STATE_ENTRY_TYPE } from "./todo-types.ts";
import { getTodoWidgetModel } from "./todo-widget.ts";
import { TodoWidgetComponent } from "./todo-widget-component.ts";
import { registerTodoTool } from "./tools/todo.ts";

export default function todotoolsExtension(pi: ExtensionAPI): void {
	let currentState: TodoState = { phases: [], ask: undefined };

	const getCurrentPhases = (): TodoPhase[] => clonePhases(currentState.phases);

	const setCurrentPhases = (phases: TodoPhase[]): void => {
		currentState = { ...currentState, phases: clonePhases(phases) };
	};

	const getCurrentAsk = (): TodoAsk | undefined => currentState.ask;

	const setCurrentAsk = (ask: TodoAsk | undefined): void => {
		currentState = { ...currentState, ask };
	};

	const syncWidget = (ctx: ExtensionContext, completedTasks: readonly TodoCompletionTransition[] = []): void => {
		const model = getTodoWidgetModel(currentState.phases);
		ctx.ui.setWidget(
			"todo-sidebar",
			model ? (tui, theme) => new TodoWidgetComponent(tui, theme, model, completedTasks) : undefined,
		);
	};

	const syncFromSession = (ctx: ExtensionContext): void => {
		currentState = getLatestTodoStateFromBranchEntries(ctx.sessionManager.getBranch());
		syncWidget(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			return;
		}
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "todo" || block.arguments?.op) {
				continue;
			}
			const phases = phasesFromCursorTodos(block.arguments?.todos);
			if (phases === undefined) {
				continue;
			}
			setCurrentPhases(phases);
			const ask = getCurrentAsk();
			pi.appendEntry(TODO_STATE_ENTRY_TYPE, { schema: "v2", phases, ...(ask ? { ask } : {}) });
			syncWidget(ctx);
		}
	});

	pi.on(
		"before_agent_start",
		async (event) => {
			return {
				systemPrompt: `${event.systemPrompt}\n${TASK_MANAGEMENT_SECTION}`,
			};
		},
		{ previewSafe: true },
	);

	const accessors = { getCurrentPhases, setCurrentPhases, getCurrentAsk, setCurrentAsk, syncWidget };
	registerTodoTool(pi, accessors);
	registerTodoCommand(pi, accessors);
}

export { findPhaseFuzzy, findTaskFuzzy, registerTodoCommand, tokenizeTodoArgs } from "./commands.ts";
export { markdownToPhases, phasesToMarkdown, resolveTodoMarkdownPath } from "./markdown.ts";
export { TASK_MANAGEMENT_SECTION } from "./prompt.ts";
export {
	appendItems,
	applyEntry,
	applyOpsToPhases,
	applyParams,
	clonePhases,
	cloneTask,
	DEFAULT_INIT_PHASE,
	describeAskNowNext,
	findPhaseByName,
	findTaskByContent,
	formatSummary,
	getCompletionTransitions,
	getLatestPhasesFromBranchEntries,
	getLatestTodoStateFromBranchEntries,
	getLatestTodosFromBranchEntries,
	getTaskTargets,
	getTodoMarker,
	getTodoResultLines,
	getTodoWidgetLines,
	initPhases,
	isIncompleteTodo,
	isTerminalTodoStatus,
	isTodoItem,
	isTodoItemArray,
	isTodoPhase,
	isTodoPhaseArray,
	nextActionableTask,
	normalizeInProgressTask,
	removeTasks,
	resolvePhaseOrError,
	resolveTaskOrError,
	sanitizeTodoText,
	TODO_STATE_ENTRY_TYPE,
	type TodoAsk,
	type TodoCompletionTransition,
	type TodoItem,
	type TodoOpEntry,
	type TodoOperation,
	type TodoPhase,
	type TodoState,
	type TodoStateEntry,
	type TodoStatus,
	type TodoToolDetails,
} from "./state.ts";
export { phaseRomanNumeral } from "./tools/todo.ts";
