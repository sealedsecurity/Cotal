# @cotal-ai/zellij

The zellij integration: a thin driver over the zellij CLI (open/close a tab, send keys) plus a
self-registering `zellij` `Runtime` and `TerminalLayout` provider. Importing it registers both
with the core `Registry`, so the manager can spawn agents into zellij tabs without depending
on this package.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

## What it does

- **`Runtime` (`zellij`)** — each agent gets its own **tab** in a shared per-space zellij session
  (`cotal-<space>`), created as a background session the human attaches to (`zellij attach
  <session>`). Spawned unfocused; switch to the agent's tab to watch it. Env is isolated (`env -i`)
  so the zellij server's environment doesn't reach agents. Graceful stop focuses the tab, types
  `/exit`, then closes it; hard stop closes immediately. The tab's stable numeric id (returned by
  `new-tab`) keys the whole lifecycle, surviving tab renames.

- **`TerminalLayout` (`zellij`)** — opens/closes zellij tabs for host-side orchestration
  (e.g. `cotal setup`). Detects the current session from `$ZELLIJ_SESSION_NAME`; must be called
  from inside a zellij session. Supports multi-pane tabs via `new-pane`.

## Usage

```ts
import "@cotal-ai/zellij"; // self-registers; no other setup needed
```

Then select via the manager: `cotal supervise --runtime zellij`.

## Differences from `@cotal-ai/tmux`

Both spawn each agent into its own native surface in a shared per-space session and are
native-watch (no PTY streaming). tmux addresses a **window** by its stable `@N` id for every
operation, and sends keys to a specific window target. zellij only returns a tab's stable numeric
id at `new-tab` time and exposes just names thereafter — so the runtime keys lifecycle off that id
(spawn holds it), while `write`/`write-chars` target the *focused* pane, so a per-tab send focuses
the tab by name first. Like tmux, no `cli.ts` helper is included — zellij is always on PATH and
needs no bundled binary path.

See [docs/architecture.md](../../docs/architecture.md) (*Manager*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
