/**
 * E2E smoke test for @cotal-ai/zellij.
 * Run from the repo root: pnpm exec tsx extensions/zellij/smoke.ts
 * Uses a real background zellij session; cleans up on pass or fail.
 */
import { execFileSync } from "node:child_process";
import { registry } from "@cotal-ai/core";
import * as zellij from "./src/driver.js";
import { ZellijRuntime, zellijRuntimeProvider, zellijTerminalProvider } from "./src/runtime.js";
import { seedFromDump, generateKdl, type LayoutMap } from "./src/layout-map.js";

const SESSION = "cotal-zellij-smoke";
// The placement subtest's session — hoisted so the global cleanup + signal handlers reap it too
// (it spawns a detached `script` client that must not outlive an abrupt exit).
const PSESSION = "cotal-zellij-smoke-placement";
let passed = 0;
let failed = 0;

function ok(label: string, val: unknown): void {
  if (val) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

function throws(label: string, fn: () => unknown): void {
  try {
    fn();
    failed++;
    console.log(`  ❌ ${label} (did not throw)`);
  } catch {
    passed++;
    console.log(`  ✅ ${label}`);
  }
}

function cleanup(): void {
  // Reap BOTH live sessions (main + placement). delete-session --force also kills the placement
  // section's detached headless client, so no stray session or client process survives.
  for (const s of [SESSION, PSESSION]) {
    try {
      execFileSync("zellij", ["delete-session", "--force", s], { stdio: "ignore" });
    } catch {
      /* no such session — fine */
    }
  }
}

// ── layout-map (pure — no live zellij) ──────────────────────────────────────
// These run everywhere, including a zellij-less box, since seedFromDump/generateKdl are pure.
console.log("\n── layout-map (pure) ────────────────────────────");
{
  const map: LayoutMap = {
    version: 1,
    tabs: [
      { label: "supervisor", panes: [{}] },
      {
        label: "sealed",
        stacked: true,
        panes: [
          { command: "/usr/bin/env", args: ["sleep", "600"], cwd: "/tmp" },
          { command: "/usr/bin/env", args: ["sleep", "600"], cwd: "/tmp" },
        ],
      },
    ],
  };
  const kdl = generateKdl(map);
  // Full-session grammar: a top-level `layout {`, one `tab name="…"` per tab, a new_tab_template.
  ok("generateKdl emits a full-session layout block", kdl.startsWith("layout {"));
  ok("generateKdl emits the supervisor tab", kdl.includes('tab name="supervisor"'));
  ok("generateKdl emits the sealed tab", kdl.includes('tab name="sealed"'));
  ok("generateKdl marks the stacked tab", kdl.includes("pane stacked=true {"));
  ok("generateKdl emits a new_tab_template", kdl.includes("new_tab_template {"));
  // Expanded body grammar (not the compact single-line form that fails to deserialize).
  ok("generateKdl uses expanded pane bodies", kdl.includes('pane command="/usr/bin/env" {'));
  ok("generateKdl never emits a compact body", !/\{ *cwd .*; /.test(kdl));
  // Args survive generation: the command's argv tail is a child `args "…" "…"` node, not dropped.
  ok("generateKdl emits the args node", kdl.includes('args "sleep" "600"'));

  // seedFromDump parses a full-session dump back into a map (round-trip of the shape).
  const seeded = seedFromDump(kdl);
  ok("seedFromDump recovers both tabs", seeded.tabs.length === 2);
  ok(
    "seedFromDump recovers the supervisor label",
    seeded.tabs[0]?.label === "supervisor",
  );
  ok("seedFromDump recovers the stacked flag", seeded.tabs[1]?.stacked === true);
  ok(
    "seedFromDump recovers the sealed panes' commands",
    seeded.tabs[1]?.panes.every((p) => p.command === "/usr/bin/env"),
  );
  ok(
    "seedFromDump recovers pane args (argv tail round-trips)",
    seeded.tabs[1]?.panes.every(
      (p) => p.args?.length === 2 && p.args[0] === "sleep" && p.args[1] === "600",
    ),
  );
  ok(
    "seedFromDump recovers pane cwd",
    seeded.tabs[1]?.panes.every((p) => p.cwd === "/tmp"),
  );

  // The REAL `dump-layout` grammar: cwd is an INLINE attr on the pane line, args a child node,
  // start_suspended a child to ignore. This is the form seedFromDump must handle (a synthetic
  // generateKdl round-trip alone wouldn't catch an inline-cwd / args-child parse gap).
  const realDump = [
    'layout {',
    '    cwd "/home/mattw"',
    '    tab name="wave" {',
    '        pane stacked=true {',
    '            pane command="omp" cwd="agents/workspaces/zheng" {',
    '                args "--resume"',
    '                start_suspended true',
    '            }',
    '        }',
    '    }',
    '}',
  ].join("\n");
  const real = seedFromDump(realDump);
  const rp = real.tabs[0]?.panes[0];
  ok("seedFromDump parses inline cwd= on the pane line", rp?.cwd === "agents/workspaces/zheng");
  ok("seedFromDump parses the args child node", rp?.args?.length === 1 && rp.args[0] === "--resume");
  ok("seedFromDump ignores start_suspended", rp?.command === "omp" && real.tabs[0]?.panes.length === 1);
  // A plugin/UI frame pane (`pane size=1 borderless=true { plugin … }`) holds no agent content; a
  // stray `cwd`/`args` child inside it must NOT leak onto the last real pane (regression: the child
  // matchers once fired unguarded across the skipped block).
  const withPlugin = [
    'layout {',
    '    tab name="w" {',
    '        pane command="omp" {',
    '            args "--resume"',
    '        }',
    '        pane size=1 borderless=true {',
    '            plugin location="zellij:status-bar"',
    '            cwd "/WRONG/leaked"',
    '            args "leaked"',
    '        }',
    '    }',
    '}',
  ].join("\n");
  const wp = seedFromDump(withPlugin);
  const wpPane = wp.tabs[0]?.panes[0];
  ok(
    "seedFromDump skips plugin frames (no cwd/args leak onto real panes)",
    wp.tabs[0]?.panes.length === 1 &&
      wpPane?.cwd === undefined &&
      wpPane?.args?.length === 1 &&
      wpPane.args[0] === "--resume",
  );
  // Malformed input degrades to an empty map (best-effort seed, never throws).
  ok("seedFromDump tolerates junk", seedFromDump("not a layout").tabs.length === 0);

  // Regression (coderabbit/cubic P2): a REAL content pane may carry size=/borderless= (e.g.
  // `pane size="50%" command="vim"`). The plugin-frame skip must key on an actual `plugin` CHILD,
  // not on size/borderless — else genuine content is dropped.
  const sizedContent = [
    'layout {',
    '    tab name="t" {',
    '        pane size="50%" command="vim" {',
    '            args "file.txt"',
    '        }',
    '    }',
    '}',
  ].join("\n");
  const sc = seedFromDump(sizedContent).tabs[0]?.panes[0];
  ok(
    "seedFromDump keeps a sized content pane (plugin-skip needs a plugin child, not size/borderless)",
    sc?.command === "vim" && sc.args?.length === 1 && sc.args[0] === "file.txt",
  );

  // Regression (cubic P2): a `pane split_direction="…" { … }` is a structural WRAPPER; its child
  // panes are the content. The wrapper line itself must not be recorded as an extra empty shell.
  const splitWrap = [
    'layout {',
    '    tab name="t" {',
    '        pane split_direction="vertical" {',
    '            pane command="a"',
    '            pane command="b"',
    '        }',
    '    }',
    '}',
  ].join("\n");
  const sw = seedFromDump(splitWrap).tabs[0];
  ok(
    "seedFromDump treats split_direction as a wrapper (no phantom empty pane)",
    sw?.panes.length === 2 && sw.panes.every((p) => p.command !== undefined),
  );

  // Regression (cubic P2): layout-level `cwd "…"` (the base for relative pane cwds) must round-trip;
  // dropping it would reboot a relative-cwd pane in the wrong directory.
  const withTopCwd = seedFromDump(
    ['layout {', '    cwd "/home/mattw"', '    tab name="t" {', '        pane', '    }', '}'].join("\n"),
  );
  ok("seedFromDump captures the layout-level cwd", withTopCwd.cwd === "/home/mattw");
  ok("generateKdl re-emits the layout-level cwd", generateKdl(withTopCwd).includes('cwd "/home/mattw"'));
}

// Needs a real zellij. Skip cleanly where it isn't installed (local `pnpm check` on a zellij-less
// box); CI installs zellij explicitly so this runs there.
if (!zellij.available()) {
  console.log("zellij not installed — skipping @cotal-ai/zellij smoke.");
  process.exit(0);
}

// Guarantee teardown on ANY exit — normal, `process.exit(1)` on failure, or an uncaught throw
// mid-body (the header's "cleans up on pass or fail" promise). Registered before the first live
// session is created; `cleanup` is sync + idempotent, so a later explicit call would only no-op.
// `exit` does NOT fire on SIGINT/SIGTERM (Ctrl-C, `kill`), so handle those explicitly — re-exit so
// the `exit` hook still runs and the signal's non-zero status is preserved.
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanup();
    process.exit(1);
  });
}

