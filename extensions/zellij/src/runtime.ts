import {
  registry,
  type AgentHandle,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
  type Tab,
  type TerminalLayout,
} from "@cotal-ai/core";
import * as zellij from "./driver.js";

/** Grace window for a clean exit before a graceful stop force-closes the tab. */
const GRACE_MS = 1_500;

/** Byte codes written to the focused pane. */
const ENTER = 13;
const CTRL_C = 3;

/** Schedule Enter keypresses to the tab named `name` every second for 5 seconds — auto-clears a
 *  one-time confirmation prompt (e.g. Claude's dev-channels prompt) without blocking. Focuses the
 *  tab before each send (writes go to the focused pane). */
function scheduleConfirm(session: string, name: string): void {
  for (let i = 1; i <= 5; i++) {
    setTimeout(() => {
      try {
        zellij.goToTabName(session, name);
        zellij.writeBytes(session, [ENTER]);
      } catch {
        /* tab gone or not ready — a later tick (or none) covers it */
      }
    }, i * 1_000);
  }
}

/**
 * Spawns each agent into its own new zellij **tab** in a shared per-space background session, so
 * spawned teammates get a full tab rather than crowding the spawner. Opened unfocused so the human
 * stays where they are; attach with `zellij attach <session>` then switch to the tab to watch a
 * worker. Like tmux/cmux you watch natively, so `attach()` throws — but teardown is real: the stable
 * numeric tab id is kept so the tab can be driven and closed.
 */
export class ZellijRuntime implements Runtime {
  readonly kind = "zellij" as const;

  constructor(private readonly session: string) {}

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new Error(
        `zellij runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`,
      );
    if (!zellij.available())
      throw new Error("zellij runtime: zellij is not available — is zellij installed and on PATH?");

    zellij.ensureSession(this.session);
    // P3: env -i strips the zellij server's inherited environment; only the connector-declared env
    // reaches the spawned agent (identity, model key, OS allow-list). zellij takes argv structurally,
    // so this is a clean argv, not a shell string.
    const argv = zellij.isolatedArgv(spec.env ?? {}, spec.command, spec.args);
    // Key the whole lifecycle off the STABLE numeric tab id zellij returns — tab names can be renamed
    // (a title escape), which would desync a name-based status/close.
    const tabId = zellij.openTab(this.session, name, argv, cwd, { focus: false });

    if (spec.confirm) scheduleConfirm(this.session, name);

    return {
      name,
      kind: "zellij",
      status: () => (zellij.tabNames(this.session).includes(name) ? "running" : "exited"),
      stop: (opts) => {
        if (opts?.graceful === false) return zellij.closeTabById(this.session, tabId);
        // Graceful: focus the tab, type `/exit` so the session shuts down cleanly (its SessionEnd
        // hook leaves the mesh), then close the now-idle tab regardless.
        try {
          zellij.goToTabName(this.session, name);
          zellij.writeChars(this.session, "/exit");
          zellij.writeBytes(this.session, [ENTER]);
        } catch {
          /* tab already gone — still ensure it's closed below */
        }
        // Deferred, so a throw here is uncaught in a timer and would crash the manager.
        // closeTabById already no-ops on an already-gone tab; guard anyway and log a genuine zellij
        // failure rather than let teardown cleanup take the process down.
        setTimeout(() => {
          try {
            zellij.closeTabById(this.session, tabId);
          } catch (err) {
            console.error(`zellij runtime: failed to close tab for "${name}":`, err);
          }
        }, GRACE_MS);
      },
      interrupt: () => {
        try {
          zellij.goToTabName(this.session, name);
          zellij.writeBytes(this.session, [CTRL_C]);
        } catch (err) {
          console.error(`zellij runtime: failed to interrupt "${name}":`, err);
        }
      },
      attach: () => {
        throw new Error(
          `zellij runtime: attach natively — \`zellij attach ${this.session}\`, then switch to ` +
            `tab "${name}"`,
        );
      },
    };
  }
}

/** Self-registering runtime provider — `import "@cotal-ai/zellij"` makes the manager's `zellij`
 *  runtime available without the manager depending on this package. */
export const zellijRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "zellij",
  available: () => zellij.available(),
  create: (opts) => new ZellijRuntime(opts.session),
};

registry.register(zellijRuntimeProvider);

/** Translate a backend-agnostic {@link Tab} into zellij tab + pane commands on `session`. One pane →
 *  a bare tab; several → a tab plus splits. These panes inherit the caller's env (setup panes run
 *  further `cotal` subcommands), so no `-i` isolation here. Returns the created tab's stable id. */
function zellijLayout(session: string, label: string, tab: Tab): string {
  const [first, ...rest] = tab.panes;
  if (!first) throw new Error(`zellij layout "${label}": tab has no panes`);

  if (rest.length > 0 && !tab.split)
    throw new Error(
      `zellij layout "${label}": ${tab.panes.length} panes need a split (direction + ratio)`,
    );

  const firstArgv = zellij.mergedArgv(first.env ?? {}, first.command, first.args ?? []);
  // Focus the new tab so the subsequent new-pane splits land inside it.
  const tabId = zellij.openTab(session, label, firstArgv, first.cwd ?? ".", { focus: true });

  if (first.confirm) scheduleConfirm(session, label);

  // {@link Tab.split.direction} convention: "horizontal" → stacked top/bottom rows (zellij "down");
  // "vertical" → side-by-side columns (zellij "right").
  const direction = tab.split?.direction === "vertical" ? "right" : "down";
  rest.forEach((pane) => {
    const argv = zellij.mergedArgv(pane.env ?? {}, pane.command, pane.args ?? []);
    zellij.newPane(session, argv, pane.cwd ?? ".", direction);
    if (pane.confirm) scheduleConfirm(session, label);
  });

  return tabId;
}

/** Self-registering terminal-layout provider — lets a caller (e.g. `cotal setup`) open/close zellij
 *  tabs by resolving `registry.resolve("terminal","zellij")`, so an implementation drives zellij
 *  without importing this package. The session is detected from the ambient `$ZELLIJ_SESSION_NAME`;
 *  throws if not inside zellij (per AGENTS.md: no silent fallback).
 *
 *  Handle model: zellij returns a tab's stable numeric id only at `new-tab` time and exposes just
 *  names thereafter — so this provider addresses tabs by their **label** (unique per opened tab).
 *  `open` returns the label as the ref; `close`/`refs` resolve by name. (The runtime path above,
 *  which holds the id from spawn, closes by that precise id instead.) */
export const zellijTerminalProvider: TerminalLayout = {
  kind: "terminal",
  name: "zellij",
  available: () => zellij.available(),
  open: (label, tab, opts) => {
    const session = zellij.currentSession();
    // zellijLayout focuses the new tab so its splits land inside it; restore focus unless asked.
    zellijLayout(session, label, tab);
    if (!(opts?.focus ?? false)) zellij.goToPreviousTab(session);
    return label;
  },
  close: (ref) => zellij.closeTabByName(zellij.currentSession(), ref),
  refs: (label) => (zellij.tabNames(zellij.currentSession()).includes(label) ? [label] : []),
};

registry.register(zellijTerminalProvider);
