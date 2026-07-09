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

/** Drain all pending microtasks (a macrotask tick) so an async prompt/steer callback chain has
 *  settled before we assert — hop-count-independent, unlike a single `await Promise.resolve()`. */
const drain = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

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
  /** Opt-in: value `prompt()` resolves to. Default `true` (session accepts the wake). Set
   *  `false` to simulate a DECLINED wake (no agent_start/agent_end follows). */
  promptResult = true;
  /** Opt-in: when `true`, `steer()` records then REJECTS (the fold couldn't reach the model
   *  turn). Default `false` (records + resolves as before). */
  steerReject = false;
  /** Opt-in: when `true`, `dispose()` records then REJECTS (an SDK teardown that throws).
   *  Default `false` (records + resolves as before, so tests 1-9 are unchanged). */
  disposeReject = false;
  /** Opt-in (test 14): when `true`, `steer()` records then returns a promise that NEVER settles,
   *  so a fold stays pending forever. Exercises the BOUNDED deferred commit — the terminal commit
   *  must still fire (the macrotask boundary wins the race). Default `false` (tests 1-13 unchanged). */
  steerHang = false;
  /** Opt-in (test 12): when `true`, `steer()` records then returns a PENDING promise whose reject
   *  fn is pushed onto {@link rejectSteer}, so the test controls exactly WHEN the fold settles.
   *  Firing the reject after the fold's turn committed exercises the generation guard. Default
   *  `false` (tests 1-11/13/14 keep the one-hop resolve/reject path). */
  deferSteer = false;
  /** Captured reject fns for deferred steers (see {@link deferSteer}): `rejectSteer[i]()` rejects
   *  the i-th folded steer on demand. Empty unless `deferSteer` is set. */
  rejectSteer: (() => void)[] = [];
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
    return this.promptResult;
  }
  steer(text: string): Promise<void> {
    this.steers.push(text);
    // A never-settling steer (test 14): the fold stays pending; the deferred commit must still
    // fire off its bounded macrotask boundary, so a hung steer can't wedge the turn.
    if (this.steerHang) return new Promise<void>(() => {});
    // A test-controlled deferred steer (test 12): capture the reject so the test can settle the
    // fold at a chosen moment (e.g. AFTER its turn committed, to exercise the generation guard).
    if (this.deferSteer) {
      const { promise, reject } = Promise.withResolvers<void>();
      this.rejectSteer.push(() => reject(new Error("steer rejected (deferred)")));
      return promise;
    }
    // A non-async return so a rejected steer settles in ONE microtask (an `async` method would
    // adopt the thenable and take extra ticks) — the loop's `.catch → unsurface` then runs after
    // a single `await Promise.resolve()`, matching how the real session rejects.
    return this.steerReject ? Promise.reject(new Error("steer rejected")) : Promise.resolve();
  }
  async abort(): Promise<void> {
    this.aborted++;
  }
  dispose(): Promise<void> {
    this.disposed++;
    // A non-async return so a rejected dispose settles in ONE microtask (mirrors `steer`) — the
    // loop's `.catch(log)` then swallows it and `shutdown()` still resolves.
    return this.disposeReject ? Promise.reject(new Error("dispose rejected")) : Promise.resolve();
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
  await Promise.resolve(); // let the folded steer's .then (pendingSteerIds.delete) confirm before commit
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

// 7) declined prompt completes the turn (no wedge): prompt() resolving false means the session
//    DECLINED the wake — no agent_start/agent_end follows. The turn must still complete (ack the
//    origin, go idle) and the NEXT message must pump; pre-fix the origin was never acked and the
//    peer wedged with an in-flight-but-never-streaming turn.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("d1", "alice", "q")];
  session.promptResult = false; // the session declines the wake
  runPeerLoop({ mesh, session }); // pump fires → prompt called → resolves false, no START emitted
  await drain(); // let the async prompt().then chain settle (2 hops) before asserting
  assert(session.prompts.length === 1, "the declined origin was prompted exactly once");
  assert(ids(mesh.acked) === "d1", "declined origin committed (acked, drop/no-retry) — not wedged");
  assert(last(mesh.statuses).status === "idle", "the peer went idle after the decline");
  mesh.arrive(dm("d2", "bob", "q2")); // a fresh message must pump — the peer is not wedged
  await drain();
  assert(session.prompts[1] === framed(dm("d2", "bob", "q2")), "a fresh turn pumped after the decline");
}
console.log("7) declined prompt completes the turn (no wedge) OK ✅");