cleanup(); // start fresh

console.log("\n── driver ──────────────────────────────────────");

ok("available() returns true", zellij.available());

console.log(`\n── session: ${SESSION} ──────────────────────────`);
zellij.ensureSession(SESSION);
ok("ensureSession creates the session", zellij.hasSession(SESSION));
zellij.ensureSession(SESSION);
ok("ensureSession is idempotent (a live session is untouched)", zellij.hasSession(SESSION));

// openTab returns a stable numeric tab id, not a name.
const tabId = zellij.openTab(SESSION, "test-tab", zellij.mergedArgv({}, "sleep", ["120"]), "/tmp", {
  focus: false,
});
ok("openTab returns a numeric tab id", /^\d+$/.test(tabId));

const names = zellij.tabNames(SESSION);
ok("tabNames includes test-tab", names.includes("test-tab"));

// send paths (target the focused pane — focus the tab first)
zellij.goToTabName(SESSION, "test-tab");
zellij.writeChars(SESSION, "echo hello");
zellij.writeBytes(SESSION, [13]); // Enter
ok("writeChars + writeBytes don't throw", true);

// close by stable id
zellij.closeTabById(SESSION, tabId);
// zellij applies the close asynchronously; give the server a beat.
await new Promise((r) => setTimeout(r, 300));
ok("tabNames excludes test-tab after closeTabById", !zellij.tabNames(SESSION).includes("test-tab"));

