import { execFileSync } from "node:child_process";

/**
 * A thin driver over the `zellij` CLI (`zellij action …` on a running session). Mesh-free — the
 * runtime layer imports it. Unlike the tmux driver, nothing here builds a shell string: zellij
 * takes a command as structural argv after `--`, so env isolation and the launch command are passed
 * as separate argv elements (no shell-quoting, no injection surface).
 *
 * Addressing: each agent gets its own named zellij **tab**, and `new-tab` returns a **stable numeric
 * tab id** on stdout — the zellij analogue of tmux's `@N` window id. Lifecycle (status/close) keys
 * off that id; `write`/`write-chars` target the *focused* pane, so a per-tab send focuses the tab by
 * name first (tab names are unique per agent).
 */

/** True if zellij is installed and reachable on PATH. */
export function available(): boolean {
  try {
    execFileSync("zellij", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Session name from the surrounding zellij environment. Throws if not inside zellij (per AGENTS.md:
 *  no silent fallback). `ZELLIJ_SESSION_NAME` is set by zellij inside every session. */
export function currentSession(): string {
  const s = process.env.ZELLIJ_SESSION_NAME;
  if (!process.env.ZELLIJ || !s)
    throw new Error("zellij: not inside a zellij session ($ZELLIJ / $ZELLIJ_SESSION_NAME not set)");
  return s;
}

/** True if a zellij session named `session` exists (and is not exited). `list-sessions -n -s`
 *  prints one bare session name per line; an exited session is suffixed and filtered out. */
export function hasSession(session: string): boolean {
  try {
    const out = execFileSync("zellij", ["list-sessions", "-n", "-s"], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .includes(session);
  } catch {
    return false;
  }
}

/** Ensure a background zellij session `session` exists; creates it detached if absent. `attach
 *  --create-background` makes a session with no client attached (the manager spawns tabs into it;
 *  the human attaches later with `zellij attach <session>`). Idempotent — a live session is left
 *  untouched. */
export function ensureSession(session: string): void {
  if (hasSession(session)) return;
  execFileSync("zellij", ["attach", "--create-background", session], { stdio: "ignore" });
}

/** Every `zellij action` for `session` runs as a client against that specific session
 *  (`--session <s> action …`), so the driver targets a named background session, not just the
 *  ambient one. */
function actionArgs(session: string, action: string[]): string[] {
  return ["--session", session, "action", ...action];
}

function isTabGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // zellij prints a not-found / no-such-tab style error to stderr and exits non-zero when the tab id
  // is already gone. Treat any of those as an idempotent no-op (already closed).
  return /no tab|not found|does not exist|no such|couldn't find|unknown tab/i.test(msg);
}

function isPaneGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // `close-pane -p <id>` exits 0 even for an unknown id (verified), so this catch is defensive: a
  // future zellij could error on a gone pane. Treat a not-found/no-such-pane message as a no-op.
  return /no pane|not found|does not exist|no such|couldn't find|unknown pane/i.test(msg);
}

/** Render `env` as `KEY=value` argv tokens for `env -i`. Reject any KEY that isn't a valid env
 *  identifier — defense-in-depth, matching the tmux driver, even though zellij takes argv
 *  structurally (no shell splice). Values pass through verbatim as their own argv elements. */
function envAssignments(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      throw new Error(`zellij: refusing to pass unsafe env var name ${JSON.stringify(k)}`);
    return `${k}=${v}`;
  });
}

/** Build the argv that runs `command args` under `env -i` isolation — only the given `env` entries
 *  reach the process (the zellij server's inherited environment is stripped). Returned as the argv
 *  that follows `--` in a `new-tab`/`new-pane` invocation.
 *
 *  No-leak: unlike a shell-rendered runtime (tmux), the command is passed to zellij **structurally
 *  as argv** over its control socket, not rendered into a visible command line — so the `env -i
 *  KEY=value` assignments carrying secrets never appear in `zellij action dump-layout` or `ps`
 *  (verified: zellij records the resolved child command, and `env` exec's itself away). Hence no
 *  0o600-launcher-script indirection is needed here. */
export function isolatedArgv(
  env: Record<string, string>,
  command: string,
  args: string[],
): string[] {
  return ["env", "-i", ...envAssignments(env), command, ...args];
}

/** Build the argv that runs `command args` with `env` merged into the inherited environment (used by
 *  layout panes that run further `cotal` subcommands and need the ambient env). */
export function mergedArgv(
  env: Record<string, string>,
  command: string,
  args: string[],
): string[] {
  return ["env", ...envAssignments(env), command, ...args];
}

/** Open a new tab named `name` in `session`, running `argv` (already env-wrapped), rooted at `cwd`.
 *  Created unfocused by default so the human stays where they are; pass `focus: true` to switch to
 *  it. Returns the stable numeric tab id zellij prints on stdout — drive later status/close off it. */
export function openTab(
  session: string,
  name: string,
  argv: string[],
  cwd: string,
  opts: { focus?: boolean } = {},
): string {
  const out = execFileSync(
    "zellij",
    actionArgs(session, ["new-tab", "--name", name, "--cwd", cwd, "--", ...argv]),
    { encoding: "utf8" },
  ).trim();
  const id = out.split(/\s+/)[0];
  if (!id || !/^\d+$/.test(id))
    throw new Error(`zellij: couldn't read tab id from new-tab ("${out}")`);
  // new-tab focuses the created tab; restore the human's place unless focus was asked for.
  if (!(opts.focus ?? false)) goToPreviousTab(session);
  return id;
}

/** Open a new pane in the focused tab running `argv`, rooted at `cwd`, with a shape. `stacked` adds
 *  the pane to the tab's stack (the lane default), `floating` floats it, otherwise it splits along
 *  `direction` (default "down"). Returns the created pane id (`terminal_<n>`). The pane lands in the
 *  currently-focused tab, so callers focus the target tab first (see `goToTabNameCreate`). */
