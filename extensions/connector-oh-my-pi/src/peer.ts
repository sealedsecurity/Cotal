import { MeshAgent, configFromEnv } from "@cotal-ai/connector-core";
// oh-my-pi's published root barrel (`@oh-my-pi/pi-coding-agent`) is currently
// unconsumable under `nodenext` — its dist .d.ts use extensionless relative
// re-exports (TS2834) and re-export names pi-tui/pi-utils don't declare, voiding
// the whole barrel. So we deep-import from the subpath entrypoints, which resolve
// to the specific .d.ts and typecheck clean. Revert to the root import once the
// upstream type-build fix (can1357/oh-my-pi) is published.
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
  defineTool,
  Type,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import type { Static } from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import { runPeerLoop } from "./loop.js";

/**
 * Read-only / awareness tools. Replies are NOT sent by the model — the run loop delivers
 * the agent's final text on the right delivery mode (see runOmpPeer), so the model can't
 * mis-route or duplicate a reply. These just let it see who is present and report its own
 * status. Mirrors the pi / openai-agents / vercel-ai adapters.
 */
function buildTools(mesh: MeshAgent) {
  const cotal_roster = defineTool({
    name: "cotal_roster",
    label: "Cotal roster",
    description: "List the peers currently present on the Cotal mesh.",
    parameters: Type.Object({}),
    execute: async () => {
      const peers = mesh.roster();
      const text = peers.length
        ? peers
            .map((p) => `${p.card.name}${p.card.role ? `/${p.card.role}` : ""} [${p.status}]`)
            .join("\n")
        : "roster is empty";
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  const statusParams = Type.Object({
    status: Type.Union([Type.Literal("idle"), Type.Literal("waiting"), Type.Literal("working")]),
    activity: Type.Optional(Type.String()),
  });
  const cotal_status = defineTool({
    name: "cotal_status",
    label: "Cotal status",
    description: "Update this peer's presence status on the mesh.",
    parameters: statusParams,
    execute: async (_id: string, params: Static<typeof statusParams>) => {
      await mesh.setStatus(params.status, params.activity);
      return { content: [{ type: "text", text: `status set to ${params.status}` }], details: {} };
    },
  });

  return [cotal_roster, cotal_status];
}

/**
 * Embed an oh-my-pi coding-agent session in-process and drive it from mesh traffic. This is
 * the native-embed pattern (cf. docs/agent-frameworks.md): MeshAgent owns the NATS
 * connection, presence, and a stream-backed inbox; oh-my-pi's loop is driven straight off
 * that inbox via {@link runPeerLoop} — `prompt()` wakes an idle session on the front
 * message, `steer()` interjects into a live one (true mid-turn drive), and presence is read
 * off the session's event stream. The loop owns reply routing, so the model never
 * mis-routes.
 */
export async function runOmpPeer(): Promise<void> {
  const mesh = new MeshAgent(configFromEnv());
  mesh.start();

  // oh-my-pi discovers auth + the model registry from the environment when they
  // aren't supplied (a spawned peer gets provider keys via the connector's
  // buildLaunch env), so we let createAgentSession default them rather than wiring
  // them by hand — matches oh-my-pi's own SDK usage.
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    sessionManager: SessionManager.inMemory(),
    customTools: buildTools(mesh),
  });

  const loop = runPeerLoop({ mesh, session });

  async function shutdown(): Promise<void> {
    try {
      await loop.shutdown();
      await mesh.stop();
    } finally {
      process.exit(0);
    }
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Keep alive.
  await new Promise<void>(() => {});
}
