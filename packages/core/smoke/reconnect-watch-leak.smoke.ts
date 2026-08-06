/**
 * reconnect watch-leak smoke (SEA-1821). The presence + channel-registry KV watchers
 * (`startPresenceWatch`/`startChannelWatch`) each open a `kv.watch()`, which backs an ephemeral
 * ordered JetStream consumer. `connectAndBind` re-arms both on EVERY (re)connect; before the fix,
 * `clearConnectionScoped` did NOT tear down the prior iterators. `nc.drain()` closes the client
 * delivery sub but never sends `CONSUMER.DELETE` — the ordered consumer is independent server-side
 * JetStream state that survives client disconnect until its ~5-min `inactive_threshold`. So each
 * reconnect abandoned two consumers server-side; over hours that leaked hundreds per agent and
 * pegged the broker's CPU.
 *
 * Two phases, both asserting the live ordered-consumer count on `KV_cotal_presence_<space>` /
 * `KV_cotal_channels_<space>` does NOT grow with reconnects (open mode — unrestricted JS API for the
 * probe):
 *   1. MANUAL reconnect() — the old connection is still alive, so stopWatch's delete lands and the
 *      count holds flat immediately. Pre-fix this climbs ~1/stream/reconnect.
 *   2. SELF-HEAL (terminal nc.closed()) — kill+restart the server (store preserved) so nats.js
 *      exhausts its own reconnects and superviseConnection drives a full rebuild. The old nc is dead
 *      here, so stopWatch's delete no-ops; the fix's iter.stop() still halts the consumer so it ages
 *      out rather than piling up. Asserts BOUNDED growth (not the unbounded pre-fix leak).
 *
 * Run: pnpm smoke:reconnect-watch-leak   (needs `nats-server` on PATH; JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { CotalEndpoint, isReachable, presenceBucket, channelBucket } from "../src/index.js";

const PORT = 12000 + Math.floor(Math.random() * 8000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, t = 3000): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (proc.exitCode !== null || proc.signalCode !== null) resolve();
  else { proc.once("exit", () => resolve()); setTimeout(resolve, t); }
  return promise;
};
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `reconnectleak${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "cotal-watch-leak-"));
const storeDir = join(dir, "js");
// Open mode: a plain JetStream server, no auth — the endpoint lazily creates its KV streams, and the
// probe connection can list consumers freely (auth mode scopes the JS API away from every profile).
// A factory so phase 2 can kill + restart on the SAME store dir (JetStream state, incl. the leaked
// consumers, must survive the restart to be observable).
const startServer = () => spawn("nats-server", ["-js", "-p", String(PORT), "-sd", storeDir], { stdio: "ignore" });
let srv = startServer();

// A KV bucket X is backed by the JetStream stream `KV_X`.
const presenceStream = `KV_${presenceBucket(space)}`;
const channelStream = `KV_${channelBucket(space)}`;

let agent: CotalEndpoint | undefined;
let probeNc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) break; await wait(200); }

  // An ordinary agent that watches presence + channels (the leak-carrying path). Open mode: no creds.
  agent = new CotalEndpoint({ space, servers: SERVERS, channels: ["general"], consume: false, watchPresence: true, watchChannels: true, registerPresence: true, card: { name: "alice", kind: "agent" } });
  agent.on("error", () => {}); await agent.start();
  await wait(300);

  probeNc = await connect({ servers: SERVERS, name: "watch-leak-probe" });
  const jsm = await jetstreamManager(probeNc);
  const countConsumers = async (stream: string): Promise<number> => {
    let n = 0;
    for await (const _ci of jsm.consumers.list(stream)) n++;
    return n;
  };

  const presenceBefore = await countConsumers(presenceStream);
  const channelBefore = await countConsumers(channelStream);
  check("baseline: presence stream has >=1 watcher consumer", presenceBefore >= 1, { presenceBefore });
  check("baseline: channel stream has >=1 watcher consumer", channelBefore >= 1, { channelBefore });

  // Reconnect the agent several times; each reconnect re-arms both watchers. With the fix, the prior
  // iterators are stopped in clearConnectionScoped, so the live consumer count holds flat.
  const RECONNECTS = 5;
  for (let i = 0; i < RECONNECTS; i++) {
    await agent.reconnect();
    await wait(300);
  }
  // Give the server a moment to settle any just-stopped consumers.
  await wait(500);

  const presenceAfter = await countConsumers(presenceStream);
  const channelAfter = await countConsumers(channelStream);

  // Allow a small transient slack (a just-torn-down consumer can linger a beat), but NOT growth
  // proportional to the reconnect count. Pre-fix: +1 per stream per reconnect (=> +5). Post-fix: ~0.
  const slack = 1;
  check(
    `presence watcher consumers do NOT grow across ${RECONNECTS} reconnects (fix stops prior iterators)`,
    presenceAfter <= presenceBefore + slack,
    { presenceBefore, presenceAfter, reconnects: RECONNECTS },
  );
  check(
    `channel watcher consumers do NOT grow across ${RECONNECTS} reconnects (fix stops prior iterators)`,
    channelAfter <= channelBefore + slack,
    { channelBefore, channelAfter, reconnects: RECONNECTS },
  );

  // ---- Phase 2: SELF-HEAL path (terminal nc.closed → reestablishLoop → doRebuild) ----
  // Kill the server so nats.js exhausts its own reconnects and superviseConnection fires a full
  // rebuild; restart on the SAME store so JetStream state (incl. any leaked consumers) survives and
  // stays observable. Each cycle re-arms both watchers via connectAndBind and tears the prior ones
  // down via clearConnectionScoped. On this path the old nc is dead, so stopWatch's delete no-ops —
  // the fix's iter.stop() halts the ordered-consumer recreate loop so the orphan ages out instead of
  // piling up. Assert the count stays BOUNDED (does not grow ~1/stream/cycle as the pre-fix leak did).
  const CYCLES = 3;
  for (let i = 0; i < CYCLES; i++) {
    srv.kill("SIGKILL");
    await awaitExit(srv);
    // Down long enough that nats.js gives up its internal reconnects and closed() resolves, driving
    // the endpoint's own reestablishLoop (retryMs=3000 → back off, then reconnect once we're back up).
    await wait(1500);
    srv = startServer();
    for (let j = 0; j < 50; j++) { if (await isReachable(SERVERS)) break; await wait(200); }
    // Wait for the endpoint's self-heal to reconnect + re-arm (reestablishLoop backoff can take a few s).
    for (let j = 0; j < 60; j++) {
      await wait(500);
      try { if ((await countConsumers(presenceStream)) >= 1) break; } catch { /* server still settling */ }
    }
  }
  await wait(500);

  const presenceHealed = await countConsumers(presenceStream);
  const channelHealed = await countConsumers(channelStream);
  // Bounded, not unbounded: pre-fix each self-heal leaves its abandoned consumer (=> grows ~1/cycle,
  // and on a live-forever fleet, forever). Post-fix the recreate loop is stopped so orphans age out;
  // within the smoke's window we tolerate a few not-yet-aged-out inactive consumers but NOT growth
  // proportional to CYCLES. The bound below (baseline + CYCLES) still fails the pre-fix unbounded leak
  // once the earlier manual-phase reconnects are also counted (pre-fix presence would be >=1+5+3).
  const healBound = 1 + CYCLES;
  check(
    `presence watcher consumers stay bounded across ${CYCLES} self-heal cycles (stop halts recreate)`,
    presenceHealed <= presenceBefore + healBound,
    { presenceBefore, presenceHealed, cycles: CYCLES, healBound },
  );
  check(
    `channel watcher consumers stay bounded across ${CYCLES} self-heal cycles (stop halts recreate)`,
    channelHealed <= channelBefore + healBound,
    { channelBefore, channelHealed, cycles: CYCLES, healBound },
  );

  console.log(`\nRECONNECT-WATCH-LEAK SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  console.log(`  MANUAL   presence: ${presenceBefore} -> ${presenceAfter} | channel: ${channelBefore} -> ${channelAfter} over ${RECONNECTS} reconnects`);
  console.log(`  SELFHEAL presence: ${presenceBefore} -> ${presenceHealed} | channel: ${channelBefore} -> ${channelHealed} over ${CYCLES} kill/restart cycles`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await agent?.stop(); } catch { /* ignore */ }
  try { await probeNc?.drain(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
