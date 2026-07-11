/**
 * Smoke test for the cotal-mesh OMP extension. Repo style: plain assert + console.log, run via
 * `bun cotal-mesh.smoke.ts`, non-zero exit on failure. No test framework.
 *
 * Drives the extension factory with a FAKE ExtensionAPI (records tool registrations, event
 * handlers, and sendMessage calls) so the whole load path is exercised with no NATS connection.
 * Asserts: inert without identity; with identity it registers the cotal_* tool surface, subscribes
 * to the lifecycle events, and cotal_inbox is read-only.
 */
import cotalMesh from "./src/extension.ts";
import * as zodV4 from "zod/v4";
import { MeshAgent } from "@cotal-ai/connector-core";
import { setImmediate as settle } from "node:timers/promises";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
}

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	approval?: string;
	execute: (...a: unknown[]) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
	renderCall?: (args: unknown, options?: unknown, theme?: unknown) => { render: (width: number) => readonly string[] };
}

/** A fake ExtensionAPI that records everything the factory does. */
function fakePi(opts?: { rejectSessionName?: boolean }) {
	const tools = new Map<string, RegisteredTool>();
	const events = new Map<string, (e: unknown) => unknown>();
	const sent: { message: Record<string, unknown>; options: Record<string, unknown> }[] = [];
	const sessionNameSets: string[] = [];
	const z = zodV4.z;
	const pi = {
		zod: zodV4,
		logger: console,
		registerTool: (t: RegisteredTool) => tools.set(t.name, t),
		on: (event: string, handler: (e: unknown) => unknown) => events.set(event, handler),
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) =>
			sent.push({ message, options }),
		registerCommand: () => {},
		setLabel: () => {},
		// The title fix calls `await pi.setSessionName(config.name)`. Record every name it sets so we
		// can assert on WHAT was set (and how many times); `rejectSessionName` models a host that
		// refuses the rename, exercising the best-effort catch in session_start.
		setSessionName: (name: string) => {
			sessionNameSets.push(name);
			return opts?.rejectSessionName
				? Promise.reject(new Error("smoke: setSessionName rejected"))
				: Promise.resolve();
		},
	};
	return { pi, tools, events, sent, sessionNameSets, z };
}

// ---- 1. inert without identity ------------------------------------------------
delete process.env.COTAL_NAME;
delete process.env.COTAL_LINK;
delete process.env.COTAL_AGENT_FILE;
{
	const { pi, tools, events } = fakePi();
	cotalMesh(pi as never);
	assert(tools.size === 0, "no identity → registers no tools");
	assert(events.size === 0, "no identity → subscribes to no events");
	console.log("1) inert without identity OK ✅");
}

