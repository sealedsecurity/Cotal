import { runOmpPeer } from "./peer.js";

runOmpPeer().catch((e) => {
  process.stderr.write(`[oh-my-pi-peer] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
