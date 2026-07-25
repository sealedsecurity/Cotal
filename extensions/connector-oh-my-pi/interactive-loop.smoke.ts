/**
 * Behavioral smoke for the cotal-mesh delivery loop (`runPeerLoop` in interactive-loop.ts). Repo
 * style: plain assert + console.log, run via `bun interactive-loop.smoke.ts`, non-zero exit on
 * failure. No test framework.
 *
 * Drives the loop with a structural FakeMesh (captures the on(...) handlers so the test can emit
 * incoming/mention-wake/wake, array-backed peek/drain inbox, controllable attention/channelMode/
 * pendingWake, recording setStatus/stop) and a fake host recording sendMessage. The 8 documented
 * invariants of interactive-loop.ts are the spec; each is asserted below.
 */
import { formatInjection, ORIENTATION_BOOTSTRAP, type InboxItem } from "@cotal-ai/connector-core";
import type { AttentionMode, ChannelMode, PresenceStatus } from "@cotal-ai/core";
import { runPeerLoop, INCOMING, NUDGE, type PeerMesh, type PeerHost } from "./src/interactive-loop.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
}

/** Minimal InboxItem builder — required fields per @cotal-ai/connector-core agent.d.ts
 *  (id, ts, fromId, fromName, kind, mentionsMe, historical, text); channel added for kind:"channel". */
function item(partial: Partial<InboxItem> & Pick<InboxItem, "id">): InboxItem {
	return {
		ts: 0,
		fromId: "u1",
		fromName: "Alice",
		kind: "dm",
		mentionsMe: false,
		historical: false,
		text: `msg-${partial.id}`,
		...partial,
	};
}

type MeshEvent = "incoming" | "mention-wake" | "wake";

/** A structural PeerMesh whose handlers, inbox, and modes the test controls directly. */
class FakeMesh implements PeerMesh {
	connected = true;
	attention: AttentionMode = "open";
	inbox: InboxItem[] = [];
	private _channelMode: ChannelMode | undefined = undefined;
	private _pendingWake = 0;
	readonly statusCalls: { status: PresenceStatus; activity?: string }[] = [];
	stopCalls = 0;
	private readonly handlers: Partial<Record<MeshEvent, (item: InboxItem) => void>> = {};

	on(event: "incoming" | "mention-wake", handler: (item: InboxItem) => void): void;
	on(event: "wake", handler: () => void): void;
	on(event: MeshEvent, handler: (item: InboxItem) => void): void {
		this.handlers[event] = handler;
	}

	/** Fire a captured handler as the mesh would. */
	emit(event: MeshEvent, it?: InboxItem): void {
		const h = this.handlers[event];
		assert(h, `loop registered a "${event}" handler`);
		h(it as InboxItem);
	}

	peekInbox(): InboxItem[] {
		return this.inbox;
	}
	drainInbox(limit?: number): InboxItem[] {
		return this.inbox.splice(0, limit ?? this.inbox.length);
	}
	pendingWake(): number {
		return this._pendingWake;
	}
	setPendingWake(n: number): void {
		this._pendingWake = n;
	}
	setChannelMode(mode: ChannelMode | undefined): void {
		this._channelMode = mode;
	}
	channelMode(_channel?: string): ChannelMode | undefined {
		return this._channelMode;
	}
	async setStatus(status: PresenceStatus, activity?: string): Promise<void> {
		this.statusCalls.push({ status, activity });
	}
	async stop(): Promise<void> {
		this.stopCalls++;
	}
}

interface SentCall {
	message: { customType: string; content: string; display: boolean; details: unknown; attribution: "user" | "agent" };
	options: { deliverAs: "steer" | "nextTurn"; triggerTurn: true };
}

/** A fake host that records every sendMessage AND models OMP's delivery routing, so a test can
 *  assert the user-visible landing zone (not just the envelope). Mirrors the real routing in
 *  agent-session.ts `sendCustomMessage`: the deliverAs branch at 7458-7479 sends `nextTurn` to the
 *  hidden `#queueHiddenNextTurnMessage` queue (never `this.agent.steer()`), while a `steer` reaching
 *  a session that is still tearing down a user-interrupted (ESC) turn (`interruptUnwinding` here
 *  models isStreaming still true + #advisorAutoResumeSuppressed latched at 7766-7768) folds via
 *  this.agent.steer() into the editable pending-message UI = the composer. When idle, either mode
 *  wakes a fresh turn via #promptAgentInitiatedMessage (7472-7478), so the happy path is identical.
 *  Keep this fake in sync with agent-session.ts:7458-7479 if OMP's routing changes. */
