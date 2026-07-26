# Durable-delivery ACL provisioning

Design record — control-plane/security fix. Design only; implementation follows as separate PRs
against this frozen contract.

## Problem / Intent

The durable read-ACL registry row (KV bucket `cotal_acl_<space>`, one record per agent id holding its
`allowSubscribe`) is the keystone that lets the standalone delivery daemon authorize an agent's
durable deliveries while the agent is dormant. `packages/core/src/acls.ts:11-13`:

> Every write is a single ATOMIC CAS put of the whole value, so a present record is always complete:
> a present `allowSubscribe: []` is a known "reads nothing" policy (the reader DROPS), distinct from
> an ABSENT record (a genuinely-unknown owner — the reader DEFERS, never drops).

The row is written only by `provisionAgent` → `commitAcl`, gated at
`packages/core/src/provision.ts:272`:

```ts
if (opts.durableMembership !== false) await provisioner.commitAcl(identity.id, allowSubscribe);
```

But the two launch paths agents actually use never reach that write:

1. **`cotal mint`** (the manual/canonical recipe) calls `mintCreds` directly and only writes a creds
   file — `implementations/cli/src/commands/mint.ts:88-92`:

   ```ts
   const identity = newIdentity();
   const creds = await mintCreds(auth, identity, profile, { allowSubscribe, allowPublish, role });
   ```

   mint is purely offline: it has no `CotalEndpoint`/`connect`/`isReachable` code at all (a search over
   `mint.ts` for those symbols returns zero matches), so it cannot write a KV row.

2. **`cotal spawn`** explicitly opts out — `implementations/cli/src/commands/spawn.ts:249-256`:

   ```ts
   const creds = await provisionAgent(prov, auth, identity, {
     ...
     durableMembership: false,
   });
   ```

An agent with no row is @mention-wake-blind: the daemon refuses its durable join,
`packages/core/src/endpoint.ts:1643-1645`:

```ts
const acl = await readAcl(await this.aclRegistry(), caller);
if (acl === undefined)
  return { ok: false, error: `durableJoin: no read ACL on record for ${caller} (not provisioned for durable delivery)` };
```

**Live evidence (from the investigation record that motivated this design):** the live `cotal_acl_main` bucket held
**0 rows across all 7 connected agents** — every dormant agent was wake-blind. An out-of-band
backfill (`commitAcl` per live agent id) took rows 0→6, after which durable memberships self-healed
0→8 with no reconnect via the boot-join reconcile loop (`endpoint.ts:1938-1942`, capped-backoff
retry `Math.min(30_000, 1000 * 2 ** attempt)`) — proving the row is the whole gate. The backfill is
runtime KV state (wiped by a mesh rebuild / fresh auth regen, e.g. the upcoming `wave` bring-up), so
it is not the fix; this design is.

