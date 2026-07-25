/**
 * Reconnect-logging smoke (no NATS) — proves a mesh drop can't flood the host or corrupt its TUI.
 * CotalEndpoint is an EventEmitter, so we drive MeshAgent's endpoint events directly (never
 * connecting) and assert the anti-flood + off-terminal contract:
 *   - a drop logs exactly ONE "connection lost" line; recovery logs exactly ONE "reconnected" line;
 *   - the repeated endpoint errors during the outage (the TIMEOUT flood) are SUPPRESSED;
 *   - a live-connection error still surfaces (ACL denial, etc.), and an identical repeat is deduped;
 *   - an INJECTED logger receives every line and process.stderr is NEVER touched — so the in-process
 *     OMP extension (which passes pi.logger) can't scribble on the shared terminal.
 * Run: pnpm smoke:reconnect-log
 */
import { MeshAgent, type MeshLogLevel } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const cfg: AgentConfig = {
  space: "smoke",
  name: "log-canary",
  servers: "nats://127.0.0.1:1",
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
  kind: "agent",
  tls: false,
};

const lines: { msg: string; level: MeshLogLevel }[] = [];
const agent = new MeshAgent(cfg, (msg, level) => lines.push({ msg, level: level ?? "info" }));
const endpointErrors = () => lines.filter((l) => l.msg.includes("endpoint error"));

// Guard: with a logger injected, NOTHING may reach the shared terminal.
let stderrWrites = 0;
const realWrite = process.stderr.write.bind(process.stderr);
(process.stderr as unknown as { write: (s: string) => boolean }).write = () => {
  stderrWrites++;
  return true;
};

try {
  const ep = agent.ep;

  // Initial connect: the observer must NOT announce a "reconnect" (connectLoop logs the first connect).
  ep.emit("connection", { connected: true });
  check("initial connect logs no 'reconnected'", lines.filter((l) => l.msg.includes("reconnected")).length === 0, lines);

  // Drop.
  ep.emit("connection", { connected: false });
  const lost = lines.filter((l) => l.msg.includes("connection lost"));
  check("drop logs exactly one 'connection lost' at warn", lost.length === 1 && lost[0].level === "warn", lost);

  // The flood: repeated endpoint errors while disconnected — the exact spam that broke the TUI.
  for (let i = 0; i < 8; i++) ep.emit("error", new Error("TIMEOUT"));
  check("outage endpoint errors are suppressed", endpointErrors().length === 0, lines);

  // Recover.
  ep.emit("connection", { connected: true });
  const recon = lines.filter((l) => l.msg.includes("reconnected to the mesh"));
  check("recovery logs exactly one 'reconnected' at info", recon.length === 1 && recon[0].level === "info", recon);

  // A live-connection error DOES surface (genuine, actionable).
  ep.emit("error", new Error("NATS permission denied: cannot publish"));
  check("live error surfaces once", endpointErrors().length === 1, lines);

  // An identical consecutive error is deduped (spam guard for a connected-but-flapping error).
  ep.emit("error", new Error("NATS permission denied: cannot publish"));
  check("identical consecutive live error is deduped", endpointErrors().length === 1, lines);

  // The whole sequence never touched the terminal.
  check("no writes to process.stderr (no TUI corruption)", stderrWrites === 0, stderrWrites);
} finally {
  (process.stderr as unknown as { write: typeof realWrite }).write = realWrite;
}

console.log(`\nRECONNECT-LOG SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}  (${lines.length} lines)`);
process.exit(failures === 0 ? 0 : 1);
