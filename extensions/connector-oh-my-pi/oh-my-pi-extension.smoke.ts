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
}

/** A fake ExtensionAPI that records everything the factory does. */
function fakePi() {
	const tools = new Map<string, RegisteredTool>();
	const events = new Map<string, (e: unknown) => unknown>();
	const sent: { message: Record<string, unknown>; options: Record<string, unknown> }[] = [];
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
	};
	return { pi, tools, events, sent, z };
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
	const origStart = MeshAgent.prototype.start;
	let startCalls = 0;
	MeshAgent.prototype.start = function () {
		startCalls++;
	};
	try {
		// (a) non-interactive session (subagent/print/RPC): hasUI:false → stays off the mesh.
		{
			const { pi, events } = fakePi();
			cotalMesh(pi as never);
			const sessionStart = events.get("session_start") as
				| ((event: unknown, ctx: { hasUI: boolean }) => unknown)
				| undefined;
			assert(sessionStart, "identity → subscribes to session_start");
			startCalls = 0;
			await sessionStart(undefined, { hasUI: false });
			assert(startCalls === 0, "hasUI:false → agent.start NOT invoked (subagent stays off mesh)");
		}
		// (b) interactive top-level session: hasUI:true → joins the mesh.
		{
			const { pi, events } = fakePi();
			cotalMesh(pi as never);
			const sessionStart = events.get("session_start") as (event: unknown, ctx: { hasUI: boolean }) => unknown;
			startCalls = 0;
			await sessionStart(undefined, { hasUI: true });
			assert(startCalls === 1, "hasUI:true → agent.start invoked (interactive session joins)");
		}
	} finally {
		MeshAgent.prototype.start = origStart;
	}
	console.log("4) session_start + hasUI gates mesh-join OK ✅");
}

// ---- 5. schema members are rebuilt with the HOST's zod -------------------------
// Regression for the pi-coding-agent 18.x break: `pi.zod` there is a zod-shaped facade
// over an IR schema engine, and its `z.object()` rejects members built by another zod
// copy ("undefined is not an object (evaluating 'schema.ir.desc')"). Tests 1-4 inject
// the SAME zod the specs use, so a foreign member never occurs and the bug is invisible
// to them. This host records what it is handed and refuses anything it did not build —
// the property the real 18.x host enforces.
{
	process.env.COTAL_NAME = "smoke-peer";
	const BUILT = Symbol("host-built");
	const built = <T extends object>(o: T): T => Object.assign(o, { [BUILT]: true });
	const leaf = () => built({
		max: () => leaf(),
		optional: () => leaf(),
		describe: () => leaf(),
	});
	// A host whose `object()` throws on any member it did not build itself.
	const hostZ = {
		string: () => leaf(),
		boolean: () => leaf(),
		enum: () => leaf(),
		array: () => leaf(),
		unknown: () => leaf(),
		object: (shape: Record<string, unknown>) => {
			for (const [key, member] of Object.entries(shape ?? {})) {
				if ((member as Record<symbol, unknown>)?.[BUILT] !== true) {
					throw new Error(`foreign schema member '${key}' — host did not build it`);
				}
			}
			return built({ shape });
		},
	};
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		zod: { z: hostZ },
		logger: console,
		registerTool: (t: RegisteredTool) => tools.set(t.name, t),
		on: () => {},
		sendMessage: () => {},
		registerCommand: () => {},
		setLabel: () => {},
	};
	// Before the fix this threw while registering the first spec with params.
	cotalMesh(pi as never);
	assert(tools.size > 0, "IR-style host: specs still register");
	assert(tools.has("cotal_send"), "IR-style host: a spec with params registered");
	assert(tools.has("cotal_feedback"), "IR-style host: a spec with enum + max params registered");
	console.log(`5) schema members rebuilt with host zod OK ✅ (${tools.size} tools)`);
}

console.log("\nCOTAL-MESH EXTENSION SMOKE OK ✅");
process.exit(0);