// ---- 2. with identity: tools + events registered ------------------------------
process.env.COTAL_NAME = "smoke-peer";
process.env.COTAL_SERVERS = "nats://127.0.0.1:4222"; // never actually connected in this smoke
{
	const { pi, tools, events } = fakePi();
	cotalMesh(pi as never);

	// The shared cotal_* surface is registered.
	for (const name of ["cotal_orientation", "cotal_roster", "cotal_inbox", "cotal_send", "cotal_dm", "cotal_status"]) {
		assert(tools.has(name), `registers ${name}`);
	}
	console.log(`   registered ${tools.size} cotal_* tools`);

	// Lifecycle events are subscribed for presence + turn tracking.
	for (const ev of ["agent_start", "agent_end", "tool_execution_start", "session_shutdown"]) {
		assert(events.has(ev), `subscribes to ${ev}`);
	}
	console.log("2) identity → tools + events registered OK ✅");

	// ---- 3. cotal_inbox is read-only (peek) -----------------------------------
	const inbox = tools.get("cotal_inbox")!;
	assert(inbox.approval === "read", "cotal_inbox is approval:read");
	// Its schema takes no args (peek is forced), so execute must run without throwing on {}.
	const inboxResult = await inbox.execute("", {}, undefined, undefined, undefined);
	assert(inboxResult.content.length === 1, "cotal_inbox execute returns one content part");
	assert(!inboxResult.content[0].text.startsWith("⚠"), "cotal_inbox execute does not error on empty inbox");
	console.log("3) cotal_inbox read-only OK ✅");

	// ---- 3b. every cotal_* tool carries a renderCall (spinner-fallback fix) ----
	// A tool with no renderCall falls back to OMP's generic animated-spinner glyph. Asserting a
	// renderCall on every registered tool is the regression guard for that artifact. Each must
	// return a Component (a `render(width)` producing lines), not throw, for real and empty args.
	for (const [name, tool] of tools) {
		assert(typeof tool.renderCall === "function", `${name} carries a renderCall (no spinner fallback)`);
		const comp = tool.renderCall!({}, {}, {});
		assert(comp && typeof comp.render === "function", `${name} renderCall returns a Component`);
		const lines = comp.render(80);
		assert(Array.isArray(lines) && lines.some((l) => l.length > 0), `${name} renderCall renders a non-empty line`);
	}
	console.log(`   all ${tools.size} tools carry a renderCall`);

	// The renderCall enriches the title with a per-surface summary drawn from args (not just the
	// bare label): a cotal_dm to a peer shows the recipient; cotal_send shows the channel.
	const dmLine = tools.get("cotal_dm")!.renderCall!({ to: "mercator", text: "ping" }, {}, {}).render(200).join(" ");
	assert(dmLine.includes("mercator"), "cotal_dm renderCall shows the recipient");
	const sendLine = tools.get("cotal_send")!.renderCall!({ channel: "svc.cotal", text: "hi" }, {}, {}).render(200).join(" ");
	assert(sendLine.includes("svc.cotal"), "cotal_send renderCall shows the channel");
	console.log("3b) tool renderCall present + enriched OK ✅");

	// The factory started a MeshAgent with a background reconnect loop; fire session_shutdown to stop
	// it so the smoke process can exit (no live mesh in this test).
	const shutdown = events.get("session_shutdown");
	if (shutdown) await shutdown(undefined);
}

