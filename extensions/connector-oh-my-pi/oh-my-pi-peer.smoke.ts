/**
 * Smoke test for the @cotal-ai/oh-my-pi peer loop (no NATS/LLM needed): drives
 * `runPeerLoop({ mesh, session })` against a fake MeshAgent and a scripted stub session, and
 * asserts the reply-routing / scope-isolation / ack-on-surface invariants the native embed
 * relies on — including the oh-my-pi fork divergence (an `agent_end` carries no `willRetry`,
 * so it is always the turn's terminal event).
 *
 *   pnpm smoke:oh-my-pi
 */
import { EventEmitter } from "node:events";
import { runPeerLoop, type PeerMesh, type PeerSession } from "./src/loop.js";
import type { InboxItem } from "@cotal-ai/connector-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

// --- message factories -------------------------------------------------------------------
function dm(id: string, fromId: string, text = id): InboxItem {
  return { id, ts: 0, fromId, fromName: fromId, kind: "dm", mentionsMe: false, historical: false, text };
}
function chan(
  id: string,
  fromId: string,
  opts: { mentionsMe?: boolean; channel?: string; text?: string } = {},
): InboxItem {
  const { mentionsMe = true, channel = "general", text = id } = opts;
  return {
    id,
    ts: 0,
    fromId,
    fromName: fromId,
    kind: "channel",
    channel,
    mentionsMe,
    historical: false,
    text,
  };
}
const framed = (i: InboxItem): string => `from ${i.fromName} via ${i.kind}: ${i.text}`;

// --- scripted session-event factories ----------------------------------------------------
const START: AgentSessionEvent = { type: "agent_start" };
const toolStart = (toolName: string): AgentSessionEvent =>
  ({ type: "tool_execution_start", toolCallId: "t", toolName, args: {} }) as AgentSessionEvent;
/** A NORMAL `agent_end` — the oh-my-pi fork has no `willRetry` field, so this is terminal. */
const end = (reply?: string): AgentSessionEvent =>
  ({
    type: "agent_end",
    messages: reply ? [{ role: "assistant", content: [{ type: "text", text: reply }] }] : [],
  }) as AgentSessionEvent;

// --- fakes -------------------------------------------------------------------------------
interface Sent {
  text: string;
  channel?: string;
}
interface DirectMsg {
  target: string;
  text: string;
}

/** Mirrors the MeshAgent slice the loop uses: an EventEmitter (`incoming`/`wake`) plus a
 *  stream-backed inbox (drainInbox acks by front position, ackInbox acks by id, absent id is a
 *  no-op) and record-only presence/delivery. */
class FakeMesh extends EventEmitter implements PeerMesh {
  readonly id = "me";
  items: InboxItem[] = [];
  acked: InboxItem[] = [];
  statuses: { status: string; activity?: string }[] = [];
  sends: Sent[] = [];
  dms: DirectMsg[] = [];

  peekInbox(): InboxItem[] {
    return [...this.items];
  }
  drainInbox(limit?: number): InboxItem[] {
    const n = limit && limit > 0 ? Math.min(limit, this.items.length) : this.items.length;
    const taken = this.items.splice(0, n);
    this.acked.push(...taken);
    return taken;
  }
  ackInbox(ids: string[]): InboxItem[] {
    const wanted = new Set(ids);
    const taken: InboxItem[] = [];
    this.items = this.items.filter((p) => {
      if (!wanted.has(p.id)) return true;
      this.acked.push(p);
      taken.push(p);
      return false;
    });
    return taken;
  }
  async setStatus(status: "idle" | "waiting" | "working", activity?: string): Promise<void> {
    this.statuses.push({ status, activity });
  }
  async send(text: string, channel?: string): Promise<unknown> {
    this.sends.push({ text, channel });
    return {};
  }
  async dm(target: string, text: string): Promise<unknown> {
    this.dms.push({ target, text });
    return {};
  }

