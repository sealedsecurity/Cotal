import { InboxTurn } from "@cotal-ai/connector-core";
import type { InboxItem, InboxSource } from "@cotal-ai/connector-core";
// Type-only: the event union is erased at build/runtime, so this module has NO oh-my-pi
// value import and loads under plain node/tsx (the oh-my-pi runtime pulls in `bun`, which is
// unloadable off-Bun). The runtime wiring lives in `peer.ts`; this is the injectable loop.
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

export function log(e: unknown): void {
  process.stderr.write(`[oh-my-pi-peer] ${e instanceof Error ? e.message : String(e)}\n`);
}

/**
 * The mesh surface {@link runPeerLoop} drives: presence, reply delivery, and a stream-backed
 * inbox ({@link InboxSource}). The real `MeshAgent` satisfies this structurally; the smoke
 * test passes a fake so the loop can be exercised with no NATS connection.
 */
export interface PeerMesh extends InboxSource {
  readonly id: string;
  setStatus(status: "idle" | "waiting" | "working", activity?: string): Promise<unknown>;
  send(text: string, channel?: string, mentions?: string[]): Promise<unknown>;
  dm(target: string, text: string): Promise<unknown>;
  on(event: "incoming" | "wake", listener: () => void): unknown;
}

/**
 * The slice of the oh-my-pi `AgentSession` the loop drives. The real session satisfies this
 * structurally; the smoke passes a stub whose `prompt`/`steer` record and whose event stream
 * is driven with the scripted `agent_start`/`agent_end` events.
 */
export interface PeerSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<boolean>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

/** A running peer loop. {@link runOmpPeer} owns the mesh + process lifecycle around it. */
export interface PeerLoop {
  /** Abandon any in-flight turn (no ack → redeliver) and tear the session down. */
  shutdown(): Promise<void>;
}

/** Actionable = a DM, an anycast to our role, or a channel message that names us — and not
 *  our own echo. Pure ambient channel chatter is dropped (acked, never answered). */
function actionable(mesh: Pick<PeerMesh, "id">, item: InboxItem): boolean {
  if (item.fromId === mesh.id) return false;
  return item.kind !== "channel" || item.mentionsMe;
}

/** The audience a reply goes back to. A channel message is answered ON that channel
 *  (sender-independent — everyone there already saw it); a DM/anycast is answered privately
 *  to its sender. Two messages with the same scope can share one turn + reply; mixing scopes
 *  cannot (a DM folded into a channel turn would broadcast private content), so different-
 *  scope messages get their own scope-isolated turn. */
function scopeKey(item: InboxItem): string {
  return item.kind === "channel" && item.channel ? `channel:${item.channel}` : `dm:${item.fromId}`;
}

/** Pull this turn's final assistant text from the agent_end payload (not the session-wide
 *  last message), so a turn that produced no text never re-delivers a previous reply. */
function turnReplyText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object" || !("role" in m) || m.role !== "assistant") continue;
    if (!("content" in m) || !Array.isArray(m.content)) continue;
    const text = m.content
      .map((p) => (p && typeof p === "object" && "type" in p && p.type === "text" && "text" in p ? String(p.text ?? "") : ""))
      .join("");
    return text.length ? text : undefined;
  }
  return undefined;
}

/**
 * Wire an oh-my-pi session's event stream to a {@link PeerMesh}'s inbox and run the
 * reply/scope/ack loop. Pure wiring over the two injected surfaces — no NATS, no process
 * lifecycle, no session creation — so it can be driven against fakes ({@link PeerMesh} +
 * {@link PeerSession}) in the smoke test. {@link runOmpPeer} owns the real instances and the
 * mesh/process lifecycle around this.
 *
 * `prompt()` wakes an idle session on the front message, `steer()` interjects into a live one
 * (true mid-turn drive), and presence is read off the session's event stream. The loop owns
 * reply routing, so the model never mis-routes.
 *
 * Delivery is ack-on-surface: the inbox is the single source of truth (no parallel buffer);
 * a turn surfaces a front-contiguous run and `commit()`s (drainInbox-acks) it only once the
 * turn completes, so a crash/interrupt redelivers. Each turn is owned by one reply scope —
 * a mid-turn message is steered in only when it shares that scope; a different-scope message
 * stays on the stream and becomes the next turn's origin — so a private DM is never folded
 * into a channel broadcast.
 *
 * oh-my-pi is a fork of Pi, so this mirrors the `@cotal-ai/pi` connector; one fork
 * divergence is handled here — oh-my-pi surfaces retries as session-level `auto_retry_*`
 * events rather than an `agent_end.willRetry` flag, so an `agent_end` here is always the
 * turn's terminal event.
 */
