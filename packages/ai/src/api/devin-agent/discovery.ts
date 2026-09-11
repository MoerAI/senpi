/**
 * Cascade model discovery.
 *
 * `GetCliModelConfigs` is credential-scoped: it reports the models the signed-in
 * account may actually use, which differs per plan and per rollout. A failed or
 * empty response therefore returns undefined so callers KEEP their static seed
 * instead of publishing an empty catalog.
 */

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Model } from "../../types.ts";
import { GetCliModelConfigsRequestSchema, GetCliModelConfigsResponseSchema } from "./gen/cascade_pb.ts";
import { devinCliMetadata } from "./metadata.ts";
import { DEVIN_CLI_MODEL_CONFIGS_PATH, DEVIN_DEFAULT_BASE_URL } from "./paths.ts";

const DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 128_000;

export interface DevinDiscoveryOptions {
	apiKey: string | undefined;
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function fetchDevinModels(options: DevinDiscoveryOptions): Promise<Model<"devin-agent">[] | undefined> {
	const baseUrl = options.baseUrl ?? DEVIN_DEFAULT_BASE_URL;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);

	try {
		const request = create(GetCliModelConfigsRequestSchema, { metadata: devinCliMetadata(options.apiKey) });
		const payload = toUnaryFrame(request);
		const response = await fetch(baseUrl + DEVIN_CLI_MODEL_CONFIGS_PATH, {
			method: "POST",
			headers: {
				"content-type": "application/connect+proto",
				"connect-protocol-version": "1",
			},
			body: payload,
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		const body = new Uint8Array(await response.arrayBuffer());
		const decoded = decodeUnary(body);
		if (!decoded) return undefined;
		const models = decoded.clientModelConfigs.filter(usable).map(toModel);
		return models.length > 0 ? models : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function usable(config: { modelUid: string; disabled: boolean }): boolean {
	return config.modelUid.length > 0 && !config.disabled;
}

function toModel(config: {
	modelUid: string;
	label: string;
	maxTokens: number;
	supportsImages: boolean;
}): Model<"devin-agent"> {
	return {
		id: config.modelUid,
		name: config.label || config.modelUid,
		api: "devin-agent",
		provider: "devin",
		baseUrl: DEVIN_DEFAULT_BASE_URL,
		reasoning: true,
		input: config.supportsImages ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: config.maxTokens > 0 ? config.maxTokens : DEFAULT_MAX_TOKENS,
	} as unknown as Model<"devin-agent">;
}

/** Unary Connect bodies use the same 5-byte prefix, uncompressed. */
function toUnaryFrame(
	message: ReturnType<typeof create<typeof GetCliModelConfigsRequestSchema>>,
): Uint8Array<ArrayBuffer> {
	const payload = toBinary(GetCliModelConfigsRequestSchema, message);
	const frame = new Uint8Array(5 + payload.byteLength);
	new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
	frame.set(payload, 5);
	return frame;
}

function decodeUnary(
	body: Uint8Array,
): ReturnType<typeof fromBinary<typeof GetCliModelConfigsResponseSchema>> | undefined {
	if (body.byteLength < 5) return undefined;
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
	const length = view.getUint32(1, false);
	const payload = body.subarray(5, 5 + length);
	try {
		return fromBinary(GetCliModelConfigsResponseSchema, payload);
	} catch {
		return undefined;
	}
}
