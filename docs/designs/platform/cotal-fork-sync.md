# Cotal fork-sync + branch-model reset

Status: Draft (all Open Questions ruled by Matt — see Decisions; the PR merge freezes the record)

## Problem / Intent

`sealedsecurity/Cotal` is a fork of `Cotal-AI/Cotal` that has drifted too far to keep building on:
`origin/main` (`d55c6adb`) is **815 commits behind** `upstream/main` (`8571c1bb`) and carries 7
sealed commits; `origin/sealed-fork` (`0106d35c`) is **33 ahead / 723 behind**. Matt has decided
(frozen intent — not relitigated here) to reset the branch model: `main` becomes a clean mirror of
upstream `main` with zero sealed commits; `sealed-fork` becomes the integration branch = new `main`
+ the still-needed sealed changes reapplied via reviewed PRs. This record designs the HOW: the
migration sequence, the curated reapply inventory, coordination with in-flight branches, and the
per-feature verification plan.

## Approach

**Hard reset + curated cherry-pick reapply, human-gated at the two shared-branch moves.**

1. **Sync `main`** — a human (Matt) force-moves `main` to `upstream/main` (`8571c1bb`). The agent
   push-guard forbids agents pushing `main`; this step is specified here and executed by hand.
   Immediately before the move, the same hands push archive tags pinning the old tips
   (`archive/pre-sync-main` → `d55c6adb`, `archive/pre-sync-sealed-fork` → `0106d35c`) so no sealed
   history is ever unreachable (a raw tag push is not a `jj-vine submit`, so it stays inside the
   human gate — T2 commands 0a/0b).
2. **Reset `sealed-fork`** — same human gate force-moves `sealed-fork` to the new `main`. This is a
   hard reset, not a merge: a merge of 723 upstream commits into 33 sealed commits would produce a
   conflict swamp with no review story, and the whole point of the new model is that `sealed-fork`'s
   delta over `main` is exactly the set of reviewed reapply PRs (Decision D6). Owners of the
   in-flight branches are notified before the move and rebase after it (coordination cost recorded in
   the Plan).
3. **Reapply via PRs, one feature-group per PR** — the 33+7 sealed commits collapse into 4 reapply
   lanes (oh-my-pi connector, zellij runtime, cotal-mint identity-reuse, KV-watch-leak fix) plus an
   explicit **drop list** for work upstream has superseded. Each lane is a feature branch off the new
   `sealed-fork`, cherry-picked/re-derived, submitted via `jj-vine submit`, review-looped, and merged
   into `sealed-fork` — never pushed to it directly. **These are not uniformly cheap:** the connector
   (T4) reapplies a tree byte-identical to `sealed-fork`'s, but its `loop.ts:1` **value-import** of
   `InboxTurn` from `@cotal-ai/connector-core` dangles on the new base (upstream deleted that seam —
   see the inventory + Decision D7), so T4 is an API-migration port on par with T6/T7, not a
   tree-copy.

Curated inventory (verified against the clone this session, re-confirmed by the review pass):