  /** Deliver a message: buffer it, then wake the loop on the given mesh event. */
  arrive(item: InboxItem, event: "incoming" | "wake" = "incoming"): void {
    this.items.push(item);
    this.emit(event);
  }
}

/** A scripted oh-my-pi session: `prompt`/`steer` only RECORD (the test drives the
 *  `agent_start`/`tool_execution_*`/`agent_end` stream explicitly via {@link emit}), so a turn's
 *  lifecycle is fully controllable — a live turn can be held open while same-scope peers are
 *  folded in before it ends. */
class StubSession implements PeerSession {
  prompts: string[] = [];
  steers: string[] = [];
  aborted = 0;
  disposed = 0;
  private listeners: ((event: AgentSessionEvent) => void)[] = [];

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {};
  }
  emit(event: AgentSessionEvent): void {
    for (const l of this.listeners) l(event);
  }
  async prompt(text: string): Promise<boolean> {
    this.prompts.push(text);
    return true;
  }
  async steer(text: string): Promise<void> {
    this.steers.push(text);
  }
  async abort(): Promise<void> {
    this.aborted++;
  }
  async dispose(): Promise<void> {
    this.disposed++;
  }
}

const ids = (xs: InboxItem[]): string => xs.map((x) => x.id).join(",");
const last = <T>(xs: T[]): T => xs[xs.length - 1];

// 1) reply routing by scope: a DM is answered privately; a channel message on the channel;
//    a DM is NEVER broadcast to a channel and vice-versa.
{
  // (a) DM → dm, never send
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("q1", "alice", "hi")];
  runPeerLoop({ mesh, session });
  assert(session.prompts[0] === framed(dm("q1", "alice", "hi")), "DM origin framed + prompted");
  session.emit(START);
  session.emit(end("hello alice"));
  assert(mesh.dms.length === 1 && mesh.dms[0].target === "alice", "DM answered privately to sender");
  assert(mesh.dms[0].text === "hello alice", "DM reply is this turn's text");
  assert(mesh.sends.length === 0, "a DM is never broadcast to a channel");
}
{
  // (b) channel (mentions us) → send on that channel, never dm
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [chan("c1", "bob", { channel: "eng", text: "hey me" })];
  runPeerLoop({ mesh, session });
  session.emit(START);
  session.emit(end("hi eng"));
  assert(mesh.sends.length === 1 && mesh.sends[0].channel === "eng", "channel msg answered on its channel");
  assert(mesh.sends[0].text === "hi eng", "channel reply is this turn's text");
  assert(mesh.dms.length === 0, "a channel reply is never sent as a private DM");
}
console.log("1) reply routing by scope OK ✅");

// 2) actionable filter: own echoes (fromId === mesh.id) and ambient channel chatter (not
//    mentionsMe) are dropped — acked, never prompted, never answered.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("echo", "me"), chan("amb", "bob", { mentionsMe: false })];
  runPeerLoop({ mesh, session });
  assert(session.prompts.length === 0, "no actionable message → nothing prompted");
  assert(ids(mesh.acked) === "echo,amb", "own echo + ambient chatter are ack-dropped");
  assert(mesh.dms.length === 0 && mesh.sends.length === 0, "neither is ever answered");
  assert(last(mesh.statuses).status === "idle", "empty of actionable → idle");
}
console.log("2) actionable filter OK ✅");

// 3) same-scope fold: two same-scope messages arriving during a live turn fold in via steer;
//    a different-scope message breaks contiguity and opens its own next turn.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("a1", "alice", "q1")];
  runPeerLoop({ mesh, session });
  session.emit(START); // turn is now live (streaming)
  mesh.arrive(dm("a2", "alice", "q2")); // same scope → folded via steer
  mesh.arrive(dm("b1", "bob", "qb")); // different scope → NOT folded, waits its turn
  assert(session.steers.length === 1 && session.steers[0] === framed(dm("a2", "alice", "q2")),
    "same-scope peer folded via steer; cross-scope not folded");
  assert(mesh.items.some((x) => x.id === "b1"), "cross-scope message stays on the stream");
  session.emit(end("ans")); // terminal → commit alice run, deliver, pump next scope
  assert(ids(mesh.acked) === "a1,a2", "the surfaced same-scope run [a1,a2] was acked on end");
  assert(mesh.dms.length === 1 && mesh.dms[0].target === "alice", "one reply delivered to the shared scope");
  assert(session.prompts[1] === framed(dm("b1", "bob", "qb")), "cross-scope msg opens its own next turn");
}
console.log("3) same-scope fold OK ✅");

