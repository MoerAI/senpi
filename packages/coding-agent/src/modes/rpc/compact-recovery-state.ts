import type { TranscriptRoot } from "./accepted-transcript.ts";
import { CompactReadError, CompactReadLease } from "./compact-read-lease.ts";
import { RecoveryStreams } from "./compact-recovery-streams.ts";
import {
	type CheckpointToken,
	type RecoveryCaller,
	type RecoveryCounters,
	type RecoveryFailure,
	type RecoveryOutcome,
	type RecoveryAdmission,
	RecoveryRefusedError,
	type RecoveryStreamState,
	type RecoveryToken,
	recovered,
	repairNeeded,
	storageUnavailable,
} from "./compact-recovery-types.ts";
import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "./session-acceptance-lane.ts";

/** A frozen checkpoint: its token, and the lane root the legacy view reader (S07b) reads under the lane. */
export interface FrozenCheckpoint {
	readonly token: CheckpointToken;
	readonly lane: SessionAcceptanceLane;
	readonly root: FrozenAcceptedRoot;
}

interface Checkpoint extends FrozenCheckpoint {
	readonly lease: CompactReadLease;
}

/** An admission's route; its session epoch and generation come from the lane and the stream at the freeze. */
export type RecoveryRoute = Omit<RecoveryAdmission, "sessionEpoch" | "generation">;

/**
 * The checkpoint tokens of one host (S08a/S08b, R3.C1.2-C1.5). A freeze pins one complete accepted root in one
 * synchronous step and mints a token naming the cut's accepted identities as the next generation of its stream;
 * nothing is published when the root is incomplete. Issuing a generation invalidates the stream's previous token
 * at once and reclaims its root as soon as the operations in flight on it unwind, whether or not its holder ever
 * releases it. Every lookup validates the caller, the token and the cut before I/O and after every await.
 */
export class RecoveryCheckpoints {
	private readonly checkpoints = new Map<string, Checkpoint>();
	private readonly streams = new RecoveryStreams();
	private readonly refusals = new Map<string, number>();
	private minted = 0;
	private frozen = 0;
	private reclaimed = 0;

	get open(): number {
		return this.checkpoints.size;
	}

	tokens(): readonly CheckpointToken[] {
		return [...this.checkpoints.values()].map(({ token }) => token);
	}

	/** The stream a caller's admissions share, as a bounded description; undefined once its peer incarnation ended. */
	stream(caller: RecoveryCaller): RecoveryStreamState | undefined {
		return this.streams.describe(caller);
	}

	status(): RecoveryCounters {
		return {
			open: this.checkpoints.size,
			streams: this.streams.size,
			frozen: this.frozen,
			reclaimed: this.reclaimed,
			refused: Object.fromEntries(this.refusals),
		};
	}

	/** The next generation of the route's stream: a failed freeze advances nothing and pins nothing. */
	freeze(route: RecoveryRoute, lane: SessionAcceptanceLane): RecoveryOutcome<FrozenCheckpoint> {
		if (lane.retired) return this.refuse(repairNeeded("lane_retired"));
		const root = lane.freeze();
		if (root.current === undefined) {
			lane.release(root);
			return this.refuse(storageUnavailable("compact_state_unavailable"));
		}
		const id = `${route.socketEpoch}:${++this.minted}`;
		const { generation, retired } = this.streams.next(route, root.sessionEpoch, id);
		const token: CheckpointToken = {
			kind: "checkpoint",
			id,
			admission: { ...route, sessionEpoch: root.sessionEpoch, generation },
			cut: {
				sessionEpoch: root.sessionEpoch,
				sequence: root.sequence,
				historyVersion: root.transcript.historyVersion,
				leafId: root.transcript.leafId,
				activeMessageId: root.activeMessageId,
				turnId: root.turnId,
			},
		};
		const checkpoint: Checkpoint = {
			token,
			lane,
			root,
			lease: new CompactReadLease(
				() => {
					lane.release(root);
					this.checkpoints.delete(token.id);
				},
				() => {
					const stale = this.staleness(token, lane);
					if (stale) throw new RecoveryRefusedError(stale);
				},
			),
		};
		this.checkpoints.set(token.id, checkpoint);
		this.frozen += 1;
		this.reclaim(retired);
		return recovered(checkpoint);
	}

	/** Idempotent, and never another token's: the root goes once this token's last operation unwinds. */
	release(token: RecoveryToken): void {
		this.checkpoints.get(token.id)?.lease.release();
	}

	/**
	 * A peer incarnation is gone: its streams end and every checkpoint it froze is reclaimed whether or not its
	 * holder ever releases it (RULING-50 (2)); an operation still in flight on one is refused as `peer_gone` and
	 * its root goes once that operation unwinds.
	 */
	forgetPeer(socketEpoch: string): void {
		this.streams.forgetPeer(socketEpoch);
		for (const { token } of [...this.checkpoints.values()])
			if (token.admission.socketEpoch === socketEpoch) this.reclaim(token.id);
	}

	/** The session closed: its streams keep a closed description and refuse live token access from now on. */
	close(sessionId: string): void {
		this.streams.close(sessionId);
	}

