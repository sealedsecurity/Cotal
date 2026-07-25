import { execFileSync, spawn } from "node:child_process";

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

/** True if `session` has at least one attached client. `list-clients` lists one row per connected
 *  client (plus a header); a background session with no client lists none. Unreachable → `false`. */
export function hasClient(session: string): boolean {
  try {
    const out = execFileSync("zellij", actionArgs(session, ["list-clients"]), { encoding: "utf8" });
    // Rows after the `CLIENT_ID …` header are real clients; a client row starts with a digit.
    return out.split("\n").some((l) => /^\d/.test(l.trim()));
  } catch {
    return false;
  }
}

/** util-linux `script` argv that attaches a headless PTY client to `session`. Uses the portable
 *  `-qec "<cmd>" /dev/null` command-STRING form, which every `script` supports — NOT the structural
 *  `-- <cmd>` form, which needs util-linux ≥2.40 and silently no-ops on older `script` (e.g. Ubuntu
 *  24.04's 2.39: the command never runs, no client attaches, placement fails). `-c` runs `<cmd>`
 *  under a shell, so the session name is validated against a metacharacter-free charset first
 *  (`^[A-Za-z0-9_.][A-Za-z0-9_.-]*$` — like the runtime's agent-name guard, but also barring a
 *  leading `-` so a name can't be read as a `zellij attach` CLI option), keeping the invariant
 *  that no attacker-controlled shell string is ever built. Throws on an unsafe name (no silent
 *  fallback). Exported for unit tests. */
export function scriptAttachArgv(session: string): string[] {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(session))
    throw new Error(
      `zellij: unsafe session name ${JSON.stringify(session)} (allowed: letters, digits, _ . -; not leading -)`,
    );
  return ["-qec", `zellij attach ${session}`, "/dev/null"];
}

/** Ensure `session` has an attached client, spawning a detached headless PTY one if none is present.
 *  Returns whether a client is attached on return. The PLACEMENT path needs this: pane-id ops
 *  (`new-pane`/`list-panes`/`close-pane -p`) silently no-op against a client-less background session
 *  — a placed pane never actually spawns and then reads as `exited` (verified on zellij 0.44.3). A
 *  real client makes them reliable; `zellij attach` needs a PTY, so wrap it in `script` (util-linux)
 *  via {@link scriptAttachArgv} (portable command-string form; session name validated there).
 *  The client is `detached`+`unref`'d so it outlives this process — session-scoped (reaped when the
 *  session is deleted), NOT manager-scoped. The human's own later `zellij attach` simply adds a
 *  second client (zellij multiplexes). Idempotent: skipped when a client (this one, or the human) is
 *  already attached. `script` missing/unspawnable → returns `false` so the caller can fail loud. */
export function ensureClient(session: string): boolean {
  if (hasClient(session)) return true;
  const client = spawn("script", scriptAttachArgv(session), {
    detached: true,
    stdio: "ignore",
  });
  // `spawn` reports a missing/unspawnable `script` ASYNCHRONOUSLY via an `error` event, never a sync
  // throw — an unhandled one crashes the process, so swallow it (the busy-wait below then times out
  // and we return false). Best-effort: a missing `script` is not fatal, the caller surfaces it.
  client.on("error", () => {});
  client.unref();
  // Block until the client is actually attached (≈140ms locally on 0.44.3), so a caller's subsequent
  // pane op sees a real client. Bounded busy-wait via a synchronous `sleep` child — `spawn` can't be
  // awaited from the sync spawn path. Give up after ~3s (client never attached — e.g. no `script`).
  for (let i = 0; i < 30; i++) {
    if (hasClient(session)) return true;
    try {
      execFileSync("sleep", ["0.1"], { stdio: "ignore" });
    } catch {
      return false; // sleep unavailable — stop waiting
    }
  }
  return false;
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
  const id = execFileSync(
    "zellij",
    actionArgs(session, ["new-pane", ...shape, "--cwd", cwd, "--", ...argv]),
    { encoding: "utf8" },
  ).trim();
  if (!/^terminal_\d+$/.test(id))
    throw new Error(`zellij: couldn't read pane id from new-pane ("${id}")`);
  return id;
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

/** The id (`terminal_<n>`) of the currently-focused content pane in `session`, or `null` if none is
 *  resolvable. Reads `list-panes --json` and picks the focused non-plugin pane. Used right after
 *  `openTab` to learn the first pane's id (zellij prints only a TAB id at `new-tab`), so a per-pane
 *  confirm can target it precisely rather than tab-focus (which races later splits). */
export function focusedPaneId(session: string): string | null {
  try {
    const out = execFileSync("zellij", actionArgs(session, ["list-panes", "--json"]), {
      encoding: "utf8",
    });
    const panes = JSON.parse(out) as Array<{ id: number; is_plugin?: boolean; is_focused?: boolean }>;
    const focused = panes.find((p) => p.is_focused && !p.is_plugin);
    return focused ? `terminal_${focused.id}` : null;
  } catch {
    return null;
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

/** True if a tab with the stable numeric `tabId` is open in `session`. Reads `list-tabs --json`
 *  (whose `tab_id` is the id `openTab` returns) so it survives a tab RENAME — unlike a name-based
 *  check, which desyncs the moment a title escape or `rename-tab` changes the visible name. Reliable
 *  clientless (verified: `list-tabs` answers a background session). A missing tab / unreachable
 *  session reads as absent → `false`. */
export function tabExists(session: string, tabId: string): boolean {
  const n = Number(tabId);
  if (!Number.isInteger(n)) return false;
  try {
    const out = execFileSync("zellij", actionArgs(session, ["list-tabs", "--json"]), {
      encoding: "utf8",
    });
    const tabs = JSON.parse(out) as Array<{ tab_id?: number }>;
    return tabs.some((t) => t.tab_id === n);
  } catch {
    return false;
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