export function runPeerLoop({
  mesh,
  session,
  // How long a terminal commit waits for a turn's unconfirmed fold steers to settle before giving
  // up on them (un-surfacing → redeliver). A healthy steer settles in ≤1 microtask (its promise
  // resolves at synchronous enqueue-time — no image work on the connector's string-only steers), so
  // allSettled wins this race by orders of magnitude and the timeout never fires on the happy path;
  // it only bounds a genuinely-stuck steer so shutdown/commit can't wedge. 5s is generous headroom
  // over any realistic settle (even a future images-carrying steer's normalize/resize is ~tens of
  // ms) while keeping a stuck-steer commit delay human-tolerable. Injectable so tests don't wait it.
  steerSettleTimeoutMs = 5_000,
}: {
  mesh: PeerMesh;
  session: PeerSession;
  steerSettleTimeoutMs?: number;
}): PeerLoop {
  const turn = new InboxTurn(mesh);
  let streaming = false; // gates steer(): only valid once the agent is actually streaming
  // Set once shutdown() begins so nothing dispatched after teardown drives a disposed session
  // (commit/pump/setStatus/steer on a torn-down loop). Checked at every entry point that can act
  // post-shutdown: pump(), foldSameScope(), the session event handler, the prompt callback
  // (onStartError), and the deferred commit.
  let stopped = false;
  // Monotonic turn counter, bumped on each terminal commit. A fold's steer callback captures the
  // generation it was issued under, so a late settle (a steer resolving after its turn committed)
  // can only mutate ITS OWN turn — never a later turn that re-surfaced a redelivered id (cubic P1).
  let generation = 0;
  // Folds issued in the current turn whose steer() has not settled: id → the settle-chained promise.
  // agent_end awaits these (bounded) so an ACCEPTED fold stays acked and only a rejected/stranded one
  // is un-surfaced. steer() resolving means the session accepted the message into its queue (the
  // model got it); un-surfacing an accepted fold would redeliver a message already delivered, since
  // the mesh only dedups ACKED ids — an un-acked redelivery re-surfaces to the model.
  const pendingSteers = new Map<string, Promise<void>>();

  const setStatus = (status: "idle" | "working", activity?: string): void => {
    void mesh.setStatus(status, activity).catch(() => {});
  };

  const framed = (item: InboxItem): string =>
    `from ${item.fromName} via ${item.kind}: ${item.text}`;

  function deliver(to: InboxItem, text: string): void {
    if (to.kind === "channel" && to.channel) void mesh.send(text, to.channel).catch(log);
    else void mesh.dm(to.fromId, text).catch(log);
  }

  /** Start the next turn on the front actionable message, dropping leading non-actionable
   *  (own echoes, ambient chatter) first. No-op while a turn is in flight or after teardown. */
  function pump(): void {
    if (stopped || turn.inFlight) return;
    turn.drop((i) => !actionable(mesh, i));
    const origin = turn.start();
    if (!origin) {
      setStatus("idle");
      return;
    }
    streaming = false;
    // prompt() resolves false when the session DECLINES the wake (no agent_start/agent_end will
    // follow). Treat that like a pre-flight failure: complete the turn so the peer doesn't wedge
    // with an in-flight-but-never-streaming origin. A true pre-flight throw routes the same way.
    session.prompt(framed(origin)).then(
      (accepted) => {
        if (!accepted && !streaming) onStartError(new Error("session declined the prompt"));
      },
      onStartError,
    );
  }

  /** Fold any front-contiguous, same-scope actionable messages into the live turn (mid-turn
   *  steer). A cross-scope or ambient message breaks contiguity and waits for its own turn. */
  function foldSameScope(): void {
    if (stopped || !turn.origin || !streaming) return;
    const gen = generation; // these folds belong to the current turn; a late settle checks this
    for (const item of turn.extend((i, o) => actionable(mesh, i) && scopeKey(i) === scopeKey(o))) {
      // extend() surfaces synchronously so a re-entrant fold can't re-pick the item; the steer is
      // async. Track the settle-chained promise so agent_end can await the real accept/reject before
      // commit. The generation guard stops a steer that settles after its turn committed from
      // mutating a later turn's ack set (its id long since acked or re-surfaced under a new turn).
      const settle = session.steer(framed(item)).then(
        () => {
          if (gen === generation) pendingSteers.delete(item.id); // accepted → stays surfaced → acked
        },
        (e) => {
          log(e);
          if (gen !== generation) return; // turn already committed → never touch a later turn
          pendingSteers.delete(item.id);
          turn.unsurface(item.id); // rejected → drop from the ack set → redelivers on a later turn
        },
      );
      pendingSteers.set(item.id, settle);
    }
  }

  function onStartError(e: unknown): void {
    log(e);
    if (stopped) return; // torn down mid-flight → never commit/pump/status a disposed session
    if (streaming) return; // already running → agent_end will complete the turn
    turn.commit(); // pre-flight failure (e.g. no model/key): drop, no retry-loop
    setStatus("idle");
    pump();
  }

  /** The sole terminal-commit tail for a streaming turn: un-surface any fold whose steer never
   *  confirmed (redeliver, not ack), ack the rest, bump generation so a late steer settle can no
   *  longer mutate this turn, then advance to the next scope. */
  function finishTurn(to: InboxItem | undefined, reply?: string): void {
    for (const id of pendingSteers.keys()) turn.unsurface(id); // unconfirmed fold → redeliver, not acked
    pendingSteers.clear();
    turn.commit(); // ack the surfaced run (origin + confirmed folds) — clean or failed both consume
    generation++; // supersede: a steer settling after this can't touch the next turn's ack set
    if (to && reply) deliver(to, reply);
    pump(); // next scope
  }

  /** agent_end path with folds still unconfirmed: wait — bounded by {@link steerSettleTimeoutMs} so
   *  a steer that never settles can't hang the turn — for each fold's steer to settle (its handler in
   *  {@link foldSameScope} acks an accepted fold by leaving it surfaced, un-surfaces a rejected one),
   *  then finish. The timeout is generous (a healthy steer settles in ≤1 microtask, so allSettled
   *  wins the race with orders of magnitude to spare — even a slow accept lands well within it, so an
   *  accepted fold is never falsely un-surfaced). A fold STILL pending after the timeout stranded →
   *  finishTurn un-surfaces it (redeliver, the safe direction). Guarded so a shutdown mid-wait or a
   *  superseding turn never commits a stale/disposed turn. */
  async function commitAfterSteers(gen: number, to: InboxItem | undefined, reply?: string): Promise<void> {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, steerSettleTimeoutMs));
    await Promise.race([Promise.allSettled([...pendingSteers.values()]), timeout]);
    if (stopped || gen !== generation) return; // torn down or superseded mid-wait → don't commit
    finishTurn(to, reply);
  }

  mesh.on("incoming", () => {
    if (turn.inFlight) foldSameScope();
    else pump();
  });
  mesh.on("wake", () => {
    if (!turn.inFlight) pump();
  });

  session.subscribe((event: AgentSessionEvent) => {
    if (stopped) return; // teardown began → don't drive a disposed session
    switch (event.type) {
      case "agent_start":
        streaming = true;
        setStatus("working", "thinking");
        foldSameScope(); // flush same-scope peers that landed before streaming began
        break;
      case "tool_execution_start":
        setStatus("working", `running ${event.toolName}`);
        break;
      case "tool_execution_end":
        setStatus("working", "thinking"); // clear the per-tool activity so it can't read stale
        break;
      case "agent_end": {
        // oh-my-pi has no `agent_end.willRetry`; a retry is its own session `auto_retry_*`
        // event and the failed turn still ends here, so `agent_end` is always terminal.
        streaming = false; // done streaming — foldSameScope is now a no-op; no new folds this turn
        const to = turn.origin;
        const reply = turnReplyText(event.messages);
        // No unconfirmed folds → commit synchronously (the common one-message turn, unchanged). With
        // folds still settling, defer the commit until they do so an accepted fold is acked and only
        // a rejected/stranded one redelivers (bounded, generation-guarded).
        if (pendingSteers.size === 0) finishTurn(to, reply);
        else void commitAfterSteers(generation, to, reply);
        break;
      }
    }
  });

  // Drain anything already buffered before the listeners were attached.
  pump();

  return {
    async shutdown(): Promise<void> {
      stopped = true; // block any in-flight prompt/steer/mesh callback from driving a disposed session
      // abort() and dispose() are INDEPENDENT teardown steps: each must run even if the other fails,
      // and neither may propagate out of shutdown() — peer.ts awaits this before mesh.stop(), so a
      // throw here would skip mesh cleanup → ghost peer. Per-call try/catch (not one wrapping block:
      // that would let an abort failure skip dispose) also covers a SYNCHRONOUS throw that a bare
      // .catch() would miss (a non-conforming adapter throwing before it returns its promise).
      try {
        if (turn.inFlight) {
          turn.abandon(); // leave the in-flight run on the stream → redeliver, no peer dropped
          await session.abort();
        }
      } catch (e) {
        log(e); // a failed abort must not skip dispose below
      }
      try {
        await session.dispose(); // await async cleanup before the caller stops the mesh
      } catch (e) {
        log(e); // a failed dispose must not skip the caller's mesh.stop()
      }
    },
  };
}
