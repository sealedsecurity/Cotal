/**
 * E2E smoke test for @cotal-ai/zellij.
 * Run from the repo root: pnpm exec tsx extensions/zellij/smoke.ts
 * Uses a real background zellij session; cleans up on pass or fail.
 */
import { execFileSync, spawn } from "node:child_process";
import { registry } from "@cotal-ai/core";
import * as zellij from "./src/driver.js";
import { ZellijRuntime, zellijRuntimeProvider, zellijTerminalProvider } from "./src/runtime.js";
import { seedFromDump, generateKdl, type LayoutMap } from "./src/layout-map.js";

const SESSION = "cotal-zellij-smoke";
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
  try {
    execFileSync("zellij", ["delete-session", "--force", SESSION], { stdio: "ignore" });
  } catch {
    /* no such session — fine */
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
          { command: "/usr/bin/env", cwd: "/tmp" },
          { command: "/usr/bin/env", cwd: "/tmp" },
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
  // Malformed input degrades to an empty map (best-effort seed, never throws).
  ok("seedFromDump tolerates junk", seedFromDump("not a layout").tabs.length === 0);
}

// Needs a real zellij. Skip cleanly where it isn't installed (local `pnpm check` on a zellij-less
// box); CI installs zellij explicitly so this runs there.
if (!zellij.available()) {
  console.log("zellij not installed — skipping @cotal-ai/zellij smoke.");
  process.exit(0);
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
ok("tab gone after hard stop", !zellij.tabNames(SESSION).includes("smoke-agent"));
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

console.log("\n── placement (pane-into-tab; needs an attached client) ──");
// Pane-id ops (list-panes / focus-pane-id / close-pane -p) are only reliable with a client attached
// (verified): a background session's focus is stuck and pane-ids aren't introspectable. So fork a
// real `zellij attach` client for this section, then tear it down. Agents use an ABSOLUTE command —
// `isolatedArgv` wraps in `env -i`, which strips PATH, so a bare name wouldn't resolve.
{
  const PSESSION = "cotal-zellij-smoke-placement";
  // The client needs a PTY to actually attach — `spawn(..., {stdio:"ignore"})` gives no TTY and the
  // attach no-ops. `script -qec "<cmd>" /dev/null` runs the command under a PTY. If `script` isn't on
  // PATH (util-linux), skip the live-placement section honestly rather than report false failures.
  let hasScript = true;
  try {
    execFileSync("script", ["--version"], { stdio: "ignore" });
  } catch {
    hasScript = false;
  }
  if (!hasScript) {
    console.log("  ⏭  `script` (util-linux) not available — skipping live placement (pane-id ops need an attached client).");
  } else {
    try {
      execFileSync("zellij", ["delete-session", "--force", PSESSION], { stdio: "ignore" });
    } catch {
      /* none — fine */
    }
    zellij.ensureSession(PSESSION);
    // Attach a client under a PTY, in its own session (detached) so we can reap the whole group.
    const client = spawn("script", ["-qec", `zellij attach ${PSESSION}`, "/dev/null"], {
      stdio: "ignore",
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 1500)); // let the client attach + paint

    try {
      const rt = new ZellijRuntime(PSESSION);
      const place = { tab: "lane", stacked: true } as const;
      const a = rt.spawn("laneA", { command: "/usr/bin/env", args: ["sleep", "600"] }, "/tmp", place);
      const b = rt.spawn("laneB", { command: "/usr/bin/env", args: ["sleep", "600"] }, "/tmp", place);
      await new Promise((r) => setTimeout(r, 900));

      ok("placement: both agents land in one tab (create-on-demand)", zellij.tabNames(PSESSION).includes("lane"));
      ok("placement: laneA is running", a.status() === "running");
      ok("placement: laneB is running", b.status() === "running");

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
      // Reap the client's process group (script + its zellij child).
      try {
        if (client.pid) process.kill(-client.pid);
      } catch {
        /* already gone */
      }
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
