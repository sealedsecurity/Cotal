/**
 * reconnect watch-leak ACL smoke — AUTH mode (SEA-1821). The leak fix (endpoint.ts `stopWatch`)
 * reclaims each kv.watch ordered consumer with `consumer.delete()`, which issues
 * `$JS.API.CONSUMER.DELETE.<stream>.<name>` on the AGENT's own scoped cred. That grant is
 * default-deny: unless the agent profile's pub-ACL explicitly allows it (provision.ts), the delete is
 * refused server-side and the fix silently no-ops in production — exactly the fleet-fatal condition.
 * The open-mode leak smoke (reconnect-watch-leak.smoke.ts) can't catch this: open mode has no ACL, so
 * the delete always lands there. This smoke closes that gap by asserting, on a REAL scoped agent cred:
 *
 *   1. an agent may delete its OWN presence-KV watch ordered consumer (the widened grant), AND
 *   2. an agent may delete its OWN channel-KV watch ordered consumer, AND
 *   3. the grant is scoped — the agent still may NOT delete a consumer on a stream it has no
 *      DELETE grant for (the DM stream), so the widening didn't over-reach into a blanket power.
 *
 * Pre-widening, (1) and (2) throw a permissions violation; post-widening they resolve. (3) must
 * always be denied.
 *
 * Run: pnpm smoke:reconnect-watch-leak:acl:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type QueuedIterator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm, type KvWatchEntry } from "@nats-io/kv";
import {
  createSpaceAuth, serverConfig, mintCreds, newIdentity, provisionAgent, setupSpaceStreams,
  isReachable, presenceBucket, channelBucket, dmStream, CotalEndpoint,
} from "../src/index.js";

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
const isPermissionError = (e: unknown): boolean => /permission/i.test((e as Error)?.message ?? "");

// The ordered PushConsumer @nats-io/kv stashes on the watch iterator's `_data` slot (see endpoint.ts
// stopWatch — absent from the exported QueuedIterator<T> type, so a named cast is the only reach).
const consumerOf = (iter: QueuedIterator<KvWatchEntry>): { delete(): Promise<unknown>; name?: string } | undefined => {
  const withData = iter as QueuedIterator<KvWatchEntry> & { _data?: unknown };
  const c = withData._data;
  return c && typeof c === "object" && "delete" in c && typeof (c as { delete: unknown }).delete === "function"
    ? (c as { delete(): Promise<unknown>; name?: string })
    : undefined;
};

const space = `reconnectleakacl${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-watch-leak-acl-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

let mgr: CotalEndpoint | undefined;
let agentNc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) break; await wait(200); }

  // Provision the space + a scoped AGENT cred through the real path (permissionsFor("agent", …)).
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  mgr.on("error", () => {}); await mgr.start();

  const aId = newIdentity();
  const aCreds = await provisionAgent(mgr, auth, aId, { allowSubscribe: ["general"], subscribe: ["general"] });

  // Open a RAW connection on the agent's scoped cred and replicate the endpoint's watch path, so the
  // delete we assert on rides EXACTLY the agent's production ACL.
  agentNc = await connect({ servers: SERVERS, name: "acl-probe", inboxPrefix: `_INBOX_${aId.id}`, authenticator: credsAuthenticator(new TextEncoder().encode(aCreds)) });
  const kvm = new Kvm(agentNc);

  // (1) presence-KV watch consumer delete — the widened grant.
  const presenceKv = await kvm.open(presenceBucket(space));
  const pIter = await presenceKv.watch();
  const pConsumer = consumerOf(pIter);
  check("presence watch exposes its ordered consumer (via _data)", !!pConsumer);
  let pDeleted = false; let pErr: unknown;
  try { await pConsumer?.delete(); pDeleted = true; } catch (e) { pErr = e; }
  check("agent cred MAY delete its own presence-KV watch consumer (widened ACL, not a permission error)", pDeleted, pErr);
  pIter.stop();

  // (2) channel-KV watch consumer delete — the widened grant.
  const channelKv = await kvm.open(channelBucket(space));
  const cIter = await channelKv.watch();
  const cConsumer = consumerOf(cIter);
  check("channel watch exposes its ordered consumer (via _data)", !!cConsumer);
  let cDeleted = false; let cErr: unknown;
  try { await cConsumer?.delete(); cDeleted = true; } catch (e) { cErr = e; }
  check("agent cred MAY delete its own channel-KV watch consumer (widened ACL, not a permission error)", cDeleted, cErr);
  cIter.stop();

  // (3) the widening is SCOPED: the agent still may NOT delete a consumer on a stream it holds no
  // DELETE grant for. The DM stream is admin-only — a delete there must be refused, proving we did not
  // hand the agent a blanket consumer-delete power.
  const jsm = await jetstreamManager(agentNc);
  let dmDenied = false; let dmErr: unknown;
  try { await jsm.consumers.delete(dmStream(space), "no_such_consumer"); } catch (e) { dmErr = e; dmDenied = isPermissionError(e); }
  check("agent cred may NOT delete a DM-stream consumer (grant stayed scoped, not blanket)", dmDenied, dmErr);

  console.log(`\nRECONNECT-WATCH-LEAK ACL (AUTH) SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await agentNc?.drain(); } catch { /* ignore */ }
  try { await mgr?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
