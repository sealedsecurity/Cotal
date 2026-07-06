/**
 * E2E smoke test for @cotal-ai/zellij.
 * Run from the repo root: pnpm exec tsx extensions/zellij/smoke.ts
 * Uses a real background zellij session; cleans up on pass or fail.
 */
import { execFileSync } from "node:child_process";
import { registry } from "@cotal-ai/core";
import * as zellij from "./src/driver.js";
import { ZellijRuntime, zellijRuntimeProvider, zellijTerminalProvider } from "./src/runtime.js";

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

console.log("\n────────────────────────────────────────────────");
console.log(`\n${passed} passed, ${failed} failed\n`);

cleanup();

if (failed > 0) process.exit(1);
