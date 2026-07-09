/**
 * The delivery loop that bridges a Cotal mesh to one oh-my-pi session — extracted from the
 * extension factory so it can be driven with fakes (no NATS, no real session) in the smoke.
 *
 * It owns three things: (1) DELIVERY — inbound mesh traffic is injected into the session, waking
 * an idle one and steering a live one, never interrupting a running turn; (2) ACK-ON-SURFACE — the
 * batch injected into a turn is acked only when that turn ends, matched by id so a front-eviction
 * can't ack the wrong messages; (3) PRESENCE — the session's own lifecycle events map to mesh
 * presence. The real `MeshAgent` satisfies {@link PeerMesh} structurally; the real `ExtensionAPI`
 * satisfies {@link PeerHost}.
 */
import { formatInjection, fmtFrom, ORIENTATION_BOOTSTRAP, type InboxItem } from "@cotal-ai/connector-core";
import type { PresenceStatus, AttentionMode, ChannelMode } from "@cotal-ai/core";

/** The mesh surface the loop drives. `MeshAgent` satisfies this structurally. */
export interface PeerMesh {
	readonly connected: boolean;
	readonly attention: AttentionMode;
	channelMode(channel?: string): ChannelMode | undefined;
	peekInbox(): InboxItem[];
	drainInbox(limit?: number): InboxItem[];
	pendingWake(): number;
	setStatus(status: PresenceStatus, activity?: string): Promise<void>;
	stop(): Promise<void>;
	on(event: "incoming" | "mention-wake", handler: (item: InboxItem) => void): void;
	on(event: "wake", handler: () => void): void;
}

/** The host-session surface the loop drives. The extension's `ExtensionAPI` satisfies this.
 *  Delivery uses `deliverAs: "nextTurn"`, the one mode OMP's contract keeps hidden from the
 *  editable pending-message UI: when idle it wakes a fresh turn (same #promptAgentInitiatedMessage
 *  path as a steer), and when the session is still tearing down a user-interrupted (ESC) turn it is
 *  parked in the hidden next-turn queue and redelivered — never bled into the composer. */
export interface PeerHost {
	sendMessage(
		message: { customType: string; content: string; display: boolean; details: unknown; attribution: "user" | "agent" },
		options: { deliverAs: "nextTurn"; triggerTurn: true },
	): void;
}

/** customType tags for injected messages — namespaced like OMP's own `irc:*`. */
export const INCOMING = "cotal:incoming";
export const NUDGE = "cotal:nudge";

/** A running peer loop. The factory owns the mesh + process lifecycle around it. */
export interface PeerLoop {
	/** Call on `agent_start`: a turn began — hold delivery. */
	onAgentStart(): void;
	/** Call on `agent_end`: the turn ended — ack the surfaced batch, then flush the next. */
	onAgentEnd(): void;
	/** Presence: this session is offline; stop the mesh. */
	shutdown(): Promise<void>;
}

/**
 * Wire a {@link PeerMesh}'s inbox to a {@link PeerHost} and return the turn-lifecycle hooks the
 * factory calls from the session's event stream.
 */
export function runPeerLoop({ mesh, host }: { mesh: PeerMesh; host: PeerHost }): PeerLoop {
	// One session, driven straight off the inbox. `busy` gates delivery so a message that arrives
	// mid-turn waits for turn end (no-interrupt). `surfaced` holds the ids injected into the current
	// turn, acked on completion by id (not count) so a front-eviction can't ack the wrong messages.
	let busy = false;
	let surfaced: string[] = [];
	let primed = false; // orientation bootstrap prepended once, on the first delivered turn

	/** Inject the current inbox batch (peeked, not drained). `override` replaces the body with a bare
	 *  nudge (focus @mention recall) and surfaces nothing to ack. Never drives into a running turn. */
	function drive(override?: string): void {
		if (busy) return;
		let text: string;
		let ids: string[] = [];
		if (override) {
			text = override;
		} else {
			const items = mesh.peekInbox();
			if (items.length === 0) return;
			ids = items.map((i) => i.id);
			const inj = formatInjection(items);
			if (!inj) return;
			text = inj;
		}
		if (!primed) {
			primed = true;
			text = `${ORIENTATION_BOOTSTRAP}\n\n${text}`;
		}
		busy = true;
		surfaced = ids;
		// The content participates in LLM context (a CustomMessage); triggerTurn wakes an idle session
		// into a fresh turn. `nextTurn` (not `steer`) is deliberate: the loop only ever delivers when it
		// believes the session idle (drive() early-returns while busy), so it never needs steer's mid-
		// turn fold — and steer's one distinguishing behavior is that, arriving while OMP is still
		// unwinding a user-interrupted (ESC) turn, it surfaces into the editable composer. `nextTurn` is
		// hidden-from-composer by contract: idle → the same fresh-turn path, mid-unwind → parked +
		// redelivered. Attribution "user" — a peer message is external input here.
		host.sendMessage(
			{ customType: override ? NUDGE : INCOMING, content: text, display: true, details: {}, attribution: "user" },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	}

	/** Ack the surfaced batch — but only the leading run STILL at the front of the inbox, matched by
	 *  id. The mesh evicts from the FRONT at its cap, so a long turn on a chatty channel can shift our
	 *  surfaced prefix out; matching by id (not a raw count) means we never ack the wrong, newer
	 *  messages. Any surfaced survivor that no longer leads is left unacked → redelivered. */
	function ackSurfaced(): void {
		if (surfaced.length === 0) return;
		const front = mesh.peekInbox();
		let n = 0;
		while (n < surfaced.length && n < front.length && front[n].id === surfaced[n]) n++;
		if (n > 0) mesh.drainInbox(n);
		surfaced = [];
	}

	// ---- inbound mesh → delivery --------------------------------------------
	// A directed message (DM / anycast / @mention) drives when idle; ambient channel chatter drives
	// only in `open` while idle (dnd/focus hold it for the next turn); a per-channel `quiet` channel
	// never ambient-drives. `muted` ambient never reaches here (ack-dropped at ingest).
	mesh.on("incoming", (item: InboxItem) => {
		if (busy) return; // buffer; onAgentEnd drives at turn end
		const directed = item.kind !== "channel" || item.mentionsMe;
		const quiet = item.kind === "channel" && mesh.channelMode(item.channel) === "quiet";
		if (directed || (!quiet && mesh.attention === "open")) drive();
	});
	mesh.on("mention-wake", (item: InboxItem) => {
		// Focus: the @mention body was acked-and-dropped at ingest — wake a turn to PULL it (recall).
		if (!busy) drive(`📨 You were mentioned by ${fmtFrom(item)} on #${item.channel ?? "?"} — read it with cotal_inbox.`);
	});
	mesh.on("wake", () => {
		if (!busy) drive();
	});

	return {
		onAgentStart(): void {
			busy = true;
		},
		onAgentEnd(): void {
			// turn-end: release the no-interrupt gate, ack the surfaced batch, flush the next.
			busy = false;
			ackSurfaced();
			if (mesh.pendingWake() > 0) drive();
		},
		async shutdown(): Promise<void> {
			await mesh.stop();
		},
	};
}
