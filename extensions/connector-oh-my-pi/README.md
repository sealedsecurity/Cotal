# @cotal-ai/oh-my-pi

The Cotal connector for [oh-my-pi](https://github.com/can1357/oh-my-pi). It ships two entry
points onto one mesh runtime (`MeshAgent` + the shared `cotal_*` tools from
[`@cotal-ai/connector-core`](../connector-core)):

## 1. Headless native-embed peer (`runOmpPeer` / `connector`)

Embeds a Cotal endpoint inside an oh-my-pi process and answers mesh traffic through the agent's
own loop, driven by the shared `InboxTurn` embed loop — like the [`@cotal-ai/pi`](../pi) adapter,
it drives a *live* turn (`steer()` folds a same-scope message into an in-flight one). This is the
path a Cotal manager uses to spawn and supervise an oh-my-pi worker (`connector.buildLaunch`).

## 2. Interactive session extension (`src/extension.ts`)

A `pi --extension` (default export = the extension factory) that joins a **human- or
Compass-launched** oh-my-pi session to the mesh — the interactive sibling of the
[opencode](../connector-opencode) plugin. It holds a `MeshAgent`, registers the `cotal_*` tools
via `pi.registerTool`, maps the session's event stream to presence, and delivers inbound mesh
traffic into the session with `pi.sendMessage(..., { deliverAs })` (waking an idle session,
steering a live one, never interrupting a running turn; acks on turn end so a crash redelivers).
Identity comes from `COTAL_*` env — no identity → inert, so a plain `omp` never joins as a stray
peer. `pnpm build` bundles it to `dist/extension.bundle.js` (esbuild, host `@oh-my-pi/*`
external), the artifact a session loads via `--extension`.

## Fork divergences handled here

oh-my-pi is a fork of Pi, so this mirrors [`@cotal-ai/pi`](../pi) but targets
`@oh-my-pi/pi-coding-agent`: retries surface as session `auto_retry_*` events (not an
`agent_end.willRetry` flag), and imports use the package's subpath entrypoints while the published
root type barrel is fixed upstream (see the header comment in `src/peer.ts` / `src/extension.ts`).

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

See [docs/agent-frameworks.md](../../docs/agent-frameworks.md) for the native-embed pattern,
and the [root AGENTS.md](../../AGENTS.md) for the tier rules.
