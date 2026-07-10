# Design: native OMP renderer for the cotal connector

## Problem / Intent

The cotal connector delivers mesh traffic into an oh-my-pi (OMP) session as a
`CustomMessage`, and registers the `cotal_*` tools natively. Both surfaces render
poorly today:

- **Inbound peer messages render as one flat blob.** `drive()` builds the injection
  text with `formatInjection(items)` and sends it as `content`, passing an empty
  `details: {}` — with no registered renderer, OMP falls back to printing the raw
  string, so a batch of peer messages collapses into a single unreadable paragraph
  (Matt: "dumped into a single paragraph, hard to read").
- **Outbound `cotal_*` tool cards show a double-render spinner glyph.** The tools
  register via `pi.registerTool` with no `renderCall`/`renderResult`, so OMP uses its
  generic animated-spinner fallback — producing the visible spinner artifact Matt
  flagged.

Both are fixed natively in the connector by using OMP's extension rendering API:
a `registerMessageRenderer` for the inbound custom-message types, and
`renderCall`/`renderResult` on the outbound tool registrations.

This record is the design contract; the implementation ships separately (see
Global Constraints — it is gated on PR #8's fork-base clearing).

## Approach

**Inbound — structured message renderer.** Carry the already-in-hand `InboxItem[]`
through the `sendMessage` `details` field (today discarded as `{}`), and register a
`MessageRenderer` for the two custom types the loop emits (`cotal:incoming`,
`cotal:nudge`). OMP stores `details` on the `CustomMessage` and hands the whole
message to the renderer, which reads `message.details.items` and lays out one card
per item (sender · role · kind/channel badge · mention/historical markers · text),
mirroring OMP's own `CustomMessageComponent` frame. The `content` string (the
`formatInjection` blob) is retained unchanged as the no-renderer / non-TUI fallback
and as the LLM-visible text — the renderer is display-only and never alters what the
model reads.

This requires widening the connector's internal `PeerHost.sendMessage` `details`
type from `unknown` to a structured payload, and threading the real `items` (plus a
`kind` discriminator) at the call site instead of `{}`.

**Outbound — tool renderers.** Add `renderCall` (and optionally `renderResult`) to
the `pi.registerTool` options in `registerSpec()`. A tool carrying either hook takes
OMP's custom-renderer branch instead of the generic animated-spinner fallback, which
removes the glyph. There are two registration branches to cover: the `cotal_inbox`
branch and the generic branch (all other `cotal_*` tools). Copy the shape of OMP's
built-in `ircToolRenderer` (`src/tools/irc.ts`, wired in `src/tools/renderers.ts`),
which is the closest analogue (a messaging tool).

