/**
 * reconnect watch-leak smoke (SEA-1821). The presence + channel-registry KV watchers
 * (`startPresenceWatch`/`startChannelWatch`) each open a `kv.watch()`, which backs an ephemeral
 * ordered JetStream consumer plus a delivery subscription. `connectAndBind` re-arms both on EVERY
 * (re)connect; before the fix, `clearConnectionScoped` did NOT stop the prior iterators, so each
 * reconnect abandoned two ordered consumers server-side (nats.js `nc.drain()` does not reclaim a
 * watch's delivery sub — it rides a dynamic inbox outside the connection's tracked-sub set). Over
 * hours that leaked hundreds of consumers + sockets per agent and pegged the broker's CPU.
 *
 * Asserts (open mode — unrestricted JS API for the consumer-count probe): the live ordered-consumer
 * count on `KV_cotal_presence_<space>` and `KV_cotal_channels_<space>` does NOT grow across repeated
 * reconnects (a bounded steady state: one watcher each, the prior one torn down). Pre-fix this count
 * climbs by ~1 per stream per reconnect; post-fix it holds flat.
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
// Open mode: a plain JetStream server, no auth — the endpoint lazily creates its KV streams, and the
// probe connection can list consumers freely (auth mode scopes the JS API away from every profile).
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });

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

  console.log(`\nRECONNECT-WATCH-LEAK SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  console.log(`  presence: ${presenceBefore} -> ${presenceAfter} | channel: ${channelBefore} -> ${channelAfter} over ${RECONNECTS} reconnects`);
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