// ---- 4. session_start gates the mesh-join on ctx.hasUI ------------------------
// A task/print/RPC subagent inherits the parent's COTAL_* env, so hasIdentity() alone would make
// every subagent a stray same-named peer. The extension defers the mesh-join to session_start and
// only calls agent.start() when ctx.hasUI is true (interactive/top-level). Observe agent.start via a
// spy on MeshAgent.prototype.start — no-op'd so no real NATS reconnect loop spins — then restore it.
// Each branch loads a fresh factory: the `started` guard is per-instance, so one instance can't be
// re-driven. Env from block 2 (COTAL_NAME/COTAL_SERVERS) is still set → identity is present.
{
	// The title fix makes session_start `async` and, on an interactive session, name the session
	// after the mesh identity via `ctx.sessionManager.getSessionName()` / `pi.setSessionName()`, so
	// the ctx now carries a sessionManager. One shape for every sub-case below.
	type SessionStart = (
		event: unknown,
		ctx: { hasUI: boolean; sessionManager: { getSessionName: () => string | undefined } },
	) => unknown | Promise<unknown>;
	const origStart = MeshAgent.prototype.start;
	let startCalls = 0;
	MeshAgent.prototype.start = function () {
		startCalls++;
	};
	try {
		// (a) non-interactive session (subagent/print/RPC): hasUI:false → stays off the mesh AND does
		//     no title work (behavior #3: a subagent must never rename the parent's session).
		{
			const { pi, events, sessionNameSets } = fakePi();
			cotalMesh(pi as never);
			const sessionStart = events.get("session_start") as SessionStart | undefined;
			assert(sessionStart, "identity → subscribes to session_start");
			startCalls = 0;
			await sessionStart(undefined, { hasUI: false, sessionManager: { getSessionName: () => undefined } });
			assert(startCalls === 0, "hasUI:false → agent.start NOT invoked (subagent stays off mesh)");
			assert(sessionNameSets.length === 0, "hasUI:false → setSessionName NOT called (no title work off the mesh)");
		}
		// (b) interactive top-level session, unnamed: hasUI:true + getSessionName() undefined → joins
		//     the mesh AND names the session after the mesh identity (behavior #1: title IS set when
		//     unset; the arg must be config.name == COTAL_NAME == "smoke-peer" from block 2's env).
		{
			const { pi, events, sessionNameSets } = fakePi();
			cotalMesh(pi as never);
			const sessionStart = events.get("session_start") as SessionStart;
			startCalls = 0;
			await sessionStart(undefined, { hasUI: true, sessionManager: { getSessionName: () => undefined } });
			await settle(); // the title work is now a detached fire-and-forget IIFE — let it settle before asserting sessionNameSets
			assert(startCalls === 1, "hasUI:true → agent.start invoked (interactive session joins)");
			assert(
				sessionNameSets.length === 1 && sessionNameSets[0] === "smoke-peer",
				`hasUI:true + unnamed → setSessionName called once with "smoke-peer" (got ${JSON.stringify(sessionNameSets)})`,
			);
		}
		// (c) interactive session already named (resumed / manual `/rename`, source:"user"): hasUI:true
		//     + getSessionName() returns a non-empty name → the guard suppresses the rename (behavior
		//     #2: an existing title is NEVER clobbered), yet the mesh-join still proceeds.
		{
			const { pi, events, sessionNameSets } = fakePi();
			cotalMesh(pi as never);
			const sessionStart = events.get("session_start") as SessionStart;
			startCalls = 0;
			await sessionStart(undefined, { hasUI: true, sessionManager: { getSessionName: () => "user-renamed" } });
			await settle(); // detached title IIFE: flush the microtask queue before asserting the (suppressed) rename
			assert(sessionNameSets.length === 0, "hasUI:true + already named → setSessionName NEVER called (guard protects /rename + resume)");
			assert(startCalls === 1, "hasUI:true + already named → agent.start still invoked (join unaffected by the guard)");
		}
		// (d) best-effort: setSessionName rejects (host refuses the rename). session_start must still
		//     resolve and agent.start must still fire (behavior #4: a title failure must never break
		//     the mesh-join). The rename is attempted exactly once before the failure is swallowed.
		{
			const { pi, events, sessionNameSets } = fakePi({ rejectSessionName: true });
			cotalMesh(pi as never);
			const sessionStart = events.get("session_start") as SessionStart;
			startCalls = 0;
			await sessionStart(undefined, { hasUI: true, sessionManager: { getSessionName: () => undefined } });
			await settle(); // detached title IIFE: flush before asserting the attempted-then-swallowed rename
			assert(sessionNameSets.length === 1 && sessionNameSets[0] === "smoke-peer", "setSessionName rejects → rename attempted exactly once");
			assert(startCalls === 1, "setSessionName rejects → agent.start still invoked (best-effort: title failure never breaks the join)");
		}
		// (e) P1 regression: getSessionName() THROWS (session manager not ready). The cosmetic rename
		//     must NEVER gate the mesh-join. With the fix, agent.start() fires FIRST and the guard read
		//     lives INSIDE the detached IIFE's try, so the throw is swallowed there and can't reach the
		//     handler — the join proceeds regardless (this is the exact both-bots P1: a not-ready
		//     session manager once left the pane off the mesh).
		{
			const { pi, events, sessionNameSets } = fakePi();
			cotalMesh(pi as never);
			const sessionStart = events.get("session_start") as SessionStart;
			startCalls = 0;
			let handlerThrew = false;
			try {
				await sessionStart(undefined, {
					hasUI: true,
					sessionManager: {
						getSessionName: () => {
							throw new Error("session manager not ready");
						},
					},
				});
			} catch {
				handlerThrew = true;
			}
			await settle(); // let the detached IIFE run (its try/catch swallows the getSessionName throw)
			assert(!handlerThrew, "getSessionName throws → session_start still resolves (throw confined to the detached IIFE)");
			assert(startCalls === 1, "getSessionName throws → agent.start STILL invoked (the crux: a not-ready session manager never gates the join)");
			assert(sessionNameSets.length === 0, "getSessionName throws → setSessionName NEVER called (the guard read threw before any rename)");
		}
	} finally {
		MeshAgent.prototype.start = origStart;
	}
	console.log("4) session_start + hasUI gates mesh-join OK ✅");
}

console.log("\nCOTAL-MESH EXTENSION SMOKE OK ✅");
process.exit(0);
