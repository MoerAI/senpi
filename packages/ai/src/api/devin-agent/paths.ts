/**
 * Cascade RPC paths and wire constants.
 *
 * Devin's released CLI speaks the Connect protocol over HTTP/1.1 against
 * Codeium's Cascade edge. The service paths are spelled out here rather than
 * derived from a generated service descriptor: the vendored schema in
 * packages/ai/proto/devin/cascade.proto carries only the message subset the
 * transport needs, so its package name is cosmetic while these paths are the
 * real contract.
 */

export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";
export const DEVIN_CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

/** Connect frame flags: bit 0 marks a gzipped payload, bit 1 the end-of-stream trailer. */
export const DEVIN_COMPRESSED_FLAG = 0x01;
export const DEVIN_TRAILER_FLAG = 0x02;

/**
 * Hard upper bound on one Connect frame payload. The 4-byte length prefix can
 * describe 4 GiB; a corrupted or hostile prefix must not turn into an
 * allocation of that size, so anything larger is a protocol error.
 */
export const DEVIN_MAX_FRAME_PAYLOAD = 64 * 1024 * 1024;