// idempotent close
zellij.closeTabById(SESSION, tabId);
ok("closeTabById is idempotent (no throw on already-gone)", true);

console.log("\n── runtime ─────────────────────────────────────");

const runtime = new ZellijRuntime(SESSION);
const SECRET_CANARY = "leak-canary-zellij-DO-NOT-LEAK";
const handle = runtime.spawn(
  "smoke-agent",
  { command: "sleep", args: ["120"], env: { COTAL_CONTROL_TOKEN: SECRET_CANARY } },
  "/tmp",
);
ok(`handle.name = "smoke-agent"`, handle.name === "smoke-agent");
ok(`handle.kind = "zellij"`, handle.kind === "zellij");
ok("handle.status() = running", handle.status() === "running");
ok("tab alive after spawn", zellij.tabNames(SESSION).includes("smoke-agent"));

// Regression (status by stable tab id, not mutable name): rename the tab out from under the handle;
// a name-based status() would now read "exited", the id-based one stays "running". Needs a client to
// apply the rename (background sessions don't rename clientless) — skip honestly where `script` is absent.
if (zellij.ensureClient(SESSION)) {
  zellij.goToTabName(SESSION, "smoke-agent");
  execFileSync("zellij", ["--session", SESSION, "action", "rename-tab", "smoke-renamed"]);
  await new Promise((r) => setTimeout(r, 400));
  ok("tab renamed (name-based status would be wrong now)", !zellij.tabNames(SESSION).includes("smoke-agent"));
  ok("status() = running AFTER rename (id-based survives it)", handle.status() === "running");
} else {
  console.log("  ⏭  no client (`script` absent) — skipping the rename-under-handle regression.");
}