// 4) ack-on-surface: a surfaced message is acked ONLY on agent_end; an in-flight turn on
//    shutdown abandons (no ack → redelivers).
{
  // (a) acked only on agent_end
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("s1", "alice")];
  runPeerLoop({ mesh, session });
  assert(mesh.acked.length === 0, "surfaced-but-unacked before the turn completes");
  session.emit(START);
  assert(mesh.acked.length === 0, "agent_start does not ack");
  session.emit(end("done"));
  assert(ids(mesh.acked) === "s1", "agent_end acks the surfaced run");
}
{
  // (b) in-flight shutdown abandons — no ack, redelivers
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("s1", "alice")];
  const loop = runPeerLoop({ mesh, session });
  session.emit(START); // turn in flight
  await loop.shutdown();
  assert(mesh.acked.length === 0, "in-flight shutdown acks nothing → redeliver");
  assert(ids(mesh.items) === "s1", "the in-flight message stays on the stream");
  assert(session.aborted === 1, "shutdown aborts the live turn");
  assert(session.disposed === 1, "shutdown disposes the session");
}
console.log("4) ack-on-surface OK ✅");

// 5) presence mapping: agent_start → working(thinking), tool_execution_start →
//    working(running <tool>), agent_end → idle (via mesh.setStatus).
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("p1", "alice")];
  runPeerLoop({ mesh, session });
  session.emit(START);
  assert(last(mesh.statuses).status === "working" && last(mesh.statuses).activity === "thinking",
    "agent_start → working(thinking)");
  session.emit(toolStart("bash"));
  assert(last(mesh.statuses).status === "working" && last(mesh.statuses).activity === "running bash",
    "tool_execution_start → working(running <tool>)");
  session.emit(end("ok"));
  assert(last(mesh.statuses).status === "idle", "agent_end (inbox now empty) → idle");
}
console.log("5) presence mapping OK ✅");

// 6) oh-my-pi fork specific: an `agent_end` has NO `willRetry`; assert a normal agent_end is
//    treated as terminal — it commits, delivers, and pumps the next scope's turn.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("a1", "alice", "qa"), dm("b1", "bob", "qb")]; // two distinct scopes, FIFO
  runPeerLoop({ mesh, session });
  assert(session.prompts[0] === framed(dm("a1", "alice", "qa")), "first turn starts on the front DM");
  session.emit(START); // fold pass: bob is a different scope → not folded
  assert(session.steers.length === 0, "cross-scope bob is not folded into alice's turn");
  const terminal = end("ra");
  assert(!("willRetry" in terminal), "the oh-my-pi agent_end carries no willRetry flag");
  session.emit(terminal); // terminal: commit + deliver + pump next
  assert(ids(mesh.acked) === "a1", "terminal agent_end committed alice's run");
  assert(mesh.dms.length === 1 && mesh.dms[0].target === "alice", "terminal agent_end delivered alice's reply");
  assert(session.prompts[1] === framed(dm("b1", "bob", "qb")), "terminal agent_end pumped the next scope's turn");
  session.emit(START);
  session.emit(end("rb"));
  assert(ids(mesh.acked) === "a1,b1" && mesh.dms.length === 2, "the pumped bob turn also commits + delivers");
}
console.log("6) agent_end terminal without willRetry OK ✅");

console.log("OH-MY-PI PEER SMOKE OK ✅");
