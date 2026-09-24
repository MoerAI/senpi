/**
 * Lenient tool-name matching shared by the inbound tool-call resolver
 * (`@earendil-works/pi-agent-core` `resolveToolNameAlias`) and the Anthropic
 * tool-reference repair, so both paths accept the same shapes.
 *
 * Models write tool names in shapes no tool was registered under: recased
 * (`LazyWeather` for `lazy_weather`), under a gateway namespace
 * (`mcp__686f__Eval`, `Mcp__686f__Eval`), under a namespace whose id contains
 * underscores (`mcp__my_server__Memory`), or without the namespace a registered
 * tool carries (`create_issue` for senpi's own `mcp_github_create_issue`).
 *
 * Names are compared with case and `-`/`_` separators folded away, and an
 * `mcp_`/`mcp__` prefix (any case) is stripped on both the requested and the
 * registered side. The most specific form is tried first, and a step resolves
 * only when exactly one tool matches it: the matcher never guesses between two
 * candidates.
 */

const MCP_NAMESPACE_PREFIX = /^mcp_+/i;
const UNDERSCORE_RUN = /_+/g;

export function foldToolName(name: string): string {
	return name.toLowerCase().replaceAll(/[-_]/g, "");
}

/**
 * The name itself, then, for an `mcp_`/`mcp__`-prefixed name, every remainder
 * after an underscore run that closes a non-empty namespace segment, longest
 * first (`mcp__my_server__Tool` -> `server__Tool`, `Tool`).
 */
export function toolNameForms(name: string): string[] {
	const forms = [name];
	const prefix = MCP_NAMESPACE_PREFIX.exec(name);
	if (!prefix) return forms;
	const rest = name.slice(prefix[0].length);
	for (const run of rest.matchAll(UNDERSCORE_RUN)) {
		const suffix = rest.slice(run.index + run[0].length);
		if (run.index > 0 && suffix.length > 0) forms.push(suffix);
	}
	return forms;
}

function uniqueMatch(names: readonly string[], matches: (name: string) => boolean): string | undefined {
	const found = names.filter(matches);
	return found.length === 1 ? found[0] : undefined;
}

/**
 * Resolve `requested` to the one available tool it names, or `undefined` when
 * no tool or more than one tool matches.
 *
 * Order, stopping at the first step with exactly one match:
 * 1. for each requested form, most specific first: the exact name, then a tool
 *    whose full folded name equals the form's folded name;
 * 2. for each requested form: a tool whose namespace-stripped form folds to
 *    the requested form's folded name.
 */
export function resolveToolNameMatch(requested: string, available: Iterable<string>): string | undefined {
	const names = [...new Set(available)];
	const requestedForms = toolNameForms(requested);
	for (const form of requestedForms) {
		if (names.includes(form)) return form;
		const key = foldToolName(form);
		const folded = uniqueMatch(names, (name) => foldToolName(name) === key);
		if (folded !== undefined) return folded;
	}
	for (const form of requestedForms) {
		const key = foldToolName(form);
		const stripped = uniqueMatch(names, (name) =>
			toolNameForms(name)
				.slice(1)
				.some((registeredForm) => foldToolName(registeredForm) === key),
		);
		if (stripped !== undefined) return stripped;
	}
	return undefined;
}
