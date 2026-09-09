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
		// One bad spec costs one tool, not all of them. `hostMember` guards the members, but
		// the host's `object()` and `registerTool()` can reject a whole spec — the real 18.x
		// `object()` throws on a member it dislikes, which is this connector's original bug.
		// Unguarded, that removes EVERY cotal_* tool, and the process still exits 0, so the
		// agent boots mesh-deaf and looks healthy.
		try {
			registerSpec(pi, agent, config, spec, z, log);
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			log(`${spec.name}: registration failed (${reason}) — tool not registered`, "warn");
		}
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
	log: MeshLogger,
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
		// A degraded member is a silent contract change: this connector would serve a looser
		// tool than every other one, with no signal. `hostMember` reports the degradation
		// itself rather than the caller re-deriving which kinds it handles — one source of
		// truth, so the switch and the warning cannot drift apart.
		// `hostMember` owns the never-throw contract and reports its own degradations.
		const { schema, degraded } = hostMember(z, member);
		shape[key] = schema;
		if (degraded !== undefined) {
			log(`${spec.name}.${key}: ${degraded}`, "warn");
		}
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
 *  `string` (with optional `min_length` / `max_length` / regex-format checks), `boolean`, `enum`,
 *  `array`, each optionally wrapped in `optional`. `_zod.def` is the v4 introspection surface. */
interface ZodCheckDef {
	check?: string;
	length?: number;
	/** Present on a `string_format` check; dispatch is on `pattern`, since zod precomputes
	 *  one for every format it can express as a regex. */
	pattern?: RegExp;
	maximum?: number;
	minimum?: number;
}
interface ZodDef {
	type?: string;
	/** Set by `z.email()` / `z.url()` / `z.uuid()` etc, which carry the format on the def
	 *  itself rather than in `checks` — most also precompute an equivalent `pattern`. */
	format?: string;
	pattern?: RegExp;
	innerType?: ZodInternals;
	element?: ZodInternals;
	// zod types `entries` as the enum's generic value type, NOT `string` — `z.enum({A:1})`
	// really does yield numbers. Declaring `unknown` keeps the typechecker honest; the
	// enum arm filters to strings rather than casting over the difference.
	entries?: Record<string, unknown>;
	checks?: { _zod?: { def?: ZodCheckDef } }[];
}
/** The two calls `hostMember` makes AFTER the switch, once an arm has built its schema.
 *  Self-referential so `.optional()` keeps its type instead of erasing to `unknown` and
 *  forcing a cast straight back. The arm-local builders (`.regex`/`.min`/`.max`) are typed
 *  by the host `z` parameter, NOT by this interface — and on an 18.x IR host that type is
 *  structurally a lie, so those calls are unchecked at compile time. Hence the caller
 *  treats a translation throw as a degradation. */
interface Chainable {
	describe(d: string): Chainable;
	optional(): Chainable;
}

interface ZodInternals {
	_zod?: { def?: ZodDef };
	description?: string;
}

/** What `hostMember` produced: the host-built schema, plus the kind it could NOT reproduce
 *  when it had to fall back to `z.unknown()`. Reporting the degradation here rather than
 *  letting the caller re-derive it keeps one source of truth for which kinds are handled. */
interface HostMemberResult {
	schema: unknown;
	/** A ready-to-log phrase naming what could not be reproduced, when anything was lost.
	 *  The message is built here because only this function knows WHAT it dropped — a whole
	 *  kind (widened to `unknown`) or a single check on an otherwise-faithful member. */
	degraded?: string;
}

