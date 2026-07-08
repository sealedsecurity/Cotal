/**
 * The layout map: a small, versioned description of a multi-tab zellij arrangement, plus the two
 * pure functions that bridge it to zellij's KDL.
 *
 * - {@link seedFromDump} parses a live `zellij action dump-layout` into a {@link LayoutMap} — a
 *   one-time seed so an operator starts from their current arrangement rather than a blank map.
 * - {@link generateKdl} renders a {@link LayoutMap} back to a **full-session** KDL layout for a
 *   top-level `zellij --layout FILE` fresh boot.
 *
 * Both are pure (no live zellij), so they unit-test without a running server.
 *
 * THE GRAMMAR CONTRACT (verified against zellij 0.44.3). Two KDL contexts must never be conflated:
 * a *full-session* layout (`layout { tab {…} tab {…} }`, booted via top-level `zellij --layout`)
 * accepts `pane command="x" { … }` children and round-trips with `dump-layout`; applying a layout to
 * an *already-running* session (`action new-tab --layout-string`) parses each `tab` as a standalone
 * tab layout and rejects that grammar. `generateKdl` only ever emits the full-session form — it is
 * never fed to a live session. It also emits the EXPANDED body grammar (`args`/`start_suspended`
 * each on their own line), because the compact single-line body (`{ args "10"; start_suspended
 * true }`) fails to deserialize.
 */

/** One content pane within a tab. `lane` is an operator label (which wave lane this pane belongs to);
 *  `command`/`args`/`cwd` seed what it runs on a fresh boot. All optional — an empty pane is a bare
 *  shell. `args` are the command's argv tail (zellij dumps them as a separate `args "…" "…"` node). */
export interface LayoutPane {
  lane?: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

/** One tab: a `label` (its name) and its content panes. `stacked` renders the panes as a stack
 *  (zellij `pane stacked=true { … }`) rather than the default even tiling — the lane-tab default. */
export interface LayoutTab {
  label: string;
  stacked?: boolean;
  panes: LayoutPane[];
}

/** A full multi-tab arrangement. `version` pins the schema for forward migration. */
export interface LayoutMap {
  version: 1;
  /** Layout-level base cwd (zellij emits `cwd "…"` at the top of a dump). Relative pane cwds resolve
   *  against it, so it must round-trip or a regenerated pane boots in the wrong directory. */
  cwd?: string;
  tabs: LayoutTab[];
}

/** Panes zellij injects into every tab that are not agent content — the tab-bar/status-bar plugins
 *  and the `zellij:link` helper. `seedFromDump` skips them so a seeded map holds only real panes. */
const NON_CONTENT_PLUGINS = /plugin location="zellij:(tab-bar|status-bar|link|about)"/;

/**
 * Parse a `zellij action dump-layout` string into a {@link LayoutMap}. A one-time seed: it captures
 * the tab labels, their stacked-ness, and each tab's content panes (command + cwd), dropping zellij's
 * plugin/UI panes and the `new_tab_template` / `swap_*_layout` scaffolding that a fresh boot
 * regenerates. Best-effort and forgiving — an unparseable dump yields an empty map rather than
 * throwing, since it only seeds an editable default.
 */
export function seedFromDump(dumpKdl: string): LayoutMap {
  const tabs: LayoutTab[] = [];
  const lines = dumpKdl.split("\n");
  let cur: LayoutTab | null = null;
  let layoutCwd: string | undefined; // layout-level `cwd "…"` (before any tab); relative pane cwds resolve against it
  let inSwapOrTemplate = false;
  let swapDepth = 0;
  let inPluginPane = false; // inside a plugin/UI frame pane (`pane … { plugin … }`) — skip wholesale
  let pluginDepth = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();

    // Skip the swap_*_layout / new_tab_template blocks entirely — regenerated on boot, not content.
    if (/^(swap_tiled_layout|swap_floating_layout|new_tab_template)\b/.test(line)) {
      inSwapOrTemplate = true;
      swapDepth = 0;
    }
    if (inSwapOrTemplate) {
      swapDepth += countBraces(line);
      if (swapDepth <= 0 && /\}/.test(line)) inSwapOrTemplate = false;
      continue;
    }