| Group | Commits (on `origin/sealed-fork` / `origin/main`) | Disposition |
|---|---|---|
| oh-my-pi connector | `55bc0c60` (feat) + 12 fix/test commits through `568c8175`, incl. `e2347788` (pi-coding-agent 16.3.12 + zod), `ae2de4e1` (connector-core InboxTurn), `f6f91657` (CI smokes), `cd091f1b` (`@cotal-ai/delivery` decl) | **Reapply as a semantic PORT (not a tree-copy) — see Decision D7.** Upstream has no `extensions/connector-oh-my-pi` (`git ls-tree upstream/main extensions/` — only cmux, connector-{claude-code,codex,core,hermes,opencode}, orca, pi, tmux), so the tree lands with no path collision, and its `src/` is byte-identical to PR #13's branch (`git diff --quiet origin/sealed-fork origin/upstream-cotal-181-omp-connector -- extensions/connector-oh-my-pi/` is clean over the whole extension). **But byte-identity only proves our two copies match each other, not that the tree composes with upstream.** It does not: `loop.ts:1` **value-imports** `InboxTurn` (and `loop.ts:2` type-imports `InboxItem`/`InboxSource`) from `@cotal-ai/connector-core` — the value import is the build-breaker. Upstream deleted `extensions/connector-core/src/inbox-turn.ts` (`git cat-file -e` fails) and has no `ackInbox` (it drains via `drainInboxIds`, `extensions/connector-core/src/agent.ts:462`, with a two-site ack model). Upstream re-landed `InboxTurn` inside `extensions/pi` with a **different contract** (tombstone ledger, `TOMBSTONE_CAP=4096`, `extensions/pi/src/inbox-turn.ts:14,21`), exported at `extensions/pi/src/index.ts:4` "for SDK embedders driving their own session". `pnpm build` fails at `loop.ts:1` until the connector is ported per D7. |
| `@cotal-ai/zellij` runtime + placement | `35c26085`, `48c084b8` (feats) + 10 hardening commits through `a6ecda6b` | **Reapply.** Upstream has no `extensions/zellij` and no zellij references in `implementations/cli/src/` (grep clean); upstream's `extensions/tmux` is the sibling pattern to re-anchor the CLI-allowlist commits (`f2d0ba27`) against. |
| cotal-mint identity-reuse | The 7 commits on `origin/main` only (`dca37915^..d55c6adb`, PR #9) — **not** on `sealed-fork` (`merge-base --is-ancestor d55c6adb origin/sealed-fork` fails). Note the `^` — `dca37915..d55c6adb` (two-dot, exclusive) drops `dca37915` itself (the foundational reuse commit) and yields only 6; the inclusive set is `dca37915^..d55c6adb` = 7. | **Reapply, expect conflicts.** Upstream `implementations/cli/src/commands/mint.ts` is 115 lines vs our 158 and has no identity-reuse (`grep 'reuse'` clean); its `--force` overwrite guard (`mint.ts:37-38`) sits inside a **new `--signer` mode** (`values.signer`, `mint.ts:29-42`) that did not exist in our version — the re-derivation must preserve it. Source from the archive tag, not the `cotal-mint-reuse-identity` branch (that branch carries only 4 of the 7 commits — see T7). |
| KV-watch-leak fix (SEA-1821) | `5e9a274f` + review rounds `b99340c5`, `c21270d8` (PR #12) | **Reapply, re-derive.** Upstream `packages/core/src/endpoint.ts` (3666 lines) has **no** `presenceWatch`/`channelWatch`/`stopWatch` (grep clean); the sealed fix lives at `origin/sealed-fork:packages/core/src/endpoint.ts:234,379-382`. The file drifted heavily (reconnect machinery now at `endpoint.ts:375-391`), so this is a port, not a clean cherry-pick. The smoke `packages/core/smoke/reconnect-watch-leak.smoke.ts` ports with it. **This lane also absorbs `fe6d3ec1`'s `packages/core` half** (exponential reconnect backoff) so all `endpoint.ts` reconnect surgery lands in one lane (see T6). |
| reconnect-logger (`origin/upstream-cotal-reconnect-logger`, tip `0041740f`, unmerged — 1 ahead of `sealed-fork`) | Standalone upstream-shaped variant of `fe6d3ec1` (edge logging, injectable MeshAgent logger, exponential endpoint backoff) | **Drop — superseded.** Its content is subsumed by `fe6d3ec1`, folded into T6's `endpoint.ts` port. Listed here so it is neither lost nor left basing on orphaned history; freeze-noticed in T1 and cleaned up in T9. |
| `@cotal-ai/pi` (`89a57ed5`) | On `origin/zheng-connector-oh-my-pi`, **not** on `sealed-fork` | **Drop — superseded by upstream's parallel `extensions/pi`.** `89a57ed5` is **not** an ancestor of `upstream/main` (`git merge-base --is-ancestor 89a57ed5 upstream/main` FAILS; it lives only on the side branch `upstream/feat/connector-openai-vercel` + `zheng-connector-oh-my-pi`). Upstream's `extensions/pi` is a **parallel reimplementation** with the same package name, rooted at a separate commit (`6f74fb8a`), evolved +1879/−269 over 15 files past our ancestor — **not** our `89a57ed5` evolved. It supersedes ours functionally and launches via `command: "pi"` (`extensions/pi/src/connector.ts:112`). We keep upstream's `extensions/pi` (untouched) and, per D7, the connector consumes its exported `InboxTurn`. |
| `yaml` phantom-dep workarounds | folded inside connector commits | **Drop.** Upstream declares `yaml ^2.9.0` (`packages/core/package.json:52`); any sealed workaround for the headless-spawn breakage is dead weight on the new base. |

Known debt resolved by D7: our connector launched through a `tsx` shim
(`origin/sealed-fork:extensions/connector-oh-my-pi/src/connector.ts:9,52` — `command: TSX`), while
upstream's correct launcher pattern is the runtime binary (`extensions/pi/src/connector.ts:112`,
`command: "pi"`). Since D7 ports the connector onto upstream pi's exported ledger (option b), the
launcher alignment folds into that port rather than being a separate follow-up.

## Alternatives considered

- **Merge upstream into `sealed-fork` instead of resetting** — preserves history in place, no
  forced rebases. Rejected (Decision D6): a 723-commit merge produces one unreviewable
  mega-conflict commit, leaves `main` still stale, and permanently forfeits the invariant that
  `sealed-fork − main` = the reviewed sealed delta.
- **Rebase the 33 commits wholesale onto upstream** — keeps every commit. Rejected: at least two
  groups (`@cotal-ai/pi`, yaml workarounds) are superseded, and the connector, mint, and KV-watch
  groups need re-derivation, not mechanical replay; per-feature PRs give each group its own review
  and test cycle.
- **New branch names (`main-mirror` + fresh integration branch) instead of force-moving the shared
  ones** — avoids the force-push. Rejected as the default (Decision D6), but the concrete rename
  cost is small: `git grep sealed-fork` over both trees' `.github/` and `docs/` is empty — no CI
  workflow or doc references the name. The real consumers are the in-flight branches' open-PR base
  refs + local checkouts, and those owners pay a 723-commit rebase under **either** model (their
  merge-bases are all pre-reset SHAs), so rebase cost does not differentiate. The hard reset rests
  on the invariant argument alone, which is sufficient. A **rename-cutover variant** (create
  `sealed-fork` anew at `8571c1bb`, tag+delete the old, rename into place) achieves the identical end
  state without a force-push through branch protection and lets GitHub retarget open PRs on rename —
  recorded as an acceptable execution variant of D6, not a distinct design.

## Global Constraints

- **Push-guard (the human gate):** the agent NEVER pushes or force-moves `main` or `sealed-fork`
  (the shared bases), and NEVER pushes the archive tags. Those moves (T2 — incl. the tag pushes 0a/0b
  — and T3) are specified here and executed by Matt by hand. Agents work only on feature branches
  under allowlisted owners.
- **`jj-vine submit` is the only push path** for agent work — never `git push`, never
  `gh pr create` (`rule://commit-conventions`, `skill://jj`).
- **Reapply PRs base on `sealed-fork` via `trunk()` (Decision D8).** `jj-vine` has no base-branch
  flag; it derives a PR's base from the DAG (parent bookmark, else `trunk()`), and it cannot base a
  PR on a bookmark that is neither trunk nor a submitted stack bookmark (empirically: it hangs on an
  untracked `sealed-fork@origin` base and panics — `bookmark.rs:738` — on a tracked one). So once
  `sealed-fork` IS the integration trunk (post-T3), set the clone's `revset-alias."trunk()" =
  "sealed-fork@origin"` and jj-vine bases every reapply PR (T4–T7) on `sealed-fork` natively. This is
  self-applied by the coordinating agent + re-verified (`jj config list --repo` shows the alias;
  a `--dry-run` submit shows base `sealed-fork`).
- **Rebase-onto-current before submit:** every reapply branch rebases onto the current
  `sealed-fork` tip immediately before each submit (`rule://sync-before-submit`).
- **Review loop on every PR** (`skill://review`): each reapply PR gets the full review cycle;
  review fixes are additive commits, never amend+force-push.
- **No history destruction:** archive tags (`archive/pre-sync-main`, `archive/pre-sync-sealed-fork`)
  MUST exist on origin before either force-move; every dropped/orphaned commit stays reachable
  through them.
- **PR base:** all reapply PRs target `sealed-fork`, never `main`. `main` stays a pristine upstream
  mirror — nothing sealed ever merges to it. (This record's own PR #14, opened on `main` as a review
  vehicle, is disposed of by T1/T9 — it does not merge to `main`.)
- **Verification floor per reapply PR:** `pnpm build` green + the feature's own smokes (named per
  task) on the new base. Upstream's full `pnpm check` gate is aspirational on day one (it chains
  30+ live smokes); each task names its required subset.
