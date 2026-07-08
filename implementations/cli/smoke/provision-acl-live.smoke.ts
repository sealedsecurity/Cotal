/**
 * Durable read-ACL provisioning — live-broker smoke for `planAclProvision` / `provisionAcls`
 * (the routine behind `cotal provision-acl`) and the `cotal spawn` daemon-gate, verified against a
 * REAL nats-server (JWT auth + JetStream) on an isolated port. Closes the gap where `cotal mint`
 * writes creds but no durable read-ACL row, so an agent is @mention-wake-blind until provisioned.
 *
 * Behaviors defended (each fails if the write / skip / gate breaks — see the red-green notes in the PR):
 *   1. row written + reads back — a persona with an agent file + minted creds gets an ACL row whose
 *      value an independent provisioner endpoint reads back as its `allowSubscribe`.
 *   2. PARITY (defended hardest) — the provisioned row equals the creds' BAKED chat read scope
 *      (`sub.allow` chat subjects), decoded from the JWT — durable read scope never diverges from live.
 *   3. drift is SKIPPED, never rewritten — creds baked [general] but the file declares [general, ops]:
 *      `planAclProvision` flags `drift`, `provisionAcls` skips it, and a pre-existing row is untouched.
 *   4. credless persona is SKIPPED — an agent file with no creds → `result.skipped` ("no creds"),
 *      never provisioned (this command never mints; that is `cotal mint`'s job).
 *   5. default [general] — a file with neither `allowSubscribe` nor `subscribe` → row is [general].
 *   6. idempotent — running `provisionAcls` twice leaves the row + count stable, no throw.
 *   7/8. spawn daemon-gate (defended at the routine boundary, NOT a full connector-fork spawn — see the
 *      note printed at the end): the exact decision `cotal spawn` makes —
 *      `daemonLive = (await prov.readDeliveryLease(0)) !== undefined` → `provisionAgent({durableMembership})`
 *      — driven by a REAL delivery lease. Lease present ⇒ ACL row for the spawned id; absent ⇒ no row.
 *
 * Needs the bundled `nats-server` — resolved via the CLI's own `resolveNatsServer()` (PATH first, then
 * the bundled platform package), so it runs without an operator-installed server. Kills ONLY the PID it
 * spawns (never pkill). Run: pnpm smoke:provision-acl:live
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpaceAuth,
  serverConfig,
  setupSpaceStreams,
  isReachable,
  mintCreds,
  idFromCreds,
  newIdentity,
  provisionAgent,
  chatSubject,
  dlvStream,
  dlvDurable,
  dmStream,
  dmDurable,
  CotalEndpoint,
} from "@cotal-ai/core";
import { authDir } from "@cotal-ai/workspace";
import { planAclProvision, provisionAcls, type AclProvisionResult } from "../src/lib/acl-provision.js";
import { personasDir } from "../src/lib/personas.js";
import { resolveNatsServer } from "../src/lib/nats-bin.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `provacl-${randomUUID().slice(0, 8)}`;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
function awaitExit(proc: ChildProcess, timeoutMs = 3000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

/** The chat `sub.allow` entries a creds JWT was minted with — replicated from `acl-provision.ts`
 *  `credChatSubAllow` (not exported), so #2 can prove the row matches the creds' broker-enforced scope. */
function credChatSubAllow(creds: string): string[] {
  const m = creds.match(/BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*------END NATS USER JWT/);
  const payload = m?.[1].trim().split(".")[1];
  if (!payload) return [];
  const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    nats?: { sub?: { allow?: string[] } };
  };
  const prefix = chatSubject(space, "*", "").slice(0, -1); // cotal.<space>.chat.*. (channel stripped)
  return (claim.nats?.sub?.allow ?? []).filter((s) => s.startsWith(prefix)).sort();
}

const auth = await createSpaceAuth(space);
const roots: string[] = [];
/** A fresh, isolated persona catalog + creds dir (its own `<root>/.cotal/{agents,auth/creds}`). Each
 *  behavior gets its own root so `planAclProvision` (which walks the WHOLE catalog) sees only its
 *  personas; all share the one space/broker (rows are id-keyed, so no cross-behavior collision). */
function freshRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cotal-provacl-${label}-`));
  mkdirSync(personasDir(root), { recursive: true });
  mkdirSync(join(authDir(root), "creds"), { recursive: true });
  roots.push(root);
  return root;
}
function writeAgent(root: string, name: string, fm: string): void {
  writeFileSync(join(personasDir(root), `${name}.md`), `---\nname: ${name}\n${fm}\n---\nYou are ${name}.\n`);
}
/** Mint agent creds from the SAME derivation `cotal mint` uses and drop them at the root's creds path,
 *  returning the stable id + the creds string (needed to decode the baked read scope for parity). */
async function mintPersona(root: string, name: string, allowSubscribe?: string[]): Promise<{ id: string; creds: string }> {
  const identity = newIdentity();
  const creds = await mintCreds(auth, identity, "agent", { allowSubscribe });
  writeFileSync(join(authDir(root), "creds", `${name}.creds`), creds);
  return { id: identity.id, creds };
}

let reader: CotalEndpoint | undefined;
let deliveryEp: CotalEndpoint | undefined;
let dir: string | undefined;
let srv: ChildProcess | undefined;
try {
  // Server setup lives INSIDE the try so a throw here (e.g. resolveNatsServer can't find the binary)
  // still hits the finally — no leaked temp dir, no dangling child.
  dir = mkdtempSync(join(tmpdir(), "cotal-provacl-srv-"));
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
  const { bin: natsBin } = await resolveNatsServer();
  srv = spawn(natsBin, ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  srv.on("error", (e) => console.error("  ! nats-server spawn error:", e.message)); // never let an async spawn error go unhandled (would crash the process before cleanup)
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      up = true;
      break;
    }
    await sleep(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // Independent provisioner endpoint — reads rows back (the daemon's-eye view, separate from the
  // routine's own short-lived endpoint), pre-seeds the drift row, and drives the spawn-gate decision.
  reader = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: await mintCreds(auth, newIdentity(), "provisioner"),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { name: "reader", role: "provisioner", kind: "endpoint" },
  });
  reader.on("error", () => {});
  await reader.start();

  const run = (root: string) => provisionAcls({ root, space, server: SERVERS, auth });

  // ── 1. row written + reads back ─────────────────────────────────────────────────────────────
  const rAlpha = freshRoot("alpha");
  writeAgent(rAlpha, "alpha", "allowSubscribe: [general, ops]");
  const alpha = await mintPersona(rAlpha, "alpha", ["general", "ops"]);
  const r1 = await run(rAlpha);
  check("[#1 row-written] alpha appears in result.provisioned", r1.provisioned.some((p) => p.name === "alpha"), r1);
  const alphaRow = await reader.aclForOwner(alpha.id);
  check("[#1 row-written] alpha's ACL row reads back as [general, ops]", eq(alphaRow, ["general", "ops"]), alphaRow);

  // ── 2. PARITY: provisioned row == creds' baked chat read scope ──────────────────────────────
  const rBravo = freshRoot("bravo");
  writeAgent(rBravo, "bravo", "allowSubscribe: [general, ops]");
  const bravo = await mintPersona(rBravo, "bravo", ["general", "ops"]);
  await run(rBravo);
  const bravoRow = (await reader.aclForOwner(bravo.id)) ?? [];
  check("[#2 parity] bravo row == [general, ops]", eq(bravoRow, ["general", "ops"]), bravoRow);
  const rowSubjects = bravoRow.map((ch) => chatSubject(space, "*", ch)).sort();
  const bakedSubjects = credChatSubAllow(bravo.creds);
  check(
    "[#2 parity] row channels render to the creds' BAKED chat sub.allow subjects",
    rowSubjects.length > 0 && eq(rowSubjects, bakedSubjects),
    { rowSubjects, bakedSubjects },
  );

  // ── 3. drift is SKIPPED, never rewritten ────────────────────────────────────────────────────
  // creds baked [general] but the file declares [general, ops] → mismatch. Pre-seed the correct row.
  const rCharlie = freshRoot("charlie");
  writeAgent(rCharlie, "charlie", "allowSubscribe: [general, ops]");
  const charlie = await mintPersona(rCharlie, "charlie", ["general"]);
  await reader.commitAcl(charlie.id, ["general"]); // the existing, correct-for-creds row
  const plan = planAclProvision(rCharlie, space);
  const charlieEntry = plan.find((e) => e.name === "charlie");
  check("[#3 drift] planAclProvision flags charlie's drift", Boolean(charlieEntry?.drift), charlieEntry);
  const r3 = await run(rCharlie);
  check(
    "[#3 drift] charlie is in result.skipped, NOT result.provisioned",
    r3.skipped.some((s) => s.name === "charlie") && !r3.provisioned.some((p) => p.name === "charlie"),
    r3,
  );
  const charlieRow = await reader.aclForOwner(charlie.id);
  check("[#3 drift] the existing charlie row is NOT overwritten (still [general])", eq(charlieRow, ["general"]), charlieRow);

  // ── 4. credless persona is SKIPPED (this command never mints) ───────────────────────────────
  const rFox = freshRoot("foxtrot");
  writeAgent(rFox, "foxtrot", "allowSubscribe: [general]"); // no creds file written
  const r4 = await run(rFox);
  const foxSkip = r4.skipped.find((s) => s.name === "foxtrot");
  check(
    "[#4 credless] foxtrot skipped with a 'no creds' reason, never provisioned",
    /no creds/i.test(foxSkip?.reason ?? "") && !r4.provisioned.some((p) => p.name === "foxtrot"),
    r4,
  );

  // ── 5. default [general] when neither read field is declared ────────────────────────────────
  const rDelta = freshRoot("delta");
  writeAgent(rDelta, "delta", "role: worker"); // no subscribe / no allowSubscribe
  const delta = await mintPersona(rDelta, "delta"); // minted with the same default → no drift
  await run(rDelta);
  const deltaRow = await reader.aclForOwner(delta.id);
  check("[#5 default] delta with no read fields → row is [general]", eq(deltaRow, ["general"]), deltaRow);

  // ── 6. idempotent: two runs leave row + count stable, no throw ───────────────────────────────
  const rEcho = freshRoot("echo");
  writeAgent(rEcho, "echo", "allowSubscribe: [general, ops]");
  const echo = await mintPersona(rEcho, "echo", ["general", "ops"]);
  const e1 = await run(rEcho);
  const e2 = await run(rEcho); // rewrites the same value (core commitAcl is an atomic CAS put)
  const echoRow = await reader.aclForOwner(echo.id);
  check(
    "[#6 idempotent] second run: rowCount + provisioned stable, row unchanged",
    e2.rowCount === e1.rowCount && e2.provisioned.length === 1 && eq(echoRow, ["general", "ops"]),
    { e1: e1.rowCount, e2: e2.rowCount, echoRow },
  );

  // ── 7/8. spawn daemon-gate — the exact `cotal spawn` decision, at the routine boundary ───────
  // Boundary defense (NOT a connector-fork spawn): replicate spawn.ts's
  //   `daemonLive = (await prov.readDeliveryLease(0)) !== undefined` → provisionAgent({durableMembership})
  // driven by a REAL lease, and assert the OBSERVABLE consequence (row present vs absent). This also
  // exercises the provisioner's new `STREAM.MSG.GET.KV_<delivery>` read grant (the read would 403 without it).

  // #8 first — before any lease exists: absent lease ⇒ live-only ⇒ NO row.
  const noDaemonId = newIdentity();
  const daemonLiveBefore = (await reader.readDeliveryLease(0)) !== undefined;
  await provisionAgent(reader, auth, noDaemonId, { allowSubscribe: ["general"], durableMembership: daemonLiveBefore });
  const noDaemonRow = await reader.aclForOwner(noDaemonId.id);
  check(
    "[#8 gate] no delivery lease ⇒ daemonLive false ⇒ NO ACL row for the spawned id",
    daemonLiveBefore === false && noDaemonRow === undefined,
    { daemonLiveBefore, noDaemonRow },
  );

  // Bring a real delivery daemon's lease up (CAS create under the scoped `delivery` cred).
  deliveryEp = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: await mintCreds(auth, newIdentity(), "delivery"),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    card: { name: "delivery", role: "delivery", kind: "endpoint" },
  });
  deliveryEp.on("error", () => {});
  await deliveryEp.start();
  await deliveryEp.acquireDeliveryLease(0);

  // #7 — lease present ⇒ durable membership ⇒ ACL row for the spawned id.
  const daemonId = newIdentity();
  const daemonLiveAfter = (await reader.readDeliveryLease(0)) !== undefined;
  await provisionAgent(reader, auth, daemonId, { allowSubscribe: ["general", "ops"], durableMembership: daemonLiveAfter });
  const daemonRow = await reader.aclForOwner(daemonId.id);
  check(
    "[#7 gate] delivery lease present ⇒ daemonLive true ⇒ ACL row for the spawned id",
    daemonLiveAfter === true && eq(daemonRow, ["general", "ops"]),
    { daemonLiveAfter, daemonRow },
  );

  // ── 9. bad creds isolated, siblings still provision ─────────────────────────────────────────
  // A malformed on-disk creds file must NOT abort the whole catalog pass (pre-fix it threw, leaving
  // every later persona @mention-wake-blind). planAclProvision isolates it as an error entry and the
  // loop continues, so a valid sibling is still provisioned. Corrupt baddie's creds AFTER mint so
  // idFromCreds throws when the routine reads them; goodie is the valid sibling that must survive.
  const rGolf = freshRoot("golf");
  writeAgent(rGolf, "goodie", "allowSubscribe: [general, ops]");
  const goodie = await mintPersona(rGolf, "goodie", ["general", "ops"]);
  writeAgent(rGolf, "baddie", "allowSubscribe: [general]");
  const baddie = await mintPersona(rGolf, "baddie", ["general"]);
  const baddieCreds = join(authDir(rGolf), "creds", "baddie.creds");
  writeFileSync(baddieCreds, "not-valid-creds-@@@"); // overwrite the real creds with garbage
  // PRECONDITION the fix guards: the on-disk creds now fail to parse (idFromCreds throws).
  let parseThrew = false;
  try {
    idFromCreds(readFileSync(baddieCreds, "utf8"));
  } catch {
    parseThrew = true;
  }
  check("[#9 bad-creds] PRECONDITION: the corrupt creds file fails to parse (idFromCreds throws)", parseThrew);

  let r9: AclProvisionResult | undefined;
  let r9Threw = false;
  try {
    r9 = await run(rGolf);
  } catch (e) {
    r9Threw = true;
    console.error("  ! #9 run threw:", (e as Error).message);
  }
  // The crux of the regression: one bad creds file no longer aborts the pass.
  check("[#9 bad-creds] the catalog pass COMPLETED — run() did not throw on the bad creds file", !r9Threw && r9 !== undefined);
  check(
    "[#9 bad-creds] valid sibling 'goodie' is still provisioned despite the bad-creds neighbor",
    r9?.provisioned.some((p) => p.name === "goodie") ?? false,
    r9,
  );
  const goodieRow = await reader.aclForOwner(goodie.id);
  check("[#9 bad-creds] goodie's ACL row reads back as [general, ops]", eq(goodieRow, ["general", "ops"]), goodieRow);
  const baddieSkip = r9?.skipped.find((s) => s.name === "baddie");
  check(
    "[#9 bad-creds] baddie is skipped with an 'unreadable creds' reason, never provisioned",
    /unreadable creds/i.test(baddieSkip?.reason ?? "") && !(r9?.provisioned.some((p) => p.name === "baddie") ?? false),
    r9,
  );
  const baddieRow = await reader.aclForOwner(baddie.id);
  check("[#9 bad-creds] no ACL row was committed for the corrupt persona", baddieRow === undefined, baddieRow);

  // ── 10. provision-acl creates the bind-only dm_<id> + dlv_<id> durables, not just the ACL row ──
  // @mention-wake delivery rides the daemon's fan-out → per-member `dlv_<id>` DELIVER durable, which the
  // agent BINDS (denied CONSUMER.CREATE on DLV) and `pumpDlv` SILENTLY no-ops when it's absent. A
  // `cotal mint` + `exec omp` agent has NEITHER the ACL row nor the durables, so the pre-fix ACL-row-only
  // path left its @mention-wake messages piling undrained in an absent `dlv_<id>`. This defends the fix
  // that pre-creates BOTH bind-only mailboxes (`provisionDmInbox` + `provisionDlvInbox`) before the row.
  // Existence is read through the reader's provisioner jsm — that cred holds CONSUMER.INFO on DM/DLV
  // (provision.ts:883), and `consumers.info` RESOLVES with the durable when present, THROWS (404) when
  // absent. `manager()` is TS-private on CotalEndpoint but callable at runtime; no public consumer-info
  // accessor exists and `@nats-io/*` is not a CLI dep (unimportable from this smoke), so this single
  // documented reach past the private surface is the only path to a jsm here.
  interface JsmConsumerInfo {
    manager(): Promise<{ consumers: { info(stream: string, durable: string): Promise<{ name: string }> } }>;
  }
  const readerJsmAccess = reader as unknown as JsmConsumerInfo; // see note above — reach the provisioner jsm
  const jsm = await readerJsmAccess.manager();
  const consumerName = async (stream: string, durable: string): Promise<string | undefined> => {
    try {
      return (await jsm.consumers.info(stream, durable)).name; // resolves iff the durable exists
    } catch {
      return undefined; // 404 — the durable was never created
    }
  };

  const rHotel = freshRoot("hotel");
  writeAgent(rHotel, "hotel", "allowSubscribe: [general, ops]");
  const hotel = await mintPersona(rHotel, "hotel", ["general", "ops"]);
  await run(rHotel);
  const dlvName = await consumerName(dlvStream(space), dlvDurable(hotel.id));
  check(
    "[#10 dlv-footprint] provision-acl pre-created the bind-only dlv_<id> DELIVER durable",
    dlvName === dlvDurable(hotel.id),
    { got: dlvName, want: dlvDurable(hotel.id) },
  );
  const dmName = await consumerName(dmStream(space), dmDurable(hotel.id));
  check(
    "[#10 dlv-footprint] provision-acl pre-created the bind-only dm_<id> DM durable",
    dmName === dmDurable(hotel.id),
    { got: dmName, want: dmDurable(hotel.id) },
  );
  // Idempotency: the two new provision calls re-create existing durables as a no-op — a second run must
  // NOT throw, and BOTH durables must still exist afterward (defends the new calls' "re-runnable" contract).
  let hotelRerunThrew = false;
  try {
    await run(rHotel);
  } catch (e) {
    hotelRerunThrew = true;
    console.error("  ! #10 second run threw:", e instanceof Error ? e.message : e);
  }
  const dlvAfter = await consumerName(dlvStream(space), dlvDurable(hotel.id));
  const dmAfter = await consumerName(dmStream(space), dmDurable(hotel.id));
  check(
    "[#10 idempotent] a second run does not throw and both durables still exist (re-create is a no-op)",
    !hotelRerunThrew && dlvAfter === dlvDurable(hotel.id) && dmAfter === dmDurable(hotel.id),
    { hotelRerunThrew, dlvAfter, dmAfter },
  );
  console.log(
    `\nNote: #7/#8 defend the spawn daemon-gate at the ROUTINE BOUNDARY (readDeliveryLease→durableMembership→row),` +
      ` driven by a real lease — not a full connector-fork \`cotal spawn\` (out of harness scope).`,
  );
  console.log(`\nPROVISION-ACL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try {
    await reader?.stop();
  } catch {
    /* ignore */
  }
  try {
    await deliveryEp?.stop();
  } catch {
    /* ignore */
  }
  if (srv) {
    srv.kill("SIGKILL");
    await awaitExit(srv);
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
process.exit(process.exitCode ?? (fail ? 1 : 0)); // force-exit: lingering endpoint reconnect timers keep the loop alive
