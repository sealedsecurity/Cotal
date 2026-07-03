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
export function runPeerLoop({ mesh, session }: { mesh: PeerMesh; session: PeerSession }): PeerLoop {
  const turn = new InboxTurn(mesh);
  let streaming = false; // gates steer(): only valid once the agent is actually streaming

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
   *  (own echoes, ambient chatter) first. No-op while a turn is in flight. */
  function pump(): void {
    if (turn.inFlight) return;
    turn.drop((i) => !actionable(mesh, i));
    const origin = turn.start();
    if (!origin) {
      setStatus("idle");
      return;
    }
    streaming = false;
    void session.prompt(framed(origin)).catch(onStartError); // wake into a fresh turn
  }

  /** Fold any front-contiguous, same-scope actionable messages into the live turn (mid-turn
   *  steer). A cross-scope or ambient message breaks contiguity and waits for its own turn. */
  function foldSameScope(): void {
    if (!turn.origin || !streaming) return;
    for (const item of turn.extend((i, o) => actionable(mesh, i) && scopeKey(i) === scopeKey(o))) {
      void session.steer(framed(item)).catch(log);
    }
  }

  function onStartError(e: unknown): void {
    log(e);
    if (streaming) return; // already running → agent_end will complete the turn
    turn.commit(); // pre-flight failure (e.g. no model/key): drop, no retry-loop
    setStatus("idle");
    pump();
  }

  mesh.on("incoming", () => {
    if (turn.inFlight) foldSameScope();
    else pump();
  });
  mesh.on("wake", () => {
    if (!turn.inFlight) pump();
  });

  session.subscribe((event: AgentSessionEvent) => {
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
        const to = turn.origin;
        const reply = turnReplyText(event.messages);
        turn.commit(); // ack the surfaced run — clean or failed both consume (no retry-loop)
        streaming = false;
        if (to && reply) deliver(to, reply);
        pump(); // next scope
        break;
      }
    }
  });

  // Drain anything already buffered before the listeners were attached.
  pump();

  return {
    async shutdown(): Promise<void> {
      if (turn.inFlight) {
        turn.abandon(); // leave the in-flight run on the stream → redeliver, no peer dropped
        await session.abort();
      }
      void session.dispose();
    },
  };
}