/** PURE: rebuild one spec schema member with the HOST's zod.
 *
 *  The spec's members come from connector-core's own zod copy. A 17.x host is zod-backed and
 *  tolerates them; an 18.x host is IR-backed and throws. Rebuilding from the member's own
 *  introspected shape is correct on both, because the result is always built by the host.
 *
 *  An unrecognized member degrades to `z.unknown()` rather than throwing: a tool with a loose
 *  param still registers and works, where a throw would take the whole mesh connector down —
 *  which is the exact failure this function exists to prevent. An `optional`-wrapped member
 *  stays optional, so that degradation loosens rather than narrows. Other wrappers
 *  (`default`, `nullable`) are NOT preserved — they degrade to a required `unknown`, which
 *  narrows; they are reported via `degraded` rather than silently accepted, and no
 *  current spec uses them. */
export function hostMember(z: ExtensionAPI["zod"]["z"], member: unknown): HostMemberResult {
	const node = member as ZodInternals;
	const def = node?._zod?.def;
	if (def === undefined)
		return { schema: z.unknown(), degraded: "unreadable member — widened to unknown" };

	// `.describe()` after `.optional()` lands on the OUTER node; before it, on the inner one.
	const inner = def.type === "optional" ? def.innerType : undefined;
	const core = inner ?? node;
	const coreDef = core._zod?.def;
	const description = node.description ?? core.description;

	const losses: string[] = [];
	let built: Chainable;
	// The never-throw contract is enforced HERE, where it is documented, so there is exactly
	// one degradation path and it always reaches the `.optional()` re-wrap below. Enforcing
	// it in the caller instead produced a second path that could not reach the re-wrap, so a
	// caught throw returned a BARE `unknown` and flipped optional params to REQUIRED — the
	// narrowing the default arm goes out of its way to avoid. A builder can throw for real:
	// `z` is typed as zod, but an 18.x host merely resembles it, so a missing or stricter
	// method surfaces at runtime and tsc cannot see it.
	try {
	switch (coreDef?.type) {
		case "string": {
			let s = z.string();
			// Patterns are collected and applied LAST, after every length bound. An 18.x host
			// implements `.min()`/`.max()` by wrapping the node in an IR `morph`, and it then
			// REFUSES `.regex()` on a morph — so interleaving them in zod's authoring order
			// (regex → max → regex) throws on the real host. Applying all lengths, then all
			// patterns, is order-independent for the resulting schema and never hits that.
			const patterns: RegExp[] = [];
			// A format built by `z.email()` / `z.url()` / `z.uuid()` is NOT in `checks` — it
			// is a top-level `format` on the def, with a precomputed `pattern` for most.
			// Carry the pattern where there is one, and report the rest: without this the
			// constraint disappears with the loop never seeing it.
			if (coreDef.format !== undefined) {
				if (coreDef.pattern !== undefined) patterns.push(coreDef.pattern);
				else losses.push(`string format "${coreDef.format}" has no pattern — constraint dropped`);
			}
			// Carry every constraint the specs use. A dropped one silently loosens the tool
			// contract the model is shown, which is worse than a load failure: it never
			// surfaces. Anything we cannot carry is named in `degraded` rather than
			// vanishing — the kind still translates, so only the check is lost.
			for (const check of coreDef.checks ?? []) {
				const c = check._zod?.def;
				if (c === undefined) continue;
				if (c.check === "max_length" && c.maximum !== undefined) s = s.max(c.maximum);
				else if (c.check === "min_length" && c.minimum !== undefined) s = s.min(c.minimum);
				else if (c.check === "length_equals" && c.length !== undefined) {
					// `.length(n)` is a single check, not a min/max pair, but it is exactly
					// reproducible as both bounds with builders already in use.
					s = s.min(c.length).max(c.length);
				} else if (c.pattern !== undefined) {
					// zod precomputes a pattern for every format it can express as one
					// (regex, starts_with, ends_with, includes), so one branch carries all.
					patterns.push(c.pattern);
				} else if (c.check !== undefined && c.check !== "overwrite") {
					// `overwrite` (.trim()/.toLowerCase()) has no schema representation at all.
					losses.push(`string check "${c.check}" not reproducible — constraint dropped`);
				}
			}
			for (const pattern of patterns) s = s.regex(pattern);
			built = s;
			break;
		}
		case "boolean":
			built = z.boolean();
			break;
		case "enum": {
			// Keep only string members: a numeric enum fed to the host's `z.enum` yields a
			// schema that matches NOTHING (rejects both 1 and "1"), which is an uncallable
			// param. Widening to `z.string()` is the same loosening as the fallback below.
			const all = Object.values(coreDef.entries ?? {});
			const values = all.filter((v): v is string => typeof v === "string");
			if (values.length === 0) {
				// A host rejects an empty enum outright, so this guard is load-bearing.
				// Report the cause: an all-numeric enum and a genuinely empty one both
				// land here, and only the first is surprising.
				losses.push(
					all.length > 0
						? `enum has no string members (${all.length} numeric) — widened to string`
						: "enum has no members — widened to string",
				);
				built = z.string();
			} else {
				if (values.length !== all.length) {
					losses.push(
						`enum dropped ${all.length - values.length} non-string member(s) — narrowed to its string values`,
					);
				}
				built = z.enum(values as [string, ...string[]]);
			}
			break;
		}
		case "array": {
			const element = hostMember(z, coreDef.element);
			// An untranslatable element degrades the array too — report the inner kind.
			// Prefix so the phrase says WHERE the loss was: the array itself is faithful,
			// only its items widened. Composes on recursion, keeping the depth legible.
			if (element.degraded !== undefined) losses.push(`array element: ${element.degraded}`);
			let a = z.array(element.schema as Parameters<typeof z.array>[0]);
			// Cardinality lives in the array's own checks, same shape as a string's length.
			for (const check of coreDef.checks ?? []) {
				const c = check._zod?.def;
				if (c === undefined) continue;
				if (c.check === "max_length" && c.maximum !== undefined) a = a.max(c.maximum);
				else if (c.check === "min_length" && c.minimum !== undefined) a = a.min(c.minimum);
				else if (c.check === "length_equals" && c.length !== undefined) {
					a = a.min(c.length).max(c.length);
				} else if (c.check !== undefined && c.check !== "overwrite") {
					losses.push(`array check "${c.check}" not reproducible — constraint dropped`);
				}
			}
			built = a;
			break;
		}
		default:
			// Widen to `unknown` and name the kind we could not reproduce. Never return
			// early: a BARE `z.unknown()` is REQUIRED, so skipping the re-wrap below would
			// flip an unhandled optional param to mandatory — a NARROWING, the opposite of
			// the graceful loosening this fallback exists to provide.
			built = z.unknown();
			losses.push(`unhandled schema kind "${coreDef?.type ?? "unreadable"}" — widened to unknown`);
			break;
	}
	} catch (e) {
		built = z.unknown();
		losses.push(`translation threw (${e instanceof Error ? e.message : String(e)}) — widened to unknown`);
	}

	// Order matters, and ONLY on the IR host: `.optional()` there builds a new union node
	// whose description is auto-derived and suppressed by the JSON-schema emitter, so
	// describing FIRST silently drops the text for enum and unknown members. Applying
	// `.optional()` first and describing last matches how the specs are authored and keeps
	// the description on both hosts (on zod the two orders are identical).
	// The wrapper calls can throw on a hostile host too. Losing optionality or a description
	// is a degradation; losing the whole member is not, so each is applied defensively.
	let wrapped: Chainable = built;
	if (inner !== undefined) {
		try {
			wrapped = built.optional();
		} catch (e) {
			losses.push(`optional wrapper threw (${e instanceof Error ? e.message : String(e)}) — param is now required`);
		}
	}
	if (description !== undefined) {
		try {
			wrapped = wrapped.describe(description);
		} catch (e) {
			losses.push(`describe threw (${e instanceof Error ? e.message : String(e)}) — description dropped`);
		}
	}
	return { schema: wrapped, degraded: losses.length > 0 ? losses.join("; ") : undefined };
}
