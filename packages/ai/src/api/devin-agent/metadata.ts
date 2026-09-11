/**
 * Cascade `Metadata` construction.
 *
 * Every Cascade RPC carries the same identity envelope. The session token is
 * scheme-prefixed on the wire, and `userJwt` stays empty for the calls the CLI
 * makes with the session token alone.
 */

import { create } from "@bufbuild/protobuf";
import { type Metadata, MetadataSchema } from "./gen/cascade_pb.ts";

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

const DEVIN_OS = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";

/** Identity the released Devin CLI reports; Cascade gates features on it. */
const DEVIN_CLI_IDENTITY = {
	ideName: "chisel",
	ideType: "cli",
	ideVersion: "0.0.0-dev",
	extensionName: "chisel",
	extensionVersion: "0.0.0-dev",
	locale: "en",
	os: DEVIN_OS,
} as const;

/** Session token as the wire format carries it: the scheme prefix is required. */
export function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

export function devinCliMetadata(apiKey: string | undefined, userJwt = ""): Metadata {
	return create(MetadataSchema, {
		...DEVIN_CLI_IDENTITY,
		apiKey: normalizeDevinSessionToken(apiKey),
		userJwt,
	});
}