    // Skip plugin/UI frame panes wholesale — a `pane … { plugin location="…" }` (tab-/status-bar).
    // Detected by an ACTUAL `plugin` child (bounded lookahead), NOT by size/borderless: those attrs
    // are legal on real content panes too (`pane size="50%" command="vim"`), so keying on them would
    // drop genuine content. A frame holds no agent content, so its children (a stray `cwd`/`args`)
    // must never leak onto the last real pane.
    if (
      /^pane\b/.test(line) &&
      !/\bcommand=/.test(line) &&
      /\{\s*$/.test(line) &&
      paneBlockHasPlugin(lines, idx)
    ) {
      inPluginPane = true;
      pluginDepth = 0;
    }
    if (inPluginPane) {
      pluginDepth += countBraces(line);
      if (pluginDepth <= 0 && /\}/.test(line)) inPluginPane = false;
      continue;
    }

    const tabMatch = line.match(/^tab name="((?:[^"\\]|\\.)*)"(.*)$/);
    if (tabMatch) {
      if (cur) tabs.push(cur);
      cur = { label: unescapeKdl(tabMatch[1]), panes: [] };
      continue;
    }

    // Layout-level `cwd "…"` appears before any tab; capture it as the map's base cwd.
    if (!cur) {
      const topCwd = line.match(/^cwd "((?:[^"\\]|\\.)*)"/);
      if (topCwd) layoutCwd = unescapeKdl(topCwd[1]);
      continue;
    }

    // A stacked tab shows `pane stacked=true { … }` wrapping its children (which ARE content).
    if (/\bstacked=true\b/.test(line) && /^pane\b/.test(line)) cur.stacked = true;

    // A content pane: `pane command="…" [cwd="…"] { … }` — command and cwd are INLINE attributes on
    // the pane line (zellij's dump form), with `args`/`start_suspended` as child nodes below.
    const paneCmd = line.match(/^pane\b[^{]*\bcommand="((?:[^"\\]|\\.)*)"/);
    if (paneCmd && !NON_CONTENT_PLUGINS.test(line)) {
      const pane: LayoutPane = { command: unescapeKdl(paneCmd[1]) };
      const inlineCwd = line.match(/\bcwd="((?:[^"\\]|\\.)*)"/);
      if (inlineCwd) pane.cwd = unescapeKdl(inlineCwd[1]);
      cur.panes.push(pane);
    }
    // A bare content pane is a LEAF: `pane`, `pane cwd="…"`, `pane focus=true` with no child block.
    // A `pane` that OPENS a block (`pane {`, `pane split_direction="vertical" {`, `pane stacked=true
    // {`) is a structural WRAPPER — its child panes are the real content, captured on their own
    // lines — so the wrapper line itself must not be recorded as an (empty) content pane.
    else if (
      /^pane\b/.test(line) &&
      !/\bstacked=/.test(line) &&
      !/\{\s*$/.test(line) &&
      !NON_CONTENT_PLUGINS.test(line)
    ) {
      const pane: LayoutPane = {};
      const inlineCwd = line.match(/\bcwd="((?:[^"\\]|\\.)*)"/);
      if (inlineCwd) pane.cwd = unescapeKdl(inlineCwd[1]);
      cur.panes.push(pane);
    }

    // `args "a" "b" …` is a child node of the most recent pane — the command's argv tail. Without it
    // a seeded `omp --resume` regenerates as a bare `omp`, booting the wrong process.
    const argsLine = line.match(/^args\s+(.+)$/);
    if (argsLine && cur.panes.length > 0) {
      const toks = argsLine[1].match(/"((?:[^"\\]|\\.)*)"/g);
      if (toks) cur.panes[cur.panes.length - 1].args = toks.map((t) => unescapeKdl(t.slice(1, -1)));
    }

    // Fallback: a child `cwd "…"` node (older/alternate dump form) also attaches to the last pane.
    const cwd = line.match(/^cwd "((?:[^"\\]|\\.)*)"/);
    if (cwd && cur.panes.length > 0) cur.panes[cur.panes.length - 1].cwd = unescapeKdl(cwd[1]);
  }
  if (cur) tabs.push(cur);

  const map: LayoutMap = { version: 1, tabs };
  if (layoutCwd !== undefined) map.cwd = layoutCwd;
  return map;
}