class FakeHost implements PeerHost {
	readonly sent: SentCall[] = [];
	/** Set true to model OMP still unwinding a user-interrupted (ESC) turn — the bug window. */
	interruptUnwinding = false;
	readonly composer: string[] = []; // editable pending UI — a bleed lands here (the defect)
	readonly held: string[] = []; // hidden next-turn queue — parked, awaiting the deferred continuation
	readonly turns: string[] = []; // content a real turn actually consumed (idle wake, or a held flush)
	sendMessage(message: SentCall["message"], options: SentCall["options"]): void {
		this.sent.push({ message, options });
		if (this.interruptUnwinding) {
			// Mid-unwind: nextTurn parks in the hidden queue (#queueHiddenNextTurnMessage, 7459); a
			// steer would instead fold via this.agent.steer() into the editable composer (7466).
			if (options.deliverAs === "nextTurn") this.held.push(message.content);
			else this.composer.push(message.content);
		} else {
			// Idle: either mode wakes a fresh turn via #promptAgentInitiatedMessage (7472-7478) that
			// consumes the message immediately.
			this.turns.push(message.content);
		}
	}
	/** Model OMP draining the hidden next-turn queue into a real turn — the deferred
	 *  #promptQueuedHiddenNextTurnMessages continuation (7323-7346) that the post-prompt task
	 *  (7298-7321) runs once the interrupted prompt has settled. Parked content becomes consumed
	 *  turn content, exactly as a clean redelivery would. Returns what it flushed. */
	flushHeld(): string[] {
		const flushed = this.held.splice(0, this.held.length);
		this.turns.push(...flushed);
		return flushed;
	}
	get last(): SentCall {
		return this.sent[this.sent.length - 1];
	}
}

/** Assert a sendMessage call carries the fixed nextTurn/turn envelope the loop always uses. */
function assertEnvelope(call: SentCall, customType: string, ctx: string): void {
	assert(call.message.customType === customType, `${ctx}: customType === ${customType}`);
	assert(call.message.display === true, `${ctx}: display true`);
	assert(call.message.attribution === "user", `${ctx}: attribution "user"`);
	assert(JSON.stringify(call.message.details) === "{}", `${ctx}: details {}`);
	assert(call.options.deliverAs === "nextTurn", `${ctx}: deliverAs "nextTurn"`);
	assert(call.options.triggerTurn === true, `${ctx}: triggerTurn true`);
}

// ---- 1. Directed drives when idle, with the correct message/options shape ----------------------
{
	const mesh = new FakeMesh();
	const host = new FakeHost();
	runPeerLoop({ mesh, host });

	// A DM: directed regardless of attention.
	const dm = item({ id: "d1", kind: "dm", text: "hey there" });
	mesh.inbox = [dm];
	mesh.emit("incoming", dm);
	assert(host.sent.length === 1, "1) DM drives one sendMessage when idle");
	assertEnvelope(host.last, INCOMING, "1/dm");
	const inj = formatInjection([dm]);
	assert(inj && host.last.message.content.includes(inj), "1) content carries the formatted injection");

	// A channel message with mentionsMe is also directed even when the channel is quiet + attention dnd.
	const mesh2 = new FakeMesh();
	const host2 = new FakeHost();
	mesh2.attention = "dnd";
	mesh2.setChannelMode("quiet");
	runPeerLoop({ mesh: mesh2, host: host2 });
	const mention = item({ id: "c1", kind: "channel", channel: "general", mentionsMe: true, text: "@me look" });
	mesh2.inbox = [mention];
	mesh2.emit("incoming", mention);
	assert(host2.sent.length === 1, "1) channel @mention drives even in dnd + quiet");
	assertEnvelope(host2.last, INCOMING, "1/mention");
	console.log("1) directed drives when idle OK ✅");
}

