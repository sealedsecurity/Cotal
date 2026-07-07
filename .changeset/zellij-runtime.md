---
"@cotal-ai/zellij": minor
---

feat: @cotal-ai/zellij — a zellij Runtime and TerminalLayout extension

Spawns each agent into its own **tab** in a shared per-space background zellij session (the human
attaches with `zellij attach <session>`), with P3 `env -i` isolation. A `TerminalLayout` provider
lets `cotal setup` open and close zellij tabs from the ambient `$ZELLIJ_SESSION_NAME` session.
Self-registers on import (`import "@cotal-ai/zellij"`), exactly like `@cotal-ai/tmux` and
`@cotal-ai/cmux`; select it with `--runtime zellij`, which fails loud if the extension isn't
imported (no silent fallback to pty). Lifecycle keys off the stable numeric tab id `new-tab`
returns. Because zellij takes the launch command structurally as argv over its control socket
(not a rendered command line), secret env values never appear in `dump-layout`/`ps` — so no
launcher-script indirection is needed.

Adds **per-agent placement**: `Runtime.spawn` takes an optional `placement` (target tab by name,
created on demand; stacked/floating/split), so a wave lands each agent as a pane in a named lane
tab of the shared session. Only zellij reads it; the other runtimes accept and ignore it. A pure
`layout-map` module (`seedFromDump`/`generateKdl`) turns a `dump-layout` into a full-session KDL
that boots via top-level `zellij --layout`, for fresh-boot wave restart. Per-agent `placement`
threads through the manifest → resolve → spawn chain (`runtime: zellij` + `placement` on an agent
entry), and `--runtime zellij` is selectable from both runtime allow-lists.