export function newPane(
  session: string,
  argv: string[],
  cwd: string,
  opts: { stacked?: boolean; floating?: boolean; direction?: "right" | "down" } = {},
): string {
  const shape = opts.stacked
    ? ["--stacked"]
    : opts.floating
      ? ["--floating"]
      : ["--direction", opts.direction ?? "down"];
  return execFileSync(
    "zellij",
    actionArgs(session, ["new-pane", ...shape, "--cwd", cwd, "--", ...argv]),
    { encoding: "utf8" },
  ).trim();
}

/** Focus a tab by name, CREATING it if absent (`go-to-tab-name --create`). Subsequent `new-pane`
 *  calls land in this now-focused tab — the placement path's "put this agent in tab X" primitive.
 *  Returns `""` (the tab was created or already current); a failure surfaces zellij's own error. */
export function goToTabNameCreate(session: string, name: string): string {
  execFileSync("zellij", actionArgs(session, ["go-to-tab-name", name, "--create"]), {
    stdio: "ignore",
  });
  return "";
}

/** Close a specific pane by its id (`terminal_<n>`), regardless of focus (`close-pane -p <id>`).
 *  Idempotent: an already-gone pane is a no-op. The precise per-agent teardown primitive for panes
 *  sharing a tab — closes exactly this pane, leaving its siblings alive. */
export function closePaneById(session: string, paneId: string): void {
  try {
    execFileSync("zellij", actionArgs(session, ["close-pane", "-p", paneId]), { stdio: "pipe" });
  } catch (err) {
    if (isPaneGone(err)) return;
    throw err;
  }
}

/** True if `paneId` (`terminal_<n>`) is a live (non-exited) pane in `session`. Reads the session-wide
 *  `list-panes --json --state`, whose numeric `id` is the suffix of the `terminal_<n>` id. A pane
 *  the server can't find (or an unreachable session) reads as absent → `false`. */
export function paneExists(session: string, paneId: string): boolean {
  const n = Number(paneId.replace(/^terminal_/, ""));
  if (!Number.isInteger(n)) return false;
  try {
    const out = execFileSync(
      "zellij",
      actionArgs(session, ["list-panes", "--json", "--state"]),
      { encoding: "utf8" },
    );
    const panes = JSON.parse(out) as Array<{ id: number; is_plugin?: boolean; exited?: boolean }>;
    return panes.some((p) => p.id === n && !p.is_plugin && !p.exited);
  } catch {
    return false;
  }
}

/** Focus a specific pane by its id (`terminal_<n>`), across tabs (verified: focuses a pane in a
 *  non-focused tab). Used before a pane-scoped write (interrupt / graceful `/exit`) so the keystrokes
 *  land in that agent's pane, not whatever else the tab last focused. Throws if the pane is gone —
 *  callers that must not fail (deferred teardown) guard it. */
export function focusPaneId(session: string, paneId: string): void {
  execFileSync("zellij", actionArgs(session, ["focus-pane-id", paneId]), { stdio: "ignore" });
}

/** Focus a tab by name. Returns silently; a missing tab surfaces zellij's own error. */
export function goToTabName(session: string, name: string): void {
  execFileSync("zellij", actionArgs(session, ["go-to-tab-name", name]), { stdio: "ignore" });
}

/** Focus the previously-active tab — used to restore the human's place after opening a tab
 *  unfocused. Best-effort: never throws (a failed focus-restore must not fail a spawn). */
export function goToPreviousTab(session: string): void {
  try {
    execFileSync("zellij", actionArgs(session, ["go-to-previous-tab"]), { stdio: "ignore" });
  } catch {
    /* best-effort focus restore — never fail a spawn over it */
  }
}

/** Close a tab by its stable numeric id. Idempotent: an already-gone tab is a no-op. */
export function closeTabById(session: string, tabId: string): void {
  try {
    execFileSync("zellij", actionArgs(session, ["close-tab-by-id", tabId]), { stdio: "pipe" });
  } catch (err) {
    if (isTabGone(err)) return;
    throw err;
  }
}

/** Close a tab by name: focus it, then close the (now-active) tab. Idempotent — a missing tab is a
 *  no-op. Used by the TerminalLayout path, where only names are queryable after creation (the stable
 *  numeric id is returned only at `new-tab` time, so a lingering same-label tab is closed by name). */
export function closeTabByName(session: string, name: string): void {
  try {
    execFileSync("zellij", actionArgs(session, ["go-to-tab-name", name]), { stdio: "pipe" });
    execFileSync("zellij", actionArgs(session, ["close-tab"]), { stdio: "pipe" });
  } catch (err) {
    if (isTabGone(err)) return;
    throw err;
  }
}

/** All open tab names in `session`, or `[]` if unreachable. */
export function tabNames(session: string): string[] {
  try {
    return execFileSync("zellij", actionArgs(session, ["query-tab-names"]), { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Write literal characters into the focused pane of `session`. `write-chars` sends text verbatim
 *  (no key-name interpretation). Focus the target tab first — writes go to the focused pane. */
export function writeChars(session: string, text: string): void {
  execFileSync("zellij", actionArgs(session, ["write-chars", text]), { stdio: "ignore" });
}

/** Write raw bytes into the focused pane of `session` (e.g. `13` = Enter, `3` = Ctrl-C). Bytes are
 *  passed as decimal argv tokens, matching `zellij action write`. */
export function writeBytes(session: string, bytes: number[]): void {
  execFileSync("zellij", actionArgs(session, ["write", ...bytes.map(String)]), { stdio: "ignore" });
}