// ---- 2. Ambient gating by attention + quiet channelMode ----------------------------------------
{
	// open + non-quiet → drives.
	{
		const mesh = new FakeMesh();
		const host = new FakeHost();
		mesh.attention = "open";
		mesh.setChannelMode(undefined); // non-quiet channel
		runPeerLoop({ mesh, host });
		const it = item({ id: "a1", kind: "channel", channel: "general", mentionsMe: false, text: "ambient chatter" });
		mesh.inbox = [it];
		mesh.emit("incoming", it);
		assert(host.sent.length === 1, "2) ambient drives when open + non-quiet");
	}
	// dnd → does NOT drive (buffered).
	for (const att of ["dnd", "focus"] as AttentionMode[]) {
		const mesh = new FakeMesh();
		const host = new FakeHost();
		mesh.attention = att;
		mesh.setChannelMode(undefined); // non-quiet channel
		runPeerLoop({ mesh, host });
		const it = item({ id: "a2", kind: "channel", channel: "general", mentionsMe: false, text: "ambient" });
		mesh.inbox = [it];
		mesh.emit("incoming", it);
		assert(host.sent.length === 0, `2) ambient does NOT drive when attention=${att}`);
	}
	// open but quiet channel → does NOT drive.
	{
		const mesh = new FakeMesh();
		const host = new FakeHost();
		mesh.attention = "open";
		mesh.setChannelMode("quiet");
		runPeerLoop({ mesh, host });
		const it = item({ id: "a3", kind: "channel", channel: "quietc", mentionsMe: false, text: "ambient" });
		mesh.inbox = [it];
		mesh.emit("incoming", it);
		assert(host.sent.length === 0, "2) ambient does NOT drive on a quiet channel even when open");
	}
	console.log("2) ambient gating by attention + quiet channelMode OK ✅");
}

// ---- 3. No-interrupt while busy ----------------------------------------------------------------
{
	const mesh = new FakeMesh();
	const host = new FakeHost();
	const loop = runPeerLoop({ mesh, host });
	loop.onAgentStart(); // turn in progress
	const dm = item({ id: "b1", kind: "dm", text: "urgent" });
	mesh.inbox = [dm];
	mesh.emit("incoming", dm); // directed, but busy
	assert(host.sent.length === 0, "3) directed item during a turn does NOT interrupt (buffers)");
	const amb = item({ id: "b2", kind: "channel", channel: "general", mentionsMe: false, text: "chatter" });
	mesh.inbox = [dm, amb];
	mesh.emit("incoming", amb);
	assert(host.sent.length === 0, "3) ambient item during a turn does NOT interrupt");
	console.log("3) no-interrupt while busy OK ✅");
}

// ---- 4. Ack-on-surface by id, incl. eviction/reorder cases -------------------------------------
{
	// 4a. Partial: front stays matched for a leading prefix, then diverges → only the prefix drains.
	{
		const mesh = new FakeMesh();
		const host = new FakeHost();
		const loop = runPeerLoop({ mesh, host });
		const a = item({ id: "s1" }), b = item({ id: "s2" }), c = item({ id: "s3" });
		mesh.inbox = [a, b, c];
		mesh.emit("wake"); // surfaces [s1,s2,s3], busy=true
		assert(host.sent.length === 1, "4a) wake surfaced the batch");
		// Before turn end, the front's 3rd slot is replaced (c evicted, x arrived at that position).
		const x = item({ id: "sX" });
		mesh.inbox = [a, b, x];
		loop.onAgentEnd();
		assert(mesh.inbox.map((i) => i.id).join(",") === "sX", "4a) only leading matched prefix [s1,s2] drained; sX remains");
	}
	// 4b. Non-matching front: front[0] no longer matches → NOTHING drained (all redelivered).
	{
		const mesh = new FakeMesh();
		const host = new FakeHost();
		const loop = runPeerLoop({ mesh, host });
		const a = item({ id: "t1" }), b = item({ id: "t2" });
		mesh.inbox = [a, b];
		mesh.emit("wake"); // surfaces [t1,t2]
		// Front-eviction shifts our surfaced prefix out entirely.
		mesh.inbox = [b];
		loop.onAgentEnd();
		assert(mesh.inbox.map((i) => i.id).join(",") === "t2", "4b) non-matching front drains nothing; t2 redelivered");
	}
	// 4c. Ack only happens on onAgentEnd, not at surface time.
	{
		const mesh = new FakeMesh();
		const host = new FakeHost();
		const loop = runPeerLoop({ mesh, host });
		const a = item({ id: "u1" });
		mesh.inbox = [a];
		mesh.emit("wake");
		assert(mesh.inbox.length > 0, "4c) surfacing does NOT drain the inbox");
		loop.onAgentEnd();
		assert(mesh.inbox.length === 0, "4c) onAgentEnd drains the still-matching surfaced batch");
	}
	console.log("4) ack-on-surface by id (incl. eviction/reorder) OK ✅");
}