	/** An admission ended (a detach today; S14 extends this): its route leaves the stream, the counter stays. */
	retireRoute(caller: RecoveryCaller, admissionId: string): void {
		this.streams.retireRoute(caller, admissionId);
	}

	/** The pinned transcript root (version, leaf, accepted ids, base identity); its bytes are read by S11's page route. */
	transcript(token: RecoveryToken, caller: RecoveryCaller): RecoveryOutcome<TranscriptRoot> {
		const claimed = this.claim(token, caller);
		if (!claimed.ok) return claimed;
		const { transcript } = claimed.value.root;
		return transcript.unavailable === null
			? recovered(transcript)
			: this.refuse(storageUnavailable(transcript.unavailable));
	}

	readSettled(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readSettled(root));
	}

	readCurrent(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readCurrent(root));
	}

	readComponents(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readCurrentComponents(root));
	}

	readActive(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readCurrentActive(root));
	}

	readCalls(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readCurrentCalls(root));
	}

	private async read<T>(
		token: RecoveryToken,
		caller: RecoveryCaller,
		component: (lane: SessionAcceptanceLane, root: FrozenAcceptedRoot) => Promise<T>,
	): Promise<RecoveryOutcome<T>> {
		const claimed = this.claim(token, caller);
		if (!claimed.ok) return claimed;
		const { lease, lane, root } = claimed.value;
		try {
			return recovered(await lease.run(() => component(lane, root)));
		} catch (cause) {
			return this.refused(token, lane, cause);
		}
	}

	/** Invalidates a token the owner retires (superseded, replaced, or its peer gone): the root goes after its leases. */
	private reclaim(id: string | undefined): void {
		const checkpoint = id === undefined ? undefined : this.checkpoints.get(id);
		if (!checkpoint) return;
		this.reclaimed += 1;
		checkpoint.lease.release();
	}

	/** Owner and routing session first, then the token: a retired token is described by its stream before any I/O. */
	private claim(token: RecoveryToken, caller: RecoveryCaller): RecoveryOutcome<Checkpoint> {
		if (token.admission.socketEpoch !== caller.socketEpoch) return this.refuse(repairNeeded("foreign_peer"));
		if (token.admission.sessionId !== caller.sessionId) return this.refuse(repairNeeded("foreign_session"));
		const checkpoint = this.checkpoints.get(token.id);
		if (!checkpoint || checkpoint.token !== token) return this.refuse(this.describe(token));
		try {
			checkpoint.lease.assert();
		} catch (cause) {
			return this.refused(token, checkpoint.lane, cause);
		}
		return recovered(checkpoint);
	}

	/** What a token's stream says about a token no longer owned here: the bounded description its holder gets. */
	private describe(token: CheckpointToken): RecoveryFailure {
		const stream = this.streams.get(token.admission);
		if (!stream) return { kind: "repair_needed", reason: "unknown_token" };
		if (stream.closed) return { kind: "repair_needed", reason: "session_closed" };
		if (stream.sessionEpoch !== token.admission.sessionEpoch) return { kind: "repair_needed", reason: "stale_epoch" };
		if (stream.generation !== token.admission.generation)
			return { kind: "repair_needed", reason: "superseded_token", newerGeneration: stream.generation };
		return { kind: "repair_needed", reason: "unknown_token" };
	}

	/** Why a once-valid token no longer names a readable cut; undefined while it still does. */
	private staleness(token: CheckpointToken, lane: SessionAcceptanceLane): RecoveryFailure | undefined {
		const stream = this.streams.get(token.admission);
		if (!stream) return { kind: "repair_needed", reason: "peer_gone" };
		if (stream.closed) return { kind: "repair_needed", reason: "session_closed" };
		if (lane.retired) return { kind: "repair_needed", reason: "lane_retired" };
		if (lane.sessionEpoch !== token.cut.sessionEpoch || stream.sessionEpoch !== token.admission.sessionEpoch)
			return { kind: "repair_needed", reason: "stale_epoch" };
		if (stream.generation !== token.admission.generation)
			return { kind: "repair_needed", reason: "superseded_token", newerGeneration: stream.generation };
		return undefined;
	}

	/** A refused operation names the cut's staleness first; a store that could not serve it is storage_unavailable. */
	private refused(token: CheckpointToken, lane: SessionAcceptanceLane, cause: unknown): RecoveryOutcome<never> {
		const stale = this.staleness(token, lane);
		if (stale) return this.refuse(stale);
		if (cause instanceof RecoveryRefusedError) return this.refuse(cause.failure);
		if (cause instanceof CompactReadError)
			return this.refuse(cause.reason === "released" ? repairNeeded("released") : storageUnavailable(cause.reason));
		throw cause;
	}

	/** Every typed failure leaves through here, counted by its reason. */
	private refuse(failure: RecoveryFailure): RecoveryOutcome<never> {
		const reason = failure.kind === "storage_unavailable" ? failure.kind : failure.reason;
		this.refusals.set(reason, (this.refusals.get(reason) ?? 0) + 1);
		return { ok: false, failure };
	}
}