// E2E no-leak: the secret env VALUE must not appear in zellij's queryable layout — env rides the
// structural argv over the control socket (env -i), never a rendered command line.
const layout = execFileSync("zellij", ["--session", SESSION, "action", "dump-layout"], {
  encoding: "utf8",
});
ok("dump-layout does NOT leak the env secret", !layout.includes(SECRET_CANARY));

handle.interrupt();
ok("interrupt() doesn't throw", true);

throws("attach() throws", () => handle.attach());

handle.stop({ graceful: false });
await new Promise((r) => setTimeout(r, 300));
ok("renamed tab gone after hard stop (close-by-id ignores the name)", !zellij.tabNames(SESSION).includes("smoke-renamed"));
ok("handle.status() = exited after stop", handle.status() === "exited");

console.log("\n── registry registration ────────────────────────");

ok("zellijRuntimeProvider registered as 'runtime/zellij'", registry.resolve("runtime", "zellij") != null);
ok("zellijRuntimeProvider.available() returns true", zellijRuntimeProvider.available());
ok("zellijTerminalProvider registered as 'terminal/zellij'", registry.resolve("terminal", "zellij") != null);
ok("zellijTerminalProvider.available() returns true", zellijTerminalProvider.available());

console.log("\n── argv builders ────────────────────────────────");

const isolated = zellij.isolatedArgv({ FOO: "bar baz", X: "1" }, "/usr/bin/env", ["sh"]);
ok("isolatedArgv starts with ['env','-i']", isolated[0] === "env" && isolated[1] === "-i");
ok("isolatedArgv carries FOO=bar baz as one token", isolated.includes("FOO=bar baz"));
ok("isolatedArgv ends with the command + args", isolated.at(-2) === "/usr/bin/env" && isolated.at(-1) === "sh");

const merged = zellij.mergedArgv({ FOO: "bar" }, "echo", ["hello"]);
ok("mergedArgv starts with 'env'", merged[0] === "env");
ok("mergedArgv does NOT contain '-i'", !merged.includes("-i"));

throws("isolatedArgv rejects an unsafe env var name", () =>
  zellij.isolatedArgv({ "BAD NAME": "x" }, "echo", []),
);

// scriptAttachArgv (portable `script` invocation for ensureClient) — regression for the CI/runner
// break: the structural `script … -- cmd` form needs util-linux ≥2.40 (silently no-ops on the
// runner's 2.39, so no client attaches and placement throws). The portable `-qec "<cmd>" /dev/null`
// string form works on every `script`; injection-safety comes from validating the session charset,
// not from avoiding the shell. These are pure (no spawn), so they run everywhere.
const attachArgv = zellij.scriptAttachArgv(SESSION);
ok("scriptAttachArgv uses the portable -qec string form", attachArgv[0] === "-qec");
ok("scriptAttachArgv does NOT use the ≥2.40 structural -- form", !attachArgv.includes("--"));
ok("scriptAttachArgv embeds `zellij attach <session>` as the command string", attachArgv[1] === `zellij attach ${SESSION}`);
ok("scriptAttachArgv ends with the /dev/null typescript sink", attachArgv.at(-1) === "/dev/null");
throws("scriptAttachArgv rejects a session name with shell metacharacters", () =>
  zellij.scriptAttachArgv("evil; rm -rf ~"),
);
throws("scriptAttachArgv rejects a session name with $(...) command substitution", () =>
  zellij.scriptAttachArgv("x$(touch pwned)"),
);
ok("scriptAttachArgv accepts the safe session charset (letters, digits, _ . -)", Array.isArray(zellij.scriptAttachArgv("cotal-space_1.2")));