- **`endpoint.ts` reconnect zone is single-owner:** T6 owns ALL `packages/core/src/endpoint.ts`
  reconnect-path surgery (the watch-leak fix + `fe6d3ec1`'s backoff half). T4 does not touch
  `endpoint.ts`. This removes the concurrent-patch hazard the "independent lanes" framing hid.
- **Ordering:** T1 → T2 (incl. 0a/0b) → T3 strictly serial; T4–T7 (reapply lanes) may run in
  parallel after T3. T4 (connector) and T5 (zellij) are independent; T6 (KV-watch) and T7 (mint)
  are independent ports. T8 (in-flight-branch rebases) starts after T3 and proceeds per-owner.

## Plan

### T1 — Pre-flight: freeze notice + this record's PR authored
Owner: coordinating agent.
Do: broadcast a freeze notice to the owners of the in-flight branches that `sealed-fork` will be
force-moved and they must rebase or close (see T8): `cotal-connector-renderer-design`,
`cotal-connector-renderer-tools`, `cotal-durable-acl-design`, `cotal-durable-acl-provision`,
`cotal-mint-reuse-identity`, `harness-sea1821-kv-watch-leak`, and `upstream-cotal-reconnect-logger`.
This record's PR (#14) is authored on `main` as a **review vehicle** so Matt + the review agent can
ratify the design before T2/T3 execute — but it does **not** merge to `main` (Decision D5): T2
force-moves `main` to upstream, which orphans #14's base, so #14 is closed/retargeted at T9 and the
record re-lands as (part of) the first post-reset reapply-era PR targeting `sealed-fork`, making
`docs/designs/` part of the new sealed delta. The archive tags are pushed by Matt in T2 (0a/0b),
not here.
Interfaces: consumes `origin/main`@`d55c6adb`, `origin/sealed-fork`@`0106d35c`; produces an
acknowledged notice from each branch owner + PR #14 (review vehicle; not merged to `main`).
Verify: each in-flight-branch owner has acknowledged the freeze notice.

### T2 — Human gate: archive tags + force-move `main` to upstream (Matt executes)
Owner: Matt (agent cannot push `main` or the tags).
Do (exact commands, run from a clone with both remotes):
```bash
# 0a/0b — archive tags FIRST (no-history-destruction precondition)
git push origin d55c6adb:refs/tags/archive/pre-sync-main
git push origin 0106d35c:refs/tags/archive/pre-sync-sealed-fork
# then the force-move
git fetch upstream main
git push origin +8571c1bbe585:refs/heads/main
```
(If GitHub branch protection blocks the force-push, temporarily lift it — the repo's "sync fork"
will not fast-forward, since `main` has 7 sealed commits, so the force-push path is the real one.)
Interfaces: produces the two origin tags + `origin/main` = `8571c1bb`, 0 ahead / 0 behind
`upstream/main`. Note: the force-move orphans PR #14's base — handle #14 at/after T3 (T9), do not
leave it dangling.
Verify: `git ls-remote origin 'refs/tags/archive/*'` shows both tags at `d55c6adb` / `0106d35c`;
`git rev-parse origin/main` = `8571c1bbe585`; `git rev-list --count upstream/main..origin/main` = 0.

### T3 — Human gate: reset `sealed-fork` to the new `main` (Matt executes)
Owner: Matt.
Do: `git push origin +8571c1bbe585:refs/heads/sealed-fork` (same SHA as T2 — sealed-fork starts
life as an exact copy of the new `main`).
Interfaces: consumes T2 complete; produces `origin/sealed-fork` = `8571c1bb`. From here
`sealed-fork − main` = merged reapply PRs only.
Verify: `git rev-parse origin/sealed-fork` = `8571c1bbe585`.

### T4 — Reapply lane: oh-my-pi connector (semantic port onto upstream pi's ledger — D7)
Owner: `upstream-cotal/service-owner` (the hardening author — Decision D3).
Do: branch `reapply-connector-oh-my-pi` off new `sealed-fork`; bring over
`extensions/connector-oh-my-pi/` from the archive tag `archive/pre-sync-sealed-fork`@`0106d35c`
(the byte-identical superset of PR #13 / zheng's branch — after T3, `origin/sealed-fork@0106d35c` is
dangling notation; resolve it via the tag). Then **port the InboxTurn seam per D7 (option b):**
rewrite `loop.ts` against `@cotal-ai/pi`'s exported `InboxTurn` (`extensions/pi/src/index.ts:4`) —
map the connector's commit/abandon/extend calls onto the tombstone-ledger API (`CommitResult`,
`drainInboxIds`). This dissolves `ae2de4e1`'s connector-core re-derivation (do NOT re-add
`inbox-turn.ts`/`ackInbox` to upstream's `connector-core`). Drop any `yaml` workaround (upstream
declares `yaml ^2.9.0`). Fold in the launcher alignment (`tsx` shim → `command: "pi"`). Do NOT
touch `extensions/pi` (upstream's) or `packages/core/src/endpoint.ts` (T6 owns the reconnect zone).
Re-check the `@cotal-ai/delivery` declaration (`cd091f1b`) against upstream's current `bin/cotal.ts`
resolution — drop if the build resolves without it.
Interfaces: consumes new `sealed-fork` + `archive/pre-sync-sealed-fork:extensions/connector-oh-my-pi/`
+ upstream's `extensions/pi` exported `InboxTurn`; produces one PR into `sealed-fork` adding
`extensions/connector-oh-my-pi`.
Verify: `pnpm build` green (the `loop.ts:1` break is resolved); connector smokes pass:
`extensions/connector-oh-my-pi/{interactive-loop,oh-my-pi-extension,oh-my-pi-peer}.smoke.ts`. **The
smokes currently fake the OLD inbox contract** (`oh-my-pi-peer.smoke.ts:72-95` implements `ackInbox`
on a FakeMesh) — under D7(b) they MUST be re-derived against upstream's ledger API, or they pass
green while asserting a contract the connector no longer uses (a rubber-stamp, not a test).

### T5 — Reapply lane: `@cotal-ai/zellij` runtime + placement
Owner: zheng (original author) or assigned lane.
Do: branch `reapply-zellij` off new `sealed-fork`; bring over `extensions/zellij/` from
`archive/pre-sync-sealed-fork`@`0106d35c` (feats `35c26085`, `48c084b8` + the 10 hardening commits,
squash-replayed as a small reviewable series); re-derive the CLI `--runtime zellij` allowlist changes
(`f2d0ba27`-equivalent) against upstream's current `implementations/cli/src/` (upstream has zero
zellij references — grep clean — so this is additive, patterned on upstream's `extensions/tmux`);
re-derive the zellij-binary CI caching (`d6112281`) against upstream's current CI workflows.
Interfaces: consumes new `sealed-fork` + `archive/pre-sync-sealed-fork:extensions/zellij/`; produces
one PR into `sealed-fork` adding `extensions/zellij` + CLI allowlist + CI caching.
Verify: `pnpm build` green; `extensions/zellij/smoke.ts` passes (in a throwaway zellij session per
`rule://zellij-session-safety`); `--runtime zellij` accepted by the CLI override allow-lists.

### T6 — Reapply lane: KV-watch-leak fix (SEA-1821) + reconnect backoff
Owner: the `harness-sea1821-kv-watch-leak` lane owner.
Do: branch `reapply-sea1821-kv-watch` off new `sealed-fork`; **port** (not cherry-pick) the fix onto
upstream's drifted `packages/core/src/endpoint.ts` (3666 lines, no trace of the fix). **Source the
fix content from `archive/pre-sync-sealed-fork`@`0106d35c`** — the SHAs `5e9a274f`, `b99340c5`,
`c21270d8`, and `fe6d3ec1` are reachable ONLY from `0106d35c` and are NOT ancestors of `d55c6adb`,
so after T3 the bare SHAs are dangling notation; resolve them via the tag (the
`harness-sea1821-kv-watch-leak` branch is closed at T8, so it is not a durable source either). Diff
seam-to-seam against the sealed-side anchors: the fields + `stopWatch()` at
`archive/pre-sync-sealed-fork:endpoint.ts:234`, teardown in `clearConnectionScoped` (upstream still
has it at `endpoint.ts:762,765,881`), the ACL grant for watch-consumer delete. Also port
`fe6d3ec1`'s reconnect-backoff half (sealed exponential 3s→30s; upstream still has flat
`retryMs=3000` at `endpoint.ts:391`) so all reconnect-path surgery is in this one lane. Port
`packages/core/smoke/reconnect-watch-leak.smoke.ts` (111 lines) + its root `package.json` script.
Red-green: run the ported smoke on unpatched upstream first and watch it fail
(`rule://red-green-testing`).
Interfaces: consumes new `sealed-fork` + fix content at `5e9a274f` (+ rounds `b99340c5`, `c21270d8`)
+ `fe6d3ec1`'s `packages/core` half, all via `archive/pre-sync-sealed-fork`@`0106d35c`; produces one
PR into `sealed-fork` touching `packages/core/src/endpoint.ts`, the smoke, root `package.json`.
Verify: smoke fails pre-patch, passes post-patch; `pnpm build` + `packages/core` tests green;
`packages/core/smoke/delivery-reconnect.smoke.ts` still green.

