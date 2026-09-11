/**
 * Devin's credential-free model seed.
 *
 * Cascade's real catalog is credential-scoped (see api/devin-agent/discovery.ts),
 * so the bundle ships the lanes Devin's CLI documents publicly and lets runtime
 * discovery replace them once an account is signed in.
 */

import type { Model } from "../types.ts";

function devinModel(id: string, name: string, contextWindow: number, maxTokens: number): Model<"devin-agent"> {
	return {
		id,
		name,
		api: "devin-agent",
		provider: "devin",
		baseUrl: "https://server.codeium.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

export const DEVIN_MODELS: Model<"devin-agent">[] = [
	devinModel("swe-2", "SWE-2", 200_000, 128_000),
	devinModel("swe-2-high", "SWE-2 (high)", 200_000, 128_000),
	devinModel("swe-1-6", "SWE-1.6", 200_000, 128_000),
	devinModel("swe-1-6-fast", "SWE-1.6 Fast", 200_000, 128_000),
];
