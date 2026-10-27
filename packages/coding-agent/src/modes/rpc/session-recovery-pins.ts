import { legacyResyncMessage } from "./compact-legacy-view.ts";
import type { FrozenCheckpoint, RecoveryCheckpoints } from "./compact-recovery-state.ts";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { resyncCut } from "./legacy-resync-view.ts";
import type { LegacyReplayStore } from "./legacy-replay-store.ts";
import type { SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import type { ResyncCut, ResyncReason } from "./socket-peer-recovery.ts";
import type { ShedMode } from "./socket-peer-shed.ts";

/** A checkpoint pinned for one frozen view, released once on that view's end (R3.C1.5). */
export type PinnedRoot = FrozenCheckpoint & { readonly sessionId: string };

/** What the pins read of the fanout's peers: a registration's incarnation and the attach ordinals it holds. */
export interface RecoveryPeers {
	socketEpoch(id: string): string | undefined;
	/** Per attached session, the ordinal of the attach that holds it for `id`; undefined for an unknown peer. */
	ordinals(id: string): ReadonlyMap<string, number> | undefined;
	has(id: string, capability: string): boolean;
}

/**
 * The checkpoints a host pins for its peers' legacy views (S08a producers): one per held lane-owned session on the
 * admission (the attach ordinal) that holds it, and the shed's recovery cut read from them.
 */
export class SessionRecoveryPins {
	private readonly acceptance: ReadonlyMap<string, SessionAcceptanceLane>;
	private readonly checkpoints: RecoveryCheckpoints;
	private readonly replay: LegacyReplayStore;
	private readonly peers: RecoveryPeers;
	private readonly shedMode: ShedMode;

	constructor(
		acceptance: ReadonlyMap<string, SessionAcceptanceLane>,
		checkpoints: RecoveryCheckpoints,
		replay: LegacyReplayStore,
		peers: RecoveryPeers,
		shedMode: ShedMode,
	) {
		this.acceptance = acceptance;
		this.checkpoints = checkpoints;
		this.replay = replay;
		this.peers = peers;
		this.shedMode = shedMode;
	}

	/** One checkpoint per held lane-owned session, on the admission (the attach ordinal) that holds it for `id`. */
	pin(id: string, sessionIds: readonly string[]): readonly PinnedRoot[] {
		const socketEpoch = this.peers.socketEpoch(id);
		return sessionIds.flatMap((sessionId) => {
			const lane = this.acceptance.get(sessionId);
			const ordinal = this.peers.ordinals(id)?.get(sessionId);
			if (!lane || ordinal === undefined || socketEpoch === undefined) return [];
			const route = {
				socketEpoch,
				admissionId: `attach-${ordinal}`,
				routeKind: "ordinary" as const,
				peer: id,
				sessionId,
			};
			const frozen = this.checkpoints.freeze(route, lane);
			return frozen.ok ? [{ sessionId, ...frozen.value }] : [];
		});
	}

	unpin(pinned: readonly PinnedRoot[]): void {
		for (const { token } of pinned) this.checkpoints.release(token);
	}

	/**
	 * The shed's recovery: checkpoints frozen at the shed, before the actor awaits its drain (R3.C1.5), as the next
	 * generation of each held admission; released when the recovery ends.
	 */
	resync(id: string, reason: ResyncReason, carried: readonly string[] = []): ResyncCut {
		const capture = this.shedMode === "capture";
		const attached = [...(this.peers.ordinals(id)?.keys() ?? [])];
		const ordinals = new Map(this.peers.ordinals(id));
		const pinned = this.pin(id, attached);
		const roots = new Map(pinned.map((root) => [root.sessionId, root]));
		const view = {
			reason,
			placeholders: this.peers.has(id, MEDIA_PLACEHOLDERS_CAPABILITY),
			// Capture: closed once the attachment held at the shed is gone (carry 30); drop: today's rule.
			closedNow: (sessionId: string) =>
				capture
					? this.peers.ordinals(id)?.get(sessionId) !== ordinals.get(sessionId) || !ordinals.has(sessionId)
					: !(this.peers.ordinals(id)?.has(sessionId) ?? false),
			onRelease: () => this.unpin(pinned),
		};
		const sessions = capture ? [...new Set([...carried, ...attached])] : attached;
		return resyncCut(
			sessions,
			capture ? () => sessions : () => [...new Set([...sessions, ...(this.peers.ordinals(id)?.keys() ?? [])])],
			(sessionId) =>
				this.acceptance.has(sessionId)
					? legacyResyncMessage(sessionId, roots.get(sessionId))
					: Promise.resolve(this.replay.latestMessage(sessionId)),
			view,
			this.replay.track,
		);
	}
}