// ---- 5. Flush next after turn when pendingWake > 0 ---------------------------------------------
{
	const mesh = new FakeMesh();
	const host = new FakeHost();
	const loop = runPeerLoop({ mesh, host });
	loop.onAgentStart(); // busy
	// A batch arrives mid-turn; buffered (no send), and the mesh reports it as pending.
	const buffered = item({ id: "f1", kind: "dm", text: "arrived during turn" });
	mesh.inbox = [buffered];
	mesh.emit("incoming", buffered);
	assert(host.sent.length < 1, "5) buffered during turn — no send yet");
	mesh.setPendingWake(1);
	loop.onAgentEnd();
	assert(host.sent.length === 1, "5) onAgentEnd flushes the buffered batch when pendingWake > 0");
	assertEnvelope(host.last, INCOMING, "5/flush");

	// And when pendingWake === 0, onAgentEnd does NOT drive spuriously.
	const mesh2 = new FakeMesh();
	const host2 = new FakeHost();
	const loop2 = runPeerLoop({ mesh: mesh2, host: host2 });
	loop2.onAgentStart();
	mesh2.inbox = [item({ id: "f2", kind: "dm" })];
	mesh2.setPendingWake(0);
	loop2.onAgentEnd();
	assert(host2.sent.length === 0, "5) onAgentEnd does not flush when pendingWake === 0");
	console.log("5) flush-next after turn when pendingWake > 0 OK ✅");
}

// ---- 6. First turn primed once (orientation bootstrap) -----------------------------------------
{
	const mesh = new FakeMesh();
	const host = new FakeHost();
	const loop = runPeerLoop({ mesh, host });

	const first = item({ id: "p1", kind: "dm", text: "first" });
	mesh.inbox = [first];
	mesh.emit("incoming", first);
	loop.onAgentEnd(); // ack + no pending → no reflow
	assert(host.sent[0].message.content.startsWith(ORIENTATION_BOOTSTRAP), "6) first delivery is prefixed with the orientation bootstrap");

	const second = item({ id: "p2", kind: "dm", text: "second" });
	mesh.inbox = [second];
	mesh.emit("incoming", second);
	assert(!host.sent[1].message.content.startsWith(ORIENTATION_BOOTSTRAP), "6) later deliveries are NOT re-primed");
	console.log("6) first turn primed once OK ✅");
}

// ---- 7. mention-wake drives a NUDGE naming the sender + cotal_inbox ------------------------------
{
	const mesh = new FakeMesh();
	const host = new FakeHost();
	const loop = runPeerLoop({ mesh, host });
	const mw = item({ id: "m1", kind: "channel", channel: "general", fromName: "Bob", mentionsMe: true, text: "@me" });
	mesh.emit("mention-wake", mw);
	assert(host.sent.length === 1, "7) mention-wake drives one message when idle");
	assertEnvelope(host.last, NUDGE, "7/nudge");
	const content = host.last.message.content;
	assert(content.includes("Bob"), "7) nudge names the sender");
	assert(content.includes("cotal_inbox"), "7) nudge says to use cotal_inbox");
	assert(content.includes("#general"), "7) nudge names the channel");

	// mention-wake while busy does NOT drive.
	const mesh2 = new FakeMesh();
	const host2 = new FakeHost();
	const loop2 = runPeerLoop({ mesh: mesh2, host: host2 });
	loop2.onAgentStart();
	mesh2.emit("mention-wake", mw);
	assert(host2.sent.length === 0, "7) mention-wake during a turn does NOT interrupt");
	console.log("7) mention-wake NUDGE OK ✅");
}

