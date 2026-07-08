import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chatSubject,
  CotalEndpoint,
  idFromCreds,
  mintCreds,
  newIdentity,
  type SpaceAuth,
} from "@cotal-ai/core";
import { authDir } from "@cotal-ai/workspace";
import { listPersonas } from "./personas.js";

/**
 * Durable read-ACL provisioning — the durable form of the out-of-band backfill.
 *
 * The delivery daemon authorizes an agent's durable @mention-wake deliveries against its row in the
 * `cotal_acl_<space>` registry (absent ⇒ DEFER, never deliver). `cotal mint` writes creds but not
 * that row (it is offline), so an agent launched via `cotal mint` + `exec omp` is @mention-wake-blind
 * until something provisions the row. This routine walks the persona catalog and commits a row for
 * every agent, deriving the read ACL to match exactly what its creds were minted with — so durable
 * read scope never diverges from the live (sub.allow) read scope.
 *
 * Idempotent (core `commitAcl` is an atomic CAS put — re-running rewrites the same value). Runs under
 * a privileged provisioner cred; agents never write their own ACL. This is the option-agnostic
 * correctness mechanism; whether it is auto-invoked at `cotal up` or a mint flag drives it is the
 * open mint-strategy fork (design PR: durable-delivery-acl-provisioning).
 */

/** The read ACL an agent is minted with — replicated verbatim from the mint chokepoint so a
 *  provisioned row equals the creds' baked `sub.allow`. Two steps, each matching one line:
 *  `cotal mint` picks `allowSubscribe ?? subscribe` (nullish — an explicit `[]` is KEPT, not
 *  replaced by `subscribe`; mint.ts:84), then `permissionsFor` maps an empty/absent list to
 *  `["general"]` (`?.length ? it : ["general"]`; provision.ts:411). Kept in lockstep with both. */
function agentReadAcl(def: { allowSubscribe?: string[]; subscribe?: string[] } | undefined): string[] {
  const declared = def?.allowSubscribe ?? def?.subscribe; // mint.ts:84 — nullish, NOT length
  return declared?.length ? declared : ["general"]; // permissionsFor :411
}

/** The chat `sub.allow` entries a creds JWT was minted with — the authoritative, broker-enforced read
 *  grant. Used to cross-check that a provisioned ACL matches the creds (drift ⇒ a re-mint is needed). */
function credChatSubAllow(creds: string, space: string): string[] {
  const m = creds.match(/BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*------END NATS USER JWT/);
  const payload = m?.[1].trim().split(".")[1];
  if (!payload) return [];
  const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    nats?: { sub?: { allow?: string[] } };
  };
  const prefix = `${chatSubject(space, "*", "").slice(0, -1)}`; // cotal.<space>.chat.*. (channel stripped)
  return (claim.nats?.sub?.allow ?? []).filter((s) => s.startsWith(prefix)).sort();
}

export interface AclProvisionPlanEntry {
  name: string;
  /** Present once creds exist (derived from the creds); undefined for a persona with no creds yet. */
  id?: string;
  allowSubscribe: string[];
  /** True when the agent already has creds on disk; false when they must be minted. */
  hasCreds: boolean;
  /** Set when the creds' baked read scope diverges from the file-derived ACL (a re-mint is required). */
  drift?: string;
  /** Set when the persona file failed to parse. */
  error?: string;
}

/** Build the provisioning plan from the persona catalog — pure/offline (reads files, no mesh). */
export function planAclProvision(root: string, space: string): AclProvisionPlanEntry[] {
  const credsDir = join(authDir(root), "creds");
  const plan: AclProvisionPlanEntry[] = [];
  for (const p of listPersonas(root)) {
    if (p.error) {
      plan.push({ name: p.name, allowSubscribe: [], hasCreds: false, error: p.error });
      continue;
    }
    const allowSubscribe = agentReadAcl(p.def);
    const credsPath = join(credsDir, `${p.name}.creds`);
    if (!existsSync(credsPath)) {
      plan.push({ name: p.name, allowSubscribe, hasCreds: false });
      continue;
    }
    const creds = readFileSync(credsPath, "utf8");
    const id = idFromCreds(creds);
    // Parity: the file-derived ACL must render to the same chat sub.allow the creds carry, or the
    // durable read scope would diverge from the live one. Compare as sorted sets.
    const want = allowSubscribe.map((ch) => chatSubject(space, "*", ch)).sort();
    const have = credChatSubAllow(creds, space);
    const drift =
      JSON.stringify(want) === JSON.stringify(have)
        ? undefined
        : `creds read scope [${have.join(", ")}] != file ACL [${want.join(", ")}] — re-mint ${p.name}`;
    plan.push({ name: p.name, id, allowSubscribe, hasCreds: true, drift });
  }
  return plan;
}

export interface AclProvisionResult {
  provisioned: { name: string; id: string; allowSubscribe: string[] }[];
  skipped: { name: string; reason: string }[];
  rowCount: number;
}

/**
 * Provision (commit) an ACL row for every persona that already has creds. A credless persona is
 * SKIPPED (an ACL row is keyed by agent id, which exists only once creds are minted) — this command
 * never mints: minting is `cotal mint`'s job, and mint-if-absent is the still-open mint-strategy fork.
 * A drift entry (creds read scope != file ACL) is fail-loud skipped, never silently rewritten.
 */
export async function provisionAcls(opts: {
  root: string;
  space: string;
  server: string;
  auth: SpaceAuth;
}): Promise<AclProvisionResult> {
  const plan = planAclProvision(opts.root, opts.space);
  const ep = new CotalEndpoint({
    space: opts.space,
    servers: opts.server,
    creds: await mintCreds(opts.auth, newIdentity(), "provisioner"),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { name: "acl-provisioner", role: "provisioner", kind: "endpoint" },
  });
  ep.on("error", () => {}); // JS API errors surface on the awaited call; don't crash the process
  await ep.start();
  const result: AclProvisionResult = { provisioned: [], skipped: [], rowCount: 0 };
  try {
    for (const e of plan) {
      if (e.error) {
        result.skipped.push({ name: e.name, reason: `persona parse error: ${e.error}` });
        continue;
      }
      if (e.drift) {
        result.skipped.push({ name: e.name, reason: e.drift });
        continue;
      }
      if (!e.hasCreds) {
        result.skipped.push({ name: e.name, reason: "no creds (run `cotal mint` first)" });
        continue;
      }
      const id = e.id;
      await ep.commitAcl(id as string, e.allowSubscribe);
      // Read-back through the public accessor confirms the row landed (and is what the daemon's reader
      // will see) — a real verification, not just a key tally.
      const back = await ep.aclForOwner(id as string);
      if (JSON.stringify(back) !== JSON.stringify(e.allowSubscribe))
        throw new Error(`ACL write for ${e.name} did not read back: wrote ${JSON.stringify(e.allowSubscribe)}, read ${JSON.stringify(back)}`);
      result.provisioned.push({ name: e.name, id: id as string, allowSubscribe: e.allowSubscribe });
    }
    result.rowCount = result.provisioned.length;
  } finally {
    await ep.stop();
  }
  return result;
}