### T7 — Reapply lane: cotal-mint identity-reuse
Owner: the `cotal-mint-reuse-identity` lane owner.
Do: branch `reapply-mint-identity-reuse` off new `sealed-fork`; **source the 7 commits from
`archive/pre-sync-main`@`d55c6adb`, NOT the `cotal-mint-reuse-identity` branch** (that branch is 4
ahead of upstream — only 4 of the 7 commits; the `-v2` branch that carried the rest no longer exists
as a remote ref, so the 7 are reachable only via the tag / old main). Re-derive PR #9's behavior
(reuse existing identity unless `--force`; agent-profile gating; fail-loud on unparseable creds;
canonical-path + symlink rejection) onto upstream's rewritten
`implementations/cli/src/commands/mint.ts` (115 lines, no reuse logic — only the `--force` guard at
`mint.ts:37-38`, which sits inside upstream's **new `--signer` mode** at `mint.ts:29-42` that the
re-derivation MUST preserve). `packages/core/src/identity.ts` still exists upstream (drifted +66/−16)
— re-anchor against it. Port the red-green regressions (`bd3edb6d`, `994e85ce`) as the lane's tests.
Interfaces: consumes new `sealed-fork` + the 7 commits `dca37915^..d55c6adb` (inclusive of
`dca37915`) via `archive/pre-sync-main`; produces one PR into `sealed-fork` touching
`implementations/cli/src/commands/mint.ts`, `packages/core/src/identity.ts`, their smokes, root
`package.json`.
Verify: ported mint regression tests green; `pnpm build` green; manual smoke: `cotal mint` twice →
second run reuses identity; `--force` overwrites; `--signer` mode still works.

