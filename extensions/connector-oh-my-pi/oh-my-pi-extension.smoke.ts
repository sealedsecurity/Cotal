/**
 * Smoke test for the cotal-mesh OMP extension. Repo style: plain assert + console.log, run via
 * `bun cotal-mesh.smoke.ts`, non-zero exit on failure. No test framework.
 *
 * Drives the extension factory with a FAKE ExtensionAPI (records tool registrations, event
 * handlers, and sendMessage calls) so the whole load path is exercised with no NATS connection.
 * Asserts: inert without identity; with identity it registers the cotal_* tool surface, subscribes
 * to the lifecycle events, and cotal_inbox is read-only.
 */
import cotalMesh, { hostMember } from "./src/extension.ts";
import * as zodV4 from "zod/v4";
import { MeshAgent, cotalToolSpecs, configFromEnv } from "@cotal-ai/connector-core";

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
// COTAL_CREDS is a PATH to configFromEnv, so an inherited value either crashes the suite
// outright (ENOENT, at case 2, before any per-case save/restore runs) or silently changes
// the capability surface and thus which tools exist. Pin it once here so every case runs
// against a known surface wherever the suite is invoked — including on a live agent.
delete process.env.COTAL_CREDS;
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
	// Pin the capability surface instead of inheriting the ambient one: with COTAL_CREDS
	// set, cotal_persona is filtered out and the regex path is never exercised, so this
	// case would pass locally and fail in a clean CI env.
	const prevCreds = process.env.COTAL_CREDS;
	const prevCaps5 = process.env.COTAL_CAPABILITIES;
	delete process.env.COTAL_CREDS;
	process.env.COTAL_CAPABILITIES = "spawn";
	const BUILT = Symbol("host-built");
	const built = <T extends object>(o: T): T => Object.assign(o, { [BUILT]: true });
	// Every builder hostMember can call must exist here, or the stub throws for a reason
	// that has nothing to do with what the case is testing. This bit once: `.regex`/`.min`
	// were missing, and the case only passed because ambient COTAL_CREDS hid the one
	// spec member that uses a regex.
	const leaf = () => built({
		max: () => leaf(),
		min: () => leaf(),
		regex: () => leaf(),
		optional: () => leaf(),
		describe: () => leaf(),
	});
	// A host whose `object()` throws on any member it did not build itself.
	const hostZ = {
		string: () => leaf(),
		boolean: () => leaf(),
		enum: () => leaf(),
		// Check what we are HANDED, not just that we were called: an unrecursed element is
		// exactly the foreign member this case exists to catch, and the real 18.x host does
		// reject it (`undefined is not an object (evaluating 'ir.k')` — this PR's bug).
		array: (el: unknown) => {
			if ((el as Record<symbol, unknown>)?.[BUILT] !== true) {
				throw new Error("foreign array element — host did not build it");
			}
			return leaf();
		},
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
	// Restore BEFORE asserting: `assert` exits the process, so a restore placed after a
	// failing assert never runs. Nothing below reads the env.
	if (prevCreds === undefined) delete process.env.COTAL_CREDS;
	else process.env.COTAL_CREDS = prevCreds;
	if (prevCaps5 === undefined) delete process.env.COTAL_CAPABILITIES;
	else process.env.COTAL_CAPABILITIES = prevCaps5;
	assert(tools.size > 0, "IR-style host: specs still register");
	assert(tools.has("cotal_send"), "IR-style host: a spec with params registered");
	assert(tools.has("cotal_feedback"), "IR-style host: a spec with enum + max params registered");
	assert(tools.has("cotal_persona"), "IR-style host: the regex-bearing spec was in scope");
	console.log(`5) schema members rebuilt with host zod OK ✅ (${tools.size} tools)`);
}