// 8) rejected steer un-surfaces its message (redelivers, not lost): a folded same-scope message
//    is surfaced then steered; if steer() REJECTS the message never reached the model turn, so the
//    terminal commit must NOT ack it — it stays on the stream and redelivers. Pre-fix commit acked
//    the undelivered fold (acked === "a1,a2") and the message was lost from the stream.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("a1", "alice", "q1")];
  session.steerReject = true; // the fold's steer will reject (never reaches the model turn)
  runPeerLoop({ mesh, session });
  session.emit(START); // turn live, streaming
  mesh.arrive(dm("a2", "alice", "q2")); // same scope → foldSameScope → extend surfaces a2, steer rejects
  await drain(); // let the steer().catch → turn.unsurface(a2) run
  session.emit(end("ans")); // terminal → commit acks the surfaced run
  assert(ids(mesh.acked) === "a1", "only the delivered origin a1 acked; the rejected fold a2 is not");
  assert(mesh.items.some((x) => x.id === "a2"), "a2 stays on the stream (redelivers, not lost)");
  assert(session.steers.length === 1, "the fold attempted the steer exactly once");
}
console.log("8) rejected steer un-surfaces its message (redelivers) OK ✅");

// 9) the steer-ack RACE (agent_end commits before the rejection's .catch runs): the stricter
//    sibling of test 8. Test 8 drains BEFORE agent_end, so the rejected fold's
//    `.catch → unsurface` has already run and commit() sees a2 gone — it passes even on the
//    intermediate c09b21e (plain `.catch(→unsurface)` fold + immediate commit()). Here we do NOT
//    drain at the critical point: we emit agent_end in the SAME tick the steer rejected, so
//    commit() runs while a2's rejection `.catch` is still a queued microtask. Only the final fix
//    (7c73207: un-surface every still-pending fold in agent_end, before commit) survives — on
//    c09b21e commit() acks a2 before the late `.catch` (which then no-ops on a reset turn) and a2
//    is lost.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("a1", "alice", "q1")];
  session.steerReject = true; // the fold's steer will reject (never reaches the model turn)
  runPeerLoop({ mesh, session });
  session.emit(START); // turn live, streaming
  mesh.arrive(dm("a2", "alice", "q2")); // same scope → foldSameScope surfaces a2, steer() rejects
  // RACE WINDOW: do NOT drain. Emit agent_end immediately — commit() runs while a2's rejection
  // `.catch` is still queued, so only the final fix's in-agent_end un-surface saves a2.
  session.emit(end("ans")); // terminal → commit
  await drain(); // now let the steer rejection's `.catch` settle before asserting
  assert(ids(mesh.acked) === "a1",
    "RACE: only the delivered origin a1 acked; the rejected fold a2 is not (c09b21e acks a1,a2)");
  assert(mesh.items.some((x) => x.id === "a2"),
    "RACE: a2 stayed on the stream → redelivers (c09b21e loses it)");
  assert(session.steers.length === 1, "the fold attempted the steer exactly once");
}
console.log("9) steer-ack race: agent_end before rejection settles does not ack the fold OK ✅");

// 10) a rejecting dispose() must NOT reject loop.shutdown(): peer.ts does `await loop.shutdown()`
//     THEN `await mesh.stop()`. If shutdown() rejects (an SDK dispose() that throws), mesh.stop()
//     is skipped → the peer leaves a ghost presence on the mesh. The final fix
//     (`await session.dispose().catch(log)`) swallows the dispose failure so shutdown() resolves;
//     on c09b21e (bare `await session.dispose()`) it rejects.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("s1", "alice")];
  session.disposeReject = true; // the SDK teardown will throw
  const loop = runPeerLoop({ mesh, session });
  // Complete a turn so turn.inFlight is false at shutdown and it goes straight to the dispose() line.
  session.emit(START);
  await drain();
  session.emit(end("x"));
  await drain();
  let resolved = false;
  try {
    await loop.shutdown();
    resolved = true;
  } catch {
    resolved = false;
  }
  assert(resolved === true,
    "loop.shutdown() RESOLVED despite the rejecting dispose (c09b21e rejects → mesh.stop skipped)");
  assert(session.disposed === 1, "dispose was still attempted exactly once");
}
console.log("10) rejecting dispose does not reject shutdown (mesh.stop still runs) OK ✅");