### T8 — In-flight branch rebases (coordination, per-owner)
Owner: each branch's owner; tracked by the coordinating agent.
Do: after T3, each in-flight branch rebases onto the new `sealed-fork` (or its lane's reapply branch
where it depends on one). Dispositions: `harness-sea1821-kv-watch-leak` (0 ahead of `sealed-fork` —
fully merged) and `cotal-mint-reuse-identity` are **superseded by T6/T7 → close, don't rebase**;
`upstream-cotal-reconnect-logger` is **superseded by `fe6d3ec1` in T6 → close** (T9); the four
renderer/ACL design branches rebase. This is the recorded coordination cost of the hard reset: every
rebasing owner pays one rebase across a 723-commit base jump; content conflicts are likely and each
owner triages their own.
Interfaces: consumes T3 complete + T1's notice; produces each branch either rebased onto
`sealed-fork`@`8571c1bb`+ or closed-as-superseded.
Verify: `git branch -r --no-merged origin/sealed-fork` contains only live, rebased branches; no
branch still bases on `0106d35c` ancestry.

### T9 — Post-migration: PR #13/#14 disposition + branch hygiene
Owner: coordinating agent.
Do: **close PR #13** (Decision D1 — its content is fully contained in T4's source), with a
cross-link to T4's PR. **Close or retarget PR #14** (this record's review vehicle): T2 orphans its
`main` base, so once the design re-lands as the first post-reset reapply-era PR targeting
`sealed-fork` (Decision D5), close #14 with a pointer to that PR. Delete or archive the superseded
connector/reconnect branches once T4/T6 merge (`upstream-cotal-181-omp-connector`,
`zheng-connector-oh-my-pi`, `zheng-connector-upstream`, `upstream-cotal-reconnect-logger`); confirm
the archive tags remain.
Interfaces: consumes T4/T6 merged + the design re-landed on `sealed-fork`; produces a clean origin
branch list.
Verify: PR #13 and PR #14 both closed with pointers to their successor PRs; `git branch -r` shows no
stale connector/reconnect branches; `git ls-remote origin 'refs/tags/archive/*'` still shows both
tags.

