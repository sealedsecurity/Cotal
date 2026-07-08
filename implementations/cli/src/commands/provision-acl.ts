import { parseArgs } from "node:util";
import { planAclProvision, provisionAcls } from "../lib/acl-provision.js";
import { resolveTargetNoConnectOrExit, resolveTargetOrExit } from "../lib/connect.js";
import { cotalRoot } from "../lib/paths.js";
import { c } from "../ui.js";

/**
 * `cotal provision-acl` — write the durable read-ACL row (`cotal_acl_<space>`) for every persona in the
 * catalog, so the standalone delivery daemon authorizes their durable @mention-wake deliveries.
 *
 * The gap this closes: `cotal mint` writes creds but is offline — it never touches the mesh — so an
 * agent brought up via `cotal mint` + `exec omp` (no manager/`cotal spawn` in the loop) has no ACL row
 * and is @mention-wake-blind until something provisions it. This command is that something: a
 * re-runnable, privileged pass that derives each agent's read ACL to match exactly what its creds were
 * minted with (so durable read scope never diverges from live), and commits the row.
 *
 * Idempotent (core `commitAcl` is an atomic CAS put). `--dry-run` prints the plan without connecting.
 * A credless persona is SKIPPED (a row is keyed by agent id, which exists only once creds are minted) —
 * this command never mints (that's `cotal mint`; mint-if-absent is the still-open mint-strategy fork). A
 * persona whose creds' baked read scope diverges from its file ACL is fail-loud skipped with a re-mint
 * hint — never silently rewritten.
 */
export async function provisionAcl(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      space: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const root = cotalRoot();

  // --dry-run: OFFLINE — show the plan (what would be provisioned/skipped) without a connection.
  // Resolve the target from the registry FIRST (offline: no connect, no prune — see the helper's note
  // on the one stale-entry divergence from the live path) so the preview scans the same catalog the
  // live run would: a `--space`/out-of-checkout invocation resolves a registered mesh whose root
  // differs from cwd — planning against raw `cotalRoot()` + `values.space` would preview a different
  // persona set than the command actually provisions.
  if (values["dry-run"]) {
    const dt = resolveTargetNoConnectOrExit({ server: values.server, space: values.space });
    const space = dt.space;
    const plan = planAclProvision(dt.root ?? root, space);
    console.log(c.bold(`provision-acl (dry run) — space "${space}" — ${plan.length} personas`));
    for (const e of plan) {
      if (e.error) { console.log(`  ${c.red("skip")} ${e.name.padEnd(16)} persona parse error: ${e.error}`); continue; }
      if (e.drift) { console.log(`  ${c.red("skip")} ${e.name.padEnd(16)} ${e.drift}`); continue; }
      const scope = `[${e.allowSubscribe.join(", ")}]`;
      if (!e.hasCreds) console.log(`  ${c.yellow("skip")} ${e.name.padEnd(16)} ${scope}  (no creds — run \`cotal mint\` first)`);
      else console.log(`  ${c.green("acl ")} ${e.name.padEnd(16)} ${scope}`);
    }
    console.log(c.dim("dry run — nothing written. Re-run without --dry-run to commit."));
    return;
  }

  const target = await resolveTargetOrExit({ server: values.server, space: values.space });
  if (!target.auth) {
    console.error(c.red("provision-acl needs an auth-mode mesh (it mints a privileged provisioner cred) — this target is open/off-registry."));
    process.exit(1);
  }
  // Scan the RESOLVED mesh's catalog, not the cwd's: `--space`/out-of-checkout invocations resolve a
  // registered mesh whose root differs from cwd. `target.root` is set for a registry-resolved auth mesh
  // (guaranteed here — the `!target.auth` guard above already exited an off-registry target); fall back
  // to the cwd root defensively.
  const result = await provisionAcls({ root: target.root ?? root, space: target.space, server: target.server, auth: target.auth });
  for (const p of result.provisioned)
    console.log(`  ${c.green("✓")} ${p.name.padEnd(16)} [${p.allowSubscribe.join(", ")}]`);
  for (const s of result.skipped) console.log(`  ${c.yellow("skip")} ${s.name.padEnd(16)} ${s.reason}`);
  console.log(
    c.bold(`provisioned ${result.provisioned.length} ACL row(s)`) +
      (result.skipped.length ? `, skipped ${result.skipped.length}` : "") +
      ` — space "${target.space}"`,
  );
}
