import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  agentFilePath,
  identityFromCreds,
  loadAgentFile,
  mintCreds,
  mkSecretDir,
  newIdentity,
  stripSpaceAuth,
  writeSecretFile,
  type Identity,
  type Profile,
} from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { cotalRoot } from "../lib/paths.js";
import { c } from "../ui.js";

/** Out-of-band cred minting: generate an identity, sign a profile-scoped user JWT with the
 *  space's account signing key, and write a creds file the agent/observer loads to join.
 *  `--signer` instead emits a stripped signer file — only the account signing material
 *  (`space` + `account.pub` + `account.signingSeed`), no operator root-of-trust — to mount into a
 *  containerized manager so it can mint per-agent creds without holding the account-minting key. */
export async function mint(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      out: { type: "string" },
      signer: { type: "boolean" }, // emit a stripped signer file instead of agent/observer creds
      force: { type: "boolean" }, // overwrite an existing --signer file; or (agent) rotate to a fresh id instead of reusing the existing creds'
      "allow-subscribe": { type: "string" }, // read ACL override (comma-separated)
      "allow-publish": { type: "string" }, // post ACL override (comma-separated)
    },
  });
  const dir = authDir(cotalRoot());

  // `--signer`: no identity, no name — strip this space's auth.json to its account signing material.
  if (values.signer) {
    const auth = loadSpaceAuth(dir);
    if (!auth) {
      console.error(c.red("no space auth found here — run `cotal up` first"));
      process.exit(1);
    }
    const out = resolve(values.out ?? "signer.json");
    if (existsSync(out) && !values.force) {
      console.error(c.red(`${out} already exists — pass --force to overwrite`));
      process.exit(1);
    }
    writeSecretFile(out, JSON.stringify(stripSpaceAuth(auth), null, 2));
    console.log(c.green(`✓ wrote signer for space "${auth.space}"`));
    console.log(c.dim(`  ${out}`));
    console.log(c.dim("  mount read-only at /workspace/.cotal/auth/auth.json in the container"));
    return;
  }

  const name = positionals[0];
  if (!name) {
    console.error(c.red("usage: cotal mint <name> --profile <agent|observer|admin> [--allow-subscribe a,b] [--allow-publish a,b] [--out <path>]"));
    process.exit(1);
  }
  const splitList = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const profile = (values.profile ?? "agent") as Profile;
  if (profile !== "agent" && profile !== "observer" && profile !== "admin") {
    console.error(c.red(`unknown profile "${profile}" — expected agent, observer, or admin`));
    process.exit(1);
  }
  const auth = loadSpaceAuth(dir);
  if (!auth) {
    console.error(c.red("no space auth found here — run `cotal up` first"));
    process.exit(1);
  }
  // For agents, derive the read/post ACLs AND role from the agent file if one exists (flags
  // override): allowSubscribe (read; defaults to subscribe) and allowPublish (post; default-deny);
  // role scopes the TASK-queue consumer to svc_<role>. observers/managers ignore all three.
  // NOTE: this mints CREDS only — the bind-only chat/DM/TASK durables are pre-created separately by
  // a privileged provisioner (`cotal up` / manager / `cotal spawn`), as for DM/TASK already.
  let allowSubscribe: string[] | undefined;
  let allowPublish: string[] | undefined;
  let role: string | undefined;
  if (profile === "agent") {
    const f = agentFilePath(cotalRoot(), name);
    const def = existsSync(f) ? loadAgentFile(f) : undefined;
    allowSubscribe = splitList(values["allow-subscribe"]) ?? def?.allowSubscribe ?? def?.subscribe;
    allowPublish = splitList(values["allow-publish"]) ?? def?.allowPublish;
    role = def?.role;
  }
  // Re-mint reuses the SAME identity by default — but only for the `agent` profile. mint's read/post
  // ACLs come from the persona file, so re-minting is how an agent's channels get refreshed; and the
  // mesh id, its durable ACL row, and its dm/dlv durables are all keyed by the nkey public key, so
  // rotating the id on every mint (the old behavior) orphaned that row + those durables, leaving the
  // agent @mention-wake-blind until re-provisioned. Observer/admin creds carry no persona-refresh
  // workflow and no durable footprint to orphan, and silently extending a privileged admin key's
  // lifetime across re-mints would be surprising — so they always rotate. Reuse only when: agent
  // profile, a creds file already exists here, and --force did not ask for deliberate rotation
  // (a compromised key / intentional new identity).
  const canonicalOut = resolve(join(dir, "creds", `${name}.creds`));
  const out = resolve(values.out ?? canonicalOut);
  // The canonical `creds/<name>.creds` path is the ONLY binding between an agent name and a creds
  // file: the file bakes an nkey id, not the name (`identity.ts`), so a creds file at a custom
  // `--out` cannot be attributed to <name>. A custom `--out` onto an EXISTING creds file must
  // therefore never be silently reused (re-signing another agent's id with this name's ACLs) nor
  // overwritten (rotating that id, orphaning its id-keyed ACL row + dm/dlv durables) — fail loud
  // unless --force asks for the overwrite deliberately. Identity reuse is thus canonical-path-only.
  if (!values.force && out !== canonicalOut && existsSync(out)) {
    throw new Error(
      `cotal mint: --out ${out} already holds a creds file that may not belong to "${name}" — creds ` +
        `identify an agent by nkey id, not by name, so this file cannot be safely reused or ` +
        `overwritten for "${name}". Pass --force to overwrite it with a fresh identity, or point ` +
        `--out at a path that does not exist yet.`,
    );
  }
  const reuse = profile === "agent" && !values.force && out === canonicalOut && existsSync(out);
  let identity: Identity;
  if (reuse) {
    try {
      identity = identityFromCreds(readFileSync(out, "utf8"));
    } catch (e) {
      // A present-but-unreadable creds file (empty, truncated, or not a user creds file) must fail
      // loud, not silently rotate — silently minting a fresh id here would orphan the durable row
      // the existing id may still own. Point the operator at the deliberate-rotation escape hatch.
      throw new Error(
        `cotal mint: creds already exist at ${out} but could not be parsed to reuse the identity ` +
          `(${e instanceof Error ? e.message : String(e)}). Pass --force to mint a fresh identity ` +
          `(rotates the id), or remove the file if it is stale.`,
      );
    }
  } else {
    identity = newIdentity();
  }
  const creds = await mintCreds(auth, identity, profile, { allowSubscribe, allowPublish, role });
  mkSecretDir(dirname(out));
  writeSecretFile(out, creds);
  console.log(c.green(`✓ minted ${profile} creds for "${name}"`));
  console.log(c.dim(`  id:    ${identity.id}${reuse ? " (reused — re-mint kept the identity)" : " (new)"}`));
  console.log(c.dim(`  creds: ${out}`));
}