// ---- 6. translation preserves every constraint ---------------------------------
// Case 5 only proves registration does not THROW. It cannot see a constraint that was
// silently dropped, because its fake host returns chainable stubs — and a dropped
// constraint is worse than a load failure: it loosens the tool contract the model is
// shown and never surfaces. This drives the real zod as the "host" and compares the
// JSON Schema of every spec member before and after translation.
//
// This case exists because `pattern` on cotal_persona.name WAS being dropped: the string
// branch only carried `max_length`.
{
	process.env.COTAL_NAME = "smoke-peer";
	// The manager-op tools (cotal_spawn / cotal_persona) only exist with the `spawn`
	// capability, and cotal_persona.name is the member that carried the dropped regex —
	// so a run without it checks 29 members and misses the exact one that broke.
	const prevCaps = process.env.COTAL_CAPABILITIES;
	process.env.COTAL_CAPABILITIES = "spawn";
	const specs = cotalToolSpecs(configFromEnv(), "oh-my-pi");
	if (prevCaps === undefined) delete process.env.COTAL_CAPABILITIES;
	else process.env.COTAL_CAPABILITIES = prevCaps;
	assert(
		specs.some((s) => s.name === "cotal_persona"),
		"constraint fidelity: capability-gated specs are in scope",
	);
	// The 38 real members only cover the kinds the CURRENT specs happen to use: no array
	// cardinality, no string .min(), no top-level format, no non-string enum. So the
	// branches handling those are unobservable here — each could be deleted outright with
	// this sweep still green. These synthetic members make them observable, and every one
	// is a shape ordinary spec authoring would produce.
	const synthetic: Record<string, unknown> = {
		arrayMinMax: zodV4.z.array(zodV4.z.string()).min(1).max(5),
		arrayNested: zodV4.z.array(zodV4.z.string().max(3)).min(1),
		arrayLength: zodV4.z.array(zodV4.z.string()).length(2),
		stringMinMax: zodV4.z.string().min(2).max(9),
		stringLength: zodV4.z.string().length(8),
		// The interleaving that throws on a real 18.x host if patterns are not deferred.
		stringRegexLen: zodV4.z.string().regex(/^a/).max(10).regex(/b$/),
		email: zodV4.z.email(),
		uuid: zodV4.z.uuid(),
		optionalDescribed: zodV4.z.string().max(4).optional().describe("D"),
	};
	const allSpecs: { name: string; schema: Record<string, unknown> }[] = [
		...specs.map((sp) => ({ name: sp.name, schema: (sp.schema ?? {}) as Record<string, unknown> })),
		{ name: "__synthetic__", schema: synthetic },
	];
	let checked = 0;
	const lost: string[] = [];
	for (const spec of allSpecs) {
		for (const [key, member] of Object.entries(spec.schema ?? {})) {
			checked++;
			// zodV4 IS the host here, so a faithful translation must round-trip identically.
			const before = zodV4.z.toJSONSchema(zodV4.z.object({ [key]: member })) as {
				properties: Record<string, Record<string, unknown>>;
				required?: string[];
			};
			const after = zodV4.z.toJSONSchema(
				zodV4.z.object({ [key]: hostMember(zodV4.z, member).schema as never }),
			) as { properties: Record<string, Record<string, unknown>>; required?: string[] };
			const a = before.properties[key] ?? {};
			const b = after.properties[key] ?? {};
			for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
				// `format` is carried AS its precomputed `pattern` (z.email() etc. keep the
				// regex, lose the cosmetic keyword). Where the pattern matches, the
				// constraint survived, so demanding the keyword too would fail a faithful
				// translation — and a red gate gets the CODE "fixed", not the test.
				if (k === "format" && JSON.stringify(a.pattern) === JSON.stringify(b.pattern)) continue;
				if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
					lost.push(`${spec.name}.${key}: ${k} ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
				}
			}
			if (JSON.stringify(before.required ?? []) !== JSON.stringify(after.required ?? [])) {
				lost.push(`${spec.name}.${key}: optionality changed`);
			}
		}
	}
	// A floor, not `> 0`: the failure this case exists to catch is the sweep silently
	// SHRINKING (it was 29 before the capability gate was pinned, hiding the broken member).
	// A floor stays green when specs gain params and goes red when coverage narrows.
	assert(
		checked >= 47,
		`constraint fidelity: swept ${checked} members, expected >= 47 — did the spec list shrink?`,
	);
	assert(lost.length === 0, `constraint fidelity: translation lost ${lost.length} — ${lost.join("; ")}`);
	console.log(`6) translation preserves every constraint OK ✅ (${checked} members)`);
}

// ---- 7. the unknown-kind fallback LOOSENS, never narrows -----------------------
// Case 6 can only see kinds the specs use today, so it cannot defend the fallback: the
// day a spec adds `z.number()` or `.nullable()`, case 6 still passes. The fallback's whole
// purpose is to widen a member it cannot translate rather than kill the connector — but an
// early return skips the `.optional()` re-wrap, and a BARE `z.unknown()` member is REQUIRED
// in zod. That would flip a future optional param to mandatory: a narrowing, the exact
// opposite of the intent, and visible only on the omp connector.
{
	const unhandledOptional = zodV4.z.number().optional().describe("a future optional param");
	const rebuilt = hostMember(zodV4.z as never, unhandledOptional).schema as never;
	const schema = zodV4.z.object({ limit: rebuilt });
	assert(
		schema.safeParse({}).success,
		"fallback: an unhandled OPTIONAL member stays optional (bare z.unknown() would be required)",
	);
	assert(
		schema.safeParse({ limit: 5 }).success,
		"fallback: an unhandled member accepts its original value (widened, not narrowed)",
	);
	// A REQUIRED unhandled member must stay required — widening applies to the type, not arity.
	const unhandledRequired = zodV4.z.number().describe("a future required param");
	const req = zodV4.z.object({ n: hostMember(zodV4.z as never, unhandledRequired).schema as never });
	assert(!req.safeParse({}).success, "fallback: an unhandled REQUIRED member stays required");
	// The degradation must be REPORTED, not just survivable: silently serving a looser tool
	// than every other connector is the failure this reporting exists to prevent.
	assert(
		hostMember(zodV4.z as never, unhandledOptional).degraded?.includes('"number"') === true,
		"fallback: reports the kind it could not translate",
	);
	// A kind the switch can NEVER learn, so this cannot decay: `number` is the likeliest
	// future addition, and the day someone adds `case "number":` the assertions above stop
	// testing the fallback while still passing. A synthetic kind keeps the contract pinned.
	const synthetic = {
		_zod: { def: { type: "optional", innerType: { _zod: { def: { type: "__never-handled__" } } } } },
		description: "a kind the switch cannot handle",
	};
	const syn = hostMember(zodV4.z as never, synthetic);
	assert(
		syn.degraded?.includes("__never-handled__") === true,
		"fallback: names an arbitrary unhandled kind",
	);
	assert(
		zodV4.z.object({ s: syn.schema as never }).safeParse({}).success,
		"fallback: an arbitrary unhandled OPTIONAL kind stays optional",
	);
	// A handled kind must NOT report — a spurious warning trains readers to ignore the real one.
	assert(
		hostMember(zodV4.z as never, zodV4.z.string().optional()).degraded === undefined,
		"fallback: a translated kind reports no degradation",
	);
	console.log("7) unknown-kind fallback loosens without narrowing OK ✅");
}

// ---- 8. describe survives the optional wrapper on an IR-style host --------------
// The bug this defends is invisible to every case above, which is exactly why it shipped:
// case 5's stub discards its arguments, and case 6 uses real zod as the host, where
// `.describe().optional()` and `.optional().describe()` are equivalent. On the omp 18.x IR
// facade they are NOT — `.optional()` builds a NEW union node that does not inherit the
// inner description, and the emitter suppresses the auto-derived one, so describing FIRST
// drops the text from the schema the model is shown.
//
// This host reproduces that one property: `.optional()` returns a node WITHOUT the desc.
{
	interface IRNode {
		desc?: string;
		describe(d: string): IRNode;
		optional(): IRNode;
		max(n: number): IRNode;
		min(n: number): IRNode;
		regex(r: RegExp): IRNode;
	}
	const node = (desc?: string): IRNode => ({
		desc,
		describe(d) {
			return node(d);
		},
		// The IR union does not carry the inner node's description — the whole bug.
		optional() {
			return node(undefined);
		},
		max() {
			return node(desc);
		},
		min() {
			return node(desc);
		},
		regex() {
			return node(desc);
		},
	});
	const irZ = {
		string: () => node(),
		boolean: () => node(),
		enum: () => node(),
		array: () => node(),
		unknown: () => node(),
		object: (shape: Record<string, unknown>) => ({ shape }),
	};
	// An optional member WITH a description — the shape of cotal_status.attention.
	const member = zodV4.z.enum(["open", "dnd", "focus"]).optional().describe("ATTN-DESC");
	const result = hostMember(irZ as never, member).schema as IRNode;
	assert(
		result.desc === "ATTN-DESC",
		`IR host: description survives the optional wrapper (got ${JSON.stringify(result.desc)}) — describe must be applied AFTER optional`,
	);
	// A required member keeps its description too (no wrapper involved).
	const required = zodV4.z.string().describe("REQ-DESC");
	assert(
		(hostMember(irZ as never, required).schema as IRNode).desc === "REQ-DESC",
		"IR host: a required member keeps its description",
	);
	console.log("8) description survives .optional() on an IR-style host OK ✅");
}


// ---- 9. degradations are reported, and a throwing host cannot take the mesh down --
// Two properties the JSON-Schema sweep cannot see. (a) A member that is narrowed or
// widened must SAY so: every other arm reports, and a silent enum narrowing makes a
// param uncallable on this connector only. (b) The never-throw contract must be real,
// not documented — `z` is typed as zod, but an 18.x host is a different object that
// merely resembles it, so a missing or stricter builder surfaces at RUNTIME. Unguarded,
// one throw removes EVERY cotal_* tool while the process still exits 0.
{
	const degradedOf = (m: unknown) => hostMember(zodV4.z as never, m as never).degraded;
	assert(
		degradedOf(zodV4.z.enum({ A: 1, B: 2 } as never))?.includes("widened to string") === true,
		"reporting: an all-numeric enum reports the widening",
	);
	assert(
		degradedOf(zodV4.z.enum({ A: "a", B: 1 } as never))?.includes("narrowed") === true,
		"reporting: a mixed enum reports the dropped members",
	);
	assert(
		degradedOf(zodV4.z.array(zodV4.z.date()))?.startsWith("array element:") === true,
		"reporting: an element loss says it was the element, not the array",
	);
	assert(degradedOf(zodV4.z.string().max(3)) === undefined, "reporting: no false positive");
	assert(degradedOf(zodV4.z.array(zodV4.z.string()).min(1)) === undefined, "reporting: no false positive on cardinality");

	// A host where every builder EXCEPT `object`/`unknown` throws — the worst case a real
	// facade can present. It must be a live Proxy, not a spread of one: `{...proxy}` copies
	// only own enumerable keys, of which a Proxy over `{}` has none, so spreading yields an
	// empty object and every builder reads `undefined` instead of throwing — a different
	// failure, and one that would let this case pass while testing almost nothing.
	const hostileZ = new Proxy(
		{ object: zodV4.z.object, unknown: zodV4.z.unknown },
		{
			get: (target, prop) =>
				prop in target
					? target[prop as keyof typeof target]
					: () => {
							throw new Error(`host rejected .${String(prop)}()`);
						},
		},
	);
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		// `object`/`unknown` must work, or there is no tool to register at all.
		zod: { z: hostileZ },
		logger: console,
		registerTool: (t: RegisteredTool) => tools.set(t.name, t),
		on: () => {},
		sendMessage: () => {},
		registerCommand: () => {},
		setLabel: () => {},
	};
	process.env.COTAL_NAME = "smoke-peer";
	cotalMesh(pi as never);
	assert(tools.size > 0, "never-throw: a hostile host still registers tools, it does not kill the extension");
	assert(tools.has("cotal_send"), "never-throw: a spec whose every member throws still registers");
	console.log(`9) degradations reported; a throwing host degrades, not crashes OK ✅ (${tools.size} tools)`);
}

console.log("\nCOTAL-MESH EXTENSION SMOKE OK ✅");
process.exit(0);