// 11) an ACCEPTED steer is ACKED, not redelivered (the exact inverse of test 9): a same-scope
//     fold whose steer() RESOLVES (the session accepted the message into its turn) must be acked
//     even when agent_end fires in the SAME tick — before the accept's `.then(delete)` microtask
//     has flushed. The deferred commit awaits the still-pending fold, sees it accepted, and acks
//     it. Un-acking an accepted fold would REDELIVER a message the model already got (the mesh
//     dedups only ACKED ids, so an un-acked id re-surfaces to the model). This is the greptile
//     finding: 6f82f76 un-surfaces every still-pending fold in agent_end unconditionally, so an
//     accepted-but-not-yet-flushed fold is dropped from the ack set → double delivery.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("a1", "alice", "q1")]; // steer ACCEPTS (default steerReject=false)
  runPeerLoop({ mesh, session });
  session.emit(START); // turn live, streaming
  mesh.arrive(dm("a2", "alice", "q2")); // same scope → fold; steer() RESOLVES, its .then(delete) queued
  // RACE WINDOW: do NOT drain. Emit agent_end while a2's accept `.then` is still a queued microtask,
  // so pendingSteers is non-empty → the commit is DEFERRED until the accept settles.
  session.emit(end("ans"));
  await drain(); // the deferred commit awaits the accept (microtask) then commits within this tick
  assert(ids(mesh.acked) === "a1,a2",
    "ACCEPTED fold a2 is acked with the origin (6f82f76 acks only a1 → a2 redelivers)");
  assert(!mesh.items.some((x) => x.id === "a2"),
    "a2 left the stream (acked, won't redeliver); 6f82f76 leaves it → double delivery");
  assert(session.steers.length === 1, "the fold attempted the steer exactly once");
}
console.log("11) accepted steer is acked, not redelivered OK ✅");

// 12) a late steer settle does NOT mutate a LATER turn (cubic P1, the generation guard): a fold's
//     steer that settles AFTER its turn committed must be a no-op — it must never strip an id the
//     NEXT turn re-surfaced. Turn 1 folds a2 with a test-controlled (deferred) steer; the fold is
//     stranded past the macrotask boundary → un-surfaced (redelivered) and turn 1 commits, bumping
//     the generation. a2 redelivers as turn 2's origin. THEN, while turn 2 holds a2 surfaced-but-
//     uncommitted, we fire the STALE turn-1 steer reject. On the fixed loop the callback captured
//     turn 1's generation and no-ops. On 6f82f76 the reject's `.catch` calls turn.unsurface("a2")
//     on the live turn 2 (no generation guard) → strips a2 from turn 2's ack set → a2 is never
//     acked and redelivers forever.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  session.deferSteer = true; // turn 1's fold steer stays pending until we fire rejectSteer[0]()
  mesh.items = [dm("a1", "alice", "q1")];
  runPeerLoop({ mesh, session });
  session.emit(START); // turn 1 live
  mesh.arrive(dm("a2", "alice", "q2")); // fold a2 under generation g0; steer deferred (unsettled)
  session.emit(end("r1")); // pendingSteers non-empty → deferred commit races the macrotask boundary
  await drain(); // boundary wins: a2 still pending → un-surfaced (redeliver), turn 1 commits, gen→g1
  assert(ids(mesh.acked) === "a1", "turn 1 acked only its origin a1; the stranded fold a2 redelivers");
  assert(session.prompts.length === 2 && session.prompts[1] === framed(dm("a2", "alice", "q2")),
    "a2 redelivered as turn 2's origin");
  session.emit(START); // turn 2 live: a2 surfaced, NOT yet committed
  // Fire the STALE turn-1 (g0) steer reject now, WHILE turn 2 holds a2 surfaced. On the fix the
  // g0 callback sees generation moved on and no-ops; on 6f82f76 it strips a2 from turn 2.
  session.rejectSteer[0]();
  await drain();
  session.emit(end("r2")); // turn 2 commits
  await drain();
  assert(mesh.acked.filter((x) => x.id === "a2").length === 1,
    "a2 acked exactly once under turn 2; the stale g0 reject was a no-op (6f82f76 strips it → 0)");
  assert(!mesh.items.some((x) => x.id === "a2"),
    "a2 left the stream after turn 2 (6f82f76 leaves it surfaced-then-stripped → redelivers)");
}
console.log("12) late steer settle does not mutate a later turn (generation guard) OK ✅");

