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
			async execute(_id, _params, _signal, _onUpdate, _ctx: ExtensionContext) {
				return toResult(await spec.run(agent, config, { peek: true }));
			},
		});
		return;
	}

	// The shared spec carries schema members built with connector-core's OWN zod. Under
	// pi-coding-agent 18.x `pi.zod` is a zod-shaped facade over an IR schema engine, so its
	// `z.object()` walks members expecting IR nodes and throws on a foreign ZodType
	// ("undefined is not an object (evaluating 'schema.ir.desc')"). Rebuilding only the
	// container is not enough — each MEMBER must be re-rendered with the host's `z`.
	// `hostMember` reads the spec member's shape by introspection and rebuilds it, which is
	// correct on both the zod-backed (17.x) and IR-backed (18.x) hosts.
	const shape: Record<string, unknown> = {};
	for (const [key, member] of Object.entries(spec.schema ?? {})) {
		shape[key] = hostMember(z, member);
	}
	const parameters = z.object(shape as Parameters<typeof z.object>[0]);
	pi.registerTool<ReturnType<typeof z.object>>({
		name: spec.name,
		label: spec.title,
		description: spec.description,
		parameters,
		async execute(_id, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			return toResult(await spec.run(agent, config, params ?? {}));
		},
	});
}

/** Zod-v4 internals we introspect on a spec member. Only the subset the shared specs use:
 *  `string` (with an optional `max_length` check), `boolean`, `enum`, `array`, each optionally
 *  wrapped in `optional`. Reading `_zod.def` is the documented v4 introspection surface. */
interface ZodDef {
	type?: string;
	innerType?: ZodInternals;
	element?: ZodInternals;
	entries?: Record<string, string>;
	checks?: { _zod?: { def?: { check?: string; maximum?: number } } }[];
}
interface ZodInternals {
	_zod?: { def?: ZodDef };
	description?: string;
}

/** PURE: rebuild one spec schema member with the HOST's zod.
 *
 *  The spec's members come from connector-core's own zod copy. A 17.x host is zod-backed and
 *  tolerates them; an 18.x host is IR-backed and throws. Rebuilding from the member's own
 *  introspected shape is correct on both, because the result is always built by the host.
 *
 *  An unrecognized member degrades to `z.unknown()` rather than throwing: a tool with a loose
 *  param still registers and works, where a throw would take the whole mesh connector down —
 *  which is the exact failure this function exists to prevent. */
function hostMember(z: ExtensionAPI["zod"]["z"], member: unknown): unknown {
	const node = member as ZodInternals;
	const def = node?._zod?.def;
	if (def === undefined) return z.unknown();

	// `.describe()` after `.optional()` lands on the OUTER node; before it, on the inner one.
	const inner = def.type === "optional" ? def.innerType : undefined;
	const core = inner ?? node;
	const coreDef = core._zod?.def;
	const description = node.description ?? core.description;

	let built: { describe(d: string): unknown; optional(): unknown };
	switch (coreDef?.type) {
		case "string": {
			let s = z.string();
			const max = coreDef.checks?.find((c) => c._zod?.def?.check === "max_length")?._zod?.def?.maximum;
			if (max !== undefined) s = s.max(max);
			built = s;
			break;
		}
		case "boolean":
			built = z.boolean();
			break;
		case "enum": {
			const values = Object.values(coreDef.entries ?? {});
			built = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
			break;
		}
		case "array":
			built = z.array(hostMember(z, coreDef.element) as Parameters<typeof z.array>[0]);
			break;
		default:
			return z.unknown();
	}

	if (description !== undefined) built = built.describe(description) as typeof built;
	return inner !== undefined ? built.optional() : built;
}