## Tasks

- [ ] T1 — Freeze notice acknowledged by all in-flight owners + PR #14 authored as review vehicle (not merged to `main`)
- [ ] T2 — (HUMAN) archive tags pushed (0a/0b) + `main` force-moved to `8571c1bb`, verified 0/0 vs upstream
- [ ] T3 — (HUMAN) `sealed-fork` reset to new `main`, verified; then set `trunk()=sealed-fork@origin` (D8)
- [ ] T4 — Connector reapply PR merged (build green — InboxTurn ported onto upstream pi's ledger — + connector smokes re-derived green)
- [ ] T5 — Zellij reapply PR merged (build + zellij smoke green)
- [ ] T6 — KV-watch + reconnect-backoff port PR merged (red-green smoke evidence attached)
- [ ] T7 — Mint identity-reuse port PR merged (regression tests green; `--signer` preserved)
- [ ] T8 — All in-flight branches rebased or closed-as-superseded
- [ ] T9 — PR #13 + PR #14 closed; stale connector/reconnect branches removed

## Decisions

Ruled by Matt on the design PR (#14). These freeze on merge and become the contract executing
agents read.

- **D1 — PR #13: close now as superseded.** Its connector source is byte-identical to `sealed-fork`'s
  (a duplicate reapply on stale `main`); T4 reapplies the same connector from the hardened lineage.
  Close with a cross-link to the fork-sync plan / T4 PR (T9).
- **D2 — Reapply the curated set as designed.** Reapply the 4 groups (connector, zellij,
  KV-watch+backoff, mint); drop the 3 superseded (`@cotal-ai/pi`, `yaml` workarounds,
  `upstream-cotal-reconnect-logger`).
- **D3 — Connector lineage + owner:** reapply the **hardened** `sealed-fork` lineage (a strict
  superset of zheng's); `upstream-cotal/service-owner` owns T4 (the hardening author, best placed
  for the InboxTurn port).
- **D4 — Execution: agent runs the main-move.** `upstream-cotal/service-owner` runs T2/T3 (the
  verbatim commands above); a coordinating agent drives T1/T8/T9; reapply lanes run as a small fleet.
  (This is inside the human gate only in the push-guard sense — Matt delegated the force-push
  execution to this agent explicitly; the agent does not self-authorize a `main` push absent that
  ruling.)
- **D5 — Sealed artifacts land on post-reset `sealed-fork`, never `main`.** This design record's
  PR #14 is a review vehicle on `main`; it does not merge to `main`. Post-reset, the record re-lands
  as (part of) the first reapply-era PR targeting `sealed-fork`; #14 is closed at T9.
- **D6 — Hard reset (force-move) + archive tags.** A 723-commit merge is unreviewable and forfeits
  the `sealed-fork − main = reviewed delta` invariant; the archive tags keep old history reachable
  and T1's notice bounds the surprise. The rename-cutover variant is an acceptable execution detail.
- **D7 — Connector InboxTurn: migrate onto upstream pi's exported ledger (option b).** Rewrite
  `loop.ts` against `@cotal-ai/pi`'s exported `InboxTurn` (`extensions/pi/src/index.ts:4`), NOT
  resurrect the deleted `connector-core` seam. This composes with dropping our `@cotal-ai/pi` +
  keeping upstream's, folds in the launcher alignment, and avoids a parallel ack surface against
  upstream's redesigned ack model. Smokes are re-derived to the ledger contract (T4).
- **D8 — Reapply PRs base on `sealed-fork` via `trunk()`.** jj-vine cannot base a PR on a non-trunk
  `sealed-fork` (hangs untracked / panics tracked, `bookmark.rs:738`; no `--base` flag). Post-T3,
  set the clone's `revset-alias."trunk()" = "sealed-fork@origin"` so jj-vine bases every reapply PR
  on `sealed-fork` natively. (A jj-vine follow-up: the hang/panic on a non-trunk base is a tool
  defect worth filing so future non-trunk bases don't need the trunk-alias workaround.)