// 13) shutdown blocks further dispatch (cubic P2, the stopped-guards): once shutdown() begins, a
//     mesh `incoming`/`wake` event must NOT start a new turn on the disposed session. The initial
//     pump surfaces s1 (prompt pending, no START → not streaming); shutdown abandons it and disposes.
//     A post-shutdown arrive+wake must not re-pump. 6f82f76's pump() has no stopped guard → the
//     late incoming starts a turn and prompts the disposed session.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  mesh.items = [dm("s1", "alice")];
  const loop = runPeerLoop({ mesh, session }); // pump → surfaces s1, prompt(s1) pending (no START)
  await drain(); // let the initial prompt(s1) settle; turn is surfaced-but-not-streaming
  await loop.shutdown(); // stopped=true; abandon in-flight s1 (redeliver); dispose
  assert(session.disposed === 1, "shutdown disposed the session");
  const promptsBefore = session.prompts.length; // exactly the one pre-shutdown s1 prompt
  mesh.arrive(dm("s2", "bob")); // post-shutdown incoming → pump() must early-return (stopped)
  mesh.emit("wake"); // post-shutdown wake → pump() must early-return (stopped)
  await drain();
  assert(session.prompts.length === promptsBefore,
    "no new prompt after shutdown (pump stopped-guard); 6f82f76 re-pumps the disposed session");
}
console.log("13) shutdown blocks further dispatch (stopped-guard) OK ✅");

// 14) strand safety — a never-settling steer does NOT hang the terminal commit (mercator's
//     insurance test, a forward guard). The deferred commit races the pending folds against a
//     one-macrotask boundary, so even a steer that NEVER settles cannot wedge the turn: the
//     boundary wins, the turn commits (origin acked), and the unconfirmed fold is un-surfaced
//     (redeliver — the safe direction, since the model may never have received it). This is NOT a
//     6f82f76 differentiator: 6f82f76 commits synchronously so it also would not hang here. Test 14
//     GUARDS the new deferred path — it FAILS if someone later drops the boundary and awaits
//     allSettled unbounded (the commit would then never fire and this test would hang, never
//     reaching its asserts). See the throwaway boundary-removed probe reported alongside this file.
{
  const mesh = new FakeMesh();
  const session = new StubSession();
  session.steerHang = true; // the fold's steer never resolves or rejects
  mesh.items = [dm("a1", "alice", "q1")];
  runPeerLoop({ mesh, session });
  session.emit(START); // turn live, streaming
  mesh.arrive(dm("a2", "alice", "q2")); // fold a2; steer hangs → a2 stays pending forever
  session.emit(end("ans")); // pendingSteers non-empty → deferred commit races the boundary
  await drain(); // ONE macrotask tick — the boundary wins the race, commit fires without the steer
  assert(mesh.acked.some((x) => x.id === "a1"),
    "the turn COMMITTED off the bounded wait (a1 acked) — a hung steer did not wedge it");
  assert(mesh.items.some((x) => x.id === "a2"),
    "the never-confirmed fold a2 was un-surfaced → stays on the stream to redeliver (safe direction)");
  assert(session.steers.length === 1, "the hung fold attempted the steer exactly once");
}
console.log("14) strand safety: never-settling steer does not hang commit OK ✅");

console.log("OH-MY-PI PEER SMOKE OK ✅");
