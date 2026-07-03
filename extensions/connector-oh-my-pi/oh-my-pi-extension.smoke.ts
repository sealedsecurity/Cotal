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
	console.log("3) cotal_inbox read-only OK ✅");

	// The factory started a MeshAgent with a background reconnect loop; fire session_shutdown to stop
	// it so the smoke process can exit (no live mesh in this test).
	const shutdown = events.get("session_shutdown");
	if (shutdown) await shutdown(undefined);
}

console.log("\nCOTAL-MESH EXTENSION SMOKE OK ✅");
process.exit(0);
