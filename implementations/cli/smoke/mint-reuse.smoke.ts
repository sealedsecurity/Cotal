/**
 * `cotal mint` identity-reuse smoke (hermetic — no broker). Exercises the REAL mint() command against
 * a tmp `.cotal/` root laid out exactly as `cotal up` writes it (auth.json via saveSpaceAuth + a
 * persona file), and asserts the reuse-unless-force contract end to end. Run with:
 *   pnpm --filter @cotal-ai/cli exec tsx smoke/mint-reuse.smoke.ts
 *
 * The load-bearing regression: re-minting an AGENT keeps the SAME nkey id (so its durable ACL row +
 * dm/dlv durables, all id-keyed, stay valid) — the old unconditional newIdentity() rotated the id on
 * every mint and orphaned them, leaving the agent @mention-wake-blind. --force rotates deliberately;
 * a persona ACL change refreshes the baked channels WITHOUT rotating; observer/admin always rotate
 * (reuse is agent-only — no durable footprint to orphan, and re-signing a privileged key would
 * silently extend its lifetime); and a present-but-unparseable creds file fails loud (never a silent
 * fresh-mint that would orphan the id its predecessor may still own).
 *
 * mint() resolves its root via findCotalRoot() walking up from process.cwd(), so the harness chdir's
 * into the tmp root and restores cwd in the finally.
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, idFromCreds } from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { mint } from "../src/commands/mint.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// The chat-read channels a minted creds file grants (decode the JWT's nats.sub.allow, keep chat.*.<ch>
// entries). Same JWT-decode shape as manager/smoke/persona-identity-acl.smoke.ts.
function credSubChat(path: string): string[] {
  const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  const allow: string[] = claims.nats?.sub?.allow ?? [];
  return allow.filter((s) => s.includes(".chat."));
}

// mint() logs its result to stdout; silence it (restored even on throw) so the check output stays
// legible — the ids we assert on are read straight from the written creds file, not from the log.
async function mintQuiet(argv: string[]): Promise<void> {
  const orig = console.log;
  console.log = () => {};
  try {
    await mint(argv);
  } finally {
    console.log = orig;
  }
}

// A tmp `.cotal/` root with real space trust material (auth.json, exactly as `cotal up` persists it)
// and a `scout` agent persona reading/posting the `general` channel.
const space = `mint-reuse-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const root = mkdtempSync(join(tmpdir(), "cotal-mint-reuse-"));
const agentsDir = join(root, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
saveSpaceAuth(authDir(root), auth);
const scoutPersona = join(agentsDir, "scout.md");
writeFileSync(scoutPersona, "---\nname: scout\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n");
const scoutCreds = join(authDir(root), "creds", "scout.creds");
const credsDir = join(authDir(root), "creds");

const prevCwd = process.cwd();
process.chdir(root); // findCotalRoot() walks up from cwd — anchor it at our tmp root
try {
  // 1) THE regression: re-minting an agent twice reuses the SAME id (before the fix, two mints gave
  //    two different ids and orphaned the id-keyed durables).
  await mintQuiet(["scout"]);
  const id1 = idFromCreds(readFileSync(scoutCreds, "utf8"));
  await mintQuiet(["scout"]);
  const id2 = idFromCreds(readFileSync(scoutCreds, "utf8"));
  check("re-mint of an agent reuses the same id", id1 === id2, { id1, id2 });

  // 2) --force is the deliberate-rotation escape hatch: a fresh id despite an existing creds file.
  await mintQuiet(["scout", "--force"]);
  const id3 = idFromCreds(readFileSync(scoutCreds, "utf8"));
  check("mint --force rotates to a different id", id3 !== id2, { id2, id3 });

  // 3) A persona ACL change is applied on re-mint (refreshed channels) WITHOUT rotating the id —
  //    the whole point: an agent's read scope is refreshed while its mesh id stays stable.
  const beforeChans = credSubChat(scoutCreds); // channels baked before the persona change
  writeFileSync(scoutPersona, "---\nname: scout\nsubscribe: [general]\nallowSubscribe: [general, review]\nallowPublish: [general]\n---\nbody\n");
  await mintQuiet(["scout"]);
  const id4 = idFromCreds(readFileSync(scoutCreds, "utf8"));
  const afterChans = credSubChat(scoutCreds);
  check("re-mint after an ACL change keeps the identity", id4 === id3, { id3, id4 });
  check(
    "re-mint bakes the NEW channel into sub.allow (review added, was absent before)",
    afterChans.some((s) => s.endsWith(".chat.*.review")) && !beforeChans.some((s) => s.endsWith(".chat.*.review")),
    { beforeChans, afterChans },
  );

  // 4) First-ever mint of a brand-new name has no creds file — the reuse=false path must mint a fresh
  //    identity and write valid creds, not crash on the absent-file read.
  writeFileSync(join(agentsDir, "newbie.md"), "---\nname: newbie\nsubscribe: [general]\nallowSubscribe: [general]\n---\nbody\n");
  const newbieCreds = join(credsDir, "newbie.creds");
  await mintQuiet(["newbie"]);
  const idNew = idFromCreds(readFileSync(newbieCreds, "utf8"));
  check("first mint of a brand-new name mints a fresh identity (absent-creds path, no crash)", idNew !== id4 && idNew.startsWith("U"), { idNew, id4 });

  // 5) Reuse is AGENT-ONLY: re-minting an observer or admin creds file ROTATES the id (a privileged
  //    key must not silently extend its lifetime across re-mints).
  for (const profile of ["observer", "admin"] as const) {
    const pOut = join(credsDir, `${profile}-dash.creds`);
    await mintQuiet([`${profile}-dash`, "--profile", profile]);
    const a = idFromCreds(readFileSync(pOut, "utf8"));
    await mintQuiet([`${profile}-dash`, "--profile", profile]);
    const b = idFromCreds(readFileSync(pOut, "utf8"));
    check(`re-mint of an ${profile} creds rotates the id (reuse is agent-only)`, a !== b, { profile, a, b });
  }

  // 6) A present-but-unparseable creds file at the out path fails LOUD naming --force — never a raw
  //    parse crash, and never a silent fresh-mint (which would orphan the predecessor id's durables).
  mkdirSync(credsDir, { recursive: true });
  const corruptCreds = join(credsDir, "corrupt.creds");
  writeFileSync(corruptCreds, ""); // present but no seed block
  let msg = "";
  try {
    await mintQuiet(["corrupt"]);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  check(
    "unparseable existing creds → actionable error naming --force (no silent rotate, no raw crash)",
    /could not be parsed/.test(msg) && /--force/.test(msg),
    { msg },
  );
  // Assert the FILESYSTEM state, not just the message: the failed mint must not have written fresh
  // creds over the corrupt file. A future refactor that mints-then-throws would still surface a
  // parse error yet silently rotate the id — this catches that by proving the file is untouched.
  check(
    "failed corrupt-creds mint left the file untouched (no silent fresh-mint)",
    readFileSync(corruptCreds, "utf8") === "",
    { content: readFileSync(corruptCreds, "utf8").slice(0, 40) },
  );

  // 7) Cross-identity --out guard (greptile P1). Creds carry the nkey id, NOT the agent name, so the
  //    only name↔identity binding is the canonical creds/<name>.creds path. Reuse is therefore
  //    canonical-path-only: `cotal mint <name> --out <another agent's creds>` must never reuse (re-sign
  //    that file's id with <name>'s ACLs) nor silently clobber it (overwrite its id, orphaning its
  //    durables). Without --force it fails loud; --force is the deliberate-overwrite escape hatch.
  writeFileSync(join(agentsDir, "victim.md"), "---\nname: victim\nsubscribe: [general]\nallowSubscribe: [general]\n---\nbody\n");
  writeFileSync(join(agentsDir, "raider.md"), "---\nname: raider\nsubscribe: [general]\nallowSubscribe: [general, review, ops]\n---\nbody\n");
  const victimCreds = join(credsDir, "victim.creds");
  await mintQuiet(["victim"]);
  const victimBefore = readFileSync(victimCreds, "utf8");
  const victimIdBefore = idFromCreds(victimBefore);
  let raiderMsg = "";
  try {
    await mintQuiet(["raider", "--out", victimCreds]);
  } catch (e) {
    raiderMsg = e instanceof Error ? e.message : String(e);
  }
  check(
    "mint <name> --out <another agent's creds> fails loud naming --force (no cross-identity reuse)",
    /--force/.test(raiderMsg) && /belong/.test(raiderMsg),
    { raiderMsg },
  );
  check(
    "refused cross-identity mint left the target creds byte-identical (no re-sign of its id, no clobber)",
    readFileSync(victimCreds, "utf8") === victimBefore && idFromCreds(readFileSync(victimCreds, "utf8")) === victimIdBefore,
    { changed: readFileSync(victimCreds, "utf8") !== victimBefore },
  );
  // --force is the explicit escape hatch: it rotates to a FRESH identity and overwrites the target.
  await mintQuiet(["raider", "--out", victimCreds, "--force"]);
  check(
    "mint --out <existing creds> --force overwrites with a fresh identity (escape hatch intact)",
    idFromCreds(readFileSync(victimCreds, "utf8")) !== victimIdBefore,
    { victimIdBefore, after: idFromCreds(readFileSync(victimCreds, "utf8")) },
  );
} finally {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nmint-reuse smoke: ${failures === 0 ? "OK ✅" : "FAILED ❌"} (${failures} failing)`);
assert.equal(failures, 0, `${failures} check(s) failed`);
process.exit(0);
