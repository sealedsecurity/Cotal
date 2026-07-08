/**
 * identityFromCreds unit smoke (pure, no broker) — run with:
 *   pnpm --filter @cotal-ai/core exec tsx smoke/identity.smoke.ts
 *
 * Defends the id-preserving creds reader that `cotal mint` uses to REUSE an agent's identity across a
 * re-mint (the reuse-unless-force fix). The contract: the {id, seed} carried by a creds file round-trips
 * unchanged; the id agrees with idFromCreds; and a creds file that is corrupt (no seed block) or spliced
 * (a seed paired with a foreign JWT subject) is REJECTED — never silently handing back a wrong or
 * mismatched id, which is exactly what would let a re-mint re-sign the wrong identity.
 */
import assert from "node:assert/strict";
import { createSpaceAuth, mintCreds } from "../src/provision.js";
import { newIdentity, idFromCreds, identityFromCreds } from "../src/identity.js";

// Offline key material — createSpaceAuth mints an operator→account chain locally, no broker needed.
const auth = await createSpaceAuth("test");

// (a) Round-trip: a freshly-minted agent creds file yields back the SAME id AND seed (both fields).
//     This is the load-bearing property — reuse re-signs THIS identity, so a wrong id or a mangled
//     seed here would silently rotate the agent despite the "reuse" intent.
{
  const id = newIdentity();
  const creds = await mintCreds(auth, id, "agent", { allowSubscribe: ["general"] });
  const got = identityFromCreds(creds);
  assert.equal(got.id, id.id, "identityFromCreds must recover the minted id");
  assert.equal(got.seed, id.seed, "identityFromCreds must recover the minted seed verbatim");
}

// (b) Single-id cross-consistency at the API boundary: the id it returns agrees with idFromCreds on
//     the same creds (the "one id everywhere" invariant — the two readers must never diverge).
{
  const creds = await mintCreds(auth, newIdentity(), "agent", { allowSubscribe: ["general"] });
  assert.equal(identityFromCreds(creds).id, idFromCreds(creds));
}

// (c) Spliced creds (A's seed + B's JWT ⇒ JWT subject ≠ seed identity) is REJECTED. identityFromCreds
//     inherits idFromCreds's JWT-subject cross-check, so it can't return a seed whose JWT claims a
//     different identity — the guard against re-signing a seed that was paired with someone else's JWT.
{
  const a = await mintCreds(auth, newIdentity(), "agent", { allowSubscribe: ["general"] });
  const b = await mintCreds(auth, newIdentity(), "agent", { allowSubscribe: ["general"] });
  const jwtBlock = /-----BEGIN NATS USER JWT-----[\s\S]*?------END NATS USER JWT------/;
  const bJwt = b.match(jwtBlock)![0];
  const spliced = a.replace(jwtBlock, bJwt); // A's seed block, B's JWT subject
  assert.throws(() => identityFromCreds(spliced), /!= JWT subject/);
}

// (d) A creds string with no seed block throws the documented error rather than returning a bogus id.
assert.throws(() => identityFromCreds("this is not a creds file"), /no user nkey seed block found/);

console.log("identity.smoke: all assertions passed");