> **Scope caveat (the row is the whole gate *for this population*).** Those 7 agents were
> spawn/manager-provisioned, so they already held their bind-only `dm_<id>` + `dlv_<id>` durables —
> only the ACL row was missing, which is why committing it alone restored delivery. An agent brought
> up via `cotal mint` + `exec omp` (this design's target recipe) has **neither** the ACL row **nor**
> the durables: `cotal mint` is offline (creds only), and only a provisioner can create `dlv_<id>`
> (the agent is denied `CONSUMER.CREATE` on DLV; `pumpDlv` silently no-ops when it's absent). So the
> provisioning step must write the **full footprint** — `dm_<id>` + `dlv_<id>` + the ACL row (what
> `provisionAgent` writes) — not the row alone. Both statements hold: the row is the last-missing
> gate for a spawned agent; the durables + row are all required for a mint+exec-omp agent.

## Approach

### The fork

- **(i) `cotal mint` commits the ACL directly.** mint connects to NATS (short-lived provisioner
  cred, which it can mint — it already holds the signer via `loadSpaceAuth`) and `commitAcl`s after
  writing creds. Fixes the exact recipe, but turns mint from an offline cred-gen primitive into
  requires-a-live-broker: a real nature change that breaks offline `cotal mint` scripting and adds a
  new failure mode (mint fails when the broker is down).
- **(ii) a provisioning step owns it** — `cotal up` (plus a re-runnable `cotal provision-acl`)
  commits ACL rows for every agent defined in the persona dir (`.cotal/agents/*.md`, enumerated by
  `listPersonas`, `implementations/cli/src/lib/personas.ts:29-46`). Keeps mint offline-pure;
  bring-up becomes one command that also makes every agent non-blind from boot, with no per-agent
  flag to remember. Trade-off — **the enumeration source is load-bearing and, as specified, defeats
  the target recipe (see OQ#2, from the design-critic pass):** both `cotal up` and the standalone
  `cotal provision-acl` enumerate the persona dir via `listPersonas` (agent-files only — it never
  scans `creds/`; `personas.ts:33` `readdirSync(dir).filter((f) => f.endsWith(".md"))`). But
  `cotal mint <name> --profile agent` — the recipe this design targets — writes **only a creds file**,
  no persona file (`mint.ts:82` merely *reads* `agentFilePath` if it exists; `mint.ts:88-92` writes
  `creds/<name>.creds` and nothing else). So a plain-minted agent has no persona file and is invisible
  to `listPersonas` → skipped by both paths → wake-blind: the exact bug this design fixes. This is not
  the edge case an earlier draft deferred; it is the primary path, and OQ#2 raises enumerating
  `creds/*.creds` as the fix.) Couples
  ACL provisioning to bring-up; and — the one wrinkle the fork glosses — a row
  is keyed by the agent's **id** (its nkey public key, `packages/core/src/identity.ts:12-17`), so
  provisioning an agent whose creds don't exist yet forces the step to mint them (see Task 2).
- **(iii) mint gets an opt-in `--commit-acl` flag** (offline by default; commits when passed and the
  broker is reachable). Backward-compatible, but a flag to remember on every mint — easy to forget,
  silently re-introducing this exact bug.

### Recommendation: (ii)

> **Status (2026-07-09) — fork escalated to core; record NOT frozen.** Matt's call: the
> ACL-provisioning gap is "more of a core issue with Cotal" than a CLI-layer patch, to be
> deliberated before diving deeper — filed as **SEA-1168**. (ii) below is the leading candidate and
> #4 implements it, but the Approach + Plan are not frozen until SEA-1168 decides CLI-layer vs a
> core fix. See Open Questions.

**(ii)**, provisioning folded into bring-up. The mesh is about to be rebuilt onto the canonical
`wave` space where the recipe is `cotal up --channels …` + per-agent `cotal mint --profile agent`;
(ii) is the only option where that recipe yields non-blind agents with zero extra per-agent steps,
and it preserves mint's offline purity ((i) destroys it) without (iii)'s forget-the-flag failure
mode. The manager path needs nothing: manager-spawned agents already get rows
(`implementations/manager/src/manager.ts:722-723` calls `provisionAgent` without
`durableMembership: false`).

Shape: one idempotent TS routine, invoked automatically at the tail of `cotal up` (after
`postStart` — the bucket is pre-created there, `packages/core/src/streams.ts:300:
await kvm.create(aclBucket(opts.space))`; hook point `implementations/cli/src/commands/up.ts:171-175`)
and exposed as `cotal provision-acl` for re-runs after later mints. Failure posture mirrors the
delivery daemon at up (`up.ts:284-285` "non-fatal — durable delivery degrades"): log loudly, don't
kill the broker; the standalone command fails loud (exit 1). This soft-fail-at-`up` is the one
deliberate exception to the "No fallbacks" constraint below, and is spelled out there as such.

### The spawn completeness half (applies whichever option is chosen)

spawn's `durableMembership: false` is documented as deliberate (`spawn.ts:244-248`):

> Direct foreground spawn is LIVE-ONLY: this short-lived provisioner is not a managing Plane-3 host,
> and no long-lived manager knows this agent (it's in no manager's `agents` ledger), so a durable
> boot membership could be neither authorized for reader delivery nor leaved via self-service.

That rationale is outdated. The durable reader is now the standalone delivery daemon, which
re-authorizes from the ACL KV registry, not any manager ledger —
`packages/core/src/provision.ts:231-233`:

> Record the agent's read ACL (`allowSubscribe`) in the durable ACL registry — the same act as
> baking it into the JWT, persisted so the **server-side delivery daemon** can re-authorize the
> agent's durable entries and validate its runtime durable-joins (it holds no in-memory ledger).

Self-service leave also rides `ctl.delivery.<id>` to the daemon, not the manager — the agent cred
grant at `provision.ts:424-427`:

```ts
// ctl.delivery.<id> — request a durable backstop join/leave/list from the SERVER-SIDE delivery
// daemon (NOT the manager). ...
controlServiceSubject(space, CONTROL_DELIVERY, id),
```

So the "no manager" objection no longer holds — **when a delivery daemon is live**. The remaining
truth in the old comment: spawn can target a daemon-less mesh, where live-only stays correct. Fix:
replace the unconditional `false` with **provision-when-daemon-live** — read the daemon's
single-flight lease (`CotalEndpoint.readDeliveryLease(0)`, `endpoint.ts:1363-1367`; a present lease
record means a daemon is live or binding, and the boot self-join's reconcile loop already tolerates
responder-timing) and pass `durableMembership: lease !== undefined`. Rewrite the stale comment, and
refresh the `provision.ts:214-218` / `:244-245` docstrings that still name "direct `cotal spawn`" as
the canonical live-only example. Not auto-provisioned: `cotal join`'s console
(`implementations/cli/src/commands/join.ts:119-127`) stays intentionally live-only — a bare console
is genuinely ephemeral, and absent-row = live-only is exactly the registry's semantic for it.

Why conditional rather than always-write: absent-row-means-live-only is load-bearing registry
semantics (`ProvisionOpts.durableMembership`, `provision.ts:212-219`), and unconditional writes on
daemon-less meshes would accrete rows nothing authorizes or GCs.

## Plan

### Global Constraints

- **Privileged ACL writes only.** Rows are written under a provisioner/manager cred — agents never
  self-authorize their own read ACL (`acls.ts:9-10`: "Writes are **privileged** … agent-authored
  ACLs are forbidden (they would self-authorize reads)"). The provisioner profile already carries
  exactly the needed grants (`provision.ts:893` `$KV.<aclBucket>.>` + `:899-900` read verbs).
- **ACL value == minted `allowSubscribe`.** The row must equal the read set baked into the creds'
  `sub.allow` (rendered at `provision.ts:523` via `chatSubject(space, "*", ch)`), or durable read
  scope diverges from live read scope. Enforced structurally: one shared derivation helper feeds
  both mint and provisioning (Task 1), and pre-existing creds are cross-checked against their JWT
  (Task 2). **Design-critic refinement (clear improvement):** the shared helper guarantees equality
  only on the creds-**absent** path; on the creds-**exists** path the parity check compares a
  rendered-subject set (`chatSubject`) against the JWT while the durable gate matches channel **names**
  (`channelInAllow` over `subjectMatches`, `endpoint.ts:1646` / `subjects.ts:146-148`) — two different
  matchers, so wildcard entries (`team.>`, `*`) are the seam where they can diverge. `assertValidChannel`
  (`subjects.ts:103-120`) already forecloses the token-aliasing case, so this is defense-in-depth, not
  an open hole; still, prefer deriving the committed ACL value **from the decoded JWT `sub.allow`**
  (invert `chatSubject` → names) so the row is byte-derived from the same artifact that governs live
  reads (parity by identity, not a cross-matcher set-compare), and add a wildcard-channel round-trip
  case to Task 2's smoke.
- **Write via core `commitAcl` only** (`acls.ts:59`, atomic CAS, idempotent, `[]`-vs-absent
  preserved). No hand-rolled KV puts.
- **No new committed bash — TS only** (repo convention; tooling runs via `tsx`, Node >= 20, ESM).
- **Tests are red→green against a live `nats-server`,** using the proven harness pattern of
  `packages/core/smoke/delivery-boot-retry.smoke.ts` (spin a real server from `serverConfig`, wait
  `isReachable`, `setupSpaceStreams`, provision, assert durable membership;
  script registered in root `package.json` like `:93` `smoke:delivery-boot-retry:auth`). Write the
  failing assertion first, watch it fail, then implement.
- **No fallbacks — fail loud** on unsupported states (AGENTS.md); docs updated in the same change
  as behavior (AGENTS.md). *One deliberate, scoped exception:* the `cotal up` auto-provision hook is
  non-fatal (see Recommendation) — `up` orchestrates many agents and one provisioning shortfall must
  not abort the whole bring-up, and the step is re-runnable. The **standalone** `cotal provision-acl`
  stays hard-fail (exit 1) — a targeted command SHOULD fail loud. **Design-critic refinement (clear
  improvement):** the daemon-soft-fail analogy is not exact — a daemon failure self-heals via
  `reconcileBootJoin` when it recovers, but an ACL-provisioning shortfall does **not** self-heal (no
  privileged writer ever fills the missing row, so `durableJoin` stays refused,
  `endpoint.ts:1643-1645`), and a bare "log loudly" line in a long `up` transcript reproduces exactly
  the invisibility of the motivating incident (0 rows unnoticed). So the hook must make residual
  blindness **observable and actionable**, not merely logged: record the unprovisioned ids and surface
  them on the existing delivery-health surface / `cotal status`, and/or have `up` exit non-zero if any
  agent was left unprovisioned (it still comes up). Bare logging is not sufficient.
- **Design-critic pass (SEA-1188).** This record went through one adversarial read-only critic pass
  (2026-07-11). Two clear improvements are folded above (F4 — observable residual-blindness at the
  `up` hook; F5 — derive the committed ACL from the decoded JWT + a wildcard round-trip test), and the
  Task 3 lease-read grant is corrected (STREAM.INFO on the delivery bucket is already granted; only
  MSG.GET was missing). Three code-grounded forks were surfaced as load-bearing Open Questions #2
  (enumerate `creds/*.creds`, not persona files — the current source defeats the target recipe), #3
  (reopens D1), and #4 (reopens D2). The record was already freeze-blocked on SEA-1168 (OQ#1); these
  compound that block and must be resolved with it before freeze.

### Task 1 — shared read-policy derivation helper

Extract the agent read/post-policy derivation duplicated between `mint.ts:84-86`
(`flags ?? def?.allowSubscribe ?? def?.subscribe`) and the mint chokepoint default
(`provision.ts:409` `opts.allowSubscribe?.length ? opts.allowSubscribe : ["general"]`) into one CLI
helper, and adopt it in `mint.ts`. This is what makes mint-time and provision-time ACL values equal
by construction instead of by parallel maintenance.

- **Interfaces:** consumes `AgentDef` (`loadAgentFile(path): AgentDef`) and optional flag overrides;
  produces `agentReadPolicy(def: AgentDef | undefined, flags?: { allowSubscribe?: string[]; allowPublish?: string[] }): { allowSubscribe: string[]; allowPublish?: string[]; role?: string }`
  with the `["general"]` default applied; feeds
  `mintCreds(auth: SpaceAuth, identity: Identity, profile: Profile, opts?: MintOpts): Promise<string>`
  (`provision.ts:284`).
- **Test cycle:** `pnpm typecheck`; behavior pinned by Task 2's parity assertions (a pure
  refactor — mint output byte-comparable before/after for the same inputs).

### Task 2 — `provisionAcls` routine + `cotal provision-acl` + `cotal up` hook

New `implementations/cli/src/lib/acl-provision.ts` routine, one privileged short-lived endpoint
(same shape as spawn's provisioner, `spawn.ts:231-241`):

For every `listPersonas(root)` entry (skip `error` entries loudly):

1. **Creds exist** (`authDir(root)/creds/<name>.creds`, the path mint writes at `mint.ts:90`):
   `id = idFromCreds(creds)` (`identity.ts:33-44`); recompute `allowSubscribe` via Task 1's helper;
   **parity check** — render `allowSubscribe.map(ch => chatSubject(space, "*", ch))` and compare as
   a set against the decoded JWT's chat `sub.allow` entries (same base64url payload decode
   `idFromCreds` already uses); mismatch ⇒ loud error naming the re-mint fix (no fallbacks).
2. **Creds absent**: mint them exactly as `cotal mint <name> --profile agent` would (`newIdentity()`
   + file-derived policy + `writeSecretFile`) — forced by the id-keyed registry: a row cannot exist
   before an identity does. This is what makes fresh-mesh bring-up one command.
3. Provision the **full durable-delivery footprint** for `id` — what `provisionAgent` writes when
   durable membership is enabled (`durableMembership: true`), **not** the live-only
   `durableMembership: false` path a bare `cotal spawn` takes, which skips the ACL row entirely
   (`provision.ts:272`; the scope caveat above): the bind-only `dm_<id>` + `dlv_<id>` mailboxes the
   agent cannot self-create (denied `CONSUMER.CREATE` on DM/DLV — only a provisioner may create them),
   then the ACL row. `ep.provisionDmInbox(id)`; `ep.provisionDlvInbox(id)`; `ep.commitAcl(id,
   allowSubscribe)` (`CotalEndpoint.commitAcl(targetId: string, allowSubscribe: string[]): Promise<void>`,
   `endpoint.ts:1309-1311`, which rides core `commitAcl`'s CAS). All three are idempotent
   (durable create-if-absent + CAS put), so the routine is re-runnable. Committing the row alone
   (as an earlier draft of this step did) leaves a mint+exec-omp agent with an authorized owner but
   no per-member durable, so `pumpDlv` silently no-ops and @mention-wake still never lands.

Surfaces: `cotal provision-acl` command (fail-loud, re-runnable, idempotent — `acls.ts:55-56`
"Idempotent in effect"); auto-invoked at the tail of `cotal up` after `postStart(...)`
(`up.ts:171-175`), best-effort with a loud log (matching `startDeliveryWithBroker`'s posture).
`up -f` needs no hook (manifest agents are manager-provisioned).

- **Interfaces:** consumes `listPersonas(root = cotalRoot()): PersonaEntry[]` (`personas.ts:29`),
  `idFromCreds(creds: string): string`, `agentReadPolicy(...)` (Task 1),
  `mintCreds(auth, newIdentity(), "provisioner")` for the privileged cred,
  `new CotalEndpoint({ space, servers, creds, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card })`;
  produces, per agent, `provisionDmInbox(id)` + `provisionDlvInbox(id)` (bind-only DM/DLV durables) +
  `commitAcl(id, allowSubscribe)` writes readable via
  `readAcl(kv: KV, owner: string): Promise<{ record: AclRecord; revision: number } | undefined>`
  (`acls.ts:37`) /
  `openAclRegistry(nc: NatsConnection, space: string, opts?: { create?: boolean }): Promise<KV>`
  (`acls.ts:21`).
- **Test cycle (red first):** new `implementations/cli/smoke/provision-acl.smoke.ts` on the
  delivery-boot-retry harness pattern: spin `nats-server` + `setupSpaceStreams`; lay down persona
  files + pre-minted creds for one agent, none for another; **red** — assert both that
  `readAcl(kv, id)` returns each agent's file-equal `allowSubscribe` AND that the per-member
  durables `dm_<id>` + `dlv_<id>` exist (consumer info on the DM/DLV streams resolves, not
  `consumer not found`) — the row-alone assertion would pass a footprint-incomplete impl that
  still leaves `pumpDlv` no-op'ing, so the durable checks are what actually guard the bug (all
  fail today: no writer exists); **green** after implementing; re-run routine ⇒ idempotent (row
  CAS + durable create-if-absent both no-op cleanly); tampered creds (policy drift) ⇒ loud error.
  Register as `smoke:provision-acl:auth` in root `package.json`.

### Task 3 — spawn: provision-when-daemon-live

In `spawn.ts`, replace `durableMembership: false` (`:255`) with a daemon-liveness probe on the
already-started provisioner endpoint, and rewrite the stale `:244-248` comment to the daemon-era
rationale (registry re-auth + `ctl.delivery` self-service; conditional purely on daemon presence).
Refresh the two `provision.ts` docstrings (`:214-218`, `:244-245`) naming spawn as the canonical
live-only example. Grant the provisioner profile read on the delivery lease bucket —
`provisionerPermissions` (`provision.ts:860-909`) already grants `$JS.API.STREAM.INFO.KV_<deliveryBucket>`
for every backing stream via `streamSetup` (`:867`, `:871-874`), and the ACL/channel read verbs at
`:899-902` do **not** cover the delivery bucket — so add only the one genuinely-missing grant,
`$JS.API.STREAM.MSG.GET.KV_<deliveryBucket>` (read-only; mirrors the agent's own Component-6 lease
read, no escalation). (Do not re-add STREAM.INFO — it is already present; adding it is harmless
over-spec.)

- **Interfaces:** consumes
  `readDeliveryLease(shardIndex: number): Promise<DeliveryLeaseInfo | undefined>`
  (`endpoint.ts:1363-1367`; `DeliveryLeaseInfo { holder: string; since: number; ready: boolean }`,
  `lease.ts:23-27`); produces the
  `provisionAgent(provisioner: DurableProvisioner, auth: SpaceAuth, identity: Identity, opts: ProvisionOpts): Promise<string>`
  call (`provision.ts:246`) with `durableMembership: lease !== undefined`. `join.ts` untouched.
- **Test cycle (red first):** extract spawn's auth-provisioning block into a testable CLI-lib
  helper; new smoke on the same harness: with a live daemon (lease present — daemon endpoint via
  `mintCreds(auth, newIdentity(), "delivery")` + `startPlane3`, as
  `delivery-boot-retry.smoke.ts:56-58`) ⇒ **red** assert the row exists post-provision and
  `durableJoin` succeeds (fails today: unconditional `false`); with no daemon ⇒ no row, live-only
  (matches today, guards the conditional). Register as `smoke:spawn-durable:auth`.

### Task 4 — end-to-end proof + docs

E2E assert of the actual incident shape, and the same-change doc updates AGENTS.md requires.
Smoke: fresh space → provision-acl routine → agent connects with `channels: ["<durable-ch>"]` →
`hasDurableMembership` flips true without any manager (mirrors `delivery-boot-retry.smoke.ts:53-66`
asserts). Docs: `docs/architecture.md` mint/out-of-band section (`:681-683` currently describes
mint as creds-only) + `docs/getting-started.md` bring-up recipe gain the provisioning step and the
non-blind-from-boot guarantee.

- **Interfaces:** consumes `CotalEndpoint.hasDurableMembership(channel: string): boolean`
  (`endpoint.ts:1963-1965`), `waitForDeliveryLease(opts: { servers: string; space: string; creds: string; id: string; timeoutMs?: number }): Promise<boolean>`
  (`lease.ts:55-61`) for daemon readiness in the harness; produces the e2e assertion inside
  `smoke:provision-acl:auth` (extend Task 2's smoke rather than a fourth script if it stays
  readable).

## Tasks

- [ ] **T1** — extract `agentReadPolicy` shared derivation; adopt in `mint.ts`; `pnpm typecheck`
      green, mint output unchanged for identical inputs.
- [ ] **T2** — `provisionAcls` routine + `cotal provision-acl` command + `cotal up` post-start
      hook; red→green `smoke:provision-acl:auth` (rows present + file-equal, idempotent re-run,
      loud parity failure).
- [ ] **T3** — spawn `durableMembership: lease !== undefined` + provisioner lease-read grants +
      comment/docstring rewrites; red→green `smoke:spawn-durable:auth` (row + join with daemon; no
      row without).
- [ ] **T4** — e2e non-blind-from-boot assertion; `docs/architecture.md` +
      `docs/getting-started.md` updated in the same change.

## Decisions

Ratified by Matt 2026-07-09 (asked directly, recommendations pre-selected). D1/D2 fix how the
CLI-provisioning approach behaves; if SEA-1168 (see Open Questions) redirects the fix into core,
revisit them under that record.

> **Design-critic pass (SEA-1188, 2026-07-11) reopened D1 and D2 on new code evidence.** The
> ratification text below is left exactly as Matt ratified it; the critic's challenges are surfaced
> as load-bearing Open Questions #3 (D1 — lease-conditional strands spawn agents wake-blind on a
> daemon-restart race) and #4 (D2 — `up`-minting orphans the id-keyed footprint on every normal
> bring-up). Both await Matt's ruling; neither Decision is altered here.

- **D1 — spawn provisions when a daemon is live (was OQ3).** `cotal spawn` replaces the
  unconditional `durableMembership: false` with auto-detect via the delivery lease
  (`durableMembership = readDeliveryLease(0) !== undefined`); no new flag. An explicit `--live-only`
  escape hatch may be added later without changing this default. Designed at Task 3 and "The spawn
  completeness half".
- **D2 — `cotal up` mints creds when absent (was OQ4).** The provisioning step writes
  `creds/<name>.creds` for persona-dir agents that lack them, then provisions the full footprint —
  ACL rows are id-keyed, so a row cannot exist before an identity does. Fresh-mesh bring-up becomes
  one command; per-agent `cotal mint` becomes optional. Designed at Task 2 step 2.

Deferred, non-load-bearing (the merge ratifies the deferral):

- **D3 — both surfaces, not either/or (was OQ2).** The record designs one shared routine exposed
  BOTH as the `cotal up` tail hook AND the standalone re-runnable `cotal provision-acl` — a superset
  that satisfies either preference, so an executor hits no ambiguity.
- **D4 — re-mint ACL-row orphans, out of scope (was OQ5).** `cotal mint` always mints a fresh
  identity, so re-minting a name orphans the old id's row; absent-owner rows are DEFER-inert (never
  mis-deliver) but accrete. A `deleteAcl`-on-re-mint / GC follow-up is noted, not designed here.

