/**
 * Cotal mesh extension for the oh-my-pi coding agent.
 *
 * Loaded via `pi --extension` or from `~/.omp/agent/extensions/`, this turns an interactive
 * OMP session into a first-class Cotal mesh peer — at parity with the Claude Code (MCP) and
 * OpenCode (plugin) connectors, and rendered from the SAME shared source of truth
 * (`cotalToolSpecs` in `@cotal-ai/connector-core`), so the cotal_* surface can't drift.
 *
 *  • holds the MeshAgent (NATS endpoint, inbox, presence) for the session's lifetime;
 *  • registers the cotal_* tools natively via `pi.registerTool` (roster, inbox, send, dm,
 *    anycast, status, channels, …), rendered from the shared specs;
 *  • maps the agent's own event stream to presence (working | waiting | idle | offline);
 *  • DELIVERS inbound mesh traffic into the session via `pi.sendMessage(..., {deliverAs})`:
 *    an idle session is woken (triggerTurn), a live one is steered — never interrupting a
 *    running turn, matching the other connectors. It acks on turn completion, so a crash or
 *    error redelivers.
 *
 * Identity comes from COTAL_* env (the extension runs in the omp process and inherits it).
 * No identity → inert, so a plain `omp` never joins as a stray peer. Set COTAL_NAME (and
 * optionally COTAL_LINK / COTAL_AGENT_FILE) before launch to join; `cotal up --open` gives a
 * loopback mesh that needs only COTAL_NAME.
 */
// oh-my-pi's published root barrel (`@oh-my-pi/pi-coding-agent`) is currently unconsumable under
// `nodenext` — its dist .d.ts use extensionless relative re-exports and re-export names pi-tui /
// pi-utils don't declare, voiding the whole barrel. Deep-import from the subpath entrypoint, which
// resolves to the specific .d.ts and typechecks clean. Revert to the root import once the upstream
// type-build fix is published (see the header comment in src/peer.ts).
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	configFromEnv,
	hasIdentity,
	MeshAgent,
	cotalToolSpecs,
	type CotalToolSpec,
	type ToolResult,
	type MeshLogger,
} from "@cotal-ai/connector-core";
import type { PresenceStatus } from "@cotal-ai/core";
import { runPeerLoop } from "./interactive-loop.js";

export default function cotalMesh(pi: ExtensionAPI): void {
	// Route every connector diagnostic through OMP's FILE logger, never the shared terminal:
	// a raw stderr write corrupts the live TUI, and mesh reconnect churn would otherwise flood it.
	const log: MeshLogger = (msg, level = "info") => {
		const line = `[cotal-mesh] ${msg}`;
		if (level === "error") pi.logger.error(line);
		else if (level === "warn") pi.logger.warn(line);
		else pi.logger.info(line);
	};

	// No identity → a plain `omp`, not a launcher-joined session. Stay off the mesh.
	if (!hasIdentity()) {
		log("no COTAL_NAME / COTAL_LINK / COTAL_AGENT_FILE — staying off the mesh");
		return;
	}

	const config = configFromEnv();
	config.connector = "oh-my-pi"; // advertise the host harness on our AgentCard (meta.connector)
	const agent = new MeshAgent(config, log);

	// Join the mesh only from a real interactive (top-level) session. A `task`/print/RPC subagent
	// inherits the parent's COTAL_* env, so hasIdentity() alone would make every subagent a stray
	// same-named peer (polluting the roster + making DMs to that name ambiguous, and worse, a
	// subagent could receive mesh traffic meant for the main session). `ctx.hasUI` is false in
	// print/RPC/subagent mode and true for the interactive session — the available signal that
	// distinguishes them (OMP's internal agentKind "main"|"sub" isn't exposed to extensions).
	// Deferred to session_start because hasUI is only on the handler ctx, not the factory arg.
	// NOTE: a future headless launcher (e.g. Compass spawning a real worker) is also hasUI:false and
	// WOULD need to join — revisit with an explicit signal (agentKind/env opt-in) when that lands.
	let started = false;
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (started) return;
		started = true;
		if (!ctx.hasUI) {
			log("non-interactive session (subagent/print/RPC) — staying off the mesh");
			return;
		}
		agent.start(); // background connect with retry — never blocks
	});

	const loop = runPeerLoop({ mesh: agent, host: pi });

	const safeStatus = async (status: PresenceStatus, activity?: string): Promise<void> => {
		try {
			if (agent.connected) await agent.setStatus(status, activity);
		} catch {
			/* presence is best-effort — never throw into the agent loop */
		}
	};

	// ---- session event stream → presence + turn lifecycle -------------------
	pi.on("agent_start", async () => {
		loop.onAgentStart();
		await safeStatus("working");
	});
	pi.on("tool_execution_start", async (event) => {
		await safeStatus("working", event.toolName);
	});
	pi.on("agent_end", async () => {
		// agent_end is the turn-end signal (single-session process, notification-only): ack + flush.
		await safeStatus("idle");
		loop.onAgentEnd();
	});
	pi.on("session_shutdown", async () => {
		await safeStatus("offline");
		await loop.shutdown();
	});

	// ---- cotal_* tools, rendered from the shared specs ----------------------
	const { z } = pi.zod;
	for (const spec of cotalToolSpecs(config, "oh-my-pi")) {
		registerSpec(pi, agent, config, spec, z);
	}

	log(
		`loaded — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""} (${config.servers}); joins the mesh on session_start if interactive`,
	);
}

/** Render one shared CotalToolSpec onto `pi.registerTool`. `cotal_inbox` is forced read-only
 *  (peek): this extension delivers + acks each turn, so the agent's inbox tool must never drain,
 *  or it would race the ack. All others pass their args straight through to the spec's `run`. */
function registerSpec(
	pi: ExtensionAPI,
	agent: MeshAgent,
	config: ReturnType<typeof configFromEnv>,
	spec: CotalToolSpec,
	z: ExtensionAPI["zod"]["z"],
): void {
	const toResult = (r: ToolResult) => ({
		content: [{ type: "text" as const, text: r.isError ? `⚠ ${r.text}` : r.text }],
		details: {},
	});

	if (spec.name === "cotal_inbox") {
		pi.registerTool({
			name: spec.name,
			label: spec.title,
			description:
				"Show the peer messages currently waiting for you (incl. focus-mode recall). You don't normally need this — the extension delivers peer messages into your turns automatically; use it to re-check what's pending mid-task. Read-only: it never consumes them.",
			parameters: z.object({}),
			approval: "read",
			async execute(_id, _params, _signal, _onUpdate, _ctx: ExtensionContext) {
				return toResult(await spec.run(agent, config, { peek: true }));
			},
		});
		return;
	}

	// The shared spec carries a Zod raw shape from connector-core's own zod copy; rebuild it with the
	// host's injected zod (pi.zod) so the schema type matches OMP's tool registry. The cast bridges the
	// two structurally-identical zod copies at this single boundary (raw shapes are plain objects).
	const parameters = z.object((spec.schema ?? {}) as Parameters<typeof z.object>[0]);
	pi.registerTool({
		name: spec.name,
		label: spec.title,
		description: spec.description,
		parameters,
		async execute(_id, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			return toResult(await spec.run(agent, config, params ?? {}));
		},
	});
}