// ---- 8. shutdown stops the mesh ----------------------------------------------------------------
{
	const mesh = new FakeMesh();
	const host = new FakeHost();
	const loop = runPeerLoop({ mesh, host });
	await loop.shutdown();
	assert(mesh.stopCalls === 1, "8) shutdown calls mesh.stop() exactly once");
	console.log("8) shutdown stops mesh OK ✅");
}

// ---- 9. ESC-interrupt: a queued message is HELD for redelivery, never bled into the composer ----
// Repro for the reported defect: hitting ESC to interrupt a running turn while a cotal message is
// waiting must not land the message text in the editable composer. The connector cannot observe the
// interrupt (agent_end/ExtensionContext carry no abort reason), so it must deliver in a mode that is
// hidden-from-composer under OMP's own contract. `nextTurn` is that mode: idle → a fresh turn wakes
// as before; still-unwinding after an ESC → parked in the hidden next-turn queue, redelivered clean.
// A `steer` (the pre-fix envelope) bleeds into the composer in that window — this asserts it doesn't.
{
	const mesh = new FakeMesh();
	const host = new FakeHost();
	const loop = runPeerLoop({ mesh, host });

	// The turn the user is about to ESC out of.
	loop.onAgentStart();
	// A directed DM arrives while that turn is live — buffered by the no-interrupt gate, not delivered.
	const dm = item({ id: "esc1", kind: "dm", text: "peer ping during a turn" });
	mesh.inbox = [dm];
	mesh.emit("incoming", dm);
	assert(host.sent.length === 0, "9) message arriving mid-turn is buffered, not delivered");

	// User hits ESC: OMP aborts with USER_INTERRUPT and is still tearing the turn down when the
	// connector's turn-end hook fires and flushes the buffered message (pendingWake mirrors the real
	// MeshAgent reporting the mid-turn arrival as a pending wake, exactly as test 5 drives it).
	mesh.setPendingWake(1);
	host.interruptUnwinding = true;
	loop.onAgentEnd();

	assert(host.sent.length === 1, "9) the buffered message is delivered at turn end");
	assert(host.composer.length === 0, `9) message must NOT bleed into the composer (got ${JSON.stringify(host.composer)})`);
	assert(host.held.length === 1 && host.held[0].includes("peer ping during a turn"), "9) message is HELD for clean redelivery");
	// It stays unacked (still leads the inbox) so it redelivers as a normal peer message next turn.
	assert(mesh.peekInbox().some((i) => i.id === "esc1"), "9) held message stays on the inbox for redelivery");
	// The other half of the acceptance ("held + redelivered next turn"): prove held-AND-DELIVERED,
	// not just held-AND-acked. OMP's deferred continuation (#promptQueuedHiddenNextTurnMessages,
	// 7323-7346) drains the hidden queue into a real turn once the interrupted prompt settles — model
	// that flush and assert the parked content actually reached a turn before we let the ack stand.
	host.interruptUnwinding = false;
	const flushed = host.flushHeld();
	assert(flushed.length === 1 && flushed[0].includes("peer ping during a turn"), "9) held message is flushed into a real turn (delivered, not dropped)");
	assert(host.turns.some((t) => t.includes("peer ping during a turn")), "9) the redelivered message was consumed by a turn");
	// Only now, when that clean turn ends, does the connector ack — draining the peer inbox. This is
	// the ack-on-turn-end path (interactive-loop.ts ackSurfaced) that nextTurn preserves.
	mesh.setPendingWake(0);
	loop.onAgentEnd();
	assert(mesh.peekInbox().length === 0, "9) the message is acked (drained) only after it was delivered into a turn");
	console.log("9) ESC-interrupt holds the message, no composer bleed OK ✅");
}

console.log("\nCOTAL-MESH LOOP SMOKE OK ✅");
process.exit(0);