## Open Questions

**FREEZE BLOCKER — this record MUST NOT merge-freeze while this is open** (standing design policy:
no merge with an unresolved load-bearing open question).

1. **The fork is escalated to core, not picked.** Matt's call (2026-07-09): the ACL-provisioning
   gap is "more of a core issue with Cotal" than a CLI-layer patch — "raise an issue first before
   we dive too deep … not something we can just fix immediately." Filed as **SEA-1168**
   (durable-delivery ACL provisioning gap: CLI-provisioning layer vs the core
   mint(offline)/provision(online) split). The Approach + Plan above stand as the leading (ii)
   CLI-layer candidate — and #4 implements it — but are NOT frozen until SEA-1168 decides whether
   the fix lives in the CLI provisioning layer (this record) or in core (e.g. the delivery daemon
   self-provisions the row on first authorized contact, or the mint/JWT flow carries durable
   membership directly). Fold SEA-1168's outcome here as a Decision, then freeze.
2. **[LOAD-BEARING — from design-critic pass] Enumerate `creds/*.creds`, not persona files?**
   The Approach keys provisioning on `listPersonas` (`.cotal/agents/*.md`), but the target recipe
   `cotal mint <name> --profile agent` writes only a creds file (`mint.ts:88-92`), no persona file —
   so every plain-minted agent is invisible to both provisioning paths and stays wake-blind (the exact
   bug this design fixes; verified: `personas.ts:33` filters `.md` only, `mint.ts:82` merely reads the
   persona if present). The record's earlier deferral of this as an "edge case" is false against the
   code; it is the primary path. **Fix (recommend):** enumerate `creds/*.creds` instead of (or in
   union with) personas — `idFromCreds(creds)` (`identity.ts:33-44`) already yields the id, and the
   read set is recoverable by decoding the JWT `sub.allow` (the same decode Task 2's parity path does),
   so no persona file is needed to provision. This covers every minted agent by construction and matches
   the id-keyed registry's natural key space. Materially changes Task 2's enumeration; needs Matt's call.
3. **[LOAD-BEARING — from design-critic pass — REOPENS ratified D1] Conditional-on-lease vs
   always-write the ACL row on spawn.** D1 ratified `durableMembership = readDeliveryLease(0) !==
   undefined`. The critic surfaces, on code evidence, that this conditions a **persistent** privileged
   row on a **transient** liveness signal: spawn's provisioner is short-lived (`await prov.stop()`
   immediately after `provisionAgent`, `spawn.ts:257`), so a spawn whose probe races a daemon restart
   (lease TTL-expired in the gap) reads `undefined`, writes no row, and exits — and nothing ever
   backfills it (the agent can't self-authorize, `acls.ts:9-10`; `reconcileBootJoin` retries
   durableJoin forever but the write never comes), leaving the agent **permanently** wake-blind. The
   stated reason for rejecting always-write (avoid accreting rows on daemon-less meshes) is in tension
   with D4, which already accepts absent-owner rows accreting DEFER-inert with GC deferred.
   **Alternatives:** (a) always write the row on spawn (it is DEFER-inert and harmless on a daemon-less
   mesh, `acls.ts:11-13`; the accretion cost is already accepted by D4); (b) if a live-only mode is
   wanted, gate it on the explicit `--live-only` flag D1 already contemplates, not an inferred transient
   read. This reopens a ratified Decision on new evidence — surfaced for Matt, D1 left as-ratified until he rules.
