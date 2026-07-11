# Design: native OMP renderer for the cotal connector

## Problem / Intent

The cotal connector delivers mesh traffic into an oh-my-pi (OMP) session as a
`CustomMessage`, and registers the `cotal_*` tools natively. Both surfaces render
poorly today:

- **Inbound peer messages render as one flat blob.** `drive()` builds the injection
  text with `formatInjection(items)` and sends it as `content`, passing an empty
  `details: {}`. `formatInjection` (`connector-core/src/control.ts:76-81`) already
  emits one `•`-bullet per item joined by `\n`, so the string itself is structured —
  but with no registered renderer OMP falls back to rendering `content` as its default
  Markdown body (`message-frame.ts:58-89`), which reflows/soft-wraps those bullet lines
  so the per-message structure is lost on screen (Matt: "dumped into a single
  paragraph, hard to read"). The fix is the renderer (or, per OQ#4 option (a),
  pre-formatting `content` so OMP's own frame renders it cleanly) — not a change to
  `formatInjection`, which is already correct.
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
message to the renderer, which **branches on `message.customType`** — the value OMP
already dispatched the renderer on, so it is authoritative by construction (no
separate discriminator to keep in sync): an `incoming` message lays out one card per
`details.items` entry (sender · role · kind/channel badge · mention/historical
markers · text), and a `nudge` renders a single compact line from `content` (it
carries no items). The framing of these cards is a load-bearing Open Question — a
returned `MessageRenderer` Component does **not** inherit OMP's card frame (see OQ#4);
the record no longer assumes it "mirrors" one. The `content` string (the
`formatInjection` block) is retained unchanged as the no-renderer / non-TUI fallback
and as the LLM-visible text — the renderer is display-only and never alters what the
model reads.

This requires widening the connector's internal `PeerHost.sendMessage` `details`
type from `unknown` to a structured payload (`{ items: InboxItem[] }` — no `kind`
field; the renderer keys on `customType`), and threading the real `items` at the call
site instead of `{}`.

**Outbound — tool renderers.** Add `renderCall` (and optionally `renderResult`) to
the `pi.registerTool` options in `registerSpec()`. A tool carrying either hook takes
OMP's custom-renderer branch instead of the generic animated-spinner fallback, which
removes the glyph. There are two registration branches to cover: the `cotal_inbox`
branch and the generic branch (all other `cotal_*` tools). **Port the `renderCall` /
`renderResult` bodies** from OMP's built-in `ircToolRenderer` (`src/tools/irc.ts`) —
but only those two functions: irc's `inline` / `mergeCallAndResult` flags live on
OMP's *internal* `ToolRenderer` record, not on the extension `ToolDefinition` surface
`pi.registerTool` uses, so the merged single-card look is not reachable this way (see
OQ#5). Two rows (call + result) is the natural `ToolDefinition` shape and fully
removes the spinner glyph regardless.

**Why this approach (vs alternatives).** The `details`-passthrough is the sanctioned
OMP extension path — `sendMessage`'s typed `details` field exists precisely for
extension-specific structured data (`session/session-entries.ts:187`, "Extension-specific
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
   the `drive()` call site: `details: { items }` (in the nudge/override branch `items`
   is `[]` — the renderer keys on `message.customType`, not `items` emptiness, so
   nudges still render; see step 5). Also type the OMP-facing call as
   `pi.sendMessage<CotalInjectionDetails>({...})` (the host method is generic —
   `types.ts:1105`) so the payload is checked against `CustomMessagePayload<CotalInjectionDetails>`
   rather than erased to `unknown` at the `pi` boundary.
5. Implement a `MessageRenderer` (`renderCotalMessage`) that **branches on
   `message.customType`** (`INCOMING` vs `NUDGE`) — the value OMP already dispatched
   the renderer on, so it is authoritative and needs no separate `kind` field; it
   does NOT gate on `items` emptiness (nudge legitimately carries `items: []`, so an
   emptiness check would wrongly send nudges to the fallback):
   - `customType === INCOMING` → one card `Component` per `details.items` entry. The
     card frame is OQ#4 (a returned Component is unframed — option (a) returns
     `undefined` after pre-formatting `content`; option (b) hand-builds a frame).
   - `customType === NUDGE` → a single compact line rendered from `message.content`
     (the nudge string; `items` is `[]` here by design).
   - `details` absent/undefined (a non-cotal custom message) → return `undefined` so
     OMP falls back to `content`. This is the only unconditional `undefined` case.
6. Register it in `cotalMesh(pi)` for both custom types:
   `pi.registerMessageRenderer("cotal:incoming", renderCotalMessage)` and
   `pi.registerMessageRenderer("cotal:nudge", renderCotalMessage)`, using the exported
   `INCOMING` / `NUDGE` constants.
7. Extend the interactive-loop smoke to assert `details` carries the structured
   `items` (not `{}`) on an incoming batch, and that a registered renderer is invoked.

## Tasks

- [ ] **A1** — `renderCall` on both `registerTool` branches in `registerSpec()`
  (spinner-fallback fix, minimal).
  - `Interfaces:` consumes OMP `ToolDefinition.renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component` (`extensibility/extensions/types.ts:476`); produces a `Component` from `@oh-my-pi/pi-tui`. Attaches inside `registerSpec` (`extension.ts:141`), both the `cotal_inbox` `pi.registerTool` (`extension.ts:158`) and the generic `pi.registerTool` (`extension.ts:176`).
- [ ] **A2** — per-surface `renderCall` enrichment (recipient/channel/preview from `args`) + optional `renderResult`.
  - `Interfaces:` `renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme, args?: Static<TParams>) => Component` (`extensibility/extensions/types.ts:479-485`). **Port only the `renderCall`/`renderResult` function bodies** from `ircToolRenderer` (`src/tools/irc.ts:814`, registered into the *internal* renderer table at `src/tools/renderers.ts:86`); its `inline`/`mergeCallAndResult` flags are on OMP's internal `ToolRenderer` type (`src/tools/renderers.ts:34-72`), NOT on the extension `ToolDefinition` — do not copy them (see OQ#5).
- [ ] **A3** — smoke assertion: registered `cotal_*` tools expose a `renderCall`.
  - `Interfaces:` extends `extensions/connector-oh-my-pi/*.smoke.ts`; asserts against the fake `pi` capturing `registerTool` options.
- [ ] **B1** — widen + export `CotalInjectionDetails`; thread real payload at the `drive()` call site.
  - `Interfaces:` produces `export interface CotalInjectionDetails { items: InboxItem[] }` (no `kind` field — the renderer keys on `customType`; `InboxItem` from `@cotal-ai/connector-core`, shape at `connector-core/src/agent.ts:44`). Changes `PeerHost.sendMessage` `message.details` from `unknown` → `CotalInjectionDetails` (`interactive-loop.ts:35-40`); call site `interactive-loop.ts:96-97` `details: {}` → `details: { items }`, and types the OMP-facing call `host.sendMessage<CotalInjectionDetails>(...)` (host method generic at `extensibility/extensions/types.ts:1105`) so the payload is checked, not erased to `unknown`.
- [ ] **B2** — implement `renderCotalMessage: MessageRenderer<CotalInjectionDetails>`.
  - `Interfaces:` `MessageRenderer<T> = (message: CustomMessage<T>, options: MessageRenderOptions, theme: Theme) => Component | undefined` (`extensibility/extensions/types.ts:917-921`); reads `message.details` (`CustomMessage<T>.details?: T`, `session/messages.ts:556`) and `message.customType` (`session/messages.ts:554`). **Branches on `message.customType`**: `INCOMING` → per-`InboxItem` card `Component` (frame per OQ#4 — a returned Component is *not* wrapped in OMP's card by `renderFramedMessage` (`modes/components/message-frame.ts:50-56`); option (a) returns `undefined` after pre-formatting `content`, option (b) hand-builds the frame); `NUDGE` → compact single line from `message.content`; `details` absent → `undefined` (fall back to `content`) — the sole unconditional `undefined` case.
- [ ] **B3** — register the renderer for both custom types in `cotalMesh(pi)`.
  - `Interfaces:` `pi.registerMessageRenderer<CotalInjectionDetails>(customType, renderCotalMessage): void` (`extensibility/extensions/types.ts:1089`); called in `cotalMesh(pi: ExtensionAPI)` (`extension.ts:41`) for `INCOMING` (`"cotal:incoming"`) and `NUDGE` (`"cotal:nudge"`) (`interactive-loop.ts:42-43`).
- [ ] **B4** — smoke: `details` carries structured `items` on an incoming batch; renderer invoked.
  - `Interfaces:` extends `extensions/connector-oh-my-pi/interactive-loop.smoke.ts`; asserts the fake host records `details.items.length > 0` (not `{}`) and `registerMessageRenderer` was called for both types.

## Global Constraints

- **OMP API floor.** Connector depends on `@oh-my-pi/pi-coding-agent: "^16.3.12"`
  (`extensions/connector-oh-my-pi/package.json:34`), which resolves 16.3.12 (the
  only version in the pnpm store; there is no 16.3.15). The renderer APIs are
  **source-verified present in the installed 16.3.12 tree**:
  `registerMessageRenderer` (`extensibility/extensions/types.ts:1089`),
  `MessageRenderer<T>` (`types.ts:917-921`), `CustomMessage.details?: T`
  (`session/messages.ts:556`), `ToolDefinition.renderCall`/`renderResult`
  (`types.ts:476`/`479`). No version bump is required.
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
- **Design-critic pass (SEA-1188).** This record went through one adversarial
  read-only critic pass before freeze (2026-07-11). It folded five findings: the
  Problem mechanism (F6), the `customType` discriminator replacing a redundant `kind`
  field (F5), the generic-threaded `sendMessage` (F4), the corrected OMP anchors to
  the installed 16.3.12 tree (F3), and the `ircToolRenderer` port scope (F2). Two
  code-false core claims survived as load-bearing Open Questions #4 and #5 (the frame
  and the merged-card target) — both need Matt's call before freeze.

## Open Questions

1. **[RESOLVED — not for review] Do the renderer APIs exist in the build version?**
   Yes — `registerMessageRenderer`, `MessageRenderer<T>`, `CustomMessage.details`, and
   `ToolDefinition.renderCall/renderResult` are all source-verified in the installed
   OMP 16.3.12 tree. Resolved from OMP source rather than asked; folded into
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
4. **[LOAD-BEARING — from design-critic pass] Does a returned `MessageRenderer`
   Component inherit OMP's frame, or must the renderer rebuild it?** The Approach
   (and Task B2) says the inbound cards "mirror OMP's own `CustomMessageComponent`
   frame." **This is code-false as written.** `renderFramedMessage`
   (`modes/components/message-frame.ts:50-56`) hands a custom renderer's returned
   Component straight back to the caller **unframed** — `if (component) return
   component;` — and builds the rounded-outline `Box`/`Text`/`Markdown` card
   (`message-frame.ts:58-89`) **only** on the fallback path where the renderer
   returns `undefined`/throws. So a `MessageRenderer` that returns a Component owns
   the *entire* visual; it inherits no frame. Two materially different shapes:
   - **(a) Return `undefined` for the incoming case and fix the `content` string.**
     `formatInjection` (`connector-core/src/control.ts:76-81`) already emits one
     `•`-bullet per item joined by `\n`; pre-format it as a clean multi-line block
     and let OMP's own `renderFramedMessage` build the canonical card — the real OMP
     frame for free, zero internal-theme coupling. The lightest fix; but the cards
     stay text, not per-item Components.
   - **(b) Build a bespoke per-item frame in the renderer.** Gets rich per-item
     Components, but the card must be hand-built from `@oh-my-pi/pi-tui` primitives,
     and to match every *other* injected-message card it must reuse
     `renderFramedMessage`'s box styling (`theme.boxRound`, `theme.fg('borderMuted')`,
     `customMessageBg` — `message-frame.ts:60`, `custom-message.ts:23`), which are
     **internal theme keys not exported to extensions** — a new coupling the Lane-boundary
     constraint does not currently acknowledge.
   **Recommend (a)** for the first cut (lightest, no internal coupling; directly fixes
   the flat-blob Problem), with (b) as a follow-up if per-item Components are wanted.
   Needs Matt's call — the record's current "mirror the frame" answer is wrong and the
   choice changes both the Lane-boundary coupling and Task B2's shape.
5. **[LOAD-BEARING — from design-critic pass] Merged single card vs two rows for the
   `cotal_*` tool renderers?** The Approach (and Task A2) says to "copy the shape of
   OMP's built-in `ircToolRenderer`." **`ircToolRenderer` is not a drop-in template
   for an extension tool.** It is `{ inline: true, mergeCallAndResult: true,
   renderCall, renderResult }` (`tools/irc.ts:814-816`) plugged into OMP's *internal*
   `ToolRenderer` record (`tools/renderers.ts:34-72`), which carries those flags. The
   surface the connector actually registers through — `pi.registerTool` →
   `ToolDefinition` (`extensibility/extensions/types.ts:440-484`) — exposes **only**
   `renderCall?` (`:476`) and `renderResult?` (`:479`); it has **no `inline` /
   `mergeCallAndResult` / animated-pending fields** (grep of the type: none). So only
   the `renderCall`/`renderResult` *function bodies* port; irc's merged single-card
   behavior is unreachable via `registerTool`. Fork on the visual target:
   - **(a) Accept two rows** (a call row + a result row), the natural `ToolDefinition`
     shape. Simplest; the spinner-fix (the stated Problem) is fully met either way.
   - **(b) Hand-build a merged look inside `renderResult`** if a single irc-style card
     is wanted — more work, and it only approximates irc's merge.
   **Recommend (a)**; the spinner artifact (the actual Problem) is removed the moment
   either hook is present. Needs Matt's call on whether the merged look is a
   requirement. Task A2's "copy the shape" wording is corrected below to "port the
   render bodies; the wrapper flags are internal-only."
