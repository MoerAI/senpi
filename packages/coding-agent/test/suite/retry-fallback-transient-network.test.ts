import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { isPureNetworkTransient } from "../../src/core/retry-fallback/transient-network.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

const failure = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });
const networkReset = () => failure("TypeError: fetch failed (ECONNRESET): connection reset by peer");
const rateLimitedTimeout = () => failure("429 Too Many Requests: rate limit reached, request timed out");

async function flakyHarness(harnesses: Harness[], maxRetries: number): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		fallbackNow: () => 0,
		settings: {
			retry: { enabled: true, baseDelayMs: 1, maxRetries, fallbackChains: { [primary]: [fallback] } },
		},
	});
	harnesses.push(harness);
	return harness;
}

describe("senpi#3306 network blips never strand a session on a fallback", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("#given network resets within the same-model budget #when the model then answers #then the session never switches", async () => {
		const harness = await flakyHarness(harnesses, 3);
		harness.setResponses([networkReset(), networkReset(), networkReset(), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("flaky network");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-1", "faux-1"]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});

	it("#given network resets past the same-model budget #when the next turn starts #then the fallback served once and the primary is back", async () => {
		const harness = await flakyHarness(harnesses, 1);
		harness.setResponses([
			networkReset(),
			networkReset(),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("primary answer"),
		]);

		await harness.session.prompt("first");
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ from: primary, to: fallback }]);

		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toMatchObject([{ from: fallback, to: primary }]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-2", "faux-1"]);
	});

	it("#given a blip then a rate limit on the fallback in one turn #when the retry continues #then the session stays off the primary", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			fallbackNow: () => 0,
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					maxRetries: 0,
					fallbackChains: { [primary]: [fallback, "faux/faux-3"] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([networkReset(), rateLimitedTimeout(), fauxAssistantMessage("third answer")]);

		await harness.session.prompt("first");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-3"]);
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
	});

	// #3335: provider verdicts and certificate faults must not get a next-turn network retry.
	it.each([
		"429 Too Many Requests: rate limit reached, request timed out",
		"internal error; request timed out",
		"Internal error: stream terminated",
		"5xx: timed out",
		"Error: terminated (rate_limit_error)",
		"SSL certificate problem: unable to get local issuer certificate",
		"tls: failed to verify certificate: x509: certificate has expired",
		"status 429x timeout",
	])("#given %s #when the next turn starts on a frozen clock #then the primary stays held", async (errorMessage) => {
		const harness = await flakyHarness(harnesses, 1);
		harness.setResponses([
			failure(errorMessage),
			failure(errorMessage),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("fallback again"),
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-2");
	});
});

describe("isPureNetworkTransient", () => {
	it.each([
		"TypeError: fetch failed (ECONNRESET)",
		"getaddrinfo ENOTFOUND api.example.test",
		"Request timed out after 60000ms",
		"socket hang up",
		"Client network socket disconnected before secure TLS connection was established",
		"TLS handshake timeout",
		"write EPIPE",
	])("#given %s #then it is a network blip", (message) => {
		expect(isPureNetworkTransient(message)).toBe(true);
	});

	it.each([
		"429 Too Many Requests: request timed out",
		"overloaded_error: capacity, connection reset",
		"You have hit your usage limit. Resets in 9 minutes (timeout)",
		"insufficient_quota",
		"500 Internal server error: request timed out",
		"504 Gateway Timeout",
		"Error 524: A timeout occurred",
		"503 upstream connect error or disconnect/reset before headers. reset reason: overflow",
		"service unavailable: connection error",
		"model is experiencing high demand; timed out",
		"internal error; request timed out",
		"Internal error: stream terminated",
		"5xx: timed out",
		"Error: terminated (rate_limit_error)",
		"SSL certificate problem: unable to get local issuer certificate",
		"tls: failed to verify certificate: x509: certificate has expired",
		"ERR_TLS_CERT_ALTNAME_INVALID",
		"status 429x timeout",
		undefined,
	])("#given %s #then it is not a pure network blip", (message) => {
		expect(isPureNetworkTransient(message)).toBe(false);
	});
});
