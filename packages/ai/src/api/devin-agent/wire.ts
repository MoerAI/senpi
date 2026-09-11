/** Cascade wire surface: paths, identity metadata, frame codec and request building. */

export { type DevinFrame, decodeDevinFrames, encodeDevinFrame as encodeDevinRequestFrame } from "./frames.ts";
export { devinCliMetadata, normalizeDevinSessionToken } from "./metadata.ts";
export {
	DEVIN_CHAT_MESSAGE_PATH,
	DEVIN_CLI_MODEL_CONFIGS_PATH,
	DEVIN_DEFAULT_BASE_URL,
	DEVIN_MAX_FRAME_PAYLOAD,
} from "./paths.ts";
export { buildDevinChatRequest, DEVIN_DEFAULT_STOP_PATTERNS, type DevinChatRequestInput } from "./request.ts";
