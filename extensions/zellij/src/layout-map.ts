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
 *  `command`/`cwd` seed what it runs on a fresh boot. All optional — an empty pane is a bare shell. */
export interface LayoutPane {
  lane?: string;
  command?: string;
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
  let depth = 0; // brace depth relative to the tab body; panes live at the tab's direct child level
  let inSwapOrTemplate = false;
  let swapDepth = 0;

  for (const raw of lines) {
    const line = raw.trim();

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

    const tabMatch = line.match(/^tab name="((?:[^"\\]|\\.)*)"(.*)$/);
    if (tabMatch) {
      if (cur) tabs.push(cur);
      cur = { label: unescapeKdl(tabMatch[1]), panes: [] };
      depth = 0;
      continue;
    }

    if (!cur) continue;
    depth += countBraces(line);

    // A stacked tab shows `pane stacked=true { … }` wrapping its children.
    if (/\bstacked=true\b/.test(line) && /^pane\b/.test(line)) cur.stacked = true;

    // A content pane: `pane command="…"` (possibly with a cwd on a following line). Skip plugin/UI.
    const paneCmd = line.match(/^pane command="((?:[^"\\]|\\.)*)"/);
    if (paneCmd && !NON_CONTENT_PLUGINS.test(line)) {
      cur.panes.push({ command: unescapeKdl(paneCmd[1]) });
    }
    // A bare `pane` with no command and no plugin is an empty content pane (e.g. a shell).
    else if (/^pane\s*(\{)?\s*$/.test(line) && !NON_CONTENT_PLUGINS.test(line)) {
      cur.panes.push({});
    }

    // `cwd "…"` attaches to the most recent pane in this tab.
    const cwd = line.match(/^cwd "((?:[^"\\]|\\.)*)"/);
    if (cwd && cur.panes.length > 0) cur.panes[cur.panes.length - 1].cwd = unescapeKdl(cwd[1]);
  }
  if (cur) tabs.push(cur);

  return { version: 1, tabs };
}

/**
 * Render a {@link LayoutMap} to a full-session KDL layout string for a top-level `zellij --layout`
 * fresh boot. Emits each tab with its content panes (stacked when `tab.stacked`), plus a
 * `new_tab_template` so tabs the operator opens later inherit a sane default. Never emitted to a live
 * session (grammar trap); the body grammar is expanded (never the compact single-line form).
 */
export function generateKdl(map: LayoutMap): string {
  const out: string[] = ["layout {"];
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
 *  body grammar; a bare pane is a single `pane` node. `cwd` becomes a `cwd "…"` child. */
function renderPane(pane: LayoutPane, indentLevel: number): string {
  const pad = "    ".repeat(indentLevel);
  if (!pane.command) {
    return pane.cwd ? `${pad}pane cwd="${escapeKdl(pane.cwd)}"` : `${pad}pane`;
  }
  const lines = [`${pad}pane command="${escapeKdl(pane.command)}" {`];
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

/** Escape a value for a KDL double-quoted string. */
function escapeKdl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Inverse of {@link escapeKdl} for parsed dump values. */
function unescapeKdl(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