4. **[LOAD-BEARING — from design-critic pass — REOPENS ratified D2] `cotal up` minting creds
   orphans the footprint on every normal bring-up.** D2 ratified that `up` mints `creds/<name>.creds`
   for persona-dir agents lacking them. The critic surfaces: every `cotal mint` makes a **fresh**
   identity (`mint.ts:88` `newIdentity()`), and the footprint is id-keyed. So on the record's own
   recipe (`cotal up` + per-agent `cotal mint`, Approach lines 105-107), if personas exist at up-time,
   `up` mints id A and provisions A's full footprint; the operator's subsequent `cotal mint <name>`
   then mints a **different** id B, overwriting `creds/<name>.creds` and orphaning A's dm_/dlv_/ACL —
   promoting D4's "edge case" orphan to the common path on every bring-up, and `up` gains a
   secret-writing side effect. **Alternatives:** (a) decouple identity-minting from bring-up — `up`
   and `provision-acl` provision only creds that already exist (creds-absent → loud "run cotal mint
   first"), keeping `cotal mint` the sole identity author; (b) if one-command fresh bring-up is a hard
   requirement, make it idempotent-by-name (record the name→id binding so a later `cotal mint <same>`
   is a no-op or a deliberate rotation). This reopens a ratified Decision on new evidence — surfaced for Matt, D2 left as-ratified until he rules.