console.log("\n── placement (pane-into-tab; the runtime auto-attaches a client) ──");
// Regression (greptile P1): placement pane-id ops (new-pane / list-panes / close-pane -p) silently
// no-op against a client-less background session, so a placed pane never spawns and reads as exited.
// The runtime's spawnIntoTab now calls ensureClient to attach a headless PTY client first — so this
// section spawns placement agents WITHOUT pre-attaching its own client and proves they come up live.
// ensureClient uses `script` (util-linux); skip honestly if it's absent (the fix can't work without it).
{
  let hasScript = true;
  try {
    execFileSync("script", ["--version"], { stdio: "ignore" });
  } catch {
    hasScript = false;
  }
  if (!hasScript) {
    console.log("  ⏭  `script` (util-linux) not available — skipping live placement (ensureClient needs it).");
  } else {
    try {
      const rt = new ZellijRuntime(PSESSION);
      const place = { tab: "lane", stacked: true } as const;
      // No pre-attached client: ensureSession makes a background session, and spawnIntoTab's
      // ensureClient must attach one so the pane actually spawns.
      const a = rt.spawn("laneA", { command: "/usr/bin/env", args: ["sleep", "600"] }, "/tmp", place);
      ok("placement: a client is attached after the first placed spawn", zellij.hasClient(PSESSION));
      const b = rt.spawn("laneB", { command: "/usr/bin/env", args: ["sleep", "600"] }, "/tmp", place);
      await new Promise((r) => setTimeout(r, 900));

      ok("placement: both agents land in one tab (create-on-demand)", zellij.tabNames(PSESSION).includes("lane"));
      ok("placement: laneA is running (pane really spawned, not exited)", a.status() === "running");
      ok("placement: laneB is running", b.status() === "running");

      // Regression (cubic P1: per-pane confirm routing): the "lane" tab holds 2 panes, and a confirm
      // must target each pane's OWN id (scheduleConfirmPane) — a tab-focus Enter reaches only the
      // last-focused pane. Checked HERE, before the adhoc tab below steals focus. laneB was the last
      // spawn, so the lane tab's focused pane is a concrete `terminal_N` that `paneExists` confirms is
      // independently addressable — exactly the per-pane target the fix routes the confirm to. (The
      // per-pane teardown below independently proves laneA's distinct id is separately targetable.)
      const laneFocused = zellij.focusedPaneId(PSESSION);
      ok(
        "confirm-routing: focused lane pane resolves to an addressable pane id (per-pane confirm target)",
        laneFocused !== null && /^terminal_\d+$/.test(laneFocused) && zellij.paneExists(PSESSION, laneFocused),
      );

      // ad-hoc tab still works after placement (the fluid-tab guarantee).
      zellij.goToTabNameCreate(PSESSION, "adhoc");
      ok("placement: an ad-hoc tab can still be created after placement", zellij.tabNames(PSESSION).includes("adhoc"));

      // Per-pane teardown: stopping laneA leaves laneB alive (shared tab, precise close).
      a.stop({ graceful: false });
      await new Promise((r) => setTimeout(r, 700));
      ok("placement: laneA exited after per-pane stop", a.status() === "exited");
      ok("placement: laneB still running (sibling untouched)", b.status() === "running");

      b.stop({ graceful: false });
      await new Promise((r) => setTimeout(r, 500));
      ok("placement: laneB exited after its own stop", b.status() === "exited");
    } finally {
      // delete-session reaps the headless client ensureClient attached (session-scoped, detached).
      try {
        execFileSync("zellij", ["delete-session", "--force", PSESSION], { stdio: "ignore" });
      } catch {
        /* none — fine */
      }
    }
  }
}

console.log("\n────────────────────────────────────────────────");
console.log(`\n${passed} passed, ${failed} failed\n`);

cleanup();

if (failed > 0) process.exit(1);