**Why this approach (vs alternatives).** The `details`-passthrough is the sanctioned
OMP extension path — `sendMessage`'s typed `details` field exists precisely for
extension-specific structured data (`session-entries.ts:197`, "Extension-specific
data (not sent to LLM)"), and `registerMessageRenderer` is the matching read side.
The alternative — parsing the flat `formatInjection` string back into rows inside a
renderer — is fragile (re-parsing text we already have structured) and was rejected.
Hooks are attached once in `registerSpec` (not per-tool inline) because that helper
is the single registration chokepoint for every cotal tool.

## Plan

Two independent workstreams. The outbound tool-renderer work is smaller and fully
API-version-independent; the inbound work depends on the `registerMessageRenderer` /
`details` path (both source-verified present — see Global Constraints). They share no
code beyond living in the same two files, and can land as separate PRs (see Open
Questions #2).

**Workstream A — outbound tool renderers (`extension.ts`)**

1. Add `renderCall` to the `cotal_inbox` `registerTool` options and to the generic
   `registerTool` options in `registerSpec()`. Minimal form: a titled single-line
   `Text` (tool label + a one-line summary of args) — enough to leave the
   spinner-fallback branch. Optionally add `renderResult` for a compact result line.
2. Enrich `renderCall` per surface: for send-class tools (`cotal_send`, `cotal_dm`,
   `cotal_anycast`) show recipient/channel + a message preview from `args`; for
   `cotal_status` show the new status/activity; for `cotal_inbox` a static
   "peek inbox" label.
3. Extend the connector smoke to assert the registered tools carry a `renderCall`
   (so the spinner-fallback regression is caught).

**Workstream B — inbound message renderer (`interactive-loop.ts` + `extension.ts`)**

4. Widen `PeerHost.sendMessage`'s `details` type from `unknown` to a structured
   `CotalInjectionDetails` payload, and export that type. Thread the real payload at
   the `drive()` call site: `details: { items, kind: override ? "nudge" : "incoming" }`
   (in the nudge branch `items` is `[]` — the renderer handles the bare-string nudge
   case distinctly).
5. Implement a `MessageRenderer` (`renderCotalMessage`) that reads
   `message.details.items` and returns a per-item card `Component` built from
   `@oh-my-pi/pi-tui` `Box`/`Container` + OMP `theme`, mirroring
   `CustomMessageComponent`. Handle: incoming (N item cards), nudge (single
   compact line), and the empty/absent-details fallback (render nothing extra —
   `content` already carries the text).
6. Register it in `cotalMesh(pi)` for both custom types:
   `pi.registerMessageRenderer("cotal:incoming", renderCotalMessage)` and
   `pi.registerMessageRenderer("cotal:nudge", renderCotalMessage)`, using the exported
   `INCOMING` / `NUDGE` constants.
7. Extend the interactive-loop smoke to assert `details` carries the structured
   `items` (not `{}`) on an incoming batch, and that a registered renderer is invoked.

## Tasks

- [ ] **A1** — `renderCall` on both `registerTool` branches in `registerSpec()`
  (spinner-fallback fix, minimal).
  - `Interfaces:` consumes OMP `ToolDefinition.renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component` (`types.ts:464`); produces a `Component` from `@oh-my-pi/pi-tui`. Attaches inside `registerSpec` (`extension.ts:141`), both the `cotal_inbox` `pi.registerTool` (`extension.ts:158-169`) and the generic `pi.registerTool` (`extension.ts:176-185`).
- [ ] **A2** — per-surface `renderCall` enrichment (recipient/channel/preview from `args`) + optional `renderResult`.
  - `Interfaces:` `renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme, args?: Static<TParams>) => Component` (`types.ts:467-472`). Copy template: `ircToolRenderer` (`src/tools/irc.ts`, registered in `src/tools/renderers.ts:106`).
- [ ] **A3** — smoke assertion: registered `cotal_*` tools expose a `renderCall`.
  - `Interfaces:` extends `extensions/connector-oh-my-pi/*.smoke.ts`; asserts against the fake `pi` capturing `registerTool` options.
- [ ] **B1** — widen + export `CotalInjectionDetails`; thread real payload at the `drive()` call site.
  - `Interfaces:` produces `export interface CotalInjectionDetails { items: InboxItem[]; kind: "incoming" | "nudge" }` (`InboxItem` from `@cotal-ai/connector-core`, shape at `connector-core/src/agent.ts:44-64`). Changes `PeerHost.sendMessage` `message.details` from `unknown` → `CotalInjectionDetails` (`interactive-loop.ts:34-40`); call site `interactive-loop.ts:96-98` `details: {}` → `details: { items, kind: override ? "nudge" : "incoming" }`.
- [ ] **B2** — implement `renderCotalMessage: MessageRenderer<CotalInjectionDetails>`.
  - `Interfaces:` `MessageRenderer<T> = (message: CustomMessage<T>, options: MessageRenderOptions, theme: Theme) => Component | undefined` (`types.ts:905-909`); reads `message.details?.items` (`CustomMessage<T>.details?: T`, `session/messages.ts:467-472`). Builds `Component` via `Box`/`Container` from `@oh-my-pi/pi-tui` + `theme`, mirroring `CustomMessageComponent` (`src/modes/components/custom-message.ts`). Renders per-`InboxItem` card; returns `undefined` when `details?.items` is empty/absent (fallback to `content`).
- [ ] **B3** — register the renderer for both custom types in `cotalMesh(pi)`.
  - `Interfaces:` `pi.registerMessageRenderer<CotalInjectionDetails>(customType, renderCotalMessage): void` (`types.ts:1077`); called in `cotalMesh(pi: ExtensionAPI)` (`extension.ts:41`) for `INCOMING` (`"cotal:incoming"`) and `NUDGE` (`"cotal:nudge"`) (`interactive-loop.ts:42-43`).
- [ ] **B4** — smoke: `details` carries structured `items` on an incoming batch; renderer invoked.
  - `Interfaces:` extends `extensions/connector-oh-my-pi/interactive-loop.smoke.ts`; asserts the fake host records `details.items.length > 0` (not `{}`) and `registerMessageRenderer` was called for both types.

## Global Constraints

- **OMP API floor.** Connector depends on `@oh-my-pi/pi-coding-agent: "^16.3.12"`
  (`extensions/connector-oh-my-pi/package.json:34`), which resolves 16.3.15. The
  renderer APIs are **source-verified present** in OMP at **16.3.4** (older than
  16.3.15 → present a fortiori; the CHANGELOG shows `registerMessageRenderer` landed
  many versions earlier): `registerMessageRenderer` (`types.ts:1077`),
  `MessageRenderer<T>` (`types.ts:905`), `CustomMessage.details?: T`
  (`session/messages.ts:472`), `ToolDefinition.renderCall/renderResult`
  (`types.ts:464/467`). No version bump is required.
- **Import path.** The connector deep-imports OMP types from
  `@oh-my-pi/pi-coding-agent/extensibility/extensions/types` (the published root
  barrel is currently unconsumable under `nodenext`; see `extension.ts:23-28`).
  Renderer/tool-renderer types come from that same subpath; TUI primitives
  (`Component`, `Box`, `Container`) from `@oh-my-pi/pi-tui`.
- **Lane boundary.** Changes are confined to `extensions/connector-oh-my-pi` (and the
  `InboxItem` type it already imports from `connector-core`). No core/protocol change.
- **Display-only.** The renderer never alters `content` (the LLM-visible text /
  non-TUI fallback); it only adds a TUI `Component`. `formatInjection` +
  `ORIENTATION_BOOTSTRAP` behavior is unchanged.
- **Implementation is gated (design is not).** Connector code exists only on branch
  `cotal-connector-esc-composer` (PR #8), which is fork-base held (stacked on #5), so
  the implementation cannot merge until the fork-base clears. This design record is a
  markdown file off `main` and is not gated — it ships and freezes independently.
- **Conventions.** Conventional Commits; `Co-Authored-By: seal <noreply@sealedsecurity.com>`
  trailer; maintainer voice.
- **OMP-side fix is separate.** OMP owns a parallel commit-core root-cause fix
  (renderless cards never commit unsealed); it is independent of this connector-side
  rendering work and not in this lane.

## Open Questions

1. **[RESOLVED — not for review] Do the renderer APIs exist in the build version?**
   Yes — `registerMessageRenderer`, `MessageRenderer<T>`, `CustomMessage.details`, and
   `ToolDefinition.renderCall/renderResult` are all source-verified in OMP 16.3.4
   (< the resolved 16.3.15). Resolved from OMP source rather than asked; folded into
   Global Constraints as the API floor. Recorded here only as a resolved note.
2. **[LOAD-BEARING] Landing target given #8's fork-base hold.** The implementation must
   build on the connector code, which lives only on #8 (fork-base held). Options:
   (a) stack the implementation branch on #8 and park it until the fork-base clears;
   (b) wait for #8 → `main`, then branch off `main`. **Recommend (a)** — the work is
   execute-ready the moment the fork-base clears, with no idle wait. Needs Matt's call
   before implementation starts.
3. **[non-load-bearing] One PR or two?** Ship inbound (Workstream B) and outbound
   (Workstream A) as one PR, or split. **Recommend split** — Workstream A (outbound
   spinner-fix) is smaller and fully API-version-independent, so it can land first
   with a tight diff; Workstream B follows. Deferred: the design is correct either
   way; this is a delivery-shape choice ratified at merge.