/**
 * Render a {@link LayoutMap} to a full-session KDL layout string for a top-level `zellij --layout`
 * fresh boot. Emits each tab with its content panes (stacked when `tab.stacked`), plus a
 * `new_tab_template` so tabs the operator opens later inherit a sane default. Never emitted to a live
 * session (grammar trap); the body grammar is expanded (never the compact single-line form).
 */
export function generateKdl(map: LayoutMap): string {
  const out: string[] = ["layout {"];
  if (map.cwd) out.push(`    cwd "${escapeKdl(map.cwd)}"`);
  for (const tab of map.tabs) {
    out.push(`    tab name="${escapeKdl(tab.label)}" {`);
    const body = tab.panes.length > 0 ? tab.panes : [{}];
    const paneLines = body.map((p) => renderPane(p, tab.stacked ? 3 : 2));
    if (tab.stacked) {
      out.push(`        pane stacked=true {`);
      for (const pl of paneLines) out.push(pl);
      out.push(`        }`);
    } else {
      for (const pl of paneLines) out.push(pl);
    }
    out.push(`    }`);
  }
  // A default template for operator-opened tabs: a single empty pane.
  out.push(`    new_tab_template {`);
  out.push(`        pane`);
  out.push(`    }`);
  out.push("}");
  return out.join("\n") + "\n";
}

/** Render one pane at `indentLevel` (units of 4 spaces). A pane with a command emits the expanded
 *  body grammar; a bare pane is a single `pane` node. `cwd`/`args` become child nodes. A bare pane
 *  never carries args (args without a command is meaningless), so they're only emitted with one. */
function renderPane(pane: LayoutPane, indentLevel: number): string {
  const pad = "    ".repeat(indentLevel);
  if (!pane.command) {
    return pane.cwd ? `${pad}pane cwd="${escapeKdl(pane.cwd)}"` : `${pad}pane`;
  }
  const lines = [`${pad}pane command="${escapeKdl(pane.command)}" {`];
  if (pane.args && pane.args.length > 0)
    lines.push(`${pad}    args ${pane.args.map((a) => `"${escapeKdl(a)}"`).join(" ")}`);
  if (pane.cwd) lines.push(`${pad}    cwd "${escapeKdl(pane.cwd)}"`);
  lines.push(`${pad}}`);
  return lines.join("\n");
}

/** Net brace delta on a line ( `{` minus `}` ), ignoring braces inside double-quoted strings. */
function countBraces(line: string): number {
  let n = 0;
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inStr = !inStr;
    else if (!inStr && ch === "{") n++;
    else if (!inStr && ch === "}") n--;
  }
  return n;
}

/** Bounded lookahead: does the `pane … {` block that OPENS at `lines[startIdx]` hold a `plugin`
 *  child node? Identifies a plugin/UI frame (tab-/status-bar) precisely, vs a real content pane that
 *  merely carries `size`/`borderless`. Scans only this one brace-balanced block. */
function paneBlockHasPlugin(lines: string[], startIdx: number): boolean {
  let d = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i].trim();
    d += countBraces(l);
    if (i > startIdx && /^plugin\b/.test(l)) return true;
    if (d <= 0) return false; // block closed without a plugin child
  }
  return false;
}

/** Escape a value for a KDL double-quoted string. */
function escapeKdl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Inverse of {@link escapeKdl} for parsed dump values. */
function unescapeKdl(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
