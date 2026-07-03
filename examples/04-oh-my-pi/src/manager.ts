/**
 * Composition root for example 04 (oh-my-pi coding agent). Runs a manager that
 * spawns oh-my-pi peers into the space. Each spawn is a real oh-my-pi agent
 * session (extensions/connector-oh-my-pi) that embeds a Cotal endpoint and
 * answers DMs, anycasts, and @-mentions on channels — waking an idle session
 * with prompt() and folding same-scope traffic into a live turn with steer().
 * Importing the connector self-registers it as "oh-my-pi".
 */
import { DEFAULT_SERVER, isReachable } from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";
import "@cotal-ai/oh-my-pi"; // self-registers "oh-my-pi"

const space = process.env.COTAL_SPACE?.trim() || "demo";
const server = process.env.COTAL_SERVERS?.trim() || DEFAULT_SERVER;

if (!(await isReachable(server))) {
  console.error(`Can't reach NATS at ${server}. Run: pnpm cotal up`);
  process.exit(1);
}

const mgr = new Manager({ space, servers: server });
await mgr.start();
console.log(`example-04-oh-my-pi manager up in space "${space}" — connector: oh-my-pi`);
console.log(`console: ${mgr.consoleUrl}`);

process.on("SIGINT", () => void mgr.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void mgr.stop().then(() => process.exit(0)));
await new Promise<void>(() => {});
