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
// TUI Component TYPE only (erased at build; no runtime import, so it never drags pi-tui's
// Bun-coupled transitive graph — @oh-my-pi/pi-utils' barrel pulls `bun`, which the Node/tsx smoke
// can't load). A `renderCall` returning a Component takes OMP's custom-renderer branch instead of
// the generic animated-spinner fallback (the glyph artifact on cotal_* cards); we return a minimal
// hand-rolled Component (just the required `render(width)`) rather than pi-tui's `Text`. See the
// renderer helpers below.
import type { Component } from "@oh-my-pi/pi-tui";
import {
	configFromEnv,
	hasIdentity,
	MeshAgent,
	cotalToolSpecs,
	type CotalToolSpec,
	type ToolResult,
	type MeshLogger,
} from "@cotal-ai/connector-core";
import { isConcreteChannel, type PresenceStatus } from "@cotal-ai/core";
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
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (started) return;
		started = true;
		if (!ctx.hasUI) {
			log("non-interactive session (subagent/print/RPC) — staying off the mesh");
			return;
		}
		// Start the mesh join FIRST — it's a non-blocking background connect with retry. The session
		// naming below is cosmetic and must never gate the join: a `getSessionName()` throw (session
		// manager not ready) or a `setSessionName()` promise that stalls instead of rejecting would
		// otherwise leave the pane off the mesh. So connect, then name in fire-and-forget.
		agent.start(); // background connect with retry — never blocks
		// Name the session after the mesh identity so the terminal/pane title reflects WHO this agent
		// is (COTAL_NAME) instead of a generic auto-title — the launcher forwards the name but OMP has
		// no other agent-reachable way to set it (`/rename` isn't agent-invokable, the auto-title never
		// fired). Connector-side, not an OMP→Cotal dependency. Guarded on an unset name so a resumed
		// session or a manual `/rename` (both source:"user") is never clobbered; best-effort — a title
		// failure (reject OR a getSessionName throw) must never break the join, so the whole path is
		// detached and fully guarded.
		void (async () => {
			try {
				if (!ctx.sessionManager.getSessionName()) await pi.setSessionName(config.name);
			} catch (e) {
				log(`could not set session name to "${config.name}": ${e instanceof Error ? e.message : String(e)}`, "warn");
			}
		})();
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

/** Truncate to `max` display columns with a trailing ellipsis, collapsing internal whitespace to
 *  single spaces first. Shared by the call summary and the render clamp so both handle the narrow
 *  and zero/negative-width edges identically: `max <= 0` → empty, `max === 1` → just the ellipsis. */
function truncate(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ");
	if (max <= 0) return "";
	if (flat.length <= max) return flat;
	return max === 1 ? "…" : `${flat.slice(0, max - 1)}…`;
}

/** One-line, human-readable summary of a cotal_* tool call, keyed by tool name and drawn from the
 *  shared spec's args. Display-only (feeds `renderCall`); pure + exported for the smoke. Unknown
 *  tools and absent args degrade to an empty summary (the label alone still leaves the spinner
 *  fallback). Args are `unknown` because each tool's shape differs; we read defensively.
 *  `defaultChannel` is the destination `cotal_send` resolves an omitted `channel` to — the caller
 *  passes the SAME value the endpoint uses (`config.subscribe.find(isConcreteChannel) ?? "general"`,
 *  mirrored from CotalEndpoint.multicast), so the card names the real target instead of a guess. */
export function cotalCallSummary(name: string, args: unknown, defaultChannel: string): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	const preview = (v: unknown, max = 60): string => truncate(str(v), max);
	switch (name) {
		case "cotal_send": {
			const ch = str(a.channel) || defaultChannel;
			const ment = Array.isArray(a.mentions) && a.mentions.length ? ` @${a.mentions.map(str).filter(Boolean).join(" @")}` : "";
			const body = preview(a.text);
			return `#${ch}${ment}${body ? ` — ${body}` : ""}`;
		}
		case "cotal_dm": {
			const to = str(a.to) || "?";
			const body = preview(a.text);
			return `${to}${body ? ` — ${body}` : ""}`;
		}
		case "cotal_anycast": {
			const role = str(a.role) || "?";
			const body = preview(a.text);
			return `@${role}${body ? ` — ${body}` : ""}`;
		}
		case "cotal_status": {
			const parts = [str(a.status), str(a.attention)].filter(Boolean);
			const act = preview(a.activity, 40);
			return `${parts.join(" · ")}${act ? `${parts.length ? " · " : ""}${act}` : ""}`;
		}
		default:
			return "";
	}
}

/** Build the display-only Component for a cotal_* tool call: a titled single line (label + summary).
 *  Returning a Component from `renderCall` is what takes OMP's custom-renderer branch instead of the
 *  generic animated-spinner fallback — the whole point of wiring these hooks. Minimal by design: a
 *  one-line renderer truncated to the render width. We hand-roll the Component (only `render(width)`
 *  is required by the interface) instead of using pi-tui's `Text`, so no runtime pi-tui import is
 *  pulled — that would drag @oh-my-pi/pi-utils' Bun-coupled barrel and break the Node/tsx smoke.
 *  A zero/negative or non-finite width yields a single empty line: OMP can hand a Component a
 *  zero-width slot, and the width-bounded render contract must never return an over-wide line. */
function renderCotalCall(label: string, summary: string): Component {
	const line = summary ? `${label} — ${summary}` : label;
	return {
		render(width: number): readonly string[] {
			if (!Number.isFinite(width) || width <= 0) return [""];
			const w = Math.floor(width);
			return [line.length > w ? truncate(line, w) : line];
		},
	};
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

	// The channel `cotal_send` resolves an omitted `channel` to — the same expression the endpoint
	// uses (CotalEndpoint.multicast), so the tool card names the real destination, not a guess.
	const defaultChannel = config.subscribe.find(isConcreteChannel) ?? "general";

	if (spec.name === "cotal_inbox") {
		// Empty params (this tool takes none). The explicit `registerTool<…>` generic below pins
		// `TParams` so the tool registry doesn't infer it from the literal and recurse into
		// `Static<TParams>` (TS2589, excessively deep) under pi-coding-agent ≥16.3.7.
		const parameters = z.object({});
		pi.registerTool<ReturnType<typeof z.object>>({
			name: spec.name,
			label: spec.title,
			description:
				"Show the peer messages currently waiting for you (incl. focus-mode recall). You don't normally need this — the extension delivers peer messages into your turns automatically; use it to re-check what's pending mid-task. Read-only: it never consumes them.",
			parameters,
			approval: "read",
			renderCall: () => renderCotalCall(spec.title, "peek inbox"),
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
	pi.registerTool<ReturnType<typeof z.object>>({
		name: spec.name,
		label: spec.title,
		description: spec.description,
		parameters,
		renderCall: (args) => renderCotalCall(spec.title, cotalCallSummary(spec.name, args, defaultChannel)),
		async execute(_id, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			return toResult(await spec.run(agent, config, params ?? {}));
		},
	});
}
